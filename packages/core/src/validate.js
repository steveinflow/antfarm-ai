// Ticket validation

const VALID_TYPES = ['bug', 'feature'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SCREENSHOTS = 10;
const MAX_SCREENSHOTS_BYTES = 10 * 1024 * 1024; // 10 MB

// Reasoning validation constants
const MAX_EVIDENCE_ITEMS = 50;
const MAX_SUMMARY_LENGTH = 500;
const MAX_NOTE_LENGTH = 500;
const VALID_EVIDENCE_TYPES = ['file', 'screenshot', 'url'];
const MAX_NESTING_DEPTH = 3; // evidence items must be flat objects (depth ≤ 3 from root)

/**
 * Measure the maximum nesting depth of a value.
 * Primitive values and null have depth 0. Objects/arrays add one level per nesting.
 * Stops early once depth exceeds the given limit to avoid expensive traversal.
 *
 * @param {*} value
 * @param {number} limit - Stop-early limit; returns limit+1 when exceeded
 * @returns {number}
 */
function maxDepth(value, limit = MAX_NESTING_DEPTH) {
  if (value === null || typeof value !== 'object') return 0;
  if (limit === 0) return 1; // already exceeded
  let depth = 0;
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const child of entries) {
    const childDepth = maxDepth(child, limit - 1);
    if (childDepth + 1 > depth) {
      depth = childDepth + 1;
      if (depth >= limit) return depth; // stop early
    }
  }
  return depth;
}

/**
 * Validate a reasoning object provided by an advisor persona before persisting
 * to Firestore. Guards against oversized or deeply nested payloads from buggy
 * or community-fork personas that don't sanitise their LLM output.
 *
 * Schema: { summary: string, evidence: Array<{ type, ...fields }> }
 *
 * @param {*} reasoning - Value to validate (any type accepted for safe rejection)
 * @returns {string[]|null} Array of error strings, or null when valid
 */
export function validateReasoning(reasoning) {
  const errors = [];

  if (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
    errors.push('reasoning must be a plain object');
    return errors;
  }

  // summary — required string, bounded length
  if (typeof reasoning.summary !== 'string') {
    errors.push('reasoning.summary must be a string');
  } else if (reasoning.summary.trim().length === 0) {
    errors.push('reasoning.summary must not be empty');
  } else if (reasoning.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push(`reasoning.summary must not exceed ${MAX_SUMMARY_LENGTH} characters`);
  }

  // evidence — required array, bounded item count
  if (!Array.isArray(reasoning.evidence)) {
    errors.push('reasoning.evidence must be an array');
  } else {
    if (reasoning.evidence.length > MAX_EVIDENCE_ITEMS) {
      errors.push(`reasoning.evidence must not exceed ${MAX_EVIDENCE_ITEMS} items`);
    }

    reasoning.evidence.forEach((item, idx) => {
      const prefix = `reasoning.evidence[${idx}]`;

      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${prefix} must be a plain object`);
        return;
      }

      // type — required, must be a known value
      if (!VALID_EVIDENCE_TYPES.includes(item.type)) {
        errors.push(`${prefix}.type must be one of: ${VALID_EVIDENCE_TYPES.join(', ')}`);
      }

      // note — optional string, bounded length
      if (item.note !== undefined) {
        if (typeof item.note !== 'string') {
          errors.push(`${prefix}.note must be a string`);
        } else if (item.note.length > MAX_NOTE_LENGTH) {
          errors.push(`${prefix}.note must not exceed ${MAX_NOTE_LENGTH} characters`);
        }
      }

      // Nesting depth guard — evidence items should be flat objects
      const depth = maxDepth(item, MAX_NESTING_DEPTH);
      if (depth > MAX_NESTING_DEPTH) {
        errors.push(`${prefix} exceeds maximum nesting depth of ${MAX_NESTING_DEPTH}`);
      }
    });
  }

  return errors.length ? errors : null;
}

export function validateTicket({ type, title, userId, userEmail, screenshots }) {
  const errors = [];

  if (!type || !VALID_TYPES.includes(type)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (!title || !title.trim()) {
    errors.push('title is required');
  }

  if (userId !== undefined && userId !== null && typeof userId !== 'string') {
    errors.push('userId must be a string');
  }

  if (userEmail !== undefined && userEmail !== null && userEmail !== '') {
    if (typeof userEmail !== 'string' || !EMAIL_REGEX.test(userEmail)) {
      errors.push('userEmail must be a valid email address');
    }
  }

  if (screenshots !== undefined && screenshots !== null) {
    if (!Array.isArray(screenshots)) {
      errors.push('screenshots must be an array');
    } else {
      if (screenshots.length > MAX_SCREENSHOTS) {
        errors.push(`screenshots must not exceed ${MAX_SCREENSHOTS} items`);
      }
      const totalBytes = screenshots.reduce((sum, s) => {
        // Each screenshot may be a base64 string, a Buffer, or an object with a size property
        if (typeof s === 'string') {
          // base64 strings: approximate byte length
          return sum + Math.ceil(s.length * 0.75);
        }
        if (Buffer.isBuffer(s)) {
          return sum + s.length;
        }
        if (s && typeof s === 'object' && typeof s.size === 'number') {
          return sum + s.size;
        }
        return sum;
      }, 0);
      if (totalBytes > MAX_SCREENSHOTS_BYTES) {
        errors.push(`screenshots total size must not exceed ${MAX_SCREENSHOTS_BYTES / (1024 * 1024)} MB`);
      }
    }
  }

  return errors.length ? errors : null;
}
