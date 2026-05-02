// master-worker.js — Master Worker chat handler.
// Watches /orchestrator/masterWorker in Firestore for new user messages.
// When a new message arrives (status === 'pending'):
//   1. Sets status to 'responding' and records pausedWorkerCount
//   2. Runs a Claude session (streaming) to generate a reply
//   3. Appends the assistant message and sets status back to 'idle'
//
// While the master worker is responding, the orchestrator pauses other workers
// by blocking new spawns (canSpawnWorker returns false).

import { query } from '@anthropic-ai/claude-agent-sdk';
import { sanitizeNote, wrapInDataBlock } from './prompt-sanitizer.js';

const MASTER_WORKER_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are the Master Worker — the orchestration AI for the Docket ticket automation system.

You oversee a pool of Claude agent workers that autonomously handle software tickets (coding tasks, bug fixes, feature implementations).

You have full visibility into the system and can answer questions about:
- Current worker status and active tickets
- The overall health and progress of the system
- Best practices for ticket management and AI-assisted development
- Architecture and implementation strategies
- Debugging and troubleshooting worker failures

Be concise and direct. You are talking to the developer/operator who runs this system.
When other workers are paused to allow you to respond, acknowledge this briefly if relevant.`;

/**
 * Create a master worker handler.
 *
 * @param {object} opts
 * @param {object} opts.db - Firestore admin instance
 * @param {function} opts.canSpawnWorker - Returns true if workers can spawn
 * @param {function} opts.getActiveWorkerCount - Returns current active worker count
 * @param {function} opts.onLog - Logging callback (line: string) => void
 * @returns {{ start: function, stop: function, isResponding: () => boolean }}
 */
export function createMasterWorker({ db, getActiveWorkerCount, onLog }) {
  const masterWorkerRef = db.collection('orchestrator').doc('masterWorker');
  let unsubscribe = null;
  let responding = false;
  let lastSeenUpdatedAt = null;

  function log(line) {
    if (onLog) onLog(line);
  }

  /**
   * Returns true while the master worker is processing a user message.
   * The orchestrator checks this to block new worker spawns.
   */
  function isResponding() {
    return responding;
  }

  /**
   * Process a pending user message — called when Firestore detects status === 'pending'.
   */
  async function handlePendingMessage(data) {
    if (responding) {
      log('[master-worker] Already responding — ignoring duplicate trigger');
      return;
    }

    const messages = data.messages || [];
    if (messages.length === 0) {
      log('[master-worker] No messages found — resetting to idle');
      await masterWorkerRef.set({ status: 'idle' }, { merge: true });
      return;
    }

    responding = true;
    const activeWorkerCount = getActiveWorkerCount();

    log(`[master-worker] New user message received — pausing ${activeWorkerCount} active workers`);

    // Mark as responding so the UI shows the typing indicator and paused count
    try {
      await masterWorkerRef.set({
        status: 'responding',
        pausedWorkerCount: activeWorkerCount,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (err) {
      log(`[master-worker] Failed to set responding status: ${err.message}`);
      responding = false;
      return;
    }

    // Build the conversation prompt from message history.
    // Security: msg.text comes from Firestore (untrusted). Sanitize each message
    // and wrap user content in XML data blocks so the LLM treats it as data,
    // not as instructions. msg.role is validated against an allowlist.
    const VALID_ROLES = new Set(['user', 'assistant']);
    const conversationLines = messages
      .filter(msg => msg && VALID_ROLES.has(msg.role) && typeof msg.text === 'string')
      .map(msg => {
        const role = msg.role === 'user' ? 'Human' : 'Assistant';
        const safeText = sanitizeNote(msg.text);
        // Wrap user messages in data blocks to prevent injection; assistant
        // messages are our own prior output and trusted, but sanitize anyway.
        const formattedText = msg.role === 'user'
          ? wrapInDataBlock(safeText, 'user-message')
          : safeText;
        return `${role}: ${formattedText}`;
      });
    const conversationText = conversationLines.join('\n\n');

    const prompt = `<system>\n${SYSTEM_PROMPT}\n</system>\n\n${conversationText}\n\nAssistant:`;

    let responseText = '';

    try {
      log('[master-worker] Starting Claude session...');

      // The master worker is a text-only conversational session — no tools are
      // allowed, so 'default' permission mode is appropriate and safe.
      const stream = query({
        prompt,
        options: {
          model: MASTER_WORKER_MODEL,
          allowedTools: [],
          permissionMode: 'default',
        },
      });

      for await (const message of stream) {
        // Log session_id server-side only — never store or expose to clients
        if (message.session_id) {
          log(`[master-worker] Session ID: ${message.session_id}`);
        }
        if (message.type === 'assistant') {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                responseText += block.text;
              }
            }
          }
        }
      }

      log(`[master-worker] Response generated (${responseText.length} chars)`);
    } catch (err) {
      log(`[master-worker] Claude session error: ${err.message}`);
      responseText = `Sorry, I encountered an error: ${err.message}`;
    }

    // Append assistant response and set status back to idle
    const now = new Date().toISOString();
    const assistantMessage = {
      role: 'assistant',
      text: responseText.trim() || '(no response)',
      at: now,
    };
    const updatedMessages = [
      ...messages,
      assistantMessage,
    ];

    try {
      await masterWorkerRef.set({
        status: 'idle',
        messages: updatedMessages,
        pausedWorkerCount: 0,
        updatedAt: now,
      }, { merge: false });
      log('[master-worker] Response saved — workers can resume');
    } catch (err) {
      log(`[master-worker] Failed to save response: ${err.message}`);
    }

    responding = false;
  }

  /**
   * On startup, check if a previous server crash left the document in 'responding'
   * state. If so, reset it to 'idle' — the interrupted session is unrecoverable.
   * This prevents the UI from showing "..." forever after a restart.
   */
  async function recoverOnStartup() {
    try {
      const snap = await masterWorkerRef.get();
      if (!snap.exists) return;
      const data = snap.data();
      if (data.status === 'responding') {
        log('[master-worker] Found orphaned responding state — resetting to idle');
        await masterWorkerRef.set({
          status: 'idle',
          pausedWorkerCount: 0,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }
    } catch (err) {
      log(`[master-worker] Startup recovery check failed: ${err.message}`);
    }
  }

  /**
   * Start listening for incoming messages from the web UI.
   */
  function start() {
    if (unsubscribe) return;

    log('[master-worker] Starting listener on orchestrator/masterWorker...');

    // Recover from any crash that left status stuck at 'responding'
    recoverOnStartup().catch(err => {
      log(`[master-worker] Startup recovery error: ${err.message}`);
    });

    unsubscribe = masterWorkerRef.onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        const data = snap.data();

        // Only trigger on new 'pending' updates (detect by updatedAt changing)
        if (data.status !== 'pending') return;
        if (data.updatedAt && data.updatedAt === lastSeenUpdatedAt) return;
        lastSeenUpdatedAt = data.updatedAt;

        handlePendingMessage(data).catch(err => {
          log(`[master-worker] Unhandled error: ${err.stack || err.message}`);
          responding = false;
        });
      },
      (err) => {
        log(`[master-worker] Listener error: ${err.message}`);
      }
    );
  }

  /**
   * Stop listening for messages.
   */
  function stop() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    responding = false;
    log('[master-worker] Stopped');
  }

  return { start, stop, isResponding };
}
