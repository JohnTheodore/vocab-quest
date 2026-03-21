# Vocabulary Quest

A vocabulary learning game for middle-grade readers, tied to books they are actively reading.

## Running in GitHub Codespaces (recommended)

1. Click **Code → Codespaces → Create codespace on main**
2. Wait for the environment to build (~2 minutes)
3. Copy `.env.example` to `.env` and fill in your API keys:
   ```
   cp .env.example .env
   ```
4. Edit `.env` with your keys (click the file in the sidebar)
5. Start the dev server:
   ```
   npm run dev
   ```
6. The browser will open automatically at the forwarded port

## Running locally

```bash
npm install
cp .env.example .env
# Edit .env with your API keys
npm run dev
```

## Image generation (Docker)

```bash
# Build once
docker build -t vocab-image-gen .

# Run (from folder containing words.json)
docker run --rm \
  -v "$(pwd):/data" \
  vocab-image-gen \
  --key YOUR_GEMINI_API_KEY \
  --input words.json \
  --output vocab-images.tar.gz
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `VITE_ANTHROPIC_API_KEY` | Anthropic API key from console.anthropic.com |
| `VITE_GEMINI_API_KEY` | Gemini API key from aistudio.google.com (for live image generation) |

When running in the Claude.ai artifact, these are not needed — the artifact uses its own injected keys.

## Using with Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude
```
