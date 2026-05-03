// @docket/orchestrator — periodic maintenance pass.
//
// Periodically (or in response to a 'blocked' ticket / web-UI Run Now)
// pauses every active worker, runs the maintenance worker
// (packages/orchestrator/src/maintenance.js) which surveys problem tickets,
// merge-queue retries, blocked builds, etc., then releases the worker gate.
//
// Owns the pendingMaintenanceAfterCurrent flag so concurrent triggers
// while a pass is already running queue exactly one follow-up rather than
// stacking up.

import { runMaintenance } from './maintenance.js';

/**
 * @param {object} state    Shared orchestrator state.
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.projects
 * @param {Function} deps.writeLogFile
 * @param {Function} deps.dequeueNext
 * @param {Function} deps.getTicketService
 * @param {number}   deps.maintenanceIntervalMs
 */
export function createScheduledMaintenance(state, deps) {
  const { activeWorkers, registeredProjectIds, workerLogs } = state;
  const { db, projects, writeLogFile, dequeueNext, getTicketService, maintenanceIntervalMs } = deps;

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

  return { pauseActiveWorkersForMaintenance, maintenanceHasWork, runScheduledMaintenance, handleBlockedTicket };
}
