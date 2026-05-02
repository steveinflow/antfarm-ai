// Prompt sanitizer — validates and sanitizes Firestore-sourced data
// before it is inserted into agent prompts.
//
// Security context: The agent runs with bypassPermissions: true in an
// isolated worktree. Prompt injection from Firestore ticket fields could
// cause the agent to execute arbitrary commands. All ticket-sourced data
// MUST pass through these functions before being included in prompts.
//
// Strategy:
//   - Structured fields (ids, types): strict allowlist/length/charset validation
//   - Free-text fields (description, notes): wrap in XML-style data delimiters
//     so the LLM clearly understands what is data vs. instructions; truncate
//     to a safe maximum length
//   - Array fields: sanitize each element individually
//   - Code/log blocks: ensure content cannot escape the enclosing fences

// ── Limits ────────────────────────────────────────────────────────────────────

const LIMITS = {
  ticketId: 32,
  title: 500,
  type: 50,
  projectId: 100,
  description: 20_000,
  noteItem: 2_000,    // single status-history note
  wipGoal: 1_000,
  wipPlanItem: 1_000,
  wipProgressItem: 1_000,
  wipDiscoveryItem: 1_000,
  wipRoadblockItem: 1_000,
  wipLastLogs: 10_000,
  wipSource: 200,
  screenshotUrl: 2_000,
  userAnswer: 10_000,
};

// ── Structured-field validators ───────────────────────────────────────────────

/**
 * Validate a ticket ID (e.g. "KB-005").
 * Allows letters, digits, and hyphens only.
 */
export function sanitizeTicketId(value) {
  if (typeof value !== 'string') return '[invalid-ticket-id]';
  const trimmed = value.trim().slice(0, LIMITS.ticketId);
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : '[invalid-ticket-id]';
}

/**
 * Validate a project ID.
 * Allows letters, digits, hyphens, and underscores only.
 */
export function sanitizeProjectId(value) {
  if (typeof value !== 'string') return '[invalid-project-id]';
  const trimmed = value.trim().slice(0, LIMITS.projectId);
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : '[invalid-project-id]';
}

/**
 * Validate a ticket type.
 * Allows only known safe values; falls back to 'general'.
 */
const VALID_TICKET_TYPES = new Set(['bug', 'feature', 'general', 'task', 'chore', 'docs']);

export function sanitizeTicketType(value) {
  if (typeof value !== 'string') return 'general';
  const lower = value.trim().toLowerCase().slice(0, LIMITS.type);
  return VALID_TICKET_TYPES.has(lower) ? lower : 'general';
}

/**
 * Sanitize a ticket title.
 * Strip control characters, enforce length limit.
 */
export function sanitizeTitle(value) {
  if (typeof value !== 'string') return '[no title]';
  return stripControlChars(value).slice(0, LIMITS.title).trim() || '[no title]';
}

// ── Free-text sanitizers ──────────────────────────────────────────────────────

/**
 * Sanitize a free-text description for use inside an XML-style data block.
 * The caller is responsible for wrapping the result in <data>…</data> tags.
 */
export function sanitizeDescription(value) {
  if (typeof value !== 'string') return '';
  return sanitizeFreeText(value, LIMITS.description);
}

/**
 * Sanitize a single status-history note entry.
 */
export function sanitizeNote(value) {
  if (typeof value !== 'string') return '';
  return sanitizeFreeText(value, LIMITS.noteItem);
}

/**
 * Sanitize a status-history "from" or "to" field.
 * Allows only alphanumeric + underscore/hyphen.
 */
export function sanitizeStatus(value) {
  if (typeof value !== 'string') return '?';
  const trimmed = value.trim().slice(0, 50);
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : '?';
}

/**
 * Sanitize user-provided answer text.
 */
export function sanitizeUserAnswer(value) {
  if (typeof value !== 'string') return '';
  return sanitizeFreeText(value, LIMITS.userAnswer);
}

/**
 * Sanitize a screenshot URL.
 * Only http/https URLs are allowed; others are replaced with a placeholder.
 * Base64 data URLs are handled separately via isBase64ImageDataUrl().
 */
export function sanitizeScreenshotUrl(value) {
  if (typeof value !== 'string') return '[invalid-url]';
  const trimmed = value.trim().slice(0, LIMITS.screenshotUrl);
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '[invalid-url]';
    }
    return trimmed;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Check if a value is a base64-encoded image data URL.
 * Allows image/* MIME types only (png, jpeg, gif, webp, svg+xml).
 * Returns false for non-image data URLs to prevent injection.
 */
export function isBase64ImageDataUrl(value) {
  if (typeof value !== 'string') return false;
  return /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/.test(value);
}

// ── WIP field sanitizers ──────────────────────────────────────────────────────

export function sanitizeWipGoal(value) {
  if (typeof value !== 'string') return '';
  return sanitizeFreeText(value, LIMITS.wipGoal);
}

export function sanitizeWipListItem(value) {
  if (typeof value !== 'string') return '';
  return sanitizeFreeText(value, LIMITS.wipProgressItem);
}

/**
 * Sanitize lastLogs for inclusion inside a fenced code block.
 * Prevents the content from escaping the ``` fence.
 */
export function sanitizeLastLogs(value) {
  if (typeof value !== 'string') return '';
  const truncated = value.slice(0, LIMITS.wipLastLogs);
  // Replace any sequence of backticks (3+) that would close the fence
  return truncated.replace(/`{3,}/g, '```̈').slice(0, LIMITS.wipLastLogs);
}

export function sanitizeWipSource(value) {
  if (typeof value !== 'string') return '';
  return sanitizeFreeText(value, LIMITS.wipSource);
}

// ── Delimiters ────────────────────────────────────────────────────────────────

/**
 * Wrap sanitized free-text in XML-style data delimiters.
 * This clearly separates data from instructions in the prompt so that
 * the LLM treats the content as data rather than directives.
 */
export function wrapInDataBlock(content, label = 'data') {
  return `<${label}>\n${content}\n</${label}>`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Remove ASCII control characters (except newline, carriage return, tab).
 */
function stripControlChars(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * General free-text sanitizer:
 *   1. Must be a string
 *   2. Strip control characters
 *   3. Truncate to maxLength
 *   4. Trim whitespace
 */
function sanitizeFreeText(value, maxLength) {
  return stripControlChars(value).slice(0, maxLength).trim();
}
