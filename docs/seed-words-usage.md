# Seed Words: Managing the Review Queue for Playtesting

The seed script (`scripts/seed-words.mjs`) populates the review queue with SAT vocabulary words that aren't tied to any book chapter. It generates quiz data (definitions, MC options, hints) via Claude and writes word records to the KV store.

The server must be running before you use any of these commands (`npm run server` or `npm run dev`).

---

## Common tasks

### Seed all words (first time)

```bash
node scripts/seed-words.mjs
```

Creates quiz data and word records for all 46 words. Skips any that already have quiz data cached.

### Preview what would be seeded without making changes

```bash
node scripts/seed-words.mjs --dry-run
```

### Seed only one difficulty tier

```bash
node scripts/seed-words.mjs --tier review      # 14 easier words (AoA 8-10)
node scripts/seed-words.mjs --tier learning     # 16 mid-level words (AoA 10-13)
node scripts/seed-words.mjs --tier challenge    # 16 harder words (AoA 13-16)
```

### Seed a small batch for quick testing

```bash
node scripts/seed-words.mjs --count 5
```

### Regenerate quiz data (new definitions/options/hints from Claude)

```bash
node scripts/seed-words.mjs --reseed
```

Overwrites existing quiz cache entries. Useful if definitions feel off or you want fresh distractors.

### Add new words

Edit the `SEED_WORDS` array in `scripts/seed-words.mjs`, then run:

```bash
node scripts/seed-words.mjs
```

It only generates quiz data for words that don't already have a cache entry.

---

## Resetting progress for re-playtesting

### Wipe all progress and re-seed from scratch

```bash
curl -X DELETE http://localhost:3001/api/kv/vocab-quest-data
node scripts/seed-words.mjs
```

This deletes **all** SM-2 progress (including words learned from book chapters), then re-creates word records for the seed words with `nextReviewDate = today` so they appear in the review queue immediately.

### Wipe progress but keep quiz data (faster, no Claude calls)

```bash
curl -X DELETE http://localhost:3001/api/kv/vocab-quest-data
node scripts/seed-words.mjs
```

Same as above — the seed script detects that quiz cache entries still exist and skips regeneration. Only the word records are recreated.

---

## How it works

The seed script writes two things per word:

1. **Per-word quiz cache** (`quiz-word-{word}`) — the MC options, hint, context sentence, morphological root, and difficulty tier. This is what `ReviewLoadingPhase` reads to build exercises.

2. **Word record** (inside `vocab-quest-data`) — the SM-2 state that makes the word appear in `getReviewQueue()`. Seeded words have `nextReviewDate = today` and `bookHash: null` (since they don't come from a book chapter).
