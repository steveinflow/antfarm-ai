// Rejection service — stores and retrieves advisor proposal rejections.
// Rejections are stored in a flat subcollection:
//   projects/{projectId}/rejections/{ticketId}
//
// Security: freeText is user-generated and gets injected into LLM prompts.
// Before injection, all newlines are stripped and content is capped at 200 chars.
// This enforcement happens at write time here, not just at read time.

const VALID_REASONS = new Set(['duplicate', 'out_of_scope', 'not_a_priority', 'other']);
const FREE_TEXT_MAX = 200;

/**
 * Sanitize free-text rejection reason for safe storage and later LLM injection.
 * - Strips all newline characters
 * - Hard-caps at 200 chars
 * - Strips control characters
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeFreeText(text) {
  if (typeof text !== 'string') return '';
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars
    .replace(/[\r\n]+/g, ' ')                            // strip newlines (security)
    .trim()
    .slice(0, FREE_TEXT_MAX);
}

/**
 * Create a rejection service for a project.
 *
 * @param {object} db - Firestore instance (admin or web SDK)
 * @param {string} projectId
 * @returns {{ addRejection, listRejections, getRecentRejectionCount }}
 */
export function createRejectionService(db, projectId) {
  const rejectionsRef = () =>
    db.collection('projects').doc(projectId).collection('rejections');

  /**
   * Record a rejection for a proposed ticket.
   *
   * @param {object} opts
   * @param {string} opts.ticketId - The rejected ticket's Firestore doc id
   * @param {string} opts.ticketTitle - The rejected ticket's title (stored for dedup matching)
   * @param {string} opts.reason - One of: duplicate | out_of_scope | not_a_priority | other
   * @param {string} [opts.freeText] - Optional free text (only for reason === 'other')
   * @param {string} [opts.personaType] - The persona that generated the ticket
   * @returns {Promise<void>}
   */
  async function addRejection({ ticketId, ticketTitle, reason, freeText, personaType }) {
    if (!ticketId || typeof ticketId !== 'string') {
      throw new Error('ticketId is required');
    }
    if (!VALID_REASONS.has(reason)) {
      throw new Error(`Invalid reason "${reason}". Must be one of: ${[...VALID_REASONS].join(', ')}`);
    }

    const doc = {
      reason,
      personaType: typeof personaType === 'string' ? personaType.slice(0, 64) : null,
      ticketTitle: typeof ticketTitle === 'string' ? ticketTitle.slice(0, 500) : '',
      createdAt: new Date().toISOString(),
    };

    // Only store freeText when reason is 'other'; sanitize before storing
    if (reason === 'other' && typeof freeText === 'string' && freeText.trim()) {
      doc.freeText = sanitizeFreeText(freeText);
    }

    await rejectionsRef().doc(ticketId).set(doc);
  }

  /**
   * Undo a rejection — removes the rejection document.
   *
   * @param {string} ticketId - The rejected ticket's Firestore doc id
   * @returns {Promise<void>}
   */
  async function undoRejection(ticketId) {
    await rejectionsRef().doc(ticketId).delete();
  }

  /**
   * List recent rejections for this project, ordered newest-first.
   * Used by the advisor to inject rejection history into prompts.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit] - Max rejections to fetch (default: 50)
   * @returns {Promise<Array<{ ticketTitle, reason, freeText, personaType, createdAt }>>}
   */
  async function listRejections({ limit = 50 } = {}) {
    const snap = await rejectionsRef()
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Count rejections created in the current calendar month.
   * Used for the "N proposals rejected this month" UI badge.
   *
   * @returns {Promise<number>}
   */
  async function getRecentRejectionCount() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const snap = await rejectionsRef()
      .where('createdAt', '>=', startOfMonth)
      .get();

    return snap.size;
  }

  return { addRejection, undoRejection, listRejections, getRecentRejectionCount };
}
