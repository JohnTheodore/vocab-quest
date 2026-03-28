# Vocabulary Dashboard Design Report

## Purpose

Design a dashboard that presents vocabulary mastery data in a useful, digestible way as the word count scales to hundreds of words across multiple books.

## Three Questions the Dashboard Must Answer

In priority order:

1. **"What should I do right now?"** — actionable next step (review words, play a new chapter)
2. **"Am I making progress?"** — motivation and momentum
3. **"Where am I weak?"** — targeted effort without cognitive overload

## Key Design Principle

The dashboard is a **window, not a control panel**. The SM-2 algorithm already handles scheduling decisions. The user should never need to manually pick words, interpret numerical scores, or make scheduling decisions.

## Research Foundations

### Evaluability (Hsee, 1996)
Users can't intuit what "easeFactor 2.3" means, but they instantly read a color gradient or icon progression. Mastery should be shown as visual indicators, not numbers.

### Self-Determination Theory (Deci & Ryan)
Autonomy, competence, and relatedness drive intrinsic motivation. The dashboard should emphasize competence (visible progress) and autonomy (choice of what to explore) without competitive framing.

### Spaced Repetition Visualization
Anki's approach of showing card maturity distribution (new/learning/young/mature) as a stacked bar is the gold standard for SR dashboards. Adapt this to the 10-14 age group with friendlier language.

### Cognitive Load (Sweller)
Group words by natural categories (book/chapter context) rather than flat alphabetical lists. Collapse by default. Let users drill down on demand.

## Data Model Mapping

### Mastery Buckets (derived from SM-2 `repetitions` field)
| Repetitions | Label      | Color   | Meaning                        |
|-------------|------------|---------|--------------------------------|
| 0           | New        | Gray    | Seen but not yet reviewed      |
| 1           | Learning   | Orange  | Just started, still fragile    |
| 2-3         | Familiar   | Yellow  | Building strength              |
| 4+          | Mastered   | Green   | Strong retention, long interval|

### Available Data (already in client-side KV store)
- `wordRecords`: per-word SM-2 state, sources (book/chapter), timestamps
- `sessions`: game history with per-word task results
- Derived: `getReviewQueue()`, `getTotalWordCount()`, `getNextReviewDate()`

### New Functions Needed
- `getMasteryDistribution()` — bucket words by repetition count
- `getWordsByBook()` — group words by `sources[0].bookTitle`
- `getWordHistory(word)` — session results for a specific word

## Proposed Layout: Three-Tier Architecture

### Tier 1: Action Banner (always visible, top)
Already exists as review queue banner. Keep as-is: "Practice N words" or "All caught up! Next review Thursday."

### Tier 2: Summary Stats (compact row, ~80px height)
3-4 at-a-glance metrics:
- Total words learned (with optional growth indicator)
- Mastery distribution (stacked bar or donut)
- Weekly activity (7-dot grid, like mini GitHub contribution graph)
- Books with active words

### Tier 3: Word Explorer (scrollable, on demand)
- Grouped by book (collapsible sections)
- Sorted within groups by urgency (overdue first, then lowest mastery)
- Visual mastery indicator per word (dots, bar, or color)
- Tap-to-expand: original passage context, review history, next review date
- Search/filter bar (by mastery level, book, or text)

## What to Skip
- **Leaderboards / social comparison** — wrong audience, mixed research for learning contexts
- **Time-series charts** — a "parent view" concern, not student-facing
- **Per-word manual scheduling** — defeats the purpose of SM-2
- **Numerical scores exposed to user** — use visual indicators instead

## User Actions from Dashboard
1. **Start review session** — one tap, system picks the words
2. **Spot-check a word** — search, tap, see context and history
3. **Feel progress** — mastery bar shifting from orange to green over weeks

## Mockup Variants

Three design directions were explored as HTML mockups in `/docs/mockups/`:

### Mockup A: "Ring Summary" (Duolingo-inspired)
- Circular progress rings for mastery categories
- Minimal, gamified feel
- Word list below as simple cards

### Mockup B: "Book Shelf" (Context-first)
- Words grouped under book covers / titles
- Emphasizes the reading connection
- Mastery shown as subtle per-word color bars

### Mockup C: "Garden" (Growth metaphor)
- Words represented as plants at different growth stages
- Playful, age-appropriate for 10-14
- Overdue words shown as wilting (needs water = needs review)
