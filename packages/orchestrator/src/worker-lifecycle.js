// @docket/orchestrator — worker lifecycle.
//
// The fattest of the extracted modules.  Owns:
//   - canSpawnWorker / resetWorkerLog / claimAndSpawn (slot reservation)
//   - handleNewTicket / handleCriticalUpgrade (Firestore listener entry points)
//   - doSpawnWorker / doResumeWorker (the actual spawn/resume + finalize bodies)
//   - handlePause / handleResume / handleUpgrade (lifecycle transitions)
//
// Most everything in here used to live in the closure body — extracting it
// requires a long deps list because the worker lifecycle is genuinely the
// crossroads of every other concern (provisioning, queue, log-flusher,
// merge queue, model fallback, deploy hand-off, master worker gate).
//
// The mutual recursion between claimAndSpawn / doSpawnWorker / doResumeWorker
// is preserved by hoisted function declarations inside this factory.  The
// queue's dequeueNext is read off `deps` at call time so the orchestrator
// can wire it after both modules are built.

import { spawnWorker, finalizeWorker, resumeWorker } from './worker.js';
import { cleanupWorktree } from './worktree.js';
import { describeError } from './error-formatter.js';

/**
 * @param {object} state    Shared orchestrator state.
 * @param {object} deps
 *   db, projects, model, fallbackModel (unused here but available for future),
 *   userId, firebaseKeyPath, workerIdleTimeoutMs, workerCooldownMs,
 *   bypassPermissions, masterWorker, mergeQueueManager (from state),
 *   writeLogFile, scheduleRender, getTicketService, getEffectiveModel,
 *   ensureProjectRepo, ensureClaudeSettings, onLog, onWorkerLog,
 *   enqueueWithPriority, dequeueNext (late-bound — read at call time)
 */
export function createWorkerLifecycle(state, deps) {
  const {
    activeWorkers,
    pausedWorkers,
    queue,
    ticketInfoCache,
    workerLogFlushedCount,
    workerLogFlushTimers,
    recentErrors,
    config,
    mergeQueueManager,
    upgradeModel,
  } = state;

  const {
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
  } = deps;

  // dequeueNext is read off deps at call time — see module header.
  const callDequeueNext = () => deps.dequeueNext();

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
    state.workerLogs.set(docId, []);
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
    if (state.claimingTickets.has(docId)) return;
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
    deps.enqueueWithPriority(entry);
    const criticalTag = entry.critical ? ' [CRITICAL]' : '';
    writeLogFile(`Queued ${ticketData.ticketId}${criticalTag} (${activeWorkers.size}/${config.maxWorkers} workers busy)`);
    callDequeueNext();

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
    if (state.claimingTickets.has(docId)) return;

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
      deps.enqueueWithPriority(entry);
      const criticalTag = '[CRITICAL UPGRADE]';
      writeLogFile(`${criticalTag} ${entry.ticketId} promoted to critical in queue (${activeWorkers.size}/${config.maxWorkers} workers busy)`);
      callDequeueNext();
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
        callDequeueNext();
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
        onDequeue: callDequeueNext,
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
        callDequeueNext();
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
        callDequeueNext(); // Free the worker slot immediately
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
        callDequeueNext();
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
        onDequeue: callDequeueNext,
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
        callDequeueNext();
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
      callDequeueNext();
    }
  }

  return {
    canSpawnWorker,
    resetWorkerLog,
    claimAndSpawn,
    handleNewTicket,
    handleCriticalUpgrade,
    doSpawnWorker,
    handlePause,
    handleResume,
    handleUpgrade,
    doResumeWorker,
  };
}
