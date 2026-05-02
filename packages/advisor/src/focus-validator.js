// Focus constraint validation for advisor personas (DK-187).
//
// Each persona has a distinct focus type:
//   - Engineer: globs    (file path globs, e.g. "src/payments/**")
//   - Design:   routes   (URL route paths, e.g. "/checkout")
//   - Product:  keywords (feature keywords, e.g. "billing")
//
// Focus config is stored in /advisor/{personaId} under a `focus` map.
// The daemon reads and re-validates on every run — never trusts the stored value
// without going through validateFocus() first.
//
// Field limits (enforced on write and re-validated on read in the daemon):
//   globs:    max 10 items, each max 100 chars
//   routes:   max 10 items, each max 100 chars
//   keywords: max 20 items, each max 50 chars
//
// Injection defense: values containing instruction-like prose are rejected or stripped.
// Specifically, values containing: ignore, instead, you are, system prompt, instructions
// are rejected server-side in the daemon on read (not only in the UI on write).
//
// Glob safety: globs starting with ".." or "/" are rejected (path traversal).
// Glob complexity: patterns with more than one "**" segment are rejected.

// ── Field limits ──────────────────────────────────────────────────────────
export const FOCUS_LIMITS = {
  globs:    { maxItems: 10, maxLength: 100 },
  routes:   { maxItems: 10, maxLength: 100 },
  keywords: { maxItems: 20, maxLength: 50  },
};

// ── Keyword injection defense ─────────────────────────────────────────────
// Reject values that look like instruction prose. Applied server-side on every read.
// These are case-insensitive substring matches.
const INJECTION_PHRASES = [
  'ignore',
  'instead',
  'you are',
  'system prompt',
  'instructions',
];

/**
 * Check if a value looks like an injection attempt.
 * Returns true if the value should be rejected.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeInjection(value) {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return INJECTION_PHRASES.some(phrase => lower.includes(phrase));
}

// ── Glob validation ───────────────────────────────────────────────────────

/**
 * Validate a single glob pattern for the Engineer persona focus.
 *
 * Rules:
 *  - Must be a non-empty string
 *  - Max 100 characters
 *  - Must not start with ".." or "/" (path traversal / absolute path)
 *  - Must not contain more than one "**" segment
 *  - Must not look like injection prose
 *
 * @param {string} raw
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFocusGlob(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'glob must be a non-empty string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > FOCUS_LIMITS.globs.maxLength) {
    return { valid: false, reason: `glob exceeds ${FOCUS_LIMITS.globs.maxLength} character limit` };
  }
  // Reject absolute paths and traversal
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { valid: false, reason: 'glob must be a relative path (no leading slash)' };
  }
  if (trimmed.startsWith('..')) {
    return { valid: false, reason: 'glob must not start with ".." (path traversal)' };
  }
  // Reject multiple "**" segments
  const doubleStarCount = (trimmed.match(/\*\*/g) || []).length;
  if (doubleStarCount > 1) {
    return { valid: false, reason: 'glob must not contain more than one "**" segment' };
  }
  // Injection defense
  if (looksLikeInjection(trimmed)) {
    return { valid: false, reason: 'glob contains disallowed instruction-like prose' };
  }
  return { valid: true };
}

// ── Route validation ──────────────────────────────────────────────────────

/**
 * Validate a single route path for the Design persona focus.
 *
 * Rules:
 *  - Must be a non-empty string
 *  - Max 100 characters
 *  - Must be a relative path (no scheme, no host)
 *  - Must start with "/" (route paths are absolute relative to app root)
 *  - Must not look like injection prose
 *
 * @param {string} raw
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFocusRoute(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'route must be a non-empty string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > FOCUS_LIMITS.routes.maxLength) {
    return { valid: false, reason: `route exceeds ${FOCUS_LIMITS.routes.maxLength} character limit` };
  }
  // Reject scheme-bearing URLs (must be a relative path)
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed) || /^\/\//.test(trimmed)) {
    return { valid: false, reason: 'route must be a relative path (no scheme or host)' };
  }
  // Reject javascript: and data: URIs
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
    return { valid: false, reason: 'route must not match javascript: or data: URIs' };
  }
  // Routes should start with "/"
  if (!trimmed.startsWith('/')) {
    return { valid: false, reason: 'route must start with "/" (e.g. /checkout)' };
  }
  // Injection defense
  if (looksLikeInjection(trimmed)) {
    return { valid: false, reason: 'route contains disallowed instruction-like prose' };
  }
  return { valid: true };
}

// ── Keyword validation ────────────────────────────────────────────────────

/**
 * Validate a single keyword for the Product persona focus.
 *
 * Rules:
 *  - Must be a non-empty string
 *  - Max 50 characters
 *  - Must not look like injection prose
 *
 * @param {string} raw
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFocusKeyword(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'keyword must be a non-empty string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > FOCUS_LIMITS.keywords.maxLength) {
    return { valid: false, reason: `keyword exceeds ${FOCUS_LIMITS.keywords.maxLength} character limit` };
  }
  // Injection defense
  if (looksLikeInjection(trimmed)) {
    return { valid: false, reason: 'keyword contains disallowed instruction-like prose' };
  }
  return { valid: true };
}

// ── Full focus config validation ──────────────────────────────────────────

/**
 * Validate the full focus config map for a persona.
 * Returns a sanitized copy of the config with invalid items removed.
 * Logs warnings for each rejected item.
 *
 * Returns null if the config is absent or has no valid items (means unconstrained).
 *
 * @param {object|null} rawFocus  - Raw focus map from Firestore (may be null/missing)
 * @param {'engineer'|'design'|'product'} personaId
 * @param {function} [warn]       - Optional callback(msg) for rejected items
 * @returns {{ globs?: string[], routes?: string[], keywords?: string[] } | null}
 */
export function validateFocus(rawFocus, personaId, warn) {
  if (!rawFocus || typeof rawFocus !== 'object') return null;

  const result = {};
  let hasAny = false;

  // Engineer: validate globs
  if (personaId === 'engineer' && Array.isArray(rawFocus.globs)) {
    const safe = [];
    for (const item of rawFocus.globs) {
      if (safe.length >= FOCUS_LIMITS.globs.maxItems) break;
      const { valid, reason } = validateFocusGlob(item);
      if (!valid) {
        if (warn) warn(`Rejecting focus glob "${item}": ${reason}`);
        continue;
      }
      safe.push(item.trim());
    }
    if (safe.length > 0) {
      result.globs = safe;
      hasAny = true;
    }
  }

  // Design: validate routes
  if (personaId === 'design' && Array.isArray(rawFocus.routes)) {
    const safe = [];
    for (const item of rawFocus.routes) {
      if (safe.length >= FOCUS_LIMITS.routes.maxItems) break;
      const { valid, reason } = validateFocusRoute(item);
      if (!valid) {
        if (warn) warn(`Rejecting focus route "${item}": ${reason}`);
        continue;
      }
      safe.push(item.trim());
    }
    if (safe.length > 0) {
      result.routes = safe;
      hasAny = true;
    }
  }

  // Product: validate keywords
  if (personaId === 'product' && Array.isArray(rawFocus.keywords)) {
    const safe = [];
    for (const item of rawFocus.keywords) {
      if (safe.length >= FOCUS_LIMITS.keywords.maxItems) break;
      const { valid, reason } = validateFocusKeyword(item);
      if (!valid) {
        if (warn) warn(`Rejecting focus keyword "${item}": ${reason}`);
        continue;
      }
      safe.push(item.trim());
    }
    if (safe.length > 0) {
      result.keywords = safe;
      hasAny = true;
    }
  }

  return hasAny ? result : null;
}

// ── Prompt injection builder ──────────────────────────────────────────────

/**
 * Build a focus_constraints prompt block for injection into the system prompt.
 * Values are wrapped in XML-style tags so the model treats them as data, not instructions.
 * Returns null if the focus config has no valid items.
 *
 * @param {{ globs?: string[], routes?: string[], keywords?: string[] } | null} focus
 * @param {'engineer'|'design'|'product'} personaId
 * @returns {string | null}
 */
export function buildFocusConstraintBlock(focus, personaId) {
  if (!focus) return null;

  const lines = [];
  lines.push('<focus_constraints>');

  if (personaId === 'engineer' && Array.isArray(focus.globs) && focus.globs.length > 0) {
    lines.push(`  <globs>${focus.globs.join(', ')}</globs>`);
    lines.push('  Restrict your analysis to files matching the above glob patterns only.');
    lines.push('  Ignore files outside these paths.');
  }

  if (personaId === 'design' && Array.isArray(focus.routes) && focus.routes.length > 0) {
    lines.push(`  <routes>${focus.routes.join(', ')}</routes>`);
    lines.push('  Restrict your analysis to the above route paths only.');
    lines.push('  Only report issues in these areas of the application.');
  }

  if (personaId === 'product' && Array.isArray(focus.keywords) && focus.keywords.length > 0) {
    lines.push(`  <keywords>${focus.keywords.join(', ')}</keywords>`);
    lines.push('  Focus your feature ideas exclusively on the above keywords/feature areas.');
    lines.push('  Ideas about unrelated areas should not be proposed.');
  }

  lines.push('</focus_constraints>');

  // If no field was written, return null
  if (lines.length === 2) return null; // only open/close tags
  return lines.join('\n');
}
