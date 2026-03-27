# Vocabulary Seeding: Sources, Categorization & Difficulty

Research into populating the review queue with vocabulary words independent of book chapters.

---

## Word Sources

### Academic Word List (AWL) — Primary seed source

570 word families (~3,000 word forms) that appear frequently across academic disciplines. Created by Averil Coxhead from a 3.5-million-word academic corpus. Organized into 10 sublists by frequency (Sublist 1 = most common). These are exactly the cross-disciplinary words that appear on the SAT.

- [Official source (Victoria University of Wellington)](https://www.wgtn.ac.nz/lals/resources/academicwordlist)
- [Browsable by sublist (EAP Foundation)](https://www.eapfoundation.com/vocab/academic/awllists/)

### Paul Nation's BNC/COCA Frequency Bands — Expansion source

25 bands of 1,000 word families each. The 3k-9k range is the sweet spot for ages 10-14 SAT prep. Words ranked 1-3k are generally known by age 10. Words beyond 15k may be too obscure.

- [Available from Victoria University of Wellington](https://www.wgtn.ac.nz/lals/resources/paul-nations-resources/vocabulary-lists)

### Exclusion Lists

- **Fry list** (1,000 most common words, grades 3-9) — too basic for SAT prep, use as a filter
- **Dolch list** (220 service words + 95 nouns, pre-K through 3rd grade) — too basic, use as a filter
- Any word on these lists should NOT be in the seed pool

### Digital SAT Context

Post-2024, the SAT emphasizes "words in context" — understanding nuanced meanings of medium-difficulty words rather than obscure vocabulary. This is well-suited to a middle-grade app since the target words are more accessible.

---

## Categorization Systems

### WordNet

Lexical database with ~117,000 synonym sets (synsets) linked by semantic relations (hypernymy, hyponymy, meronymy, antonymy). Provides definitions, example sentences, part-of-speech, and semantic relationships.

- **Open English WordNet** — CC BY 4.0, available in JSON, LMF, RDF, WNDB
- [GitHub: globalwordnet/english-wordnet](https://github.com/globalwordnet/english-wordnet)
- Node.js access via `en-wordnet` on npm
- Useful for: definitions, synonym/antonym quizzes, semantic grouping, "related words" features

### CEFR Levels (A1-C2)

Individual English words can be tagged with CEFR proficiency levels. For ages 10-14, B2-C1 words are the SAT-prep range.

- **Oxford 3000/5000** — 3,000 core words (A1-B2) and 5,000 extended words, each tagged with CEFR level. [PDF from Oxford](https://www.oxfordlearnersdictionaries.com/external/pdf/wordlists/oxford-3000-5000/The_Oxford_3000_by_CEFR_level.pdf)
- **Words-CEFR-Dataset** — maps English words to CEFR levels. [GitHub: Maximax67/Words-CEFR-Dataset](https://github.com/Maximax67/Words-CEFR-Dataset)
- **Kaggle** — [10,000 English words CEFR-labeled](https://www.kaggle.com/datasets/nezahatkk/10-000-english-words-cerf-labelled)

### Morphological Families / Latin-Greek Roots

~76% of academic English words share common morphological roots; ~90% of domain-specific words derive from Greek or Latin. Teaching root families is one of the highest-leverage vocabulary strategies.

- Wikipedia: [List of Greek and Latin roots in English](https://en.wikipedia.org/wiki/List_of_Greek_and_Latin_roots_in_English) (CC BY-SA)
- WordNet "derivationally related forms" links
- Claude can identify roots at seed time for each word

### Thematic / Semantic Categories

WordNet's hypernym hierarchy provides natural thematic grouping. Practical categories for SAT prep: emotions/feelings, science/nature, government/law, arts/literature, character traits, time/change, size/quantity.

---

## Difficulty Assignment

### Best Predictors of Word Difficulty

From Ha, Nguyen, & Stoeckel (2024), using machine learning on learner data:

| Rank | Predictor | Available Dataset |
|------|-----------|-------------------|
| 1 | **Age of Acquisition (AoA)** | Kuperman et al. — 30,121 words |
| 2 | **Contextual distinctiveness** | Derivable from COCA |
| 3 | **Word frequency** | COCA top 5,000 (free) |
| 4 | **Concreteness** | Brysbaert et al. — 40,000 words |
| 5 | **Word length / syllables** | Trivially computable |

### Age of Acquisition — The Key Metric

[Kuperman et al. (2012)](https://pubmed.ncbi.nlm.nih.gov/22581493/) provides numeric age ratings for 30,121 words (e.g., "dog" = ~3.0, "prudence" = ~10.5).

Mapping to Vocab Quest difficulty tiers for ages 10-14:

| AoA Range | Tier | Description |
|-----------|------|-------------|
| 8-10 | Review | Should know, reinforce |
| 10-13 | Learning | Right at their frontier |
| 13-16 | Challenge | Stretch words, SAT-level |
| 16+ | Expert | May be too hard for most |

Available from [NORARE database](https://norare.clld.org/contributions/Kuperman-2012-AoA).

### Word Frequency

COCA (Corpus of Contemporary American English) frequency rank is a reasonable secondary signal. Words ranked 1-3,000 are generally known by age 10. The 5,000-15,000 range is the SAT prep sweet spot.

**Frequency alone is insufficient** — the "yo-yo problem" (rare in text but known by all kids) and the "constitute problem" (frequent in text but poorly understood by 12-year-olds). Use alongside AoA.

- [COCA top 5,000 on GitHub](https://github.com/brucewlee/COCA-WordFrequency)

### Concreteness

[Brysbaert et al. (2014)](https://github.com/ArtsEngine/concreteness) provides ratings for ~40,000 words on a 1-5 scale (1=abstract, 5=concrete). Abstract words are harder to learn at equal frequency. Also useful for exercise design: concrete words work well with images, abstract words need context-heavy exercises.

---

## Freely Available Machine-Readable Datasets

| Dataset | Format | License | Words |
|---------|--------|---------|-------|
| [Open English WordNet](https://github.com/globalwordnet/english-wordnet) | JSON, LMF, RDF | CC BY 4.0 | ~117k synsets |
| [COCA Top 5,000](https://github.com/brucewlee/COCA-WordFrequency) | CSV | Free/research | 5,000 |
| [Words-CEFR-Dataset](https://github.com/Maximax67/Words-CEFR-Dataset) | JSON | Open source | ~10k |
| [Kuperman AoA](https://norare.clld.org/contributions/Kuperman-2012-AoA) | Tabular | Academic | 30,121 |
| [Brysbaert Concreteness](https://github.com/ArtsEngine/concreteness) | CSV | Academic | ~40,000 |
| [AWL (Coxhead)](https://www.wgtn.ac.nz/lals/resources/academicwordlist) | PDF/web | Free | 570 families |
| [Kaggle CEFR 10k](https://www.kaggle.com/datasets/nezahatkk/10-000-english-words-cerf-labelled) | CSV | Kaggle terms | 10,000 |

---

## Seed Pipeline Design

1. Start with AWL as the core seed list
2. Join against Kuperman AoA to assign difficulty tiers
3. Enrich with WordNet for definitions and semantic grouping
4. Tag with CEFR levels
5. Group by morphological roots (Claude identifies Latin/Greek roots at seed time)
6. Use Brysbaert concreteness as secondary signal for exercise type selection
7. Filter out any Fry/Dolch words
