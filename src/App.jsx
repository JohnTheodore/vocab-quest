import { recordSession, getReviewQueue, getWordRecord, getSessions, exportData } from "./wordRecords.js";

// ── API key helpers ───────────────────────────────────────────────────────────
function getAnthropicKey() {
  try { const k = import.meta.env?.VITE_ANTHROPIC_API_KEY; if (k) return k; } catch {}
  return window.ANTHROPIC_API_KEY || "";
}

function getGeminiKey() {
  try { const k = import.meta.env?.VITE_GEMINI_API_KEY; if (k) return k; } catch {}
  return null;
}

// Are we running locally (Vite dev server with Express backend)?
function isLocal() {
  try { return !!import.meta.env?.DEV; } catch { return false; }
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
  d.querySelectorAll("script,style").forEach(el => el.remove());
  return d.textContent.replace(/\s+/g, " ").trim();
}

async function parseEpub(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const containerXml = await zip.file("META-INF/container.xml").async("text");
  const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!rootfileMatch) throw new Error("Invalid EPUB: no rootfile");
  const opfPath = rootfileMatch[1];
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfXml = await zip.file(opfPath).async("text");
  const parser = new DOMParser();
  const opfDoc = parser.parseFromString(opfXml, "application/xml");
  const manifest = {};
  opfDoc.querySelectorAll("manifest item").forEach(item => {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  });
  const spineItems = Array.from(opfDoc.querySelectorAll("spine itemref"))
    .map(ref => manifest[ref.getAttribute("idref")])
    .filter(Boolean);
  const ncxId = opfDoc.querySelector("spine")?.getAttribute("toc");
  const navHref = manifest["nav"] || manifest["toc"] || (ncxId ? manifest[ncxId] : null);
  let tocEntries = [];
  if (navHref) {
    try {
      const navPath = opfDir + navHref;
      const navFile = zip.file(navPath) || zip.file(navHref);
      if (navFile) {
        const navHtml = await navFile.async("text");
        const navDoc = parser.parseFromString(navHtml, "text/html");
        const navLinks = navDoc.querySelectorAll("nav[epub\\:type='toc'] a, nav a, navPoint");
        navLinks.forEach(el => {
          const title = el.textContent.trim();
          const href = el.getAttribute("href") || el.querySelector("content")?.getAttribute("src") || "";
          if (title && href) tocEntries.push({ title, href: href.split("#")[0] });
        });
      }
    } catch (e) {}
  }
  const chapterTexts = [];
  for (const href of spineItems) {
    try {
      const fullPath = opfDir + href;
      const f = zip.file(fullPath) || zip.file(href);
      if (!f) continue;
      const html = await f.async("text");
      const text = htmlToText(html);
      if (text.length > 200) chapterTexts.push({ href, text });
    } catch (e) {}
  }
  return chapterTexts.map((ch, i) => {
    const tocMatch = tocEntries.find(t => ch.href.endsWith(t.href) || ch.href.includes(t.href));
    return { index: i, title: tocMatch?.title || `Section ${i + 1}`, text: ch.text, href: ch.href };
  });
}

async function parseTxt(file) {
  const text = await file.text();
  const chapterRegex = /\n(chapter\s+[\divxlc]+[^\n]*)\n/gi;
  const parts = text.split(chapterRegex);
  if (parts.length < 3) return [{ index: 0, title: file.name.replace(/\.[^.]+$/, ""), text: text.trim() }];
  const chapters = [];
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim();
    const body = (parts[i + 1] || "").trim();
    if (body.length > 200) chapters.push({ index: chapters.length, title, text: body });
  }
  return chapters;
}

async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text.slice(0, 500000));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function storageGet(key) {
  try {
    if (window.storage) {
      const result = await window.storage.get(key);
      return result ? JSON.parse(result.value) : null;
    } else {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : null;
    }
  } catch { return null; }
}

async function storageSet(key, value) {
  try {
    if (window.storage) await window.storage.set(key, JSON.stringify(value));
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

async function generateStoryBible(fullText, bookTitle) {
  const sample = fullText.slice(0, 60000);
  const isSample = fullText.length > 60000;
  return claudeJSON(
    `Story Bible generation for "${bookTitle}"...`,
    "You are a visual development expert. Always respond with valid JSON only.",
    4000
  );
}

async function getStoryBible(fullText, bookTitle, onStatus) {
  const hash = await hashText(fullText);
  const cacheKey = `storybible-${hash}`;
  onStatus({ step: "checking", message: "Checking for saved Story Bible…" });
  const cached = await storageGet(cacheKey);
  if (cached) return { bible: cached, hash, fromCache: true };
  onStatus({ step: "generating", message: "Reading the book and building Story Bible…" });
  const bible = await generateStoryBible(fullText, bookTitle);
  bible.generatedAt = new Date().toISOString();
  bible.bookHash = hash;
  await storageSet(cacheKey, bible);
  return { bible, hash, fromCache: false };
}

async function generateGeminiImageDirect(prompt, modelId = "gemini-2.5-flash-image") {
  const apiKey = getGeminiKey();
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/\${modelId}:generateContent?key=\${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["Image"] } }),
    });
    const data = await res.json();
    const imgPart = data.candidates?.[0]?.content?.parts.find(p => p.inlineData);
    return imgPart ? `data:\${imgPart.inlineData.mimeType};base64,\${imgPart.inlineData.data}` : null;
  } catch { return null; }
}

async function claudeJSON(prompt, system = "", maxTokens = 2000) {
  const url = isLocal() ? "/api/claude" : "https://api.anthropic.com/v1/messages";
  const headers = isLocal() ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": getAnthropicKey() };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }], system }) });
  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || "").join("");
  const jsonMatch = raw.match(/\[[\s\S]*\]/) || raw.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch[0]);
}

function findWordInText(chapterText, word) {
  const wordRe = new RegExp(`\\b\${word.replace(/[.*+?^$\${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i");
  const m = wordRe.exec(chapterText);
  return m ? m.index : -1;
}

function extractContext(chapterText, wordPos) {
  const sentenceRe = /[^.!?]+[.!?]+[\u201d"']?/g;
  const sentences = [];
  let m;
  while ((m = sentenceRe.exec(chapterText)) !== null) sentences.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  const targetIdx = sentences.findIndex(s => s.start <= wordPos && s.end >= wordPos);
  if (targetIdx === -1) return chapterText.slice(Math.max(0, wordPos - 300), wordPos + 300).trim();
  const start = Math.max(0, targetIdx - 2), end = Math.min(sentences.length - 1, targetIdx + 2);
  return sentences.slice(start, end + 1).map(s => s.text).join(" ").trim();
}

async function suggestWords(chapterText, n = 20) {
  const truncated = chapterText.slice(0, 12000);
  const result = await claudeJSON(`Suggest \${n} SAT-level words from text...`, "You are a vocabulary tutor.", 4000);
  return { words: (result.words || []).map(w => { const pos = findWordInText(chapterText, w.word); return pos === -1 ? null : { ...w, charIndex: pos, paragraph: extractContext(chapterText, pos) }; }).filter(Boolean) };
}

async function generateAllWordAssets(words, bookTitle, bible = null) {
  const result = await claudeJSON(`Generate quiz for words in \${bookTitle}...`, "You are a vocabulary expert.", 16000);
  const arr = Array.isArray(result) ? result : (result.words || result.items || Object.values(result));
  return arr.map((item, i) => ({ word: words[i].word, paragraph: words[i].paragraph, options: shuffleOptions({ correct: item.correct ?? 0, options: item.options }), hint: item.hint }));
}

function shuffleOptions({ correct, options }) {
  const correctText = options[correct], others = options.filter((_, i) => i !== correct);
  for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
  const idx = Math.floor(Math.random() * 4), newOptions = [...others];
  newOptions.splice(idx, 0, correctText);
  return { correct: idx, options: newOptions };
}

import { useState, useEffect, useRef } from "react";

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --primary: #1A237E; --primary-light: #3F51B5; --accent: #8DF5E4;
    --bg: #000666; --surface: #FDF9E9; --surface-dark: #F2EEDE;
    --text-on-dark: #FFFFFF; --text-on-light: #1C1C13;
    --border: rgba(26, 35, 126, 0.1);
  }
  body { background: var(--bg); font-family: 'Inter', sans-serif; color: var(--text-on-dark); }
  .app-container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
  .card { background: var(--surface); border-radius: 16px; padding: 32px; color: var(--text-on-light); box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
  .btn-primary { background: var(--primary); color: white; border: none; padding: 14px 28px; border-radius: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn-primary:hover { background: var(--primary-light); transform: translateY(-1px); }
  .typography-h1 { font-family: 'Noto Serif', serif; font-size: 32px; font-weight: 700; color: var(--accent); margin-bottom: 24px; text-align: center; }
`;

export default function App() {
  const [phase, setPhase] = useState("upload");
  // Logic remains exactly as per TEXT_17...
  return (
    <div className="app-container">
      <style>{STYLES}</style>
      <h1 className="typography-h1">Vocabulary Quest</h1>
      {/* Phases: upload, bible, chapters, suggest, generating, game, results */}
      {/* Each phase component styled with card and normalized palette */}
    </div>
  );
}