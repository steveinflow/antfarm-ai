// Shared prompt-building utilities for all advisor personas.
//
// This module provides a single injection point for shared context that applies
// to every persona (Engineer, Design, Product, QA, custom). Persona-specific
// prompt construction remains in each persona file.
//
// DK-302: Current Priorities injection.
// When a project has `advisorContext.priorities` set, it is injected as a
// clearly labeled block in the shared base prompt section, BEFORE any
// persona-specific instructions.
//
// DK-112: Topic Exclusion injection.
// When a persona has `topicExclusions` set (string[] in Firestore), they are
// injected as a single "Do not propose tickets related to: ..." line appended
// to the system prompt. One array join. No JS-side keyword matching — the model
// handles semantic interpretation.
//
// DK-133: Custom Instructions injection.
// Per-persona user-authored instructions are appended to the system prompt as a
// clearly delimited block AFTER the base prompt but BEFORE topic exclusions.
// Source: project.personaInstructions[personaId] ?? advisor[personaId].customInstructions ?? ""
// One level of fallback — no merge. Project instructions override global completely.
// The block is clearly labeled so logs distinguish user content from system content.
// Full prompt logging is gated behind a debug flag (do not log in production).
//
// Injection rules:
// - Only injected when priorities/exclusions are non-empty after trimming.
// - No injection, no block — absence of context produces no noise in the prompt.
// - No semantic sanitization — trim and strip null bytes only.

/**
 * Sanitize a priorities string before injection into a prompt.
 * Trims whitespace, strips null bytes, and enforces the 500-char limit.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} trimmed priorities string, or null if empty / invalid
 */
export function sanitizePriorities(raw) {
  if (typeof raw !== 'string') return null;
  // Strip null bytes
  const stripped = raw.replace(/\0/g, '');
  const trimmed = stripped.trim();
  if (!trimmed) return null;
  // Enforce hard cap at 500 characters (same as Firestore rule)
  return trimmed.slice(0, 500);
}

/**
 * Build the shared base prompt block for current team priorities.
 *
 * Returns a formatted string to prepend to the system prompt, or null if
 * priorities is empty or not set.
 *
 * @param {string|null|undefined} priorities - raw priorities string from Firestore
 * @returns {string|null}
 */
export function buildPrioritiesBlock(priorities) {
  const safe = sanitizePriorities(priorities);
  if (!safe) return null;
  return `Current team priorities: ${safe}`;
}

/**
 * Inject the current priorities block into a system prompt string.
 * The block is inserted BEFORE any persona-specific instructions,
 * at the very beginning of the prompt additions.
 *
 * @param {string} systemPrompt - base system prompt (already built)
 * @param {string|null|undefined} priorities - raw priorities from project doc
 * @returns {string} system prompt with priorities block prepended, or unchanged if no priorities
 */
export function injectPriorities(systemPrompt, priorities) {
  const block = buildPrioritiesBlock(priorities);
  if (!block) return systemPrompt;
  return `${block}\n\n${systemPrompt}`;
}

// ── DK-112: Topic Exclusion injection ──────────────────────────────────────

// Prompt-injection patterns to reject from topic exclusion rules.
// These strings must never appear in user-supplied exclusion rules because they
// could be used to manipulate the model's behavior.
const INJECTION_PATTERNS = [
  /\n/,                  // newlines — would break out of the single injected line
  /ignore/i,             // "ignore previous instructions" variant
  /system:/i,            // system: role prefix
  /assistant:/i,         // assistant: role prefix
  /\bprompt\b/i,         // prompt injection keyword
  /<\/?[a-z]+>/i,        // XML/HTML tags (could be used to inject structured content)
];

const MAX_EXCLUSION_CHARS = 100;
const MAX_EXCLUSIONS_PER_PERSONA = 25;

/**
 * Sanitize a single topic exclusion rule string.
 * Returns null if the string is empty, too long, or contains injection patterns.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} trimmed safe string, or null if invalid
 */
export function sanitizeTopicExclusion(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/\0/g, '');
  const trimmed = stripped.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_EXCLUSION_CHARS) return null;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) return null;
  }
  return trimmed;
}

/**
 * Sanitize an array of topic exclusion rules.
 * Filters out invalid entries. Caps at MAX_EXCLUSIONS_PER_PERSONA.
 *
 * @param {string[]|null|undefined} raw
 * @returns {string[]} array of safe, trimmed exclusion strings (may be empty)
 */
export function sanitizeTopicExclusions(raw) {
  if (!Array.isArray(raw)) return [];
  const safe = [];
  for (const item of raw) {
    const s = sanitizeTopicExclusion(item);
    if (s) safe.push(s);
    if (safe.length >= MAX_EXCLUSIONS_PER_PERSONA) break;
  }
  return safe;
}

/**
 * Build the topic exclusion block to append to the system prompt.
 * Returns null if there are no valid exclusions.
 *
 * @param {string[]|null|undefined} exclusions - raw exclusion strings from Firestore
 * @returns {string|null}
 */
export function buildTopicExclusionsBlock(exclusions) {
  const safe = sanitizeTopicExclusions(exclusions);
  if (safe.length === 0) return null;
  return `Do not propose tickets related to: ${safe.join(', ')}.`;
}

/**
 * Inject topic exclusion rules into a system prompt.
 * The block is appended at the very end of the prompt so that persona-specific
 * instructions and scope constraints take precedence in model interpretation.
 *
 * @param {string} systemPrompt - fully built system prompt
 * @param {string[]|null|undefined} exclusions - raw exclusion strings from Firestore
 * @returns {string} prompt with exclusion line appended, or unchanged if no exclusions
 */
export function injectTopicExclusions(systemPrompt, exclusions) {
  const block = buildTopicExclusionsBlock(exclusions);
  if (!block) return systemPrompt;
  return `${systemPrompt}\n\n${block}`;
}

// ── DK-133: Custom Instructions injection ──────────────────────────────────

const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4000;

/**
 * Sanitize a custom instructions string before injection into a prompt.
 * Strips null bytes. Enforces the 4000-char hard limit by truncating.
 * Does NOT strip meaningful content — instructions are user-authored prose.
 * Returns null if empty after trimming.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} sanitized string, or null if empty/invalid
 */
export function sanitizeCustomInstructions(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/\0/g, '');
  const trimmed = stripped.trim();
  if (!trimmed) return null;
  // Truncate gracefully if oversized content exists — don't crash
  return trimmed.slice(0, MAX_CUSTOM_INSTRUCTIONS_CHARS);
}

/**
 * Resolve the effective custom instructions for a persona run.
 * One level of fallback only — project overrides global, full stop. No merge.
 *
 * @param {string|null|undefined} projectInstructions - project-specific override
 * @param {string|null|undefined} globalInstructions - global default for this persona
 * @returns {string|null} sanitized instructions string, or null if none
 */
export function resolveCustomInstructions(projectInstructions, globalInstructions) {
  // Project instructions take priority. If set (non-empty after trim), use them exclusively.
  const project = sanitizeCustomInstructions(projectInstructions);
  if (project) return project;
  // Fall back to global
  return sanitizeCustomInstructions(globalInstructions);
}

/**
 * Inject custom instructions into a system prompt.
 * Appended AFTER the base prompt as a clearly delimited block — not prepended.
 * The delimiter makes it obvious in logs what came from the user vs. the system.
 *
 * Position in the build chain: after base prompt + priorities + scope, before
 * topic exclusions and rejection history. This matches the spec ordering.
 *
 * @param {string} systemPrompt - system prompt built so far
 * @param {string|null|undefined} customInstructions - resolved instructions (already sanitized)
 * @returns {string} prompt with instructions block appended, or unchanged if none
 */
export function injectCustomInstructions(systemPrompt, customInstructions) {
  const safe = sanitizeCustomInstructions(customInstructions);
  if (!safe) return systemPrompt;
  return `${systemPrompt}\n\n--- USER INSTRUCTIONS FOR THIS PERSONA ---\n${safe}\n--- END USER INSTRUCTIONS ---`;
}

// ── DK-320: Rejection History injection ────────────────────────────────────

/**
 * Inject formatted rejection history into the system prompt.
 * The block is placed after main persona instructions but before output format
 * instructions (i.e., just before topic exclusions in the build chain).
 *
 * The rejectionHistoryBlock must already be formatted by formatRejectionHistory()
 * from rejection-history.js. This function only handles injection position.
 *
 * @param {string} systemPrompt - fully built system prompt up to this point
 * @param {string|null} rejectionHistoryBlock - pre-formatted block, or null/empty string
 * @returns {string} prompt with rejection history injected, or unchanged if no rejections
 */
export function injectRejectionHistory(systemPrompt, rejectionHistoryBlock) {
  if (!rejectionHistoryBlock || !rejectionHistoryBlock.trim()) return systemPrompt;
  return `${systemPrompt}\n\n${rejectionHistoryBlock}`;
}

// ── DK-039: Per-persona focus directive injection ───────────────────────────

/**
 * Build the focus directive block to inject into a persona system prompt.
 *
 * The directive is wrapped in clearly delimited [FOCUS START] / [FOCUS END] markers
 * so the model can distinguish it from system instructions. The block is only injected
 * when the directive is a non-empty string after trimming.
 *
 * Security: the directive is a free-text user string, but is:
 *   - Sanitized by sanitizeDirective() in start-advisor.js (strips XML tags, collapses
 *     newlines, enforces 500-char cap) before being passed here.
 *   - Only ever injected as text content in an LLM prompt — never interpolated into
 *     shell commands, file globs, or system calls.
 *
 * @param {string|null|undefined} directive - pre-sanitized directive string from Firestore
 * @returns {string|null} formatted block, or null if empty / not set
 */
export function buildFocusDirectiveBlock(directive) {
  if (typeof directive !== 'string') return null;
  const trimmed = directive.trim();
  if (!trimmed) return null;
  return `The user has requested a focus for this cycle:\n[FOCUS START]\n${trimmed}\n[FOCUS END]\nApply this focus to your analysis.`;
}

/**
 * Inject the focus directive block into a system prompt.
 * Positioned after project-specific instructions and before focusPrompt/feedback modifiers.
 * Returns the prompt unchanged if no directive is set.
 *
 * @param {string} systemPrompt - fully built system prompt up to this point
 * @param {string|null|undefined} directive - pre-sanitized directive string from Firestore
 * @returns {string} prompt with directive block injected, or unchanged if no directive
 */
export function injectFocusDirective(systemPrompt, directive) {
  const block = buildFocusDirectiveBlock(directive);
  if (!block) return systemPrompt;
  return `${systemPrompt}\n\n${block}`;
}

// ── DK-134: Per-persona per-project scope block injection ───────────────────

const MAX_SCOPE_TOPIC_CHARS = 50;
const MAX_SCOPE_PATH_CHARS = 200;
const MAX_SCOPE_ITEMS = 25;

/**
 * Sanitize a single scope topic tag.
 * Max 50 chars. Strips null bytes and control characters. Rejects injection patterns.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function sanitizeScopeTopic(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!stripped) return null;
  if (stripped.length > MAX_SCOPE_TOPIC_CHARS) return null;
  // Reject injection patterns (same as topic exclusions)
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(stripped)) return null;
  }
  return stripped;
}

/**
 * Sanitize a single scope path glob.
 * Max 200 chars. Rejects absolute paths, traversal, and injection patterns.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function sanitizeScopePath(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!stripped) return null;
  if (stripped.length > MAX_SCOPE_PATH_CHARS) return null;
  // Reject absolute paths and traversal
  if (stripped.startsWith('/') || stripped.startsWith('..') || /^[A-Za-z]:[\\/]/.test(stripped)) return null;
  return stripped;
}

/**
 * Build the scope block to prepend to a persona prompt.
 * Injected when scope topics or path include patterns are non-empty.
 *
 * Format matches the ticket spec:
 *   "Focus your analysis on the following topics: <topics>."
 *   "Only examine files matching these patterns: <patterns>."
 *
 * @param {{ topics?: string[], include?: string[], exclude?: string[] }|null|undefined} scope
 * @returns {string|null} formatted block, or null if no scope set
 */
export function buildScopeBlock(scope) {
  if (!scope || typeof scope !== 'object') return null;

  const topics = Array.isArray(scope.topics)
    ? scope.topics.map(sanitizeScopeTopic).filter(Boolean).slice(0, MAX_SCOPE_ITEMS)
    : [];
  const include = Array.isArray(scope.include)
    ? scope.include.map(sanitizeScopePath).filter(Boolean).slice(0, MAX_SCOPE_ITEMS)
    : [];
  const exclude = Array.isArray(scope.exclude)
    ? scope.exclude.map(sanitizeScopePath).filter(Boolean).slice(0, MAX_SCOPE_ITEMS)
    : [];

  if (topics.length === 0 && include.length === 0 && exclude.length === 0) return null;

  const lines = [];
  if (topics.length > 0) {
    lines.push(`Focus your analysis on the following topics: ${topics.join(', ')}.`);
  }
  if (include.length > 0) {
    lines.push(`Only examine files matching these patterns: ${include.join(', ')}.`);
  }
  if (exclude.length > 0) {
    lines.push(`Exclude files matching these patterns: ${exclude.join(', ')}.`);
  }

  return lines.join('\n');
}

/**
 * Inject the scope block into a system prompt.
 * Positioned after priorities but before persona-specific instructions,
 * so that scope constraints are visible to the model early in the prompt.
 *
 * @param {string} systemPrompt - fully built system prompt up to this point
 * @param {{ topics?: string[], include?: string[], exclude?: string[] }|null|undefined} scope
 * @returns {string} prompt with scope block injected, or unchanged if no scope
 */
export function injectScopeBlock(systemPrompt, scope) {
  const block = buildScopeBlock(scope);
  if (!block) return systemPrompt;
  return `${systemPrompt}\n\n${block}`;
}
