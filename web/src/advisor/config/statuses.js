// Status sets used for performance dashboard categorisation.

/**
 * Statuses that count as "accepted" (user decided to act on this proposal).
 */
export const ACCEPTED_STATUSES = new Set(['open', 'in_progress', 'blocked', 'waiting_for_user', 'in_maintenance', 'done', 'verified']);

/**
 * Statuses that count as "rejected" (user explicitly dismissed).
 * 'rejected' is the terminal status for triage-rejected proposals (DK-196).
 * 'wont_do' is the legacy path (admin decision, not triage feedback).
 */
export const REJECTED_STATUSES = new Set(['wont_do', 'rejected']);
