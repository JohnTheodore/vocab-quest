/**
 * Multi-user authentication integration tests
 *
 * Spins up a minimal Express server that mirrors the auth, user management,
 * KV namespacing, and setup endpoints from server.js. Tests the full lifecycle:
 * first-time setup, login, session tokens, KV isolation between users, admin
 * user management, and password reset.
 *
 * Run: node --test test/auth.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';
import express from 'express';

// ── Auth helpers (mirrored from server.js) ───────────────────────────────────
// These are minimal copies of the server's auth functions so we can test
// the exact same logic in isolation without importing the full server.

const SESSION_SECRET = 'test-secret-for-auth-tests';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSessionToken(userId, passwordVersion) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${userId}:${timestamp}:${passwordVersion}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 4) return null;
  const [userId, timestamp, passwordVersion, hmac] = parts;
  if (!userId || !timestamp || !passwordVersion || !hmac) return null;
  const payload = `${userId}:${timestamp}:${passwordVersion}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now - parseInt(timestamp, 10) > SESSION_MAX_AGE) return null;
  return { userId, passwordVersion: parseInt(passwordVersion, 10) };
}

function resolveKey(user, key) {
  const sanitized = sanitizeKey(key);
  return `u_${sanitizeKey(user.id)}_${sanitized}`;
}

// ── Test server factory ──────────────────────────────────────────────────────
// Creates a fresh Express app with a temp data directory for each test suite.
// Mirrors the auth endpoints and KV store from server.js.

function createTestServer(dataDir) {
  const USERS_FILE = join(dataDir, 'users.json');

  function loadUsers() {
    if (!existsSync(USERS_FILE)) return null;
    try { return JSON.parse(readFileSync(USERS_FILE, 'utf8')); }
    catch { return null; }
  }

  function saveUsers(users) {
    const tmp = join(dataDir, 'users.tmp');
    writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
    renameSync(tmp, USERS_FILE);
  }

  // Parse cookies from the request header
  function parseCookies(req) {
    const cookies = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
    }
    return cookies;
  }

  function requireAuth(req, res, next) {
    const users = loadUsers();
    if (!users) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'No users configured' } });
      return res.redirect('/setup');
    }
    const token = parseCookies(req)['vq_session'] || '';
    const session = verifySessionToken(token);
    if (!session || !users[session.userId]) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'Unauthorized' } });
      return res.redirect('/login');
    }
    const u = users[session.userId];
    if ((u.passwordVersion || 1) !== session.passwordVersion) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: { message: 'Session expired' } });
      return res.redirect('/login');
    }
    req.user = { id: session.userId, displayName: u.displayName, role: u.role };
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Admin access required' } });
    }
    next();
  }

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ── Setup endpoint ─────────────────────────────────────────────────────
  app.post('/api/setup', (req, res) => {
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
    const userId = sanitizeKey(trimmedEmail);
    if (!userId || userId.includes(':')) return res.status(400).json({ error: { message: 'Invalid email' } });

    const salt = generateSalt();
    const users = {
      [userId]: {
        email: trimmedEmail,
        displayName: (displayName || trimmedEmail).trim(),
        passwordHash: hashPassword(password, salt),
        salt,
        role: 'admin',
        passwordVersion: 1,
        anthropicApiKey: null,
        geminiApiKey: null,
        createdAt: new Date().toISOString(),
      },
    };

    // Migrate existing files
    const skippedFiles = ['users.json', 'users.tmp', '.session-secret'];
    const migrated = [];
    try {
      const files = readdirSync(dataDir).filter(f => f.endsWith('.json') && !skippedFiles.includes(f));
      for (const file of files) {
        const src = join(dataDir, file);
        const baseName = file.slice(0, -5);
        const dest = join(dataDir, `u_${userId}_${baseName}.json`);
        copyFileSync(src, dest);
        migrated.push({ src, dest, file });
      }
      for (const { src, dest, file } of migrated) {
        if (!existsSync(dest) || statSync(src).size !== statSync(dest).size) {
          throw new Error(`Verification failed for ${file}`);
        }
      }
      for (const { src } of migrated) unlinkSync(src);
    } catch (err) {
      // Migration error — still save users
    }

    saveUsers(users);
    const token = createSessionToken(userId, 1);
    res.setHeader('Set-Cookie', `vq_session=${token}; Path=/; HttpOnly`);
    res.json({ ok: true, migrated: migrated.length });
  });

  // ── Login ──────────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const users = loadUsers();
    if (!users) return res.status(400).json({ error: { message: 'No users configured' } });

    const trimmedEmail = (email || '').trim().toLowerCase();
    if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
      return res.status(401).json({ error: { message: 'Incorrect email or password' } });
    }
    const userId = sanitizeKey(trimmedEmail);
    const user = users[userId];
    const computedHash = hashPassword(password || '', user?.salt || 'dummy-salt');
    const storedHash = user?.passwordHash || '';
    const a = Buffer.from(computedHash);
    const b = Buffer.from(storedHash);
    if (!user || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: { message: 'Incorrect email or password' } });
    }

    const token = createSessionToken(userId, user.passwordVersion || 1);
    res.setHeader('Set-Cookie', `vq_session=${token}; Path=/; HttpOnly`);
    res.json({ ok: true });
  });

  // ── Password reset (test version — no email, returns token in JSON) ──────
  const RESET_TOKEN_MAX_AGE = 60 * 60; // 1 hour

  app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.json({ ok: true });

    const users = loadUsers();
    if (!users) return res.json({ ok: true });

    const trimmedEmail = (email || '').trim().toLowerCase();
    const userId = sanitizeKey(trimmedEmail);
    const user = users[userId];
    if (!user) return res.json({ ok: true });

    // Skip if a reset token was issued less than 5 minutes ago
    const now = Math.floor(Date.now() / 1000);
    const RESET_COOLDOWN = 5 * 60;
    if (user.resetTokenExpiry && (user.resetTokenExpiry - RESET_TOKEN_MAX_AGE + RESET_COOLDOWN) > now) {
      return res.json({ ok: true, cooldown: true });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.resetTokenHash = tokenHash;
    user.resetTokenExpiry = Math.floor(Date.now() / 1000) + RESET_TOKEN_MAX_AGE;
    saveUsers(users);

    // In tests, return the raw token so we can use it (no email sending)
    res.json({ ok: true, token: rawToken });
  });

  app.post('/api/reset-password', (req, res) => {
    const { token, email, password, confirmPassword } = req.body;
    if (!token || !email) return res.status(400).json({ error: { message: 'Invalid reset link' } });
    if (!password || password.length < 8) return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ error: { message: 'Passwords do not match' } });

    const users = loadUsers();
    if (!users) return res.status(400).json({ error: { message: 'Invalid reset link' } });

    const trimmedEmail = email.trim().toLowerCase();
    const userId = sanitizeKey(trimmedEmail);
    const user = users[userId];

    if (!user || !user.resetTokenHash || !user.resetTokenExpiry) {
      return res.status(400).json({ error: { message: 'Invalid or expired reset link' } });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > user.resetTokenExpiry) {
      delete user.resetTokenHash;
      delete user.resetTokenExpiry;
      saveUsers(users);
      return res.status(400).json({ error: { message: 'Reset link expired' } });
    }

    const providedHash = crypto.createHash('sha256').update(token).digest('hex');
    const a = Buffer.from(providedHash);
    const b = Buffer.from(user.resetTokenHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ error: { message: 'Invalid or expired reset link' } });
    }

    const newSalt = generateSalt();
    user.passwordHash = hashPassword(password, newSalt);
    user.salt = newSalt;
    user.passwordVersion = (user.passwordVersion || 1) + 1;
    delete user.resetTokenHash;
    delete user.resetTokenExpiry;
    saveUsers(users);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'vq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ ok: true });
  });

  // ── Protected routes ───────────────────────────────────────────────────
  app.use(requireAuth);

  app.get('/api/me', (req, res) => {
    res.json({ id: req.user.id, displayName: req.user.displayName, role: req.user.role });
  });

  app.get('/api/users', requireAdmin, (_req, res) => {
    const users = loadUsers();
    if (!users) return res.json([]);
    res.json(Object.entries(users).map(([id, u]) => ({
      id, displayName: u.displayName, role: u.role, createdAt: u.createdAt,
    })));
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    const { email, displayName, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: { message: 'Email and password are required' } });
    if (password.length < 8) return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });
    const trimmedEmail = email.trim().toLowerCase();
    const userId = sanitizeKey(trimmedEmail);
    if (userId.includes(':')) return res.status(400).json({ error: { message: 'Invalid email' } });
    const users = loadUsers();
    if (!users) return res.status(400).json({ error: { message: 'Multi-user mode not active' } });
    if (users[userId]) return res.status(409).json({ error: { message: `User "${trimmedEmail}" already exists` } });
    const salt = generateSalt();
    users[userId] = {
      email: trimmedEmail,
      displayName: (displayName || trimmedEmail).trim(),
      passwordHash: hashPassword(password, salt),
      salt,
      role: 'member',
      passwordVersion: 1,
      anthropicApiKey: null,
      geminiApiKey: null,
      createdAt: new Date().toISOString(),
    };
    saveUsers(users);
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    const userId = sanitizeKey(req.params.id);
    if (userId === req.user.id) return res.status(400).json({ error: { message: 'Cannot delete your own account' } });
    const users = loadUsers();
    if (!users || !users[userId]) return res.status(404).json({ error: { message: 'User not found' } });
    delete users[userId];
    saveUsers(users);
    const prefix = `u_${userId}_`;
    const files = readdirSync(dataDir).filter(f => f.startsWith(prefix));
    await Promise.all(files.map(f => unlink(join(dataDir, f)).catch(() => {})));
    res.json({ ok: true, deletedFiles: files.length });
  });

  // ── KV store with namespacing ──────────────────────────────────────────
  app.get('/api/kv/:key', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const file = join(dataDir, `${resolveKey(req.user, req.params.key)}.json`);
    if (!existsSync(file)) return res.json(null);
    try {
      const raw = readFileSync(file, 'utf8');
      res.json({ value: raw });
    } catch { res.status(500).json({ error: { message: 'Read failed' } }); }
  });

  app.put('/api/kv/:key', (req, res) => {
    const key = resolveKey(req.user, req.params.key);
    const file = join(dataDir, `${key}.json`);
    const tmp = join(dataDir, `${key}.tmp`);
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: { message: 'Missing "value"' } });
    try {
      writeFileSync(tmp, value, 'utf8');
      renameSync(tmp, file);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: { message: 'Write failed' } }); }
  });

  app.delete('/api/kv/:key', async (req, res) => {
    const file = join(dataDir, `${resolveKey(req.user, req.params.key)}.json`);
    try { await unlink(file); } catch (err) {
      if (err.code !== 'ENOENT') return res.status(500).json({ error: { message: 'Delete failed' } });
    }
    res.json({ ok: true });
  });

  return app;
}

// ── Helper: make HTTP requests with cookie support ──────────────────────────

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/vq_session=([^;]+)/);
  return match ? match[1] : null;
}

async function jsonPost(url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `vq_session=${cookie}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  return res;
}

async function jsonGet(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = `vq_session=${cookie}`;
  return fetch(url, { headers, redirect: 'manual' });
}

async function jsonDelete(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = `vq_session=${cookie}`;
  return fetch(url, { method: 'DELETE', headers, redirect: 'manual' });
}

async function kvGet(baseUrl, key, cookie) {
  const res = await jsonGet(`${baseUrl}/api/kv/${encodeURIComponent(key)}`, cookie);
  const data = await res.json();
  return data ? JSON.parse(data.value) : null;
}

async function kvSet(baseUrl, key, value, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `vq_session=${cookie}`;
  await fetch(`${baseUrl}/api/kv/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

let server, tempDir, BASE_URL;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'vq-auth-test-'));
  const app = createTestServer(tempDir);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      BASE_URL = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// ── Session token unit tests ────────────────────────────────────────────────

describe('Session tokens', () => {
  it('creates a valid token that verifies back to the userId and passwordVersion', () => {
    const token = createSessionToken('emma', 1);
    const result = verifySessionToken(token);
    assert.equal(result.userId, 'emma');
    assert.equal(result.passwordVersion, 1);
  });

  it('rejects a tampered token (modified userId)', () => {
    const token = createSessionToken('emma', 1);
    const tampered = token.replace('emma', 'evil');
    assert.equal(verifySessionToken(tampered), null);
  });

  it('rejects a tampered token (modified hmac)', () => {
    const token = createSessionToken('emma', 1);
    const parts = token.split(':');
    parts[3] = 'deadbeef'.repeat(8); // wrong HMAC
    assert.equal(verifySessionToken(parts.join(':')), null);
  });

  it('rejects an empty or malformed token', () => {
    assert.equal(verifySessionToken(''), null);
    assert.equal(verifySessionToken(null), null);
    assert.equal(verifySessionToken('just-one-part'), null);
    assert.equal(verifySessionToken('two:parts'), null);
    assert.equal(verifySessionToken('three:parts:only'), null);
  });

  it('rejects an expired token', () => {
    // Create a token with a timestamp 31 days in the past
    const userId = 'emma';
    const passwordVersion = 1;
    const expired = Math.floor(Date.now() / 1000) - (SESSION_MAX_AGE + 1);
    const payload = `${userId}:${expired}:${passwordVersion}`;
    const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const token = `${payload}:${hmac}`;
    assert.equal(verifySessionToken(token), null);
  });
});

// ── Password hashing ────────────────────────────────────────────────────────

describe('Password hashing', () => {
  const salt = generateSalt();

  it('produces deterministic output for same inputs', () => {
    const h1 = hashPassword('secret', salt);
    const h2 = hashPassword('secret', salt);
    assert.equal(h1, h2);
  });

  it('produces different output for different passwords', () => {
    const h1 = hashPassword('secret', salt);
    const h2 = hashPassword('different', salt);
    assert.notEqual(h1, h2);
  });

  it('produces different output for different salts', () => {
    const salt2 = generateSalt();
    const h1 = hashPassword('secret', salt);
    const h2 = hashPassword('secret', salt2);
    assert.notEqual(h1, h2);
  });
});

// ── No users configured (pre-setup state) ──────────────────────────────────

describe('Pre-setup state (no users.json)', () => {
  let freshDir, freshServer, freshUrl;

  before(async () => {
    freshDir = mkdtempSync(join(tmpdir(), 'vq-presetup-test-'));
    const app = createTestServer(freshDir);
    await new Promise((resolve) => {
      freshServer = app.listen(0, () => {
        freshUrl = `http://localhost:${freshServer.address().port}`;
        resolve();
      });
    });
  });

  after(() => {
    freshServer?.close();
    if (freshDir) rmSync(freshDir, { recursive: true, force: true });
  });

  it('API requests return 401 with "No users configured" message', async () => {
    const res = await jsonGet(`${freshUrl}/api/me`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.ok(data.error.message.includes('No users configured'));
  });

  it('login returns error when no users exist', async () => {
    const res = await jsonPost(`${freshUrl}/api/login`, {
      email: 'anyone@example.com', password: 'password123',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.message.includes('No users configured'));
  });

  it('KV API returns 401 before setup', async () => {
    const res = await jsonGet(`${freshUrl}/api/kv/some-key`);
    assert.equal(res.status, 401);
  });
});

// ── First-time setup ────────────────────────────────────────────────────────

describe('First-time setup', () => {
  it('creates the admin account and returns a session cookie', async () => {
    const res = await jsonPost(`${BASE_URL}/api/setup`, {
      email: 'dad@example.com', displayName: 'Dad', password: 'testpass123',
    });
    assert.equal(res.status, 200);
    const cookie = extractCookie(res);
    assert.ok(cookie, 'Should set a session cookie');

    // Verify the cookie works for /api/me
    const meRes = await jsonGet(`${BASE_URL}/api/me`, cookie);
    const me = await meRes.json();
    assert.equal(me.id, 'dad_example.com');
    assert.equal(me.displayName, 'Dad');
    assert.equal(me.role, 'admin');
  });

  it('rejects setup when users.json already exists', async () => {
    const res = await jsonPost(`${BASE_URL}/api/setup`, {
      email: 'hacker@example.com', displayName: 'Hacker', password: 'nope1234',
    });
    assert.equal(res.status, 403);
  });
});

// ── Login ───────────────────────────────────────────────────────────────────

describe('Login', () => {
  it('authenticates with correct credentials', async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'dad@example.com', password: 'testpass123',
    });
    assert.equal(res.status, 200);
    const cookie = extractCookie(res);
    assert.ok(cookie, 'Should set a session cookie');
  });

  it('rejects incorrect password', async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'dad@example.com', password: 'wrongpassword',
    });
    assert.equal(res.status, 401);
  });

  it('rejects nonexistent user', async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'nobody@example.com', password: 'testpass123',
    });
    assert.equal(res.status, 401);
  });

  it('is case-insensitive for email', async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'Dad@Example.COM', password: 'testpass123',
    });
    assert.equal(res.status, 200);
    const cookie = extractCookie(res);
    assert.ok(cookie, 'Should set a session cookie');
  });

  it('safely handles special characters in email', async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, {
      email: "'; DROP TABLE users; --", password: 'testpass123',
    });
    assert.equal(res.status, 401);
  });
});

// ── Logout ──────────────────────────────────────────────────────────────────

describe('Logout', () => {
  it('invalidates the session cookie', async () => {
    // Login to get a session
    const loginRes = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'dad@example.com', password: 'testpass123',
    });
    const cookie = extractCookie(loginRes);
    assert.ok(cookie);

    // Verify session works
    const meRes = await jsonGet(`${BASE_URL}/api/me`, cookie);
    assert.equal(meRes.status, 200);

    // Logout (clears cookie — server responds with Set-Cookie: vq_session=;)
    const logoutRes = await fetch(`${BASE_URL}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `vq_session=${cookie}` },
      redirect: 'manual',
    });
    // The server clears the cookie by setting vq_session= (empty value)
    const setCookie = logoutRes.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('vq_session=;') || setCookie.includes('vq_session='), 'Should clear cookie');
    assert.ok(setCookie.includes('Max-Age=0'), 'Should expire immediately');
  });
});

// ── Protected routes ────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('returns 401 for unauthenticated API requests', async () => {
    const res = await jsonGet(`${BASE_URL}/api/me`);
    assert.equal(res.status, 401);
  });

  it('returns 401 with an invalid session token', async () => {
    const res = await jsonGet(`${BASE_URL}/api/me`, 'invalid-token');
    assert.equal(res.status, 401);
  });
});

// ── User management ─────────────────────────────────────────────────────────

describe('User management (admin)', () => {
  let adminCookie;

  before(async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'dad@example.com', password: 'testpass123',
    });
    adminCookie = extractCookie(res);
  });

  it('lists users (admin sees all accounts)', async () => {
    const res = await jsonGet(`${BASE_URL}/api/users`, adminCookie);
    const users = await res.json();
    assert.ok(Array.isArray(users));
    assert.ok(users.some(u => u.id === 'dad_example.com'));
  });

  it('creates a new member account', async () => {
    const res = await jsonPost(`${BASE_URL}/api/users`, {
      email: 'emma@example.com', displayName: 'Emma', password: 'emma1234',
    }, adminCookie);
    assert.equal(res.status, 200);

    // Verify the new user can log in
    const loginRes = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'emma@example.com', password: 'emma1234',
    });
    assert.equal(loginRes.status, 200);
  });

  it('rejects duplicate user creation', async () => {
    const res = await jsonPost(`${BASE_URL}/api/users`, {
      email: 'emma@example.com', displayName: 'Emma', password: 'emma1234',
    }, adminCookie);
    assert.equal(res.status, 409);
  });

  it('prevents admin from deleting themselves', async () => {
    const res = await jsonDelete(`${BASE_URL}/api/users/dad_example.com`, adminCookie);
    assert.equal(res.status, 400);
  });

  it('non-admin cannot manage users', async () => {
    // Login as emma (member)
    const loginRes = await jsonPost(`${BASE_URL}/api/login`, {
      email: 'emma@example.com', password: 'emma1234',
    });
    const emmaCookie = extractCookie(loginRes);

    // Try to list users
    const res = await jsonGet(`${BASE_URL}/api/users`, emmaCookie);
    assert.equal(res.status, 403);

    // Try to create a user
    const createRes = await jsonPost(`${BASE_URL}/api/users`, {
      email: 'test@example.com', password: 'test1234',
    }, emmaCookie);
    assert.equal(createRes.status, 403);
  });
});

// ── KV namespacing (data isolation) ─────────────────────────────────────────

describe('KV namespacing — full user isolation', () => {
  let dadCookie, emmaCookie;

  before(async () => {
    const dadRes = await jsonPost(`${BASE_URL}/api/login`, { email: 'dad@example.com', password: 'testpass123' });
    dadCookie = extractCookie(dadRes);
    const emmaRes = await jsonPost(`${BASE_URL}/api/login`, { email: 'emma@example.com', password: 'emma1234' });
    emmaCookie = extractCookie(emmaRes);
  });

  it('users cannot see each other\'s data', async () => {
    // Dad writes a value
    await kvSet(BASE_URL, 'vocab-quest-data', { words: ['hello'] }, dadCookie);

    // Emma reads the same key — should be null (her namespace is empty)
    const emmaVal = await kvGet(BASE_URL, 'vocab-quest-data', emmaCookie);
    assert.equal(emmaVal, null, 'Emma should not see Dad\'s data');

    // Dad can read his own data back
    const dadVal = await kvGet(BASE_URL, 'vocab-quest-data', dadCookie);
    assert.deepEqual(dadVal, { words: ['hello'] });
  });

  it('same key name stores independently per user', async () => {
    await kvSet(BASE_URL, 'vocab-books-index', [{ title: 'Dad Book' }], dadCookie);
    await kvSet(BASE_URL, 'vocab-books-index', [{ title: 'Emma Book' }], emmaCookie);

    const dadBooks = await kvGet(BASE_URL, 'vocab-books-index', dadCookie);
    const emmaBooks = await kvGet(BASE_URL, 'vocab-books-index', emmaCookie);

    assert.deepEqual(dadBooks, [{ title: 'Dad Book' }]);
    assert.deepEqual(emmaBooks, [{ title: 'Emma Book' }]);
  });

  it('deleting a key only affects the requesting user', async () => {
    await kvSet(BASE_URL, 'test-delete', { v: 'dad' }, dadCookie);
    await kvSet(BASE_URL, 'test-delete', { v: 'emma' }, emmaCookie);

    // Dad deletes his copy
    await jsonDelete(`${BASE_URL}/api/kv/test-delete`, dadCookie);

    // Dad's copy is gone
    const dadVal = await kvGet(BASE_URL, 'test-delete', dadCookie);
    assert.equal(dadVal, null);

    // Emma's copy is untouched
    const emmaVal = await kvGet(BASE_URL, 'test-delete', emmaCookie);
    assert.deepEqual(emmaVal, { v: 'emma' });
  });
});

// ── User deletion cleans up data ────────────────────────────────────────────

describe('User deletion with data cleanup', () => {
  let adminCookie;

  before(async () => {
    const res = await jsonPost(`${BASE_URL}/api/login`, { email: 'dad@example.com', password: 'testpass123' });
    adminCookie = extractCookie(res);
  });

  it('creates a user, writes data, deletes user, verifies cleanup', async () => {
    // Create a test user
    await jsonPost(`${BASE_URL}/api/users`, {
      email: 'testuser@example.com', displayName: 'Test', password: 'test1234',
    }, adminCookie);

    // Login as test user and write some data
    const loginRes = await jsonPost(`${BASE_URL}/api/login`, { email: 'testuser@example.com', password: 'test1234' });
    const testCookie = extractCookie(loginRes);
    await kvSet(BASE_URL, 'vocab-quest-data', { progress: true }, testCookie);
    await kvSet(BASE_URL, 'vocab-books-index', [{ title: 'Test Book' }], testCookie);

    // Verify files exist on disk
    const filesBefore = readdirSync(tempDir).filter(f => f.startsWith('u_testuser_example.com_'));
    assert.ok(filesBefore.length >= 2, `Expected at least 2 files, found ${filesBefore.length}`);

    // Admin deletes the test user
    const deleteRes = await jsonDelete(`${BASE_URL}/api/users/testuser_example.com`, adminCookie);
    assert.equal(deleteRes.status, 200);

    // Verify files are cleaned up
    const filesAfter = readdirSync(tempDir).filter(f => f.startsWith('u_testuser_example.com_'));
    assert.equal(filesAfter.length, 0, 'All user data files should be deleted');

    // Verify user can no longer log in
    const loginAgain = await jsonPost(`${BASE_URL}/api/login`, { email: 'testuser@example.com', password: 'test1234' });
    assert.equal(loginAgain.status, 401);
  });
});

// ── Password reset ──────────────────────────────────────────────────────────

describe('Password reset flow', () => {
  it('generates a reset token and allows password change', async () => {
    // Request a reset for the admin account
    const forgotRes = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'dad@example.com' });
    assert.equal(forgotRes.status, 200);
    const { token } = await forgotRes.json();
    assert.ok(token, 'Should return a reset token in test mode');

    // Reset the password using the token
    const resetRes = await jsonPost(`${BASE_URL}/api/reset-password`, {
      token, email: 'dad@example.com', password: 'newpass123',
    });
    assert.equal(resetRes.status, 200);

    // Old password should no longer work
    const oldLogin = await jsonPost(`${BASE_URL}/api/login`, { email: 'dad@example.com', password: 'testpass123' });
    assert.equal(oldLogin.status, 401);

    // New password should work
    const newLogin = await jsonPost(`${BASE_URL}/api/login`, { email: 'dad@example.com', password: 'newpass123' });
    assert.equal(newLogin.status, 200);
  });

  it('invalidates existing sessions after password reset', async () => {
    // Login to get a session cookie
    const loginRes = await jsonPost(`${BASE_URL}/api/login`, { email: 'dad@example.com', password: 'newpass123' });
    const cookie = extractCookie(loginRes);
    assert.ok(cookie);

    // Verify the session works
    const meRes1 = await jsonGet(`${BASE_URL}/api/me`, cookie);
    assert.equal(meRes1.status, 200);

    // Reset password
    const forgotRes = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'dad@example.com' });
    const { token } = await forgotRes.json();
    await jsonPost(`${BASE_URL}/api/reset-password`, {
      token, email: 'dad@example.com', password: 'resetpass1',
    });

    // Old session should be invalidated (passwordVersion bumped)
    const meRes2 = await jsonGet(`${BASE_URL}/api/me`, cookie);
    assert.equal(meRes2.status, 401);
  });

  it('rejects an invalid token', async () => {
    const res = await jsonPost(`${BASE_URL}/api/reset-password`, {
      token: 'deadbeef'.repeat(8), email: 'dad@example.com', password: 'whatever1',
    });
    assert.equal(res.status, 400);
  });

  it('rejects a used token (single-use)', async () => {
    const forgotRes = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'dad@example.com' });
    const { token } = await forgotRes.json();

    // Use it once
    const first = await jsonPost(`${BASE_URL}/api/reset-password`, {
      token, email: 'dad@example.com', password: 'singleuse1',
    });
    assert.equal(first.status, 200);

    // Try to use it again
    const second = await jsonPost(`${BASE_URL}/api/reset-password`, {
      token, email: 'dad@example.com', password: 'singleuse2',
    });
    assert.equal(second.status, 400);
  });

  it('rejects password under 8 characters', async () => {
    // Password length is validated before the token is checked, so a dummy token works
    const res = await jsonPost(`${BASE_URL}/api/reset-password`, {
      token: 'dummy', email: 'dad@example.com', password: 'short',
    });
    assert.equal(res.status, 400);
  });

  it('rejects mismatched password confirmation', async () => {
    const forgotRes = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'dad@example.com' });
    const { token } = await forgotRes.json();

    const res = await jsonPost(`${BASE_URL}/api/reset-password`, {
      token, email: 'dad@example.com', password: 'newpass123', confirmPassword: 'different1',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.message.includes('match'));
  });

  it('returns ok even for nonexistent email (no enumeration)', async () => {
    const res = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'nobody@example.com' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  it('enforces 5-minute cooldown between reset emails', async () => {
    // Use emma (hasn't had a recent reset request)
    const res1 = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'emma@example.com' });
    const data1 = await res1.json();
    assert.ok(data1.token, 'First request should generate a token');

    // Second request within cooldown should not generate a new token
    const res2 = await jsonPost(`${BASE_URL}/api/forgot-password`, { email: 'emma@example.com' });
    const data2 = await res2.json();
    assert.equal(data2.cooldown, true, 'Second request should hit cooldown');
    assert.equal(data2.token, undefined, 'Should not issue a new token during cooldown');
  });
});

// ── Setup migration ─────────────────────────────────────────────────────────

describe('Setup migration (existing data files)', () => {
  let migrationDir, migrationServer, migrationUrl;

  before(async () => {
    // Create a fresh temp dir with pre-existing data (simulating a legacy deployment)
    migrationDir = mkdtempSync(join(tmpdir(), 'vq-migration-test-'));

    // Write some "legacy" data files (no user prefix)
    writeFileSync(join(migrationDir, 'vocab-quest-data.json'), JSON.stringify({ words: 57 }), 'utf8');
    writeFileSync(join(migrationDir, 'vocab-books-index.json'), JSON.stringify([{ title: 'Old Book' }]), 'utf8');
    writeFileSync(join(migrationDir, 'vocab-book-abc123.json'), JSON.stringify({ chapters: [] }), 'utf8');

    const app = createTestServer(migrationDir);
    await new Promise((resolve) => {
      migrationServer = app.listen(0, () => {
        migrationUrl = `http://localhost:${migrationServer.address().port}`;
        resolve();
      });
    });
  });

  after(() => {
    migrationServer?.close();
    if (migrationDir) rmSync(migrationDir, { recursive: true, force: true });
  });

  it('migrates existing files to the new admin user namespace', async () => {
    // Run setup — this should copy existing files to u_admin_example.com_ prefix
    const res = await jsonPost(`${migrationUrl}/api/setup`, {
      email: 'admin@example.com', displayName: 'Admin', password: 'adminpass',
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.migrated, 3, 'Should migrate 3 existing files');

    // Verify namespaced files exist
    assert.ok(existsSync(join(migrationDir, 'u_admin_example.com_vocab-quest-data.json')));
    assert.ok(existsSync(join(migrationDir, 'u_admin_example.com_vocab-books-index.json')));
    assert.ok(existsSync(join(migrationDir, 'u_admin_example.com_vocab-book-abc123.json')));

    // Verify originals are deleted
    assert.ok(!existsSync(join(migrationDir, 'vocab-quest-data.json')));
    assert.ok(!existsSync(join(migrationDir, 'vocab-books-index.json')));
    assert.ok(!existsSync(join(migrationDir, 'vocab-book-abc123.json')));

    // Verify data is readable through the KV API
    const cookie = extractCookie(res);
    const vocabData = await kvGet(migrationUrl, 'vocab-quest-data', cookie);
    assert.deepEqual(vocabData, { words: 57 });

    const booksIndex = await kvGet(migrationUrl, 'vocab-books-index', cookie);
    assert.deepEqual(booksIndex, [{ title: 'Old Book' }]);
  });
});
