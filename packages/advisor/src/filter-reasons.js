// filter-reasons.js — shared enum codes for advisor ticket filter/skip reasons.
// Used by run-logger.js and advisor-panel.js (via the web UI) to map codes to labels.
//
// Rules:
// - Store codes in Firestore, never free-form AI text.
// - UI should display the plain-language label; fall back to the raw code for unknown values.
// - Add new codes here; the UI fallback handles unknown codes gracefully.

/**
 * Reason codes for proposals that were skipped (not created as tickets).
 * These are stored in the `ticketsFiltered` array in the run log document.
 *
 * @enum {string}
 */
export const FILTER_REASONS = {
  /** Proposal matched an existing open ticket (keyword/title similarity) */
  DUPLICATE:        'duplicate',

  /** Proposal matched a user-rejected proposal in rejection history */
  REJECTION_MATCH:  'rejection_match',

  /** Proposal fell below the confidence threshold after scoring */
  LOW_CONFIDENCE:   'low_confidence',

  /** Proposal was deferred by the per-run ticket cap */
  RATE_LIMIT:       'rate_limit',

  /** Proposal was outside the project's defined scope */
  OUT_OF_SCOPE:     'out_of_scope',

  /** Proposal was not appropriate for this persona type */
  PERSONA_MISMATCH: 'persona_mismatch',
};

/**
 * Human-readable labels for filter reason codes.
 * Used in the run log drawer UI.
 * Entries must match the codes in FILTER_REASONS above.
 *
 * @type {Record<string, string>}
 */
export const FILTER_REASON_LABELS = {
  [FILTER_REASONS.DUPLICATE]:       'Duplicate of existing ticket',
  [FILTER_REASONS.REJECTION_MATCH]: 'Matches previously rejected proposal',
  [FILTER_REASONS.LOW_CONFIDENCE]:  'Low confidence',
  [FILTER_REASONS.RATE_LIMIT]:      'Deferred by run cap',
  [FILTER_REASONS.OUT_OF_SCOPE]:    'Outside project scope',
  [FILTER_REASONS.PERSONA_MISMATCH]:'Persona mismatch',
};

/**
 * Return the plain-language label for a filter reason code.
 * Falls back to the raw code string for unknown codes.
 *
 * @param {string} code
 * @returns {string}
 */
export function filterReasonLabel(code) {
  return FILTER_REASON_LABELS[code] || code;
}
