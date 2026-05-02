import admin from 'firebase-admin';

// Advisor feedback service — records accept/reject/snooze decisions and
// computes aggregated signal for prompt injection.
//
// Feedback events are stored as an append-only subcollection:
//   /projects/{projectId}/feedbackEvents/{eventId}
//
// Fields per event:
//   personaId  — 'engineer' | 'design' | 'product'
//   ticketId   — string reference only (no denormalized content)
//   decision   — 'accepted' | 'rejected' | 'snoozed'
//   timestamp  — server timestamp
//   userId     — string (for auditability)
//
// Signal computation is scoped per-persona per-project over the recency window:
//   last 30 days OR last 50 decisions, whichever is smaller.
//
// Minimum threshold: at least 10 decisions required before injection.
//
// Category ranking uses the ticket's existing `tags` or `category` field.
// No LLM, embeddings, or similarity search is used.

const RECENCY_DAYS = 30;
const RECENCY_MAX_DECISIONS = 50;
const MIN_THRESHOLD = 10;
const TOP_CATEGORIES_MAX = 5;
const CATEGORY_LABEL_MAX_LENGTH = 60;

/**
 * Strip newlines and truncate a category label to prevent prompt injection.
 * @param {string} label
 * @returns {string}
 */
function sanitizeCategoryLabel(label) {
  if (typeof label !== 'string') return '';
  return label.replace(/[\r\n]+/g, ' ').trim().slice(0, CATEGORY_LABEL_MAX_LENGTH);
}

/**
 * Create a feedback service scoped to the advisor feedback loop.
 *
 * @param {object} db - Firestore Admin instance
 * @returns {object}
 */
export function createAdvisorFeedbackService(db) {
  /**
   * Record a single feedback decision.
   *
   * @param {object} opts
   * @param {string} opts.projectId
   * @param {string} opts.personaId   - 'engineer' | 'design' | 'product'
   * @param {string} opts.ticketId    - Firestore doc ID (no content)
   * @param {string} opts.decision    - 'accepted' | 'rejected' | 'snoozed'
   * @param {string} opts.userId      - Authenticated user ID
   * @returns {Promise<void>}
   */
  async function recordDecision({ projectId, personaId, ticketId, decision, userId }) {
    if (!projectId || !personaId || !ticketId || !decision || !userId) {
      throw new Error('recordDecision: missing required field');
    }
    const validDecisions = ['accepted', 'rejected', 'snoozed'];
    if (!validDecisions.includes(decision)) {
      throw new Error(`recordDecision: invalid decision "${decision}"`);
    }
    await db
      .collection('projects')
      .doc(projectId)
      .collection('feedbackEvents')
      .add({
        personaId,
        ticketId,
        decision,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        userId,
      });
  }

  /**
   * Fetch recent feedback events for a persona in a project.
   * Applies the recency window: last 30 days OR last 50, whichever is smaller.
   *
   * @param {string} projectId
   * @param {string} personaId
   * @returns {Promise<Array<{ id, personaId, ticketId, decision, timestamp, userId }>>}
   */
  async function fetchRecentEvents(projectId, personaId) {
    const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000);

    // Query last 50 decisions for this persona, ordered by timestamp desc
    const snap = await db
      .collection('projects')
      .doc(projectId)
      .collection('feedbackEvents')
      .where('personaId', '==', personaId)
      .orderBy('timestamp', 'desc')
      .limit(RECENCY_MAX_DECISIONS)
      .get();

    const events = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      // Also apply the 30-day cutoff (whichever is smaller)
      const ts = data.timestamp?.toDate?.() ?? null;
      if (ts && ts < cutoff) break; // ordered desc, so once we hit old docs we can stop
      events.push({ id: doc.id, ...data });
    }
    return events;
  }

  /**
   * Compute aggregated signal from a list of events.
   * Returns counts, acceptance rate, and top rejected categories.
   * Category data requires fetching ticket docs (by ticketId) from Firestore.
   *
   * @param {string} projectId
   * @param {Array} events
   * @returns {Promise<{ accepted, rejected, snoozed, total, acceptanceRate, topRejectedCategories }>}
   */
  async function computeSignal(projectId, events) {
    let accepted = 0;
    let rejected = 0;
    let snoozed = 0;

    // Collect rejected ticket IDs for category ranking
    const rejectedTicketIds = [];

    for (const ev of events) {
      if (ev.decision === 'accepted') accepted++;
      else if (ev.decision === 'rejected') { rejected++; rejectedTicketIds.push(ev.ticketId); }
      else if (ev.decision === 'snoozed') snoozed++;
    }

    // Acceptance rate excludes snoozed (per spec: snooze is neutral)
    const denominator = accepted + rejected;
    const acceptanceRate = denominator > 0 ? Math.round((accepted / denominator) * 100) : null;

    // Rank rejected categories using existing structured fields (tags / category)
    const topRejectedCategories = await computeTopRejectedCategories(
      projectId,
      rejectedTicketIds,
    );

    return {
      accepted,
      rejected,
      snoozed,
      total: accepted + rejected + snoozed,
      acceptanceRate,
      topRejectedCategories,
    };
  }

  /**
   * Fetch ticket docs and tally rejected categories.
   * Uses tickets' existing `tags` (array) or `category` (string) fields.
   * No LLM, embeddings, or similarity search.
   *
   * @param {string} projectId
   * @param {string[]} ticketIds
   * @returns {Promise<Array<{ label: string, count: number }>>}
   */
  async function computeTopRejectedCategories(projectId, ticketIds) {
    if (!ticketIds.length) return [];

    const counts = {};
    // Fetch in batches of 10 (Firestore 'in' query limit)
    for (let i = 0; i < ticketIds.length; i += 10) {
      const batch = ticketIds.slice(i, i + 10);
      try {
        const snap = await db
          .collection('projects')
          .doc(projectId)
          .collection('tickets')
          .where('__name__', 'in', batch.map(id => db.collection('projects').doc(projectId).collection('tickets').doc(id)))
          .get();

        for (const doc of snap.docs) {
          const data = doc.data();
          const labels = extractCategories(data);
          for (const label of labels) {
            const key = sanitizeCategoryLabel(label);
            if (key) counts[key] = (counts[key] || 0) + 1;
          }
        }
      } catch {
        // Non-fatal: if ticket fetch fails, skip category ranking for this batch
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CATEGORIES_MAX)
      .map(([label, count]) => ({ label, count }));
  }

  /**
   * Extract category labels from a ticket document.
   * Checks `tags` (array) first, then `category` (string).
   *
   * @param {object} ticketData
   * @returns {string[]}
   */
  function extractCategories(ticketData) {
    if (Array.isArray(ticketData.tags) && ticketData.tags.length > 0) {
      return ticketData.tags.filter(t => typeof t === 'string' && t.trim());
    }
    if (typeof ticketData.category === 'string' && ticketData.category.trim()) {
      return [ticketData.category.trim()];
    }
    return [];
  }

  /**
   * Build a prompt injection block for a persona in a project.
   * Returns null if:
   *   - feedback injection is disabled for this persona
   *   - fewer than MIN_THRESHOLD decisions exist in the recency window
   *
   * @param {string} projectId
   * @param {string} personaId
   * @param {boolean} injectionEnabled - from per-project Firestore config
   * @returns {Promise<string|null>}
   */
  async function buildInjectionBlock(projectId, personaId, injectionEnabled) {
    if (!injectionEnabled) return null;

    const events = await fetchRecentEvents(projectId, personaId);
    if (events.length < MIN_THRESHOLD) return null;

    const signal = await computeSignal(projectId, events);

    const lines = [
      `Recent feedback for this persona (last ${events.length} decisions):`,
      `- Accepted: ${signal.accepted} / Rejected: ${signal.rejected} / Snoozed: ${signal.snoozed}`,
    ];

    if (signal.acceptanceRate !== null) {
      lines.push(`- Acceptance rate: ${signal.acceptanceRate}%`);
    }

    if (signal.topRejectedCategories.length > 0) {
      const top = signal.topRejectedCategories[0];
      lines.push(`- Most rejected category: ${top.label} (${top.count} of ${signal.rejected})`);
    }

    return lines.join('\n');
  }

  /**
   * Read the per-persona feedback injection toggle from the per-project config.
   * Stored in the project document under:
   *   advisorConfig.{personaId}.feedbackInjectionEnabled
   * Defaults to true (enabled) if not set.
   *
   * @param {string} projectId
   * @param {string} personaId
   * @returns {Promise<boolean>}
   */
  async function getFeedbackInjectionEnabled(projectId, personaId) {
    try {
      const snap = await db.collection('projects').doc(projectId).get();
      if (!snap.exists) return true;
      const data = snap.data();
      const val = data?.advisorConfig?.[personaId]?.feedbackInjectionEnabled;
      // Default to true if not explicitly set to false
      return val !== false;
    } catch {
      return true;
    }
  }

  /**
   * Set the per-persona feedback injection toggle on a project doc.
   *
   * @param {string} projectId
   * @param {string} personaId
   * @param {boolean} enabled
   * @returns {Promise<void>}
   */
  async function setFeedbackInjectionEnabled(projectId, personaId, enabled) {
    await db.collection('projects').doc(projectId).set(
      { advisorConfig: { [personaId]: { feedbackInjectionEnabled: !!enabled } } },
      { merge: true },
    );
  }

  /**
   * Fetch aggregated stats for UI display (stat row + expanded view).
   * Returns raw counts, acceptance rate, top rejected categories,
   * total decisions in window, and threshold status.
   *
   * @param {string} projectId
   * @param {string} personaId
   * @returns {Promise<{
   *   total: number,
   *   accepted: number,
   *   rejected: number,
   *   snoozed: number,
   *   acceptanceRate: number|null,
   *   topRejectedCategories: Array<{ label, count }>,
   *   belowThreshold: boolean,
   *   windowDays: number,
   *   windowMax: number,
   * }>}
   */
  async function getStats(projectId, personaId) {
    const events = await fetchRecentEvents(projectId, personaId);
    const signal = await computeSignal(projectId, events);
    return {
      ...signal,
      belowThreshold: events.length < MIN_THRESHOLD,
      windowDays: RECENCY_DAYS,
      windowMax: RECENCY_MAX_DECISIONS,
    };
  }

  return {
    recordDecision,
    fetchRecentEvents,
    computeSignal,
    buildInjectionBlock,
    getFeedbackInjectionEnabled,
    setFeedbackInjectionEnabled,
    getStats,
    MIN_THRESHOLD,
    RECENCY_DAYS,
    RECENCY_MAX_DECISIONS,
  };
}
