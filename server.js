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
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHmac } from 'crypto';
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
        return res.status(500).json({ error: { message: message.result || 'Agent error' } });
      }
    }
    if (!fullText) return res.status(500).json({ error: { message: 'Empty response from agent' } });
    res.json({ content: [{ type: 'text', text: fullText }], stop_reason: 'end_turn' });
  } catch (err) {
    console.error('Claude API error:', err);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message || 'Server error' } });
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
