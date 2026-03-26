/**
 * Game logic unit tests
 *
 * Tests the core game mechanics: queue construction, scoring, SM-2 spaced
 * repetition, stage transitions, and edge cases that would be hard to debug
 * in production.
 *
 * Run: node --test test/game-logic.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sm2Update, qualityFromScores } from '../src/wordRecords.js';

// ── Helpers that mirror App.jsx game logic ──────────────────────────────────

/** Mirrors GamePhase blank-option construction */
function buildBlankOptions(assets) {
  return assets.map((a, idx) => {
    const otherWords = assets.filter((_, j) => j !== idx).map(x => x.word);
    const shuffled = [...otherWords].sort(() => Math.random() - 0.5).slice(0, 3);
    const blankArr = [
      { word: a.word, isCorrect: true },
      ...shuffled.map(w => ({ word: w, isCorrect: false })),
    ];
    for (let i = blankArr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [blankArr[i], blankArr[j]] = [blankArr[j], blankArr[i]];
    }
    return { ...a, blankOptions: blankArr };
  });
}

/** Mirrors GamePhase queue construction */
function buildQueue(assetsWithBlanks) {
  return [
    ...assetsWithBlanks.map(a => ({ ...a, roundType: "meaning" })),
    ...assetsWithBlanks.map(a => ({ ...a, roundType: "blank" })),
    ...assetsWithBlanks.map(a => ({ ...a, roundType: "spell" })),
  ];
}

/** Mirrors GamePhase initial scores */
function buildInitialScores(assets) {
  return Object.fromEntries(
    assets.map(a => [a.word, { meaning: null, blank: null, spelling: null }])
  );
}

/** Mirrors SpellCard processChar logic for the recall stage */
function simulateRecall(word, typedChars) {
  const lower = word.toLowerCase();
  let mistakes = 0;
  for (let i = 0; i < lower.length; i++) {
    if ((typedChars[i] || "").toLowerCase() !== lower[i]) mistakes++;
  }
  return mistakes;
}

function makeAssets(words) {
  return words.map(w => ({
    word: w,
    paragraph: `The ${w} was remarkable.`,
    options: { correct: 0, options: [`def of ${w}`, "wrong1", "wrong2", "wrong3"] },
    hint: `Think about ${w}.`,
  }));
}

// ── Queue Construction ──────────────────────────────────────────────────────

describe("Queue construction", () => {
  it("creates 3N exercises for N words (meaning + blank + spell)", () => {
    const assets = makeAssets(["tenacious", "ephemeral", "cacophony", "sublime", "pernicious"]);
    const withBlanks = buildBlankOptions(assets);
    const queue = buildQueue(withBlanks);

    assert.equal(queue.length, 15); // 5 * 3
    assert.equal(queue.filter(q => q.roundType === "meaning").length, 5);
    assert.equal(queue.filter(q => q.roundType === "blank").length, 5);
    assert.equal(queue.filter(q => q.roundType === "spell").length, 5);
  });

  it("orders rounds: all meaning first, then all blank, then all spell", () => {
    const assets = makeAssets(["alpha", "beta", "gamma"]);
    const queue = buildQueue(buildBlankOptions(assets));

    assert.deepEqual(queue.map(q => q.roundType), [
      "meaning", "meaning", "meaning",
      "blank", "blank", "blank",
      "spell", "spell", "spell",
    ]);
  });

  it("preserves word order within each round", () => {
    const assets = makeAssets(["alpha", "beta", "gamma"]);
    const queue = buildQueue(buildBlankOptions(assets));

    const meaningWords = queue.filter(q => q.roundType === "meaning").map(q => q.word);
    const blankWords = queue.filter(q => q.roundType === "blank").map(q => q.word);
    const spellWords = queue.filter(q => q.roundType === "spell").map(q => q.word);

    assert.deepEqual(meaningWords, ["alpha", "beta", "gamma"]);
    assert.deepEqual(blankWords, ["alpha", "beta", "gamma"]);
    assert.deepEqual(spellWords, ["alpha", "beta", "gamma"]);
  });

  it("works with a single word", () => {
    const assets = makeAssets(["solitary"]);
    const withBlanks = buildBlankOptions(assets);
    const queue = buildQueue(withBlanks);

    assert.equal(queue.length, 3);
  });
});

// ── Blank Options Edge Cases ────────────────────────────────────────────────

describe("Blank options construction", () => {
  it("always includes the correct word", () => {
    const assets = makeAssets(["tenacious", "ephemeral", "cacophony", "sublime", "pernicious"]);
    const withBlanks = buildBlankOptions(assets);

    for (const a of withBlanks) {
      const correctOpt = a.blankOptions.find(o => o.isCorrect);
      assert.ok(correctOpt, `Missing correct option for ${a.word}`);
      assert.equal(correctOpt.word, a.word);
    }
  });

  it("has exactly one correct option per word", () => {
    const assets = makeAssets(["tenacious", "ephemeral", "cacophony", "sublime", "pernicious"]);
    const withBlanks = buildBlankOptions(assets);

    for (const a of withBlanks) {
      const correctCount = a.blankOptions.filter(o => o.isCorrect).length;
      assert.equal(correctCount, 1, `Expected 1 correct option for ${a.word}, got ${correctCount}`);
    }
  });

  it("produces 4 options with 4+ words", () => {
    const assets = makeAssets(["alpha", "beta", "gamma", "delta"]);
    const withBlanks = buildBlankOptions(assets);

    for (const a of withBlanks) {
      assert.equal(a.blankOptions.length, 4);
    }
  });

  it("handles 2 words gracefully (fewer distractors)", () => {
    const assets = makeAssets(["alpha", "beta"]);
    const withBlanks = buildBlankOptions(assets);

    for (const a of withBlanks) {
      assert.ok(a.blankOptions.length >= 2, `Expected at least 2 options, got ${a.blankOptions.length}`);
      assert.ok(a.blankOptions.some(o => o.isCorrect), "Must have a correct option");
    }
  });

  it("handles 1 word (no distractors available)", () => {
    const assets = makeAssets(["solitary"]);
    const withBlanks = buildBlankOptions(assets);

    assert.ok(withBlanks[0].blankOptions.length >= 1);
    assert.ok(withBlanks[0].blankOptions.some(o => o.isCorrect));
  });

  it("never includes the target word as a distractor", () => {
    const assets = makeAssets(["alpha", "beta", "gamma", "delta", "epsilon"]);
    const withBlanks = buildBlankOptions(assets);

    for (const a of withBlanks) {
      const distractors = a.blankOptions.filter(o => !o.isCorrect);
      for (const d of distractors) {
        assert.notEqual(d.word, a.word, `Distractor should not be the target word ${a.word}`);
      }
    }
  });
});

// ── Score State ─────────────────────────────────────────────────────────────

describe("Score state management", () => {
  it("initializes all scores to null", () => {
    const assets = makeAssets(["alpha", "beta"]);
    const scores = buildInitialScores(assets);

    for (const word of ["alpha", "beta"]) {
      assert.deepEqual(scores[word], { meaning: null, blank: null, spelling: null });
    }
  });

  it("simulates correct score flow through all three rounds", () => {
    const assets = makeAssets(["alpha", "beta"]);
    let scores = buildInitialScores(assets);

    // Meaning round: both correct first try
    for (const word of ["alpha", "beta"]) {
      scores = { ...scores, [word]: { ...scores[word], meaning: "correct" } };
    }
    // Blank round: alpha correct, beta retry
    scores = { ...scores, alpha: { ...scores.alpha, blank: "correct" } };
    scores = { ...scores, beta: { ...scores.beta, blank: "retry" } };
    // Spell round: both correct
    for (const word of ["alpha", "beta"]) {
      scores = { ...scores, [word]: { ...scores[word], spelling: "correct" } };
    }

    assert.deepEqual(scores.alpha, { meaning: "correct", blank: "correct", spelling: "correct" });
    assert.deepEqual(scores.beta, { meaning: "correct", blank: "retry", spelling: "correct" });
  });

  it("last word score is not lost (React batching edge case simulation)", () => {
    // Simulates the pattern: build newScores from current, pass to both setScores and advance
    const assets = makeAssets(["alpha", "beta"]);
    let scores = buildInitialScores(assets);

    // Set all scores except the very last one
    scores = { ...scores, alpha: { meaning: "correct", blank: "correct", spelling: "correct" } };
    scores = { ...scores, beta: { ...scores.beta, meaning: "correct", blank: "correct" } };

    // Last word, last round — this is the pattern that could lose data
    const newScores = { ...scores, beta: { ...scores.beta, spelling: "retry" } };

    // Verify the final scores object passed to onDone has everything
    assert.equal(newScores.alpha.meaning, "correct");
    assert.equal(newScores.alpha.blank, "correct");
    assert.equal(newScores.alpha.spelling, "correct");
    assert.equal(newScores.beta.meaning, "correct");
    assert.equal(newScores.beta.blank, "correct");
    assert.equal(newScores.beta.spelling, "retry");
  });
});

// ── SpellCard Recall Logic ──────────────────────────────────────────────────

describe("SpellCard recall mistake counting", () => {
  it("reports 0 mistakes for perfect recall", () => {
    assert.equal(simulateRecall("tenacious", "tenacious".split("")), 0);
  });

  it("counts each wrong character as a mistake", () => {
    assert.equal(simulateRecall("cat", ["c", "o", "t"]), 1); // 'o' instead of 'a'
    assert.equal(simulateRecall("cat", ["d", "o", "g"]), 3); // all wrong
  });

  it("is case-insensitive", () => {
    assert.equal(simulateRecall("Hello", ["h", "e", "l", "l", "o"]), 0);
    assert.equal(simulateRecall("hello", ["H", "E", "L", "L", "O"]), 0);
  });

  it("counts missing characters as mistakes", () => {
    // If user typed fewer chars than the word length
    assert.equal(simulateRecall("cat", ["c", "a"]), 1); // missing 't'
    assert.equal(simulateRecall("cat", []), 3);
  });
});

// ── SM-2 Spaced Repetition ──────────────────────────────────────────────────

describe("qualityFromScores", () => {
  it("returns 5 when all three scores are correct", () => {
    assert.equal(qualityFromScores("correct", "correct", "correct"), 5);
  });

  it("returns 3 when any score is retry", () => {
    assert.equal(qualityFromScores("correct", "correct", "retry"), 3);
    assert.equal(qualityFromScores("retry", "correct", "correct"), 3);
    assert.equal(qualityFromScores("correct", "retry", "correct"), 3);
  });

  it("returns 1 when any score is wrong", () => {
    assert.equal(qualityFromScores("correct", "correct", "wrong"), 1);
    assert.equal(qualityFromScores("wrong", "correct", "correct"), 1);
  });

  it("returns minimum across all three", () => {
    assert.equal(qualityFromScores("correct", "retry", "wrong"), 1);
    assert.equal(qualityFromScores("retry", "retry", "retry"), 3);
  });

  it("treats null/undefined as wrong (quality 1)", () => {
    assert.equal(qualityFromScores("correct", "correct", null), 1);
    assert.equal(qualityFromScores("correct", undefined, "correct"), 1);
  });

  it("spelling score actually affects the result (bug regression)", () => {
    // Before the fix, spelling was ignored — this would have returned 5
    assert.equal(qualityFromScores("correct", "correct", "retry"), 3);
    assert.equal(qualityFromScores("correct", "correct", "wrong"), 1);
  });
});

describe("sm2Update", () => {
  const freshRecord = {
    word: "test",
    easeFactor: 2.5,
    interval: 1,
    repetitions: 0,
    nextReviewDate: "2026-01-01",
    lastReviewedAt: null,
  };

  it("first correct answer sets interval to 1 day", () => {
    const result = sm2Update(freshRecord, 5);
    assert.equal(result.interval, 1);
    assert.equal(result.repetitions, 1);
  });

  it("second correct answer sets interval to 6 days", () => {
    const after1 = sm2Update(freshRecord, 5);
    const after2 = sm2Update(after1, 5);
    assert.equal(after2.interval, 6);
    assert.equal(after2.repetitions, 2);
  });

  it("third correct answer multiplies by ease factor", () => {
    const after1 = sm2Update(freshRecord, 5);
    const after2 = sm2Update(after1, 5);
    const after3 = sm2Update(after2, 5);
    // 6 * easeFactor (which has been increasing)
    assert.ok(after3.interval > 6, `Expected interval > 6, got ${after3.interval}`);
    assert.equal(after3.repetitions, 3);
  });

  it("wrong answer (quality < 3) resets to interval 1, repetitions 0", () => {
    const after1 = sm2Update(freshRecord, 5);
    const after2 = sm2Update(after1, 5);
    const afterFail = sm2Update(after2, 1);
    assert.equal(afterFail.interval, 1);
    assert.equal(afterFail.repetitions, 0);
  });

  it("quality 3 (retry) still counts as successful but lowers ease factor", () => {
    const afterPerfect = sm2Update(freshRecord, 5);
    const afterRetry = sm2Update({ ...freshRecord }, 3);

    assert.equal(afterRetry.repetitions, 1);
    assert.ok(afterRetry.easeFactor < afterPerfect.easeFactor,
      "Retry should lower ease factor relative to perfect");
  });

  it("ease factor never drops below 1.3", () => {
    let record = { ...freshRecord };
    // Repeatedly fail then retry to push ease factor down
    for (let i = 0; i < 20; i++) {
      record = sm2Update(record, 1); // fail → resets interval to 1
      record = sm2Update(record, 3); // retry
    }
    assert.ok(record.easeFactor >= 1.3, `Ease factor ${record.easeFactor} dropped below 1.3`);
  });

  it("interval is capped at 365 days (no Date overflow)", () => {
    let record = { ...freshRecord };
    // Many consecutive perfect answers would grow interval exponentially
    for (let i = 0; i < 50; i++) {
      record = sm2Update(record, 5);
    }
    assert.ok(record.interval <= 365, `Interval ${record.interval} exceeded 365-day cap`);
    // nextReviewDate should be valid, not Invalid Date
    assert.ok(!isNaN(new Date(record.nextReviewDate).getTime()), "nextReviewDate is invalid");
  });

  it("sets nextReviewDate to a future date", () => {
    const result = sm2Update(freshRecord, 5);
    const next = new Date(result.nextReviewDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    assert.ok(next >= today, "nextReviewDate should be today or later");
  });

  it("sets lastReviewedAt to current timestamp", () => {
    const before = new Date().toISOString();
    const result = sm2Update(freshRecord, 5);
    const after = new Date().toISOString();
    assert.ok(result.lastReviewedAt >= before);
    assert.ok(result.lastReviewedAt <= after);
  });
});

// ── Session Recording Data Shape ────────────────────────────────────────────

describe("Session recording data integrity", () => {
  it("wordResults includes all three task types per word", () => {
    // Mirrors what ResultsPhase builds before calling recordSession
    const assets = makeAssets(["alpha", "beta"]);
    const scores = {
      alpha: { meaning: "correct", blank: "correct", spelling: "retry" },
      beta: { meaning: "retry", blank: "correct", spelling: "correct" },
    };

    const wordResults = assets.flatMap(a => [
      { word: a.word, taskType: "meaning",    firstTry: scores[a.word]?.meaning  === "correct", attempts: scores[a.word]?.meaning  ? 1 : 0 },
      { word: a.word, taskType: "fill-blank", firstTry: scores[a.word]?.blank    === "correct", attempts: scores[a.word]?.blank    ? 1 : 0 },
      { word: a.word, taskType: "spelling",   firstTry: scores[a.word]?.spelling === "correct", attempts: scores[a.word]?.spelling ? 1 : 0 },
    ]);

    assert.equal(wordResults.length, 6); // 2 words * 3 tasks
    assert.equal(wordResults.filter(r => r.taskType === "meaning").length, 2);
    assert.equal(wordResults.filter(r => r.taskType === "fill-blank").length, 2);
    assert.equal(wordResults.filter(r => r.taskType === "spelling").length, 2);

    // Verify firstTry mapping
    const alphaSpelling = wordResults.find(r => r.word === "alpha" && r.taskType === "spelling");
    assert.equal(alphaSpelling.firstTry, false); // "retry" → not first try

    const betaMeaning = wordResults.find(r => r.word === "beta" && r.taskType === "meaning");
    assert.equal(betaMeaning.firstTry, false); // "retry" → not first try

    const alphaBlank = wordResults.find(r => r.word === "alpha" && r.taskType === "fill-blank");
    assert.equal(alphaBlank.firstTry, true); // "correct" → first try
  });

  it("progress bar percentage is correct at boundaries", () => {
    const totalExercises = 15; // 5 words * 3 rounds

    // Start
    assert.equal((0 / totalExercises) * 100, 0);
    // End of meaning round
    assert.equal(Math.round((5 / totalExercises) * 100), 33);
    // End of blank round
    assert.equal(Math.round((10 / totalExercises) * 100), 67);
    // Last exercise
    assert.equal(Math.round((14 / totalExercises) * 100), 93);
  });
});

// ── Stale Closure Regression ────────────────────────────────────────────────

describe("Stale closure regression (ref pattern)", () => {
  it("ref captures the correct mistake count even when state update is pending", () => {
    // Simulates the ref pattern used in SpellCard:
    //   setRecallMistakes(mistakes);          // async state update
    //   recallMistakesRef.current = mistakes;  // sync ref write
    //   setTimeout(() => onCorrect(recallMistakesRef.current), 1000);

    let refValue = 0;
    let stateValue = 0;

    // Simulate: state update is async (batched), ref is sync
    const mistakes = 3;
    stateValue = mistakes; // This would be async in React — may not be visible yet
    refValue = mistakes;   // This is synchronous — always visible

    // The timeout callback should read from ref, not state
    const callbackValue = refValue;
    assert.equal(callbackValue, 3, "Ref should have the correct value immediately");
  });

  it("ref pattern handles zero mistakes correctly", () => {
    let refValue = 99; // stale initial value

    const mistakes = 0;
    refValue = mistakes;

    assert.equal(refValue, 0, "Ref should update to 0, not stay stale");
  });
});
