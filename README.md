# Vocabulary Quest

### 1. What is this?

A vocabulary learning game for middle-grade readers (ages 10–14), built around books they are actively reading. Upload any EPUB or TXT book, pick a chapter, and the app finds the most valuable vocabulary words in it — SAT-level words that appear in rich, meaningful context. Each word is presented in its original passage so the reader can connect the definition to the story they love.

The game has two rounds: **word → meaning** (guess the definition from context, with hints if you're stuck), then **fill in the blank** (given the definition, find the word in the passage). A Story Bible ensures that AI-generated illustrations stay visually consistent across sessions — same characters, same settings, same painterly Victorian aesthetic throughout.

---

### 2. What does it look like?

![Vocabulary Quest — languidly](screenshot.jpg)

*A vocabulary card for the word "languidly" from A Little Princess, with an illustration, the original passage with the word highlighted, and four multiple-choice options.*

---

### 3. How do I run it?

**In GitHub Codespaces (recommended):**

1. Click **Code → Codespaces → Create codespace on main**
2. Wait ~2 minutes for the dev container to build (Node 18, Python 3.12)
3. Install dependencies:
   ```bash
   npm install
   ```
4. Log in to Claude — this is how the app authenticates with the Claude API:
   ```bash
   claude login
   ```
   Follow the browser-based OAuth flow. Credentials are saved to `~/.claude/.credentials.json` and picked up automatically by the server.
5. Add your Gemini key for image generation:
   ```bash
   cp .env.example .env
   # Edit .env — add your GEMINI_API_KEY
   ```
6. Start the app:
   ```bash
   npm run dev
   ```
7. Click the forwarded-port popup (port 5173) — Vocabulary Quest opens in your browser

**Locally on your machine:**

```bash
git clone https://github.com/YOUR_USERNAME/vocab-quest.git
cd vocab-quest
npm install
claude login          # authenticate with Claude
cp .env.example .env  # add your GEMINI_API_KEY
npm run dev
```

---

### 4. How do I configure it?

#### Environment variables

| Variable | Where to get it | Required for |
|----------|----------------|--------------|
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → API Keys | Image generation |
| `AUTH_PASSWORD` | You choose it | Password-protecting the app (production) |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude login` output or CI secrets | Claude API in environments without `claude login` (e.g. Railway) |

Copy `.env.example` to `.env` and fill in the values. The `.env` file is gitignored and will never be committed.

#### Claude authentication

The server proxies Claude requests through the `@anthropic-ai/claude-agent-sdk`, which reads credentials from `~/.claude/.credentials.json` (created by `claude login`). No Anthropic API key is needed — your Claude Pro/Max subscription is used directly.

For headless environments like Railway where you can't run `claude login`, set the `CLAUDE_CODE_OAUTH_TOKEN` environment variable instead (see the deployment section below).

#### Password authentication

When `AUTH_PASSWORD` is set, the app requires a password before granting access. This is cookie-based and stateless — no database needed. If `AUTH_PASSWORD` is not set, auth is disabled (convenient for local development).

---

### 5. Deploying to production (Railway)

The app is configured for [Railway](https://railway.app) out of the box via `railway.toml`:

1. Create a new Railway project and connect your GitHub repo
2. Set these environment variables in the Railway dashboard:

   | Variable | Value |
   |----------|-------|
   | `GEMINI_API_KEY` | Your Google AI Studio key |
   | `AUTH_PASSWORD` | A password to protect the app |
   | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token from `~/.claude/.credentials.json` (the `accessToken` field) |

3. Deploy — Railway runs `npm run build` then `node server.js` automatically

The server binds to `process.env.PORT` (injected by Railway at runtime) and serves the Vite-built frontend from `dist/`.

---

### 6. How does it work?

The app is a React frontend (`src/App.jsx`) backed by an Express API server (`server.js`) that proxies calls to Claude and Gemini. It progresses through eight sequential phases:

**Upload → Story Bible → Chapter Select → Word Suggestion → Asset Generation → Game → Results**

- **EPUB/TXT parsing** — JSZip extracts chapter text client-side. Chapter titles are enriched from multiple sources (NCX metadata, HTML table-of-contents pages, and in-chapter headings) to show full names even when the epub's TOC only stores short labels
- **Story Bible** — Claude reads up to 60,000 characters of the book and extracts character appearances and setting descriptions. Cached by SHA-256 hash of the book text — generated once, loaded instantly on return visits
- **Word suggestion** — Claude identifies up to 20 SAT-level words per chapter that appear verbatim in the text, with character position verified client-side. Also cached per chapter
- **Quiz generation** — A single Claude call generates all quiz options and hints for the selected words at once
- **Image generation** — Prompts are built from the original passage + matching Story Bible character/setting descriptions + book-wide style constants, ensuring visual consistency. Images are generated via the Gemini API and cached in the browser
- **Two-round game** — Round 1: word → meaning (keep trying with hints until correct). Round 2: fill in the blank (definition given, choose the correct word)
- **Results** — Separate scores for each round, showing first-try vs. with-a-hint performance

**Tech stack:** React 18, Vite, Express, Claude Agent SDK, Google Gemini image API, JSZip, pako

---

### 7. Progress tracking & spaced repetition

The app tracks every word you encounter and uses the **SM-2 algorithm** (the same algorithm behind Anki) to schedule future reviews. All data lives in browser storage and can be exported as a JSON file.

#### How it works

After each game, the app records a session and updates a per-word record with SM-2 spaced repetition state. The quality score is derived from your performance:

| Result | SM-2 quality | Effect |
|--------|-------------|--------|
| Correct on first try | 5 (perfect recall) | Interval grows, next review pushed further out |
| Correct after hints | 3 (recalled with difficulty) | Interval grows more slowly |
| Never answered correctly | 1 (blackout) | Interval resets to 1 day |

When a word appears in both rounds (meaning + fill-in-the-blank), the **minimum** score across both is used — the word is only considered well-learned if both tasks were nailed on the first try.

#### Exporting your progress

Click **Download Progress** on the results screen to save `vocab-quest-progress.json`. The file contains:

```jsonc
{
  "wordRecords": {
    "languidly": {
      "word": "languidly",
      "firstSeenAt": "2026-03-21T10:00:00Z",
      "sources": [                          // every book/chapter where this word appeared
        { "bookTitle": "A Little Princess", "bookHash": "abc123", "chapterTitle": "Chapter 5" }
      ],
      "easeFactor": 2.5,                    // SM-2 difficulty multiplier (starts at 2.5)
      "interval": 6,                        // days until next review
      "repetitions": 2,                     // consecutive successful reviews
      "nextReviewDate": "2026-03-27",       // when this word is due for review
      "lastReviewedAt": "2026-03-21T10:30:00Z"
    }
    // ... one entry per word you've ever studied
  },
  "sessions": [
    {
      "id": "sess_1711018200000_a1b2c",
      "gameType": "vocab-quest",
      "completedAt": "2026-03-21T10:30:00Z",
      "context": { "bookTitle": "A Little Princess", "bookHash": "abc123", "chapterTitle": "Chapter 5" },
      "wordResults": [
        { "word": "languidly", "taskType": "meaning",    "firstTry": true,  "attempts": 1 },
        { "word": "languidly", "taskType": "fill-blank", "firstTry": false, "attempts": 2 }
      ]
    }
    // ... one entry per completed game
  ]
}
```

See [`docs/spaced-repetition-design.md`](docs/spaced-repetition-design.md) for the full data model and algorithm specification.
