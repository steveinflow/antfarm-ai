// @docket/orchestrator — main daemon
// Watches multiple project subcollections, manages worker pool,
// merge queues, paused tickets, and the terminal dashboard.

import admin from 'firebase-admin';
import { createTicketService } from '@docket/core';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startProjectListener, startBlockedTicketListener, startPausedTicketsListener, startCriticalTicketListener } from './listener.js';
import { spawnWorker, finalizeWorker, resumeWorker } from './worker.js';
import { createWorktree, cleanupWorktree } from './worktree.js';
import { promoteCanary } from './deploy.js';
import { createDashboard } from './dashboard.js';
import { createTUI } from './tui.js';
import { runMaintenance } from './maintenance.js';
import { createMasterWorker } from './master-worker.js';
import { createUsageMonitor } from './usage-monitor.js';
import { describeError } from './error-formatter.js';
import { createOrchestratorState } from './state.js';
import { createQueue } from './queue.js';

/**
 * Create an orchestrator instance.
 *
 * @param {object} options
 * @param {object} options.db - Firestore instance
 * @param {object} options.projects - Map of projectId -> { repoPath, ... }
 * @param {number} options.maxWorkers - Max concurrent workers across all projects
 * @param {string} options.model - Claude model to use
 * @param {string} options.userId - User ID to filter tickets
 * @param {number} options.workerIdleTimeoutMs - Idle timeout per worker
 * @returns {{ start: function, shutdown: function }}
 */
export function createOrchestrator({ db, projects, maxWorkers, model, fallbackModel, userId, firebaseKeyPath, workerIdleTimeoutMs, workerCooldownMs = 5 * 60 * 1000, workerStaggerMs, maintenanceIntervalMs = 5 * 60 * 1000, usageCheckIntervalMs = 30 * 60 * 1000, usagePauseThreshold = 90, usageFallbackThreshold = 80, usageCheckToken = null, bypassPermissions = false, pagesBaseUrl = null, pagesRepoPath = null }) {
  // ── State ───────────────────────────────────────────────────────
  // All shared mutable state lives in `state` so each extracted module
  // can read/write the same single object.  Collections are destructured
  // for convenience (Maps/Sets/Arrays are mutated in place) while scalars
  // (e.g. state.maintenanceRunning) are addressed through `state` so
  // assignments propagate.
  const state = createOrchestratorState({ maxWorkers });
  const {
    activeWorkers,
    recentErrors,
    pausedWorkers,
    queue,
    ticketInfoCache,
    workerLogs,
    listenerUnsubs,
    registeredProjectIds,
    claimingTickets,
    ticketServices,
    mergeQueueManager,
    config,
    advisorPersonaState,
    lastSeenPromoteCanary,
    workerLogFlushedCount,
    workerLogFlushTimers,
    MAX_WORKERS_LIMIT,
    MAX_MEMORY_LOG_LINES,
    HEARTBEAT_INTERVAL_MS,
    upgradeModel,
  } = state;

  /** Dashboard (classic — accessible via 'd' key) */
  const dashboard = createDashboard({
    activeWorkers,
    pausedWorkers,
    queue,
    ticketInfoCache,
    workerLogs,
    recentErrors,
    config,
    get maintenanceStatus() { return state.maintenanceStatus; },
  });

  /** Fancy three-pane TUI — default view */
  const tui = createTUI({
    activeWorkers,
    pausedWorkers,
    queue,
    ticketInfoCache,
    workerLogs,
    recentErrors,
    config,
    maintenanceStatus: () => state.maintenanceStatus,
    advisorState: () => advisorPersonaState,
  });

  /** Master worker — handles user chat via /orchestrator/masterWorker */
  const masterWorker = createMasterWorker({
    db,
    getActiveWorkerCount: () => activeWorkers.size,
    onLog: (line) => writeLogFile(line),
  });

  // ── Usage monitor ────────────────────────────────────────────────

  /** Effective model — switches to fallbackModel when Sonnet weekly limit crosses fallbackThreshold,
   *  or to fallbackModel when nonSonnetMode is active. */
  function getEffectiveModel() {
    if (state.nonSonnetMode && fallbackModel) return fallbackModel;
    if (state.usingFallbackModel && fallbackModel) return fallbackModel;
    return model;
  }

  const usageMonitor = createUsageMonitor({
    intervalMs: usageCheckIntervalMs,
    threshold: usagePauseThreshold,
    fallbackThreshold: usageFallbackThreshold,
    token: usageCheckToken,
    writeLog: writeLogFile,
    onPause({ reason, resumeAt }) {
      if (state.savedMaxWorkers === null) state.savedMaxWorkers = config.maxWorkers;
      config.maxWorkers = 0;
      writeLogFile(`[usage] Pausing — ${reason}`);
      if (resumeAt) {
        writeLogFile(`[usage] Will auto-resume at ${new Date(resumeAt).toLocaleString()}`);
      }
      scheduleRender();
    },
    onResume() {
      if (state.savedMaxWorkers !== null) {
        config.maxWorkers = state.savedMaxWorkers;
        state.savedMaxWorkers = null;
      }
      writeLogFile(`[usage] Resuming — maxWorkers restored to ${config.maxWorkers}`);
      scheduleRender();
      dequeueNext();
    },
    onFallback({ reason }) {
      if (!fallbackModel) return; // no fallback model configured — skip
      state.usingFallbackModel = true;
      writeLogFile(`[usage] Falling back to ${fallbackModel} — ${reason}`);
      scheduleRender();
    },
    onFallbackRecover() {
      if (!state.usingFallbackModel) return;
      state.usingFallbackModel = false;
      writeLogFile(`[usage] Sonnet limit recovered — resuming ${model}`);
      scheduleRender();
    },
    onUsageUpdate({ limits, checkedAt }) {
      // Persist the latest Claude plan usage to Firestore so the web UI
      // can display current progress towards plan limits in the token spend dialog.
      db.collection('orchestrator').doc('config').set(
        { planUsage: { limits, checkedAt } },
        { merge: true }
      ).catch(err => writeLogFile(`[usage] Failed to persist usage data: ${err.message}`));
    },
  });

  /** Log file — persistent file for debugging across terminals */
  const logDir = join(import.meta.dirname, '..', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'orchestrator.log');

  function writeLogFile(line) {
    try {
      const ts = new Date().toISOString();
      appendFileSync(logFile, `${ts} ${line}\n`);
    } catch {
      // don't fail if log write fails
    }
  }

  // ── Auto-provision repoPath ────────────────────────────────────

  /**
   * Derive a default repo base directory from existing project configs.
   * Takes the parent directory of the first configured project's repoPath.
   */
  function getDefaultRepoBase() {
    for (const cfg of Object.values(projects)) {
      if (cfg.repoPath) return dirname(cfg.repoPath);
    }
    return null;
  }

  /**
   * Ensure a project has a valid repoPath.  If missing, auto-provision one
   * by deriving it from existing project configs, creating the directory and
   * initialising a git repo if needed, then persisting to Firestore.
   *
   * @returns {boolean} true if repoPath is now valid, false if provisioning failed.
   */
  async function ensureProjectRepo(projectId, projectConfig) {
    if (projectConfig?.repoPath) return true;

    const base = getDefaultRepoBase();
    if (!base) {
      writeLogFile(`[${projectId}] Cannot auto-provision repoPath — no existing project has a repoPath configured`);
      return false;
    }

    const repoPath = join(base, projectId);
    writeLogFile(`[${projectId}] Auto-provisioning repoPath: ${basename(repoPath)}`);

    // Create directory if needed
    if (!existsSync(repoPath)) {
      mkdirSync(repoPath, { recursive: true });
      writeLogFile(`[${projectId}] Created directory ${basename(repoPath)}`);
    }

    // Init git repo if needed
    if (!existsSync(join(repoPath, '.git'))) {
      try {
        execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });

        // Seed package.json so the deploy pipeline has a version to bump from.
        const pkgPath = join(repoPath, 'package.json');
        if (!existsSync(pkgPath)) {
          const pkg = { name: projectId, version: '0.0.1', private: true };
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        }

        execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'ignore' });
        writeLogFile(`[${projectId}] Initialised git repo at ${basename(repoPath)}`);
      } catch (err) {
        writeLogFile(`[${projectId}] Failed to init git repo: ${err.message}`);
        return false;
      }
    }

    // Persist to Firestore
    try {
      await db.collection('projects').doc(projectId).set(
        { repoPath },
        { merge: true }
      );
      writeLogFile(`[${projectId}] Persisted repoPath to Firestore`);
    } catch (err) {
      writeLogFile(`[${projectId}] Failed to persist repoPath to Firestore: ${err.message}`);
      // Still usable locally even if Firestore write fails
    }

    // Update in-memory config
    if (!projects[projectId]) {
      projects[projectId] = { repoPath };
    } else {
      projects[projectId].repoPath = repoPath;
    }
    if (projectConfig) projectConfig.repoPath = repoPath;

    return true;
  }

  // ── Ensure .claude/settings.json ──────────────────────────────

  /**
   * Ensures the project repo has a .claude/settings.json with bash permissions
   * that agent workers need in acceptEdits mode.  Without this file, the SDK
   * sandbox blocks git write commands, build tools, and other essential CLI
   * operations — causing workers to spin uselessly trying workarounds.
   *
   * Only creates the file if it doesn't already exist (never overwrites
   * user-customised settings).
   */
  function ensureClaudeSettings(repoPath, projectId) {
    if (!repoPath) return;

    const settingsPath = join(repoPath, '.claude', 'settings.json');
    if (existsSync(settingsPath)) return;

    const claudeDir = join(repoPath, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const settings = {
      permissions: {
        allow: [
          'Bash(git add:*)',
          'Bash(git commit:*)',
          'Bash(git fetch:*)',
          'Bash(git rebase:*)',
          'Bash(git checkout:*)',
          'Bash(git branch:*)',
          'Bash(git stash:*)',
          'Bash(git merge:*)',
          'Bash(git log:*)',
          'Bash(git diff:*)',
          'Bash(git status:*)',
          'Bash(git show:*)',
          'Bash(git rev-parse:*)',
          'Bash(npm:*)',
          'Bash(npx:*)',
          'Bash(node:*)',
          'Bash(ls:*)',
          'Bash(find:*)',
          'Bash(cat:*)',
          'Bash(head:*)',
          'Bash(tail:*)',
          'Bash(wc:*)',
          'Bash(tree:*)',
          'Bash(pwd:*)',
          'Bash(which:*)',
          'Bash(echo:*)',
          'Bash(mkdir:*)',
          'Bash(cp:*)',
          'Bash(mv:*)',
          'Bash(rm:*)',
          'Bash(chmod:*)',
          'Bash(grep:*)',
          'Bash(sed:*)',
          'Bash(awk:*)',
          'Bash(sort:*)',
          'Bash(uniq:*)',
          'Bash(basename:*)',
          'Bash(dirname:*)',
          'Bash(bash:*)',
          'Bash(sh:*)',
        ],
        deny: [
          'Bash(git push:*)',
          'Bash(git reset --hard:*)',
        ],
      },
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    writeLogFile(`[${projectId}] Created .claude/settings.json with default agent permissions`);
  }

  // ── Bootstrap new project ──────────────────────────────────────

  /**
   * When a brand-new project is discovered with zero tickets, create a
   * bootstrap ticket that instructs the agent to scaffold the initial app.
   */
  async function bootstrapNewProject(projectId, projectData) {
    const ticketService = getTicketService(projectId);

    // Only bootstrap if the project has no tickets yet.
    const existing = await db
      .collection('projects').doc(projectId)
      .collection('tickets')
      .limit(1)
      .get();
    if (!existing.empty) return;

    const name = projectData.name || projectId;
    const context = projectData.advisorContext || '';

    // Set initial version and URL fields so the deploy pipeline, web UI
    // version indicators, and canary/release links work from the start.
    try {
      const now = new Date().toISOString();
      const fields = {
        liveVersion: 'v0.0.1',
        liveVersionAt: now,
        autoDeploy: true,
        canaryDeployCommand: 'npm run deploy:canary',
        promoteCommand: 'npm run promote:canary',
      };

      // Derive canary/release URLs from the configured pages base, and
      // create placeholder pages in the local pages repo (if configured)
      // so the links don't 404 before the first deploy.
      if (pagesBaseUrl) {
        fields.canaryUrl = `${pagesBaseUrl}/${projectId}-canary/`;
        fields.releaseUrl = `${pagesBaseUrl}/${projectId}/`;
      }

      if (pagesRepoPath && existsSync(pagesRepoPath)) {
        const pagesProjects = join(pagesRepoPath, 'projects');
        if (!existsSync(pagesProjects)) {
          mkdirSync(pagesProjects, { recursive: true });
        }

        const placeholder = [
          '<!doctype html><html lang="en"><head><meta charset="UTF-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
          `<title>${name}</title>`,
          '<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#aaa}p{text-align:center;font-size:1.2rem}</style>',
          `</head><body><p>${name} — awaiting first deploy</p></body></html>`,
        ].join('\n');

        for (const dir of [projectId, `${projectId}-canary`]) {
          const dirPath = join(pagesProjects, dir);
          if (!existsSync(dirPath)) {
            mkdirSync(dirPath, { recursive: true });
            writeFileSync(join(dirPath, 'index.html'), placeholder);
          }
        }

        try {
          execFileSync('git', ['add', `projects/${projectId}`, `projects/${projectId}-canary`], { cwd: pagesRepoPath, stdio: 'ignore' });
          execFileSync('git', ['commit', '-m', `Add placeholder pages for ${projectId}`], { cwd: pagesRepoPath, stdio: 'ignore' });
          execFileSync('git', ['push', 'origin', 'master'], { cwd: pagesRepoPath, stdio: 'ignore' });
          writeLogFile(`[${projectId}] Created and pushed placeholder pages`);
        } catch (err) {
          writeLogFile(`[${projectId}] Failed to push placeholder pages: ${err.message}`);
        }
      }

      await db.collection('projects').doc(projectId).set(fields, { merge: true });
      writeLogFile(`[${projectId}] Initialised version and URL fields`);
    } catch (err) {
      writeLogFile(`[${projectId}] Failed to set initial project fields: ${err.message}`);
    }

    const description = [
      `Set up the initial project scaffold for **${name}**.`,
      '',
      context ? `## Project description` : '',
      context ? context : '',
      context ? '' : '',
      '## What to do',
      '',
      '1. Look at what already exists in the repo (if anything).',
      '2. Based on the project description above, create a sensible initial project structure:',
      '   - `package.json` with name, scripts, and core dependencies',
      '   - Entry point / source files for the main application',
      '   - A `.gitignore` appropriate for the stack',
      '   - A brief `README.md` explaining what the project is and how to run it',
      '3. Take a real first swing at building the core functionality — don\'t just scaffold, actually implement the main idea as far as you can.',
      '4. Make sure the project builds and runs without errors.',
      '5. Commit your work and mark this ticket done.',
    ].filter(l => l !== '').join('\n');

    try {
      const ticket = await ticketService.add({
        type: 'feature',
        title: `Bootstrap ${name}`,
        description,
        userId: null,
        userEmail: 'orchestrator@docket.app',
        status: 'open',
      });
      writeLogFile(`[${projectId}] Created bootstrap ticket ${ticket.ticketId}: Bootstrap ${name}`);
    } catch (err) {
      writeLogFile(`[${projectId}] Failed to create bootstrap ticket: ${err.message}`);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────

  async function writeHeartbeat() {
    try {
      await db.collection('orchestrator').doc('config').set(
        { lastHeartbeat: new Date().toISOString() },
        { merge: true }
      );
    } catch {
      // best-effort — don't fail if heartbeat write fails
    }
  }

  function startHeartbeat() {
    // Write immediately on start, then on a regular interval
    writeHeartbeat();
    state.heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  async function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    // Clear the heartbeat so the web panel knows the orchestrator is offline
    try {
      await db.collection('orchestrator').doc('config').set(
        { lastHeartbeat: null },
        { merge: true }
      );
    } catch {
      // best-effort
    }
  }

  // ── Ticket service factory ──────────────────────────────────────

  function getTicketService(projectId) {
    if (!ticketServices.has(projectId)) {
      ticketServices.set(projectId, createTicketService(db, projectId, {
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
        arrayUnion: (...elements) => admin.firestore.FieldValue.arrayUnion(...elements),
        arrayRemove: (...elements) => admin.firestore.FieldValue.arrayRemove(...elements),
      }));
    }
    return ticketServices.get(projectId);
  }

  // ── Logging ─────────────────────────────────────────────────────

  // ── Dashboard/TUI render debounce ──────────────────────────────
  function scheduleRender() {
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => {
      state.renderTimer = null;
      if (tui.isOpen) tui.render();
      else if (dashboard.isOpen) dashboard.render();
    }, 100);
  }

  // ── Worker log flushing to Firestore ────────────────────────────

  /**
   * Schedule a debounced flush of new worker log lines to Firestore.
   * Batches writes so we don't hammer Firestore on every log line.
   */
  function scheduleLogFlush(docId) {
    if (workerLogFlushTimers.has(docId)) return;
    const timer = setTimeout(() => {
      workerLogFlushTimers.delete(docId);
      flushWorkerLog(docId);
    }, 2000);
    workerLogFlushTimers.set(docId, timer);
  }

  function flushWorkerLog(docId) {
    const lines = workerLogs.get(docId);
    if (!lines || lines.length === 0) return;
    const alreadyFlushed = workerLogFlushedCount.get(docId) || 0;
    const newLines = lines.slice(alreadyFlushed);
    if (newLines.length === 0) return;

    // Find the project for this docId
    const workerState = activeWorkers.get(docId) || pausedWorkers.get(docId);
    const info = ticketInfoCache.get(docId);
    const projectId = workerState?.projectId || info?.projectId;
    if (!projectId) return;

    const ticketService = getTicketService(projectId);
    workerLogFlushedCount.set(docId, lines.length);

    // Keep only the last 500 lines in Firestore to avoid doc size limits.
    const MAX_LOG_LINES = 500;

    if (lines.length <= MAX_LOG_LINES) {
      // Fast path: append only the new delta lines using arrayUnion.
      // This avoids rewriting previously-flushed lines on every flush.
      ticketService.appendWorkerLog(docId, newLines).catch(err => {
        writeLogFile(`Failed to append worker log for ${docId.slice(0, 8)}: ${err.message}`);
      });
    } else {
      // Trim path: total lines exceeded the cap — do a full overwrite with
      // the trimmed set so the stored array stays within document size limits.
      const allLines = lines.slice(-MAX_LOG_LINES);
      ticketService.update(docId, { workerLog: allLines }).catch(err => {
        writeLogFile(`Failed to flush worker log for ${docId.slice(0, 8)}: ${err.message}`);
      });
    }
  }

  /**
   * Append a log line to the in-memory workerLogs buffer for docId.
   * Trims the oldest entries when the buffer exceeds MAX_MEMORY_LOG_LINES so
   * long-running workers do not cause unbounded memory growth.
   * Also adjusts the flushed-line counter so the next Firestore flush still
   * sends only the truly new (unflushed) delta, even after a trim.
   */
  function appendWorkerLogLine(docId, formatted) {
    if (!workerLogs.has(docId)) workerLogs.set(docId, []);
    const lines = workerLogs.get(docId);
    lines.push(formatted);
    if (lines.length > MAX_MEMORY_LOG_LINES) {
      const excess = lines.length - MAX_MEMORY_LOG_LINES;
      lines.splice(0, excess);
      // Keep the flushed-count consistent: after trimming, the new logical
      // position of the first unflushed line has shifted by `excess` rows.
      // Clamp to zero so we never record a negative count.
      const prev = workerLogFlushedCount.get(docId) || 0;
      workerLogFlushedCount.set(docId, Math.max(0, prev - excess));
    }
  }

  function onLog(docId, line) {
    const ts = new Date().toISOString().slice(11, 19);
    const formatted = `[${ts}] ${line}`;
    // Don't write to stdout when TUI or dashboard is open — it corrupts the display.
    // All output goes to log file + workerLogs.
    if (!tui.isOpen && !dashboard.isOpen) console.log(formatted);
    writeLogFile(`[${docId.slice(0, 8)}] ${line}`);
    appendWorkerLogLine(docId, formatted);
    scheduleLogFlush(docId);
  }

  function onWorkerLog(docId, line) {
    const ts = new Date().toISOString().slice(11, 19);
    const formatted = `[${ts}] ${line}`;
    writeLogFile(`[${docId.slice(0, 8)}] ${line}`);
    appendWorkerLogLine(docId, formatted);
    scheduleLogFlush(docId);
    scheduleRender();
  }

  // ── Worker lifecycle ────────────────────────────────────────────

  function canSpawnWorker() {
    // Pause new worker spawns while the master worker is responding to a user message.
    // This ensures the master worker has full context visibility during the conversation.
    if (masterWorker.isResponding()) return false;
    return activeWorkers.size < config.maxWorkers && !state.shuttingDown && !state.maintenanceRunning;
  }

  /**
   * Reset the in-memory worker logs and clear Firestore workerLog for a fresh session.
   * Called when a new or resumed worker session begins.
   */
  function resetWorkerLog(docId, projectId) {
    // Cancel any pending flush timer
    const timer = workerLogFlushTimers.get(docId);
    if (timer) {
      clearTimeout(timer);
      workerLogFlushTimers.delete(docId);
    }
    // Reset in-memory state
    workerLogs.set(docId, []);
    workerLogFlushedCount.set(docId, 0);
    // Clear the stored workerLog in Firestore
    const ticketService = getTicketService(projectId);
    ticketService.update(docId, { workerLog: [] }).catch(err => {
      writeLogFile(`Failed to clear workerLog for ${docId.slice(0, 8)}: ${err.message}`);
    });
  }

  /**
   * Claim a worker slot and spawn — matches KB orchestrator pattern.
   * Reserves the slot SYNCHRONOUSLY so concurrent snapshot events
   * see an accurate count before the async claim/spawn completes.
   * Then fire-and-forget the actual worker.
   */
  async function claimAndSpawn(docId, projectId, resumeCtx) {
    if (activeWorkers.has(docId) || pausedWorkers.has(docId)) return;

    // Reserve the slot immediately (synchronously)
    const ac = new AbortController();
    const info = ticketInfoCache.get(docId) || {};
    activeWorkers.set(docId, {
      projectId,
      ticketId: info.ticketId || resumeCtx?.ticketId || null,
      worktreeDir: resumeCtx?.worktreeDir || null,
      ac,
      sessionId: resumeCtx?.sessionId || null,
      startedAt: Date.now(),
      phase: resumeCtx ? 'resuming' : 'claiming',
    });
    scheduleRender();

    // Fire and forget — worker runs in background
    if (resumeCtx) {
      doResumeWorker(docId, { projectId, ac, ...resumeCtx }).catch(err => {
        writeLogFile(`UNCAUGHT RESUME ERROR [${docId.slice(0, 8)}] ${err.stack || err.message}`);
      });
    } else {
      doSpawnWorker(docId, projectId, ac).catch(err => {
        writeLogFile(`UNCAUGHT SPAWN ERROR [${docId.slice(0, 8)}] ${err.stack || err.message}`);
      });
    }
  }

  function handleNewTicket(docId, ticketData, projectId) {
    // Skip if already active, paused, queued, or being claimed
    if (activeWorkers.has(docId) || pausedWorkers.has(docId)) return;
    if (claimingTickets.has(docId)) return;
    if (queue.some(q => q.docId === docId)) return;

    // Cache ticket info
    ticketInfoCache.set(docId, {
      ticketId: ticketData.ticketId,
      title: ticketData.title,
      projectId,
      advisorPersona: ticketData.advisorPersona || null,
    });

    writeLogFile(`New ticket: ${ticketData.ticketId} (${ticketData.title}) in ${projectId}`);

    // Always go through the queue so the stagger applies uniformly.
    // dequeueNext() will start the worker immediately if there's no stagger pending.
    // Critical tickets bypass the worker cap in dequeueNext().
    const entry = {
      docId,
      ticketId: ticketData.ticketId,
      title: ticketData.title,
      projectId,
      userId: ticketData.userId || null,
      critical: !!(ticketData.critical),
      advisorPersona: ticketData.advisorPersona || null,
    };
    enqueueWithPriority(entry);
    const criticalTag = entry.critical ? ' [CRITICAL]' : '';
    writeLogFile(`Queued ${ticketData.ticketId}${criticalTag} (${activeWorkers.size}/${config.maxWorkers} workers busy)`);
    dequeueNext();

    scheduleRender();
  }

  /**
   * Called when an open ticket's critical flag is set to true while it is
   * already sitting in the queue (or when it first appears as critical).
   *
   * - If the ticket is already active or paused, do nothing — it's already
   *   being worked on.
   * - If it is in the queue, upgrade its entry to critical === true, re-insert
   *   it at the front of the priority order, and call dequeueNext() so it can
   *   bypass the worker cap and start immediately.
   * - If it is not queued yet, delegate to handleNewTicket() so the ticket is
   *   enqueued with the correct priority right away.
   */
  function handleCriticalUpgrade(docId, ticketData, projectId) {
    // Already being worked on or claimed — nothing to do.
    if (activeWorkers.has(docId) || pausedWorkers.has(docId)) return;
    if (claimingTickets.has(docId)) return;

    const existingIdx = queue.findIndex(q => q.docId === docId);

    if (existingIdx !== -1) {
      // The ticket is in the queue but was not yet critical.
      // If it is already marked critical in the queue entry, dequeueNext()
      // was already called at enqueue time — nothing more to do.
      if (queue[existingIdx].critical) return;

      // Remove from its current position, then re-insert with critical=true
      // so enqueueWithPriority() places it at the front.
      queue.splice(existingIdx, 1);
      // Reconstruct from ticketInfoCache to get the freshest data.
      const info = ticketInfoCache.get(docId) || {};
      const entry = {
        docId,
        ticketId: info.ticketId || ticketData.ticketId,
        title: info.title || ticketData.title,
        projectId,
        userId: ticketData.userId || null,
        critical: true,
        advisorPersona: ticketData.advisorPersona || null,
      };
      enqueueWithPriority(entry);
      const criticalTag = '[CRITICAL UPGRADE]';
      writeLogFile(`${criticalTag} ${entry.ticketId} promoted to critical in queue (${activeWorkers.size}/${config.maxWorkers} workers busy)`);
      dequeueNext();
      scheduleRender();
    } else {
      // Not in the queue yet — handleNewTicket will enqueue it with critical priority.
      handleNewTicket(docId, ticketData, projectId);
    }
  }

  async function doSpawnWorker(docId, projectId, ac) {
    const projectConfig = projects[projectId];
    const ticketService = getTicketService(projectId);

    // Worker state was pre-reserved by claimAndSpawn
    const workerState = activeWorkers.get(docId);
    if (!workerState) return;

    // Auto-provision repoPath for projects created via the web UI.
    if (!projectConfig?.repoPath) {
      const ok = await ensureProjectRepo(projectId, projectConfig);
      if (!ok) {
        activeWorkers.delete(docId);
        const ticketId = ticketInfoCache.get(docId)?.ticketId || docId.slice(0, 8);
        const msg = `Project "${projectId}" has no repoPath and auto-provisioning failed. Set repoPath in the admin panel.`;
        onLog(docId, `Blocking ${ticketId}: ${msg}`);
        writeLogFile(`[${docId.slice(0, 8)}] Blocked — could not auto-provision repoPath for project ${projectId}`);
        recentErrors.unshift({
          docId,
          ticketId,
          projectId,
          error: msg,
          timestamp: Date.now(),
        });
        if (recentErrors.length > 10) recentErrors.length = 10;
        try {
          await ticketService.transitionStatus(docId, 'blocked', {
            note: msg,
            workerPhase: null,
            workerStartedAt: null,
          });
        } catch (err) {
          writeLogFile(`[${docId.slice(0, 8)}] Failed to block ticket: ${err.message}`);
        }
        scheduleRender();
        dequeueNext();
        return;
      }
    }

    // Ensure the project repo has a .claude/settings.json so agent workers
    // running in acceptEdits mode have the bash permissions they need (git,
    // build tools, common CLI utilities).  Without this file, git add/commit
    // and build commands are silently blocked by the SDK sandbox.
    ensureClaudeSettings(projectConfig.repoPath, projectId);

    // Clear any previous session logs so the web panel shows a fresh log
    resetWorkerLog(docId, projectId);

    try {
      const effectiveModel = getEffectiveModel();
      const result = await spawnWorker(docId, {
        projectId,
        ticketService,
        projectConfig,
        db,
        model: effectiveModel,
        userId,
        firebaseKeyPath,
        workerIdleTimeoutMs,
        abortController: ac,
        onLog,
        onWorkerLog,
        nonSonnetMode: state.nonSonnetMode,
        bypassPermissions,
        onStarted: (worktreeDir) => {
          workerState.worktreeDir = worktreeDir;
          workerState.phase = 'running';
          const info = ticketInfoCache.get(docId);
          if (info) workerState.ticketId = info.ticketId;
          scheduleRender();
        },
      });

      workerState.sessionId = result.sessionId;
      workerState.ticketId = result.ticketId;
      workerState.worktreeDir = result.worktreeDir;
      workerState.costUsd = result.costUsd || 0;
      workerState.phase = 'finalizing';
      scheduleRender();

      const workerDurationMs = Date.now() - workerState.startedAt;

      // Finalize
      await finalizeWorker(docId, {
        projectId,
        ticketService,
        projectConfig,
        onMerge: (ticketId, repoPath) => mergeQueueManager.enqueueMerge(
          ticketId, repoPath, {
            projectConfig, allProjects: projects, ticketService, docId, projectId, db,
            onLog: (msg) => onLog(docId, msg),
            costUsd: workerState.costUsd,
            durationMs: workerDurationMs,
          },
        ),
        onPause: handlePause,
        onDequeue: dequeueNext,
        onCleanup: (id) => {
          activeWorkers.delete(id);
          scheduleRender();
        },
        worktreeDir: result.worktreeDir,
        ticketId: result.ticketId,
        sessionId: result.sessionId,
        onLog,
        // In non-sonnet mode, the agent can request an upgrade to opus for complex tasks.
        onUpgrade: state.nonSonnetMode ? handleUpgrade : null,
      });
    } catch (err) {
      activeWorkers.delete(docId);

      // Check if this abort was triggered by maintenance (not a real error).
      // pauseActiveWorkersForMaintenance() calls ac.abort('maintenance-pause').
      // In that case, reset cleanly to 'open' with an informational note and
      // do NOT record it as an error — the ticket will be re-queued naturally
      // by the Firestore listener once maintenance releases the worker gate.
      if (ac.signal.aborted && ac.signal.reason === 'maintenance-pause') {
        onLog(docId, `Worker paused for maintenance — resetting ${workerState.ticketId || docId.slice(0, 8)} to open`);
        writeLogFile(`[${docId.slice(0, 8)}] Paused for maintenance`);
        try {
          await ticketService.transitionStatus(docId, 'open', {
            note: 'Paused for maintenance — will be re-queued automatically',
            workerPhase: null,
            workerStartedAt: null,
          });
        } catch {
          // ignore
        }
        if (workerState.worktreeDir) {
          cleanupWorktree(workerState.worktreeDir, projectConfig.repoPath);
        }
        scheduleRender();
        dequeueNext();
        return;
      }

      const friendlyError = describeError(err);
      onLog(docId, `Worker error: ${friendlyError}`);
      writeLogFile(`ERROR [${docId.slice(0, 8)}] ${err.stack || err.message}`);

      // Track error for dashboard display
      const info = ticketInfoCache.get(docId) || {};
      recentErrors.unshift({
        docId,
        ticketId: info.ticketId || workerState.ticketId || docId.slice(0, 8),
        projectId,
        error: friendlyError,
        timestamp: Date.now(),
      });
      // Keep only last 10 errors
      if (recentErrors.length > 10) recentErrors.length = 10;
      scheduleRender();

      // Clean up worktree if it was created
      if (workerState.worktreeDir) {
        cleanupWorktree(workerState.worktreeDir, projectConfig.repoPath);
      }

      // If the worker was killed by the idle timeout, apply a cooldown before
      // requeueing to prevent hammering a rate-limited / hung API.
      const isIdleTimeout = ac.signal.aborted && ac.signal.reason !== 'maintenance-pause';
      if (isIdleTimeout && workerCooldownMs > 0) {
        const mins = Math.round(workerCooldownMs / 60000);
        const ticketLabel = workerState.ticketId || docId.slice(0, 8);
        onLog(docId, `Cooling down ${ticketLabel} for ${mins}m before requeue`);
        writeLogFile(`[${docId.slice(0, 8)}] Cooldown ${mins}m after idle timeout`);
        ticketService.update(docId, { workerPhase: 'cooldown', workerStartedAt: null }).catch(() => {});
        dequeueNext(); // Free the worker slot immediately
        setTimeout(async () => {
          try {
            await ticketService.transitionStatus(docId, 'open', {
              note: `Requeued after ${mins}m cooldown (session timed out)`,
              workerPhase: null,
              workerStartedAt: null,
            });
          } catch { /* ignore */ }
        }, workerCooldownMs);
      } else {
        // Non-timeout error — reset immediately
        try {
          await ticketService.transitionStatus(docId, 'open', {
            note: `Orchestrator worker error: ${err.message}`,
            workerPhase: null,
            workerStartedAt: null,
          });
        } catch {
          // ignore
        }
        dequeueNext();
      }
    }
  }

  function handlePause(docId, { ticketId, question, sessionId, worktreeDir, projectId }) {
    // Remove from active
    activeWorkers.delete(docId);

    // Add to paused — the single per-project waiting_for_user listener (started
    // in start()) will detect when this ticket leaves waiting_for_user status and
    // call handleResume, so no per-ticket document listener is needed here.
    const pausedState = {
      projectId,
      ticketId,
      worktreeDir,
      sessionId,
      question,
    };

    pausedWorkers.set(docId, pausedState);

    writeLogFile(`Paused ${ticketId} — waiting for user`);
    scheduleRender();
  }

  async function handleResume(docId) {
    const paused = pausedWorkers.get(docId);
    if (!paused) return;

    pausedWorkers.delete(docId);

    const resumeCtx = {
      ticketId: paused.ticketId,
      sessionId: paused.sessionId,
      worktreeDir: paused.worktreeDir,
    };

    if (!canSpawnWorker()) {
      // Re-queue for later
      queue.unshift({
        docId,
        ticketId: paused.ticketId,
        title: ticketInfoCache.get(docId)?.title || '',
        projectId: paused.projectId,
        _resume: resumeCtx,
      });
      writeLogFile(`Re-queued ${paused.ticketId} for resume (no worker slots)`);
      scheduleRender();
      return;
    }

    claimAndSpawn(docId, paused.projectId, resumeCtx).catch(err => {
      writeLogFile(`Resume claim error: ${err.stack || err.message}`);
    });
  }

  /**
   * Handle a worker's request to upgrade from haiku to opus in non-sonnet mode.
   * The haiku agent sets requestUpgrade: true on the ticket when it detects the
   * task is too complex. We restart the session with the upgradeModel (opus).
   */
  function handleUpgrade(docId, { ticketId, worktreeDir, sessionId, projectId }) {
    // Remove from active — the upgrade session is treated as a fresh resume with opus
    activeWorkers.delete(docId);

    writeLogFile(`[non-sonnet] ${ticketId} upgrading to ${upgradeModel} (haiku requested upgrade)`);
    scheduleRender();

    const upgradeCtx = {
      ticketId,
      sessionId,
      worktreeDir,
      _upgradeModel: upgradeModel, // signal to use opus instead of effective model
    };

    claimAndSpawn(docId, projectId, upgradeCtx).catch(err => {
      writeLogFile(`Upgrade claim error: ${err.stack || err.message}`);
    });
  }

  async function doResumeWorker(docId, ctx) {
    const { projectId, ac } = ctx;
    const projectConfig = projects[projectId];
    const ticketService = getTicketService(projectId);

    // Worker state was pre-reserved by claimAndSpawn
    const workerState = activeWorkers.get(docId);
    if (!workerState) return;

    // For resumes we keep the existing logs and append — don't clear.
    // Just cancel any stale flush timer so we start fresh.
    const timer = workerLogFlushTimers.get(docId);
    if (timer) {
      clearTimeout(timer);
      workerLogFlushTimers.delete(docId);
    }

    ensureClaudeSettings(projectConfig?.repoPath, projectId);

    try {
      // Use the upgrade model (opus) if this resume was triggered by a complexity upgrade request.
      // Otherwise use the normal effective model.
      const effectiveModel = ctx._upgradeModel || getEffectiveModel();
      if (ctx._upgradeModel) {
        onLog(docId, `Resuming with upgrade model: ${effectiveModel}`);
        writeLogFile(`[non-sonnet] ${ctx.ticketId} running with upgrade model ${effectiveModel}`);
      }
      const result = await resumeWorker(docId, {
        projectId,
        ticketService,
        projectConfig,
        db,
        model: effectiveModel,
        userId,
        firebaseKeyPath,
        workerIdleTimeoutMs,
        abortController: ac,
        sessionId: ctx.sessionId,
        worktreeDir: ctx.worktreeDir,
        ticketId: ctx.ticketId,
        onLog,
        onWorkerLog,
        // In non-sonnet mode, include upgrade instructions unless this IS the upgrade session.
        nonSonnetMode: state.nonSonnetMode && !ctx._upgradeModel,
        bypassPermissions,
        onStarted: (worktreeDir) => {
          workerState.phase = 'running';
          scheduleRender();
        },
      });

      workerState.sessionId = result.sessionId;
      workerState.costUsd = result.costUsd || 0;

      const workerDurationMs = Date.now() - workerState.startedAt;

      // Finalize
      await finalizeWorker(docId, {
        projectId,
        ticketService,
        projectConfig,
        onMerge: (ticketId, repoPath) => mergeQueueManager.enqueueMerge(
          ticketId, repoPath, {
            projectConfig, allProjects: projects, ticketService, docId, projectId, db,
            onLog: (msg) => onLog(docId, msg),
            costUsd: workerState.costUsd,
            durationMs: workerDurationMs,
          },
        ),
        onPause: handlePause,
        onDequeue: dequeueNext,
        onCleanup: (id) => {
          activeWorkers.delete(id);
          scheduleRender();
        },
        worktreeDir: result.worktreeDir,
        ticketId: result.ticketId,
        sessionId: result.sessionId,
        onLog,
        // In non-sonnet mode, the agent can request an upgrade to opus for complex tasks.
        onUpgrade: state.nonSonnetMode ? handleUpgrade : null,
      });
    } catch (err) {
      activeWorkers.delete(docId);

      // Check if this abort was triggered by maintenance (not a real error).
      // pauseActiveWorkersForMaintenance() calls ac.abort('maintenance-pause').
      if (ac.signal.aborted && ac.signal.reason === 'maintenance-pause') {
        onLog(docId, `Worker paused for maintenance — resetting ${ctx.ticketId || docId.slice(0, 8)} to open`);
        writeLogFile(`[${docId.slice(0, 8)}] Paused for maintenance (resume)`);
        try {
          await ticketService.transitionStatus(docId, 'open', {
            note: 'Paused for maintenance — will be re-queued automatically',
            workerPhase: null,
            workerStartedAt: null,
          });
        } catch {
          // ignore
        }
        if (ctx.worktreeDir) {
          cleanupWorktree(ctx.worktreeDir, projectConfig.repoPath);
        }
        scheduleRender();
        dequeueNext();
        return;
      }

      const friendlyError = describeError(err);
      onLog(docId, `Resume error: ${friendlyError}`);
      writeLogFile(`ERROR [${docId.slice(0, 8)}] ${err.stack || err.message}`);

      // Track error for dashboard display
      recentErrors.unshift({
        docId,
        ticketId: ctx.ticketId || docId.slice(0, 8),
        projectId,
        error: friendlyError,
        timestamp: Date.now(),
      });
      if (recentErrors.length > 10) recentErrors.length = 10;
      scheduleRender();

      cleanupWorktree(ctx.worktreeDir, projectConfig.repoPath);
      dequeueNext();
    }
  }

  const { enqueueWithPriority, dequeueNext } = createQueue(state, {
    canSpawnWorker,
    claimAndSpawn,
    scheduleRender,
    writeLogFile,
    masterWorker,
    workerStaggerMs,
  });

  // ── Startup recovery ────────────────────────────────────────────

  async function resetOrphanedTickets() {
    console.log('[orchestrator] Checking for orphaned in_progress tickets...');
    writeLogFile('Checking for orphaned in_progress tickets...');

    for (const [projectId] of Object.entries(projects)) {
      const ticketService = getTicketService(projectId);
      try {
        const count = await ticketService.rekickOrchestrator();
        if (count > 0) {
          console.log(`[orchestrator] Reset ${count} orphaned ticket(s) in ${projectId}`);
          writeLogFile(`Reset ${count} orphaned ticket(s) in ${projectId}`);
        }
      } catch (err) {
        console.error(`[orchestrator] Error resetting tickets in ${projectId}: ${err.message}`);
        writeLogFile(`Error resetting tickets in ${projectId}: ${err.message}`);
      }
    }
  }

  // ── Keyboard handling ───────────────────────────────────────────

  function startKeyboardHandler() {
    if (!process.stdin.isTTY) return;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', async (key) => {
      // Classic dashboard is open — delegate (overrides TUI)
      if (dashboard.isOpen) {
        const result = dashboard.handleKey(key);
        if (result === 'quit') {
          await shutdown();
          process.exit(0);
        }
        if (result === 'rekick') {
          await resetOrphanedTickets();
          dashboard.render();
        }
        if (result === 'maintenance') {
          if (state.maintenanceRunning) {
            writeLogFile('Maintenance already running — ignoring manual trigger');
          } else {
            writeLogFile('Manual maintenance triggered via keyboard');
            // Cancel the scheduled timer so we don't double-run
            if (state.maintenanceTimer) {
              clearTimeout(state.maintenanceTimer);
              state.maintenanceTimer = null;
            }
            runScheduledMaintenance().catch(err => {
              writeLogFile(`Manual maintenance error: ${err.stack || err.message}`);
            });
          }
          dashboard.render();
        }
        if (result === 'pool_up') {
          config.maxWorkers++;
          writeLogFile(`Max workers increased to ${config.maxWorkers}`);
          dashboard.render();
          dequeueNext();
          db.collection('orchestrator').doc('config').set(
            { maxWorkers: config.maxWorkers },
            { merge: true }
          ).catch(err => writeLogFile(`Failed to sync pool size: ${err.message}`));
        }
        if (result === 'pool_down') {
          config.maxWorkers = Math.max(1, config.maxWorkers - 1);
          writeLogFile(`Max workers decreased to ${config.maxWorkers}`);
          dashboard.render();
          db.collection('orchestrator').doc('config').set(
            { maxWorkers: config.maxWorkers },
            { merge: true }
          ).catch(err => writeLogFile(`Failed to sync pool size: ${err.message}`));
        }
        // If classic dashboard closed itself (ESC), return to TUI
        if (!dashboard.isOpen && result !== 'quit') {
          tui.open();
        }
        return;
      }

      // Fancy TUI is open — delegate
      if (tui.isOpen) {
        // 'd' opens classic dashboard (TUI closes itself via ESC / its own quit)
        if (key === 'd') {
          tui.close();
          dashboard.open();
          return;
        }
        const result = tui.handleKey(key);
        if (result === 'quit') {
          await shutdown();
          process.exit(0);
        }
        if (result === 'rekick') {
          await resetOrphanedTickets();
          tui.render();
        }
        if (result === 'maintenance') {
          if (state.maintenanceRunning) {
            writeLogFile('Maintenance already running — ignoring manual trigger');
          } else {
            writeLogFile('Manual maintenance triggered via keyboard');
            if (state.maintenanceTimer) {
              clearTimeout(state.maintenanceTimer);
              state.maintenanceTimer = null;
            }
            runScheduledMaintenance().catch(err => {
              writeLogFile(`Manual maintenance error: ${err.stack || err.message}`);
            });
          }
          tui.render();
        }
        if (result === 'pool_up') {
          config.maxWorkers++;
          writeLogFile(`Max workers increased to ${config.maxWorkers}`);
          tui.render();
          dequeueNext();
          db.collection('orchestrator').doc('config').set(
            { maxWorkers: config.maxWorkers },
            { merge: true }
          ).catch(err => writeLogFile(`Failed to sync pool size: ${err.message}`));
        }
        if (result === 'pool_down') {
          config.maxWorkers = Math.max(1, config.maxWorkers - 1);
          writeLogFile(`Max workers decreased to ${config.maxWorkers}`);
          tui.render();
          db.collection('orchestrator').doc('config').set(
            { maxWorkers: config.maxWorkers },
            { merge: true }
          ).catch(err => writeLogFile(`Failed to sync pool size: ${err.message}`));
        }
        return;
      }

      // Both UIs closed — global shortcuts
      switch (key) {
        case 't':
          tui.open();
          break;
        case 'd':
          dashboard.open();
          break;
        case 'q':
        case '\x03': // Ctrl+C
          await shutdown();
          process.exit(0);
          break;
        case 'r':
          await resetOrphanedTickets();
          break;
        default:
          break;
      }
    });
  }

  // ── Scheduled Maintenance ────────────────────────────────────────

  /**
   * Abort all currently active workers so maintenance can run safely.
   * Each aborted worker's ticket will be reset to 'open' by the worker's
   * error handler, which means the Firestore listener will re-queue them.
   * While maintenanceRunning is true, canSpawnWorker() returns false, so
   * re-queued tickets wait in the queue until maintenance completes.
   *
   * Also saves synthetic WIP for each worker so the next session can
   * pick up from a reasonable starting point.
   */
  async function pauseActiveWorkersForMaintenance() {
    if (activeWorkers.size === 0) return;
    writeLogFile(`Pausing ${activeWorkers.size} active worker(s) for maintenance...`);
    for (const [docId, worker] of activeWorkers) {
      writeLogFile(`  Aborting worker for ${worker.ticketId || docId}`);

      // Save synthetic WIP so the worker can resume with context after maintenance
      try {
        const ticketService = getTicketService(worker.projectId);
        const ticket = await ticketService.getById(docId);
        if (ticket && !ticket.workInProgress) {
          const logs = workerLogs.get(docId) || [];
          const lastLogs = logs.slice(-30).join('\n');
          await ticketService.update(docId, {
            workInProgress: {
              goal: ticket.title,
              lastLogs: lastLogs || '(no logs captured)',
              source: 'maintenance-pause',
              savedAt: new Date().toISOString(),
            },
          });
        }
      } catch {
        // best-effort — don't block maintenance
      }

      if (worker.ac) worker.ac.abort('maintenance-pause');
    }
  }

  /**
   * Returns true if any project has tickets in blocked or in_maintenance state.
   * Used as a cheap pre-check so we only pause workers when there's real work to do.
   */
  async function maintenanceHasWork() {
    for (const projectId of registeredProjectIds) {
      try {
        const snap = await db
          .collection('projects').doc(projectId)
          .collection('tickets')
          .where('status', 'in', ['blocked', 'in_maintenance'])
          .limit(1)
          .get();
        if (!snap.empty) return true;
      } catch {
        // If we can't check, assume there might be work
        return true;
      }
    }
    return false;
  }

  async function runScheduledMaintenance() {
    if (state.maintenanceRunning || state.shuttingDown) return;
    state.maintenanceRunning = true;
    // Clear any pending blocked-ticket debounce timer since we're running now
    if (state.blockedMaintenanceTimer) {
      clearTimeout(state.blockedMaintenanceTimer);
      state.blockedMaintenanceTimer = null;
    }
    writeLogFile('Scheduled maintenance starting...');

    // Pre-check: only pause workers if there are actually broken tickets.
    // Without this, every periodic maintenance pass would abort in-progress
    // workers and reset their tickets to 'open' even when nothing is wrong.
    const hasWork = await maintenanceHasWork();
    if (hasWork) {
      // Pause all active workers so maintenance has exclusive access to git repos
      // and the deploy pipeline. The aborted workers will reset their tickets to
      // 'open', which will be re-queued and picked up after maintenance completes.
      await pauseActiveWorkersForMaintenance();

      // Wait for aborted workers to finish their cleanup (resetting tickets to
      // 'open') before maintenance starts scanning for problems to fix.
      if (activeWorkers.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } else {
      writeLogFile('No broken tickets found — skipping worker pause.');
    }

    let hasMoreProblems = false;
    try {
      const result = await runMaintenance({
        db,
        projects,
        dryRun: false,
        allProjects: projects,
        onLog: (msg) => writeLogFile(msg),
      });
      hasMoreProblems = result.hasMoreProblems;
    } catch (err) {
      writeLogFile(`Scheduled maintenance error: ${err.stack || err.message}`);
    } finally {
      state.maintenanceRunning = false;
      // Allow queued tickets to start now that maintenance has released the worker gate
      dequeueNext();
      if (state.shuttingDown) return;

      // If a maintenance run was requested while we were busy (blocked ticket or
      // "Run Now" click), run immediately instead of waiting for the next scheduled
      // interval.
      if (state.pendingMaintenanceAfterCurrent || hasMoreProblems) {
        state.pendingMaintenanceAfterCurrent = false;
        const reason = hasMoreProblems ? 'remaining problems found' : 'was requested while busy';
        writeLogFile(`Running follow-up maintenance (${reason})...`);
        // Run on next tick so callers see maintenanceRunning = false first
        setTimeout(() => {
          runScheduledMaintenance().catch(err => {
            writeLogFile(`Follow-up maintenance error: ${err.stack || err.message}`);
          });
        }, 0);
      } else {
        // Schedule next periodic run
        state.maintenanceTimer = setTimeout(runScheduledMaintenance, maintenanceIntervalMs);
      }
    }
  }

  /**
   * Called when a ticket transitions into the 'blocked' state.
   * Triggers an immediate maintenance pass (debounced by 2s to coalesce
   * rapid successive blocked events).
   */
  function handleBlockedTicket(docId, ticketData, projectId) {
    if (state.shuttingDown) return;
    writeLogFile(`Blocked ticket detected: ${ticketData.ticketId || docId} in ${projectId} — scheduling immediate maintenance`);

    // If maintenance is already running, mark a pending run so that it starts
    // again immediately after the current pass completes (rather than silently
    // dropping the request and waiting for the next scheduled interval).
    if (state.maintenanceRunning) {
      state.pendingMaintenanceAfterCurrent = true;
      return;
    }

    // Debounce: wait 2 seconds to coalesce multiple rapid blocked events
    // into a single maintenance pass.
    if (state.blockedMaintenanceTimer) return;
    state.blockedMaintenanceTimer = setTimeout(() => {
      state.blockedMaintenanceTimer = null;
      // Cancel the regularly-scheduled timer so we don't double-run
      if (state.maintenanceTimer) {
        clearTimeout(state.maintenanceTimer);
        state.maintenanceTimer = null;
      }
      runScheduledMaintenance();
    }, 2000);
  }

  // ── Start / Shutdown ────────────────────────────────────────────

  async function start() {
    console.log('[orchestrator] Starting...');
    console.log(`[orchestrator] Projects: ${Object.keys(projects).join(', ')}`);
    console.log(`[orchestrator] Max workers: ${maxWorkers}, Model: ${model}`);
    console.log(`[orchestrator] User: ${userId}`);
    console.log(`[orchestrator] Idle timeout: ${Math.round(workerIdleTimeoutMs / 1000)}s`);
    console.log(`[orchestrator] Maintenance interval: ${Math.round(maintenanceIntervalMs / 1000)}s (first run in 30s)`);
    console.log(`[orchestrator] Auth: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'OAuth token (Max subscription)' : 'API credits (no CLAUDE_CODE_OAUTH_TOKEN)'}`);
    console.log(`[orchestrator] Permission mode: ${bypassPermissions ? 'bypassPermissions (FULL BYPASS — operator-enabled)' : 'acceptEdits (default)'}`);
    console.log(`[orchestrator] Log file: ${logFile}`);
    console.log('');
    writeLogFile('=== Orchestrator starting ===');
    writeLogFile(`Projects: ${Object.keys(projects).join(', ')}, Max workers: ${maxWorkers}, Model: ${model}`);
    writeLogFile(`Idle timeout: ${Math.round(workerIdleTimeoutMs / 1000)}s`);
    if (bypassPermissions) {
      writeLogFile('WARNING: bypassPermissions=true — all SDK permission checks disabled for worker sessions');
    }

    // Reset orphaned tickets from previous runs
    await resetOrphanedTickets();

    // If the orchestrator/maintenance doc is stuck in 'running' state from a
    // previous crash, reset it to 'idle' so the web UI's Run Now button is
    // re-enabled and a new manual trigger can be accepted.
    try {
      const maintSnap = await db.collection('orchestrator').doc('maintenance').get();
      if (maintSnap.exists && maintSnap.data().status === 'running') {
        await db.collection('orchestrator').doc('maintenance').set(
          {
            status: 'idle',
            phase: 'reset',
            result: null,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        writeLogFile('Reset stale maintenance status (was stuck in running state)');
        console.log('[orchestrator] Reset stale maintenance status (was stuck in running state)');
      }
    } catch (err) {
      writeLogFile(`Failed to reset maintenance status: ${err.message}`);
    }

    // Sync pool size with Firestore:
    // - If a value was previously set (e.g. via web UI), use it.
    // - Otherwise publish the config-file default so the doc exists.
    // Also pre-seed lastSeenManualTrigger so the initial onSnapshot does not
    // treat a stale manualTrigger value as a new trigger and run maintenance
    // spuriously at every restart.
    try {
      const configSnap = await db.collection('orchestrator').doc('config').get();
      if (configSnap.exists) {
        const configData = configSnap.data();
        if (typeof configData.maxWorkers === 'number') {
          const stored = configData.maxWorkers;
          if (stored > MAX_WORKERS_LIMIT) {
            writeLogFile(`WARNING: Firestore maxWorkers value (${stored}) exceeds maximum allowed (${MAX_WORKERS_LIMIT}) — ignoring suspicious value`);
          } else if (stored >= 1 && stored !== config.maxWorkers) {
            config.maxWorkers = stored;
            writeLogFile(`Restored maxWorkers from Firestore: ${config.maxWorkers}`);
          }
        } else {
          await db.collection('orchestrator').doc('config').set(
            { maxWorkers: config.maxWorkers },
            { merge: true }
          );
        }
        // Pre-seed so the initial onSnapshot doesn't re-fire an old trigger
        if (configData.manualTrigger) {
          state.lastSeenManualTrigger = configData.manualTrigger;
          writeLogFile(`Pre-seeded lastSeenManualTrigger: ${configData.manualTrigger}`);
        }
        // Pre-seed killSignal so an old value doesn't trigger a kill on restart
        if (configData.killSignal) {
          state.lastSeenKillSignal = configData.killSignal;
          writeLogFile(`Pre-seeded lastSeenKillSignal: ${configData.killSignal}`);
        }
        // Pre-seed promoteCanary so stale promotion requests don't re-fire on restart
        if (configData.promoteCanary && typeof configData.promoteCanary === 'object') {
          for (const [pid, ts] of Object.entries(configData.promoteCanary)) {
            if (ts) {
              lastSeenPromoteCanary[pid] = ts;
              writeLogFile(`Pre-seeded lastSeenPromoteCanary[${pid}]: ${ts}`);
            }
          }
        }
        // Restore sonnetPaused so we start in the correct model mode
        if (typeof configData.sonnetPaused === 'boolean') {
          state.nonSonnetMode = configData.sonnetPaused;
          if (state.nonSonnetMode) {
            writeLogFile(`[non-sonnet] Restored sonnetPaused=true — starting in non-sonnet mode (${fallbackModel || 'haiku'})`);
          }
        }
      } else {
        await db.collection('orchestrator').doc('config').set(
          { maxWorkers: config.maxWorkers },
          { merge: true }
        );
      }
    } catch (err) {
      writeLogFile(`Failed to sync initial config: ${err.message}`);
    }

    // Start the master worker — listens for user chat messages via Firestore
    masterWorker.start();

    // Start heartbeat — writes lastHeartbeat to Firestore every 15 s so the
    // web panel can detect when the orchestrator is no longer running.
    startHeartbeat();

    // Listen to Firestore orchestrator config for live pool size and manual trigger changes
    const configUnsub = db.collection('orchestrator').doc('config').onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        if (typeof data.maxWorkers === 'number' && data.maxWorkers >= 1 && data.maxWorkers <= MAX_WORKERS_LIMIT) {
          const prev = config.maxWorkers;
          config.maxWorkers = data.maxWorkers;
          if (prev !== config.maxWorkers) {
            writeLogFile(`Max workers updated via web UI: ${prev} → ${config.maxWorkers}`);
            scheduleRender();
            // Dequeue next if pool was increased
            if (config.maxWorkers > prev) dequeueNext();
          }
        } else if (typeof data.maxWorkers === 'number' && data.maxWorkers > MAX_WORKERS_LIMIT) {
          writeLogFile(`WARNING: Ignoring suspicious maxWorkers value from Firestore: ${data.maxWorkers} (max allowed: ${MAX_WORKERS_LIMIT})`);
        }
        // Check for sonnetPaused toggle from the web UI
        // When true, workers use haiku by default (non-sonnet mode).
        if (typeof data.sonnetPaused === 'boolean' && data.sonnetPaused !== state.nonSonnetMode) {
          state.nonSonnetMode = data.sonnetPaused;
          if (state.nonSonnetMode) {
            writeLogFile(`[non-sonnet] Sonnet paused — workers will use ${fallbackModel || 'haiku'} (upgrade: ${upgradeModel})`);
          } else {
            writeLogFile(`[non-sonnet] Sonnet resumed — workers will use ${model}`);
          }
          scheduleRender();
        }

        // Check for a kill signal from the web UI
        if (data.killSignal && data.killSignal !== state.lastSeenKillSignal) {
          state.lastSeenKillSignal = data.killSignal;
          writeLogFile('Kill signal received from web UI — shutting down');
          console.log('\n[orchestrator] Kill signal received from web UI.');
          shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
          return;
        }
        // Check for a manual maintenance trigger from the web UI
        if (data.manualTrigger && data.manualTrigger !== state.lastSeenManualTrigger) {
          state.lastSeenManualTrigger = data.manualTrigger;
          if (state.maintenanceRunning) {
            // Queue a follow-up run so "Run Now" is never silently dropped
            writeLogFile('Maintenance already running — queuing a follow-up run after current pass');
            state.pendingMaintenanceAfterCurrent = true;
          } else {
            writeLogFile('Manual maintenance triggered via web UI');
            if (state.maintenanceTimer) {
              clearTimeout(state.maintenanceTimer);
              state.maintenanceTimer = null;
            }
            runScheduledMaintenance().catch(err => {
              writeLogFile(`Manual maintenance error: ${err.stack || err.message}`);
            });
          }
          scheduleRender();
        }

        // Check for canary promotion requests from the web UI
        // Format: data.promoteCanary = { [projectId]: timestampString, ... }
        if (data.promoteCanary && typeof data.promoteCanary === 'object') {
          for (const [projectId, timestamp] of Object.entries(data.promoteCanary)) {
            if (!timestamp || timestamp === lastSeenPromoteCanary[projectId]) continue;
            lastSeenPromoteCanary[projectId] = timestamp;

            const projectConfig = projects[projectId];
            if (!projectConfig) {
              writeLogFile(`[promote] Promote requested for unknown project: ${projectId}`);
              continue;
            }

            writeLogFile(`[promote] Promotion request for ${projectId} from web UI`);
            // Run promotion asynchronously — don't block the snapshot handler
            (async () => {
              // Mark promotion as running in Firestore
              const promoteRef = db.collection('orchestrator').doc('promotions');
              try {
                await promoteRef.set({
                  [projectId]: { status: 'running', startedAt: new Date().toISOString(), error: null },
                }, { merge: true });

                await promoteCanary(projectId, projectConfig.repoPath, projectConfig, (msg) => writeLogFile(msg));

                await promoteRef.set({
                  [projectId]: { status: 'done', completedAt: new Date().toISOString(), error: null },
                }, { merge: true });
                writeLogFile(`[promote] Promotion of ${projectId} complete`);
              } catch (err) {
                writeLogFile(`[promote] Promotion failed for ${projectId}: ${err.message}`);
                try {
                  await promoteRef.set({
                    [projectId]: { status: 'error', error: err.message.slice(0, 500), failedAt: new Date().toISOString() },
                  }, { merge: true });
                } catch {
                  // best-effort
                }
              }
            })().catch(err => writeLogFile(`[promote] Unhandled promotion error: ${err.message}`));
          }
        }
      },
      (err) => {
        writeLogFile(`Config listener error: ${err.message}`);
      }
    );
    listenerUnsubs.push(configUnsub);

    // Listen to maintenance worker status
    const maintenanceUnsub = db.collection('orchestrator').doc('maintenance').onSnapshot(
      (snap) => {
        state.maintenanceStatus = snap.exists ? snap.data() : null;
        scheduleRender();
      },
      () => {
        // Ignore errors — maintenance status is optional
      }
    );
    listenerUnsubs.push(maintenanceUnsub);

    // Listen to advisor persona state for TUI display
    for (const personaId of ['engineer', 'design', 'product']) {
      const advisorUnsub = db.collection('advisor').doc(personaId).onSnapshot(
        (snap) => {
          advisorPersonaState[personaId] = snap.exists ? snap.data() : null;
          scheduleRender();
        },
        () => {
          // Ignore errors — advisor state is optional
        }
      );
      listenerUnsubs.push(advisorUnsub);
    }

    /**
     * Register all four Firestore listeners (open, blocked, critical, paused) for
     * a single project.  Safe to call multiple times — skips projects that are
     * already registered.
     *
     * Also ensures `projects[projectId]` exists so that workers can look up the
     * projectConfig.  For projects added dynamically through the web UI the
     * repoPath is often empty; the config entry is still created so the rest of
     * the orchestrator code doesn't crash when it accesses `projects[projectId]`.
     */
    function registerProjectListeners(projectId, projectConfig) {
      if (registeredProjectIds.has(projectId)) return;
      registeredProjectIds.add(projectId);

      // Ensure the projects map has an entry for this project so that
      // claimAndSpawn / doSpawnWorker / maintenance can look up projectConfig.
      if (!projects[projectId]) {
        projects[projectId] = projectConfig || {};
      }

      const unsub = startProjectListener(db, projectId, userId, {
        onNewTicket: (docId, ticketData, pid) => {
          handleNewTicket(docId, ticketData, pid);
        },
        onError: (err) => {
          console.error(`[orchestrator] Listener error for ${projectId}:`, err.message);
        },
      });

      listenerUnsubs.push(unsub);

      // Also watch for tickets entering the 'blocked' state so maintenance
      // runs immediately rather than waiting for the next scheduled interval.
      const blockedUnsub = startBlockedTicketListener(db, projectId, {
        onBlockedTicket: (docId, ticketData, pid) => {
          handleBlockedTicket(docId, ticketData, pid);
        },
        onError: (err) => {
          console.error(`[orchestrator] Blocked listener error for ${projectId}:`, err.message);
        },
      });

      listenerUnsubs.push(blockedUnsub);

      // Watch for open tickets being marked critical so they can bypass the
      // worker cap even if they were already sitting in the queue.
      const criticalUnsub = startCriticalTicketListener(db, projectId, {
        onCriticalTicket: (docId, ticketData, pid) => {
          handleCriticalUpgrade(docId, ticketData, pid);
        },
        onError: (err) => {
          console.error(`[orchestrator] Critical listener error for ${projectId}:`, err.message);
        },
      });

      listenerUnsubs.push(criticalUnsub);

      // Single collection-level listener for all paused (waiting_for_user) tickets.
      // Replaces the previous approach of creating one document listener per paused
      // ticket so that the number of open Firestore connections stays constant
      // regardless of how many tickets are paused.
      //
      // startPausedTicketsListener fires onTicketChanged when a ticket's status
      // changes *away* from waiting_for_user (Firestore 'removed' event), which
      // means the user has responded and we should resume the worker.
      const pausedUnsub = startPausedTicketsListener(db, projectId, {
        onTicketChanged: (docId) => {
          // A 'removed' event from the waiting_for_user query means this ticket
          // is no longer paused — resume the worker if we have one for it.
          if (pausedWorkers.has(docId)) {
            const paused = pausedWorkers.get(docId);
            writeLogFile(`${paused.ticketId} answered — resuming`);
            handleResume(docId);
          }
        },
        onError: (err) => {
          console.error(`[orchestrator] Paused-tickets listener error for ${projectId}:`, err.message);
        },
      });

      listenerUnsubs.push(pausedUnsub);

      console.log(`[orchestrator] Listening on ${projectId}`);
    }

    // Start one listener per project defined in config.
    // Also ensure each config-based project has a Firestore document so the
    // web UI can discover it (it queries db.collection('projects').get()).
    for (const [projectId, projectConfig] of Object.entries(projects)) {
      registerProjectListeners(projectId, projectConfig);

      // Create the project document if it doesn't exist yet.  Uses set+merge
      // so existing documents (with liveVersion, URLs, etc.) aren't clobbered.
      db.collection('projects').doc(projectId).set({
        name: projectConfig.name || projectId,
        prefix: projectConfig.prefix || projectId.toUpperCase().slice(0, 4),
        ...(projectConfig.repoPath && { repoPath: projectConfig.repoPath }),
        updatedAt: new Date().toISOString(),
      }, { merge: true }).catch(err => {
        writeLogFile(`[${projectId}] Failed to ensure project doc: ${err.message}`);
      });
    }

    // Watch the top-level `projects` Firestore collection so that projects
    // created through the web UI (or CLI) are picked up automatically without
    // requiring an orchestrator restart.
    //
    // For each project document that is 'added' (either on initial snapshot or
    // later as a real-time change) we register listeners if we haven't already.
    // Projects that were in docket.config.json are already registered above, so
    // they are safely skipped (registeredProjectIds check).
    const projectsCollectionUnsub = db.collection('projects').onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'added') {
            const projectId = change.doc.id;
            if (!registeredProjectIds.has(projectId)) {
              const data = change.doc.data();
              const dynamicConfig = {
                repoPath: data.repoPath || '',
                autoDeploy: data.autoDeploy ?? true,
                canaryDeployCommand: data.canaryDeployCommand || 'npm run deploy:canary',
                promoteCommand: data.promoteCommand || 'npm run promote:canary',
                ...(data.deployCommand && { deployCommand: data.deployCommand }),
                ...(data.webDir && { webDir: data.webDir }),
                ...(data.versionPaths && { versionPaths: data.versionPaths }),
                ...(data.versionFiles && { versionFiles: data.versionFiles }),
                ...(data.firestoreRulesCommand && { firestoreRulesCommand: data.firestoreRulesCommand }),
                ...(data.dependents && { dependents: data.dependents }),
              };
              // Auto-provision repoPath and bootstrap new projects.
              const setup = async () => {
                if (!dynamicConfig.repoPath) {
                  const ok = await ensureProjectRepo(projectId, dynamicConfig);
                  if (ok) {
                    writeLogFile(`[orchestrator] Auto-provisioned repoPath for discovered project: ${projectId}`);
                  } else {
                    writeLogFile(`[orchestrator] Failed to auto-provision repoPath for ${projectId}`);
                    return;
                  }
                }
                await bootstrapNewProject(projectId, data);
              };
              setup().catch(err => {
                writeLogFile(`[orchestrator] Error during project setup for ${projectId}: ${err.message}`);
              });
              writeLogFile(`[orchestrator] Discovered new project in Firestore: ${projectId} — registering listeners`);
              registerProjectListeners(projectId, dynamicConfig);
            }
          } else if (change.type === 'modified') {
            // A project document was updated in Firestore (e.g. repoPath configured
            // via the admin panel).  Sync the in-memory projects config so workers
            // and maintenance can use the updated values.
            const projectId = change.doc.id;
            const data = change.doc.data();
            const hadRepoPath = !!(projects[projectId] && projects[projectId].repoPath);
            const nowHasRepoPath = !!(data.repoPath);

            if (projects[projectId]) {
              // Update all fields that the orchestrator uses from the project config.
              // Preserve deploy defaults for dynamically discovered projects —
              // only overwrite autoDeploy if Firestore explicitly sets it.
              const merged = { ...data };
              if (merged.autoDeploy === undefined) {
                merged.autoDeploy = projects[projectId].autoDeploy;
              }
              if (!merged.canaryDeployCommand && projects[projectId].canaryDeployCommand) {
                merged.canaryDeployCommand = projects[projectId].canaryDeployCommand;
              }
              if (!merged.promoteCommand && projects[projectId].promoteCommand) {
                merged.promoteCommand = projects[projectId].promoteCommand;
              }
              Object.assign(projects[projectId], merged);
            } else {
              projects[projectId] = {
                autoDeploy: true,
                canaryDeployCommand: 'npm run deploy:canary',
                promoteCommand: 'npm run promote:canary',
                ...data,
              };
            }

            writeLogFile(`[orchestrator] Project "${projectId}" config updated in Firestore — synced in-memory config`);

            // If repoPath was just configured for the first time, trigger a
            // maintenance pass so any tickets blocked due to missing repoPath
            // are retried immediately.
            if (!hadRepoPath && nowHasRepoPath) {
              writeLogFile(`[orchestrator] Project "${projectId}" now has repoPath — scheduling maintenance to retry blocked tickets`);
              if (!state.maintenanceRunning) {
                if (state.blockedMaintenanceTimer) {
                  clearTimeout(state.blockedMaintenanceTimer);
                  state.blockedMaintenanceTimer = null;
                }
                state.blockedMaintenanceTimer = setTimeout(() => {
                  state.blockedMaintenanceTimer = null;
                  runScheduledMaintenance().catch(err => {
                    writeLogFile(`[orchestrator] Maintenance error after repoPath set: ${err.stack || err.message}`);
                  });
                }, 2000);
              } else {
                state.pendingMaintenanceAfterCurrent = true;
              }
            }
          }
        }
      },
      (err) => {
        writeLogFile(`[orchestrator] Projects collection listener error: ${err.message}`);
      }
    );
    listenerUnsubs.push(projectsCollectionUnsub);

    // Start keyboard handler
    startKeyboardHandler();

    console.log('');

    // Open fancy TUI by default (press 'd' to switch to classic dashboard)
    tui.open();

    // Schedule first maintenance run after a short initial delay
    state.maintenanceTimer = setTimeout(runScheduledMaintenance, 30 * 1000);

    // Start usage monitor (no-ops gracefully if token unavailable)
    usageMonitor.start();

    // Handle process signals
    process.on('SIGINT', async () => {
      await shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await shutdown();
      process.exit(0);
    });
  }

  async function shutdown() {
    if (state.shuttingDown) return;
    state.shuttingDown = true;

    // Stop usage monitor
    usageMonitor.stop();

    // Cancel scheduled maintenance
    if (state.maintenanceTimer) {
      clearTimeout(state.maintenanceTimer);
      state.maintenanceTimer = null;
    }
    if (state.blockedMaintenanceTimer) {
      clearTimeout(state.blockedMaintenanceTimer);
      state.blockedMaintenanceTimer = null;
    }
    state.pendingMaintenanceAfterCurrent = false;

    // Stop heartbeat and clear it so the web panel knows we're offline
    await stopHeartbeat();

    // Cancel any pending worker log flush timers
    for (const timer of workerLogFlushTimers.values()) {
      clearTimeout(timer);
    }
    workerLogFlushTimers.clear();

    console.log('\n[orchestrator] Shutting down...');

    // Stop master worker listener
    masterWorker.stop();

    // Close TUI and classic dashboard
    if (tui.isOpen) tui.close();
    if (dashboard.isOpen) dashboard.close();

    // Unsubscribe all listeners
    for (const unsub of listenerUnsubs) {
      try { unsub(); } catch { /* ignore */ }
    }
    listenerUnsubs.length = 0;

    // Abort all active workers and save WIP
    for (const [docId, worker] of activeWorkers) {
      console.log(`[orchestrator] Aborting worker for ${worker.ticketId || docId}`);
      if (worker.ac) worker.ac.abort();

      // Save synthetic WIP if the worker never saved one
      try {
        const ticketService = getTicketService(worker.projectId);
        const ticket = await ticketService.getById(docId);
        if (ticket && !ticket.workInProgress) {
          // Synthesize WIP from the last ~30 lines of worker logs
          const logs = workerLogs.get(docId) || [];
          const lastLogs = logs.slice(-30).join('\n');
          await ticketService.update(docId, {
            workInProgress: {
              goal: ticket.title,
              lastLogs: lastLogs || '(no logs captured)',
              source: 'orchestrator-shutdown',
              savedAt: new Date().toISOString(),
            },
          });
        }
      } catch {
        // best-effort — don't block shutdown
      }

      // Reset ticket to open
      try {
        const ticketService = getTicketService(worker.projectId);
        await ticketService.transitionStatus(docId, 'open', {
          note: 'Orchestrator shutdown — resetting to open',
        });
      } catch {
        // ignore
      }

      // Clean up worktree
      if (worker.worktreeDir) {
        const projectConfig = projects[worker.projectId];
        if (projectConfig) {
          cleanupWorktree(worker.worktreeDir, projectConfig.repoPath);
        }
      }
    }
    activeWorkers.clear();

    // Clear paused workers — the per-project paused-tickets listener
    // (stored in listenerUnsubs) is already stopped above via listenerUnsubs.
    // Keep paused worktrees — they contain work that may be resumed.
    pausedWorkers.clear();

    // Clear queue
    queue.length = 0;

    // Restore terminal
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {
        // ignore
      }
    }

    console.log('[orchestrator] Shutdown complete.');
  }

  return { start, shutdown };
}
