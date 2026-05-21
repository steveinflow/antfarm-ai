// @docket/orchestrator — main daemon
// Watches multiple project subcollections, manages worker pool,
// merge queues, paused tickets, and the terminal dashboard.

import admin from 'firebase-admin';
import { createTicketService } from '@docket/core';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupWorktree } from './worktree.js';
import { createDashboard } from './dashboard.js';
import { createTUI } from './tui.js';
import { createMasterWorker } from './master-worker.js';
import { createUsageMonitor } from './usage-monitor.js';
import { createOrchestratorState } from './state.js';
import { createQueue } from './queue.js';
import { createRenderScheduler } from './render-scheduler.js';
import { createLogFlusher } from './log-flusher.js';
import { createHeartbeat } from './heartbeat.js';
import { createProvisioning } from './project-provisioning.js';
import { createRecovery } from './recovery.js';
import { createWorkerLifecycle } from './worker-lifecycle.js';
import { createScheduledMaintenance } from './scheduled-maintenance.js';
import { createKeyboardHandler } from './keyboard.js';
import { createFirestoreListeners } from './firestore-listeners.js';

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
    ticketServices,
    config,
    advisorPersonaState,
    lastSeenPromoteCanary,
    workerLogFlushTimers,
    MAX_WORKERS_LIMIT,
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

  // ── Project provisioning + bootstrap ────────────────────────────
  const { ensureProjectRepo, ensureClaudeSettings, bootstrapNewProject } = createProvisioning(state, {
    db,
    projects,
    writeLogFile,
    getTicketService,
    pagesBaseUrl,
    pagesRepoPath,
  });

  // ── Heartbeat ───────────────────────────────────────────────────
  const { startHeartbeat, stopHeartbeat } = createHeartbeat(state, {
    db,
    intervalMs: HEARTBEAT_INTERVAL_MS,
  });

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

  // ── Dashboard/TUI render debounce ──────────────────────────────
  const { scheduleRender } = createRenderScheduler(state, { tui, dashboard });

  // ── Worker log flushing to Firestore ────────────────────────────
  const { onLog, onWorkerLog } = createLogFlusher(state, {
    writeLogFile,
    getTicketService,
    scheduleRender,
    tui,
    dashboard,
  });

  // ── Worker lifecycle + queue (mutually recursive) ──────────────
  // worker-lifecycle and queue depend on each other:
  //   queue.dequeueNext -> worker.claimAndSpawn
  //   worker.claimAndSpawn -> queue.dequeueNext (after a spawn finishes/fails)
  // We build a shared `workerDeps` object first (with placeholders that will
  // be filled in below), then construct both modules and wire references.
  const workerDeps = {
    db,
    projects,
    userId,
    firebaseKeyPath,
    workerIdleTimeoutMs,
    workerCooldownMs,
    bypassPermissions,
    masterWorker,
    writeLogFile,
    scheduleRender,
    getTicketService,
    getEffectiveModel,
    ensureProjectRepo,
    ensureClaudeSettings,
    onLog,
    onWorkerLog,
    enqueueWithPriority: null, // wired below
    dequeueNext: null,         // wired below
  };
  const workerLifecycle = createWorkerLifecycle(state, workerDeps);
  const {
    canSpawnWorker,
    claimAndSpawn,
    handleNewTicket,
    handleCriticalUpgrade,
    handleResume,
  } = workerLifecycle;

  const queueModule = createQueue(state, {
    canSpawnWorker,
    claimAndSpawn,
    scheduleRender,
    writeLogFile,
    masterWorker,
    workerStaggerMs,
  });
  const { enqueueWithPriority, dequeueNext } = queueModule;
  workerDeps.enqueueWithPriority = enqueueWithPriority;
  workerDeps.dequeueNext = dequeueNext;


  // ── Startup recovery ────────────────────────────────────────────
  const { resetOrphanedTickets } = createRecovery(state, {
    projects,
    getTicketService,
    writeLogFile,
  });

  // ── Scheduled Maintenance ────────────────────────────────────────
  const { runScheduledMaintenance, handleBlockedTicket } = createScheduledMaintenance(state, {
    db,
    projects,
    writeLogFile,
    dequeueNext,
    getTicketService,
    maintenanceIntervalMs,
  });

  // ── Keyboard handling ───────────────────────────────────────────
  const { startKeyboardHandler } = createKeyboardHandler(state, {
    db,
    tui,
    dashboard,
    shutdown,
    resetOrphanedTickets,
    runScheduledMaintenance,
    dequeueNext,
    writeLogFile,
  });

  // ── Firestore listeners ─────────────────────────────────────────
  const {
    registerProjectListeners,
    subscribeToOrchestratorConfig,
    subscribeToMaintenanceStatus,
    subscribeToAdvisorPersonas,
    subscribeToProjectsCollection,
  } = createFirestoreListeners(state, {
    db,
    projects,
    userId,
    fallbackModel,
    model,
    writeLogFile,
    scheduleRender,
    dequeueNext,
    shutdown,
    runScheduledMaintenance,
    handleNewTicket,
    handleCriticalUpgrade,
    handleBlockedTicket,
    handleResume,
    ensureProjectRepo,
    bootstrapNewProject,
  });

  // ── Start / Shutdown ────────────────────────────────────────────

  async function start() {
    writeLogFile('=== Orchestrator starting ===');
    writeLogFile(`Projects: ${Object.keys(projects).join(', ')}, Max workers: ${maxWorkers}, Model: ${model}`);
    writeLogFile(`User: ${userId}`);
    writeLogFile(`Idle timeout: ${Math.round(workerIdleTimeoutMs / 1000)}s`);
    writeLogFile(`Maintenance interval: ${Math.round(maintenanceIntervalMs / 1000)}s (first run in 30s)`);
    writeLogFile(`Auth: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'OAuth (Max)' : 'API credits'}`);
    writeLogFile(`Log file: ${logFile}`);
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

    // Wire up the Firestore subscriptions (config, maintenance status,
    // advisor personas, projects collection).
    subscribeToOrchestratorConfig();
    subscribeToMaintenanceStatus();
    subscribeToAdvisorPersonas();

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

    // Watch for projects added/modified through the web UI (or CLI).
    subscribeToProjectsCollection();

    // Start keyboard handler
    startKeyboardHandler();

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

    writeLogFile('Shutting down...');

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
      writeLogFile(`Aborting worker for ${worker.ticketId || docId}`);
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

    writeLogFile('Shutdown complete.');
  }

  return { start, shutdown };
}
