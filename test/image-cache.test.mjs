/**
 * Image caching integration tests
 *
 * Spins up the Express server with a temp DATA_DIR, then exercises the exact
 * same storageGet/storageSet → /api/kv round-trip that the client uses for
 * illustration caching. Image generation is mocked with a deterministic hash
 * so we can verify cache hits return the exact same data.
 *
 * Run: node --test test/image-cache.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// ── Helpers that mirror the client code exactly ──────────────────────────────

let BASE_URL;

/** Mirrors window.storage from App.jsx */
function makeStorage(baseUrl) {
  return {
    async get(key) {
      const res = await fetch(`${baseUrl}/api/kv/${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      return await res.json();
    },
    async set(key, value) {
      await fetch(`${baseUrl}/api/kv/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    },
    async delete(key) {
      await fetch(`${baseUrl}/api/kv/${encodeURIComponent(key)}`, { method: 'DELETE' });
    },
  };
}

/** Mirrors storageGet from App.jsx */
async function storageGet(storage, key) {
  try {
    const result = await storage.get(key);
    return result ? JSON.parse(result.value) : null;
  } catch { return null; }
}

/** Mirrors storageSet from App.jsx */
async function storageSet(storage, key, value) {
  try {
    await storage.set(key, JSON.stringify(value));
  } catch (e) { console.warn("Storage write failed:", e); }
}

/** Mirrors hashText from App.jsx (but server-side using crypto) */
function hashText(text) {
  return createHash('sha256').update(text.slice(0, 500000)).digest('hex').slice(0, 32);
}

/** Mock image generator — deterministic fake data URI based on prompt */
function generateMockImage(prompt) {
  const hash = createHash('sha256').update(prompt).digest('base64').slice(0, 200);
  return `data:image/jpeg;base64,${hash}`;
}

// ── Mirrors getCachedImage / cacheImage from GeneratingPhase ─────────────────

function makeCacheHelpers(storage, chHash, geminiModel) {
  async function getCachedImage(word) {
    if (!chHash) return null;
    const cached = await storageGet(storage, `illust-${chHash}-${word.toLowerCase().trim()}`);
    return cached ? cached.dataUri : null;
  }

  async function cacheImage(word, dataUri) {
    if (!chHash || !dataUri) return;
    const w = word.toLowerCase().trim();
    await storageSet(storage, `illust-${chHash}-${w}`, {
      dataUri,
      model: geminiModel,
      generatedAt: new Date().toISOString(),
    });
  }

  async function updateIllustIndex(words) {
    if (!chHash) return;
    const indexKey = `illust-index-${chHash}`;
    const existing = (await storageGet(storage, indexKey)) || [];
    const merged = [...new Set([...existing, ...words.map(w => w.toLowerCase().trim())])];
    await storageSet(storage, indexKey, merged);
  }

  async function flushIllustrationCaches() {
    const indexKey = `illust-index-${chHash}`;
    const words = (await storageGet(storage, indexKey)) || [];
    for (const w of words) {
      try { await storage.delete(`illust-${chHash}-${w}`); } catch {}
    }
    try { await storage.delete(indexKey); } catch {}
  }

  return { getCachedImage, cacheImage, updateIllustIndex, flushIllustrationCaches };
}

/**
 * Simulates a full GeneratingPhase image pass: for each word, check cache,
 * generate if missing, cache the result. Returns { images, generatedCount }.
 */
async function simulateImagePass(helpers, words, prompts) {
  const newlyCached = [];
  const images = await Promise.all(
    words.map(async (word, i) => {
      const cached = await helpers.getCachedImage(word);
      if (cached) return { word, image: cached, fromCache: true };
      const img = generateMockImage(prompts[i]);
      await helpers.cacheImage(word, img);
      newlyCached.push(word);
      return { word, image: img, fromCache: false };
    })
  );
  if (newlyCached.length) await helpers.updateIllustIndex(newlyCached);
  return { images, generatedCount: newlyCached.length };
}

// ── Server setup ─────────────────────────────────────────────────────────────

let server;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'vq-test-'));
  process.env.DATA_DIR = tempDir;

  // Import the server (it's an ES module that starts listening on import)
  // We need to start a fresh Express app, so let's build a minimal one
  // that mirrors the KV endpoints from server.js
  const express = (await import('express')).default;
  const { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } = await import('fs');
  const { unlink } = await import('fs/promises');

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const DATA_DIR = tempDir;
  mkdirSync(DATA_DIR, { recursive: true });

  function sanitizeKey(key) {
    return key.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  app.get('/api/kv/:key', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const file = join(DATA_DIR, `${sanitizeKey(req.params.key)}.json`);
    if (!existsSync(file)) return res.json(null);
    try {
      const raw = readFileSync(file, 'utf8');
      res.json({ value: raw });
    } catch (err) {
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
      res.status(500).json({ error: { message: 'Write failed' } });
    }
  });

  app.delete('/api/kv/:key', async (req, res) => {
    const file = join(DATA_DIR, `${sanitizeKey(req.params.key)}.json`);
    try { await unlink(file); } catch (err) {
      if (err.code !== 'ENOENT') return res.status(500).json({ error: { message: 'Delete failed' } });
    }
    res.json({ ok: true });
  });

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KV store round-trip', () => {
  it('returns null for missing key', async () => {
    const storage = makeStorage(BASE_URL);
    const val = await storageGet(storage, 'nonexistent-key');
    assert.equal(val, null);
  });

  it('writes and reads back a value', async () => {
    const storage = makeStorage(BASE_URL);
    await storageSet(storage, 'test-key', { hello: 'world' });
    const val = await storageGet(storage, 'test-key');
    assert.deepEqual(val, { hello: 'world' });
  });

  it('overwrites existing value', async () => {
    const storage = makeStorage(BASE_URL);
    await storageSet(storage, 'overwrite-key', { v: 1 });
    await storageSet(storage, 'overwrite-key', { v: 2 });
    const val = await storageGet(storage, 'overwrite-key');
    assert.deepEqual(val, { v: 2 });
  });

  it('deletes a value', async () => {
    const storage = makeStorage(BASE_URL);
    await storageSet(storage, 'delete-key', { v: 1 });
    await storage.delete('delete-key');
    const val = await storageGet(storage, 'delete-key');
    assert.equal(val, null);
  });

  it('read-after-write is immediate (no stale cache)', async () => {
    const storage = makeStorage(BASE_URL);
    const key = 'cache-test';
    // Read → null
    assert.equal(await storageGet(storage, key), null);
    // Write
    await storageSet(storage, key, { cached: true });
    // Read → should see new value, not cached null
    const val = await storageGet(storage, key);
    assert.deepEqual(val, { cached: true });
  });
});

describe('Image caching (simulated GeneratingPhase)', () => {
  const CHAPTER_TEXT = 'It was a dark and stormy night in the old Victorian manor...';
  const CH_HASH = hashText(CHAPTER_TEXT);
  const WORDS = ['languidly', 'contented', 'muddled', 'scrambling', 'glimpse'];
  const PROMPTS = WORDS.map(w => `Paint ${w} in a Victorian scene`);
  const MODEL = 'test-model';

  it('first play: all images generated (none from cache)', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    const { images, generatedCount } = await simulateImagePass(helpers, WORDS, PROMPTS);

    assert.equal(generatedCount, 5, 'all 5 should be generated');
    assert.equal(images.filter(i => i.fromCache).length, 0, 'none should be from cache');
    for (const img of images) {
      assert.ok(img.image.startsWith('data:image/jpeg;base64,'), `${img.word} should have data URI`);
    }
  });

  it('second play (replay): all images from cache, identical data', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    // First play
    const first = await simulateImagePass(helpers, WORDS, PROMPTS);

    // Second play — same words, same chapter
    const second = await simulateImagePass(helpers, WORDS, PROMPTS);

    assert.equal(second.generatedCount, 0, 'no images should be regenerated');
    assert.equal(second.images.filter(i => i.fromCache).length, 5, 'all should be from cache');

    // Verify identical data
    for (let i = 0; i < WORDS.length; i++) {
      assert.equal(second.images[i].image, first.images[i].image,
        `${WORDS[i]}: cached image should be identical to generated image`);
    }
  });

  it('illust-index contains all words after parallel caching', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    await simulateImagePass(helpers, WORDS, PROMPTS);

    const indexKey = `illust-index-${CH_HASH}`;
    const index = await storageGet(storage, indexKey);
    assert.ok(Array.isArray(index), 'index should be an array');
    for (const w of WORDS) {
      assert.ok(index.includes(w.toLowerCase()), `index should contain "${w}"`);
    }
  });

  it('flush deletes all images and index', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    await simulateImagePass(helpers, WORDS, PROMPTS);
    await helpers.flushIllustrationCaches();

    // All images should be gone
    for (const w of WORDS) {
      const cached = await helpers.getCachedImage(w);
      assert.equal(cached, null, `${w} should be null after flush`);
    }

    // Index should be gone
    const index = await storageGet(storage, `illust-index-${CH_HASH}`);
    assert.equal(index, null, 'index should be null after flush');
  });

  it('play after flush: all regenerated, then replay: all from cache', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    // First play — generates and caches
    await simulateImagePass(helpers, WORDS, PROMPTS);

    // Flush
    await helpers.flushIllustrationCaches();

    // Second play after flush — should regenerate all
    const afterFlush = await simulateImagePass(helpers, WORDS, PROMPTS);
    assert.equal(afterFlush.generatedCount, 5, 'all should be regenerated after flush');

    // Third play (replay) — should all come from cache
    const replay = await simulateImagePass(helpers, WORDS, PROMPTS);
    assert.equal(replay.generatedCount, 0, 'replay after regeneration should use cache');

    // Verify identical to afterFlush
    for (let i = 0; i < WORDS.length; i++) {
      assert.equal(replay.images[i].image, afterFlush.images[i].image,
        `${WORDS[i]}: replay image should match post-flush regeneration`);
    }
  });

  it('large data URI (realistic image size) round-trips correctly', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    // ~800KB base64 string, similar to real Gemini output
    const bigData = 'data:image/jpeg;base64,' + 'A'.repeat(800_000);
    await helpers.cacheImage('bigword', bigData);
    const cached = await helpers.getCachedImage('bigword');
    assert.equal(cached, bigData, 'large data URI should round-trip exactly');
  });

  it('different word selection produces cache miss', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    // Cache images for WORDS
    await simulateImagePass(helpers, WORDS, PROMPTS);

    // Different words
    const otherWords = ['beastly', 'drowse', 'cautiously'];
    const otherPrompts = otherWords.map(w => `Paint ${w} in a Victorian scene`);
    const result = await simulateImagePass(helpers, otherWords, otherPrompts);

    assert.equal(result.generatedCount, 3, 'new words should all be generated');
  });

  it('word casing and whitespace are normalized', async () => {
    const storage = makeStorage(BASE_URL);
    const helpers = makeCacheHelpers(storage, CH_HASH, MODEL);

    await helpers.cacheImage('Languidly', 'data:image/jpeg;base64,abc');
    const cached = await helpers.getCachedImage('  languidly  ');
    assert.equal(cached, 'data:image/jpeg;base64,abc', 'should find despite case/whitespace');
  });
});

describe('Concurrent writes (parallel image caching)', () => {
  it('5 parallel writes to different keys all succeed', async () => {
    const storage = makeStorage(BASE_URL);
    const chHash = hashText('concurrent-test-chapter');
    const helpers = makeCacheHelpers(storage, chHash, 'test');

    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const dataUris = words.map(w => `data:image/jpeg;base64,${w}_image`);

    // Write all in parallel (mimics Promise.all in GeneratingPhase)
    await Promise.all(words.map((w, i) => helpers.cacheImage(w, dataUris[i])));

    // Read all back
    for (let i = 0; i < words.length; i++) {
      const cached = await helpers.getCachedImage(words[i]);
      assert.equal(cached, dataUris[i], `${words[i]} should be cached`);
    }
  });
});
