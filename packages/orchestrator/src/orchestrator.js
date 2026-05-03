// @docket/orchestrator — main daemon
// Watches multiple project subcollections, manages worker pool,
// merge queues, paused tickets, and the terminal dashboard.

import admin from 'firebase-admin';
import { createTicketService } from '@docket/core';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startProjectListener, startBlockedTicketListener, startPausedTicketsListener, startCriticalTicketListener } from './listener.js';
import { spawnWorker, finalizeWorker, resumeWorker } from './worker.js';
import { createWorktree, cleanupWorktree } from './worktree.js';
import { promoteCanary } from './deploy.js';
import { createDashboard } from './dashboard.js';
import { createTUI } from './tui.js';
import { createMasterWorker } from './master-worker.js';
import { createUsageMonitor } from './usage-monitor.js';
import { describeError } from './error-formatter.js';
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

  // ── Worker lifecycle ────────────────────────────────────────────

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
