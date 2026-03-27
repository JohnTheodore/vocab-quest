# Spaced Repetition Data Model — Design Spec

**Project:** Vocabulary Quest
**Status:** Implemented
**Scope:** Data model and engine design for tracking vocabulary game results and scheduling word reviews across multiple game types.

---

## Goals

1. Record which words a learner has encountered and how well they performed.
2. Use that history to schedule future reviews using a spaced repetition algorithm.
3. Support multiple vocabulary game types (current and future) feeding into a single shared model.
4. Persist data on the server via the key-value store API (`/api/kv/:key`), backed by JSON files in the `data/` directory.

---

## Design Principles

- **Word-centric, not game-centric.** The spaced repetition engine tracks knowledge of a *word*, regardless of which game produced the evidence. Games are interchangeable input sources.
- **Append-only session log.** Raw game results are never mutated — they are logged as immutable session records. The SR state on each word is derived from this log over time.
- **Minimal coupling.** New games only need to produce a `GameSession` record in the standard format. No changes to the SR engine are required.

---

## Data Model

### 1. `WordRecord`

One record per unique word, ever seen across all games and books. This is the primary entity that the spaced repetition engine reads and writes.

```jsonc
{
  "word": "languidly",
  "normalizedWord": "languidly",         // lowercase, used as the storage key
  "firstSeenAt": "2026-03-21T10:00:00Z",
  "sources": [                           // all books/contexts where this word appeared
    {
      "bookTitle": "A Little Princess",
      "bookHash": "abc123",              // SHA-256 of book text (already computed by app)
      "chapterTitle": "Chapter 5"
    }
  ],

  // SM-2 spaced repetition state
  "easeFactor": 2.5,                     // retention difficulty multiplier; starts at 2.5
  "interval": 1,                         // days until next review
  "repetitions": 3,                      // consecutive successful reviews
  "nextReviewDate": "2026-03-25",        // ISO date (date only, no time)
  "lastReviewedAt": "2026-03-21T10:00:00Z"
}
```

All word records are stored together in a single blob under the `vocab-quest-data` key (see Storage section below).

---

### 2. `GameSession`

One record per completed game. This is an append-only log — existing sessions are never modified.

```jsonc
{
  "id": "sess_20260321_a1b2c3",          // timestamp + random suffix
  "gameType": "vocab-quest",             // identifies the game that produced this session
  "completedAt": "2026-03-21T10:30:00Z",
  "context": {                           // game-specific metadata; schema varies by gameType
    "bookTitle": "A Little Princess",
    "bookHash": "abc123",
    "chapterTitle": "Chapter 5"
  },
  "wordResults": [                       // one entry per word × task combination
    {
      "word": "languidly",
      "taskType": "meaning",             // what kind of question was asked
      "firstTry": true,                  // true = answered correctly without any wrong guesses
      "attempts": 1                      // total attempts including wrong ones
    },
    {
      "word": "languidly",
      "taskType": "fill-blank",
      "firstTry": false,
      "attempts": 2
    }
  ]
}
```

All sessions are stored together in the same `vocab-quest-data` blob alongside word records (see Storage section below).

---

### 3. Review Queue (derived, not stored)

The review queue is not a stored entity. It is computed on demand by loading all `WordRecord` entries and filtering:

```
reviewQueue = all WordRecords where nextReviewDate <= today, sorted by nextReviewDate ascending
```

An optional `review-queue-cache` key may be written after each session to avoid re-scanning all word records on startup, but it is treated as a disposable cache and always validated against the current date.

---

## Spaced Repetition Algorithm

The engine uses a simplified version of **SM-2** (SuperMemo 2), the algorithm behind Anki and most modern flashcard systems.

### Quality score mapping

The single most important signal from each game result is `firstTry`. This maps to an SM-2 quality score (0–5):

| Result | Quality |
|---|---|
| Correct on first try | 5 — perfect recall |
| Correct after hints/wrong guesses | 3 — recalled with difficulty |
| Never answered correctly | 1 — blackout |

When a word has multiple `taskType` results in a session (e.g. both `meaning` and `fill-blank` in a chapter session), the **minimum** quality score across all **present** tasks is used. Task types not present in the session are ignored — they are not counted as "wrong". This is important for review sessions where each word has only one exercise type: a correct spelling exercise should produce quality 5, not quality 1 because meaning and fill-blank are "missing."

### SM-2 update rules

Applied to a `WordRecord` after each session in which that word appeared:

```
if quality >= 3:
  if repetitions == 0:  interval = 1
  if repetitions == 1:  interval = 6
  if repetitions >= 2:  interval = round(interval × easeFactor)
  repetitions += 1
  easeFactor = max(1.3, easeFactor + 0.1 − (5 − quality) × 0.08)
else:
  repetitions = 0
  interval = 1

nextReviewDate = today + interval days
```

---

## Session Processing Flow

When a game ends (the player reaches the results screen), the app performs the following steps:

```
1. Generate a new session ID
2. Write a GameSession record to storage
3. Append the session ID to session-index
4. For each unique word in the session:
   a. Load (or create) its WordRecord
   b. Compute the quality score from the session's wordResults for that word
   c. Run the SM-2 update
   d. Merge any new source context into sources[]
   e. Write the updated WordRecord back to storage
5. Invalidate (or recompute) the review-queue-cache
```

Step 4 is the only place where `WordRecord` is mutated. Steps 2–3 are append-only.

---

## Extensibility: Adding New Games

New game types integrate by producing a `GameSession` record with the correct `gameType` and `taskType` values. The spaced repetition engine is unchanged.

### Existing and planned game types

| Game | `gameType` | `taskType` values | Status |
|---|---|---|---|
| Chapter Play | `vocab-quest` | `meaning`, `fill-blank`, `spelling` | Implemented |
| Review Practice | `review` | one of: `meaning`, `fill-blank`, `spelling` | Implemented |
| Free Recall (planned) | `review` | `recall` | Planned |
| Sentence Generation (planned) | `review` | `sentence` | Planned |

### Adding a new game

1. When the game ends, construct a `GameSession` with the appropriate `gameType`, `context`, and `wordResults[]`.
2. Ensure each `wordResult` includes `word`, `taskType`, `firstTry`, and `attempts`.
3. Pass the session to the shared `recordSession()` function (see API below).

No other changes are required.

---

## JavaScript API

The module `src/wordRecords.js` wraps the storage layer and exports:

```js
// Called at the end of any game to persist results and update SR state.
// `session` is a GameSession object (without the id, which is generated internally).
// Returns the full session object with generated id and timestamp.
export async function recordSession(session): Promise<GameSession>

// Returns all words due for review today, sorted by urgency (most overdue first).
export async function getReviewQueue(): Promise<WordRecord[]>

// Returns the earliest upcoming review date and count of words due on that date.
// Used by the UI to show "All caught up! Next review: 3 words on Thursday."
export async function getNextReviewDate(): Promise<{ date: string, count: number } | null>

// Returns the full history for a single word, or null if never seen.
export async function getWordRecord(word): Promise<WordRecord | null>

// Returns all sessions, optionally filtered by gameType.
export async function getSessions(options?: { gameType?: string }): Promise<GameSession[]>

// Downloads the full data blob as a JSON file (manual backup).
export async function exportData(filename?: string): Promise<void>
```

---

## Storage

All spaced repetition data is stored as a single JSON blob under the key `vocab-quest-data`, with the structure:

```jsonc
{
  "wordRecords": { "languidly": { /* WordRecord */ }, ... },
  "sessions": [ { /* GameSession */ }, ... ]
}
```

This key is managed through the server-side key-value store (`/api/kv/vocab-quest-data`), which persists it as a JSON file in the `data/` directory. The client-side `storageGet`/`storageSet` helpers in `src/App.jsx` call the KV API via `window.storage`, which is wired to the server endpoints at app startup.

---

## Open Questions

1. **Deduplication across books.** If "languidly" appears in two different books, should it be one `WordRecord` or two? This spec treats it as one (normalized word is the key), with multiple entries in `sources[]`. This is the right call for SR purposes — knowledge of a word transfers across books.

2. **Review game UX.** **Resolved and implemented.** See `docs/review-queue-implementation.md` for the full design and implementation status. Key decisions: reviews pull from all due words across all books (not chapter-scoped), each word gets one exercise per session matched to its SM-2 maturity level, exercise types are interleaved, and sessions feed back into the standard `GameSession` / `WordRecord` model using `gameType: "review"`. Words can also be seeded independently of books via `scripts/seed-words.mjs`.
