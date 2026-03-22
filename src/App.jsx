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

// ── EPUB/TXT Parsers ──────────────────────────────────────────────────────────
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
  return chapterTexts.map((ch, i) => ({ index: i, title: `Section ${i + 1}`, text: ch.text, href: ch.href }));
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

// ── Components ────────────────────────────────────────────────────────────────
function Highlighted({ passage, word }) {
  const re = new RegExp(`(${word})`, "i");
  const parts = passage.split(re);
  return <>{parts.map((p, i) => re.test(p) ? <mark key={i}>{p}</mark> : p)}</>;
}

export default function App() {
  const [phase, setPhase] = useState("upload");
  const [chapters, setChapters] = useState([]);
  const [bookTitle, setBookTitle] = useState("");
  const [currentChapter, setCurrentChapter] = useState(null);

  async function handleFileUpload(file) {
    const chapters = file.name.endsWith(".epub") ? await parseEpub(file) : await parseTxt(file);
    setChapters(chapters);
    setBookTitle(file.name.replace(/\.[^.]+$/, ""));
    setPhase("chapters");
  }

  return (
    <div className="app-container">
      <header className="minimal-header">
        <h1>Vocabulary Quest</h1>
      </header>

      {phase === "upload" && (
        <div className="card">
          <div className="card-body" style={{textAlign:'center', padding: '100px 40px'}}>
             <span className="section-label">Book Upload</span>
             <h2 style={{fontFamily: "'Playfair Display'", fontSize: '28px', marginBottom: '32px'}}>Begin your scholarly journey.</h2>
             <input type="file" onChange={e => handleFileUpload(e.target.files[0])} style={{display:'none'}} id="file-up"/>
             <label htmlFor="file-up" className="primary-btn">Choose an EPUB or TXT file</label>
          </div>
        </div>
      )}

      {phase === "chapters" && (
        <div>
          <span className="section-label">Chapters — {bookTitle}</span>
          <div className="chapter-grid">
            {chapters.map(ch => (
              <button key={ch.index} className="chapter-item" onClick={() => { setCurrentChapter(ch); setPhase("game"); }}>
                <h3>{ch.title}</h3>
                <p style={{color: 'var(--ink-dim)', margin: 0}}>{Math.round(ch.text.split(' ').length)} words</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "game" && (
        <div className="game-layout">
          <div>
            <div className="illustration" style={{background: '#e5e1d5'}}></div>
            <div style={{marginTop: '32px'}}>
              <h2 className="vocab-word">Languidly</h2>
              <p className="passage">
                "Sara sat in the corner of the attic room, watching the rain trace slow rivers down the windowpane. She moved <mark>languidly</mark> through the motions of tidying her possessions."
              </p>
            </div>
          </div>
          <div className="card">
            <div className="card-body">
              <span className="section-label">Definition Quiz</span>
              <h3 style={{fontFamily: "'Playfair Display'", fontSize: '24px', marginBottom: '24px'}}>What does "languidly" mean?</h3>
              <div className="options-stack">
                <button className="option-btn">Quickly and with great energy</button>
                <button className="option-btn correct">Slowly, dreamsily, and without effort</button>
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
