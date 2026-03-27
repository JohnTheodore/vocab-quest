# Review Queue Implementation

**Status:** Implemented (milestone 1)

The review queue lets players practice words from across all their books (and seeded SAT vocabulary) in short, interleaved sessions. This is the first milestone: existing exercise types (MC, fill-in-blank, spelling) matched to word maturity.

---

## How it works

### Entry point

The home screen shows a green "Practice N words" banner when words are due for review. If no words are due, it shows "All caught up!" with the next review date. Clicking the banner enters the review flow directly — no book/chapter selection needed.

**Implementation:** `UploadPhase` calls `getReviewQueue()` and `getNextReviewDate()` on mount.

### Word selection

Takes the top 5 due words per session, prioritized by most overdue first (`getReviewQueue()` sorts by `nextReviewDate` ascending). Players can start another session for more words.

**Why 5:** Short sessions reduce the "I don't have time" barrier (Drops' time-boxing insight) and the player can always do another round.

### Exercise assignment by maturity

Each word gets one exercise type based on its SM-2 repetition count:

| SM-2 State | Exercise Type | Why |
|---|---|---|
| `repetitions 0-1` | MC meaning | Just learned or just failed — low friction to rebuild the link |
| `repetitions 2-3` | Fill-in-blank | Cued recall for familiar words |
| `repetitions 4+` | Spelling | Approaching mastery — no definition cues |

**Implementation:** `assignExerciseType()` function in `App.jsx`.

As new exercise types are built (free recall, sentence generation, morphological analysis), they'll slot into the higher maturity tiers.

### Asset retrieval

Review words need quiz data (MC options, hints) that was generated when the word was first played or seeded. Two sources:

1. **Per-word quiz cache** (`quiz-word-{word}`) — written by `generateAllWordAssets()` during chapter play and by `scripts/seed-words.mjs` during seeding. Directly addressable by word.
2. **Chapter caches** — for book-sourced words, the original paragraph and illustration are looked up via the word's `source.bookHash` and `source.chapterTitle`.

For seeded words (`bookHash: null`), the context sentence is stored directly in the per-word quiz cache entry.

If no quiz data is found, the word falls back to a spelling exercise (which doesn't need MC options).

**Implementation:** `ReviewLoadingPhase` component in `App.jsx`.

### Interleaved queue

The queue is shuffled (Fisher-Yates) after assignment so exercise types are mixed rather than grouped. Kornell & Bjork (2008): interleaving improved learning by 43% vs. blocking.

### Game phase

`ReviewGamePhase` is a separate component from the chapter `GamePhase`. It's simpler: one pass through the queue, one exercise per word, renders MeaningCard / BlankCard / SpellCard based on each entry's type.

The score model is `{ word → { score, exerciseType } }` instead of the chapter flow's `{ word → { meaning, blank, spelling } }`.

### Session recording

On the results screen, `ReviewResultsPhase` calls `recordSession()` with `gameType: "review"`. Each word produces one `wordResult` with the appropriate `taskType`.

**Quality scoring fix:** `recordSession()` in `wordRecords.js` was updated to only score task types actually present in the session. Previously, missing types defaulted to "wrong" (quality 1), which would have penalized review words that only get one exercise. Now it filters to `presentScores` and takes the minimum of only those.

### Results display

Single-column layout showing each word with its score and exercise type label. Simpler than the chapter flow's 3-column meaning × blank × spelling grid.

---

## Components

| Component | File | Status |
|---|---|---|
| `getReviewQueue()` | `src/wordRecords.js` | Implemented |
| `getNextReviewDate()` | `src/wordRecords.js` | Implemented |
| `assignExerciseType()` | `src/App.jsx` | Implemented |
| `ReviewLoadingPhase` | `src/App.jsx` | Implemented |
| `ReviewGamePhase` | `src/App.jsx` | Implemented |
| `ReviewResultsPhase` | `src/App.jsx` | Implemented |
| Review banner in `UploadPhase` | `src/App.jsx` | Implemented |
| Per-word quiz cache writes | `src/App.jsx` (`generateAllWordAssets`) | Implemented |
| Single-exercise quality scoring | `src/wordRecords.js` (`recordSession`) | Implemented |
| Seed script | `scripts/seed-words.mjs` | Implemented |
| Review queue tests | `test/review-queue.test.mjs` | 21 tests passing |

---

## Next milestones

See `docs/exercise-design-research.md` for the full roadmap. In priority order:

1. **Free recall** — "Type what this word means" with Claude scoring. Biggest retention improvement.
2. **Morphological analysis** — Group words by shared Latin/Greek roots. Requires storing root info (already captured in seed data).
3. **Sentence generation** — "Use this word in a sentence" with Claude scoring. Highest difficulty.
4. **Context variation** — Claude generates new example sentences for later reviews instead of always showing the original paragraph.
