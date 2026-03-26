/**
 * Vocabulary Quest — API Server
 *
 * Claude calls: proxied through @anthropic-ai/claude-agent-sdk, which uses
 *   credentials from `claude login` (~/.claude/.credentials.json).
 * Gemini calls: proxied using GEMINI_API_KEY from .env.
 * Auth: cookie-based password gate, active only when AUTH_PASSWORD is set.
 *
 * Run alongside Vite: npm run dev
 * Or standalone:      npm run server
 */

import express from 'express';
import helmet from 'helmet';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { unlink } from 'fs/promises';
import { createHmac, createHash } from 'crypto';
import { spawn } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ── Load .env manually (no dotenv dependency needed) ─────────────────────────
try {
  const envPath = resolve(process.cwd(), '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {}

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set in .env — image generation will be unavailable');
}

const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
// Stateless session token derived from the password — no session store needed
const AUTH_TOKEN = AUTH_PASSWORD
  ? createHmac('sha256', AUTH_PASSWORD).update('vocab-quest').digest('hex')
  : null;

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  }
  return cookies;
}

function isAuthenticated(req) {
  if (!AUTH_TOKEN) return true; // auth disabled in dev
  return parseCookies(req)['vq_session'] === AUTH_TOKEN;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  // API routes get 401; page routes get redirected to login
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'Unauthorized' } });
  res.redirect('/login');
}

const app = express();
// Security headers (X-Frame-Options, HSTS, nosniff, etc.). CSP is disabled
// because the app uses inline styles, CDN scripts (JSZip), Google Fonts, and
// base64 data-URI images — all of which conflict with a strict CSP. The other
// headers still provide meaningful protection (clickjacking, MIME sniffing,
// HTTPS enforcement). CSP can be enabled later when CSS is extracted to a file
// and JSZip is bundled.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Login page & logout (exempt from auth) ────────────────────────────────────
app.get('/login', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0e0e0e;
      font-family: system-ui, sans-serif;
      color: #d4b04a;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 14px;
      width: 300px;
      padding: 32px;
      border: 1px solid rgba(180,130,50,0.25);
      border-radius: 6px;
      background: rgba(255,255,255,0.03);
    }
    h1 { font-size: 18px; letter-spacing: 0.1em; text-align: center; }
    input {
      padding: 10px 12px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(180,130,50,0.3);
      border-radius: 4px;
      color: #e8d5a0;
      font-size: 15px;
      outline: none;
    }
    input:focus { border-color: rgba(180,130,50,0.7); }
    button {
      padding: 10px;
      background: rgba(180,130,50,0.15);
      border: 1px solid rgba(180,130,50,0.4);
      border-radius: 4px;
      color: #d4b04a;
      font-size: 15px;
      cursor: pointer;
      letter-spacing: 0.05em;
    }
    button:hover { background: rgba(180,130,50,0.25); }
    .error { color: #e07070; font-size: 13px; text-align: center; }
  </style>
</head>
<body>
  <form method="POST" action="/api/login">
    <h1>Vocab Quest</h1>
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
    ${res.locals.error ? `<p class="error">${res.locals.error}</p>` : ''}
  </form>
</body>
</html>`);
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const token = AUTH_TOKEN
    ? createHmac('sha256', password || '').update('vocab-quest').digest('hex')
    : null;

  if (!AUTH_TOKEN || token === AUTH_TOKEN) {
    res.setHeader('Set-Cookie',
      `vq_session=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`
    );
    return res.redirect('/');
  }

  res.locals.error = 'Incorrect password';
  res.status(401);
  app.handle({ ...req, method: 'GET', url: '/login' }, res);
});

app.get('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'vq_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

// ── All routes below require auth ─────────────────────────────────────────────
app.use(requireAuth);

// ── /api/claude — proxied via Agent SDK (uses claude login credentials) ───────
app.post('/api/claude', async (req, res) => {
  const { messages, system, max_tokens = 4000 } = req.body;

  const userMessage = messages?.findLast(m => m.role === 'user')?.content || '';
  const prompt = typeof userMessage === 'string'
    ? userMessage
    : userMessage.map(b => b.text || '').join('');

  if (!prompt) return res.status(400).json({ error: { message: 'No user message found' } });

  try {
    let fullText = '';
    for await (const message of query({
      prompt,
      options: {
        ...(system ? { appendSystemPrompt: system } : {}),
        allowedTools: [],
        permissionMode: 'dontAsk',
        // Railway has no `claude` binary in PATH, so we must spawn Claude using
        // the same Node executable that's running this server.
        spawnClaudeCodeProcess: ({ args, cwd, env, signal }) => {
          return spawn(process.execPath, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        },
      },
    })) {
      if (message.type === 'assistant') {
        const textBlocks = message.message?.content?.filter(b => b.type === 'text') || [];
        fullText += textBlocks.map(b => b.text).join('');
      }
      if (message.type === 'result' && message.is_error) {
        const errMsg = message.result || 'Agent error';
        // Classify errors so the client gets an actionable error code + message
        // instead of a generic 500. Auth errors are common when the OAuth token
        // expires in headless environments like Railway.
        const isAuthError = /unauthorized|401|auth|token.*invalid|token.*expired|credential/i.test(errMsg);
        const code = isAuthError ? 'OAUTH_TOKEN_INVALID' : 'AGENT_ERROR';
        const hint = isAuthError
          ? 'The Claude OAuth token is invalid or expired. Refresh CLAUDE_CODE_OAUTH_TOKEN in your environment variables and redeploy.'
          : errMsg;
        console.error(`Claude agent error [${code}]:`, errMsg);
        return res.status(isAuthError ? 502 : 500).json({ error: { code, message: hint } });
      }
    }
    if (!fullText) return res.status(500).json({ error: { code: 'EMPTY_RESPONSE', message: 'Empty response from agent' } });
    res.json({ content: [{ type: 'text', text: fullText }], stop_reason: 'end_turn' });
  } catch (err) {
    // Catch-all: classify the exception so the client console shows a specific
    // error code rather than an opaque "Server error". This is especially
    // useful when Railway returns a 503 because the agent process crashed
    // before our code could send a JSON response.
    const errMsg = err.message || 'Server error';
    const isAuthError = /unauthorized|401|auth|token.*invalid|token.*expired|credential/i.test(errMsg);
    const isSpawnError = /spawn|ENOENT|EACCES|MODULE_NOT_FOUND/i.test(errMsg);
    let code, hint, status;
    if (isAuthError) {
      code = 'OAUTH_TOKEN_INVALID';
      hint = 'The Claude OAuth token is invalid or expired. Refresh CLAUDE_CODE_OAUTH_TOKEN in your environment variables and redeploy.';
      status = 502;
    } else if (isSpawnError) {
      code = 'AGENT_SPAWN_FAILED';
      hint = `Failed to start the Claude agent process: ${errMsg}`;
      status = 500;
    } else {
      code = 'CLAUDE_API_ERROR';
      hint = errMsg;
      status = 500;
    }
    console.error(`Claude API error [${code}]:`, err);
    if (!res.headersSent) res.status(status).json({ error: { code, message: hint } });
  }
});

// ── /api/gemini — proxy to Google Generative Language API ────────────────────
app.post('/api/gemini/:model', async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: { message: 'Gemini API key not configured' } });

  const { model } = req.params;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error(`Gemini API error: HTTP ${response.status} for model ${model}:`, JSON.stringify(data));
    }
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Gemini API network error:', err);
    res.status(500).json({ error: { message: err.message || 'Server error' } });
  }
});

// ── /api/kv/:key — generic key-value store backed by data/ directory ─────────
//
// All app data (books, progress, illustrations, story bibles, word caches) was
// originally stored in the browser via localStorage. This meant data was lost
// when switching browsers or clearing storage, and couldn't survive Railway
// redeploys. Rather than building dedicated endpoints per resource type, we
// added a generic KV store — the client already had a storageGet/storageSet
// abstraction with a window.storage pluggable backend, so wiring that to these
// endpoints moved everything server-side with minimal client changes.
//
// Each key becomes a JSON file in DATA_DIR. Writes use atomic rename (write to
// .tmp, then fs.rename) so a crash mid-write can't corrupt a file. Keys are
// sanitized to prevent path traversal.
//
// In Codespaces, ./data/ persists inside /workspaces/ across stops/starts.
// On Railway, DATA_DIR should point to a mounted volume (e.g. /data).
const DATA_DIR = resolve(process.cwd(), process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

app.get('/api/kv/:key', (req, res) => {
  // Prevent browser from caching KV responses — the value can change between
  // requests (e.g., a GET returning null, then a PUT writes data, then another
  // GET should return the new data, not a cached null).
  res.set('Cache-Control', 'no-store');
  const file = join(DATA_DIR, `${sanitizeKey(req.params.key)}.json`);
  if (!existsSync(file)) return res.json(null);
  try {
    const raw = readFileSync(file, 'utf8');
    res.json({ value: raw });
  } catch (err) {
    console.error('KV read error:', err);
    res.status(500).json({ error: { message: 'Read failed' } });
  }
});

app.put('/api/kv/:key', (req, res) => {
  const key = sanitizeKey(req.params.key);
  const file = join(DATA_DIR, `${key}.json`);
  const tmp = join(DATA_DIR, `${key}.tmp`);
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: { message: 'Missing "value" in body' } });
  try {
    writeFileSync(tmp, value, 'utf8');
    renameSync(tmp, file);
    res.json({ ok: true });
  } catch (err) {
    console.error('KV write error:', err);
    res.status(500).json({ error: { message: 'Write failed' } });
  }
});

app.delete('/api/kv/:key', async (req, res) => {
  const file = join(DATA_DIR, `${sanitizeKey(req.params.key)}.json`);
  try {
    await unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('KV delete error:', err);
      return res.status(500).json({ error: { message: 'Delete failed' } });
    }
  }
  res.json({ ok: true });
});

// ── DELETE /api/books/:hash — remove a book and all associated data ─────────
//
// Previously, book deletion was orchestrated client-side: the browser loaded
// the book data, computed chapter hashes, then issued dozens of sequential
// DELETE /api/kv/:key calls — one per word list, illustration, story bible,
// etc. Each call was a full HTTP round trip, so a book with 10 chapters and
// cached illustrations took ~20 seconds to delete.
//
// This endpoint moves that logic server-side. The server reads the book data
// from the local filesystem (no network hop), computes chapter hashes with
// Node's crypto (no async overhead), collects every related file path, and
// deletes them all in parallel with Promise.all. The whole operation completes
// in a single HTTP round trip (~100ms).
//
// Deleted data: vocab-book-{hash}, storybible-{hash}, wordlist-{chapterHash},
// illust-index-{chapterHash}, illust-{chapterHash}-{word}, and the index entry.
app.delete('/api/books/:hash', async (req, res) => {
  const bookHash = sanitizeKey(req.params.hash);
  const bookFile = join(DATA_DIR, `vocab-book-${bookHash}.json`);

  // Collect all files to delete — start with book-level files
  const toDelete = [
    bookFile,
    join(DATA_DIR, `storybible-${bookHash}.json`),
  ];

  // Read the book data to discover chapter-level keys. The chapter hash is
  // derived from each chapter's text using the same SHA-256 algorithm as the
  // client (first 32 hex chars), so we find the exact same file names.
  try {
    if (existsSync(bookFile)) {
      const raw = readFileSync(bookFile, 'utf8');
      const bookData = JSON.parse(raw);
      for (const ch of bookData.chapters || []) {
        const chapterHash = createHash('sha256').update(ch.text).digest('hex').slice(0, 32);
        toDelete.push(join(DATA_DIR, `wordlist-${chapterHash}.json`));

        // The illustration index lists which words have cached images.
        // We need to read it to discover per-word illustration file names.
        const illustIndexFile = join(DATA_DIR, `illust-index-${chapterHash}.json`);
        try {
          if (existsSync(illustIndexFile)) {
            const words = JSON.parse(readFileSync(illustIndexFile, 'utf8'));
            for (const w of words) {
              toDelete.push(join(DATA_DIR, `illust-${chapterHash}-${sanitizeKey(w)}.json`));
            }
          }
        } catch {}
        toDelete.push(illustIndexFile);
      }
    }
  } catch (err) {
    console.error('Error reading book data for cleanup:', err);
    // Best-effort: continue deleting whatever files we already found
  }

  // Delete all files in parallel — each unlink is independent, and failures
  // (e.g. file already gone) are silently ignored.
  await Promise.all(toDelete.map(f => unlink(f).catch(() => {})));

  // Update the book index atomically (write .tmp then rename)
  const indexFile = join(DATA_DIR, `${sanitizeKey(BOOK_INDEX_KEY)}.json`);
  try {
    if (existsSync(indexFile)) {
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      const updated = index.filter(b => b.hash !== req.params.hash);
      const tmp = join(DATA_DIR, `${sanitizeKey(BOOK_INDEX_KEY)}.tmp`);
      writeFileSync(tmp, JSON.stringify(updated), 'utf8');
      renameSync(tmp, indexFile);
    }
  } catch (err) {
    console.error('Error updating book index:', err);
    return res.status(500).json({ error: { message: 'Failed to update book index' } });
  }

  res.json({ ok: true });
});

const BOOK_INDEX_KEY = 'vocab-books-index';

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Gemini availability check
app.get('/api/gemini-available', (_req, res) => {
  res.json({ available: !!GEMINI_KEY });
});

// ── Serve static frontend in production ───────────────────────────────────────
const distPath = resolve(process.cwd(), 'dist');
if (existsSync(distPath)) {
  const { default: serveStatic } = await import('serve-static');
  app.use(serveStatic(distPath));
  app.get('*', (_req, res) => res.sendFile(resolve(distPath, 'index.html')));
}

const PORT = process.env.PORT || 3001; // Railway injects PORT at runtime
app.listen(PORT, () => {
  console.log(`Vocab Quest API server running on http://localhost:${PORT}`);
  console.log(`Auth: ${AUTH_PASSWORD ? 'enabled' : 'disabled (set AUTH_PASSWORD to enable)'}`);
  console.log(`Claude: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'using CLAUDE_CODE_OAUTH_TOKEN env var' : 'using ~/.claude/.credentials.json'}`);
  console.log(`Gemini: ${GEMINI_KEY ? 'configured' : 'NOT configured'}`);
});
