/**
 * Vocabulary Quest — API Server
 *
 * Proxies Claude API calls through the @anthropic-ai/claude-agent-sdk,
 * which picks up authentication from `claude login` automatically.
 * No ANTHROPIC_API_KEY needed — uses your Claude Pro subscription.
 *
 * Run alongside Vite: npm run dev
 * Or standalone:      npm run server
 */

import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── /api/claude — drop-in replacement for api.anthropic.com/v1/messages ───────
app.post('/api/claude', async (req, res) => {
  const { messages, system, max_tokens = 4000, model } = req.body;

  // Build the prompt from the messages array
  // The Agent SDK takes a simple string prompt, so we flatten the conversation
  const userMessage = messages?.findLast(m => m.role === 'user')?.content || '';
  const prompt = typeof userMessage === 'string'
    ? userMessage
    : userMessage.map(b => b.text || '').join('');

  if (!prompt) {
    return res.status(400).json({ error: { message: 'No user message found' } });
  }

  try {
    let fullText = '';

    // query() uses Claude Code's runtime — authenticated via `claude login`
    // It picks up credentials from ~/.claude/credentials automatically
    for await (const message of query({
      prompt,
      options: {
        // Pass system prompt if provided
        ...(system ? { appendSystemPrompt: system } : {}),
        // Disable all file/shell tools — we only need text responses
        allowedTools: [],
        // Don't write any files to disk
        permissionMode: 'bypassPermissions',
      },
    })) {
      // Collect text from assistant messages
      if (message.type === 'assistant') {
        const textBlocks = message.message?.content?.filter(b => b.type === 'text') || [];
        fullText += textBlocks.map(b => b.text).join('');
      }

      // result message signals completion
      if (message.type === 'result') {
        if (message.is_error) {
          return res.status(500).json({ error: { message: message.result || 'Agent error' } });
        }
      }
    }

    // Return in the same shape as api.anthropic.com/v1/messages
    // so the React app needs no changes to parse the response
    res.json({
      content: [{ type: 'text', text: fullText }],
      stop_reason: 'end_turn',
    });

  } catch (err) {
    console.error('Agent SDK error:', err);
    res.status(500).json({ error: { message: err.message || 'Server error' } });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Vocab Quest API server running on http://localhost:${PORT}`);
  console.log('Using Claude Code credentials from: claude login');
});
