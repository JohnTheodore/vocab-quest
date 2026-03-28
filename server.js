/**
 * Vocabulary Quest — API Server
 *
 * Multi-user authentication:
 *   When data/users.json exists, each user logs in with a username + password.
 *   Sessions are HMAC-signed cookies (userId:timestamp:hmac). All KV data is
 *   namespaced per user (u_{userId}_{key}) for full isolation — each user has
 *   their own books, illustrations, vocabulary progress, and review history.
 *
 *   When data/users.json does NOT exist (legacy mode), the app falls back to
 *   single-password auth via AUTH_PASSWORD env var, with no KV namespacing.
 *   This preserves backwards compatibility for existing deployments.
 *
 * Claude calls: proxied through @anthropic-ai/claude-agent-sdk, which uses
 *   credentials from `claude login` (~/.claude/.credentials.json).
 * Gemini calls: proxied using GEMINI_API_KEY from .env.
 *
 * Run alongside Vite: npm run dev
 * Or standalone:      npm run server
 */

import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, constants, readdirSync, copyFileSync, unlinkSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { unlink, access } from 'fs/promises';
import { spawn } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import rateLimit from 'express-rate-limit';

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

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const EMAIL_FROM = process.env.EMAIL_FROM || 'Vocab Quest <onboarding@resend.dev>';
const RESET_TOKEN_MAX_AGE = 60 * 60; // 1 hour in seconds

// ── Data directory ───────────────────────────────────────────────────────────
// In Codespaces, ./data/ persists inside /workspaces/ across stops/starts.
// On Railway, DATA_DIR should point to a mounted volume (e.g. /data).
const DATA_DIR = resolve(process.cwd(), process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = join(DATA_DIR, 'users.json');
const BOOK_INDEX_KEY = 'vocab-books-index';

// ── Legacy single-password auth (used when users.json does not exist) ────────
// When AUTH_PASSWORD is set and no users.json exists, the app uses the original
// single-password gate. This is "legacy mode" — preserved for backwards compat.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const LEGACY_AUTH_TOKEN = AUTH_PASSWORD
  ? crypto.createHmac('sha256', AUTH_PASSWORD).update('vocab-quest').digest('hex')
  : null;

// ── Session secret ───────────────────────────────────────────────────────────
// Used to HMAC-sign multi-user session cookies. Resolution order:
//   1. SESSION_SECRET env var (explicit, highest priority)
//   2. AUTH_PASSWORD env var (backwards compat with existing deployments)
//   3. data/.session-secret — auto-generated random secret, persisted to disk
//      so it survives Railway redeploys and Codespace restarts without any
//      env var configuration. Sessions remain valid across server restarts.
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (AUTH_PASSWORD) return AUTH_PASSWORD;
  const secretFile = join(DATA_DIR, '.session-secret');
  try {
    return readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(64).toString('hex');
    writeFileSync(secretFile, secret, 'utf8');
    return secret;
  }
}
const SESSION_SECRET = getSessionSecret();

// ── User management helpers ──────────────────────────────────────────────────
// Users are stored as a JSON object in data/users.json, mapping userId to
// profile. The file is read on every auth check (cheap for <100 users) to
// ensure changes (new accounts, deletions) take effect immediately without
// a server restart.

/**
 * Load all users from disk. Returns null if users.json doesn't exist (legacy mode).
 * Returns the parsed {userId: profile} object otherwise.
 */
function loadUsers() {
  if (!existsSync(USERS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read users.json:', err);
    return null;
  }
}

/**
 * Atomically write the users object to disk. Uses the same .tmp + rename
 * pattern as the KV store to prevent corruption if the server crashes mid-write.
 */
function saveUsers(users) {
  const tmp = join(DATA_DIR, 'users.tmp');
  writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  renameSync(tmp, USERS_FILE);
}

/**
 * Generate a random 16-byte salt for password hashing.
 */
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Hash a password using scrypt (memory-hard KDF). Resistant to GPU/ASIC
 * brute-force attacks, unlike plain SHA-256. A random per-user salt ensures
 * no two users produce the same hash even with identical passwords.
 * Node's built-in crypto.scryptSync requires no new dependencies.
 */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// ── Session token helpers ────────────────────────────────────────────────────
// Multi-user sessions use a structured cookie: "userId:timestamp:hmac"
// where hmac = HMAC-SHA256(SESSION_SECRET, "userId:timestamp"). The token
// is HttpOnly, SameSite=Strict, Secure in production, and expires after 30d.
// The timestamp is embedded so we can add server-side expiry in the future.

/** Max session age in seconds (30 days). */
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Create a signed session token for the given userId.
 * Format: "userId:timestamp:passwordVersion:hmac" — the HMAC covers all
 * fields so none can be tampered with. passwordVersion enables automatic
 * invalidation when a user changes their password.
 */
function createSessionToken(userId, passwordVersion) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${userId}:${timestamp}:${passwordVersion}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

/**
 * Verify a session token and return { userId, passwordVersion } if valid,
 * or null if invalid/expired. Splits the token into its 4 parts, recomputes
 * the HMAC, compares using timingSafeEqual, and checks timestamp expiry.
 */
function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 4) return null;
  const [userId, timestamp, passwordVersion, hmac] = parts;
  if (!userId || !timestamp || !passwordVersion || !hmac) return null;

  // Recompute the expected HMAC and compare timing-safely
  const payload = `${userId}:${timestamp}:${passwordVersion}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Enforce server-side expiry (Fix #2)
  const now = Math.floor(Date.now() / 1000);
  if (now - parseInt(timestamp, 10) > SESSION_MAX_AGE) return null;

  return { userId, passwordVersion: parseInt(passwordVersion, 10) };
}

/**
 * Build the Set-Cookie header value for a session cookie.
 * Secure flag is set in production (when PORT env var is injected by Railway).
 * HttpOnly prevents JS access. SameSite=Strict prevents CSRF.
 */
function sessionCookie(token) {
  const secure = process.env.PORT ? '; Secure' : '';
  return `vq_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${SESSION_MAX_AGE}`;
}

// ── Cookie parser ────────────────────────────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  }
  return cookies;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
// Supports two modes:
//   1. Multi-user mode (users.json exists): parse the structured session token,
//      verify the HMAC, look up the user, and set req.user.
//   2. Legacy mode (no users.json): compare the cookie against the single
//      LEGACY_AUTH_TOKEN derived from AUTH_PASSWORD. Sets req.user = null.
//
// If auth is disabled entirely (no users.json AND no AUTH_PASSWORD), all
// requests pass through with req.user = null. This is for local dev only.
function requireAuth(req, res, next) {
  const users = loadUsers();
  const token = parseCookies(req)['vq_session'] || '';

  if (users) {
    // ── Multi-user mode ──────────────────────────────────────────────────
    const session = verifySessionToken(token);
    if (!session || !users[session.userId]) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'Unauthorized' } });
      return res.redirect('/login');
    }
    const u = users[session.userId];
    // Reject sessions from before a password change
    if ((u.passwordVersion || 1) !== session.passwordVersion) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'Session expired — please log in again' } });
      return res.redirect('/login');
    }
    req.user = { id: session.userId, displayName: u.displayName, role: u.role };
    return next();
  }

  // ── Legacy mode (single password) ────────────────────────────────────────
  if (!LEGACY_AUTH_TOKEN) {
    // No auth configured at all — redirect to setup so the admin can create an account
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'No users configured. Visit /setup to create an admin account.' } });
    return res.redirect('/setup');
  }
  // Compare the cookie against the legacy single-password token using
  // timingSafeEqual to prevent timing attacks.
  const a = Buffer.from(token);
  const b = Buffer.from(LEGACY_AUTH_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    req.user = null; // Legacy mode — no user identity
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'Unauthorized' } });
  res.redirect('/login');
}

// ── KV key namespacing ───────────────────────────────────────────────────────
// In multi-user mode, every KV key is prefixed with "u_{userId}_" so each
// user's data is fully isolated. In legacy mode (req.user === null), keys
// are used as-is — no prefix. This means the frontend is completely unaware
// of namespacing; it requests "vocab-quest-data" and the server silently
// maps it to "u_emma_vocab-quest-data" based on the session.

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(str) {
  return EMAIL_RE.test(str);
}

/**
 * Resolve a KV key to its namespaced filename (without .json extension).
 * In multi-user mode: prefixes with "u_{userId}_".
 * In legacy mode: returns the key unchanged.
 */
function resolveKey(req, key) {
  const sanitized = sanitizeKey(key);
  if (!req.user) return sanitized; // Legacy mode — no prefix
  return `u_${sanitizeKey(req.user.id)}_${sanitized}`;
}

// ── Shared login page styles ─────────────────────────────────────────────────
// Used by both /login and /setup pages to maintain a consistent look.
const LOGIN_STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8f5ef;
      background-image: radial-gradient(ellipse at 15% 10%, rgba(180,140,80,0.05) 0%, transparent 55%),
                        radial-gradient(ellipse at 85% 90%, rgba(140,100,40,0.04) 0%, transparent 55%);
      font-family: 'Source Serif 4', Georgia, serif;
      color: #2c2218;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 14px;
      width: 300px;
      padding: 32px;
      border: 1px solid rgba(100,70,20,0.12);
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 2px 12px rgba(100,70,20,0.06);
    }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: 0.02em; text-align: center; color: #6b5218; }
    p.subtitle { font-size: 13px; text-align: center; color: #8a6d2e; opacity: 0.7; margin-top: -4px; }
    input {
      padding: 10px 12px;
      background: #f8f5ef;
      border: 1px solid rgba(100,70,20,0.18);
      border-radius: 4px;
      color: #2c2218;
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 15px;
      outline: none;
    }
    input::placeholder { color: #8a6d2e; opacity: 0.5; }
    input:focus { border-color: rgba(100,70,20,0.4); box-shadow: 0 0 0 2px rgba(100,70,20,0.06); }
    button {
      padding: 10px;
      background: rgba(100,70,20,0.08);
      border: 1px solid rgba(100,70,20,0.18);
      border-radius: 4px;
      color: #6b5218;
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.02em;
    }
    button:hover { background: rgba(100,70,20,0.14); }
    .error { color: #b83030; font-size: 13px; text-align: center; }
    .success { color: #2e7d32; font-size: 13px; text-align: center; }
    .link { font-size: 13px; text-align: center; }
    .link a { color: #6b5218; opacity: 0.7; }
    .link a:hover { opacity: 1; }
`;

// Brute-force protection: 5 attempts per 15 minutes per IP.
// In-memory store resets on restart, which is acceptable for a single-process
// deploy. Applied to login and setup routes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts — try again in 15 minutes' } },
});

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

// ── First-time setup (exempt from auth) ──────────────────────────────────────
// The /setup page is shown only when users.json does not exist. It creates
// the initial admin account and migrates any existing data files to the new
// user's namespace. Once users.json exists, /setup redirects to /login.

app.get('/setup', (_req, res) => {
  // If users already exist, there's nothing to set up — go to login
  if (existsSync(USERS_FILE)) return res.redirect('/login');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Setup</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form method="POST" action="/api/setup">
    <h1>Vocab Quest</h1>
    <p class="subtitle">Create your admin account</p>
    <input type="email" name="email" placeholder="Email" required autofocus autocomplete="email">
    <input type="text" name="displayName" placeholder="Display name" required>
    <input type="password" name="password" placeholder="Password" required autocomplete="new-password">
    <button type="submit">Create Account</button>
  </form>
</body>
</html>`);
});

app.post('/api/setup', authLimiter, (req, res) => {
  // Guard: only works when no users exist yet. Once users.json is created,
  // this endpoint is permanently locked (returns 403).
  if (existsSync(USERS_FILE)) {
    return res.status(403).json({ error: { message: 'Setup already completed' } });
  }

  const { email, displayName, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'Email and password are required' } });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });
  }

  const trimmedEmail = email.trim().toLowerCase();
  if (!isValidEmail(trimmedEmail)) {
    return res.status(400).json({ error: { message: 'Invalid email address' } });
  }

  // Sanitize the email to be safe as a file prefix (same rules as KV keys)
  const userId = sanitizeKey(trimmedEmail);
  if (!userId || userId.includes(':')) {
    return res.status(400).json({ error: { message: 'Invalid email' } });
  }

  // Create the first user with admin role
  const salt = generateSalt();
  const users = {
    [userId]: {
      email: trimmedEmail,
      displayName: (displayName || trimmedEmail).trim(),
      passwordHash: hashPassword(password, salt),
      salt,
      role: 'admin',
      passwordVersion: 1,
      // Reserved for future per-user API key support (not used yet)
      anthropicApiKey: null,
      geminiApiKey: null,
      createdAt: new Date().toISOString(),
    },
  };

  // ── Migrate existing data files to the new user's namespace ──────────
  // Uses a copy-first, verify, then delete strategy to prevent data loss
  // from partial failures. See docs/multi-user-auth-design.md §10.1.
  const migrated = [];
  const skippedFiles = ['users.json', 'users.tmp', '.session-secret'];
  try {
    const files = readdirSync(DATA_DIR).filter(f =>
      f.endsWith('.json') && !skippedFiles.includes(f)
    );

    // Phase A: Copy each existing file to the user-namespaced version
    for (const file of files) {
      const src = join(DATA_DIR, file);
      const baseName = file.slice(0, -5); // strip .json
      const dest = join(DATA_DIR, `u_${userId}_${baseName}.json`);
      copyFileSync(src, dest);
      console.log(`[setup migration] Copied ${file} → u_${userId}_${baseName}.json`);
      migrated.push({ src, dest, file });
    }

    // Phase B: Verify every copied file exists and matches the source size
    for (const { src, dest, file } of migrated) {
      if (!existsSync(dest)) {
        throw new Error(`Verification failed: ${dest} does not exist after copy`);
      }
      const srcSize = statSync(src).size;
      const destSize = statSync(dest).size;
      if (srcSize !== destSize) {
        throw new Error(`Verification failed: ${file} size mismatch (${srcSize} vs ${destSize})`);
      }
    }

    // Phase C: Delete the original unprefixed files now that copies are verified
    for (const { src, file } of migrated) {
      unlinkSync(src);
      console.log(`[setup migration] Removed original ${file}`);
    }

    if (migrated.length > 0) {
      console.log(`[setup migration] Successfully migrated ${migrated.length} files to user "${userId}"`);
    }
  } catch (err) {
    // Migration failed — log the error but still create the account.
    // The copied files remain alongside originals; no data is lost.
    console.error('[setup migration] Error during migration:', err.message);
    console.error('[setup migration] Some files may need manual cleanup. Originals are intact.');
  }

  // Save the new users file (atomic write)
  saveUsers(users);

  // Log the user in immediately by setting their session cookie
  const token = createSessionToken(userId, 1);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.redirect('/');
});

// ── Login page & logout (exempt from auth) ────────────────────────────────────
// Renders differently depending on mode:
//   - Multi-user mode (users.json exists): shows username + password fields
//   - Legacy mode (no users.json): shows password-only field (original behavior)
//   - No auth at all: redirects to / (nothing to log in to)

app.get('/login', (_req, res) => {
  const users = loadUsers();

  // No users yet — redirect to first-time setup
  if (!users && !AUTH_PASSWORD) return res.redirect('/setup');

  // If multi-user is active, show the full login form with email field
  if (users) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Login</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form method="POST" action="/api/login">
    <h1>Vocab Quest</h1>
    <input type="email" name="email" placeholder="Email" autofocus autocomplete="email">
    <input type="password" name="password" placeholder="Password" autocomplete="current-password">
    <button type="submit">Enter</button>
    ${res.locals.error ? `<p class="error">${res.locals.error}</p>` : ''}
    <p class="link"><a href="/forgot-password">Forgot password?</a></p>
  </form>
</body>
</html>`);
  }

  // Legacy mode: password-only login (original behavior)
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Login</title>
  <style>${LOGIN_STYLES}</style>
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

app.post('/api/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  const users = loadUsers();

  if (users) {
    // ── Multi-user login ─────────────────────────────────────────────────
    // Look up the user by email, verify the scrypt hash, and issue a
    // signed session token. The email is sanitized to match the key
    // format in users.json (lowercase, safe characters only).
    const trimmedEmail = (email || '').trim().toLowerCase();
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
      res.locals.error = 'Incorrect email or password';
      res.status(401);
      return app.handle({ ...req, method: 'GET', url: '/login' }, res);
    }
    const userId = sanitizeKey(trimmedEmail);
    const user = users[userId];
    // Always compute hash to avoid leaking whether user exists via timing
    const computedHash = hashPassword(password || '', user?.salt || 'dummy-salt');
    const storedHash = user?.passwordHash || '';
    const a = Buffer.from(computedHash);
    const b = Buffer.from(storedHash);
    if (!user || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.locals.error = 'Incorrect email or password';
      res.status(401);
      return app.handle({ ...req, method: 'GET', url: '/login' }, res);
    }

    const token = createSessionToken(userId, user.passwordVersion || 1);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.redirect('/');
  }

  // ── Legacy login (single password) ───────────────────────────────────────
  const token = LEGACY_AUTH_TOKEN
    ? crypto.createHmac('sha256', password || '').update('vocab-quest').digest('hex')
    : null;

  if (!LEGACY_AUTH_TOKEN || token === LEGACY_AUTH_TOKEN) {
    // Secure flag ensures the cookie is only sent over HTTPS, preventing
    // leakage if someone hits an HTTP URL. Omitted in dev (localhost is HTTP).
    res.setHeader('Set-Cookie', sessionCookie(LEGACY_AUTH_TOKEN));
    return res.redirect('/');
  }

  res.locals.error = 'Incorrect password';
  res.status(401);
  app.handle({ ...req, method: 'GET', url: '/login' }, res);
});

app.post('/api/logout', (_req, res) => {
  const secure = process.env.PORT ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vq_session=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`);
  res.redirect('/login');
});

// ── Password reset flow (exempt from auth) ───────────────────────────────────
// Step 1: GET /forgot-password — renders the "enter your email" form.
// Step 2: POST /api/forgot-password — generates a reset token, emails the link.
// Step 3: GET /reset-password?token=xxx — renders the "enter new password" form.
// Step 4: POST /api/reset-password — verifies token, updates password.

app.get('/forgot-password', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Reset Password</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form method="POST" action="/api/forgot-password">
    <h1>Reset Password</h1>
    <p class="subtitle">Enter your email to receive a reset link</p>
    <input type="email" name="email" placeholder="Email" required autofocus autocomplete="email">
    <button type="submit">Send Reset Link</button>
    <p class="link"><a href="/login">Back to login</a></p>
  </form>
</body>
</html>`);
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  // Always show the same message regardless of whether the email exists,
  // to prevent user enumeration attacks.
  const successPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Check Your Email</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form>
    <h1>Check Your Email</h1>
    <p class="success">If an account exists with that email, we've sent a password reset link. It expires in 1 hour.</p>
    <p class="link"><a href="/login">Back to login</a></p>
  </form>
</body>
</html>`;

  const { email } = req.body;
  if (!email) return res.send(successPage);

  const users = loadUsers();
  if (!users) return res.send(successPage);

  const trimmedEmail = (email || '').trim().toLowerCase();
  const userId = sanitizeKey(trimmedEmail);
  const user = users[userId];

  // If user doesn't exist, show same success page (no enumeration)
  if (!user) return res.send(successPage);

  // Skip if a reset token was issued less than 5 minutes ago (prevents email flooding)
  const now = Math.floor(Date.now() / 1000);
  const RESET_COOLDOWN = 5 * 60; // 5 minutes
  if (user.resetTokenExpiry && (user.resetTokenExpiry - RESET_TOKEN_MAX_AGE + RESET_COOLDOWN) > now) {
    return res.send(successPage);
  }

  // Generate a random reset token and store its SHA-256 hash
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.resetTokenHash = tokenHash;
  user.resetTokenExpiry = Math.floor(Date.now() / 1000) + RESET_TOKEN_MAX_AGE;
  saveUsers(users);

  // Send the reset email via Resend
  const resetUrl = `${APP_URL}/reset-password?token=${rawToken}&email=${encodeURIComponent(trimmedEmail)}`;

  if (RESEND_API_KEY) {
    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [trimmedEmail],
          subject: 'Vocab Quest — Reset Your Password',
          html: `<p>Hi ${user.displayName},</p>
<p>Someone requested a password reset for your Vocab Quest account. Click the link below to set a new password:</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
<p>— Vocab Quest</p>`,
        }),
      });
      if (!emailRes.ok) {
        const err = await emailRes.json().catch(() => ({}));
        console.error('[password reset] Resend API error:', emailRes.status, err);
      }
    } catch (err) {
      console.error('[password reset] Failed to send email:', err.message);
    }
  } else {
    // Dev mode: log the reset URL to the console
    console.log(`[password reset] No RESEND_API_KEY set. Reset URL:\n  ${resetUrl}`);
  }

  res.send(successPage);
});

app.get('/reset-password', (req, res) => {
  const { token, email } = req.query;
  if (!token || !email) return res.redirect('/forgot-password');

  // Normalize email so the form submits the same casing the backend expects
  const normalizedEmail = email.trim().toLowerCase();

  // Escape HTML special characters to prevent XSS via query params
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — New Password</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form method="POST" action="/api/reset-password">
    <h1>New Password</h1>
    <p class="subtitle">Enter your new password (min 8 characters)</p>
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="email" value="${esc(normalizedEmail)}">
    <input type="password" name="password" placeholder="New password" required autofocus autocomplete="new-password" minlength="8">
    <input type="password" name="confirmPassword" placeholder="Confirm password" required autocomplete="new-password" minlength="8">
    <button type="submit">Reset Password</button>
  </form>
</body>
</html>`);
});

app.post('/api/reset-password', authLimiter, (req, res) => {
  const { token, email, password, confirmPassword } = req.body;

  const errorPage = (msg) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Reset Password</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form>
    <h1>Reset Password</h1>
    <p class="error">${msg}</p>
    <p class="link"><a href="/forgot-password">Try again</a></p>
  </form>
</body>
</html>`;

  if (!token || !email) return res.status(400).send(errorPage('Invalid reset link.'));
  if (!password || password.length < 8) return res.status(400).send(errorPage('Password must be at least 8 characters.'));
  if (password !== confirmPassword) return res.status(400).send(errorPage('Passwords do not match.'));

  const users = loadUsers();
  if (!users) return res.status(400).send(errorPage('Invalid reset link.'));

  const trimmedEmail = email.trim().toLowerCase();
  const userId = sanitizeKey(trimmedEmail);
  const user = users[userId];

  if (!user || !user.resetTokenHash || !user.resetTokenExpiry) {
    return res.status(400).send(errorPage('Invalid or expired reset link.'));
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now > user.resetTokenExpiry) {
    // Clear expired token
    delete user.resetTokenHash;
    delete user.resetTokenExpiry;
    saveUsers(users);
    return res.status(400).send(errorPage('This reset link has expired. Please request a new one.'));
  }

  // Verify token hash using timingSafeEqual
  const providedHash = crypto.createHash('sha256').update(token).digest('hex');
  const a = Buffer.from(providedHash);
  const b = Buffer.from(user.resetTokenHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).send(errorPage('Invalid or expired reset link.'));
  }

  // Token is valid — update the password
  const newSalt = generateSalt();
  user.passwordHash = hashPassword(password, newSalt);
  user.salt = newSalt;
  user.passwordVersion = (user.passwordVersion || 1) + 1;
  delete user.resetTokenHash;
  delete user.resetTokenExpiry;
  saveUsers(users);

  // Show success page — user needs to log in with new password
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vocab Quest — Password Reset</title>
  <style>${LOGIN_STYLES}</style>
</head>
<body>
  <form>
    <h1>Password Reset</h1>
    <p class="success">Your password has been reset. All existing sessions have been logged out.</p>
    <p class="link"><a href="/login">Log in with your new password</a></p>
  </form>
</body>
</html>`);
});

// ── Health check (exempt from auth — called by Railway before routing traffic) ──
// Verifies the data volume is mounted and writable so Railway can gate deploys
// on actual readiness, not just "process started". Only checks local resources
// (filesystem), NOT external APIs (Claude/Gemini), because a transient
// third-party outage should not block deploys or trigger restarts.
const startedAt = Date.now();
app.get('/api/health', async (_req, res) => {
  try {
    await access(DATA_DIR, constants.R_OK | constants.W_OK);
  } catch (err) {
    console.error('[health] DATA_DIR access check failed:', DATA_DIR, err.message);
    return res.status(503).json({ status: 'degraded', reason: 'data directory inaccessible' });
  }
  res.json({
    status: 'ok',
    // Commit SHA lets us verify which build is live after a deploy.
    version: process.env.RAILWAY_GIT_COMMIT_SHA || 'dev',
    // Uptime in seconds — useful for spotting crash-loop restarts.
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// ── All routes below require auth ─────────────────────────────────────────────
app.use(requireAuth);

// ── GET /api/me — return the current user's profile ──────────────────────────
// Used by the frontend to display the user's name, determine admin status,
// and decide whether to show the admin panel. Returns null in legacy mode.
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json(null);
  res.json({
    id: req.user.id,
    displayName: req.user.displayName,
    role: req.user.role,
  });
});

// ── User management (admin only) ─────────────────────────────────────────────
// These endpoints let the admin create and delete family/friend accounts.
// All routes verify req.user.role === 'admin' before proceeding.

/**
 * Middleware that rejects non-admin users with 403.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: { message: 'Admin access required' } });
  }
  next();
}

// GET /api/users — list all user accounts (no secrets)
app.get('/api/users', requireAdmin, (_req, res) => {
  const users = loadUsers();
  if (!users) return res.json([]);
  const list = Object.entries(users).map(([id, u]) => ({
    id,
    email: u.email || id,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt,
  }));
  res.json(list);
});

// POST /api/users — create a new user account
app.post('/api/users', requireAdmin, (req, res) => {
  const { email, displayName, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'Email and password are required' } });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });
  }

  const trimmedEmail = email.trim().toLowerCase();
  if (!isValidEmail(trimmedEmail)) {
    return res.status(400).json({ error: { message: 'Invalid email address' } });
  }

  const userId = sanitizeKey(trimmedEmail);
  if (!userId || userId.includes(':')) {
    return res.status(400).json({ error: { message: 'Invalid email' } });
  }

  const users = loadUsers();
  if (!users) {
    return res.status(400).json({ error: { message: 'Multi-user mode not active. Run /setup first.' } });
  }
  if (users[userId]) {
    return res.status(409).json({ error: { message: `User "${trimmedEmail}" already exists` } });
  }

  const salt = generateSalt();
  users[userId] = {
    email: trimmedEmail,
    displayName: (displayName || trimmedEmail).trim(),
    passwordHash: hashPassword(password, salt),
    salt,
    role: 'member',
    passwordVersion: 1,
    // Reserved for future per-user API key support (not used yet)
    anthropicApiKey: null,
    geminiApiKey: null,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);
  res.json({ ok: true });
});

// DELETE /api/users/:id — delete a user and all their namespaced data files.
// The admin cannot delete their own account to prevent accidental lockout.
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const userId = sanitizeKey(req.params.id);
  if (userId === req.user.id) {
    return res.status(400).json({ error: { message: 'Cannot delete your own account' } });
  }

  const users = loadUsers();
  if (!users || !users[userId]) {
    return res.status(404).json({ error: { message: 'User not found' } });
  }

  // Remove user from users.json
  delete users[userId];
  saveUsers(users);

  // Delete all data files namespaced to this user (u_{userId}_*.json)
  // This is best-effort — if some files fail to delete, the user account
  // is already removed and the orphaned files are harmless.
  const prefix = `u_${userId}_`;
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith(prefix));
    await Promise.all(files.map(f => unlink(join(DATA_DIR, f)).catch(() => {})));
    console.log(`[user delete] Removed ${files.length} data files for user "${userId}"`);
  } catch (err) {
    console.error(`[user delete] Error cleaning up files for "${userId}":`, err);
  }

  res.json({ ok: true });
});

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
  // 60s timeout prevents a hung Google API call from holding a connection
  // open indefinitely. Image generation can legitimately take 30-60s, so
  // this is generous while still failing before the user gives up.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error(`Gemini API error: HTTP ${response.status} for model ${model}:`, JSON.stringify(data));
    }
    res.status(response.status).json(data);
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Gemini API request timed out' : (err.message || 'Server error');
    console.error('Gemini API network error:', message);
    res.status(504).json({ error: { message } });
  } finally {
    clearTimeout(timeout);
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
// Each key becomes a JSON file in DATA_DIR. In multi-user mode, keys are
// prefixed with "u_{userId}_" via resolveKey() for full per-user isolation.
// Writes use atomic rename (write to .tmp, then fs.rename) so a crash
// mid-write can't corrupt a file. Keys are sanitized to prevent path traversal.
//
// In Codespaces, ./data/ persists inside /workspaces/ across stops/starts.
// On Railway, DATA_DIR should point to a mounted volume (e.g. /data).

app.get('/api/kv/:key', (req, res) => {
  // Prevent browser from caching KV responses — the value can change between
  // requests (e.g., a GET returning null, then a PUT writes data, then another
  // GET should return the new data, not a cached null).
  res.set('Cache-Control', 'no-store');
  const file = join(DATA_DIR, `${resolveKey(req, req.params.key)}.json`);
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
  const key = resolveKey(req, req.params.key);
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
  const file = join(DATA_DIR, `${resolveKey(req, req.params.key)}.json`);
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
// In multi-user mode, all file paths are prefixed with "u_{userId}_" via
// resolveKey() so deletion only touches the requesting user's data.
//
// Deleted data: vocab-book-{hash}, storybible-{hash}, wordlist-{chapterHash},
// illust-index-{chapterHash}, illust-{chapterHash}-{word}, and the index entry.
app.delete('/api/books/:hash', async (req, res) => {
  const bookHash = sanitizeKey(req.params.hash);
  // resolveKey adds the user prefix in multi-user mode
  const bookFileKey = resolveKey(req, `vocab-book-${bookHash}`);
  const bookFile = join(DATA_DIR, `${bookFileKey}.json`);

  // Collect all files to delete — start with book-level files
  const toDelete = [
    bookFile,
    join(DATA_DIR, `${resolveKey(req, `storybible-${bookHash}`)}.json`),
  ];

  // Read the book data to discover chapter-level keys. The chapter hash is
  // derived from each chapter's text using the same SHA-256 algorithm as the
  // client (first 32 hex chars), so we find the exact same file names.
  try {
    if (existsSync(bookFile)) {
      const raw = readFileSync(bookFile, 'utf8');
      const bookData = JSON.parse(raw);
      for (const ch of bookData.chapters || []) {
        const chapterHash = crypto.createHash('sha256').update(ch.text).digest('hex').slice(0, 32);
        toDelete.push(join(DATA_DIR, `${resolveKey(req, `wordlist-${chapterHash}`)}.json`));

        // The illustration index lists which words have cached images.
        // We need to read it to discover per-word illustration file names.
        const illustIndexKey = resolveKey(req, `illust-index-${chapterHash}`);
        const illustIndexFile = join(DATA_DIR, `${illustIndexKey}.json`);
        try {
          if (existsSync(illustIndexFile)) {
            const words = JSON.parse(readFileSync(illustIndexFile, 'utf8'));
            for (const w of words) {
              toDelete.push(join(DATA_DIR, `${resolveKey(req, `illust-${chapterHash}-${sanitizeKey(w)}`)}.json`));
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
  const indexKey = resolveKey(req, BOOK_INDEX_KEY);
  const indexFile = join(DATA_DIR, `${indexKey}.json`);
  try {
    if (existsSync(indexFile)) {
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      const updated = index.filter(b => b.hash !== req.params.hash);
      const tmp = join(DATA_DIR, `${indexKey}.tmp`);
      writeFileSync(tmp, JSON.stringify(updated), 'utf8');
      renameSync(tmp, indexFile);
    }
  } catch (err) {
    console.error('Error updating book index:', err);
    return res.status(500).json({ error: { message: 'Failed to update book index' } });
  }

  res.json({ ok: true });
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
  const users = loadUsers();
  const mode = users
    ? `multi-user (${Object.keys(users).length} accounts)`
    : AUTH_PASSWORD ? 'single-password (legacy)' : 'disabled (set AUTH_PASSWORD or run /setup)';
  console.log(`Vocab Quest API server running on http://localhost:${PORT}`);
  console.log(`Auth: ${mode}`);
  console.log(`Claude: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'using CLAUDE_CODE_OAUTH_TOKEN env var' : 'using ~/.claude/.credentials.json'}`);
  console.log(`Gemini: ${GEMINI_KEY ? 'configured' : 'NOT configured'}`);
});
