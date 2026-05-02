// weight-builder.js — Persona emphasis weight validation and prompt injection.
//
// Weights are stored per-project in Firestore under:
//   advisor.projects.<id>.weights.engineer = { security: 3, performance: 1, maintainability: 1 }
//   advisor.projects.<id>.weights.design   = { layout: 1, copy: 1, flow: 3 }
//
// Rules (from ticket DK-105):
//   - Values are integers 1–5. No floats, no normalization.
//   - Keys must be in a hardcoded allowlist — user-supplied keys are never written
//     to Firestore or interpolated into prompts (prompt injection vector).
//   - When all weights for a persona equal 1 (or the map is absent), inject NOTHING.
//     The common case (no customization) must be identical to current behavior.
//   - Label as "priority level" in the injected string — NOT "3x" or similar.

// ── Allowlists ────────────────────────────────────────────────────────────────

/** Valid concern keys per persona (hardcoded — never derived from user input). */
export const PERSONA_CONCERNS = {
  engineer: ['security', 'performance', 'maintainability'],
  design:   ['layout', 'copy', 'flow'],
  product:  ['user_value', 'feasibility', 'strategic_fit'],
};

/** Human-readable labels for each concern key. */
const CONCERN_LABELS = {
  security:       'security',
  performance:    'performance',
  maintainability:'maintainability',
  layout:         'layout',
  copy:           'copy',
  flow:           'flow',
  user_value:     'user value',
  feasibility:    'feasibility',
  strategic_fit:  'strategic fit',
};

// ── Weight validation ─────────────────────────────────────────────────────────

/**
 * Validate and sanitize a weights map for a given persona.
 * - Only keys in the persona's allowlist are kept.
 * - Values must be integers 1–5; invalid values are dropped (fall back to 1 in prompt).
 * - Never throws — returns a safe, sanitized map (may be empty).
 *
 * @param {*} rawWeights - Untrusted value from Firestore
 * @param {'engineer'|'design'|'product'} personaId
 * @returns {object} Sanitized weights map (only allowlisted keys with valid values)
 */
export function sanitizeWeights(rawWeights, personaId) {
  const allowedKeys = PERSONA_CONCERNS[personaId];
  if (!allowedKeys) return {};
  if (!rawWeights || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) return {};

  const result = {};
  for (const key of allowedKeys) {
    const raw = rawWeights[key];
    if (raw === undefined || raw === null) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 5) {
      result[key] = n;
    }
  }
  return result;
}

/**
 * Return true when all weights for a persona are at default (1) or absent.
 * In this case, nothing should be injected into the prompt.
 *
 * @param {object} weights - Already-sanitized weights map
 * @param {'engineer'|'design'|'product'} personaId
 * @returns {boolean}
 */
export function isDefaultWeights(weights, personaId) {
  const allowedKeys = PERSONA_CONCERNS[personaId];
  if (!allowedKeys) return true;
  if (!weights || typeof weights !== 'object') return true;
  for (const key of allowedKeys) {
    const v = weights[key];
    if (v !== undefined && v !== 1) return false;
  }
  return true;
}

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Build a natural-language priority line to append to the persona's system prompt.
 * Returns null when all weights are default (preserving current behavior exactly).
 *
 * The output is a single line like:
 *   "Prioritize concerns in this order by priority level: security (5), maintainability (3), performance (1). Surface higher-priority findings first."
 *
 * Concerns are sorted descending by weight so the highest-priority concern is listed first.
 * Equal-weight concerns preserve their canonical order from the allowlist.
 *
 * @param {*} rawWeights - Untrusted value from Firestore
 * @param {'engineer'|'design'|'product'} personaId
 * @returns {string|null} Priority line for prompt injection, or null if all-default
 */
export function buildWeightPriorityLine(rawWeights, personaId) {
  const allowedKeys = PERSONA_CONCERNS[personaId];
  if (!allowedKeys) return null;

  const weights = sanitizeWeights(rawWeights, personaId);
  if (isDefaultWeights(weights, personaId)) return null;

  // Build a full map, filling missing keys with 1
  const fullWeights = Object.fromEntries(allowedKeys.map(k => [k, weights[k] ?? 1]));

  // Sort descending by weight, preserving canonical order for ties
  const sorted = [...allowedKeys].sort((a, b) => fullWeights[b] - fullWeights[a]);

  const concernStr = sorted
    .map(k => `${CONCERN_LABELS[k] || k} (${fullWeights[k]})`)
    .join(', ');

  return `Prioritize concerns in this order by priority level: ${concernStr}. Surface higher-priority findings first.`;
}
