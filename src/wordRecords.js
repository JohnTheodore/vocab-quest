// ── Word Records & Spaced Repetition ─────────────────────────────────────────

const STORAGE_KEY = "vocab-quest-data";

async function loadData() {
  try {
    if (window.storage) {
      const result = await window.storage.get(STORAGE_KEY);
      return result ? JSON.parse(result.value) : { wordRecords: {}, sessions: [] };
    } else {
      const val = localStorage.getItem(STORAGE_KEY);
      return val ? JSON.parse(val) : { wordRecords: {}, sessions: [] };
    }
  } catch { return { wordRecords: {}, sessions: [] }; }
}

async function saveData(data) {
  try {
    if (window.storage) {
      await window.storage.set(STORAGE_KEY, JSON.stringify(data));
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch (e) { console.warn("wordRecords: storage write failed:", e); }
}

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

export async function recordSession(session) {
  const data = await loadData();
  const fullSession = {
    ...session,
    id: `sess_${Date.now()}`,
    completedAt: new Date().toISOString(),
  };
  data.sessions.push(fullSession);

  for (const r of session.wordResults) {
    const key = r.word.toLowerCase();
    const existing = data.wordRecords[key] || {
      word: key,
      easeFactor: 2.5,
      interval: 1,
      repetitions: 0,
      nextReviewDate: new Date().toISOString().slice(0, 10),
    };
    const quality = r.firstTry ? 5 : 3;
    data.wordRecords[key] = sm2Update(existing, quality);
  }

  await saveData(data);
  return fullSession;
}

export async function exportData() {
  const data = await loadData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vocab-quest-progress.json";
  a.click();
}
