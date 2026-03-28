import { useState, useEffect, useRef, useCallback } from "react";
import { recordSession, exportData, getReviewQueue, getNextReviewDate, getTotalWordCount, getHomeData } from "./wordRecords.js";

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


// ── Correct-answer chimes (Web Audio API, no files needed) ────────────────────
const correctSound = (() => {
  let ctx = null;
  let muted = localStorage.getItem("vq-muted") === "1";

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // Marimba-like tone: sine fundamental + quiet 2nd harmonic, bright attack, reverb tail
  function chimeNote(ac, freq, start, vol) {
    // Fundamental (sine)
    const osc1 = ac.createOscillator();
    const g1 = ac.createGain();
    osc1.type = "sine";
    osc1.frequency.value = freq;
    // Bright attack: instant peak then fast initial drop, then slow reverb tail
    g1.gain.setValueAtTime(vol, start);
    g1.gain.setTargetAtTime(vol * 0.35, start + 0.015, 0.04); // fast drop to 35%
    g1.gain.setTargetAtTime(0.001, start + 0.06, 0.12);        // slow reverb tail

    // 2nd harmonic (adds brightness to attack, fades faster)
    const osc2 = ac.createOscillator();
    const g2 = ac.createGain();
    osc2.type = "sine";
    osc2.frequency.value = freq * 2;
    g2.gain.setValueAtTime(vol * 0.3, start);
    g2.gain.setTargetAtTime(0.001, start + 0.01, 0.04); // fades quickly

    // 3rd harmonic (very quiet, adds initial "ding" brightness)
    const osc3 = ac.createOscillator();
    const g3 = ac.createGain();
    osc3.type = "sine";
    osc3.frequency.value = freq * 3;
    g3.gain.setValueAtTime(vol * 0.08, start);
    g3.gain.setTargetAtTime(0.001, start + 0.005, 0.02);

    [osc1, osc2, osc3].forEach((o, i) => {
      const g = [g1, g2, g3][i];
      o.connect(g);
      g.connect(ac.destination);
      o.start(start);
      o.stop(start + 0.6);
    });
  }

  // Three variations — rising intervals, marimba timbre, ~200-300ms perceived
  const chimes = [
    // 1: Rising major third (C6→E6) — bright, simple
    (ac) => {
      const t = ac.currentTime;
      chimeNote(ac, 1046.5, t, 0.18);
      chimeNote(ac, 1318.5, t + 0.1, 0.2);
    },
    // 2: Rising perfect fifth (G5→D6) — open, warm
    (ac) => {
      const t = ac.currentTime;
      chimeNote(ac, 783.99, t, 0.17);
      chimeNote(ac, 1174.7, t + 0.11, 0.19);
    },
    // 3: Rising arpeggio (E5→G5→C6) — playful, resolved
    (ac) => {
      const t = ac.currentTime;
      chimeNote(ac, 659.25, t, 0.14);
      chimeNote(ac, 783.99, t + 0.08, 0.16);
      chimeNote(ac, 1046.5, t + 0.16, 0.18);
    },
  ];

  return {
    play() {
      if (muted) return;
      try {
        const ac = getCtx();
        chimes[Math.floor(Math.random() * chimes.length)](ac);
      } catch (_) { /* audio not available — silently ignore */ }
    },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      localStorage.setItem("vq-muted", muted ? "1" : "0");
      return muted;
    },
  };
})();

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

// XSS note: htmlToText and extractHeadingFromHtml use innerHTML on a detached
// DOM element to parse EPUB chapter HTML. The parsed HTML never enters the visible
// DOM — we only extract .textContent from it. The source is a user-uploaded EPUB,
// so the threat model is self-targeting (the user uploaded the file themselves).
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
  // A 503 comes from Railway's reverse proxy when our server process dies
  // (e.g. OOM or the agent subprocess crashed). The server never returns 503
  // itself, so this is always an infrastructure-level failure.
  if (res.status === 503) {
    throw new Error('Server is unavailable (503). This usually means the Claude agent process crashed — check that CLAUDE_CODE_OAUTH_TOKEN is set and valid in your Railway environment variables.');
  }
  // Guard against non-JSON responses (e.g. Railway HTML error pages on crash)
  let data;
  try { data = await res.json(); } catch {
    throw new Error(`Server returned ${res.status} with non-JSON body. The server may be out of memory or restarting.`);
  }
  // Surface the server's structured error code so the console message is
  // immediately actionable (e.g. "[OAUTH_TOKEN_INVALID] ...")
  if (data.error) {
    const { code, message } = data.error;
    const prefix = code ? `[${code}] ` : '';
    throw new Error(`${prefix}${message}`);
  }
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

  // Also cache each word's quiz item individually for review lookups.
  // The chapter-level cache key depends on the exact word subset selected,
  // making it hard to find later. Per-word keys are directly addressable.
  for (const item of arr) {
    const wordKey = `quiz-word-${item.word.toLowerCase().trim()}`;
    await storageSet(wordKey, item);
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
  @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --gold: #6b5218;
    --gold-dim: #8a6d2e;
    --gold-faint: rgba(100,70,20,0.08);
    --bg: #f8f5ef;
    --card-bg: #ffffff;
    --text: #2c2218;
    --text-dim: #5a4d3a;
    --border: rgba(100,70,20,0.12);
    --correct: rgba(34,120,34,0.08);
    --correct-border: rgba(34,120,34,0.3);
    --correct-text: #1a7a1a;
    --wrong: rgba(190,40,40,0.06);
    --wrong-border: rgba(190,50,50,0.25);
    --wrong-text: #b83030;
    --retry-text: #8b6914;
    --accent: rgba(100,70,20,var(--a,0.1));
  }
  body { background: var(--bg); }
  .app {
    min-height: 100vh;
    background: var(--bg);
    background-image: radial-gradient(ellipse at 15% 10%, rgba(180,140,80,0.05) 0%, transparent 55%),
                      radial-gradient(ellipse at 85% 90%, rgba(140,100,40,0.04) 0%, transparent 55%);
    font-family: 'Source Serif 4', Georgia, serif;
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 16px 80px;
  }
  .app-title { text-align: center; margin-bottom: 36px; }
  .app-title h1 { font-family: 'Source Serif 4', Georgia, serif; font-size: 28px; font-weight: 600; color: var(--gold); letter-spacing: 0.02em; }
  .app-title p { font-size: 13px; color: var(--gold-dim); opacity: 0.7; margin-top: 4px; font-style: normal; }

  /* ── User bar (top-right, shows current user + logout) ──────────────── */
  .user-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    padding: 8px 16px;
    font-size: 13px;
    color: var(--gold-dim);
    opacity: 0.8;
  }
  .user-bar span { font-weight: 500; }
  .user-bar a, .user-bar button.link-btn {
    color: var(--gold-dim);
    text-decoration: none;
    opacity: 0.7;
    cursor: pointer;
    background: none;
    border: none;
    font: inherit;
    padding: 0;
  }
  .user-bar a:hover, .user-bar button.link-btn:hover { opacity: 1; text-decoration: underline; }

  /* ── Admin panel ────────────────────────────────────────────────────── */
  .admin-panel {
    max-width: 500px;
    margin: 0 auto 32px;
    padding: 20px;
    border: 1px solid rgba(180,130,50,0.2);
    border-radius: 6px;
    background: rgba(255,255,255,0.02);
  }
  .admin-panel h2 {
    font-size: 16px;
    color: var(--gold);
    margin-bottom: 16px;
    font-weight: 600;
  }
  .admin-panel .user-list {
    list-style: none;
    margin-bottom: 16px;
  }
  .admin-panel .user-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid rgba(180,130,50,0.1);
    font-size: 14px;
    color: var(--text);
  }
  .admin-panel .user-list li:last-child { border-bottom: none; }
  .admin-panel .user-role {
    font-size: 11px;
    color: var(--gold-dim);
    opacity: 0.6;
    margin-left: 8px;
  }
  .admin-panel .delete-btn {
    background: none;
    border: 1px solid rgba(224,112,112,0.3);
    color: #e07070;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
  }
  .admin-panel .delete-btn:hover { background: rgba(224,112,112,0.1); }
  .admin-panel .add-user-form {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .admin-panel .add-user-form input {
    flex: 1;
    min-width: 100px;
    padding: 7px 10px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(180,130,50,0.3);
    border-radius: 4px;
    color: #1a1206;
    font-size: 13px;
  }
  .admin-panel .add-user-form input::placeholder {
    color: rgba(26,18,6,0.45);
  }
  .admin-panel .add-user-form button {
    padding: 7px 14px;
    background: rgba(180,130,50,0.15);
    border: 1px solid rgba(180,130,50,0.4);
    border-radius: 4px;
    color: #1a1206;
    font-size: 13px;
    cursor: pointer;
  }
  .admin-panel .add-user-form button:hover { background: rgba(180,130,50,0.25); }
  .admin-panel .admin-error { color: #e07070; font-size: 13px; margin-top: 8px; }
  .admin-panel .admin-success { color: #70c070; font-size: 13px; margin-top: 8px; }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 2px 16px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
    width: 100%;
    max-width: 660px;
    overflow: hidden;
  }
  .card-body { padding: 28px 32px 32px; }
  .card-section { padding: 22px 32px; border-bottom: 1px solid rgba(100,70,20,0.06); }
  .section-label { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(100,70,20,0.45); margin-bottom: 10px; }

  /* Upload */
  .upload-zone {
    border: 2px dashed rgba(100,70,20,0.2);
    border-radius: 4px;
    padding: 48px 24px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
    margin-bottom: 0;
  }
  .upload-zone:hover, .upload-zone.drag-over { border-color: rgba(100,70,20,0.4); background: rgba(100,70,20,0.03); }
  .upload-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.5; }
  .upload-zone h2 { font-family: 'Source Serif 4', Georgia, serif; font-size: 20px; color: var(--gold); margin-bottom: 8px; }
  .upload-zone p { font-size: 13px; color: var(--text-dim); line-height: 1.6; }
  .upload-zone input { display: none; }

  /* Book library */
  .home-section-label {
    font-family: 'Source Serif 4', Georgia, serif; font-size: 16px; font-weight: 600;
    color: var(--text); margin-bottom: 14px;
  }
  .book-library-sublabel { font-size: 12px; color: var(--text-dim); margin-bottom: 12px; }
  .review-banner {
    margin-bottom: 20px; padding: 16px 18px; background: rgba(34,120,34,0.06);
    border: 1px solid rgba(34,120,34,0.2); border-radius: 6px; cursor: pointer;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    transition: background 0.15s;
  }
  .review-banner:hover { background: rgba(34,120,34,0.1); }
  .review-banner-empty { cursor: default; background: rgba(100,70,20,0.04); border-color: rgba(100,70,20,0.12); }
  .review-banner-empty:hover { background: rgba(100,70,20,0.04); }
  .review-banner-text { display: flex; flex-direction: column; gap: 3px; }
  .review-banner-count { font-family: 'Source Serif 4', Georgia, serif; font-size: 17px; font-weight: 600; color: var(--text); }
  .review-banner-sub { font-size: 12px; color: var(--text-dim); }
  .review-banner-arrow { font-size: 20px; color: rgba(34,120,34,0.5); }
  .book-library { margin-bottom: 20px; }
  .book-library-label { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(100,70,20,0.45); margin-bottom: 10px; }
  .book-entry { margin-bottom: 8px; }
  .book-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border: 1px solid rgba(100,70,20,0.1); border-radius: 3px;
    cursor: pointer; transition: all 0.15s;
  }
  .book-entry:has(.book-cache-panel) .book-item { border-radius: 3px 3px 0 0; margin-bottom: 0; }
  .book-item:hover { background: rgba(100,70,20,0.04); border-color: rgba(100,70,20,0.2); }
  .book-item-info { flex: 1; min-width: 0; }
  .book-item-title { font-family: 'Source Serif 4', Georgia, serif; font-size: 15px; color: var(--gold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .book-item-meta { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
  .book-item-actions { flex-shrink: 0; margin-left: 12px; display: flex; gap: 6px; align-items: center; }
  .book-item-btn {
    padding: 4px 10px; font-size: 11px; border-radius: 3px; cursor: pointer; transition: all 0.15s;
    background: rgba(100,70,20,0.05); border: 1px solid rgba(100,70,20,0.12); color: rgba(100,70,20,0.6);
  }
  .book-item-btn:hover { background: rgba(100,70,20,0.1); border-color: rgba(100,70,20,0.25); }
  .book-item-btn.kebab { font-weight: bold; letter-spacing: 1px; padding: 4px 8px; }
  .book-item-btn.remove { color: #b04040; border-color: rgba(190,50,50,0.15); background: rgba(190,50,50,0.05); font-size: 14px; padding: 2px 8px; line-height: 1; }
  .book-item-btn.remove:hover { background: rgba(190,50,50,0.1); border-color: rgba(190,50,50,0.3); }
  .book-cache-panel {
    padding: 12px 16px; margin: 0 0 8px; background: rgba(100,70,20,0.02);
    border: 1px solid rgba(100,70,20,0.06); border-top: none; border-radius: 0 0 3px 3px;
  }
  .cache-panel-label { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(100,70,20,0.4); margin-bottom: 8px; }
  .cache-layer-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-size: 12px; color: var(--text-dim); }
  .cache-layer-cost { font-size: 10px; opacity: 0.45; }
  .cache-flush-btn {
    padding: 3px 10px; font-size: 10px; border-radius: 3px; cursor: pointer; transition: all 0.15s;
    background: rgba(100,70,20,0.05); border: 1px solid rgba(100,70,20,0.12); color: rgba(100,70,20,0.6);
  }
  .cache-flush-btn:hover { background: rgba(100,70,20,0.1); border-color: rgba(100,70,20,0.25); }
  .cache-flush-all {
    margin-top: 8px; width: 100%; padding: 6px; font-size: 11px; border-radius: 3px; cursor: pointer;
    background: rgba(190,50,50,0.05); border: 1px solid rgba(190,50,50,0.15); color: #b04040; transition: all 0.15s;
  }
  .cache-flush-all:hover { background: rgba(190,50,50,0.1); border-color: rgba(190,50,50,0.25); }
  .library-divider { display: flex; align-items: center; gap: 12px; margin: 20px 0; color: var(--text-dim); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; }
  .library-divider::before, .library-divider::after { content: ""; flex: 1; border-top: 1px solid rgba(100,70,20,0.08); }
  .add-book-btn {
    display: flex; align-items: center; gap: 6px; margin-top: 12px;
    padding: 8px 0; font-size: 13px; color: var(--text-dim);
    background: none; border: none; cursor: pointer; font-family: inherit;
    transition: color 0.15s;
  }
  .add-book-btn:hover { color: var(--gold); }

  /* Chapter list */
  .chapter-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; padding-right: 4px; }
  .chapter-list::-webkit-scrollbar { width: 4px; }
  .chapter-list::-webkit-scrollbar-track { background: transparent; }
  .chapter-list::-webkit-scrollbar-thumb { background: rgba(100,70,20,0.2); border-radius: 2px; }
  .chapter-btn {
    background: rgba(100,70,20,0.02);
    border: 1px solid rgba(100,70,20,0.1);
    border-radius: 3px;
    padding: 11px 16px;
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 14px;
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .chapter-btn:hover { background: rgba(100,70,20,0.05); border-color: rgba(100,70,20,0.2); color: var(--text); }
  .chapter-btn .ch-words { font-size: 11px; opacity: 0.5; }

  /* Word count selector */
  .count-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .count-label { font-size: 14px; color: var(--text-dim); }
  .count-btn { background: rgba(100,70,20,0.06); border: 1px solid rgba(100,70,20,0.18); border-radius: 3px; width: 32px; height: 32px; font-size: 18px; color: var(--gold); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
  .count-btn:hover { background: rgba(100,70,20,0.12); }
  .count-val { font-family: 'Source Serif 4', Georgia, serif; font-size: 22px; font-weight: 600; color: var(--gold); width: 32px; text-align: center; }

  /* Word suggestion list */
  .word-suggestion {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 16px;
    border: 1px solid rgba(100,70,20,0.08);
    border-radius: 3px;
    background: rgba(100,70,20,0.015);
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .word-suggestion:hover { background: rgba(100,70,20,0.04); border-color: rgba(100,70,20,0.18); }
  .word-suggestion.selected { background: rgba(100,70,20,0.06); border-color: rgba(100,70,20,0.25); }
  .word-suggestion.suggested { border-color: rgba(100,70,20,0.18); }
  .ws-check { width: 20px; height: 20px; border: 1.5px solid rgba(100,70,20,0.25); border-radius: 3px; flex-shrink: 0; margin-top: 2px; display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--gold); }
  .word-suggestion.selected .ws-check { background: rgba(100,70,20,0.12); }
  .ws-word { font-family: 'Source Serif 4', Georgia, serif; font-size: 17px; font-weight: 600; color: var(--gold); }
  .ws-badge { display: inline-block; font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold-dim); border: 1px solid rgba(100,70,20,0.18); border-radius: 2px; padding: 1px 5px; margin-left: 8px; vertical-align: middle; }
  .ws-reason { font-size: 12.5px; color: var(--text-dim); margin-top: 3px; line-height: 1.5; font-style: normal; }

  /* Generation progress */
  .gen-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .gen-item { border: 1px solid rgba(100,70,20,0.1); border-radius: 3px; padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
  .gen-item.done { border-color: var(--correct-border); background: rgba(34,120,34,0.04); }
  .gen-item.active { border-color: rgba(100,70,20,0.3); }
  .gen-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(100,70,20,0.2); flex-shrink: 0; }
  .gen-item.done .gen-dot { background: var(--correct-text); }
  .gen-item.active .gen-dot { background: var(--gold); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .gen-word { font-family: 'Source Serif 4', Georgia, serif; font-size: 14px; color: var(--text-dim); }
  .gen-item.done .gen-word { color: var(--correct-text); }
  .gen-item.active .gen-word { color: var(--gold); }

  /* Game – quiz card with illustration + question content */
  @keyframes imgFade { from{opacity:0} to{opacity:1} }
  .illustration-area {
    padding: 20px 24px 0; overflow: hidden;
  }
  .illustration-frame {
    position: relative; width: 100%; aspect-ratio: 3/2; border-radius: 6px;
    overflow: hidden; background: rgba(100,70,20,0.04);
    box-shadow: 0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(100,70,20,0.08);
  }
  .illustration-frame img {
    width: 100%; height: 100%; object-fit: cover; display: block;
    animation: imgFade 0.8s ease;
  }
  .word-banner { padding: 18px 32px 14px; border-bottom: 1px solid rgba(100,70,20,0.06); display: flex; align-items: baseline; gap: 14px; }
  .vocab-word { font-family: 'Source Serif 4', Georgia, serif; font-size: 34px; font-weight: 600; color: var(--gold); }
  .word-pos { font-size: 12px; font-style: normal; color: rgba(100,70,20,0.45); }
  .paragraph-text { font-size: 15px; line-height: 1.7; color: var(--text-dim); font-style: normal; }
  .paragraph-text mark { background: rgba(120,80,20,0.1); color: #6b5218; border-radius: 2px; padding: 1px 3px; font-style: normal; }
  .question-text { font-family: 'Source Serif 4', Georgia, serif; font-size: 17px; font-weight: 600; color: var(--text); margin-bottom: 16px; }
  .options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .opt-btn {
    background: rgba(100,70,20,0.02);
    border: 1px solid rgba(100,70,20,0.1);
    border-radius: 3px;
    padding: 12px 14px;
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 13.5px;
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    line-height: 1.45;
    transition: all 0.15s;
  }
  .opt-btn:hover:not(:disabled) { background: rgba(100,70,20,0.06); border-color: rgba(100,70,20,0.22); color: var(--text); }
  .opt-btn.correct { background: var(--correct); border-color: var(--correct-border); color: var(--correct-text); animation: correctPulse 0.45s ease; }
  @keyframes correctPulse { 0%{box-shadow:0 0 0 0 rgba(34,120,34,0.3)} 50%{box-shadow:0 0 0 6px rgba(34,120,34,0.12)} 100%{box-shadow:0 0 0 0 rgba(34,120,34,0)} }
  .opt-btn.eliminated { opacity: 0.35; cursor: not-allowed; background: rgba(100,70,20,0.01); border-color: rgba(100,70,20,0.05); color: rgba(80,60,30,0.35); text-decoration: line-through; text-decoration-color: rgba(80,60,30,0.2); }
  .opt-btn.blank-opt { font-family: 'Source Serif 4', Georgia, serif; font-style: normal; font-size: 16px; }
  .options-grid.blank-options { grid-template-columns: 1fr; }
  .blank-row { display: flex; gap: 24px; align-items: flex-start; }
  .blank-row .options-grid.blank-options { flex: 1 1 55%; min-width: 0; }
  .blank-feedback { flex: 1 1 45%; min-width: 0; display: flex; align-items: center; }
  .blank-word { display: inline-block; background: rgba(100,70,20,0.06); border-bottom: 2px solid rgba(100,70,20,0.3); border-radius: 2px; padding: 0 6px; min-width: 80px; text-align: center; font-style: normal; letter-spacing: 0.05em; }
  .opt-btn:disabled:not(.correct):not(.wrong) { opacity: 0.5; cursor: default; }
  .opt-letter { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: rgba(100,70,20,0.35); margin-bottom: 3px; font-style: normal; }
  .feedback-slot { margin-top: 16px; transition: visibility 0s; }
  .feedback-slot .feedback-banner { animation: none; }
  .blank-feedback .feedback-banner { margin-top: 0; }
  .feedback-banner { padding: 13px 16px; border-radius: 3px; font-size: 13.5px; line-height: 1.55; animation: fadeUp 0.3s ease; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
  .feedback-banner.hint { background: rgba(140,100,20,0.07); border: 1px solid rgba(140,100,20,0.2); color: #6b5218; }
  .feedback-banner.correct { background: var(--correct); border: 1px solid var(--correct-border); color: var(--correct-text); }
  .fb-head { font-family: 'Source Serif 4', Georgia, serif; font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .next-btn { margin-top: 22px; width: 100%; background: rgba(100,70,20,0.06); border: 1px solid rgba(100,70,20,0.2); border-radius: 3px; padding: 13px; font-family: 'Source Serif 4', Georgia, serif; font-size: 15px; font-weight: 600; color: var(--gold); cursor: pointer; letter-spacing: 0.03em; transition: all 0.15s; }
  .next-btn:hover { background: rgba(100,70,20,0.12); border-color: rgba(100,70,20,0.35); }
  .primary-btn { background: rgba(100,70,20,0.08); border: 1px solid rgba(100,70,20,0.25); border-radius: 3px; padding: 12px 28px; font-family: 'Source Serif 4', Georgia, serif; font-size: 15px; font-weight: 600; color: var(--gold); cursor: pointer; transition: all 0.15s; letter-spacing: 0.03em; }
  .primary-btn:hover { background: rgba(100,70,20,0.15); }
  .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .secondary-btn { background: transparent; border: 1px solid rgba(100,70,20,0.15); border-radius: 3px; padding: 8px 20px; font-family: 'Source Serif 4', Georgia, serif; font-size: 13px; color: var(--gold-dim); cursor: pointer; transition: all 0.15s; letter-spacing: 0.03em; }
  .secondary-btn:hover { border-color: rgba(100,70,20,0.3); color: var(--gold); }

  /* Exercise label bar — small, muted header so it doesn't compete with the definition */
  .exercise-label-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 32px; border-bottom: 1px solid rgba(100,70,20,0.06);
    font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
    color: rgba(100,70,20,0.4);
  }
  .exercise-label-tag {
    font-size: 10px; font-style: normal; letter-spacing: 0.08em;
    text-transform: none; color: rgba(100,70,20,0.35);
  }

  /* Definition section — prominent callout */
  .definition-section {
    border-left: 3px solid var(--gold);
    margin: 0 24px; padding: 18px 24px !important;
    border-bottom: none !important;
    background: rgba(100,70,20,0.02); border-radius: 0 3px 3px 0;
  }

  /* Spelling card */
  .speak-btn {
    background: rgba(100,70,20,0.06); border: 1px solid rgba(100,70,20,0.15); border-radius: 3px;
    color: var(--gold-dim); cursor: pointer; padding: 6px 8px; display: flex; align-items: center;
    justify-content: center; transition: all 0.15s; line-height: 1;
  }
  .speak-btn:hover { background: rgba(100,70,20,0.12); border-color: rgba(100,70,20,0.3); color: var(--gold); }
  .spell-chars-wrap { position: relative; }
  .spell-chars {
    display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;
    padding: 24px 0 12px; user-select: none;
  }
  .spell-char {
    display: inline-flex; align-items: center; justify-content: center; flex-direction: column;
    width: 32px; height: 42px; font-family: 'Source Serif 4', Georgia, serif; font-size: 22px; font-weight: 600;
    border-radius: 3px; position: relative; transition: all 0.2s;
  }
  .spell-char.spell-ghost {
    color: rgba(100,70,20,0.15); background: rgba(100,70,20,0.03);
    border: 1px solid rgba(100,70,20,0.06);
  }
  .spell-char.spell-ghost.spell-active {
    color: rgba(100,70,20,0.28); border-color: rgba(100,70,20,0.2);
    background: rgba(100,70,20,0.05);
  }
  .spell-char.spell-active::after {
    content: ''; position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
    width: 14px; height: 2px; background: var(--gold); border-radius: 1px;
    animation: cursorBlink 1s step-end infinite;
  }
  @keyframes cursorBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
  .spell-char.spell-typed {
    color: var(--gold); background: rgba(100,70,20,0.06);
    border: 1px solid rgba(100,70,20,0.18);
  }
  .spell-char.spell-flash-wrong {
    color: var(--wrong-text) !important; background: var(--wrong) !important;
    border-color: var(--wrong-border) !important;
    animation: spellShake 0.35s ease;
  }
  @keyframes spellShake {
    0%,100%{transform:translateX(0)} 20%{transform:translateX(-3px)} 40%{transform:translateX(3px)} 60%{transform:translateX(-2px)} 80%{transform:translateX(2px)}
  }
  .spell-char.spell-blank {
    color: rgba(100,70,20,0.12); background: transparent;
    border-bottom: 2px solid rgba(100,70,20,0.18); border-radius: 0;
  }
  .spell-char.spell-blank.spell-active {
    border-bottom-color: var(--gold);
  }
  .spell-char.spell-blank.spell-filled {
    color: var(--text); border-bottom-color: rgba(100,70,20,0.3);
  }
  .spell-char.spell-review-ok {
    color: var(--correct-text); background: var(--correct);
    border: 1px solid var(--correct-border);
  }
  .spell-char.spell-review-wrong {
    color: var(--wrong-text); background: var(--wrong);
    border: 1px solid var(--wrong-border);
  }
  .spell-correct-hint {
    position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%);
    font-size: 13px; color: var(--correct-text); font-weight: 600;
  }
  .spell-hidden-input {
    position: absolute; inset: 0; width: 100%; height: 100%;
    opacity: 0; font-size: 16px; cursor: default; z-index: 1;
  }

  /* Game progress bar — inline, with phase labels and step counter */
  .game-progress-bar {
    width: 100%; max-width: 660px; margin-bottom: 16px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .gp-phases {
    display: flex; justify-content: center; gap: 20px;
  }
  .gp-phase {
    font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
    color: rgba(100,70,20,0.25); transition: color 0.3s;
  }
  .gp-phase.gp-active {
    color: var(--gold); font-weight: 600;
  }
  .gp-track {
    width: 100%; height: 6px; border-radius: 3px;
    background: rgba(100,70,20,0.08); overflow: hidden;
  }
  .gp-fill {
    height: 100%; background: var(--gold); border-radius: 3px;
    transition: width 0.4s ease;
  }
  .gp-bottom-row {
    display: flex; align-items: center; justify-content: center; gap: 10px;
  }
  .gp-count {
    font-size: 11px; color: rgba(100,70,20,0.4);
    letter-spacing: 0.04em;
  }
  .gp-mute-btn {
    background: none; border: none; cursor: pointer; padding: 2px;
    color: rgba(100,70,20,0.3); display: flex; align-items: center;
    transition: color 0.15s;
  }
  .gp-mute-btn:hover { color: rgba(100,70,20,0.6); }

  /* Score strip */
  .score-strip { display: flex; justify-content: center; gap: 7px; margin-bottom: 20px; flex-wrap: wrap; }
  .score-dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid rgba(100,70,20,0.2); background: transparent; transition: all 0.3s; }
  .score-dot.current { border-color: rgba(100,70,20,0.5); background: rgba(100,70,20,0.2); }
  .score-dot.correct { background: rgba(34,120,34,0.6); border-color: var(--correct-border); }
  .score-dot.retry { background: rgba(180,140,30,0.6); border-color: rgba(180,140,30,0.45); }
  .score-dot.retest { background: rgba(60,120,200,0.6); border-color: rgba(60,120,200,0.45); }

  /* Results */
  .results-word-card {
    display: flex; align-items: center; justify-content: space-between;
    border-radius: 3px; padding: 10px 16px; margin-bottom: 8px;
  }
  .rwc-word { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 17px; }
  .rwc-label { font-size: 12px; opacity: 0.8; letter-spacing: 0.04em; }

  .spinner { width: 32px; height: 32px; border: 2px solid rgba(100,70,20,0.1); border-top-color: rgba(100,70,20,0.5); border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .mini-spinner { width: 14px; height: 14px; border: 1.5px solid rgba(100,70,20,0.1); border-top-color: rgba(100,70,20,0.45); border-radius: 50%; animation: spin 0.8s linear infinite; }

  /* ── Tablet responsive ──────────────────────────────────────────────────── */

  /* Touch targets: raise all interactive elements to >=44px on touch screens */
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

  /* Small tablets and up (>=600px): expand card and breathing room */
  @media (min-width: 600px) {
    .card { max-width: 720px; }
    .app { padding: 40px 24px 80px; }
  }

  /* Portrait tablet and up (>=768px): larger layout, more readable type */
  @media (min-width: 768px) {
    .card { max-width: 800px; }
    .app { padding: 48px 32px 80px; }
    .card-body { padding: 32px 40px 40px; }
    .card-section { padding: 26px 40px; }
    .word-banner { padding: 20px 40px 16px; }
    .chapter-list { max-height: 560px; }
    .opt-btn { font-size: 14.5px; line-height: 1.5; }
    .opt-btn.blank-opt { font-size: 17px; }
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

  /* Landscape tablet and up (>=1024px): make use of the wider viewport */
  @media (min-width: 1024px) {
    .card { max-width: 860px; }
    .app { padding: 56px 40px 80px; }
    .options-grid { gap: 14px; }
    .app-title { margin-bottom: 44px; }
    .app-title h1 { font-size: 32px; }
  }

  /* .game-active is added to .app only during the question phase. */
  .app.game-active { padding: 14px; height: 100dvh; box-sizing: border-box; justify-content: flex-start; }
  .app.game-active > .card { display: grid; grid-template-rows: auto 1fr; height: calc(100dvh - 120px); overflow: hidden; }
  .app.game-active .illustration-area { min-height: 0; max-height: 35vh; display: flex; align-items: center; justify-content: center; padding: 12px; overflow: hidden; }
  .app.game-active .illustration-frame { aspect-ratio: auto; width: 100%; height: 100%; }
  .app.game-active .illustration-frame img { object-fit: contain; }
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
    .app.game-active .illustration-frame img { height: 100%; width: 100%; }
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
function UploadPhase({ onParsed, onStartReview }) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [library, setLibrary] = useState([]);
  const [expandedBook, setExpandedBook] = useState(null);
  const [flushed, setFlushed] = useState({}); // { "hash-layer": true } for brief confirmation
  const [deleting, setDeleting] = useState(null); // hash of book currently being deleted
  const [reviewCount, setReviewCount] = useState(0);
  const [nextReview, setNextReview] = useState(null); // { date, count }
  const [totalWords, setTotalWords] = useState(0);
  const inputRef = useRef();

  useEffect(() => { getBookIndex().then(setLibrary); }, []);
  // Fetch review queue count and total vocabulary size on mount. These drive
  // the home screen layout: whether to show the practice section, the welcome
  // message, or the "all caught up" state. Single fetch to avoid 3 round-trips.
  useEffect(() => {
    getHomeData().then(({ reviewCount, nextReview, totalWords }) => {
      setReviewCount(reviewCount);
      setNextReview(nextReview);
      setTotalWords(totalWords);
    });
  }, []);

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

  // Delete via the server-side bulk endpoint instead of issuing dozens of
  // sequential KV DELETE calls from the client. The server reads files and
  // computes chapter hashes locally, deletes everything in parallel, and
  // returns in a single round trip (~100ms vs ~20s previously).
  // UI shows a "Deleting..." state so the user knows the action is in progress.
  async function handleDeleteBook(e, hash) {
    e.stopPropagation();
    setDeleting(hash);
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(hash)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setExpandedBook(null);
      // Optimistic removal — the server already deleted the index entry,
      // so we update the UI immediately without re-fetching.
      setLibrary(prev => prev.filter(b => b.hash !== hash));
    } catch (err) {
      console.error('Failed to delete book:', err);
      setError('Failed to delete book. Please try again.');
    }
    setDeleting(null);
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

  // New users: no books and no words yet. Show a welcome explanation.
  const isNewUser = library.length === 0 && totalWords === 0;
  // Returning users who have words (from books or seeding) see the practice section.
  const hasWords = totalWords > 0;

  return (
    <>
      {/* ── Welcome message for first-time users ─────────────────────────── */}
      {isNewUser && (
        <div className="card">
          <div className="card-body" style={{textAlign:"center",padding:"32px 24px"}}>
            <div style={{fontSize:13,color:"var(--text-dim)",lineHeight:1.7,maxWidth:440,margin:"0 auto"}}>
              <strong style={{color:"var(--text)"}}>How it works:</strong> Upload a book you're reading, pick a chapter, and the app will find vocabulary words to learn. After you play, the words come back for practice at just the right time so you remember them.
            </div>
          </div>
        </div>
      )}

      {/* ── Section 1: Practice your words ────────────────────────────────
          Shown when the player has any words in their vocabulary. This is the
          primary daily activity — the thing returning users should do first. */}
      {hasWords && (
        <div className="card">
          <div className="card-body">
            <div className="home-section-label">Practice your words</div>
            {reviewCount > 0 ? (
              <div className="review-banner" onClick={onStartReview}>
                <div className="review-banner-text">
                  <span className="review-banner-count">Practice {Math.min(reviewCount, 5)} word{Math.min(reviewCount, 5) !== 1 ? "s" : ""}</span>
                  <span className="review-banner-sub">{reviewCount} ready across your vocabulary</span>
                </div>
                <span className="review-banner-arrow">&rarr;</span>
              </div>
            ) : (
              <div className="review-banner review-banner-empty">
                <div className="review-banner-text">
                  <span className="review-banner-count">All caught up!</span>
                  <span className="review-banner-sub">
                    {totalWords} word{totalWords !== 1 ? "s" : ""} in your vocabulary
                    {nextReview && <> · Next practice: {nextReview.count} word{nextReview.count !== 1 ? "s" : ""} on {new Date(nextReview.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</>}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Section 2: Learn new words ────────────────────────────────────
          Book library + upload zone. Always visible so the player can add
          new books or pick a chapter from an existing one. */}
      <div className="card">
        <div className="card-body">
          <div className="home-section-label">Learn new words</div>
          {library.length > 0 && (
            <div className="book-library">
              <div className="book-library-sublabel">Pick a book and chapter to find vocabulary words</div>
              {library.map(b => (
                <div key={b.hash} className={`book-entry${deleting === b.hash ? " book-entry-deleting" : ""}`}>
                  <div className="book-item" onClick={() => deleting ? null : handleSelectBook(b.hash)} style={deleting === b.hash ? { opacity: 0.5, pointerEvents: "none" } : {}}>
                    <div className="book-item-info">
                      <div className="book-item-title">{b.title}</div>
                      <div className="book-item-meta">{deleting === b.hash ? "Deleting..." : `${b.chapterCount} chapter${b.chapterCount !== 1 ? "s" : ""}`}</div>
                    </div>
                    <div className="book-item-actions">
                      <button className="book-item-btn kebab" onClick={e => { e.stopPropagation(); setExpandedBook(expandedBook === b.hash ? null : b.hash); }} title="Cache settings" disabled={!!deleting}>...</button>
                      <button className="book-item-btn remove" onClick={e => handleDeleteBook(e, b.hash)} title="Remove book and all cached data" disabled={!!deleting}>{deleting === b.hash ? "\u23F3" : "\u00D7"}</button>
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
              <input ref={inputRef} type="file" accept=".epub,.txt" onChange={e => handleFile(e.target.files[0])} style={{display:"none"}} />
              {loading ? (
                <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12,fontSize:13,color:"var(--text-dim)"}}>
                  <div className="spinner" style={{width:16,height:16,borderWidth:2}}/> Loading…
                </div>
              ) : (
                <button className="add-book-btn" onClick={() => inputRef.current.click()}>
                  + Add a book
                </button>
              )}
              {error && <p style={{color:"#e09090",fontSize:13,marginTop:8}}>{error}</p>}
            </div>
          )}
          {library.length === 0 && (
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
          )}
        </div>
      </div>
    </>
  );
}

// ── Phase: CHAPTER SELECT ─────────────────────────────────────────────────────
function ChapterPhase({ chapters, bookTitle, storyBible, onSelect }) {
  return (
    <div className="card">
      <div className="card-body">
        <div className="section-label">Choose a chapter — {bookTitle}</div>

        {storyBible && (
          <div style={{marginBottom:16,padding:"10px 14px",background:"rgba(100,70,20,0.04)",border:"1px solid rgba(100,70,20,0.12)",borderRadius:3,display:"flex",alignItems:"center",gap:10}}>
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
      <p style={{fontStyle:"normal",color:"var(--text-dim)"}}>Finding valuable vocabulary words…</p>
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
              <span style={{fontSize:11,color:"rgba(100,70,20,0.38)",fontStyle:"normal"}}>from cache</span>
              <button onClick={handleRefresh}
                style={{background:"none",border:"1px solid rgba(100,70,20,0.15)",borderRadius:3,
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
          <div style={{marginTop:16,background:"rgba(100,70,20,0.03)",border:"1px solid rgba(100,70,20,0.15)",borderRadius:3,padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:11,letterSpacing:"0.15em",textTransform:"uppercase",color:"rgba(100,70,20,0.4)"}}>
                words.json for offline image generation — click text to select all
              </div>
              <span style={{fontSize:11,color:"rgba(100,70,20,0.38)",fontStyle:"normal"}}>
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
        <div style={{marginTop:16,padding:"12px 14px",background:"rgba(100,70,20,0.03)",
          border:"1px solid rgba(100,70,20,0.1)",borderRadius:3}}>
          <div style={{fontSize:11,letterSpacing:"0.15em",textTransform:"uppercase",
            color:"rgba(100,70,20,0.4)",marginBottom:8}}>Optional — upload images before generating</div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <input ref={tarballInputRef} type="file" accept="application/gzip,application/x-gzip,application/x-tar,.gz,.tgz,*/*"
              style={{display:"none"}}
              onChange={e => handleTarballUpload(e.target.files[0])}/>
            <button
              onClick={() => tarballInputRef.current?.click()}
              style={{background:"none",border:"1px solid rgba(100,70,20,0.18)",borderRadius:3,
                padding:"7px 14px",fontFamily:"'Lora',serif",fontSize:13,
                color:"var(--gold-dim)",cursor:"pointer"}}>
              ↑ Upload vocab-images.tar.gz
            </button>
            {tarballStatus === "loading" && (
              <span style={{fontSize:12,color:"var(--text-dim)",fontStyle:"normal",display:"flex",alignItems:"center",gap:6}}>
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
              style={{fontSize:12,padding:"6px 8px",background:"var(--card-bg)",color:"var(--text-dim)",border:"1px solid rgba(100,70,20,0.18)",borderRadius:3}}
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
        <p style={{fontSize:13,color:"var(--text-dim)",marginBottom:20,lineHeight:1.6,fontStyle:"normal"}}>
          Building character & setting descriptions to keep illustrations consistent across the whole book.
        </p>

        <div style={{display:"flex",alignItems:"flex-start",gap:14,padding:"16px",background:"rgba(100,70,20,0.04)",border:"1px solid rgba(100,70,20,0.1)",borderRadius:3}}>
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
                  <div key={c.name} style={{marginBottom:8,padding:"10px 14px",background:"rgba(100,70,20,0.02)",border:"1px solid rgba(100,70,20,0.06)",borderRadius:3}}>
                    <div style={{fontFamily:"'Source Serif 4',Georgia,serif",fontSize:14,color:"var(--gold)",marginBottom:3}}>{c.name}</div>
                    <div style={{fontSize:12,color:"var(--text-dim)",lineHeight:1.5,fontStyle:"normal"}}>{c.promptFragment}</div>
                  </div>
                ))}
              </div>
            )}
            {bible.settings?.length > 0 && (
              <div>
                <div className="section-label" style={{marginBottom:8}}>Settings</div>
                {bible.settings.map(s => (
                  <div key={s.name} style={{marginBottom:8,padding:"10px 14px",background:"rgba(100,70,20,0.02)",border:"1px solid rgba(100,70,20,0.06)",borderRadius:3}}>
                    <div style={{fontFamily:"'Source Serif 4',Georgia,serif",fontSize:14,color:"var(--gold)",marginBottom:3}}>{s.name}</div>
                    <div style={{fontSize:12,color:"var(--text-dim)",lineHeight:1.5,fontStyle:"normal"}}>{s.promptFragment}</div>
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
                          style={{background:"none",border:"none",fontSize:13,color:"rgba(100,70,20,0.4)",
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
      correctSound.play();
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
      <div className="exercise-label-bar">
        <span>Fill in the blank</span>
        <span className="exercise-label-tag">review</span>
      </div>
      {/* XSS safe: definition is a Claude-generated string rendered as a JSX
          text child (auto-escaped by React), not via dangerouslySetInnerHTML. */}
      <div className="card-section definition-section">
        <div style={{fontSize:17,lineHeight:1.7,color:"var(--text)"}}>
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
      <div className="card-section blank-row" style={{borderBottom:"none",paddingBottom:28}}>
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
        <div className="blank-feedback">
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
    </div>
  );
}

// ── Spelling practice card ────────────────────────────────────────────────────
function SpellCard({ asset, onCorrect }) {
  const word = asset.word;
  const lower = word.toLowerCase();
  const [stage, setStage] = useState("trace"); // trace | recall | review
  const [pos, setPos] = useState(0);           // current char index (trace/review)
  const [recallChars, setRecallChars] = useState([]);
  const [recallMistakes, setRecallMistakes] = useState(0);
  const recallMistakesRef = useRef(0);
  const [flash, setFlash] = useState(-1);      // index of wrong-char flash
  const inputRef = useRef(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const focusInput = useCallback(() => {
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.value = "";
        inputRef.current.focus();
      }
    }, 80);
  }, []);

  useEffect(focusInput, [stage, focusInput]);

  // Cancel any in-progress speech when the card unmounts, so audio doesn't
  // keep playing after the user navigates away.
  useEffect(() => () => speechSynthesis.cancel(), []);

  function speak(e) {
    if (e) e.stopPropagation();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word);
    u.rate = 0.82;
    speechSynthesis.speak(u);
  }

  // Process a single typed character
  function processChar(ch) {
    const s = stageRef.current;
    if (s === "trace" || s === "review") {
      if (ch === lower[pos]) {
        const next = pos + 1;
        setPos(next);
        if (next >= lower.length) {
          if (s === "trace") {
            setTimeout(() => {
              setStage("recall");
              setPos(0);
              setRecallChars([]);
            }, 800);
          } else {
            // review retype complete → report score
            correctSound.play();
            const m = recallMistakesRef.current;
            setTimeout(() => onCorrect(m), 1000);
          }
        }
      } else {
        // Wrong character — flash it
        setFlash(pos);
        setTimeout(() => setFlash(-1), 400);
      }
    } else if (s === "recall") {
      const newChars = [...recallChars, ch];
      setRecallChars(newChars);
      if (newChars.length >= lower.length) {
        let mistakes = 0;
        for (let i = 0; i < lower.length; i++) {
          if (newChars[i] !== lower[i]) mistakes++;
        }
        setRecallMistakes(mistakes);
        recallMistakesRef.current = mistakes;
        if (mistakes === 0) {
          // Perfect — brief pause then advance
          correctSound.play();
          setTimeout(() => onCorrect(0), 1200);
        } else {
          // Show review inline — user can immediately start retyping
          setTimeout(() => { setStage("review"); setPos(0); }, 500);
        }
      }
    }
  }

  function handleInput(e) {
    const val = e.target.value || "";
    if (val.length > 0) {
      const ch = val.slice(-1).toLowerCase();
      e.target.value = "";
      processChar(ch);
    }
  }

  function handleKeyDown(e) {
    // Allow backspace during recall before submission
    if (e.key === "Backspace" && stageRef.current === "recall" && recallChars.length > 0) {
      e.preventDefault();
      setRecallChars(prev => prev.slice(0, -1));
    }
  }

  // Render the character boxes
  function renderChars() {
    const chars = word.split("");

    if (stage === "trace") {
      return chars.map((ch, i) => {
        let cls = "spell-char";
        if (i < pos) cls += " spell-typed";
        else if (i === pos) cls += " spell-ghost spell-active";
        else cls += " spell-ghost";
        if (i === flash) cls += " spell-flash-wrong";
        return <span key={i} className={cls}>{ch}</span>;
      });
    }

    if (stage === "recall") {
      return chars.map((ch, i) => {
        let cls = "spell-char spell-blank";
        if (i < recallChars.length) cls += " spell-filled";
        else if (i === recallChars.length) cls += " spell-active";
        return (
          <span key={i} className={cls}>
            {i < recallChars.length ? recallChars[i] : "\u00A0"}
          </span>
        );
      });
    }

    // Review: positions < pos are retyped (gold), positions >= pos show recall results
    if (stage === "review") {
      return chars.map((ch, i) => {
        if (i < pos) {
          // Already retyped correctly
          return <span key={i} className="spell-char spell-typed">{ch}</span>;
        }
        // Show recall result with cursor on current position
        const typed = recallChars[i] || "";
        const ok = typed.toLowerCase() === ch.toLowerCase();
        let cls = `spell-char ${ok ? "spell-review-ok" : "spell-review-wrong"}`;
        if (i === pos) cls += " spell-active";
        if (i === flash) cls += " spell-flash-wrong";
        return (
          <span key={i} className={cls}>
            {typed}
            {!ok && <span className="spell-correct-hint">{ch}</span>}
          </span>
        );
      });
    }
    return null;
  }

  // In the chapter flow, options is always present. In review, spelling exercises
  // for words without cached quiz data have options: null — we just skip showing
  // the definition in that case (the word itself is still shown for tracing).
  const definition = asset.options?.options?.[asset.options?.correct] || null;
  const stageLabels = {
    trace: "Type each letter as you see it",
    recall: "Now spell it from memory",
    review: "Type each correction to continue",
  };

  return (
    <div className="card" onClick={focusInput}>
      <div className="exercise-label-bar">
        <span>Spell the word</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span className="exercise-label-tag">practice</span>
          <button className="speak-btn" onClick={speak} title="Hear pronunciation" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
          </button>
        </div>
      </div>

      {definition && (
        <div className="card-section definition-section">
          <div style={{fontSize:17,lineHeight:1.7,color:"var(--text)"}}>
            {definition}
          </div>
        </div>
      )}

      <div className="card-section" style={{borderBottom:"none",paddingBottom:28}}>
        <div className="section-label">{stageLabels[stage]}</div>

        <div className="spell-chars-wrap">
          <div className="spell-chars">
            {renderChars()}
          </div>
          {/* Hidden input overlays the chars area so tapping it opens the keyboard */}
          <input
            ref={inputRef}
            className="spell-hidden-input"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Type spelling"
            enterKeyHint="next"
          />
        </div>

        {/* Perfect recall gets a brief success banner (no retyping needed) */}
        {stage === "recall" && recallChars.length >= lower.length && recallMistakes === 0 && (
          <div className="feedback-banner correct" style={{marginTop:20}}>
            <div className="fb-head">Perfect spelling! ✦</div>
            You spelled <strong>{word}</strong> flawlessly.
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

  // Queue: meaning → fill-in-the-blank → spelling for ALL words
  const initialQueue = [
    ...assetsWithBlanks.map(a => ({ ...a, roundType: "meaning" })),
    ...assetsWithBlanks.map(a => ({ ...a, roundType: "blank" })),
    ...assetsWithBlanks.map(a => ({ ...a, roundType: "spell" })),
  ];
  const [queue] = useState(initialQueue);
  const [queuePos, setQueuePos] = useState(0);
  // Track scores separately for each round
  const [scores, setScores] = useState(
    () => Object.fromEntries(assetsWithBlanks.map(a => [a.word, { meaning: null, blank: null, spelling: null }]))
  );
  const [phase, setPhase] = useState("quiz");
  const [wrongPicks, setWrongPicks] = useState([]);
  const [correctPick, setCorrectPick] = useState(null);
  const [soundMuted, setSoundMuted] = useState(correctSound.muted);

  const current = queue[queuePos];

  useEffect(() => {
    setPhase("quiz");
    setWrongPicks([]);
    setCorrectPick(null);
  }, [queuePos]);

  function advance(newScores) {
    if (queuePos >= queue.length - 1) {
      onDone(newScores);
    } else {
      setQueuePos(pos => pos + 1);
    }
  }

  function handleSelect(i) {
    const isCorrect = i === current.options.correct;
    if (isCorrect) {
      correctSound.play();
      const newScore = wrongPicks.length === 0 ? "correct" : "retry";
      const newScores = { ...scores, [current.word]: { ...scores[current.word], meaning: newScore } };
      setScores(newScores);
      setCorrectPick(i);
      setPhase("correct");
      setTimeout(() => advance(newScores), wrongPicks.length === 0 ? 1200 : 1500);
    } else {
      setWrongPicks(p => [...p, i]);
      setPhase("hint");
    }
  }

  function handleBlankCorrect(numWrong) {
    const blankScore = numWrong === 0 ? "correct" : "retry";
    const newScores = { ...scores, [current.word]: { ...scores[current.word], blank: blankScore } };
    setScores(newScores);
    advance(newScores);
  }

  function handleSpellCorrect(numMistakes) {
    const spellScore = numMistakes === 0 ? "correct" : "retry";
    const newScores = { ...scores, [current.word]: { ...scores[current.word], spelling: spellScore } };
    setScores(newScores);
    advance(newScores);
  }

  const totalExercises = queue.length;
  const progressPct = (queuePos / totalExercises) * 100;

  const roundType = current.roundType;
  const dotScores = assets.map(a => {
    const s = scores[a.word];
    const scoreKey = roundType === "blank" ? "blank" : roundType === "spell" ? "spelling" : "meaning";
    const score = s?.[scoreKey];
    if (!score && a.word === current.word) return "current";
    return score || "";
  });

  const phases = [
    { key: "meaning", label: "Meaning" },
    { key: "blank",   label: "Fill in blank" },
    { key: "spell",   label: "Spelling" },
  ];

  return (
    <>
      <div className="game-progress-bar">
        <div className="gp-phases">
          {phases.map(p => (
            <span key={p.key} className={`gp-phase${p.key === roundType ? " gp-active" : ""}`}>
              {p.label}
            </span>
          ))}
        </div>
        <div className="gp-track">
          <div className="gp-fill" style={{width:`${progressPct}%`}}/>
        </div>
        <div className="gp-bottom-row">
          <div className="gp-count">{queuePos + 1} of {totalExercises}</div>
          <button
            className="gp-mute-btn"
            onClick={() => setSoundMuted(correctSound.toggle())}
            title={soundMuted ? "Unmute sounds" : "Mute sounds"}
            type="button"
          >
            {soundMuted ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            )}
          </button>
        </div>
      </div>
      <div className="score-strip">
        {dotScores.map((s, i) => (
          <div key={i} className={`score-dot ${s}`} title={assets[i].word}/>
        ))}
      </div>

      {roundType === "blank" ? (
        <BlankCard
          key={current.word}
          asset={current}
          onCorrect={handleBlankCorrect}
        />
      ) : roundType === "spell" ? (
        <SpellCard
          key={current.word}
          asset={current}
          onCorrect={handleSpellCorrect}
        />
      ) : (
        <div className="card">

          {current.image && (
            <div className="illustration-area">
              <div className="illustration-frame">
                <img key={current.word} src={current.image} alt={`Scene for ${current.word}`}/>
              </div>
            </div>
          )}
          {/* Word + paragraph merged into one section (no separate banner / "From the text" label)
              to keep the content half compact and balanced against the illustration */}
          <div className="game-content">
          <div className="card-section">
            <span className="vocab-word">{current.word}</span>
            <div className="paragraph-text" style={{marginTop:10}}>
              "<Highlighted paragraph={current.paragraph} word={current.word}/>"
            </div>
          </div>
          <div className="card-section" style={{borderBottom:"none",paddingBottom:28}}>
            <div className="question-text">What does "{current.word}" mean?</div>
            <div className="options-grid">
              {current.options.options.map((opt, i) => {
                let cls = "opt-btn";
                if (wrongPicks.includes(i)) cls += " eliminated";
                if (correctPick === i) cls += " correct";
                const disabled = phase === "correct" || wrongPicks.includes(i);
                return (
                  <button key={i} className={cls} onClick={() => handleSelect(i)} disabled={disabled}>
                    <span className="opt-letter">{String.fromCharCode(65+i)}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
            <div className="feedback-slot" style={{visibility: phase === "hint" ? "visible" : "hidden"}}>
              <div className="feedback-banner hint">
                <div className="fb-head">Not quite — try again.</div>
                {current.hint}
              </div>
            </div>
          </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── REVIEW: Exercise assignment by maturity ──────────────────────────────────
//
// Maps a word's SM-2 repetition count to the appropriate exercise type.
// The principle: harder exercises for more mature words (desirable difficulty).
// See docs/exercise-design-research.md § Review Queue Design for the research.
//
// Currently uses only the three existing exercise types. As new types are added
// (free recall, sentence generation), they'll slot into the higher tiers.
function assignExerciseType(wordRecord) {
  const rep = wordRecord.repetitions || 0;
  if (rep <= 1) return "meaning";       // MC — just learned or just failed, low friction
  if (rep <= 3) return "blank";         // fill-in-blank — cued recall for familiar words
  return "spell";                       // spelling — approaching mastery, no definition cues
}

// ── REVIEW: Loading phase — fetches cached assets for review words ───────────
//
// Unlike the chapter flow (which generates all assets fresh via Claude/Gemini),
// the review flow assembles assets from cached data. Each word's quiz data
// (definitions, MC options, hints) was cached under `quiz-word-{word}` when it
// was first played in a chapter or seeded by scripts/seed-words.mjs.
//
// This phase: loads the review queue → picks top 15 → looks up cached assets
// for each → assigns exercise types by maturity → shuffles for interleaving.
function ReviewLoadingPhase({ onReady, onEmpty }) {
  const [status, setStatus] = useState("loading"); // loading | error
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const queue = await getReviewQueue();
        if (queue.length === 0) { onEmpty(); return; }

        // Cap at 5 words per session to keep reviews quick and low-friction.
        // Players can always start another session for more. getReviewQueue()
        // already sorts most overdue first, so this naturally prioritizes words
        // at risk of being forgotten. See Drops' time-boxing insight: short
        // sessions reduce the "I don't have time" barrier.
        const selected = queue.slice(0, 5);

        const reviewAssets = [];
        for (const wordRec of selected) {
          const exerciseType = assignExerciseType(wordRec);
          const source = wordRec.sources?.[0];

          // Look up quiz data from the per-word cache. This key is written in
          // two places: generateAllWordAssets (chapter play) and seed-words.mjs.
          const quizItem = await storageGet(`quiz-word-${wordRec.word.toLowerCase().trim()}`);

          // Try to find the original paragraph and illustration from the book's
          // chapter cache. This only works for book-sourced words (not seeded).
          let paragraph = "";
          let image = null;
          if (source?.bookHash) {
            const bookData = await loadBookFromLibrary(source.bookHash);
            if (bookData) {
              const chapter = bookData.chapters.find(c => c.title === source.chapterTitle);
              if (chapter) {
                const chHash = await hashText(chapter.text);
                const wordlistCache = await storageGet(`wordlist-${chHash}`);
                const wordInfo = wordlistCache?.find(w => w.word.toLowerCase() === wordRec.word.toLowerCase());
                paragraph = wordInfo?.paragraph || "";
                const illustCache = await storageGet(`illust-${chHash}-${wordRec.word.toLowerCase().trim()}`);
                image = illustCache?.dataUri || null;
              }
            }
          }
          // For seeded words (bookHash is null), the seed script stores the
          // context sentence directly in the quiz cache entry as `paragraph`.
          if (!paragraph && quizItem?.paragraph) {
            paragraph = quizItem.paragraph;
          }

          if (quizItem) {
            // Re-shuffle MC options each session so the player can't memorize
            // option positions across reviews.
            reviewAssets.push({
              word: wordRec.word,
              paragraph,
              options: shuffleOptions({ correct: quizItem.correct ?? 0, options: quizItem.options }),
              hint: quizItem.hint,
              image,
              exerciseType,
              repetitions: wordRec.repetitions || 0,
              source,
            });
          } else {
            // No cached quiz data — fall back to spelling, which only needs
            // the word itself (no MC options or hints required).
            reviewAssets.push({
              word: wordRec.word,
              paragraph,
              options: null,
              hint: null,
              image,
              exerciseType: "spell",
              repetitions: wordRec.repetitions || 0,
              source,
            });
          }
        }

        if (reviewAssets.length === 0) { onEmpty(); return; }

        // Shuffle so exercise types are interleaved (not grouped). Kornell &
        // Bjork (2008): interleaving improved learning by 43% vs. blocking.
        for (let i = reviewAssets.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [reviewAssets[i], reviewAssets[j]] = [reviewAssets[j], reviewAssets[i]];
        }

        onReady(reviewAssets);
      } catch (e) {
        console.error("Review loading failed:", e);
        setError(e.message);
        setStatus("error");
      }
    })();
  }, []);

  if (status === "error") return (
    <div className="card"><div className="card-body" style={{textAlign:"center",padding:"48px"}}>
      <p style={{color:"#e09090"}}>Failed to load review: {error}</p>
    </div></div>
  );

  return (
    <div className="card"><div className="card-body" style={{textAlign:"center",padding:"48px"}}>
      <div className="spinner" style={{margin:"0 auto 16px"}}/>
      <p style={{fontStyle:"normal",color:"var(--text-dim)"}}>Preparing your practice session…</p>
    </div></div>
  );
}

// ── REVIEW: Game phase — interleaved, one exercise per word ──────────────────
//
// Simpler than the chapter GamePhase: one pass through the queue, each word
// gets exactly one exercise (determined by assignExerciseType during loading).
// This is a separate component rather than a mode of GamePhase because the
// chapter flow has round-management logic (3 passes, round labels, per-round
// score tracking) that doesn't apply to reviews and would require extensive
// conditionals to bypass.
//
// The score model is also different: { word → { score, exerciseType } } instead
// of { word → { meaning, blank, spelling } }, since each word has only one exercise.
function ReviewGamePhase({ assets, onDone }) {
  // Build blank options for fill-in-blank exercises. Distractors are drawn from
  // the full review pool (not one chapter), which makes them harder and more
  // useful than chapter-scoped distractors — the words are less related.
  const assetsWithBlanks = assets.map((a, idx) => {
    if (a.exerciseType !== "blank") return a;
    const otherWords = assets.filter((_, j) => j !== idx).map(x => x.word);
    const shuffled = [...otherWords].sort(() => Math.random() - 0.5).slice(0, 3);
    const blankArr = [{ word: a.word, isCorrect: true }, ...shuffled.map(w => ({ word: w, isCorrect: false }))];
    for (let i = blankArr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [blankArr[i], blankArr[j]] = [blankArr[j], blankArr[i]];
    }
    return { ...a, blankOptions: blankArr };
  });

  const [queuePos, setQueuePos] = useState(0);
  const [scores, setScores] = useState(
    () => Object.fromEntries(assetsWithBlanks.map(a => [a.word, { score: null, exerciseType: a.exerciseType }]))
  );
  const [phase, setPhase] = useState("quiz");
  const [wrongPicks, setWrongPicks] = useState([]);
  const [correctPick, setCorrectPick] = useState(null);
  const [soundMuted, setSoundMuted] = useState(correctSound.muted);

  const current = assetsWithBlanks[queuePos];

  useEffect(() => {
    setPhase("quiz");
    setWrongPicks([]);
    setCorrectPick(null);
  }, [queuePos]);

  function advance(newScores) {
    if (queuePos >= assetsWithBlanks.length - 1) {
      onDone(newScores);
    } else {
      setQueuePos(pos => pos + 1);
    }
  }

  // MC meaning handlers
  function handleSelect(i) {
    const isCorrect = i === current.options.correct;
    if (isCorrect) {
      correctSound.play();
      const newScore = wrongPicks.length === 0 ? "correct" : "retry";
      const newScores = { ...scores, [current.word]: { ...scores[current.word], score: newScore } };
      setScores(newScores);
      setCorrectPick(i);
      setPhase("correct");
      setTimeout(() => advance(newScores), wrongPicks.length === 0 ? 1200 : 1500);
    } else {
      setWrongPicks(p => [...p, i]);
      setPhase("hint");
    }
  }

  function handleBlankCorrect(numWrong) {
    const blankScore = numWrong === 0 ? "correct" : "retry";
    const newScores = { ...scores, [current.word]: { ...scores[current.word], score: blankScore } };
    setScores(newScores);
    advance(newScores);
  }

  function handleSpellCorrect(numMistakes) {
    const spellScore = numMistakes === 0 ? "correct" : "retry";
    const newScores = { ...scores, [current.word]: { ...scores[current.word], score: spellScore } };
    setScores(newScores);
    advance(newScores);
  }

  const totalExercises = assetsWithBlanks.length;
  const progressPct = (queuePos / totalExercises) * 100;

  const exerciseLabel = { meaning: "Meaning", blank: "Fill in blank", spell: "Spelling" }[current.exerciseType] || "";

  return (
    <>
      <div className="game-progress-bar">
        <div className="gp-phases">
          <span className="gp-phase gp-active">{exerciseLabel}</span>
          <span className="gp-phase" style={{opacity:0.4}}>Practice session</span>
        </div>
        <div className="gp-track">
          <div className="gp-fill" style={{width:`${progressPct}%`}}/>
        </div>
        <div className="gp-bottom-row">
          <div className="gp-count">{queuePos + 1} of {totalExercises}</div>
          <button
            className="gp-mute-btn"
            onClick={() => setSoundMuted(correctSound.toggle())}
            title={soundMuted ? "Unmute sounds" : "Mute sounds"}
            type="button"
          >
            {soundMuted ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {current.exerciseType === "blank" ? (
        <BlankCard
          key={`${current.word}-${queuePos}`}
          asset={current}
          onCorrect={handleBlankCorrect}
        />
      ) : current.exerciseType === "spell" ? (
        <SpellCard
          key={`${current.word}-${queuePos}`}
          asset={current}
          onCorrect={handleSpellCorrect}
        />
      ) : (
        <div className="card">
          {current.image && (
            <div className="illustration-area">
              <div className="illustration-frame">
                <img key={current.word} src={current.image} alt={`Scene for ${current.word}`}/>
              </div>
            </div>
          )}
          <div className="game-content">
          <div className="card-section">
            <span className="vocab-word">{current.word}</span>
            {current.paragraph && (
              <div className="paragraph-text" style={{marginTop:10}}>
                "<Highlighted paragraph={current.paragraph} word={current.word}/>"
              </div>
            )}
          </div>
          <div className="card-section" style={{borderBottom:"none",paddingBottom:28}}>
            <div className="question-text">What does "{current.word}" mean?</div>
            <div className="options-grid">
              {current.options.options.map((opt, i) => {
                let cls = "opt-btn";
                if (wrongPicks.includes(i)) cls += " eliminated";
                if (correctPick === i) cls += " correct";
                const disabled = phase === "correct" || wrongPicks.includes(i);
                return (
                  <button key={i} className={cls} onClick={() => handleSelect(i)} disabled={disabled}>
                    <span className="opt-letter">{String.fromCharCode(65+i)}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
            <div className="feedback-slot" style={{visibility: phase === "hint" ? "visible" : "hidden"}}>
              <div className="feedback-banner hint">
                <div className="fb-head">Not quite — try again.</div>
                {current.hint}
              </div>
            </div>
          </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── REVIEW: Results phase ────────────────────────────────────────────────────
//
// Single-column layout (vs. the chapter flow's 3-column meaning×blank×spelling
// grid) because each word only had one exercise. Shows the exercise type as a
// label so the player knows what they were tested on.
//
// Records the session with gameType "review" so SM-2 updates use the
// single-exercise quality scoring (see the presentScores fix in wordRecords.js).
function ReviewResultsPhase({ assets, scores, onDone, onPracticeMore }) {
  const scoreConfig = {
    correct: { bg:"rgba(34,120,34,0.07)",  border:"rgba(34,120,34,0.25)", color:"var(--correct-text)", icon:"✦", label:"first try" },
    retry:   { bg:"rgba(140,100,20,0.07)", border:"rgba(140,100,20,0.25)", color:"var(--retry-text)",   icon:"◆", label:"with a hint" },
    wrong:   { bg:"rgba(190,50,50,0.06)",  border:"rgba(190,50,50,0.2)",   color:"var(--wrong-text)",   icon:"✗", label:"missed" },
  };

  const exerciseLabels = { meaning: "Meaning", blank: "Fill in blank", spell: "Spelling" };

  const total = assets.length;
  const perfect = assets.filter(a => scores[a.word]?.score === "correct").length;
  const allPerfect = perfect === total;
  const [remainingCount, setRemainingCount] = useState(null);

  // Record the review session on mount, then check how many words remain. Each word produces exactly one wordResult
  // (unlike chapter sessions which produce 3 per word). The exerciseType names
  // used internally (meaning/blank/spell) must be mapped to the taskType names
  // that recordSession expects (meaning/fill-blank/spelling) for SM-2 scoring.
  useEffect(() => {
    const wordResults = assets.map(a => {
      const s = scores[a.word];
      const taskType = s?.exerciseType === "blank" ? "fill-blank"
        : s?.exerciseType === "spell" ? "spelling"
        : "meaning";
      return {
        word: a.word,
        taskType,
        firstTry: s?.score === "correct",
        attempts: s?.score ? 1 : 0,
      };
    });
    recordSession({
      gameType: "review",
      context: { bookTitle: "Review", bookHash: null, chapterTitle: "Practice session" },
      wordResults,
    }).then(() => getReviewQueue().then(q => setRemainingCount(q.length)));
  }, []);

  return (
    <div className="card">
      <div className="card-body" style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Source Serif 4',Georgia,serif",fontSize:52,color:"var(--gold)",marginBottom:10}}>
          {allPerfect ? "✦" : "◆"}
        </div>
        <div style={{fontFamily:"'Source Serif 4',Georgia,serif",fontSize:24,fontWeight:600,color:"var(--text)",marginBottom:6}}>
          {allPerfect ? "Perfect practice!" : "Well done!"}
        </div>
        <div style={{fontSize:13,color:"var(--gold-dim)",marginBottom:24,fontStyle:"normal"}}>
          {perfect} of {total} first try · Practice session
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6,margin:"0 auto 24px",maxWidth:780}}>
          {assets.map(a => {
            const s = scores[a.word]?.score || "wrong";
            const sc = scoreConfig[s] || scoreConfig.wrong;
            const exType = scores[a.word]?.exerciseType || "meaning";
            return (
              <div key={a.word} className="results-word-card" style={{background:sc.bg,border:`1px solid ${sc.border}`,justifyContent:"space-between"}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span className="rwc-word" style={{color:sc.color,fontSize:15}}>{a.word}</span>
                  <span className="rwc-label" style={{color:sc.color,fontSize:11}}>{sc.icon} {sc.label}</span>
                </div>
                <span style={{fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",color:"rgba(100,70,20,0.4)"}}>{exerciseLabels[exType]}</span>
              </div>
            );
          })}
        </div>

        {remainingCount > 0 && (
          <button className="primary-btn" onClick={onPracticeMore}>
            Practice more ({remainingCount} remaining)
          </button>
        )}
        <button className={remainingCount > 0 ? "secondary-btn" : "primary-btn"} onClick={onDone}>Back to Home</button>
        <div style={{marginTop:12}}>
          <button className="secondary-btn" onClick={() => exportData()}>Download Progress</button>
        </div>
      </div>
    </div>
  );
}

// ── Phase: RESULTS ────────────────────────────────────────────────────────────
function ResultsPhase({ assets, scores, bookTitle, bookHash, chapterTitle, onPlayAgain }) {
  const scoreConfig = {
    correct: { bg:"rgba(34,120,34,0.07)",  border:"rgba(34,120,34,0.25)", color:"var(--correct-text)", icon:"✦", label:"first try" },
    retry:   { bg:"rgba(140,100,20,0.07)", border:"rgba(140,100,20,0.25)", color:"var(--retry-text)",   icon:"◆", label:"with a hint" },
    wrong:   { bg:"rgba(190,50,50,0.06)",  border:"rgba(190,50,50,0.2)",   color:"var(--wrong-text)",   icon:"✗", label:"missed" },
  };

  const total = assets.length;
  const meaningPerfect  = assets.filter(a => scores[a.word]?.meaning  === "correct").length;
  const blankPerfect    = assets.filter(a => scores[a.word]?.blank    === "correct").length;
  const spellingPerfect = assets.filter(a => scores[a.word]?.spelling === "correct").length;
  const allPerfect = meaningPerfect === total && blankPerfect === total && spellingPerfect === total;
  const [nextPractice, setNextPractice] = useState(null);

  useEffect(() => {
    const wordResults = assets.flatMap(a => [
      { word: a.word, taskType: "meaning",    firstTry: scores[a.word]?.meaning  === "correct", attempts: scores[a.word]?.meaning  ? 1 : 0 },
      { word: a.word, taskType: "fill-blank", firstTry: scores[a.word]?.blank    === "correct", attempts: scores[a.word]?.blank    ? 1 : 0 },
      { word: a.word, taskType: "spelling",   firstTry: scores[a.word]?.spelling === "correct", attempts: scores[a.word]?.spelling ? 1 : 0 },
    ]);
    recordSession({
      gameType: "vocab-quest",
      context: { bookTitle, bookHash, chapterTitle },
      wordResults,
    }).then(() => getNextReviewDate().then(setNextPractice));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const colStyle = {fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"rgba(100,70,20,0.4)",textAlign:"left",paddingLeft:16};

  return (
    <div className="card">
      <div className="card-body" style={{textAlign:"center"}}>
        <div style={{fontFamily:"'Source Serif 4',Georgia,serif",fontSize:52,color:"var(--gold)",marginBottom:10}}>
          {allPerfect ? "✦" : "◆"}
        </div>
        <div style={{fontFamily:"'Source Serif 4',Georgia,serif",fontSize:24,fontWeight:600,color:"var(--text)",marginBottom:6}}>
          {allPerfect ? "Perfect score, Scholar!" : "Well done!"}
        </div>
        <div style={{fontSize:13,color:"var(--gold-dim)",marginBottom:24,fontStyle:"normal"}}>{chapterTitle} · {bookTitle}</div>

        {/* Three-column header */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,margin:"0 auto 6px",maxWidth:780}}>
          <div style={colStyle}>Word → Meaning</div>
          <div style={colStyle}>Fill in the Blank</div>
          <div style={colStyle}>Spelling</div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6,margin:"0 auto 24px",maxWidth:780}}>
          {assets.map(a => {
            const ms = scores[a.word]?.meaning  || "wrong";
            const bs = scores[a.word]?.blank    || "wrong";
            const ss = scores[a.word]?.spelling || "wrong";
            const mc = scoreConfig[ms] || scoreConfig.wrong;
            const bc = scoreConfig[bs] || scoreConfig.wrong;
            const sc = scoreConfig[ss] || scoreConfig.wrong;
            return (
              <div key={a.word} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                <div className="results-word-card" style={{background:mc.bg,border:`1px solid ${mc.border}`,flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span className="rwc-word" style={{color:mc.color,fontSize:15}}>{a.word}</span>
                  <span className="rwc-label" style={{color:mc.color,fontSize:11}}>{mc.icon} {mc.label}</span>
                </div>
                <div className="results-word-card" style={{background:bc.bg,border:`1px solid ${bc.border}`,flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span className="rwc-word" style={{color:bc.color,fontSize:15}}>{a.word}</span>
                  <span className="rwc-label" style={{color:bc.color,fontSize:11}}>{bc.icon} {bc.label}</span>
                </div>
                <div className="results-word-card" style={{background:sc.bg,border:`1px solid ${sc.border}`,flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span className="rwc-word" style={{color:sc.color,fontSize:15}}>{a.word}</span>
                  <span className="rwc-label" style={{color:sc.color,fontSize:11}}>{sc.icon} {sc.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        {nextPractice && (
          <div style={{fontSize:12,color:"var(--text-dim)",marginBottom:16,fontStyle:"normal"}}>
            These words will come back for practice on {new Date(nextPractice.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </div>
        )}
        <button className="primary-btn" onClick={onPlayAgain}>Play Again</button>
        <div style={{marginTop:12}}>
          <button className="secondary-btn" onClick={() => exportData()}>Download Progress</button>
        </div>
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
// ── Admin panel — manage family/friend accounts ──────────────────────────────
// Visible only to admin users. Lists all accounts with the ability to add new
// members or delete existing ones. Communicates with GET/POST/DELETE /api/users.
function AdminPanel({ currentUser, onClose }) {
  const [users, setUsers] = useState([]);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Fetch the user list on mount
  useEffect(() => {
    fetch("/api/users").then(r => r.json()).then(setUsers).catch(() => {});
  }, []);

  // Create a new user account
  const handleAdd = async (e) => {
    e.preventDefault();
    setError(""); setSuccess("");
    if (!newId.trim() || !newPass.trim()) { setError("Username and password are required"); return; }
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: newId.trim(), displayName: newName.trim() || newId.trim(), password: newPass }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error?.message || "Failed to create user"); return; }
      setSuccess(`User "${newId.trim()}" created`);
      setNewId(""); setNewName(""); setNewPass("");
      // Refresh the user list
      const updated = await fetch("/api/users").then(r => r.json());
      setUsers(updated);
    } catch { setError("Network error"); }
  };

  // Delete a user (with confirmation)
  const handleDelete = async (userId) => {
    if (!confirm(`Delete user "${userId}" and all their data? This cannot be undone.`)) return;
    setError(""); setSuccess("");
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { setError(data.error?.message || "Failed to delete user"); return; }
      setSuccess(`User "${userId}" deleted`);
      setUsers(u => u.filter(x => x.id !== userId));
    } catch { setError("Network error"); }
  };

  return (
    <div className="admin-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2>Manage Users</h2>
        <button className="link-btn" onClick={onClose} style={{ color: "var(--gold-dim)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>Close</button>
      </div>
      <ul className="user-list">
        {users.map(u => (
          <li key={u.id}>
            <span>{u.displayName}<span className="user-role">{u.role}</span></span>
            {u.id !== currentUser.id && (
              <button className="delete-btn" onClick={() => handleDelete(u.id)}>Delete</button>
            )}
          </li>
        ))}
      </ul>
      <form className="add-user-form" onSubmit={handleAdd}>
        <input placeholder="Username" value={newId} onChange={e => setNewId(e.target.value)} />
        <input placeholder="Display name" value={newName} onChange={e => setNewName(e.target.value)} />
        <input placeholder="Password" type="password" value={newPass} onChange={e => setNewPass(e.target.value)} />
        <button type="submit">Add User</button>
      </form>
      {error && <div className="admin-error">{error}</div>}
      {success && <div className="admin-success">{success}</div>}
    </div>
  );
}

export default function App() {
  // upload → bible → chapters → suggest → generating → game → results
  // review-loading → review-game → review-results (parallel review flow)
  const [phase, setPhase] = useState("upload");
  const [bookData, setBookData] = useState(null);
  const [storyBible, setStoryBible] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [chosenWords, setChosenWords] = useState([]);
  const [tarballImages, setTarballImages] = useState(null);
  const [chosenGeminiModel, setChosenGeminiModel] = useState(GEMINI_IMAGE_MODELS[0].id);
  const [gameAssets, setGameAssets] = useState([]);
  const [scores, setScores] = useState({});
  const [reviewAssets, setReviewAssets] = useState([]);
  const [reviewScores, setReviewScores] = useState({});
  // Incremented each time we return to the upload phase so UploadPhase
  // remounts and re-fetches the review queue count (avoids stale counts
  // after completing a review or chapter session).
  const [uploadKey, setUploadKey] = useState(0);

  // ── Multi-user state ─────────────────────────────────────────────────
  // Fetches the current user's profile from GET /api/me on mount. Returns
  // null in legacy mode (single-password auth). Used to display the user's
  // name, show the admin panel, and gate admin-only features.
  const [currentUser, setCurrentUser] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(setCurrentUser)
      .catch(() => {});
  }, []);

  return (
    <>
      <style>{STYLES}</style>
      {/* game-active class tightens spacing so the question card fits without scrolling on a tablet */}
      <div className={`app${phase === "game" || phase === "review-game" ? " game-active" : ""}`}>

        {/* ── User bar: shows current user, admin link, and logout ──────── */}
        {/* Hidden during game phases to maximize screen space for the card. */}
        {/* Only rendered in multi-user mode (currentUser !== null).         */}
        {currentUser && phase !== "game" && phase !== "review-game" && (
          <div className="user-bar">
            <span>Hi, {currentUser.displayName}</span>
            {currentUser.role === "admin" && (
              <button className="link-btn" onClick={() => setShowAdmin(s => !s)}>
                {showAdmin ? "Hide Admin" : "Admin"}
              </button>
            )}
            <a href="/api/logout">Log out</a>
          </div>
        )}

        {/* Hide the title on the question page — it wastes vertical space needed to fit the card */}
        {phase !== "game" && phase !== "review-game" && (
          <div className="app-title">
            <h1>Vocabulary Quest</h1>
            <p>Learn words from the books you love</p>
          </div>
        )}

        {/* ── Admin panel: manage family/friend accounts ────────────────── */}
        {showAdmin && currentUser?.role === "admin" && (
          <AdminPanel currentUser={currentUser} onClose={() => setShowAdmin(false)} />
        )}

        {phase === "upload" && (
          <UploadPhase
            key={uploadKey}
            onParsed={data => { setBookData(data); setPhase("bible"); }}
            onStartReview={() => setPhase("review-loading")}
          />
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

        {/* Review flow: a parallel track to the chapter flow (upload→bible→...→results).
            Entered from the "Practice N words" banner on the upload screen.
            review-loading fetches cached assets → review-game plays them → review-results
            records the session and shows scores → back to upload. */}
        {phase === "review-loading" && (
          <ReviewLoadingPhase
            onReady={assets => { setReviewAssets(assets); setPhase("review-game"); }}
            onEmpty={() => { setUploadKey(k => k + 1); setPhase("upload"); }}
          />
        )}

        {phase === "review-game" && (
          <ReviewGamePhase
            assets={reviewAssets}
            onDone={s => { setReviewScores(s); setPhase("review-results"); }}
          />
        )}

        {phase === "review-results" && (
          <ReviewResultsPhase
            assets={reviewAssets}
            scores={reviewScores}
            onPracticeMore={() => setPhase("review-loading")}
            onDone={() => { setUploadKey(k => k + 1); setPhase("upload"); }}
          />
        )}
      </div>
    </>
  );
}

// ── Test exports ─────────────────────────────────────────────────────────────
export { GamePhase as _GamePhase, ReviewGamePhase as _ReviewGamePhase, STYLES as _STYLES };
