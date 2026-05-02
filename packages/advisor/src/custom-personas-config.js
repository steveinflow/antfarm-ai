// Custom personas config validator.
// Validates the "advisor.personas" array from docket.config.json.
// Called at daemon startup to ensure user-defined personas are safe to run.

const VALID_MODELS = new Set([
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001', // alias used in existing config
  'claude-sonnet-4-6',
  'claude-opus-4-5',
]);

// Model aliases — map legacy/short names to canonical names accepted by the API
const MODEL_ALIASES = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

const RESERVED_NAMES = new Set(['Engineer', 'Design', 'Product']);

// Characters that could break prompt interpolation
const PROMPT_DELIMITER_RE = /[\n\r\u2028\u2029]|<\/?system>|<\|/g;

/**
 * Strip newlines and prompt-delimiter characters from a string value.
 * Used for name and focusAreas before they flow into constructed prompts.
 *
 * @param {string} str
 * @returns {string}
 */
export function sanitizePromptValue(str) {
  if (typeof str !== 'string') return '';
  return str.replace(PROMPT_DELIMITER_RE, ' ').trim();
}

// Role-switching phrases that signal prompt-injection attempts in a focus prompt.
// Case-insensitive substring check — no need to be exhaustive.
const INJECTION_PHRASES = [
  'ignore previous instructions',
  'you are now',
  'disregard',
  'new persona',
  'system:',
];

/**
 * Sanitize an on-demand focus prompt supplied by the user.
 *
 * Rules:
 *  1. Hard-truncate at 256 characters (before any other processing).
 *  2. Strip or reject strings containing role-switching / injection phrases.
 *  3. Strip prompt-delimiter characters (newlines, <system>, etc.).
 *
 * Returns null if the input is empty or entirely composed of injection phrases.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} sanitized value, or null if empty / rejected
 */
export function sanitizeFocusPrompt(raw) {
  if (typeof raw !== 'string') return null;
  // 1. Hard truncate
  let s = raw.slice(0, 256);
  // 2. Reject strings containing injection phrases (case-insensitive substring check)
  const lower = s.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      // Strip the offending phrase rather than dropping the whole input
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      s = s.replace(re, '');
    }
  }
  // 3. Strip prompt-delimiter characters
  s = s.replace(PROMPT_DELIMITER_RE, ' ').trim();
  return s.length > 0 ? s : null;
}

/**
 * Sanitize a system prompt — strip prompt-delimiter characters but preserve newlines
 * since they are intentional formatting in system prompts.
 *
 * @param {string} str
 * @returns {string}
 */
export function sanitizeSystemPrompt(str) {
  if (typeof str !== 'string') return '';
  // Only strip the dangerous delimiters, not newlines
  return str.replace(/<\/?system>|<\|/g, '').trim();
}

/**
 * Slugify a persona name to produce a stable Firestore document ID.
 * e.g. "Accessibility Expert" → "accessibility-expert"
 *
 * @param {string} name
 * @returns {string}
 */
export function slugifyName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64); // reasonable max length for a Firestore doc ID
}

/**
 * Validate and normalize a single custom persona definition.
 *
 * @param {object} raw - Raw persona object from config
 * @param {Set<string>} seenIds - IDs already validated (to catch duplicates within the array)
 * @returns {{ persona: object, errors: string[] }}
 */
export function validatePersona(raw, seenIds = new Set()) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { persona: null, errors: ['Persona must be an object'] };
  }

  // ── Name ───────────────────────────────────────────────────────────────
  if (!raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
    errors.push('Persona "name" is required and must be a non-empty string');
  } else {
    const trimmedName = raw.name.trim();
    if (RESERVED_NAMES.has(trimmedName)) {
      errors.push(`Persona name "${trimmedName}" is reserved — choose a different name`);
    }
  }

  // ── System prompt ───────────────────────────────────────────────────────
  if (!raw.systemPrompt || typeof raw.systemPrompt !== 'string' || !raw.systemPrompt.trim()) {
    errors.push('Persona "systemPrompt" is required and must be a non-empty string');
  }

  // ── Model ──────────────────────────────────────────────────────────────
  if (raw.model !== undefined) {
    if (!VALID_MODELS.has(raw.model)) {
      errors.push(
        `Persona model "${raw.model}" is not valid. Must be one of: ${[...VALID_MODELS].filter(m => !m.includes('20251001')).join(', ')}`
      );
    }
  }

  // ── intervalHours ──────────────────────────────────────────────────────
  // Minimum is 1 hour (daemon also enforces this floor independently via startPersonaLoop).
  if (raw.intervalHours !== undefined) {
    const h = Number(raw.intervalHours);
    if (!Number.isFinite(h) || h < 1) {
      errors.push(`Persona "intervalHours" must be a number >= 1 (got ${raw.intervalHours})`);
    }
  }

  // ── focusAreas ─────────────────────────────────────────────────────────
  if (raw.focusAreas !== undefined) {
    if (!Array.isArray(raw.focusAreas)) {
      errors.push('Persona "focusAreas" must be an array of strings');
    } else {
      for (const fa of raw.focusAreas) {
        if (typeof fa !== 'string') {
          errors.push('Each entry in "focusAreas" must be a string');
          break;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { persona: null, errors };
  }

  // ── Normalize ──────────────────────────────────────────────────────────
  const name = sanitizePromptValue(raw.name.trim());
  const id = raw.id || slugifyName(name);

  if (seenIds.has(id)) {
    return { persona: null, errors: [`Duplicate persona id "${id}" — names must be unique`] };
  }
  seenIds.add(id);

  const model = MODEL_ALIASES[raw.model] || raw.model || 'claude-sonnet-4-6';
  // Floor is 1 hour; daemon also enforces this independently.
  const intervalHours = Math.max(1, Number(raw.intervalHours) || 24);
  const systemPrompt = sanitizeSystemPrompt(raw.systemPrompt);
  const focusAreas = Array.isArray(raw.focusAreas)
    ? raw.focusAreas.map(fa => sanitizePromptValue(String(fa))).filter(Boolean)
    : [];

  return {
    persona: { id, name, systemPrompt, model, intervalHours, focusAreas },
    errors: [],
  };
}

/**
 * Load and validate the custom personas array from the advisor config.
 *
 * @param {object} advisorConfig - The "advisor" section of docket.config.json
 * @returns {{ personas: object[], warnings: string[] }}
 */
export function loadCustomPersonas(advisorConfig) {
  const rawPersonas = advisorConfig?.personas;

  if (!rawPersonas) {
    return { personas: [], warnings: [] };
  }

  if (!Array.isArray(rawPersonas)) {
    return {
      personas: [],
      warnings: ['"advisor.personas" must be an array — ignoring custom personas'],
    };
  }

  const personas = [];
  const warnings = [];
  const seenIds = new Set();

  for (let i = 0; i < rawPersonas.length; i++) {
    const { persona, errors } = validatePersona(rawPersonas[i], seenIds);
    if (errors.length > 0) {
      warnings.push(`Custom persona [${i}] skipped: ${errors.join('; ')}`);
    } else {
      personas.push(persona);
    }
  }

  return { personas, warnings };
}
