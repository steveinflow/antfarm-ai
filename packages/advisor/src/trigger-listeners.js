// trigger-listeners.js — DK-136: Event-based persona run triggers
//
// Ticket-close-count trigger: watches all projects' ticket collections for
// transitions to 'done' within a configurable sliding time window. When the
// count hits the threshold for a persona, fires an advisor run.
//
// No new infrastructure required — the orchestrator already watches Firestore.
// This listener runs inside the advisor daemon process.
//
// Config shape (per persona in docket.config.json):
//   triggers.ticketCloseCount        — number of tickets to close before firing (e.g. 5)
//   triggers.ticketCloseWindowHours  — sliding window in hours (e.g. 2)
//
// Only a single pending run is queued per persona. Subsequent triggers are
// dropped until the pending run executes.

function log(persona, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [trigger-listener:${persona}] ${msg}`);
}

/**
 * Start ticket-close-count trigger listeners for all configured personas.
 *
 * @param {object} options
 * @param {object} options.db            - Firestore admin instance
 * @param {object} options.personaConfig - map of personaId -> config with triggers block
 *   e.g. { engineer: { triggers: { ticketCloseCount: 5, ticketCloseWindowHours: 2 } } }
 * @param {string[]} options.projectIds  - project IDs to watch
 * @returns {() => void} - unsubscribe function to stop all listeners
 */
export function startTicketCloseTriggers({ db, personaConfig, projectIds }) {
  if (!personaConfig || !projectIds || projectIds.length === 0) {
    return () => {};
  }

  // Build list of personas that have ticketCloseCount configured
  const configuredPersonas = Object.entries(personaConfig)
    .filter(([, cfg]) => cfg?.triggers?.ticketCloseCount > 0)
    .map(([personaId, cfg]) => ({
      personaId,
      threshold: cfg.triggers.ticketCloseCount,
      windowMs: (cfg.triggers.ticketCloseWindowHours ?? 2) * 60 * 60 * 1000,
    }));

  if (configuredPersonas.length === 0) {
    return () => {};
  }

  const maxWindow = Math.max(...configuredPersonas.map(p => p.windowMs));

  log('all', `Starting ticket-close-count triggers for: ${configuredPersonas.map(p => p.personaId).join(', ')} (${projectIds.length} projects)`);

  // Track recent ticket closures: timestamp array (sliding window)
  const closeTimestamps = []; // { at, ticketId, projectId }

  // Track whether a pending trigger is already queued for each persona
  const pendingTriggered = {}; // personaId -> boolean

  // Skip the initial snapshot dump — only react to real-time changes
  const initialized = {}; // projectId -> boolean

  const unsubscribes = [];

  // Set up one Firestore listener per project, scoped to recently-updated tickets
  for (const projectId of projectIds) {
    // Scope the query to tickets updated within the window to avoid reading the
    // entire done-ticket history.  Firestore doesn't support compound inequality
    // filters on different fields, so we filter by updatedAt and check status
    // in the change handler.
    const windowStart = new Date(Date.now() - maxWindow).toISOString();

    const unsubTickets = db
      .collection('projects')
      .doc(projectId)
      .collection('tickets')
      .where('status', '==', 'done')
      .where('updatedAt', '>=', windowStart)
      .onSnapshot((snap) => {
        // Skip the initial snapshot — it's a dump of all matching docs, not
        // real-time changes.  We only want to react to tickets that transition
        // to done AFTER the listener starts.
        if (!initialized[projectId]) {
          initialized[projectId] = true;
          return;
        }

        const now = Date.now();
        let newCloses = 0;

        snap.docChanges().forEach((change) => {
          if (change.type !== 'added' && change.type !== 'modified') return;
          const data = change.doc.data();

          // Get the timestamp of the done transition from statusHistory
          const statusHistory = Array.isArray(data.statusHistory) ? data.statusHistory : [];
          const doneEntry = [...statusHistory].reverse().find(h => h.to === 'done');
          if (!doneEntry) return;

          const doneAt = doneEntry.at ? new Date(doneEntry.at).getTime() : null;
          if (!doneAt || isNaN(doneAt)) return;

          // Only count tickets that became done within the window
          if (now - doneAt > maxWindow) return;

          // Deduplicate by ticket ID
          const ticketId = change.doc.id;
          if (closeTimestamps.some(e => e.ticketId === ticketId)) return;

          closeTimestamps.push({ at: doneAt, ticketId, projectId });
          newCloses++;
        });

        if (newCloses === 0) return;

        // Prune entries older than the longest window
        const cutoff = now - maxWindow;
        while (closeTimestamps.length > 0 && closeTimestamps[0].at < cutoff) {
          closeTimestamps.shift();
        }

        // Check each persona's threshold
        for (const { personaId, threshold, windowMs } of configuredPersonas) {
          if (pendingTriggered[personaId]) continue;

          const windowCutoff = now - windowMs;
          const recentCloses = closeTimestamps.filter(e => e.at >= windowCutoff);

          if (recentCloses.length >= threshold) {
            pendingTriggered[personaId] = true;
            const nowIso = new Date().toISOString();
            log(personaId, `Threshold reached (${recentCloses.length}/${threshold}) — firing run`);

            // Clear the counted closures to start a fresh window
            closeTimestamps.splice(0, closeTimestamps.length);

            db.collection('advisor').doc(personaId).set({
              runRequestedAt: nowIso,
              runRequestedError: null,
            }, { merge: true }).then(() => {
              return db.collection('advisorTriggerLog').add({
                personaId,
                trigger: 'ticketCloseCount',
                triggeredAt: nowIso,
                triggeredBy: 'system',
                proposalsCreated: null,
              });
            }).catch(err => {
              log(personaId, `Failed to write Firestore trigger: ${err.message}`);
            });

            // Reset pending flag after one full window
            setTimeout(() => {
              pendingTriggered[personaId] = false;
              log(personaId, `Pending trigger flag cleared — ready for next threshold`);
            }, windowMs);
          }
        }
      }, (err) => {
        log('all', `Firestore listener error for project ${projectId}: ${err.message}`);
      });

    unsubscribes.push(unsubTickets);
  }

  return () => {
    for (const unsub of unsubscribes) {
      try { unsub(); } catch { /* ignore */ }
    }
    log('all', 'Ticket-close-count trigger listeners stopped');
  };
}

/**
 * Get the current ticket-close progress for a persona (for UI display).
 * Returns { count, threshold, windowHours } or null if not configured.
 *
 * @param {object} options
 * @param {object} options.db           - Firestore admin instance
 * @param {string} options.personaId    - persona ID
 * @param {object} options.cfg          - persona trigger config
 * @param {string[]} options.projectIds - project IDs to query
 * @returns {Promise<{ count: number, threshold: number, windowHours: number } | null>}
 */
export async function getTicketCloseProgress({ db, personaId, cfg, projectIds }) {
  const threshold = cfg?.triggers?.ticketCloseCount;
  const windowHours = cfg?.triggers?.ticketCloseWindowHours ?? 2;
  if (!threshold || threshold <= 0 || !projectIds || projectIds.length === 0) return null;

  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  let count = 0;
  const seen = new Set();

  for (const projectId of projectIds) {
    try {
      const snap = await db
        .collection('projects')
        .doc(projectId)
        .collection('tickets')
        .where('status', '==', 'done')
        .where('updatedAt', '>=', cutoff)
        .get();

      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        const data = doc.data();
        const statusHistory = Array.isArray(data.statusHistory) ? data.statusHistory : [];
        const doneEntry = [...statusHistory].reverse().find(h => h.to === 'done');
        if (doneEntry?.at && doneEntry.at >= cutoff) {
          seen.add(doc.id);
          count++;
        }
      }
    } catch {
      // ignore per-project errors
    }
  }

  return { count: Math.min(count, threshold), threshold, windowHours };
}
