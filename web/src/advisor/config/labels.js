// Display labels and icons for advisor errors, filter reasons, rejection reasons, and health states.

// ── Error reason display mapping ────────────────────────────
export const ERROR_REASON_LABELS = {
  rate_limit:        'Rate limit reached',
  api_unreachable:   'Could not reach Claude API',
  no_codebase_access:'No codebase path configured',
  timeout:           'Request timed out',
  api_error:         'API error',
};

// ── Filter reason display mapping (DK-189) ──────────────────
// Maps FILTER_REASONS enum codes (stored in ticketsFiltered.reasons) to
// plain-language labels. Falls back to the raw code for unknown values.
export const FILTER_REASON_LABELS = {
  duplicate:       'Duplicate of existing ticket',
  rejection_match: 'Matches previously rejected proposal',
  low_confidence:  'Low confidence',
  rate_limit:      'Deferred by run cap',
  out_of_scope:    'Outside project scope',
  persona_mismatch:'Persona mismatch',
};

// ── Rejection reason display mapping ────────────────────────
// Text labels (not color-only) per accessibility requirements.
export const REJECTION_REASON_LABELS = {
  duplicate:      'duplicate',
  low_confidence: 'low confidence',
  threshold:      'threshold',
};

// Simple icons alongside text labels (not color-only per a11y spec)
export const REJECTION_REASON_ICONS = {
  duplicate:      '⧉',
  low_confidence: '~',
  threshold:      '▽',
};

/**
 * Label + color for health category.
 */
export const HEALTH_META = {
  green:  { label: 'Healthy',  cls: 'adv-perf-dot-green'  },
  yellow: { label: 'Fair',     cls: 'adv-perf-dot-yellow' },
  red:    { label: 'Low',      cls: 'adv-perf-dot-red'    },
};
