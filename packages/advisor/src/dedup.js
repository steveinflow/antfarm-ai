// Deduplication — prevents the advisor from filing the same ticket twice.
// Uses simple keyword overlap on titles of open/in-progress tickets and
// previously rejected proposals (rejection feedback loop).

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'be', 'as', 'it',
  'its', 'this', 'that', 'add', 'fix', 'update', 'improve', 'issue',
]);

function keywords(title) {
  return new Set(
    title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function overlap(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / Math.min(setA.size, setB.size);
}

/**
 * Count the number of shared keywords between two keyword sets.
 * Used when comparing against an integer dedupThreshold.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number}
 */
function countShared(setA, setB) {
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common;
}

/**
 * Build a comma-joined phrase of the shared keywords between two keyword sets.
 * Used for the run log `ticketsDeduped[].summary` field.
 * Returns an empty string if no shared keywords.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {string}
 */
function sharedKeywordsPhrase(setA, setB) {
  const shared = [];
  for (const w of setA) if (setB.has(w)) shared.push(w);
  return shared.join(', ');
}

/**
 * Validate and return a safe dedupThreshold value.
 * Accepts integers in [1, 10]. Falls back to 3 (Medium) if missing, out-of-range, or non-numeric.
 * Clamped before use — malformed Firestore values produce no surprises.
 *
 * Threshold mapping (UI labels → integers):
 *   Low    → 1  (only near-identical tickets filtered; ~1 keyword match)
 *   Medium → 3  (default — significant keyword overlap; ~3 keyword matches)
 *   High   → 5  (any topical overlap triggers filtering; ~5 keyword matches)
 *
 * The integer threshold is compared against the raw count of shared keywords
 * between the proposed title and each existing ticket title. If shared keyword
 * count >= threshold, the proposed ticket is considered a duplicate.
 *
 * @param {*} raw - Value from Firestore persona config (personaConfig?.dedupThreshold)
 * @returns {number} Validated integer in [1, 10]
 */
export function getValidatedDedupThreshold(raw) {
  const n = Number(raw);
  if (!isNaN(n) && isFinite(n) && n >= 1) {
    return Math.max(1, Math.min(10, Math.round(n) || 3));
  }
  return 3; // Medium default
}

/**
 * Check if a proposed ticket title is too similar to an existing open ticket.
 *
 * @param {Array<{ id?: string, title: string, status: string }>} existingTickets
 * @param {string} newTitle
 * @param {number} [threshold] - When >= 1: integer count of shared keywords required to flag as
 *   duplicate (configurable per-persona via Firestore). When < 1: ratio threshold (legacy, 0–1).
 *   Default 0.6 (ratio) for backward compatibility with callers that do not pass a threshold.
 * @returns {{ isDuplicate: boolean, matchTitle?: string, matchId?: string, matchedKeywords?: string }}
 */
export function checkDuplicate(existingTickets, newTitle, threshold = 0.6) {
  const newKw = keywords(newTitle);
  const now = new Date();
  const active = existingTickets.filter(t => {
    if (t.status !== 'open' && t.status !== 'in_progress' && t.status !== 'waiting_for_user') {
      return false;
    }
    // Exclude tickets that are currently snoozed — snoozed tickets should not block
    // new proposals during the snooze window. They resurface automatically when
    // snoozedUntil passes.
    if (t.snoozedUntil != null) {
      const snoozedUntilDate = new Date(t.snoozedUntil);
      if (!isNaN(snoozedUntilDate.getTime()) && snoozedUntilDate > now) {
        return false;
      }
    }
    return true;
  });

  // threshold >= 1: integer count of shared keywords (per-persona configurable dedup sensitivity).
  // threshold < 1: legacy ratio comparison (backward-compatible default).
  const useCountMode = threshold >= 1;

  for (const ticket of active) {
    const existingKw = keywords(ticket.title);
    const isMatch = useCountMode
      ? countShared(newKw, existingKw) >= threshold
      : overlap(newKw, existingKw) >= threshold;
    if (isMatch) {
      return {
        isDuplicate: true,
        matchTitle: ticket.title,
        matchId: ticket.id,
        // Comma-joined phrase of overlapping keywords — stored in ticketsDeduped[].summary
        matchedKeywords: sharedKeywordsPhrase(newKw, existingKw),
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * Check whether a new proposed ticket (from one persona) overlaps with existing
 * proposed tickets from *other* personas in the same project. This is the dedup
 * logic inverted — instead of "skip if overlaps," it returns overlap matches so
 * the caller can record convergence relationships bilaterally.
 *
 * Only matches against tickets whose `advisorPersona` differs from `newPersona`.
 * Uses the same keyword threshold as checkDuplicate for consistency.
 *
 * File-path overlap (from fileRefs) is checked when available and weighted more
 * heavily — a single shared file path is treated as the equivalent of 2 keyword
 * matches. Be conservative: only high-confidence matches are returned.
 *
 * @param {Array<{ id?: string, title: string, status: string, advisorPersona?: string, fileRefs?: Array<{path: string}> }>} existingTickets
 * @param {string} newTitle
 * @param {string} newPersona - persona creating the new ticket ('engineer'|'design'|'product')
 * @param {string[]} [newFilePaths] - file paths referenced by the new ticket
 * @param {number} [threshold] - shared keyword count threshold (same as dedupThreshold)
 * @returns {Array<{ matchId: string, matchTitle: string, matchPersona: string, matchedKeywords: string }>}
 */
export function checkConvergence(existingTickets, newTitle, newPersona, newFilePaths = [], threshold = 3) {
  const newKw = keywords(newTitle);
  const FILE_PATH_KEYWORD_WEIGHT = 2; // shared file path counts as this many keyword matches

  // Only look at proposed tickets from other personas
  const candidates = existingTickets.filter(t => {
    if (!t.id) return false;
    if (t.status !== 'proposed') return false;
    if (!t.advisorPersona || t.advisorPersona === newPersona) return false;
    return true;
  });

  const results = [];
  const newFileSet = new Set((newFilePaths || []).map(p => p.replace(/\\/g, '/')));

  for (const ticket of candidates) {
    const existingKw = keywords(ticket.title);
    let score = countShared(newKw, existingKw);

    // File-path overlap boost: each shared path adds FILE_PATH_KEYWORD_WEIGHT to score
    if (newFileSet.size > 0 && Array.isArray(ticket.fileRefs)) {
      for (const ref of ticket.fileRefs) {
        const normalizedPath = (ref.path || '').replace(/\\/g, '/');
        if (normalizedPath && newFileSet.has(normalizedPath)) {
          score += FILE_PATH_KEYWORD_WEIGHT;
        }
      }
    }

    if (score >= threshold) {
      results.push({
        matchId: ticket.id,
        matchTitle: ticket.title,
        matchPersona: ticket.advisorPersona,
        matchedKeywords: sharedKeywordsPhrase(newKw, existingKw),
      });
    }
  }

  return results;
}

/**
 * Check if a proposed ticket title is too similar to a previously rejected proposal.
 * Extends the keyword overlap algorithm to match against rejection ticketTitle fields.
 *
 * @param {Array<{ ticketTitle: string, reason: string }>} rejections - from listRejections()
 * @param {string} newTitle
 * @param {number} [threshold] - When >= 1: integer count of shared keywords (per-persona
 *   configurable). When < 1: ratio threshold (legacy, 0–1). Default 0.6 for backward compat.
 * @returns {{ isSuppressed: boolean, matchTitle?: string, matchCount?: number }}
 */
export function checkRejectionMatch(rejections, newTitle, threshold = 0.6) {
  if (!rejections || rejections.length === 0) return { isSuppressed: false };

  const newKw = keywords(newTitle);
  const useCountMode = threshold >= 1;
  let matchCount = 0;
  let firstMatchTitle = null;

  for (const rejection of rejections) {
    if (!rejection.ticketTitle) continue;
    const rejKw = keywords(rejection.ticketTitle);
    const isMatch = useCountMode
      ? countShared(newKw, rejKw) >= threshold
      : overlap(newKw, rejKw) >= threshold;
    if (isMatch) {
      matchCount++;
      if (!firstMatchTitle) firstMatchTitle = rejection.ticketTitle;
    }
  }

  if (matchCount > 0) {
    return { isSuppressed: true, matchTitle: firstMatchTitle, matchCount };
  }

  return { isSuppressed: false };
}
