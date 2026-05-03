// @docket/orchestrator — heartbeat writer.
//
// Periodically writes `lastHeartbeat` to /orchestrator/config so the web
// panel can detect when the orchestrator is no longer running.  Clears
// the heartbeat on shutdown so the web UI flips to "offline" promptly.

/**
 * @param {object} state    Shared orchestrator state (uses state.heartbeatTimer).
 * @param {object} deps
 * @param {object} deps.db                 Firestore instance.
 * @param {number} deps.intervalMs         Heartbeat write cadence.
 */
export function createHeartbeat(state, deps) {
  const { db, intervalMs } = deps;

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
    state.heartbeatTimer = setInterval(writeHeartbeat, intervalMs);
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

  return { writeHeartbeat, startHeartbeat, stopHeartbeat };
}
