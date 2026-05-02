// Claude wrapper — uses @anthropic-ai/claude-agent-sdk so auth goes through
// the same Max/OAuth credentials as the orchestrator (no API key needed).
//
// ask()           — text in, text out
// askWithImages() — encodes screenshot buffers as base64 and passes them
//                   directly in the prompt as image content blocks (no temp
//                   files, no file paths disclosed to Claude)

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

// Collect all assistant text blocks from a query stream
async function collectText(stream) {
  const parts = [];
  const types = new Set();
  for await (const message of stream) {
    types.add(message.type);
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          }
        }
      }
    }
  }
  const result = parts.join('');
  if (!result.trim()) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.warn(`[${ts}] [claude] WARNING: collectText returned empty string. Message types seen: [${[...types].join(', ')}]`);
  }
  return result;
}

/**
 * Single-turn text completion.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>}
 */
export async function ask(systemPrompt, userMessage, {
  model = 'claude-sonnet-4-6',
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  const prompt = `<system>\n${systemPrompt}\n</system>\n\n${userMessage}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`ask() timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  try {
    const stream = query({
      prompt,
      options: {
        cwd: tmpdir(),
        model,
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        abortController: ac,
      },
    });
    return await collectText(stream);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-turn completion with screenshot images.
 * Encodes each buffer as base64 and passes it directly as an image content
 * block — no temp files are written, no file paths are disclosed to Claude,
 * and the Read tool is not required.
 *
 * @param {string} systemPrompt
 * @param {Buffer[]} imageBuffers
 * @param {string} userText
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>}
 */
export async function askWithImages(systemPrompt, imageBuffers, userText, {
  model = 'claude-sonnet-4-6',
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`askWithImages() timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  try {
    // Build a multimodal message with inline base64 image blocks.
    // Using the AsyncIterable<SDKUserMessage> form of query() so we can pass
    // structured content blocks instead of a raw string with file paths.
    const sessionId = randomUUID();
    const content = [
      // System instructions as the first text block
      { type: 'text', text: `<system>\n${systemPrompt}\n</system>\n\n${userText}` },
      // One image block per screenshot — base64-encoded, no paths involved
      ...imageBuffers.map((buf) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: buf.toString('base64'),
        },
      })),
    ];

    async function* makeMessages() {
      yield {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    }

    const stream = query({
      prompt: makeMessages(),
      options: {
        cwd: tmpdir(),
        model,
        // No Read tool needed — images are inlined in the prompt
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        abortController: ac,
      },
    });
    return await collectText(stream);
  } finally {
    clearTimeout(timer);
  }
}
