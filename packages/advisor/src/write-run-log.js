// write-run-log.js — writes a single run summary document to the
// /advisor/{personaId}/runs/{runId} subcollection at the end of each persona cycle.
//
// Document shape mirrors the ticket spec:
// {
//   runId:             string   (same as the Firestore doc ID)
//   personaId:         string
//   projectId:         string
//   startedAt:         Timestamp
//   completedAt:       Timestamp
//   filesScanned:      number
//   tokensUsed:        number
//   proposalsCreated:  number
//   proposalsSkipped:  number
//   skippedReasons:    [{ title, reason, matchedTicketId? }]
//   error:             string | null
// }
//
// Retention: after writing, query the subcollection ordered by startedAt desc
// and delete any documents beyond lastN (default 20, config: advisor.runRetention).

const SUBCOLLECTION = 'runs';
const DEFAULT_RETENTION = 20;

/**
 * Write one run log document to /advisor/{personaId}/runs/{runId}
 * and prune old entries beyond the retention limit.
 *
 * Call this once at the end of each persona cycle (in the finally block).
 * Never throws — errors are logged but not propagated.
 *
 * @param {object} db                 - Firestore Admin SDK instance
 * @param {string} personaId          - Persona ID (e.g. "engineer")
 * @param {string} projectId          - Project ID
 * @param {object} summary            - Run summary collected during the cycle
 * @param {Date}   summary.startedAt
 * @param {number} summary.filesScanned
 * @param {number} summary.tokensUsed
 * @param {number} summary.proposalsCreated
 * @param {number} summary.proposalsSkipped
 * @param {Array}  summary.skippedReasons    - [{ title, reason, matchedTicketId? }]
 * @param {string|null} summary.error        - sanitized error string or null
 * @param {number} [lastN=20]         - retention limit (from advisor.runRetention config)
 * @returns {Promise<void>}
 */
export async function writeRunLog(db, personaId, projectId, summary, lastN = DEFAULT_RETENTION) {
  const now = new Date();
  const doc = {
    personaId,
    projectId,
    startedAt: summary.startedAt,
    completedAt: now,
    filesScanned:     summary.filesScanned     || 0,
    tokensUsed:       summary.tokensUsed       || 0,
    proposalsCreated: summary.proposalsCreated || 0,
    proposalsSkipped: summary.proposalsSkipped || 0,
    skippedReasons:   summary.skippedReasons   || [],
    error:            summary.error            || null,
  };

  const runsRef = db.collection('advisor').doc(personaId).collection(SUBCOLLECTION);

  try {
    const newDocRef = runsRef.doc(); // auto-generated ID
    doc.runId = newDocRef.id;
    await newDocRef.set(doc);
  } catch (err) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.error(`[${ts}] [write-run-log] Failed to write run log for ${personaId}: ${err.message}`);
    return; // non-fatal
  }

  // Retention cleanup: delete documents beyond lastN, ordered by startedAt desc
  try {
    const retention = (Number.isInteger(lastN) && lastN > 0) ? lastN : DEFAULT_RETENTION;
    const snap = await runsRef.orderBy('startedAt', 'desc').get();
    if (snap.size > retention) {
      const toDelete = snap.docs.slice(retention); // everything beyond lastN
      // Batch delete (Firestore batch max is 500; retention is small so one batch suffices)
      const batch = db.batch();
      for (const doc of toDelete) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
  } catch (err) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.error(`[${ts}] [write-run-log] Retention cleanup failed for ${personaId}: ${err.message}`);
    // Non-fatal
  }
}
