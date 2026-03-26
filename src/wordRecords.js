// ── Word Records & Spaced Repetition ─────────────────────────────────────────
//
// All data lives in a single JSON blob under the key "vocab-quest-data":
//   { wordRecords: { [word]: WordRecord }, sessions: [ GameSession, ... ] }
//
// See docs/spaced-repetition-design.md for the full data model spec.

const STORAGE_KEY = "vocab-quest-data";

// ── Storage helpers ───────────────────────────────────────────────────────────
//
// These previously had a localStorage fallback, but now window.storage is always
// set by App.jsx to the server-backed KV store (see the comment there for why).

async function loadData() {
  try {
    const result = await window.storage.get(STORAGE_KEY);
    return result ? JSON.parse(result.value) : { wordRecords: {}, sessions: [] };
  } catch { return { wordRecords: {}, sessions: [] }; }
}

async function saveData(data) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { console.warn("wordRecords: storage write failed:", e); }
}

// ── SM-2 algorithm ────────────────────────────────────────────────────────────
//
// quality: 5 = first try correct, 3 = correct after hints, 1 = never got it

function sm2Update(record, quality) {
  let { easeFactor, interval, repetitions } = record;

  if (quality >= 3) {
    if (repetitions === 0)      interval = 1;
    else if (repetitions === 1) interval = 6;
    else                        interval = Math.round(interval * easeFactor);
    repetitions += 1;
    easeFactor = Math.max(1.3, easeFactor + 0.1 - (5 - quality) * 0.08);
  } else {
    repetitions = 0;
    interval = 1;
  }

  const nextReviewDate = new Date();
  nextReviewDate.setDate(nextReviewDate.getDate() + interval);

  return {
    ...record,
    easeFactor,
    interval,
    repetitions,
    nextReviewDate: nextReviewDate.toISOString().slice(0, 10),
    lastReviewedAt: new Date().toISOString(),
  };
}

function qualityFromScores(meaningScore, blankScore, spellingScore) {
  // Map game scores to SM-2 quality; use the minimum across all task types
  const scoreToQuality = { correct: 5, retry: 3, wrong: 1 };
  const mq = scoreToQuality[meaningScore] ?? 1;
  const bq = scoreToQuality[blankScore] ?? 1;
  const sq = scoreToQuality[spellingScore] ?? 1;
  return Math.min(mq, bq, sq);
}

// ── Public API ────────────────────────────────────────────────────────────────

// Called at the end of a game. `session` shape:
//   { gameType, context: { bookTitle, bookHash, chapterTitle }, wordResults: [...] }
// where each wordResult is: { word, taskType, firstTry, attempts }
export async function recordSession(session) {
  const data = await loadData();

  // 1. Append session with generated id and timestamp
  const fullSession = {
    ...session,
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    completedAt: new Date().toISOString(),
  };
  data.sessions.push(fullSession);

  // 2. Update WordRecord for each word in the session
  const now = new Date().toISOString();
  const { context } = session;

  // Group results by word
  const byWord = {};
  for (const r of session.wordResults) {
    if (!byWord[r.word]) byWord[r.word] = {};
    byWord[r.word][r.taskType] = r;
  }

  for (const [word, tasks] of Object.entries(byWord)) {
    const key = word.toLowerCase();
    const existing = data.wordRecords[key];

    const meaningScore  = tasks["meaning"]?.firstTry ? "correct" : (tasks["meaning"] ? "retry" : null);
    const blankScore    = tasks["fill-blank"]?.firstTry ? "correct" : (tasks["fill-blank"] ? "retry" : null);
    const spellingScore = tasks["spelling"]?.firstTry ? "correct" : (tasks["spelling"] ? "retry" : null);
    const quality = qualityFromScores(meaningScore ?? "wrong", blankScore ?? "wrong", spellingScore ?? "wrong");

    if (!existing) {
      // First time seeing this word — create record, then apply first SM-2 update
      const fresh = {
        word: key,
        firstSeenAt: now,
        sources: [{ bookTitle: context.bookTitle, bookHash: context.bookHash, chapterTitle: context.chapterTitle }],
        easeFactor: 2.5,
        interval: 1,
        repetitions: 0,
        nextReviewDate: new Date().toISOString().slice(0, 10),
        lastReviewedAt: null,
      };
      data.wordRecords[key] = sm2Update(fresh, quality);
    } else {
      // Merge new source if not already present
      const alreadyHasSource = existing.sources?.some(s => s.bookHash === context.bookHash && s.chapterTitle === context.chapterTitle);
      if (!alreadyHasSource) {
        existing.sources = [...(existing.sources || []), { bookTitle: context.bookTitle, bookHash: context.bookHash, chapterTitle: context.chapterTitle }];
      }
      data.wordRecords[key] = sm2Update(existing, quality);
    }
  }

  await saveData(data);
  return fullSession;
}

// Returns all words due for review today, most overdue first.
export async function getReviewQueue() {
  const data = await loadData();
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(data.wordRecords)
    .filter(r => r.nextReviewDate <= today)
    .sort((a, b) => a.nextReviewDate.localeCompare(b.nextReviewDate));
}

// Returns the WordRecord for a single word, or null if never seen.
export async function getWordRecord(word) {
  const data = await loadData();
  return data.wordRecords[word.toLowerCase()] ?? null;
}

// Returns all sessions, optionally filtered by gameType.
export async function getSessions({ gameType } = {}) {
  const data = await loadData();
  if (gameType) return data.sessions.filter(s => s.gameType === gameType);
  return data.sessions;
}

// Exports the full data blob as a downloaded JSON file.
export async function exportData(filename = "vocab-quest-progress.json") {
  const data = await loadData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
