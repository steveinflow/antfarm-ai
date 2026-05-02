// Worker — spawns Claude agent sessions in isolated worktrees.
// Uses @anthropic-ai/claude-agent-sdk's query() function.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createTicketService } from '@docket/core';
import admin from 'firebase-admin';
import { existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorktree, cleanupWorktree } from './worktree.js';
import { buildPrompt } from './prompt-builder.js';
import { isBase64ImageDataUrl } from './prompt-sanitizer.js';
import { join } from 'node:path';

// Absolute path to the docket CLI bin — works regardless of where the worker
// is invoked from, so blog-editor and other external-repo projects can use it.
const _dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_PATH = `node ${resolve(_dir, '../../cli/bin/tickets.js')}`;

/**
 * Write base64 image data URLs from ticket screenshots to files in the worktree.
 * Returns a copy of the ticket with screenshots replaced by file paths.
 * Non-image or invalid data URLs are left untouched (sanitizeScreenshotUrl handles them).
 */
function materializeScreenshots(ticket, worktreeDir) {
  if (!ticket.screenshots || ticket.screenshots.length === 0) return ticket;

  const screenshotDir = join(worktreeDir, '.screenshots');
  let dirCreated = false;
  const materialized = [];

  for (let i = 0; i < ticket.screenshots.length; i++) {
    const url = ticket.screenshots[i];
    if (isBase64ImageDataUrl(url)) {
      if (!dirCreated) {
        mkdirSync(screenshotDir, { recursive: true });
        dirCreated = true;
      }
      // Extract MIME subtype for extension (e.g., "png" from "data:image/png;base64,")
      const mimeMatch = url.match(/^data:image\/([^;]+);base64,/);
      const ext = mimeMatch ? mimeMatch[1].replace('+xml', '') : 'png';
      const filePath = join(screenshotDir, `screenshot-${i + 1}.${ext}`);
      const base64Data = url.slice(url.indexOf(',') + 1);
      writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      materialized.push(filePath);
    } else {
      materialized.push(url);
    }
  }

  return { ...ticket, screenshots: materialized };
}

/**
 * Run a worker session — streams messages from Claude agent SDK.
 *
 * @param {string} docId - Firestore document ID
 * @param {string} ticketId - Human-readable ticket ID (e.g., KB-005)
 * @param {string} worktreeDir - Absolute path to worktree
 * @param {AbortController} ac - Abort controller for cancellation
 * @param {string} prompt - The assembled prompt
 * @param {string|null} resumeSessionId - Session ID to resume (or null)
 * @param {object} options
 * @param {string} options.model - Claude model to use
 * @param {number} options.workerIdleTimeoutMs - Abort if no messages for this long
 * @param {object} [options.ticketService] - Ticket service for persisting session ID immediately
 * @param {function} [options.onLog] - Called with (docId, line) for status logs
 * @param {function} [options.onWorkerLog] - Called with (docId, line) for detailed worker logs
 * @param {boolean} [options.bypassPermissions=false] - Enable full permission bypass mode.
 *   When false (default), uses 'acceptEdits' mode which auto-accepts file edits but retains
 *   other safety checks. Set to true only in trusted development environments with explicit
 *   operator approval — this disables all SDK permission checks.
 * @returns {Promise<{ sessionId: string }>}
 */
export async function runWorkerSession(docId, ticketId, worktreeDir, ac, prompt, resumeSessionId, {
  model,
  workerIdleTimeoutMs,
  ticketService,
  onLog,
  onWorkerLog,
  bypassPermissions = false,
  firebaseKeyPath,
}) {
  const log = (line) => {
    if (onLog) onLog(docId, line);
  };
  const workerLog = (line) => {
    if (onWorkerLog) onWorkerLog(docId, line);
  };

  log(`Starting session for ${ticketId} in ${worktreeDir}`);

  let sessionId = resumeSessionId || undefined;
  let idleTimer = null;
  let messageCount = 0;
  let totalCostUsd = 0;
  let startupTimer = null;
  let heartbeatTimer = null;
  const launchTime = Date.now();

  // Track last activity for heartbeat display
  let lastToolName = null;
  let lastToolTime = null;
  let lastMessageTime = Date.now();

  // Reset idle timer on each message
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    lastMessageTime = Date.now();
    idleTimer = setTimeout(() => {
      const elapsed = Math.round((Date.now() - launchTime) / 1000);
      log(`STUCK: Idle timeout (${Math.round(workerIdleTimeoutMs / 1000)}s) for ${ticketId} after ${messageCount} messages, ${elapsed}s elapsed — aborting`);
      ac.abort();
    }, workerIdleTimeoutMs);
  }

  // Heartbeat: log every 30s while waiting
  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - launchTime) / 1000);
      const silenceSec = Math.round((Date.now() - lastMessageTime) / 1000);
      if (messageCount === 0) {
        log(`Waiting for first response from Claude... (${elapsed}s elapsed)`);
      } else if (lastToolName && lastToolTime) {
        const toolElapsed = Math.round((Date.now() - lastToolTime) / 1000);
        log(`Worker alive: ${messageCount} messages, ${elapsed}s elapsed — awaiting Claude response after ${lastToolName} (${toolElapsed}s)`);
      } else {
        log(`Worker alive: ${messageCount} messages, ${elapsed}s elapsed — silent for ${silenceSec}s`);
      }
    }, 30_000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  try {
    resetIdleTimer();
    startHeartbeat();

    // Startup timeout: if no messages after 60s, log a warning
    startupTimer = setTimeout(() => {
      if (messageCount === 0) {
        log(`WARNING: No response from Claude after 60s for ${ticketId}. Session may be stuck.`);
      }
    }, 60_000);

    // Permission mode: use 'acceptEdits' by default so file edit operations are
    // auto-accepted for unattended agent sessions, while retaining SDK safety
    // checks for other operations (e.g. shell exec, network access).
    // Operators can enable full bypass via bypassPermissions: true in docket.config.json
    // under orchestrator.bypassPermissions — only appropriate in trusted dev environments.
    const options = {
      cwd: worktreeDir,
      model,
      permissionMode: bypassPermissions ? 'bypassPermissions' : 'acceptEdits',
      ...(bypassPermissions && { allowDangerouslySkipPermissions: true }),
      abortController: ac,
      settingSources: ['project'],
      // Pass DOCKET_FIREBASE_KEY_PATH as a process env var so the CLI command
      // in the prompt is just `node <script>` (matches Bash(node:*) permissions)
      // instead of `DOCKET_FIREBASE_KEY_PATH=... node <script>` which doesn't.
      ...(firebaseKeyPath && {
        env: { ...process.env, DOCKET_FIREBASE_KEY_PATH: firebaseKeyPath },
      }),
    };

    if (sessionId) {
      options.resume = sessionId;
    }

    // Pre-flight checks
    if (!existsSync(worktreeDir)) {
      throw new Error(`Worktree directory does not exist: ${worktreeDir}`);
    }
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: worktreeDir, stdio: 'pipe' });
    } catch {
      throw new Error(`Worktree is not a valid git repo: ${worktreeDir}`);
    }

    log(`Launching Claude session (model: ${model}, cwd: ${worktreeDir})`);
    const stream = query({ prompt, options });

    for await (const message of stream) {
      messageCount++;
      resetIdleTimer();

      // Clear startup timer on first message
      if (messageCount === 1) {
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = null;
        const startupMs = Date.now() - launchTime;
        log(`First message received after ${Math.round(startupMs / 1000)}s`);
      }

      if (ac.signal.aborted) break;

      // Capture session ID (SDK uses snake_case) and persist immediately so it
      // survives an orchestrator crash before ticket finalization.
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        if (ticketService) {
          ticketService.update(docId, { sessionId }).catch((err) => {
            log(`Warning: failed to persist sessionId to Firestore: ${err.message}`);
          });
        }
      }

      if (message.type === 'assistant') {
        // New assistant message — Claude responded; clear any pending tool wait
        lastToolName = null;
        lastToolTime = null;
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              for (const line of block.text.split('\n')) {
                if (line.trim()) workerLog(line);
              }
            } else if (block.type === 'tool_use') {
              const inputStr = JSON.stringify(block.input || {});
              const inputPreview = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
              workerLog(`Tool: ${block.name} ${inputPreview}`);
              // Track last tool for heartbeat visibility
              lastToolName = block.name;
              lastToolTime = Date.now();
            }
          }
        }
      } else if (message.type === 'tool_result') {
        const content = message.message?.content;
        if (typeof content === 'string') {
          const preview = content.slice(0, 300).replace(/\n/g, ' ');
          workerLog(`  → ${preview}${content.length > 300 ? '...' : ''}`);
        }
        // Tool result received — update timer so heartbeat shows time since result was sent to Claude
        lastToolTime = Date.now();
      } else if (message.type === 'result') {
        if (message.total_cost_usd != null) {
          totalCostUsd = message.total_cost_usd;
        }
        const cost = totalCostUsd > 0 ? ` $${totalCostUsd.toFixed(4)}` : '';
        const resultMsg = `Session ended: ${message.subtype} (${message.duration_ms}ms${cost})`;
        workerLog(resultMsg);
        log(`Session complete for ${ticketId} (${messageCount} messages, ${Math.round((Date.now() - launchTime) / 1000)}s${cost})`);
      } else if (message.type === 'system') {
        workerLog(`[${message.subtype || 'system'}] session started`);
      }
      // user messages (tool result wrappers) are handled via tool_result above
    }

    // Stream ended — check if we got any messages
    if (messageCount === 0) {
      throw new Error(`Claude session produced no output for ${ticketId}. Process may have exited silently.`);
    }
  } catch (err) {
    // Log full error details for debugging
    const elapsed = Math.round((Date.now() - launchTime) / 1000);
    log(`Session error for ${ticketId} after ${elapsed}s, ${messageCount} messages: ${err.message}`);
    if (err.exitCode !== undefined) log(`Exit code: ${err.exitCode}`);
    if (err.stderr) log(`stderr: ${err.stderr.slice(0, 500)}`);
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (startupTimer) clearTimeout(startupTimer);
    stopHeartbeat();
  }

  return { sessionId, costUsd: totalCostUsd };
}

/**
 * Spawn a worker for a ticket.
 * Claims the ticket, creates a worktree, runs the agent session.
 *
 * @param {string} docId - Firestore document ID
 * @param {object} ctx
 * @param {string} ctx.projectId - Project ID
 * @param {object} ctx.ticketService - Ticket service instance
 * @param {object} ctx.projectConfig - Project config (repoPath, etc.)
 * @param {object} ctx.db - Firestore instance
 * @param {string} ctx.model - Claude model
 * @param {string} ctx.userId - User ID
 * @param {number} ctx.workerIdleTimeoutMs - Idle timeout
 * @param {string} [ctx.cliPath] - CLI path override
 * @param {function} [ctx.onLog] - Status log callback
 * @param {function} [ctx.onWorkerLog] - Detailed log callback
 * @param {function} [ctx.onStarted] - Called when worker actually starts (worktreeDir, ac)
 * @param {boolean} [ctx.bypassPermissions=false] - Enable full permission bypass mode.
 *   Defaults to false (uses 'acceptEdits' mode). Set via orchestrator.bypassPermissions
 *   in docket.config.json only for trusted development environments.
 * @returns {Promise<{ sessionId: string, ticketId: string, worktreeDir: string }>}
 */
export async function spawnWorker(docId, {
  projectId,
  ticketService,
  projectConfig,
  db,
  model,
  userId,
  firebaseKeyPath,
  workerIdleTimeoutMs,
  cliPath,
  onLog,
  onWorkerLog,
  onStarted,
  abortController,
  nonSonnetMode,
  bypassPermissions = false,
}) {
  const log = (line) => {
    if (onLog) onLog(docId, line);
  };

  // Get ticket data
  const ticket = await ticketService.getById(docId);
  if (!ticket) {
    throw new Error(`Ticket ${docId} not found`);
  }

  // Claim the ticket — transition to in_progress
  try {
    await ticketService.transitionStatus(docId, 'in_progress', {
      note: 'Claimed by orchestrator',
      workerStartedAt: new Date().toISOString(),
      workerPhase: 'running',
    });
  } catch (err) {
    log(`Failed to claim ${ticket.ticketId}: ${err.message}`);
    throw err;
  }

  log(`Claimed ${ticket.ticketId}: ${ticket.title}`);

  // Create worktree
  const repoPath = projectConfig.repoPath;
  const worktreeDir = createWorktree(ticket.ticketId, repoPath);
  log(`Worktree: ${worktreeDir}`);

  // Copy .claude/settings.json into the worktree so the SDK finds the
  // permission allowlist.  The main repo has one (created by ensureClaudeSettings)
  // but worktrees are separate directory trees and .claude/ is typically not
  // tracked in git, so the worktree starts without any permissions file.
  const mainSettings = join(repoPath, '.claude', 'settings.json');
  const wtSettings = join(worktreeDir, '.claude', 'settings.json');
  if (existsSync(mainSettings) && !existsSync(wtSettings)) {
    mkdirSync(join(worktreeDir, '.claude'), { recursive: true });
    copyFileSync(mainSettings, wtSettings);
    log(`Copied .claude/settings.json into worktree`);
  }

  // Materialize base64 screenshots as files in the worktree
  const ticketWithScreenshots = materializeScreenshots(ticket, worktreeDir);

  // Build prompt (includes WIP if present)
  // CLI path uses just `node <script>` — DOCKET_FIREBASE_KEY_PATH is passed
  // as a process env var (not inlined) so the command matches Bash(node:*) permissions.
  const effectiveCli = cliPath || DEFAULT_CLI_PATH;
  const prompt = buildPrompt(ticketWithScreenshots, { userId, projectId, cliPath: effectiveCli, nonSonnetMode });

  // Clear WIP after it's been consumed by the prompt
  if (ticket.workInProgress) {
    await ticketService.update(docId, { workInProgress: null });
    log(`Cleared WIP for ${ticket.ticketId}`);
  }

  // Use pre-created abort controller or create a new one
  const ac = abortController || new AbortController();

  if (onStarted) onStarted(worktreeDir, ac);

  // Run session
  const { sessionId, costUsd } = await runWorkerSession(
    docId,
    ticket.ticketId,
    worktreeDir,
    ac,
    prompt,
    null,
    { model, workerIdleTimeoutMs, ticketService, onLog, onWorkerLog, bypassPermissions, firebaseKeyPath },
  );

  return { sessionId, ticketId: ticket.ticketId, worktreeDir, costUsd };
}

/**
 * Finalize a worker after its session completes.
 * Checks the final ticket status and takes appropriate action.
 *
 * @param {string} docId - Firestore document ID
 * @param {object} ctx
 * @param {string} ctx.projectId - Project ID
 * @param {object} ctx.ticketService - Ticket service instance
 * @param {object} ctx.projectConfig - Project config
 * @param {function} ctx.onMerge - Called with (ticketId, repoPath) to enqueue merge
 * @param {function} ctx.onPause - Called with (docId, { ticketId, question, sessionId, worktreeDir, projectId })
 * @param {function} ctx.onDequeue - Called to dequeue next ticket
 * @param {function} ctx.onCleanup - Called with (docId) to clean up worker state
 * @param {string} ctx.worktreeDir - Worktree directory
 * @param {string} ctx.ticketId - Human-readable ticket ID
 * @param {function} [ctx.onLog] - Log callback
 * @param {function} [ctx.onUpgrade] - Called with (docId, upgradeModel, worktreeDir, ticketId, sessionId, projectId)
 *   when the agent signals it needs a more powerful model (requestUpgrade flag on ticket).
 */
export async function finalizeWorker(docId, {
  projectId,
  ticketService,
  projectConfig,
  onMerge,
  onPause,
  onDequeue,
  onCleanup,
  worktreeDir,
  ticketId,
  sessionId,
  onLog,
  onUpgrade,
}) {
  const log = (line) => {
    if (onLog) onLog(docId, line);
  };

  // Re-read ticket to get final status
  const ticket = await ticketService.getById(docId);
  if (!ticket) {
    log(`Ticket ${docId} vanished — cleaning up`);
    cleanupWorktree(worktreeDir, projectConfig.repoPath);
    onCleanup(docId);
    onDequeue();
    return;
  }

  const status = ticket.status;
  log(`Final status for ${ticketId}: ${status}`);

  // Check if the agent requested a model upgrade (non-sonnet mode: haiku → opus).
  // The agent sets requestUpgrade: true on the ticket when it determines the task
  // is too complex for haiku. We restart the session with the upgrade model (opus).
  if (ticket.requestUpgrade && onUpgrade) {
    log(`${ticketId} requested model upgrade — handing off to upgrade handler`);
    // Clear the flag so the next session doesn't loop
    await ticketService.update(docId, { requestUpgrade: null }).catch(() => {});
    onUpgrade(docId, { ticketId, worktreeDir, sessionId, projectId });
    onDequeue();
    return;
  }

  switch (status) {
    case 'waiting_for_user': {
      // Pause the worker — keep worktree, save session
      const question = ticket.pendingQuestion || null;
      log(`Pausing ${ticketId} — waiting for user`);
      onPause(docId, {
        ticketId,
        question,
        sessionId,
        worktreeDir,
        projectId,
      });
      // Do NOT clean up worktree — we will resume
      onDequeue();
      break;
    }

    case 'done': {
      // Transition back to in_progress immediately so users don't see "Done"
      // before the branch is actually merged and deployed.
      // The merge-queue will mark it done again after a successful merge+deploy.
      log(`${ticketId} is done — transitioning to in_progress before merge`);
      try {
        await ticketService.transitionStatus(docId, 'in_progress', {
          note: 'Merging branch and deploying...',
          workerPhase: 'merging',
          workerStartedAt: null,
        });
      } catch (err) {
        log(`Failed to reset ${ticketId} to in_progress before merge: ${err.message}`);
      }
      // Clear WIP — ticket is complete, WIP is irrelevant
      if (ticket.workInProgress) {
        await ticketService.update(docId, { workInProgress: null });
      }
      const repoPath = projectConfig.repoPath;
      onMerge(ticketId, repoPath);
      cleanupWorktree(worktreeDir, repoPath);
      onCleanup(docId);
      onDequeue();
      break;
    }

    case 'blocked': {
      // Just clean up — ticket stays blocked for human review
      log(`${ticketId} is blocked — cleaning up worktree`);
      cleanupWorktree(worktreeDir, projectConfig.repoPath);
      ticketService.update(docId, { workerPhase: null, workerStartedAt: null }).catch(() => {});
      onCleanup(docId);
      onDequeue();
      break;
    }

    case 'in_progress': {
      // Session ended but the agent never called the done/blocked/waiting_for_user command.
      // Check if the branch has commits ahead of the default branch.
      // If yes — the work is done, just forgotten to signal; go straight to merge.
      // If no commits — reset to open so a fresh agent can try.
      // Count commits on this branch that don't exist on any remote branch.
      // Ticket branches are never pushed, so this reliably counts the agent's commits.
      let commitsAhead = 0;
      try {
        // Check HEAD first; if HEAD is detached (e.g. interrupted rebase) also
        // check the named ticket branch so we don't discard completed work.
        // Use spawnSync with explicit args array (no shell: true) to avoid shell
        // injection via the branchName / ticketId value.
        const branchName = `ticket/${ticketId}`;
        const headResult = spawnSync('git', ['log', '--oneline', 'HEAD', '--not', '--remotes'], {
          cwd: worktreeDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        const headOut = headResult.status === 0 ? (headResult.stdout ?? '').trim() : '';
        const branchResult = spawnSync('git', ['log', '--oneline', branchName, '--not', '--remotes'], {
          cwd: worktreeDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        const branchOut = branchResult.status === 0 ? (branchResult.stdout ?? '').trim() : '';
        const best = headOut.split('\n').filter(Boolean).length >= branchOut.split('\n').filter(Boolean).length
          ? headOut : branchOut;
        commitsAhead = best ? best.split('\n').filter(Boolean).length : 0;
      } catch {
        // git error — fall through to open reset
      }

      if (commitsAhead > 0) {
        log(`${ticketId} session ended in_progress but has ${commitsAhead} commit(s) ahead — auto-merging`);
        try {
          await ticketService.transitionStatus(docId, 'in_progress', {
            note: `Auto-merge: session ended without done command but ${commitsAhead} commit(s) found`,
            workerPhase: 'merging',
            workerStartedAt: null,
          });
        } catch (err) {
          log(`Failed to set ${ticketId} to in_progress before merge: ${err.message}`);
        }
        onMerge(ticketId, projectConfig.repoPath);
        cleanupWorktree(worktreeDir, projectConfig.repoPath);
      } else {
        log(`${ticketId} session ended in_progress with no commits — resetting to open`);
        try {
          await ticketService.transitionStatus(docId, 'open', {
            note: `Agent session ended without completing or committing`,
            workerPhase: null,
            workerStartedAt: null,
          });
        } catch (err) {
          log(`Failed to reset ${ticketId}: ${err.message}`);
        }
        cleanupWorktree(worktreeDir, projectConfig.repoPath);
      }
      onCleanup(docId);
      onDequeue();
      break;
    }

    default: {
      // Truly unexpected status — clean up and reset
      log(`${ticketId} has unexpected status "${status}" — resetting to open`);
      try {
        await ticketService.transitionStatus(docId, 'open', {
          note: `Orchestrator reset: worker ended with status "${status}"`,
          workerPhase: null,
          workerStartedAt: null,
        });
      } catch (err) {
        log(`Failed to reset ${ticketId}: ${err.message}`);
      }
      cleanupWorktree(worktreeDir, projectConfig.repoPath);
      onCleanup(docId);
      onDequeue();
      break;
    }
  }
}

/**
 * Resume a paused worker after the user has answered.
 * Extracts the user answer from status history and runs a new session
 * with the answer as context.
 *
 * @param {string} docId - Firestore document ID
 * @param {object} ctx - Same shape as spawnWorker ctx, plus:
 * @param {string} ctx.sessionId - Previous session ID to resume
 * @param {string} ctx.worktreeDir - Existing worktree directory
 * @param {string} ctx.ticketId - Human-readable ticket ID
 * @returns {Promise<{ sessionId: string, ticketId: string, worktreeDir: string }>}
 */
export async function resumeWorker(docId, {
  projectId,
  ticketService,
  projectConfig,
  db,
  model,
  userId,
  firebaseKeyPath,
  workerIdleTimeoutMs,
  cliPath,
  sessionId: prevSessionId,
  worktreeDir,
  ticketId,
  onLog,
  onWorkerLog,
  onStarted,
  abortController,
  nonSonnetMode,
  bypassPermissions = false,
}) {
  const log = (line) => {
    if (onLog) onLog(docId, line);
  };

  // Get fresh ticket data
  const ticket = await ticketService.getById(docId);
  if (!ticket) {
    throw new Error(`Ticket ${docId} not found for resume`);
  }

  // Extract the user's answer from status history
  // The answer is the note on the most recent transition from waiting_for_user
  const userAnswer = extractUserAnswer(ticket.statusHistory);
  log(`Resuming ${ticketId} with user answer: ${(userAnswer || '(none)').slice(0, 80)}`);

  // Claim the ticket again
  try {
    await ticketService.transitionStatus(docId, 'in_progress', {
      note: 'Resumed by orchestrator after user response',
      workerStartedAt: new Date().toISOString(),
      workerPhase: 'running',
    });
  } catch (err) {
    log(`Failed to claim ${ticketId} for resume: ${err.message}`);
    throw err;
  }

  // Materialize base64 screenshots as files in the worktree
  const ticketWithScreenshots = materializeScreenshots(ticket, worktreeDir);

  // Build prompt with user answer context (includes WIP if present)
  const effectiveCli = cliPath || DEFAULT_CLI_PATH;
  const prompt = buildPrompt(ticketWithScreenshots, { userId, projectId, cliPath: effectiveCli, userAnswer, nonSonnetMode });

  // Clear WIP after it's been consumed by the prompt
  if (ticket.workInProgress) {
    await ticketService.update(docId, { workInProgress: null });
    log(`Cleared WIP for ${ticketId}`);
  }

  // Use pre-created abort controller or create a new one
  const ac = abortController || new AbortController();

  if (onStarted) onStarted(worktreeDir, ac);

  // Run session, resuming from previous session
  const { sessionId, costUsd } = await runWorkerSession(
    docId,
    ticketId,
    worktreeDir,
    ac,
    prompt,
    prevSessionId,
    { model, workerIdleTimeoutMs, ticketService, onLog, onWorkerLog, bypassPermissions, firebaseKeyPath },
  );

  return { sessionId, ticketId, worktreeDir, costUsd };
}

// ── Helpers ───────────────────────────────────────────────────────

function extractUserAnswer(statusHistory) {
  if (!statusHistory || !Array.isArray(statusHistory)) return null;

  // Walk backwards to find the most recent transition FROM waiting_for_user
  for (let i = statusHistory.length - 1; i >= 0; i--) {
    const entry = statusHistory[i];
    if (entry.from === 'waiting_for_user' && entry.note) {
      return entry.note;
    }
  }
  return null;
}
