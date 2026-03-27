#!/usr/bin/env node
/**
 * Seed the review queue with common SAT vocabulary words.
 *
 * Generates quiz assets (definitions, options, hints) via Claude, then writes
 * word records and per-word quiz cache entries to the KV store.
 *
 * Prerequisites:
 *   - The server must be running (npm run server or npm run dev)
 *
 * Usage:
 *   node scripts/seed-words.mjs                    # seed all words
 *   node scripts/seed-words.mjs --tier learning    # seed only one tier
 *   node scripts/seed-words.mjs --dry-run          # show what would be seeded
 *   node scripts/seed-words.mjs --count 10         # seed only first N words
 */

// ── Seed word list ──────────────────────────────────────────────────────────
// Curated SAT-level words across difficulty tiers (based on Age of Acquisition).
// Each word includes a natural context sentence for use in exercises.

const SEED_WORDS = [
  // ── Review tier (AoA 8-10): should know, reinforce ──────────────────────
  { word: "abundant", tier: "review", sentence: "The garden produced an abundant harvest of tomatoes and peppers that summer.", root: "abundare (Latin: to overflow)" },
  { word: "cautious", tier: "review", sentence: "The cautious driver slowed down as the road became icy.", root: "cautio (Latin: caution, from cavere: to beware)" },
  { word: "symbol", tier: "review", sentence: "The dove has long been a symbol of peace across many cultures.", root: "symbolon (Greek: token, sign)" },
  { word: "ancient", tier: "review", sentence: "The ancient ruins stood silent on the hilltop, weathered by thousands of years.", root: "antiquus (Latin: old, former)" },
  { word: "vanish", tier: "review", sentence: "The magician made the coin vanish from her open palm.", root: "evanescere (Latin: to disappear)" },
  { word: "tremendous", tier: "review", sentence: "A tremendous roar of thunder shook the windows of the old house.", root: "tremendus (Latin: to be trembled at)" },
  { word: "flexible", tier: "review", sentence: "The gymnast's flexible body bent into positions that seemed impossible.", root: "flexibilis (Latin: from flectere, to bend)" },
  { word: "scarce", tier: "review", sentence: "Clean water was scarce in the village, so every drop was precious.", root: "excerpere (Latin: to pluck out, via Old French escars)" },
  { word: "resolve", tier: "review", sentence: "Despite the setbacks, she had the resolve to finish the marathon.", root: "resolvere (Latin: to loosen, release)" },
  { word: "dispute", tier: "review", sentence: "The neighbors settled their dispute over the property line with a survey.", root: "disputare (Latin: to discuss, from dis- + putare: to reckon)" },
  { word: "inhabit", tier: "review", sentence: "Thousands of species inhabit the coral reefs of the Pacific Ocean.", root: "inhabitare (Latin: to dwell in)" },
  { word: "abandon", tier: "review", sentence: "The crew had to abandon the sinking ship and take to the lifeboats.", root: "abandonner (Old French: to surrender)" },
  { word: "absurd", tier: "review", sentence: "The idea of a fish riding a bicycle seemed completely absurd.", root: "absurdus (Latin: out of tune, senseless)" },
  { word: "distinguish", tier: "review", sentence: "It was hard to distinguish the twins apart until you noticed their different smiles.", root: "distinguere (Latin: to separate, mark off)" },

  // ── Learning tier (AoA 10-13): right at their frontier ──────────────────
  { word: "benevolent", tier: "learning", sentence: "The benevolent donor gave millions to build schools in rural areas.", root: "bene (Latin: well) + volens (wishing)" },
  { word: "eloquent", tier: "learning", sentence: "The eloquent speaker held the audience captive with her powerful words.", root: "eloquens (Latin: from e- out + loqui: to speak)" },
  { word: "scrutinize", tier: "learning", sentence: "The detective scrutinized every detail of the crime scene for clues.", root: "scrutinium (Latin: a search, from scruta: trash, rags)" },
  { word: "inevitable", tier: "learning", sentence: "With dark clouds gathering, rain seemed inevitable before the game ended.", root: "in- (not) + evitabilis (Latin: avoidable)" },
  { word: "meticulous", tier: "learning", sentence: "The meticulous artist spent three hours painting a single leaf on the canvas.", root: "meticulosus (Latin: fearful, from metus: fear)" },
  { word: "resilient", tier: "learning", sentence: "The resilient community rebuilt their town within a year after the hurricane.", root: "resilire (Latin: to spring back)" },
  { word: "ubiquitous", tier: "learning", sentence: "Smartphones have become ubiquitous — you see them everywhere you go.", root: "ubique (Latin: everywhere)" },
  { word: "volatile", tier: "learning", sentence: "The volatile situation at the border could change at any moment.", root: "volatilis (Latin: flying, swift, from volare: to fly)" },
  { word: "ambiguous", tier: "learning", sentence: "The ambiguous instructions left the students confused about what to do next.", root: "ambiguus (Latin: going around, from ambi-: both ways + agere: to drive)" },
  { word: "pragmatic", tier: "learning", sentence: "Rather than debating theories, the pragmatic engineer focused on what would actually work.", root: "pragmatikos (Greek: fit for business, from pragma: deed)" },
  { word: "diligent", tier: "learning", sentence: "The diligent student reviewed her notes every evening before bed.", root: "diligens (Latin: attentive, from dis- apart + legere: to choose)" },
  { word: "candid", tier: "learning", sentence: "The manager gave a candid assessment of the project's problems instead of sugarcoating them.", root: "candidus (Latin: white, pure, sincere)" },
  { word: "compelling", tier: "learning", sentence: "The lawyer made a compelling argument that convinced even the skeptical jurors.", root: "compellere (Latin: to drive together, to force)" },
  { word: "flourish", tier: "learning", sentence: "The small business began to flourish once they found their loyal customers.", root: "florere (Latin: to bloom, from flos: flower)" },
  { word: "denounce", tier: "learning", sentence: "Several senators stood up to denounce the new policy as unfair.", root: "denuntiare (Latin: to announce, warn)" },
  { word: "plausible", tier: "learning", sentence: "Her excuse sounded plausible, but the teacher suspected she hadn't done the homework.", root: "plausibilis (Latin: worthy of applause, from plaudere: to clap)" },

  // ── Challenge tier (AoA 13-16): stretch words, SAT-level ───────────────
  { word: "ephemeral", tier: "challenge", sentence: "The beauty of cherry blossoms is ephemeral, lasting only a few days each spring.", root: "ephemeros (Greek: lasting only a day, from epi- + hemera: day)" },
  { word: "surreptitious", tier: "challenge", sentence: "She cast a surreptitious glance at her neighbor's test before catching herself.", root: "surrepticius (Latin: stolen, from sub- secretly + rapere: to seize)" },
  { word: "pernicious", tier: "challenge", sentence: "The pernicious rumor spread through the school and damaged several friendships.", root: "perniciosus (Latin: destructive, from per- completely + nex: death)" },
  { word: "acquiesce", tier: "challenge", sentence: "After hours of debate, the committee finally acquiesced to the new rules.", root: "acquiescere (Latin: to find rest in, from ad- to + quiescere: to rest)" },
  { word: "exacerbate", tier: "challenge", sentence: "Yelling at each other only served to exacerbate the argument.", root: "exacerbare (Latin: to irritate, from ex- + acerbus: harsh, bitter)" },
  { word: "perfunctory", tier: "challenge", sentence: "The security guard gave a perfunctory glance at the ID badge without really checking it.", root: "perfunctorius (Latin: careless, from perfungi: to get through with)" },
  { word: "ameliorate", tier: "challenge", sentence: "The new medicine helped ameliorate her symptoms, though it didn't cure the disease.", root: "ameliorare (Latin: to make better, from melior: better)" },
  { word: "gregarious", tier: "challenge", sentence: "The gregarious host introduced every guest to each other within minutes.", root: "gregarius (Latin: belonging to a flock, from grex: flock)" },
  { word: "lethargic", tier: "challenge", sentence: "After eating the enormous meal, everyone felt lethargic and didn't want to move.", root: "lethargikos (Greek: drowsy, from lethe: forgetfulness)" },
  { word: "tenacious", tier: "challenge", sentence: "The tenacious reporter spent months investigating the story until she uncovered the truth.", root: "tenax (Latin: holding fast, from tenere: to hold)" },
  { word: "juxtapose", tier: "challenge", sentence: "The artist liked to juxtapose bright colors against dark backgrounds for dramatic effect.", root: "juxta (Latin: beside) + poser (French: to place)" },
  { word: "repudiate", tier: "challenge", sentence: "The scientist repudiated the flawed study, calling its methods unreliable.", root: "repudiare (Latin: to reject, from repudium: divorce)" },
  { word: "obfuscate", tier: "challenge", sentence: "The politician tried to obfuscate the issue with complicated language and statistics.", root: "obfuscare (Latin: to darken, from ob- over + fuscare: to make dark)" },
  { word: "cacophony", tier: "challenge", sentence: "The cacophony of car horns, jackhammers, and sirens made the city block unbearable.", root: "kakophonia (Greek: bad sound, from kakos: bad + phone: voice)" },
  { word: "sagacious", tier: "challenge", sentence: "The sagacious old judge could see through lies that fooled everyone else.", root: "sagax (Latin: of quick perception, from sagire: to perceive keenly)" },
  { word: "recalcitrant", tier: "challenge", sentence: "The recalcitrant mule refused to cross the bridge no matter how hard the farmer pulled.", root: "recalcitrare (Latin: to kick back, from re- back + calcitrare: to kick)" },
];

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const reseed = args.includes("--reseed");
const tierFlag = args.includes("--tier") ? args[args.indexOf("--tier") + 1] : null;
const countFlag = args.includes("--count") ? parseInt(args[args.indexOf("--count") + 1]) : null;

let words = SEED_WORDS;
if (tierFlag) words = words.filter(w => w.tier === tierFlag);
if (countFlag) words = words.slice(0, countFlag);

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";

// ── KV store helpers (same as test files) ───────────────────────────────────

async function storageGet(key) {
  try {
    const res = await fetch(`${BASE_URL}/api/kv/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const result = await res.json();
    return result ? JSON.parse(result.value) : null;
  } catch { return null; }
}

async function storageSet(key, value) {
  await fetch(`${BASE_URL}/api/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
}

// ── Claude helper ───────────────────────────────────────────────────────────
// Mirrors the claudeJSON function in App.jsx. Uses the server's /api/claude
// proxy (which handles auth via CLAUDE_CODE_OAUTH_TOKEN) rather than calling
// the Anthropic API directly, so the seed script works in the same environments
// as the app (local dev, Railway, etc.) with no additional API key setup.

async function claudeJSON(prompt, system, maxTokens = 4000) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const res = await fetch(`${BASE_URL}/api/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = (data.content || []).map(b => b.text || "").join("");
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  const objMatch = raw.match(/\{[\s\S]*\}/);
  const arrIdx = arrMatch ? raw.indexOf(arrMatch[0]) : Infinity;
  const objIdx = objMatch ? raw.indexOf(objMatch[0]) : Infinity;
  const jsonStr = arrIdx < objIdx ? arrMatch[0] : objMatch?.[0];
  if (!jsonStr) throw new Error(`No JSON in response: ${raw.slice(0, 200)}`);
  return JSON.parse(jsonStr);
}

// ── Main seed logic ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\nVocab Quest Seed Pipeline`);
  console.log(`========================`);
  console.log(`Words to seed: ${words.length}`);
  console.log(`Tiers: ${[...new Set(words.map(w => w.tier))].join(", ")}`);
  console.log(`Server: ${BASE_URL}`);
  if (dryRun) { console.log(`\nDry run — no changes will be made.\n`); }

  // Check server is running
  try {
    const health = await fetch(`${BASE_URL}/api/health`);
    if (!health.ok) throw new Error(`Status ${health.status}`);
  } catch (e) {
    console.error(`\nCannot reach server at ${BASE_URL}. Is it running? (npm run server)\n`);
    process.exit(1);
  }

  // Filter out words that already have quiz cache entries (unless --reseed)
  const newWords = [];
  for (const w of words) {
    const existing = await storageGet(`quiz-word-${w.word.toLowerCase()}`);
    if (existing && !reseed) {
      console.log(`  skip: ${w.word} (already cached)`);
    } else {
      newWords.push(w);
    }
  }

  if (newWords.length === 0) {
    console.log(`\nAll ${words.length} words already have quiz data. Nothing to do.`);
    // Still ensure word records exist
    await ensureWordRecords(words);
    return;
  }

  console.log(`\nGenerating quiz data for ${newWords.length} new words...`);
  if (dryRun) {
    for (const w of newWords) console.log(`  would generate: ${w.word} (${w.tier})`);
    console.log(`\nDry run complete.`);
    return;
  }

  // Generate quiz assets in batches of 10 via Claude. Batching reduces the
  // number of API calls (46 words = 5 calls instead of 46) and produces more
  // consistent definitions since Claude sees all words in a batch together.
  const BATCH_SIZE = 10;
  for (let i = 0; i < newWords.length; i += BATCH_SIZE) {
    const batch = newWords.slice(i, i + BATCH_SIZE);
    console.log(`\n  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.map(w => w.word).join(", ")}`);

    const wordList = batch.map((w, idx) =>
      `${idx + 1}. Word: "${w.word}"\n   Context: "${w.sentence}"`
    ).join("\n\n");

    const result = await claudeJSON(
      `You are preparing a vocabulary quiz for middle-grade readers (ages 10-14).

For each word below, generate:
- 4 multiple choice options (correct definition first at index 0, then 3 plausible wrong distractors)
- A one-sentence hint for a player who guessed wrong (points to context without giving the answer)

${wordList}

Respond ONLY with a raw JSON array, one object per word, in the same order:
[
  {
    "word": "example",
    "correct": 0,
    "options": ["the correct definition", "wrong but plausible 1", "wrong but plausible 2", "wrong but plausible 3"],
    "hint": "A helpful hint that points toward the answer without giving it away."
  }
]`,
      "You are a vocabulary education expert. Respond with a valid JSON array only — no markdown, no explanation.",
      Math.min(16000, batch.length * 700 + 1000)
    );

    const arr = Array.isArray(result) ? result : (result.words || result.items || Object.values(result));

    // Write per-word quiz cache entries (include context sentence for review lookups)
    for (const item of arr) {
      const seedWord = batch.find(w => w.word.toLowerCase() === item.word.toLowerCase());
      const entry = { ...item };
      if (seedWord) {
        entry.paragraph = seedWord.sentence;
        entry.root = seedWord.root;
        entry.tier = seedWord.tier;
      }
      const key = `quiz-word-${item.word.toLowerCase().trim()}`;
      await storageSet(key, entry);
      console.log(`    cached: ${item.word}`);
    }
  }

  // Ensure word records exist in vocab-quest-data
  await ensureWordRecords(words);

  console.log(`\nDone! ${newWords.length} words seeded. They should now appear in the review queue.`);
}

// Creates word records for seeded words in the vocab-quest-data blob.
// These records are what make words appear in getReviewQueue(). Setting
// nextReviewDate to today makes them immediately reviewable.
//
// Source is set to bookHash: null because seeded words don't come from a book.
// The ReviewLoadingPhase handles this gracefully — it skips the book/chapter
// lookup and falls back to the paragraph stored in the per-word quiz cache.
async function ensureWordRecords(wordsToSeed) {
  console.log(`\nEnsuring word records exist...`);
  const STORAGE_KEY = "vocab-quest-data";
  const data = (await storageGet(STORAGE_KEY)) || { wordRecords: {}, sessions: [] };

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  let created = 0;

  for (const w of wordsToSeed) {
    const key = w.word.toLowerCase();
    if (data.wordRecords[key]) continue;

    data.wordRecords[key] = {
      word: key,
      firstSeenAt: now,
      sources: [{ bookTitle: "Seed: SAT Vocabulary", bookHash: null, chapterTitle: `${w.tier} tier` }],
      easeFactor: 2.5,
      interval: 1,
      repetitions: 0,
      nextReviewDate: today,
      lastReviewedAt: null,
    };
    created++;
  }

  if (created > 0) {
    await storageSet(STORAGE_KEY, data);
    console.log(`  Created ${created} new word records (due today).`);
  } else {
    console.log(`  All word records already exist.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
