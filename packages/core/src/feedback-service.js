// @docket/core — feedback service
//
// Manages the /feedback top-level collection.
// Each document records a single user's rating of an advisor-generated ticket.
//
// Document ID: {ticketId}_{userId}
// Schema:
//   ticketId   string
//   projectId  string
//   rating     "relevant" | "noise"
//   userId     string   (always request.auth.uid — enforced by Firestore rules)
//   createdAt  timestamp
//
// Aggregates are computed by a scheduled job and written to
// /advisor/{personaId}/runs/{runId}.feedbackSummary.
// The client reads summary documents — never raw feedback.

/**
 * Create a feedback service bound to a Firestore instance.
 *
 * @param {object} db - Firestore instance (web SDK or admin SDK)
 * @returns {object} feedback service
 */
export function createFeedbackService(db) {
  /**
   * Write or overwrite a user's feedback for a ticket.
   * Uses setDoc with merge:true so re-votes overwrite cleanly.
   *
   * Only ticketId, projectId, and rating are written from the client.
   * userId is enforced by Firestore security rules (request.auth.uid).
   *
   * @param {object} opts
   * @param {string} opts.ticketId   - Firestore doc id of the ticket
   * @param {string} opts.projectId  - Project the ticket belongs to
   * @param {string} opts.rating     - "relevant" | "noise"
   * @param {string} opts.userId     - Current user's uid (for doc id only — rules enforce it)
   */
  async function submitFeedback({ ticketId, projectId, rating, userId }) {
    if (!ticketId || !projectId || !rating || !userId) {
      throw new Error('submitFeedback: ticketId, projectId, rating, and userId are required');
    }
    if (rating !== 'relevant' && rating !== 'noise') {
      throw new Error('submitFeedback: rating must be "relevant" or "noise"');
    }

    const docId = `${ticketId}_${userId}`;
    const ref = db.collection('feedback').doc(docId);

    await ref.set({
      ticketId,
      projectId,
      rating,
      // createdAt is set server-side on initial write; preserved on re-votes via merge
      createdAt: new Date().toISOString(),
    }, { merge: true });
  }

  /**
   * Get the current user's feedback for a specific ticket.
   * Returns null if no feedback has been submitted.
   *
   * @param {string} ticketId - Firestore doc id of the ticket
   * @param {string} userId   - Current user's uid
   * @returns {Promise<{rating: string}|null>}
   */
  async function getFeedback(ticketId, userId) {
    if (!ticketId || !userId) return null;
    const docId = `${ticketId}_${userId}`;
    const ref = db.collection('feedback').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    return snap.data();
  }

  /**
   * Tally feedback for all tickets created in a given advisor run.
   * Used by the aggregate job in the orchestrator.
   *
   * @param {string[]} ticketIds - Array of Firestore doc ids from this run
   * @returns {Promise<{ relevant: number, noise: number, total: number }>}
   */
  async function tallyFeedbackForTickets(ticketIds) {
    if (!ticketIds || ticketIds.length === 0) {
      return { relevant: 0, noise: 0, total: 0 };
    }

    // Firestore 'in' queries support up to 30 items per query.
    // Batch into chunks of 30 and aggregate.
    const CHUNK_SIZE = 30;
    let relevant = 0;
    let noise = 0;

    for (let i = 0; i < ticketIds.length; i += CHUNK_SIZE) {
      const chunk = ticketIds.slice(i, i + CHUNK_SIZE);
      const snap = await db.collection('feedback')
        .where('ticketId', 'in', chunk)
        .get();

      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.rating === 'relevant') relevant++;
        else if (data.rating === 'noise') noise++;
      }
    }

    return { relevant, noise, total: relevant + noise };
  }

  return {
    submitFeedback,
    getFeedback,
    tallyFeedbackForTickets,
  };
}
