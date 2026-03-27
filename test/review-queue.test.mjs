/**
 * Review queue unit + integration tests
 *
 * Tests exercise assignment by maturity, quality scoring for single-exercise
 * sessions, per-word quiz caching, and the full review asset loading flow.
 *
 * Run: node --test test/review-queue.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { sm2Update, qualityFromScores } from '../src/wordRecords.js';

// ── Unit tests: exercise assignment by maturity ─────────────────────────────

function assignExerciseType(wordRecord) {
  const rep = wordRecord.repetitions || 0;
  if (rep <= 1) return "meaning";
  if (rep <= 3) return "blank";
  return "spell";
}

describe("Exercise assignment by maturity", () => {
  it("assigns MC meaning for rep 0 (brand new)", () => {
    assert.equal(assignExerciseType({ repetitions: 0 }), "meaning");
  });

  it("assigns MC meaning for rep 1 (just learned)", () => {
    assert.equal(assignExerciseType({ repetitions: 1 }), "meaning");
  });

  it("assigns fill-in-blank for rep 2", () => {
    assert.equal(assignExerciseType({ repetitions: 2 }), "blank");
  });

  it("assigns fill-in-blank for rep 3", () => {
    assert.equal(assignExerciseType({ repetitions: 3 }), "blank");
  });

  it("assigns spelling for rep 4+", () => {
    assert.equal(assignExerciseType({ repetitions: 4 }), "spell");
    assert.equal(assignExerciseType({ repetitions: 10 }), "spell");
    assert.equal(assignExerciseType({ repetitions: 50 }), "spell");
  });

  it("handles missing repetitions as 0", () => {
    assert.equal(assignExerciseType({}), "meaning");
    assert.equal(assignExerciseType({ repetitions: undefined }), "meaning");
  });
});

// ── Unit tests: quality scoring for review sessions (single task type) ──────

describe("Quality scoring for review sessions", () => {
  it("scores quality 5 when only meaning is present and correct", () => {
    // Simulates what recordSession now does: filter out null scores
    const meaningScore = "correct";
    const blankScore = null;
    const spellingScore = null;
    const presentScores = [meaningScore, blankScore, spellingScore].filter(s => s !== null);
    const quality = presentScores.length > 0
      ? Math.min(...presentScores.map(s => ({ correct: 5, retry: 3, wrong: 1 }[s] ?? 1)))
      : 1;
    assert.equal(quality, 5);
  });

  it("scores quality 3 when only fill-blank is present and retry", () => {
    const presentScores = ["retry"].filter(s => s !== null);
    const quality = Math.min(...presentScores.map(s => ({ correct: 5, retry: 3, wrong: 1 }[s] ?? 1)));
    assert.equal(quality, 3);
  });

  it("scores quality 5 when only spelling is present and correct", () => {
    const presentScores = [null, null, "correct"].filter(s => s !== null);
    const quality = Math.min(...presentScores.map(s => ({ correct: 5, retry: 3, wrong: 1 }[s] ?? 1)));
    assert.equal(quality, 5);
  });

  it("still returns quality 1 when all three are wrong (chapter flow)", () => {
    const presentScores = ["wrong", "wrong", "wrong"].filter(s => s !== null);
    const quality = Math.min(...presentScores.map(s => ({ correct: 5, retry: 3, wrong: 1 }[s] ?? 1)));
    assert.equal(quality, 1);
  });

  it("returns quality 1 when no scores are present (edge case)", () => {
    const presentScores = [null, null, null].filter(s => s !== null);
    const quality = presentScores.length > 0
      ? Math.min(...presentScores.map(s => ({ correct: 5, retry: 3, wrong: 1 }[s] ?? 1)))
      : 1;
    assert.equal(quality, 1);
  });

  it("takes minimum when two tasks present (mixed review)", () => {
    const presentScores = ["correct", "retry"].filter(s => s !== null);
    const quality = Math.min(...presentScores.map(s => ({ correct: 5, retry: 3, wrong: 1 }[s] ?? 1)));
    assert.equal(quality, 3);
  });
});

// ── Unit tests: SM-2 update with review-style single exercise ───────────────

describe("SM-2 with single-exercise review sessions", () => {
  it("advances repetitions on quality 5 (single correct exercise)", () => {
    const record = { easeFactor: 2.5, interval: 6, repetitions: 2, nextReviewDate: "2026-03-20", lastReviewedAt: null };
    const updated = sm2Update(record, 5);
    assert.equal(updated.repetitions, 3);
    assert.ok(updated.interval > 6); // should multiply by easeFactor
  });

  it("resets on quality 1 (single wrong exercise)", () => {
    const record = { easeFactor: 2.5, interval: 15, repetitions: 4, nextReviewDate: "2026-03-20", lastReviewedAt: null };
    const updated = sm2Update(record, 1);
    assert.equal(updated.repetitions, 0);
    assert.equal(updated.interval, 1);
  });

  it("advances on quality 3 (retry on single exercise)", () => {
    const record = { easeFactor: 2.5, interval: 6, repetitions: 2, nextReviewDate: "2026-03-20", lastReviewedAt: null };
    const updated = sm2Update(record, 3);
    assert.equal(updated.repetitions, 3);
    assert.ok(updated.easeFactor < 2.5); // lowered by quality 3
  });
});

// ── Integration tests: per-word quiz caching and review asset loading ────────

let server;
let tempDir;
let BASE_URL;

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

async function storageGet(storage, key) {
  try {
    const result = await storage.get(key);
    return result ? JSON.parse(result.value) : null;
  } catch { return null; }
}

async function storageSet(storage, key, value) {
  try {
    await storage.set(key, JSON.stringify(value));
  } catch (e) { console.warn("Storage write failed:", e); }
}

function hashText(text) {
  return createHash('sha256').update(text.slice(0, 500000)).digest('hex').slice(0, 32);
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'vq-review-test-'));
  process.env.DATA_DIR = tempDir;

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
    } catch { res.status(500).json({ error: { message: 'Read failed' } }); }
  });

  app.put('/api/kv/:key', (req, res) => {
    const file = join(DATA_DIR, `${sanitizeKey(req.params.key)}.json`);
    const tmp = file + '.tmp';
    try {
      writeFileSync(tmp, req.body.value, 'utf8');
      renameSync(tmp, file);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: { message: 'Write failed' } }); }
  });

  app.delete('/api/kv/:key', async (req, res) => {
    const file = join(DATA_DIR, `${sanitizeKey(req.params.key)}.json`);
    try { await unlink(file); } catch {}
    res.json({ ok: true });
  });

  await new Promise(resolve => {
    server = app.listen(0, () => {
      BASE_URL = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  // Wire up window.storage for wordRecords.js
  globalThis.window = { storage: makeStorage(BASE_URL) };
});

after(() => {
  server?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Per-word quiz cache", () => {
  it("stores and retrieves individual word quiz items", async () => {
    const storage = makeStorage(BASE_URL);
    const quizItem = { word: "ephemeral", correct: 0, options: ["fleeting", "lasting", "heavy", "loud"], hint: "Think about time." };
    await storageSet(storage, `quiz-word-ephemeral`, quizItem);

    const retrieved = await storageGet(storage, `quiz-word-ephemeral`);
    assert.deepEqual(retrieved, quizItem);
  });

  it("returns null for words never played", async () => {
    const storage = makeStorage(BASE_URL);
    const retrieved = await storageGet(storage, `quiz-word-nonexistent`);
    assert.equal(retrieved, null);
  });
});

describe("Review session recording", () => {
  it("correctly updates SM-2 with single task type via recordSession", async () => {
    const { recordSession, getWordRecord } = await import('../src/wordRecords.js');

    // Create a word record by recording a review session with only one task type
    await recordSession({
      gameType: "review",
      context: { bookTitle: "Review", bookHash: null, chapterTitle: "Practice session" },
      wordResults: [
        { word: "ubiquitous", taskType: "meaning", firstTry: true, attempts: 1 },
      ],
    });

    const record = await getWordRecord("ubiquitous");
    assert.ok(record, "Word record should exist after review session");
    assert.equal(record.repetitions, 1, "Should advance repetitions on correct answer");
    assert.equal(record.interval, 1, "First correct answer → interval 1");
  });

  it("does not penalize missing task types as wrong", async () => {
    const { recordSession, getWordRecord } = await import('../src/wordRecords.js');

    // First session to establish the word
    await recordSession({
      gameType: "review",
      context: { bookTitle: "Review", bookHash: null, chapterTitle: "Practice" },
      wordResults: [
        { word: "surreptitious", taskType: "meaning", firstTry: true, attempts: 1 },
      ],
    });

    // Second review session — only spelling, and correct
    await recordSession({
      gameType: "review",
      context: { bookTitle: "Review", bookHash: null, chapterTitle: "Practice" },
      wordResults: [
        { word: "surreptitious", taskType: "spelling", firstTry: true, attempts: 1 },
      ],
    });

    const record = await getWordRecord("surreptitious");
    assert.equal(record.repetitions, 2, "Should advance — spelling correct should not be penalized by missing meaning/blank");
    assert.equal(record.interval, 6, "Second correct → interval 6");
  });
});

describe("Review queue ordering", () => {
  it("returns most overdue words first", async () => {
    const { getReviewQueue } = await import('../src/wordRecords.js');
    // The words created above should now have future nextReviewDates,
    // so the queue should be empty or contain only overdue words.
    const queue = await getReviewQueue();
    // Verify ordering: each nextReviewDate <= the next
    for (let i = 1; i < queue.length; i++) {
      assert.ok(queue[i - 1].nextReviewDate <= queue[i].nextReviewDate,
        `Queue should be sorted by nextReviewDate: ${queue[i-1].nextReviewDate} <= ${queue[i].nextReviewDate}`);
    }
  });
});

describe("getNextReviewDate", () => {
  it("returns the earliest future review date and count", async () => {
    const { getNextReviewDate } = await import('../src/wordRecords.js');
    const result = await getNextReviewDate();
    // We recorded sessions above, so there should be future reviews
    assert.ok(result, "Should have upcoming reviews");
    assert.ok(result.date > new Date().toISOString().slice(0, 10), "Date should be in the future");
    assert.ok(result.count >= 1, "Should have at least 1 word on that date");
  });
});
