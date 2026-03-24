import { useState, useEffect, useRef } from "react";
import { recordSession, exportData } from "./wordRecords.js";

// Is live Gemini image generation available? Asks the server so this works in prod too.
let _geminiAvailableCache = null;
async function checkGeminiAvailable() {
  if (_geminiAvailableCache !== null) return _geminiAvailableCache;
  try {
    const res = await fetch('/api/gemini-available');
    const data = await res.json();
    _geminiAvailableCache = !!data.available;
  } catch (e) {
    console.warn('[Gemini] Could not reach /api/gemini-available:', e.message);
    _geminiAvailableCache = false;
  }
  return _geminiAvailableCache;
}


// ── EPUB parser (uses JSZip via CDN, loaded dynamically) ──────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return window.JSZip;
}

function htmlToText(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  // Remove script/style
  d.querySelectorAll("script,style").forEach(el => el.remove());
  return d.textContent.replace(/\s+/g, " ").trim();
}

// Extract the first heading (h1-h3) from chapter HTML as a candidate chapter title.
// Many epubs have a full chapter title (e.g. "Chapter One: The Wrong Door") inside
// the chapter's own HTML, even when the NCX/TOC metadata only stores a short label
// like "One". We check h1 first (most common), then h2/h3 as fallbacks.
function extractHeadingFromHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  for (const tag of ["h1", "h2", "h3"]) {
    const el = d.querySelector(tag);
    if (el) {
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (text.length > 0 && text.length < 200) return text;
    }
  }
  return null;
}

async function parseEpub(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);

  // Find container.xml to get content.opf path
  const containerXml = await zip.file("META-INF/container.xml").async("text");
  const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!rootfileMatch) throw new Error("Invalid EPUB: no rootfile");
  const opfPath = rootfileMatch[1];
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

  const opfXml = await zip.file(opfPath).async("text");
  const parser = new DOMParser();
  const opfDoc = parser.parseFromString(opfXml, "application/xml");

  // Build id->href map from manifest
  const manifest = {};
  opfDoc.querySelectorAll("manifest item").forEach(item => {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  });

  // Get spine order
  const spineItems = Array.from(opfDoc.querySelectorAll("spine itemref"))
    .map(ref => manifest[ref.getAttribute("idref")])
    .filter(Boolean);

  // --- Step 1: Parse NCX/NAV for chapter titles ---
  // The NCX (EPUB2) or NAV (EPUB3) is the epub's official table of contents.
  // However, many epubs — especially Calibre-produced ones — store only terse labels
  // here (e.g. "One", "Two") while the full chapter names (e.g. "The Wrong Door")
  // live elsewhere. We parse this first as a baseline, then enrich below.
  const ncxId = opfDoc.querySelector("spine")?.getAttribute("toc");
  const navHref = manifest["nav"] || manifest["toc"] || (ncxId ? manifest[ncxId] : null);

  let tocEntries = []; // [{title, href}]
  if (navHref) {
    try {
      const navPath = opfDir + navHref;
      const navFile = zip.file(navPath) || zip.file(navHref);
      if (navFile) {
        const navRaw = await navFile.async("text");
        // NCX files are XML but were previously parsed as "text/html", which caused
        // querySelector("navPoint") to silently fail in some browsers. Detect format
        // and parse with the correct mime type.
        const isNcx = navHref.endsWith(".ncx") || navRaw.trimStart().startsWith("<?xml");
        const navDoc = parser.parseFromString(navRaw, isNcx ? "application/xml" : "text/html");
        if (isNcx) {
          // EPUB2 NCX: <navPoint><navLabel><text>Title</text></navLabel><content src="file.html"/></navPoint>
          navDoc.querySelectorAll("navPoint").forEach(np => {
            const title = np.querySelector("navLabel > text")?.textContent?.trim() || "";
            const href = np.querySelector("content")?.getAttribute("src") || "";
            if (title && href) tocEntries.push({ title, href: href.split("#")[0] });
          });
        } else {
          // EPUB3 HTML nav: <nav epub:type="toc"> containing <a> links
          const navEl = navDoc.querySelector("nav[epub\\:type='toc']");
          const links = navEl ? navEl.querySelectorAll("a") : navDoc.querySelectorAll("nav a");
          links.forEach(el => {
            const title = el.textContent.trim();
            const href = el.getAttribute("href") || "";
            if (title && href) tocEntries.push({ title, href: href.split("#")[0] });
          });
        }
      }
    } catch (e) { /* fallback: tocEntries stays empty, titles come from headings or fallback */ }
  }

  // --- Step 2: Read all spine files, caching raw HTML for reuse ---
  // We cache raw HTML here so the HTML TOC scan (step 3) and heading extraction
  // don't need to re-read files from the zip.
  const spineFileCache = []; // [{href, html}]
  for (const href of spineItems) {
    try {
      const fullPath = opfDir + href;
      const f = zip.file(fullPath) || zip.file(href);
      if (!f) continue;
      const html = await f.async("text");
      spineFileCache.push({ href, html });
    } catch (e) { /* skip unreadable files */ }
  }

  // --- Step 3: Scan for an HTML table-of-contents page with richer titles ---
  // Problem: many Calibre epubs have an NCX that only says "One", "Two", "Three",
  // but include a styled HTML contents page (e.g. split_3.html) where each entry
  // shows both the number AND the chapter name:
  //   <div>
  //     <p><a href="chapter04.html">One</a></p>
  //     <p>The Wrong Door</p>
  //   </div>
  // We detect this page by looking for spine files where most <a> links point to
  // other spine files (i.e. it's a navigation page, not a chapter). Then we extract
  // the full text of each link's containing block element as the enriched title.
  const htmlTocTitles = {}; // basename -> full title text from HTML TOC page
  const spineBasenames = new Set(spineItems.map(s => s.split("/").pop()));
  for (const { html } of spineFileCache) {
    try {
      // Skip real chapters (too large) and empty/tiny files
      if (html.length > 50000 || html.length < 200) continue;
      const doc = parser.parseFromString(html, "text/html");
      const links = doc.querySelectorAll("a[href]");
      if (links.length < 3) continue;
      // Count how many links point to other spine files
      let matchCount = 0;
      links.forEach(a => {
        const base = (a.getAttribute("href") || "").split("#")[0].split("/").pop();
        if (base && spineBasenames.has(base)) matchCount++;
      });
      // Require majority of links to be internal — avoids matching bibliography/index pages
      // that have a few spine links mixed with many external references
      if (matchCount < 3 || matchCount < links.length * 0.5) continue;
      // Found a TOC page — extract the full title from each link's tightest container.
      // Prefer <li> (clean list TOCs) over <div> (Calibre-style) over <td> (table TOCs).
      // The container's full textContent captures both "One" and "The Wrong Door"
      // when they're siblings in the same block.
      links.forEach(a => {
        const rawHref = (a.getAttribute("href") || "").split("#")[0];
        const base = rawHref.split("/").pop();
        if (!base || !spineBasenames.has(base)) return;
        const block = a.closest("li") || a.closest("div") || a.closest("td") || a.parentElement;
        if (!block) return;
        // Get the link text (e.g. "One") and the full block text (e.g. "One The Wrong Door").
        // If the block has extra text beyond the link, insert " - " as separator
        // so titles read "One - The Wrong Door" instead of "One The Wrong Door".
        const linkText = a.textContent.replace(/\s+/g, " ").trim();
        const fullText = block.textContent.replace(/\s+/g, " ").trim();
        let title = fullText;
        if (linkText && fullText.startsWith(linkText) && fullText.length > linkText.length) {
          const rest = fullText.slice(linkText.length).trim();
          if (rest) title = `${linkText} - ${rest}`;
        }
        // Cap at 120 chars to reject cases where a wrapper div grabbed multiple entries
        if (title.length > 0 && title.length < 120) {
          htmlTocTitles[base] = title;
        }
      });
      if (Object.keys(htmlTocTitles).length > 0) break; // Use first TOC page found
    } catch (e) { /* skip */ }
  }

  // --- Step 4: Build chapter list with text content and heading ---
  const chapterTexts = [];
  for (const { href, html } of spineFileCache) {
    const text = htmlToText(html);
    const heading = extractHeadingFromHtml(html);
    // Filter out short files (cover pages, copyright, etc.)
    if (text.length > 200) chapterTexts.push({ href, text, heading });
  }

  // --- Step 5: Assemble final chapter titles from best available source ---
  // Three sources of chapter titles, in order of richness:
  //   1. HTML TOC page (e.g. "One The Wrong Door") — richest, has number + name
  //   2. Chapter heading (h1/h2/h3 inside the chapter's own HTML)
  //   3. NCX/NAV entry (e.g. "One") — often the tersest
  // We start with the NCX title as baseline and only upgrade when a richer source
  // provides meaningfully more information (3+ extra characters). This ensures
  // epubs that already have good NCX titles are never degraded.
  const chapters = chapterTexts.map((ch, i) => {
    const tocMatch = tocEntries.find(t => ch.href.endsWith(t.href) || ch.href.includes(t.href));
    const tocTitle = tocMatch?.title || null;
    const heading = ch.heading || null;
    const chBase = ch.href.split("/").pop();
    const htmlTocTitle = htmlTocTitles[chBase] || null;

    let title = tocTitle || `Section ${i + 1}`;

    // Upgrade from HTML TOC if it has more info (e.g. "One The Wrong Door" vs "One")
    if (htmlTocTitle && htmlTocTitle.length > title.length + 2) {
      title = htmlTocTitle;
    }
    // Upgrade from chapter heading if it adds new information
    if (heading && heading.length > title.length + 2) {
      const titleLower = title.toLowerCase().replace(/[^a-z0-9]/g, "");
      const headLower = heading.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (headLower.includes(titleLower)) {
        title = heading; // heading is a superset (e.g. "Chapter One: The Wrong Door"), use it
      } else if (!titleLower.includes(headLower)) {
        title = `${title} — ${heading}`; // genuinely different info, combine both
      }
      // If title already includes the heading text, keep title as-is
    }

    return {
      index: i,
      title,
      text: ch.text,
      href: ch.href,
    };
  });

  return chapters;
}

async function parseTxt(file) {
  const text = await file.text();
  // Split on chapter headings
  const chapterRegex = /\n(chapter\s+[\divxlc]+[^\n]*)\n/gi;
  const parts = text.split(chapterRegex);
  if (parts.length < 3) {
    // No chapter markers — treat as one big chapter
    return [{ index: 0, title: file.name.replace(/\.[^.]+$/, ""), text: text.trim() }];
  }
  const chapters = [];
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim();
    const body = (parts[i + 1] || "").trim();
    if (body.length > 200) chapters.push({ index: chapters.length, title, text: body });
  }
  return chapters;
}


// ── SHA-256 hash of full book text ───────────────────────────────────────────
async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text.slice(0, 500000));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ── Persistent storage — backed by server KV store ──────────────────────────
//
// Previously, all data (books, progress, illustrations, caches) lived in
// localStorage, which is browser-local and easily lost. The storageGet/storageSet
// helpers below already checked for a window.storage pluggable backend before
// falling back to localStorage. By setting window.storage here to an object that
// calls the server's /api/kv endpoints, all existing call sites (both here and
// in wordRecords.js) automatically persist to the server with no further changes.
window.storage = {
  async get(key) {
    const res = await fetch(`/api/kv/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return await res.json();
  },
  async set(key, value) {
    await fetch(`/api/kv/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  },
  async delete(key) {
    await fetch(`/api/kv/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },
};

async function storageGet(key) {
  try {
    const result = await window.storage.get(key);
    return result ? JSON.parse(result.value) : null;
  } catch { return null; }
}

async function storageSet(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value));
  } catch (e) { console.warn("Storage write failed:", e); }
}

// ── Book library helpers ──────────────────────────────────────────────────────
const BOOK_INDEX_KEY = "vocab-books-index";

async function getBookIndex() {
  return (await storageGet(BOOK_INDEX_KEY)) || [];
}

async function saveBookToLibrary({ chapters, bookTitle, fullText }) {
  const hash = await hashText(fullText);
  const index = await getBookIndex();
  // Don't duplicate
  if (index.find(b => b.hash === hash)) return hash;
  index.unshift({ title: bookTitle, hash, chapterCount: chapters.length, savedAt: new Date().toISOString() });
  await storageSet(BOOK_INDEX_KEY, index);
  await storageSet(`vocab-book-${hash}`, { chapters, bookTitle, fullText });
  return hash;
}

async function loadBookFromLibrary(hash) {
  return await storageGet(`vocab-book-${hash}`);
}

async function deleteBookFromLibrary(hash) {
  const bookData = await loadBookFromLibrary(hash);
  if (bookData) {
    await flushWordCaches(bookData);
    await flushIllustrationCaches(bookData);
  }
  await flushStoryBible(hash);
  // Remove book data and index entry
  try { await window.storage.delete(`vocab-book-${hash}`); } catch {}
  const index = await getBookIndex();
  await storageSet(BOOK_INDEX_KEY, index.filter(b => b.hash !== hash));
}

async function flushWordCaches(bookData) {
  for (const ch of bookData.chapters || []) {
    const chapterHash = await hashText(ch.text);
    try { await window.storage.delete(`wordlist-${chapterHash}`); } catch {}
  }
}

async function flushStoryBible(bookHash) {
  try { await window.storage.delete(`storybible-${bookHash}`); } catch {}
}

async function flushIllustrationCaches(bookData) {
  for (const ch of bookData.chapters || []) {
    const chapterHash = await hashText(ch.text);
    const indexKey = `illust-index-${chapterHash}`;
    const words = (await storageGet(indexKey)) || [];
    for (const w of words) {
      try { await window.storage.delete(`illust-${chapterHash}-${w}`); } catch {}
    }
    try { await window.storage.delete(indexKey); } catch {}
  }
}

// ── Story Bible generation ────────────────────────────────────────────────────
async function generateStoryBible(fullText, bookTitle) {
  const sample = fullText.slice(0, 60000);
  const wordCount = fullText.split(/\s+/).length;
  const isSample = fullText.length > 60000;

  return claudeJSON(
    `You are a visual development artist preparing a Style Bible for an illustrated children's book app.

Analyze this ${isSample ? "opening section" : "full text"} of "${bookTitle}" and produce a Story Bible ensuring visual consistency across all AI-generated illustrations.

For each named character who appears, capture:
- Precise physical appearance (age, build, hair color/style, eye color, skin tone)  
- Typical clothing (specific garments, colors, condition)
- Key visual details that make them recognizable

For each named location, capture:
- Architecture and spatial feel
- Lighting conditions
- Color palette, textures, atmosphere

Also define a single illustration style for all images.

Respond ONLY with valid JSON:
{
  "bookTitle": "${bookTitle}",
  "isSample": ${isSample},
  "styleConstants": "painterly Victorian storybook illustration, oil paint texture, warm amber and cool grey palette, soft chiaroscuro lighting, no text in image",
  "characters": [
    {
      "name": "Sara Crewe",
      "aliases": ["Sara", "the little girl"],
      "promptFragment": "Sara Crewe: slight ten-year-old girl, tangled dark hair, large solemn dark eyes, hollow cheeks, oversized grey pinafore with frayed hem, worn black boots"
    }
  ],
  "settings": [
    {
      "name": "The Attic",
      "aliases": ["attic room", "her room"],
      "promptFragment": "cold attic garret, sloping wooden eaves, bare floorboards, grimy skylight casting blue-grey light, single tallow candle"
    }
  ]
}

Book text:
${sample}`,
    "You are a visual development expert. Always respond with valid JSON only, no markdown.",
    4000
  );
}

// ── Load or generate Story Bible (with cache) ─────────────────────────────────
async function getStoryBible(fullText, bookTitle, onStatus) {
  const hash = await hashText(fullText);
  const cacheKey = `storybible-${hash}`;

  onStatus({ step: "checking", message: "Checking for saved Story Bible…" });
  const cached = await storageGet(cacheKey);
  if (cached) {
    onStatus({ step: "cached", message: `Loaded from cache · ${cached.characters?.length || 0} characters · ${cached.settings?.length || 0} settings` });
    return { bible: cached, hash, fromCache: true };
  }

  onStatus({ step: "generating", message: "Reading the book and building Story Bible… (once per book)" });
  const bible = await generateStoryBible(fullText, bookTitle);
  bible.generatedAt = new Date().toISOString();
  bible.bookHash = hash;
  await storageSet(cacheKey, bible);
  onStatus({ step: "saved", message: `Story Bible built · ${bible.characters?.length || 0} characters · ${bible.settings?.length || 0} settings` });
  return { bible, hash, fromCache: false };
}




// ── Gemini image generation (proxied through Express server) ─────────────────
const GEMINI_IMAGE_MODELS = [
  { id: "gemini-2.5-flash-image",        label: "Gemini 2.5 Flash (fast)" },
  { id: "gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash (preview)" },
  { id: "gemini-3-pro-image-preview",     label: "Gemini 3 Pro (best quality)" },
];
const GEMINI_MODEL_KEY = "vocab-gemini-model";
function getImageAspectHint() {
  const isLandscape = window.matchMedia("(orientation: landscape)").matches;
  return isLandscape ? "3:4 portrait orientation" : "3:2 landscape orientation";
}

async function generateGeminiImageDirect(prompt, modelId = "gemini-2.5-flash-image") {
  const aspectHint = getImageAspectHint();
  try {
    const res = await fetch(`/api/gemini/${modelId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt}\n\nGenerate this image in ${aspectHint} aspect ratio.` }] }],
        generationConfig: { responseModalities: ["Image"] },
      }),
    });
    const data = await res.json();
    if (data.error) { console.warn("Gemini error:", data.error.message); return null; }
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData);
    if (!imgPart) { console.warn("Gemini: no image in response"); return null; }
    return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
  } catch (e) {
    console.warn("Gemini fetch failed:", e.message);
    return null;
  }
}

// ── Claude API helper ─────────────────────────────────────────────────────────
async function claudeJSON(prompt, system = "", maxTokens = 2000) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const url = "/api/claude";
  const headers = { "Content-Type": "application/json" };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 401) { window.location.href = '/login'; return; }
  const data = await res.json();
  if (data.error) throw new Error(`API error: ${data.error.message}`);
  const raw = (data.content || []).map(b => b.text || "").join("");
  if (!raw) throw new Error("Empty response from API");
  // Extract JSON — match either an array [...] or object {...}, whichever comes first
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  const objMatch = raw.match(/\{[\s\S]*\}/);
  const arrIdx = arrMatch ? raw.indexOf(arrMatch[0]) : Infinity;
  const objIdx = objMatch ? raw.indexOf(objMatch[0]) : Infinity;
  const jsonStr = arrIdx < objIdx ? arrMatch[0] : objMatch?.[0];
  if (!jsonStr) throw new Error(`No JSON found in response: ${raw.slice(0, 200)}`);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}. Raw: ${jsonStr.slice(0, 300)}`);
  }
}

// ── Word suggestion ───────────────────────────────────────────────────────────
// Extract ~4 sentences of context around a word's position in the chapter text
// Find the true position of a word in the full chapter text.
// Returns -1 if the word does not actually appear in the text.
function findWordInText(chapterText, word) {
  const wordRe = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const m = wordRe.exec(chapterText);
  return m ? m.index : -1;
}

// Extract ~5 sentences of context centred on the word's actual position.
function extractContext(chapterText, wordPos) {
  const sentenceRe = /[^.!?]+[.!?]+[\u201d"']?/g;
  const sentences = [];
  let m;
  while ((m = sentenceRe.exec(chapterText)) !== null) {
    sentences.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  }

  const targetIdx = sentences.findIndex(s => s.start <= wordPos && s.end >= wordPos);
  if (targetIdx === -1) {
    return chapterText.slice(Math.max(0, wordPos - 300), wordPos + 300).trim();
  }

  const start = Math.max(0, targetIdx - 2);
  const end = Math.min(sentences.length - 1, targetIdx + 2);
  return sentences.slice(start, end + 1).map(s => s.text).join(" ").trim();
}

async function suggestWords(chapterText, n = 20) {
  // Use up to 12000 chars so short chapters are fully covered and longer ones have enough material
  const truncated = chapterText.slice(0, 12000);
  // Ask for up to n words but instruct Claude to return fewer if the text doesn't have enough
  const result = await claudeJSON(
    `You are a vocabulary tutor. Analyze this chapter text and identify up to ${n} valuable vocabulary words for a middle-grade reader (ages 10-14). If the text does not contain ${n} suitable words, return as many as you can find — even just a few is fine.

Prioritize words that:
- Are SAT/ACT level or have strong literary value
- Appear in a rich, meaningful context in the passage
- Would deepen comprehension and enjoyment of the story
- Are not too obscure or archaic to be useful

CRITICAL: Only suggest words that LITERALLY APPEAR verbatim in the chapter text below. Do not suggest synonyms, related words, or words you think should be there. If you cannot find the exact word in the text, do not include it.

For each word provide the approximate character index (charIndex) where it first appears.

Respond ONLY with a raw JSON object, no markdown, no preamble:
{"words":[{"word":"languidly","charIndex":1240,"reason":"SAT word; vividly shows Sara\'s exhausted, slow movements"}]}

Chapter text:
${truncated}`,
    "You are a vocabulary education expert. Respond with valid JSON only — no markdown fences, no explanation, just the JSON object.",
    4000
  );

  // Verify each word actually exists in the text and extract real context
  const words = (result.words || [])
    .map(w => {
      const actualPos = findWordInText(chapterText, w.word);
      if (actualPos === -1) return null; // word not in text — discard
      return {
        ...w,
        charIndex: actualPos,
        paragraph: extractContext(chapterText, actualPos),
      };
    })
    .filter(Boolean); // remove any nulls

  return { words };
}

// ── Asset generation for one word ────────────────────────────────────────────
function shuffleOptions({ correct, options }) {
  const correctText = options[correct];
  const others = options.filter((_, i) => i !== correct);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const idx = Math.floor(Math.random() * 4);
  const newOptions = [...others];
  newOptions.splice(idx, 0, correctText);
  return { correct: idx, options: newOptions };
}

async function generateAllWordAssets(words, bookTitle, chapterText, bible = null) {
  // Cache quiz data (definitions, hints) so replaying the same words skips the
  // Claude call. The cache key is based on chapter + sorted word list, so choosing
  // different words from the same chapter produces a different key. Option order
  // is re-shuffled on every play so the game doesn't feel identical.
  const chHash = chapterText ? await hashText(chapterText) : null;
  const wordKey = words.map(w => w.word.toLowerCase()).sort().join(",");
  const cacheKey = chHash ? `quiz-${chHash}-${await hashText(wordKey)}` : null;

  let arr;
  const cached = cacheKey ? await storageGet(cacheKey) : null;

  if (cached) {
    arr = cached;
  } else {
    // Build a single prompt covering all words at once
    const wordList = words.map((w, i) =>
      `${i + 1}. Word: "${w.word}"\n   Passage: "${w.paragraph.slice(0, 300)}"`
    ).join("\n\n");

    const result = await claudeJSON(
      `You are preparing a vocabulary game for middle-grade readers (ages 10-14) of "${bookTitle}".

For each word below, generate:
- 4 multiple choice options (correct definition first at index 0, then 3 plausible wrong distractors)
- A one-sentence hint for a player who guessed wrong (points to context without giving the answer)

${wordList}

Respond ONLY with a raw JSON array, one object per word, in the same order:
[
  {
    "word": "languidly",
    "correct": 0,
    "options": ["in a slow, dreamy, effortless way", "with great energy and enthusiasm", "carefully and precisely", "loudly and confidently"],
    "hint": "Look at how Sara is moving — does she seem full of energy, or like even lifting her arms takes effort?"
  }
]`,
      "You are a vocabulary education expert. Respond with a valid JSON array only — no markdown, no explanation.",
      Math.min(16000, words.length * 700 + 1000)
    );

    // result may be an array directly or wrapped in an object
    arr = Array.isArray(result) ? result : (result.words || result.items || Object.values(result));

    if (cacheKey) await storageSet(cacheKey, arr);
  }

  return arr.map((item, i) => {
    const w = words[i];
    return {
      word: w.word,
      paragraph: w.paragraph,
      options: shuffleOptions({ correct: item.correct ?? 0, options: item.options }),
      hint: item.hint,
    };
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Lora:ital,wght@0,400;0,600;1,400&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --gold: #d4a843;
    --gold-dim: #b8902a;
    --gold-faint: rgba(180,130,50,0.18);
    --bg: #1c1509;
    --card-bg: linear-gradient(160deg, #2a1f0e 0%, #1e1508 100%);
    --text: #e8d5a3;
    --text-dim: #c9b882;
    --border: rgba(180,130,50,0.2);
    --correct: rgba(80,160,80,0.15);
    --correct-border: rgba(100,200,100,0.45);
    --correct-text: #a0e0a0;
    --wrong: rgba(180,60,60,0.12);
    --wrong-border: rgba(200,80,80,0.4);
    --wrong-text: #e09090;
    --retry-text: #d4b86a;
  }
  body { background: var(--bg); }
  .app {
    min-height: 100vh;
    background: var(--bg);
    background-image: radial-gradient(ellipse at 15% 10%, rgba(180,130,50,0.07) 0%, transparent 55%),
                      radial-gradient(ellipse at 85% 90%, rgba(120,60,20,0.09) 0%, transparent 55%);
    font-family: 'Lora', serif;
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 16px 80px;
  }
  .app-title { text-align: center; margin-bottom: 36px; }
  .app-title h1 { font-family: 'Playfair Display', serif; font-size: 28px; font-weight: 700; color: var(--gold); letter-spacing: 0.02em; }
  .app-title p { font-size: 13px; color: var(--gold-dim); opacity: 0.7; margin-top: 4px; font-style: italic; }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 8px 48px rgba(0,0,0,0.55), inset 0 1px 0 rgba(180,130,50,0.08);
    width: 100%;
    max-width: 660px;
    overflow: hidden;
  }
  .card-body { padding: 28px 32px 32px; }
  .card-section { padding: 22px 32px; border-bottom: 1px solid rgba(180,130,50,0.08); }
  .section-label { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(184,144,42,0.5); margin-bottom: 10px; }

  /* Upload */
  .upload-zone {
    border: 2px dashed rgba(180,130,50,0.3);
    border-radius: 4px;
    padding: 48px 24px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
    margin-bottom: 0;
  }
  .upload-zone:hover, .upload-zone.drag-over { border-color: rgba(180,130,50,0.6); background: rgba(180,130,50,0.05); }
  .upload-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.5; }
  .upload-zone h2 { font-family: 'Playfair Display', serif; font-size: 20px; color: var(--gold); margin-bottom: 8px; }
  .upload-zone p { font-size: 13px; color: var(--text-dim); line-height: 1.6; }
  .upload-zone input { display: none; }

  /* Book library */
  .book-library { margin-bottom: 20px; }
  .book-library-label { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(184,144,42,0.5); margin-bottom: 10px; }
  .book-entry { margin-bottom: 8px; }
  .book-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border: 1px solid rgba(180,130,50,0.15); border-radius: 3px;
    cursor: pointer; transition: all 0.15s;
  }
  .book-entry:has(.book-cache-panel) .book-item { border-radius: 3px 3px 0 0; margin-bottom: 0; }
  .book-item:hover { background: rgba(180,130,50,0.07); border-color: rgba(180,130,50,0.35); }
  .book-item-info { flex: 1; min-width: 0; }
  .book-item-title { font-family: 'Playfair Display', serif; font-size: 15px; color: var(--gold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .book-item-meta { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
  .book-item-actions { flex-shrink: 0; margin-left: 12px; display: flex; gap: 6px; align-items: center; }
  .book-item-btn {
    padding: 4px 10px; font-size: 11px; border-radius: 3px; cursor: pointer; transition: all 0.15s;
    background: rgba(180,130,50,0.08); border: 1px solid rgba(180,130,50,0.2); color: rgba(184,144,42,0.6);
  }
  .book-item-btn:hover { background: rgba(180,130,50,0.15); border-color: rgba(180,130,50,0.35); }
  .book-item-btn.kebab { font-weight: bold; letter-spacing: 1px; padding: 4px 8px; }
  .book-item-btn.remove { color: #c08080; border-color: rgba(200,80,80,0.2); background: rgba(200,80,80,0.08); font-size: 14px; padding: 2px 8px; line-height: 1; }
  .book-item-btn.remove:hover { background: rgba(200,80,80,0.2); border-color: rgba(200,80,80,0.4); }
  .book-cache-panel {
    padding: 12px 16px; margin: 0 0 8px; background: rgba(0,0,0,0.18);
    border: 1px solid rgba(180,130,50,0.1); border-top: none; border-radius: 0 0 3px 3px;
  }
  .cache-panel-label { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(184,144,42,0.4); margin-bottom: 8px; }
  .cache-layer-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-size: 12px; color: var(--text-dim); }
  .cache-layer-cost { font-size: 10px; opacity: 0.45; }
  .cache-flush-btn {
    padding: 3px 10px; font-size: 10px; border-radius: 3px; cursor: pointer; transition: all 0.15s;
    background: rgba(180,130,50,0.1); border: 1px solid rgba(180,130,50,0.2); color: rgba(184,144,42,0.6);
  }
  .cache-flush-btn:hover { background: rgba(180,130,50,0.2); border-color: rgba(180,130,50,0.35); }
  .cache-flush-all {
    margin-top: 8px; width: 100%; padding: 6px; font-size: 11px; border-radius: 3px; cursor: pointer;
    background: rgba(200,80,80,0.08); border: 1px solid rgba(200,80,80,0.2); color: #c08080; transition: all 0.15s;
  }
  .cache-flush-all:hover { background: rgba(200,80,80,0.15); border-color: rgba(200,80,80,0.35); }
  .library-divider { display: flex; align-items: center; gap: 12px; margin: 20px 0; color: var(--text-dim); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; }
  .library-divider::before, .library-divider::after { content: ""; flex: 1; border-top: 1px solid rgba(180,130,50,0.12); }

  /* Chapter list */
  .chapter-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; padding-right: 4px; }
  .chapter-list::-webkit-scrollbar { width: 4px; }
  .chapter-list::-webkit-scrollbar-track { background: transparent; }
  .chapter-list::-webkit-scrollbar-thumb { background: rgba(180,130,50,0.3); border-radius: 2px; }
  .chapter-btn {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(180,130,50,0.14);
    border-radius: 3px;
    padding: 11px 16px;
    font-family: 'Lora', serif;
    font-size: 14px;
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .chapter-btn:hover { background: rgba(180,130,50,0.08); border-color: rgba(180,130,50,0.35); color: var(--text); }
  .chapter-btn .ch-words { font-size: 11px; opacity: 0.5; }

  /* Word count selector */
  .count-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .count-label { font-size: 14px; color: var(--text-dim); }
  .count-btn { background: rgba(180,130,50,0.1); border: 1px solid rgba(180,130,50,0.3); border-radius: 3px; width: 32px; height: 32px; font-size: 18px; color: var(--gold); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
  .count-btn:hover { background: rgba(180,130,50,0.2); }
  .count-val { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; color: var(--gold); width: 32px; text-align: center; }

  /* Word suggestion list */
  .word-suggestion {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 16px;
    border: 1px solid rgba(180,130,50,0.12);
    border-radius: 3px;
    background: rgba(255,255,255,0.02);
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .word-suggestion:hover { background: rgba(180,130,50,0.06); border-color: rgba(180,130,50,0.3); }
  .word-suggestion.selected { background: rgba(180,130,50,0.1); border-color: rgba(180,130,50,0.4); }
  .word-suggestion.suggested { border-color: rgba(180,130,50,0.3); }
  .ws-check { width: 20px; height: 20px; border: 1.5px solid rgba(180,130,50,0.4); border-radius: 3px; flex-shrink: 0; margin-top: 2px; display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--gold); }
  .word-suggestion.selected .ws-check { background: rgba(180,130,50,0.2); }
  .ws-word { font-family: 'Playfair Display', serif; font-size: 17px; font-weight: 700; color: var(--gold); }
  .ws-badge { display: inline-block; font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold-dim); border: 1px solid rgba(180,130,50,0.3); border-radius: 2px; padding: 1px 5px; margin-left: 8px; vertical-align: middle; }
  .ws-reason { font-size: 12.5px; color: var(--text-dim); margin-top: 3px; line-height: 1.5; font-style: italic; }

  /* Generation progress */
  .gen-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .gen-item { border: 1px solid rgba(180,130,50,0.15); border-radius: 3px; padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
  .gen-item.done { border-color: var(--correct-border); background: rgba(80,160,80,0.06); }
  .gen-item.active { border-color: rgba(180,130,50,0.4); }
  .gen-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(180,130,50,0.3); flex-shrink: 0; }
  .gen-item.done .gen-dot { background: var(--correct-text); }
  .gen-item.active .gen-dot { background: var(--gold); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .gen-word { font-family: 'Playfair Display', serif; font-size: 14px; color: var(--text-dim); }
  .gen-item.done .gen-word { color: var(--correct-text); }
  .gen-item.active .gen-word { color: var(--gold); }

  /* Game – quiz card with illustration + question content */
  @keyframes imgFade { from{opacity:0} to{opacity:1} }
  /* No background color — the card gradient shows through around contain-fitted images
     instead of harsh black bars */
  .illustration-area { width: 100%; overflow: hidden; }
  .illustration-area img { width: 100%; height: auto; max-height: 28vh; object-fit: contain; display: block; animation: imgFade 0.8s ease; }
  .word-banner { padding: 18px 32px 14px; border-bottom: 1px solid rgba(180,130,50,0.1); display: flex; align-items: baseline; gap: 14px; }
  .vocab-word { font-family: 'Playfair Display', serif; font-size: 34px; font-weight: 700; color: var(--gold); }
  .word-pos { font-size: 12px; font-style: italic; color: rgba(184,144,42,0.55); }
  .paragraph-text { font-size: 15px; line-height: 1.6; color: var(--text-dim); font-style: italic; }
  .paragraph-text mark { background: rgba(212,168,67,0.17); color: #e8c96a; border-radius: 2px; padding: 1px 3px; font-style: italic; }
  .question-text { font-family: 'Playfair Display', serif; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; }
  .options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .opt-btn {
    background: rgba(255,255,255,0.025);
    border: 1px solid rgba(180,130,50,0.16);
    border-radius: 3px;
    padding: 12px 14px;
    font-family: 'Lora', serif;
    font-size: 13.5px;
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    line-height: 1.45;
    transition: all 0.15s;
  }
  .opt-btn:hover:not(:disabled) { background: rgba(180,130,50,0.09); border-color: rgba(180,130,50,0.38); color: var(--text); }
  .opt-btn.correct { background: var(--correct); border-color: var(--correct-border); color: var(--correct-text); }
  .opt-btn.eliminated { opacity: 0.28; cursor: not-allowed; background: rgba(255,255,255,0.01); border-color: rgba(180,130,50,0.08); color: rgba(200,180,140,0.4); text-decoration: line-through; text-decoration-color: rgba(200,180,140,0.2); }
  .opt-btn.blank-opt { font-family: "Playfair Display", serif; font-style: italic; font-size: 14.5px; }
  .options-grid.blank-options { grid-template-columns: 1fr; max-width: 360px; }
  .blank-word { display: inline-block; background: rgba(180,130,50,0.12); border-bottom: 2px solid rgba(180,130,50,0.5); border-radius: 2px; padding: 0 6px; min-width: 80px; text-align: center; font-style: normal; letter-spacing: 0.05em; }
  .opt-btn:disabled:not(.correct):not(.wrong) { opacity: 0.5; cursor: default; }
  .opt-letter { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: rgba(180,130,50,0.45); margin-bottom: 3px; font-style: normal; }
  .feedback-banner { margin-top: 16px; padding: 13px 16px; border-radius: 3px; font-size: 13.5px; line-height: 1.55; animation: fadeUp 0.3s ease; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
  .feedback-banner.hint { background: rgba(180,130,30,0.1); border: 1px solid rgba(180,130,30,0.28); color: #d4b86a; }
  .feedback-banner.correct { background: var(--correct); border: 1px solid var(--correct-border); color: var(--correct-text); }
  .fb-head { font-family: 'Playfair Display', serif; font-size: 15px; font-weight: 700; margin-bottom: 4px; }
  .next-btn { margin-top: 22px; width: 100%; background: rgba(180,130,50,0.1); border: 1px solid rgba(180,130,50,0.32); border-radius: 3px; padding: 13px; font-family: 'Playfair Display', serif; font-size: 15px; font-weight: 700; color: var(--gold); cursor: pointer; letter-spacing: 0.03em; transition: all 0.15s; }
  .next-btn:hover { background: rgba(180,130,50,0.18); border-color: rgba(180,130,50,0.55); }
  .primary-btn { background: rgba(180,130,50,0.15); border: 1px solid rgba(180,130,50,0.4); border-radius: 3px; padding: 12px 28px; font-family: 'Playfair Display', serif; font-size: 15px; font-weight: 700; color: var(--gold); cursor: pointer; transition: all 0.15s; letter-spacing: 0.03em; }
  .primary-btn:hover { background: rgba(180,130,50,0.25); }
  .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .secondary-btn { background: transparent; border: 1px solid rgba(180,130,50,0.25); border-radius: 3px; padding: 8px 20px; font-family: 'Playfair Display', serif; font-size: 13px; color: var(--gold-dim); cursor: pointer; transition: all 0.15s; letter-spacing: 0.03em; }
  .secondary-btn:hover { border-color: rgba(180,130,50,0.45); color: var(--gold); }

  /* Score strip */
  .score-strip { display: flex; justify-content: center; gap: 7px; margin-bottom: 20px; flex-wrap: wrap; }
  .score-dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid rgba(180,130,50,0.28); background: transparent; transition: all 0.3s; }
  .score-dot.current { border-color: rgba(180,130,50,0.7); background: rgba(180,130,50,0.3); }
  .score-dot.correct { background: rgba(80,160,80,0.7); border-color: var(--correct-border); }
  .score-dot.retry { background: rgba(200,160,40,0.7); border-color: rgba(220,180,60,0.55); }
  .score-dot.retest { background: rgba(100,160,220,0.7); border-color: rgba(120,180,240,0.55); }

  /* Results */
  .results-word-card {
    display: flex; align-items: center; justify-content: space-between;
    border-radius: 3px; padding: 10px 16px; margin-bottom: 8px;
  }
  .rwc-word { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 17px; }
  .rwc-label { font-size: 12px; opacity: 0.8; letter-spacing: 0.04em; }

  .spinner { width: 32px; height: 32px; border: 2px solid rgba(180,130,50,0.15); border-top-color: rgba(180,130,50,0.7); border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .mini-spinner { width: 14px; height: 14px; border: 1.5px solid rgba(180,130,50,0.15); border-top-color: rgba(180,130,50,0.6); border-radius: 50%; animation: spin 0.8s linear infinite; }

  /* ── Tablet responsive ──────────────────────────────────────────────────── */

  /* Touch targets: raise all interactive elements to ≥44px on touch screens */
  @media (pointer: coarse) {
    .chapter-btn { padding: 14px 16px; min-height: 44px; }
    .opt-btn { padding: 14px 14px; min-height: 44px; }
    .next-btn { padding: 16px; min-height: 44px; }
    .primary-btn { padding: 14px 28px; min-height: 44px; }
    .secondary-btn { padding: 11px 20px; min-height: 44px; }
    .count-btn { width: 44px; height: 44px; font-size: 20px; }
    .count-val { width: 44px; }
    .word-suggestion { padding: 16px 16px; }
    .ws-check { width: 24px; height: 24px; font-size: 15px; }
  }

  /* Small tablets and up (≥600px): expand card and breathing room */
  @media (min-width: 600px) {
    .card { max-width: 720px; }
    .app { padding: 40px 24px 80px; }
  }

  /* Portrait tablet and up (≥768px): larger layout, more readable type */
  @media (min-width: 768px) {
    .card { max-width: 800px; }
    .app { padding: 48px 32px 80px; }
    .card-body { padding: 32px 40px 40px; }
    .card-section { padding: 26px 40px; }
    .word-banner { padding: 20px 40px 16px; }
    .chapter-list { max-height: 560px; }
    .opt-btn { font-size: 14.5px; line-height: 1.5; }
    .opt-btn.blank-opt { font-size: 15.5px; }
    .vocab-word { font-size: 38px; }
    .question-text { font-size: 18px; }
    .paragraph-text { font-size: 16px; }
    .options-grid { gap: 12px; }
    .gen-grid { gap: 12px; }
    .upload-zone { padding: 56px 32px; }
    .upload-zone h2 { font-size: 22px; }
    .ws-word { font-size: 18px; }
    .ws-reason { font-size: 13.5px; }
  }

  /* Landscape tablet and up (≥1024px): make use of the wider viewport */
  @media (min-width: 1024px) {
    .card { max-width: 860px; }
    .app { padding: 56px 40px 80px; }
    .options-grid { gap: 14px; }
    .app-title { margin-bottom: 44px; }
    .app-title h1 { font-size: 32px; }
  }

  /* .game-active is added to .app only during the question phase.
     The card uses a 2-row equal grid so the illustration and question content
     are the same height and vertically centered in the viewport.
     Portrait: image on top, content below (grid rows).
     Landscape: image on left, content on right (grid columns). */
  .app.game-active { padding: 14px; height: 100dvh; box-sizing: border-box; justify-content: center; }
  .app.game-active > .card { display: grid; grid-template-rows: 1fr 1fr; max-height: calc(100dvh - 80px); overflow: hidden; }
  .app.game-active .illustration-area { min-height: 0; display: flex; align-items: center; justify-content: center; padding: 5%; }
  .app.game-active .illustration-area img { width: 100%; height: 100%; max-height: none; object-fit: contain; }
  .app.game-active .game-content { min-height: 0; overflow-y: auto; }
  .app.game-active .card-section { padding-top: 14px; padding-bottom: 14px; }
  .app.game-active .card-section:last-child { padding-bottom: 20px; }
  .app.game-active .word-banner { padding-top: 12px; padding-bottom: 10px; }
  .app.game-active .question-text { font-size: 15px; margin-bottom: 10px; }
  .app.game-active .paragraph-text { font-size: 13.5px; line-height: 1.6; }
  .app.game-active .vocab-word { font-size: 28px; }
  .app.game-active .options-grid { gap: 8px; }
  .app.game-active .opt-btn { padding: 10px 12px; font-size: 13px; min-height: 0; }
  @media (min-width: 768px) {
    .app.game-active .opt-btn { font-size: 13.5px; }
    .app.game-active .question-text { font-size: 16px; }
    .app.game-active .paragraph-text { font-size: 14px; }
  }
  @media (orientation: landscape) {
    .app.game-active > .card:has(.illustration-area) { grid-template-rows: none; grid-template-columns: 1fr 1fr; }
    .app.game-active .illustration-area img { height: 100%; width: 100%; }
    .app.game-active .game-content { display: flex; flex-direction: column; }
  }
`;

// ── Highlight word in paragraph ───────────────────────────────────────────────
function Highlighted({ paragraph, word }) {
  const re = new RegExp(`(${word})`, "i");
  const parts = paragraph.split(re);
  return <>{parts.map((p, i) => re.test(p) ? <mark key={i}>{p}</mark> : p)}</>;
}

// ── Build image prompt using Story Bible ──────────────────────────────────────
function buildImagePrompt(paragraph, bible) {
  if (!bible) {
    return `Painterly Victorian storybook illustration depicting: "${paragraph.slice(0, 250)}". Warm amber and cool grey palette, soft chiaroscuro lighting, oil paint texture, no text in image.`;
  }
  const paraLower = paragraph.toLowerCase();
  const namedSettings = (bible.settings || []).filter(s =>
    [s.name, ...(s.aliases || [])].some(n => paraLower.includes(n.toLowerCase()))
  );
  const style = "painterly Victorian storybook illustration, warm amber and cool grey palette, soft chiaroscuro lighting, oil paint texture, no text in image";
  // Always include all characters as reference so appearances stay consistent across every image
  const allChars = (bible.characters || []).slice(0, 5);
  const parts = [
    `Storybook illustration depicting this scene: "${paragraph.slice(0, 300)}"`,
    allChars.length && `Character reference (keep appearance consistent) — ${allChars.map(c => c.promptFragment).join("; ")}`,
    namedSettings.length && `Setting — ${namedSettings.map(s => s.promptFragment).join("; ")}`,
    `Style: ${style}`,
  ].filter(Boolean);
  return parts.join(". ");
}

// ── Phase: UPLOAD ─────────────────────────────────────────────────────────────
function UploadPhase({ onParsed }) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [library, setLibrary] = useState([]);
  const [expandedBook, setExpandedBook] = useState(null);
  const [flushed, setFlushed] = useState({}); // { "hash-layer": true } for brief confirmation
  const inputRef = useRef();

  useEffect(() => { getBookIndex().then(setLibrary); }, []);

  async function handleFile(file) {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      let chapters;
      if (file.name.endsWith(".epub")) chapters = await parseEpub(file);
      else if (file.name.endsWith(".txt")) chapters = await parseTxt(file);
      else throw new Error("Please upload an EPUB or TXT file.");
      if (!chapters.length) throw new Error("Couldn't find any chapters in this file.");
      const fullText = chapters.map(c => c.text).join("\n\n");
      const bookTitle = file.name.replace(/\.[^.]+$/, "");
      const bookData = { chapters, bookTitle, fullText };
      await saveBookToLibrary(bookData);
      onParsed(bookData);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function handleSelectBook(hash) {
    setLoading(true); setError(null);
    try {
      const bookData = await loadBookFromLibrary(hash);
      if (!bookData) throw new Error("Book data not found in cache. Please re-upload.");
      onParsed(bookData);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function handleDeleteBook(e, hash) {
    e.stopPropagation();
    await deleteBookFromLibrary(hash);
    setExpandedBook(null);
    setLibrary(await getBookIndex());
  }

  async function handleFlush(e, hash, layer) {
    e.stopPropagation();
    const bookData = await loadBookFromLibrary(hash);
    if (!bookData) return;
    if (layer === "bible" || layer === "all") await flushStoryBible(hash);
    if (layer === "illustrations" || layer === "all") await flushIllustrationCaches(bookData);
    if (layer === "words" || layer === "all") await flushWordCaches(bookData);
    setFlushed(prev => ({ ...prev, [`${hash}-${layer}`]: true }));
    setTimeout(() => setFlushed(prev => { const n = { ...prev }; delete n[`${hash}-${layer}`]; return n; }), 1500);
  }

  return (
    <div className="card">
      <div className="card-body">
        {library.length > 0 && (
          <div className="book-library">
            <div className="book-library-label">Your books</div>
            {library.map(b => (
              <div key={b.hash} className="book-entry">
                <div className="book-item" onClick={() => handleSelectBook(b.hash)}>
                  <div className="book-item-info">
                    <div className="book-item-title">{b.title}</div>
                    <div className="book-item-meta">{b.chapterCount} chapter{b.chapterCount !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="book-item-actions">
                    <button className="book-item-btn kebab" onClick={e => { e.stopPropagation(); setExpandedBook(expandedBook === b.hash ? null : b.hash); }} title="Cache settings">...</button>
                    <button className="book-item-btn remove" onClick={e => handleDeleteBook(e, b.hash)} title="Remove book and all cached data">&times;</button>
                  </div>
                </div>
                {expandedBook === b.hash && (
                  <div className="book-cache-panel" onClick={e => e.stopPropagation()}>
                    <div className="cache-panel-label">Flush cached data</div>
                    {[
                      { layer: "bible", label: "Story Bible", cost: "slowest to regenerate" },
                      { layer: "illustrations", label: "Illustrations", cost: "moderate" },
                      { layer: "words", label: "Word Lists", cost: "fast" },
                    ].map(({ layer, label, cost }) => (
                      <div key={layer} className="cache-layer-row">
                        <span>{label} <span className="cache-layer-cost">({cost})</span></span>
                        <button className="cache-flush-btn" onClick={e => handleFlush(e, b.hash, layer)}>
                          {flushed[`${b.hash}-${layer}`] ? "done" : "flush"}
                        </button>
                      </div>
                    ))}
                    <button className="cache-flush-all" onClick={e => handleFlush(e, b.hash, "all")}>
                      {flushed[`${b.hash}-all`] ? "All cleared" : "Flush All"}
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="library-divider">or upload a new book</div>
          </div>
        )}
        <div
          className={`upload-zone ${dragging ? "drag-over" : ""}`}
          onClick={() => inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
        >
          <input ref={inputRef} type="file" accept=".epub,.txt" onChange={e => handleFile(e.target.files[0])} />
          {loading ? (
            <><div className="spinner" style={{margin:"0 auto 16px"}}/><p>Loading…</p></>
          ) : (
            <>
              <div className="upload-icon">📖</div>
              <h2>Upload your book</h2>
              <p>Drop an <strong>EPUB</strong> or <strong>TXT</strong> file here, or click to browse.<br/>EPUB recommended for accurate chapter detection.</p>
              {error && <p style={{color:"#e09090",marginTop:12}}>{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Phase: CHAPTER SELECT ─────────────────────────────────────────────────────
function ChapterPhase({ chapters, bookTitle, storyBible, onSelect }) {
  return (
    <div className="card">
      <div className="card-body">
        <div className="section-label">Choose a chapter — {bookTitle}</div>

        {storyBible && (
          <div style={{marginBottom:16,padding:"10px 14px",background:"rgba(180,130,50,0.07)",border:"1px solid rgba(180,130,50,0.2)",borderRadius:3,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:14}}>✦</span>
            <div style={{fontSize:12,color:"var(--text-dim)"}}>
              <span style={{color:"var(--gold)"}}>Story Bible active</span>
              {" — "}
              {storyBible.characters?.length || 0} characters · {storyBible.settings?.length || 0} settings · illustrations will be consistent
              {storyBible.fromCache === false && <span style={{marginLeft:6,opacity:0.6}}>(saved for next session)</span>}
              {storyBible.isSample && <span style={{marginLeft:6,opacity:0.6}}>(built from book opening)</span>}
            </div>
          </div>
        )}

        <div className="chapter-list">
          {chapters.map(ch => (
            <button key={ch.index} className="chapter-btn" onClick={() => onSelect(ch)}>
              <span>{ch.title}</span>
              <span className="ch-words">{Math.round(ch.text.split(" ").length / 100) / 10}k words</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Phase: WORD SUGGESTION ────────────────────────────────────────────────────
function SuggestPhase({ chapter, bookTitle, bible, onConfirm }) {
  const [loading, setLoading] = useState(true);
  const [allWords, setAllWords] = useState([]);
  const [selectedWords, setSelectedWords] = useState([]);
  const [copied, setCopied] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState(null);
  const [tarballImages, setTarballImages] = useState(null); // preloaded image map
  const [tarballStatus, setTarballStatus] = useState(null); // null | "loading" | "ready" | "error"
  const [geminiAvailable, setGeminiAvailable] = useState(false);
  const [geminiModel, setGeminiModel] = useState(() => localStorage.getItem(GEMINI_MODEL_KEY) || GEMINI_IMAGE_MODELS[0].id);
  const tarballInputRef = useRef();
  const SUGGEST_N = 5;

  useEffect(() => {
    checkGeminiAvailable().then(setGeminiAvailable);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // Cache key: hash of chapter text so same chapter always hits cache
        const chapterHash = await hashText(chapter.text);
        const cacheKey = `wordlist-${chapterHash}`;
        const cached = await storageGet(cacheKey);

        let sorted;
        if (cached) {
          console.log("Word list loaded from cache:", cacheKey);
          sorted = cached;
          setFromCache(true);
        } else {
          const result = await suggestWords(chapter.text, 20);
          sorted = (result.words || []).sort((a, b) => (a.charIndex || 0) - (b.charIndex || 0));
          await storageSet(cacheKey, sorted);
          console.log("Word list cached:", cacheKey);
        }

        setAllWords(sorted);
        setSelectedWords(sorted.slice(0, SUGGEST_N).map(w => w.word));
      } catch (e) {
        console.error("suggestWords failed:", e);
        setError("Couldn't load word suggestions: " + e.message);
      }
      setLoading(false);
    })();
  }, []);

  async function handleRefresh() {
    const chapterHash = await hashText(chapter.text);
    const cacheKey = `wordlist-${chapterHash}`;
    try { await window.storage.delete(cacheKey); } catch {}
    setLoading(true);
    setAllWords([]);
    setSelectedWords([]);
    setFromCache(false);
    setError(null);
    try {
      const result = await suggestWords(chapter.text, 20);
      const sorted = (result.words || []).sort((a, b) => (a.charIndex || 0) - (b.charIndex || 0));
      await storageSet(cacheKey, sorted);
      setAllWords(sorted);
      setSelectedWords(sorted.slice(0, SUGGEST_N).map(w => w.word));
    } catch (e) {
      setError("Couldn't load word suggestions: " + e.message);
    }
    setLoading(false);
  }

  function toggle(word) {
    setSelectedWords(prev =>
      prev.includes(word) ? prev.filter(w => w !== word) : [...prev, word]
    );
  }

  const isSelected = word => selectedWords.includes(word);
  const canStart = selectedWords.length >= 1;

  // Auto-compute export JSON whenever selection changes — no button click needed
  const exportJson = selectedWords.length > 0
    ? JSON.stringify(
        allWords
          .filter(w => selectedWords.includes(w.word))
          .map(w => ({
            word: w.word,
            paragraph: w.paragraph,
            imagePrompt: buildImagePrompt(w.paragraph, bible),
          })),
        null, 2
      )
    : null;

  async function handleTarballUpload(file) {
    if (!file) return;
    setTarballStatus("loading");
    try {
      const imageMap = await loadImagesFromTarball(file);
      setTarballImages(imageMap);
      setTarballStatus("ready");
      console.log("Pre-loaded", Object.keys(imageMap).length, "images from tarball");
    } catch (e) {
      console.error("Tarball load failed:", e);
      setTarballStatus("error");
    }
  }

  function handleStart() {
    const chosen = allWords.filter(w => selectedWords.includes(w.word));
    onConfirm(chosen, tarballImages, geminiModel);
  }

  if (loading) return (
    <div className="card"><div className="card-body" style={{textAlign:"center",padding:"48px"}}>
      <div className="spinner" style={{margin:"0 auto 16px"}}/>
      <p style={{fontStyle:"italic",color:"var(--text-dim)"}}>Finding valuable vocabulary words…</p>
    </div></div>
  );

  if (error) return (
    <div className="card"><div className="card-body">
      <p style={{color:"#e09090"}}>{error}</p>
    </div></div>
  );

  const suggestCount = Math.min(SUGGEST_N, allWords.length);

  return (
    <div className="card">
      <div className="card-body">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
          <div className="section-label" style={{marginBottom:0}}>{chapter.title} — {bookTitle}</div>
          {fromCache && (
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,color:"rgba(184,144,42,0.45)",fontStyle:"italic"}}>from cache</span>
              <button onClick={handleRefresh}
                style={{background:"none",border:"1px solid rgba(180,130,50,0.25)",borderRadius:3,
                  padding:"2px 10px",fontSize:11,color:"var(--gold-dim)",cursor:"pointer",fontFamily:"'Lora',serif"}}>
                ↺ Refresh
              </button>
            </div>
          )}
        </div>
        <div style={{marginBottom:20}}>
          <p style={{fontSize:14,color:"var(--text-dim)",lineHeight:1.6,marginBottom:16}}>
            Found <strong style={{color:"var(--gold)"}}>{allWords.length}</strong> vocabulary words in this chapter.
            {suggestCount > 0 && <> The first <strong style={{color:"var(--gold)"}}>{suggestCount}</strong> are pre-selected — swap any in or out.</>}
          </p>
          <div className="count-row">
            <span className="count-label">Words selected:</span>
            <span className="count-val" style={{color: selectedWords.length > 0 ? "var(--gold)" : "var(--wrong-text)"}}>{selectedWords.length}</span>
          </div>
        </div>
        <div style={{maxHeight:440,overflowY:"auto",paddingRight:4}}>
          {allWords.map((w, i) => (
            <div key={w.word} className={`word-suggestion ${isSelected(w.word) ? "selected" : ""} ${i < SUGGEST_N ? "suggested" : ""}`} onClick={() => toggle(w.word)}>
              <div className="ws-check">{isSelected(w.word) ? "✓" : ""}</div>
              <div style={{flex:1}}>
                <div>
                  <span className="ws-word">{w.word}</span>
                  {i < SUGGEST_N && <span className="ws-badge">suggested</span>}
                </div>
                <div className="ws-reason">{w.reason}</div>
              </div>
            </div>
          ))}
        </div>
        {exportJson && !geminiAvailable && (
          <div style={{marginTop:16,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(180,130,50,0.25)",borderRadius:3,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:11,letterSpacing:"0.15em",textTransform:"uppercase",color:"rgba(184,144,42,0.5)"}}>
                words.json for offline image generation — click text to select all
              </div>
              <span style={{fontSize:11,color:"rgba(184,144,42,0.45)",fontStyle:"italic"}}>
                click text below to select all
              </span>
            </div>
            <pre
              onClick={e => {
                const range = document.createRange();
                range.selectNodeContents(e.currentTarget);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              }}
              style={{fontSize:11,color:"var(--text-dim)",overflowX:"auto",maxHeight:200,margin:0,
                fontFamily:"monospace",lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-all",
                cursor:"text",userSelect:"all"}}>
              {exportJson}
            </pre>
          </div>
        )}
        {/* Tarball upload — only shown when Gemini is not directly accessible */}
        {!geminiAvailable && (
        <div style={{marginTop:16,padding:"12px 14px",background:"rgba(180,130,50,0.05)",
          border:"1px solid rgba(180,130,50,0.15)",borderRadius:3}}>
          <div style={{fontSize:11,letterSpacing:"0.15em",textTransform:"uppercase",
            color:"rgba(184,144,42,0.5)",marginBottom:8}}>Optional — upload images before generating</div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <input ref={tarballInputRef} type="file" accept="application/gzip,application/x-gzip,application/x-tar,.gz,.tgz,*/*"
              style={{display:"none"}}
              onChange={e => handleTarballUpload(e.target.files[0])}/>
            <button
              onClick={() => tarballInputRef.current?.click()}
              style={{background:"none",border:"1px solid rgba(180,130,50,0.3)",borderRadius:3,
                padding:"7px 14px",fontFamily:"'Lora',serif",fontSize:13,
                color:"var(--gold-dim)",cursor:"pointer"}}>
              ↑ Upload vocab-images.tar.gz
            </button>
            {tarballStatus === "loading" && (
              <span style={{fontSize:12,color:"var(--text-dim)",fontStyle:"italic",display:"flex",alignItems:"center",gap:6}}>
                <div className="mini-spinner"/>Loading images…
              </span>
            )}
            {tarballStatus === "ready" && (
              <span style={{fontSize:12,color:"var(--correct-text)"}}>
                ✓ {tarballImages ? Object.keys(tarballImages).length : 0} images ready
              </span>
            )}
            {tarballStatus === "error" && (
              <span style={{fontSize:12,color:"var(--wrong-text)"}}>✗ Failed to load tarball</span>
            )}
          </div>
        </div>
        )}

        <div style={{marginTop:12,display:"flex",justifyContent:"flex-end",alignItems:"center",gap:10}}>
          {geminiAvailable && (
            <select
              value={geminiModel}
              onChange={e => { setGeminiModel(e.target.value); localStorage.setItem(GEMINI_MODEL_KEY, e.target.value); }}
              style={{fontSize:12,padding:"6px 8px",background:"var(--card-bg)",color:"var(--text-dim)",border:"1px solid rgba(180,130,50,0.3)",borderRadius:3}}
            >
              {GEMINI_IMAGE_MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
          <button className="primary-btn" disabled={!canStart} onClick={handleStart}>
            Generate Game ({selectedWords.length} words) →
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Phase: STORY BIBLE ────────────────────────────────────────────────────────
function StoryBiblePhase({ fullText, bookTitle, onReady }) {
  const [status, setStatus] = useState({ step: "starting", message: "Starting…" });
  const [bible, setBible] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await getStoryBible(fullText, bookTitle, setStatus);
        setBible(result.bible);
        setFromCache(result.fromCache);
        // Brief pause to show the result before proceeding
        await new Promise(r => setTimeout(r, result.fromCache ? 800 : 1500));
        onReady(result.bible, result.hash);
      } catch (e) {
        setError(e.message);
        // Even if Story Bible fails, proceed without it
        await new Promise(r => setTimeout(r, 1500));
        onReady(null, null);
      }
    })();
  }, []);

  const stepIcon = { checking: "🔍", cached: "✦", generating: "📖", saved: "✓", starting: "…" };

  return (
    <div className="card">
      <div className="card-body">
        <div className="section-label">Story Bible</div>
        <p style={{fontSize:13,color:"var(--text-dim)",marginBottom:20,lineHeight:1.6,fontStyle:"italic"}}>
          Building character & setting descriptions to keep illustrations consistent across the whole book.
        </p>

        <div style={{display:"flex",alignItems:"flex-start",gap:14,padding:"16px",background:"rgba(180,130,50,0.06)",border:"1px solid rgba(180,130,50,0.18)",borderRadius:3}}>
          <div style={{fontSize:20,marginTop:1}}>{stepIcon[status.step] || "…"}</div>
          <div>
            <div style={{fontSize:14,color:"var(--text)",marginBottom:4}}>{status.message}</div>
            {status.step === "generating" && (
              <div style={{fontSize:12,color:"var(--text-dim)"}}>This only happens once per book — all future sessions load instantly.</div>
            )}
            {status.step !== "generating" && status.step !== "checking" && status.step !== "starting" && (
              <div style={{fontSize:12,color:"var(--text-dim)"}}>
                {fromCache ? "Loaded from previous session." : "Saved for future sessions."}
              </div>
            )}
          </div>
          {(status.step === "checking" || status.step === "generating") && (
            <div className="mini-spinner" style={{marginLeft:"auto",marginTop:4,flexShrink:0}}/>
          )}
        </div>

        {bible && (
          <div style={{marginTop:16}}>
            {bible.characters?.length > 0 && (
              <div style={{marginBottom:12}}>
                <div className="section-label" style={{marginBottom:8}}>Characters</div>
                {bible.characters.map(c => (
                  <div key={c.name} style={{marginBottom:8,padding:"10px 14px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(180,130,50,0.1)",borderRadius:3}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,color:"var(--gold)",marginBottom:3}}>{c.name}</div>
                    <div style={{fontSize:12,color:"var(--text-dim)",lineHeight:1.5,fontStyle:"italic"}}>{c.promptFragment}</div>
                  </div>
                ))}
              </div>
            )}
            {bible.settings?.length > 0 && (
              <div>
                <div className="section-label" style={{marginBottom:8}}>Settings</div>
                {bible.settings.map(s => (
                  <div key={s.name} style={{marginBottom:8,padding:"10px 14px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(180,130,50,0.1)",borderRadius:3}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,color:"var(--gold)",marginBottom:3}}>{s.name}</div>
                    <div style={{fontSize:12,color:"var(--text-dim)",lineHeight:1.5,fontStyle:"italic"}}>{s.promptFragment}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{marginTop:12,padding:"10px 14px",background:"var(--wrong)",border:"1px solid var(--wrong-border)",borderRadius:3,fontSize:13,color:"var(--wrong-text)"}}>
            Story Bible unavailable — proceeding without it. Images will still generate, just without guaranteed consistency.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Phase: GENERATING ASSETS ──────────────────────────────────────────────────
// ── Tarball image loader ──────────────────────────────────────────────────────
async function loadImagesFromTarball(file) {
  if (!window.pako) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const arrayBuf = await file.arrayBuffer();
  const decompressed = window.pako.inflate(new Uint8Array(arrayBuf));
  const files = {};
  let offset = 0;
  while (offset < decompressed.length - 512) {
    const header = decompressed.slice(offset, offset + 512);
    const name = new TextDecoder().decode(header.slice(0, 100)).replace(/\x00/g, "").trim();
    if (!name) break;
    const sizeStr = new TextDecoder().decode(header.slice(124, 136)).replace(/\x00/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    offset += 512;
    if (size > 0) {
      files[name] = decompressed.slice(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;
    }
  }
  if (!files["manifest.json"]) throw new Error("Invalid tarball: missing manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  const imageMap = {};
  for (const entry of (manifest.images || [])) {
    const imgData = files[entry.filename];
    if (imgData) {
      // Use btoa in chunks to handle large images without stack overflow
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < imgData.length; i += chunkSize) {
        binary += String.fromCharCode(...imgData.slice(i, i + chunkSize));
      }
      imageMap[entry.word] = `data:image/jpeg;base64,${btoa(binary)}`;
    }
  }
  return imageMap;
}

function GeneratingPhase({ words, bookTitle, bible, tarballImages, geminiModel, chapterText, onReady }) {
  const [status, setStatus] = useState("working");
  const [imgStatus, setImgStatus] = useState("pending");
  const [errorMsg, setErrorMsg] = useState(null);
  const [assetsReady, setAssetsReady] = useState(null);
  const fileInputRef = useRef();

  useEffect(() => {
    (async () => {
      try {
        const assets = await generateAllWordAssets(words, bookTitle, chapterText, bible);
        const assetsWithPrompts = assets.map(a => ({
          ...a,
          imagePrompt: buildImagePrompt(a.paragraph, bible),
        }));

        // Three-way image path:
        // 1. Gemini available (server has key): call Gemini directly
        // 2. Pre-uploaded tarball: apply images immediately
        // 3. No images: offer upload or skip

        // Illustration cache helpers
        const chHash = chapterText ? await hashText(chapterText) : null;

        async function getCachedImage(word) {
          if (!chHash) return null;
          const cached = await storageGet(`illust-${chHash}-${word.toLowerCase().trim()}`);
          return cached ? cached.dataUri : null;
        }

        async function cacheImage(word, dataUri) {
          if (!chHash || !dataUri) return;
          const w = word.toLowerCase().trim();
          await storageSet(`illust-${chHash}-${w}`, { dataUri, model: geminiModel, generatedAt: new Date().toISOString() });
        }

        // Write the illust-index once after all images are cached, not during
        // each parallel cacheImage call (which caused a race condition where
        // concurrent read-modify-write cycles lost most entries).
        async function updateIllustIndex(words) {
          if (!chHash) return;
          const indexKey = `illust-index-${chHash}`;
          const existing = (await storageGet(indexKey)) || [];
          const merged = [...new Set([...existing, ...words.map(w => w.toLowerCase().trim())])];
          await storageSet(indexKey, merged);
        }

        const geminiAvailable = await checkGeminiAvailable();
        if (geminiAvailable) {
          // ── Live: generate images via Gemini proxy ───────────────────────────
          setImgStatus("generating");
          const newlyCached = [];
          const withImages = await Promise.all(
            assetsWithPrompts.map(async a => {
              const cached = await getCachedImage(a.word);
              if (cached) return { ...a, image: cached };
              const img = await generateGeminiImageDirect(a.imagePrompt, geminiModel);
              await cacheImage(a.word, img);
              newlyCached.push(a.word);
              return { ...a, image: img };
            })
          );
          if (newlyCached.length) await updateIllustIndex(newlyCached);
          setImgStatus("done");
          onReady(withImages);

        } else if (tarballImages && Object.keys(tarballImages).length > 0) {
          // ── Artifact: use pre-uploaded tarball ──────────────────────────────
          const tarballCached = [];
          const withImages = await Promise.all(assetsWithPrompts.map(async a => {
            const img = tarballImages[a.word] || null;
            if (img) { await cacheImage(a.word, img); tarballCached.push(a.word); }
            return { ...a, image: img };
          }));
          if (tarballCached.length) await updateIllustIndex(tarballCached);
          console.log(`Applied ${withImages.filter(a => a.image).length} tarball images`);
          setImgStatus("done");
          onReady(withImages);

        } else {
          // ── Artifact: no images yet — offer upload or skip ──────────────────
          setAssetsReady(assetsWithPrompts);
          setImgStatus("skipped");
        }
      } catch (e) {
        console.error("GeneratingPhase failed:", e);
        setErrorMsg(e.message);
        setStatus("error");
      }
    })();
  }, []);

  async function handleTarball(file) {
    if (!file || !assetsReady) return;
    setImgStatus("loading");
    try {
      const imageMap = await loadImagesFromTarball(file);
      const withImages = assetsReady.map(a => ({ ...a, image: imageMap[a.word] || null }));
      console.log("Loaded", Object.keys(imageMap).length, "images from tarball");
      setImgStatus("done");
      onReady(withImages);
    } catch (e) {
      setErrorMsg(`Tarball error: ${e.message}`);
      setImgStatus("skipped");
    }
  }

  return (
    <div className="card">
      <div className="card-body">
        <div className="section-label">Preparing your game</div>

        {status === "working" && (
          <>
            <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div className="mini-spinner"/>
                <span style={{fontSize:14,color:"var(--text-dim)"}}>Generating quiz options and hints…</span>
              </div>
              {imgStatus === "generating" && (
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div className="mini-spinner"/>
                  <span style={{fontSize:14,color:"var(--text-dim)"}}>
                    Generating illustrations with Gemini ({words.length} images)…
                  </span>
                </div>
              )}
              {imgStatus === "done" && (
                <div style={{fontSize:13,color:"var(--correct-text)"}}>✓ Illustrations ready</div>
              )}
              {(imgStatus === "skipped" || imgStatus === "loading") && assetsReady && (
                <div style={{marginTop:4}}>
                  {imgStatus === "loading" ? (
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div className="mini-spinner"/>
                      <span style={{fontSize:13,color:"var(--text-dim)"}}>Loading images from tarball…</span>
                    </div>
                  ) : (
                    <>
                      <div style={{fontSize:13,color:"var(--text-dim)",marginBottom:10}}>
                        No live image generation. Upload an <strong style={{color:"var(--gold)"}}>images.tar.gz</strong> generated
                        by the offline script, or skip.
                      </div>
                      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                        <input ref={fileInputRef} type="file" accept="application/gzip,application/x-gzip,application/x-tar,.gz,.tgz,*/*"
                          style={{display:"none"}}
                          onChange={e => handleTarball(e.target.files[0])}/>
                        <button className="primary-btn"
                          onClick={() => fileInputRef.current?.click()}
                          style={{fontSize:13,padding:"9px 16px"}}>
                          ↑ Upload images.tar.gz
                        </button>
                        <button onClick={() => onReady(assetsReady)}
                          style={{background:"none",border:"none",fontSize:13,color:"rgba(184,144,42,0.5)",
                            cursor:"pointer",textDecoration:"underline"}}>
                          Skip — play without images
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

            </div>
            <div className="gen-grid" style={{marginTop:12}}>
              {words.map(w => (
                <div key={w.word} className="gen-item active">
                  <div className="gen-dot"/>
                  <span className="gen-word">{w.word}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {status === "error" && (
          <div style={{padding:"16px",background:"var(--wrong)",border:"1px solid var(--wrong-border)",borderRadius:3,fontSize:13,color:"var(--wrong-text)"}}>
            <strong>Something went wrong:</strong> {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Fill-in-the-blank retest card ─────────────────────────────────────────────
function BlankCard({ asset, onCorrect }) {
  const [wrongPicks, setWrongPicks] = useState([]);
  const [phase, setPhase] = useState("quiz"); // quiz | hint | correct

  // Build blank options: correct word + 3 distractors drawn from the other assets' wrong options
  // We store these in a ref so they don't reshuffle on re-render
  const blankOptions = asset.blankOptions; // pre-built in GamePhase

  // Blank out the vocab word in the paragraph
  const wordRe = new RegExp(`\\b${asset.word.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`, "i");
  const parts = asset.paragraph.split(wordRe);

  function handlePick(i) {
    if (blankOptions[i].isCorrect) {
      const picks = wrongPicks.length; // capture before state update
      setPhase("correct");
      setTimeout(() => onCorrect(picks), 1400);
    } else {
      setWrongPicks(p => [...p, i]);
      setPhase("hint");
    }
  }

  return (
    <div className="card">
      <div className="word-banner">
        <span className="vocab-word" style={{fontSize:22}}>Fill in the blank</span>
        <span style={{fontSize:12,fontStyle:"italic",color:"rgba(184,144,42,0.55)"}}>review</span>
      </div>
      <div className="card-section">
        <div className="section-label">Definition</div>
        <div style={{fontSize:15,lineHeight:1.7,fontStyle:"italic",color:"var(--gold-dim)"}}>
          {asset.options.options[asset.options.correct]}
        </div>
      </div>
      <div className="card-section">
        <div className="section-label">From the text — which word fits the blank?</div>
        <div className="paragraph-text">
          "
          {parts.map((part, i) => (
            <span key={i}>
              {part}
              {i < parts.length - 1 && <span className="blank-word">______</span>}
            </span>
          ))}
          "
        </div>
      </div>
      <div className="card-section" style={{borderBottom:"none",paddingBottom:28}}>
        <div className="options-grid blank-options">
          {blankOptions.map((opt, i) => {
            let cls = "opt-btn blank-opt";
            if (phase === "correct" && opt.isCorrect) cls += " correct";
            else if (wrongPicks.includes(i)) cls += " eliminated";
            const disabled = phase === "correct" || wrongPicks.includes(i);
            return (
              <button key={i} className={cls} onClick={() => handlePick(i)} disabled={disabled}>
                <span className="opt-letter">{String.fromCharCode(65+i)}</span>
                {opt.word}
              </button>
            );
          })}
        </div>
        {phase === "hint" && (
          <div className="feedback-banner hint">
            <div className="fb-head">Not quite — try again.</div>
            Think about the definition above. Which word would make that sentence mean the same thing?
          </div>
        )}
        {phase === "correct" && (
          <div className="feedback-banner correct">
            <div className="fb-head">That's it! ✦</div>
            The word is <strong>{asset.word}</strong> — moving on…
          </div>
        )}
      </div>
    </div>
  );
}

// ── Phase: GAME ───────────────────────────────────────────────────────────────
function GamePhase({ assets, bookTitle, chapterTitle, onDone }) {
  // Build blank options for each asset upfront (correct word + 3 word distractors)
  const assetsWithBlanks = assets.map((a, idx) => {
    const otherWords = assets.filter((_, j) => j !== idx).map(x => x.word);
    // Shuffle and take 3 distractors
    const shuffled = [...otherWords].sort(() => Math.random() - 0.5).slice(0, 3);
    const blankArr = [{ word: a.word, isCorrect: true }, ...shuffled.map(w => ({ word: w, isCorrect: false }))];
    // Shuffle the blank options
    for (let i = blankArr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [blankArr[i], blankArr[j]] = [blankArr[j], blankArr[i]];
    }
    return { ...a, blankOptions: blankArr };
  });

  // Queue: first pass (word→meaning) then fill-in-the-blank for ALL words
  const initialQueue = [
    ...assetsWithBlanks.map(a => ({ ...a, isRetest: false })),
    ...assetsWithBlanks.map(a => ({ ...a, isRetest: true })),
  ];
  const [queue] = useState(initialQueue);
  const [queuePos, setQueuePos] = useState(0);
  // Track scores separately for each round: { word: { meaning: score, blank: score } }
  const [scores, setScores] = useState(
    () => Object.fromEntries(assetsWithBlanks.map(a => [a.word, { meaning: null, blank: null }]))
  );
  const [phase, setPhase] = useState("quiz");
  const [wrongPicks, setWrongPicks] = useState([]);

  const current = queue[queuePos];

  useEffect(() => {
    setPhase("quiz");
    setWrongPicks([]);
  }, [queuePos]);

  function handleSelect(i) {
    const isCorrect = i === current.options.correct;
    if (isCorrect) {
      const newScore = wrongPicks.length === 0 ? "correct" : "retry";
      setScores(s => ({ ...s, [current.word]: { ...s[current.word], meaning: newScore } }));
      setPhase("correct");
    } else {
      setWrongPicks(p => [...p, i]);
      setPhase("hint");
    }
  }

  function handleNextAfterCorrect() {
    if (queuePos >= queue.length - 1) {
      onDone(scores);
    } else {
      setQueuePos(pos => pos + 1);
    }
  }

  function handleRetestCorrect(numWrong) {
    const blankScore = numWrong === 0 ? "correct" : "retry";
    const newScores = { ...scores, [current.word]: { ...scores[current.word], blank: blankScore } };
    setScores(newScores);
    if (queuePos >= queue.length - 1) {
      onDone(newScores);
    } else {
      setQueuePos(pos => pos + 1);
    }
  }

  const inBlankRound = current.isRetest;
  const dotScores = assets.map(a => {
    const s = scores[a.word];
    const meaningScore = s?.meaning;
    if (!meaningScore && a.word === current.word && !current.isRetest) return "current";
    return meaningScore || "";
  });

  return (
    <>
      <div style={{textAlign:"center",marginBottom:10,fontSize:11,letterSpacing:"0.18em",textTransform:"uppercase",color:"rgba(180,130,50,0.45)"}}>
        {inBlankRound ? "◆ Fill in the Blank" : "◆ What does this word mean?"}
      </div>
      <div className="score-strip">
        {dotScores.map((s, i) => (
          <div key={i} className={`score-dot ${s}`} title={assets[i].word}/>
        ))}
      </div>

      {current.isRetest ? (
        <BlankCard
          key={current.word}
          asset={current}
          onCorrect={handleRetestCorrect}
        />
      ) : (
        <div className="card">

          {current.image && (
            <div className="illustration-area">
              <img key={current.word} src={current.image} alt={`Scene for ${current.word}`}/>
            </div>
          )}
          {/* Word + paragraph merged into one section (no separate banner / "From the text" label)
              to keep the content half compact and balanced against the illustration */}
          <div className="game-content">
          {phase !== "correct" && (
          <div className="card-section">
            <span className="vocab-word">{current.word}</span>
            <div className="paragraph-text" style={{marginTop:10}}>
              "<Highlighted paragraph={current.paragraph} word={current.word}/>"
            </div>
          </div>
          )}
          <div className="card-section" style={{borderBottom:"none",paddingBottom:28}}>
            {phase !== "correct" && (
            <>
            <div className="question-text">What does "{current.word}" mean?</div>
            <div className="options-grid">
              {current.options.options.map((opt, i) => {
                let cls = "opt-btn";
                if (wrongPicks.includes(i)) cls += " eliminated";
                const disabled = wrongPicks.includes(i);
                return (
                  <button key={i} className={cls} onClick={() => handleSelect(i)} disabled={disabled}>
                    <span className="opt-letter">{String.fromCharCode(65+i)}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
            </>
            )}

            {phase === "hint" && (
              <div className="feedback-banner hint">
                <div className="fb-head">Not quite — try again.</div>
                {current.hint}
              </div>
            )}

            {phase === "correct" && (
              <>
                <div className="feedback-banner correct">
                  <div className="fb-head">{wrongPicks.length === 0 ? "Correct! ✦" : "Got it! ◆"}</div>
                  "{current.word}" means: {current.options.options[current.options.correct]}
                </div>
                <button className="next-btn" onClick={handleNextAfterCorrect}>
                  {queuePos < queue.length - 1 ? "Next Word →" : "See Results"}
                </button>
              </>
            )}
          </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Phase: RESULTS ────────────────────────────────────────────────────────────
function ResultsPhase({ assets, scores, bookTitle, bookHash, chapterTitle, onPlayAgain }) {
  const scoreConfig = {
    correct: { bg:"rgba(80,160,80,0.12)",  border:"rgba(100,200,100,0.35)", color:"var(--correct-text)", icon:"✦", label:"first try" },
    retry:   { bg:"rgba(200,160,40,0.1)",  border:"rgba(220,180,60,0.35)", color:"var(--retry-text)",   icon:"◆", label:"with a hint" },
    wrong:   { bg:"rgba(180,60,60,0.1)",   border:"rgba(200,80,80,0.3)",   color:"var(--wrong-text)",   icon:"✗", label:"missed" },
  };

  const total = assets.length;
  const meaningPerfect = assets.filter(a => scores[a.word]?.meaning === "correct").length;
  const blankPerfect   = assets.filter(a => scores[a.word]?.blank   === "correct").length;
  const allPerfect = meaningPerfect === total && blankPerfect === total;

  useEffect(() => {
    const wordResults = assets.flatMap(a => [
      { word: a.word, taskType: "meaning",    firstTry: scores[a.word]?.meaning === "correct", attempts: scores[a.word]?.meaning ? 1 : 0 },
      { word: a.word, taskType: "fill-blank", firstTry: scores[a.word]?.blank   === "correct", attempts: scores[a.word]?.blank   ? 1 : 0 },
    ]);
    recordSession({
      gameType: "vocab-quest",
      context: { bookTitle, bookHash, chapterTitle },
      wordResults,
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card">
      <div className="card-body" style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:52,color:"var(--gold)",marginBottom:10}}>
          {allPerfect ? "✦" : "◆"}
        </div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,color:"var(--text)",marginBottom:6}}>
          {allPerfect ? "Perfect score, Scholar!" : "Well done!"}
        </div>
        <div style={{fontSize:13,color:"var(--gold-dim)",marginBottom:24,fontStyle:"italic"}}>{chapterTitle} · {bookTitle}</div>

        {/* Two-column header */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,margin:"0 auto 6px",maxWidth:560}}>
          <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"rgba(184,144,42,0.5)",textAlign:"left",paddingLeft:16}}>Word → Meaning</div>
          <div style={{fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"rgba(184,144,42,0.5)",textAlign:"left",paddingLeft:16}}>Fill in the Blank</div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6,margin:"0 auto 24px",maxWidth:560}}>
          {assets.map(a => {
            const ms = scores[a.word]?.meaning || "wrong";
            const bs = scores[a.word]?.blank   || "wrong";
            const mc = scoreConfig[ms] || scoreConfig.wrong;
            const bc = scoreConfig[bs] || scoreConfig.wrong;
            return (
              <div key={a.word} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div className="results-word-card" style={{background:mc.bg,border:`1px solid ${mc.border}`,flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span className="rwc-word" style={{color:mc.color,fontSize:15}}>{a.word}</span>
                  <span className="rwc-label" style={{color:mc.color,fontSize:11}}>{mc.icon} {mc.label}</span>
                </div>
                <div className="results-word-card" style={{background:bc.bg,border:`1px solid ${bc.border}`,flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span className="rwc-word" style={{color:bc.color,fontSize:15}}>{a.word}</span>
                  <span className="rwc-label" style={{color:bc.color,fontSize:11}}>{bc.icon} {bc.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        <button className="primary-btn" onClick={onPlayAgain}>Play Again</button>
        <div style={{marginTop:12}}>
          <button className="secondary-btn" onClick={() => exportData()}>Download Progress</button>
        </div>
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  // upload → bible → chapters → suggest → generating → game → results
  const [phase, setPhase] = useState("upload");
  const [bookData, setBookData] = useState(null);
  const [storyBible, setStoryBible] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [chosenWords, setChosenWords] = useState([]);
  const [tarballImages, setTarballImages] = useState(null);
  const [chosenGeminiModel, setChosenGeminiModel] = useState(GEMINI_IMAGE_MODELS[0].id);
  const [gameAssets, setGameAssets] = useState([]);
  const [scores, setScores] = useState({});

  return (
    <>
      <style>{STYLES}</style>
      {/* game-active class tightens spacing so the question card fits without scrolling on a tablet */}
      <div className={`app${phase === "game" ? " game-active" : ""}`}>
        {/* Hide the title on the question page — it wastes vertical space needed to fit the card */}
        {phase !== "game" && (
          <div className="app-title">
            <h1>Vocabulary Quest</h1>
            <p>Learn words from the books you love</p>
          </div>
        )}

        {phase === "upload" && (
          <UploadPhase onParsed={data => { setBookData(data); setPhase("bible"); }}/>
        )}

        {phase === "bible" && (
          <StoryBiblePhase
            fullText={bookData.fullText}
            bookTitle={bookData.bookTitle}
            onReady={(bible, hash) => { setStoryBible(bible); setBookData(d => ({ ...d, hash })); setPhase("chapters"); }}
          />
        )}

        {phase === "chapters" && (
          <ChapterPhase
            chapters={bookData.chapters}
            bookTitle={bookData.bookTitle}
            storyBible={storyBible}
            onSelect={ch => { setChapter(ch); setPhase("suggest"); }}
          />
        )}

        {phase === "suggest" && (
          <SuggestPhase
            chapter={chapter}
            bookTitle={bookData.bookTitle}
            bible={storyBible}
            onConfirm={(words, imageMap, model) => { setChosenWords(words); setTarballImages(imageMap || null); setChosenGeminiModel(model); setPhase("generating"); }}
          />
        )}

        {phase === "generating" && (
          <GeneratingPhase
            words={chosenWords}
            bookTitle={bookData.bookTitle}
            bible={storyBible}
            tarballImages={tarballImages}
            geminiModel={chosenGeminiModel}
            chapterText={chapter.text}
            onReady={assets => { setGameAssets(assets); setPhase("game"); }}
          />
        )}

        {phase === "game" && (
          <GamePhase
            assets={gameAssets}
            bookTitle={bookData.bookTitle}
            chapterTitle={chapter.title}
            onDone={s => { setScores(s); setPhase("results"); }}
          />
        )}

        {phase === "results" && (
          <ResultsPhase
            assets={gameAssets}
            scores={scores}
            bookTitle={bookData.bookTitle}
            bookHash={bookData.hash}
            chapterTitle={chapter.title}
            onPlayAgain={() => setPhase("chapters")}
          />
        )}
      </div>
    </>
  );
}
