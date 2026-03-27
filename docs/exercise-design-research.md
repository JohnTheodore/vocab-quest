# Exercise Design: Pedagogy Research & Game Design

## Current Exercises

**MC** = multiple choice throughout this document.

| Current Exercise   | What It Builds                      | Depth      |
|--------------------|-------------------------------------|------------|
| MC meaning         | Recognize definition (lowest level) | Shallow    |
| Fill-in-the-blank  | Cued recall of word form            | Moderate   |
| Spelling           | Written form only                   | Structural |

The core finding from [Stahl & Fairbanks (1986)](https://doi.org/10.3102/00346543056001072): programs combining **definitional + contextual + active processing** produced effect sizes of **d = 0.97** (huge). Definition-only or context-only: d = 0.30. Vocab Quest already has the context (the book) and the definitions — what's missing is the deeper active processing.

---

## Exercise Types That Produce Mastery

Ranked by research evidence for long-term retention:

### 1. Morphological Analysis (Highest ROI for SAT words)

> "The word 'benevolent' has the root 'bene-' (good) and 'vol' (wish). What do you think 'malevolent' means?"

This is the single highest-value addition because it builds a **generative system** — the kid doesn't just learn one word, they learn a mechanism for decoding hundreds of words. ~60% of English words encountered by middle schoolers have Latin/Greek morphemes.

- [Bowers et al. (2010)](https://doi.org/10.3102/0034654309359353) meta-analysis: **d = 0.41** for vocabulary, with larger effects for the target age range.
- [Baumann et al. (2002)](https://doi.org/10.1598/RRQ.37.2.3) — students could infer meanings of untaught words containing taught morphemes (**d = 0.50** transfer).

### 2. Sentence Generation

> "Use 'ubiquitous' in a sentence that shows you know what it means."

- [Webb (2005)](https://doi.org/10.2307/3588329) — sentence writing was the most effective single task for productive vocabulary across all measured dimensions.
- [Joe (1998)](https://doi.org/10.1093/applin/19.3.357) — generating a new context (not copying the book's sentence) produced significantly better retention.

This is the deepest level of processing — the kid must understand the meaning, grammar, register, and collocations to produce a correct sentence. Scoring requires Claude to evaluate whether the sentence demonstrates correct understanding.

### 3. Free Recall of Meaning

> Show the word. "What does 'ephemeral' mean? Type your answer."

- [Roediger & Karpicke (2006)](https://doi.org/10.1111/j.1467-9280.2006.01693.x) — free recall produced **80% retention at one week** vs. 36% for restudy.
- [Kang et al. (2007)](https://doi.org/10.1037/0278-7393.33.2.431) — short-answer retrieval beat MC retrieval on delayed tests regardless of test format.

This is the testing effect at its strongest — effortful retrieval with no cues.

### 4. Context Inference (Pre-Teaching Step)

> Show the book passage before revealing the definition. "What do you think 'surreptitious' means based on this sentence?"

Even if the kid gets it wrong, the attempt creates a **curiosity gap** that makes the subsequent definition stick. This is the "pretesting effect."

- [Richland et al. (2009)](https://doi.org/10.1037/a0016496) — getting something wrong before being taught the answer produces better retention than just being taught the answer.

### 5. Synonym/Antonym & Word Association

> "Which word is closest in meaning to 'verbose'? Which is most opposite?"

Builds the **semantic network** around the word — how it relates to other words the kid already knows. This maps to how the mental lexicon is actually organized (spreading activation). Important for nuanced understanding: "obstinate" vs. "stubborn" vs. "tenacious."

---

## Sequencing: Progression Per Word

```
Book encounter (context)
  |
  v
Context inference — guess before being told        <-- creates curiosity gap
  |
  v
Explicit instruction — definition + morphology     <-- fills the gap
  |
  v
MC recognition (early reviews)                     <-- confirms the link
  |
  v
Fill-in-blank / synonym matching (next reviews)    <-- cued recall
  |
  v
Free recall of meaning (later reviews)             <-- effortful retrieval
  |
  v
Sentence generation (mastery reviews)              <-- full production
```

Link exercise difficulty to SM-2 maturity. Words at short intervals (just learned) get easier exercises. Words at long intervals (approaching mastery) get harder exercises. The longer spacing plus harder exercise type creates **compounding desirable difficulty**.

- [Bjork & Bjork (2011)](https://doi.org/10.1016/B978-0-12-387691-1.00001-5) — desirable difficulties framework.

---

## Three Design Principles

### Interleave, don't block

The current design (all meaning, then all blank, then all spelling) is the weaker blocked format.

- [Kornell & Bjork (2008)](https://doi.org/10.1111/j.1467-9280.2008.02127.x) — interleaving improved learning by **43%**. Mix exercise types within a session.

### Retrieval frequency matters alongside depth

- [Folse (2006)](https://doi.org/10.2307/40264532) — three fill-in-the-blank exercises beat one sentence-writing exercise. More retrieval events won over deeper single processing. Don't make every exercise a slow sentence-generation task. Mix quick retrievals with occasional deep ones.

### Vary the context across reviews

Don't always show the same book sentence.

- [Bolger et al. (2008)](https://doi.org/10.1080/09658210802107269) — encountering the word in diverse contexts was significantly better than repeated exposure in the same context. Generate or source additional example sentences for review sessions.

---

## Review Queue Design

### The core shift: from chapter sessions to word-pool sessions

The current "learn new words" flow is chapter-centric: pick a book, pick a chapter, study its words. The review queue pulls from **all due words across all books** — the chapter becomes metadata, not the organizing unit. `getReviewQueue()` in `wordRecords.js` already supports this: it returns all words where `nextReviewDate <= today`, sorted oldest-first, and word records already track `sources[]` for cross-book provenance.

### Player-facing language

In the SM-2 model, words past their `nextReviewDate` are technically "due" for review. This is the correct term in code and design docs. However, **never use "due" in player-facing UI** — it carries homework/chores connotations that undermine intrinsic motivation. Use language like:

- "12 words ready to strengthen" (not "12 words due")
- "All caught up! Next review: 3 words on Thursday" (not "No words due")
- "Strengthen your words" (not "Review due words")

The code and data model should continue using `due` / `dueWords` / `getReviewQueue()` — the reframing is purely at the UI layer.

### Session structure

Pick **~10-15 due words per session.** Prioritize by:

1. Most overdue first (longest past `nextReviewDate`)
2. Weakest first (lowest `easeFactor` or `repetitions`)

**Interleave exercise types** rather than blocking them. Each word gets **one exercise** chosen by its SM-2 maturity level:

| SM-2 State | Exercise Type | Why |
|---|---|---|
| `repetitions 0-1` (just learned / just failed) | MC meaning or fill-in-blank | Low friction, rebuild the link |
| `repetitions 2-3` (familiar) | Free recall — "type what this word means" | Effortful retrieval, no cues |
| `repetitions 4+` (approaching mastery) | Sentence generation (Claude-scored) or morphological analysis | Deep processing where it matters most |

One exercise per word per review session. The word comes back at its next SM-2 interval depending on performance. This matches Folse's finding — **frequency of retrieval events matters more than depth of any single event**. Reviewing 12 words with one exercise each is better than reviewing 4 words with three exercises each.

### What each review exercise looks like

**MC meaning / fill-in-blank** — Same as the current chapter flow, but fill-in-blank distractors are drawn from the full review pool (not just one chapter's words), making them harder and more useful.

**Free recall** — New exercise type. Show the word + the original paragraph. Text input: "What does this word mean?" Claude evaluates the response (not exact string match — the kid can use their own words, which is actually better for retention).

**Morphological analysis** — New exercise type. Group words that share roots across the learner's full vocabulary. "You know 'benevolent' means well-wishing. The root 'vol' means wish. What do you think 'voluntary' means?" This works especially well in review because the kid has accumulated words across chapters and books — the morphological connections emerge naturally as vocabulary grows.

**Sentence generation** — New exercise type. "Use 'ephemeral' in a sentence that shows you understand it." Claude evaluates. Reserved for words the kid has reviewed many times — the ultimate mastery check.

### Context variation across reviews

For early reviews, show the original book paragraph. For later reviews, Claude generates a new example sentence in a different context. This prevents the kid from memorizing "oh, 'languidly' is the one from the Sara scene" instead of actually knowing the word. See [Bolger et al. (2008)](https://doi.org/10.1080/09658210802107269) in the design principles section above.

### Entry point in the app

Add a **Review** button on the main screen (alongside the current book/chapter flow). It shows a count: "12 words ready to strengthen." Tapping it goes straight into a review session — no book selection, no chapter selection, no word suggestion, no asset generation phase. Just: here are your words, let's go.

If zero words are due, show the next review date: "All caught up! Next review: 3 words on Thursday."

### What stays the same

- **SM-2 algorithm** — works as-is, with quality scoring per exercise type
- **Word records** — already book-agnostic with `sources[]`
- **KV store** — no schema changes needed
- **The "learn new words" chapter flow** — unchanged; the review queue is additive

### Implementation priority

1. **Review entry point + session with existing exercise types** (MC, fill-in-blank, spelling) but interleaved and maturity-matched — usable immediately
2. **Free recall** with Claude scoring — biggest retention improvement
3. **Morphological analysis** — requires Claude to identify roots when words are first learned, stored alongside the word record
4. **Sentence generation** — highest difficulty exercise, Claude-scored

---

## Recommended Changes for Vocab Quest

### Add (in priority order)

1. **Context inference** as the very first step (guess before being told)
2. **Morphological analysis** exercises for words with identifiable roots
3. **Free recall** (type the meaning, no options) for later-stage reviews
4. **Sentence generation** with Claude-evaluated scoring for mastery-level reviews

### Modify

- **Interleave** exercise types instead of blocking them
- **Tie exercise difficulty to word maturity** (SM-2 repetition count / interval)
- **Vary the sentence context** across review sessions

### Keep but reposition

- **MC meaning** — only for first 1-2 reviews of a new word, then phase out
- **Fill-in-blank** — core exercise for mid-stage reviews
- **Spelling** — keep but reduce frequency; it builds form, not meaning
