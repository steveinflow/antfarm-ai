// @docket/advisor — input validation + sanitization helpers.
// Extracted from start-advisor.js for navigability.

/**
 * DK-188: Validate and normalize the minConfidence config value.
 * Must be an integer 1–10. Default 5 if missing or invalid.
 *
 * @param {number|undefined} raw - Raw value from docket.config.json advisor.minConfidence
 * @returns {number} - Validated integer 1–10
 */
export function getValidatedMinConfidence(raw) {
  if (!Number.isInteger(raw) || raw < 1 || raw > 10) return 5;
  return raw;
}

/**
 * Sanitize a user-provided hint string before it reaches buildPrompt() (DK-321).
 * - Strips newlines and carriage returns (prevent prompt injection via line breaks)
 * - Enforces 150-char cap (matches client-side limit)
 * - Returns null if the result is empty
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
export function sanitizeUserHint(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\r\n\u2028\u2029]/g, ' ').trim().slice(0, 150);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Sanitize a focus directive string before injecting into a prompt (DK-319).
 * - Strips backticks (structural delimiter prevention)
 * - Strips XML-style tags (structural precaution)
 * - Enforces 500-char cap (matches client-side limit)
 * - Returns null if result is empty after trimming
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
export function sanitizeDirective(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/`/g, '')                        // strip backticks
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')       // strip XML-style tags
    .replace(/[\r\n\u2028\u2029]/g, ' ')      // collapse newlines to spaces
    .trim()
    .slice(0, 500);
  return cleaned.length > 0 ? cleaned : null;
}
