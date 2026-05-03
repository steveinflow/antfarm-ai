// Pure persona-related helpers used by AdvisorPanel views.
// Avatar element creation lives here (DOM construction from SVG strings).

import { CONTEXT_KNOWN_BAD, PERSONA_AVATARS } from '../config/personas.js';
import { PERSONA_CONCERNS, CONCERN_META } from '../config/concerns.js';
import { FILTER_REASON_LABELS } from '../config/labels.js';

/**
 * Return a quality label for the given advisorContext value.
 * Labels: 'minimal' | 'good' | 'specific'
 * Logic mirrors spec: < 50 → minimal, 50-100 → good, > 100 with varied vocab → specific.
 * Short but known-bad strings also resolve to 'minimal'.
 */
export function getContextQuality(value) {
  const trimmed = (value || '').trim();
  if (trimmed.length < 50 || CONTEXT_KNOWN_BAD.includes(trimmed)) return 'minimal';
  if (trimmed.length < 100) return 'good';
  return 'specific';
}

/** Slugify a name for use as a Firestore doc ID */
export function slugifyName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Strip dangerous prompt-delimiter characters from a string */
export function sanitizePromptValue(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<\/?system>|<\|/g, '').replace(/[\r\u2028\u2029]/g, ' ').trim();
}

export function filterReasonLabel(code) {
  return FILTER_REASON_LABELS[code] || code;
}

/** Derive a plain-language summary from a weights map + persona id. */
export function buildWeightSummary(weights, personaId) {
  const keys = PERSONA_CONCERNS[personaId];
  if (!keys) return '';
  const all1 = keys.every(k => (weights[k] ?? 1) === 1);
  if (all1) return 'All concerns are weighted equally — no emphasis applied.';
  const sorted = [...keys].sort((a, b) => (weights[b] ?? 1) - (weights[a] ?? 1));
  const labels = sorted.map(k => CONCERN_META[k]?.label || k);
  if (labels.length === 1) return `The persona will emphasise ${labels[0]}.`;
  const last = labels.pop();
  return `The ${personaId.charAt(0).toUpperCase() + personaId.slice(1)} persona will surface ${labels.join(', ')} findings before ${last}.`;
}

/** Count rejected items by reason type. */
export function rejectionCounts(rejected) {
  const counts = {};
  for (const item of rejected) {
    const r = item.reason || 'unknown';
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

/** Build a "why was this rejected?" tooltip text for an individual rejection. */
export function buildWhyText(item) {
  if (item.reason === 'duplicate') {
    return item.matchedTicketId
      ? `Matched existing ticket: ${item.matchedTicketId}`
      : 'Too similar to an existing open ticket';
  }
  if (item.reason === 'low_confidence') {
    return item.score != null
      ? `Confidence score: ${Math.round(item.score * 100)}%`
      : 'Did not meet the confidence threshold';
  }
  if (item.reason === 'threshold') {
    return 'Filtered by a rejection history rule';
  }
  return '';
}

/**
 * Build a simple 7-run trend summary from the last N runs.
 * Returns text like "7 runs: 12 created, 8 rejected" or null if insufficient data.
 */
export function buildRunTrendText(runs) {
  const recent = (runs || []).slice(0, 7);
  if (recent.length < 2) return null;
  let totalCreated = 0, totalRejected = 0;
  for (const r of recent) {
    totalCreated  += Array.isArray(r.created)  ? r.created.length  : (r.proposalsCreated || 0);
    totalRejected += Array.isArray(r.rejected) ? r.rejected.length : 0;
  }
  return `Last ${recent.length} runs: ${totalCreated} created, ${totalRejected} rejected`;
}

/** Build the avatar wrapper div for a persona, choosing idle vs. working SVG. */
export function createAvatarEl(personaId, status) {
  const avatarData = PERSONA_AVATARS[personaId];
  if (!avatarData) return null;
  const isWorking = status === 'running';
  const svgStr = isWorking ? avatarData.working : avatarData.idle;
  const wrapper = document.createElement('div');
  wrapper.className = 'adv-avatar' + (isWorking ? ' adv-avatar-working' : ' adv-avatar-idle');
  wrapper.innerHTML = svgStr;
  return wrapper;
}
