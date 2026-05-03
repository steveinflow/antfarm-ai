// @docket/orchestrator — ticket queue helpers.
//
// Owns:
//  - enqueueWithPriority: stable priority insertion
//  - dequeueNext: spawn the next eligible worker, respecting the worker cap,
//    maintenance gate, master-worker gate, and inter-spawn stagger
//
// Both helpers operate on `state.queue` and a small handful of scalars on
// `state` (lastSpawnTime / staggerTimer / shuttingDown / maintenanceRunning).
// Cross-concern callables (canSpawnWorker, claimAndSpawn, scheduleRender,
// writeLogFile, masterWorker) are passed in via `deps`.

/**
 * Build the queue helpers for an orchestrator instance.
 *
 * @param {object} state    Shared orchestrator state.
 * @param {object} deps
 * @param {Function} deps.canSpawnWorker
 * @param {Function} deps.claimAndSpawn
 * @param {Function} deps.scheduleRender
 * @param {Function} deps.writeLogFile
 * @param {object}   deps.masterWorker
 * @param {number}   deps.workerStaggerMs
 */
export function createQueue(state, deps) {
  const { queue, claimingTickets } = state;
  const { canSpawnWorker, claimAndSpawn, scheduleRender, writeLogFile, masterWorker, workerStaggerMs } = deps;

  /**
   * Insert a new queue entry so that higher-priority tickets come first.
   * Within each group, arrival order is preserved (FIFO).
   *
   * Priority tiers (highest first):
   *   1. Critical tickets (critical === true) — bypass max worker cap; spawn immediately
   *   2. Resume entries (_resume set) — re-queued waiting_for_user tickets with an answer
   *   3. User-submitted tickets (userId != null)
   *   4. QA advisor tickets (advisorPersona === 'qa') — bugs/regressions take precedence
   *   5. All other advisor-submitted tickets (Design, Product, Engineer, custom)
   */
  function enqueueWithPriority(entry) {
    const priority = (e) => {
      if (e.critical) return 0;                   // critical — highest priority, bypasses cap
      if (e._resume) return 1;                    // resume entries
      if (e.userId) return 2;                     // user-submitted
      if (e.advisorPersona === 'qa') return 3;    // QA advisor — before Design/Product
      return 4;                                   // all other advisor-submitted
    };

    const entryPriority = priority(entry);

    // Find the first existing entry with a lower priority (higher number)
    // and insert before it.  If none found, append to the end.
    const insertIdx = queue.findIndex(e => priority(e) > entryPriority);
    if (insertIdx === -1) {
      queue.push(entry);
    } else {
      queue.splice(insertIdx, 0, entry);
    }
  }

  function dequeueNext() {
    if (state.shuttingDown || queue.length === 0) { scheduleRender(); return; }

    const next = queue[0];
    const isCritical = !!(next && next.critical);

    if (isCritical) {
      // Critical tickets bypass the worker cap — but still respect maintenance and master worker.
      if (state.maintenanceRunning || masterWorker.isResponding()) { scheduleRender(); return; }
    } else {
      // Non-critical tickets: gate on worker cap as normal.
      if (!canSpawnWorker()) { scheduleRender(); return; }

      // Enforce minimum time between spawns regardless of queue depth.
      // Firestore snapshots deliver tickets one-by-one, so queue.length is
      // almost always 1 when this runs — we can't rely on queue depth to
      // decide whether to stagger.  Instead, track when we last spawned.
      if (workerStaggerMs > 0) {
        const elapsed = Date.now() - state.lastSpawnTime;
        if (elapsed < workerStaggerMs) {
          // Already have a stagger timer pending — it will call us when ready.
          if (!state.staggerTimer) {
            const delay = workerStaggerMs - elapsed;
            state.staggerTimer = setTimeout(() => {
              state.staggerTimer = null;
              dequeueNext();
            }, delay);
          }
          scheduleRender();
          return;
        }
      }
    }

    queue.shift();
    state.lastSpawnTime = Date.now();
    claimingTickets.add(next.docId);
    claimAndSpawn(next.docId, next.projectId, next._resume || undefined).catch(err => {
      writeLogFile(`Dequeue error: ${err.stack || err.message}`);
    }).finally(() => {
      claimingTickets.delete(next.docId);
    });

    // If more tickets are already queued, schedule the next start after the stagger delay.
    if (queue.length > 0 && canSpawnWorker() && !state.staggerTimer) {
      if (workerStaggerMs > 0) {
        state.staggerTimer = setTimeout(() => { state.staggerTimer = null; dequeueNext(); }, workerStaggerMs);
      } else {
        dequeueNext();
      }
    }

    scheduleRender();
  }

  return { enqueueWithPriority, dequeueNext };
}
