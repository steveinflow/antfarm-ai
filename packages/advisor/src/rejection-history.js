// Rejection history helper — fetches project rejections from Firestore and
// formats them for injection into advisor prompts.
//
// Security: rejection records contain only immutable server-side snapshots
// (ticketTitle, ticketSummary) written at rejection time. No user-supplied
// text is stored in these fields. The injected block is wrapped in clear
// delimiters and placed in a well-defined position in the prompt.
//
// Prompt injection format (per spec):
//   Previously rejected ideas for this project — do not repropose these or closely related ideas:
//   - [ticketTitle]: [ticketSummary] (reason: [reason])
//   ...

const PROMPT_LIMIT = 15; // max entries to inject per spec (cap at 15 most recent)
const FETCH_LIMIT = 50;  // max rejections to fetch from Firestore (recency window)

/**
 * Fetch recent rejections for a project from Firestore.
 *
 * @param {object} db - Firestore Admin instance
 * @param {string} projectId
 * @returns {Promise<Array<{ ticketTitle, ticketSummary, reason, persona, createdAt }>>}
 */
export async function fetchRejections(db, projectId) {
  try {
    const snap = await db
      .collection('projects')
      .doc(projectId)
      .collection('rejections')
      .orderBy('createdAt', 'desc')
      .limit(FETCH_LIMIT)
      .get();

    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    // Non-fatal: if rejections can't be fetched, continue without them
    console.warn(`[rejection-history] Could not fetch rejections for ${projectId}: ${err.message}`);
    return [];
  }
}

/**
 * Format rejection history for injection into an advisor prompt.
 * Filters to the given persona and caps at PROMPT_LIMIT entries.
 *
 * Spec format:
 *   Previously rejected ideas for this project — do not repropose these or closely related ideas:
 *   - [ticketTitle]: [ticketSummary] (reason: [reason])
 *
 * @param {Array} rejections - from fetchRejections()
 * @param {string} [persona] - filter to this persona (engineer|design|product); if omitted, uses all
 * @returns {string} - formatted block to inject after main persona instructions, or empty string
 */
export function formatRejectionHistory(rejections, persona) {
  if (!rejections || rejections.length === 0) return '';

  // Filter to relevant persona if specified, but include entries without a persona field
  // (backward-compatible with older records that may not have the field)
  let relevant = rejections;
  if (persona) {
    relevant = rejections.filter(r => !r.persona || r.persona === persona);
  }

  if (relevant.length === 0) return '';

  // Cap at PROMPT_LIMIT (data is already ordered by recency from FETCH_LIMIT)
  const capped = relevant.slice(0, PROMPT_LIMIT);

  const lines = capped.map(r => {
    const title = r.ticketTitle || '(unknown)';
    const summary = r.ticketSummary || '';
    const reason = r.reason || '';

    if (summary) {
      return `- ${title}: ${summary} (reason: ${reason})`;
    }
    return `- ${title} (reason: ${reason})`;
  });

  return [
    'Previously rejected ideas for this project — do not repropose these or closely related ideas:',
    ...lines,
  ].join('\n');
}

/**
 * Count rejections created in the current calendar month for a project.
 * Used for internal trend tracking (not shown raw to the user).
 *
 * @param {object} db - Firestore Admin instance
 * @param {string} projectId
 * @returns {Promise<number>}
 */
export async function getMonthlyRejectionCount(db, projectId) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const snap = await db
      .collection('projects')
      .doc(projectId)
      .collection('rejections')
      .where('createdAt', '>=', startOfMonth)
      .get();

    return snap.size;
  } catch {
    return 0;
  }
}
