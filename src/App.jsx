import { useState, useEffect, useRef } from "react";
import { recordSession, exportData } from "./wordRecords.js";

// ── API key helpers ───────────────────────────────────────────────────────────
function getAnthropicKey() {
  try { const k = import.meta.env?.VITE_ANTHROPIC_API_KEY; if (k) return k; } catch {}
  return window.ANTHROPIC_API_KEY || "";
}

function getGeminiKey() {
  try { const k = import.meta.env?.VITE_GEMINI_API_KEY; if (k) return k; } catch {}
  return null;
}

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

  const chapters = chapterTexts.map((ch, i) => {
    const tocMatch = tocEntries.find(t => ch.href.endsWith(t.href) || ch.href.includes(t.href));
    return {
      index: i,
      title: tocMatch?.title || `Chapter ${i + 1}`,
      text: ch.text,
      href: ch.href,
    };
  });

  return chapters;
}

async function parseTxt(file) {
  const text = await file.text();
  const chapterRegex = /\n(chapter\s+[\divxlc]+[^\n]*)\n/gi;
  const parts = text.split(chapterRegex);
  if (parts.length < 3) {
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

// ── SHA-256 hash ───────────────────────────────────────────────────────────
async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text.slice(0, 500000));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ── Story Bible ────────────────────────────────────────────────────────────
async function claudeJSON(prompt, system = "", maxTokens = 2000) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;
  const url = isLocal() ? "/api/claude" : "https://api.anthropic.com/v1/messages";
  const headers = isLocal() ? { "Content-Type": "application/json" } : {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-api-key": getAnthropicKey(),
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || "").join("");
  const objMatch = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(objMatch[0]);
}

// ── Word Suggestions ───────────────────────────────────────────────────────
async function suggestWords(chapterText, n = 20) {
  const result = await claudeJSON(
    `Analyze this text and identify up to ${n} vocabulary words for age 10-14. Return only JSON: {"words":[{"word":"languidly","charIndex":1240,"reason":"..."}]}. \n\n ${chapterText.slice(0, 8000)}`,
    "You are a vocabulary tutor. Respond with valid JSON only."
  );
  return result;
}

// ── Direct Gemini image generation ───────────────────────────────────────────
async function generateGeminiImageDirect(prompt, modelId = "gemini-2.5-flash-image") {
  const apiKey = getGeminiKey();
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["Image"] },
        }),
      }
    );
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData);
    return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
  } catch (e) { return null; }
}

// ── Components ────────────────────────────────────────────────────────────────
function Highlighted({ passage, word }) {
  const re = new RegExp(`(${word})`, "i");
  const parts = passage.split(re);
  return <>{parts.map((p, i) => re.test(p) ? <mark key={i}>{p}</mark> : p)}</>;
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState("upload");
  const [chapters, setChapters] = useState([]);
  const [bookTitle, setBookTitle] = useState("");
  const [currentChapter, setCurrentChapter] = useState(null);
  const [suggestedWords, setSuggestedWords] = useState([]);
  const [selectedWords, setSelectedWords] = useState([]);
  const [gameAssets, setGameAssets] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [scores, setScores] = useState({});

  async function handleFileUpload(file) {
    if (!file) return;
    const chapters = file.name.endsWith(".epub") ? await parseEpub(file) : await parseTxt(file);
    setChapters(chapters);
    setBookTitle(file.name.replace(/\.[^.]+$/, ""));
    setPhase("chapters");
  }

  async function handleChapterSelect(ch) {
    setCurrentChapter(ch);
    setPhase("bible");
    const result = await suggestWords(ch.text);
    setSuggestedWords(result.words);
    setSelectedWords(result.words.slice(0, 5).map(w => w.word));
    setPhase("selection");
  }

  return (
    <div className="app-container">
      {phase === "upload" && (
        <div className="upload-modal-container">
          <div className="upload-modal">
            <span className="section-label">Book Upload</span>
            <div className="upload-dropzone" onClick={() => document.getElementById('file-up').click()}>
              <div className="upload-icon">📄</div>
              <p>Drop your EPUB/TXT file here</p>
            </div>
            <input id="file-up" type="file" accept=".epub,.txt" onChange={e => handleFileUpload(e.target.files[0])} style={{display:'none'}} />
            <button className="primary-btn" onClick={() => document.getElementById('file-up').click()}>Choose an EPUB or TXT file</button>
          </div>
        </div>
      )}

      {phase === "chapters" && (
        <div className="chapter-select-view">
          <span className="section-label">Chapters — {bookTitle}</span>
          <div className="chapter-grid">
            {chapters.map(ch => (
              <button key={ch.index} className="chapter-item" onClick={() => handleChapterSelect(ch)}>
                <h3>{ch.title}</h3>
                <p>{Math.round(ch.text.split(' ').length).toLocaleString()} words</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "selection" && (
        <div className="selection-view">
           <span className="section-label">Word Selection — {currentChapter?.title}</span>
           <div className="word-grid">
              {suggestedWords.map(w => (
                <div key={w.word} className={`word-card ${selectedWords.includes(w.word) ? 'selected' : ''}`} onClick={() => setSelectedWords(prev => prev.includes(w.word) ? prev.filter(x => x !== w.word) : [...prev, w.word])}>
                   <h4>{w.word}</h4>
                   <p>{w.reason}</p>
                </div>
              ))}
           </div>
           <button className="primary-btn start-btn" onClick={() => setPhase("game")}>Start Game ({selectedWords.length})</button>
        </div>
      )}

      {phase === "game" && (
        <div className="game-layout">
          <div className="illustration-column">
             <div className="illustration" style={{background: '#e5e1d5'}}></div>
             <div className="passage-context">
                <h2 className="vocab-word">Languidly</h2>
                <p className="passage">"Sara sat in the corner... She moved <mark>languidly</mark> through the motions of tidying her possessions."</p>
             </div>
          </div>
          <div className="quiz-column card">
            <div className="card-body">
              <span className="section-label">Definition Quiz</span>
              <h3 className="quiz-question">What does "languidly" mean?</h3>
              <div className="options-stack">
                <button className="option-btn">Quickly and with great energy</button>
                <button className="option-btn">Slowly, dreamsily, and without effort</button>
                <button className="option-btn">In a very messy or careless way</button>
                <button className="option-btn">Loudly and with heavy footsteps</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
