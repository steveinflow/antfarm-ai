// Exclusion pattern utilities — shared between engineer (glob) and design (URL) filtering.
//
// Spec requirements:
//   - Max 20 patterns per persona per project
//   - Max 200 characters per pattern
//   - Reject patterns with repeated wildcards (**/**,  ***, etc.)
//   - Reject design URL patterns that could match javascript: or data: URIs
//   - Log a warning and skip invalid patterns at runtime (never throw)
//
// Path traversal guard is NOT done here — the caller (files.js) enumerates
// files within the repo root first, then filters the resulting list.
// User-supplied globs are NEVER passed as arguments to fs operations.

const MAX_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 200;

// Matches any run of 3+ consecutive `*` characters, or ** followed by / then **
// (e.g. **/** is the canonical bad pattern but ***+ is also caught)
const REPEATED_WILDCARD_RE = /\*{3,}|\*\*\/\*\*/;

/**
 * Validate a single glob pattern for the engineer persona.
 *
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * @param {string} pattern
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateGlobPattern(pattern) {
  if (typeof pattern !== 'string') {
    return { valid: false, reason: 'pattern must be a string' };
  }
  if (pattern.trim().length === 0) {
    return { valid: false, reason: 'pattern is empty' };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, reason: `pattern exceeds ${MAX_PATTERN_LENGTH} character limit` };
  }
  if (REPEATED_WILDCARD_RE.test(pattern)) {
    return { valid: false, reason: 'pattern contains repeated wildcards (e.g. **/**) — simplify to **' };
  }
  return { valid: true };
}

/**
 * Validate a single URL pattern for the design persona.
 *
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * @param {string} pattern
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateUrlPattern(pattern) {
  if (typeof pattern !== 'string') {
    return { valid: false, reason: 'pattern must be a string' };
  }
  if (pattern.trim().length === 0) {
    return { valid: false, reason: 'pattern is empty' };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, reason: `pattern exceeds ${MAX_PATTERN_LENGTH} character limit` };
  }
  // Reject patterns that could match javascript: or data: URIs — XSS / injection risk
  const lower = pattern.toLowerCase().trim();
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
    return { valid: false, reason: 'pattern must not match javascript: or data: URIs' };
  }
  return { valid: true };
}

/**
 * Sanitize and validate an array of exclusion patterns, enforcing max count
 * and per-pattern limits.  Returns the safe subset.
 *
 * Patterns that fail validation are silently dropped (with an optional warning
 * callback so callers can log them).  Never throws.
 *
 * @param {string[]} patterns           - Raw array from Firestore
 * @param {'glob'|'url'} type           - Validation mode
 * @param {function} [warn]             - Optional callback(msg) for dropped patterns
 * @returns {string[]}                  - Validated patterns (up to MAX_PATTERNS)
 */
export function sanitizeExclusionPatterns(patterns, type, warn) {
  if (!Array.isArray(patterns)) return [];

  const validate = type === 'url' ? validateUrlPattern : validateGlobPattern;
  const result = [];

  for (const raw of patterns) {
    if (result.length >= MAX_PATTERNS) break;
    const { valid, reason } = validate(raw);
    if (!valid) {
      if (warn) warn(`Skipping invalid ${type} exclusion pattern "${raw}": ${reason}`);
      continue;
    }
    result.push(raw.trim());
  }

  return result;
}

/**
 * Check whether a URL matches any of the given exclusion patterns.
 * Patterns are matched using simple prefix or exact string matching — no regex.
 *
 * @param {string} url      - The URL to test
 * @param {string[]} patterns - Validated URL exclusion patterns
 * @returns {boolean}
 */
export function isUrlExcluded(url, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    // Exact match OR prefix match (pattern acts as a URL prefix)
    if (url === pattern || url.startsWith(pattern)) return true;
  }
  return false;
}

export { MAX_PATTERNS, MAX_PATTERN_LENGTH };
