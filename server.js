/**
 * Vocabulary Quest — API Server
 *
 * Proxies Claude API calls to api.anthropic.com using the OAuth access token
 * stored in .env as ANTHROPIC_ACCESS_TOKEN.
 *
 * Run alongside Vite: npm run dev
 * Or standalone:      npm run server
 */

import express from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

const ANTHROPIC_TOKEN = process.env.ANTHROPIC_ACCESS_TOKEN;
if (!ANTHROPIC_TOKEN) {
  console.error('ERROR: ANTHROPIC_ACCESS_TOKEN is not set in .env');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── /api/claude — drop-in replacement for api.anthropic.com/v1/messages ───────
app.post('/api/claude', async (req, res) => {
  const { messages, system, max_tokens = 4000, model = 'claude-sonnet-4-20250514' } = req.body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANTHROPIC_TOKEN}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || { message: 'Anthropic API error' } });
    }

    res.json(data);

  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: { message: err.message || 'Server error' } });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Vocab Quest API server running on http://localhost:${PORT}`);
  console.log('Using Claude credentials from: .env (ANTHROPIC_ACCESS_TOKEN)');
});
