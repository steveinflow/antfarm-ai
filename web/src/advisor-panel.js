// AdvisorPanel — left sidebar showing EPD Advisor persona status.
// Reads /advisor/{product,design,engineer} from Firestore in real-time.
// Writes pause/resume and intervalHours changes back.
// Shows a Context button in the header for editing the current project's advisorContext.
// History tab: queries advisorRuns collection per persona, last 20 runs.
// Performance dashboard: per-persona stats (generated/accepted/rejected/snoozed)
//   with 30/90-day filter and CSS sparkline. Inline expansion within each persona card.

import { showConfirmModal } from './confirm-modal.js';
import { createSaveOnBlur } from './save-on-blur.js';

const PERSONAS = [
  { id: 'product',  label: 'Product',  defaultHours: 24 },
  { id: 'design',   label: 'Design',   defaultHours: 6  },
  { id: 'engineer', label: 'Engineer', defaultHours: 12 },
  { id: 'qa',       label: 'QA',       defaultHours: 6  },
];

// Per-persona hint text shown below the interval input (spec requirement).
// Warns admins about resource-intensive personas.
const PERSONA_INTERVAL_HINTS = {
  product:  'Runs across all projects — daily or less is typical.',
  // DK-111: Design tooltip — note headless Chrome usage so users make informed throttling decisions.
  design:   'Uses headless Chrome to capture visual snapshots — heavier than other personas. Throttle generously.',
  engineer: 'Scans the codebase — 12h minimum recommended.',
  qa:       'Runs Playwright browser flows — 6h minimum recommended.',
};

// DK-039: Per-persona example placeholders for the focus directive input.
// Shown as placeholder text in the inline input to reduce blank-page paralysis.
const PERSONA_DIRECTIVE_PLACEHOLDERS = {
  engineer: 'e.g. only audit src/auth and src/payments',
  design:   'e.g. focus on mobile onboarding flow',
  product:  'e.g. ideas for reducing checkout drop-off',
  qa:       'e.g. test the checkout and payment flows',
};

// DK-039: One-liner descriptions shown below each persona header in the directive section.
// Helps users unfamiliar with persona distinctions understand what each one does.
const PERSONA_DIRECTIVE_DESCRIPTIONS = {
  engineer: 'Reviews your codebase for security vulnerabilities, performance issues, and code quality.',
  design:   'Captures screenshots of your app and audits the UI for usability and accessibility issues.',
  product:  'Generates feature ideas grounded in your project context and team priorities.',
  qa:       'Runs browser flows against your app to find broken functionality and regressions.',
};

// Reserved names that cannot be used for custom personas
const RESERVED_NAMES = new Set(['Engineer', 'Design', 'Product', 'QA']);

// Valid models for custom personas, labeled by behavior
const CUSTOM_PERSONA_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku — fast, low cost' },
  { value: 'claude-sonnet-4-6',         label: 'Sonnet — balanced' },
  { value: 'claude-opus-4-5',           label: 'Opus — thorough, slower' },
];

// Schedule presets — translate human-readable labels to/from intervalHours
// Ordered per spec: 1h, 6h, 12h, 24h, 48h plus a Custom option.
const SCHEDULE_PRESETS = [
  { label: 'Every 1 hour',   hours: 1   },
  { label: 'Every 6 hours',  hours: 6   },
  { label: 'Every 12 hours', hours: 12  },
  { label: 'Every 24 hours', hours: 24  },
  { label: 'Every 48 hours', hours: 48  },
  { label: 'Custom…',        hours: null },
];

// Starter template for new custom persona system prompts
const CUSTOM_PERSONA_STARTER = `You are a specialist reviewer focused on [your focus area].

Your responsibilities:
1. [Primary responsibility]
2. [Secondary responsibility]
3. [Additional concern]

Be specific and actionable. Only flag real issues — not theoretical edge cases.
Prioritize by impact: [high priority] > [medium priority] > [low priority].`;

// DK-120: Advisor context quality hints — example placeholder text shown in textarea.
// Two realistic project types joined with \n so users see variety.
const CONTEXT_EXAMPLES = [
  'B2B fintech SaaS for mid-market accounting teams. Core workflows: invoice approval, audit trails, multi-entity reporting.',
  'Consumer mobile app for habit tracking. Growth stage, iOS-first. Key metrics: D7 retention and streak completion rate.',
].join('\n');

// Known-bad short values treated as minimal regardless of length.
const CONTEXT_KNOWN_BAD = ['my app', 'todo app', 'test', ''];

/**
 * Return a quality label for the given advisorContext value.
 * Labels: 'minimal' | 'good' | 'specific'
 * Logic mirrors spec: < 50 → minimal, 50-100 → good, > 100 with varied vocab → specific.
 * Short but known-bad strings also resolve to 'minimal'.
 * @param {string} value
 * @returns {'minimal'|'good'|'specific'}
 */
function getContextQuality(value) {
  const trimmed = (value || '').trim();
  if (trimmed.length < 50 || CONTEXT_KNOWN_BAD.includes(trimmed)) return 'minimal';
  if (trimmed.length < 100) return 'good';
  return 'specific';
}

/** Slugify a name for use as a Firestore doc ID */
function slugifyName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Strip dangerous prompt-delimiter characters from a string */
function sanitizePromptValue(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<\/?system>|<\|/g, '').replace(/[\r\u2028\u2029]/g, ' ').trim();
}

// ── Error reason display mapping ────────────────────────────
const ERROR_REASON_LABELS = {
  rate_limit:        'Rate limit reached',
  api_unreachable:   'Could not reach Claude API',
  no_codebase_access:'No codebase path configured',
  timeout:           'Request timed out',
  api_error:         'API error',
};

// ── Filter reason display mapping (DK-189) ──────────────────
// Maps FILTER_REASONS enum codes (stored in ticketsFiltered.reasons) to
// plain-language labels. Falls back to the raw code for unknown values.
const FILTER_REASON_LABELS = {
  duplicate:       'Duplicate of existing ticket',
  rejection_match: 'Matches previously rejected proposal',
  low_confidence:  'Low confidence',
  rate_limit:      'Deferred by run cap',
  out_of_scope:    'Outside project scope',
  persona_mismatch:'Persona mismatch',
};

function filterReasonLabel(code) {
  return FILTER_REASON_LABELS[code] || code;
}

// ── DK-105: Persona concern weights ─────────────────────────────────────────
// Concern keys are hardcoded — user-supplied key names must never be sent to
// Firestore or reach the prompt (prompt injection vector).
// Values are integers 1–5. Default (all-1) = no injection into persona prompt.

/** Allowlisted concern keys per persona (must match weight-builder.js). */
const PERSONA_CONCERNS = {
  engineer: ['security', 'performance', 'maintainability'],
  design:   ['layout', 'copy', 'flow'],
  product:  ['user_value', 'feasibility', 'strategic_fit'],
};

/** Human-readable labels and inline descriptions for each concern key. */
const CONCERN_META = {
  security:       { label: 'Security',         desc: 'Vulnerabilities, auth flaws, data exposure' },
  performance:    { label: 'Performance',       desc: 'Speed, resource usage, scalability' },
  maintainability:{ label: 'Maintainability',   desc: 'Code clarity, tech debt, testability' },
  layout:         { label: 'Layout',            desc: 'Spacing, alignment, visual hierarchy' },
  copy:           { label: 'Copy',              desc: 'Labels, error messages, microcopy' },
  flow:           { label: 'Flow',              desc: 'Navigation, task completion, friction' },
  user_value:     { label: 'User Value',        desc: 'Impact on user goals and satisfaction' },
  feasibility:    { label: 'Feasibility',       desc: 'Technical complexity and effort' },
  strategic_fit:  { label: 'Strategic Fit',     desc: 'Alignment with product direction' },
};

/**
 * Preset profiles per persona — stored as weight maps applied to local state.
 * No separate Firestore document needed; presets are client-side only.
 */
const WEIGHT_PRESETS = {
  engineer: [
    { label: 'Security-first',    weights: { security: 5, performance: 2, maintainability: 2 } },
    { label: 'Balanced',          weights: { security: 1, performance: 1, maintainability: 1 } },
    { label: 'Velocity-focused',  weights: { security: 2, performance: 3, maintainability: 5 } },
  ],
  design: [
    { label: 'Polish-first',       weights: { layout: 5, copy: 3, flow: 2 } },
    { label: 'Balanced',           weights: { layout: 1, copy: 1, flow: 1 } },
    { label: 'Conversion-focused', weights: { layout: 2, copy: 4, flow: 5 } },
  ],
  product: [
    { label: 'User-first',        weights: { user_value: 5, feasibility: 2, strategic_fit: 2 } },
    { label: 'Balanced',          weights: { user_value: 1, feasibility: 1, strategic_fit: 1 } },
    { label: 'Strategy-focused',  weights: { user_value: 2, feasibility: 3, strategic_fit: 5 } },
  ],
};

/** Derive a plain-language summary from a weights map + persona id. */
function buildWeightSummary(weights, personaId) {
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

// ── Persona display name mapping ─────────────────────────────
// Maps personaId to human-readable persona name for the run log drawer.
const PERSONA_DISPLAY_NAMES = {
  engineer: 'Engineer',
  design:   'Design',
  product:  'Product',
  qa:       'QA',
};

// ── Rejection reason display mapping ────────────────────────
// Text labels (not color-only) per accessibility requirements.
const REJECTION_REASON_LABELS = {
  duplicate:      'duplicate',
  low_confidence: 'low confidence',
  threshold:      'threshold',
};

// Simple icons alongside text labels (not color-only per a11y spec)
const REJECTION_REASON_ICONS = {
  duplicate:      '⧉',
  low_confidence: '~',
  threshold:      '▽',
};

/**
 * Count rejected items by reason type.
 * @param {Array<{reason: string}>} rejected
 * @returns {object} { reason: count }
 */
function rejectionCounts(rejected) {
  const counts = {};
  for (const item of rejected) {
    const r = item.reason || 'unknown';
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

/**
 * Build a "why was this rejected?" tooltip text for an individual rejection.
 * @param {{reason: string, matchedTicketId?: string, score?: number}} item
 * @returns {string}
 */
function buildWhyText(item) {
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
 * @param {Array} runs - Array of run records (newest first)
 * @returns {string|null}
 */
function buildRunTrendText(runs) {
  const recent = (runs || []).slice(0, 7);
  if (recent.length < 2) return null;
  let totalCreated = 0, totalRejected = 0;
  for (const r of recent) {
    totalCreated  += Array.isArray(r.created)  ? r.created.length  : (r.proposalsCreated || 0);
    totalRejected += Array.isArray(r.rejected) ? r.rejected.length : 0;
  }
  return `Last ${recent.length} runs: ${totalCreated} created, ${totalRejected} rejected`;
}

// ── Persona avatar SVGs ───────────────────────────────────────
// Each persona has an idle and a working SVG representation.
// The working state shows them actively engaged (typing, drawing, reviewing code).

const PERSONA_AVATARS = {
  product: {
    idle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="PM idle">
      <!-- Head -->
      <circle cx="24" cy="14" r="8" fill="#7c5cbf" opacity="0.9"/>
      <!-- Hair -->
      <path d="M16 12 Q18 6 24 6 Q30 6 32 12" fill="#4a3580" opacity="0.9"/>
      <!-- Body / shirt -->
      <rect x="14" y="26" width="20" height="14" rx="4" fill="#4a4a6a" opacity="0.85"/>
      <!-- Collar / tie detail -->
      <path d="M21 26 L24 30 L27 26" fill="#9b59b6" opacity="0.9"/>
      <!-- Left arm (resting) -->
      <rect x="8" y="27" width="7" height="4" rx="2" fill="#7c5cbf" opacity="0.8" transform="rotate(-10 8 27)"/>
      <!-- Right arm (resting) -->
      <rect x="33" y="27" width="7" height="4" rx="2" fill="#7c5cbf" opacity="0.8" transform="rotate(10 40 27)"/>
      <!-- Clipboard / notepad (idle - held down) -->
      <rect x="19" y="34" width="10" height="7" rx="1.5" fill="#2a2a3a" stroke="#555" stroke-width="1" opacity="0.9"/>
      <line x1="21" y1="37" x2="27" y2="37" stroke="#777" stroke-width="1"/>
      <line x1="21" y1="39" x2="25" y2="39" stroke="#555" stroke-width="1"/>
    </svg>`,

    working: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="PM working">
      <!-- Head (tilted slightly — thinking) -->
      <circle cx="24" cy="13" r="8" fill="#9b6fde" opacity="0.95"/>
      <!-- Hair -->
      <path d="M16 11 Q18 5 24 5 Q30 5 32 11" fill="#5a3a90" opacity="0.9"/>
      <!-- Thought bubble -->
      <circle cx="33" cy="7" r="1.5" fill="#9b59b6" opacity="0.7"/>
      <circle cx="36" cy="5" r="2" fill="#9b59b6" opacity="0.6"/>
      <circle cx="39" cy="3" r="2.5" fill="#9b59b6" opacity="0.5"/>
      <!-- lightbulb in thought bubble -->
      <circle cx="39" cy="3" r="1.2" fill="#f1c40f" opacity="0.9"/>
      <!-- Body / shirt (leaning forward) -->
      <rect x="13" y="25" width="20" height="14" rx="4" fill="#5a3a7a" opacity="0.9"/>
      <!-- Collar / tie detail -->
      <path d="M21 25 L24 29 L27 25" fill="#b380e0" opacity="0.9"/>
      <!-- Left arm (raised — gesturing / writing) -->
      <rect x="7" y="24" width="8" height="4" rx="2" fill="#9b6fde" opacity="0.85" transform="rotate(-30 7 24)"/>
      <!-- Right arm (raised — pointing at board) -->
      <rect x="33" y="22" width="9" height="4" rx="2" fill="#9b6fde" opacity="0.85" transform="rotate(-20 33 22)"/>
      <!-- Whiteboard / strategy doc (held up) -->
      <rect x="32" y="12" width="12" height="10" rx="1.5" fill="#1a1a2a" stroke="#9b59b6" stroke-width="1.2" opacity="0.95"/>
      <line x1="34" y1="15" x2="42" y2="15" stroke="#9b59b6" stroke-width="1" opacity="0.9"/>
      <line x1="34" y1="17" x2="40" y2="17" stroke="#663399" stroke-width="1" opacity="0.8"/>
      <line x1="34" y1="19" x2="41" y2="19" stroke="#663399" stroke-width="1" opacity="0.8"/>
      <!-- Active glow ring -->
      <circle cx="24" cy="13" r="10" fill="none" stroke="#9b59b6" stroke-width="1" opacity="0.35" class="adv-avatar-glow"/>
    </svg>`,
  },

  design: {
    idle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="Designer idle">
      <!-- Head -->
      <circle cx="24" cy="14" r="8" fill="#3a8a9a" opacity="0.9"/>
      <!-- Stylish hair (bun/updo) -->
      <path d="M17 11 Q19 5 24 5 Q29 5 31 11" fill="#1e5a6a" opacity="0.9"/>
      <circle cx="24" cy="6" r="3" fill="#2a7080" opacity="0.8"/>
      <!-- Body / shirt -->
      <rect x="14" y="26" width="20" height="14" rx="4" fill="#2a5a6a" opacity="0.85"/>
      <!-- Design shirt detail — color swatch accent -->
      <rect x="17" y="29" width="4" height="4" rx="1" fill="#e74c3c" opacity="0.7"/>
      <rect x="22" y="29" width="4" height="4" rx="1" fill="#3498db" opacity="0.7"/>
      <rect x="27" y="29" width="4" height="4" rx="1" fill="#f1c40f" opacity="0.7"/>
      <!-- Left arm (resting) -->
      <rect x="8" y="27" width="7" height="4" rx="2" fill="#3a8a9a" opacity="0.8" transform="rotate(-10 8 27)"/>
      <!-- Right arm (resting) -->
      <rect x="33" y="27" width="7" height="4" rx="2" fill="#3a8a9a" opacity="0.8" transform="rotate(10 40 27)"/>
      <!-- Stylus / pen (held loosely at side) -->
      <rect x="34" y="30" width="2" height="9" rx="1" fill="#aaa" opacity="0.7" transform="rotate(15 35 34)"/>
    </svg>`,

    working: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="Designer working">
      <!-- Head (focused, looking down) -->
      <circle cx="24" cy="13" r="8" fill="#4aa8ba" opacity="0.95"/>
      <!-- Stylish hair -->
      <path d="M17 10 Q19 4 24 4 Q29 4 31 10" fill="#1e6a7a" opacity="0.9"/>
      <circle cx="24" cy="5" r="3" fill="#2a8090" opacity="0.8"/>
      <!-- Body / shirt (leaning forward toward design tablet) -->
      <rect x="13" y="25" width="20" height="14" rx="4" fill="#2a6a7a" opacity="0.9"/>
      <!-- Design shirt detail -->
      <rect x="16" y="28" width="3.5" height="3.5" rx="1" fill="#e74c3c" opacity="0.8"/>
      <rect x="21" y="28" width="3.5" height="3.5" rx="1" fill="#3498db" opacity="0.8"/>
      <rect x="26" y="28" width="3.5" height="3.5" rx="1" fill="#f1c40f" opacity="0.8"/>
      <!-- Left arm (drawing/sketching) -->
      <rect x="7" y="26" width="9" height="4" rx="2" fill="#4aa8ba" opacity="0.85" transform="rotate(-25 7 26)"/>
      <!-- Right arm (holding stylus, drawing) -->
      <rect x="32" y="26" width="9" height="4" rx="2" fill="#4aa8ba" opacity="0.85" transform="rotate(15 32 26)"/>
      <!-- Design tablet / canvas (active) -->
      <rect x="30" y="14" width="14" height="11" rx="2" fill="#1a1a1a" stroke="#3498db" stroke-width="1.2" opacity="0.95"/>
      <!-- Design lines on canvas (wireframe sketch) -->
      <rect x="31.5" y="15.5" width="4" height="3" rx="0.5" fill="none" stroke="#4aa8ba" stroke-width="0.8" opacity="0.9"/>
      <line x1="36.5" y1="17" x2="42" y2="17" stroke="#4aa8ba" stroke-width="0.8" opacity="0.7"/>
      <line x1="31.5" y1="20" x2="42" y2="20" stroke="#3498db" stroke-width="0.8" opacity="0.6"/>
      <line x1="31.5" y1="22" x2="38" y2="22" stroke="#3498db" stroke-width="0.8" opacity="0.6"/>
      <!-- Stylus actively drawing -->
      <rect x="30" y="22" width="2" height="8" rx="1" fill="#ddd" opacity="0.9" transform="rotate(-20 31 26)"/>
      <circle cx="29" cy="27" r="0.7" fill="#4aa8ba" opacity="0.9"/>
      <!-- Active glow ring -->
      <circle cx="24" cy="13" r="10" fill="none" stroke="#3498db" stroke-width="1" opacity="0.35" class="adv-avatar-glow"/>
    </svg>`,
  },

  engineer: {
    idle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="Engineer idle">
      <!-- Head -->
      <circle cx="24" cy="14" r="8" fill="#3a8a5a" opacity="0.9"/>
      <!-- Hair (short, practical) -->
      <path d="M16 12 Q17 6 24 6 Q31 6 32 12" fill="#1e5a36" opacity="0.9"/>
      <!-- Glasses (engineer detail) -->
      <circle cx="21" cy="14" r="3" fill="none" stroke="#aaa" stroke-width="1.2" opacity="0.7"/>
      <circle cx="27" cy="14" r="3" fill="none" stroke="#aaa" stroke-width="1.2" opacity="0.7"/>
      <line x1="24" y1="14" x2="24" y2="14.5" stroke="#aaa" stroke-width="1.2" opacity="0.7"/>
      <line x1="18" y1="14" x2="16.5" y2="13" stroke="#aaa" stroke-width="1.2" opacity="0.7"/>
      <line x1="30" y1="14" x2="31.5" y2="13" stroke="#aaa" stroke-width="1.2" opacity="0.7"/>
      <!-- Body / hoodie -->
      <rect x="14" y="26" width="20" height="14" rx="4" fill="#1e3a2e" opacity="0.85"/>
      <!-- Hoodie pocket detail -->
      <path d="M19 33 Q24 35 29 33" fill="none" stroke="#2a5a44" stroke-width="1.5" opacity="0.8"/>
      <!-- Left arm (resting) -->
      <rect x="8" y="27" width="7" height="4" rx="2" fill="#3a8a5a" opacity="0.8" transform="rotate(-10 8 27)"/>
      <!-- Right arm (resting, holding coffee cup) -->
      <rect x="33" y="27" width="7" height="4" rx="2" fill="#3a8a5a" opacity="0.8" transform="rotate(10 40 27)"/>
      <!-- Coffee mug -->
      <rect x="37" y="30" width="5" height="5" rx="1" fill="#2a2a2a" stroke="#555" stroke-width="0.8" opacity="0.9"/>
      <path d="M42 32 Q44 32 44 33.5 Q44 35 42 35" fill="none" stroke="#555" stroke-width="0.8" opacity="0.7"/>
      <line x1="38.5" y1="31.5" x2="40.5" y2="31.5" stroke="#4a9a6a" stroke-width="0.7" opacity="0.6"/>
    </svg>`,

    working: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="Engineer working">
      <!-- Head (leaning toward screen) -->
      <circle cx="23" cy="13" r="8" fill="#4aaa6a" opacity="0.95"/>
      <!-- Hair -->
      <path d="M15 11 Q16 5 23 5 Q30 5 31 11" fill="#1e6a40" opacity="0.9"/>
      <!-- Glasses (glowing from screen light) -->
      <circle cx="20" cy="13" r="3" fill="none" stroke="#aaa" stroke-width="1.2" opacity="0.8"/>
      <circle cx="26" cy="13" r="3" fill="none" stroke="#aaa" stroke-width="1.2" opacity="0.8"/>
      <line x1="23" y1="13" x2="23" y2="13.5" stroke="#aaa" stroke-width="1.2" opacity="0.8"/>
      <line x1="17" y1="13" x2="15.5" y2="12" stroke="#aaa" stroke-width="1.2" opacity="0.8"/>
      <line x1="29" y1="13" x2="30.5" y2="12" stroke="#aaa" stroke-width="1.2" opacity="0.8"/>
      <!-- Screen glow on glasses -->
      <circle cx="20" cy="13" r="2.5" fill="#27ae60" opacity="0.12"/>
      <circle cx="26" cy="13" r="2.5" fill="#27ae60" opacity="0.12"/>
      <!-- Body / hoodie (leaning forward) -->
      <rect x="13" y="25" width="20" height="14" rx="4" fill="#1e4a36" opacity="0.9"/>
      <!-- Hoodie pocket -->
      <path d="M18 32 Q23 34 28 32" fill="none" stroke="#2a6a4e" stroke-width="1.5" opacity="0.8"/>
      <!-- Left arm (typing) -->
      <rect x="6" y="28" width="9" height="4" rx="2" fill="#4aaa6a" opacity="0.85" transform="rotate(-15 6 28)"/>
      <!-- Right arm (typing) -->
      <rect x="33" y="28" width="9" height="4" rx="2" fill="#4aaa6a" opacity="0.85" transform="rotate(15 33 28)"/>
      <!-- Laptop / terminal screen -->
      <rect x="2" y="14" width="18" height="12" rx="1.5" fill="#0d0d0d" stroke="#27ae60" stroke-width="1.2" opacity="0.95"/>
      <!-- Code lines on screen -->
      <text x="3.5" y="19" font-family="monospace" font-size="3.5" fill="#27ae60" opacity="0.95">&gt;_ </text>
      <line x1="3" y1="21" x2="14" y2="21" stroke="#27ae60" stroke-width="0.8" opacity="0.7"/>
      <line x1="3" y1="23" x2="11" y2="23" stroke="#27ae60" stroke-width="0.8" opacity="0.5"/>
      <!-- Cursor blink indicator -->
      <rect x="15" y="21.5" width="1.5" height="2.5" fill="#27ae60" opacity="0.9" class="adv-avatar-cursor"/>
      <!-- Laptop base -->
      <rect x="1" y="26" width="20" height="1.5" rx="0.5" fill="#1a1a1a" stroke="#333" stroke-width="0.5" opacity="0.9"/>
      <!-- Active glow ring -->
      <circle cx="23" cy="13" r="10" fill="none" stroke="#27ae60" stroke-width="1" opacity="0.35" class="adv-avatar-glow"/>
    </svg>`,
  },
  qa: {
    idle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="QA idle">
      <!-- Head -->
      <circle cx="24" cy="14" r="8" fill="#c0392b" opacity="0.9"/>
      <!-- Hair (short) -->
      <path d="M16 12 Q17 6 24 6 Q31 6 32 12" fill="#7d2b20" opacity="0.9"/>
      <!-- Headset band -->
      <path d="M16 12 Q24 8 32 12" fill="none" stroke="#ddd" stroke-width="1.5" opacity="0.8"/>
      <circle cx="16" cy="14" r="2" fill="#aaa" opacity="0.8"/>
      <circle cx="32" cy="14" r="2" fill="#aaa" opacity="0.8"/>
      <!-- Body / shirt -->
      <rect x="14" y="26" width="20" height="14" rx="4" fill="#7d2b20" opacity="0.85"/>
      <!-- Bug icon on shirt -->
      <circle cx="24" cy="32" r="3" fill="#c0392b" stroke="#e74c3c" stroke-width="1" opacity="0.9"/>
      <line x1="22" y1="30" x2="20" y2="28" stroke="#e74c3c" stroke-width="1" opacity="0.7"/>
      <line x1="26" y1="30" x2="28" y2="28" stroke="#e74c3c" stroke-width="1" opacity="0.7"/>
      <!-- Left arm (resting) -->
      <rect x="8" y="27" width="7" height="4" rx="2" fill="#c0392b" opacity="0.8" transform="rotate(-10 8 27)"/>
      <!-- Right arm (resting, holding clipboard) -->
      <rect x="33" y="27" width="7" height="4" rx="2" fill="#c0392b" opacity="0.8" transform="rotate(10 40 27)"/>
      <!-- Clipboard -->
      <rect x="36" y="26" width="7" height="9" rx="1" fill="#2a2a3a" stroke="#555" stroke-width="0.8" opacity="0.9"/>
      <rect x="38" y="24.5" width="3" height="2" rx="0.5" fill="#888" opacity="0.8"/>
      <line x1="37.5" y1="29" x2="42" y2="29" stroke="#555" stroke-width="0.8" opacity="0.7"/>
      <line x1="37.5" y1="31" x2="41" y2="31" stroke="#555" stroke-width="0.8" opacity="0.7"/>
    </svg>`,

    working: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-label="QA working">
      <!-- Head (focused) -->
      <circle cx="24" cy="13" r="8" fill="#e74c3c" opacity="0.95"/>
      <!-- Hair -->
      <path d="M16 11 Q17 5 24 5 Q31 5 32 11" fill="#922b21" opacity="0.9"/>
      <!-- Headset band (active) -->
      <path d="M16 11 Q24 7 32 11" fill="none" stroke="#eee" stroke-width="1.5" opacity="0.9"/>
      <circle cx="16" cy="13" r="2.2" fill="#ccc" opacity="0.9"/>
      <circle cx="32" cy="13" r="2.2" fill="#ccc" opacity="0.9"/>
      <!-- Body / shirt -->
      <rect x="13" y="25" width="20" height="14" rx="4" fill="#922b21" opacity="0.9"/>
      <!-- Bug icon (glowing — found one!) -->
      <circle cx="24" cy="32" r="3" fill="#e74c3c" stroke="#ff7675" stroke-width="1.2" opacity="0.95"/>
      <line x1="22" y1="30" x2="19.5" y2="27.5" stroke="#ff7675" stroke-width="1.2" opacity="0.8"/>
      <line x1="26" y1="30" x2="28.5" y2="27.5" stroke="#ff7675" stroke-width="1.2" opacity="0.8"/>
      <!-- Left arm (typing) -->
      <rect x="6" y="28" width="9" height="4" rx="2" fill="#e74c3c" opacity="0.85" transform="rotate(-15 6 28)"/>
      <!-- Right arm (typing) -->
      <rect x="33" y="28" width="9" height="4" rx="2" fill="#e74c3c" opacity="0.85" transform="rotate(15 33 28)"/>
      <!-- Browser window (testing) -->
      <rect x="1" y="13" width="18" height="13" rx="1.5" fill="#0d0d0d" stroke="#e74c3c" stroke-width="1.2" opacity="0.95"/>
      <!-- Browser chrome -->
      <rect x="1" y="13" width="18" height="3" rx="1.5" fill="#1a1a1a" opacity="0.9"/>
      <circle cx="3.5" cy="14.5" r="0.8" fill="#e74c3c" opacity="0.8"/>
      <circle cx="5.5" cy="14.5" r="0.8" fill="#f39c12" opacity="0.8"/>
      <circle cx="7.5" cy="14.5" r="0.8" fill="#27ae60" opacity="0.8"/>
      <!-- Red X overlay (failing test) -->
      <line x1="5" y1="19" x2="13" y2="25" stroke="#e74c3c" stroke-width="1.5" opacity="0.8"/>
      <line x1="13" y1="19" x2="5" y2="25" stroke="#e74c3c" stroke-width="1.5" opacity="0.8"/>
      <!-- Active glow ring -->
      <circle cx="24" cy="13" r="10" fill="none" stroke="#e74c3c" stroke-width="1" opacity="0.35" class="adv-avatar-glow"/>
    </svg>`,
  },
};

// Default soul prompts — shown in the modal when no custom soul is set.
const DEFAULT_SOUL_PROMPTS = {
  product: `You are a senior product manager.
You think deeply about user needs, competitive positioning, and long-term product direction.
You prioritize simplicity, eliminate friction, and avoid feature bloat.
You have strong opinions about what makes software great: fast, predictable, gets out of the way.`,

  design: `You are a senior UX designer and visual design expert auditing a web application.

Your focus areas:
1. Visual aesthetics — inconsistent spacing, jarring colors, rough edges, unpolished elements
2. UX friction — unnecessary clicks, unclear labels, confusing flows, missing affordances
3. Usability — missing loading states, unhelpful error messages, poor empty states
4. Accessibility basics — contrast issues, missing focus styles, non-descriptive buttons
5. New controls or shortcuts that would meaningfully reduce friction for the user

Be specific about what you see. Reference visual elements by their position and appearance.
Only flag real, noticeable problems — not theoretical edge cases.`,

  engineer: `You are a senior security engineer and open source advocate reviewing code for a web application.

Your responsibilities:
1. Identify security vulnerabilities (OWASP Top 10, injection, auth issues, exposed secrets, etc.)
2. Flag anything that would be embarrassing or problematic in an open source codebase
   (hardcoded credentials, personal data in code, insecure defaults, debug backdoors)
3. Spot meaningful inefficiencies (N+1 queries, unbounded loops, memory leaks, blocking async patterns)
4. Note missing input validation at system boundaries

Be precise and actionable. Only flag real issues — not theoretical or minor stylistic concerns.
Prioritize: security > open-source safety > meaningful performance > minor quality.`,

  qa: `CRITICAL: You are running automated browser tests. You MUST ONLY interact with draft content. Never click publish, submit to live, or interact with any content visible to real users. If you are unsure whether an action is safe, skip it.

You are a QA engineer driving a headless browser through the application to find functional failures.

Your responsibilities:
1. Follow each test flow exactly as defined — click, fill, navigate, and observe
2. Identify broken flows: buttons that don't respond, forms that don't submit, pages that error
3. Note visual breakage: elements off-screen, overlapping, or not rendering
4. Catch console errors that indicate JavaScript failures
5. Flag unexpected redirects or states that don't match the expected outcome

For each issue found, file a bug ticket with:
- Exact steps to reproduce (starting from a fresh page load)
- What you expected to happen
- What actually happened (include any error messages verbatim)

Be factual and specific. Only file tickets for real, reproducible failures.`,
};

function createAvatarEl(personaId, status) {
  const avatarData = PERSONA_AVATARS[personaId];
  if (!avatarData) return null;
  const isWorking = status === 'running';
  const svgStr = isWorking ? avatarData.working : avatarData.idle;
  const wrapper = document.createElement('div');
  wrapper.className = 'adv-avatar' + (isWorking ? ' adv-avatar-working' : ' adv-avatar-idle');
  wrapper.innerHTML = svgStr;
  return wrapper;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') { node.className = v; }
      else if (k === 'htmlFor') { node.htmlFor = v; }
      else if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); }
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (Array.isArray(c)) c.forEach(ch => ch && node.appendChild(ch));
    else node.appendChild(c);
  }
  return node;
}

function formatCountdown(isoStr) {
  if (!isoStr) return null;
  const ms = new Date(isoStr).getTime() - Date.now();
  if (ms <= 0) return 'soon';
  const totalMins = Math.floor(ms / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRelative(isoStr) {
  if (!isoStr) return null;
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Format a UTC hour integer (0–23) as 12-hour local time label.
 * e.g., 9 → "9:00 AM", 18 → "6:00 PM"
 * @param {number} utcHour - integer 0–23 in UTC
 * @returns {string}
 */
function formatHour12(utcHour) {
  // Create a UTC date for today at that hour, then format in local time
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Build a summary line for the last run, per the DK-303 spec.
 * Format: "Last run 2h ago — 2 tickets created" or "Never run"
 * @param {string|object|null} lastRunAt - Firestore Timestamp or ISO string
 * @param {number|null} lastRunTicketCount - ticket count from last run
 * @returns {string}
 */
function formatLastRunLine(lastRunAt, lastRunTicketCount) {
  if (!lastRunAt) return 'Never run';
  const ago = formatRelativeTs(lastRunAt);
  const ticketPart = lastRunTicketCount != null
    ? ` — ${lastRunTicketCount} ticket${lastRunTicketCount === 1 ? '' : 's'} created`
    : '';
  return `Last run ${ago || 'recently'}${ticketPart}`;
}

/**
 * Compute the next scheduled run as a relative countdown string.
 * Per spec (DK-303): read nextRunAt directly from Firestore — orchestrator writes it.
 * Falls back to computing from lastRunAt + interval when nextRunAt is unavailable.
 * Returns strings like "in 3h 20m", "in 45m", "soon" (past due), or null if no data.
 * @param {string|object|null} nextRunAt - Firestore nextRunAt Timestamp or ISO string
 * @param {string|object|null} lastRunAt - Firestore Timestamp or ISO string (fallback)
 * @param {number|null} intervalHours - run interval in hours (ignored if intervalMinutes set)
 * @param {number|null} [intervalMinutes] - run interval in minutes (takes priority over intervalHours)
 * @returns {string|null}
 */
function computeNextRunCountdown(nextRunAt, lastRunAt, intervalHours, intervalMinutes) {
  // Prefer Firestore nextRunAt (written by orchestrator per DK-303 spec)
  const nextDate = toDate(nextRunAt);
  if (nextDate) {
    const remaining = nextDate.getTime() - Date.now();
    if (remaining <= 0) return 'soon';
    const totalMins = Math.floor(remaining / 60_000);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  }
  // Fallback: compute from lastRunAt + interval
  return _computeNextRunCountdownLegacy(lastRunAt, intervalHours, intervalMinutes);
}

/** Legacy countdown computation from lastRunAt + interval (fallback). */
function _computeNextRunCountdownLegacy(lastRunAt, intervalHours, intervalMinutes) {
  const intervalMs = (intervalMinutes != null && intervalMinutes > 0)
    ? intervalMinutes * 60_000
    : (intervalHours ? intervalHours * 3600_000 : null);
  if (!lastRunAt || !intervalMs) return null;
  const lastDate = toDate(lastRunAt);
  if (!lastDate) return null;
  const nextMs = lastDate.getTime() + intervalMs;
  const remaining = nextMs - Date.now();
  if (remaining <= 0) return 'soon';
  const totalMins = Math.floor(remaining / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

/** Convert a Firestore Timestamp or Date-like value to a JS Date. */
function toDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  // Firestore Timestamp (has .toDate())
  if (typeof val.toDate === 'function') return val.toDate();
  // ISO string or number
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a relative timestamp from a Firestore Timestamp or Date. */
function formatRelativeTs(val) {
  const d = toDate(val);
  if (!d) return null;
  return formatRelative(d.toISOString());
}

/** Format an absolute datetime for aria-label / title attributes. */
function formatAbsolute(val) {
  const d = toDate(val);
  if (!d) return '';
  return d.toLocaleString();
}

/** Format durationMs (already rounded to nearest second) as a human string. */
function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ── Performance dashboard helpers ────────────────────────────────────────────

/**
 * Compute a UTC ISO string for N days ago from now.
 * @param {number} days
 * @returns {string} ISO date string
 */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/**
 * Convert a Firestore Timestamp or ISO string to milliseconds since epoch.
 * Returns 0 when unresolvable.
 */
function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Determine the acceptance rate health category.
 * >50% → green, 20–50% → yellow, <20% → red.
 * @param {number} rate 0–1
 * @returns {'green'|'yellow'|'red'}
 */
function healthFromRate(rate) {
  if (rate > 0.5) return 'green';
  if (rate >= 0.2) return 'yellow';
  return 'red';
}

/**
 * Label + color for health category.
 */
const HEALTH_META = {
  green:  { label: 'Healthy',  cls: 'adv-perf-dot-green'  },
  yellow: { label: 'Fair',     cls: 'adv-perf-dot-yellow' },
  red:    { label: 'Low',      cls: 'adv-perf-dot-red'    },
};

/**
 * Statuses that count as "accepted" (user decided to act on this proposal).
 */
const ACCEPTED_STATUSES = new Set(['open', 'in_progress', 'blocked', 'waiting_for_user', 'in_maintenance', 'done', 'verified']);

/**
 * Statuses that count as "rejected" (user explicitly dismissed).
 * 'rejected' is the terminal status for triage-rejected proposals (DK-196).
 * 'wont_do' is the legacy path (admin decision, not triage feedback).
 */
const REJECTED_STATUSES = new Set(['wont_do', 'rejected']);

/**
 * Aggregate tickets into per-week acceptance rate buckets for the sparkline.
 * Returns an array of rate values (0–1) per week, oldest first.
 * Weeks with no tickets produce null (displayed as gap).
 *
 * @param {Array<{status: string, createdAt: *}>} tickets
 * @param {number} windowDays - 30 or 90
 * @returns {Array<number|null>}
 */
function computeSparkline(tickets, windowDays) {
  const numWeeks = Math.ceil(windowDays / 7);
  const buckets = Array.from({ length: numWeeks }, () => ({ accepted: 0, total: 0 }));
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  for (const t of tickets) {
    const ms = toMs(t.createdAt);
    if (!ms) continue;
    const age = now - ms;
    if (age < 0 || age > windowMs) continue;
    // Which week bucket? Week 0 = oldest
    const weekIdx = numWeeks - 1 - Math.floor(age / (7 * 24 * 60 * 60 * 1000));
    const idx = Math.max(0, Math.min(numWeeks - 1, weekIdx));
    buckets[idx].total++;
    if (ACCEPTED_STATUSES.has(t.status)) buckets[idx].accepted++;
  }

  return buckets.map(b => b.total === 0 ? null : b.accepted / b.total);
}

/**
 * Compute aggregate stats from a list of tickets.
 * @param {Array<{status: string}>} tickets
 * @returns {{ generated: number, accepted: number, rejected: number, snoozed: number, proposed: number }}
 */
function computeStats(tickets) {
  let accepted = 0, rejected = 0, snoozed = 0, proposed = 0;
  for (const t of tickets) {
    if (ACCEPTED_STATUSES.has(t.status)) accepted++;
    else if (REJECTED_STATUSES.has(t.status)) rejected++;
    else if (t.status === 'proposed') proposed++;
    // snoozed: not an explicit status in this system, but if ever added it would go here
  }
  return {
    generated: tickets.length,
    accepted,
    rejected,
    snoozed: 0, // placeholder — no snoozed status exists yet
    proposed,
  };
}

/**
 * Build an SVG sparkline from rate values.
 * Null values produce a gap (no bar).
 *
 * @param {Array<number|null>} rates - 0–1 values or null
 * @param {string} ariaLabel - accessible description
 * @returns {SVGElement}
 */
function buildSparklineSvg(rates, ariaLabel) {
  const W = 120, H = 28;
  const barW = Math.max(2, Math.floor((W - rates.length) / rates.length));
  const gap = 1;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-label', ariaLabel);
  svg.setAttribute('role', 'img');
  svg.setAttribute('class', 'adv-sparkline');

  // Baseline
  const baseline = document.createElementNS(svgNS, 'line');
  baseline.setAttribute('x1', '0');
  baseline.setAttribute('y1', String(H - 1));
  baseline.setAttribute('x2', String(W));
  baseline.setAttribute('y2', String(H - 1));
  baseline.setAttribute('class', 'adv-sparkline-baseline');
  svg.appendChild(baseline);

  rates.forEach((rate, i) => {
    if (rate === null) return; // gap for empty weeks
    const x = i * (barW + gap);
    const barH = Math.max(2, Math.round(rate * (H - 4)));
    const y = H - barH - 1;
    const color = rate > 0.5 ? 'adv-sparkline-bar-green'
      : rate >= 0.2 ? 'adv-sparkline-bar-yellow'
      : 'adv-sparkline-bar-red';
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(barH));
    rect.setAttribute('class', `adv-sparkline-bar ${color}`);
    svg.appendChild(rect);
  });

  return svg;
}

/**
 * Build an accessible description of a sparkline for screen readers.
 * @param {Array<number|null>} rates
 * @param {number} windowDays
 * @returns {string}
 */
function buildSparklineAriaLabel(rates, windowDays) {
  const validRates = rates.filter(r => r !== null);
  if (validRates.length === 0) return `Acceptance rate data unavailable over ${windowDays} days`;
  const first = Math.round((validRates[0] ?? 0) * 100);
  const last = Math.round((validRates[validRates.length - 1] ?? 0) * 100);
  const trend = last > first ? 'increased' : last < first ? 'decreased' : 'remained stable';
  return `Acceptance rate ${trend} from ${first}% to ${last}% over ${windowDays} days`;
}

/**
 * AdvisorPanel
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {object} opts.db - Firestore client instance
 */
export class AdvisorPanel {
  constructor({ container, db }) {
    this.container = container;
    this.db = db;

    this._mounted = false;
    this._root = null;
    this._unsubs = [];
    this._states = {}; // personaId -> Firestore data
    this._cards  = {}; // personaId -> { el, fields... }
    this._ticker = null;
    this._logExpanded = {}; // personaId -> boolean
    this._statesReceived = {}; // personaId -> boolean — true once we've received at least one snapshot

    // Projects data (still subscribed for context editing; section at bottom removed)
    this._projects = [];         // current project list (all from Firestore)
    this._filterProjectId = null; // null = show all, string = show only this project

    // YOLO mode toggle button (in panel header)
    this._yoloBtn = null;

    // Pause All button (in panel header) — pauses/resumes all built-in personas globally
    this._pauseAllBtn = null;

    // Context panel (top of panel, for current project's advisorContext)
    this._contextPanel = null;       // container element
    this._contextTextarea = null;    // textarea element
    this._contextActionBtn = null;   // edit/save button
    this._contextStatusEl = null;    // status text element
    this._contextPanelOpen = false;  // whether context panel is expanded

    // DK-302: Current Priorities field state
    // Per-project short-form priorities injected into all persona system prompts.
    // Stored at projects/{id}.advisorContext.priorities + .prioritiesUpdatedAt
    this._prioritiesTextarea = null;     // textarea element
    this._prioritiesCharCountEl = null;  // live character counter element
    this._prioritiesTimestampEl = null;  // relative "Updated X ago" element
    this._prioritiesSaveStatusEl = null; // ARIA live region for "Saved" confirmation
    this._prioritiesDebounceTimer = null; // debounce timer id
    this._prioritiesBannerEl = null;     // dismissible "Add priorities" banner element
    this._prioritiesBannerDismissed = false; // session-level dismiss state
    this._prioritiesPreviewEls = {};     // personaId -> one-line preview element in run results

    // Advisor context presets (DK-193) — named advisorContext configurations per project
    this._presets = [];                  // array of { id, name, advisorContext, createdAt, updatedAt }
    this._presetsUnsub = null;           // Firestore unsubscribe for presets listener
    this._presetsProjectId = null;       // project ID currently subscribed for presets
    this._presetSelectEl = null;         // <select> dropdown element
    this._presetSaveAsBtn = null;        // "Save as…" button element
    this._presetDriftEl = null;          // "edited" indicator + Revert link element
    this._presetDeleteBtn = null;        // delete-preset button element
    this._presetSaveModal = null;        // active "Save as preset" modal overlay
    this._presetDeleteModal = null;      // active delete-preset confirm modal overlay
    this._lastAppliedPresetId = null;    // ID of last applied preset (for drift detection)
    this._contextDirty = false;          // true when textarea differs from last applied preset
    this._contextCharCountEl = null;     // character count element beneath textarea
    this._contextQualityEl = null;       // quality indicator element (DK-120)
    this._contextFocused = false;        // true while textarea has focus (DK-120)
    this._contextModifiedThisSession = false; // true once user edits field this session (DK-120)

    // Persona instructions panel (DK-133) — tabbed editor for per-persona custom instructions
    this._personaInstrPanel = null;          // container element
    this._personaInstrOpen = {};             // personaId -> boolean (section expanded) — kept for compat
    this._personaInstrTextareas = {};        // personaId -> textarea element (project instructions)
    this._personaInstrGlobalTextareas = {};  // personaId -> textarea element (global instructions, read-only display)
    this._personaInstrSaveBtns = {};         // personaId -> save button element
    this._personaInstrStatusEls = {};        // personaId -> status element
    this._personaInstrLastSavedEls = {};     // personaId -> last-saved element
    this._personaInstrDirty = {};            // personaId -> boolean (unsaved changes)
    this._personaInstrSaveControls = {};     // (kept for compat, no longer used for new save flow)
    this._personaInstrActiveTab = 'engineer'; // currently selected tab
    this._personaInstrUseGlobal = {};        // personaId -> boolean (true = use global, not project override)
    this._personaInstrGlobalData = {};       // personaId -> string (global instructions from /advisor/{personaId})
    this._personaInstrLastFetched = {};      // personaId -> string (last Firestore value, for dirty detection)
    this._personaInstrGlobalUnsub = null;    // Firestore unsubscribe for /advisor/* listener
    this._personaInstrLiveRegion = null;     // aria-live region for save confirmations

    // Soul modal
    this._soulModal = null;      // modal overlay element (appended to document.body)
    this._soulModalPersonaId = null;

    // Focus prompt auto-save (DK-353)
    this._focusSaveControls = {};    // personaId -> save-on-blur control object

    // Persona config templates (DK-141)
    this._templates = [];              // array of { id, name, description, createdAt, lastUsedAt, config }
    this._templatesUnsub = null;       // Firestore unsubscribe for templates listener
    this._templatesSection = null;     // container element for the Templates section
    this._templatesSectionBody = null; // collapsible body element
    this._saveTemplateModal = null;    // active Save as template modal overlay
    this._templateWarnModal = null;    // active apply-template warning modal overlay

    // Test Rails modal (QA persona only)
    this._testRailsModal = null;

    // Per-card history (collapsed by default inside each persona card)
    this._historyPanels  = {};        // personaId -> panel container element
    this._historyRuns    = {};        // personaId -> array of run records (or null = not loaded)
    this._historyLoading = {};        // personaId -> boolean
    this._historyOpen    = {};        // personaId -> boolean (is the history section expanded?)
    this._historyUnsubs  = {};        // personaId -> unsubscribe fn for active query
    this._historyExpanded = {};       // runId -> boolean (expanded state of each row)

    // Custom personas
    this._customPersonas = [];       // array of custom persona definitions from Firestore
    this._customPersonasBody = null; // container element for custom persona cards
    this._customModal = null;        // active custom persona modal overlay
    this._liveRegion = null;         // ARIA live region for status announcements
    this._volumeWarningEl = null;    // volume warning element (updated on state changes)
    this._addPersonaBtn = null;      // "Add Persona" button (disabled when at cap)

    // Performance dashboard
    this._perfDashExpanded = {};     // personaId -> boolean (is the dashboard expanded?)
    this._perfDashData = {};         // personaId -> { tickets, fetchedAt } | null
    this._perfDashLoading = {};      // personaId -> boolean
    this._perfDashWindowDays = 30;   // current time window (30 or 90)
    this._perfDashContainers = {};   // personaId -> the collapsible dashboard container el

    // On-demand run timers — per-persona elapsed time intervals
    this._runTimers = {};            // personaId -> setInterval id

    // Current user (for trigger requestedBy field)
    this._currentUser = null;

    // Feedback signal state
    this._feedbackDetailExpanded = {};  // personaId -> boolean
    this._feedbackStats = {};           // personaId -> stats object | null
    this._feedbackStatsLoading = {};    // personaId -> boolean

    // DK-128: Exclusion list state
    // Engineer exclusions are glob patterns (string[]) stored at project.exclusions.engineer
    // Design exclusions are URL prefix patterns (string[]) stored at project.exclusions.design
    this._exclusionSaving = {};         // personaId -> boolean (save in progress)

    // DK-112: Topic exclusion rules state
    // Stored at project.advisor.topicExclusions.{engineer,design,product} as string[]
    // Injected into system prompt at runtime — admins only, prompt injection risk.
    this._topicExclSaving = {};         // personaId -> boolean (save in progress)

    // Collapsible cards — persisted in localStorage
    this._collapsedPersonas = this._loadCollapsedState(); // Set<personaId>

    // Collapsible top-level sidebar sections — persisted in localStorage
    this._collapsedSections = this._loadSectionCollapseState(); // Set<sectionId>

    // Collapsible per-card subsections (Activity, Performance) — persisted in localStorage
    this._collapsedCardSections = this._loadCardSectionCollapseState(); // Set<"personaId:sectionId">

    // Run log drawer (DK-189) — right-side drawer showing last 20 advisor runs
    this._runLogDrawer = null;         // drawer overlay element (appended to document.body)
    this._runLogDrawerOpen = false;    // current open/close state
    this._runLogRuns = null;           // array of run records | null (not yet loaded)
    this._runLogLoading = false;       // loading spinner state
    this._runLogExpanded = {};         // runId -> boolean (expanded accordion rows)
    this._runLogBtn = null;            // trigger button element (set in _buildUI)
    this._runLogTicketTitles = {};     // docId -> title (cache for ticket title lookup)
    // Pre-scrolled run ID from ticket attribution click (DK-189)
    this._runLogFocusRunId = null;     // runId to highlight/scroll to on open

    // DK-136: Trigger log drawer — shows advisorTriggerLog entries
    this._triggerLogDrawer = null;      // drawer overlay element (appended to document.body)
    this._triggerLogDrawerOpen = false; // current open/close state
    this._triggerLogEntries = null;     // array of log entries | null (not yet loaded)
    this._triggerLogLoading = false;    // loading spinner state
    this._triggerLogBtn = null;         // trigger button element (set in _buildUI)
    this._triggerLogFilter = null;      // persona filter: null = all, string = specific persona

    // Dry-run / Preview Run state
    this._dryRunPanels = {};           // personaId -> { panel, statusBar, proposalList, heading, promoteAllBtn, previewRunBtn }
    this._dryRunDocIds = {};           // personaId -> Firestore doc ID of in-flight dry run
    this._dryRunUnsubs = {};           // personaId -> unsubscribe function for doc listener
    this._dryRunProposals = {};        // personaId -> array of proposal objects from done run

    // Backlog deduplication (DK-366)
    this._backlogItems = [];           // array of { title: string } — parsed from PM paste input
    this._backlogSection = null;       // container element
    this._backlogTextarea = null;      // paste input textarea
    this._backlogItemCount = null;     // element showing "N items loaded"
    this._suppressDuplicates = false;  // per-session suppression toggle
    this._suppressedCount = 0;         // count of ideas suppressed this session
    this._suppressCountEl = null;      // element showing suppressed count
    this._rejectionLog = this._loadRejectionLog(); // per-session rejection log entries
    this._rejectionLogSection = null;  // container for rejection log UI
    this._rejectionLogBody = null;     // scrollable body of rejection log
    this._rejectionLogList = null;     // list element inside rejection log body
    this._rejectionLogSearch = '';     // current search filter string

    // DK-105: Persona emphasis weights state
    // Per-persona draft weights (before save). Keyed by personaId.
    // Populated from project.weights.<personaId> on project focus; all-1 defaults otherwise.
    this._weightsDraft = {};           // personaId -> { concernKey: int }
    this._weightsSaving = {};          // personaId -> boolean (save in progress)
    this._weightsSummaryEls = {};      // personaId -> span element showing plain-language summary
    this._weightsInputs = {};          // personaId -> { concernKey: <input type=number> }
    this._weightsSaveEls = {};         // personaId -> { btn, statusEl }

    // DK-101: Per-persona focus areas state
    // Stores references to UI elements built in _buildPersonaCard.
    // Populated at card-build time; updated when project data changes.
    this._focusAreasState = {};        // personaId -> { sectionEl, bodyEl, toggleEl, summaryChipEl, chipData, inputs }
    this._focusAreasSaving = {};       // personaId -> boolean (save in progress)

    // DK-365: Persona constraint state
    this._constraintModal = null;      // modal overlay element (appended to document.body)
    this._constraintModalPersonaId = null;
    this._constraintDraft = {};        // personaId -> { budget_range, platform_target, audience_segment, complexity_cap, risk_tolerance }
    this._constraintChipEls = {};      // personaId -> chip element in card header

    // DK-319: Per-persona per-project focus directive state
    // Directives are stored at advisor/{personaId}/projects/{projectId} in Firestore.
    // The UI shows inline below the persona name: Freeform (empty) or Focused (set).
    this._directiveUnsubs = {};        // personaId -> unsubscribe fn for directive listener
    this._directiveData = {};          // personaId -> { directive, directiveUpdatedAt } | null
    this._directiveSaving = {};        // personaId -> boolean (save in progress)
    this._directiveEditing = {};       // personaId -> boolean (inline input visible)
    this._directiveEls = {};           // personaId -> { sectionEl, badgeEl, inputEl, labelEl, timestampEl, stalenessEl, clearBtn, nextRunEl, counterEl, editRow, displayRow }

    // DK-187: Persona focus constraints state
    // Stores references to UI elements built in _buildPersonaCard.
    // Data is read from /advisor/{personaId}.focus and written back on save.
    this._focusConstraintsState = {};  // personaId -> { sectionEl, bodyEl, toggleEl, summaryChipEl, chipListEl, inputEl, saveBtn, saveStatusEl, clearBtn, dirty }
    this._focusConstraintsSaving = {}; // personaId -> boolean (save in progress)

    // DK-118: Per-project persona enable/disable toggles
    // Stored at projects/{projectId}.advisor.personas.{engineer,design,product} in Firestore.
    // Absent keys default to true (enabled). Writes are debounced 500ms.
    this._personaTogglesPanel = null;    // container element
    this._personaTogglesLegend = null;   // <legend> element for fieldset grouping
    this._personaToggleEls = {};         // personaId -> { checkbox, statusEl, undoEl }
    this._personaTogglesOnOffEls = {};   // personaId -> <span> showing On/Off text
    this._personaToggleSaving = {};      // personaId -> boolean (save in progress)
    this._personaToggleDebounce = {};    // personaId -> setTimeout id
    this._edpIndicatorEl = null;         // EDP indicator element in the panel header

    // DK-134: Per-persona per-project scope config (include/exclude path chips + topic tag chips).
    // New schema stored at advisor.projects.<projectId>.<personaId>.scope.{include,exclude,topics}.
    // Backward compat: also reads old DK-301 focusAreas.{topics,paths} strings.
    // UI: gear icon on persona label → inline config drawer with chip inputs.
    this._scopedFocusState = {};       // personaId -> { drawerEl, dotEl, gearBtn, topicsChipListEl, topicsInputEl, includeChipListEl, includeInputEl, excludeChipListEl, excludeInputEl, saveStatusEl, fileCountBadgeEl, noFilesWarningEl, clearLinkEl, drawerOpen }
    this._scopedFocusSaving = {};      // personaId -> boolean
    this._scopedFocusChips = {};       // personaId -> { topics: string[], include: string[], exclude: string[] }
    this._scopeSummaryBar = null;      // scope summary bar element (DK-134)

    // DK-124: Per-persona per-project advisor pins.
    // Engineer: file glob pins (stored at project.advisorPins.engineer[]).
    // Design: URL path pins (stored at project.advisorPins.design[]).
    // Product: no pins (not applicable).
    // UI: collapsible "Focus areas" row inside the advisor config section.
    this._pinsState = {};              // personaId -> { sectionEl, bodyEl, toggleEl, summaryChipEl, chipListEl, inputEl, saveBtn, saveStatusEl, stalenessEl }
    this._pinsSaving = {};             // personaId -> boolean (save in progress)
    this._pinsDraft = {};              // personaId -> string[] (current edited state before save)

    // DK-188: Confidence threshold state.
    // Global threshold stored at /advisor/config.minConfidence in Firestore.
    // UI: labeled radio group (Low/Medium/High/Strict) with discard log below.
    this._minConfidence = 5;           // current threshold (1–10), loaded from Firestore
    this._confidenceUnsub = null;      // Firestore listener
    this._confidenceRadioEls = {};     // { value: <input type=radio> }
    this._confidenceStatusEl = null;   // status message element
    this._discardsSection = null;      // discard log container
    this._discardsBody = null;         // discard list element
    this._discardsSaving = false;      // true while saving threshold

    // DK-194: Cross-persona consensus gate state.
    // Stored at /advisor/consensusGate in Firestore. Same pattern as the pause toggle.
    // UI: toggle + threshold selector in the AdvisorPanel (workspace-level setting).
    this._consensusGate = null;          // current Firestore doc data | null
    this._consensusGatePanel = null;     // container element
    this._consensusGateToggle = null;    // <input type="checkbox"> element
    this._consensusGateThreshold = null; // <input type="number"> element
    this._consensusGateStatus = null;    // status/error message element
    this._consensusGateSaving = false;   // save in progress
  }

  /**
   * Set the current user for trigger attribution.
   * @param {object|null} user - Firebase Auth user object
   */
  setCurrentUser(user) {
    this._currentUser = user;
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;

    this._root = el('div', { className: 'adv-panel' });
    this.container.appendChild(this._root);

    this._buildUI();
    this._startListeners();

    // Refresh countdowns every 30s
    this._ticker = setInterval(() => {
      if (this._mounted) this._refreshCountdowns();
    }, 30_000);
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;

    for (const u of this._unsubs) u();
    this._unsubs = [];

    // Clean up any active history listeners
    for (const unsub of Object.values(this._historyUnsubs)) {
      if (typeof unsub === 'function') unsub();
    }
    this._historyUnsubs = {};

    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }

    // Stop all per-card run timers
    if (this._runTimers) {
      for (const id of Object.keys(this._runTimers)) this._stopRunTimer(id);
      this._runTimers = {};
    }

    // Cancel any active dry-run subscriptions
    for (const id of Object.keys(this._dryRunUnsubs || {})) {
      this._cancelDryRunSubscription(id);
    }
    this._dryRunUnsubs = {};
    this._dryRunDocIds = {};

    // DK-118: Cancel any pending persona toggle debounce timers
    for (const id of Object.keys(this._personaToggleDebounce || {})) {
      if (this._personaToggleDebounce[id]) {
        clearTimeout(this._personaToggleDebounce[id]);
      }
    }
    this._personaToggleDebounce = {};
    // Cancel undo timers
    for (const refs of Object.values(this._personaToggleEls || {})) {
      if (refs?._undoTimer) clearTimeout(refs._undoTimer);
    }

    if (this._root?.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;

    this._statesReceived = {};
    this._closeSoulModal();
    this._closeConstraintModal();
    this._closeCustomModal();
    this._closeSaveTemplateModal();
    this._closeTemplateWarnModal();

    // Unsubscribe templates listener
    if (this._templatesUnsub) { this._templatesUnsub(); this._templatesUnsub = null; }

    // Unsubscribe presets listener (DK-193)
    if (this._presetsUnsub) { this._presetsUnsub(); this._presetsUnsub = null; }

    // DK-133: Unsubscribe global persona instructions listener
    if (this._personaInstrGlobalUnsub) { this._personaInstrGlobalUnsub(); this._personaInstrGlobalUnsub = null; }

    // Clear last-saved interval timers in instruction panels
    for (const id of ['engineer', 'design', 'product']) {
      const lastSavedEl = this._personaInstrLastSavedEls?.[id];
      if (lastSavedEl?._interval) { clearInterval(lastSavedEl._interval); lastSavedEl._interval = null; }
    }

    // Close any open preset modals
    this._closeSavePresetModal();
    this._closeDeletePresetModal();
  }

  // ── Collapse state ──────────────────────────────────────────

  _loadCollapsedState() {
    try {
      const raw = localStorage.getItem('adv-collapsed-personas');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: collapse all built-in persona card bodies on first visit.
    // Users can expand individual cards they need to configure.
    return new Set(PERSONAS.map(p => p.id));
  }

  _saveCollapsedState() {
    try {
      localStorage.setItem('adv-collapsed-personas', JSON.stringify([...this._collapsedPersonas]));
    } catch (_) { /* ignore */ }
  }

  // ── Section collapse state (top-level sidebar sections) ─────

  _loadSectionCollapseState() {
    try {
      const raw = localStorage.getItem('adv-collapsed-sections');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: 'personas' section is expanded; 'custom' section starts collapsed.
    return new Set(['custom']);
  }

  _saveSectionCollapseState() {
    try {
      localStorage.setItem('adv-collapsed-sections', JSON.stringify([...this._collapsedSections]));
    } catch (_) { /* ignore */ }
  }

  _toggleSectionCollapse(sectionId, bodyEl, chevronEl, headerEl) {
    const isCollapsed = this._collapsedSections.has(sectionId);
    if (isCollapsed) {
      this._collapsedSections.delete(sectionId);
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'true');
    } else {
      this._collapsedSections.add(sectionId);
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'false');
    }
    this._saveSectionCollapseState();
  }

  // ── Per-card subsection collapse state (Activity, Performance) ──

  // Per-card subsection collapse state uses an INVERTED set:
  // _collapsedCardSections stores keys that are EXPLICITLY EXPANDED.
  // A key absent from the set = collapsed (default for Activity & Performance).
  // This means new subsections (including custom persona subsections) start
  // collapsed by default without needing to pre-populate the set.
  _loadCardSectionCollapseState() {
    try {
      const raw = localStorage.getItem('adv-expanded-card-sections');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: empty set = all subsections collapsed (Activity & Performance start hidden)
    return new Set();
  }

  _saveCardSectionCollapseState() {
    try {
      localStorage.setItem('adv-expanded-card-sections', JSON.stringify([...this._collapsedCardSections]));
    } catch (_) { /* ignore */ }
  }

  // key is in the set = explicitly expanded; absent = collapsed.
  _toggleCardSection(key, bodyEl, chevronEl, headerEl) {
    const isExpanded = this._collapsedCardSections.has(key);
    if (isExpanded) {
      // Collapse it
      this._collapsedCardSections.delete(key);
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'false');
    } else {
      // Expand it
      this._collapsedCardSections.add(key);
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'true');
    }
    this._saveCardSectionCollapseState();
  }

  _toggleCardCollapse(id) {
    const card = this._cards[id];
    if (!card || !card.cardBody) return;
    const isCollapsed = this._collapsedPersonas.has(id);
    if (isCollapsed) {
      this._collapsedPersonas.delete(id);
      card.cardBody.classList.remove('adv-hidden');
      card.card.classList.remove('adv-card-collapsed');
      card.collapseBtn.textContent = '▾';
      card.collapseBtn.title = 'Collapse';
      card.collapseBtn.setAttribute('aria-expanded', 'true');
    } else {
      this._collapsedPersonas.add(id);
      card.cardBody.classList.add('adv-hidden');
      card.card.classList.add('adv-card-collapsed');
      card.collapseBtn.textContent = '▸';
      card.collapseBtn.title = 'Expand';
      card.collapseBtn.setAttribute('aria-expanded', 'false');
    }
    this._saveCollapsedState();
  }

  // ── UI construction ──────────────────────────────────────────

  _buildUI() {
    // ARIA live region — announces status changes to screen readers
    this._liveRegion = el('div', {
      'aria-live': 'polite',
      'aria-atomic': 'true',
      className: 'adv-live-region',
    });
    this._root.appendChild(this._liveRegion);

    // Header
    const contextBtn = el('button', {
      className: 'adv-context-btn',
      title: 'Edit project context',
      style: 'display:none', // hidden until a project is selected
      onClick: () => this._toggleContextPanel(),
    }, 'Context');
    this._contextBtn = contextBtn;

    const yoloBtn = el('button', {
      className: 'adv-yolo-btn',
      title: 'Auto-Accept mode: new advisor tickets skip review and go straight to the backlog',
      style: 'display:none', // hidden until a project is selected
      onClick: () => this._toggleYoloMode(),
    }, 'Auto-Accept');
    this._yoloBtn = yoloBtn;

    // Run log button — opens the right-side drawer (DK-189)
    const runLogBtn = el('button', {
      className: 'adv-run-log-btn',
      title: 'View recent advisor run log',
      'aria-label': 'Open advisor run log',
      onClick: () => this._openRunLogDrawer(),
    }, 'Run log');
    this._runLogBtn = runLogBtn;

    // DK-136: Trigger log button — opens the trigger log drawer
    const triggerLogBtn = el('button', {
      className: 'adv-trigger-log-btn',
      title: 'View event trigger history (webhook, ticket-close, manual)',
      'aria-label': 'Open trigger log',
      onClick: () => this._openTriggerLogDrawer(),
    }, 'Trigger log');
    this._triggerLogBtn = triggerLogBtn;

    // Pause All button — pauses or resumes all built-in personas globally
    const pauseAllBtn = el('button', {
      className: 'adv-pause-all-btn',
      title: 'Pause all advisors',
      'aria-label': 'Pause all advisors',
      onClick: () => this._pauseAllAdvisors(),
    }, 'Pause All');
    this._pauseAllBtn = pauseAllBtn;

    // Status legend help button — explains the outlined-ring dot style used for advisor activity
    const legendBtn = el('button', {
      className: 'status-legend-btn',
      title: 'Status dot legend',
      'aria-label': 'Status dot legend',
      'data-legend': '○  Advisor: outlined ring = advisor activity\n●  Workers: solid dot = ticket/worker state',
    }, '?');

    // DK-118: EDP indicator — shows which personas are enabled for the current project
    const edpIndicator = el('div', {
      className: 'adv-edp-indicator',
      style: 'display:none', // hidden until a project is selected
      'aria-label': 'Personas active for current project',
      title: 'E=Engineer, D=Design, P=Product — strikethrough = disabled',
    });
    this._edpIndicatorEl = edpIndicator;

    this._root.appendChild(
      el('div', { className: 'adv-header' },
        el('div', { className: 'adv-header-left' },
          el('span', { className: 'adv-title' }, 'Advisors'),
          legendBtn,
          edpIndicator,
        ),
        el('div', { className: 'adv-header-right' },
          pauseAllBtn,
          runLogBtn,
          triggerLogBtn,
          yoloBtn,
          contextBtn,
        ),
      )
    );

    // Context panel — inline editor for current project's advisorContext
    this._root.appendChild(this._buildContextPanel());

    // DK-118: Per-project persona enable/disable toggles panel
    this._root.appendChild(this._buildPersonaTogglesPanel());

    // DK-194: Cross-persona consensus gate panel (workspace-level setting)
    this._root.appendChild(this._buildConsensusGatePanel());

    // Persona instructions panel — per-project additional instructions for each persona
    this._root.appendChild(this._buildPersonaInstructionsPanel());

    // DK-302: Dismissible banner shown when priorities is empty and an advisor has run recently.
    // One banner per panel — not per persona card. Shown above the first persona card.
    const prioritiesBannerEl = el('div', {
      className: 'adv-priorities-banner',
      role: 'alert',
      style: 'display:none',
    },
      el('span', { className: 'adv-priorities-banner-text' },
        'Suggestions may be off-target. ',
        el('button', {
          className: 'adv-priorities-banner-link',
          onClick: () => {
            // Open the context panel so the user can set priorities
            if (!this._contextPanelOpen) this._toggleContextPanel();
            if (this._prioritiesTextarea) setTimeout(() => this._prioritiesTextarea.focus(), 120);
          },
        }, 'Add current priorities in project settings.')
      ),
      el('button', {
        className: 'adv-priorities-banner-dismiss',
        'aria-label': 'Dismiss this suggestion',
        onClick: (e) => {
          e.stopPropagation();
          this._prioritiesBannerDismissed = true;
          this._updatePrioritiesBanner(false);
        },
      }, '✕')
    );
    this._prioritiesBannerEl = prioritiesBannerEl;
    this._root.appendChild(prioritiesBannerEl);

    // DK-134: Scope summary bar — one-line scope summary per persona.
    // Hidden when all personas are using full codebase (no scope set).
    // Shows e.g. "Engineer: src/auth/**, +security | Design: entire codebase"
    this._scopeSummaryBar = el('div', {
      className: 'adv-scope-summary-bar adv-hidden',
      'aria-label': 'Persona scope summary',
    });
    this._root.appendChild(this._scopeSummaryBar);

    // ── Built-in personas — flat list, no intermediate section header ──
    for (const persona of PERSONAS) {
      this._root.appendChild(this._buildPersonaCard(persona));
    }

    // Acceptance rate summary table (DK-196)
    this._root.appendChild(this._buildAcceptanceRateSection());

    // Custom personas — flat, with Add Persona button
    this._root.appendChild(this._buildCustomPersonasSection());

    // Persona config templates (DK-141) — Settings > Templates section
    this._root.appendChild(this._buildTemplatesSection());

    // DK-188: Confidence threshold selector and filtered discards log
    this._root.appendChild(this._buildConfidenceSection());

    // Backlog deduplication (DK-366) — paste-and-parse backlog input + rejection log
    this._root.appendChild(this._buildBacklogSection());
  }

  _buildPersonaCard({ id, label, defaultHours }) {
    const card = el('div', { className: 'adv-card' });

    // ── Collapse toggle ────────────────────────────────────────
    const isInitiallyCollapsed = this._collapsedPersonas.has(id);
    const collapseBtn = el('button', {
      className: 'adv-collapse-btn',
      title: isInitiallyCollapsed ? 'Expand' : 'Collapse',
      'aria-expanded': String(!isInitiallyCollapsed),
      'aria-controls': `adv-card-body-${id}`,
      onClick: () => this._toggleCardCollapse(id),
    }, isInitiallyCollapsed ? '▸' : '▾');

    // ── Card header ────────────────────────────────────────────
    const statusDot  = el('span', { className: 'adv-dot adv-dot-unknown', title: 'Advisor offline' });
    const statusText = el('span', { className: 'adv-status-text' }, 'Waiting…');

    // Soul button — label included so it's clear which advisor's soul this edits
    const soulBtn = el('button', {
      className: 'adv-soul-btn',
      title: `Edit ${label} soul prompt`,
      onClick: () => this._openSoulModal(id, label),
    }, `${label} Soul`);

    // DK-365: Constraints button — opens constraint config modal
    // Only shown for the product persona (constraints are a product-focus feature)
    const constraintsBtn = id === 'product' ? el('button', {
      className: 'adv-constraints-btn',
      title: 'Configure persona constraints (budget, platform, complexity, risk)',
      'aria-label': 'Configure constraints for Product persona',
      onClick: () => this._openConstraintModal(id, label),
    }, 'Constraints') : null;

    // DK-365: Constraint chip — shown in header when constraints are active
    // Hidden until constraints are set for this persona + project
    const constraintChipEl = id === 'product' ? el('span', {
      className: 'adv-constraint-chip adv-hidden',
      title: 'Constraints are active — click Constraints to view or edit',
      'aria-label': 'Constraints active',
    }) : null;
    if (constraintChipEl) this._constraintChipEls[id] = constraintChipEl;

    // Pause toggle — labeled button per DK-111 spec.
    // Button text reads "Pause <Name>" / "Resume <Name>".
    // aria-label includes the persona name: "Pause <Name> persona" / "Resume <Name> persona".
    // Disabled while the persona is running (in-progress guard per spec).
    // pauseCheckbox and pauseTextEl are kept as null so existing _renderCard
    // branches that check card.pauseCheckbox/pauseTextEl degrade gracefully.
    const pauseCheckbox = null;
    const pauseTextEl = null;
    const pauseBtn = el('button', {
      type: 'button',
      className: 'adv-pause-btn',
      'aria-label': `Pause ${label} persona`,
      onClick: () => this._togglePause(id),
    }, `Pause ${label}`);

    // Run now button — opens inline prompt expander (DK-321)
    const runNowBtn = el('button', {
      className: 'adv-run-now-btn',
      'aria-label': `Run ${label} persona now`,
      'aria-expanded': 'false',
      'aria-controls': `adv-run-prompt-${id}`,
      title: 'Run now',
      onClick: () => this._toggleRunPrompt(id),
    }, 'Run Now');

    // Stats toggle button — opens the performance dashboard expansion
    const statsBtn = el('button', {
      className: 'adv-stats-btn',
      title: 'View performance stats',
      'aria-expanded': 'false',
      onClick: () => this._togglePerfDash(id),
    }, 'Stats ▸');

    // Run state label — shown below the button row while/after running
    const runStateEl = el('div', {
      className: 'adv-run-state',
      'aria-live': 'polite',
      role: 'status',
    });

    // Time hint
    const timeHintEl = el('span', { className: 'adv-run-time-hint' }, 'Usually 30–60s');

    // Compact summary shown only when the card is collapsed.
    // Displays next-run countdown or current status inline in the header.
    const collapsedSummaryEl = el('span', {
      className: 'adv-card-collapsed-summary',
      'aria-hidden': 'true',
    });

    // Inline countdown shown in the card header, next to the pause button.
    // Hidden when the card is collapsed (collapsed summary covers that case).
    // DK-111: Use <time> element so datetime attribute can carry machine-readable ISO value.
    const headerCountdownEl = el('time', {
      className: 'adv-header-countdown',
      'aria-live': 'polite',
    }, '—');

    // DK-134: Scope config drawer — chip-based UI for path filters + topic tags.
    // Engineer: include path chips + exclude path chips + topic tag chips.
    // Design/Product: topic tag chips only.
    // Collapsed by default; gear icon in header toggles it open.
    const SCOPED_FOCUS_PERSONAS = new Set(['engineer', 'design', 'product']);
    let scopedFocusDotEl = null;
    let scopedFocusGearBtn = null;
    let scopedFocusDrawerEl = null;

    if (SCOPED_FOCUS_PERSONAS.has(id)) {
      // Initialize per-persona chip data
      this._scopedFocusChips[id] = { topics: [], include: [], exclude: [] };

      // Active dot — shown when any constraint is non-empty; hidden otherwise.
      scopedFocusDotEl = el('span', {
        className: 'adv-scope-dot adv-hidden',
        'aria-label': 'Scope constraints active',
        title: '',  // updated dynamically
        'aria-hidden': 'false',
      });

      // Gear icon button — toggles the inline drawer
      const scopedDrawerId = `adv-scope-drawer-${id}`;
      scopedFocusGearBtn = el('button', {
        type: 'button',
        className: 'adv-scope-gear-btn',
        title: 'Configure persona scope',
        'aria-label': `Configure scope for ${label} persona`,
        'aria-expanded': 'false',
        'aria-controls': scopedDrawerId,
        onClick: () => this._toggleScopedFocusDrawer(id),
      }, '⚙');

      // ── Chip builder helper (local to this card build) ────
      const makeChipList = (fieldKey, ariaLabel) => el('div', {
        className: 'adv-scope-chip-list',
        role: 'list',
        'aria-label': ariaLabel,
      });

      const makeChipInput = (inputId, placeholder, maxlen) => el('input', {
        type: 'text',
        id: inputId,
        className: 'adv-scope-chip-input',
        placeholder,
        maxlength: String(maxlen || 200),
        autocomplete: 'off',
      });

      // ── Topic tag chips ────────────────────────────────────
      const topicsChipListEl = makeChipList('topics', 'Active topic tags');
      const topicsInputId = `adv-scope-topics-input-${id}`;
      const topicsInputEl = makeChipInput(topicsInputId, 'Add topic tag…', 50);

      // Suggested tags on first open (reduced blank-slate friction)
      const SUGGESTED_TOPICS = ['performance', 'security', 'accessibility', 'billing'];
      const suggestedRow = el('div', { className: 'adv-scope-suggestions' },
        el('span', { className: 'adv-scope-suggestions-label' }, 'Suggestions: '),
        ...SUGGESTED_TOPICS.map(tag => el('button', {
          type: 'button',
          className: 'adv-scope-suggestion-chip',
          onClick: () => this._addScopedFocusChip(id, 'topics', tag),
        }, tag)),
      );

      topicsInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._addScopedFocusChipFromInput(id, 'topics', topicsInputEl); }
        if (e.key === 'Backspace' && !topicsInputEl.value) { e.preventDefault(); this._removeLastScopedFocusChip(id, 'topics'); }
      });

      const topicsAddBtn = el('button', {
        type: 'button',
        className: 'adv-scope-chip-add-btn',
        title: 'Add topic tag',
        onClick: () => this._addScopedFocusChipFromInput(id, 'topics', topicsInputEl),
      }, 'Add');

      const topicsField = el('div', { className: 'adv-scope-field' },
        el('label', { className: 'adv-scope-field-label', htmlFor: topicsInputId },
          'Topic focus',
          el('span', { className: 'adv-scope-field-hint-inline' }, ' — max 50 chars each')
        ),
        topicsChipListEl,
        el('div', { className: 'adv-scope-input-row' },
          topicsInputEl,
          topicsAddBtn,
        ),
        suggestedRow,
      );

      // ── Path filter chips (engineer only) ─────────────────
      let includeChipListEl = null;
      let includeInputEl = null;
      let excludeChipListEl = null;
      let excludeInputEl = null;
      let fileCountBadgeEl = null;
      let testScopeBtn = null;
      let pathsSection = null;

      if (id === 'engineer') {
        includeChipListEl = makeChipList('include', 'Active include path patterns');
        const includeInputId = `adv-scope-include-input-${id}`;
        includeInputEl = makeChipInput(includeInputId, 'e.g. src/auth/**', 200);

        includeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addScopedFocusChipFromInput(id, 'include', includeInputEl); }
          if (e.key === 'Backspace' && !includeInputEl.value) { e.preventDefault(); this._removeLastScopedFocusChip(id, 'include'); }
        });

        const includeAddBtn = el('button', {
          type: 'button',
          className: 'adv-scope-chip-add-btn',
          title: 'Add include pattern',
          onClick: () => this._addScopedFocusChipFromInput(id, 'include', includeInputEl),
        }, 'Add');

        excludeChipListEl = makeChipList('exclude', 'Active exclude path patterns');
        const excludeInputId = `adv-scope-exclude-input-${id}`;
        excludeInputEl = makeChipInput(excludeInputId, 'e.g. **/*.test.js', 200);

        excludeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addScopedFocusChipFromInput(id, 'exclude', excludeInputEl); }
          if (e.key === 'Backspace' && !excludeInputEl.value) { e.preventDefault(); this._removeLastScopedFocusChip(id, 'exclude'); }
        });

        const excludeAddBtn = el('button', {
          type: 'button',
          className: 'adv-scope-chip-add-btn',
          title: 'Add exclude pattern',
          onClick: () => this._addScopedFocusChipFromInput(id, 'exclude', excludeInputEl),
        }, 'Add');

        fileCountBadgeEl = el('span', {
          className: 'adv-scope-file-count adv-hidden',
          'aria-live': 'polite',
        });

        testScopeBtn = el('button', {
          type: 'button',
          className: 'adv-scope-test-btn',
          title: 'Test scope — resolve patterns against project root and count matching files',
          onClick: () => this._testScopedFocus(id),
        }, 'Test scope');

        pathsSection = el('div', { className: 'adv-scope-paths-section' },
          el('div', { className: 'adv-scope-field' },
            el('label', { className: 'adv-scope-field-label', htmlFor: includeInputId },
              'Path filters — include',
              el('span', { className: 'adv-scope-field-hint-inline' }, ' — glob patterns (e.g. src/auth/**)'),
            ),
            el('div', { className: 'adv-scope-glob-hint' }, 'Glob syntax: ', el('code', {}, 'src/auth/**'), ', ', el('code', {}, '**/*.test.js')),
            includeChipListEl,
            el('div', { className: 'adv-scope-input-row' },
              includeInputEl,
              includeAddBtn,
            ),
          ),
          el('div', { className: 'adv-scope-field' },
            el('label', { className: 'adv-scope-field-label', htmlFor: excludeInputId },
              'Path filters — exclude',
            ),
            excludeChipListEl,
            el('div', { className: 'adv-scope-input-row' },
              excludeInputEl,
              excludeAddBtn,
            ),
          ),
          el('div', { className: 'adv-scope-test-row' },
            testScopeBtn,
            fileCountBadgeEl,
          ),
        );
      }

      // ── Save status + controls ─────────────────────────────
      const saveStatusEl = el('span', {
        className: 'adv-scope-save-status',
        role: 'status',
        'aria-live': 'polite',
      });

      const noFilesWarningEl = el('div', {
        className: 'adv-scope-no-files-warning adv-hidden',
        role: 'alert',
      }, '0 files matched configured scope on last cycle — check your path patterns.');

      const clearScopeLink = el('button', {
        type: 'button',
        className: 'adv-scope-clear-link',
        title: 'Clear all scope constraints for this persona',
        onClick: () => this._clearScopedFocus(id),
      }, 'Clear scope');

      const saveBtn = el('button', {
        type: 'button',
        className: 'adv-scope-save-btn',
        onClick: () => this._saveScopedFocus(id),
      }, 'Save');

      const drawerInner = el('div', { className: 'adv-scope-drawer-inner' },
        el('div', { className: 'adv-scope-drawer-header' },
          el('span', { className: 'adv-scope-drawer-title' }, 'Scope'),
          el('span', { className: 'adv-scope-drawer-default' }, 'Entire codebase by default'),
          clearScopeLink,
        ),
        topicsField,
        pathsSection,
        noFilesWarningEl,
        el('div', { className: 'adv-scope-actions' },
          saveBtn,
          saveStatusEl,
        ),
        el('div', { className: 'adv-scope-project-note' },
          'Scope applies to this project only'
        ),
      );

      scopedFocusDrawerEl = el('div', {
        className: 'adv-scope-drawer adv-hidden',
        id: scopedDrawerId,
      }, drawerInner);

      // Store refs
      this._scopedFocusState[id] = {
        drawerEl: scopedFocusDrawerEl,
        dotEl: scopedFocusDotEl,
        gearBtn: scopedFocusGearBtn,
        topicsChipListEl,
        topicsInputEl,
        includeChipListEl,   // null for design/product
        includeInputEl,      // null for design/product
        excludeChipListEl,   // null for design/product
        excludeInputEl,      // null for design/product
        fileCountBadgeEl,    // null for design/product
        testScopeBtn,        // null for design/product
        saveStatusEl,
        noFilesWarningEl,
        clearScopeLink,
        drawerOpen: false,
      };
    }

    card.appendChild(
      el('div', { className: 'adv-card-header' },
        el('div', { className: 'adv-card-header-left' },
          collapseBtn,
          statusDot,
          el('span', { className: 'adv-persona-label' }, label),
          scopedFocusDotEl,
          scopedFocusGearBtn,
          statusText,
          constraintChipEl,
          collapsedSummaryEl,
        ),
        el('div', { className: 'adv-card-header-right' },
          soulBtn,
          constraintsBtn,
          headerCountdownEl,
          runNowBtn,
          pauseBtn,
        ),
      )
    );

    // DK-301: Scope focus drawer — inserted between card header and card body.
    // Hidden by default; expanded when gear icon is clicked.
    if (scopedFocusDrawerEl) card.appendChild(scopedFocusDrawerEl);

    // ── Card body (collapsible) ────────────────────────────────
    const cardBody = el('div', {
      className: 'adv-card-body' + (isInitiallyCollapsed ? ' adv-hidden' : ''),
      id: `adv-card-body-${id}`,
    });
    if (isInitiallyCollapsed) card.classList.add('adv-card-collapsed');
    card.appendChild(cardBody);

    // ── Persona title (always visible in body) ────────────────
    cardBody.appendChild(el('div', { className: 'adv-card-body-title' }, `${label} Advisor`));

    // ── Avatar ─────────────────────────────────────────────────
    const avatarEl = createAvatarEl(id, 'idle');
    if (avatarEl) cardBody.appendChild(avatarEl);

    // ── Focus Directive (DK-039) ───────────────────────────────
    // Inline, directly below the persona name / avatar. One click to edit,
    // blur or Enter to save, Escape to cancel. 500-char hard limit.
    // Shows "Focused" badge when a directive is set, "Freeform" when empty.
    const directiveLabelId = `adv-directive-label-${id}`;
    const directiveInputId = `adv-directive-input-${id}`;

    // One-line persona description (shown above the directive input)
    const directivePersonaDesc = el('p', { className: 'adv-directive-persona-desc' },
      PERSONA_DIRECTIVE_DESCRIPTIONS[id] || ''
    );

    // Status badge — "Focused" or "Freeform". Never color-only; always includes text.
    const directiveBadge = el('span', {
      className: 'adv-directive-badge adv-directive-badge-freeform',
      'aria-label': 'Directive status: Freeform',
    }, 'Freeform');

    // Timestamp — "Focus set 3 days ago"
    const directiveTimestamp = el('span', { className: 'adv-directive-ts adv-hidden' });

    // Staleness nudge — shown when directive is 14+ days old
    const directiveStaleness = el('span', { className: 'adv-directive-stale adv-hidden' },
      'This directive is 14+ days old — still relevant?'
    );

    // Next run indicator — "next run in ~Xh"
    const directiveNextRun = el('span', { className: 'adv-directive-next-run' });

    // Display row — shown in non-editing state (click to edit)
    const directiveDisplayText = el('span', {
      className: 'adv-directive-display-text',
      'aria-hidden': 'true',
    }, '');

    const directiveEditBtn = el('button', {
      className: 'adv-directive-edit-btn',
      type: 'button',
      title: 'Click to edit focus directive',
      'aria-label': `Edit focus directive for ${label} persona`,
      onClick: () => this._openDirectiveEdit(id),
    }, 'Edit');

    const directiveDisplayRow = el('div', { className: 'adv-directive-display-row' },
      directiveBadge,
      directiveDisplayText,
      directiveEditBtn,
    );

    // Edit row — shown in editing state
    const directiveLabel = el('label', {
      className: 'adv-directive-label',
      id: directiveLabelId,
      htmlFor: directiveInputId,
    }, 'Focus directive');

    const directiveCounter = el('span', {
      className: 'adv-directive-counter',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }, '0 / 500');

    const directiveInput = el('input', {
      type: 'text',
      className: 'adv-directive-input',
      id: directiveInputId,
      placeholder: PERSONA_DIRECTIVE_PLACEHOLDERS[id] || 'e.g. focus on this area',
      maxlength: '500',
      'aria-labelledby': directiveLabelId,
      'aria-describedby': `adv-directive-counter-${id} adv-directive-hint-${id}`,
      onInput: () => {
        const len = directiveInput.value.length;
        directiveCounter.textContent = `${len} / 500`;
        directiveCounter.className = 'adv-directive-counter' + (len > 480 ? ' adv-directive-counter-warn' : '');
        // Announce to assistive technology on input (not only on submission)
        directiveCounter.setAttribute('aria-live', 'polite');
      },
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._saveDirective(id, directiveInput.value); }
        if (e.key === 'Escape') { e.preventDefault(); this._cancelDirectiveEdit(id); }
      },
      onBlur: () => this._saveDirective(id, directiveInput.value),
    });
    directiveCounter.id = `adv-directive-counter-${id}`;

    // Character count hint — nudges users toward specificity
    const directiveHint = el('p', {
      className: 'adv-directive-hint',
      id: `adv-directive-hint-${id}`,
    }, '10–500 characters works best.');

    // "Applies on next cycle" note — static, always shown in edit mode
    const directiveAppliesNote = el('p', { className: 'adv-directive-applies-note' },
      'Applies on next cycle.'
    );

    // Inline save confirmation — aria-live="polite" for screen reader feedback
    const directiveSaveStatus = el('span', {
      className: 'adv-directive-save-status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }, '');

    const directiveSaveBtn = el('button', {
      className: 'adv-directive-save-btn',
      type: 'button',
      title: 'Save focus directive',
      onMousedown: (e) => e.preventDefault(), // prevent blur before click
      onClick: () => this._saveDirective(id, directiveInput.value),
    }, 'Save');

    // Clear button — shows "×" per spec, resets to empty without manual deletion
    const directiveClearBtn = el('button', {
      className: 'adv-directive-clear-btn',
      type: 'button',
      title: 'Clear directive — return to freeform',
      'aria-label': 'Clear focus directive',
      onMousedown: (e) => e.preventDefault(), // prevent blur before click
      onClick: () => this._saveDirective(id, ''),
    }, '×');

    const directiveCancelBtn = el('button', {
      className: 'adv-directive-cancel-btn',
      type: 'button',
      title: 'Cancel editing',
      onMousedown: (e) => e.preventDefault(), // prevent blur before click
      onClick: () => this._cancelDirectiveEdit(id),
    }, 'Cancel');

    const directiveEditRow = el('div', { className: 'adv-directive-edit-row adv-hidden' },
      el('div', { className: 'adv-directive-edit-header' },
        directiveLabel,
        directiveCounter,
      ),
      directiveInput,
      directiveHint,
      el('div', { className: 'adv-directive-edit-actions' },
        directiveSaveBtn,
        directiveClearBtn,
        directiveCancelBtn,
        directiveSaveStatus,
      ),
      directiveAppliesNote,
    );

    // Hidden by default; _renderDirective reveals it when a project is selected
    const directiveSection = el('div', { className: 'adv-directive-section adv-hidden' },
      directivePersonaDesc,
      el('div', { className: 'adv-directive-meta' },
        directiveDisplayRow,
        directiveTimestamp,
        directiveStaleness,
        directiveNextRun,
      ),
      directiveEditRow,
    );

    cardBody.appendChild(directiveSection);

    // Store directive element refs for later updates
    this._directiveEls[id] = {
      sectionEl: directiveSection,
      badgeEl: directiveBadge,
      inputEl: directiveInput,
      labelEl: directiveLabel,
      timestampEl: directiveTimestamp,
      stalenessEl: directiveStaleness,
      clearBtn: directiveClearBtn,
      nextRunEl: directiveNextRun,
      counterEl: directiveCounter,
      editRow: directiveEditRow,
      displayRow: directiveDisplayRow,
      displayText: directiveDisplayText,
      editBtn: directiveEditBtn,
      saveStatusEl: directiveSaveStatus,
    };

    // ── Focus prompt area ──────────────────────────────────────
    // Collapsed by default. Expandable with a "Focus area (optional)" label.
    const focusLabel = el('label', {
      className: 'adv-focus-label',
      htmlFor: `adv-focus-${id}`,
    }, 'Focus area (optional)');

    const focusCounter = el('span', { className: 'adv-focus-counter' }, '0 / 256');

    const focusTextarea = el('textarea', {
      className: 'adv-focus-textarea',
      id: `adv-focus-${id}`,
      placeholder: 'e.g. review the advisor deduplication logic',
      maxlength: '256',
      rows: '2',
      onInput: () => {
        const len = focusTextarea.value.length;
        focusCounter.textContent = `${len} / 256`;
        focusCounter.className = 'adv-focus-counter' + (len > 240 ? ' adv-focus-counter-warn' : '');
      },
    });

    const chipsEl = el('div', { className: 'adv-focus-chips adv-hidden' });

    // Toggle button for the focus area.
    // Focus area starts expanded by default (primary control); only collapses after
    // a focus prompt has been saved. The toggle lets users re-collapse/expand manually.
    const focusToggleBtn = el('button', {
      className: 'adv-focus-toggle',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `adv-focus-area-${id}`,
      onClick: () => {
        const isExpanded = focusToggleBtn.getAttribute('aria-expanded') === 'true';
        focusToggleBtn.setAttribute('aria-expanded', String(!isExpanded));
        focusArea.classList.toggle('adv-focus-area-open', !isExpanded);
        // When collapsing: show saved focus preview if one exists, else plain label
        const savedText = focusToggleBtn.dataset.savedFocus || '';
        if (isExpanded) {
          // Collapsing — show preview if there's a saved prompt
          focusToggleBtn.textContent = savedText ? 'Focus● ▸' : 'Focus ▸';
          focusToggleBtn.title = savedText
            ? `Saved focus active: "${savedText}"`
            : 'Set a focus area for the next run';
          // Show inline preview when collapsing
          const previewEl = this._cards[id]?.focusPreviewEl;
          if (previewEl && savedText) {
            const maxLen = 40;
            const preview = savedText.length > maxLen ? savedText.slice(0, maxLen) + '…' : savedText;
            previewEl.textContent = preview;
            previewEl.title = savedText;
            previewEl.className = 'adv-focus-preview';
          }
        } else {
          // Expanding — hide preview
          focusToggleBtn.textContent = savedText ? 'Focus● ▾' : 'Focus ▾';
          const previewEl = this._cards[id]?.focusPreviewEl;
          if (previewEl) {
            previewEl.textContent = '';
            previewEl.className = 'adv-focus-preview adv-hidden';
          }
          focusTextarea.focus();
        }
        this._focusManuallyToggled = this._focusManuallyToggled || {};
        this._focusManuallyToggled[id] = true;
      },
    }, 'Focus ▾');

    // Unsaved-changes dot — shown while the user is typing before auto-save fires (DK-315).
    const focusDirtyDot = el('span', {
      className: 'adv-focus-dirty-dot adv-hidden',
      title: 'Unsaved changes — will auto-save shortly',
      'aria-hidden': 'true',
    }, '●');

    // Indicator showing the currently saved focus prompt (from Firestore).
    // Hidden when no saved focus is set.
    const savedFocusEl = el('div', { className: 'adv-saved-focus adv-hidden' });

    const focusArea = el('div', {
      className: 'adv-focus-area adv-focus-area-open',
      id: `adv-focus-area-${id}`,
    },
      el('div', { className: 'adv-focus-header' },
        focusLabel,
        focusCounter,
      ),
      focusTextarea,
      chipsEl,
      el('div', { className: 'adv-focus-actions' },
        focusDirtyDot,
        savedFocusEl,
      ),
    );

    // Attach auto-save behavior (DK-315): debounce-on-input (800ms) + save on blur.
    // Uses _autoSaveFocusPrompt which saves without clearing or collapsing.
    const focusSaveControl = createSaveOnBlur({
      element: focusTextarea,
      onSave: async (value) => {
        await this._autoSaveFocusPrompt(id, value);
      },
      debounceMs: 800,
      autoSaveOnInput: true,
      showIndicator: true,
      indicatorPosition: 'inline',
      autoFadeAfterMs: 2000,
      onDirtyChange: (dirty) => {
        focusDirtyDot.classList.toggle('adv-hidden', !dirty);
      },
    });
    this._focusSaveControls[id] = focusSaveControl;

    // ── Inline Run-prompt expander (DK-321) ───────────────────────────────
    // Revealed when user clicks "Run Now". Single-line input (no multi-line),
    // 150-char hard cap, Escape to dismiss, Enter to submit.
    const runPromptHintId = `adv-run-prompt-hint-${id}`;
    const runPromptInput = el('input', {
      type: 'text',
      className: 'adv-run-prompt-input',
      placeholder: 'focus on the new auth module',
      maxlength: '150',
      'aria-label': 'Optional focus for this run only',
      'aria-describedby': runPromptHintId,
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submitRunPrompt(id); }
        if (e.key === 'Escape') { e.preventDefault(); this._closeRunPrompt(id); }
      },
    });
    const runPromptCounter = el('span', { className: 'adv-run-prompt-counter' }, '0 / 150');
    runPromptInput.addEventListener('input', () => {
      const len = runPromptInput.value.length;
      runPromptCounter.textContent = `${len} / 150`;
      runPromptCounter.className = 'adv-run-prompt-counter' + (len > 130 ? ' adv-run-prompt-counter-warn' : '');
    });
    const runPromptHintEl = el('span', {
      className: 'adv-run-prompt-hint',
      id: runPromptHintId,
    }, 'Optional — override for this run only');

    // ── DK-367: Scope input ───────────────────────────────────────────────
    // "Focus on:" — an optional free-text field that aims the run at a specific
    // part of the product. Scoped runs produce denser, more targeted output.
    const runScopeLabelId = `adv-run-scope-label-${id}`;
    const runScopeInputId = `adv-run-scope-input-${id}`;
    const runScopeNudgeId = `adv-run-scope-nudge-${id}`;

    // Known vague scope strings that should trigger the quality nudge
    const VAGUE_SCOPE_PATTERNS = ['the app', 'everything', 'all of it', 'the whole app', 'all', 'app'];

    const runScopeInput = el('input', {
      type: 'text',
      className: 'adv-run-scope-input',
      id: runScopeInputId,
      placeholder: 'onboarding, step 2 — email verification',
      maxlength: '500',
      'aria-labelledby': runScopeLabelId,
      'aria-describedby': runScopeNudgeId,
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submitRunPrompt(id); }
        if (e.key === 'Escape') { e.preventDefault(); this._closeRunPrompt(id); }
      },
    });
    const runScopeNudge = el('span', {
      className: 'adv-run-scope-nudge adv-hidden',
      id: runScopeNudgeId,
      role: 'status',
      'aria-live': 'polite',
    }, 'Try being more specific — e.g., "account settings > notifications tab."');
    runScopeInput.addEventListener('input', () => {
      const val = runScopeInput.value.trim();
      const isTooShort = val.length > 0 && val.length < 10;
      const isVague = VAGUE_SCOPE_PATTERNS.some(p => val.toLowerCase() === p);
      if (isTooShort || isVague) {
        runScopeNudge.classList.remove('adv-hidden');
      } else {
        runScopeNudge.classList.add('adv-hidden');
      }
    });
    const runScopeLabelEl = el('label', {
      className: 'adv-run-scope-label',
      id: runScopeLabelId,
      for: runScopeInputId,
    }, 'Focus on:');

    const runScopeRow = el('div', { className: 'adv-run-scope-row' },
      runScopeLabelEl,
      runScopeInput,
    );

    const runPromptSubmitBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-submit',
      onClick: () => this._submitRunPrompt(id),
    }, 'Run');
    const runPromptCancelBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-cancel',
      onClick: () => this._closeRunPrompt(id),
    }, 'Cancel');
    const runPromptExpander = el('div', {
      className: 'adv-run-prompt-expander adv-hidden',
      id: `adv-run-prompt-${id}`,
      role: 'group',
      'aria-label': 'Run with optional focus prompt',
    },
      el('div', { className: 'adv-run-prompt-header' },
        runPromptHintEl,
        runPromptCounter,
      ),
      runPromptInput,
      runScopeRow,
      runScopeNudge,
      el('div', { className: 'adv-run-prompt-actions' },
        runPromptSubmitBtn,
        runPromptCancelBtn,
      ),
    );

    cardBody.appendChild(runPromptExpander);
    cardBody.appendChild(
      el('div', { className: 'adv-focus-row' },
        el('div', { className: 'adv-run-state-row' },
          runStateEl,
          timeHintEl,
        ),
      )
    );
    // ── Activity log (expandable) ──────────────────────────────
    const logToggleBtn = el('button', {
      className: 'adv-log-toggle',
      type: 'button',
      title: 'Show activity log',
      'aria-expanded': 'false',
      'aria-controls': `adv-log-container-${id}`,
      onClick: () => this._toggleLog(id),
    }, 'Log ▸');

    const logClearBtn = el('button', {
      className: 'adv-log-clear-btn adv-hidden',
      title: 'Clear activity log',
      'aria-label': 'Clear activity log',
      onClick: () => this._clearLog(id),
    }, '✕');

    const logContainer = el('div', { className: 'adv-log-container adv-log-hidden', id: `adv-log-container-${id}` });
    const logList = el('div', { className: 'adv-log-list' });
    logContainer.appendChild(logList);

    // ── Footer: schedule controls (single row) ─────────────────
    // Interval input — spec requires a visible <label> element (not just placeholder).
    const intervalInputId = `adv-interval-${id}`;
    const intervalValidationEl = el('span', {
      className: 'adv-interval-validation',
      role: 'alert',
      'aria-live': 'polite',
    });
    const intervalSavedEl = el('span', { className: 'adv-interval-saved' }); // transient "Saved"
    let intervalSavedTimer = null;

    // Unit selector: hours (default) or minutes
    const intervalUnitSelect = el('select', {
      className: 'adv-interval-unit-select',
      'aria-label': 'Interval unit',
    },
      el('option', { value: 'hours' }, 'hours'),
      el('option', { value: 'minutes' }, 'minutes'),
    );

    // DK-111: min interval is 0.25h (15 min). Hours mode allows floats; minutes mode
    // stays integer. step=0.25 in hours mode so arrow keys snap to quarter-hours.
    const MIN_HOURS = 0.25;
    const getIntervalIsMinutes = () => intervalUnitSelect.value === 'minutes';
    const getIntervalMax = () => getIntervalIsMinutes() ? 60 : 168;
    const getIntervalMin = () => getIntervalIsMinutes() ? 1 : MIN_HOURS;
    const getIntervalStep = () => getIntervalIsMinutes() ? '1' : '0.25';

    // Shared validation helper — returns { valid, warn, errMsg }
    const validateIntervalInput = () => {
      const raw = intervalInput.value;
      const isMinutes = getIntervalIsMinutes();
      const min = getIntervalMin();
      const max = getIntervalMax();
      const v = parseFloat(raw);
      if (!raw || isNaN(v) || v < min || v > max) {
        return { valid: false, warn: false, errMsg: isMinutes
          ? `Enter a whole number 1–${max}`
          : `Enter a number ${min}–${max} (minimum 0.25 = 15 min)` };
      }
      if (isMinutes && !Number.isInteger(v)) {
        return { valid: false, warn: false, errMsg: `Enter a whole number 1–${max}` };
      }
      // Soft warning: hours < 1 (spec: show warning, not error)
      if (!isMinutes && v < 1) {
        return { valid: true, warn: true, errMsg: null };
      }
      return { valid: true, warn: false, errMsg: null };
    };

    const applyIntervalValidation = () => {
      const { valid, warn, errMsg } = validateIntervalInput();
      if (!valid) {
        intervalValidationEl.textContent = errMsg;
        intervalValidationEl.className = 'adv-interval-validation adv-interval-validation-err';
      } else if (warn) {
        intervalValidationEl.textContent = 'Intervals under 1 hour run frequently — check resource usage.';
        intervalValidationEl.className = 'adv-interval-validation adv-interval-validation-warn';
      } else {
        intervalValidationEl.textContent = '';
        intervalValidationEl.className = 'adv-interval-validation';
      }
    };

    const intervalInput = el('input', {
      className: 'adv-interval-input',
      type: 'number',
      id: intervalInputId,
      'aria-label': 'Run interval',
      min: String(MIN_HOURS),
      max: '168',
      step: '0.25',
      value: String(defaultHours),
      // Inline validation on change (not on submit per spec)
      onInput: applyIntervalValidation,
      // Confirm on blur (per spec)
      onBlur: () => {
        const { valid } = validateIntervalInput();
        if (valid) {
          this._saveInterval(id, intervalInput.value, intervalUnitSelect.value, intervalSavedEl, (timer) => {
            if (intervalSavedTimer) clearTimeout(intervalSavedTimer);
            intervalSavedTimer = timer;
          });
        }
      },
      // Confirm on Enter (per spec)
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          intervalInput.blur();
        }
      },
    });

    // When unit changes, update min/max/step constraints and re-validate; save if valid
    intervalUnitSelect.addEventListener('change', () => {
      const isMinutes = getIntervalIsMinutes();
      const max = getIntervalMax();
      const min = getIntervalMin();
      intervalInput.max = String(max);
      intervalInput.min = String(min);
      intervalInput.step = getIntervalStep();
      const v = parseFloat(intervalInput.value);
      // Clamp to max when switching from hours → minutes (e.g. 24h → 24m is fine, 168h → 60m)
      if (!isNaN(v) && v > max) {
        intervalInput.value = String(max);
      }
      // Clamp to integer when switching to minutes
      if (isMinutes && !isNaN(v) && !Number.isInteger(v)) {
        intervalInput.value = String(Math.max(1, Math.ceil(v)));
      }
      applyIntervalValidation();
      // Save updated unit+value immediately on unit change if valid
      const { valid } = validateIntervalInput();
      if (valid) {
        this._saveInterval(id, intervalInput.value, intervalUnitSelect.value, intervalSavedEl, (timer) => {
          if (intervalSavedTimer) clearTimeout(intervalSavedTimer);
          intervalSavedTimer = timer;
        });
      }
    });

    // Visible <label> element for the interval input (not just placeholder per spec)
    const intervalLabel = el('label', {
      className: 'adv-interval-label-el',
      htmlFor: intervalInputId,
    }, 'Every');

    // Per-persona hint text (spec: "small per-persona note for the interval field").
    // DK-111: Design hint includes headless Chrome note so users make informed throttling decisions.
    // title attribute gives the full text as a browser tooltip.
    const hintText = PERSONA_INTERVAL_HINTS[id] || '';
    const intervalHintEl = el('span', {
      className: 'adv-interval-hint',
      title: hintText,
    }, hintText);

    // ── Ticket cap input ───────────────────────────────────────
    // Inline number input (range 1–50). Visible without expanding.
    // Tooltip explains throttle framing per spec.
    const capInputId = `adv-cap-${id}`;
    const capSavedEl = el('span', { className: 'adv-interval-saved' });
    let capSavedTimer = null;

    const capInput = el('input', {
      className: 'adv-cap-input',
      type: 'number',
      id: capInputId,
      min: '1',
      max: '50',
      value: '3',
      title: 'Top-ranked tickets by impact are created first; others are deferred.',
      'aria-label': 'Max tickets per run',
      onInput: () => {
        const v = parseInt(capInput.value, 10);
        if (!capInput.value || isNaN(v) || v < 1 || v > 50 || !Number.isInteger(v)) {
          capInput.classList.add('adv-cap-input-invalid');
        } else {
          capInput.classList.remove('adv-cap-input-invalid');
        }
      },
      onBlur: () => {
        const v = parseInt(capInput.value, 10);
        if (capInput.value && !isNaN(v) && v >= 1 && v <= 50 && Number.isInteger(v)) {
          this._saveTicketCap(id, v, capSavedEl, (timer) => {
            if (capSavedTimer) clearTimeout(capSavedTimer);
            capSavedTimer = timer;
          });
        }
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          capInput.blur();
        }
      },
    });

    const capLabel = el('label', {
      className: 'adv-cap-label',
      htmlFor: capInputId,
    }, 'Cap:');

    // ── Preview Run button (dry-run trigger) ──────────────────────
    // Secondary-weight text button per spec — exploratory action, not primary.
    const previewRunBtn = el('button', {
      className: 'adv-preview-run-btn',
      'aria-label': `Preview Run: ${label} persona`,
      title: 'Run a preview — see what this persona would propose without creating real tickets',
      onClick: () => this._startDryRun(id, label),
    }, 'Preview Run');

    // ── Preview panel (dry-run results) ─────────────────────────
    // Full-width panel that expands below the card body.
    // aria-live so screen readers announce status changes.
    const dryRunPanel = el('div', {
      className: 'adv-dry-run-panel adv-hidden',
      id: `adv-dry-run-panel-${id}`,
      role: 'region',
      'aria-label': `${label} persona preview results`,
    });

    const dryRunStatusBar = el('div', {
      className: 'adv-dry-run-status-bar',
      role: 'status',
      'aria-live': 'polite',
    });

    const dryRunPanelHeading = el('h3', {
      className: 'adv-dry-run-panel-heading',
      tabIndex: '-1',
    }, `${label} — Preview Run`);

    const dryRunProposalList = el('div', {
      className: 'adv-dry-run-proposal-list',
    });

    const dryRunCloseBtn = el('button', {
      className: 'adv-dry-run-close-btn',
      'aria-label': 'Close preview panel',
      onClick: () => this._closeDryRunPanel(id),
    }, '✕ Close');

    const dryRunPromoteAllBtn = el('button', {
      className: 'adv-dry-run-promote-all-btn adv-hidden',
      'aria-label': 'Promote all proposals to real tickets',
      onClick: () => this._promoteAllDryRunProposals(id, label),
    }, 'Promote all');

    const dryRunPanelHeaderRow = el('div', { className: 'adv-dry-run-panel-header-row' },
      dryRunPanelHeading,
      el('div', { className: 'adv-dry-run-panel-header-actions' },
        dryRunPromoteAllBtn,
        dryRunCloseBtn,
      ),
    );

    dryRunPanel.appendChild(dryRunStatusBar);
    dryRunPanel.appendChild(dryRunPanelHeaderRow);
    dryRunPanel.appendChild(dryRunProposalList);

    // Store dry-run panel references (panel appended to cardBody below, after footer)
    this._dryRunPanels[id] = {
      panel: dryRunPanel,
      statusBar: dryRunStatusBar,
      proposalList: dryRunProposalList,
      heading: dryRunPanelHeading,
      promoteAllBtn: dryRunPromoteAllBtn,
      previewRunBtn,
    };

    // ── Last run info line (DK-303) ────────────────────────────────────────
    // Single scannable line below card header: "Last run 2h ago — 2 tickets created"
    // or "Never run". Updated by _renderCard when state changes.
    const lastRunLineEl = el('div', {
      className: 'adv-last-run-line',
    }, 'Never run');
    cardBody.appendChild(lastRunLineEl);

    // DK-302: Collapsed one-line priorities preview — shown below last-run line
    // so users can correlate persona output with what priorities were set at the time.
    const prioritiesPreviewEl = el('div', {
      className: 'adv-priorities-preview',
      title: 'Current priorities used by this persona',
      style: 'display:none',
    });
    this._prioritiesPreviewEls[id] = prioritiesPreviewEl;
    cardBody.appendChild(prioritiesPreviewEl);

    // ── Schedule row: [Every] [input] [unit] · cap [cap input] [saved] ──
    // Essential scheduling controls only. Countdown moves to the card header.
    // Preview Run moved to secondary actions section below.
    const scheduleFooter = el('div', { className: 'adv-card-footer' },
      el('div', { className: 'adv-schedule-row' },
        intervalLabel,
        intervalInput,
        intervalUnitSelect,
        el('span', { className: 'adv-schedule-sep' }, '·'),
        capLabel,
        capInput,
        intervalSavedEl,
        capSavedEl,
      ),
      intervalValidationEl,
      intervalHintEl,
    );
    cardBody.appendChild(scheduleFooter);

    // ── Schedule section (DK-195) ───────────────────────────────────────────
    // Collapsible "Custom schedule" disclosure. Default closed.
    // Stores: schedule: { timezone, allowedDays, windowStart, windowEnd } in Firestore.
    // Backward-compatible: existing allowedHours field left untouched in daemon.
    const timeWindowBodyId = `adv-time-window-body-${id}`;
    let timeWindowOpen = false;

    // Detect browser timezone for default
    const browserTz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch { return 'UTC'; }
    })();

    // ── Timezone selector ─────────────────────────────────────────────────
    // Common IANA timezones. Users can type a custom value via the text input fallback.
    const COMMON_TIMEZONES = [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Anchorage', 'America/Adak', 'Pacific/Honolulu',
      'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
      'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
      'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland',
    ];
    // Ensure browser tz is in the list
    const tzOptions = COMMON_TIMEZONES.includes(browserTz)
      ? COMMON_TIMEZONES
      : [browserTz, ...COMMON_TIMEZONES];

    const tzSelect = el('select', {
      className: 'adv-tz-select',
      'aria-label': 'Timezone',
      id: `adv-tz-${id}`,
    }, ...tzOptions.map(tz => el('option', { value: tz, selected: tz === browserTz }, tz)));

    // ── Time inputs ───────────────────────────────────────────────────────
    const startTimeInput = el('input', {
      type: 'time',
      className: 'adv-time-input',
      'aria-label': 'Active from',
      id: `adv-start-time-${id}`,
      value: '21:00',
    });

    const endTimeInput = el('input', {
      type: 'time',
      className: 'adv-time-input',
      'aria-label': 'Until',
      id: `adv-end-time-${id}`,
      value: '06:00',
    });

    // Plain-language hint (e.g. "9 hours active" or "overnight window")
    const schedDurationEl = el('span', { className: 'adv-time-window-duration' });

    function updateTimeHint() {
      const s = startTimeInput.value; // "HH:MM"
      const e = endTimeInput.value;
      if (!s || !e) { schedDurationEl.textContent = ''; return; }
      const [sh, sm] = s.split(':').map(Number);
      const [eh, em] = e.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin   = eh * 60 + em;
      let durationMin;
      if (startMin < endMin) {
        durationMin = endMin - startMin;
      } else if (startMin > endMin) {
        durationMin = (24 * 60 - startMin) + endMin; // overnight
      } else {
        schedDurationEl.textContent = '(0 hours — same start and end)';
        return;
      }
      const h = Math.floor(durationMin / 60);
      const m = durationMin % 60;
      const label = startMin > endMin ? 'overnight window' : `${h > 0 ? h + 'h' : ''}${m > 0 ? ' ' + m + 'm' : ''} active`;
      schedDurationEl.textContent = `(${label.trim()})`;
    }
    updateTimeHint();

    // ── Day-of-week toggle pills ──────────────────────────────────────────
    // Uses JS day integers: 0=Sun, 1=Mon, …, 6=Sat (matches Date.getDay())
    const DAYS = [
      { dayInt: 1, key: 'mon', label: 'M',  ariaLabel: 'Monday'    },
      { dayInt: 2, key: 'tue', label: 'T',  ariaLabel: 'Tuesday'   },
      { dayInt: 3, key: 'wed', label: 'W',  ariaLabel: 'Wednesday' },
      { dayInt: 4, key: 'thu', label: 'T',  ariaLabel: 'Thursday'  },
      { dayInt: 5, key: 'fri', label: 'F',  ariaLabel: 'Friday'    },
      { dayInt: 6, key: 'sat', label: 'S',  ariaLabel: 'Saturday'  },
      { dayInt: 0, key: 'sun', label: 'S',  ariaLabel: 'Sunday'    },
    ];
    // Default: Mon–Fri (days 1-5)
    const defaultDayInts = new Set([1, 2, 3, 4, 5]);
    const dayButtons = {};
    const dayButtonEls = DAYS.map(({ dayInt, key, label, ariaLabel }) => {
      const active = defaultDayInts.has(dayInt);
      const btn = el('button', {
        type: 'button',
        className: 'adv-day-btn' + (active ? ' adv-day-btn-active' : ''),
        'aria-pressed': String(active),
        'aria-label': ariaLabel,
        'data-day': String(dayInt),
        onClick: () => {
          const pressed = btn.getAttribute('aria-pressed') === 'true';
          btn.setAttribute('aria-pressed', String(!pressed));
          btn.classList.toggle('adv-day-btn-active', !pressed);
          this._saveSchedule(id, tzSelect, startTimeInput, endTimeInput, dayButtons, timeWindowSavedEl, nextRunEl, noRunsWarningEl);
        },
      }, label);
      dayButtons[key] = btn;
      return btn;
    });

    // Fieldset wrapper for accessibility
    const dayFieldset = el('fieldset', { className: 'adv-day-fieldset' },
      el('legend', { className: 'adv-day-legend' }, 'Active days'),
      el('div', { className: 'adv-day-row' }, ...dayButtonEls),
    );

    // ── Next run / last ran display ───────────────────────────────────────
    const nextRunEl = el('div', {
      className: 'adv-schedule-next-run',
      'aria-live': 'polite',
    });

    // ── No-runs warning ───────────────────────────────────────────────────
    const noRunsWarningEl = el('div', {
      className: 'adv-schedule-no-runs-warning adv-hidden',
      role: 'alert',
    }, 'This schedule has no runs in the next 7 days.');

    const timeWindowSavedEl = el('span', {
      className: 'adv-interval-saved',
      role: 'status',
      'aria-live': 'polite',
    });

    // "Clear schedule" button — removes the restriction
    const clearWindowBtn = el('button', {
      type: 'button',
      className: 'adv-time-window-clear-btn',
      title: 'Remove schedule — run at any time',
      onClick: () => this._clearSchedule(id, timeWindowSavedEl, nextRunEl, noRunsWarningEl),
    }, 'Clear schedule');

    // Save on change for all schedule inputs
    const saveScheduleOnChange = () =>
      this._saveSchedule(id, tzSelect, startTimeInput, endTimeInput, dayButtons, timeWindowSavedEl, nextRunEl, noRunsWarningEl);
    tzSelect.addEventListener('change', saveScheduleOnChange);
    startTimeInput.addEventListener('change', () => { updateTimeHint(); saveScheduleOnChange(); });
    endTimeInput.addEventListener('change', () => { updateTimeHint(); saveScheduleOnChange(); });

    const timeWindowBody = el('div', {
      className: 'adv-time-window-body adv-hidden',
      id: timeWindowBodyId,
    },
      el('p', { className: 'adv-time-window-hint' },
        'Scheduled runs only. "Run Now" always fires.'
      ),
      el('div', { className: 'adv-time-window-tz-row' },
        el('label', { htmlFor: `adv-tz-${id}`, className: 'adv-time-label' }, 'Timezone'),
        tzSelect,
      ),
      el('div', { className: 'adv-time-window-hours' },
        el('label', { htmlFor: `adv-start-time-${id}`, className: 'adv-time-label' }, 'Active from'),
        startTimeInput,
        el('label', { htmlFor: `adv-end-time-${id}`, className: 'adv-time-label' }, 'Until'),
        endTimeInput,
        schedDurationEl,
      ),
      dayFieldset,
      noRunsWarningEl,
      nextRunEl,
      el('div', { className: 'adv-time-window-actions' },
        clearWindowBtn,
        timeWindowSavedEl,
      ),
    );

    const timeWindowToggleBtn = el('button', {
      type: 'button',
      className: 'adv-time-window-toggle',
      'aria-expanded': 'false',
      'aria-controls': timeWindowBodyId,
      onClick: () => {
        timeWindowOpen = !timeWindowOpen;
        timeWindowBody.classList.toggle('adv-hidden', !timeWindowOpen);
        timeWindowToggleBtn.setAttribute('aria-expanded', String(timeWindowOpen));
        timeWindowToggleBtn.textContent = timeWindowOpen ? 'Custom schedule ▾' : 'Custom schedule ▸';
      },
    }, 'Custom schedule ▸');

    const timeWindowSection = el('div', { className: 'adv-time-window-section' },
      timeWindowToggleBtn,
      timeWindowBody,
    );
    cardBody.appendChild(timeWindowSection);

    // ── DK-136: Trigger pills section ─────────────────────────────────────
    // Shows active trigger conditions as pills: "every 12h", "on deploy", "manual"
    // Plus a progress counter for ticket-close triggers: "3/5 tickets closed"
    const triggerPillsEl = el('div', { className: 'adv-trigger-pills' });
    const triggerProgressEl = el('div', {
      className: 'adv-trigger-progress',
      style: 'display:none',
    });

    // Initial pills are rendered; updated in _renderCard when intervalHours changes
    // Interval pill is always shown
    const intervalPill = el('span', {
      className: 'adv-trigger-pill adv-trigger-pill-interval',
      title: 'Scheduled interval trigger',
    });
    triggerPillsEl.appendChild(intervalPill);

    // "on deploy" pill — shown if webhook trigger is configured (read from Firestore config)
    const webhookPill = el('span', {
      className: 'adv-trigger-pill adv-trigger-pill-webhook adv-hidden',
      title: 'Webhook / deploy trigger active — configure DOCKET_WEBHOOK_SECRET env var',
    }, 'on deploy');
    triggerPillsEl.appendChild(webhookPill);

    // "manual" pill — always shown (Run Now button provides this)
    const manualPill = el('span', {
      className: 'adv-trigger-pill adv-trigger-pill-manual',
      title: 'Manual trigger via Run Now button',
    }, 'manual');
    triggerPillsEl.appendChild(manualPill);

    const triggersSection = el('div', { className: 'adv-triggers-section' },
      el('div', { className: 'adv-triggers-row' },
        triggerPillsEl,
        triggerProgressEl,
      ),
    );
    cardBody.appendChild(triggersSection);

    // ── Dedup sensitivity control (DK-130) ────────────────────────────────
    // Segmented control: Low / Medium / High. Controls per-persona keyword overlap
    // threshold for duplicate detection. Stored as integer in Firestore.
    // Default: Medium (3). Writes on change; shows inline "Saved" confirmation.
    const DEDUP_OPTIONS = [
      {
        value: 1,
        label: 'Low',
        description: 'Only near-identical tickets are filtered. May allow near-duplicates through.',
        secondary: 'Low (~1 keyword match)',
      },
      {
        value: 3,
        label: 'Medium',
        description: 'Tickets with significant keyword overlap are filtered. Recommended starting point.',
        secondary: 'Medium (~3 keyword matches)',
      },
      {
        value: 5,
        label: 'High',
        description: 'Any topical overlap triggers filtering. May suppress real issues.',
        secondary: 'High (~5 keyword matches)',
      },
    ];

    const dedupGroupId = `adv-dedup-${id}`;
    const dedupSavedEl = el('span', {
      className: 'adv-interval-saved',
      role: 'status',
      'aria-live': 'polite',
    });
    let dedupSavedTimer = null;

    // Build radio buttons for each sensitivity level
    const dedupRadioButtons = DEDUP_OPTIONS.map((opt) => {
      const radioId = `${dedupGroupId}-${opt.label.toLowerCase()}`;

      // Info icon with tooltip — focusable, one sentence per label
      const tooltipId = `${radioId}-tooltip`;
      const infoIcon = el('button', {
        type: 'button',
        className: 'adv-dedup-tooltip-trigger',
        'aria-label': `Info: ${opt.label} sensitivity`,
        'aria-describedby': tooltipId,
        tabIndex: '0',
        onClick: (e) => {
          e.stopPropagation();
          const tooltip = document.getElementById(tooltipId);
          if (tooltip) {
            const isVisible = tooltip.getAttribute('aria-hidden') === 'false';
            tooltip.setAttribute('aria-hidden', isVisible ? 'true' : 'false');
            tooltip.classList.toggle('adv-dedup-tooltip-visible', !isVisible);
          }
        },
        onBlur: () => {
          const tooltip = document.getElementById(tooltipId);
          if (tooltip) {
            tooltip.setAttribute('aria-hidden', 'true');
            tooltip.classList.remove('adv-dedup-tooltip-visible');
          }
        },
      }, 'ⓘ');

      const tooltip = el('span', {
        className: 'adv-dedup-tooltip',
        id: tooltipId,
        role: 'tooltip',
        'aria-hidden': 'true',
      }, opt.description);

      const radioInput = el('input', {
        type: 'radio',
        className: 'adv-dedup-radio',
        name: dedupGroupId,
        id: radioId,
        value: String(opt.value),
        onChange: () => {
          // Update visual state for all buttons in this group
          const allRadios = dedupRadioRow.querySelectorAll('.adv-dedup-option');
          allRadios.forEach(btn => btn.setAttribute('aria-checked', 'false'));
          optionEl.setAttribute('aria-checked', 'true');
          // Save to Firestore
          this._saveDedupThreshold(id, opt.value, dedupSavedEl, (timer) => {
            if (dedupSavedTimer) clearTimeout(dedupSavedTimer);
            dedupSavedTimer = timer;
          });
        },
      });

      // Visible label showing secondary (numeric) info
      const optionLabel = el('label', {
        className: 'adv-dedup-option-label',
        htmlFor: radioId,
        title: opt.secondary,
      }, opt.label);

      const optionEl = el('span', {
        className: 'adv-dedup-option',
        role: 'radio',
        'aria-checked': opt.value === 3 ? 'true' : 'false', // default Medium
        'aria-label': `${opt.secondary}`,
        onClick: () => {
          radioInput.click();
        },
        onKeyDown: (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            radioInput.click();
          }
        },
        tabIndex: '-1', // tabIndex managed via radioInput for keyboard nav
      },
        radioInput,
        optionLabel,
        infoIcon,
        tooltip,
      );

      return optionEl;
    });

    const dedupLabelEl = el('span', {
      className: 'adv-dedup-label',
      id: `${dedupGroupId}-label`,
    }, 'Dedup:');

    const dedupRadioRow = el('div', {
      className: 'adv-dedup-row',
      role: 'radiogroup',
      'aria-labelledby': `${dedupGroupId}-label`,
    },
      dedupLabelEl,
      el('span', { className: 'adv-dedup-options' }, ...dedupRadioButtons),
      dedupSavedEl,
    );

    const dedupLatencyNote = el('span', {
      className: 'adv-dedup-latency-note',
    }, 'Changes take effect on the next advisor cycle.');

    const dedupRow = el('div', { className: 'adv-dedup-section' },
      dedupRadioRow,
      dedupLatencyNote,
    );
    cardBody.appendChild(dedupRow);

    // ── Secondary actions row: [Preview Run] ──
    // Separated from schedule controls to reduce cognitive load on the main footer.
    // Placed below schedule for less visual prominence.
    const secondaryActionsRow = el('div', {
      className: 'adv-secondary-actions-row',
    },
      previewRunBtn,
    );
    cardBody.appendChild(secondaryActionsRow);

    // Dry-run panel goes below the schedule footer, still inside the card body.
    // Hidden by default; shown when user clicks "Preview Run".
    cardBody.appendChild(dryRunPanel);

    // ── Performance subsection (collapsible) ───────────────────
    // Starts collapsed by default (expanded key absent from set)
    const perfSectionKey = `${id}:performance`;
    const perfSectionExpanded = this._collapsedCardSections.has(perfSectionKey);
    const perfChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, perfSectionExpanded ? '▾' : '▸');
    const perfSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(perfSectionExpanded),
      'aria-controls': `adv-perf-section-${id}`,
      onClick: () => this._toggleCardSection(perfSectionKey, perfSectionBody, perfChevron, perfSectionHeader),
    },
      perfChevron,
      el('span', {}, 'Performance'),
    );
    cardBody.appendChild(perfSectionHeader);

    const perfSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-perf-section-${id}`,
    });
    if (!perfSectionExpanded) perfSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(perfSectionBody);

    // ── Stats row ──────────────────────────────────────────────
    const ticketsEl = el('span', { className: 'adv-stat-val' }, '0');
    const cyclesEl  = el('span', { className: 'adv-stat-val' }, '0');

    perfSectionBody.appendChild(
      el('div', { className: 'adv-stats' },
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Tickets '),
          ticketsEl,
        ),
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Cycles '),
          cyclesEl,
        ),
        statsBtn,
      )
    );

    // ── Feedback injection toggle ──────────────────────────────
    // "Use my decisions to improve proposals." toggle, defaults on.
    // Adjacent to interval controls per spec.
    const feedbackToggleId = `adv-feedback-toggle-${id}`;
    const feedbackToggleCheckbox = el('input', {
      type: 'checkbox',
      className: 'adv-feedback-toggle-checkbox',
      id: feedbackToggleId,
      checked: true,
      'aria-describedby': `adv-feedback-toggle-status-${id}`,
      onChange: () => this._saveFeedbackToggle(id, feedbackToggleCheckbox.checked),
    });
    const feedbackToggleStatusEl = el('span', {
      className: 'adv-feedback-toggle-status',
      id: `adv-feedback-toggle-status-${id}`,
      'aria-live': 'polite',
    }, 'Feedback injection: on');

    const feedbackToggleRow = el('div', { className: 'adv-feedback-toggle-row' },
      el('label', {
        className: 'adv-feedback-toggle-label',
        htmlFor: feedbackToggleId,
      },
        feedbackToggleCheckbox,
        el('span', { className: 'adv-feedback-toggle-text' }, 'Use my decisions to improve proposals'),
      ),
      feedbackToggleStatusEl,
    );
    perfSectionBody.appendChild(feedbackToggleRow);

    // ── Feedback stat row ──────────────────────────────────────
    // Collapsed by default. Shows accepted/rejected counts per spec.
    // Expands to show top rejected categories with signal framing.
    const feedbackStatSummaryEl = el('span', { className: 'adv-feedback-stat-summary' }, '');
    const feedbackStatExpandBtn = el('button', {
      className: 'adv-feedback-stat-expand',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `adv-feedback-detail-${id}`,
    }, '▸');

    const feedbackStatRow = el('div', {
      className: 'adv-feedback-stat-row',
      role: 'button',
      tabindex: '0',
      onClick: () => this._toggleFeedbackDetail(id),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._toggleFeedbackDetail(id);
        }
      },
    },
      feedbackStatExpandBtn,
      el('span', { className: 'adv-feedback-stat-label' }, `${label}: `),
      feedbackStatSummaryEl,
    );

    const feedbackDetailEl = el('div', {
      className: 'adv-feedback-detail adv-hidden',
      id: `adv-feedback-detail-${id}`,
    });

    perfSectionBody.appendChild(feedbackStatRow);
    perfSectionBody.appendChild(feedbackDetailEl);

    // ── Exclusion list (Engineer: glob patterns, Design: URL patterns) ──
    // Only shown for personas that scan files (engineer) or URLs (design).
    // Product persona is out of scope per spec.
    let exclusionSectionEl = null;
    let exclusionTagListEl = null;
    let exclusionInputEl = null;
    let exclusionValidationEl = null;
    let exclusionAddBtn = null;
    let exclusionSkipCountEl = null;

    if (id === 'engineer' || id === 'design') {
      const isEngineer = id === 'engineer';
      const exclusionSectionId = `adv-exclusion-section-${id}`;
      const exclusionInputId = `adv-exclusion-input-${id}`;
      const exclusionLabel = isEngineer ? 'File exclusions' : 'URL exclusions';
      const exclusionPlaceholder = isEngineer ? 'e.g. vendor/**, legacy/**' : 'e.g. https://example.com/admin/';
      const exclusionHint = isEngineer
        ? 'Glob patterns — files/dirs this persona will always skip.'
        : 'URL prefixes — pages this persona will always skip.';

      // Visible label for the input (not placeholder-only per a11y spec)
      const exclusionLabelEl = el('label', {
        className: 'adv-exclusion-label',
        htmlFor: exclusionInputId,
      }, exclusionLabel);

      // Live validation output — uses aria-live="polite" per a11y spec
      exclusionValidationEl = el('span', {
        className: 'adv-exclusion-validation',
        role: 'status',
        'aria-live': 'polite',
      });

      exclusionInputEl = el('input', {
        type: 'text',
        id: exclusionInputId,
        className: 'adv-exclusion-input',
        placeholder: exclusionPlaceholder,
        maxLength: 200,
        'aria-label': exclusionLabel,
        'aria-describedby': `adv-exclusion-validation-${id}`,
        onInput: () => this._validateExclusionInput(id, exclusionInputEl, exclusionValidationEl),
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._addExclusion(id, exclusionInputEl, exclusionValidationEl);
          }
        },
      });
      exclusionValidationEl.id = `adv-exclusion-validation-${id}`;

      exclusionAddBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-add-btn',
        title: `Add ${isEngineer ? 'glob' : 'URL'} exclusion pattern`,
        onClick: () => this._addExclusion(id, exclusionInputEl, exclusionValidationEl),
      }, 'Add');

      // Tag list — shows current exclusion patterns as deletable tags
      exclusionTagListEl = el('div', {
        className: 'adv-exclusion-tag-list',
        role: 'list',
        'aria-label': `Active ${exclusionLabel.toLowerCase()}`,
      });

      // Suppression counter — "N skipped this week" (loaded from advisorRuns)
      exclusionSkipCountEl = el('div', {
        className: 'adv-exclusion-skip-count adv-hidden',
        'aria-live': 'polite',
      });

      exclusionSectionEl = el('div', {
        className: 'adv-exclusion-section',
        id: exclusionSectionId,
      },
        el('div', { className: 'adv-exclusion-hint' }, exclusionHint),
        exclusionTagListEl,
        el('div', { className: 'adv-exclusion-input-row' },
          exclusionLabelEl,
          exclusionInputEl,
          exclusionAddBtn,
        ),
        exclusionValidationEl,
        exclusionSkipCountEl,
      );

      perfSectionBody.appendChild(exclusionSectionEl);
    }

    // ── DK-101: Focus Areas ────────────────────────────────────
    // Collapsible section per persona. Collapsed by default; shows a summary
    // chip in the header when constraints are active.
    // Engineer: includePaths + excludePaths (chip inputs, glob patterns)
    // Design: urlPatterns (chip inputs, relative paths only)
    // Product: targetSegment + businessGoal (plain text fields, max 200 chars)
    let focusAreasSectionEl = null;
    let focusAreasChipData = {}; // { fieldKey: HTMLElement } for chip lists
    let focusAreasInputs = {};   // { fieldKey: HTMLInputElement | HTMLTextAreaElement }
    let focusAreasSummaryChipEl = null; // header chip "N constraints active"
    let focusAreasSectionOpen = false;

    const FOCUS_AREAS_PERSONAS = new Set(['engineer', 'design', 'product']);
    if (FOCUS_AREAS_PERSONAS.has(id)) {
      const focusSectionId = `adv-focus-areas-${id}`;
      const focusSectionBodyId = `adv-focus-areas-body-${id}`;

      // ── Summary chip (shown in header when any constraint active) ──
      focusAreasSummaryChipEl = el('span', {
        className: 'adv-focus-areas-summary-chip adv-hidden',
        'aria-label': 'Focus area constraints active',
        title: 'Scope constraints are narrowing this persona\'s analysis',
      });

      // ── Collapse toggle ──
      const focusAreasToggle = el('button', {
        type: 'button',
        className: 'adv-focus-areas-toggle',
        'aria-expanded': 'false',
        'aria-controls': focusSectionBodyId,
        id: focusSectionId,
        onClick: () => {
          focusAreasSectionOpen = !focusAreasSectionOpen;
          focusAreasToggle.setAttribute('aria-expanded', String(focusAreasSectionOpen));
          focusAreasSectionBodyEl.classList.toggle('adv-hidden', !focusAreasSectionOpen);
          focusAreasToggle.textContent = focusAreasSectionOpen ? 'Focus Areas ▾' : 'Focus Areas ▸';
        },
      }, 'Focus Areas ▸');

      // ── Section body ──
      const focusAreasFields = [];

      if (id === 'engineer') {
        // includePaths chip input
        const includeListEl = el('div', {
          className: 'adv-focus-areas-chip-list',
          role: 'list',
          'aria-label': 'Active include paths',
        });
        focusAreasChipData['includePaths'] = includeListEl;

        const includeInputId = `adv-focus-areas-include-${id}`;
        const includeInputEl = el('input', {
          type: 'text',
          id: includeInputId,
          className: 'adv-focus-areas-input',
          placeholder: 'e.g. src/payments',
          maxlength: '200',
          'aria-label': 'Add include path',
        });
        focusAreasInputs['includePaths'] = includeInputEl;

        includeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addFocusAreaChip(id, 'includePaths', includeInputEl); }
          if (e.key === 'Backspace' && !includeInputEl.value) { e.preventDefault(); this._removeLastFocusAreaChip(id, 'includePaths'); }
        });

        const includeAddBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-add-btn',
          title: 'Add include path',
          onClick: () => this._addFocusAreaChip(id, 'includePaths', includeInputEl),
        }, 'Add');

        const excludeListEl = el('div', {
          className: 'adv-focus-areas-chip-list',
          role: 'list',
          'aria-label': 'Active exclude paths',
        });
        focusAreasChipData['excludePaths'] = excludeListEl;

        const excludeInputId = `adv-focus-areas-exclude-${id}`;
        const excludeInputEl = el('input', {
          type: 'text',
          id: excludeInputId,
          className: 'adv-focus-areas-input',
          placeholder: 'e.g. src/__tests__',
          maxlength: '200',
          'aria-label': 'Add exclude path',
        });
        focusAreasInputs['excludePaths'] = excludeInputEl;

        excludeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addFocusAreaChip(id, 'excludePaths', excludeInputEl); }
          if (e.key === 'Backspace' && !excludeInputEl.value) { e.preventDefault(); this._removeLastFocusAreaChip(id, 'excludePaths'); }
        });

        const excludeAddBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-add-btn',
          title: 'Add exclude path',
          onClick: () => this._addFocusAreaChip(id, 'excludePaths', excludeInputEl),
        }, 'Add');

        focusAreasFields.push(
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: includeInputId }, 'Include paths'),
            el('div', { className: 'adv-focus-areas-hint' }, 'Relative to project root. Glob patterns supported. Empty = scan everything.'),
            includeListEl,
            el('div', { className: 'adv-focus-areas-input-row' },
              includeInputEl,
              includeAddBtn,
            ),
          ),
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: excludeInputId }, 'Exclude paths'),
            el('div', { className: 'adv-focus-areas-hint' }, 'Relative to project root. Glob patterns supported.'),
            excludeListEl,
            el('div', { className: 'adv-focus-areas-input-row' },
              excludeInputEl,
              excludeAddBtn,
            ),
          ),
        );
      } else if (id === 'design') {
        // urlPatterns chip input
        const urlListEl = el('div', {
          className: 'adv-focus-areas-chip-list',
          role: 'list',
          'aria-label': 'Active URL patterns',
        });
        focusAreasChipData['urlPatterns'] = urlListEl;

        const urlInputId = `adv-focus-areas-url-${id}`;
        const urlInputEl = el('input', {
          type: 'text',
          id: urlInputId,
          className: 'adv-focus-areas-input',
          placeholder: 'e.g. /checkout/**',
          maxlength: '200',
          'aria-label': 'Add URL pattern',
        });
        focusAreasInputs['urlPatterns'] = urlInputEl;

        urlInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addFocusAreaChip(id, 'urlPatterns', urlInputEl); }
          if (e.key === 'Backspace' && !urlInputEl.value) { e.preventDefault(); this._removeLastFocusAreaChip(id, 'urlPatterns'); }
        });

        const urlAddBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-add-btn',
          title: 'Add URL pattern',
          onClick: () => this._addFocusAreaChip(id, 'urlPatterns', urlInputEl),
        }, 'Add');

        focusAreasFields.push(
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: urlInputId }, 'URL patterns'),
            el('div', { className: 'adv-focus-areas-hint' }, 'Relative paths only — e.g. /checkout/**, /login. No scheme or hostname.'),
            urlListEl,
            el('div', { className: 'adv-focus-areas-input-row' },
              urlInputEl,
              urlAddBtn,
            ),
          ),
        );
      } else if (id === 'product') {
        // targetSegment text field (single line, max 200)
        const segmentInputId = `adv-focus-areas-segment-${id}`;
        const segmentInputEl = el('input', {
          type: 'text',
          id: segmentInputId,
          className: 'adv-focus-areas-text-input',
          placeholder: 'e.g. SMB users',
          maxlength: '200',
          'aria-label': 'Target segment',
        });
        focusAreasInputs['targetSegment'] = segmentInputEl;

        // businessGoal text field (single line, max 200)
        const goalInputId = `adv-focus-areas-goal-${id}`;
        const goalInputEl = el('input', {
          type: 'text',
          id: goalInputId,
          className: 'adv-focus-areas-text-input',
          placeholder: 'e.g. reduce churn',
          maxlength: '200',
          'aria-label': 'Business goal',
        });
        focusAreasInputs['businessGoal'] = goalInputEl;

        // Save button for product (chip-style inputs save on add; text fields need explicit save)
        const productFocusSaveStatusEl = el('span', {
          className: 'adv-focus-areas-save-status',
          role: 'status',
          'aria-live': 'polite',
        });
        focusAreasInputs['_saveStatusEl'] = productFocusSaveStatusEl;

        const productFocusSaveBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-save-btn',
          onClick: () => this._saveProductFocusAreas(id),
        }, 'Save');

        focusAreasFields.push(
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: segmentInputId }, 'Target segment'),
            el('div', { className: 'adv-focus-areas-hint' }, 'e.g. "enterprise users" — prepended as context to each run.'),
            segmentInputEl,
          ),
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: goalInputId }, 'Business goal'),
            el('div', { className: 'adv-focus-areas-hint' }, 'e.g. "reduce churn" — prepended as context to each run.'),
            goalInputEl,
          ),
          el('div', { className: 'adv-focus-areas-actions' },
            productFocusSaveBtn,
            productFocusSaveStatusEl,
            el('span', { className: 'adv-focus-areas-next-run-note' }, 'Applies on next scheduled run.'),
          ),
        );
      }

      const focusAreasNote = el('div', { className: 'adv-focus-areas-note' },
        'Changes apply on the next scheduled run.',
      );

      const focusAreasSectionBodyEl = el('div', {
        className: 'adv-focus-areas-body adv-hidden',
        id: focusSectionBodyId,
      },
        ...focusAreasFields,
        id !== 'product' ? focusAreasNote : null,
      );

      focusAreasSectionEl = el('div', { className: 'adv-focus-areas-section' },
        el('div', { className: 'adv-focus-areas-header' },
          focusAreasToggle,
          focusAreasSummaryChipEl,
        ),
        focusAreasSectionBodyEl,
      );

      // Store refs for render updates
      this._focusAreasState = this._focusAreasState || {};
      this._focusAreasState[id] = {
        sectionEl: focusAreasSectionEl,
        bodyEl: focusAreasSectionBodyEl,
        toggleEl: focusAreasToggle,
        summaryChipEl: focusAreasSummaryChipEl,
        chipData: focusAreasChipData,
        inputs: focusAreasInputs,
      };

      perfSectionBody.appendChild(focusAreasSectionEl);
    }

    // ── DK-124: Focus area pinning ──────────────────────────────
    // Shown for engineer and design only (product has no file/URL mappings).
    // Engineer: file glob patterns — pinned files appear first in the scan list.
    // Design: URL path patterns — pinned URLs appear first in the screenshot queue.
    // Save on explicit button press (not on keystroke/blur) — changes affect agent behavior.
    // Data: stored at project.advisorPins.{engineer|design} as string[].
    const PINS_PERSONAS = new Set(['engineer', 'design']);
    if (PINS_PERSONAS.has(id)) {
      const pinsSectionId = `adv-pins-section-${id}`;
      const pinsBodyId = `adv-pins-body-${id}`;
      let pinsSectionOpen = false;

      // Per-persona metadata
      const pinsMeta = id === 'engineer'
        ? {
            label: 'Focus areas',
            inputLabel: 'Pinned file globs',
            placeholder: 'e.g. src/payments/**',
            hint: 'Relative globs only — these paths run first. The full codebase is still included.',
            addAriaLabel: 'Add pinned file glob',
            chipAriaLabel: 'Active pinned file globs',
            maxLen: 64,
          }
        : {
            label: 'Focus areas',
            inputLabel: 'Pinned URL paths',
            placeholder: '/checkout',
            hint: 'Relative paths starting with /. These pages are screenshotted first. The full audit still runs.',
            addAriaLabel: 'Add pinned URL path',
            chipAriaLabel: 'Active pinned URL paths',
            maxLen: 200,
          };

      // Summary chip (shown in header when any pin is active)
      const pinsSummaryChipEl = el('span', {
        className: 'adv-pins-summary-chip adv-hidden',
        'aria-label': 'Focus area pins active',
        title: 'This persona will prioritize your pinned paths on each run',
      });

      // Collapse toggle
      const pinsToggleBtn = el('button', {
        type: 'button',
        className: 'adv-pins-toggle',
        'aria-expanded': 'false',
        'aria-controls': pinsBodyId,
        id: pinsSectionId,
        onClick: () => {
          pinsSectionOpen = !pinsSectionOpen;
          pinsToggleBtn.setAttribute('aria-expanded', String(pinsSectionOpen));
          pinsBodyEl.classList.toggle('adv-hidden', !pinsSectionOpen);
          pinsToggleBtn.textContent = pinsSectionOpen ? `${pinsMeta.label} ▾` : `${pinsMeta.label} ▸`;
        },
      }, `${pinsMeta.label} ▸`);

      // Chip list (read-only display; remove is via delete button on each chip)
      const pinsChipListEl = el('div', {
        className: 'adv-pins-chip-list',
        role: 'list',
        'aria-label': pinsMeta.chipAriaLabel,
      });

      // Validation message element
      const pinsValidationEl = el('span', {
        className: 'adv-pins-validation',
        role: 'status',
        'aria-live': 'polite',
      });

      // Text input
      const pinsInputId = `adv-pins-input-${id}`;
      const pinsInputEl = el('input', {
        type: 'text',
        id: pinsInputId,
        className: 'adv-pins-input',
        placeholder: pinsMeta.placeholder,
        maxlength: String(pinsMeta.maxLen),
        'aria-label': pinsMeta.addAriaLabel,
        'aria-describedby': `adv-pins-validation-${id}`,
      });
      pinsValidationEl.id = `adv-pins-validation-${id}`;

      pinsInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._addPinsChip(id, pinsInputEl, pinsValidationEl);
        }
        if (e.key === 'Backspace' && !pinsInputEl.value) {
          e.preventDefault();
          this._removeLastPinsChip(id, pinsValidationEl);
        }
      });

      // Add button
      const pinsAddBtn = el('button', {
        type: 'button',
        className: 'adv-pins-add-btn',
        title: pinsMeta.addAriaLabel,
        onClick: () => this._addPinsChip(id, pinsInputEl, pinsValidationEl),
      }, 'Add');

      // Save button + status
      const pinsSaveStatusEl = el('span', {
        className: 'adv-pins-save-status',
        role: 'status',
        'aria-live': 'polite',
      });
      const pinsSaveBtn = el('button', {
        type: 'button',
        className: 'adv-pins-save-btn',
        title: 'Save pinned focus areas',
        onClick: () => this._savePins(id),
      }, 'Save');

      // Staleness warning — surfaced when a pin target no longer exists
      const pinsStaleEl = el('div', {
        className: 'adv-pins-stale adv-hidden',
        role: 'status',
        'aria-live': 'polite',
      });

      // "Weighted, not exclusive" callout — conveyed in text per accessibility requirement
      const pinsWeightNote = el('div', { className: 'adv-pins-weight-note' },
        'These paths run first — the full codebase is still included.',
      );

      // Section body
      const pinsBodyEl = el('div', {
        className: 'adv-pins-body adv-hidden',
        id: pinsBodyId,
      },
        pinsStaleEl,
        el('div', { className: 'adv-pins-field' },
          el('label', { className: 'adv-pins-label', htmlFor: pinsInputId }, pinsMeta.inputLabel),
          el('div', { className: 'adv-pins-hint' }, pinsMeta.hint),
          pinsChipListEl,
          el('div', { className: 'adv-pins-input-row' },
            pinsInputEl,
            pinsAddBtn,
          ),
          pinsValidationEl,
        ),
        pinsWeightNote,
        el('div', { className: 'adv-pins-actions' },
          pinsSaveBtn,
          pinsSaveStatusEl,
        ),
        el('div', { className: 'adv-focus-areas-note' }, 'Applies on next scheduled run.'),
      );

      const pinsSectionEl = el('div', { className: 'adv-pins-section' },
        el('div', { className: 'adv-pins-header' },
          pinsToggleBtn,
          pinsSummaryChipEl,
        ),
        pinsBodyEl,
      );

      // Store refs
      this._pinsState = this._pinsState || {};
      this._pinsState[id] = {
        sectionEl: pinsSectionEl,
        bodyEl: pinsBodyEl,
        toggleEl: pinsToggleBtn,
        summaryChipEl: pinsSummaryChipEl,
        chipListEl: pinsChipListEl,
        inputEl: pinsInputEl,
        saveBtn: pinsSaveBtn,
        saveStatusEl: pinsSaveStatusEl,
        stalenessEl: pinsStaleEl,
        validationEl: pinsValidationEl,
      };
      this._pinsDraft[id] = [];

      perfSectionBody.appendChild(pinsSectionEl);
    }

    // ── DK-187: Persona focus constraints (scope targeting) ────
    // Only shown for engineer, design, and product personas.
    // Focus is per-persona (not per-project): stored at /advisor/{personaId}.focus
    // and validated server-side on every daemon read.
    const FOCUS_CONSTRAINTS_PERSONAS = new Set(['engineer', 'design', 'product']);
    if (FOCUS_CONSTRAINTS_PERSONAS.has(id)) {
      const fcSectionId = `adv-fc-section-${id}`;
      const fcBodyId = `adv-fc-body-${id}`;
      let fcSectionOpen = false;
      let fcDirty = false;

      // Label and placeholder vary per persona
      const fcMeta = {
        engineer: {
          label: 'Prompt Focus: File Globs',
          placeholder: 'e.g. src/payments/**',
          hint: 'Glob patterns (relative). Empty = analyse all files.',
          summaryUnit: 'glob',
        },
        design: {
          label: 'Prompt Focus: Route Paths',
          placeholder: 'e.g. /checkout',
          hint: 'Route paths starting with /. Empty = audit all routes.',
          summaryUnit: 'route',
        },
        product: {
          label: 'Prompt Focus: Keywords',
          placeholder: 'e.g. billing',
          hint: 'Feature keywords. Empty = surface ideas across all areas.',
          summaryUnit: 'keyword',
        },
      }[id];

      const fcFieldKey = { engineer: 'globs', design: 'routes', product: 'keywords' }[id];

      // Summary chip shown in header when focus is active
      const fcSummaryChipEl = el('span', {
        className: 'adv-fc-summary-chip adv-hidden',
        title: `Prompt focus constraints are active for this persona`,
      });

      // Chip list
      const fcChipListEl = el('div', {
        className: 'adv-focus-areas-chip-list',
        role: 'list',
        'aria-label': `Active ${fcMeta.summaryUnit}s`,
      });

      // Text input
      const fcInputId = `adv-fc-input-${id}`;
      const fcInputEl = el('input', {
        type: 'text',
        id: fcInputId,
        className: 'adv-focus-areas-input',
        placeholder: fcMeta.placeholder,
        maxlength: id === 'product' ? '50' : '100',
        'aria-label': `Add ${fcMeta.summaryUnit}`,
      });

      // Mark dirty on input
      fcInputEl.addEventListener('input', () => {
        if (!fcDirty) {
          fcDirty = true;
          if (this._focusConstraintsState[id]) this._focusConstraintsState[id].dirty = true;
          const { saveBtn } = this._focusConstraintsState[id] || {};
          if (saveBtn) saveBtn.classList.add('adv-fc-save-dirty');
        }
      });

      // Enter to add, Backspace on empty to remove last chip
      fcInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._addFocusConstraintChip(id, fcInputEl); }
        if (e.key === 'Backspace' && !fcInputEl.value) { e.preventDefault(); this._removeLastFocusConstraintChip(id); }
      });

      // Add button
      const fcAddBtn = el('button', {
        type: 'button',
        className: 'adv-focus-areas-add-btn',
        title: `Add ${fcMeta.summaryUnit}`,
        onClick: () => this._addFocusConstraintChip(id, fcInputEl),
      }, 'Add');

      // Save button + status
      const fcSaveStatusEl = el('span', {
        className: 'adv-fc-save-status',
        role: 'status',
        'aria-live': 'polite',
      });
      const fcSaveBtn = el('button', {
        type: 'button',
        className: 'adv-fc-save-btn',
        title: 'Save focus constraints',
        onClick: () => this._saveFocusConstraints(id),
      }, 'Save');

      // Clear button (one-click return to unconstrained mode)
      const fcClearBtn = el('button', {
        type: 'button',
        className: 'adv-fc-clear-btn',
        title: 'Clear all focus constraints — return to watching everything',
        onClick: () => this._clearFocusConstraints(id),
      }, 'Clear focus');

      // Collapse toggle
      const fcToggleBtn = el('button', {
        type: 'button',
        className: 'adv-fc-toggle',
        'aria-expanded': 'false',
        'aria-controls': fcBodyId,
        id: fcSectionId,
        onClick: () => {
          fcSectionOpen = !fcSectionOpen;
          fcToggleBtn.setAttribute('aria-expanded', String(fcSectionOpen));
          fcBodyEl.classList.toggle('adv-hidden', !fcSectionOpen);
          fcToggleBtn.textContent = fcSectionOpen ? 'Focus… ▾' : 'Focus… ▸';
          if (fcSectionOpen && this._mounted) {
            // Move focus into input when expanding (accessibility spec)
            setTimeout(() => fcInputEl.focus(), 50);
          }
        },
      }, 'Focus… ▸');

      // Body
      const fcBodyEl = el('div', {
        className: 'adv-fc-body adv-hidden',
        id: fcBodyId,
      },
        el('div', { className: 'adv-focus-areas-field' },
          el('label', { className: 'adv-focus-areas-label', htmlFor: fcInputId }, fcMeta.label),
          el('div', { className: 'adv-focus-areas-hint' }, fcMeta.hint),
          fcChipListEl,
          el('div', { className: 'adv-focus-areas-input-row' },
            fcInputEl,
            fcAddBtn,
          ),
        ),
        el('div', { className: 'adv-fc-actions' },
          fcSaveBtn,
          fcClearBtn,
          fcSaveStatusEl,
        ),
        el('div', { className: 'adv-focus-areas-note' }, 'Applies on next scheduled run.'),
      );

      const fcSectionEl = el('div', { className: 'adv-fc-section' },
        el('div', { className: 'adv-fc-header' },
          fcToggleBtn,
          fcSummaryChipEl,
        ),
        fcBodyEl,
      );

      // Store refs
      this._focusConstraintsState = this._focusConstraintsState || {};
      this._focusConstraintsState[id] = {
        sectionEl: fcSectionEl,
        bodyEl: fcBodyEl,
        toggleEl: fcToggleBtn,
        summaryChipEl: fcSummaryChipEl,
        chipListEl: fcChipListEl,
        inputEl: fcInputEl,
        saveBtn: fcSaveBtn,
        saveStatusEl: fcSaveStatusEl,
        clearBtn: fcClearBtn,
        fieldKey: fcFieldKey,
        dirty: false,
      };

      perfSectionBody.appendChild(fcSectionEl);
    }

    // ── DK-112: Topic Exclusion Rules ─────────────────────────
    // Shown for engineer, design, and product personas.
    // Lets users define a list of topics this persona should never propose.
    // Stored at project.advisor.topicExclusions.{personaId} as string[].
    // Injected into the system prompt at runtime by prompt-builder.js.
    let topicExclTagListEl = null;
    let topicExclInputEl = null;
    let topicExclValidationEl = null;
    let topicExclAddBtn = null;
    let topicExclSectionEl = null;

    const TOPIC_EXCL_PERSONAS = new Set(['engineer', 'design', 'product']);
    if (TOPIC_EXCL_PERSONAS.has(id)) {
      const texSectionId = `adv-tex-section-${id}`;
      const texInputId = `adv-tex-input-${id}`;

      topicExclValidationEl = el('span', {
        className: 'adv-exclusion-validation',
        role: 'status',
        'aria-live': 'polite',
        id: `adv-tex-validation-${id}`,
      });

      topicExclInputEl = el('input', {
        type: 'text',
        id: texInputId,
        className: 'adv-exclusion-input',
        placeholder: 'e.g. dark mode, authentication, onboarding',
        maxLength: 100,
        'aria-label': 'Add topic exclusion rule',
        'aria-describedby': `adv-tex-validation-${id}`,
        onInput: () => this._validateTopicExclInput(topicExclInputEl, topicExclValidationEl),
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._addTopicExclusion(id, topicExclInputEl, topicExclValidationEl);
          }
        },
      });

      topicExclAddBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-add-btn',
        title: 'Add topic exclusion rule',
        onClick: () => this._addTopicExclusion(id, topicExclInputEl, topicExclValidationEl),
      }, 'Add');

      topicExclTagListEl = el('div', {
        className: 'adv-exclusion-tag-list',
        role: 'list',
        'aria-label': 'Active topic exclusion rules',
      });

      // Cold start placeholder — shown when rules list is empty
      const topicExclEmptyEl = el('span', {
        className: 'adv-exclusion-empty adv-tex-empty',
      }, 'No exclusion rules set. The fastest way to add rules is via the "Never suggest" button on proposal cards in the triage queue.');

      topicExclTagListEl.appendChild(topicExclEmptyEl);

      topicExclSectionEl = el('div', {
        className: 'adv-exclusion-section adv-tex-section',
        id: texSectionId,
      },
        el('div', { className: 'adv-exclusion-hint' },
          'Topics this persona should never propose. Plain keywords or short phrases — no globs or regex.',
        ),
        topicExclTagListEl,
        el('div', { className: 'adv-exclusion-input-row' },
          el('label', { className: 'adv-exclusion-label', htmlFor: texInputId }, 'Topic exclusions'),
          topicExclInputEl,
          topicExclAddBtn,
        ),
        topicExclValidationEl,
      );

      perfSectionBody.appendChild(topicExclSectionEl);
    }

    // ── DK-105: Emphasis weights ───────────────────────────────
    // Only shown for the three built-in advisor personas that support weights.
    // (QA persona is out of scope for v1.)
    const weightConcerns = PERSONA_CONCERNS[id];
    if (weightConcerns) {
      const weightSectionId = `adv-weights-section-${id}`;
      const weightHeadingId = `adv-weights-heading-${id}`;

      // Default weights (all 1) — used until project data loads or overrides
      const defaultWeights = Object.fromEntries(weightConcerns.map(k => [k, 1]));
      this._weightsDraft[id] = { ...defaultWeights };
      this._weightsInputs[id] = {};

      // ── Summary line (plain-language description of current weights) ──
      const weightSummaryEl = el('p', {
        className: 'adv-weights-summary',
        role: 'status',
        'aria-live': 'polite',
      }, buildWeightSummary(defaultWeights, id));
      this._weightsSummaryEls[id] = weightSummaryEl;

      // ── Cross-persona note (one line of helper text per spec) ──
      const crossPersonaNote = el('p', { className: 'adv-weights-cross-persona-note' },
        'These weights apply within this persona only — they do not affect other personas\u2019 output or global ticket ordering.',
      );

      // ── Preset profile buttons ──────────────────────────────
      const presets = WEIGHT_PRESETS[id] || [];
      const presetRow = el('div', { className: 'adv-weights-preset-row', role: 'group', 'aria-label': 'Preset profiles' });
      for (const preset of presets) {
        const presetBtn = el('button', {
          type: 'button',
          className: 'adv-weights-preset-btn',
          title: `Apply "${preset.label}" preset`,
          onClick: () => {
            // Apply preset to draft and update inputs
            for (const k of weightConcerns) {
              const v = preset.weights[k] ?? 1;
              this._weightsDraft[id][k] = v;
              const inp = this._weightsInputs[id]?.[k];
              if (inp) inp.value = String(v);
            }
            // Regenerate summary
            if (this._weightsSummaryEls[id]) {
              this._weightsSummaryEls[id].textContent = buildWeightSummary(this._weightsDraft[id], id);
            }
          },
        }, preset.label);
        presetRow.appendChild(presetBtn);
      }

      // ── Concern rows (numeric input + label + description) ───
      const concernsContainer = el('div', { className: 'adv-weights-concerns' });
      for (const key of weightConcerns) {
        const meta = CONCERN_META[key] || { label: key, desc: '' };
        const inputId = `adv-weight-${id}-${key}`;
        const numInput = el('input', {
          type: 'number',
          className: 'adv-weight-input',
          id: inputId,
          min: '1',
          max: '5',
          value: '1',
          'aria-label': `${meta.label} weight (1–5)`,
          title: meta.desc,
          onInput: () => {
            const v = parseInt(numInput.value, 10);
            if (Number.isInteger(v) && v >= 1 && v <= 5) {
              this._weightsDraft[id][key] = v;
              // Update summary live
              if (this._weightsSummaryEls[id]) {
                this._weightsSummaryEls[id].textContent = buildWeightSummary(this._weightsDraft[id], id);
              }
            }
          },
        });
        this._weightsInputs[id][key] = numInput;

        // Text label (High/Medium/Low) adjacent to input — accessibility requirement
        const weightLevelEl = el('span', { className: 'adv-weight-level-label', 'aria-hidden': 'true' });
        numInput.addEventListener('input', () => {
          const v = parseInt(numInput.value, 10);
          weightLevelEl.textContent = v >= 4 ? 'High' : v === 3 ? 'Medium' : 'Low';
        });
        // Initialize
        weightLevelEl.textContent = 'Low';

        concernsContainer.appendChild(
          el('div', { className: 'adv-weight-row' },
            numInput,
            weightLevelEl,
            el('label', { htmlFor: inputId, className: 'adv-weight-label' },
              el('strong', {}, meta.label),
              el('span', { className: 'adv-weight-desc' }, ` — ${meta.desc}`),
            ),
          )
        );
      }

      // ── Save button + status ─────────────────────────────────
      const weightSaveStatusEl = el('span', {
        className: 'adv-weights-save-status',
        role: 'status',
        'aria-live': 'polite',
      });
      const weightSaveBtn = el('button', {
        type: 'button',
        className: 'adv-weights-save-btn',
        onClick: () => this._saveWeights(id),
      }, 'Save weights');

      // ── Reset button ─────────────────────────────────────────
      const weightResetBtn = el('button', {
        type: 'button',
        className: 'adv-weights-reset-btn',
        title: 'Reset all weights to default (1)',
        onClick: () => {
          for (const k of weightConcerns) {
            this._weightsDraft[id][k] = 1;
            const inp = this._weightsInputs[id]?.[k];
            if (inp) inp.value = '1';
          }
          // Update level labels
          const levelLabels = weightSectionEl.querySelectorAll('.adv-weight-level-label');
          levelLabels.forEach(lbl => { lbl.textContent = 'Low'; });
          if (this._weightsSummaryEls[id]) {
            this._weightsSummaryEls[id].textContent = buildWeightSummary(this._weightsDraft[id], id);
          }
        },
      }, 'Reset to defaults');

      this._weightsSaveEls[id] = { btn: weightSaveBtn, statusEl: weightSaveStatusEl };

      const weightSaveRow = el('div', { className: 'adv-weights-save-row' },
        weightSaveBtn,
        weightResetBtn,
        weightSaveStatusEl,
      );

      const weightSectionEl = el('section', {
        className: 'adv-weights-section',
        id: weightSectionId,
        'aria-labelledby': weightHeadingId,
      },
        el('h4', {
          className: 'adv-weights-heading',
          id: weightHeadingId,
        }, 'Emphasis weights'),
        crossPersonaNote,
        presetRow,
        concernsContainer,
        weightSummaryEl,
        weightSaveRow,
      );

      perfSectionBody.appendChild(weightSectionEl);
    }

    // ── Run summary line ───────────────────────────────────────
    // e.g. "ran 4h ago · 0 proposals"
    const runSummaryEl = el('div', { className: 'adv-run-summary' }, '—');
    perfSectionBody.appendChild(runSummaryEl);

    // ── Performance dashboard expansion ────────────────────────
    const perfDashContainer = el('div', { className: 'adv-perf-dash adv-perf-dash-hidden' });
    perfSectionBody.appendChild(perfDashContainer);
    this._perfDashContainers[id] = perfDashContainer;

    // ── Activity subsection (collapsible) ──────────────────────
    // Starts collapsed by default (expanded key absent from set)
    const actSectionKey = `${id}:activity`;
    const actSectionExpanded = this._collapsedCardSections.has(actSectionKey);
    const actChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, actSectionExpanded ? '▾' : '▸');
    const actSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(actSectionExpanded),
      'aria-controls': `adv-act-section-${id}`,
      onClick: () => this._toggleCardSection(actSectionKey, actSectionBody, actChevron, actSectionHeader),
    },
      actChevron,
      el('span', {}, 'Activity'),
    );
    cardBody.appendChild(actSectionHeader);

    const actSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-act-section-${id}`,
    });
    if (!actSectionExpanded) actSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(actSectionBody);

    // ── Per-card history (collapsed by default) ─────────────────
    const historyToggleBtn = el('button', {
      className: 'adv-card-history-toggle',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `adv-card-history-${id}`,
      onClick: () => this._toggleCardHistory(id),
    }, 'History ▸');

    const historyRefreshBtn = el('button', {
      className: 'adv-history-refresh-btn adv-hidden',
      title: 'Refresh run history',
      'aria-label': 'Refresh history',
      onClick: () => this._loadHistoryRuns(id),
    }, '↺');

    const testRailsBtn = id === 'qa' ? el('button', {
      className: 'adv-card-history-toggle adv-test-rails-btn',
      type: 'button',
      title: 'View and edit QA test rails',
      onClick: () => this._openTestRailsModal(),
    }, 'Test Rails ▸') : null;

    // Inline preview of the saved focus prompt — visible when focus area is collapsed
    // and a saved focus prompt is set. Hidden when expanded or no saved prompt.
    const focusPreviewEl = el('span', {
      className: 'adv-focus-preview adv-hidden',
      'aria-hidden': 'true',
    });

    const historyHeaderRow = el('div', { className: 'adv-card-history-header' },
      focusToggleBtn,
      focusPreviewEl,
      logToggleBtn,
      logClearBtn,
      testRailsBtn,
      historyToggleBtn,
      historyRefreshBtn,
    );

    const historyPanel = el('div', {
      className: 'adv-card-history-panel adv-hidden',
      id: `adv-card-history-${id}`,
    });
    this._historyPanels[id] = historyPanel;

    actSectionBody.appendChild(historyHeaderRow);
    actSectionBody.appendChild(focusArea);
    actSectionBody.appendChild(logContainer);
    actSectionBody.appendChild(historyPanel);

    this._cards[id] = { card, cardBody, collapseBtn, collapsedSummaryEl, avatarEl, statusDot, statusText, soulBtn, constraintsBtn, constraintChipEl, statsBtn, pauseBtn, pauseCheckbox, pauseTextEl, runNowBtn, runPromptExpander, runPromptInput, runPromptSubmitBtn, runPromptCancelBtn, runScopeInput, runScopeNudge, previewRunBtn, runStateEl, timeHintEl, focusTextarea, focusToggleBtn, focusPreviewEl, focusDirtyDot, savedFocusEl, activityEl: null, logToggleBtn, logClearBtn, logContainer, logList, countdownEl: headerCountdownEl, intervalInput, intervalUnitSelect, intervalSavedEl, ticketsEl, cyclesEl, runSummaryEl, historyToggleBtn, historyRefreshBtn, historyPanel, testRailsBtn, feedbackToggleCheckbox, feedbackToggleStatusEl, feedbackToggleRow, feedbackStatSummaryEl, feedbackStatExpandBtn, feedbackStatRow, feedbackDetailEl, capInput, capSavedEl, exclusionSectionEl, exclusionTagListEl, exclusionInputEl, exclusionValidationEl, exclusionAddBtn, exclusionSkipCountEl, dedupRadioRow, dedupSavedEl, lastRunLineEl,
      // DK-195: timezone-aware schedule refs
      tzSelect, startTimeInput, endTimeInput, nextRunEl, noRunsWarningEl,
      // legacy schedule refs (null = replaced by new UI; kept so old checks don't crash)
      startHourSelect: null, endHourSelect: null, dayButtons, timeWindowSavedEl, timeWindowBody, timeWindowToggleBtn,
      // DK-112: topic exclusion rules refs
      topicExclTagListEl, topicExclInputEl, topicExclValidationEl, topicExclAddBtn, topicExclSectionEl,
      // DK-136: trigger pills + progress counter
      intervalPill, webhookPill, manualPill, triggerProgressEl };
    return card;
  }

  // ── Performance dashboard ────────────────────────────────────

  /**
   * Toggle the performance dashboard for a persona.
   * Loads data on first open; subsequent opens use cached data.
   */
  _togglePerfDash(personaId) {
    const isExpanded = !this._perfDashExpanded[personaId];
    this._perfDashExpanded[personaId] = isExpanded;

    const container = this._perfDashContainers[personaId];
    const card = this._cards[personaId];
    if (!container || !card) return;

    if (isExpanded) {
      container.classList.remove('adv-perf-dash-hidden');
      card.statsBtn.textContent = 'Stats ▾';
      card.statsBtn.setAttribute('aria-expanded', 'true');
      // Load data if not already loaded
      if (!this._perfDashData[personaId]) {
        this._loadPerfDash(personaId);
      } else {
        this._renderPerfDash(personaId);
      }
    } else {
      container.classList.add('adv-perf-dash-hidden');
      card.statsBtn.textContent = 'Stats ▸';
      card.statsBtn.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * Load performance data for a persona from Firestore.
   * Uses a collectionGroup query across all projects.
   * Data is not auto-refreshed — user can manually refresh.
   */
  async _loadPerfDash(personaId) {
    this._perfDashLoading[personaId] = true;
    this._renderPerfDash(personaId);

    try {
      const windowMs = this._perfDashWindowDays * 24 * 60 * 60 * 1000;
      // Use a Date object (not an ISO string) for the Firestore range query.
      // tickets.createdAt is stored as a Firestore serverTimestamp (Timestamp type).
      // Firestore cannot compare a Timestamp field against a string value — the
      // query would return empty results. The Firebase compat SDK accepts a JS Date
      // as a valid Timestamp comparator.
      const since = new Date(Date.now() - windowMs);

      // collectionGroup query: tickets across all projects where advisorPersona matches
      const snap = await this.db.collectionGroup('tickets')
        .where('advisorPersona', '==', personaId)
        .where('createdAt', '>=', since)
        .get();

      const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this._perfDashData[personaId] = { tickets, fetchedAt: new Date() };
    } catch (err) {
      console.error(`AdvisorPanel: failed to load perf data for ${personaId}`, err);
      this._perfDashData[personaId] = { tickets: [], fetchedAt: new Date(), error: err.message };
    } finally {
      this._perfDashLoading[personaId] = false;
      this._renderPerfDash(personaId);
    }
  }

  /**
   * Render the performance dashboard into its container.
   * Called after data loads and when the time window changes.
   */
  _renderPerfDash(personaId) {
    const container = this._perfDashContainers[personaId];
    if (!container) return;
    container.innerHTML = '';

    // ── Header row: time filter + refresh ──────────────────────
    const windowDays = this._perfDashWindowDays;
    const make30Btn = el('button', {
      className: 'adv-perf-filter-btn' + (windowDays === 30 ? ' adv-perf-filter-btn-active' : ''),
      'aria-pressed': String(windowDays === 30),
      onClick: () => {
        if (this._perfDashWindowDays !== 30) {
          this._perfDashWindowDays = 30;
          // Clear cached data so it reloads with new window
          for (const pid of Object.keys(this._perfDashExpanded)) {
            if (this._perfDashExpanded[pid]) {
              this._perfDashData[pid] = null;
              this._loadPerfDash(pid);
            }
          }
        }
      },
    }, '30d');

    const make90Btn = el('button', {
      className: 'adv-perf-filter-btn' + (windowDays === 90 ? ' adv-perf-filter-btn-active' : ''),
      'aria-pressed': String(windowDays === 90),
      onClick: () => {
        if (this._perfDashWindowDays !== 90) {
          this._perfDashWindowDays = 90;
          for (const pid of Object.keys(this._perfDashExpanded)) {
            if (this._perfDashExpanded[pid]) {
              this._perfDashData[pid] = null;
              this._loadPerfDash(pid);
            }
          }
        }
      },
    }, '90d');

    const data = this._perfDashData[personaId];
    const isLoading = this._perfDashLoading[personaId];

    // Refresh button + last updated timestamp
    const refreshBtn = el('button', {
      className: 'adv-perf-refresh-btn',
      title: 'Refresh stats',
      disabled: isLoading,
      onClick: () => {
        this._perfDashData[personaId] = null;
        this._loadPerfDash(personaId);
      },
    }, isLoading ? '…' : '↺');

    const fetchedAtStr = data?.fetchedAt
      ? `Updated ${data.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    container.appendChild(
      el('div', { className: 'adv-perf-header' },
        el('div', { className: 'adv-perf-filter-group', role: 'group', 'aria-label': 'Time window' },
          make30Btn,
          make90Btn,
        ),
        el('div', { className: 'adv-perf-refresh-row' },
          el('span', { className: 'adv-perf-updated' }, fetchedAtStr),
          refreshBtn,
        ),
      )
    );

    // ── Loading state ──────────────────────────────────────────
    if (isLoading) {
      container.appendChild(
        el('div', { className: 'adv-perf-loading', 'aria-busy': 'true' },
          el('span', { 'aria-hidden': 'true', className: 'adv-history-spinner' }),
          el('span', {}, 'Loading stats…'),
        )
      );
      return;
    }

    // ── Error state ────────────────────────────────────────────
    if (!data) {
      container.appendChild(
        el('div', { className: 'adv-perf-empty' }, 'Click ↺ to load stats.')
      );
      return;
    }

    if (data.error) {
      container.appendChild(
        el('div', { className: 'adv-perf-error' }, `Could not load stats: ${data.error}`)
      );
      return;
    }

    // ── Cold start check ───────────────────────────────────────
    const personaState = this._states[personaId];
    const cycleCount = personaState?.cycleCount ?? 0;
    const MIN_CYCLES = 5;

    if (cycleCount < MIN_CYCLES) {
      container.appendChild(
        el('div', { className: 'adv-perf-cold-start' },
          el('span', { className: 'adv-perf-cold-icon', 'aria-hidden': 'true' }, '🌱'),
          el('p', { className: 'adv-perf-cold-msg' },
            `Not enough data yet. ${cycleCount} of ${MIN_CYCLES} cycles completed. ` +
            `Stats will appear once this persona has run at least ${MIN_CYCLES} times.`
          ),
        )
      );
      return;
    }

    const tickets = data.tickets;
    const stats = computeStats(tickets);

    // ── Health indicator ───────────────────────────────────────
    const acceptanceRate = stats.generated > 0 ? stats.accepted / stats.generated : 0;
    const health = healthFromRate(acceptanceRate);
    const healthMeta = HEALTH_META[health];

    container.appendChild(
      el('div', { className: 'adv-perf-health' },
        el('span', {
          className: `adv-perf-dot ${healthMeta.cls}`,
          'aria-hidden': 'true',
        }),
        el('span', { className: 'adv-perf-health-label' }, healthMeta.label),
        el('span', { className: 'adv-perf-rate' },
          `${Math.round(acceptanceRate * 100)}% acceptance`
        ),
      )
    );

    // ── Summary stats ──────────────────────────────────────────
    const statItems = [
      { label: 'Generated', value: stats.generated, sub: '' },
      { label: 'Accepted',  value: stats.accepted,  sub: stats.generated > 0 ? `${Math.round(stats.accepted / stats.generated * 100)}%` : '' },
      { label: 'Rejected',  value: stats.rejected,  sub: stats.generated > 0 ? `${Math.round(stats.rejected / stats.generated * 100)}%` : '' },
      { label: 'Pending',   value: stats.proposed,  sub: '' },
    ];

    const statRow = el('div', { className: 'adv-perf-stats-row' });
    for (const s of statItems) {
      statRow.appendChild(
        el('div', { className: 'adv-perf-stat' },
          el('span', { className: 'adv-perf-stat-val' }, String(s.value)),
          el('span', { className: 'adv-perf-stat-label' }, s.label),
          s.sub ? el('span', { className: 'adv-perf-stat-sub' }, s.sub) : null,
        )
      );
    }
    container.appendChild(statRow);

    // Snoozed footnote
    container.appendChild(
      el('p', { className: 'adv-perf-snooze-note' },
        '* Snoozed proposals (dismissed temporarily) are included in Pending until acted on.'
      )
    );

    // ── Sparkline ──────────────────────────────────────────────
    const sparkRates = computeSparkline(tickets, windowDays);
    const ariaLabel = buildSparklineAriaLabel(sparkRates, windowDays);

    container.appendChild(
      el('div', { className: 'adv-perf-sparkline-wrap' },
        el('span', { className: 'adv-perf-spark-label' }, `Acceptance rate / week (${windowDays}d)`),
        buildSparklineSvg(sparkRates, ariaLabel),
      )
    );

    // ── Last / next run timestamps ─────────────────────────────
    // Next run is computed client-side from lastRunAt + intervalHours per spec.
    if (personaState) {
      const lastRun = personaState.lastRunAt
        ? new Date(personaState.lastRunAt).toLocaleString()
        : '—';
      // Compute nextRunAt client-side; do not read it from Firestore
      const lastRunDate = toDate(personaState.lastRunAt);
      const iHours = personaState.intervalHours ?? (PERSONAS.find(p => p.id === personaId)?.defaultHours ?? 24);
      const nextRunMs = lastRunDate ? lastRunDate.getTime() + iHours * 3600_000 : 0;
      const nextRun = nextRunMs > 0 ? new Date(nextRunMs).toLocaleString() : '—';
      const nextRunLabel = nextRunMs > Date.now() ? nextRun : 'Soon';

      container.appendChild(
        el('div', { className: 'adv-perf-timestamps' },
          el('div', { className: 'adv-perf-ts-row' },
            el('span', { className: 'adv-perf-ts-label' }, 'Last run'),
            el('span', { className: 'adv-perf-ts-val' }, lastRun),
          ),
          el('div', { className: 'adv-perf-ts-row' },
            el('span', { className: 'adv-perf-ts-label' }, 'Next run'),
            el('span', { className: 'adv-perf-ts-val' }, nextRunLabel),
          ),
        )
      );
    }

    // ── Inline frequency control ───────────────────────────────
    const personaCard = this._cards[personaId];
    const currentHours = personaState?.intervalHours ?? (PERSONAS.find(p => p.id === personaId)?.defaultHours ?? 24);
    const freqInput = el('input', {
      className: 'adv-interval-input adv-perf-freq-input',
      type: 'number',
      min: '1',
      max: '168',
      value: String(currentHours),
      title: 'Interval in hours',
      'aria-label': 'Run interval in hours',
    });
    const freqSaveBtn = el('button', {
      className: 'adv-interval-save',
      title: 'Save interval',
      onClick: () => this._saveInterval(personaId, freqInput.value, 'hours'),
    }, 'Save');

    container.appendChild(
      el('div', { className: 'adv-perf-freq' },
        el('span', { className: 'adv-perf-freq-label' }, 'Run every'),
        freqInput,
        el('span', { className: 'adv-perf-freq-unit' }, 'hours'),
        freqSaveBtn,
      )
    );

    // Keep freqInput in sync if personaState updates
    if (personaCard) personaCard._perfFreqInput = freqInput;
  }

  _buildCustomPersonasSection() {
    const section = el('div', { className: 'adv-custom-section' });

    this._customPersonasBody = el('div', { className: 'adv-custom-body', id: 'adv-custom-body' });

    // "Add" button — always visible, disabled when at cap
    const addBtn = el('button', {
      className: 'adv-custom-add-btn',
      title: 'Create a new custom persona',
      onClick: () => this._openCustomPersonaModal(null),
    }, '+ Add Persona');
    this._addPersonaBtn = addBtn;

    section.appendChild(
      el('div', { className: 'adv-custom-add-row' },
        addBtn,
      )
    );

    section.appendChild(this._customPersonasBody);

    return section;
  }

  /**
   * Build the acceptance rate summary table section (DK-196).
   * Shows a collapsible table with one row per persona:
   *   persona name | proposed | accepted | rejected | acceptance rate %
   * Data is loaded from feedbackEvents on first expand.
   */
  _buildAcceptanceRateSection() {
    const section = el('div', { className: 'adv-acceptance-section' });

    // Collapsible header
    const isExpanded = this._collapsedCardSections.has('acceptance-rate');
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');
    const header = el('button', {
      className: 'adv-acceptance-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-acceptance-body',
      onClick: () => this._toggleAcceptanceSection(body, chevron, header),
    },
      chevron,
      el('span', {}, 'Acceptance Rates'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-acceptance-body',
      id: 'adv-acceptance-body',
    });
    if (!isExpanded) body.classList.add('adv-hidden');
    section.appendChild(body);

    this._acceptanceBody = body;

    if (isExpanded) {
      this._loadAcceptanceRates();
    }

    return section;
  }

  _toggleAcceptanceSection(bodyEl, chevronEl, headerEl) {
    const isExpanded = this._collapsedCardSections.has('acceptance-rate');
    if (isExpanded) {
      // Collapse
      this._collapsedCardSections.delete('acceptance-rate');
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      headerEl.setAttribute('aria-expanded', 'false');
    } else {
      // Expand and load
      this._collapsedCardSections.add('acceptance-rate');
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      headerEl.setAttribute('aria-expanded', 'true');
      this._loadAcceptanceRates();
    }
    this._saveCardSectionCollapseState();
  }

  /**
   * Load acceptance rate data for all personas from feedbackEvents.
   * Queries the last 90 days across all projects the user can see.
   * Renders a table with: persona | proposed | accepted | rejected | rate%
   */
  async _loadAcceptanceRates() {
    if (!this._acceptanceBody) return;
    this._acceptanceBody.innerHTML = '';
    this._acceptanceBody.appendChild(
      el('div', { className: 'adv-acceptance-loading' },
        el('span', { 'aria-hidden': 'true', className: 'adv-history-spinner' }),
        el('span', {}, 'Loading…'),
      )
    );

    try {
      const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
      if (!projectId) {
        this._acceptanceBody.innerHTML = '';
        this._acceptanceBody.appendChild(
          el('div', { className: 'adv-acceptance-empty' }, 'No project selected.')
        );
        return;
      }

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Fetch all feedbackEvents across all built-in personas in parallel
      const allPersonaIds = [
        ...PERSONAS.map(p => p.id),
        ...this._customPersonas.map(p => p.id || p._docId).filter(Boolean),
      ];

      const results = await Promise.all(
        allPersonaIds.map(async (pid) => {
          try {
            const snap = await this.db
              .collection('projects')
              .doc(projectId)
              .collection('feedbackEvents')
              .where('personaId', '==', pid)
              .orderBy('timestamp', 'desc')
              .limit(200)
              .get();

            let accepted = 0, rejected = 0;
            for (const doc of snap.docs) {
              const data = doc.data();
              const ts = data.timestamp?.toDate?.() ?? null;
              if (ts && ts < cutoff) break;
              if (data.decision === 'accepted') accepted++;
              else if (data.decision === 'rejected') rejected++;
            }
            const total = accepted + rejected;
            const rate = total > 0 ? Math.round(accepted / total * 100) : null;
            return { personaId: pid, accepted, rejected, total, rate };
          } catch {
            return { personaId: pid, accepted: 0, rejected: 0, total: 0, rate: null, error: true };
          }
        })
      );

      // Filter to personas with any data
      const withData = results.filter(r => r.total > 0 || r.error);
      const allEmpty = withData.length === 0;

      this._acceptanceBody.innerHTML = '';

      if (allEmpty) {
        this._acceptanceBody.appendChild(
          el('div', { className: 'adv-acceptance-empty' },
            'No feedback recorded yet. Accept or reject proposals to see rates.'
          )
        );
        return;
      }

      // Build table
      const table = el('table', {
        className: 'adv-acceptance-table',
        'aria-label': 'Acceptance rates by persona',
      });

      // Header row
      const thead = el('thead', {});
      thead.appendChild(
        el('tr', {},
          el('th', { scope: 'col' }, 'Persona'),
          el('th', { scope: 'col' }, 'Accepted'),
          el('th', { scope: 'col' }, 'Rejected'),
          el('th', { scope: 'col' }, 'Rate'),
          el('th', { scope: 'col' }, 'Quality'),
        )
      );
      table.appendChild(thead);

      const tbody = el('tbody', {});
      for (const row of results) {
        if (row.total === 0 && !row.error) continue;

        const personaLabel = PERSONAS.find(p => p.id === row.personaId)?.label
          || this._customPersonas.find(p => (p.id || p._docId) === row.personaId)?.name
          || row.personaId;

        const rateStr = row.rate !== null ? `${row.rate}%` : '—';
        let qualityLabel = '—';
        let qualityCls = '';
        if (row.rate !== null) {
          if (row.rate > 50) { qualityLabel = 'Healthy'; qualityCls = 'adv-acceptance-quality-green'; }
          else if (row.rate >= 20) { qualityLabel = 'Fair'; qualityCls = 'adv-acceptance-quality-yellow'; }
          else { qualityLabel = 'Low'; qualityCls = 'adv-acceptance-quality-red'; }
        }

        tbody.appendChild(
          el('tr', {},
            el('td', { className: 'adv-acceptance-persona' }, personaLabel),
            el('td', { className: 'adv-acceptance-num' }, String(row.accepted)),
            el('td', { className: 'adv-acceptance-num' }, String(row.rejected)),
            el('td', { className: 'adv-acceptance-rate' }, rateStr),
            el('td', { className: `adv-acceptance-quality ${qualityCls}` }, qualityLabel),
          )
        );
      }
      table.appendChild(tbody);
      this._acceptanceBody.appendChild(table);

      // Note about time window
      this._acceptanceBody.appendChild(
        el('p', { className: 'adv-acceptance-note' }, 'Based on last 90 days of feedback.')
      );
    } catch (err) {
      console.warn('AdvisorPanel: failed to load acceptance rates', err);
      this._acceptanceBody.innerHTML = '';
      this._acceptanceBody.appendChild(
        el('div', { className: 'adv-acceptance-error' }, 'Could not load acceptance rates.')
      );
    }
  }

  _buildContextPanel() {
    const panel = el('div', { className: 'adv-context-panel', style: 'display:none' });

    // ── DK-302: Current Priorities field ──────────────────────────────────
    // Placed at the top of the context panel — first thing to configure.
    // Per-project: the field is scoped per project; project name is visible in the header
    // (set via the project filter selector, shown in the same panel context).
    const MAX_PRIORITIES_CHARS = 500;
    const prioritiesCharCountId = 'adv-priorities-charcount';
    const prioritiesSaveStatusId = 'adv-priorities-save-status';

    const prioritiesLabel = el('label', {
      className: 'adv-priorities-label',
      htmlFor: 'adv-priorities-textarea',
    }, 'Current Priorities');
    const prioritiesSubLabel = el('div', { className: 'adv-priorities-sublabel' },
      'Used by all advisor personas when generating suggestions.'
    );
    const prioritiesLabelRow = el('div', { className: 'adv-priorities-label-row' },
      prioritiesLabel,
      prioritiesSubLabel,
    );
    panel.appendChild(prioritiesLabelRow);

    // ARIA live region for "Saved" confirmation — must be announced to screen readers
    const prioritiesSaveStatusEl = el('span', {
      id: prioritiesSaveStatusId,
      className: 'adv-priorities-save-status',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    this._prioritiesSaveStatusEl = prioritiesSaveStatusEl;
    panel.appendChild(prioritiesSaveStatusEl);

    const prioritiesTextarea = el('textarea', {
      id: 'adv-priorities-textarea',
      className: 'adv-priorities-textarea',
      placeholder: 'e.g., shipping payments by March 15, deprioritize infra work',
      rows: '3',
      maxlength: String(MAX_PRIORITIES_CHARS),
      'aria-describedby': `${prioritiesCharCountId} ${prioritiesSaveStatusId}`,
      onInput: () => {
        this._onPrioritiesInput(prioritiesTextarea, prioritiesCharCountEl, MAX_PRIORITIES_CHARS);
      },
    });
    this._prioritiesTextarea = prioritiesTextarea;
    panel.appendChild(prioritiesTextarea);

    // Live character counter — always visible, updated on input
    const prioritiesCharCountEl = el('div', {
      id: prioritiesCharCountId,
      className: 'adv-priorities-charcount',
    }, `0 / ${MAX_PRIORITIES_CHARS}`);
    this._prioritiesCharCountEl = prioritiesCharCountEl;
    panel.appendChild(prioritiesCharCountEl);

    // Relative timestamp for last update + timing note
    const prioritiesTimestampEl = el('div', { className: 'adv-priorities-timestamp' });
    this._prioritiesTimestampEl = prioritiesTimestampEl;
    panel.appendChild(prioritiesTimestampEl);

    // Timing expectation line
    panel.appendChild(
      el('div', { className: 'adv-priorities-timing-note' },
        'Changes take effect on the next scheduled advisor run.'
      )
    );

    // Section divider before Global Context
    panel.appendChild(el('div', { className: 'adv-priorities-divider' }));

    // Section label — communicates this is a global setting, not per-persona
    const label = el('div', { className: 'adv-context-panel-label' },
      el('span', { className: 'adv-context-panel-label-icon' }, '⊕'),
      'Global Context',
    );
    panel.appendChild(label);

    // ── Preset selector row ────────────────────────────────────────────────
    // Dropdown showing active preset name (or "Custom" when edited)
    const presetSelect = el('select', {
      className: 'adv-preset-select',
      'aria-label': 'Active context preset',
      onChange: () => this._onPresetSelectChange(presetSelect),
    });
    this._presetSelectEl = presetSelect;

    // "edited" drift indicator + Revert link (hidden until drift detected)
    const driftEl = el('span', { className: 'adv-preset-drift', 'aria-live': 'polite', role: 'status' });
    this._presetDriftEl = driftEl;

    // Delete preset button (shown only when a named preset is active)
    const deletePresetBtn = el('button', {
      className: 'adv-preset-delete-btn',
      title: 'Delete this preset',
      'aria-label': 'Delete active preset',
      style: 'display:none',
      onClick: () => this._openDeletePresetModal(),
    }, '✕');
    this._presetDeleteBtn = deletePresetBtn;

    const selectorRow = el('div', { className: 'adv-preset-selector-row' },
      presetSelect,
      deletePresetBtn,
      driftEl,
    );
    panel.appendChild(selectorRow);

    // ── Context textarea ───────────────────────────────────────────────────
    const MAX_CONTEXT_CHARS = 4000;

    const textarea = el('textarea', {
      className: 'adv-context-textarea',
      placeholder: CONTEXT_EXAMPLES,
      rows: '5',
      maxlength: String(MAX_CONTEXT_CHARS),
      'aria-label': 'Project context for AI advisors',
      onInput: () => {
        this._onContextTextareaInput(textarea);
      },
      onFocus: () => {
        this._contextFocused = true;
        this._contextModifiedThisSession = true;
        this._updateContextHints(textarea);
      },
      onBlur: () => {
        this._contextFocused = false;
        this._updateContextHints(textarea);
      },
    });
    panel.appendChild(textarea);

    // Character count — aria-live so screen readers announce changes.
    // Visibility is gated: shown on focus, or on blur if out of suggested range.
    const charCountEl = el('div', {
      className: 'adv-context-charcount',
      'aria-live': 'polite',
      role: 'status',
    });
    panel.appendChild(charCountEl);
    this._contextCharCountEl = charCountEl;

    // Quality indicator — shown only when the field is focused or has been modified
    // this session. Purely informational; never a blocker.
    const qualityEl = el('div', { className: 'adv-context-quality' });
    panel.appendChild(qualityEl);
    this._contextQualityEl = qualityEl;

    // ── Footer: status + Save as… + Save ─────────────────────────────────
    const footer = el('div', { className: 'adv-context-panel-footer' });
    const statusEl = el('span', { className: 'adv-context-status', role: 'status', 'aria-live': 'polite' });

    // "Save as…" button — always visible (not hover-only per spec)
    const saveAsBtn = el('button', {
      className: 'adv-context-save-as',
      onClick: () => this._openSavePresetModal(textarea.value),
    }, 'Save as…');
    this._presetSaveAsBtn = saveAsBtn;

    // Save button — saves the live context to the project doc
    const actionBtn = el('button', {
      className: 'adv-context-edit',
      onClick: () => {
        const projectId = this._filterProjectId;
        if (!projectId) return;
        this._saveContext(projectId, textarea.value, actionBtn, statusEl);
      },
    }, 'Save');

    footer.appendChild(statusEl);
    footer.appendChild(saveAsBtn);
    footer.appendChild(actionBtn);
    panel.appendChild(footer);

    this._contextPanel = panel;
    this._contextTextarea = textarea;
    this._contextActionBtn = actionBtn;
    this._contextStatusEl = statusEl;

    return panel;
  }

  /**
   * Called when the user types in the context textarea.
   * Updates character count, quality indicator, and drift indicator.
   */
  _onContextTextareaInput(textarea) {
    this._contextModifiedThisSession = true;
    this._updateContextHints(textarea);
    // Drift detection: if the user has edited from a known preset, mark dirty
    this._contextDirty = true;
    this._updatePresetDriftIndicator();
  }

  // ── DK-302: Current Priorities field handlers ─────────────────────────────

  /**
   * Called when the user types in the priorities textarea.
   * Updates character counter and schedules a debounced autosave.
   * @param {HTMLTextAreaElement} textarea
   * @param {HTMLElement} charCountEl
   * @param {number} maxChars
   */
  _onPrioritiesInput(textarea, charCountEl, maxChars) {
    const len = textarea.value.length;
    if (charCountEl) {
      charCountEl.textContent = `${len} / ${maxChars}`;
      charCountEl.classList.toggle('adv-priorities-charcount--warn', len > maxChars * 0.8);
      charCountEl.classList.toggle('adv-priorities-charcount--over', len > maxChars);
    }
    // Debounced autosave (~1s)
    if (this._prioritiesDebounceTimer) clearTimeout(this._prioritiesDebounceTimer);
    this._prioritiesDebounceTimer = setTimeout(() => {
      const projectId = this._filterProjectId;
      if (projectId) this._savePriorities(projectId, textarea.value);
    }, 1000);
  }

  /**
   * Save the priorities field to Firestore.
   * Trims whitespace, strips null bytes, enforces 500-char limit server-side.
   * On success, shows a quiet "Saved" confirmation via ARIA live region (3s).
   * @param {string} projectId
   * @param {string} rawText
   */
  async _savePriorities(projectId, rawText) {
    if (!projectId) return;
    // Trim and strip null bytes (server-side also enforces 500 char limit)
    const trimmed = rawText.replace(/\0/g, '').trim().slice(0, 500);
    try {
      await this.db.collection('projects').doc(projectId).update({
        priorities: trimmed,
        prioritiesUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Show "Saved" confirmation via ARIA live region
      if (this._prioritiesSaveStatusEl) {
        this._prioritiesSaveStatusEl.textContent = 'Saved';
        setTimeout(() => {
          if (this._prioritiesSaveStatusEl) this._prioritiesSaveStatusEl.textContent = '';
        }, 3000);
      }
    } catch (err) {
      console.error('Failed to save priorities:', err);
    }
  }

  /**
   * Format a relative timestamp for the priorities field.
   * Returns "Updated 2 days ago." style text, or empty if no timestamp.
   * @param {string|null} isoStr
   * @returns {{ text: string, stale: boolean }}
   */
  _formatPrioritiesTimestamp(isoStr) {
    if (!isoStr) return { text: '', stale: false };
    const ms = Date.now() - new Date(isoStr).getTime();
    if (ms < 0) return { text: '', stale: false };
    const mins = Math.floor(ms / 60_000);
    let text;
    if (mins < 1) text = 'Updated just now.';
    else if (mins < 60) text = `Updated ${mins} minute${mins === 1 ? '' : 's'} ago.`;
    else {
      const h = Math.floor(mins / 60);
      if (h < 24) text = `Updated ${h} hour${h === 1 ? '' : 's'} ago.`;
      else {
        const days = Math.floor(h / 24);
        text = `Updated ${days} day${days === 1 ? '' : 's'} ago.`;
      }
    }
    // 14+ days = stale indicator
    const stale = ms > 14 * 24 * 60 * 60 * 1000;
    return { text, stale };
  }

  /**
   * Update the priorities timestamp element from a raw priorities updated-at string.
   * @param {string|null} prioritiesUpdatedAt
   */
  _updatePrioritiesTimestamp(prioritiesUpdatedAt) {
    if (!this._prioritiesTimestampEl) return;
    const { text, stale } = this._formatPrioritiesTimestamp(prioritiesUpdatedAt);
    this._prioritiesTimestampEl.textContent = text;
    this._prioritiesTimestampEl.classList.toggle('adv-priorities-timestamp--stale', stale);
  }

  /**
   * Update the "Add priorities" dismissible banner shown in the advisor output section
   * when priorities is empty and an advisor has run recently.
   * @param {boolean} showBanner
   */
  _updatePrioritiesBanner(showBanner) {
    if (!this._prioritiesBannerEl) return;
    if (this._prioritiesBannerDismissed) {
      this._prioritiesBannerEl.style.display = 'none';
      return;
    }
    this._prioritiesBannerEl.style.display = showBanner ? '' : 'none';
  }

  /**
   * Update the Update the collapsed one-line preview of current priorities for a persona card.
   * @param {string} personaId
   * @param {string|null} priorities
   */
  _updatePrioritiesPreview(personaId, priorities) {
    const el = this._prioritiesPreviewEls[personaId];
    if (!el) return;
    const trimmed = (priorities || '').trim();
    if (trimmed) {
      // Truncate to one line (120 chars)
      const preview = trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed;
      el.textContent = `Priorities: ${preview}`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * Update the character counter and quality indicator based on the current
   * textarea value and focus state (DK-120).
   *
   * Character counter:
   *   - Always shown on focus.
   *   - Hidden on blur only if content is within the 100-400 char suggested range.
   *   - Shows count against the 4000-char hard max (warn at 80%, over at 100%).
   *   - Marks out-of-range (< 50 or > 600) at boundaries.
   *
   * Quality indicator:
   *   - Only shown when the field is focused or has been modified this session.
   *   - Never blocks saving. Informational only.
   *
   * @param {HTMLTextAreaElement} textarea
   */
  _updateContextHints(textarea) {
    const value = textarea ? textarea.value : '';
    const len = value.length;
    const MAX = 4000;
    const SUGGESTED_MIN = 100;
    const SUGGESTED_MAX = 400;

    // ── Character counter ──────────────────────────────────────────────────
    if (this._contextCharCountEl) {
      const focused = this._contextFocused;
      const withinSuggestedRange = len >= SUGGESTED_MIN && len <= SUGGESTED_MAX;
      // Show on focus always; show on blur if out of suggested range or near hard max
      const shouldShow = focused || !withinSuggestedRange || len > MAX * 0.8;

      if (shouldShow) {
        // Show count / range; append suggested range hint when focused and not near max
        if (len <= MAX * 0.8) {
          this._contextCharCountEl.textContent = `${len} / ${SUGGESTED_MAX} suggested`;
        } else {
          this._contextCharCountEl.textContent = `${len} / ${MAX}`;
        }
        this._contextCharCountEl.classList.toggle('adv-context-charcount--boundary', len < 50 || len > 600);
        this._contextCharCountEl.classList.toggle('adv-context-charcount--warn', len > MAX * 0.9);
        this._contextCharCountEl.classList.toggle('adv-context-charcount--over', len > MAX);
      } else {
        this._contextCharCountEl.textContent = '';
        this._contextCharCountEl.className = 'adv-context-charcount';
      }
    }

    // ── Quality indicator ──────────────────────────────────────────────────
    if (this._contextQualityEl) {
      const active = this._contextFocused || this._contextModifiedThisSession;
      if (active && len > 0) {
        const quality = getContextQuality(value);
        this._contextQualityEl.textContent = `Context: ${quality}`;
        this._contextQualityEl.className = `adv-context-quality adv-context-quality--${quality}`;
      } else {
        this._contextQualityEl.textContent = '';
        this._contextQualityEl.className = 'adv-context-quality';
      }
    }
  }

  /**
   * Update the drift indicator based on whether the current textarea value
   * matches the last applied preset.
   */
  _updatePresetDriftIndicator() {
    if (!this._presetDriftEl || !this._presetSelectEl) return;

    const currentText = this._contextTextarea?.value ?? '';
    const activePreset = this._presets.find(p => p.id === this._lastAppliedPresetId);

    const isDrifted = this._lastAppliedPresetId && activePreset
      && currentText.trim() !== (activePreset.advisorContext || '').trim();

    if (isDrifted) {
      // Show "edited" indicator with Revert link
      this._presetDriftEl.textContent = '';
      const editedSpan = el('span', { className: 'adv-preset-drift-label' }, 'edited');
      const revertLink = el('button', {
        className: 'adv-preset-revert-link',
        onClick: () => {
          if (this._contextTextarea && activePreset) {
            this._contextTextarea.value = activePreset.advisorContext || '';
            this._contextDirty = false;
            // Update hints without triggering dirty flag
            this._updateContextHints(this._contextTextarea);
            this._updatePresetDriftIndicator();
            this._updatePresetSelector();
          }
        },
      }, 'Revert');
      this._presetDriftEl.appendChild(editedSpan);
      this._presetDriftEl.appendChild(document.createTextNode(' — '));
      this._presetDriftEl.appendChild(revertLink);
      this._presetDriftEl.style.display = '';

      // Show "Custom" in the selector
      this._updatePresetSelectorValue('__custom__');
    } else {
      this._presetDriftEl.textContent = '';
      this._presetDriftEl.style.display = 'none';
      this._updatePresetSelectorValue(this._lastAppliedPresetId || '__none__');
    }
  }

  /**
   * Update just the selected value in the preset dropdown without rebuilding it.
   */
  _updatePresetSelectorValue(value) {
    if (!this._presetSelectEl) return;
    // Ensure the value exists as an option; if not, fall back
    const opts = Array.from(this._presetSelectEl.options).map(o => o.value);
    if (opts.includes(value)) {
      this._presetSelectEl.value = value;
    }
  }

  /**
   * Called when the user changes the preset dropdown selection.
   */
  _onPresetSelectChange(selectEl) {
    const value = selectEl.value;
    if (value === '__none__' || value === '__custom__') return;

    const preset = this._presets.find(p => p.id === value);
    if (!preset) return;

    // If current context has been edited, warn inline before applying
    const currentText = this._contextTextarea?.value ?? '';
    const isEdited = this._lastAppliedPresetId
      ? this._contextDirty
      : currentText.trim().length > 0;

    if (isEdited) {
      // Show inline warning element — replace with warning then apply
      if (this._presetDriftEl) {
        this._presetDriftEl.textContent = '';
        const warnEl = el('span', {
          className: 'adv-preset-switch-warn',
          role: 'alert',
          'aria-live': 'assertive',
        }, 'Unsaved changes will be lost. ');
        const applyLink = el('button', {
          className: 'adv-preset-revert-link',
          onClick: () => this._applyPreset(preset),
        }, 'Apply anyway');
        const cancelLink = el('button', {
          className: 'adv-preset-revert-link',
          style: 'margin-left:6px',
          onClick: () => {
            // Revert dropdown to previous value
            this._updatePresetDriftIndicator();
            this._updatePresetSelectorValue(this._lastAppliedPresetId || '__none__');
          },
        }, 'Cancel');
        this._presetDriftEl.appendChild(warnEl);
        this._presetDriftEl.appendChild(applyLink);
        this._presetDriftEl.appendChild(cancelLink);
        this._presetDriftEl.style.display = '';
      }
    } else {
      this._applyPreset(preset);
    }
  }

  /**
   * Apply a preset: set textarea value + update activePresetId on project doc.
   */
  async _applyPreset(preset) {
    const projectId = this._filterProjectId;
    if (!projectId || !preset) return;

    // Apply to textarea immediately (optimistic)
    if (this._contextTextarea) {
      this._contextTextarea.value = preset.advisorContext || '';
    }
    this._lastAppliedPresetId = preset.id;
    this._contextDirty = false;
    this._updateContextHints(this._contextTextarea);
    this._updatePresetDriftIndicator();
    this._updatePresetSelector();

    // Persist advisorContext + activePresetId to Firestore
    try {
      await this.db.collection('projects').doc(projectId).update({
        advisorContext: (preset.advisorContext || '').trim(),
        activePresetId: preset.id,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('AdvisorPanel: failed to apply preset', err);
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = 'Error applying preset';
        this._contextStatusEl.className = 'adv-context-status adv-context-status-err';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 3000);
      }
    }
  }

  /**
   * Rebuild the preset <select> options list.
   */
  _updatePresetSelector() {
    const select = this._presetSelectEl;
    if (!select) return;

    const currentVal = select.value;
    select.textContent = '';

    // "(no preset)" option
    const noneOpt = document.createElement('option');
    noneOpt.value = '__none__';
    noneOpt.textContent = '— No preset —';
    select.appendChild(noneOpt);

    // "Custom" option (only shown when drift detected)
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom';
    select.appendChild(customOpt);

    for (const preset of this._presets) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;

      // Hover tooltip: last-modified date + first 80 chars of context
      const modDate = preset.updatedAt
        ? new Date(preset.updatedAt.toDate ? preset.updatedAt.toDate() : preset.updatedAt)
            .toLocaleDateString()
        : '';
      const preview = (preset.advisorContext || '').slice(0, 80);
      opt.title = [modDate, preview].filter(Boolean).join(' — ');

      select.appendChild(opt);
    }

    // Restore value
    const opts = Array.from(select.options).map(o => o.value);
    if (opts.includes(currentVal)) {
      select.value = currentVal;
    } else {
      select.value = this._lastAppliedPresetId || '__none__';
    }

    // Show/hide delete button based on whether a named preset is selected
    const selectedId = select.value;
    if (this._presetDeleteBtn) {
      const isNamedPreset = selectedId !== '__none__' && selectedId !== '__custom__';
      this._presetDeleteBtn.style.display = isNamedPreset ? '' : 'none';
    }
  }

  /**
   * Subscribe to the advisorTemplates subcollection for the given project.
   * Unsubscribes from any previously watched project first.
   */
  _subscribePresets(projectId) {
    if (this._presetsUnsub) {
      this._presetsUnsub();
      this._presetsUnsub = null;
    }
    this._presetsProjectId = projectId;
    this._presets = [];

    if (!projectId) {
      this._updatePresetSelector();
      return;
    }

    const ref = this.db.collection('projects').doc(projectId).collection('advisorTemplates');
    const unsub = ref.orderBy('createdAt').onSnapshot(
      (snap) => {
        this._presets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._updatePresetSelector();
        this._updatePresetDriftIndicator();
      },
      (err) => {
        if (err.code !== 'permission-denied') {
          console.error('AdvisorPanel: presets listener error', err);
        }
        if (this._mounted && this._presetsProjectId === projectId) {
          setTimeout(() => {
            if (this._mounted && this._presetsProjectId === projectId) {
              this._subscribePresets(projectId);
            }
          }, 8000);
        }
      }
    );
    this._presetsUnsub = unsub;
  }

  /**
   * Open the "Save as preset" modal.
   * Pre-populates suggested names on the user's first save.
   */
  _openSavePresetModal(currentContextText) {
    if (this._presetSaveModal) return; // already open

    const projectId = this._filterProjectId;
    if (!projectId) return;

    // Validate context length before opening modal
    if (!currentContextText || !currentContextText.trim()) {
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = 'Context is empty — nothing to save.';
        this._contextStatusEl.className = 'adv-context-status adv-context-status-err';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 3000);
      }
      return;
    }
    if (currentContextText.length > 4000) {
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = 'Context exceeds 4,000 characters — please shorten it first.';
        this._contextStatusEl.className = 'adv-context-status adv-context-status-err';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 4000);
      }
      return;
    }

    const SUGGESTED_NAMES = ['Pre-launch', 'Growth', 'Debt cleanup'];
    const MIN_NAME_LEN = 1;
    const MAX_NAME_LEN = 48;

    const overlay = el('div', {
      className: 'adv-modal-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSavePresetModal(); },
    });

    const modal = el('div', { className: 'adv-modal adv-preset-save-modal' });

    const header = el('div', { className: 'adv-modal-header' },
      el('div', { className: 'adv-modal-title' }, 'Save as preset'),
      el('button', {
        className: 'adv-modal-close',
        'aria-label': 'Close',
        onClick: () => this._closeSavePresetModal(),
      }, '×'),
    );
    modal.appendChild(header);

    // Name input
    const nameLabel = el('label', { className: 'adv-modal-label', htmlFor: 'adv-preset-name-input' }, 'Preset name');
    const nameInput = el('input', {
      type: 'text',
      id: 'adv-preset-name-input',
      className: 'adv-modal-input',
      placeholder: 'e.g. Pre-launch',
      maxlength: String(MAX_NAME_LEN),
      'aria-required': 'true',
    });

    const nameCountEl = el('div', { className: 'adv-modal-charcount' });
    const updateNameCount = () => {
      const len = nameInput.value.length;
      nameCountEl.textContent = len > MAX_NAME_LEN * 0.7 ? `${len} / ${MAX_NAME_LEN}` : '';
      nameCountEl.classList.toggle('adv-modal-charcount--warn', len > MAX_NAME_LEN * 0.85);
    };
    nameInput.addEventListener('input', updateNameCount);

    // Suggested name buttons (first save experience)
    const suggestionsEl = el('div', { className: 'adv-preset-suggestions' });
    for (const sug of SUGGESTED_NAMES) {
      const btn = el('button', {
        className: 'adv-preset-suggestion-btn',
        type: 'button',
        onClick: () => {
          nameInput.value = sug;
          updateNameCount();
          nameInput.focus();
        },
      }, sug);
      suggestionsEl.appendChild(btn);
    }

    // Validation error el
    const nameErrEl = el('div', {
      className: 'adv-modal-err',
      role: 'alert',
      'aria-live': 'assertive',
      style: 'display:none',
    });

    const saveBtn = el('button', {
      className: 'adv-modal-save-btn',
      type: 'button',
      onClick: () => this._savePreset(nameInput.value, currentContextText, saveBtn, nameErrEl),
    }, 'Save preset');

    const cancelBtn = el('button', {
      className: 'adv-modal-cancel-btn',
      type: 'button',
      onClick: () => this._closeSavePresetModal(),
    }, 'Cancel');

    const actions = el('div', { className: 'adv-modal-actions' }, saveBtn, cancelBtn);

    modal.appendChild(nameLabel);
    modal.appendChild(nameInput);
    modal.appendChild(nameCountEl);
    modal.appendChild(suggestionsEl);
    modal.appendChild(nameErrEl);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._presetSaveModal = overlay;

    // Keyboard: Enter saves, Escape closes
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { this._closeSavePresetModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._presetSaveModal._keyHandler = onKey;

    setTimeout(() => nameInput.focus(), 50);
  }

  _closeSavePresetModal() {
    if (!this._presetSaveModal) return;
    if (this._presetSaveModal._keyHandler) {
      document.removeEventListener('keydown', this._presetSaveModal._keyHandler);
    }
    this._presetSaveModal.remove();
    this._presetSaveModal = null;
  }

  /**
   * Persist a new or overwritten preset to Firestore.
   */
  async _savePreset(name, contextText, saveBtn, nameErrEl) {
    const trimmedName = (name || '').trim();
    const MIN = 1, MAX = 48;

    // Validate name
    if (trimmedName.length < MIN) {
      nameErrEl.textContent = 'Name is required.';
      nameErrEl.style.display = '';
      return;
    }
    if (trimmedName.length > MAX) {
      nameErrEl.textContent = `Name must be ${MAX} characters or fewer.`;
      nameErrEl.style.display = '';
      return;
    }

    // Validate context
    if ((contextText || '').length > 4000) {
      nameErrEl.textContent = 'Context exceeds 4,000 characters.';
      nameErrEl.style.display = '';
      return;
    }

    const projectId = this._filterProjectId;
    if (!projectId) return;

    saveBtn.disabled = true;
    nameErrEl.style.display = 'none';

    // Check if a preset with this name already exists → overwrite it
    const existing = this._presets.find(p => p.name === trimmedName);

    try {
      const now = new Date().toISOString();
      if (existing) {
        await this.db.collection('projects').doc(projectId)
          .collection('advisorTemplates').doc(existing.id).update({
            name: trimmedName,
            advisorContext: contextText.trim(),
            updatedAt: now,
          });
        this._lastAppliedPresetId = existing.id;
      } else {
        const docRef = await this.db.collection('projects').doc(projectId)
          .collection('advisorTemplates').add({
            name: trimmedName,
            advisorContext: contextText.trim(),
            createdAt: now,
            updatedAt: now,
          });
        this._lastAppliedPresetId = docRef.id;
      }

      // Also update activePresetId on the project
      await this.db.collection('projects').doc(projectId).update({
        activePresetId: this._lastAppliedPresetId,
        updatedAt: now,
      });

      this._contextDirty = false;
      this._closeSavePresetModal();
      this._updatePresetSelector();
      this._updatePresetDriftIndicator();

      // Show success in status element
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = `Preset "${trimmedName}" saved`;
        this._contextStatusEl.className = 'adv-context-status adv-context-status-ok';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 2500);
      }
    } catch (err) {
      console.error('AdvisorPanel: failed to save preset', err);
      nameErrEl.textContent = 'Save failed — please try again.';
      nameErrEl.style.display = '';
      saveBtn.disabled = false;
    }
  }

  /**
   * Open the delete-preset confirmation modal.
   */
  _openDeletePresetModal() {
    if (this._presetDeleteModal) return;
    const projectId = this._filterProjectId;
    if (!projectId) return;
    const presetId = this._presetSelectEl?.value;
    if (!presetId || presetId === '__none__' || presetId === '__custom__') return;
    const preset = this._presets.find(p => p.id === presetId);
    if (!preset) return;

    const overlay = el('div', {
      className: 'adv-modal-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeDeletePresetModal(); },
    });
    const modal = el('div', { className: 'adv-modal adv-preset-delete-modal' });

    modal.appendChild(el('div', { className: 'adv-modal-header' },
      el('div', { className: 'adv-modal-title' }, 'Delete preset'),
      el('button', {
        className: 'adv-modal-close',
        'aria-label': 'Close',
        onClick: () => this._closeDeletePresetModal(),
      }, '×'),
    ));

    modal.appendChild(el('p', { className: 'adv-modal-body' },
      `Delete preset "${preset.name}"? This cannot be undone.`,
    ));

    const deleteBtn = el('button', {
      className: 'adv-modal-delete-btn',
      type: 'button',
      role: 'alert',
      onClick: async () => {
        deleteBtn.disabled = true;
        try {
          await this.db.collection('projects').doc(projectId)
            .collection('advisorTemplates').doc(preset.id).delete();

          // Clear activePresetId if this was the active one
          if (this._lastAppliedPresetId === preset.id) {
            this._lastAppliedPresetId = null;
            await this.db.collection('projects').doc(projectId).update({
              activePresetId: null,
              updatedAt: new Date().toISOString(),
            });
          }
          this._closeDeletePresetModal();
        } catch (err) {
          console.error('AdvisorPanel: failed to delete preset', err);
          deleteBtn.disabled = false;
        }
      },
    }, 'Delete');

    const cancelBtn = el('button', {
      className: 'adv-modal-cancel-btn',
      type: 'button',
      onClick: () => this._closeDeletePresetModal(),
    }, 'Cancel');

    modal.appendChild(el('div', { className: 'adv-modal-actions' }, deleteBtn, cancelBtn));
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._presetDeleteModal = overlay;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeDeletePresetModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._presetDeleteModal._keyHandler = onKey;

    setTimeout(() => deleteBtn.focus(), 50);
  }

  _closeDeletePresetModal() {
    if (!this._presetDeleteModal) return;
    if (this._presetDeleteModal._keyHandler) {
      document.removeEventListener('keydown', this._presetDeleteModal._keyHandler);
    }
    this._presetDeleteModal.remove();
    this._presetDeleteModal = null;
  }

  // ── Persona instructions panel ────────────────────────────────────────

  /**
   * Build the persona instructions panel — three collapsible per-persona sections
   * (Engineer, Design, Product), collapsed by default. Visible only when a project
   * is selected. Reads/writes project.personaInstructions.{engineer,design,product}.
   */
  _buildPersonaInstructionsPanel() {
    // DK-133: Per-persona custom instruction editor — tabbed UI with explicit Save,
    // dirty state, global vs per-project toggle, and aria-live save confirmation.
    const INSTR_PERSONAS = [
      {
        id: 'engineer',
        label: 'Engineer',
        description: 'Reviews code for security vulnerabilities, inefficiencies, and open-source safety issues.',
        placeholder: 'e.g. Focus on security issues in the auth module only',
        globalPlaceholder: 'No global instructions set for Engineer.',
      },
      {
        id: 'design',
        label: 'Design',
        description: 'Audits the app UI for UX friction, accessibility, and visual polish issues.',
        placeholder: 'e.g. Prioritize mobile viewports, we have no desktop users',
        globalPlaceholder: 'No global instructions set for Design.',
      },
      {
        id: 'product',
        label: 'Product',
        description: 'Generates feature ideas grounded in project context and user needs.',
        placeholder: 'e.g. We are pre-revenue — ignore monetization feature ideas',
        globalPlaceholder: 'No global instructions set for Product.',
      },
    ];
    const MAX_CHARS = 4000;
    const WARN_THRESHOLD = 0.8;

    const panel = el('div', {
      className: 'adv-instr-panel',
      style: 'display:none', // hidden until a project is selected
    });

    // Panel header — collapsible toggle for the whole section
    const panelChevron = el('span', { className: 'adv-instr-panel-chevron', 'aria-hidden': 'true' }, '▸');
    const panelHeader = el('button', {
      className: 'adv-instr-panel-header',
      'aria-expanded': 'false',
      'aria-controls': 'adv-instr-panel-body',
      id: 'adv-instr-toggle',
      onClick: () => {
        const isExpanded = panelHeader.getAttribute('aria-expanded') === 'true';
        panelHeader.setAttribute('aria-expanded', String(!isExpanded));
        panelChevron.textContent = isExpanded ? '▸' : '▾';
        panelBody.classList.toggle('adv-hidden', isExpanded);
      },
    },
      panelChevron,
      el('span', { className: 'adv-instr-panel-title' }, 'Persona Instructions'),
    );
    panel.appendChild(panelHeader);

    const panelBody = el('div', {
      className: 'adv-instr-panel-body adv-hidden',
      id: 'adv-instr-panel-body',
    });
    panel.appendChild(panelBody);

    // aria-live region for save confirmations — polite so it doesn't interrupt reading
    const liveRegion = el('div', {
      'aria-live': 'polite',
      'aria-atomic': 'true',
      className: 'adv-instr-live-region',
    });
    panelBody.appendChild(liveRegion);
    this._personaInstrLiveRegion = liveRegion;

    // Scope label — tells user whether they are editing global defaults or a project override
    const scopeLabel = el('div', { className: 'adv-instr-scope-label' }, 'Editing: Global defaults');
    this._personaInstrScopeLabel = scopeLabel;
    panelBody.appendChild(scopeLabel);

    // ── Tab list ────────────────────────────────────────────────────────────
    const tabList = el('div', {
      className: 'adv-instr-tablist',
      role: 'tablist',
      'aria-label': 'Persona',
    });
    panelBody.appendChild(tabList);

    // ── Tab panels container ─────────────────────────────────────────────────
    const tabPanelsContainer = el('div', { className: 'adv-instr-tab-panels' });
    panelBody.appendChild(tabPanelsContainer);

    // Build one tab button + one panel per persona
    const tabEls = {};
    const panelEls = {};

    for (const { id, label, description, placeholder, globalPlaceholder } of INSTR_PERSONAS) {
      // ── Tab button ──────────────────────────────────────────────────────
      const tabId = `adv-instr-tab-${id}`;
      const panelId = `adv-instr-tabpanel-${id}`;

      const tabBtn = el('button', {
        className: 'adv-instr-tab',
        role: 'tab',
        'aria-selected': 'false',
        'aria-controls': panelId,
        id: tabId,
        type: 'button',
        onClick: () => this._switchPersonaInstrTab(id),
        onKeyDown: (e) => {
          // Arrow key navigation within tablist (ARIA pattern)
          const ids = INSTR_PERSONAS.map(p => p.id);
          const idx = ids.indexOf(id);
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[(idx + 1) % ids.length]);
            tabEls[ids[(idx + 1) % ids.length]]?.focus();
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[(idx - 1 + ids.length) % ids.length]);
            tabEls[ids[(idx - 1 + ids.length) % ids.length]]?.focus();
          } else if (e.key === 'Home') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[0]);
            tabEls[ids[0]]?.focus();
          } else if (e.key === 'End') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[ids.length - 1]);
            tabEls[ids[ids.length - 1]]?.focus();
          }
        },
      }, label);
      tabList.appendChild(tabBtn);
      tabEls[id] = tabBtn;

      // ── Tab panel ──────────────────────────────────────────────────────
      const tabPanel = el('div', {
        className: 'adv-instr-tabpanel adv-hidden',
        role: 'tabpanel',
        id: panelId,
        'aria-labelledby': tabId,
      });

      // Persona description
      tabPanel.appendChild(
        el('p', { className: 'adv-instr-persona-desc' }, description)
      );

      // ── Global vs per-project toggle ──────────────────────────────────
      const toggleId = `adv-instr-use-global-${id}`;
      const toggleLabel = el('label', {
        className: 'adv-instr-global-toggle-label',
        htmlFor: toggleId,
      }, 'Use global defaults');
      const toggle = el('input', {
        className: 'adv-instr-global-toggle',
        type: 'checkbox',
        id: toggleId,
        checked: true,  // default: use global
        onChange: () => {
          const useGlobal = toggle.checked;
          this._personaInstrUseGlobal[id] = useGlobal;
          this._applyPersonaInstrScopeMode(id, useGlobal);
        },
      });
      tabPanel.appendChild(
        el('div', { className: 'adv-instr-global-toggle-row' },
          toggle,
          toggleLabel,
        )
      );
      this._personaInstrGlobalToggleEls = this._personaInstrGlobalToggleEls || {};
      this._personaInstrGlobalToggleEls[id] = toggle;

      // ── Global instructions (read-only preview, shown when toggle=global) ──
      const globalTextareaId = `adv-instr-global-textarea-${id}`;
      const globalLabel = el('label', {
        className: 'adv-instr-label',
        htmlFor: globalTextareaId,
      }, 'Global instructions (read-only)');
      const globalCounterEl = el('span', { className: 'adv-instr-counter' }, '');
      const globalLabelRow = el('div', { className: 'adv-instr-label-row' }, globalLabel, globalCounterEl);

      const globalTextarea = el('textarea', {
        className: 'adv-instr-textarea adv-instr-textarea-readonly',
        id: globalTextareaId,
        placeholder: globalPlaceholder,
        rows: '5',
        readOnly: true,
        disabled: true,
      });
      this._personaInstrGlobalTextareas[id] = globalTextarea;

      const globalSection = el('div', { className: 'adv-instr-global-section' },
        globalLabelRow,
        globalTextarea,
        el('p', { className: 'adv-instr-tip' },
          'Set global defaults from the advisor settings page. Projects can override these.'
        ),
      );
      tabPanel.appendChild(globalSection);
      this._personaInstrGlobalSections = this._personaInstrGlobalSections || {};
      this._personaInstrGlobalSections[id] = globalSection;
      this._personaInstrGlobalCounterEls = this._personaInstrGlobalCounterEls || {};
      this._personaInstrGlobalCounterEls[id] = globalCounterEl;

      // ── Project-specific instructions (shown when toggle=customize) ────
      const textareaId = `adv-instr-textarea-${id}`;
      const counterEl = el('span', {
        className: 'adv-instr-counter',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }, '');
      const labelEl = el('label', {
        className: 'adv-instr-label',
        htmlFor: textareaId,
      }, 'Instructions for this project');

      const textarea = el('textarea', {
        className: 'adv-instr-textarea',
        id: textareaId,
        placeholder,
        maxlength: String(MAX_CHARS),
        rows: '5',
        onInput: () => {
          const len = textarea.value.length;
          const pct = len / MAX_CHARS;
          counterEl.textContent = len > 0 ? `${len} / ${MAX_CHARS}` : '';
          counterEl.className = 'adv-instr-counter' + (pct >= WARN_THRESHOLD ? ' adv-instr-counter-warn' : '');
          this._personaInstrDirty[id] = true;
          // Enable save button when dirty
          if (this._personaInstrSaveBtns[id]) {
            this._personaInstrSaveBtns[id].disabled = false;
          }
        },
      });
      this._personaInstrTextareas[id] = textarea;

      // Save button
      const saveBtn = el('button', {
        className: 'adv-instr-save-btn',
        type: 'button',
        disabled: true,  // enabled only when dirty
        onClick: () => this._savePersonaInstructions(id),
      }, 'Save');
      this._personaInstrSaveBtns[id] = saveBtn;

      // Last saved label
      const lastSavedEl = el('span', { className: 'adv-instr-last-saved' }, '');
      this._personaInstrLastSavedEls[id] = lastSavedEl;

      // Status element (Saving…, Error saving)
      const statusEl = el('span', { className: 'adv-instr-status' }, '');
      this._personaInstrStatusEls[id] = statusEl;

      const projectSection = el('div', { className: 'adv-instr-project-section adv-hidden' },
        el('div', { className: 'adv-instr-label-row' }, labelEl, counterEl),
        textarea,
        el('p', { className: 'adv-instr-tip' },
          'Be specific — name frameworks, compliance standards, or areas to ignore.'
        ),
        el('div', { className: 'adv-instr-footer' },
          el('div', { className: 'adv-instr-footer-meta' },
            lastSavedEl,
            statusEl,
          ),
          el('div', { className: 'adv-instr-footer-right' },
            el('span', { className: 'adv-instr-apply-note' }, 'Active on next run'),
            saveBtn,
          ),
        ),
      );
      tabPanel.appendChild(projectSection);
      this._personaInstrProjectSections = this._personaInstrProjectSections || {};
      this._personaInstrProjectSections[id] = projectSection;
      this._personaInstrCounterEls = this._personaInstrCounterEls || {};
      this._personaInstrCounterEls[id] = counterEl;

      tabPanelsContainer.appendChild(tabPanel);
      panelEls[id] = tabPanel;
    }

    // Store element maps for tab switching
    this._personaInstrTabEls = tabEls;
    this._personaInstrPanelEls = panelEls;

    // "Save as template" — captures current persona instructions as a reusable template.
    const saveAsTemplateBtn = el('button', {
      className: 'adv-instr-save-template-btn',
      type: 'button',
      title: 'Save current persona instructions as a reusable template',
      onClick: () => this._openSaveAsTemplateModal(),
    }, 'Save as template');
    this._saveAsTemplateBtn = saveAsTemplateBtn;

    panelBody.appendChild(
      el('div', { className: 'adv-instr-template-row' },
        saveAsTemplateBtn,
      )
    );

    this._personaInstrPanel = panel;

    // Subscribe to global instructions from /advisor/{personaId}
    this._subscribeGlobalInstructions();

    return panel;
  }

  /**
   * Switch the active persona instructions tab.
   * Warns user if the current tab has unsaved changes before switching.
   */
  _switchPersonaInstrTab(newId) {
    const currentId = this._personaInstrActiveTab;
    // Warn if current tab has unsaved changes
    if (currentId && currentId !== newId && this._personaInstrDirty[currentId]) {
      const confirmed = window.confirm(
        `You have unsaved changes to the ${currentId.charAt(0).toUpperCase() + currentId.slice(1)} persona instructions. Discard changes and switch tabs?`
      );
      if (!confirmed) {
        // Restore focus to current tab button
        this._personaInstrTabEls[currentId]?.focus();
        return;
      }
      // Discard changes: reset textarea to last fetched value
      const lastFetched = this._personaInstrLastFetched[currentId] || '';
      if (this._personaInstrTextareas[currentId]) {
        this._personaInstrTextareas[currentId].value = lastFetched;
      }
      this._personaInstrDirty[currentId] = false;
      if (this._personaInstrSaveBtns[currentId]) {
        this._personaInstrSaveBtns[currentId].disabled = true;
      }
      const counterEl = this._personaInstrCounterEls?.[currentId];
      if (counterEl) counterEl.textContent = '';
    }

    this._personaInstrActiveTab = newId;

    // Update tab aria-selected and visibility
    for (const [id, tabBtn] of Object.entries(this._personaInstrTabEls || {})) {
      const isActive = id === newId;
      tabBtn.setAttribute('aria-selected', String(isActive));
      tabBtn.classList.toggle('adv-instr-tab-active', isActive);
    }
    for (const [id, panelEl] of Object.entries(this._personaInstrPanelEls || {})) {
      panelEl.classList.toggle('adv-hidden', id !== newId);
    }
  }

  /**
   * Apply global or per-project scope mode for a persona instruction tab.
   * When useGlobal=true: show global textarea (read-only), hide project textarea.
   * When useGlobal=false: hide global textarea, show project textarea (editable).
   */
  _applyPersonaInstrScopeMode(personaId, useGlobal) {
    const globalSection = this._personaInstrGlobalSections?.[personaId];
    const projectSection = this._personaInstrProjectSections?.[personaId];
    if (globalSection) globalSection.classList.toggle('adv-hidden', !useGlobal);
    if (projectSection) projectSection.classList.toggle('adv-hidden', useGlobal);

    // Update scope label
    const projectId = this._filterProjectId;
    const project = this._projects.find(p => p.id === projectId);
    if (this._personaInstrScopeLabel) {
      if (!projectId) {
        this._personaInstrScopeLabel.textContent = 'Editing: Global defaults';
      } else if (useGlobal) {
        this._personaInstrScopeLabel.textContent = 'Using: Global defaults';
      } else {
        const name = project?.name || projectId;
        this._personaInstrScopeLabel.textContent = `Editing: Project — ${name}`;
      }
    }

    // Update global textarea content
    if (useGlobal) {
      const globalText = this._personaInstrGlobalData[personaId] || '';
      const globalTextarea = this._personaInstrGlobalTextareas?.[personaId];
      if (globalTextarea) {
        globalTextarea.value = globalText;
      }
      // Update global counter
      const globalCounter = this._personaInstrGlobalCounterEls?.[personaId];
      if (globalCounter) {
        globalCounter.textContent = globalText.length > 0 ? `${globalText.length} / 4000` : '';
      }
    }
  }

  /**
   * Subscribe to global persona instructions at /advisor/{engineer,design,product}.
   * These are the fallback when a project hasn't set per-project instructions.
   * Unsubscribes any existing listener first.
   */
  _subscribeGlobalInstructions() {
    if (this._personaInstrGlobalUnsub) {
      this._personaInstrGlobalUnsub();
      this._personaInstrGlobalUnsub = null;
    }
    if (!this.db) return;

    const personaIds = ['engineer', 'design', 'product'];
    const unsubs = [];

    for (const personaId of personaIds) {
      const unsub = this.db.collection('advisor').doc(personaId).onSnapshot(
        (snap) => {
          const data = snap.data() || {};
          const instructions = (typeof data.customInstructions === 'string') ? data.customInstructions : '';
          this._personaInstrGlobalData[personaId] = instructions;

          // If this persona's tab is currently showing global, refresh it
          if (this._personaInstrUseGlobal[personaId] !== false) {
            const globalTextarea = this._personaInstrGlobalTextareas?.[personaId];
            if (globalTextarea) {
              globalTextarea.value = instructions;
            }
            const globalCounter = this._personaInstrGlobalCounterEls?.[personaId];
            if (globalCounter) {
              globalCounter.textContent = instructions.length > 0 ? `${instructions.length} / 4000` : '';
            }
          }
        },
        (err) => {
          if (err.code !== 'permission-denied') {
            console.error(`AdvisorPanel: global instructions listener error for ${personaId}:`, err);
          }
        },
      );
      unsubs.push(unsub);
    }

    // Combine all unsubscribes into one
    this._personaInstrGlobalUnsub = () => unsubs.forEach(u => u());
  }

  /**
   * Save persona instructions (explicit save — no auto-save, no debounce).
   * DK-133: On save, write to Firestore. Confirm via aria-live region.
   */
  async _savePersonaInstructions(personaId) {
    const projectId = this._filterProjectId;
    if (!projectId) return;

    const textarea = this._personaInstrTextareas[personaId];
    if (!textarea) return;
    const text = textarea.value;

    if (text.length > 4000) {
      const statusEl = this._personaInstrStatusEls[personaId];
      if (statusEl) {
        statusEl.textContent = 'Too long (max 4000 characters)';
        statusEl.className = 'adv-instr-status adv-instr-status-err';
      }
      return;
    }

    const saveBtn = this._personaInstrSaveBtns[personaId];
    const statusEl = this._personaInstrStatusEls[personaId];
    const lastSavedEl = this._personaInstrLastSavedEls[personaId];

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = 'Saving…';
      statusEl.className = 'adv-instr-status';
    }

    try {
      const update = {
        [`personaInstructions.${personaId}`]: text.trim(),
        updatedAt: new Date().toISOString(),
      };
      await this.db.collection('projects').doc(projectId).update(update);

      this._personaInstrDirty[personaId] = false;
      this._personaInstrLastFetched[personaId] = text.trim();

      if (statusEl) {
        statusEl.textContent = '';
        statusEl.className = 'adv-instr-status';
      }

      // "Last saved: X minutes ago" — starts at "just now"
      if (lastSavedEl) {
        lastSavedEl.textContent = 'Last saved: just now';
        lastSavedEl._savedAt = Date.now();
        // Update every minute
        if (lastSavedEl._interval) clearInterval(lastSavedEl._interval);
        lastSavedEl._interval = setInterval(() => {
          const mins = Math.floor((Date.now() - lastSavedEl._savedAt) / 60000);
          lastSavedEl.textContent = mins < 1 ? 'Last saved: just now' : `Last saved: ${mins} minute${mins === 1 ? '' : 's'} ago`;
        }, 30000);
      }

      // aria-live confirmation
      if (this._personaInstrLiveRegion) {
        this._personaInstrLiveRegion.textContent = 'Saved — active on next run';
        setTimeout(() => {
          if (this._personaInstrLiveRegion) this._personaInstrLiveRegion.textContent = '';
        }, 4000);
      }
    } catch (err) {
      console.error(`AdvisorPanel: failed to save personaInstructions.${personaId}:`, err);
      if (statusEl) {
        statusEl.textContent = 'Error saving';
        statusEl.className = 'adv-instr-status adv-instr-status-err';
      }
      // Re-enable save so user can retry
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /** Render/update the persona instructions panel content for the current project. */
  _renderPersonaInstructionsPanel() {
    if (!this._personaInstrPanel) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      this._personaInstrPanel.style.display = 'none';
      return;
    }

    this._personaInstrPanel.style.display = '';

    const project = this._projects.find(p => p.id === projectId);
    const instructions = project?.personaInstructions || {};

    for (const id of ['engineer', 'design', 'product']) {
      const textarea = this._personaInstrTextareas[id];
      if (!textarea) continue;

      // Only update textarea when not dirty (user hasn't typed unsaved changes)
      if (!this._personaInstrDirty[id] && document.activeElement !== textarea) {
        const value = instructions[id] || '';
        textarea.value = value;
        this._personaInstrLastFetched[id] = value;

        // Reset counter
        const counterEl = this._personaInstrCounterEls?.[id];
        if (counterEl) counterEl.textContent = '';

        // Disable save button (not dirty)
        if (this._personaInstrSaveBtns[id]) {
          this._personaInstrSaveBtns[id].disabled = true;
        }
      }

      // Determine if project has custom override (non-empty project instructions)
      const hasProjectOverride = !!(instructions[id] && instructions[id].trim());

      // Default: show global if no project override exists, unless user explicitly toggled
      if (this._personaInstrUseGlobal[id] === undefined) {
        // First load: default to global if no project instructions, project if override exists
        this._personaInstrUseGlobal[id] = !hasProjectOverride;
      }

      // Sync toggle checkbox
      const toggleEl = this._personaInstrGlobalToggleEls?.[id];
      if (toggleEl) {
        toggleEl.checked = this._personaInstrUseGlobal[id];
      }

      // Apply scope mode
      this._applyPersonaInstrScopeMode(id, this._personaInstrUseGlobal[id]);
    }

    // Activate default tab (engineer) on first render
    if (!this._personaInstrTabsInitialized) {
      this._personaInstrTabsInitialized = true;
      this._switchPersonaInstrTab('engineer');
    }

    // Update scope label for current state
    this._updatePersonaInstrScopeLabel();
  }

  /** Update the scope label to reflect the current project and active tab. */
  _updatePersonaInstrScopeLabel() {
    if (!this._personaInstrScopeLabel) return;
    const projectId = this._filterProjectId;
    const project = this._projects.find(p => p.id === projectId);
    const activeId = this._personaInstrActiveTab;
    const useGlobal = this._personaInstrUseGlobal[activeId] !== false;

    if (!projectId) {
      this._personaInstrScopeLabel.textContent = 'Editing: Global defaults';
    } else if (useGlobal) {
      this._personaInstrScopeLabel.textContent = 'Using: Global defaults';
    } else {
      const name = project?.name || projectId;
      this._personaInstrScopeLabel.textContent = `Editing: Project — ${name}`;
    }
  }

  /** Save a single persona's instructions to Firestore. */
  // ── Persona config templates (DK-141) ────────────────────────

  /**
   * Subscribe to the current user's persona templates collection.
   * Uses the Firebase Auth user ID from the db.app.auth() reference.
   * Unsubscribes any existing listener first.
   */
  _subscribeTemplates() {
    // Clean up any previous subscription
    if (this._templatesUnsub) { this._templatesUnsub(); this._templatesUnsub = null; }

    let uid;
    try {
      uid = this.db.app.auth().currentUser?.uid;
    } catch (_) { /* auth not available */ }
    if (!uid) {
      // Not signed in yet — re-try after a short delay (auth race)
      setTimeout(() => { if (this._mounted) this._subscribeTemplates(); }, 2000);
      return;
    }

    const ref = this.db.collection('users').doc(uid).collection('personaTemplates');
    const unsub = ref.orderBy('lastUsedAt', 'desc').onSnapshot(
      (snap) => {
        this._templates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._renderTemplatesSection();
      },
      (err) => {
        // Permission-denied may be transient (auth propagation lag)
        if (err.code !== 'permission-denied') {
          console.error('AdvisorPanel: templates listener error', err);
        }
        // Retry after backoff
        if (this._mounted) {
          setTimeout(() => { if (this._mounted) this._subscribeTemplates(); }, 8000);
        }
      }
    );
    this._templatesUnsub = unsub;
  }

  /**
   * Build the "Settings > Templates" collapsible section at the bottom of the panel.
   * Hidden from users who have zero templates to avoid empty-state friction.
   */
  _buildTemplatesSection() {
    const section = el('div', { className: 'adv-templates-section' });

    const chevron = el('span', { className: 'adv-templates-chevron', 'aria-hidden': 'true' }, '▸');
    const header = el('button', {
      className: 'adv-templates-header',
      'aria-expanded': 'false',
      'aria-controls': 'adv-templates-body',
      onClick: () => {
        const isExpanded = header.getAttribute('aria-expanded') === 'true';
        header.setAttribute('aria-expanded', String(!isExpanded));
        chevron.textContent = isExpanded ? '▸' : '▾';
        body.classList.toggle('adv-hidden', isExpanded);
      },
    },
      chevron,
      el('span', { className: 'adv-templates-header-title' }, 'Templates'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-templates-body adv-hidden',
      id: 'adv-templates-body',
      role: 'region',
      'aria-label': 'Persona config templates',
    });
    section.appendChild(body);

    this._templatesSection = section;
    this._templatesSectionBody = body;

    // Start hidden — shown only when user has at least one template
    section.style.display = 'none';

    return section;
  }

  /**
   * Re-render the templates section body.
   * Shows the section only when at least one template exists.
   */
  _renderTemplatesSection() {
    if (!this._templatesSection || !this._templatesSectionBody) return;

    // Hide entirely if no templates
    if (this._templates.length === 0) {
      this._templatesSection.style.display = 'none';
      return;
    }

    this._templatesSection.style.display = '';

    // Rebuild body content
    const body = this._templatesSectionBody;
    body.innerHTML = '';

    body.appendChild(
      el('p', { className: 'adv-templates-intro' },
        'Saved persona instruction templates. Apply one when setting up a new project.'
      )
    );

    // List of templates — keyboard-navigable with visible focus states
    const list = el('div', { className: 'adv-templates-list', role: 'list' });

    for (const tmpl of this._templates) {
      list.appendChild(this._buildTemplateRow(tmpl));
    }

    body.appendChild(list);
  }

  /**
   * Build a single template row with name, description, last-used date,
   * rename and delete actions.
   */
  _buildTemplateRow(tmpl) {
    const row = el('div', { className: 'adv-template-row', role: 'listitem' });

    const lastUsed = tmpl.lastUsedAt
      ? (tmpl.lastUsedAt.toDate ? tmpl.lastUsedAt.toDate() : new Date(tmpl.lastUsedAt))
      : (tmpl.createdAt
          ? (tmpl.createdAt.toDate ? tmpl.createdAt.toDate() : new Date(tmpl.createdAt))
          : null);

    const lastUsedStr = lastUsed
      ? lastUsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    // Inline confirm state for delete
    let deleteConfirmPending = false;
    const confirmEl = el('span', { className: 'adv-template-delete-confirm adv-hidden' }, 'Delete?');

    const deleteBtn = el('button', {
      className: 'adv-template-delete-btn',
      type: 'button',
      title: `Delete template "${tmpl.name}"`,
      'aria-label': `Delete template ${tmpl.name}`,
      onClick: async () => {
        if (!deleteConfirmPending) {
          // First click — show inline confirmation
          deleteConfirmPending = true;
          confirmEl.classList.remove('adv-hidden');
          deleteBtn.textContent = 'Yes, delete';
          deleteBtn.classList.add('adv-template-delete-btn-confirm');
          // Auto-cancel after 4 seconds
          setTimeout(() => {
            if (deleteConfirmPending) {
              deleteConfirmPending = false;
              confirmEl.classList.add('adv-hidden');
              deleteBtn.textContent = 'Delete';
              deleteBtn.classList.remove('adv-template-delete-btn-confirm');
            }
          }, 4000);
        } else {
          // Second click — proceed with delete
          await this._deleteTemplate(tmpl.id, row);
        }
      },
    }, 'Delete');

    const renameBtn = el('button', {
      className: 'adv-template-rename-btn',
      type: 'button',
      title: `Rename template "${tmpl.name}"`,
      'aria-label': `Rename template ${tmpl.name}`,
      onClick: () => this._openRenameTemplateModal(tmpl),
    }, 'Rename');

    row.appendChild(
      el('div', { className: 'adv-template-meta' },
        el('span', { className: 'adv-template-name' }, tmpl.name),
        tmpl.description
          ? el('span', { className: 'adv-template-desc' }, tmpl.description)
          : null,
        el('span', { className: 'adv-template-last-used' }, `Last used: ${lastUsedStr}`),
      )
    );

    row.appendChild(
      el('div', { className: 'adv-template-actions' },
        confirmEl,
        renameBtn,
        deleteBtn,
      )
    );

    return row;
  }

  /**
   * Delete a template from Firestore.
   * @param {string} templateId
   * @param {HTMLElement} rowEl - DOM row to remove on success
   */
  async _deleteTemplate(templateId, rowEl) {
    let uid;
    try { uid = this.db.app.auth().currentUser?.uid; } catch (_) {}
    if (!uid) return;

    try {
      await this.db.collection('users').doc(uid)
        .collection('personaTemplates').doc(templateId).delete();
      // Row will be removed when the Firestore listener fires; optimistically hide it
      if (rowEl?.parentNode) rowEl.parentNode.removeChild(rowEl);
    } catch (err) {
      console.error('Failed to delete template:', err);
    }
  }

  /**
   * Open the "Save as template" modal.
   * Captures the current persona instructions from the visible textareas.
   */
  _openSaveAsTemplateModal() {
    this._closeSaveTemplateModal(); // close any existing one

    // Collect current instruction values from the textareas
    const config = {
      instructions: this._personaInstrTextareas['engineer']?.value?.trim() || '',
      scope: this._personaInstrTextareas['design']?.value?.trim() || '',
      triggers: this._personaInstrTextareas['product']?.value?.trim() || '',
    };

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSaveTemplateModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-save-template-modal' });

    // Header
    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', { className: 'adv-soul-modal-title' }, 'Save as template'),
        el('button', {
          className: 'adv-soul-modal-close',
          title: 'Close',
          'aria-label': 'Close dialog',
          onClick: () => this._closeSaveTemplateModal(),
        }, '×'),
      )
    );

    modal.appendChild(
      el('p', { className: 'adv-soul-modal-desc' },
        'Save the current persona instructions as a named template. ' +
        'Apply it when setting up new projects to skip repeated configuration.'
      )
    );

    // Name field (required, max 60 chars)
    const nameId = 'adv-template-name-input';
    const nameCounter = el('span', { className: 'adv-template-name-counter' }, '0 / 60');
    const nameInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: nameId,
      placeholder: 'e.g. Security-focused setup',
      maxlength: '60',
      'aria-required': 'true',
      onInput: () => {
        const len = nameInput.value.length;
        nameCounter.textContent = `${len} / 60`;
        nameCounter.className = 'adv-template-name-counter' + (len > 54 ? ' adv-template-counter-warn' : '');
      },
    });

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: nameId }, 'Template name'),
          el('span', { className: 'adv-template-required' }, '(required)'),
          nameCounter,
        ),
        nameInput,
      )
    );

    // Description field (optional, max 120 chars)
    const descId = 'adv-template-desc-input';
    const descCounter = el('span', { className: 'adv-template-name-counter' }, '0 / 120');
    const descInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: descId,
      placeholder: 'One-line description (optional)',
      maxlength: '120',
      onInput: () => {
        const len = descInput.value.length;
        descCounter.textContent = `${len} / 120`;
        descCounter.className = 'adv-template-name-counter' + (len > 108 ? ' adv-template-counter-warn' : '');
      },
    });

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: descId }, 'Description'),
          descCounter,
        ),
        descInput,
      )
    );

    // Footer
    const statusEl = el('span', { className: 'adv-soul-status' });
    const cancelBtn = el('button', {
      className: 'adv-soul-reset-btn',
      type: 'button',
      onClick: () => this._closeSaveTemplateModal(),
    }, 'Cancel');

    const saveBtn = el('button', {
      className: 'adv-soul-save-btn',
      type: 'button',
      onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          statusEl.textContent = 'Name is required.';
          statusEl.className = 'adv-soul-status adv-soul-status-err';
          nameInput.focus();
          return;
        }
        await this._saveTemplate(name, descInput.value.trim(), config, saveBtn, statusEl);
      },
    }, 'Save Template');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          cancelBtn,
          saveBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._saveTemplateModal = overlay;

    // Keyboard: Escape to close
    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeSaveTemplateModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._saveTemplateModal._keyHandler = onKey;

    // Focus the name input
    setTimeout(() => nameInput.focus(), 50);
  }

  _closeSaveTemplateModal() {
    if (this._saveTemplateModal) {
      if (this._saveTemplateModal._keyHandler) {
        document.removeEventListener('keydown', this._saveTemplateModal._keyHandler);
      }
      if (this._saveTemplateModal.parentNode) {
        this._saveTemplateModal.parentNode.removeChild(this._saveTemplateModal);
      }
      this._saveTemplateModal = null;
    }
  }

  /**
   * Write a new persona template document to Firestore.
   * @param {string} name
   * @param {string} description
   * @param {{ instructions: string, scope: string, triggers: string }} config
   * @param {HTMLButtonElement} saveBtn
   * @param {HTMLElement} statusEl
   */
  async _saveTemplate(name, description, config, saveBtn, statusEl) {
    let uid;
    try { uid = this.db.app.auth().currentUser?.uid; } catch (_) {}
    if (!uid) {
      statusEl.textContent = 'Not signed in.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    // Client-side length validation (belt-and-suspenders — rules also enforce)
    if (name.length > 60) {
      statusEl.textContent = 'Name must be 60 characters or fewer.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }
    if (description.length > 120) {
      statusEl.textContent = 'Description must be 120 characters or fewer.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    const now = new Date().toISOString();
    const doc = {
      name,
      description,
      createdAt: now,
      lastUsedAt: now,
      config: {
        instructions: (config.instructions || '').slice(0, 2000),
        scope:        (config.scope        || '').slice(0, 2000),
        triggers:     (config.triggers     || '').slice(0, 2000),
      },
    };

    try {
      await this.db.collection('users').doc(uid)
        .collection('personaTemplates').add(doc);

      statusEl.textContent = '✓ Template saved!';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';
      setTimeout(() => this._closeSaveTemplateModal(), 1200);
    } catch (err) {
      console.error('Failed to save template:', err);
      statusEl.textContent = 'Error saving template.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      saveBtn.disabled = false;
    }
  }

  /**
   * Open a rename modal for an existing template.
   * @param {{ id: string, name: string, description: string }} tmpl
   */
  _openRenameTemplateModal(tmpl) {
    this._closeSaveTemplateModal();

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSaveTemplateModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-save-template-modal' });

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', { className: 'adv-soul-modal-title' }, 'Rename template'),
        el('button', {
          className: 'adv-soul-modal-close',
          title: 'Close',
          'aria-label': 'Close dialog',
          onClick: () => this._closeSaveTemplateModal(),
        }, '×'),
      )
    );

    const nameId = 'adv-template-rename-input';
    const nameCounter = el('span', { className: 'adv-template-name-counter' }, `${tmpl.name.length} / 60`);
    const nameInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: nameId,
      maxlength: '60',
      'aria-required': 'true',
      onInput: () => {
        const len = nameInput.value.length;
        nameCounter.textContent = `${len} / 60`;
        nameCounter.className = 'adv-template-name-counter' + (len > 54 ? ' adv-template-counter-warn' : '');
      },
    });
    nameInput.value = tmpl.name;

    const descId = 'adv-template-rename-desc';
    const descCounter = el('span', { className: 'adv-template-name-counter' }, `${(tmpl.description || '').length} / 120`);
    const descInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: descId,
      maxlength: '120',
      placeholder: 'One-line description (optional)',
      onInput: () => {
        const len = descInput.value.length;
        descCounter.textContent = `${len} / 120`;
        descCounter.className = 'adv-template-name-counter' + (len > 108 ? ' adv-template-counter-warn' : '');
      },
    });
    descInput.value = tmpl.description || '';

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: nameId }, 'Template name'),
          el('span', { className: 'adv-template-required' }, '(required)'),
          nameCounter,
        ),
        nameInput,
      )
    );

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: descId }, 'Description'),
          descCounter,
        ),
        descInput,
      )
    );

    const statusEl = el('span', { className: 'adv-soul-status' });
    const cancelBtn = el('button', {
      className: 'adv-soul-reset-btn',
      type: 'button',
      onClick: () => this._closeSaveTemplateModal(),
    }, 'Cancel');

    const saveBtn = el('button', {
      className: 'adv-soul-save-btn',
      type: 'button',
      onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          statusEl.textContent = 'Name is required.';
          statusEl.className = 'adv-soul-status adv-soul-status-err';
          nameInput.focus();
          return;
        }
        saveBtn.disabled = true;
        statusEl.textContent = 'Saving…';
        statusEl.className = 'adv-soul-status';

        let uid;
        try { uid = this.db.app.auth().currentUser?.uid; } catch (_) {}
        if (!uid) { statusEl.textContent = 'Not signed in.'; statusEl.className = 'adv-soul-status adv-soul-status-err'; saveBtn.disabled = false; return; }

        try {
          await this.db.collection('users').doc(uid)
            .collection('personaTemplates').doc(tmpl.id)
            .update({ name, description: descInput.value.trim() });
          statusEl.textContent = '✓ Renamed!';
          statusEl.className = 'adv-soul-status adv-soul-status-ok';
          setTimeout(() => this._closeSaveTemplateModal(), 1000);
        } catch (err) {
          console.error('Failed to rename template:', err);
          statusEl.textContent = 'Error renaming.';
          statusEl.className = 'adv-soul-status adv-soul-status-err';
          saveBtn.disabled = false;
        }
      },
    }, 'Save');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          cancelBtn,
          saveBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._saveTemplateModal = overlay;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeSaveTemplateModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._saveTemplateModal._keyHandler = onKey;

    setTimeout(() => nameInput.focus(), 50);
  }

  /** Close the apply-template warning modal if open */
  _closeTemplateWarnModal() {
    if (this._templateWarnModal) {
      if (this._templateWarnModal.parentNode) {
        this._templateWarnModal.parentNode.removeChild(this._templateWarnModal);
      }
      this._templateWarnModal = null;
    }
  }

  /**
   * Show a preview of a template's fields before applying it to the project.
   * Called from the new project setup flow.
   * @param {{ name, config: { instructions, scope, triggers } }} tmpl
   * @param {function(config)} onApply - callback to receive the config after user confirms
   */
  _openTemplatePreviewModal(tmpl, onApply) {
    this._closeTemplateWarnModal();

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeTemplateWarnModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-template-preview-modal' });

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', { className: 'adv-soul-modal-title' }, `Apply template: ${tmpl.name}`),
        el('button', {
          className: 'adv-soul-modal-close',
          title: 'Close',
          'aria-label': 'Close dialog',
          onClick: () => this._closeTemplateWarnModal(),
        }, '×'),
      )
    );

    modal.appendChild(
      el('p', { className: 'adv-soul-modal-desc' },
        'The following fields will be pre-populated. Review them after applying — ' +
        'you must explicitly save each field to commit the changes.'
      )
    );

    // Field previews — checks for project-specific content (paths/repo names)
    const PATH_PATTERN = /\b(\/[\w/-]+|[\w-]+\.(js|ts|py|go|json|yml|yaml)|https?:\/\/)/i;

    const buildFieldPreview = (label, value, personaId) => {
      if (!value) return null;

      const hasPathRef = PATH_PATTERN.test(value);

      const preview = el('div', { className: 'adv-template-preview-field' },
        el('div', { className: 'adv-template-preview-field-label' }, label),
        el('pre', { className: 'adv-template-preview-field-value' }, value),
      );

      if (hasPathRef) {
        preview.appendChild(
          el('div', { className: 'adv-template-preview-warn' },
            el('span', { className: 'adv-template-preview-warn-icon', 'aria-hidden': 'true' }, '⚠'),
            el('span', {},
              'This field may reference paths from another project — review before saving.'
            ),
          )
        );
      }

      return preview;
    };

    const previewsEl = el('div', { className: 'adv-template-previews' });

    const instructionsPreview = buildFieldPreview('Engineer instructions', tmpl.config?.instructions, 'engineer');
    const scopePreview = buildFieldPreview('Design instructions', tmpl.config?.scope, 'design');
    const triggersPreview = buildFieldPreview('Product instructions', tmpl.config?.triggers, 'product');

    if (instructionsPreview) previewsEl.appendChild(instructionsPreview);
    if (scopePreview) previewsEl.appendChild(scopePreview);
    if (triggersPreview) previewsEl.appendChild(triggersPreview);

    if (!instructionsPreview && !scopePreview && !triggersPreview) {
      previewsEl.appendChild(
        el('p', { className: 'adv-template-preview-empty' }, 'This template has no instructions saved.')
      );
    }

    modal.appendChild(previewsEl);

    const cancelBtn = el('button', {
      className: 'adv-soul-reset-btn',
      type: 'button',
      onClick: () => this._closeTemplateWarnModal(),
    }, 'Cancel');

    const applyBtn = el('button', {
      className: 'adv-soul-save-btn',
      type: 'button',
      onClick: () => {
        this._closeTemplateWarnModal();
        if (onApply) onApply(tmpl.config || {});
      },
    }, 'Apply and edit');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        el('span', {}),
        el('div', { className: 'adv-soul-modal-footer-right' },
          cancelBtn,
          applyBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._templateWarnModal = overlay;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeTemplateWarnModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._templateWarnModal._keyHandler = onKey;

    setTimeout(() => applyBtn.focus(), 50);
  }

  /**
   * Get the current list of templates (for use in the new project modal).
   * @returns {Array}
   */
  getTemplates() {
    return this._templates || [];
  }

  /** Toggle the context panel open/closed. */
  _toggleContextPanel() {
    this._contextPanelOpen = !this._contextPanelOpen;
    if (this._contextPanel) {
      this._contextPanel.style.display = this._contextPanelOpen ? '' : 'none';
    }
    if (this._contextBtn) {
      this._contextBtn.classList.toggle('adv-context-btn-active', this._contextPanelOpen);
    }
    if (this._contextPanelOpen) {
      this._renderContextPanel();
    }
  }

  /** Render/update the context panel content for the current project. */
  _renderContextPanel() {
    if (!this._contextPanel || !this._contextTextarea) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      // No project selected — hide panel and button
      this._contextPanel.style.display = 'none';
      this._contextPanelOpen = false;
      if (this._contextBtn) {
        this._contextBtn.style.display = 'none';
        this._contextBtn.classList.remove('adv-context-btn-active');
      }
      // Unsubscribe presets when no project
      if (this._presetsProjectId) {
        this._subscribePresets(null);
      }
      return;
    }

    // Show button when a project is selected
    if (this._contextBtn) this._contextBtn.style.display = '';

    // Subscribe to presets for this project if not already
    if (this._presetsProjectId !== projectId) {
      this._subscribePresets(projectId);
    }

    if (!this._contextPanelOpen) return;

    const project = this._projects.find(p => p.id === projectId);

    // Sync active preset ID from project doc
    const serverActivePresetId = project?.activePresetId || null;
    if (serverActivePresetId !== this._lastAppliedPresetId) {
      this._lastAppliedPresetId = serverActivePresetId;
      this._contextDirty = false;
    }

    // Only update textarea value when not actively dirty (avoid overwriting user edits)
    if (!this._contextDirty) {
      this._contextTextarea.value = project?.advisorContext || '';
      this._updateContextHints(this._contextTextarea);
    }

    // DK-302: Populate priorities field from project doc (no dirty guard — autosave keeps it in sync)
    if (this._prioritiesTextarea) {
      const priorities = project?.priorities || '';
      this._prioritiesTextarea.value = priorities;
      if (this._prioritiesCharCountEl) {
        const len = priorities.length;
        this._prioritiesCharCountEl.textContent = `${len} / 500`;
        this._prioritiesCharCountEl.classList.toggle('adv-priorities-charcount--warn', len > 400);
        this._prioritiesCharCountEl.classList.toggle('adv-priorities-charcount--over', len > 500);
      }
      this._updatePrioritiesTimestamp(project?.prioritiesUpdatedAt || null);
    }

    this._updatePresetSelector();
    this._updatePresetDriftIndicator();
  }

  _buildProjectsSection() {
    // Legacy method kept for compatibility — no longer added to DOM.
    // Projects section has been replaced by the header Context button.
    return el('div', { style: 'display:none' });
  }

  // ── Firestore listeners ──────────────────────────────────────

  _startListeners() {
    // Built-in persona state listeners
    for (const { id } of PERSONAS) {
      this._subscribePersona(id);
    }

    // Custom persona definitions listener
    this._subscribeCustomPersonas();

    // Projects listener
    this._subscribeProjects();

    // DK-194: Consensus gate Firestore listener (/advisor/consensusGate)
    this._subscribeConsensusGate();

    // Feedback stats — load once at mount (deferred slightly so project list loads first)
    setTimeout(() => {
      if (this._mounted) {
        for (const { id } of PERSONAS) {
          this._loadFeedbackStats(id);
        }
      }
    }, 2000);

    // Persona config templates — subscribe when auth user is available (DK-141)
    this._subscribeTemplates();

    // DK-188: Subscribe to global confidence threshold config
    this._subscribeConfidenceConfig();
  }

  // Returns true when a permission-denied error should be treated as a transient
  // auth race rather than a genuine permissions problem.
  //
  // Firestore can fire permission-denied before the Firebase ID token has fully
  // propagated to the Firestore client — even after getIdToken() has been called.
  // As long as the user is still authenticated, the listener retry will self-heal,
  // so we log these as console.warn (not console.error) to keep the console clean.
  //
  // We only escalate to console.error when the user is NOT signed in (a genuine
  // auth problem that the retry loop cannot fix by itself).
  _isPermissionDeniedTransient(err) {
    if (err.code !== 'permission-denied') return false;
    try {
      return !!this.db.app.auth().currentUser;
    } catch (_) {
      // If we can't access auth state, fall back to treating it as transient
      // (the retry loop will keep trying; a real error will surface eventually).
      return true;
    }
  }

  // Subscribe (or re-subscribe) to a single persona's Firestore document.
  // On error the listener is dead, so we retry after a backoff delay so the
  // panel resumes updating once permissions are restored (e.g. after rule deploy).
  _subscribePersona(id, retryDelayMs = 5000) {
    const ref = this.db.collection('advisor').doc(id);
    const unsub = ref.onSnapshot(
      (snap) => {
        this._statesReceived[id] = true;
        this._states[id] = snap.exists ? snap.data() : null;
        this._renderCard(id);
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn(`AdvisorPanel: listener error for ${id} (transient, retrying)`, err);
        } else {
          console.error(`AdvisorPanel: listener error for ${id}`, err);
        }
        // Do not clear state on error — preserve last known state so the panel
        // continues to show the correct status instead of incorrectly showing "Offline".
        // Only set to null (and show Offline) if we have never received any data.
        if (!this._statesReceived[id]) {
          this._states[id] = null;
          this._renderCard(id);
        }
        // Firestore terminates the listener on error. Schedule a retry so the
        // panel automatically recovers once permissions are in place.
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000); // cap at 60s
          setTimeout(() => {
            if (this._mounted) this._subscribePersona(id, delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(unsub);
  }

  // Subscribe (or re-subscribe) to the projects collection.
  _subscribeProjects(retryDelayMs = 5000) {
    const projectsUnsub = this.db.collection('projects').onSnapshot(
      (snap) => {
        this._projects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._projects.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        this._renderProjects();
        // Re-render all persona cards when project data changes: advisor settings
        // (pause, interval, ticketCap, savedFocusPrompt) are now stored per-project
        // in the project doc, so card display must update when project data changes.
        if (this._filterProjectId) {
          for (const { id } of PERSONAS) {
            this._renderCard(id);
          }
          // DK-105: Refresh emphasis weights UI to reflect the latest stored weights
          for (const key of Object.keys(PERSONA_CONCERNS)) {
            this._updateWeightsUI(key);
          }
        }
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn('AdvisorPanel: projects listener error (transient, retrying)', err);
        } else {
          console.error('AdvisorPanel: projects listener error', err);
        }
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000);
          setTimeout(() => {
            if (this._mounted) this._subscribeProjects(delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(projectsUnsub);
  }

  // DK-194: Subscribe to /advisor/consensusGate Firestore document.
  // Mirrors the pause toggle pattern. Writes from the UI go here; the daemon reads this.
  _subscribeConsensusGate(retryDelayMs = 5000) {
    const ref = this.db.collection('advisor').doc('consensusGate');
    const unsub = ref.onSnapshot(
      (snap) => {
        this._consensusGate = snap.exists ? snap.data() : null;
        this._renderConsensusGatePanel();
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn('AdvisorPanel: consensusGate listener error (transient, retrying)', err);
        } else {
          console.error('AdvisorPanel: consensusGate listener error', err);
        }
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000);
          setTimeout(() => {
            if (this._mounted) this._subscribeConsensusGate(delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(unsub);
  }

  /** Build the cross-review consensus gate panel (DK-194). */
  _buildConsensusGatePanel() {
    const panel = el('div', {
      className: 'adv-consensus-gate-panel',
    });

    // Panel header — collapsible toggle (matches persona toggles panel pattern)
    const panelChevron = el('span', { className: 'adv-consensus-gate-chevron', 'aria-hidden': 'true' }, '▸');
    const panelHeader = el('button', {
      className: 'adv-persona-toggles-header', // reuse style
      'aria-expanded': 'false',
      'aria-controls': 'adv-consensus-gate-body',
      onClick: () => {
        const isExpanded = panelHeader.getAttribute('aria-expanded') === 'true';
        panelHeader.setAttribute('aria-expanded', String(!isExpanded));
        panelChevron.textContent = isExpanded ? '▸' : '▾';
        panelBody.classList.toggle('adv-hidden', isExpanded);
      },
    },
      panelChevron,
      el('span', { className: 'adv-persona-toggles-title' }, 'Cross-review gate'),
    );
    panel.appendChild(panelHeader);

    const panelBody = el('div', {
      className: 'adv-persona-toggles-body adv-hidden',
      id: 'adv-consensus-gate-body',
    });
    panel.appendChild(panelBody);

    panelBody.appendChild(
      el('p', { className: 'adv-persona-toggles-intro' },
        'Require cross-review before tickets are created. When enabled, a ticket proposed by one advisor must be endorsed by other personas before it moves to the backlog.'
      )
    );

    // Toggle row
    const toggleId = 'adv-consensus-gate-toggle';
    const toggle = el('input', {
      type: 'checkbox',
      id: toggleId,
      className: 'adv-persona-toggle-input',
      'aria-label': 'Require cross-review before tickets are created',
      'aria-describedby': 'adv-consensus-gate-status',
      onChange: () => this._onConsensusGateToggle(toggle.checked),
    });
    this._consensusGateToggle = toggle;

    const toggleThumb = el('span', { className: 'adv-persona-toggle-thumb' });
    const toggleTrack = el('span', { className: 'adv-persona-toggle-track', 'aria-hidden': 'true' }, toggleThumb);
    const toggleLabel = el('label', {
      className: 'adv-persona-toggle-label',
      htmlFor: toggleId,
    },
      el('div', { className: 'adv-persona-toggle-switch-wrap' }, toggle, toggleTrack),
      el('span', { className: 'adv-persona-toggle-label-text' },
        el('span', { className: 'adv-persona-toggle-name' }, 'Require cross-review before tickets are created'),
      )
    );

    panelBody.appendChild(el('div', { className: 'adv-persona-toggle-row' }, toggleLabel));

    // Threshold row
    const thresholdId = 'adv-consensus-gate-threshold';
    const thresholdInput = el('input', {
      type: 'number',
      id: thresholdId,
      min: '2',
      max: '3',
      value: '2',
      className: 'adv-consensus-gate-threshold-input',
      'aria-label': 'Number of personas that must agree',
      'aria-describedby': 'adv-consensus-gate-threshold-desc adv-consensus-gate-status',
      onChange: () => this._onConsensusGateThresholdChange(thresholdInput.value),
      onInput: () => this._validateConsensusGateThreshold(thresholdInput.value),
    });
    this._consensusGateThreshold = thresholdInput;

    const thresholdDesc = el('span', {
      id: 'adv-consensus-gate-threshold-desc',
      className: 'adv-consensus-gate-threshold-desc',
    }, 'of 3 personas must agree');
    this._consensusGateThresholdDesc = thresholdDesc;

    panelBody.appendChild(
      el('div', { className: 'adv-consensus-gate-threshold-row' },
        el('label', { htmlFor: thresholdId, className: 'adv-consensus-gate-threshold-label' },
          'Threshold: '
        ),
        thresholdInput,
        thresholdDesc,
      )
    );

    // Status / validation message
    const statusEl = el('div', {
      id: 'adv-consensus-gate-status',
      className: 'adv-consensus-gate-status',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    this._consensusGateStatus = statusEl;
    panelBody.appendChild(statusEl);

    this._consensusGatePanel = panel;
    return panel;
  }

  /** Render/update the consensus gate panel from Firestore data. */
  _renderConsensusGatePanel() {
    if (!this._consensusGateToggle || !this._consensusGateThreshold) return;

    const data = this._consensusGate || {};
    const enabled = !!data.enabled;
    const threshold = typeof data.threshold === 'number' ? data.threshold : 2;

    this._consensusGateToggle.checked = enabled;
    this._consensusGateThreshold.value = String(threshold);
    this._consensusGateThreshold.disabled = !enabled;

    // Update threshold descriptor: "of N personas must agree"
    const enabledCount = this._getEnabledPersonaCount();
    if (this._consensusGateThresholdDesc) {
      this._consensusGateThresholdDesc.textContent = `of ${enabledCount} persona${enabledCount !== 1 ? 's' : ''} must agree`;
      this._consensusGateThreshold.max = String(enabledCount);
    }

    // Clear status if no errors
    if (this._consensusGateStatus) {
      this._consensusGateStatus.textContent = '';
      this._consensusGateStatus.className = 'adv-consensus-gate-status';
    }

    // Show contextual note when first enabled
    if (enabled && this._consensusGateStatus && !this._consensusGateStatus.textContent) {
      this._consensusGateStatus.textContent =
        'Cross-review is active. Pending tickets may take time to accumulate endorsements depending on persona intervals.';
      this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-note';
    }
  }

  /** Return the count of currently enabled (non-disabled) built-in personas. */
  _getEnabledPersonaCount() {
    // Count personas that are not explicitly disabled for the current project.
    // Absent keys = enabled (default). Uses the same logic as _renderPersonaTogglesPanel.
    const project = this._projects.find(p => p.id === this._filterProjectId);
    const personas = project?.advisor?.personas || {};
    let count = 0;
    for (const id of ['engineer', 'design', 'product']) {
      if (personas[id] !== false) count++;
    }
    // Fall back to total built-in count if no project selected
    return count > 0 ? count : 3;
  }

  /** Validate consensus gate threshold and show inline error if needed. */
  _validateConsensusGateThreshold(rawValue) {
    if (!this._consensusGateStatus) return true;
    const val = parseInt(rawValue, 10);
    const enabledCount = this._getEnabledPersonaCount();
    if (!Number.isInteger(val) || val < 2) {
      this._consensusGateStatus.textContent = 'Threshold must be at least 2.';
      this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-error';
      return false;
    }
    if (val > enabledCount) {
      this._consensusGateStatus.textContent = `Only ${enabledCount} persona${enabledCount !== 1 ? 's' : ''} are enabled — threshold cannot be ${val}.`;
      this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-error';
      return false;
    }
    this._consensusGateStatus.textContent = '';
    this._consensusGateStatus.className = 'adv-consensus-gate-status';
    return true;
  }

  /** Handle consensus gate toggle change. */
  async _onConsensusGateToggle(enabled) {
    if (this._consensusGateSaving) return;
    this._consensusGateSaving = true;
    if (this._consensusGateToggle) this._consensusGateToggle.disabled = true;
    try {
      const threshold = parseInt(this._consensusGateThreshold?.value || '2', 10);
      const safeThreshold = Number.isInteger(threshold) && threshold >= 2 ? threshold : 2;
      if (enabled && !this._validateConsensusGateThreshold(String(safeThreshold))) {
        // Validation failed — revert toggle
        if (this._consensusGateToggle) this._consensusGateToggle.checked = false;
        return;
      }
      await this.db.collection('advisor').doc('consensusGate').set({
        enabled,
        threshold: safeThreshold,
        maxProposedTickets: this._consensusGate?.maxProposedTickets ?? 5,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      // onSnapshot will fire and update the UI
    } catch (err) {
      console.error('AdvisorPanel: failed to update consensus gate', err);
      if (this._consensusGateStatus) {
        this._consensusGateStatus.textContent = 'Failed to save — please try again.';
        this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-error';
      }
    } finally {
      this._consensusGateSaving = false;
      if (this._consensusGateToggle) this._consensusGateToggle.disabled = false;
    }
  }

  /** Handle consensus gate threshold change. */
  async _onConsensusGateThresholdChange(rawValue) {
    if (!this._validateConsensusGateThreshold(rawValue)) return;
    if (this._consensusGateSaving) return;
    const val = parseInt(rawValue, 10);
    const enabled = !!this._consensusGate?.enabled;
    if (!enabled) return; // only save when gate is on
    this._consensusGateSaving = true;
    try {
      await this.db.collection('advisor').doc('consensusGate').set({
        threshold: val,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (err) {
      console.error('AdvisorPanel: failed to update consensus gate threshold', err);
    } finally {
      this._consensusGateSaving = false;
    }
  }

  // Subscribe to /advisorPersonas collection (custom persona definitions).
  // When a custom persona is added/removed, also subscribe/unsubscribe
  // to its /advisor/{id} state document for live status.
  _subscribeCustomPersonas(retryDelayMs = 5000) {
    const unsub = this.db.collection('advisorPersonas').onSnapshot(
      (snap) => {
        const personas = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
        personas.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

        // Subscribe to state for any new custom personas
        const currentIds = new Set(this._customPersonas.map(p => p.id));
        for (const p of personas) {
          const pid = p.id || p._docId;
          if (!currentIds.has(pid) && !this._cards[pid]) {
            this._subscribePersona(pid);
          }
        }

        this._customPersonas = personas;
        this._renderCustomPersonas();
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn('AdvisorPanel: custom personas listener error (transient, retrying)', err);
        } else {
          console.error('AdvisorPanel: custom personas listener error', err);
        }
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000);
          setTimeout(() => {
            if (this._mounted) this._subscribeCustomPersonas(delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(unsub);
  }

  // ── Per-card history toggle ───────────────────────────────────

  _toggleCardHistory(personaId) {
    const isOpen = !this._historyOpen[personaId];
    this._historyOpen[personaId] = isOpen;

    const card = this._cards[personaId];
    const panel = this._historyPanels[personaId];
    if (!card || !panel) return;

    if (isOpen) {
      panel.classList.remove('adv-hidden');
      card.historyToggleBtn.textContent = 'History ▾';
      card.historyToggleBtn.setAttribute('aria-expanded', 'true');
      card.historyRefreshBtn.classList.remove('adv-hidden');
      // Load runs if not yet loaded
      if (!this._historyRuns[personaId]) {
        this._loadHistoryRuns(personaId);
      }
    } else {
      panel.classList.add('adv-hidden');
      card.historyToggleBtn.textContent = 'History ▸';
      card.historyToggleBtn.setAttribute('aria-expanded', 'false');
      card.historyRefreshBtn.classList.add('adv-hidden');
    }
  }

  /**
   * Subscribe to the advisorRuns collection for a given persona.
   * Shows a loading state, then renders runs when data arrives.
   * When a project is selected (_filterProjectId is set), the query is scoped
   * to that project only. When no project is selected (null), all projects are
   * shown for this persona.
   * On error, retries with exponential backoff (matches the pattern used by
   * _subscribePersona and _subscribeCustomPersonas) so transient auth failures
   * on page load self-heal once the Firebase ID token is ready.
   */
  _loadHistoryRuns(personaId, retryDelayMs = 5000) {
    // Cancel any existing listener for this persona
    if (this._historyUnsubs[personaId]) {
      this._historyUnsubs[personaId]();
      delete this._historyUnsubs[personaId];
    }

    this._historyLoading[personaId] = true;
    this._historyRuns[personaId] = null;
    this._renderHistoryPanel(personaId);

    let query = this.db.collection('advisorRuns')
      .where('persona', '==', personaId);
    // Scope to the currently selected project when one is active
    if (this._filterProjectId) {
      query = query.where('projectId', '==', this._filterProjectId);
    }
    query = query.orderBy('startedAt', 'desc').limit(20);

    const unsub = query.onSnapshot(
      (snap) => {
        this._historyLoading[personaId] = false;
        this._historyRuns[personaId] = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        this._renderHistoryPanel(personaId);
        // Re-render persona card so the summary line picks up the latest run
        this._renderCard(personaId);
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn(`AdvisorPanel: history listener error for ${personaId} (transient, retrying)`, err);
        } else {
          console.error(`AdvisorPanel: history listener error for ${personaId}`, err);
        }
        this._historyLoading[personaId] = false;
        if (this._historyRuns[personaId] === null) {
          // Show empty state rather than hanging spinner on error
          this._historyRuns[personaId] = [];
        }
        this._renderHistoryPanel(personaId);
        // Firestore terminates the listener on error. Schedule a retry so the
        // panel automatically recovers once permissions are in place (e.g. after
        // a transient auth token delay on page load or a rules re-deploy).
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000); // cap at 60s
          setTimeout(() => {
            if (this._mounted) this._loadHistoryRuns(personaId, delay * 2);
          }, delay);
        }
      }
    );

    this._historyUnsubs[personaId] = unsub;
  }

  _renderHistoryPanel(personaId) {
    const panel = this._historyPanels[personaId];
    if (!panel) return;
    panel.innerHTML = '';

    if (this._historyLoading[personaId]) {
      panel.appendChild(el('div', { className: 'adv-history-loading', 'aria-busy': 'true' },
        el('span', { className: 'adv-history-spinner', 'aria-hidden': 'true' }),
        el('span', {}, 'Loading…'),
      ));
      return;
    }

    const runs = this._historyRuns[personaId];
    if (!runs || runs.length === 0) {
      const persona = PERSONAS.find(p => p.id === personaId);
      const hours = persona ? persona.defaultHours : '?';
      panel.appendChild(
        el('div', { className: 'adv-history-empty' },
          `Runs every ~${hours}h — more history will appear over time.`
        )
      );
      return;
    }

    if (runs.length < 3) {
      const persona = PERSONAS.find(p => p.id === personaId);
      const hours = persona ? persona.defaultHours : '?';
      panel.appendChild(
        el('div', { className: 'adv-history-hint' },
          `Runs every ~${hours}h — more history will appear over time.`
        )
      );
    }

    // 7-run trend summary (above the list)
    const trendText = buildRunTrendText(runs);
    if (trendText) {
      panel.appendChild(
        el('div', { className: 'adv-history-trend' }, trendText)
      );
    }

    const list = el('div', { className: 'adv-history-list' });

    for (const run of runs) {
      list.appendChild(this._buildHistoryRow(run, personaId));
    }

    panel.appendChild(list);
  }

  _buildHistoryRow(run, personaId) {
    const runId = run._id || `${run.startedAt}-${run.status}`;
    const isExpanded = !!this._historyExpanded[runId];

    const relTime = formatRelativeTs(run.startedAt) || '—';
    const absTime = formatAbsolute(run.startedAt);

    // Derive counts from rich arrays (new schema) or fall back to legacy scalar fields
    const created = Array.isArray(run.created) ? run.created : [];
    const rejected = Array.isArray(run.rejected) ? run.rejected : [];
    const scanned = Array.isArray(run.scanned) ? run.scanned : [];
    const createdCount = created.length || run.proposalsCreated || 0;
    const rejectedCount = rejected.length;

    // Status badge: completed / failed / running (new schema) or ok/quiet/error (legacy)
    const statusNorm = run.status === 'ok' ? 'completed'
      : run.status === 'quiet' ? 'completed'
      : run.status === 'error' ? 'failed'
      : run.status || 'completed';

    const statusClass = {
      completed: 'adv-badge-ok',
      failed:    'adv-badge-error',
      running:   'adv-badge-quiet',
    }[statusNorm] || 'adv-badge-ok';

    const statusLabel = {
      completed: 'ok',
      failed:    'error',
      running:   'running',
    }[statusNorm] || statusNorm;

    // Detail region id
    const detailId = `adv-run-detail-${runId}`;

    // ── Collapsed row ──────────────────────────────────────────
    const triggerBtn = el('button', {
      className: 'adv-history-row-trigger',
      'aria-expanded': String(isExpanded),
      'aria-controls': detailId,
      onClick: () => {
        const nowExpanded = !this._historyExpanded[runId];
        this._historyExpanded[runId] = nowExpanded;
        // Re-render the panel to reflect the new expanded state
        this._renderHistoryPanel(personaId);
      },
    });

    triggerBtn.appendChild(
      el('span', {
        className: 'adv-history-row-time',
        title: absTime,
        'aria-label': `${relTime} (${absTime})`,
      }, relTime)
    );

    triggerBtn.appendChild(
      el('span', { className: `adv-badge ${statusClass}` }, statusLabel)
    );

    // DK-367: Scope chip — shown inline when run has a scopeText
    const scopeText = typeof run.scopeText === 'string' && run.scopeText.trim()
      ? run.scopeText.trim()
      : null;
    if (scopeText) {
      const truncatedScope = scopeText.length > 40 ? scopeText.slice(0, 40) + '…' : scopeText;
      triggerBtn.appendChild(
        el('span', {
          className: 'adv-history-scope-chip',
          title: scopeText,
          'aria-label': `Run scoped to: ${scopeText}`,
        }, `Focus: ${truncatedScope}`)
      );
    }

    // Summary: "2 created · 3 rejected · 5/8 relevant" (new schema) or legacy "N proposals"
    const summaryParts = [];
    if (createdCount > 0) summaryParts.push(`${createdCount} created`);
    if (rejectedCount > 0) {
      // Group by reason for the summary
      const byCounts = rejectionCounts(rejected);
      const bucketStr = Object.entries(byCounts)
        .map(([reason, n]) => `${n} ${REJECTION_REASON_LABELS[reason] || reason}`)
        .join(', ');
      summaryParts.push(`${rejectedCount} rejected${bucketStr ? ` (${bucketStr})` : ''}`);
    }
    // Feedback ratio: only shown when at least one ticket has been rated
    if (run.feedbackSummary && run.feedbackSummary.total > 0) {
      const fs = run.feedbackSummary;
      summaryParts.push(`${fs.relevant}/${fs.total} relevant`);
    }
    if (summaryParts.length === 0 && createdCount === 0 && rejectedCount === 0) {
      summaryParts.push('nothing found');
    }

    triggerBtn.appendChild(
      el('span', { className: 'adv-history-row-proposals' }, summaryParts.join(' · '))
    );

    triggerBtn.appendChild(
      el('span', { className: 'adv-history-row-chevron', 'aria-hidden': 'true' },
        isExpanded ? '▾' : '▸'
      )
    );

    const row = el('div', { className: 'adv-history-row' }, triggerBtn);

    // ── Expanded detail ────────────────────────────────────────
    const detail = el('div', {
      className: 'adv-history-detail' + (isExpanded ? '' : ' adv-hidden'),
      id: detailId,
      role: 'region',
    });

    if (isExpanded) {
      const duration = formatDuration(run.durationMs);

      // DK-367: Scope callout — shown when run was scoped to a specific area
      if (scopeText) {
        detail.appendChild(
          el('div', { className: 'adv-history-scope-callout', role: 'note' },
            el('span', { className: 'adv-history-scope-callout-label' }, 'This run was scoped to:'),
            ' ',
            el('span', { className: 'adv-history-scope-callout-value' }, scopeText),
            el('span', { className: 'adv-history-scope-callout-hint' }, ' — results will differ from unscoped runs.')
          )
        );
      }

      // Duration
      detail.appendChild(el('div', { className: 'adv-history-detail-row' },
        el('span', { className: 'adv-detail-label' }, 'Duration'),
        el('span', { className: 'adv-detail-val' }, duration),
      ));

      // Error (if any)
      const errorReason = run.error || run.errorReason;
      if ((statusNorm === 'failed' || run.status === 'error') && errorReason) {
        const errorLabel = ERROR_REASON_LABELS[errorReason] || errorReason;
        detail.appendChild(el('div', { className: 'adv-history-detail-row adv-history-detail-error' },
          el('span', { className: 'adv-detail-label' }, 'Error'),
          el('span', { className: 'adv-detail-val adv-detail-val-error' }, errorLabel),
        ));
      }

      // ── Feedback ratio ────────────────────────────────────────
      // feedbackSummary is written by the aggregate job after a run completes.
      // Shows as "N / M relevant" where N=relevant, M=total rated.
      // Only displayed when at least one ticket has been rated.
      if (run.feedbackSummary && run.feedbackSummary.total > 0) {
        const fs = run.feedbackSummary;
        const ratioText = `${fs.relevant} / ${fs.total} relevant`;
        detail.appendChild(el('div', { className: 'adv-history-detail-row' },
          el('span', { className: 'adv-detail-label' }, 'Feedback'),
          el('span', { className: 'adv-detail-val adv-feedback-ratio' }, ratioText),
        ));
      }

      // ── Rejected tickets section (lead with this per design notes) ──
      if (rejected.length > 0) {
        detail.appendChild(this._buildRejectedSection(rejected));
      }

      // ── Created tickets section ─────────────────────────────
      if (created.length > 0) {
        detail.appendChild(this._buildCreatedSection(created));
      }

      // ── Scan list ────────────────────────────────────────────
      if (scanned.length > 0) {
        detail.appendChild(this._buildScanListSection(scanned, personaId));
      } else {
        // Legacy fields
        const files = run.filesScanned ?? 0;
        const urls  = run.urlsScanned ?? 0;
        if (files > 0 || urls > 0) {
          const scanCount = personaId === 'design' ? urls : files;
          const scanLabel = personaId === 'design' ? 'URLs scanned' : 'Files scanned';
          detail.appendChild(el('div', { className: 'adv-history-detail-row' },
            el('span', { className: 'adv-detail-label' }, scanLabel),
            el('span', { className: 'adv-detail-val' }, String(scanCount)),
          ));
        }
      }
    }

    row.appendChild(detail);
    return row;
  }

  /**
   * Build the rejected tickets section for an expanded run detail.
   * Groups items by rejection reason.
   *
   * @param {Array<{title, reason, matchedTicketId?, score?}>} rejected
   * @returns {HTMLElement}
   */
  _buildRejectedSection(rejected) {
    const section = el('div', { className: 'adv-run-rejected-section' });
    section.appendChild(
      el('div', { className: 'adv-run-section-header' }, 'Rejected')
    );

    // Group by reason
    const groups = {};
    for (const item of rejected) {
      const r = item.reason || 'unknown';
      if (!groups[r]) groups[r] = [];
      groups[r].push(item);
    }

    for (const [reason, items] of Object.entries(groups)) {
      const label = REJECTION_REASON_LABELS[reason] || reason;
      const icon = REJECTION_REASON_ICONS[reason] || '○';
      const groupId = `adv-rej-group-${reason}-${Math.random().toString(36).slice(2, 7)}`;

      const groupHeader = el('button', {
        className: 'adv-rej-group-header',
        'aria-expanded': 'false',
        'aria-controls': groupId,
        onClick: () => {
          const isExp = groupHeader.getAttribute('aria-expanded') === 'true';
          groupHeader.setAttribute('aria-expanded', String(!isExp));
          groupList.classList.toggle('adv-hidden', isExp);
          groupChevron.textContent = isExp ? '▸' : '▾';
        },
      });

      const groupChevron = el('span', { className: 'adv-rej-chevron', 'aria-hidden': 'true' }, '▸');
      groupHeader.appendChild(
        el('span', {
          className: `adv-rej-reason-badge adv-rej-reason-${reason}`,
          'aria-label': label,
        },
          el('span', { 'aria-hidden': 'true' }, icon),
          el('span', {}, ` ${label}`)
        )
      );
      groupHeader.appendChild(
        el('span', { className: 'adv-rej-count' }, `${items.length}`)
      );
      groupHeader.appendChild(groupChevron);

      const groupList = el('ul', { className: 'adv-rej-list adv-hidden', id: groupId, role: 'list' });
      for (const item of items) {
        const li = el('li', { className: 'adv-rej-item' });

        const titleEl = el('span', { className: 'adv-rej-title' }, item.title);
        li.appendChild(titleEl);

        // "why?" tooltip
        const whyText = buildWhyText(item);
        if (whyText) {
          const whyBtn = el('button', {
            className: 'adv-rej-why-btn',
            'aria-label': `Why this was rejected: ${whyText}`,
            title: whyText,
          }, 'why?');
          li.appendChild(whyBtn);
        }

        groupList.appendChild(li);
      }

      section.appendChild(groupHeader);
      section.appendChild(groupList);
    }

    return section;
  }

  /**
   * Build the created tickets section (ticket IDs linking to the board).
   * @param {string[]} created - Array of ticket IDs
   * @returns {HTMLElement}
   */
  _buildCreatedSection(created) {
    const section = el('div', { className: 'adv-run-created-section' });
    section.appendChild(
      el('div', { className: 'adv-run-section-header' }, `Created (${created.length})`)
    );

    const list = el('ul', { className: 'adv-created-list', role: 'list' });
    for (const ticketId of created) {
      // Ticket IDs are Firestore doc IDs — link to ticket on the board
      const li = el('li', { className: 'adv-created-item' });
      // Use a hash-based link so clicking navigates to the ticket in the SPA
      const link = el('a', {
        className: 'adv-created-link',
        href: `#ticket/${ticketId}`,
        title: `View ticket ${ticketId}`,
      }, ticketId.slice(0, 12) + (ticketId.length > 12 ? '…' : ''));
      li.appendChild(link);
      list.appendChild(li);
    }
    section.appendChild(list);

    return section;
  }

  /**
   * Build the scan list section with a 10-item cap + "show N more" expansion.
   * @param {string[]} scanned - Array of file paths or sanitized URLs
   * @param {string} personaId
   * @returns {HTMLElement}
   */
  _buildScanListSection(scanned, personaId) {
    const SCAN_CAP = 10;
    const section = el('div', { className: 'adv-run-scan-section' });
    const label = personaId === 'design' ? 'URLs scanned' : 'Files scanned';

    section.appendChild(
      el('div', { className: 'adv-run-section-header' }, `${label} (${scanned.length})`)
    );

    const visible = scanned.slice(0, SCAN_CAP);
    const overflow = scanned.slice(SCAN_CAP);

    const list = el('ul', { className: 'adv-scan-list', role: 'list' });
    for (const path of visible) {
      list.appendChild(
        el('li', { className: 'adv-scan-item' },
          el('span', {
            className: 'adv-scan-path',
            title: path,
            'aria-label': path,
          }, path)
        )
      );
    }
    section.appendChild(list);

    if (overflow.length > 0) {
      const moreId = `adv-scan-more-${Math.random().toString(36).slice(2, 7)}`;
      const moreList = el('ul', { className: 'adv-scan-list adv-hidden', id: moreId, role: 'list' });
      for (const path of overflow) {
        moreList.appendChild(
          el('li', { className: 'adv-scan-item' },
            el('span', {
              className: 'adv-scan-path',
              title: path,
              'aria-label': path,
            }, path)
          )
        );
      }

      const moreBtn = el('button', {
        className: 'adv-scan-more-btn',
        'aria-expanded': 'false',
        'aria-controls': moreId,
        onClick: () => {
          const isExp = moreBtn.getAttribute('aria-expanded') === 'true';
          moreBtn.setAttribute('aria-expanded', String(!isExp));
          moreList.classList.toggle('adv-hidden', isExp);
          moreBtn.textContent = isExp ? `Show ${overflow.length} more` : 'Show less';
        },
      }, `Show ${overflow.length} more`);

      section.appendChild(moreBtn);
      section.appendChild(moreList);
    }

    return section;
  }

  // ── Rendering ────────────────────────────────────────────────

  _renderCard(id) {
    const card = this._cards[id];
    if (!card) return;
    const data = this._states[id];

    if (!data) {
      card.statusDot.className = 'adv-dot adv-dot-unknown';
      card.statusDot.title = 'Advisor offline';
      card.statusText.textContent = 'Offline';
      // Pause toggle — disable when offline; revert to "Pause <name>" label.
      if (card.pauseCheckbox) { card.pauseCheckbox.checked = false; card.pauseCheckbox.disabled = true; }
      if (card.pauseTextEl) card.pauseTextEl.textContent = 'Active';
      if (card.pauseBtn) {
        card.pauseBtn.classList.remove('adv-paused');
        const persona = PERSONAS.find(p => p.id === id);
        const lbl = persona?.label ?? id;
        card.pauseBtn.textContent = `Pause ${lbl}`;
        card.pauseBtn.setAttribute('aria-label', `Pause ${lbl} persona`);
        card.pauseBtn.disabled = true;
      }
      card.runNowBtn.setAttribute('aria-disabled', 'true');
      card.runNowBtn.style.pointerEvents = 'none';
      card.runNowBtn.style.opacity = '0.5';
      // Avatar: revert to idle
      if (card.avatarEl) {
        card.avatarEl.className = 'adv-avatar adv-avatar-idle';
        const avatarData = PERSONA_AVATARS[id];
        if (avatarData) card.avatarEl.innerHTML = avatarData.idle;
      }
      // Clear running highlight when offline
      card.card.classList.remove('adv-card-running');
      // Update icon-rail status dot
      if (typeof window._updateAdvisorRailDot === 'function') {
        window._updateAdvisorRailDot(id, 'paused');
      }
      return;
    }

    // When a project is focused, overlay per-project advisor settings from the project doc.
    // Per-project settings (paused, interval, ticketCap, savedFocusPrompt) take priority
    // over global /advisor/{personaId} values so each project has independent configuration.
    const focusedProjectId = this._filterProjectId;
    const perProjectSettings = focusedProjectId
      ? (this._projects.find(p => p.id === focusedProjectId)?.advisorSettings?.[id] ?? null)
      : null;

    const { status, lastActivity, lastRunAt, nextRunAt, ticketsCreated, cycleCount, error, activityLog, lastRunTickets, cooldownUntil, lastRunError } = data;

    // Use per-project interval when focused; fall back to global
    const intervalHours = perProjectSettings?.intervalHours !== undefined
      ? perProjectSettings.intervalHours
      : data.intervalHours;
    const intervalMinutes = perProjectSettings?.intervalMinutes !== undefined
      ? perProjectSettings.intervalMinutes
      : data.intervalMinutes;

    // Use per-project paused flag when focused; fall back to global status
    const isProjectPaused = perProjectSettings !== null
      ? (perProjectSettings?.paused ?? false)
      : (status === 'paused');

    // Use per-project ticketCap, dedupThreshold, and savedFocusPrompt when focused
    const effectiveTicketCap = perProjectSettings?.ticketCap !== undefined
      ? perProjectSettings.ticketCap
      : data.ticketCap;
    // Per-project dedupThreshold overrides global default (DK-130). Default: 3 (Medium).
    const effectiveDedupThreshold = perProjectSettings?.dedupThreshold !== undefined
      ? perProjectSettings.dedupThreshold
      : (data.dedupThreshold !== undefined ? data.dedupThreshold : 3);
    const effectiveSavedFocusPrompt = perProjectSettings !== null
      ? (perProjectSettings?.savedFocusPrompt ?? null)
      : data.savedFocusPrompt;

    // Active/running card highlight — left-border accent + name color
    card.card.classList.toggle('adv-card-running', status === 'running');

    // Avatar: swap between idle and working
    if (card.avatarEl) {
      const avatarData = PERSONA_AVATARS[id];
      if (avatarData) {
        const isWorking = status === 'running';
        card.avatarEl.className = 'adv-avatar' + (isWorking ? ' adv-avatar-working' : ' adv-avatar-idle');
        card.avatarEl.innerHTML = isWorking ? avatarData.working : avatarData.idle;
      }
    }

    // Status dot + text — reflects global daemon status (running/idle) and
    // per-project pause state (isProjectPaused) when a project is focused.
    const displayPaused = isProjectPaused;
    if (status === 'running') {
      card.statusDot.className = 'adv-dot adv-dot-running';
      card.statusDot.title = 'Advisor generating tickets';
      card.statusText.textContent = 'Running';
    } else if (displayPaused) {
      card.statusDot.className = 'adv-dot adv-dot-paused';
      card.statusDot.title = 'Advisor paused';
      card.statusText.textContent = 'Paused';
    } else {
      card.statusDot.className = 'adv-dot adv-dot-idle';
      card.statusDot.title = 'Advisor idle';
      const ago = formatRelative(lastRunAt);
      card.statusText.textContent = ago ? `Idle · ${ago}` : 'Idle';
    }

    // Update icon-rail status dot (narrow-width collapsed mode)
    if (typeof window._updateAdvisorRailDot === 'function') {
      window._updateAdvisorRailDot(id, displayPaused ? 'paused' : status);
    }

    // Pause toggle — checkbox checked = paused; adjacent text "Active / Paused".
    // Per spec: display adjacent text, not color alone. Toggle state is independent
    // of interval edits — saving a new interval while paused does not unpause.
    // When a project is focused, reflects per-project pause state (not global daemon state).
    // DK-111: button-based toggle. Text reads "Pause <Name>" / "Resume <Name>".
    // Disabled while running (in-progress guard per spec).
    if (card.pauseCheckbox) {
      card.pauseCheckbox.checked = isProjectPaused;
      card.pauseCheckbox.disabled = false;
    }
    if (card.pauseTextEl) {
      card.pauseTextEl.textContent = isProjectPaused ? 'Paused' : 'Active';
    }
    if (card.pauseBtn) {
      card.pauseBtn.classList.toggle('adv-paused', isProjectPaused);
      const persona = PERSONAS.find(p => p.id === id);
      const lbl = persona?.label ?? id;
      const isRunning = status === 'running';
      if (isProjectPaused) {
        card.pauseBtn.textContent = `Resume ${lbl}`;
        card.pauseBtn.setAttribute('aria-label', `Resume ${lbl} persona`);
      } else {
        card.pauseBtn.textContent = `Pause ${lbl}`;
        card.pauseBtn.setAttribute('aria-label', `Pause ${lbl} persona`);
      }
      // Disable during in-progress state per spec: Firestore is ground truth,
      // do not use optimistic local state.
      card.pauseBtn.disabled = isRunning;
      card.pauseBtn.title = isRunning ? 'Persona is running — wait for cycle to complete' : '';
    }

    // Run now button — use aria-disabled (not disabled) per DK-321 spec so it
    // remains focusable and the reason is surfaced via aria-describedby tooltip.
    // Disabled when: running, trigger already pending, runRequestedAt set, or within cooldown window.
    const isTriggerPending = !!data.trigger?.requestedAt && !data.trigger?.consumed;
    const isRunRequestPending = !!data.runRequestedAt; // DK-303: new simple trigger field
    let isInCooldown = false;
    let cooldownReasonId = null;
    if (cooldownUntil) {
      const cooldownUntilMs = new Date(cooldownUntil).getTime();
      if (!isNaN(cooldownUntilMs) && Date.now() < cooldownUntilMs) {
        isInCooldown = true;
      }
    }
    const isRunDisabled = status === 'running' || !!data.runNow || isTriggerPending || isRunRequestPending || isInCooldown;
    // aria-disabled keeps the element focusable; real disabled would hide it from AT
    card.runNowBtn.setAttribute('aria-disabled', String(isRunDisabled));
    card.runNowBtn.setAttribute('aria-expanded', String(!card.runPromptExpander?.classList.contains('adv-hidden')));

    // DK-303: "Run in progress" / "Requested..." text on button during active states
    if (status === 'running') {
      card.runNowBtn.textContent = 'Run in progress';
    } else if (isTriggerPending || isRunRequestPending) {
      card.runNowBtn.textContent = 'Requested…';
    } else {
      card.runNowBtn.textContent = 'Run Now';
    }

    // DK-303: Paused notice — show inline notice when persona is paused but run is possible
    const pausedNoticeId = `adv-paused-notice-${id}`;
    let pausedNoticeEl = document.getElementById(pausedNoticeId);
    if (isProjectPaused && !isRunDisabled) {
      if (!pausedNoticeEl) {
        pausedNoticeEl = el('span', {
          id: pausedNoticeId,
          className: 'adv-paused-run-notice',
          role: 'status',
        }, 'Persona is paused — this will run once and will not resume the schedule.');
        card.runNowBtn.parentNode?.insertBefore(pausedNoticeEl, card.runNowBtn.nextSibling);
      }
      pausedNoticeEl.style.display = '';
    } else if (pausedNoticeEl) {
      pausedNoticeEl.style.display = 'none';
    }

    if (isRunDisabled) {
      // Surface reason via aria-describedby tooltip (DK-321 spec)
      const reasonId = `adv-run-reason-${id}`;
      let reasonText = 'Run now';
      if (status === 'running') {
        reasonText = 'Run in progress — button disabled';
      } else if (isTriggerPending || isRunRequestPending) {
        reasonText = 'A run has been requested and is starting';
      } else if (isInCooldown) {
        reasonText = 'Cooling down — try again in a moment';
      }
      // Ensure reason tooltip element exists and is up-to-date
      let reasonEl = document.getElementById(reasonId);
      if (!reasonEl) {
        reasonEl = el('span', { id: reasonId, className: 'adv-sr-only', role: 'tooltip' });
        card.runNowBtn.parentNode?.insertBefore(reasonEl, card.runNowBtn.nextSibling);
      }
      reasonEl.textContent = reasonText;
      card.runNowBtn.setAttribute('aria-describedby', reasonId);
      card.runNowBtn.style.pointerEvents = 'none';
      card.runNowBtn.style.opacity = '0.5';
    } else {
      card.runNowBtn.removeAttribute('aria-describedby');
      card.runNowBtn.style.pointerEvents = '';
      card.runNowBtn.style.opacity = '';
    }

    // DK-303: runRequestedError — show error if orchestrator rejected the request
    const runErrId = `adv-run-err-${id}`;
    let runErrEl = document.getElementById(runErrId);
    if (data.runRequestedError) {
      if (!runErrEl) {
        runErrEl = el('div', {
          id: runErrId,
          className: 'adv-run-requested-error',
          role: 'alert',
        });
        card.runStateEl?.parentNode?.insertBefore(runErrEl, card.runStateEl?.nextSibling);
      }
      runErrEl.textContent = data.runRequestedError;
      runErrEl.style.display = '';
    } else if (runErrEl) {
      runErrEl.style.display = 'none';
    }

    // 4-state status chip (DK-321): Idle / Running... / Last run X ago · N tickets / Last run failed
    // Uses text labels (not color alone) for color-blind accessibility.
    if (card.runStateEl) {
      if (status === 'running') {
        // Running... state — timer started immediately on click (optimistic UI)
        // If the timer isn't running (e.g. page refresh mid-run), start it now.
        if (!this._runTimers?.[id]) {
          this._startRunTimer(id);
        }
        if (card.timeHintEl) card.timeHintEl.className = 'adv-run-time-hint adv-run-time-hint-visible';
      } else {
        // Stop elapsed timer when run completes
        this._stopRunTimer(id);

        if (status === 'failed' || (status === 'idle' && lastRunError)) {
          // Failed state — show generic error message with tooltip for full text
          card.runStateEl.textContent = 'Last run failed';
          card.runStateEl.className = 'adv-run-state adv-run-state-failed';
          card.runStateEl.title = lastRunError || 'Run failed';
          card.runStateEl.setAttribute('aria-label', `Last run failed: ${lastRunError || 'Run failed'}`);
        } else if (lastRunTickets != null) {
          // Last run: X ago · N tickets
          const ago = formatRelative(lastRunAt) || 'recently';
          const ticketLabel = lastRunTickets === 1 ? '1 ticket' : `${lastRunTickets} tickets`;
          card.runStateEl.textContent = `Last run: ${ago} · ${ticketLabel}`;
          card.runStateEl.className = 'adv-run-state adv-run-state-done';
          card.runStateEl.title = '';
          card.runStateEl.removeAttribute('aria-label');
        } else if (lastRunAt) {
          // Idle with known last run time
          const ago = formatRelative(lastRunAt);
          card.runStateEl.textContent = ago ? `Idle · Last run ${ago}` : 'Idle';
          card.runStateEl.className = 'adv-run-state';
          card.runStateEl.title = '';
          card.runStateEl.removeAttribute('aria-label');
        } else {
          card.runStateEl.textContent = 'Idle';
          card.runStateEl.className = 'adv-run-state';
          card.runStateEl.title = '';
          card.runStateEl.removeAttribute('aria-label');
        }
        if (card.timeHintEl) card.timeHintEl.className = 'adv-run-time-hint';
      }
    }

    // Last activity (only shown on custom advisor cards; built-in cards show activity inside the collapsible log)
    if (card.activityEl) {
      card.activityEl.textContent = error || lastActivity || '—';
      card.activityEl.className = 'adv-activity' + (error ? ' adv-activity-error' : '');
    }

    // Countdown — DK-303: read nextRunAt from Firestore (written by orchestrator).
    // Falls back to computing from lastRunAt + interval if nextRunAt not yet written.
    // Uses per-project pause state and interval when a project is focused.
    // DK-111: set datetime attribute on <time> element for machine-readability.
    if (status === 'running') {
      card.countdownEl.textContent = 'now';
      card.countdownEl.removeAttribute('datetime');
    } else if (isProjectPaused) {
      card.countdownEl.textContent = 'paused';
      card.countdownEl.removeAttribute('datetime');
    } else {
      const cd = computeNextRunCountdown(data.nextRunAt, lastRunAt, intervalHours, intervalMinutes);
      card.countdownEl.textContent = cd || '—';
      // Compute absolute ISO datetime for the <time datetime> attribute.
      // Prefer nextRunAt from Firestore; fall back to lastRunAt + interval.
      const nextAbsolute = toDate(data.nextRunAt) || (() => {
        const intervalMs = (intervalMinutes != null && intervalMinutes > 0)
          ? intervalMinutes * 60_000
          : (intervalHours ? intervalHours * 3_600_000 : null);
        const lastDate = toDate(lastRunAt);
        return (lastDate && intervalMs) ? new Date(lastDate.getTime() + intervalMs) : null;
      })();
      if (nextAbsolute && nextAbsolute.getTime() > Date.now()) {
        card.countdownEl.setAttribute('datetime', nextAbsolute.toISOString());
      } else {
        card.countdownEl.removeAttribute('datetime');
      }
    }

    // DK-303: Last run summary line — "Last run 2h ago — 2 tickets created" or "Never run"
    if (card.lastRunLineEl) {
      card.lastRunLineEl.textContent = formatLastRunLine(lastRunAt, data.lastRunTicketCount ?? null);
    }

    // DK-302: Update the banner visibility when persona state changes (a persona may have just run).
    // The banner shows when priorities is empty AND at least one persona has a lastRunAt.
    {
      const focusedProject = this._projects.find(p => p.id === this._filterProjectId);
      const hasPriorities = !!(focusedProject?.priorities?.trim());
      const anyPersonaRan = PERSONAS.some(({ id: pid }) => this._states[pid]?.lastRunAt);
      this._updatePrioritiesBanner(!hasPriorities && anyPersonaRan);
    }

    // Interval input + unit selector (sync from Firestore unless user is actively editing)
    // Only built-in persona cards have an intervalInput; custom cards show a schedule label.
    const isEditingInterval = document.activeElement === card.intervalInput ||
      document.activeElement === card.intervalUnitSelect;
    if (card.intervalInput && !isEditingInterval) {
      if (intervalMinutes != null && intervalMinutes > 0) {
        // Minutes mode — integers only, min 1
        card.intervalInput.value = String(intervalMinutes);
        if (card.intervalUnitSelect) card.intervalUnitSelect.value = 'minutes';
        card.intervalInput.max = '60';
        card.intervalInput.min = '1';
        card.intervalInput.step = '1';
      } else if (intervalHours) {
        // Hours mode — floats allowed, min 0.25 (DK-111)
        card.intervalInput.value = String(intervalHours);
        if (card.intervalUnitSelect) card.intervalUnitSelect.value = 'hours';
        card.intervalInput.max = '168';
        card.intervalInput.min = '0.25';
        card.intervalInput.step = '0.25';
      }
    }

    // DK-111: Daemon offline detection — warn if lastRunAt is stale by >2× the interval.
    // Only shown when the persona is not currently running and has run at least once.
    // Warning text: "Daemon may be offline — last run was X ago."
    {
      const offlineWarnId = `adv-offline-warn-${id}`;
      let offlineWarnEl = document.getElementById(offlineWarnId);
      let showOfflineWarn = false;
      if (lastRunAt && status !== 'running' && !isProjectPaused) {
        const effectiveIntervalMs = intervalMinutes != null && intervalMinutes > 0
          ? intervalMinutes * 60_000
          : (intervalHours || 12) * 3_600_000;
        const staleThresholdMs = 2 * effectiveIntervalMs;
        const msSinceLastRun = Date.now() - new Date(lastRunAt).getTime();
        showOfflineWarn = msSinceLastRun > staleThresholdMs;
      }
      if (showOfflineWarn) {
        if (!offlineWarnEl) {
          offlineWarnEl = el('div', {
            id: offlineWarnId,
            className: 'adv-offline-warn',
            role: 'alert',
          });
          // Insert after the run-state row (inside card body)
          const runStateRow = card.runStateEl?.closest('.adv-run-state-row') ??
                              card.runStateEl?.parentNode;
          if (runStateRow?.parentNode) {
            runStateRow.parentNode.insertBefore(offlineWarnEl, runStateRow.nextSibling);
          } else if (card.cardBody) {
            card.cardBody.insertBefore(offlineWarnEl, card.cardBody.firstChild);
          }
        }
        const ago = formatRelative(lastRunAt) || 'a long time ago';
        offlineWarnEl.textContent = `Daemon may be offline — last run was ${ago}.`;
        offlineWarnEl.style.display = '';
      } else if (offlineWarnEl) {
        offlineWarnEl.style.display = 'none';
      }
    }

    // Ticket cap input — sync from Firestore state (field: ticketCap).
    // When a project is focused, shows per-project ticketCap; otherwise global.
    // Range [1,50], default 3. Only update when not actively editing.
    if (card.capInput && document.activeElement !== card.capInput) {
      const n = Number(effectiveTicketCap);
      if (Number.isInteger(n) && n >= 1 && n <= 50) {
        card.capInput.value = String(n);
      }
      // If effectiveTicketCap is undefined/null (first time), leave placeholder value (3) as-is.
    }

    // Dedup sensitivity radio buttons — sync from Firestore (DK-130).
    // Maps integer threshold to Low/Medium/High. Default: 3 (Medium).
    // Only update when the radio row exists (not present for custom personas).
    if (card.dedupRadioRow) {
      const DEDUP_VALUE_MAP = { 1: 'low', 3: 'medium', 5: 'high' };
      // Clamp to nearest canonical value: 1→low, 3→medium, 5→high
      let canonicalValue = 3; // default Medium
      const rawThreshold = Number(effectiveDedupThreshold);
      if (!isNaN(rawThreshold)) {
        if (rawThreshold <= 1) canonicalValue = 1;
        else if (rawThreshold <= 3) canonicalValue = 3;
        else canonicalValue = 5;
      }
      const selectedLabel = DEDUP_VALUE_MAP[canonicalValue];
      // Update aria-checked state on each option
      const allOptions = card.dedupRadioRow.querySelectorAll('.adv-dedup-option');
      const allRadios = card.dedupRadioRow.querySelectorAll('.adv-dedup-radio');
      allOptions.forEach((optEl) => {
        const radio = optEl.querySelector('.adv-dedup-radio');
        if (radio) {
          const isSelected = String(radio.value) === String(canonicalValue);
          optEl.setAttribute('aria-checked', String(isSelected));
          radio.checked = isSelected;
        }
      });
      void allRadios; // suppress unused-variable lint
    }

    // DK-136: Trigger pills — update interval pill text from current interval setting
    if (card.intervalPill) {
      const ivMins = data.intervalMinutes;
      const ivHours = data.intervalHours;
      let intervalLabel;
      if (ivMins != null && Number.isFinite(ivMins) && ivMins > 0) {
        intervalLabel = `every ${ivMins}m`;
      } else if (ivHours != null && Number.isFinite(ivHours) && ivHours > 0) {
        intervalLabel = ivHours === 1 ? 'every 1h' : `every ${ivHours}h`;
      } else {
        const def = PERSONAS.find(p => p.id === id);
        intervalLabel = def ? `every ${def.defaultHours}h` : 'scheduled';
      }
      card.intervalPill.textContent = intervalLabel;
    }

    // Stats
    card.ticketsEl.textContent = String(ticketsCreated ?? 0);
    card.cyclesEl.textContent  = String(cycleCount ?? 0);

    // DK-195: Schedule pickers — sync from Firestore (new 'schedule' field takes priority)
    if (data.schedule && card.tzSelect) {
      this._updateScheduleUI(id, data.schedule);
    } else if (data.allowedHours && card.tzSelect) {
      // Legacy allowedHours — convert to schedule-style for UI display only
      this._updateScheduleUIFromAllowedHours(id, data.allowedHours);
    }

    // Soul button — highlight when a custom soul prompt is set (built-in cards only)
    if (card.soulBtn) {
      const hasCustomSoul = typeof data.soulPrompt === 'string' && data.soulPrompt.trim().length > 0;
      const soulPersona = PERSONAS.find(p => p.id === id);
      const soulLabel = soulPersona?.label ?? id;
      card.soulBtn.className = 'adv-soul-btn' + (hasCustomSoul ? ' adv-soul-btn-active' : '');
      card.soulBtn.title = hasCustomSoul ? `${soulLabel} soul prompt customized — click to edit` : `Edit ${soulLabel} soul prompt`;
    }

    // Saved focus prompt indicator — shown when a focus prompt is saved to run next cycle.
    // When a project is focused, shows per-project savedFocusPrompt; otherwise global.
    {
      const saved = typeof effectiveSavedFocusPrompt === 'string' && effectiveSavedFocusPrompt.trim()
        ? effectiveSavedFocusPrompt.trim()
        : null;
      if (card.savedFocusEl) {
        if (saved) {
          card.savedFocusEl.textContent = `Saved: "${saved}"`;
          card.savedFocusEl.className = 'adv-saved-focus';
        } else {
          card.savedFocusEl.textContent = '';
          card.savedFocusEl.className = 'adv-saved-focus adv-hidden';
        }
      }
      // DK-315: Populate focus textarea from saved value so users can see / edit the
      // current focus in-place. Only set if textarea is empty and not being actively edited
      // (avoids clobbering an in-progress edit or overwriting the save-on-blur lastValue).
      if (card.focusTextarea && document.activeElement !== card.focusTextarea
          && card.focusTextarea.value === '') {
        const focusSaveControl = this._focusSaveControls?.[id];
        if (!focusSaveControl?.isDirty()) {
          card.focusTextarea.value = saved || '';
          // Tell the save-on-blur control what the "already saved" value is, so it
          // doesn't fire a spurious save when the user blurs without making changes.
          focusSaveControl?.setLastValue(saved || '');
          // Update char counter to match
          const counterEl = card.focusTextarea.closest?.('.adv-focus-area')
            ?.querySelector?.('.adv-focus-counter');
          if (counterEl) {
            const len = (saved || '').length;
            counterEl.textContent = len > 0 ? `${len} / 256` : '';
            counterEl.className = 'adv-focus-counter' + (len > 230 ? ' adv-focus-counter-warn' : '');
          }
        }
      }
      // Update focus toggle button state, dataset, and inline preview
      if (card.focusToggleBtn) {
        const prevSaved = card.focusToggleBtn.dataset.savedFocus || '';
        card.focusToggleBtn.dataset.savedFocus = saved || '';

        const manuallyToggled = this._focusManuallyToggled?.[id];
        const focusAreaEl = document.getElementById(`adv-focus-area-${id}`);

        if (!manuallyToggled && focusAreaEl) {
          if (saved && !prevSaved) {
            // Saved focus just appeared — collapse the focus area since it is now "configured",
            // BUT only if the user is not actively editing the textarea (DK-315: auto-save
            // while typing should not collapse the area mid-edit).
            const isEditing = card.focusTextarea && document.activeElement === card.focusTextarea;
            const saveControlDirty = this._focusSaveControls?.[id]?.isDirty?.();
            if (!isEditing && !saveControlDirty) {
              focusAreaEl.classList.remove('adv-focus-area-open');
              card.focusToggleBtn.setAttribute('aria-expanded', 'false');
            }
          } else if (!saved && prevSaved) {
            // Saved focus was consumed (run used it) — re-expand so user can set the next one
            focusAreaEl.classList.add('adv-focus-area-open');
            card.focusToggleBtn.setAttribute('aria-expanded', 'true');
            // Clear the textarea so it doesn't show a stale value after the run consumed the focus
            if (card.focusTextarea && document.activeElement !== card.focusTextarea) {
              card.focusTextarea.value = '';
              this._focusSaveControls?.[id]?.setLastValue('');
              const counterEl = card.focusTextarea.closest?.('.adv-focus-area')
                ?.querySelector?.('.adv-focus-counter');
              if (counterEl) { counterEl.textContent = ''; counterEl.className = 'adv-focus-counter'; }
            }
          }
        }

        const isExpanded = card.focusToggleBtn.getAttribute('aria-expanded') === 'true';
        const arrow = isExpanded ? '▾' : '▸';
        card.focusToggleBtn.textContent = saved ? `Focus● ${arrow}` : `Focus ${arrow}`;
        card.focusToggleBtn.title = saved
          ? `Saved focus active: "${saved}"`
          : 'Set a focus area for the next run';

        // Inline preview span — visible only when collapsed and a saved focus is set
        if (card.focusPreviewEl) {
          if (!isExpanded && saved) {
            const maxLen = 40;
            const preview = saved.length > maxLen ? saved.slice(0, maxLen) + '…' : saved;
            card.focusPreviewEl.textContent = preview;
            card.focusPreviewEl.title = saved;
            card.focusPreviewEl.className = 'adv-focus-preview';
          } else {
            card.focusPreviewEl.textContent = '';
            card.focusPreviewEl.className = 'adv-focus-preview adv-hidden';
          }
        }
      }
    }

    // Run summary line — "ran 4h ago · 0 proposals"
    if (card.runSummaryEl) {
      const runs = this._historyRuns[id];
      if (runs && runs.length > 0) {
        const latest = runs[0];
        const relTime = formatRelativeTs(latest.startedAt) || '—';
        const proposals = latest.proposalsCreated ?? 0;
        card.runSummaryEl.textContent = `ran ${relTime} · ${proposals} proposal${proposals !== 1 ? 's' : ''}`;
        card.runSummaryEl.title = formatAbsolute(latest.startedAt);
      } else if (runs === null) {
        // History query is in flight — show loading placeholder so we don't
        // display stale cross-project data from the global persona state.
        card.runSummaryEl.textContent = '—';
        card.runSummaryEl.title = '';
      } else if (runs && runs.length === 0) {
        // History loaded, no runs for this project
        card.runSummaryEl.textContent = 'No runs yet';
        card.runSummaryEl.title = '';
      } else if (lastRunAt && !this._filterProjectId) {
        // Fall back to persona state lastRunAt only when no project filter is
        // active (global view). When a project is selected, this value spans all
        // projects and would show data from a different project.
        const ago = formatRelative(lastRunAt);
        const tickets = ticketsCreated ?? 0;
        card.runSummaryEl.textContent = ago ? `ran ${ago} · ${tickets} total proposals` : '—';
        card.runSummaryEl.title = '';
      } else {
        card.runSummaryEl.textContent = 'No runs yet';
        card.runSummaryEl.title = '';
      }
    }

    // Collapsed header summary — compact one-line info visible when card body is hidden.
    // Shows next run countdown (or running/paused state) so admins can scan at a glance.
    // Uses per-project pause state and interval when a project is focused.
    if (card.collapsedSummaryEl) {
      let summaryText = '';
      if (status === 'running') {
        summaryText = '· running…';
      } else if (isProjectPaused) {
        summaryText = '· paused';
      } else {
        const cd = computeNextRunCountdown(data.nextRunAt, lastRunAt, intervalHours, intervalMinutes);
        summaryText = cd ? `· next ${cd}` : '';
      }
      card.collapsedSummaryEl.textContent = summaryText;
    }

    // DK-365: Constraint chip — shows "⚙ N constraints active" in card header
    // when the product persona has active constraints for the focused project.
    if (card.constraintChipEl && id === 'product') {
      const constraints = perProjectSettings?.constraints ?? null;
      const count = constraints ? Object.keys(constraints).filter(k => {
        const v = constraints[k];
        if (Array.isArray(v)) return v.length > 0;
        if (v && typeof v === 'object') return true;
        return v != null && v !== '';
      }).length : 0;
      if (count > 0) {
        card.constraintChipEl.textContent = `⚙ ${count} constraint${count === 1 ? '' : 's'} active`;
        card.constraintChipEl.classList.remove('adv-hidden');
        card.constraintChipEl.setAttribute('aria-label', `${count} constraint${count === 1 ? '' : 's'} active — click Constraints to view or edit`);
      } else {
        card.constraintChipEl.classList.add('adv-hidden');
      }
    }

    // Activity log entries (built-in cards only — custom cards don't have a log list)
    if (card.logList) this._renderLog(id, activityLog);

    // Sync perf dash frequency input if the dashboard is expanded
    if (this._perfDashExpanded[id] && card._perfFreqInput && intervalHours && document.activeElement !== card._perfFreqInput) {
      card._perfFreqInput.value = String(intervalHours);
    }

    // DK-187: Render focus constraints chip list from persona doc's focus map
    if (['engineer', 'design', 'product'].includes(id)) {
      this._renderFocusConstraints(id);
    }

    // Re-evaluate the aggregate volume warning whenever a persona state changes
    // (pausing/unpausing a built-in changes the enabled count)
    this._updateVolumeWarning();

    // Keep Pause All button label in sync with current pause state
    this._updatePauseAllBtn();

    // DK-319: Refresh directive UI with current interval/status data
    // (next-run indicator and section visibility depend on persona state)
    this._renderDirective(id);
  }

  _refreshCountdowns() {
    const focusedProjectId = this._filterProjectId;
    // Built-in personas — compute next run client-side from lastRunAt + interval.
    // When a project is focused, use per-project interval and pause state.
    for (const { id } of PERSONAS) {
      const card = this._cards[id];
      const data = this._states[id];
      if (!card || !data) continue;

      // Resolve per-project settings overlay
      const perProjectSettings = focusedProjectId
        ? (this._projects.find(p => p.id === focusedProjectId)?.advisorSettings?.[id] ?? null)
        : null;
      const isProjectPaused = perProjectSettings !== null
        ? (perProjectSettings?.paused ?? false)
        : (data.status === 'paused');
      const intervalHours = perProjectSettings?.intervalHours !== undefined
        ? perProjectSettings.intervalHours
        : data.intervalHours;
      const intervalMinutes = perProjectSettings?.intervalMinutes !== undefined
        ? perProjectSettings.intervalMinutes
        : data.intervalMinutes;

      if (data.status === 'running') continue;
      if (isProjectPaused) {
        card.countdownEl.textContent = 'paused';
        if (card.collapsedSummaryEl) card.collapsedSummaryEl.textContent = '· paused';
        continue;
      }
      const cd = computeNextRunCountdown(data.nextRunAt, data.lastRunAt, intervalHours, intervalMinutes);
      card.countdownEl.textContent = cd || '—';
      // Keep collapsed header summary in sync
      if (card.collapsedSummaryEl) {
        card.collapsedSummaryEl.textContent = cd ? `· next ${cd}` : '';
      }
      // DK-319: Keep directive next-run indicator in sync
      const dirEls = this._directiveEls[id];
      if (dirEls) {
        if (cd) {
          dirEls.nextRunEl.textContent = `next run ${cd}`;
          dirEls.nextRunEl.className = 'adv-directive-next-run';
        } else {
          dirEls.nextRunEl.textContent = '';
          dirEls.nextRunEl.className = 'adv-directive-next-run adv-hidden';
        }
      }
    }
    // Custom personas
    for (const p of this._customPersonas) {
      const id = p.id || p._docId;
      const card = this._cards[id];
      const data = this._states[id];
      if (!card || !data) continue;
      if (data.status === 'running' || data.status === 'paused') continue;
      const cd = computeNextRunCountdown(data.nextRunAt, data.lastRunAt, data.intervalHours, data.intervalMinutes);
      if (card.countdownEl) card.countdownEl.textContent = cd || '—';
    }
  }

  _toggleLog(id) {
    const expanded = !this._logExpanded[id];
    this._logExpanded[id] = expanded;
    const card = this._cards[id];
    if (!card) return;
    if (expanded) {
      card.logContainer.classList.remove('adv-log-hidden');
      card.logToggleBtn.textContent = 'Log ▾';
      card.logToggleBtn.title = 'Hide activity log';
      card.logToggleBtn.setAttribute('aria-expanded', 'true');
      if (card.logClearBtn) card.logClearBtn.classList.remove('adv-hidden');
    } else {
      card.logContainer.classList.add('adv-log-hidden');
      card.logToggleBtn.textContent = 'Log ▸';
      card.logToggleBtn.title = 'Show activity log';
      card.logToggleBtn.setAttribute('aria-expanded', 'false');
      if (card.logClearBtn) card.logClearBtn.classList.add('adv-hidden');
    }
  }

  /**
   * Clear the activity log for a persona by writing an empty activityLog array
   * to the /advisor/{personaId} document in Firestore.
   * @param {string} personaId
   */
  async _clearLog(personaId) {
    const card = this._cards[personaId];
    if (!card) return;
    try {
      await this.db.collection('advisor').doc(personaId).set({ activityLog: [] }, { merge: true });
    } catch (err) {
      console.error(`AdvisorPanel: failed to clear activity log for ${personaId}`, err);
    }
  }

  // ── Feedback signal methods ──────────────────────────────────

  /**
   * Save the per-persona feedback injection toggle to Firestore.
   * Writes to /projects/{projectId} advisorConfig.{personaId}.feedbackInjectionEnabled.
   * Operates on the currently selected project filter (or all projects if no filter).
   *
   * @param {string} personaId
   * @param {boolean} enabled
   */
  async _saveFeedbackToggle(personaId, enabled) {
    const card = this._cards[personaId];
    if (!card) return;

    // Update ARIA status text for screen readers
    if (card.feedbackToggleStatusEl) {
      card.feedbackToggleStatusEl.textContent = `Feedback injection: ${enabled ? 'on' : 'off'}`;
    }

    // Mark card as muted/labeled when injection is disabled per spec
    if (card.feedbackToggleRow) {
      card.feedbackToggleRow.classList.toggle('adv-feedback-injection-disabled', !enabled);
    }

    // Write to all projects (or the filtered project)
    const projectId = this._filterProjectId;
    if (!projectId) {
      // Write to all projects that have this persona configured
      for (const project of this._projects) {
        try {
          await this.db.collection('projects').doc(project.id).set(
            { advisorConfig: { [personaId]: { feedbackInjectionEnabled: enabled } } },
            { merge: true }
          );
        } catch (err) {
          console.warn(`Failed to save feedback toggle for ${project.id}:`, err);
        }
      }
    } else {
      try {
        await this.db.collection('projects').doc(projectId).set(
          { advisorConfig: { [personaId]: { feedbackInjectionEnabled: enabled } } },
          { merge: true }
        );
      } catch (err) {
        console.warn(`Failed to save feedback toggle for ${projectId}:`, err);
      }
    }

    // Reload stats after toggle change
    this._loadFeedbackStats(personaId);
  }

  /**
   * Toggle the feedback detail expansion for a persona card.
   * Loads stats on first open.
   *
   * @param {string} personaId
   */
  _toggleFeedbackDetail(personaId) {
    const card = this._cards[personaId];
    if (!card) return;

    const expanded = !this._feedbackDetailExpanded[personaId];
    this._feedbackDetailExpanded[personaId] = expanded;

    if (card.feedbackStatExpandBtn) {
      card.feedbackStatExpandBtn.setAttribute('aria-expanded', String(expanded));
      card.feedbackStatExpandBtn.textContent = expanded ? '▾' : '▸';
    }
    if (card.feedbackDetailEl) {
      card.feedbackDetailEl.classList.toggle('adv-hidden', !expanded);
    }

    if (expanded && !this._feedbackStats[personaId]) {
      this._loadFeedbackStats(personaId);
    }
  }

  /**
   * Load feedback stats for a persona from Firestore.
   * Aggregates feedbackEvents subcollection client-side over the recency window.
   *
   * Retries indefinitely on permission-denied while the user is authenticated —
   * the same strategy used by _subscribePersona and other onSnapshot listeners
   * (see _isPermissionDeniedTransient, DK-181, DK-206). Firestore can fire
   * permission-denied before the ID token has fully propagated; as long as the
   * user is signed in, the error is treated as transient and retried with
   * exponential backoff (capped at 60s).
   *
   * @param {string} personaId
   * @param {number} [retryDelayMs=5000] - backoff delay for the next retry attempt
   */
  async _loadFeedbackStats(personaId, retryDelayMs = 5000) {
    if (this._feedbackStatsLoading[personaId]) return;
    this._feedbackStatsLoading[personaId] = true;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      this._feedbackStatsLoading[personaId] = false;
      return;
    }

    try {
      const RECENCY_DAYS = 30;
      const RECENCY_MAX = 50;
      const MIN_THRESHOLD = 10;
      const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000);

      const snap = await this.db
        .collection('projects')
        .doc(projectId)
        .collection('feedbackEvents')
        .where('personaId', '==', personaId)
        .orderBy('timestamp', 'desc')
        .limit(RECENCY_MAX)
        .get();

      let accepted = 0, rejected = 0, snoozed = 0;
      const rejectedTicketIds = [];

      for (const doc of snap.docs) {
        const data = doc.data();
        const ts = data.timestamp?.toDate?.() ?? null;
        if (ts && ts < cutoff) break;
        if (data.decision === 'accepted') accepted++;
        else if (data.decision === 'rejected') { rejected++; rejectedTicketIds.push(data.ticketId); }
        else if (data.decision === 'snoozed') snoozed++;
      }

      const total = accepted + rejected + snoozed;
      const denominator = accepted + rejected;
      const acceptanceRate = denominator > 0 ? Math.round((accepted / denominator) * 100) : null;
      const belowThreshold = total < MIN_THRESHOLD;

      // Fetch rejected ticket categories
      const categoryCounts = {};
      for (let i = 0; i < rejectedTicketIds.length; i += 10) {
        const batch = rejectedTicketIds.slice(i, i + 10);
        if (!batch.length) break;
        try {
          const ticketSnap = await this.db
            .collection('projects')
            .doc(projectId)
            .collection('tickets')
            .where('__name__', 'in', batch)
            .get();
          for (const tDoc of ticketSnap.docs) {
            const td = tDoc.data();
            const labels = Array.isArray(td.tags) && td.tags.length > 0
              ? td.tags.filter(t => typeof t === 'string' && t.trim())
              : (typeof td.category === 'string' && td.category.trim() ? [td.category.trim()] : []);
            for (const label of labels) {
              const key = label.replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
              if (key) categoryCounts[key] = (categoryCounts[key] || 0) + 1;
            }
          }
        } catch { /* skip */ }
      }

      const topRejectedCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => ({ label, count }));

      this._feedbackStats[personaId] = {
        accepted, rejected, snoozed, total,
        acceptanceRate, belowThreshold,
        topRejectedCategories,
        windowDays: RECENCY_DAYS,
        windowMax: RECENCY_MAX,
        minThreshold: MIN_THRESHOLD,
        projectId,
      };

      // Read toggle state from project doc
      const projSnap = await this.db.collection('projects').doc(projectId).get();
      const injectionEnabled = projSnap.exists
        ? (projSnap.data()?.advisorConfig?.[personaId]?.feedbackInjectionEnabled !== false)
        : true;
      this._renderFeedbackStats(personaId, injectionEnabled);
    } catch (err) {
      // Use the same transient-detection helper as the onSnapshot listeners:
      // retry indefinitely while the user is authenticated (token propagation
      // can take arbitrarily long), escalate to console.error only when
      // permission-denied occurs without a signed-in user (a genuine auth problem).
      if (this._isPermissionDeniedTransient(err)) {
        const delay = Math.min(retryDelayMs, 60_000);
        console.warn(`AdvisorPanel: feedback stats error for ${personaId} (transient, retrying in ${delay}ms)`, err);
        setTimeout(() => {
          if (this._mounted) this._loadFeedbackStats(personaId, delay * 2);
        }, delay);
      } else {
        if (err.code === 'permission-denied') {
          console.error(`AdvisorPanel: feedback stats permission denied for ${personaId} (not authenticated)`, err);
        } else {
          console.warn(`Failed to load feedback stats for ${personaId}:`, err);
        }
      }
    } finally {
      this._feedbackStatsLoading[personaId] = false;
    }
  }

  /**
   * Render feedback stats into the card's feedback stat row and detail panel.
   *
   * @param {string} personaId
   * @param {boolean} injectionEnabled
   */
  _renderFeedbackStats(personaId, injectionEnabled) {
    const card = this._cards[personaId];
    const stats = this._feedbackStats[personaId];
    if (!card || !stats) return;

    // Update toggle checkbox state (without triggering onChange)
    if (card.feedbackToggleCheckbox) {
      card.feedbackToggleCheckbox.checked = injectionEnabled;
    }
    if (card.feedbackToggleStatusEl) {
      card.feedbackToggleStatusEl.textContent = `Feedback injection: ${injectionEnabled ? 'on' : 'off'}`;
    }
    if (card.feedbackToggleRow) {
      card.feedbackToggleRow.classList.toggle('adv-feedback-injection-disabled', !injectionEnabled);
    }

    // Stat row summary: "8/11 accepted, last 30 days"
    const denominator = stats.accepted + stats.rejected;
    if (card.feedbackStatSummaryEl) {
      if (stats.total === 0) {
        card.feedbackStatSummaryEl.textContent = 'No decisions recorded yet';
      } else {
        card.feedbackStatSummaryEl.textContent =
          `${stats.accepted}/${denominator} accepted, last ${stats.windowDays} days`;
      }
    }

    // Detail panel
    if (card.feedbackDetailEl) {
      card.feedbackDetailEl.innerHTML = '';

      if (stats.belowThreshold) {
        // Below threshold — show progress toward activation
        const msg = el('p', { className: 'adv-feedback-threshold-msg' },
          `Feedback mode activates after ${stats.minThreshold} decisions (${stats.total} recorded so far).`
        );
        card.feedbackDetailEl.appendChild(msg);
      } else {
        // Show acceptance rate with text + bar (not color alone per spec)
        if (stats.acceptanceRate !== null) {
          const rateLabel = `${stats.acceptanceRate}% acceptance rate`;
          const rateBar = el('div', { className: 'adv-feedback-rate-bar', 'aria-hidden': 'true' });
          const rateFill = el('div', {
            className: 'adv-feedback-rate-fill',
            style: `width: ${stats.acceptanceRate}%`,
          });
          rateBar.appendChild(rateFill);
          card.feedbackDetailEl.appendChild(
            el('div', { className: 'adv-feedback-rate-row' },
              el('span', { className: 'adv-feedback-rate-label' }, rateLabel),
              rateBar,
            )
          );
        }

        // Window scope note
        card.feedbackDetailEl.appendChild(
          el('p', { className: 'adv-feedback-window-note' },
            `Based on last ${stats.windowDays} days or last ${stats.windowMax} decisions, whichever is smaller.`
          )
        );

        // Top rejected categories — framed as signal, not failure
        if (stats.topRejectedCategories.length > 0) {
          card.feedbackDetailEl.appendChild(
            el('p', { className: 'adv-feedback-categories-label' },
              'Proposals with low acceptance (reducing frequency):'
            )
          );
          const catList = el('ul', { className: 'adv-feedback-categories-list' });
          for (const cat of stats.topRejectedCategories) {
            catList.appendChild(
              el('li', { className: 'adv-feedback-category-item' },
                `${cat.label} (${cat.count} rejected)`
              )
            );
          }
          card.feedbackDetailEl.appendChild(catList);
        }

        // Snooze note
        if (stats.snoozed > 0) {
          card.feedbackDetailEl.appendChild(
            el('p', { className: 'adv-feedback-snooze-note' },
              `${stats.snoozed} snoozed (tracked separately, not counted in acceptance rate).`
            )
          );
        }
      }
    }
  }

  // ── Exclusion management (DK-128) ───────────────────────────────────────

  /**
   * Validate an exclusion pattern input field and update the validation element.
   * Returns true if valid (caller may proceed to add).
   *
   * @param {string} personaId  - 'engineer' | 'design'
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   * @returns {boolean}
   */
  _validateExclusionInput(personaId, inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) {
      validationEl.textContent = '';
      validationEl.className = 'adv-exclusion-validation';
      return false;
    }
    if (value.length > 200) {
      validationEl.textContent = '✗ Pattern exceeds 200 characters';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return false;
    }
    if (personaId === 'engineer') {
      // Reject pathological glob patterns (repeated wildcards)
      if (/\*{3,}|\*\*\/\*\*/.test(value)) {
        validationEl.textContent = '✗ Pattern contains repeated wildcards — simplify to **';
        validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
        return false;
      }
    } else if (personaId === 'design') {
      // Reject dangerous URL patterns
      const lower = value.toLowerCase();
      if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
        validationEl.textContent = '✗ Pattern must not match javascript: or data: URIs';
        validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
        return false;
      }
    }
    // Valid
    validationEl.textContent = '✓ valid';
    validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
    return true;
  }

  /**
   * Add an exclusion pattern from the input field to Firestore.
   * Enforces max 20 patterns, 200 chars per pattern.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   */
  async _addExclusion(personaId, inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const isValid = this._validateExclusionInput(personaId, inputEl, validationEl);
    if (!isValid) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      validationEl.textContent = '✗ Select a project first';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    const project = this._projects.find(p => p.id === projectId);
    const currentExclusions = Array.isArray(project?.exclusions?.[personaId])
      ? project.exclusions[personaId]
      : [];

    // Enforce max 20 patterns
    if (currentExclusions.length >= 20) {
      validationEl.textContent = '✗ Maximum of 20 exclusion patterns reached';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    // Avoid exact duplicates
    if (currentExclusions.includes(value)) {
      validationEl.textContent = '✓ Already in exclusion list';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
      inputEl.value = '';
      return;
    }

    const newExclusions = [...currentExclusions, value];
    this._exclusionSaving[personaId] = true;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { exclusions: { [personaId]: newExclusions } },
        { merge: true }
      );
      inputEl.value = '';
      validationEl.textContent = '';
      validationEl.className = 'adv-exclusion-validation';
    } catch (err) {
      validationEl.textContent = `✗ Save failed: ${err.message}`;
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      console.warn(`AdvisorPanel: failed to save exclusion for ${personaId}:`, err);
    } finally {
      this._exclusionSaving[personaId] = false;
    }
  }

  /**
   * Remove an exclusion pattern from the list for a persona.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   * @param {string} pattern    - Pattern to remove
   */
  async _removeExclusion(personaId, pattern) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    const project = this._projects.find(p => p.id === projectId);
    const currentExclusions = Array.isArray(project?.exclusions?.[personaId])
      ? project.exclusions[personaId]
      : [];

    const newExclusions = currentExclusions.filter(p => p !== pattern);

    try {
      await this.db.collection('projects').doc(projectId).set(
        { exclusions: { [personaId]: newExclusions } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove exclusion for ${personaId}:`, err);
    }
  }

  /**
   * Render the exclusion tag list for a persona from the current project data.
   * Called from _renderProjects() whenever project data changes.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   */
  _renderExclusionTags(personaId) {
    const card = this._cards[personaId];
    if (!card || !card.exclusionTagListEl) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const patterns = Array.isArray(project?.exclusions?.[personaId])
      ? project.exclusions[personaId]
      : [];

    card.exclusionTagListEl.innerHTML = '';

    if (patterns.length === 0) {
      card.exclusionTagListEl.appendChild(
        el('span', { className: 'adv-exclusion-empty' }, 'No exclusions set.')
      );
      return;
    }

    for (const pattern of patterns) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-tag-delete',
        title: `Remove exclusion: ${pattern}`,
        'aria-label': `Remove exclusion pattern ${pattern}`,
        // Keyboard accessible: Delete and Backspace both work (per a11y spec)
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removeExclusion(personaId, pattern);
          }
        },
        onClick: () => this._removeExclusion(personaId, pattern),
      }, '×');
      // Make button focusable per a11y spec
      deleteBtn.setAttribute('tabindex', '0');

      const tag = el('span', {
        className: 'adv-exclusion-tag',
        role: 'listitem',
      },
        el('span', { className: 'adv-exclusion-tag-text' }, pattern),
        deleteBtn,
      );
      card.exclusionTagListEl.appendChild(tag);
    }
  }

  /**
   * Load and display the exclusion suppression count ("N skipped this week").
   * Queries advisorRuns from the past 7 days, sums exclusionSkipCount.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   */
  async _loadExclusionSkipCount(personaId) {
    const card = this._cards[personaId];
    if (!card || !card.exclusionSkipCountEl) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const snap = await this.db.collection('advisorRuns')
        .where('persona', '==', personaId)
        .where('projectId', '==', projectId)
        .where('startedAt', '>=', cutoff)
        .where('status', '==', 'completed')
        .get();

      let total = 0;
      for (const doc of snap.docs) {
        const count = doc.data()?.exclusionSkipCount;
        if (typeof count === 'number' && count > 0) total += count;
      }

      if (total > 0) {
        card.exclusionSkipCountEl.textContent = `${total} suggestion${total === 1 ? '' : 's'} skipped this week`;
        card.exclusionSkipCountEl.classList.remove('adv-hidden');
      } else {
        card.exclusionSkipCountEl.classList.add('adv-hidden');
      }
    } catch {
      // Non-fatal — skip count is informational only
      card.exclusionSkipCountEl.classList.add('adv-hidden');
    }
  }

  // ── DK-112: Topic Exclusion Rules management ─────────────────────────────

  /**
   * Validate a topic exclusion rule input value.
   * Returns true if valid, false if invalid. Updates validationEl with feedback.
   *
   * Rules mirror the server-side sanitizeTopicExclusion() in prompt-builder.js:
   * - Max 100 characters
   * - No newlines
   * - No injection keywords (ignore, system:, assistant:, prompt, XML tags)
   *
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   * @returns {boolean}
   */
  _validateTopicExclInput(inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) {
      validationEl.textContent = '';
      validationEl.className = 'adv-exclusion-validation';
      return false;
    }
    if (value.length > 100) {
      validationEl.textContent = '✗ Rule exceeds 100 characters';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return false;
    }
    // Client-side injection pattern checks (mirrors prompt-builder.js)
    const INJECTION_PATTERNS = [
      { re: /\n/, msg: 'Rule must not contain newlines' },
      { re: /\bignore\b/i, msg: 'Rule contains reserved keyword "ignore"' },
      { re: /system:/i, msg: 'Rule contains reserved prefix "system:"' },
      { re: /assistant:/i, msg: 'Rule contains reserved prefix "assistant:"' },
      { re: /\bprompt\b/i, msg: 'Rule contains reserved keyword "prompt"' },
      { re: /<\/?[a-z]+>/i, msg: 'Rule must not contain HTML or XML tags' },
    ];
    for (const { re, msg } of INJECTION_PATTERNS) {
      if (re.test(value)) {
        validationEl.textContent = `✗ ${msg}`;
        validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
        return false;
      }
    }
    validationEl.textContent = '✓ valid';
    validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
    return true;
  }

  /**
   * Add a topic exclusion rule for a persona from the input field.
   * Writes to project.advisor.topicExclusions.{personaId} in Firestore.
   * Shows an undo toast immediately after adding.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   */
  async _addTopicExclusion(personaId, inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const isValid = this._validateTopicExclInput(inputEl, validationEl);
    if (!isValid) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      validationEl.textContent = '✗ Select a project first';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    const project = this._projects.find(p => p.id === projectId);
    const currentRules = Array.isArray(project?.advisor?.topicExclusions?.[personaId])
      ? project.advisor.topicExclusions[personaId]
      : [];

    if (currentRules.length >= 25) {
      validationEl.textContent = '✗ Maximum of 25 exclusion rules reached';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    if (currentRules.includes(value)) {
      validationEl.textContent = '✓ Already in exclusion list';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
      inputEl.value = '';
      return;
    }

    const newRules = [...currentRules, value];
    this._topicExclSaving[personaId] = true;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { topicExclusions: { [personaId]: newRules } } },
        { merge: true }
      );
      inputEl.value = '';
      validationEl.textContent = `✓ Rule saved — ${personaId} will not propose "${value}"`;
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
      setTimeout(() => {
        if (validationEl.className === 'adv-exclusion-validation adv-exclusion-validation-ok') {
          validationEl.textContent = '';
          validationEl.className = 'adv-exclusion-validation';
        }
      }, 3000);
    } catch (err) {
      validationEl.textContent = `✗ Save failed: ${err.message}`;
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      console.warn(`AdvisorPanel: failed to save topic exclusion for ${personaId}:`, err);
    } finally {
      this._topicExclSaving[personaId] = false;
    }
  }

  /**
   * Remove a topic exclusion rule from the list for a persona.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   * @param {string} rule - The rule text to remove
   */
  async _removeTopicExclusion(personaId, rule) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    const project = this._projects.find(p => p.id === projectId);
    const currentRules = Array.isArray(project?.advisor?.topicExclusions?.[personaId])
      ? project.advisor.topicExclusions[personaId]
      : [];

    const newRules = currentRules.filter(r => r !== rule);

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { topicExclusions: { [personaId]: newRules } } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove topic exclusion for ${personaId}:`, err);
    }
  }

  /**
   * Render the topic exclusion tag list for a persona from current project data.
   * Called from _renderProjects() whenever project data changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderTopicExclusions(personaId) {
    const card = this._cards[personaId];
    if (!card || !card.topicExclTagListEl) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const rules = Array.isArray(project?.advisor?.topicExclusions?.[personaId])
      ? project.advisor.topicExclusions[personaId]
      : [];

    card.topicExclTagListEl.innerHTML = '';

    if (rules.length === 0) {
      card.topicExclTagListEl.appendChild(
        el('span', { className: 'adv-exclusion-empty adv-tex-empty' },
          'No exclusion rules set. The fastest way to add rules is via the "Never suggest" button on proposal cards in the triage queue.',
        )
      );
      return;
    }

    for (const rule of rules) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-tag-delete',
        title: `Remove exclusion rule: ${rule}`,
        'aria-label': `Remove topic exclusion rule: ${rule}`,
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removeTopicExclusion(personaId, rule);
          }
        },
        onClick: () => this._removeTopicExclusion(personaId, rule),
      }, '×');
      deleteBtn.setAttribute('tabindex', '0');

      const tag = el('span', {
        className: 'adv-exclusion-tag',
        role: 'listitem',
      },
        el('span', { className: 'adv-exclusion-tag-text' }, rule),
        deleteBtn,
      );
      card.topicExclTagListEl.appendChild(tag);
    }
  }

  // ── Focus Areas management (DK-101) ─────────────────────────────────────

  /**
   * Render the Focus Areas UI for a persona from current project data.
   * Called from _renderProjects() when project data changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderFocusAreas(personaId) {
    const state = this._focusAreasState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const focusData = project?.advisor?.projects?.[projectId]?.[personaId] ?? {};

    // ── Render chip lists for engineer and design ──────────────────
    if (personaId === 'engineer') {
      this._renderFocusChipList(personaId, 'includePaths', Array.isArray(focusData.includePaths) ? focusData.includePaths : []);
      this._renderFocusChipList(personaId, 'excludePaths', Array.isArray(focusData.excludePaths) ? focusData.excludePaths : []);
    } else if (personaId === 'design') {
      this._renderFocusChipList(personaId, 'urlPatterns', Array.isArray(focusData.urlPatterns) ? focusData.urlPatterns : []);
    } else if (personaId === 'product') {
      // Update text inputs
      const segInput = state.inputs?.['targetSegment'];
      if (segInput && !segInput.matches(':focus')) {
        segInput.value = typeof focusData.targetSegment === 'string' ? focusData.targetSegment : '';
      }
      const goalInput = state.inputs?.['businessGoal'];
      if (goalInput && !goalInput.matches(':focus')) {
        goalInput.value = typeof focusData.businessGoal === 'string' ? focusData.businessGoal : '';
      }
    }

    // ── Update summary chip ─────────────────────────────────────
    const chipEl = state.summaryChipEl;
    if (!chipEl) return;

    let activeCount = 0;
    if (personaId === 'engineer') {
      activeCount += (focusData.includePaths?.length ?? 0) + (focusData.excludePaths?.length ?? 0);
    } else if (personaId === 'design') {
      activeCount += (focusData.urlPatterns?.length ?? 0);
    } else if (personaId === 'product') {
      if (focusData.targetSegment?.trim()) activeCount++;
      if (focusData.businessGoal?.trim()) activeCount++;
    }

    if (activeCount > 0) {
      chipEl.textContent = `${activeCount} constraint${activeCount === 1 ? '' : 's'} active`;
      chipEl.classList.remove('adv-hidden');
    } else {
      chipEl.textContent = '';
      chipEl.classList.add('adv-hidden');
    }
  }

  /**
   * Render a chip list for a focus areas field.
   *
   * @param {string} personaId
   * @param {string} fieldKey - 'includePaths' | 'excludePaths' | 'urlPatterns'
   * @param {string[]} values
   */
  _renderFocusChipList(personaId, fieldKey, values) {
    const state = this._focusAreasState?.[personaId];
    if (!state) return;
    const listEl = state.chipData?.[fieldKey];
    if (!listEl) return;

    listEl.innerHTML = '';

    if (values.length === 0) {
      listEl.appendChild(el('span', { className: 'adv-focus-areas-empty' }, 'None set.'));
      return;
    }

    for (const value of values) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-focus-areas-chip-delete',
        title: `Remove: ${value}`,
        'aria-label': `Remove ${fieldKey} entry: ${value}`,
        tabindex: '0',
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removeFocusAreaChip(personaId, fieldKey, value);
          }
          if (e.key === 'ArrowLeft') {
            const prev = deleteBtn.closest('.adv-focus-areas-chip')?.previousElementSibling?.querySelector('.adv-focus-areas-chip-delete');
            if (prev) prev.focus();
          }
          if (e.key === 'ArrowRight') {
            const next = deleteBtn.closest('.adv-focus-areas-chip')?.nextElementSibling?.querySelector('.adv-focus-areas-chip-delete');
            if (next) next.focus();
          }
        },
        onClick: () => this._removeFocusAreaChip(personaId, fieldKey, value),
      }, '×');

      listEl.appendChild(
        el('span', { className: 'adv-focus-areas-chip', role: 'listitem' },
          el('span', { className: 'adv-focus-areas-chip-text' }, value),
          deleteBtn,
        )
      );
    }
  }

  /**
   * Add a chip value to a focus areas field (engineer/design chip inputs).
   * Validates the value and saves to Firestore.
   *
   * @param {string} personaId
   * @param {string} fieldKey - 'includePaths' | 'excludePaths' | 'urlPatterns'
   * @param {HTMLInputElement} inputEl
   */
  async _addFocusAreaChip(personaId, fieldKey, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    // Validation
    if (value.length > 200) return;

    // For urlPatterns: reject schemes/hostnames
    if (fieldKey === 'urlPatterns') {
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value) || /^\/\//.test(value)) {
        const state = this._focusAreasState?.[personaId];
        if (state?.inputs?.['_validationEl']) {
          state.inputs['_validationEl'].textContent = '✗ Relative paths only — no scheme or hostname';
        }
        return;
      }
    }

    // For includePaths/excludePaths: reject absolute paths
    if (fieldKey === 'includePaths' || fieldKey === 'excludePaths') {
      if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
        return; // Silently reject absolute paths — tooltip explains
      }
    }

    const project = this._projects.find(p => p.id === projectId);
    const existing = project?.advisor?.projects?.[projectId]?.[personaId]?.[fieldKey] ?? [];
    if (!Array.isArray(existing)) return;

    // Max 20 chips per field
    if (existing.length >= 20) return;

    // Avoid exact duplicates
    if (existing.includes(value)) {
      inputEl.value = '';
      return;
    }

    const newValues = [...existing, value];
    if (this._focusAreasSaving[personaId]) return;
    this._focusAreasSaving[personaId] = true;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { [personaId]: { [fieldKey]: newValues } } } } },
        { merge: true }
      );
      inputEl.value = '';
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save focusArea ${fieldKey} for ${personaId}:`, err);
    } finally {
      this._focusAreasSaving[personaId] = false;
    }
  }

  /**
   * Remove the last chip from a focus areas field.
   *
   * @param {string} personaId
   * @param {string} fieldKey
   */
  async _removeLastFocusAreaChip(personaId, fieldKey) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;
    const project = this._projects.find(p => p.id === projectId);
    const existing = project?.advisor?.projects?.[projectId]?.[personaId]?.[fieldKey] ?? [];
    if (!Array.isArray(existing) || existing.length === 0) return;
    await this._removeFocusAreaChip(personaId, fieldKey, existing[existing.length - 1]);
  }

  /**
   * Remove a specific chip value from a focus areas field.
   *
   * @param {string} personaId
   * @param {string} fieldKey
   * @param {string} value
   */
  async _removeFocusAreaChip(personaId, fieldKey, value) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;
    const project = this._projects.find(p => p.id === projectId);
    const existing = project?.advisor?.projects?.[projectId]?.[personaId]?.[fieldKey] ?? [];
    if (!Array.isArray(existing)) return;
    const newValues = existing.filter(v => v !== value);

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { [personaId]: { [fieldKey]: newValues } } } } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove focusArea chip for ${personaId}/${fieldKey}:`, err);
    }
  }

  /**
   * Save the product persona focus area text fields (targetSegment, businessGoal).
   *
   * @param {string} personaId - always 'product'
   */
  async _saveProductFocusAreas(personaId) {
    const state = this._focusAreasState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      const statusEl = state.inputs?.['_saveStatusEl'];
      if (statusEl) {
        statusEl.textContent = 'Select a project first';
        statusEl.className = 'adv-focus-areas-save-status adv-focus-areas-save-status-err';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'adv-focus-areas-save-status'; }, 3000);
      }
      return;
    }

    if (this._focusAreasSaving[personaId]) return;
    this._focusAreasSaving[personaId] = true;

    const statusEl = state.inputs?.['_saveStatusEl'];
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'adv-focus-areas-save-status'; }

    const targetSegment = (state.inputs?.['targetSegment']?.value ?? '').trim().slice(0, 200) || null;
    const businessGoal = (state.inputs?.['businessGoal']?.value ?? '').trim().slice(0, 200) || null;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { product: { targetSegment, businessGoal } } } } },
        { merge: true }
      );
      if (statusEl) {
        statusEl.textContent = 'Saved — applies on next run';
        statusEl.className = 'adv-focus-areas-save-status adv-focus-areas-save-status-ok';
        setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-focus-areas-save-status'; } }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save product focusAreas:`, err);
      if (statusEl) {
        statusEl.textContent = '✗ Save failed';
        statusEl.className = 'adv-focus-areas-save-status adv-focus-areas-save-status-err';
        setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-focus-areas-save-status'; } }, 4000);
      }
    } finally {
      this._focusAreasSaving[personaId] = false;
    }
  }

  // ── DK-124: Focus area pins methods ──────────────────────────────────────

  /**
   * Render the pins chip list for a persona from project Firestore state.
   * Called after project data changes (onProjectsChange).
   *
   * @param {string} personaId - 'engineer' | 'design'
   */
  _renderPins(personaId) {
    const state = this._pinsState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const pins = Array.isArray(project?.advisorPins?.[personaId])
      ? project.advisorPins[personaId]
      : [];

    // Sync draft to Firestore state (only when not actively editing)
    if (!this._pinsSaving[personaId]) {
      this._pinsDraft[personaId] = [...pins];
    }

    // Render chip list
    this._renderPinsChipList(personaId, this._pinsDraft[personaId] ?? pins);

    // Update summary chip
    const count = (this._pinsDraft[personaId] ?? pins).length;
    if (count > 0) {
      state.summaryChipEl.textContent = `${count} pin${count === 1 ? '' : 's'} active`;
      state.summaryChipEl.classList.remove('adv-hidden');
    } else {
      state.summaryChipEl.textContent = '';
      state.summaryChipEl.classList.add('adv-hidden');
    }

    // Staleness warning: shown when the last run warned about dead pins
    // (written to project.advisorPins._stalenessWarning.{personaId})
    const staleWarning = project?.advisorPins?._stalenessWarning?.[personaId];
    if (staleWarning && typeof staleWarning === 'string') {
      state.stalenessEl.textContent = `⚠ ${staleWarning}`;
      state.stalenessEl.classList.remove('adv-hidden');
    } else {
      state.stalenessEl.textContent = '';
      state.stalenessEl.classList.add('adv-hidden');
    }
  }

  /**
   * Render the chip list UI for current draft pins.
   *
   * @param {string} personaId
   * @param {string[]} values
   */
  _renderPinsChipList(personaId, values) {
    const state = this._pinsState?.[personaId];
    if (!state) return;
    const listEl = state.chipListEl;
    if (!listEl) return;

    listEl.innerHTML = '';

    if (!values || values.length === 0) {
      listEl.appendChild(el('span', { className: 'adv-pins-empty' }, 'No pins set.'));
      return;
    }

    for (const value of values) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-pins-chip-delete',
        title: `Remove: ${value}`,
        'aria-label': `Remove pin: ${value}`,
        tabindex: '0',
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removePinsChip(personaId, value);
          }
          if (e.key === 'ArrowLeft') {
            const prev = e.currentTarget.closest('[role="listitem"]')?.previousElementSibling?.querySelector('button');
            if (prev) prev.focus();
          }
          if (e.key === 'ArrowRight') {
            const next = e.currentTarget.closest('[role="listitem"]')?.nextElementSibling?.querySelector('button');
            if (next) next.focus();
          }
        },
        onClick: () => this._removePinsChip(personaId, value),
      }, '×');

      const chip = el('span', {
        className: 'adv-pins-chip',
        role: 'listitem',
      },
        el('span', { className: 'adv-pins-chip-label' }, value),
        deleteBtn,
      );
      listEl.appendChild(chip);
    }
  }

  /**
   * Validate a pin value for the given persona before adding to the draft.
   * Returns { valid: true } or { valid: false, reason: string }.
   *
   * @param {string} personaId - 'engineer' | 'design'
   * @param {string} value
   * @returns {{ valid: boolean, reason?: string }}
   */
  _validatePin(personaId, value) {
    if (!value || !value.trim()) {
      return { valid: false, reason: 'Value must not be empty' };
    }
    const v = value.trim();
    if (personaId === 'engineer') {
      if (v.length > 64) return { valid: false, reason: 'Max 64 characters per glob' };
      if (v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:[\\/]/.test(v)) {
        return { valid: false, reason: 'Relative paths only — no leading / ~ or drive letter' };
      }
      if (v.replace(/\\/g, '/').split('/').includes('..')) {
        return { valid: false, reason: 'Path must not contain ".." sequences' };
      }
    } else if (personaId === 'design') {
      if (v.length > 200) return { valid: false, reason: 'Max 200 characters per path' };
      if (!v.startsWith('/')) return { valid: false, reason: 'URL paths must start with /' };
      if (v.startsWith('//') || /^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) {
        return { valid: false, reason: 'Relative paths only — no scheme or hostname' };
      }
    }
    return { valid: true };
  }

  /**
   * Add a pin chip to the draft (local state only — saved on explicit button press).
   *
   * @param {string} personaId
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   */
  _addPinsChip(personaId, inputEl, validationEl) {
    const value = (inputEl.value || '').trim();
    if (!value) return;

    const result = this._validatePin(personaId, value);
    if (!result.valid) {
      if (validationEl) {
        validationEl.textContent = `✗ ${result.reason}`;
        setTimeout(() => { if (validationEl) validationEl.textContent = ''; }, 3000);
      }
      return;
    }

    if (validationEl) validationEl.textContent = '';

    const draft = this._pinsDraft[personaId] ?? [];
    if (draft.length >= 20) {
      if (validationEl) {
        validationEl.textContent = '✗ Maximum 20 pins per persona';
        setTimeout(() => { if (validationEl) validationEl.textContent = ''; }, 3000);
      }
      return;
    }
    if (draft.includes(value)) {
      inputEl.value = '';
      return;
    }

    this._pinsDraft[personaId] = [...draft, value];
    inputEl.value = '';
    this._renderPinsChipList(personaId, this._pinsDraft[personaId]);

    // Update summary chip count
    const state = this._pinsState?.[personaId];
    const count = this._pinsDraft[personaId].length;
    if (state?.summaryChipEl) {
      state.summaryChipEl.textContent = `${count} pin${count === 1 ? '' : 's'} active`;
      state.summaryChipEl.classList.remove('adv-hidden');
    }
  }

  /**
   * Remove the last chip from the draft.
   *
   * @param {string} personaId
   * @param {HTMLElement} validationEl
   */
  _removeLastPinsChip(personaId, validationEl) {
    const draft = this._pinsDraft[personaId] ?? [];
    if (draft.length === 0) return;
    this._removePinsChip(personaId, draft[draft.length - 1]);
  }

  /**
   * Remove a specific chip value from the draft.
   *
   * @param {string} personaId
   * @param {string} value
   */
  _removePinsChip(personaId, value) {
    const draft = this._pinsDraft[personaId] ?? [];
    this._pinsDraft[personaId] = draft.filter(v => v !== value);
    this._renderPinsChipList(personaId, this._pinsDraft[personaId]);

    const state = this._pinsState?.[personaId];
    const count = this._pinsDraft[personaId].length;
    if (state?.summaryChipEl) {
      if (count > 0) {
        state.summaryChipEl.textContent = `${count} pin${count === 1 ? '' : 's'} active`;
        state.summaryChipEl.classList.remove('adv-hidden');
      } else {
        state.summaryChipEl.textContent = '';
        state.summaryChipEl.classList.add('adv-hidden');
      }
    }
  }

  /**
   * Save the current draft pins to Firestore.
   * Writes the full advisorPins.{personaId} array (not a merge) to avoid drift.
   * Shows a visible "Saved" confirmation after write.
   *
   * @param {string} personaId - 'engineer' | 'design'
   */
  async _savePins(personaId) {
    const state = this._pinsState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = 'Select a project first';
        state.saveStatusEl.className = 'adv-pins-save-status adv-pins-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-pins-save-status'; } }, 3000);
      }
      return;
    }

    if (this._pinsSaving[personaId]) return;
    this._pinsSaving[personaId] = true;

    if (state.saveBtn) state.saveBtn.disabled = true;
    if (state.saveStatusEl) {
      state.saveStatusEl.textContent = 'Saving…';
      state.saveStatusEl.className = 'adv-pins-save-status';
    }

    // Validate all draft values again before writing
    const draft = this._pinsDraft[personaId] ?? [];
    const validPins = draft.filter(v => this._validatePin(personaId, v).valid).slice(0, 20);

    try {
      // Write the full advisorPins.{personaId} field (not a sub-merge) to avoid partial-update drift.
      // Use dot-notation path so we only touch this persona's key, not the whole advisorPins map.
      await this.db.collection('projects').doc(projectId).set(
        { advisorPins: { [personaId]: validPins } },
        { merge: true },
      );

      // Clear staleness warning on explicit save (user acknowledged or fixed the issue)
      await this.db.collection('projects').doc(projectId).set(
        { advisorPins: { _stalenessWarning: { [personaId]: null } } },
        { merge: true },
      );

      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = 'Saved';
        state.saveStatusEl.className = 'adv-pins-save-status adv-pins-save-status-ok';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-pins-save-status'; } }, 2500);
      }
      if (state.stalenessEl) {
        state.stalenessEl.textContent = '';
        state.stalenessEl.classList.add('adv-hidden');
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save pins for ${personaId}:`, err);
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = '✗ Save failed';
        state.saveStatusEl.className = 'adv-pins-save-status adv-pins-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-pins-save-status'; } }, 4000);
      }
    } finally {
      this._pinsSaving[personaId] = false;
      if (state.saveBtn) state.saveBtn.disabled = false;
    }
  }

  // ── DK-187: Focus constraint methods ─────────────────────────────────────

  /**
   * Render the focus constraints chip list for a persona from Firestore state.
   * Called from _renderCard (via _states listener) and after project filter changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderFocusConstraints(personaId) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;

    const personaState = this._states[personaId];
    const focus = personaState?.focus ?? null;
    const values = Array.isArray(focus?.[state.fieldKey]) ? focus[state.fieldKey] : [];

    // Rebuild chip list
    const listEl = state.chipListEl;
    if (!listEl) return;
    listEl.innerHTML = '';

    if (values.length === 0) {
      listEl.appendChild(el('span', { className: 'adv-focus-areas-empty' }, 'Watching everything'));
    } else {
      for (const value of values) {
        const deleteBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-chip-delete',
          title: `Remove: ${value}`,
          'aria-label': `Remove ${state.fieldKey} entry: ${value}`,
          tabindex: '0',
          onKeyDown: (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              this._removeFocusConstraintChip(personaId, value);
            }
            if (e.key === 'ArrowLeft') {
              const prev = deleteBtn.closest('.adv-focus-areas-chip')?.previousElementSibling?.querySelector('.adv-focus-areas-chip-delete');
              if (prev) prev.focus();
            }
            if (e.key === 'ArrowRight') {
              const next = deleteBtn.closest('.adv-focus-areas-chip')?.nextElementSibling?.querySelector('.adv-focus-areas-chip-delete');
              if (next) next.focus();
            }
          },
          onClick: () => this._removeFocusConstraintChip(personaId, value),
        }, '×');
        deleteBtn.setAttribute('aria-label', `Remove ${state.fieldKey} entry: ${value}`);

        listEl.appendChild(
          el('span', { className: 'adv-focus-areas-chip', role: 'listitem' },
            el('span', { className: 'adv-focus-areas-chip-text', title: value }, value),
            deleteBtn,
          )
        );
      }
    }

    // Update summary chip in header
    const summaryChip = state.summaryChipEl;
    if (summaryChip) {
      if (values.length > 0) {
        const unit = { globs: 'glob', routes: 'route', keywords: 'keyword' }[state.fieldKey] || 'item';
        summaryChip.textContent = `${values.length} ${unit}${values.length === 1 ? '' : 's'}`;
        summaryChip.title = values.join(', ');
        summaryChip.classList.remove('adv-hidden');
      } else {
        summaryChip.textContent = '';
        summaryChip.classList.add('adv-hidden');
      }
    }
  }

  /**
   * Add a chip to the focus constraints field (immediate Firestore save per chip add).
   * Validates the value client-side before writing.
   *
   * @param {string} personaId
   * @param {HTMLInputElement} inputEl
   */
  async _addFocusConstraintChip(personaId, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;

    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];

    // Enforce max per field
    const maxItems = { globs: 10, routes: 10, keywords: 20 }[state.fieldKey] ?? 10;
    if (existing.length >= maxItems) return;

    // Enforce max length
    const maxLen = { globs: 100, routes: 100, keywords: 50 }[state.fieldKey] ?? 100;
    if (value.length > maxLen) return;

    // Avoid duplicates
    if (existing.includes(value)) {
      inputEl.value = '';
      return;
    }

    // Client-side safety checks (mirroring focus-validator.js)
    if (personaId === 'engineer') {
      if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('..')) return;
      if ((value.match(/\*\*/g) || []).length > 1) return;
    }
    if (personaId === 'design') {
      if (!value.startsWith('/')) return;
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value) || /^\/\//.test(value)) return;
    }

    const newValues = [...existing, value];
    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: newValues } },
        { merge: true }
      );
      inputEl.value = '';
      // Reset dirty state (this chip was immediately saved)
      if (state) { state.dirty = false; state.saveBtn?.classList.remove('adv-fc-save-dirty'); }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to add focus constraint chip for ${personaId}:`, err);
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  }

  /**
   * Remove the last chip from the focus constraints field.
   * @param {string} personaId
   */
  async _removeLastFocusConstraintChip(personaId) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;
    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];
    if (existing.length === 0) return;
    await this._removeFocusConstraintChip(personaId, existing[existing.length - 1]);
  }

  /**
   * Remove a specific chip value from the focus constraints field.
   * Immediately saves to Firestore.
   *
   * @param {string} personaId
   * @param {string} value
   */
  async _removeFocusConstraintChip(personaId, value) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;
    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];
    const newValues = existing.filter(v => v !== value);
    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;
    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: newValues } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove focus constraint chip for ${personaId}:`, err);
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  }

  /**
   * Save the current focus constraint chip list.
   * Called by the Save button.
   * @param {string} personaId
   */
  async _saveFocusConstraints(personaId) {
    // Chips are already saved on add/remove; Save just clears the dirty flag + shows confirmation.
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;

    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;

    const { saveBtn, saveStatusEl } = state;
    if (saveStatusEl) { saveStatusEl.textContent = 'Saving…'; saveStatusEl.className = 'adv-fc-save-status'; }

    // Get current chips from state (already saved piecemeal on add, but re-save for full replace)
    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: existing } },
        { merge: true }
      );
      state.dirty = false;
      if (saveBtn) saveBtn.classList.remove('adv-fc-save-dirty');
      if (saveStatusEl) {
        saveStatusEl.textContent = '✓ Saved — applies on next run';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-ok';
        setTimeout(() => {
          if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; }
        }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save focus constraints for ${personaId}:`, err);
      if (saveStatusEl) {
        saveStatusEl.textContent = '✗ Save failed';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-err';
        setTimeout(() => { if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; } }, 4000);
      }
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  }

  /**
   * Clear all focus constraints for a persona — returns to "Watching everything".
   * @param {string} personaId
   */
  async _clearFocusConstraints(personaId) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;
    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;

    const { saveStatusEl, saveBtn } = state;
    if (saveStatusEl) { saveStatusEl.textContent = 'Clearing…'; saveStatusEl.className = 'adv-fc-save-status'; }

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: [] } },
        { merge: true }
      );
      state.dirty = false;
      if (saveBtn) saveBtn.classList.remove('adv-fc-save-dirty');
      if (saveStatusEl) {
        saveStatusEl.textContent = '✓ Cleared — watching everything';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-ok';
        setTimeout(() => { if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; } }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to clear focus constraints for ${personaId}:`, err);
      if (saveStatusEl) {
        saveStatusEl.textContent = '✗ Clear failed';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-err';
        setTimeout(() => { if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; } }, 4000);
      }
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  }

  // ── DK-134: Scope config per persona (chip-based topics + path filters) ──────

  /**
   * Toggle the scope config drawer open/closed.
   * @param {string} personaId
   */
  _toggleScopedFocusDrawer(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;
    state.drawerOpen = !state.drawerOpen;
    state.drawerEl.classList.toggle('adv-hidden', !state.drawerOpen);
    state.gearBtn.setAttribute('aria-expanded', String(state.drawerOpen));
    state.gearBtn.title = state.drawerOpen
      ? 'Close scope focus areas'
      : 'Configure scope focus areas';
    // Move focus into topics input when opening (accessibility)
    if (state.drawerOpen && state.topicsInputEl) {
      setTimeout(() => state.topicsInputEl.focus(), 50);
    }
  }

  /**
   * Render the scoped focus UI for a persona from current project data.
   * Reads new DK-134 scope schema (arrays) with fallback to DK-301 string fields.
   * Called from _renderProjects() and setProjectFilter() when project data changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;

    // DK-134: Read new scope schema (arrays) stored at advisor.projects.<projectId>.<personaId>.scope
    const scopeData = project?.advisor?.projects?.[projectId]?.[personaId]?.scope ?? {};
    // Fallback: DK-301 legacy string fields at focusAreas.<personaId>
    const legacyFocusAreas = project?.advisor?.projects?.[projectId]?.focusAreas?.[personaId] ?? {};

    // Merge: prefer new array schema; fall back to legacy string parsing
    let topics = Array.isArray(scopeData.topics) ? scopeData.topics : [];
    let include = Array.isArray(scopeData.include) ? scopeData.include : [];
    let exclude = Array.isArray(scopeData.exclude) ? scopeData.exclude : [];

    // Legacy migration: if new arrays are empty but legacy string fields exist, import them
    if (topics.length === 0 && typeof legacyFocusAreas.topics === 'string' && legacyFocusAreas.topics.trim()) {
      topics = legacyFocusAreas.topics.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
    }
    if (personaId === 'engineer' && include.length === 0 && typeof legacyFocusAreas.paths === 'string' && legacyFocusAreas.paths.trim()) {
      include = [legacyFocusAreas.paths.trim()];
    }

    // Only update chip state if the drawer is not actively being edited
    if (!state.drawerOpen) {
      this._scopedFocusChips[personaId] = { topics: [...topics], include: [...include], exclude: [...exclude] };
      this._rebuildScopeChips(personaId);
    }

    // Zero-file warning: shown when advisor wrote a warning for this persona
    const noFilesWarning = project?.advisor?.projects?.[projectId]?.focusAreaWarnings?.[personaId]?.noFilesMatched === true;
    if (state.noFilesWarningEl) {
      state.noFilesWarningEl.classList.toggle('adv-hidden', !noFilesWarning || personaId !== 'engineer');
    }

    // Active dot: shown when any constraint is non-empty
    const isActive = topics.length > 0 || include.length > 0 || exclude.length > 0;
    if (state.dotEl) {
      state.dotEl.classList.toggle('adv-hidden', !isActive);
      if (isActive) {
        const parts = [];
        if (topics.length > 0) parts.push(`Topics: ${topics.join(', ')}`);
        if (include.length > 0) parts.push(`Include: ${include.join(', ')}`);
        if (exclude.length > 0) parts.push(`Exclude: ${exclude.join(', ')}`);
        state.dotEl.title = `Scoped: ${parts.join(' | ')}`;
        state.dotEl.setAttribute('aria-label', `Scope active: ${parts.join(', ')}`);
      } else {
        state.dotEl.title = '';
        state.dotEl.setAttribute('aria-label', 'Scope constraints active');
      }
    }
  }

  /**
   * Rebuild all chip DOM elements for a persona from the in-memory chip data.
   * @param {string} personaId
   */
  _rebuildScopeChips(personaId) {
    const state = this._scopedFocusState?.[personaId];
    const chips = this._scopedFocusChips?.[personaId];
    if (!state || !chips) return;

    const renderList = (listEl, chipArr, fieldKey) => {
      if (!listEl) return;
      listEl.innerHTML = '';
      for (const value of chipArr) {
        listEl.appendChild(this._makeScopeChip(personaId, fieldKey, value));
      }
    };

    renderList(state.topicsChipListEl, chips.topics, 'topics');
    if (personaId === 'engineer') {
      renderList(state.includeChipListEl, chips.include, 'include');
      renderList(state.excludeChipListEl, chips.exclude, 'exclude');
    }
  }

  /**
   * Create a removable chip element for a scope field.
   * Chip is keyboard-accessible: Tab to focus, Backspace/Delete to remove.
   */
  _makeScopeChip(personaId, fieldKey, value) {
    const removeBtn = el('button', {
      type: 'button',
      className: 'adv-scope-chip-remove',
      'aria-label': `Remove ${value}`,
      onClick: () => {
        const chips = this._scopedFocusChips[personaId];
        if (!chips) return;
        chips[fieldKey] = chips[fieldKey].filter(v => v !== value);
        this._rebuildScopeChips(personaId);
      },
    }, '×');

    const chip = el('span', {
      className: 'adv-scope-chip',
      role: 'listitem',
      tabIndex: 0,
      onKeydown: (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          const chips = this._scopedFocusChips[personaId];
          if (!chips) return;
          chips[fieldKey] = chips[fieldKey].filter(v => v !== value);
          this._rebuildScopeChips(personaId);
        }
      },
    }, value, removeBtn);

    return chip;
  }

  /**
   * Add a chip from a text input field for the given scope field.
   * Trims whitespace, enforces length cap, deduplicates.
   */
  _addScopedFocusChipFromInput(personaId, fieldKey, inputEl) {
    const raw = inputEl?.value?.trim();
    if (!raw) return;
    this._addScopedFocusChip(personaId, fieldKey, raw);
    if (inputEl) inputEl.value = '';
  }

  /**
   * Add a chip value (string) to a scope field.
   * Enforces max length, deduplicates, max 25 items per field.
   */
  _addScopedFocusChip(personaId, fieldKey, value) {
    const MAX_LEN = fieldKey === 'topics' ? 50 : 200;
    const MAX_CHIPS = 25;
    const safe = sanitizePromptValue(value?.trim() ?? '');
    if (!safe) return;
    const capped = safe.slice(0, MAX_LEN);
    // Path filters: reject absolute paths and traversal
    if ((fieldKey === 'include' || fieldKey === 'exclude') &&
        (capped.startsWith('/') || capped.startsWith('..') || /^[A-Za-z]:[\\/]/.test(capped))) {
      return;
    }
    const chips = this._scopedFocusChips[personaId];
    if (!chips) return;
    if (!Array.isArray(chips[fieldKey])) chips[fieldKey] = [];
    if (chips[fieldKey].includes(capped)) return; // deduplicate
    if (chips[fieldKey].length >= MAX_CHIPS) return; // cap
    chips[fieldKey].push(capped);
    this._rebuildScopeChips(personaId);
  }

  /**
   * Remove the last chip from a scope field (Backspace on empty input).
   */
  _removeLastScopedFocusChip(personaId, fieldKey) {
    const chips = this._scopedFocusChips[personaId];
    if (!chips || !Array.isArray(chips[fieldKey]) || chips[fieldKey].length === 0) return;
    chips[fieldKey].pop();
    this._rebuildScopeChips(personaId);
  }

  /**
   * Clear all scope constraints for a persona (topics + include + exclude).
   */
  async _clearScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;

    // Clear in-memory chip state
    this._scopedFocusChips[personaId] = { topics: [], include: [], exclude: [] };
    this._rebuildScopeChips(personaId);

    // Clear file count badge
    if (state.fileCountBadgeEl) {
      state.fileCountBadgeEl.textContent = '';
      state.fileCountBadgeEl.classList.add('adv-hidden');
    }

    // Save empty state to Firestore
    await this._saveScopedFocus(personaId);
  }

  /**
   * "Test scope" — resolve path patterns against the project root and show file count.
   * Only available for engineer persona. Reads repoPath from Firestore project doc,
   * posts to a server-side endpoint (if available) to resolve globs server-side.
   * If no endpoint, shows an informational message instead.
   */
  async _testScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state || !state.fileCountBadgeEl) return;

    const chips = this._scopedFocusChips[personaId];
    const include = chips?.include ?? [];
    const exclude = chips?.exclude ?? [];

    if (include.length === 0 && exclude.length === 0) {
      state.fileCountBadgeEl.textContent = 'Add path patterns first';
      state.fileCountBadgeEl.classList.remove('adv-hidden');
      setTimeout(() => {
        if (state.fileCountBadgeEl) {
          state.fileCountBadgeEl.textContent = '';
          state.fileCountBadgeEl.classList.add('adv-hidden');
        }
      }, 3000);
      return;
    }

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    state.fileCountBadgeEl.textContent = 'Counting…';
    state.fileCountBadgeEl.classList.remove('adv-hidden');

    try {
      // Query Firestore for the stored file count from the last cycle result.
      // Full server-side pattern resolution requires a backend endpoint.
      // For now, surface the Firestore-stored file counts from the last run.
      const projectSnap = await this.db.collection('projects').doc(projectId).get();
      const project = projectSnap.data();
      const lastCount = project?.advisor?.projects?.[projectId]?.scopeFileCount?.[personaId] ?? null;
      if (lastCount !== null && typeof lastCount === 'number') {
        state.fileCountBadgeEl.textContent = `${lastCount} file${lastCount === 1 ? '' : 's'} matched`;
      } else {
        state.fileCountBadgeEl.textContent = 'Save scope and run to see file count';
      }
    } catch (err) {
      state.fileCountBadgeEl.textContent = 'Count unavailable';
    }

    setTimeout(() => {
      if (state.fileCountBadgeEl) {
        state.fileCountBadgeEl.classList.add('adv-hidden');
        state.fileCountBadgeEl.textContent = '';
      }
    }, 8000);
  }

  /**
   * Save the scoped focus config for a persona to Firestore.
   * DK-134: Stores chip arrays at advisor.projects.<projectId>.<personaId>.scope.
   * Also writes legacy string fields for backward compat with older daemon versions.
   * @param {string} personaId
   */
  async _saveScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = 'Select a project first';
        state.saveStatusEl.className = 'adv-scope-save-status adv-scope-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-scope-save-status'; } }, 3000);
      }
      return;
    }

    if (this._scopedFocusSaving[personaId]) return;
    this._scopedFocusSaving[personaId] = true;

    if (state.saveStatusEl) { state.saveStatusEl.textContent = 'Saving…'; state.saveStatusEl.className = 'adv-scope-save-status'; }

    // Read from chip state (already sanitized on input)
    const chips = this._scopedFocusChips[personaId] ?? { topics: [], include: [], exclude: [] };

    // Server-side sanitization double-check: strip prompt delimiters, enforce length caps
    const safeTopics = chips.topics
      .map(t => sanitizePromptValue(t).slice(0, 50))
      .filter(Boolean)
      .slice(0, 25);

    // DK-134: New scope schema — arrays
    const scopeData = {
      topics: safeTopics,
      ...(personaId === 'engineer' ? {
        include: chips.include.map(p => sanitizePromptValue(p).slice(0, 200)).filter(Boolean).slice(0, 25),
        exclude: chips.exclude.map(p => sanitizePromptValue(p).slice(0, 200)).filter(Boolean).slice(0, 25),
      } : {}),
    };

    try {
      // Write new array schema under advisor.projects.<projectId>.<personaId>.scope
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { [personaId]: { scope: scopeData } } } } },
        { merge: true }
      );
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = '✓ Saved — applies on next run';
        state.saveStatusEl.className = 'adv-scope-save-status adv-scope-save-status-ok';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-scope-save-status'; } }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save scoped focus for ${personaId}:`, err);
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = '✗ Save failed';
        state.saveStatusEl.className = 'adv-scope-save-status adv-scope-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-scope-save-status'; } }, 4000);
      }
    } finally {
      this._scopedFocusSaving[personaId] = false;
    }
  }

  /**
   * DK-134: Update the scope summary bar shown above all persona cards.
   * Shows a one-line summary per persona (e.g. "Engineer: src/auth/**, +security").
   * Hidden when all personas have no scope set.
   */
  _updateScopeSummaryBar() {
    if (!this._scopeSummaryBar) return;
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;

    const SCOPE_PERSONAS = [
      { id: 'engineer', label: 'Engineer' },
      { id: 'design',   label: 'Design'   },
      { id: 'product',  label: 'Product'  },
    ];

    const lines = [];
    for (const { id, label } of SCOPE_PERSONAS) {
      const scopeData = project?.advisor?.projects?.[projectId]?.[id]?.scope ?? {};
      const topics = Array.isArray(scopeData.topics) ? scopeData.topics : [];
      const include = Array.isArray(scopeData.include) ? scopeData.include : [];
      // Also check chip state (in-memory changes not yet saved)
      const chipTopics = this._scopedFocusChips[id]?.topics ?? topics;
      const chipInclude = this._scopedFocusChips[id]?.include ?? include;

      const parts = [];
      if (chipInclude.length > 0) parts.push(chipInclude.join(', '));
      if (chipTopics.length > 0) parts.push('+' + chipTopics.join(', +'));

      lines.push({ label, summary: parts.length > 0 ? parts.join(' ') : 'entire codebase' });
    }

    const anyScoped = lines.some(l => l.summary !== 'entire codebase');
    this._scopeSummaryBar.classList.toggle('adv-hidden', !anyScoped);

    if (anyScoped) {
      this._scopeSummaryBar.innerHTML = '';
      for (const { label, summary } of lines) {
        const item = el('div', { className: 'adv-scope-summary-item' },
          el('span', { className: 'adv-scope-summary-persona' }, label + ':'),
          el('span', {
            className: 'adv-scope-summary-value' + (summary === 'entire codebase' ? ' adv-scope-summary-default' : ''),
            title: summary,
          }, summary),
        );
        this._scopeSummaryBar.appendChild(item);
      }
    }
  }

  _renderLog(id, activityLog) {
    const card = this._cards[id];
    if (!card || !card.logList) return;

    const entries = Array.isArray(activityLog) ? activityLog : [];
    card.logList.innerHTML = '';

    if (entries.length === 0) {
      card.logList.appendChild(
        el('div', { className: 'adv-log-empty' }, 'No activity recorded yet.')
      );
      return;
    }

    for (const entry of entries) {
      const ts = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const line = el('div', { className: 'adv-log-entry' },
        ts ? el('span', { className: 'adv-log-ts' }, ts + ' ') : null,
        el('span', { className: 'adv-log-msg' }, entry.msg || ''),
      );
      card.logList.appendChild(line);
    }
  }

  // ── DK-118: Per-project persona enable/disable toggles ──────────────────────

  /**
   * Build the persona enable/disable toggles panel.
   * Three toggle switches for Engineer, Design, and Product personas.
   * Collapsed by default. Visible only when a project is selected.
   * Stored at projects/{projectId}.advisor.personas.{engineer,design,product}.
   */
  _buildPersonaTogglesPanel() {
    const TOGGLE_PERSONAS = [
      {
        id: 'engineer',
        label: 'Engineer analysis',
        description: 'Reviews code for security vulnerabilities, inefficiencies, and open-source safety issues.',
      },
      {
        id: 'design',
        label: 'Design analysis',
        description: 'Audits the app UI for UX friction, accessibility, and visual polish issues.',
      },
      {
        id: 'product',
        label: 'Product analysis',
        description: 'Generates feature ideas grounded in project context and user needs.',
      },
    ];

    const panel = el('div', {
      className: 'adv-persona-toggles-panel',
      style: 'display:none', // hidden until a project is selected
    });

    // Panel header — collapsible toggle
    const panelChevron = el('span', { className: 'adv-persona-toggles-chevron', 'aria-hidden': 'true' }, '▸');
    const panelHeader = el('button', {
      className: 'adv-persona-toggles-header',
      'aria-expanded': 'false',
      'aria-controls': 'adv-persona-toggles-body',
      onClick: () => {
        const isExpanded = panelHeader.getAttribute('aria-expanded') === 'true';
        panelHeader.setAttribute('aria-expanded', String(!isExpanded));
        panelChevron.textContent = isExpanded ? '▸' : '▾';
        panelBody.classList.toggle('adv-hidden', isExpanded);
      },
    },
      panelChevron,
      el('span', { className: 'adv-persona-toggles-title' }, 'Advisor'),
    );
    panel.appendChild(panelHeader);

    const panelBody = el('div', {
      className: 'adv-persona-toggles-body adv-hidden',
      id: 'adv-persona-toggles-body',
    });
    panel.appendChild(panelBody);

    panelBody.appendChild(
      el('p', { className: 'adv-persona-toggles-intro' },
        'Enable or disable individual personas for this project. Changes take effect on the next advisor cycle.'
      )
    );

    // Use fieldset/legend for accessibility (per spec)
    const projectName = this._projects.find(p => p.id === this._filterProjectId)?.name
      || this._filterProjectId || 'this project';
    const fieldset = el('fieldset', { className: 'adv-persona-toggles-fieldset' });
    const legend = el('legend', { className: 'adv-persona-toggles-legend' }, `Advisor personas for ${projectName}`);
    this._personaTogglesLegend = legend;
    fieldset.appendChild(legend);

    for (const { id, label, description } of TOGGLE_PERSONAS) {
      const rowId = `adv-persona-toggle-${id}`;
      const statusId = `adv-persona-toggle-status-${id}`;
      const undoId = `adv-persona-toggle-undo-${id}`;

      // Toggle switch (checkbox styled as switch)
      const checkbox = el('input', {
        type: 'checkbox',
        className: 'adv-persona-toggle-input',
        id: rowId,
        checked: true, // default: enabled; updated by _renderPersonaTogglesPanel
        'aria-label': `Enable ${label} for ${projectName}`,
        'aria-describedby': statusId,
        onChange: () => this._onPersonaToggleChange(id, checkbox.checked, statusId, undoId),
      });

      const onOffText = el('span', { className: 'adv-persona-toggle-onoff', 'aria-hidden': 'true' }, 'On');
      this._personaTogglesOnOffEls[id] = onOffText;

      const toggleThumb = el('span', { className: 'adv-persona-toggle-thumb' });
      const toggleTrack = el('span', { className: 'adv-persona-toggle-track', 'aria-hidden': 'true' }, toggleThumb);

      // Label wraps both the track and the text so clicking either toggles the switch.
      // The hidden checkbox is the semantic control; label provides the click area.
      const labelEl = el('label', {
        className: 'adv-persona-toggle-label',
        htmlFor: rowId,
      },
        el('div', { className: 'adv-persona-toggle-switch-wrap' },
          checkbox,
          toggleTrack,
          onOffText,
        ),
        el('span', { className: 'adv-persona-toggle-label-text' },
          el('span', { className: 'adv-persona-toggle-name' }, label),
          el('span', { className: 'adv-persona-toggle-desc' }, description),
        )
      );

      // Status / confirmation text
      const statusEl = el('div', {
        className: 'adv-persona-toggle-status',
        id: statusId,
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      });

      // Undo affordance
      const undoEl = el('div', {
        className: 'adv-persona-toggle-undo adv-hidden',
        id: undoId,
      });

      const row = el('div', { className: 'adv-persona-toggle-row' }, labelEl);

      fieldset.appendChild(row);
      fieldset.appendChild(statusEl);
      fieldset.appendChild(undoEl);

      this._personaToggleEls[id] = { checkbox, statusEl, undoEl };
    }

    panelBody.appendChild(fieldset);

    this._personaTogglesPanel = panel;
    return panel;
  }

  /**
   * Render/update the persona toggles panel for the current project.
   * Called when project data changes or project filter changes.
   */
  _renderPersonaTogglesPanel() {
    if (!this._personaTogglesPanel) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      this._personaTogglesPanel.style.display = 'none';
      return;
    }

    this._personaTogglesPanel.style.display = '';

    const project = this._projects.find(p => p.id === projectId);
    const personas = project?.advisor?.personas || {};

    // Update legend with current project name
    if (this._personaTogglesLegend) {
      const projectName = project?.name || projectId;
      this._personaTogglesLegend.textContent = `Advisor personas for ${projectName}`;
    }

    for (const id of ['engineer', 'design', 'product']) {
      const refs = this._personaToggleEls[id];
      if (!refs) continue;

      // Absent key = enabled (defaults to true)
      const enabled = personas[id] !== false;
      refs.checkbox.checked = enabled;

      // Update on/off text
      if (this._personaTogglesOnOffEls?.[id]) {
        this._personaTogglesOnOffEls[id].textContent = enabled ? 'On' : 'Off';
        this._personaTogglesOnOffEls[id].classList.toggle('adv-persona-toggle-onoff-off', !enabled);
      }

      // Update aria-label with current project name
      const projectName = project?.name || projectId;
      const labels = {
        engineer: 'Engineer analysis',
        design: 'Design analysis',
        product: 'Product analysis',
      };
      refs.checkbox.setAttribute('aria-label', `Enable ${labels[id] || id} for ${projectName}`);

      // Show disabled timestamp if persona is off
      const disabledAt = personas[`${id}DisabledAt`];
      if (!enabled && disabledAt) {
        const d = toDate(disabledAt);
        if (d) {
          const monthDay = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          // Only show timestamp if no in-flight status message
          if (!this._personaToggleSaving[id] && refs.statusEl.textContent === '') {
            refs.statusEl.textContent = `Disabled ${monthDay}`;
            refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-disabled';
          }
        }
      } else if (!this._personaToggleSaving[id] && refs.statusEl.textContent.startsWith('Disabled ')) {
        refs.statusEl.textContent = '';
        refs.statusEl.className = 'adv-persona-toggle-status';
      }
    }

    // Update the EDP indicator in the project list (project tab dropdown)
    this._renderEdpIndicator();
  }

  /**
   * Handle a persona toggle change.
   * Debounces 500ms before writing to Firestore.
   * On success: shows inline confirmation + 5-second undo affordance.
   * On failure: snaps toggle back to previous state.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   * @param {boolean} newEnabled - the new desired state
   * @param {string} statusId - ID of the status element
   * @param {string} undoId - ID of the undo element
   */
  _onPersonaToggleChange(personaId, newEnabled, statusId, undoId) {
    const projectId = this._filterProjectId;
    if (!projectId) return;

    const refs = this._personaToggleEls[personaId];
    if (!refs) return;

    // Update on/off text immediately (optimistic UI)
    if (this._personaTogglesOnOffEls?.[personaId]) {
      this._personaTogglesOnOffEls[personaId].textContent = newEnabled ? 'On' : 'Off';
      this._personaTogglesOnOffEls[personaId].classList.toggle('adv-persona-toggle-onoff-off', !newEnabled);
    }

    // Clear any existing debounce timer
    if (this._personaToggleDebounce[personaId]) {
      clearTimeout(this._personaToggleDebounce[personaId]);
      this._personaToggleDebounce[personaId] = null;
    }

    // Clear previous undo affordance
    refs.undoEl.classList.add('adv-hidden');
    refs.undoEl.innerHTML = '';

    // Show "Saving…" status
    refs.statusEl.textContent = 'Saving…';
    refs.statusEl.className = 'adv-persona-toggle-status';

    const previousEnabled = !newEnabled; // what it was before the change

    this._personaToggleDebounce[personaId] = setTimeout(async () => {
      this._personaToggleDebounce[personaId] = null;
      this._personaToggleSaving[personaId] = true;

      // Check if the persona is currently running (show "running now" notice)
      const personaState = this._states[personaId];
      const isRunning = personaState?.status === 'running';
      if (isRunning && !newEnabled) {
        refs.statusEl.textContent = `${personaId.charAt(0).toUpperCase() + personaId.slice(1)} running now — will disable after this run`;
        refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-info';
        refs.statusEl.setAttribute('aria-live', 'assertive');
      }

      try {
        const labels = {
          engineer: 'Engineer analysis',
          design: 'Design analysis',
          product: 'Product analysis',
        };
        const personaLabel = labels[personaId] || personaId;

        // Build the update
        const update = {
          [`advisor.personas.${personaId}`]: newEnabled,
          updatedAt: new Date().toISOString(),
        };

        // When disabling, also write disabledAt timestamp
        if (!newEnabled) {
          update[`advisor.personas.${personaId}DisabledAt`] = new Date().toISOString();
        } else {
          // When re-enabling, delete the disabledAt field by setting to null
          // (Firestore client SDK: use FieldValue.delete() — but we don't have it here;
          // set to null and handle null in the render logic)
          update[`advisor.personas.${personaId}DisabledAt`] = null;
        }

        await this.db.collection('projects').doc(projectId).update(update);

        this._personaToggleSaving[personaId] = false;

        // Show confirmation message
        const action = newEnabled ? 'enabled' : 'disabled';
        const effectMsg = newEnabled
          ? `${personaLabel} enabled — takes effect next cycle`
          : `${personaLabel} disabled — takes effect next cycle`;

        if (isRunning && !newEnabled) {
          refs.statusEl.textContent = `${personaId.charAt(0).toUpperCase() + personaId.slice(1)} running now — will disable after this run`;
          refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-info';
        } else {
          refs.statusEl.textContent = effectMsg;
          refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-ok';
          refs.statusEl.setAttribute('aria-live', 'polite');
        }

        // Announce to screen readers
        this._announceToSR(effectMsg);

        // Show 5-second undo affordance
        const undoBtn = el('button', {
          className: 'adv-persona-toggle-undo-btn',
          type: 'button',
          onClick: () => {
            // Revert: toggle back to the previous state
            refs.checkbox.checked = previousEnabled;
            if (this._personaTogglesOnOffEls?.[personaId]) {
              this._personaTogglesOnOffEls[personaId].textContent = previousEnabled ? 'On' : 'Off';
              this._personaTogglesOnOffEls[personaId].classList.toggle('adv-persona-toggle-onoff-off', !previousEnabled);
            }
            refs.undoEl.classList.add('adv-hidden');
            clearTimeout(refs._undoTimer);
            this._onPersonaToggleChange(personaId, previousEnabled, statusId, undoId);
          },
        }, 'Undo');

        refs.undoEl.innerHTML = '';
        refs.undoEl.appendChild(undoBtn);
        refs.undoEl.classList.remove('adv-hidden');

        // Auto-dismiss after 5 seconds
        if (refs._undoTimer) clearTimeout(refs._undoTimer);
        refs._undoTimer = setTimeout(() => {
          refs.undoEl.classList.add('adv-hidden');
          // Also clear the confirmation message after 5 seconds (unless it's the running-now message)
          if (!refs.statusEl.classList.contains('adv-persona-toggle-status-info')) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-persona-toggle-status';
          }
        }, 5000);

      } catch (err) {
        console.error(`AdvisorPanel: failed to toggle ${personaId} for ${projectId}:`, err);
        this._personaToggleSaving[personaId] = false;

        // Snap back to previous state on failure
        refs.checkbox.checked = previousEnabled;
        if (this._personaTogglesOnOffEls?.[personaId]) {
          this._personaTogglesOnOffEls[personaId].textContent = previousEnabled ? 'On' : 'Off';
          this._personaTogglesOnOffEls[personaId].classList.toggle('adv-persona-toggle-onoff-off', !previousEnabled);
        }

        refs.statusEl.textContent = 'Error — could not save. Try again.';
        refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-err';
        refs.statusEl.setAttribute('aria-live', 'assertive');

        // Clear error after 4 seconds
        setTimeout(() => {
          if (refs.statusEl.textContent === 'Error — could not save. Try again.') {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-persona-toggle-status';
          }
        }, 4000);
      }
    }, 500);
  }

  /**
   * Update the E/D/P indicator in the advisor panel header.
   * Active personas render at full opacity; inactive ones are muted (strikethrough).
   * Called whenever persona toggle state changes or project filter changes.
   */
  _renderEdpIndicator() {
    if (!this._edpIndicatorEl) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      this._edpIndicatorEl.style.display = 'none';
      return;
    }

    const project = this._projects.find(p => p.id === projectId);
    if (!project) {
      this._edpIndicatorEl.style.display = 'none';
      return;
    }

    this._edpIndicatorEl.style.display = '';
    this._edpIndicatorEl.innerHTML = '';

    const personas = project?.advisor?.personas || {};
    const parts = [
      { letter: 'E', enabled: personas.engineer !== false, title: 'Engineer analysis' },
      { letter: 'D', enabled: personas.design !== false,   title: 'Design analysis' },
      { letter: 'P', enabled: personas.product !== false,  title: 'Product analysis' },
    ];

    for (const { letter, enabled, title } of parts) {
      const span = el('span', {
        className: 'adv-edp-letter' + (enabled ? '' : ' adv-edp-letter-off'),
        title: `${title}: ${enabled ? 'enabled' : 'disabled'}`,
        'aria-label': `${title}: ${enabled ? 'on' : 'off'}`,
      }, letter);
      this._edpIndicatorEl.appendChild(span);
    }
  }

  _renderProjects() {
    // Update the context panel with fresh project data
    this._renderContextPanel();
    this._renderYoloToggle();
    this._renderPersonaInstructionsPanel();
    // DK-118: Update persona enable/disable toggles when project data changes
    this._renderPersonaTogglesPanel();
    // DK-194: Update consensus gate panel (enabled persona count may have changed)
    this._renderConsensusGatePanel();
    // DK-128: Update exclusion tag lists when project data changes
    for (const personaId of ['engineer', 'design']) {
      this._renderExclusionTags(personaId);
      this._loadExclusionSkipCount(personaId);
    }
    // DK-101: Update focus areas UI for all three personas
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderFocusAreas(personaId);
    }
    // DK-187: Focus constraints UI reads from /advisor/{personaId}.focus (persona-level, not project)
    // No need to re-render on project change — handled by _subscribePersona listener.

    // DK-302: Update priorities preview and dismissible banner when project data changes
    const project = this._projects.find(p => p.id === this._filterProjectId);
    const priorities = project?.priorities || '';
    for (const personaId of ['engineer', 'design', 'product', 'qa']) {
      this._updatePrioritiesPreview(personaId, priorities);
    }
    // Show banner if priorities is empty AND at least one persona has run recently
    const hasPriorities = !!(priorities.trim());
    const anyPersonaRan = PERSONAS.some(({ id }) => this._states[id]?.lastRunAt);
    this._updatePrioritiesBanner(!hasPriorities && anyPersonaRan);

    // DK-134: Update scoped focus UI (chip arrays per project) for all three personas
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderScopedFocus(personaId);
    }
    // DK-134: Update scope summary bar after all persona scopes are rendered
    this._updateScopeSummaryBar();
    // DK-112: Update topic exclusion rule tags when project data changes
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderTopicExclusions(personaId);
    }
    // DK-124: Update advisor pins chip lists when project data changes
    for (const personaId of ['engineer', 'design']) {
      this._renderPins(personaId);
    }
  }

  /** Render/update the YOLO toggle button for the current project. */
  _renderYoloToggle() {
    if (!this._yoloBtn) return;
    const projectId = this._filterProjectId;
    if (!projectId) {
      this._yoloBtn.style.display = 'none';
      return;
    }
    this._yoloBtn.style.display = '';
    const project = this._projects.find(p => p.id === projectId);
    const isOn = !!(project?.yoloMode);
    this._yoloBtn.textContent = isOn ? 'Auto-Accept: ON' : 'Auto-Accept';
    this._yoloBtn.classList.toggle('adv-yolo-on', isOn);
    this._yoloBtn.title = isOn
      ? 'Auto-Accept is ON — new advisor tickets go directly to the backlog without review. Click to turn off.'
      : 'Auto-Accept is OFF — new advisor tickets require review before entering the backlog. Click to turn on.';
  }

  /** Toggle YOLO mode on/off for the current project. */
  async _toggleYoloMode() {
    const projectId = this._filterProjectId;
    if (!projectId || !this._yoloBtn) return;
    const project = this._projects.find(p => p.id === projectId);
    const newMode = !(project?.yoloMode);
    this._yoloBtn.disabled = true;
    try {
      await this.db.collection('projects').doc(projectId).update({
        yoloMode: newMode,
        updatedAt: new Date().toISOString(),
      });
      // onSnapshot on _projects will fire and call _renderYoloToggle automatically

      // When enabling YOLO mode, bulk-accept all existing proposed tickets
      if (newMode) {
        await this._acceptAllProposedTickets(projectId);
      }
    } catch (err) {
      console.error('AdvisorPanel: failed to toggle YOLO mode', err);
    } finally {
      if (this._yoloBtn) this._yoloBtn.disabled = false;
    }
  }

  /** Bulk-transition all proposed tickets in the given project to open. */
  async _acceptAllProposedTickets(projectId) {
    const snap = await this.db
      .collection('projects')
      .doc(projectId)
      .collection('tickets')
      .where('status', '==', 'proposed')
      .get();

    if (snap.empty) return;

    const now = new Date().toISOString();
    // Firestore batches are limited to 500 operations; chunk if needed
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 500) {
      const batch = this.db.batch();
      const chunk = docs.slice(i, i + 500);
      for (const doc of chunk) {
        const data = doc.data();
        const history = data.statusHistory || [];
        history.push({ from: 'proposed', to: 'open', at: now, note: 'Accepted via YOLO mode' });
        batch.update(doc.ref, { status: 'open', statusHistory: history, updatedAt: now });
      }
      await batch.commit();
    }
  }

  // ── Project filter ────────────────────────────────────────────

  /**
   * Set which project to show in the EPD pane.
   * @param {string|null} projectId - null or 'all' means show all projects;
   *   a project ID string means show only that project.
   */
  setProjectFilter(projectId) {
    const newFilter = (projectId === 'all' || projectId == null) ? null : projectId;
    if (this._filterProjectId === newFilter) return;
    this._filterProjectId = newFilter;
    // Clear persona instructions state when project changes
    this._personaInstrDirty = {};
    this._personaInstrLastFetched = {};
    this._personaInstrUseGlobal = {};         // reset scope mode; will re-default on render
    this._personaInstrTabsInitialized = false; // reset tab init flag
    // DK-118: Clear persona toggle debounce timers and status when project changes
    for (const id of Object.keys(this._personaToggleDebounce)) {
      if (this._personaToggleDebounce[id]) {
        clearTimeout(this._personaToggleDebounce[id]);
        this._personaToggleDebounce[id] = null;
      }
    }
    for (const id of Object.keys(this._personaToggleEls)) {
      const refs = this._personaToggleEls[id];
      if (refs) {
        if (refs._undoTimer) clearTimeout(refs._undoTimer);
        refs.undoEl?.classList.add('adv-hidden');
        if (refs.statusEl) {
          refs.statusEl.textContent = '';
          refs.statusEl.className = 'adv-persona-toggle-status';
        }
      }
    }
    // Reset context preset state when project changes
    this._lastAppliedPresetId = null;
    this._contextDirty = false;
    // Reset per-session hint state (DK-120)
    this._contextFocused = false;
    this._contextModifiedThisSession = false;
    // Subscribe to the new project's presets (will be done in _renderContextPanel too,
    // but triggering here ensures it starts promptly on project switch)
    this._subscribePresets(newFilter);
    this._renderProjects(); // also updates context panel via _renderContextPanel()
    // DK-105: Refresh emphasis weights UI to show the new project's stored weights
    for (const key of Object.keys(PERSONA_CONCERNS)) {
      this._updateWeightsUI(key);
    }
    // DK-101: Refresh focus areas UI when project filter changes
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderFocusAreas(personaId);
    }
    // DK-124: Refresh advisor pins UI when project filter changes
    for (const personaId of ['engineer', 'design']) {
      this._renderPins(personaId);
    }
    // DK-134: Refresh scoped focus UI and scope summary bar when project filter changes
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderScopedFocus(personaId);
    }
    this._updateScopeSummaryBar();
    // DK-319: Re-subscribe to directive for each built-in persona under the new project
    for (const persona of PERSONAS) {
      this._subscribeDirective(persona.id, newFilter);
    }
    // Reload feedback stats for all built-in personas when project filter changes
    for (const persona of PERSONAS) {
      this._feedbackStats[persona.id] = null; // invalidate cache
      this._loadFeedbackStats(persona.id);
    }
    // Reload history for all personas so that the run summary line and history
    // panel always reflect only runs for the newly selected project.
    // We reload unconditionally (not just for personas that had history opened)
    // because the run summary line in each card uses history data — if history
    // was never loaded for a persona, the summary would fall back to the global
    // _states[id].lastRunAt which spans all projects, showing cross-project data.
    const allPersonaIds = [
      ...PERSONAS.map(p => p.id),
      ...this._customPersonas.map(p => p.id || p._docId).filter(Boolean),
    ];
    for (const id of allPersonaIds) {
      // Re-query with the new project filter. _loadHistoryRuns immediately sets
      // _historyRuns[id] = null (loading state) before the async query fires,
      // then calls _renderCard once results arrive. We also call _renderCard
      // immediately after so the run summary clears stale cross-project data
      // while the new query is in flight.
      this._loadHistoryRuns(id);
      this._renderCard(id);
    }
  }

  // ── Controls ─────────────────────────────────────────────────

  /** @deprecated — kept for backward compat; new code calls _triggerRun */
  async _runNow(id) {
    await this._triggerRun(id, null);
  }

  /**
   * Toggle the inline run-prompt expander for a persona card (DK-321).
   * Shows or hides the single-line prompt input beneath Run Now.
   * No-ops if the button is aria-disabled.
   */
  _toggleRunPrompt(id) {
    const card = this._cards[id];
    if (!card) return;
    // Honour aria-disabled — do not open if run is blocked
    if (card.runNowBtn.getAttribute('aria-disabled') === 'true') return;

    const expander = card.runPromptExpander;
    if (!expander) {
      // Fallback: no expander (e.g. custom card) — trigger directly
      this._triggerRun(id, null);
      return;
    }
    const isOpen = !expander.classList.contains('adv-hidden');
    if (isOpen) {
      this._closeRunPrompt(id);
    } else {
      expander.classList.remove('adv-hidden');
      card.runNowBtn.setAttribute('aria-expanded', 'true');
      // Clear previous value when reopening
      if (card.runPromptInput) {
        card.runPromptInput.value = '';
        // Pre-fill with active directive if set (spec: "pre-fill with the active directive if one is set")
        const savedFocus = this._states[id]?.savedFocusPrompt || '';
        if (savedFocus) card.runPromptInput.value = savedFocus;
        // Focus input after expand
        setTimeout(() => card.runPromptInput.focus(), 50);
      }
      // DK-367: Clear scope input and hide nudge when expander opens
      if (card.runScopeInput) card.runScopeInput.value = '';
      if (card.runScopeNudge) card.runScopeNudge.classList.add('adv-hidden');
    }
  }

  /**
   * Submit the inline run-prompt expander and trigger a run (DK-321, DK-367).
   * Sanitizes the prompt: strips newlines, enforces 150-char cap.
   * Also reads the optional scope field and passes it to _triggerRun.
   */
  async _submitRunPrompt(id) {
    const card = this._cards[id];
    if (!card) return;
    const rawValue = card.runPromptInput?.value ?? '';
    // Client-side sanitization: strip newlines, enforce 150-char cap (DK-321 spec)
    const sanitizedHint = rawValue
      .replace(/[\r\n\u2028\u2029]/g, ' ')
      .replace(/<\/?system>|<\|/g, '')
      .trim()
      .slice(0, 150) || null;

    // DK-367: Read and sanitize scope text (strip newlines, enforce 500-char cap)
    const rawScope = card.runScopeInput?.value ?? '';
    const sanitizedScope = rawScope
      .replace(/[\r\n\u2028\u2029]/g, ' ')
      .replace(/<\/?system>|<\|/g, '')
      .trim()
      .slice(0, 500) || null;

    // Close the expander immediately (optimistic UI)
    this._closeRunPrompt(id);
    await this._triggerRun(id, sanitizedHint, sanitizedScope);
  }

  /**
   * Close the inline run-prompt expander without triggering a run (DK-321).
   */
  _closeRunPrompt(id) {
    const card = this._cards[id];
    if (!card) return;
    if (card.runPromptExpander) {
      card.runPromptExpander.classList.add('adv-hidden');
    }
    // Clear scope input and hide nudge when expander closes (DK-367)
    if (card.runScopeInput) card.runScopeInput.value = '';
    if (card.runScopeNudge) card.runScopeNudge.classList.add('adv-hidden');
    card.runNowBtn.setAttribute('aria-expanded', 'false');
    // Return focus to the Run Now button
    if (document.activeElement === card.runPromptInput ||
        document.activeElement === card.runPromptSubmitBtn ||
        document.activeElement === card.runPromptCancelBtn ||
        document.activeElement === card.runScopeInput) {
      card.runNowBtn.focus();
    }
  }

  /**
   * Trigger an on-demand run for a persona.
   * Writes the trigger field to /advisor/{id} which the daemon watches.
   * Cooldown is enforced by disabling the button; no confirm modal needed.
   *
   * @param {string} id - Persona ID
   * @param {string|null} sanitizedHint - Optional pre-sanitized focus hint string
   * @param {string|null} scopeText - Optional pre-sanitized scope text (DK-367)
   */
  async _triggerRun(id, sanitizedHint = null, scopeText = null) {
    const card = this._cards[id];
    const data = this._states[id];
    const isPaused = data?.status === 'paused';

    // Guard: refuse if aria-disabled (running / cooldown / pending)
    if (card?.runNowBtn.getAttribute('aria-disabled') === 'true') return;

    // Optimistic UI: mark button disabled immediately so no double-click
    if (card) {
      card.runNowBtn.setAttribute('aria-disabled', 'true');
      card.runNowBtn.style.pointerEvents = 'none';
      card.runNowBtn.style.opacity = '0.5';
    }

    // Start elapsed timer (shows Running... immediately before backend confirmation)
    if (!this._runTimers) this._runTimers = {};
    this._startRunTimer(id);

    try {
      const user = this._currentUser || null;
      const nowIso = new Date().toISOString();
      const triggerData = {
        trigger: {
          requestedAt: nowIso,
          focusPrompt: sanitizedHint,
          // DK-367: scopeText stored alongside the trigger; read by the daemon on next cycle
          scopeText: scopeText || null,
          requestedBy: user?.email || user?.uid || null,
          projectId: this._filterProjectId || null,
          consumed: false,
        },
        // DK-303: runRequestedAt — simpler on-demand run field watched by orchestrator.
        // Cleared by orchestrator after pickup. Both fields are written for compatibility.
        runRequestedAt: nowIso,
        // Clear any prior runRequestedError so UI doesn't show stale error
        runRequestedError: null,
      };
      // If the advisor is paused, unpause it so the run cycle actually executes.
      if (isPaused) triggerData.status = 'idle';
      await this.db.collection('advisor').doc(id).set(triggerData, { merge: true });
    } catch (err) {
      console.error('Failed to trigger run:', err);
      // Re-enable button on error
      if (card) {
        card.runNowBtn.setAttribute('aria-disabled', 'false');
        card.runNowBtn.style.pointerEvents = '';
        card.runNowBtn.style.opacity = '';
      }
      this._stopRunTimer(id);
    }
  }

  /**
   * Save the focus prompt to Firestore so it persists across sessions and is
   * used on the next run (scheduled or on-demand), then cleared automatically.
   *
   * @param {string} id - Persona ID
   * @param {HTMLTextAreaElement} focusTextareaEl - Textarea with focus prompt text
   */
  /**
   * Sanitize a raw focus prompt value (shared by auto-save and manual save paths).
   */
  _sanitizeFocusPrompt(rawFocus) {
    const INJECTION_PHRASES = ['ignore previous instructions', 'you are now', 'disregard', 'new persona', 'system:'];
    let focusPrompt = (rawFocus || '').trim().slice(0, 256);
    for (const phrase of INJECTION_PHRASES) {
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      focusPrompt = focusPrompt.replace(re, '');
    }
    focusPrompt = focusPrompt.replace(/<\/?system>|<\|/g, '').trim();
    return focusPrompt.length > 0 ? focusPrompt : null;
  }

  /**
   * Persist the sanitized focus prompt value to Firestore and update toggle button/preview.
   * Called by both auto-save (debounce) and manual save paths.
   */
  async _persistFocusPrompt(id, sanitizedFocus) {
    const focusProjectId = this._filterProjectId;
    if (focusProjectId) {
      await this.db.collection('projects').doc(focusProjectId).update({
        [`advisorSettings.${id}.savedFocusPrompt`]: sanitizedFocus,
        updatedAt: new Date().toISOString(),
      });
    } else {
      await this.db.collection('advisor').doc(id).set(
        { savedFocusPrompt: sanitizedFocus },
        { merge: true }
      );
    }
    // Update the toggle button and inline preview to reflect the newly saved value
    const card = this._cards[id];
    if (card?.focusToggleBtn) {
      const savedPreview = sanitizedFocus || '';
      card.focusToggleBtn.dataset.savedFocus = savedPreview;
      // Only update button label if area is currently collapsed (don't disturb open state)
      const focusAreaEl = document.getElementById(`adv-focus-area-${id}`);
      const isOpen = focusAreaEl?.classList.contains('adv-focus-area-open');
      if (!isOpen) {
        card.focusToggleBtn.textContent = savedPreview ? 'Focus● ▸' : 'Focus ▸';
        card.focusToggleBtn.title = savedPreview
          ? `Saved focus active: "${savedPreview}"`
          : 'Set a focus area for the next run';
      } else {
        // Area is open — update the toggle dot indicator only
        card.focusToggleBtn.textContent = savedPreview ? 'Focus● ▾' : 'Focus ▾';
      }
      // Update inline preview (shown when collapsed)
      if (card.focusPreviewEl) {
        if (savedPreview) {
          const maxLen = 40;
          const preview = savedPreview.length > maxLen ? savedPreview.slice(0, maxLen) + '…' : savedPreview;
          card.focusPreviewEl.textContent = preview;
          card.focusPreviewEl.title = savedPreview;
          card.focusPreviewEl.className = 'adv-focus-preview';
        } else {
          card.focusPreviewEl.textContent = '';
          card.focusPreviewEl.className = 'adv-focus-preview adv-hidden';
        }
      }
    }
  }

  /**
   * Auto-save path (called from debounce/blur via save-on-blur control).
   * Saves to Firestore but does NOT clear the textarea or collapse the focus area.
   * The value parameter is the raw string value from the textarea.
   */
  async _autoSaveFocusPrompt(id, rawValue) {
    const sanitizedFocus = this._sanitizeFocusPrompt(rawValue);
    await this._persistFocusPrompt(id, sanitizedFocus);
  }

  /**
   * @deprecated — kept for reference; auto-save now handles all persistence.
   * Original manual-save path: sanitize → persist → clear textarea → collapse area.
   */
  async _saveFocusPrompt(id, focusTextareaEl) {
    const card = this._cards[id];
    const sanitizedFocus = this._sanitizeFocusPrompt(focusTextareaEl?.value);
    if (card?.saveFocusBtn) {
      card.saveFocusBtn.disabled = true;
    }
    try {
      await this._persistFocusPrompt(id, sanitizedFocus);
      // Clear the textarea after saving so the user knows the save was captured
      if (focusTextareaEl) focusTextareaEl.value = '';
      // Update the character counter display to reflect the cleared textarea
      const counterEl = focusTextareaEl?.closest?.('.adv-focus-area')
        ?.querySelector?.('.adv-focus-counter');
      if (counterEl) {
        counterEl.textContent = '0 / 256';
        counterEl.className = 'adv-focus-counter';
      }
      // Auto-collapse the focus area after saving — the focus is now "configured".
      if (this._focusManuallyToggled) delete this._focusManuallyToggled[id];
      const focusAreaEl = document.getElementById(`adv-focus-area-${id}`);
      if (focusAreaEl && card?.focusToggleBtn) {
        focusAreaEl.classList.remove('adv-focus-area-open');
        card.focusToggleBtn.setAttribute('aria-expanded', 'false');
        const savedPreview = sanitizedFocus || '';
        card.focusToggleBtn.textContent = savedPreview ? 'Focus● ▸' : 'Focus ▸';
        card.focusToggleBtn.title = savedPreview
          ? `Saved focus active: "${savedPreview}"`
          : 'Set a focus area for the next run';
      }
    } catch (err) {
      console.error('Failed to save focus prompt:', err);
    } finally {
      if (card?.saveFocusBtn) {
        card.saveFocusBtn.disabled = false;
      }
    }
  }

  // ── Focus Directive (DK-319) ─────────────────────────────────

  /**
   * Open the inline directive edit mode for a persona card.
   * Pre-fills the input with the current directive value if one is set.
   *
   * @param {string} id - Persona ID
   */
  _openDirectiveEdit(id) {
    const els = this._directiveEls[id];
    if (!els) return;
    this._directiveEditing[id] = true;
    // Pre-fill input with current directive value
    const data = this._directiveData[id];
    const current = (typeof data?.directive === 'string') ? data.directive : '';
    els.inputEl.value = current;
    const len = current.length;
    els.counterEl.textContent = `${len} / 500`;
    els.counterEl.className = 'adv-directive-counter' + (len > 480 ? ' adv-directive-counter-warn' : '');
    // Show edit row, hide display row
    els.editRow.classList.remove('adv-hidden');
    els.displayRow.classList.add('adv-hidden');
    // Focus the input
    setTimeout(() => els.inputEl.focus(), 50);
  }

  /**
   * Cancel directive edit mode without saving.
   * Hides the edit row and restores the display row.
   *
   * @param {string} id - Persona ID
   */
  _cancelDirectiveEdit(id) {
    const els = this._directiveEls[id];
    if (!els) return;
    this._directiveEditing[id] = false;
    els.editRow.classList.add('adv-hidden');
    els.displayRow.classList.remove('adv-hidden');
    // Return focus to the edit button
    els.editBtn.focus();
  }

  /**
   * Save the focus directive to Firestore.
   * Stored at: advisor/{personaId}/projects/{projectId}/directive + directiveUpdatedAt.
   * Passing empty string clears the directive (returns persona to freeform).
   * Sanitizes client-side: strip backticks and XML-style tags, enforce 500-char cap.
   * On success, briefly shows an inline "Saved" label next to the field (aria-live="polite").
   * On failure, shows an inline error.
   *
   * @param {string} id - Persona ID
   * @param {string} rawValue - Raw input value
   */
  async _saveDirective(id, rawValue) {
    // Guard: if blur fired after we already closed (e.g. Save btn click → blur), skip
    if (!this._directiveEditing[id]) return;

    const els = this._directiveEls[id];
    const projectId = this._filterProjectId;
    if (!projectId) {
      // Directives require a project context — cannot save without a selected project
      this._cancelDirectiveEdit(id);
      return;
    }

    // Client-side sanitization matching server-side rules (DK-039 spec)
    const sanitized = (rawValue || '')
      .replace(/`/g, '')                       // strip backticks
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')      // strip XML-style tags
      .replace(/[\r\n\u2028\u2029]/g, ' ')     // collapse newlines
      .trim()
      .slice(0, 500) || null;

    // Close edit mode immediately (optimistic UI)
    this._directiveEditing[id] = false;
    if (els) {
      els.editRow.classList.add('adv-hidden');
      els.displayRow.classList.remove('adv-hidden');
    }

    this._directiveSaving[id] = true;
    let saveSuccess = false;
    try {
      const docRef = this.db
        .collection('advisor')
        .doc(id)
        .collection('projects')
        .doc(projectId);

      await docRef.set({
        directive: sanitized,
        directiveUpdatedAt: new Date(),
      }, { merge: true });
      saveSuccess = true;
    } catch (err) {
      console.error('Failed to save directive:', err);
      // Show inline error — transient, clears after 4s
      if (els?.saveStatusEl) {
        els.saveStatusEl.textContent = 'Error saving — try again';
        els.saveStatusEl.className = 'adv-directive-save-status adv-directive-save-error';
        if (this._directiveSaveStatusTimer?.[id]) clearTimeout(this._directiveSaveStatusTimer[id]);
        if (!this._directiveSaveStatusTimer) this._directiveSaveStatusTimer = {};
        this._directiveSaveStatusTimer[id] = setTimeout(() => {
          if (els?.saveStatusEl) {
            els.saveStatusEl.textContent = '';
            els.saveStatusEl.className = 'adv-directive-save-status';
          }
        }, 4000);
      }
    } finally {
      this._directiveSaving[id] = false;
    }

    // Show inline "Saved" confirmation — transient, clears after 2.5s
    if (saveSuccess && els?.saveStatusEl) {
      els.saveStatusEl.textContent = 'Saved';
      els.saveStatusEl.className = 'adv-directive-save-status adv-directive-save-ok';
      if (!this._directiveSaveStatusTimer) this._directiveSaveStatusTimer = {};
      if (this._directiveSaveStatusTimer[id]) clearTimeout(this._directiveSaveStatusTimer[id]);
      this._directiveSaveStatusTimer[id] = setTimeout(() => {
        if (els?.saveStatusEl) {
          els.saveStatusEl.textContent = '';
          els.saveStatusEl.className = 'adv-directive-save-status';
        }
      }, 2500);
    }
  }

  /**
   * Subscribe to the focus directive for the focused project.
   * Stores unsubscribe fn in _directiveUnsubs[id].
   * Updates _directiveData[id] and calls _renderDirective().
   *
   * @param {string} id - Persona ID
   * @param {string} projectId - Firestore project doc ID
   */
  _subscribeDirective(id, projectId) {
    // Unsubscribe any existing listener
    if (this._directiveUnsubs[id]) {
      this._directiveUnsubs[id]();
      this._directiveUnsubs[id] = null;
    }
    if (!projectId) {
      this._directiveData[id] = null;
      this._renderDirective(id);
      return;
    }
    const unsub = this.db
      .collection('advisor')
      .doc(id)
      .collection('projects')
      .doc(projectId)
      .onSnapshot((snap) => {
        this._directiveData[id] = snap.exists ? snap.data() : null;
        this._renderDirective(id);
      }, () => {
        this._directiveData[id] = null;
        this._renderDirective(id);
      });
    this._directiveUnsubs[id] = unsub;
  }

  /**
   * Render the directive section for a persona card based on current data.
   * Updates badge, display text, timestamp, staleness nudge, and next-run indicator.
   *
   * @param {string} id - Persona ID
   */
  _renderDirective(id) {
    const els = this._directiveEls[id];
    if (!els) return;

    const data = this._directiveData[id];
    const directive = (typeof data?.directive === 'string' && data.directive.trim())
      ? data.directive.trim()
      : null;

    // Update active / empty badge
    if (directive) {
      els.badgeEl.textContent = 'Focused';
      els.badgeEl.className = 'adv-directive-badge adv-directive-badge-focused';
      els.badgeEl.setAttribute('aria-label', 'Directive status: Focused');
    } else {
      els.badgeEl.textContent = 'Freeform';
      els.badgeEl.className = 'adv-directive-badge adv-directive-badge-freeform';
      els.badgeEl.setAttribute('aria-label', 'Directive status: Freeform');
    }

    // Update display text — plain text, truncated for display
    if (els.displayText) {
      if (directive) {
        const max = 60;
        els.displayText.textContent = directive.length > max ? directive.slice(0, max) + '…' : directive;
        els.displayText.title = directive;
      } else {
        els.displayText.textContent = '';
        els.displayText.title = '';
      }
    }

    // Update timestamp and staleness nudge
    const updatedAt = data?.directiveUpdatedAt;
    if (directive && updatedAt) {
      const updatedMs = updatedAt.toDate ? updatedAt.toDate().getTime() : new Date(updatedAt).getTime();
      if (!isNaN(updatedMs)) {
        const ageDays = Math.floor((Date.now() - updatedMs) / (1000 * 60 * 60 * 24));
        const ageText = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`;
        els.timestampEl.textContent = `Focus set ${ageText}`;
        els.timestampEl.className = 'adv-directive-ts';

        // Staleness nudge: 14+ days old
        if (ageDays >= 14) {
          els.stalenessEl.className = 'adv-directive-stale';
        } else {
          els.stalenessEl.className = 'adv-directive-stale adv-hidden';
        }
      } else {
        els.timestampEl.className = 'adv-directive-ts adv-hidden';
        els.stalenessEl.className = 'adv-directive-stale adv-hidden';
      }
    } else {
      els.timestampEl.className = 'adv-directive-ts adv-hidden';
      els.stalenessEl.className = 'adv-directive-stale adv-hidden';
    }

    // Update next-run indicator using current persona state
    const state = this._states[id];
    const focusedProjectId = this._filterProjectId;
    const perProjectSettings = focusedProjectId
      ? (this._projects.find(p => p.id === focusedProjectId)?.advisorSettings?.[id] ?? null)
      : null;
    const intervalHours = perProjectSettings?.intervalHours !== undefined
      ? perProjectSettings.intervalHours
      : state?.intervalHours;
    const intervalMinutes = perProjectSettings?.intervalMinutes !== undefined
      ? perProjectSettings.intervalMinutes
      : state?.intervalMinutes;
    const lastRunAt = state?.lastRunAt;
    const cd = computeNextRunCountdown(lastRunAt, intervalHours, intervalMinutes);
    if (cd && state?.status !== 'running') {
      els.nextRunEl.textContent = `next run ${cd}`;
      els.nextRunEl.className = 'adv-directive-next-run';
    } else if (state?.status === 'running') {
      els.nextRunEl.textContent = 'running…';
      els.nextRunEl.className = 'adv-directive-next-run';
    } else {
      els.nextRunEl.textContent = '';
      els.nextRunEl.className = 'adv-directive-next-run adv-hidden';
    }

    // Show section only when a project is selected (directives require project context)
    els.sectionEl.classList.toggle('adv-hidden', !focusedProjectId);
  }

  /**
   * Start a per-card elapsed timer for running state display (DK-321).
   * Updates runStateEl every second with "Running... Xs" label.
   * Shows the "Tickets will appear in the board when complete" hint.
   * Respects prefers-reduced-motion — falls back to static text, no pulse.
   */
  _startRunTimer(id) {
    this._stopRunTimer(id);
    if (!this._runTimers) this._runTimers = {};
    const startMs = Date.now();
    const card = this._cards[id];
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const tick = () => {
      if (!card || !this._runTimers?.[id]) return;
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      if (card.runStateEl) {
        // "Running..." text label (not color alone — spec requirement)
        // Reduced-motion: static "Running" (no animated pulse ellipsis)
        const label = reducedMotion ? `Running ${elapsed}s` : `Running… ${elapsed}s`;
        card.runStateEl.textContent = label;
        card.runStateEl.className = 'adv-run-state adv-run-state-running' + (reducedMotion ? ' adv-run-state-reduced-motion' : '');
        card.runStateEl.title = '';
        card.runStateEl.removeAttribute('aria-label');
      }
      // "Tickets will appear in the board when complete" — spec expectation-setting text
      if (card.timeHintEl) {
        card.timeHintEl.textContent = 'Tickets will appear in the board when complete';
        card.timeHintEl.className = 'adv-run-time-hint adv-run-time-hint-visible';
      }
    };
    tick();
    this._runTimers[id] = setInterval(tick, 1000);
  }

  /** Stop the per-card elapsed timer for a persona. */
  _stopRunTimer(id) {
    if (this._runTimers?.[id]) {
      clearInterval(this._runTimers[id]);
      delete this._runTimers[id];
    }
  }

  // ── Dry-run / Preview Run ────────────────────────────────────────────────

  /**
   * Start a dry-run for a persona. Writes a request doc to /advisor-dry-runs
   * and subscribes to it with onSnapshot to receive results.
   */
  async _startDryRun(id, label) {
    const user = this._currentUser;
    if (!user) {
      alert('You must be signed in to use Preview Run.');
      return;
    }

    const panels = this._dryRunPanels[id];
    if (!panels) return;

    // Warn about unsaved config changes (can't detect them easily without diff —
    // surface a general hint instead)
    const { panel, statusBar, proposalList, heading, promoteAllBtn, previewRunBtn } = panels;

    // Disable button during run
    previewRunBtn.disabled = true;

    // Show panel and set initial status
    panel.classList.remove('adv-hidden');
    proposalList.innerHTML = '';
    promoteAllBtn.classList.add('adv-hidden');
    this._setDryRunStatus(id, `Running ${label} persona preview…`);

    // Move keyboard focus to panel heading
    setTimeout(() => heading.focus(), 50);

    // Cancel any previous subscription for this persona
    this._cancelDryRunSubscription(id);

    try {
      // Write request doc to Firestore
      // Use firebase global (compat SDK) for FieldValue.serverTimestamp()
      const _firebase = window.firebase;
      const _serverTimestamp = _firebase?.firestore?.FieldValue?.serverTimestamp
        ? _firebase.firestore.FieldValue.serverTimestamp()
        : new Date();

      const docRef = await this.db.collection('advisor-dry-runs').add({
        personaId: id,
        userId: user.uid,
        projectId: this._filterProjectId || null,
        status: 'pending',
        createdAt: _serverTimestamp,
      });
      this._dryRunDocIds[id] = docRef.id;

      // Subscribe to doc for results
      const unsub = docRef.onSnapshot((snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        this._onDryRunUpdate(id, label, data);
      }, (err) => {
        console.error(`AdvisorPanel: dry-run listener error for ${id}:`, err);
        this._setDryRunStatus(id, `Run failed — ${err.message}`);
        if (panels.previewRunBtn) panels.previewRunBtn.disabled = false;
      });
      this._dryRunUnsubs[id] = unsub;

    } catch (err) {
      console.error('AdvisorPanel: failed to start dry run:', err);
      this._setDryRunStatus(id, `Run failed — ${err.message}`);
      previewRunBtn.disabled = false;
    }
  }

  /** Handle a snapshot update on a dry-run doc. */
  _onDryRunUpdate(id, label, data) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    const { statusBar, proposalList, promoteAllBtn, previewRunBtn } = panels;

    const { status, proposals, error, statusMessage } = data;

    if (status === 'running') {
      const msg = statusMessage
        ? `Running ${label} persona… ${statusMessage}`
        : `Running ${label} persona…`;
      this._setDryRunStatus(id, msg);
      return;
    }

    if (status === 'error') {
      this._setDryRunStatus(id, `Run failed — ${error || 'unknown error'}`);
      if (previewRunBtn) previewRunBtn.disabled = false;
      this._cancelDryRunSubscription(id);
      return;
    }

    if (status === 'done') {
      const allProposals = Array.isArray(proposals) ? proposals : [];
      const realCount  = allProposals.filter(p => !p.deduped).length;
      const dedupCount = allProposals.filter(p => p.deduped).length;
      let statusMsg = `Preview ready — ${realCount} proposal${realCount !== 1 ? 's' : ''} found.`;
      if (dedupCount > 0) statusMsg += ` (${dedupCount} would be deduped)`;
      this._setDryRunStatus(id, statusMsg);

      this._dryRunProposals[id] = allProposals;
      this._renderDryRunProposals(id, label, allProposals);

      if (realCount > 1) {
        promoteAllBtn.classList.remove('adv-hidden');
        promoteAllBtn.textContent = `Promote all (${realCount})`;
        promoteAllBtn.setAttribute('aria-label', `Promote all ${realCount} proposals to real tickets`);
      } else {
        promoteAllBtn.classList.add('adv-hidden');
      }

      if (previewRunBtn) previewRunBtn.disabled = false;
      this._cancelDryRunSubscription(id);
    }
  }

  /** Render proposal cards in the dry-run panel. */
  _renderDryRunProposals(id, label, proposals) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    const { proposalList } = panels;
    proposalList.innerHTML = '';

    // Reset suppressed count before re-render (DK-366)
    this._suppressedCount = 0;
    this._updateSuppressedCountEl();

    if (!proposals || proposals.length === 0) {
      proposalList.appendChild(
        el('div', { className: 'adv-dry-run-empty' },
          'No proposals — the persona found no new issues to report with current settings.'
        )
      );
      return;
    }

    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      const card = this._buildProposalCard(id, label, p, i);
      proposalList.appendChild(card);
    }

    // After render: if suppression is on and all proposals were suppressed, show indicator
    if (this._suppressDuplicates && this._suppressedCount === proposals.length) {
      proposalList.appendChild(
        el('div', { className: 'adv-dry-run-empty' },
          `All ${proposals.length} proposal${proposals.length !== 1 ? 's' : ''} suppressed as likely duplicates. Turn off suppression in the Backlog Check section to view them.`
        )
      );
    }
  }

  /**
   * Build a single proposal card element.
   * Enhanced with backlog dedup flagging (DK-366):
   *   - Checks PM's pasted backlog for similarity matches
   *   - Shows inline collapsed chip: "Possible duplicate — matched title"
   *   - Expands to stacked comparison view with similarity score
   *   - Three resolution actions for flagged cards
   *   - Suppression: if suppression mode is on, suppressed cards are hidden
   */
  _buildProposalCard(personaId, personaLabel, proposal, index) {
    const isDeduped = !!proposal.deduped;
    const title = String(proposal.title || '(untitled)').slice(0, 200);
    const description = String(proposal.description || '').slice(0, 3000);
    const type = String(proposal.type || 'bug');
    const reasoningSummary = proposal.reasoning_summary ? String(proposal.reasoning_summary).slice(0, 400) : null;
    const filterReason = proposal.filterReason ? String(proposal.filterReason) : null;
    // DK-188: Confidence score from the persona's self-rating (integer 1–10, or null if not available)
    const confidenceScore = (Number.isInteger(proposal.confidenceScore) && proposal.confidenceScore >= 1 && proposal.confidenceScore <= 10)
      ? proposal.confidenceScore : null;

    // Check PM's backlog for similarity match (DK-366)
    const backlogMatch = !isDeduped ? this._checkBacklogMatch(title) : { isMatch: false };
    const isFlaggedByBacklog = backlogMatch.isMatch;

    // Suppression mode: if active and this idea matches backlog, suppress it
    if (isFlaggedByBacklog && this._suppressDuplicates) {
      this._suppressedCount++;
      this._updateSuppressedCountEl();
      // Return empty element (card is suppressed — not shown)
      const suppressed = el('div', { className: 'adv-hidden', 'aria-hidden': 'true' });
      return suppressed;
    }

    const card = el('div', {
      className: [
        'adv-preview-card',
        isDeduped ? 'adv-preview-card-deduped' : '',
        isFlaggedByBacklog ? 'adv-preview-card-backlog-flagged' : '',
      ].filter(Boolean).join(' '),
      role: 'article',
      'aria-label': isFlaggedByBacklog
        ? `Possible duplicate flagged: ${title}`
        : `Proposal: ${title}`,
    });

    // Preview badge row (always shown for accessibility distinction)
    // All flagged cards must include a visible text label/icon (not color-alone)
    const badgeRow = el('div', { className: 'adv-preview-badge-row' },
      el('span', { className: 'adv-preview-badge' }, 'Preview'),
      el('span', { className: 'adv-preview-type-badge' }, type),
      isDeduped
        ? el('span', {
            className: 'adv-preview-dedup-badge',
            'aria-label': filterReason === 'duplicate' ? 'Duplicate flagged' :
              filterReason === 'low_confidence' ? 'Below confidence threshold' : 'Rejection match flagged',
          }, filterReason === 'duplicate' ? 'Would be deduped' :
             filterReason === 'low_confidence' ? `Filtered — low confidence (${proposal.confidenceScore ?? 0}/10)` :
             'Rejection match')
        : null,
      // DK-188: Confidence badge — only shown for proposals that made it through
      // Pair score with text label (not color alone) as per a11y spec.
      confidenceScore !== null && !isDeduped
        ? el('span', {
            className: 'adv-preview-confidence-badge',
            title: 'Self-rated by the persona. Use as a soft signal, not a quality certificate.',
            'aria-label': `Confidence: ${confidenceScore} of 10. Self-rated by the persona — use as a soft signal.`,
          }, `Confidence: ${confidenceScore}/10`)
        : null,
      isFlaggedByBacklog
        ? el('span', {
            className: 'adv-preview-backlog-flag-badge',
            'aria-label': 'Duplicate flagged',
          }, '⧉ Duplicate flagged')
        : null,
    );
    card.appendChild(badgeRow);

    // Title (uses textContent — AI output is untrusted)
    const titleEl = el('h4', { className: 'adv-preview-card-title' });
    titleEl.textContent = title;
    card.appendChild(titleEl);

    // ── Backlog flag inline chip (DK-366) ─────────────────────
    // Shows collapsed chip that expands into stacked comparison view.
    // Accessible: text label not color-only. ARIA live region on resolution.
    if (isFlaggedByBacklog) {
      const matchTitle = backlogMatch.matchTitle || '';
      const scoreLabel = backlogMatch.scoreLabel || '';
      const flagId = `adv-backlog-flag-${index}`;
      const comparisonId = `adv-backlog-comparison-${index}`;

      let comparisonExpanded = false;

      // Collapsed chip (default state)
      const flagChip = el('button', {
        className: 'adv-backlog-flag-chip',
        'aria-expanded': 'false',
        'aria-controls': comparisonId,
        id: flagId,
        title: 'Click to see comparison with matched backlog item',
      });
      // Use textContent — matched title is PM-entered text (treated as untrusted display input)
      const chipText = el('span', { className: 'adv-backlog-flag-chip-text' });
      chipText.textContent = `Possible duplicate — ${matchTitle.slice(0, 60)}${matchTitle.length > 60 ? '…' : ''}`;
      const chipScore = el('span', { className: 'adv-backlog-flag-chip-score' });
      chipScore.textContent = scoreLabel;

      flagChip.appendChild(el('span', { className: 'adv-backlog-flag-chip-icon', 'aria-hidden': 'true' }, '⧉'));
      flagChip.appendChild(chipText);
      flagChip.appendChild(chipScore);

      // Stacked comparison view (collapsed by default, expands on chip click)
      // Stack layout: idea above, matched ticket below — not two-column
      // (reflows at 200% zoom and viewports below 1024px)
      const comparison = el('div', {
        className: 'adv-backlog-comparison adv-hidden',
        id: comparisonId,
        role: 'region',
        'aria-label': 'Comparison with matched backlog item',
        'aria-labelledby': flagId,
      });

      const ideaPane = el('div', { className: 'adv-backlog-comparison-pane adv-backlog-comparison-idea' });
      const ideaPaneLabel = el('div', { className: 'adv-backlog-comparison-pane-label' }, 'Generated idea:');
      const ideaPaneText = el('div', { className: 'adv-backlog-comparison-pane-text' });
      ideaPaneText.textContent = title;
      ideaPane.appendChild(ideaPaneLabel);
      ideaPane.appendChild(ideaPaneText);

      const matchPane = el('div', { className: 'adv-backlog-comparison-pane adv-backlog-comparison-match' });
      const matchPaneLabel = el('div', { className: 'adv-backlog-comparison-pane-label' },
        `Matched backlog item (${scoreLabel}):`
      );
      const matchPaneText = el('div', { className: 'adv-backlog-comparison-pane-text' });
      matchPaneText.textContent = matchTitle; // PM-entered text — textContent safe
      matchPane.appendChild(matchPaneLabel);
      matchPane.appendChild(matchPaneText);

      comparison.appendChild(ideaPane);
      comparison.appendChild(matchPane);

      flagChip.addEventListener('click', () => {
        comparisonExpanded = !comparisonExpanded;
        if (comparisonExpanded) {
          comparison.classList.remove('adv-hidden');
          flagChip.setAttribute('aria-expanded', 'true');
        } else {
          comparison.classList.add('adv-hidden');
          flagChip.setAttribute('aria-expanded', 'false');
        }
      });

      card.appendChild(flagChip);
      card.appendChild(comparison);

      // ── Three resolution actions (DK-366) ───────────────────
      // Each action must have a unique accessible label that includes the idea title.
      // All buttons are keyboard-reachable with visible focus states (CSS handles focus).
      // State change is announced via ARIA live region.
      const resolutionSection = el('div', {
        className: 'adv-backlog-resolution',
        role: 'group',
        'aria-label': `Resolve duplicate flag for: ${title}`,
      });

      const resolveHeader = el('div', { className: 'adv-backlog-resolution-header' }, 'Resolve flag:');

      // Action 1: Already captured — confirm as duplicate, suppress idea, log it
      const alreadyCapturedBtn = el('button', {
        className: 'adv-backlog-resolution-btn adv-backlog-resolution-btn-captured',
        'aria-label': `Already captured — mark as duplicate: ${title}`,
        onClick: () => {
          this._resolveBacklogFlag(card, {
            action: 'already_captured',
            ideaTitle: title,
            matchedTitle: matchTitle,
            note: '',
            announcement: `Marked as already captured: ${title}`,
          });
        },
      }, 'Already captured');

      // Action 2: Keep — different angle — dismiss the flag, retain the idea
      const keepDifferentBtn = el('button', {
        className: 'adv-backlog-resolution-btn adv-backlog-resolution-btn-keep',
        'aria-label': `Keep idea — different angle: ${title}`,
        onClick: () => {
          this._resolveBacklogFlag(card, {
            action: 'keep_different',
            ideaTitle: title,
            matchedTitle: matchTitle,
            note: '',
            announcement: `Flag dismissed — kept as different angle: ${title}`,
            removeFlagOnly: true,
          });
        },
      }, 'Keep — different angle');

      // Action 3: Reject entirely — remove + log with optional note
      const rejectEntirelyBtn = el('button', {
        className: 'adv-backlog-resolution-btn adv-backlog-resolution-btn-reject',
        'aria-label': `Reject entirely: ${title}`,
        onClick: () => {
          this._openRejectNoteDialog(card, title, matchTitle);
        },
      }, 'Reject entirely');

      resolutionSection.appendChild(resolveHeader);
      resolutionSection.appendChild(alreadyCapturedBtn);
      resolutionSection.appendChild(keepDifferentBtn);
      resolutionSection.appendChild(rejectEntirelyBtn);

      card.appendChild(resolutionSection);
    }

    // Description (truncated with expand)
    const descPre = el('div', { className: 'adv-preview-card-desc adv-preview-card-desc-collapsed' });
    descPre.textContent = description;
    card.appendChild(descPre);

    // Toggle expand/collapse for description
    if (description.length > 300) {
      const expandBtn = el('button', {
        className: 'adv-preview-expand-btn',
        onClick: () => {
          const collapsed = descPre.classList.toggle('adv-preview-card-desc-collapsed');
          expandBtn.textContent = collapsed ? 'Show more' : 'Show less';
        },
      }, 'Show more');
      card.appendChild(expandBtn);
    }

    // Reasoning summary
    if (reasoningSummary) {
      const reasoningEl = el('div', { className: 'adv-preview-reasoning' });
      reasoningEl.textContent = `Why: ${reasoningSummary}`;
      card.appendChild(reasoningEl);
    }

    // Actions row (only for non-deduped proposals)
    if (!isDeduped) {
      const promoteBtn = el('button', {
        className: 'adv-preview-promote-btn',
        // Accessible name includes proposal title per spec
        'aria-label': `Promote: ${title}`,
        onClick: () => this._promoteDryRunProposal(personaId, index, title),
      }, 'Promote');

      const dismissBtn = el('button', {
        className: 'adv-preview-dismiss-btn',
        'aria-label': `Dismiss: ${title}`,
        onClick: () => this._dismissProposalCard(card),
      }, 'Dismiss');

      card.appendChild(
        el('div', { className: 'adv-preview-actions' },
          promoteBtn,
          dismissBtn,
        )
      );
    } else {
      // Deduped: show info note only
      card.appendChild(
        el('div', { className: 'adv-preview-dedup-note' },
          proposal.dedupMatchId
            ? `This proposal would be filtered — it duplicates an existing ticket.`
            : `This proposal would be filtered before reaching your board.`,
        )
      );
    }

    return card;
  }

  /**
   * Resolve a backlog flag with one of the three actions.
   * Announces the resolution via ARIA live region (DK-366).
   *
   * @param {HTMLElement} cardEl - The proposal card element
   * @param {{ action, ideaTitle, matchedTitle, note, announcement, removeFlagOnly? }} opts
   */
  _resolveBacklogFlag(cardEl, opts) {
    const { action, ideaTitle, matchedTitle, note, announcement, removeFlagOnly } = opts;

    // Log to rejection log (all actions including "keep" are logged for transparency)
    this._addToRejectionLog({ ideaTitle, matchedTitle, note, action });

    // Announce state change to screen readers
    this._announceToSR(announcement || `Flag resolved: ${ideaTitle}`);

    if (removeFlagOnly) {
      // "Keep — different angle": just remove the flag UI from the card
      cardEl.classList.remove('adv-preview-card-backlog-flagged');
      const flagChip = cardEl.querySelector('.adv-backlog-flag-chip');
      const comparison = cardEl.querySelector('.adv-backlog-comparison');
      const resolutionSection = cardEl.querySelector('.adv-backlog-resolution');
      if (flagChip) flagChip.remove();
      if (comparison) comparison.remove();
      if (resolutionSection) resolutionSection.remove();

      // Also remove the flag badge from the badge row
      const flagBadge = cardEl.querySelector('.adv-preview-backlog-flag-badge');
      if (flagBadge) flagBadge.remove();
    } else {
      // "Already captured" or "Reject entirely": remove the entire card
      cardEl.classList.add('adv-preview-card-dismissed');
      setTimeout(() => cardEl.remove(), 300);
    }
  }

  /**
   * Open a dialog for the "Reject entirely" action that collects an optional note.
   * Inline within the card (not a modal) for accessibility and keyboard flow.
   *
   * @param {HTMLElement} cardEl
   * @param {string} ideaTitle
   * @param {string} matchedTitle
   */
  _openRejectNoteDialog(cardEl, ideaTitle, matchedTitle) {
    // Remove any existing reject note dialog on this card
    const existing = cardEl.querySelector('.adv-backlog-reject-dialog');
    if (existing) { existing.remove(); return; }

    const dialog = el('div', {
      className: 'adv-backlog-reject-dialog',
      role: 'group',
      'aria-label': `Add note before rejecting: ${ideaTitle}`,
    });

    const noteLabel = el('label', {
      className: 'adv-backlog-reject-note-label',
      htmlFor: `adv-reject-note-${ideaTitle.slice(0, 20).replace(/\s/g, '-')}`,
    }, 'Note (optional — e.g. "Rejected for Q2"):');

    const noteInput = el('input', {
      type: 'text',
      className: 'adv-backlog-reject-note-input',
      id: `adv-reject-note-${ideaTitle.slice(0, 20).replace(/\s/g, '-')}`,
      placeholder: 'e.g. Rejected for Q2 — revisit if scope expands',
      maxlength: '500',
      'aria-label': `Rejection note for: ${ideaTitle}`,
    });

    const confirmRejectBtn = el('button', {
      className: 'adv-backlog-reject-confirm-btn',
      'aria-label': `Confirm reject: ${ideaTitle}`,
      onClick: () => {
        const note = noteInput.value.trim();
        this._resolveBacklogFlag(cardEl, {
          action: 'reject_entirely',
          ideaTitle,
          matchedTitle,
          note,
          announcement: `Rejected: ${ideaTitle}${note ? ` — ${note}` : ''}`,
        });
      },
    }, 'Confirm reject');

    const cancelBtn = el('button', {
      className: 'adv-backlog-reject-cancel-btn',
      'aria-label': `Cancel reject: ${ideaTitle}`,
      onClick: () => dialog.remove(),
    }, 'Cancel');

    dialog.appendChild(noteLabel);
    dialog.appendChild(noteInput);
    dialog.appendChild(el('div', { className: 'adv-backlog-reject-dialog-btns' }, confirmRejectBtn, cancelBtn));

    // Insert after the resolution section
    const resolutionSection = cardEl.querySelector('.adv-backlog-resolution');
    if (resolutionSection) {
      resolutionSection.after(dialog);
    } else {
      cardEl.appendChild(dialog);
    }

    // Focus the note input
    setTimeout(() => noteInput.focus(), 50);
  }

  /** Promote a single dry-run proposal to a real ticket. */
  async _promoteDryRunProposal(personaId, proposalIndex, title) {
    const proposals = this._dryRunProposals[personaId];
    if (!proposals || proposalIndex >= proposals.length) return;
    const proposal = proposals[proposalIndex];
    if (!proposal) return;

    // Single confirmation step per spec
    const confirmed = await showConfirmModal({
      title: 'Promote proposal?',
      message: `This will create 1 proposal in your board: "${String(proposal.title || '').slice(0, 80)}"`,
      confirm: 'Create ticket',
      danger: false,
    });
    if (!confirmed) return;

    await this._writeProposalToFirestore(personaId, [proposal]);
  }

  /** Promote all non-deduped dry-run proposals. */
  async _promoteAllDryRunProposals(personaId, personaLabel) {
    const proposals = (this._dryRunProposals[personaId] || []).filter(p => !p.deduped);
    if (proposals.length === 0) return;

    const confirmed = await showConfirmModal({
      title: `Promote all ${personaLabel} proposals?`,
      message: `This will create ${proposals.length} proposal${proposals.length !== 1 ? 's' : ''} in your board.`,
      confirm: `Create ${proposals.length} ticket${proposals.length !== 1 ? 's' : ''}`,
      danger: false,
    });
    if (!confirmed) return;

    await this._writeProposalToFirestore(personaId, proposals);
  }

  /** Write one or more proposals to Firestore tickets collection. */
  async _writeProposalToFirestore(personaId, proposals) {
    const user = this._currentUser;
    if (!user) {
      alert('You must be signed in to promote proposals.');
      return;
    }

    const panels = this._dryRunPanels[personaId];

    // Determine project — use filter project if set, else first eligible project
    const projectId = this._filterProjectId;
    if (!projectId) {
      alert('Please select a project to promote proposals into.');
      return;
    }

    const _firebase = window.firebase;
    const serverTimestamp = _firebase?.firestore?.FieldValue?.serverTimestamp
      ? () => _firebase.firestore.FieldValue.serverTimestamp()
      : () => new Date();
    const ticketsRef = this.db
      .collection('projects').doc(projectId)
      .collection('tickets');
    const projRef = this.db.collection('projects').doc(projectId);

    let successCount = 0;
    let errorCount = 0;
    for (const proposal of proposals) {
      try {
        // Atomic ticket creation with nextTicketNumber increment
        await this.db.runTransaction(async (tx) => {
          const projDoc = await tx.get(projRef);
          if (!projDoc.exists) throw new Error(`Project "${projectId}" not found`);
          const projData = projDoc.data();
          const nextNum = projData.nextTicketNumber || 1;
          const prefix = projData.prefix || 'TK';
          const ticketId = `${prefix}-${nextNum}`;

          tx.update(projRef, { nextTicketNumber: nextNum + 1 });

          const now = serverTimestamp();
          const doc = {
            ticketNumber: nextNum,
            ticketId,
            type: proposal.type || 'bug',
            title: String(proposal.title || '').slice(0, 200),
            description: String(proposal.description || '').slice(0, 10000),
            status: 'proposed',
            statusHistory: [{ to: 'proposed', at: new Date().toISOString(), note: 'Promoted from dry-run preview' }],
            pendingQuestion: null,
            userId: user.uid,
            userEmail: user.email || '',
            projectId,
            advisorPersona: proposal.advisorPersona || personaId,
            createdAt: now,
            updatedAt: now,
          };
          if (proposal.reasoning_summary) {
            doc.reasoning = { summary: String(proposal.reasoning_summary).slice(0, 500), evidence: [] };
          }
          tx.set(ticketsRef.doc(), doc);
        });

        successCount++;
      } catch (err) {
        console.error('AdvisorPanel: failed to promote proposal:', err);
        errorCount++;
      }
    }

    if (panels) {
      if (errorCount === 0) {
        this._setDryRunStatus(personaId, `${successCount} ticket${successCount !== 1 ? 's' : ''} created in your board.`);
      } else {
        this._setDryRunStatus(personaId, `${successCount} created, ${errorCount} failed.`);
      }
    }
  }

  /** Dismiss (remove) a single proposal card from the UI. */
  _dismissProposalCard(cardEl) {
    cardEl.classList.add('adv-preview-card-dismissed');
    setTimeout(() => cardEl.remove(), 300);
  }

  /** Close the dry-run panel for a persona. */
  _closeDryRunPanel(id) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    panels.panel.classList.add('adv-hidden');
    this._cancelDryRunSubscription(id);
    delete this._dryRunProposals[id];
    if (panels.previewRunBtn) panels.previewRunBtn.disabled = false;
  }

  /** Cancel any active dry-run Firestore subscription for a persona. */
  _cancelDryRunSubscription(id) {
    if (this._dryRunUnsubs[id]) {
      this._dryRunUnsubs[id]();
      delete this._dryRunUnsubs[id];
    }
    delete this._dryRunDocIds[id];
  }

  /** Update the status bar text in the dry-run panel. */
  _setDryRunStatus(id, text) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    panels.statusBar.textContent = text;
  }

  async _togglePause(id) {
    const data = this._states[id];
    const projectId = this._filterProjectId;
    // Per-project override: read paused state from project settings when a project is focused
    const projectSettings = projectId
      ? this._projects.find(p => p.id === projectId)?.advisorSettings?.[id]
      : null;
    const isPaused = projectId
      ? (projectSettings?.paused ?? false)
      : data?.status === 'paused';

    // Disable checkbox during write to prevent double-toggle
    const card = this._cards[id];
    if (card?.pauseCheckbox) card.pauseCheckbox.disabled = true;

    try {
      if (projectId) {
        // Write per-project paused flag to project document
        await this.db.collection('projects').doc(projectId).update({
          [`advisorSettings.${id}.paused`]: !isPaused,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // No project focused — write to global persona doc (affects all projects)
        await this.db.collection('advisor').doc(id).set({ status: isPaused ? 'idle' : 'paused' }, { merge: true });
      }
    } catch (err) {
      console.error('Failed to toggle pause:', err);
      // Revert checkbox state on error (Firestore listener will re-sync when possible)
      if (card?.pauseCheckbox) card.pauseCheckbox.checked = isPaused;
    } finally {
      if (card?.pauseCheckbox) card.pauseCheckbox.disabled = false;
    }
  }

  /**
   * Update the Pause All button label and state to reflect current persona states.
   * The button shows "Resume All" when all built-in personas are globally paused,
   * and "Pause All" otherwise.
   * Only considers global pause state (not per-project overrides).
   */
  _updatePauseAllBtn() {
    if (!this._pauseAllBtn) return;
    const allPaused = PERSONAS.every(({ id }) => this._states[id]?.status === 'paused');
    if (allPaused) {
      this._pauseAllBtn.textContent = 'Resume All';
      this._pauseAllBtn.title = 'Resume all advisors';
      this._pauseAllBtn.setAttribute('aria-label', 'Resume all advisors');
      this._pauseAllBtn.classList.add('adv-pause-all-active');
    } else {
      this._pauseAllBtn.textContent = 'Pause All';
      this._pauseAllBtn.title = 'Pause all advisors';
      this._pauseAllBtn.setAttribute('aria-label', 'Pause all advisors');
      this._pauseAllBtn.classList.remove('adv-pause-all-active');
    }
  }

  /**
   * Pause or resume all built-in personas globally.
   * If every built-in persona is already paused, this resumes them all (sets status → 'idle').
   * Otherwise it pauses all that are not yet paused.
   * Always operates on the global /advisor/{id} documents regardless of the focused project.
   */
  async _pauseAllAdvisors() {
    if (!this._pauseAllBtn) return;
    const allPaused = PERSONAS.every(({ id }) => this._states[id]?.status === 'paused');
    const newStatus = allPaused ? 'idle' : 'paused';

    // Disable button during write to prevent double-click
    this._pauseAllBtn.disabled = true;

    try {
      await Promise.all(
        PERSONAS.map(({ id }) => {
          // Only update personas that need to change state
          const currentStatus = this._states[id]?.status;
          if (allPaused ? currentStatus === 'paused' : currentStatus !== 'paused') {
            return this.db.collection('advisor').doc(id).set({ status: newStatus }, { merge: true });
          }
          return Promise.resolve();
        })
      );
    } catch (err) {
      console.error('Failed to pause/resume all advisors:', err);
    } finally {
      this._pauseAllBtn.disabled = false;
    }
  }

  /**
   * Save an updated interval to Firestore.
   * Per spec: only writes intervalHours/intervalMinutes (does NOT unpause a paused persona).
   * Shows a transient "Saved" confirmation on the card, not a global toast.
   * @param {string} id - persona id
   * @param {string} rawValue - raw input value
   * @param {string} [unit='hours'] - 'hours' or 'minutes'
   * @param {HTMLElement} [savedEl] - element to show "Saved" in (optional)
   * @param {function} [onTimer] - called with the setTimeout id so caller can clear (optional)
   */
  async _saveInterval(id, rawValue, unit, savedEl, onTimer) {
    const isMinutes = unit === 'minutes';
    const max = isMinutes ? 60 : 168;
    // Hours mode: allow floats >= 0.25 (DK-111 min). Minutes mode: integer >= 1.
    const v = isMinutes ? parseInt(rawValue, 10) : parseFloat(rawValue);
    const minVal = isMinutes ? 1 : 0.25;
    if (!rawValue || isNaN(v) || v < minVal || v > max) return;
    if (isMinutes && !Number.isInteger(v)) return;
    const projectId = this._filterProjectId;
    try {
      if (projectId) {
        // Write per-project interval to project document
        if (isMinutes) {
          await this.db.collection('projects').doc(projectId).update({
            [`advisorSettings.${id}.intervalMinutes`]: v,
            [`advisorSettings.${id}.intervalHours`]: null,
            updatedAt: new Date().toISOString(),
          });
        } else {
          await this.db.collection('projects').doc(projectId).update({
            [`advisorSettings.${id}.intervalHours`]: v,
            [`advisorSettings.${id}.intervalMinutes`]: null,
            updatedAt: new Date().toISOString(),
          });
        }
      } else {
        // No project focused — write to global persona doc (affects all projects)
        const ref = this.db.collection('advisor').doc(id);
        if (isMinutes) {
          // Save as intervalMinutes; clear intervalHours so daemon uses minutes
          await ref.set({ intervalMinutes: v, intervalHours: null }, { merge: true });
        } else {
          // Save as intervalHours; clear intervalMinutes
          await ref.set({ intervalHours: v, intervalMinutes: null }, { merge: true });
        }
      }
      // Transient "Saved" confirmation on the card (spec: not a global toast)
      if (savedEl) {
        savedEl.textContent = 'Saved';
        savedEl.className = 'adv-interval-saved adv-interval-saved-visible';
        const timer = setTimeout(() => {
          savedEl.textContent = '';
          savedEl.className = 'adv-interval-saved';
        }, 2000);
        if (onTimer) onTimer(timer);
      }
    } catch (err) {
      console.error('Failed to save interval:', err);
      if (savedEl) {
        savedEl.textContent = 'Error';
        savedEl.className = 'adv-interval-saved adv-interval-saved-err';
      }
    }
  }

  /**
   * Save the per-persona ticket cap to Firestore.
   * Validates [1, 50] before writing. Shows transient "Saved" confirmation.
   *
   * @param {string} id - Persona ID
   * @param {number} cap - Validated integer in [1, 50]
   * @param {HTMLElement} [savedEl] - Element to show confirmation in
   * @param {function} [onTimer] - Called with setTimeout id so caller can clear
   */
  async _saveTicketCap(id, cap, savedEl, onTimer) {
    // Client-side validation — enforce min 1, max 50
    if (!Number.isInteger(cap) || cap < 1 || cap > 50) return;
    const projectId = this._filterProjectId;
    try {
      if (projectId) {
        // Write per-project ticket cap to project document
        await this.db.collection('projects').doc(projectId).update({
          [`advisorSettings.${id}.ticketCap`]: cap,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // No project focused — write to global persona doc (affects all projects)
        await this.db.collection('advisor').doc(id).set({ ticketCap: cap }, { merge: true });
      }
      if (savedEl) {
        savedEl.textContent = 'Saved';
        savedEl.className = 'adv-interval-saved adv-interval-saved-visible';
        const timer = setTimeout(() => {
          savedEl.textContent = '';
          savedEl.className = 'adv-interval-saved';
        }, 2000);
        if (onTimer) onTimer(timer);
      }
    } catch (err) {
      console.error('Failed to save ticketCap:', err);
      if (savedEl) {
        savedEl.textContent = 'Error';
        savedEl.className = 'adv-interval-saved adv-interval-saved-err';
      }
    }
  }

  // ── DK-105: Emphasis weights ────────────────────────────────────────────────

  /**
   * Populate the weights UI from the current focused project's stored weights.
   * Called when project focus changes and on initial load.
   * Falls back to all-1 defaults when no weights are stored.
   *
   * @param {string} personaId
   */
  _updateWeightsUI(personaId) {
    const concerns = PERSONA_CONCERNS[personaId];
    if (!concerns) return;
    const inputs = this._weightsInputs[personaId];
    if (!inputs) return;

    // Resolve weights from the focused project doc
    const projectId = this._filterProjectId;
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const storedWeights = project?.weights?.[personaId] ?? {};

    // Build a full map, filling missing keys with 1
    const fullWeights = Object.fromEntries(concerns.map(k => [k, storedWeights[k] ?? 1]));
    this._weightsDraft[personaId] = { ...fullWeights };

    // Update inputs
    for (const key of concerns) {
      const inp = inputs[key];
      if (inp && document.activeElement !== inp) {
        inp.value = String(fullWeights[key]);
      }
    }

    // Update level labels
    for (const key of concerns) {
      const inp = inputs[key];
      if (!inp) continue;
      const row = inp.closest('.adv-weight-row');
      if (!row) continue;
      const lbl = row.querySelector('.adv-weight-level-label');
      if (lbl) {
        const v = fullWeights[key];
        lbl.textContent = v >= 4 ? 'High' : v === 3 ? 'Medium' : 'Low';
      }
    }

    // Update summary
    const summaryEl = this._weightsSummaryEls[personaId];
    if (summaryEl) summaryEl.textContent = buildWeightSummary(fullWeights, personaId);
  }

  /**
   * Save per-project emphasis weights to Firestore.
   * Only writes when a project is focused — weights are per-project.
   * Validates that all values are integers 1–5 before writing.
   *
   * @param {string} personaId
   */
  async _saveWeights(personaId) {
    const concerns = PERSONA_CONCERNS[personaId];
    if (!concerns) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      const refs = this._weightsSaveEls[personaId];
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Select a project first';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-err';
        setTimeout(() => {
          if (refs.statusEl) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-weights-save-status';
          }
        }, 3000);
      }
      return;
    }

    if (this._weightsSaving[personaId]) return;
    this._weightsSaving[personaId] = true;

    const refs = this._weightsSaveEls[personaId];
    if (refs?.btn) refs.btn.disabled = true;
    if (refs?.statusEl) {
      refs.statusEl.textContent = 'Saving…';
      refs.statusEl.className = 'adv-weights-save-status';
    }

    // Build validated weights map — only allowlisted keys, integers 1–5
    const draft = this._weightsDraft[personaId] ?? {};
    const weights = {};
    let valid = true;
    for (const key of concerns) {
      const v = Number(draft[key]);
      if (!Number.isInteger(v) || v < 1 || v > 5) { valid = false; break; }
      weights[key] = v;
    }

    if (!valid) {
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Invalid values — use 1–5 only';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-err';
      }
      if (refs?.btn) refs.btn.disabled = false;
      this._weightsSaving[personaId] = false;
      return;
    }

    try {
      // Optimistic update — the project listener will sync back shortly
      await this.db.collection('projects').doc(projectId).update({
        [`weights.${personaId}`]: weights,
        updatedAt: new Date().toISOString(),
      });
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Saved';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-ok';
        setTimeout(() => {
          if (refs.statusEl) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-weights-save-status';
          }
        }, 2000);
      }
    } catch (err) {
      console.error(`AdvisorPanel: failed to save weights for ${personaId}:`, err);
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Error — could not save';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-err';
        setTimeout(() => {
          if (refs.statusEl) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-weights-save-status';
          }
        }, 4000);
      }
      // Roll back draft to what was stored
      this._updateWeightsUI(personaId);
    } finally {
      if (refs?.btn) refs.btn.disabled = false;
      this._weightsSaving[personaId] = false;
    }
  }

  /**
   * Save the per-persona dedup sensitivity threshold to Firestore.
   * Only accepts integers in [1, 10] (Low=1, Medium=3, High=5).
   * Shows transient "Saved" confirmation via aria-live="polite".
   *
   * @param {string} id - Persona ID
   * @param {number} threshold - Integer in [1, 10]
   * @param {HTMLElement} [savedEl] - Element to show confirmation in (must have aria-live="polite")
   * @param {function} [onTimer] - Called with setTimeout id so caller can clear
   */
  async _saveDedupThreshold(id, threshold, savedEl, onTimer) {
    // Client-side validation — must be integer in [1, 10]
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) return;
    const projectId = this._filterProjectId;
    try {
      if (projectId) {
        // Write per-project dedup threshold to project advisor settings
        await this.db.collection('projects').doc(projectId).update({
          [`advisorSettings.${id}.dedupThreshold`]: threshold,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // No project focused — write to global persona doc (affects all projects)
        await this.db.collection('advisor').doc(id).set({ dedupThreshold: threshold }, { merge: true });
      }
      if (savedEl) {
        savedEl.textContent = 'Saved';
        savedEl.className = 'adv-interval-saved adv-interval-saved-visible';
        const timer = setTimeout(() => {
          savedEl.textContent = '';
          savedEl.className = 'adv-interval-saved';
        }, 2000);
        if (onTimer) onTimer(timer);
      }
    } catch (err) {
      console.error('Failed to save dedupThreshold:', err);
      if (savedEl) {
        savedEl.textContent = 'Error';
        savedEl.className = 'adv-interval-saved adv-interval-saved-err';
      }
    }
  }

  // ── Schedule (DK-195) ────────────────────────────────────────────────────

  /**
   * Compute the next run time for a schedule config, walking forward from now.
   * Returns a Date if found within 8 days, null otherwise.
   * Used for client-side next-run display and the "no runs in 7 days" warning.
   *
   * @param {{ timezone, allowedDays, windowStart, windowEnd }} schedule
   * @param {Date} [from] - start walking from this date (default: now)
   * @returns {Date|null}
   */
  _computeNextScheduledRun(schedule, from) {
    if (!schedule) return null;
    const { timezone, allowedDays, windowStart, windowEnd } = schedule;
    if (!Array.isArray(allowedDays) || allowedDays.length === 0) return null;
    if (!windowStart || !windowEnd) return null;

    const parseMin = (hhmm) => {
      const m = (hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return -1;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    };
    const s = parseMin(windowStart);
    const e = parseMin(windowEnd);
    if (s === -1 || e === -1) return null;

    const now = from ?? new Date();

    // Walk forward in 1-minute increments, up to 8*24*60 minutes
    for (let m = 0; m <= 8 * 24 * 60; m++) {
      const candidate = new Date(now.getTime() + m * 60_000);
      try {
        const parts = new Intl.DateTimeFormat('en', {
          timeZone: timezone,
          weekday: 'short',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(candidate);

        const dayStr  = parts.find(p => p.type === 'weekday')?.value?.toLowerCase().slice(0, 3);
        const hourStr = parts.find(p => p.type === 'hour')?.value;
        const minStr  = parts.find(p => p.type === 'minute')?.value;
        const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const dayInt = DAY_MAP[dayStr];
        if (dayInt === undefined) continue;
        if (!allowedDays.includes(dayInt)) continue;

        const h = parseInt(hourStr, 10);
        const min = parseInt(minStr, 10);
        const localMin = (h === 24 ? 0 : h) * 60 + (isNaN(min) ? 0 : min);

        const inWindow = s <= e
          ? (localMin >= s && localMin < e)
          : (localMin >= s || localMin < e);
        if (inWindow) return candidate;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Update the next-run element and no-runs warning based on current schedule config.
   */
  _updateNextRunDisplay(card, schedule) {
    if (!card?.nextRunEl) return;
    if (!schedule) {
      card.nextRunEl.textContent = '';
      if (card.noRunsWarningEl) card.noRunsWarningEl.classList.add('adv-hidden');
      return;
    }
    const nextDate = this._computeNextScheduledRun(schedule);
    if (!nextDate) {
      card.nextRunEl.textContent = '';
      if (card.noRunsWarningEl) {
        card.noRunsWarningEl.classList.remove('adv-hidden');
      }
      return;
    }
    // Check if any run exists in next 7 days
    const sevenDays = new Date(Date.now() + 7 * 86_400_000);
    const hasRunIn7Days = nextDate.getTime() <= sevenDays.getTime();
    if (card.noRunsWarningEl) {
      card.noRunsWarningEl.classList.toggle('adv-hidden', hasRunIn7Days);
    }
    // Format: "Next: Mon Mar 2, 11:00pm"
    const formatted = nextDate.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    card.nextRunEl.textContent = `Next: ${formatted}`;
  }

  /**
   * Save schedule to Firestore for the persona (DK-195).
   * Reads timezone from select, windowStart/windowEnd from time inputs,
   * and allowedDays from aria-pressed state on day buttons.
   */
  async _saveSchedule(id, tzSelect, startTimeInput, endTimeInput, dayButtons, savedEl, nextRunEl, noRunsWarningEl) {
    const timezone    = tzSelect?.value?.trim() || 'UTC';
    const windowStart = startTimeInput?.value || '';
    const windowEnd   = endTimeInput?.value   || '';

    if (!windowStart || !windowEnd) return;

    // allowedDays: collect dayInt from data-day attribute for active buttons
    const allowedDays = Object.entries(dayButtons)
      .filter(([, btn]) => btn.getAttribute('aria-pressed') === 'true')
      .map(([, btn]) => parseInt(btn.getAttribute('data-day'), 10))
      .filter(d => !isNaN(d));

    const schedule = { timezone, allowedDays, windowStart, windowEnd };

    // Update next-run display client-side immediately (no round-trip)
    const card = this._cards[id];
    if (card) this._updateNextRunDisplay(card, schedule);

    try {
      await this.db.collection('advisor').doc(id).set({ schedule }, { merge: true });
      if (savedEl) {
        savedEl.textContent = 'Saved';
        savedEl.className = 'adv-interval-saved adv-interval-saved-visible';
        setTimeout(() => {
          savedEl.textContent = '';
          savedEl.className = 'adv-interval-saved';
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to save schedule:', err);
      if (savedEl) {
        savedEl.textContent = 'Error';
        savedEl.className = 'adv-interval-saved adv-interval-saved-err';
      }
    }
  }

  /**
   * Clear the schedule restriction for the persona (set schedule to null).
   */
  async _clearSchedule(id, savedEl, nextRunEl, noRunsWarningEl) {
    const card = this._cards[id];
    if (card) this._updateNextRunDisplay(card, null);
    try {
      await this.db.collection('advisor').doc(id).set({ schedule: null }, { merge: true });
      if (savedEl) {
        savedEl.textContent = 'Schedule cleared';
        savedEl.className = 'adv-interval-saved adv-interval-saved-visible';
        setTimeout(() => {
          savedEl.textContent = '';
          savedEl.className = 'adv-interval-saved';
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to clear schedule:', err);
    }
  }

  /**
   * Sync the schedule picker UI from Firestore schedule data (DK-195).
   */
  _updateScheduleUI(id, schedule) {
    const card = this._cards[id];
    if (!card?.tzSelect) return;
    if (!schedule || typeof schedule !== 'object') return;

    const { timezone, allowedDays, windowStart, windowEnd } = schedule;

    // Timezone
    if (typeof timezone === 'string') {
      // Add option if not present
      if (![...card.tzSelect.options].some(o => o.value === timezone)) {
        const opt = document.createElement('option');
        opt.value = timezone;
        opt.textContent = timezone;
        card.tzSelect.insertBefore(opt, card.tzSelect.firstChild);
      }
      card.tzSelect.value = timezone;
    }

    // Time inputs
    if (typeof windowStart === 'string' && windowStart) card.startTimeInput.value = windowStart;
    if (typeof windowEnd   === 'string' && windowEnd)   card.endTimeInput.value   = windowEnd;

    // Day buttons — match by data-day integer attribute
    const daySet = Array.isArray(allowedDays) ? new Set(allowedDays) : new Set();
    Object.entries(card.dayButtons).forEach(([, btn]) => {
      const dayInt = parseInt(btn.getAttribute('data-day'), 10);
      const active = daySet.has(dayInt);
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('adv-day-btn-active', active);
    });

    // Update next-run display
    this._updateNextRunDisplay(card, schedule);
  }

  /**
   * Sync UI from legacy allowedHours field (DK-303) when no new schedule field exists.
   * Converts UTC hours + day-abbrev format to the time-input UI as a best effort.
   */
  _updateScheduleUIFromAllowedHours(id, allowedHours) {
    const card = this._cards[id];
    if (!card?.startTimeInput) return;
    if (!allowedHours || typeof allowedHours !== 'object') return;

    const { start, end, days } = allowedHours;

    // Convert UTC integer hours to HH:MM strings for the time inputs
    if (Number.isInteger(start)) {
      card.startTimeInput.value = `${String(start).padStart(2, '0')}:00`;
    }
    if (Number.isInteger(end)) {
      card.endTimeInput.value = `${String(end).padStart(2, '0')}:00`;
    }

    // Map legacy string day abbrevs to integer day indices
    const ABBREV_TO_INT = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const daySet = Array.isArray(days)
      ? new Set(days.map(d => ABBREV_TO_INT[d]).filter(d => d !== undefined))
      : new Set();

    Object.entries(card.dayButtons).forEach(([, btn]) => {
      const dayInt = parseInt(btn.getAttribute('data-day'), 10);
      const active = daySet.has(dayInt);
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('adv-day-btn-active', active);
    });
  }

  /** @deprecated Use _saveSchedule instead. Kept for compatibility. */
  async _saveTimeWindow(id, ...args) {
    // no-op: new UI uses _saveSchedule
  }

  /** @deprecated Use _clearSchedule instead. Kept for compatibility. */
  async _clearTimeWindow(id, ...args) {
    // no-op: new UI uses _clearSchedule
  }

  /** @deprecated Use _updateScheduleUI instead. Kept for compatibility. */
  _updateTimeWindowUI(id, ...args) {
    // no-op: new UI uses _updateScheduleUI
  }

  async _saveContext(projectId, text, saveBtn, statusEl, onSuccess) {
    if (text.length > 4000) {
      statusEl.textContent = 'Context exceeds 4,000 characters — please shorten it.';
      statusEl.className = 'adv-context-status adv-context-status-err';
      setTimeout(() => {
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-context-status'; }
      }, 4000);
      return;
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-context-status';

    try {
      // Saving manually clears any active preset association (context is now "Custom")
      await this.db.collection('projects').doc(projectId).update({
        advisorContext: text.trim(),
        activePresetId: null,
        updatedAt: new Date().toISOString(),
      });
      // Clear local preset tracking too
      this._lastAppliedPresetId = null;
      this._contextDirty = false;
      this._updatePresetSelector();
      this._updatePresetDriftIndicator();

      statusEl.textContent = 'Saved';
      statusEl.className = 'adv-context-status adv-context-status-ok';
      setTimeout(() => {
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-context-status'; }
      }, 2000);
      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Failed to save advisorContext:', err);
      statusEl.textContent = 'Error';
      statusEl.className = 'adv-context-status adv-context-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Soul modal ───────────────────────────────────────────────

  _openSoulModal(personaId, personaLabel) {
    this._closeSoulModal(); // close any existing one

    this._soulModalPersonaId = personaId;

    const data = this._states[personaId];
    const currentSoul = (data && typeof data.soulPrompt === 'string' && data.soulPrompt.trim())
      ? data.soulPrompt.trim()
      : '';
    const defaultSoul = DEFAULT_SOUL_PROMPTS[personaId] || '';

    // Overlay
    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSoulModal(); },
    });

    // Modal box
    const modal = el('div', { className: 'adv-soul-modal' });

    // Header
    const header = el('div', { className: 'adv-soul-modal-header' },
      el('div', { className: 'adv-soul-modal-title' }, `${personaLabel} Soul`),
      el('button', {
        className: 'adv-soul-modal-close',
        title: 'Close',
        onClick: () => this._closeSoulModal(),
      }, '×'),
    );
    modal.appendChild(header);

    // Description
    modal.appendChild(
      el('p', { className: 'adv-soul-modal-desc' },
        'The soul prompt defines this persona\'s identity and reasoning style. ' +
        'Leave blank to use the default.',
      )
    );

    // Textarea — pre-fill with the current custom soul, or the default soul if none is set
    const textarea = el('textarea', {
      className: 'adv-soul-textarea',
      rows: '12',
    });
    textarea.value = currentSoul || defaultSoul;
    modal.appendChild(textarea);

    // Footer with status + buttons
    const statusEl = el('span', { className: 'adv-soul-status' });

    const resetBtn = el('button', {
      className: 'adv-soul-reset-btn',
      title: 'Clear custom soul and revert to default',
      onClick: async () => {
        textarea.value = '';
        await this._saveSoulPrompt(personaId, '', saveBtn, statusEl);
      },
    }, 'Use default');

    const saveBtn = el('button', {
      className: 'adv-soul-save-btn',
      onClick: async () => {
        await this._saveSoulPrompt(personaId, textarea.value, saveBtn, statusEl);
      },
    }, 'Save');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          resetBtn,
          saveBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._soulModal = overlay;

    // Focus the textarea
    setTimeout(() => textarea.focus(), 50);
  }

  _closeSoulModal() {
    if (this._soulModal) {
      if (this._soulModal.parentNode) this._soulModal.parentNode.removeChild(this._soulModal);
      this._soulModal = null;
    }
    this._soulModalPersonaId = null;
  }

  async _saveSoulPrompt(personaId, text, saveBtn, statusEl) {
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    // SECURITY: soulPrompt flows directly into the LLM system prompt. Apply
    // the same sanitization rules used server-side: strip prompt-delimiter
    // characters, remove known injection phrases, and enforce a 500-char cap.
    // Never write raw user input to this field.
    const SOUL_PROMPT_MAX_CHARS = 500;
    const SOUL_INJECTION_PHRASES = ['ignore previous instructions', 'you are now', 'disregard', 'new persona', 'system:'];
    let sanitized = text.slice(0, SOUL_PROMPT_MAX_CHARS);
    const lowerSanitized = sanitized.toLowerCase();
    for (const phrase of SOUL_INJECTION_PHRASES) {
      if (lowerSanitized.includes(phrase)) {
        const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        sanitized = sanitized.replace(re, '');
      }
    }
    sanitized = sanitized.replace(/<\/?system>|<\|/g, '').trim();
    const value = sanitized.length > 0 ? sanitized : null; // null clears it (reverts to default)

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { soulPrompt: value },
        { merge: true }
      );
      statusEl.textContent = value ? 'Saved' : 'Reverted to default';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } catch (err) {
      console.error('Failed to save soulPrompt:', err);
      statusEl.textContent = 'Error saving';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Constraint modal (DK-365) ─────────────────────────────────────────────

  /**
   * Open the constraint configuration modal drawer for the given persona.
   * Constraints are stored at project.advisorSettings.<personaId>.constraints
   * and are passed to the persona's runCycle on next run.
   */
  _openConstraintModal(personaId, personaLabel) {
    this._closeConstraintModal();

    const projectId = this._filterProjectId;
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const saved = project?.advisorSettings?.[personaId]?.constraints ?? null;

    // Work on a deep copy of saved constraints; user can discard changes
    const draft = saved ? JSON.parse(JSON.stringify(saved)) : {};

    // ── Preset helpers ────────────────────────────────────────

    const CONSTRAINT_PRESETS_DEF = [
      {
        id: 'lean_mvp', label: 'Lean MVP',
        description: 'Low complexity, bootstrapped budget, mobile + web.',
        constraints: { budget_range: { min: 0, max: 25000 }, platform_target: ['mobile', 'web'], audience_segment: 'Broad consumer', complexity_cap: 'low', risk_tolerance: 'moderate' },
      },
      {
        id: 'enterprise_safe', label: 'Enterprise-safe',
        description: 'Medium complexity, funded, web-only, enterprise segment, conservative risk.',
        constraints: { budget_range: { min: 50000, max: 500000 }, platform_target: ['web'], audience_segment: 'Enterprise', complexity_cap: 'medium', risk_tolerance: 'conservative' },
      },
      {
        id: 'consumer_mobile', label: 'Consumer Mobile',
        description: 'Low complexity, moderate budget, mobile-only, broad consumer.',
        constraints: { budget_range: { min: 5000, max: 100000 }, platform_target: ['mobile'], audience_segment: 'Broad consumer', complexity_cap: 'low', risk_tolerance: 'moderate' },
      },
    ];

    // ── Budget slider helpers ─────────────────────────────────

    const BUDGET_STEPS = [0, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
    const BUDGET_LABELS = ['$0', '$5K', '$10K', '$25K', '$50K', '$100K', '$250K', '$500K+'];

    function formatBudgetLabel(val) {
      if (val === 0) return '$0 / Bootstrapped';
      if (val <= 5000) return '$5K / Bootstrapped';
      if (val <= 10000) return '$10K / Seed';
      if (val <= 25000) return '$25K / Small seed';
      if (val <= 50000) return '$50K / Seed-funded';
      if (val <= 100000) return '$100K / Series A range';
      if (val <= 250000) return '$250K / Series A+';
      return '$500K+ / Funded';
    }

    function stepToValue(step) { return BUDGET_STEPS[Math.min(step, BUDGET_STEPS.length - 1)] || 0; }
    function valueToStep(val) {
      let closest = 0;
      let minDiff = Infinity;
      for (let i = 0; i < BUDGET_STEPS.length; i++) {
        const diff = Math.abs(BUDGET_STEPS[i] - val);
        if (diff < minDiff) { minDiff = diff; closest = i; }
      }
      return closest;
    }

    // ── Conflict detection ────────────────────────────────────

    function detectConflicts(d) {
      const msgs = [];
      if (d.complexity_cap === 'high' && d.budget_range && d.budget_range.max <= 5000) {
        msgs.push('High complexity ideas typically require engineering investment. Consider raising your budget or lowering complexity.');
      }
      if (d.risk_tolerance === 'aggressive' && d.budget_range && d.budget_range.max <= 5000) {
        msgs.push('Aggressive risk with a zero budget may produce ideas that are hard to execute. Consider raising the budget or lowering risk.');
      }
      if (Array.isArray(d.platform_target) && d.platform_target.length === 0) {
        msgs.push('No platform selected — select at least one platform for focused ideas.');
      }
      return msgs;
    }

    // ── Count active constraints ──────────────────────────────

    function countActive(d) {
      return Object.keys(d).filter(k => {
        const v = d[k];
        if (Array.isArray(v)) return v.length > 0;
        if (v && typeof v === 'object') return true;
        return v != null && v !== '';
      }).length;
    }

    // ── Overlay + modal container ─────────────────────────────

    const overlay = el('div', {
      className: 'adv-soul-overlay adv-constraint-overlay',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-constraint-modal-title',
      onClick: (e) => { if (e.target === overlay) this._closeConstraintModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-constraint-modal' });

    // Header
    const titleEl = el('span', {
      className: 'adv-soul-modal-title',
      id: 'adv-constraint-modal-title',
    }, `${personaLabel} Constraints`);

    modal.appendChild(el('div', { className: 'adv-soul-modal-header' },
      titleEl,
      el('button', {
        className: 'adv-soul-modal-close',
        title: 'Close',
        'aria-label': 'Close constraints panel',
        onClick: () => this._closeConstraintModal(),
      }, '×'),
    ));

    if (!projectId) {
      modal.appendChild(el('p', { className: 'adv-soul-modal-desc' },
        'Select a project to configure constraints.'
      ));
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      this._constraintModal = overlay;
      this._constraintModalPersonaId = personaId;
      const onKey = (e) => { if (e.key === 'Escape') { this._closeConstraintModal(); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
      this._constraintModal._keyHandler = onKey;
      return;
    }

    modal.appendChild(el('p', { className: 'adv-soul-modal-desc' },
      'Set operating constraints for this persona. Ideas generated will respect these limits. Constraints persist across sessions and apply on the next run.'
    ));

    // ── Preset row ────────────────────────────────────────────
    const presetRow = el('div', { className: 'adv-constraint-preset-row', role: 'group', 'aria-label': 'Constraint presets' });
    modal.appendChild(el('div', { className: 'adv-constraint-section' },
      el('span', { className: 'adv-constraint-section-label' }, 'Presets'),
      presetRow,
    ));

    // ── Status elements (conflict + save) ─────────────────────
    const conflictEl = el('div', {
      className: 'adv-constraint-conflict adv-hidden',
      role: 'alert',
      'aria-live': 'polite',
    });
    modal.appendChild(conflictEl);

    const statusEl = el('div', { className: 'adv-soul-status', role: 'status', 'aria-live': 'polite' });

    // ── Form fields ───────────────────────────────────────────

    const formEl = el('div', { className: 'adv-constraint-form' });

    // Helper: re-check conflicts and update UI
    const refreshConflicts = () => {
      const msgs = detectConflicts(draft);
      if (msgs.length > 0) {
        conflictEl.innerHTML = '';
        msgs.forEach(m => {
          conflictEl.appendChild(el('p', {
            className: 'adv-constraint-conflict-msg',
          }, '⚠ ' + m));
        });
        conflictEl.classList.remove('adv-hidden');
      } else {
        conflictEl.innerHTML = '';
        conflictEl.classList.add('adv-hidden');
      }
    };

    // ── 1. Budget range: dual-handle slider (simulated with two inputs) ───
    const budgetMinStep = valueToStep(draft.budget_range?.min ?? 0);
    const budgetMaxStep = valueToStep(draft.budget_range?.max ?? BUDGET_STEPS[BUDGET_STEPS.length - 1]);

    const budgetMinLabel = el('span', { className: 'adv-constraint-budget-label' }, formatBudgetLabel(stepToValue(budgetMinStep)));
    const budgetMaxLabel = el('span', { className: 'adv-constraint-budget-label' }, formatBudgetLabel(stepToValue(budgetMaxStep)));

    const budgetMinInput = el('input', {
      type: 'range',
      className: 'adv-constraint-slider',
      min: '0',
      max: String(BUDGET_STEPS.length - 1),
      step: '1',
      value: String(budgetMinStep),
      'aria-label': `Budget minimum: ${formatBudgetLabel(stepToValue(budgetMinStep))}`,
      'aria-valuemin': '0',
      'aria-valuemax': String(BUDGET_STEPS.length - 1),
      'aria-valuenow': String(budgetMinStep),
      'aria-valuetext': formatBudgetLabel(stepToValue(budgetMinStep)),
    });

    const budgetMaxInput = el('input', {
      type: 'range',
      className: 'adv-constraint-slider',
      min: '0',
      max: String(BUDGET_STEPS.length - 1),
      step: '1',
      value: String(budgetMaxStep),
      'aria-label': `Budget maximum: ${formatBudgetLabel(stepToValue(budgetMaxStep))}`,
      'aria-valuemin': '0',
      'aria-valuemax': String(BUDGET_STEPS.length - 1),
      'aria-valuenow': String(budgetMaxStep),
      'aria-valuetext': formatBudgetLabel(stepToValue(budgetMaxStep)),
    });

    budgetMinInput.addEventListener('input', () => {
      let step = parseInt(budgetMinInput.value, 10);
      const maxStep = parseInt(budgetMaxInput.value, 10);
      if (step > maxStep) { step = maxStep; budgetMinInput.value = String(step); }
      const val = stepToValue(step);
      budgetMinLabel.textContent = formatBudgetLabel(val);
      budgetMinInput.setAttribute('aria-valuenow', String(step));
      budgetMinInput.setAttribute('aria-valuetext', formatBudgetLabel(val));
      if (!draft.budget_range) draft.budget_range = { min: 0, max: BUDGET_STEPS[BUDGET_STEPS.length - 1] };
      draft.budget_range.min = val;
      refreshConflicts();
    });

    budgetMaxInput.addEventListener('input', () => {
      let step = parseInt(budgetMaxInput.value, 10);
      const minStep = parseInt(budgetMinInput.value, 10);
      if (step < minStep) { step = minStep; budgetMaxInput.value = String(step); }
      const val = stepToValue(step);
      budgetMaxLabel.textContent = formatBudgetLabel(val);
      budgetMaxInput.setAttribute('aria-valuenow', String(step));
      budgetMaxInput.setAttribute('aria-valuetext', formatBudgetLabel(val));
      if (!draft.budget_range) draft.budget_range = { min: 0, max: BUDGET_STEPS[BUDGET_STEPS.length - 1] };
      draft.budget_range.max = val;
      refreshConflicts();
    });

    // Arrow key support for sliders (keyboard operability per spec)
    [budgetMinInput, budgetMaxInput].forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          const v = Math.max(0, parseInt(inp.value, 10) - 1);
          inp.value = String(v);
          inp.dispatchEvent(new Event('input'));
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          const v = Math.min(BUDGET_STEPS.length - 1, parseInt(inp.value, 10) + 1);
          inp.value = String(v);
          inp.dispatchEvent(new Event('input'));
        }
      });
    });

    const budgetClearBtn = el('button', {
      type: 'button',
      className: 'adv-constraint-clear-btn',
      title: 'Clear budget constraint',
      onClick: () => {
        delete draft.budget_range;
        budgetMinInput.value = '0';
        budgetMaxInput.value = String(BUDGET_STEPS.length - 1);
        budgetMinLabel.textContent = formatBudgetLabel(0);
        budgetMaxLabel.textContent = formatBudgetLabel(BUDGET_STEPS[BUDGET_STEPS.length - 1]);
        refreshConflicts();
      },
    }, 'Clear');

    const budgetSection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Budget Range'),
      el('div', { className: 'adv-constraint-budget-track' },
        el('span', { className: 'adv-constraint-budget-anchor' }, '$0 / Bootstrapped'),
        el('span', { className: 'adv-constraint-budget-anchor adv-constraint-budget-anchor-right' }, '$500K+ / Funded'),
      ),
      el('div', { className: 'adv-constraint-slider-row' },
        el('span', { className: 'adv-constraint-slider-label' }, 'Min:'),
        budgetMinInput,
        budgetMinLabel,
      ),
      el('div', { className: 'adv-constraint-slider-row' },
        el('span', { className: 'adv-constraint-slider-label' }, 'Max:'),
        budgetMaxInput,
        budgetMaxLabel,
      ),
      budgetClearBtn,
    );
    formEl.appendChild(budgetSection);

    // ── 2. Risk tolerance: 5-step slider ─────────────────────
    const RISK_OPTIONS = ['conservative', 'moderate', 'balanced', 'adventurous', 'aggressive'];
    const RISK_LABELS_DISPLAY = ['Conservative', 'Moderate', 'Balanced', 'Adventurous', 'Aggressive'];
    const riskStep = RISK_OPTIONS.indexOf(draft.risk_tolerance ?? 'balanced');
    const riskValueLabel = el('span', { className: 'adv-constraint-budget-label' }, RISK_LABELS_DISPLAY[Math.max(0, riskStep)] || 'Balanced');

    const riskInput = el('input', {
      type: 'range',
      className: 'adv-constraint-slider',
      min: '0',
      max: '4',
      step: '1',
      value: String(Math.max(0, riskStep)),
      'aria-label': `Risk Tolerance: ${RISK_LABELS_DISPLAY[Math.max(0, riskStep)]} (${Math.max(0, riskStep) + 1} of 5)`,
      'aria-valuemin': '0',
      'aria-valuemax': '4',
      'aria-valuenow': String(Math.max(0, riskStep)),
      'aria-valuetext': `${RISK_LABELS_DISPLAY[Math.max(0, riskStep)]} (${Math.max(0, riskStep) + 1} of 5)`,
    });

    riskInput.addEventListener('input', () => {
      const step = parseInt(riskInput.value, 10);
      const label = RISK_LABELS_DISPLAY[step] || 'Balanced';
      riskValueLabel.textContent = label;
      riskInput.setAttribute('aria-valuenow', String(step));
      riskInput.setAttribute('aria-valuetext', `${label} (${step + 1} of 5)`);
      riskInput.setAttribute('aria-label', `Risk Tolerance: ${label} (${step + 1} of 5)`);
      draft.risk_tolerance = RISK_OPTIONS[step];
      refreshConflicts();
    });

    riskInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = Math.max(0, parseInt(riskInput.value, 10) - 1);
        riskInput.value = String(v);
        riskInput.dispatchEvent(new Event('input'));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        const v = Math.min(4, parseInt(riskInput.value, 10) + 1);
        riskInput.value = String(v);
        riskInput.dispatchEvent(new Event('input'));
      }
    });

    const riskSection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Risk Tolerance'),
      el('div', { className: 'adv-constraint-budget-track' },
        el('span', { className: 'adv-constraint-budget-anchor' }, 'Conservative'),
        el('span', { className: 'adv-constraint-budget-anchor adv-constraint-budget-anchor-right' }, 'Aggressive'),
      ),
      el('div', { className: 'adv-constraint-slider-row' },
        riskInput,
        riskValueLabel,
      ),
    );
    formEl.appendChild(riskSection);

    // ── 3. Platform target: pill-select (multi-select) ────────
    const PLATFORM_OPTIONS = [
      { value: 'web',     label: 'Web' },
      { value: 'mobile',  label: 'Mobile' },
      { value: 'desktop', label: 'Desktop' },
      { value: 'api',     label: 'API/Backend' },
    ];
    const selectedPlatforms = new Set(Array.isArray(draft.platform_target) ? draft.platform_target : []);
    const platformPills = [];

    const platformPillGroup = el('div', { className: 'adv-constraint-pill-group', role: 'group', 'aria-label': 'Platform targets (multi-select)' });
    for (const opt of PLATFORM_OPTIONS) {
      const isSelected = selectedPlatforms.has(opt.value);
      const pill = el('button', {
        type: 'button',
        className: 'adv-constraint-pill' + (isSelected ? ' adv-constraint-pill-active' : ''),
        'aria-pressed': String(isSelected),
        onClick: () => {
          const pressed = pill.getAttribute('aria-pressed') === 'true';
          if (pressed) {
            selectedPlatforms.delete(opt.value);
            pill.setAttribute('aria-pressed', 'false');
            pill.classList.remove('adv-constraint-pill-active');
          } else {
            selectedPlatforms.add(opt.value);
            pill.setAttribute('aria-pressed', 'true');
            pill.classList.add('adv-constraint-pill-active');
          }
          draft.platform_target = [...selectedPlatforms];
          refreshConflicts();
        },
      }, opt.label);
      platformPills.push(pill);
      platformPillGroup.appendChild(pill);
    }

    const platformSection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Platform Target'),
      el('span', { className: 'adv-constraint-field-hint' }, 'Select all that apply'),
      platformPillGroup,
    );
    formEl.appendChild(platformSection);

    // ── 4. Audience segment: dropdown + free text ─────────────
    const AUDIENCE_PRESETS = [
      { value: '', label: '— choose or type below —' },
      { value: 'Broad consumer', label: 'Broad consumer' },
      { value: 'SMB', label: 'SMB (small & medium business)' },
      { value: 'Enterprise', label: 'Enterprise' },
      { value: 'Developer', label: 'Developer / technical' },
      { value: 'Healthcare', label: 'Healthcare' },
      { value: 'Education', label: 'Education' },
      { value: 'Fintech', label: 'Fintech' },
    ];

    const audienceSelect = el('select', {
      className: 'adv-constraint-select',
      'aria-label': 'Audience segment preset',
      onChange: () => {
        if (audienceSelect.value) {
          audienceInput.value = audienceSelect.value;
          draft.audience_segment = audienceSelect.value;
          audienceCounter.textContent = `${audienceSelect.value.length} / 200`;
        }
      },
    });
    for (const opt of AUDIENCE_PRESETS) {
      audienceSelect.appendChild(el('option', { value: opt.value }, opt.label));
    }
    // Pre-select if saved value matches a preset
    if (draft.audience_segment) {
      const match = AUDIENCE_PRESETS.find(p => p.value === draft.audience_segment);
      if (match) audienceSelect.value = match.value;
    }

    const audienceCounter = el('span', { className: 'adv-focus-counter' }, `${(draft.audience_segment || '').length} / 200`);
    const audienceDescId = `adv-audience-desc-${personaId}`;
    const audienceInput = el('input', {
      type: 'text',
      className: 'adv-constraint-text-input',
      placeholder: 'e.g. B2B SaaS teams, 50–500 employees',
      maxlength: '200',
      value: draft.audience_segment || '',
      'aria-label': 'Audience segment (free text, max 200 characters)',
      'aria-describedby': audienceDescId,
      onInput: () => {
        const len = audienceInput.value.length;
        audienceCounter.textContent = `${len} / 200`;
        audienceCounter.className = 'adv-focus-counter' + (len > 180 ? ' adv-focus-counter-warn' : '');
        draft.audience_segment = audienceInput.value;
      },
    });

    const audienceSection = el('div', { className: 'adv-constraint-field' },
      el('div', { className: 'adv-constraint-label-row' },
        el('label', { className: 'adv-constraint-label' }, 'Audience Segment'),
        audienceCounter,
      ),
      audienceSelect,
      audienceInput,
      el('span', { className: 'adv-focus-counter', id: audienceDescId, style: 'display:none' }, 'Max 200 characters'),
    );
    formEl.appendChild(audienceSection);

    // ── 5. Complexity cap: 3-option pill-select ───────────────
    const COMPLEXITY_OPTIONS = [
      { value: 'low',    label: 'Low',    desc: 'MVP-scope ideas, minimal engineering' },
      { value: 'medium', label: 'Medium', desc: 'Standard feature complexity' },
      { value: 'high',   label: 'High',   desc: 'Platform-level changes' },
    ];

    const complexityPillGroup = el('div', { className: 'adv-constraint-pill-group', role: 'group', 'aria-label': 'Complexity cap (choose one)' });
    const complexityPills = [];
    let selectedComplexity = draft.complexity_cap || null;

    for (const opt of COMPLEXITY_OPTIONS) {
      const isSelected = selectedComplexity === opt.value;
      const pill = el('button', {
        type: 'button',
        className: 'adv-constraint-pill' + (isSelected ? ' adv-constraint-pill-active' : ''),
        title: opt.desc,
        'aria-pressed': String(isSelected),
        onClick: () => {
          complexityPills.forEach(p => {
            p.setAttribute('aria-pressed', 'false');
            p.classList.remove('adv-constraint-pill-active');
          });
          pill.setAttribute('aria-pressed', 'true');
          pill.classList.add('adv-constraint-pill-active');
          selectedComplexity = opt.value;
          draft.complexity_cap = opt.value;
          refreshConflicts();
        },
      }, opt.label);
      complexityPills.push(pill);
      complexityPillGroup.appendChild(pill);
    }

    const complexitySection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Complexity Cap'),
      el('span', { className: 'adv-constraint-field-hint' }, 'Maximum scope of ideas generated'),
      complexityPillGroup,
    );
    formEl.appendChild(complexitySection);

    modal.appendChild(formEl);
    modal.appendChild(conflictEl);

    // ── Per-run override toggle ───────────────────────────────
    const overrideSection = el('details', { className: 'adv-constraint-override' });
    overrideSection.appendChild(el('summary', {}, 'Run with saved constraints / Customize for this run'));
    overrideSection.appendChild(el('p', { className: 'adv-constraint-override-hint' },
      'Override constraints are applied to the next on-demand run only and are discarded after. They do not change your saved settings.',
    ));
    modal.appendChild(overrideSection);

    // ── Preset buttons (built after form so they can reference controls) ──
    for (const preset of CONSTRAINT_PRESETS_DEF) {
      const presetBtn = el('button', {
        type: 'button',
        className: 'adv-weights-preset-btn',
        title: preset.description,
        onClick: () => {
          // Apply preset to draft
          Object.assign(draft, JSON.parse(JSON.stringify(preset.constraints)));
          // Sync UI controls from draft
          syncUIFromDraft();
          refreshConflicts();
        },
      }, preset.label);
      presetRow.appendChild(presetBtn);
    }

    // ── Reset + Clear ─────────────────────────────────────────
    const resetBtn = el('button', {
      type: 'button',
      className: 'adv-soul-cancel-btn',
      onClick: () => {
        // Reset to saved state
        const resaved = project?.advisorSettings?.[personaId]?.constraints ?? null;
        for (const k of Object.keys(draft)) delete draft[k];
        if (resaved) Object.assign(draft, JSON.parse(JSON.stringify(resaved)));
        syncUIFromDraft();
        refreshConflicts();
        statusEl.textContent = 'Reset to saved';
        statusEl.className = 'adv-soul-status';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      },
    }, 'Reset');

    const clearBtn = el('button', {
      type: 'button',
      className: 'adv-soul-cancel-btn',
      title: 'Clear all constraints',
      onClick: () => {
        for (const k of Object.keys(draft)) delete draft[k];
        syncUIFromDraft();
        refreshConflicts();
      },
    }, 'Clear all');

    const saveBtn = el('button', {
      type: 'button',
      className: 'adv-soul-save-btn',
      onClick: () => this._saveConstraints(personaId, draft, saveBtn, statusEl),
    }, 'Save constraints');

    modal.appendChild(el('div', { className: 'adv-soul-modal-footer' },
      statusEl,
      el('div', { className: 'adv-soul-modal-footer-right' },
        clearBtn,
        resetBtn,
        saveBtn,
      ),
    ));

    // ── Sync UI controls from draft (used by presets + reset) ─

    const syncUIFromDraft = () => {
      // Budget
      const bMin = valueToStep(draft.budget_range?.min ?? 0);
      const bMax = valueToStep(draft.budget_range?.max ?? BUDGET_STEPS[BUDGET_STEPS.length - 1]);
      budgetMinInput.value = String(bMin);
      budgetMaxInput.value = String(bMax);
      budgetMinLabel.textContent = formatBudgetLabel(stepToValue(bMin));
      budgetMaxLabel.textContent = formatBudgetLabel(stepToValue(bMax));
      budgetMinInput.setAttribute('aria-valuenow', String(bMin));
      budgetMinInput.setAttribute('aria-valuetext', formatBudgetLabel(stepToValue(bMin)));
      budgetMaxInput.setAttribute('aria-valuenow', String(bMax));
      budgetMaxInput.setAttribute('aria-valuetext', formatBudgetLabel(stepToValue(bMax)));

      // Risk
      const riskIdx = RISK_OPTIONS.indexOf(draft.risk_tolerance ?? 'balanced');
      const rIdx = Math.max(0, riskIdx);
      riskInput.value = String(rIdx);
      riskValueLabel.textContent = RISK_LABELS_DISPLAY[rIdx] || 'Balanced';
      riskInput.setAttribute('aria-valuenow', String(rIdx));
      riskInput.setAttribute('aria-valuetext', `${RISK_LABELS_DISPLAY[rIdx]} (${rIdx + 1} of 5)`);

      // Platform
      const newPlatforms = new Set(Array.isArray(draft.platform_target) ? draft.platform_target : []);
      selectedPlatforms.clear();
      for (const p of newPlatforms) selectedPlatforms.add(p);
      PLATFORM_OPTIONS.forEach((opt, i) => {
        const active = selectedPlatforms.has(opt.value);
        platformPills[i].setAttribute('aria-pressed', String(active));
        platformPills[i].classList.toggle('adv-constraint-pill-active', active);
      });

      // Audience
      audienceInput.value = draft.audience_segment || '';
      audienceCounter.textContent = `${(draft.audience_segment || '').length} / 200`;
      const audienceMatch = AUDIENCE_PRESETS.find(p => p.value === (draft.audience_segment || ''));
      audienceSelect.value = audienceMatch ? audienceMatch.value : '';

      // Complexity
      const newComp = draft.complexity_cap || null;
      selectedComplexity = newComp;
      COMPLEXITY_OPTIONS.forEach((opt, i) => {
        const active = opt.value === newComp;
        complexityPills[i].setAttribute('aria-pressed', String(active));
        complexityPills[i].classList.toggle('adv-constraint-pill-active', active);
      });
    };

    // Initial conflict check
    refreshConflicts();

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._constraintModal = overlay;
    this._constraintModalPersonaId = personaId;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeConstraintModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._constraintModal._keyHandler = onKey;

    // Focus the save button
    setTimeout(() => saveBtn.focus(), 50);
  }

  _closeConstraintModal() {
    if (this._constraintModal) {
      if (this._constraintModal._keyHandler) {
        document.removeEventListener('keydown', this._constraintModal._keyHandler);
      }
      if (this._constraintModal.parentNode) this._constraintModal.parentNode.removeChild(this._constraintModal);
      this._constraintModal = null;
    }
    this._constraintModalPersonaId = null;
  }

  /**
   * Save persona constraints to Firestore.
   * Stored at project.advisorSettings.<personaId>.constraints
   * Validation is performed in the backend (start-advisor.js) before use.
   */
  async _saveConstraints(personaId, draft, saveBtn, statusEl) {
    const projectId = this._filterProjectId;
    if (!projectId) {
      statusEl.textContent = 'No project selected';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    try {
      // Build a clean constraints object from draft
      // Omit empty/default values to keep Firestore doc tidy
      const toSave = {};
      if (draft.budget_range != null) {
        toSave.budget_range = { min: draft.budget_range.min || 0, max: draft.budget_range.max || 0 };
      }
      if (Array.isArray(draft.platform_target) && draft.platform_target.length > 0) {
        toSave.platform_target = draft.platform_target;
      }
      if (draft.audience_segment?.trim()) {
        toSave.audience_segment = draft.audience_segment.trim().slice(0, 200);
      }
      if (draft.complexity_cap) {
        toSave.complexity_cap = draft.complexity_cap;
      }
      if (draft.risk_tolerance) {
        toSave.risk_tolerance = draft.risk_tolerance;
      }

      const update = {
        [`advisorSettings.${personaId}.constraints`]: Object.keys(toSave).length > 0 ? toSave : null,
        updatedAt: new Date().toISOString(),
      };
      await this.db.collection('projects').doc(projectId).update(update);

      statusEl.textContent = 'Saved';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'adv-soul-status'; }, 2000);

      // Update chip immediately (optimistic — will also refresh from Firestore on next snapshot)
      const chipEl = this._constraintChipEls[personaId];
      if (chipEl) {
        const count = Object.keys(toSave).length;
        if (count > 0) {
          chipEl.textContent = `⚙ ${count} constraint${count === 1 ? '' : 's'} active`;
          chipEl.classList.remove('adv-hidden');
        } else {
          chipEl.classList.add('adv-hidden');
        }
      }
    } catch (err) {
      console.error('Failed to save constraints:', err);
      statusEl.textContent = 'Error saving';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Test Rails modal (QA persona) ────────────────────────────

  _openTestRailsModal() {
    this._closeTestRailsModal();

    const db = this.db;
    const qaData = this._states['qa'] || {};
    // Deep copy so local edits don't mutate live state
    let localRails = JSON.parse(JSON.stringify(qaData.testRails || {}));

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeTestRailsModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-rails-modal' });

    modal.appendChild(el('div', { className: 'adv-soul-modal-header' },
      el('div', { className: 'adv-soul-modal-title' }, 'Test Rails'),
      el('button', {
        className: 'adv-soul-modal-close',
        title: 'Close',
        onClick: () => this._closeTestRailsModal(),
      }, '×'),
    ));

    modal.appendChild(el('p', { className: 'adv-soul-modal-desc' },
      'Playwright flows run each QA cycle to catch regressions. ' +
      'New rails are auto-generated from recently completed feature tickets.',
    ));

    const statusEl = el('div', { className: 'adv-rails-status' });
    const setStatus = (msg, isErr = false) => {
      statusEl.textContent = msg;
      statusEl.className = 'adv-rails-status' + (isErr ? ' adv-soul-status-err' : ' adv-soul-status-ok');
      if (!isErr) setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'adv-rails-status'; }, 2000);
    };

    const contentEl = el('div', { className: 'adv-rails-content' });

    const writeProjectRails = async (projectId, rails) => {
      await db.collection('advisor').doc('qa').set(
        { testRails: { [projectId]: rails } },
        { merge: true }
      );
      localRails[projectId] = rails;
    };

    const rebuildContent = () => {
      contentEl.innerHTML = '';
      const projectIds = Object.keys(localRails);

      if (projectIds.length === 0) {
        contentEl.appendChild(el('div', { className: 'adv-rails-empty' },
          'No test rails yet. Run QA to auto-seed from configured flows, or add one manually.',
        ));
        return;
      }

      for (const projectId of projectIds) {
        const rails = localRails[projectId] || [];
        const railsListEl = el('div', { className: 'adv-rails-list' });

        const buildRailRow = (rail) => {
          const resultClass =
            rail.lastResult === 'pass' ? 'adv-rail-pass' :
            rail.lastResult === 'fail' ? 'adv-rail-fail' :
            rail.lastResult === 'warn' ? 'adv-rail-warn' :
            'adv-rail-none';
          const resultText =
            rail.lastResult === 'pass' ? '✓' :
            rail.lastResult === 'fail' ? '✗' :
            rail.lastResult === 'warn' ? '~' : '–';
          const stepCount = Array.isArray(rail.steps) ? rail.steps.length : 0;

          const editForm = el('div', { className: 'adv-rail-edit-form adv-hidden' });

          const populateEditForm = (currentRail, isNew = false) => {
            editForm.innerHTML = '';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'adv-rail-input';
            nameInput.value = currentRail.name;
            nameInput.placeholder = 'Rail name';

            const descTA = el('textarea', { className: 'adv-rail-textarea', rows: '2', placeholder: 'What does this rail verify?' });
            descTA.value = currentRail.description || '';

            const stepsTA = el('textarea', { className: 'adv-rail-steps-textarea', rows: '10', placeholder: '[]', spellcheck: 'false' });
            stepsTA.value = JSON.stringify(currentRail.steps || [], null, 2);

            const criticalCb = document.createElement('input');
            criticalCb.type = 'checkbox';
            criticalCb.className = 'adv-rail-critical-cb';
            criticalCb.id = `adv-rail-crit-${currentRail.id}`;
            criticalCb.checked = currentRail.critical !== false;

            const criticalRow = el('div', { className: 'adv-rail-critical-row' },
              criticalCb,
              el('label', { htmlFor: `adv-rail-crit-${currentRail.id}`, className: 'adv-rail-critical-label' },
                '● Run every cycle (critical) — uncheck to run periodically',
              ),
            );

            const formStatus = el('span', { className: 'adv-soul-status' });

            const saveBtn = el('button', { className: 'adv-soul-save-btn', type: 'button',
              onClick: async () => {
                let steps;
                try { steps = JSON.parse(stepsTA.value); }
                catch { formStatus.textContent = 'Invalid JSON'; formStatus.className = 'adv-soul-status adv-soul-status-err'; return; }

                const updated = { ...currentRail, name: nameInput.value.trim() || currentRail.name, description: descTA.value.trim(), steps, critical: criticalCb.checked };
                saveBtn.disabled = true;
                formStatus.textContent = 'Saving…';
                formStatus.className = 'adv-soul-status';
                try {
                  const currentList = localRails[projectId] || [];
                  const idx = currentList.findIndex(r => r.id === updated.id);
                  const newList = idx >= 0
                    ? currentList.map((r, i) => i === idx ? updated : r)
                    : [...currentList, updated];
                  await writeProjectRails(projectId, newList);
                  setStatus('Saved');
                  rebuildContent();
                } catch (err) {
                  formStatus.textContent = 'Error: ' + err.message;
                  formStatus.className = 'adv-soul-status adv-soul-status-err';
                  saveBtn.disabled = false;
                }
              },
            }, 'Save');

            const cancelBtn = el('button', { className: 'adv-soul-reset-btn', type: 'button',
              onClick: () => {
                if (isNew) { editForm.remove(); }
                else { editForm.classList.add('adv-hidden'); }
              },
            }, 'Cancel');

            editForm.appendChild(el('div', { className: 'adv-rail-edit-fields' },
              el('label', { className: 'adv-rail-edit-label' }, 'Name'), nameInput,
              el('label', { className: 'adv-rail-edit-label' }, 'Description'), descTA,
              criticalRow,
              el('label', { className: 'adv-rail-edit-label' }, 'Steps (JSON array of step objects)'), stepsTA,
            ));
            editForm.appendChild(el('div', { className: 'adv-rail-edit-footer' }, formStatus,
              el('div', { className: 'adv-soul-modal-footer-right' }, cancelBtn, saveBtn),
            ));
          };

          const editBtn = el('button', { className: 'adv-rail-btn', type: 'button',
            onClick: () => {
              if (editForm.classList.contains('adv-hidden')) {
                populateEditForm(rail);
                editForm.classList.remove('adv-hidden');
              } else {
                editForm.classList.add('adv-hidden');
              }
            },
          }, 'Edit');

          const delBtn = el('button', { className: 'adv-rail-btn adv-rail-btn-del', type: 'button',
            onClick: async () => {
              const newList = (localRails[projectId] || []).filter(r => r.id !== rail.id);
              try {
                await writeProjectRails(projectId, newList);
                setStatus('Rail deleted');
                rebuildContent();
              } catch (err) {
                setStatus('Error: ' + err.message, true);
              }
            },
          }, '×');

          const isCritical = rail.critical !== false;
          const metaParts = [`${stepCount} step${stepCount !== 1 ? 's' : ''}`];
          if (rail.addedByFeature) metaParts.push(rail.addedByFeature);
          if (rail.lastRunAt) {
            const ago = Math.round((Date.now() - new Date(rail.lastRunAt)) / 60000);
            metaParts.push(`ran ${ago < 2 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`}`);
          }

          const row = el('div', { className: 'adv-rail-row' },
            el('span', { className: `adv-rail-result ${resultClass}`, title: rail.lastResult || 'not run' }, resultText),
            el('span', {
              className: `adv-rail-freq ${isCritical ? 'adv-rail-freq-critical' : 'adv-rail-freq-periodic'}`,
              title: isCritical ? 'Runs every cycle' : 'Runs periodically',
            }, isCritical ? '●' : '○'),
            el('span', { className: 'adv-rail-name' }, rail.name),
            el('span', { className: 'adv-rail-meta' }, metaParts.join(' · ')),
            el('div', { className: 'adv-rail-actions' }, editBtn, delBtn),
          );

          return el('div', { className: 'adv-rail-wrapper' }, row, editForm);
        };

        for (const rail of rails) {
          railsListEl.appendChild(buildRailRow(rail));
        }

        const addBtn = el('button', { className: 'adv-rails-add-btn', type: 'button',
          onClick: () => {
            const newRail = {
              id: `rail-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
              name: 'New Test Rail',
              description: '',
              steps: [],
              addedAt: new Date().toISOString(),
              addedByFeature: null,
              lastRunAt: null,
              lastResult: null,
              critical: true,
            };
            const addForm = el('div', { className: 'adv-rail-edit-form adv-rail-add-form' });
            const nameInput = document.createElement('input');
            nameInput.type = 'text'; nameInput.className = 'adv-rail-input';
            nameInput.value = newRail.name; nameInput.placeholder = 'Rail name';

            const descTA = el('textarea', { className: 'adv-rail-textarea', rows: '2', placeholder: 'What does this rail verify?' });

            const stepsTA = el('textarea', { className: 'adv-rail-steps-textarea', rows: '10', placeholder: '[]', spellcheck: 'false' });
            stepsTA.value = '[]';

            const addCritCb = document.createElement('input');
            addCritCb.type = 'checkbox'; addCritCb.className = 'adv-rail-critical-cb';
            addCritCb.id = `adv-rail-crit-new-${Date.now()}`; addCritCb.checked = true;
            const addCritRow = el('div', { className: 'adv-rail-critical-row' },
              addCritCb,
              el('label', { htmlFor: addCritCb.id, className: 'adv-rail-critical-label' },
                '● Run every cycle (critical) — uncheck to run periodically',
              ),
            );

            const formStatus = el('span', { className: 'adv-soul-status' });

            const saveBtn = el('button', { className: 'adv-soul-save-btn', type: 'button',
              onClick: async () => {
                let steps;
                try { steps = JSON.parse(stepsTA.value); }
                catch { formStatus.textContent = 'Invalid JSON'; formStatus.className = 'adv-soul-status adv-soul-status-err'; return; }
                const newEntry = { ...newRail, name: nameInput.value.trim() || newRail.name, description: descTA.value.trim(), steps, critical: addCritCb.checked };
                saveBtn.disabled = true;
                try {
                  const newList = [...(localRails[projectId] || []), newEntry];
                  await writeProjectRails(projectId, newList);
                  setStatus('Rail added');
                  rebuildContent();
                } catch (err) {
                  formStatus.textContent = 'Error: ' + err.message;
                  formStatus.className = 'adv-soul-status adv-soul-status-err';
                  saveBtn.disabled = false;
                }
              },
            }, 'Save');

            const cancelBtn = el('button', { className: 'adv-soul-reset-btn', type: 'button',
              onClick: () => addForm.remove(),
            }, 'Cancel');

            addForm.appendChild(el('div', { className: 'adv-rail-edit-fields' },
              el('label', { className: 'adv-rail-edit-label' }, 'Name'), nameInput,
              el('label', { className: 'adv-rail-edit-label' }, 'Description'), descTA,
              addCritRow,
              el('label', { className: 'adv-rail-edit-label' }, 'Steps (JSON array of step objects)'), stepsTA,
            ));
            addForm.appendChild(el('div', { className: 'adv-rail-edit-footer' }, formStatus,
              el('div', { className: 'adv-soul-modal-footer-right' }, cancelBtn, saveBtn),
            ));
            railsListEl.appendChild(addForm);
            nameInput.focus();
          },
        }, '+ Add Rail');

        contentEl.appendChild(el('div', { className: 'adv-rails-project' },
          el('div', { className: 'adv-rails-project-header' },
            el('span', { className: 'adv-rails-project-name' }, projectId),
            addBtn,
          ),
          railsListEl,
        ));
      }
    };

    rebuildContent();

    modal.appendChild(contentEl);
    modal.appendChild(statusEl);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._testRailsModal = overlay;

    // Update button state
    const card = this._cards['qa'];
    if (card?.testRailsBtn) card.testRailsBtn.textContent = 'Test Rails ▾';
  }

  _closeTestRailsModal() {
    if (this._testRailsModal) {
      if (this._testRailsModal.parentNode) this._testRailsModal.parentNode.removeChild(this._testRailsModal);
      this._testRailsModal = null;
    }
    const card = this._cards['qa'];
    if (card?.testRailsBtn) card.testRailsBtn.textContent = 'Test Rails ▸';
  }

  // ── Custom persona rendering ─────────────────────────────────

  /**
   * Render custom persona cards into the custom personas body container.
   * Called whenever the /advisorPersonas collection snapshot updates.
   */
  _renderCustomPersonas() {
    if (!this._customPersonasBody) return;
    this._customPersonasBody.innerHTML = '';

    // Update Add button's disabled state based on cap
    const MAX_CUSTOM_PERSONAS = 10;
    if (this._addPersonaBtn) {
      const atCap = this._customPersonas.length >= MAX_CUSTOM_PERSONAS;
      this._addPersonaBtn.disabled = atCap;
      this._addPersonaBtn.title = atCap
        ? `Maximum of ${MAX_CUSTOM_PERSONAS} custom personas reached`
        : 'Create a new custom persona';
    }

    if (this._customPersonas.length === 0) {
      this._customPersonasBody.appendChild(
        el('div', { className: 'adv-custom-empty' },
          'No custom personas yet. Click "+ Add Persona" to create one.'
        )
      );
      return;
    }

    // Aggregate volume warning — shown when >3 personas are enabled with intervals < 12h.
    // Stored in a dedicated container so it can be updated without re-rendering cards.
    const warningContainer = el('div', { className: 'adv-volume-warning-container' });
    this._volumeWarningEl = warningContainer;
    this._updateVolumeWarning();
    this._customPersonasBody.appendChild(warningContainer);

    for (const persona of this._customPersonas) {
      const pid = persona.id || persona._docId;
      this._customPersonasBody.appendChild(this._buildCustomPersonaCard(persona, pid));
    }
  }

  /**
   * Update the volume warning element in place (without re-rendering persona cards).
   * Called when persona states change.
   */
  _updateVolumeWarning() {
    if (!this._volumeWarningEl) return;
    this._volumeWarningEl.innerHTML = '';
    const warning = this._buildVolumeWarning();
    if (warning) {
      this._volumeWarningEl.appendChild(warning);
    }
  }

  /**
   * Build the aggregate volume warning element if conditions are met.
   * Triggered when there are more than 3 personas enabled with intervals < 12h.
   * Returns null if no warning is needed.
   *
   * @returns {HTMLElement|null}
   */
  _buildVolumeWarning() {
    const HIGH_VOLUME_PERSONA_THRESHOLD = 3;
    const HIGH_VOLUME_INTERVAL_THRESHOLD_H = 12;

    // Count enabled personas with short intervals across built-ins + custom
    let highFrequencyCount = 0;
    let minIntervalH = Infinity;

    // Check built-in personas
    for (const { id, defaultHours } of PERSONAS) {
      const state = this._states[id];
      if (!state || state.status === 'paused') continue; // skip disabled
      const intervalH = state.intervalHours ?? defaultHours;
      if (intervalH < HIGH_VOLUME_INTERVAL_THRESHOLD_H) {
        highFrequencyCount++;
        minIntervalH = Math.min(minIntervalH, intervalH);
      }
    }

    // Check custom personas
    for (const persona of this._customPersonas) {
      const pid = persona.id || persona._docId;
      const state = this._states[pid];
      if (state?.status === 'paused') continue; // skip disabled
      // Use persona doc's intervalHours as source of truth for custom personas
      const intervalH = state?.intervalHours ?? persona.intervalHours ?? 24;
      if (intervalH < HIGH_VOLUME_INTERVAL_THRESHOLD_H) {
        highFrequencyCount++;
        minIntervalH = Math.min(minIntervalH, intervalH);
      }
    }

    if (highFrequencyCount <= HIGH_VOLUME_PERSONA_THRESHOLD) return null;
    if (minIntervalH === Infinity) return null;

    const intervalLabel = minIntervalH < 1
      ? `${Math.round(minIntervalH * 60)}m`
      : `${minIntervalH}h`;

    return el('div', {
      className: 'adv-volume-warning',
      role: 'alert',
    },
      el('span', { className: 'adv-volume-warning-icon', 'aria-hidden': 'true' }, '⚠'),
      ` High ticket volume expected — ${highFrequencyCount} personas running every ${intervalLabel}.`,
    );
  }

  /**
   * Build a status card for a custom persona.
   * Mirrors the built-in persona card layout but adds a "Custom" badge
   * and edit/delete controls.
   *
   * @param {object} persona - Custom persona definition from Firestore /advisorPersonas
   * @param {string} pid - Stable persona ID (slugified name)
   */
  _buildCustomPersonaCard(persona, pid) {
    const card = el('div', { className: 'adv-card adv-card-custom' });

    // ── Collapse toggle ────────────────────────────────────────
    const isInitiallyCollapsed = this._collapsedPersonas.has(pid);
    const collapseBtn = el('button', {
      className: 'adv-collapse-btn',
      title: isInitiallyCollapsed ? 'Expand' : 'Collapse',
      'aria-expanded': String(!isInitiallyCollapsed),
      'aria-controls': `adv-card-body-${pid}`,
      onClick: () => this._toggleCardCollapse(pid),
    }, isInitiallyCollapsed ? '▸' : '▾');

    // ── Card header ────────────────────────────────────────────
    const statusDot  = el('span', { className: 'adv-dot adv-dot-unknown', title: 'Advisor offline' });
    const statusText = el('span', { className: 'adv-status-text' }, 'Waiting…');

    // "Custom" badge — text label so it's not color-only
    const customBadge = el('span', {
      className: 'adv-custom-badge',
      'aria-label': 'Custom persona',
    }, 'Custom');

    // Edit button
    const editBtn = el('button', {
      className: 'adv-custom-edit-btn',
      title: `Edit ${persona.name}`,
      onClick: () => this._openCustomPersonaModal(pid),
    }, 'Edit');

    // Pause toggle — checkbox + adjacent text (same pattern as built-in cards)
    // aria-label includes the persona name per spec: "Enable <Name> persona"
    const customPauseCheckboxId = `adv-pause-${pid}`;
    const customPauseCheckbox = el('input', {
      type: 'checkbox',
      className: 'adv-pause-checkbox',
      id: customPauseCheckboxId,
      'aria-label': `Enable ${persona.name || pid} persona`,
      title: 'Pause / Resume this persona',
      onChange: () => this._togglePause(pid),
    });
    const customPauseTextEl = el('span', { className: 'adv-pause-text' }, 'Active');
    const pauseBtn = el('label', {
      className: 'adv-pause-label',
      htmlFor: customPauseCheckboxId,
    }, customPauseCheckbox, customPauseTextEl);

    // Run now button — opens inline prompt expander (DK-321)
    const runNowBtn = el('button', {
      className: 'adv-run-now-btn',
      'aria-label': `Run ${persona.name || pid} persona now`,
      'aria-expanded': 'false',
      'aria-controls': `adv-run-prompt-${pid}`,
      title: 'Run now',
      onClick: () => this._toggleRunPrompt(pid),
    }, 'Run Now');

    // Run state label
    const runStateEl = el('div', {
      className: 'adv-run-state',
      'aria-live': 'polite',
      role: 'status',
    });

    const timeHintEl = el('span', { className: 'adv-run-time-hint' }, 'Usually 30–60s');

    card.appendChild(
      el('div', { className: 'adv-card-header' },
        el('div', { className: 'adv-card-header-left' },
          collapseBtn,
          statusDot,
          el('span', { className: 'adv-persona-label' }, persona.name || pid),
          customBadge,
          statusText,
        ),
        el('div', { className: 'adv-card-header-right' },
          editBtn,
          runNowBtn,
          pauseBtn,
        ),
      )
    );

    // ── Card body (collapsible) ────────────────────────────────
    const cardBody = el('div', {
      className: 'adv-card-body' + (isInitiallyCollapsed ? ' adv-hidden' : ''),
      id: `adv-card-body-${pid}`,
    });
    if (isInitiallyCollapsed) card.classList.add('adv-card-collapsed');
    card.appendChild(cardBody);

    // ── Persona title (always visible in body) ────────────────
    cardBody.appendChild(el('div', { className: 'adv-card-body-title' }, `${persona.name || pid} Advisor`));

    // ── Description: focus areas ───────────────────────────────
    const focusAreas = persona.focusAreas || [];
    if (focusAreas.length > 0) {
      const descEl = el('div', { className: 'adv-custom-desc' });
      const list = el('ul', { className: 'adv-custom-focus-list' });
      for (const area of focusAreas) {
        list.appendChild(el('li', {}, area));
      }
      descEl.appendChild(list);
      cardBody.appendChild(descEl);
    }

    // ── Focus prompt area ──────────────────────────────────────
    const customFocusCounter = el('span', { className: 'adv-focus-counter' }, '0 / 256');

    const customFocusTextarea = el('textarea', {
      className: 'adv-focus-textarea',
      id: `adv-focus-${pid}`,
      placeholder: 'e.g. review the advisor deduplication logic',
      maxlength: '256',
      rows: '2',
      onInput: () => {
        const len = customFocusTextarea.value.length;
        customFocusCounter.textContent = `${len} / 256`;
        customFocusCounter.className = 'adv-focus-counter' + (len > 240 ? ' adv-focus-counter-warn' : '');
      },
    });

    const customChipsEl = el('div', { className: 'adv-focus-chips adv-hidden' });

    // Focus area starts expanded by default (primary control); only collapses after
    // a focus prompt has been saved. The toggle lets users re-collapse/expand manually.
    const customFocusToggleBtn = el('button', {
      className: 'adv-focus-toggle',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `adv-focus-area-${pid}`,
      onClick: () => {
        const isExpanded = customFocusToggleBtn.getAttribute('aria-expanded') === 'true';
        customFocusToggleBtn.setAttribute('aria-expanded', String(!isExpanded));
        customFocusArea.classList.toggle('adv-focus-area-open', !isExpanded);
        const savedText = customFocusToggleBtn.dataset.savedFocus || '';
        if (isExpanded) {
          // Collapsing — show preview if there's a saved prompt
          customFocusToggleBtn.textContent = savedText ? 'Focus● ▸' : 'Focus ▸';
          customFocusToggleBtn.title = savedText
            ? `Saved focus active: "${savedText}"`
            : 'Set a focus area for the next run';
          // Show inline preview when collapsing
          const previewEl = this._cards[pid]?.focusPreviewEl;
          if (previewEl && savedText) {
            const maxLen = 40;
            const preview = savedText.length > maxLen ? savedText.slice(0, maxLen) + '…' : savedText;
            previewEl.textContent = preview;
            previewEl.title = savedText;
            previewEl.className = 'adv-focus-preview';
          }
        } else {
          // Expanding — hide preview
          customFocusToggleBtn.textContent = savedText ? 'Focus● ▾' : 'Focus ▾';
          const previewEl = this._cards[pid]?.focusPreviewEl;
          if (previewEl) {
            previewEl.textContent = '';
            previewEl.className = 'adv-focus-preview adv-hidden';
          }
          customFocusTextarea.focus();
        }
        this._focusManuallyToggled = this._focusManuallyToggled || {};
        this._focusManuallyToggled[pid] = true;
      },
    }, 'Focus ▾');

    // Unsaved-changes dot — shown while the user is typing before auto-save fires (DK-315).
    const customFocusDirtyDot = el('span', {
      className: 'adv-focus-dirty-dot adv-hidden',
      title: 'Unsaved changes — will auto-save shortly',
      'aria-hidden': 'true',
    }, '●');

    const customSavedFocusEl = el('div', { className: 'adv-saved-focus adv-hidden' });

    const customFocusArea = el('div', {
      className: 'adv-focus-area adv-focus-area-open',
      id: `adv-focus-area-${pid}`,
    },
      el('div', { className: 'adv-focus-header' },
        el('label', { className: 'adv-focus-label', htmlFor: `adv-focus-${pid}` }, 'Focus area (optional)'),
        customFocusCounter,
      ),
      customFocusTextarea,
      customChipsEl,
      el('div', { className: 'adv-focus-actions' },
        customFocusDirtyDot,
        customSavedFocusEl,
      ),
    );

    // Attach auto-save behavior (DK-315): debounce-on-input (800ms) + save on blur.
    const customFocusSaveControl = createSaveOnBlur({
      element: customFocusTextarea,
      onSave: async (value) => {
        await this._autoSaveFocusPrompt(pid, value);
      },
      debounceMs: 800,
      autoSaveOnInput: true,
      showIndicator: true,
      indicatorPosition: 'inline',
      autoFadeAfterMs: 2000,
      onDirtyChange: (dirty) => {
        customFocusDirtyDot.classList.toggle('adv-hidden', !dirty);
      },
    });
    this._focusSaveControls[pid] = customFocusSaveControl;

    // ── Inline Run-prompt expander (DK-321) ───────────────────────────────
    const customRunPromptHintId = `adv-run-prompt-hint-${pid}`;
    const customRunPromptInput = el('input', {
      type: 'text',
      className: 'adv-run-prompt-input',
      placeholder: 'focus on the new auth module',
      maxlength: '150',
      'aria-label': 'Optional focus for this run only',
      'aria-describedby': customRunPromptHintId,
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submitRunPrompt(pid); }
        if (e.key === 'Escape') { e.preventDefault(); this._closeRunPrompt(pid); }
      },
    });
    const customRunPromptCounter = el('span', { className: 'adv-run-prompt-counter' }, '0 / 150');
    customRunPromptInput.addEventListener('input', () => {
      const len = customRunPromptInput.value.length;
      customRunPromptCounter.textContent = `${len} / 150`;
      customRunPromptCounter.className = 'adv-run-prompt-counter' + (len > 130 ? ' adv-run-prompt-counter-warn' : '');
    });
    const customRunPromptSubmitBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-submit',
      onClick: () => this._submitRunPrompt(pid),
    }, 'Run');
    const customRunPromptCancelBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-cancel',
      onClick: () => this._closeRunPrompt(pid),
    }, 'Cancel');
    const customRunPromptExpander = el('div', {
      className: 'adv-run-prompt-expander adv-hidden',
      id: `adv-run-prompt-${pid}`,
      role: 'group',
      'aria-label': 'Run with optional focus prompt',
    },
      el('div', { className: 'adv-run-prompt-header' },
        el('span', { className: 'adv-run-prompt-hint', id: customRunPromptHintId }, 'Optional — override for this run only'),
        customRunPromptCounter,
      ),
      customRunPromptInput,
      el('div', { className: 'adv-run-prompt-actions' },
        customRunPromptSubmitBtn,
        customRunPromptCancelBtn,
      ),
    );

    cardBody.appendChild(customRunPromptExpander);
    cardBody.appendChild(
      el('div', { className: 'adv-focus-row' },
        el('div', { className: 'adv-run-state-row' },
          runStateEl,
          timeHintEl,
        ),
      )
    );
    cardBody.appendChild(customFocusArea);

    // ── Last activity ──────────────────────────────────────────
    const activityEl = el('div', { className: 'adv-activity' }, '—');
    cardBody.appendChild(activityEl);

    // ── Recent output snippets ─────────────────────────────────
    // Shows last run summary so user can see if persona is producing useful output
    const runSummaryEl = el('div', { className: 'adv-run-summary' }, 'No runs yet');
    cardBody.appendChild(runSummaryEl);

    // ── Footer: next run info ──────────────────────────────────
    // aria-live="polite" so updates are announced to screen readers
    const countdownEl = el('span', {
      className: 'adv-countdown',
      'aria-live': 'polite',
    }, '—');

    // Show schedule label from intervalHours
    const intervalHours = persona.intervalHours || 24;
    const scheduleLabel = this._hoursToScheduleLabel(intervalHours);
    const scheduleEl = el('span', { className: 'adv-custom-schedule' }, scheduleLabel);

    cardBody.appendChild(
      el('div', { className: 'adv-card-footer' },
        el('div', { className: 'adv-countdown-row' },
          el('span', { className: 'adv-countdown-label' }, 'Next run'),
          countdownEl,
        ),
        el('div', { className: 'adv-custom-schedule-row' },
          el('span', { className: 'adv-interval-label' }, 'Schedule'),
          scheduleEl,
        ),
      )
    );

    // ── Performance subsection (custom card, collapsible) ───────
    // Starts collapsed by default (expanded key absent from set)
    const customPerfSectionKey = `${pid}:performance`;
    const customPerfSectionExpanded = this._collapsedCardSections.has(customPerfSectionKey);
    const customPerfChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, customPerfSectionExpanded ? '▾' : '▸');
    const customPerfSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(customPerfSectionExpanded),
      'aria-controls': `adv-perf-section-${pid}`,
      onClick: () => this._toggleCardSection(customPerfSectionKey, customPerfSectionBody, customPerfChevron, customPerfSectionHeader),
    },
      customPerfChevron,
      el('span', {}, 'Performance'),
    );
    cardBody.appendChild(customPerfSectionHeader);

    const customPerfSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-perf-section-${pid}`,
    });
    if (!customPerfSectionExpanded) customPerfSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(customPerfSectionBody);

    // ── Stats row ──────────────────────────────────────────────
    const ticketsEl = el('span', { className: 'adv-stat-val' }, '0');
    const cyclesEl  = el('span', { className: 'adv-stat-val' }, '0');

    customPerfSectionBody.appendChild(
      el('div', { className: 'adv-stats' },
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Tickets '),
          ticketsEl,
        ),
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Cycles '),
          cyclesEl,
        ),
      )
    );

    // ── Activity subsection (custom card, collapsible) ──────────
    // Starts collapsed by default (expanded key absent from set)
    const customActSectionKey = `${pid}:activity`;
    const customActSectionExpanded = this._collapsedCardSections.has(customActSectionKey);
    const customActChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, customActSectionExpanded ? '▾' : '▸');
    const customActSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(customActSectionExpanded),
      'aria-controls': `adv-act-section-${pid}`,
      onClick: () => this._toggleCardSection(customActSectionKey, customActSectionBody, customActChevron, customActSectionHeader),
    },
      customActChevron,
      el('span', {}, 'Activity'),
    );
    cardBody.appendChild(customActSectionHeader);

    const customActSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-act-section-${pid}`,
    });
    if (!customActSectionExpanded) customActSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(customActSectionBody);

    // ── Per-card history (collapsed by default) ─────────────────
    const customHistoryToggleBtn = el('button', {
      className: 'adv-card-history-toggle',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `adv-card-history-${pid}`,
      onClick: () => this._toggleCardHistory(pid),
    }, 'History ▸');

    const customHistoryRefreshBtn = el('button', {
      className: 'adv-history-refresh-btn adv-hidden',
      title: 'Refresh run history',
      'aria-label': 'Refresh history',
      onClick: () => this._loadHistoryRuns(pid),
    }, '↺');

    // Inline preview of the saved focus prompt — visible when focus area is collapsed
    // and a saved focus prompt is set. Hidden when expanded or no saved prompt.
    const customFocusPreviewEl = el('span', {
      className: 'adv-focus-preview adv-hidden',
      'aria-hidden': 'true',
    });

    const customHistoryHeaderRow = el('div', { className: 'adv-card-history-header' },
      customFocusToggleBtn,
      customFocusPreviewEl,
      customHistoryToggleBtn,
      customHistoryRefreshBtn,
    );

    const customHistoryPanel = el('div', {
      className: 'adv-card-history-panel adv-hidden',
      id: `adv-card-history-${pid}`,
    });
    this._historyPanels[pid] = customHistoryPanel;

    customActSectionBody.appendChild(customHistoryHeaderRow);
    customActSectionBody.appendChild(customHistoryPanel);

    // Store card refs for live updates from _renderCard()
    this._cards[pid] = {
      card,
      cardBody,
      collapseBtn,
      avatarEl: null,
      statusDot,
      statusText,
      soulBtn: null,
      pauseBtn,
      pauseCheckbox: customPauseCheckbox,
      pauseTextEl: customPauseTextEl,
      runNowBtn,
      runPromptExpander: customRunPromptExpander,
      runPromptInput: customRunPromptInput,
      runPromptSubmitBtn: customRunPromptSubmitBtn,
      runPromptCancelBtn: customRunPromptCancelBtn,
      runStateEl,
      timeHintEl,
      focusTextarea: customFocusTextarea,
      focusToggleBtn: customFocusToggleBtn,
      focusPreviewEl: customFocusPreviewEl,
      focusDirtyDot: customFocusDirtyDot,
      savedFocusEl: customSavedFocusEl,
      activityEl,
      logToggleBtn: null,
      logContainer: null,
      logList: null,
      countdownEl,
      intervalInput: null,
      ticketsEl,
      cyclesEl,
      runSummaryEl,
      scheduleEl,
      historyToggleBtn: customHistoryToggleBtn,
      historyRefreshBtn: customHistoryRefreshBtn,
      historyPanel: customHistoryPanel,
    };

    return card;
  }

  /** Convert intervalHours to a human-readable schedule label. */
  _hoursToScheduleLabel(hours) {
    for (const preset of SCHEDULE_PRESETS) {
      if (preset.hours === hours) return preset.label;
    }
    return `Every ${hours}h`;
  }

  // ── Custom persona modal ──────────────────────────────────────

  /**
   * Open the single-scroll custom persona create/edit modal.
   * All fields (Name, Focus, Prompt, Model, Schedule) are shown at once
   * with a live preview card in the right panel.
   *
   * @param {string|null} personaId - null to create new, string to edit existing
   */
  _openCustomPersonaModal(personaId) {
    this._closeCustomModal();

    // Find existing persona data if editing
    const existing = personaId
      ? this._customPersonas.find(p => (p.id || p._docId) === personaId)
      : null;

    // State for the modal form
    const formState = {
      name: existing?.name || '',
      systemPrompt: existing?.systemPrompt || CUSTOM_PERSONA_STARTER,
      model: existing?.model || 'claude-sonnet-4-6',
      intervalHours: existing?.intervalHours || 24,
      focusAreas: existing?.focusAreas ? existing.focusAreas.join(', ') : '',
      isEditing: !!existing,
      originalId: personaId || null,
    };

    // Overlay
    const overlay = el('div', {
      className: 'adv-custom-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeCustomModal(); },
    });

    // Modal box (wider to accommodate side-by-side layout)
    const modal = el('div', {
      className: 'adv-custom-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-custom-modal-title',
    });
    overlay.appendChild(modal);

    // Header
    const titleEl = el('div', {
      className: 'adv-custom-modal-title',
      id: 'adv-custom-modal-title',
    }, formState.isEditing ? `Edit "${existing.name}"` : 'New Custom Persona');

    const closeBtn = el('button', {
      className: 'adv-soul-modal-close',
      title: 'Close',
      'aria-label': 'Close modal',
      onClick: () => this._closeCustomModal(),
    }, '×');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' }, titleEl, closeBtn)
    );

    // Live preview card
    const previewCard = el('div', { className: 'adv-card adv-card-custom adv-card-preview' });
    const previewPane = el('div', { className: 'adv-custom-preview-pane' },
      el('div', { className: 'adv-custom-preview-label' }, 'Preview'),
      previewCard,
    );

    // Single-scroll form (all fields visible at once)
    const formPane = el('div', { className: 'adv-custom-form-pane' });
    this._renderCustomModalForm(formPane, previewCard, formState);

    // Two-column body: form | preview
    modal.appendChild(
      el('div', { className: 'adv-custom-modal-body' }, formPane, previewPane)
    );

    // Footer with status + action buttons
    const statusEl = el('span', { className: 'adv-soul-status' });

    const saveBtn = el('button', {
      className: 'adv-custom-save-btn',
      onClick: async () => {
        await this._saveCustomPersona(formState, saveBtn, statusEl);
      },
    }, formState.isEditing ? 'Save Changes' : 'Create Persona');

    // Delete button (only shown when editing)
    let deleteBtn = null;
    if (formState.isEditing) {
      deleteBtn = el('button', {
        className: 'adv-custom-delete-btn',
        onClick: () => this._confirmDeleteCustomPersona(personaId, existing.name),
      }, 'Delete');
    }

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          deleteBtn,
          saveBtn,
        ),
      )
    );

    // Initialize preview card
    this._updatePreviewCard(previewCard, formState);

    document.body.appendChild(overlay);
    this._customModal = overlay;

    // Focus the first input
    setTimeout(() => {
      const firstInput = modal.querySelector('input, textarea, select');
      if (firstInput) firstInput.focus();
    }, 50);
  }

  /**
   * Render all form fields into the given container.
   * All sections (Name & Role, Prompt/Instructions, Schedule defaults) are
   * rendered at once in a single scrollable column — no step navigation needed.
   */
  _renderCustomModalForm(formPane, previewCard, formState) {
    // ── Section: Name & Role ──────────────────────────────────

    formPane.appendChild(
      el('div', { className: 'adv-custom-section-heading' }, 'Name & Role')
    );

    // Name field
    const nameLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-name',
    }, 'Persona Name');
    const nameInput = el('input', {
      id: 'adv-custom-name',
      className: 'adv-custom-input',
      type: 'text',
      placeholder: 'e.g. Accessibility, i18n, SEO…',
      maxlength: '64',
      value: formState.name,
    });
    nameInput.addEventListener('input', () => {
      formState.name = nameInput.value;
      this._updatePreviewCard(previewCard, formState);
    });

    formPane.appendChild(nameLabel);
    formPane.appendChild(nameInput);

    // Focus areas field
    const focusLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-focus',
    }, 'Focus Areas (comma-separated, optional)');
    const focusInput = el('input', {
      id: 'adv-custom-focus',
      className: 'adv-custom-input',
      type: 'text',
      placeholder: 'e.g. WCAG 2.1 AA, keyboard navigation, color contrast',
      value: formState.focusAreas,
    });
    focusInput.addEventListener('input', () => {
      formState.focusAreas = focusInput.value;
      this._updatePreviewCard(previewCard, formState);
    });

    formPane.appendChild(focusLabel);
    formPane.appendChild(focusInput);

    // ── Section: Prompt / Instructions ───────────────────────

    formPane.appendChild(
      el('div', { className: 'adv-custom-section-heading' }, 'Prompt / Instructions')
    );

    // System prompt field
    const promptLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-prompt',
    }, 'System Prompt');

    // "View built-in example" link — opens Engineer persona's system prompt read-only.
    // Primary tool for reducing blank-page paralysis (spec requirement).
    const viewExampleBtn = el('button', {
      className: 'adv-custom-example-link',
      type: 'button',
      title: 'See an example of a built-in persona prompt',
      onClick: () => this._openBuiltInExampleModal(),
    }, 'View built-in example ▸');

    const promptLabelRow = el('div', { className: 'adv-custom-label-row' },
      promptLabel,
      viewExampleBtn,
    );

    const promptCharCount = el('span', { className: 'adv-custom-char-count' }, `${formState.systemPrompt.length} chars`);
    const promptHint = el('div', { className: 'adv-custom-hint' },
      'Defines what this persona reviews and how it reasons. Pre-filled with a starter template.'
    );
    const promptTextarea = el('textarea', {
      id: 'adv-custom-prompt',
      className: 'adv-custom-textarea',
      rows: '8',
      placeholder: 'Describe the persona\'s focus and review criteria…',
    });
    promptTextarea.value = formState.systemPrompt;
    promptTextarea.addEventListener('input', () => {
      formState.systemPrompt = promptTextarea.value;
      promptCharCount.textContent = `${promptTextarea.value.length} chars`;
      this._updatePreviewCard(previewCard, formState);
    });

    // "Preview prompt" button — shows the assembled prompt (system prompt + context bundle).
    const previewPromptBtn = el('button', {
      className: 'adv-custom-preview-prompt-btn',
      type: 'button',
      title: 'Preview the full prompt that will be sent to the model',
      onClick: () => this._openPromptPreviewModal(formState),
    }, 'Preview prompt');

    formPane.appendChild(promptLabelRow);
    formPane.appendChild(promptHint);
    formPane.appendChild(promptTextarea);
    formPane.appendChild(
      el('div', { className: 'adv-custom-prompt-footer' },
        promptCharCount,
        previewPromptBtn,
      )
    );

    // ── Section: Schedule defaults ───────────────────────────

    formPane.appendChild(
      el('div', { className: 'adv-custom-section-heading' }, 'Schedule defaults')
    );

    // Model selection
    const modelLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-model',
    }, 'Model');

    const modelSelect = el('select', {
      id: 'adv-custom-model',
      className: 'adv-custom-select',
    });
    for (const { value, label } of CUSTOM_PERSONA_MODELS) {
      const opt = el('option', { value }, label);
      if (value === formState.model) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    modelSelect.addEventListener('change', () => {
      formState.model = modelSelect.value;
      this._updatePreviewCard(previewCard, formState);
    });

    formPane.appendChild(modelLabel);
    formPane.appendChild(modelSelect);

    // Schedule selection
    const scheduleLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-schedule',
    }, 'Schedule');

    const scheduleHint = el('div', { className: 'adv-custom-hint' },
      'Minimum interval is every 1 hour.'
    );

    const scheduleSelect = el('select', {
      id: 'adv-custom-schedule',
      className: 'adv-custom-select',
    });

    // Check if current intervalHours matches a preset
    const matchedPreset = SCHEDULE_PRESETS.find(p => p.hours === formState.intervalHours);
    const isCustom = !matchedPreset || matchedPreset.hours === null;

    for (const preset of SCHEDULE_PRESETS) {
      const opt = el('option', { value: preset.hours !== null ? String(preset.hours) : 'custom' }, preset.label);
      if ((preset.hours === formState.intervalHours) || (preset.hours === null && isCustom)) {
        opt.selected = true;
      }
      scheduleSelect.appendChild(opt);
    }

    // Custom hours input (shown only when "Custom…" is selected)
    const customHoursWrapper = el('div', { className: 'adv-custom-hours-wrapper' });
    const customHoursLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-hours',
    }, 'Custom interval (hours, minimum 1)');
    const customHoursInput = el('input', {
      id: 'adv-custom-hours',
      className: 'adv-custom-input',
      type: 'number',
      min: '1',
      max: '8760',
      value: String(formState.intervalHours),
    });
    customHoursWrapper.appendChild(customHoursLabel);
    customHoursWrapper.appendChild(customHoursInput);
    customHoursWrapper.style.display = isCustom ? '' : 'none';

    customHoursInput.addEventListener('input', () => {
      const h = parseInt(customHoursInput.value, 10);
      if (Number.isFinite(h) && h >= 1) {
        formState.intervalHours = h;
        this._updatePreviewCard(previewCard, formState);
      }
    });

    scheduleSelect.addEventListener('change', () => {
      const val = scheduleSelect.value;
      if (val === 'custom') {
        customHoursWrapper.style.display = '';
        customHoursInput.focus();
      } else {
        customHoursWrapper.style.display = 'none';
        formState.intervalHours = parseInt(val, 10);
        this._updatePreviewCard(previewCard, formState);
      }
    });

    formPane.appendChild(scheduleLabel);
    formPane.appendChild(scheduleHint);
    formPane.appendChild(scheduleSelect);
    formPane.appendChild(customHoursWrapper);

    // Tool permissions note
    formPane.appendChild(
      el('div', { className: 'adv-custom-permissions-note' },
        'Custom personas run with the same scoped tool permissions as built-in personas. No elevated access.'
      )
    );
  }

  /**
   * Update the live preview card based on current form state.
   */
  _updatePreviewCard(previewCard, formState) {
    previewCard.innerHTML = '';

    const name = formState.name.trim() || 'Untitled';
    const scheduleLabel = this._hoursToScheduleLabel(formState.intervalHours);
    const modelLabel = CUSTOM_PERSONA_MODELS.find(m => m.value === formState.model)?.label || formState.model;

    previewCard.appendChild(
      el('div', { className: 'adv-card-header' },
        el('div', { className: 'adv-card-header-left' },
          el('span', { className: 'adv-dot adv-dot-idle' }),
          el('span', { className: 'adv-persona-label' }, name),
          el('span', { className: 'adv-custom-badge' }, 'Custom'),
          el('span', { className: 'adv-status-text' }, 'Idle'),
        ),
      )
    );

    // Focus areas preview
    if (formState.focusAreas.trim()) {
      const areas = formState.focusAreas.split(',').map(s => s.trim()).filter(Boolean);
      if (areas.length > 0) {
        previewCard.appendChild(
          el('div', { className: 'adv-custom-focus-preview' },
            areas.map(a => el('span', { className: 'adv-focus-tag' }, a))
          )
        );
      }
    }

    previewCard.appendChild(
      el('div', { className: 'adv-card-footer' },
        el('div', { className: 'adv-custom-schedule-row' },
          el('span', { className: 'adv-interval-label' }, 'Schedule'),
          el('span', { className: 'adv-custom-schedule' }, scheduleLabel),
        ),
        el('div', { className: 'adv-custom-schedule-row' },
          el('span', { className: 'adv-interval-label' }, 'Model'),
          el('span', { className: 'adv-custom-schedule' }, modelLabel),
        ),
      )
    );
  }

  /** Validate all form fields. Returns error string or null. */
  _validateForm(formState) {
    const name = formState.name.trim();
    if (!name) return 'Persona name is required.';
    if (RESERVED_NAMES.has(name)) return `"${name}" is a reserved name. Choose a different name.`;
    if (name.length > 64) return 'Name must be 64 characters or fewer.';

    // Check for name collision with existing custom personas (when creating new)
    if (!formState.isEditing) {
      const newId = slugifyName(name);
      const collision = this._customPersonas.find(p => (p.id || p._docId) === newId);
      if (collision) return `A persona named "${collision.name}" already exists.`;
    }

    if (!formState.systemPrompt.trim()) return 'System prompt is required.';
    return null;
  }

  _closeCustomModal() {
    if (this._customModal) {
      if (this._customModal.parentNode) this._customModal.parentNode.removeChild(this._customModal);
      this._customModal = null;
    }
  }

  /**
   * Open a read-only view of the Engineer persona's system prompt.
   * Reduces blank-page paralysis when writing a new custom persona prompt.
   */
  _openBuiltInExampleModal() {
    const overlay = el('div', {
      className: 'adv-custom-overlay adv-example-overlay',
      onClick: (e) => { if (e.target === overlay) overlay.parentNode?.removeChild(overlay); },
    });

    const modal = el('div', {
      className: 'adv-custom-modal adv-example-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-example-modal-title',
    });

    const closeBtn = el('button', {
      className: 'adv-soul-modal-close',
      title: 'Close',
      'aria-label': 'Close example',
      onClick: () => overlay.parentNode?.removeChild(overlay),
    }, '×');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', {
          className: 'adv-custom-modal-title',
          id: 'adv-example-modal-title',
        }, 'Built-in Example: Engineer Persona'),
        closeBtn,
      )
    );

    const promptEl = el('pre', {
      className: 'adv-example-prompt',
      'aria-label': 'Engineer persona system prompt (read-only)',
    });
    // Use textContent — never innerHTML — to safely display the prompt
    promptEl.textContent = DEFAULT_SOUL_PROMPTS.engineer;

    modal.appendChild(
      el('div', { className: 'adv-example-modal-body' },
        el('p', { className: 'adv-custom-hint' },
          'This is the Engineer persona\'s default system prompt. Use it as a reference when writing your own.'
        ),
        promptEl,
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Keyboard dismiss
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.parentNode?.removeChild(overlay);
    });

    setTimeout(() => closeBtn.focus(), 50);
  }

  /**
   * Open a modal showing the assembled prompt preview for a custom persona.
   * Shows: system prompt + the standard context bundle description.
   * This surfaces what the model will actually receive.
   *
   * @param {object} formState - Current form state
   */
  _openPromptPreviewModal(formState) {
    const name = formState.name.trim() || 'Untitled';
    const systemPrompt = formState.systemPrompt.trim() || '(no system prompt)';

    // Build a representative preview of the assembled prompt
    const projectContext = this._projects.find(p => p.id === this._filterProjectId)?.advisorContext || '';
    const contextSection = projectContext
      ? `## Project Context\n${projectContext}\n\n`
      : '(no project context — add context in project settings)\n\n';

    const preview = [
      '=== SYSTEM PROMPT ===',
      systemPrompt,
      '',
      '=== USER PROMPT (assembled by daemon) ===',
      contextSection + 'You are reviewing this project. Based on your focus areas and the project context above, identify the most important issues or improvements.\n\nRespond with a JSON array...',
      '',
      '--- Note: The daemon appends the project context, rejection history, and focus prompt at runtime. ---',
    ].join('\n');

    const overlay = el('div', {
      className: 'adv-custom-overlay adv-preview-overlay',
      onClick: (e) => { if (e.target === overlay) overlay.parentNode?.removeChild(overlay); },
    });

    const modal = el('div', {
      className: 'adv-custom-modal adv-preview-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-preview-modal-title',
    });

    const closeBtn = el('button', {
      className: 'adv-soul-modal-close',
      title: 'Close',
      'aria-label': 'Close prompt preview',
      onClick: () => overlay.parentNode?.removeChild(overlay),
    }, '×');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', {
          className: 'adv-custom-modal-title',
          id: 'adv-preview-modal-title',
        }, `Prompt Preview: ${name}`),
        closeBtn,
      )
    );

    const promptEl = el('pre', {
      className: 'adv-example-prompt',
      'aria-label': `Assembled prompt preview for ${name} persona`,
    });
    // Use textContent — never innerHTML
    promptEl.textContent = preview;

    modal.appendChild(
      el('div', { className: 'adv-example-modal-body' },
        el('p', { className: 'adv-custom-hint' },
          'This shows what the model will receive. The daemon appends project context, rejection history, and any focus prompt at runtime.'
        ),
        promptEl,
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.parentNode?.removeChild(overlay);
    });

    setTimeout(() => closeBtn.focus(), 50);
  }

  // ── Custom persona save / delete ─────────────────────────────

  /**
   * Save a custom persona to Firestore /advisorPersonas/{id}.
   * Also writes to /advisor/{id} to initialize state if creating new.
   */
  async _saveCustomPersona(formState, saveBtn, statusEl) {
    // Validate all fields before saving
    const validationError = this._validateForm(formState);
    if (validationError) {
      statusEl.textContent = validationError;
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    // Enforce maximum of 10 custom personas per project (client-side check)
    const MAX_CUSTOM_PERSONAS = 10;
    if (!formState.isEditing && this._customPersonas.length >= MAX_CUSTOM_PERSONAS) {
      statusEl.textContent = `Maximum of ${MAX_CUSTOM_PERSONAS} custom personas reached.`;
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    const name = sanitizePromptValue(formState.name.trim());
    const systemPrompt = formState.systemPrompt.replace(/<\/?system>|<\|/g, '').trim();
    const model = formState.model || 'claude-sonnet-4-6';
    const intervalHours = Math.max(1, Number(formState.intervalHours) || 24);
    const focusAreas = formState.focusAreas
      ? formState.focusAreas.split(',').map(s => sanitizePromptValue(s.trim())).filter(Boolean)
      : [];

    const id = formState.originalId || slugifyName(name);

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    try {
      const personaData = { type: 'custom', id, name, systemPrompt, model, intervalHours, focusAreas };

      // Write persona definition to /advisorPersonas/{id}
      await this.db.collection('advisorPersonas').doc(id).set(personaData);

      // Initialize state document in /advisor/{id} if creating new
      if (!formState.isEditing) {
        const stateRef = this.db.collection('advisor').doc(id);
        const stateSnap = await stateRef.get();
        if (!stateSnap.exists) {
          await stateRef.set({
            status: 'idle',
            intervalHours,
            lastRunAt: null,
            nextRunAt: null,
            lastActivity: null,
            activityLog: [],
            cycleCount: 0,
            ticketsCreated: 0,
            error: null,
            startedAt: new Date().toISOString(),
            runNow: null,
            soulPrompt: null,
          });
        }
      } else {
        // Update interval on state doc when editing
        await this.db.collection('advisor').doc(id).set({ intervalHours }, { merge: true });
      }

      statusEl.textContent = formState.isEditing ? 'Saved' : 'Persona created';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';

      // Announce to screen readers
      if (this._liveRegion) {
        this._liveRegion.textContent = formState.isEditing
          ? `"${name}" persona updated.`
          : `"${name}" persona created.`;
        setTimeout(() => { if (this._liveRegion) this._liveRegion.textContent = ''; }, 3000);
      }

      setTimeout(() => this._closeCustomModal(), 800);
    } catch (err) {
      console.error('Failed to save custom persona:', err);
      statusEl.textContent = 'Error saving persona';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  }

  /**
   * Show a confirmation dialog before deleting a custom persona.
   * Echoes the persona name in the confirmation prompt.
   */
  async _confirmDeleteCustomPersona(personaId, personaName) {
    this._closeCustomModal();

    const confirmed = await showConfirmModal({
      title: `Delete "${personaName}"?`,
      message: 'Past tickets generated by this persona are not affected. Future runs will stop.',
      confirm: 'Delete',
      danger: true,
    });
    if (!confirmed) return;

    await this._deleteCustomPersona(personaId, personaName, null, null);
  }

  /**
   * Delete a custom persona from Firestore /advisorPersonas/{id}.
   * Does NOT delete the /advisor/{id} state doc (preserves run history).
   */
  async _deleteCustomPersona(personaId, personaName, statusEl, onSuccess) {
    try {
      await this.db.collection('advisorPersonas').doc(personaId).delete();

      // Announce to screen readers
      if (this._liveRegion) {
        this._liveRegion.textContent = `"${personaName}" persona deleted.`;
        setTimeout(() => { if (this._liveRegion) this._liveRegion.textContent = ''; }, 3000);
      }

      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Failed to delete custom persona:', err);
      if (statusEl) {
        statusEl.textContent = 'Error deleting persona';
        statusEl.className = 'adv-soul-status adv-soul-status-err';
      }
    }
  }

  // ── Run Log Drawer (DK-189) ─────────────────────────────────────────────
  // Right-side drawer showing the last 20 advisor runs for the current project.
  // Triggered by the "Run log" button in the panel header.
  // Fetches once on open; manual refresh re-runs the query.
  // No onSnapshot — the log is historical.

  /**
   * Open (or re-open) the run log drawer.
   * If already open, bring it to focus and refresh.
   *
   * @param {string|null} [focusRunId] - Optional run doc ID to pre-scroll to after load.
   */
  _openRunLogDrawer(focusRunId = null) {
    this._runLogFocusRunId = focusRunId || null;

    if (!this._runLogDrawer) {
      this._runLogDrawer = this._buildRunLogDrawer();
      document.body.appendChild(this._runLogDrawer);
    }

    this._runLogDrawerOpen = true;
    this._runLogDrawer.classList.remove('adv-drawer-hidden');
    this._runLogDrawer.setAttribute('aria-hidden', 'false');

    // Trap focus inside the drawer
    const firstFocusable = this._runLogDrawer.querySelector('button, [tabindex="0"]');
    if (firstFocusable) firstFocusable.focus();

    // Load runs if not yet loaded or if stale (null means not loaded)
    if (this._runLogRuns === null || focusRunId) {
      this._fetchRunLogRuns();
    } else {
      this._renderRunLogBody();
    }
  }

  /**
   * Close the run log drawer and return focus to the trigger button.
   */
  _closeRunLogDrawer() {
    if (!this._runLogDrawer) return;
    this._runLogDrawerOpen = false;
    this._runLogDrawer.classList.add('adv-drawer-hidden');
    this._runLogDrawer.setAttribute('aria-hidden', 'true');

    // Return focus to trigger button
    if (this._runLogBtn) this._runLogBtn.focus();
  }

  /**
   * Build the run log drawer DOM once. Subsequent opens reuse this element.
   * @returns {HTMLElement}
   */
  _buildRunLogDrawer() {
    const self = this;

    // Backdrop
    const backdrop = el('div', {
      className: 'adv-drawer-backdrop',
      'aria-hidden': 'true',
      onClick: () => self._closeRunLogDrawer(),
    });

    // Drawer panel
    const panel = el('div', {
      className: 'adv-drawer-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Advisor run log',
    });

    // Header row
    const closeBtn = el('button', {
      className: 'adv-drawer-close',
      'aria-label': 'Close run log',
      title: 'Close',
      onClick: () => self._closeRunLogDrawer(),
    }, '✕');

    const refreshBtn = el('button', {
      className: 'adv-drawer-refresh',
      'aria-label': 'Refresh run log',
      title: 'Refresh',
      onClick: () => {
        self._runLogRuns = null;
        self._fetchRunLogRuns();
      },
    }, '↻ Refresh');

    const drawerTitle = el('h2', { className: 'adv-drawer-title' }, 'Advisor run log');

    const drawerHeader = el('div', { className: 'adv-drawer-header' },
      drawerTitle,
      el('div', { className: 'adv-drawer-header-actions' },
        refreshBtn,
        closeBtn,
      ),
    );

    panel.appendChild(drawerHeader);

    // Paused notice container — shown when the advisor is paused
    this._runLogPausedNotice = el('div', {
      className: 'adv-drawer-paused-notice adv-hidden',
      role: 'note',
      'aria-label': 'Advisor is paused',
    },
      el('span', { className: 'adv-drawer-paused-icon', 'aria-hidden': 'true' }, '⏸'),
      ' Advisor is paused — no recent runs.',
    );
    panel.appendChild(this._runLogPausedNotice);

    // Body container — accordion rows rendered here
    this._runLogBody = el('div', {
      className: 'adv-drawer-body',
      role: 'list',
      'aria-label': 'Run log entries',
    });
    panel.appendChild(this._runLogBody);

    // Trap keyboard navigation inside the drawer
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        self._closeRunLogDrawer();
      }
    });

    const overlay = el('div', {
      className: 'adv-drawer-overlay adv-drawer-hidden',
      'aria-hidden': 'true',
    }, backdrop, panel);

    return overlay;
  }

  /**
   * Fetch the last 20 advisor runs for the current project from Firestore.
   * Fires once — no live listener.
   */
  async _fetchRunLogRuns() {
    if (!this._runLogBody) return;

    this._runLogLoading = true;
    this._renderRunLogBody(); // show spinner

    const projectId = this._filterProjectId;

    try {
      let query = this.db.collection('advisorRuns')
        .orderBy('timestamp', 'desc')
        .limit(20);

      if (projectId) {
        query = this.db.collection('advisorRuns')
          .where('projectId', '==', projectId)
          .orderBy('timestamp', 'desc')
          .limit(20);
      } else {
        // Fall back to startedAt ordering (legacy field) if timestamp not indexed
        query = this.db.collection('advisorRuns')
          .orderBy('startedAt', 'desc')
          .limit(20);
      }

      const snap = await query.get();
      this._runLogRuns = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    } catch (err) {
      console.warn('Run log fetch failed:', err.message);
      // Try falling back to startedAt ordering if timestamp field is missing
      try {
        let fallbackQuery = this.db.collection('advisorRuns')
          .orderBy('startedAt', 'desc')
          .limit(20);
        if (projectId) {
          fallbackQuery = this.db.collection('advisorRuns')
            .where('projectId', '==', projectId)
            .orderBy('startedAt', 'desc')
            .limit(20);
        }
        const fallbackSnap = await fallbackQuery.get();
        this._runLogRuns = fallbackSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
      } catch (fallbackErr) {
        console.error('Run log fallback fetch also failed:', fallbackErr.message);
        this._runLogRuns = [];
      }
    } finally {
      this._runLogLoading = false;
      this._renderRunLogBody();

      // Scroll to focused run if specified
      if (this._runLogFocusRunId && this._runLogBody) {
        const targetRow = this._runLogBody.querySelector(`[data-run-id="${this._runLogFocusRunId}"]`);
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Expand the target run
          if (!this._runLogExpanded[this._runLogFocusRunId]) {
            this._runLogExpanded[this._runLogFocusRunId] = true;
            this._renderRunLogBody();
            const expandedRow = this._runLogBody.querySelector(`[data-run-id="${this._runLogFocusRunId}"]`);
            if (expandedRow) expandedRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          this._runLogFocusRunId = null;
        }
      }
    }
  }

  /**
   * Render the body of the run log drawer from cached data.
   * Called after fetch completes and on accordion expand/collapse.
   */
  _renderRunLogBody() {
    if (!this._runLogBody) return;
    this._runLogBody.innerHTML = '';

    // Check paused state across all personas
    const anyPaused = Object.values(this._states).some(s => s?.status === 'paused');
    if (this._runLogPausedNotice) {
      this._runLogPausedNotice.classList.toggle('adv-hidden', !anyPaused || (this._runLogRuns && this._runLogRuns.length > 0));
    }

    if (this._runLogLoading) {
      this._runLogBody.appendChild(
        el('div', { className: 'adv-drawer-loading', 'aria-busy': 'true' },
          el('span', { className: 'adv-history-spinner', 'aria-hidden': 'true' }),
          el('span', {}, ' Loading runs…'),
        )
      );
      return;
    }

    const runs = this._runLogRuns || [];

    if (runs.length === 0) {
      this._runLogBody.appendChild(
        el('div', { className: 'adv-drawer-empty' },
          'No advisor runs found for this project yet.'
        )
      );
      return;
    }

    for (const run of runs) {
      this._runLogBody.appendChild(this._buildRunLogRow(run));
    }
  }

  /**
   * Build a single accordion row for the run log drawer.
   *
   * Collapsed: persona name, timestamp, one-line summary
   * Expanded: Created tickets, Dedup hits, Filtered summary
   *
   * @param {object} run - Run log document from advisorRuns
   * @returns {HTMLElement}
   */
  _buildRunLogRow(run) {
    const runId = run._id || `run-${Math.random().toString(36).slice(2)}`;
    const isExpanded = !!this._runLogExpanded[runId];

    // Timestamp
    const ts = run.timestamp || run.startedAt || run.finishedAt;
    const relTime = formatRelativeTs(ts) || '—';
    const absTime = formatAbsolute(ts);

    // Persona label
    const personaId = run.persona || run.personaId || '?';
    const personaLabel = PERSONA_DISPLAY_NAMES[personaId] || personaId;

    // Counts from structured fields (DK-189) or fall back to legacy
    const ticketsCreated  = Array.isArray(run.ticketsCreated)  ? run.ticketsCreated
                          : Array.isArray(run.created)         ? run.created
                          : [];
    const ticketsDeduped  = Array.isArray(run.ticketsDeduped)  ? run.ticketsDeduped  : [];
    const ticketsFiltered = run.ticketsFiltered && typeof run.ticketsFiltered === 'object'
      ? run.ticketsFiltered
      : { count: Array.isArray(run.rejected) ? run.rejected.length : 0, reasons: [] };

    const createdCount = ticketsCreated.length || (run.proposalsCreated || 0);
    const dedupedCount = ticketsDeduped.length;
    const filteredCount = ticketsFiltered.count || 0;

    // Visually recede runs with nothing interesting
    const isQuiet = createdCount === 0 && dedupedCount === 0 && filteredCount === 0;

    // One-line summary: "2 created, 1 deduped, 0 filtered"
    const summaryParts = [
      `${createdCount} created`,
      `${dedupedCount} deduped`,
      `${filteredCount} filtered`,
    ];
    const summaryText = summaryParts.join(', ');

    // Detail region id
    const detailId = `adv-run-log-detail-${runId}`;

    // ── Collapsed row ──────────────────────────────────────────────────
    const triggerBtn = el('button', {
      className: 'adv-run-log-row-trigger' + (isQuiet ? ' adv-run-log-row-quiet' : ''),
      'aria-expanded': String(isExpanded),
      'aria-controls': detailId,
      onClick: () => {
        this._runLogExpanded[runId] = !this._runLogExpanded[runId];
        this._renderRunLogBody();
      },
    });

    // Status icon (not color-only — icon + text)
    if (createdCount > 0) {
      triggerBtn.appendChild(
        el('span', { className: 'adv-run-log-icon', 'aria-hidden': 'true' }, '✦')
      );
    } else if (dedupedCount > 0) {
      triggerBtn.appendChild(
        el('span', { className: 'adv-run-log-icon adv-run-log-icon-dedup', 'aria-hidden': 'true' }, '⧉')
      );
    }

    // Persona name
    triggerBtn.appendChild(
      el('span', { className: 'adv-run-log-persona' }, personaLabel)
    );

    // DK-367: Scope chip — shown inline when run has a scopeText
    const runLogScopeText = typeof run.scopeText === 'string' && run.scopeText.trim()
      ? run.scopeText.trim()
      : null;
    if (runLogScopeText) {
      const truncated = runLogScopeText.length > 40 ? runLogScopeText.slice(0, 40) + '…' : runLogScopeText;
      triggerBtn.appendChild(
        el('span', {
          className: 'adv-run-log-scope-chip',
          title: runLogScopeText,
          'aria-label': `Run scoped to: ${runLogScopeText}`,
        }, `Focus: ${truncated}`)
      );
    }

    // Timestamp
    triggerBtn.appendChild(
      el('span', {
        className: 'adv-run-log-time',
        title: absTime,
        'aria-label': `${relTime} (${absTime})`,
      }, relTime)
    );

    // One-line summary
    triggerBtn.appendChild(
      el('span', { className: 'adv-run-log-summary' }, summaryText)
    );

    // Chevron
    triggerBtn.appendChild(
      el('span', { className: 'adv-run-log-chevron', 'aria-hidden': 'true' },
        isExpanded ? '▾' : '▸'
      )
    );

    const row = el('div', {
      className: 'adv-run-log-row',
      'data-run-id': runId,
      role: 'listitem',
    }, triggerBtn);

    // ── Expanded detail ────────────────────────────────────────────────
    const detail = el('div', {
      className: 'adv-run-log-detail' + (isExpanded ? '' : ' adv-hidden'),
      id: detailId,
      role: 'region',
      'aria-label': `Run details: ${personaLabel} ${relTime}`,
    });

    if (isExpanded) {
      // DK-367: Scope callout — shown when run was scoped to a specific area
      if (runLogScopeText) {
        detail.appendChild(
          el('div', { className: 'adv-run-log-scope-callout', role: 'note' },
            el('span', { className: 'adv-run-log-scope-callout-label' }, 'This run was scoped to:'),
            ' ',
            el('span', { className: 'adv-run-log-scope-callout-value' }, runLogScopeText),
            el('span', { className: 'adv-run-log-scope-callout-hint' }, ' — results will differ from unscoped runs.')
          )
        );
      }

      // DK-134: Scope matched-zero warning — shown when scope filters matched no files.
      // Surfaced as a visible entry per spec. Not color-only: uses text label "0 files matched".
      if (run.scopeMatchedZero === true) {
        detail.appendChild(
          el('div', {
            className: 'adv-run-log-scope-no-files',
            role: 'alert',
            'aria-label': 'Scope warning: no files matched',
          },
            el('span', { className: 'adv-run-log-scope-no-files-icon', 'aria-hidden': 'true' }, '⚠'),
            el('span', { className: 'adv-run-log-scope-no-files-text' },
              '0 files matched configured scope — no tickets were generated. ',
              el('span', { className: 'adv-run-log-scope-no-files-hint' }, 'Check your path filter patterns.')
            )
          )
        );
      }

      // Created tickets
      if (ticketsCreated.length > 0) {
        detail.appendChild(this._buildRunLogCreatedSection(ticketsCreated));
      }

      // Dedup hits
      if (ticketsDeduped.length > 0) {
        detail.appendChild(this._buildRunLogDedupedSection(ticketsDeduped));
      }

      // Filtered summary
      if (filteredCount > 0) {
        detail.appendChild(this._buildRunLogFilteredSection(ticketsFiltered));
      }

      // DK-405: Screenshot folder link — shown for design/QA runs that saved screenshots locally
      const screenshotFolder = typeof run.screenshotFolder === 'string' && run.screenshotFolder.trim()
        ? run.screenshotFolder.trim()
        : null;
      if (screenshotFolder) {
        detail.appendChild(this._buildRunLogScreenshotFolderSection(screenshotFolder));
      }

      // Empty expanded state
      if (ticketsCreated.length === 0 && ticketsDeduped.length === 0 && filteredCount === 0 && !screenshotFolder) {
        detail.appendChild(
          el('div', { className: 'adv-run-log-empty-detail' }, 'Nothing to report for this run.')
        );
      }
    }

    row.appendChild(detail);
    return row;
  }

  /**
   * Build the "Created tickets" section inside an expanded run log row.
   * Each ticket is a link — shows ID by default, title if we can look it up.
   *
   * @param {string[]} ticketIds - Firestore ticket doc IDs
   * @returns {HTMLElement}
   */
  _buildRunLogCreatedSection(ticketIds) {
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon', 'aria-hidden': 'true' }, '✦'),
        ` Created (${ticketIds.length})`,
      )
    );

    const list = el('ul', { className: 'adv-run-log-ticket-list', role: 'list' });

    for (const docId of ticketIds) {
      // Prefer cached title; show doc ID as fallback
      const cachedTitle = this._runLogTicketTitles[docId];
      const linkText = cachedTitle || docId.slice(0, 16) + (docId.length > 16 ? '…' : '');
      const ariaLabel = cachedTitle
        ? `View ticket: ${cachedTitle}`
        : `View ticket ${docId}`;

      const li = el('li', { className: 'adv-run-log-ticket-item' });
      const link = el('a', {
        className: 'adv-run-log-ticket-link',
        href: `#ticket/${docId}`,
        'aria-label': ariaLabel,
        title: cachedTitle || docId,
        onClick: () => this._closeRunLogDrawer(),
      }, linkText);

      li.appendChild(link);

      // Async: fetch ticket title if not cached, then update the link text
      if (!cachedTitle) {
        this._fetchTicketTitle(docId).then(title => {
          if (title) {
            link.textContent = title;
            link.setAttribute('aria-label', `View ticket: ${title}`);
            link.title = title;
          }
        }).catch(() => {/* non-fatal */});
      }

      list.appendChild(li);
    }

    section.appendChild(list);
    return section;
  }

  /**
   * Build the "Dedup hits" section.
   * Shows blocked ticket title/link and matched keywords phrase.
   *
   * @param {Array<{summary: string, blockedBy: string}>} deduped
   * @returns {HTMLElement}
   */
  _buildRunLogDedupedSection(deduped) {
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon adv-run-log-icon-dedup', 'aria-hidden': 'true' }, '⧉'),
        ` Dedup hits (${deduped.length})`,
      )
    );

    const list = el('ul', { className: 'adv-run-log-dedup-list', role: 'list' });

    for (const hit of deduped) {
      const blockedDocId = hit.blockedBy || '';
      const summary = hit.summary || ''; // matched keywords phrase

      const cachedTitle = blockedDocId ? this._runLogTicketTitles[blockedDocId] : null;
      const linkText = cachedTitle
        ? `View duplicate: ${cachedTitle}`
        : `View duplicate ticket`;
      const ariaLabel = cachedTitle
        ? `View duplicate: ${cachedTitle}`
        : (blockedDocId ? `View duplicate ticket ${blockedDocId}` : 'Duplicate of existing ticket');

      const li = el('li', { className: 'adv-run-log-dedup-item' });

      if (blockedDocId) {
        const link = el('a', {
          className: 'adv-run-log-dedup-link',
          href: `#ticket/${blockedDocId}`,
          'aria-label': ariaLabel,
          title: cachedTitle || blockedDocId,
          onClick: () => this._closeRunLogDrawer(),
        }, linkText);

        li.appendChild(link);

        // Async title lookup
        if (!cachedTitle) {
          this._fetchTicketTitle(blockedDocId).then(title => {
            if (title) {
              link.textContent = `View duplicate: ${title}`;
              link.setAttribute('aria-label', `View duplicate: ${title}`);
              link.title = title;
            }
          }).catch(() => {/* non-fatal */});
        }
      } else {
        li.appendChild(el('span', { className: 'adv-run-log-dedup-label' }, 'Duplicate of existing ticket'));
      }

      // Matched keywords phrase (not AI prose — stored as structured data)
      if (summary) {
        li.appendChild(
          el('span', { className: 'adv-run-log-dedup-keywords' }, ` — matched: ${summary}`)
        );
      }

      list.appendChild(li);
    }

    section.appendChild(list);
    return section;
  }

  /**
   * Build the "Filtered" section with reason codes as plain-language labels.
   *
   * @param {{ count: number, reasons: string[] }} ticketsFiltered
   * @returns {HTMLElement}
   */
  _buildRunLogFilteredSection(ticketsFiltered) {
    const { count, reasons = [] } = ticketsFiltered;
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon', 'aria-hidden': 'true' }, '▽'),
        ` Filtered (${count})`,
      )
    );

    if (reasons.length > 0) {
      const list = el('ul', { className: 'adv-run-log-filtered-list', role: 'list' });
      for (const code of reasons) {
        list.appendChild(
          el('li', { className: 'adv-run-log-filtered-item' }, filterReasonLabel(code))
        );
      }
      section.appendChild(list);
    } else {
      section.appendChild(
        el('div', { className: 'adv-run-log-filtered-count' }, `${count} proposal(s) skipped`)
      );
    }

    return section;
  }

  /**
   * DK-405: Build the "Screenshots" section inside an expanded run log row.
   * Shows a file:// link to the local folder where screenshots were saved.
   * Only rendered for design/QA runs that saved screenshots to disk.
   *
   * @param {string} folderPath - Absolute local path to the screenshot folder
   * @returns {HTMLElement}
   */
  _buildRunLogScreenshotFolderSection(folderPath) {
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon', 'aria-hidden': 'true' }, '📷'),
        ' Screenshots',
      )
    );

    // Encode the path for use as a file:// URL
    const fileUrl = 'file://' + folderPath.replace(/ /g, '%20');

    section.appendChild(
      el('div', { className: 'adv-run-log-screenshot-folder' },
        el('a', {
          className: 'adv-run-log-screenshot-folder-link',
          href: fileUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: folderPath,
          'aria-label': `Open screenshot folder: ${folderPath}`,
        }, folderPath),
      )
    );

    return section;
  }

  /**
   * Fetch and cache a ticket title from Firestore.
   * The cache is per-drawer-session (reset on drawer rebuild).
   *
   * @param {string} docId - Firestore ticket document ID
   * @returns {Promise<string|null>}
   */
  async _fetchTicketTitle(docId) {
    if (this._runLogTicketTitles[docId]) return this._runLogTicketTitles[docId];

    // Search all projects for the ticket
    // We don't know the projectId, so we use a collectionGroup query.
    // Fallback: try the current project's tickets subcollection first.
    try {
      const projectId = this._filterProjectId;
      if (projectId) {
        const snap = await this.db
          .collection('projects').doc(projectId)
          .collection('tickets').doc(docId)
          .get();
        if (snap.exists) {
          const title = snap.data().title || null;
          if (title) this._runLogTicketTitles[docId] = title;
          return title;
        }
      }
    } catch {/* fallback to collectionGroup */}

    // Try to find ticket across all projects via the ticketId field or doc ID
    try {
      // Try each project we know about
      for (const project of this._projects) {
        try {
          const snap = await this.db
            .collection('projects').doc(project.id)
            .collection('tickets').doc(docId)
            .get();
          if (snap.exists) {
            const title = snap.data().title || null;
            if (title) this._runLogTicketTitles[docId] = title;
            return title;
          }
        } catch {/* continue */}
      }
    } catch {/* non-fatal */}

    return null;
  }

  // ── Backlog Deduplication (DK-366) ──────────────────────────────────────────
  // PM pastes their backlog (newline- or comma-separated ticket titles).
  // Each idea generated in a dry-run preview is checked against this list
  // using keyword overlap similarity. Duplicates are flagged inline with
  // a similarity score, stacked comparison view, and three resolution actions.
  //
  // Per-session suppression toggle: "Surface with warning" (default) vs "Suppress duplicates".
  // When suppression is active, a session-level count is shown.
  //
  // Rejection log: per-session append-only log of dismissed ideas.

  /** Stop-words for keyword extraction (shared with server-side dedup.js) */
  _backlogStopWords() {
    return new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'are', 'was', 'be', 'as', 'it',
      'its', 'this', 'that', 'add', 'fix', 'update', 'improve', 'issue',
    ]);
  }

  /** Extract meaningful keywords from a title string. */
  _extractKeywords(title) {
    const stopWords = this._backlogStopWords();
    return new Set(
      String(title).toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
    );
  }

  /**
   * Compute keyword overlap ratio between two titles (0–1).
   * 1.0 = all keywords in the smaller set appear in the larger set.
   */
  _keywordOverlap(titleA, titleB) {
    const kwA = this._extractKeywords(titleA);
    const kwB = this._extractKeywords(titleB);
    if (kwA.size === 0 || kwB.size === 0) return 0;
    let common = 0;
    for (const w of kwA) if (kwB.has(w)) common++;
    return common / Math.min(kwA.size, kwB.size);
  }

  /**
   * Find the best-matching backlog item for a given idea title.
   * Returns null if no backlog is loaded or score is below threshold.
   *
   * Default threshold: 0.55 (slightly lower than server-side 0.6 — surface
   * more for PM review; erring toward flagging rather than missing duplicates).
   *
   * @param {string} ideaTitle
   * @param {number} [threshold=0.55]
   * @returns {{ matchTitle: string, score: number } | null}
   */
  _findBacklogMatch(ideaTitle, threshold = 0.55) {
    if (!this._backlogItems || this._backlogItems.length === 0) return null;
    let bestScore = 0;
    let bestTitle = null;
    for (const item of this._backlogItems) {
      const score = this._keywordOverlap(ideaTitle, item.title);
      if (score > bestScore) {
        bestScore = score;
        bestTitle = item.title;
      }
    }
    if (bestScore >= threshold) {
      return { matchTitle: bestTitle, score: bestScore };
    }
    return null;
  }

  /**
   * Parse a paste-and-parse backlog string (newline- or comma-separated).
   * Cap at 2000 items (per spec: configurable; 2000 is the default max).
   *
   * @param {string} raw
   * @returns {Array<{ title: string }>}
   */
  _parseBacklogInput(raw) {
    // Split on newlines first; fall back to commas for single-line input
    const lines = raw.split(/\n/);
    let items;
    if (lines.length > 1) {
      items = lines;
    } else {
      items = raw.split(',');
    }
    return items
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(0, 2000)
      .map(title => ({ title }));
  }

  /**
   * Build the backlog deduplication section.
   * Shows a collapsible section with:
   *   - Paste-and-parse textarea for backlog input
   *   - Suppression mode toggle (per-session)
   *   - Rejection log (searchable, with notes)
   */
  // ── DK-188: Confidence Threshold section ─────────────────────────────────
  // Global minimum confidence threshold for advisor suggestions.
  // Named radio group: Low (3) / Medium (5) / High (7) / Strict (9).
  // Threshold is stored in /advisor/config.minConfidence in Firestore,
  // read at cycle time by the daemon (overrides docket.config.json).

  // Named confidence levels as per design spec (DK-188).
  // Slider was rejected — named levels communicate intent, not false precision.
  _confidenceLevels() {
    return [
      { label: 'Low',    value: 3, description: 'Suggest most ideas, filter only very low-confidence ones' },
      { label: 'Medium', value: 5, description: 'Balanced filter — default starting point' },
      { label: 'High',   value: 7, description: 'Only high-confidence suggestions get through' },
      { label: 'Strict', value: 9, description: 'Very selective — may produce fewer tickets per cycle' },
    ];
  }

  /**
   * Subscribe to the /advisor/config Firestore doc for live minConfidence updates.
   * Persists the value in this._minConfidence and syncs the radio group.
   */
  _subscribeConfidenceConfig() {
    if (this._confidenceUnsub) { this._confidenceUnsub(); this._confidenceUnsub = null; }

    const unsub = this.db.collection('advisor').doc('config').onSnapshot((snap) => {
      if (!this._mounted) return;
      const raw = snap.exists ? snap.data()?.minConfidence : undefined;
      this._minConfidence = (Number.isInteger(raw) && raw >= 1 && raw <= 10) ? raw : 5;
      this._syncConfidenceRadios();
    }, (err) => {
      // Non-fatal — panel still works; backend uses config file default.
      console.warn('AdvisorPanel: confidence config listener error:', err.message);
    });

    this._confidenceUnsub = unsub;
    this._unsubs.push(unsub);
  }

  /** Sync all radio buttons to the current this._minConfidence value. */
  _syncConfidenceRadios() {
    const levels = this._confidenceLevels();
    // Find the nearest named level (closest value <= minConfidence)
    let best = levels[0];
    for (const lv of levels) {
      if (lv.value <= this._minConfidence) best = lv;
    }
    for (const lv of levels) {
      const input = this._confidenceRadioEls[lv.value];
      if (input) input.checked = (lv.value === best.value);
    }
  }

  /**
   * Save a new minConfidence value to Firestore.
   * Called when the user selects a different named level.
   *
   * @param {number} value - 1–10 integer
   */
  async _saveConfidenceThreshold(value) {
    if (this._discardsSaving) return;
    this._discardsSaving = true;

    const statusEl = this._confidenceStatusEl;
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'adv-confidence-status'; }

    try {
      await this.db.collection('advisor').doc('config').set({ minConfidence: value }, { merge: true });
      if (statusEl) {
        statusEl.textContent = 'Saved — takes effect on next cycle';
        statusEl.className = 'adv-confidence-status adv-confidence-status-ok';
        setTimeout(() => {
          if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-confidence-status'; }
        }, 3000);
      }
    } catch (err) {
      console.warn('AdvisorPanel: failed to save confidence threshold:', err);
      if (statusEl) {
        statusEl.textContent = 'Save failed';
        statusEl.className = 'adv-confidence-status adv-confidence-status-err';
      }
      // Revert radio to current stored value
      this._syncConfidenceRadios();
    } finally {
      this._discardsSaving = false;
    }
  }

  /**
   * Build the confidence threshold section.
   * Shows a radio group and a collapsed discards log.
   *
   * @returns {HTMLElement}
   */
  _buildConfidenceSection() {
    const section = el('div', { className: 'adv-confidence-section' });

    // Collapsible header
    const sectionKey = 'confidence-threshold';
    const isExpanded = !this._collapsedSections.has(sectionKey);
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');

    const header = el('button', {
      className: 'adv-backlog-section-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-confidence-body',
      onClick: () => this._toggleSectionCollapse(sectionKey, body, chevron, header),
    },
      chevron,
      el('span', { className: 'adv-section-label' }, 'Confidence Threshold'),
    );

    section.appendChild(header);

    const body = el('div', {
      id: 'adv-confidence-body',
      className: 'adv-confidence-body' + (isExpanded ? '' : ' adv-hidden'),
    });

    // Callout explaining the feature (shown on first setup)
    const callout = el('p', { className: 'adv-confidence-callout' },
      'Suggestions below this confidence score are filtered out. ',
      el('span', { className: 'adv-confidence-callout-note' },
        'Raise it over time as you calibrate.'
      )
    );
    body.appendChild(callout);

    // Radio group — named levels per design spec
    const levels = this._confidenceLevels();
    const fieldset = el('fieldset', {
      className: 'adv-confidence-fieldset',
      'aria-label': 'Minimum confidence threshold',
    });
    const legend = el('legend', { className: 'adv-confidence-legend' },
      'Minimum confidence threshold',
    );
    fieldset.appendChild(legend);

    const radioGroup = el('div', {
      className: 'adv-confidence-radio-group',
      role: 'radiogroup',
      'aria-labelledby': 'adv-confidence-legend-label',
    });

    for (const lv of levels) {
      const inputId = `adv-confidence-${lv.value}`;
      const input = el('input', {
        type: 'radio',
        id: inputId,
        name: 'adv-confidence-level',
        value: String(lv.value),
        checked: lv.value === this._minConfidence || (lv.value === 5 && this._minConfidence === 5),
        onChange: () => {
          this._minConfidence = lv.value;
          this._saveConfidenceThreshold(lv.value);
        },
      });
      this._confidenceRadioEls[lv.value] = input;

      const labelEl = el('label', {
        htmlFor: inputId,
        className: 'adv-confidence-label',
        title: lv.description,
      },
        el('span', { className: 'adv-confidence-level-name' }, lv.label),
        el('span', { className: 'adv-confidence-level-value' }, ` (${lv.value}/10)`),
      );

      radioGroup.appendChild(el('div', { className: 'adv-confidence-option' }, input, labelEl));
    }

    fieldset.appendChild(radioGroup);
    body.appendChild(fieldset);

    // Status / feedback line
    const statusEl = el('span', { className: 'adv-confidence-status' });
    this._confidenceStatusEl = statusEl;
    body.appendChild(el('div', { className: 'adv-confidence-status-row' }, statusEl));

    // Discards log — collapsed sub-section
    const discardsKey = 'confidence-discards';
    const discardsExpanded = !this._collapsedSections.has(discardsKey);
    const discardsChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, discardsExpanded ? '▾' : '▸');

    const discardsHeader = el('button', {
      className: 'adv-confidence-discards-header',
      'aria-expanded': String(discardsExpanded),
      'aria-controls': 'adv-confidence-discards-body',
      onClick: () => {
        this._toggleSectionCollapse(discardsKey, discardsBody, discardsChevron, discardsHeader);
        // Lazy-load discards when first opened
        if (!this._discardsLoaded) {
          this._discardsLoaded = true;
          this._loadDiscards();
        }
      },
    },
      discardsChevron,
      el('span', { className: 'adv-confidence-discards-label' }, 'Filtered suggestions'),
    );

    const discardsBody = el('div', {
      id: 'adv-confidence-discards-body',
      className: 'adv-confidence-discards-body' + (discardsExpanded ? '' : ' adv-hidden'),
    });

    // The actual discard list — rendered in _renderDiscardsLog
    this._discardsBody = el('div', { className: 'adv-confidence-discards-list', role: 'list', tabindex: '0', 'aria-label': 'Filtered suggestions log' });
    discardsBody.appendChild(this._discardsBody);
    this._discardsSection = discardsBody;

    // Initialise with a placeholder
    this._discardsBody.appendChild(
      el('p', { className: 'adv-confidence-discards-empty' }, 'No filtered suggestions recorded yet.')
    );

    // If discards section starts expanded, load immediately
    if (discardsExpanded) {
      this._discardsLoaded = true;
      setTimeout(() => { if (this._mounted) this._loadDiscards(); }, 500);
    }

    body.appendChild(
      el('div', { className: 'adv-confidence-discards-section' },
        discardsHeader,
        discardsBody,
      )
    );

    section.appendChild(body);
    return section;
  }

  /**
   * Load the most recent discards from Firestore and render them.
   * Reads /advisor/discards/items ordered by timestamp desc, limit 20.
   */
  async _loadDiscards() {
    if (!this._discardsBody) return;

    try {
      const snap = await this.db
        .collection('advisor')
        .doc('discards')
        .collection('items')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      if (!this._mounted || !this._discardsBody) return;

      if (snap.empty) {
        this._discardsBody.innerHTML = '';
        this._discardsBody.appendChild(
          el('p', { className: 'adv-confidence-discards-empty' }, 'No filtered suggestions recorded yet.')
        );
        return;
      }

      this._discardsBody.innerHTML = '';
      for (const doc of snap.docs) {
        const d = doc.data();
        const ts = d.timestamp?.toDate?.() ?? null;
        const tsText = ts ? formatRelativeTs(ts) : '';
        const row = el('div', {
          className: 'adv-confidence-discard-row',
          role: 'listitem',
          tabindex: '0',
        },
          el('div', { className: 'adv-confidence-discard-meta' },
            el('span', { className: 'adv-confidence-discard-persona' }, d.persona || '?'),
            el('span', { className: 'adv-confidence-discard-score', 'aria-label': `Confidence score: ${d.score} of 10` },
              `Confidence: ${d.score}/10`
            ),
            el('span', { className: 'adv-confidence-discard-threshold', 'aria-label': `Threshold was: ${d.threshold}` },
              `(threshold: ${d.threshold})`
            ),
            tsText ? el('span', { className: 'adv-confidence-discard-ts' }, tsText) : null,
          ),
          el('div', { className: 'adv-confidence-discard-title' }, d.ticketDraft?.title || '(no title)'),
          d.ticketDraft?.summary ? el('div', { className: 'adv-confidence-discard-summary' }, d.ticketDraft.summary.slice(0, 120) + (d.ticketDraft.summary.length > 120 ? '…' : '')) : null,
        );
        this._discardsBody.appendChild(row);
      }
    } catch (err) {
      if (!this._mounted || !this._discardsBody) return;
      console.warn('AdvisorPanel: failed to load discards:', err.message);
      this._discardsBody.innerHTML = '';
      this._discardsBody.appendChild(
        el('p', { className: 'adv-confidence-discards-empty' }, 'Could not load filtered suggestions.')
      );
    }
  }

  _buildBacklogSection() {
    const section = el('div', { className: 'adv-backlog-section' });

    // Collapsible header
    const sectionKey = 'backlog-dedup';
    const isExpanded = !this._collapsedSections.has(sectionKey);
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');

    const header = el('button', {
      className: 'adv-backlog-section-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-backlog-body',
      onClick: () => {
        const nowExpanded = this._collapsedSections.has(sectionKey);
        if (nowExpanded) {
          this._collapsedSections.delete(sectionKey);
          body.classList.remove('adv-hidden');
          chevron.textContent = '▾';
          header.setAttribute('aria-expanded', 'true');
        } else {
          this._collapsedSections.add(sectionKey);
          body.classList.add('adv-hidden');
          chevron.textContent = '▸';
          header.setAttribute('aria-expanded', 'false');
        }
        this._saveSectionCollapseState();
      },
    },
      chevron,
      el('span', {}, 'Backlog Check'),
      el('span', { className: 'adv-backlog-section-badge', 'aria-hidden': 'true' }, '⧉'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-backlog-body',
      id: 'adv-backlog-body',
    });
    if (!isExpanded) body.classList.add('adv-hidden');

    // ── Backlog input ─────────────────────────────────────────
    const inputLabel = el('label', {
      className: 'adv-backlog-input-label',
      htmlFor: 'adv-backlog-textarea',
    }, 'Your backlog (paste titles — one per line or comma-separated):');

    const itemCountEl = el('span', { className: 'adv-backlog-item-count', 'aria-live': 'polite' }, '');
    this._backlogItemCount = itemCountEl;

    const textarea = el('textarea', {
      className: 'adv-backlog-textarea',
      id: 'adv-backlog-textarea',
      rows: '5',
      placeholder: 'Paste ticket titles here — one per line or comma-separated.\nExample:\n  Fix login page redirect\n  Add dark mode toggle\n  Improve onboarding flow',
      'aria-label': 'Backlog titles for deduplication check',
      'aria-describedby': 'adv-backlog-hint',
    });
    this._backlogTextarea = textarea;

    const hint = el('div', {
      className: 'adv-backlog-hint',
      id: 'adv-backlog-hint',
    }, 'Ideas generated in Preview Run will be checked against these titles. No data is sent externally — all matching runs in your browser.');

    const parseBtn = el('button', {
      className: 'adv-backlog-parse-btn',
      onClick: () => this._parseAndLoadBacklog(textarea.value, itemCountEl),
    }, 'Load backlog');

    const clearBtn = el('button', {
      className: 'adv-backlog-clear-btn',
      onClick: () => {
        this._backlogItems = [];
        textarea.value = '';
        itemCountEl.textContent = '';
        this._announceToSR('Backlog cleared.');
      },
    }, 'Clear');

    const inputRow = el('div', { className: 'adv-backlog-input-row' },
      parseBtn,
      clearBtn,
      itemCountEl,
    );

    body.appendChild(inputLabel);
    body.appendChild(textarea);
    body.appendChild(hint);
    body.appendChild(inputRow);

    // ── Suppression mode toggle ───────────────────────────────
    // Per-session: "Surface with warning" (default) vs "Suppress duplicates"
    const suppressSection = el('div', { className: 'adv-backlog-suppress-section' });

    const suppressToggleId = 'adv-backlog-suppress-toggle';
    const suppressLabel = el('label', {
      className: 'adv-backlog-suppress-label',
      htmlFor: suppressToggleId,
    });

    const suppressCheckbox = el('input', {
      type: 'checkbox',
      id: suppressToggleId,
      className: 'adv-backlog-suppress-checkbox',
      'aria-describedby': 'adv-backlog-suppress-desc',
      onChange: () => {
        this._suppressDuplicates = suppressCheckbox.checked;
        suppressModeText.textContent = this._suppressDuplicates
          ? 'Suppress duplicates'
          : 'Surface with warning';
        this._updateSuppressedCountEl();
        this._announceToSR(this._suppressDuplicates
          ? 'Suppression mode on — duplicate ideas will be hidden from preview results.'
          : 'Suppression mode off — duplicate ideas will be shown with a warning flag.');
      },
    });

    const suppressModeText = el('span', { className: 'adv-backlog-suppress-mode-text' }, 'Surface with warning');

    suppressLabel.appendChild(suppressCheckbox);
    suppressLabel.appendChild(suppressModeText);

    const suppressDesc = el('div', {
      className: 'adv-backlog-suppress-desc',
      id: 'adv-backlog-suppress-desc',
    }, 'When on, ideas matching your backlog are hidden entirely from preview results.');

    this._suppressCountEl = el('div', {
      className: 'adv-backlog-suppressed-count adv-hidden',
      role: 'status',
      'aria-live': 'polite',
    }, '');

    suppressSection.appendChild(suppressLabel);
    suppressSection.appendChild(suppressDesc);
    suppressSection.appendChild(this._suppressCountEl);
    body.appendChild(suppressSection);

    // ── Rejection log ─────────────────────────────────────────
    const rejLogSection = el('div', { className: 'adv-backlog-rejlog-section' });
    this._rejectionLogSection = rejLogSection;

    const rejLogHeaderKey = 'rejection-log';
    const rejLogExpanded = this._collapsedCardSections.has(rejLogHeaderKey);
    const rejLogChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, rejLogExpanded ? '▾' : '▸');
    const rejLogHeader = el('button', {
      className: 'adv-backlog-rejlog-header',
      'aria-expanded': String(rejLogExpanded),
      'aria-controls': 'adv-backlog-rejlog-body',
      onClick: () => this._toggleCardSection(rejLogHeaderKey, rejLogBody, rejLogChevron, rejLogHeader),
    },
      rejLogChevron,
      el('span', {}, 'Rejection Log'),
    );

    const rejLogBody = el('div', {
      className: 'adv-backlog-rejlog-body',
      id: 'adv-backlog-rejlog-body',
      role: 'region',
      'aria-label': 'Rejection log — ideas you chose to reject',
    });
    if (!rejLogExpanded) rejLogBody.classList.add('adv-hidden');
    this._rejectionLogBody = rejLogBody;

    const rejLogSearch = el('input', {
      type: 'search',
      className: 'adv-backlog-rejlog-search',
      placeholder: 'Search rejection log…',
      'aria-label': 'Search rejection log',
      onInput: () => {
        this._rejectionLogSearch = rejLogSearch.value;
        this._renderRejectionLog();
      },
    });

    const rejLogList = el('div', {
      className: 'adv-backlog-rejlog-list',
      role: 'list',
      'aria-label': 'Rejected ideas',
    });
    this._rejectionLogList = rejLogList;

    rejLogBody.appendChild(rejLogSearch);
    rejLogBody.appendChild(rejLogList);

    rejLogSection.appendChild(rejLogHeader);
    rejLogSection.appendChild(rejLogBody);
    body.appendChild(rejLogSection);

    this._backlogSection = section;
    section.appendChild(body);

    // Render rejection log on build
    this._renderRejectionLog();

    return section;
  }

  /**
   * Parse the raw textarea input and load into _backlogItems.
   * Validates input size before processing. Announces count via ARIA.
   *
   * @param {string} raw - Raw text from the textarea
   * @param {HTMLElement} countEl - Element to update with item count
   */
  _parseAndLoadBacklog(raw, countEl) {
    if (!raw || !raw.trim()) {
      countEl.textContent = 'No input — paste some ticket titles first.';
      return;
    }

    // Validate input size (cap at ~200KB of raw text to avoid browser hangs)
    if (raw.length > 200_000) {
      countEl.textContent = 'Input too large — paste up to 2,000 titles at a time.';
      return;
    }

    const items = this._parseBacklogInput(raw);
    if (items.length === 0) {
      countEl.textContent = 'No titles found — check your input format.';
      return;
    }

    this._backlogItems = items;
    const msg = `${items.length.toLocaleString()} item${items.length !== 1 ? 's' : ''} loaded`;
    countEl.textContent = msg;
    this._announceToSR(`Backlog loaded: ${msg}. Ideas in Preview Run will be checked against these titles.`);
  }

  /**
   * Update the suppressed count display element.
   * Shows/hides based on whether suppression is active and count > 0.
   */
  _updateSuppressedCountEl() {
    if (!this._suppressCountEl) return;
    if (this._suppressDuplicates && this._suppressedCount > 0) {
      this._suppressCountEl.textContent =
        `${this._suppressedCount} idea${this._suppressedCount !== 1 ? 's' : ''} suppressed as likely duplicates — turn off suppression to view them.`;
      this._suppressCountEl.classList.remove('adv-hidden');
    } else {
      this._suppressCountEl.classList.add('adv-hidden');
    }
  }

  /**
   * Check a proposal against the PM's backlog and return match info.
   * Used in _buildProposalCard to show inline dedup flags.
   *
   * @param {string} ideaTitle
   * @returns {{ isMatch: boolean, matchTitle?: string, score?: number, scoreLabel?: string } }
   */
  _checkBacklogMatch(ideaTitle) {
    const match = this._findBacklogMatch(ideaTitle);
    if (!match) return { isMatch: false };
    const pct = Math.round(match.score * 100);
    return {
      isMatch: true,
      matchTitle: match.matchTitle,
      score: match.score,
      scoreLabel: `~${pct}% similarity`,
    };
  }

  // ── Rejection log helpers ─────────────────────────────────────────────────

  /**
   * Load per-session rejection log from sessionStorage.
   * Entries: { id, ideaTitle, matchedTitle, note, dismissedAt, action }
   * action: 'already_captured' | 'keep_different' | 'reject_entirely'
   */
  _loadRejectionLog() {
    try {
      const raw = sessionStorage.getItem('adv-rejection-log');
      if (raw) return JSON.parse(raw);
    } catch (_) {/* ignore */}
    return [];
  }

  /** Persist rejection log to sessionStorage. */
  _saveRejectionLog() {
    try {
      sessionStorage.setItem('adv-rejection-log', JSON.stringify(this._rejectionLog));
    } catch (_) {/* ignore */}
  }

  /**
   * Add an entry to the rejection log and re-render.
   *
   * @param {{ ideaTitle: string, matchedTitle: string|null, note: string, action: string }} entry
   */
  _addToRejectionLog(entry) {
    const id = `rej-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this._rejectionLog.unshift({
      id,
      ideaTitle: String(entry.ideaTitle || '').slice(0, 200),
      matchedTitle: entry.matchedTitle ? String(entry.matchedTitle).slice(0, 200) : null,
      note: String(entry.note || '').slice(0, 500),
      action: entry.action || 'reject_entirely',
      dismissedAt: new Date().toISOString(),
    });
    // Cap log at 500 entries per session (not a database; just in-memory with sessionStorage backup)
    if (this._rejectionLog.length > 500) this._rejectionLog.pop();
    this._saveRejectionLog();
    this._renderRejectionLog();
  }

  /**
   * Render (or re-render) the rejection log list with current search filter.
   * Called whenever the log changes or search input changes.
   */
  _renderRejectionLog() {
    if (!this._rejectionLogList) return;
    this._rejectionLogList.innerHTML = '';

    const query = (this._rejectionLogSearch || '').toLowerCase().trim();
    const filtered = this._rejectionLog.filter(entry => {
      if (!query) return true;
      return (
        entry.ideaTitle.toLowerCase().includes(query) ||
        (entry.matchedTitle || '').toLowerCase().includes(query) ||
        (entry.note || '').toLowerCase().includes(query)
      );
    });

    if (filtered.length === 0) {
      const emptyMsg = this._rejectionLog.length === 0
        ? 'No rejected ideas yet. Use "Reject entirely" on flagged proposals to log them here.'
        : 'No results match your search.';
      this._rejectionLogList.appendChild(
        el('div', { className: 'adv-backlog-rejlog-empty' }, emptyMsg)
      );
      return;
    }

    for (const entry of filtered) {
      const actionLabels = {
        already_captured: 'Already captured',
        keep_different: 'Keep — different angle',
        reject_entirely: 'Rejected',
      };
      const actionLabel = actionLabels[entry.action] || entry.action;
      const relTime = entry.dismissedAt
        ? formatRelative(entry.dismissedAt)
        : null;

      const item = el('div', {
        className: 'adv-backlog-rejlog-item',
        role: 'listitem',
      });

      const titleEl = el('div', { className: 'adv-backlog-rejlog-item-title' });
      titleEl.textContent = entry.ideaTitle;

      const metaRow = el('div', { className: 'adv-backlog-rejlog-item-meta' });
      const actionBadge = el('span', { className: `adv-backlog-rejlog-action adv-backlog-rejlog-action-${entry.action}` });
      actionBadge.textContent = actionLabel;
      metaRow.appendChild(actionBadge);
      if (relTime) {
        metaRow.appendChild(el('span', { className: 'adv-backlog-rejlog-time' }, relTime));
      }
      if (entry.matchedTitle) {
        const matchEl = el('span', { className: 'adv-backlog-rejlog-match' });
        matchEl.textContent = `Matched: ${entry.matchedTitle}`;
        metaRow.appendChild(matchEl);
      }

      item.appendChild(titleEl);
      item.appendChild(metaRow);

      if (entry.note) {
        const noteEl = el('div', { className: 'adv-backlog-rejlog-note' });
        noteEl.textContent = `"${entry.note}"`;
        item.appendChild(noteEl);
      }

      this._rejectionLogList.appendChild(item);
    }
  }

  /**
   * Announce a message to screen readers via the ARIA live region.
   * @param {string} msg
   */
  _announceToSR(msg) {
    if (!this._liveRegion) return;
    this._liveRegion.textContent = '';
    // Force a DOM update tick so screen readers detect the change
    setTimeout(() => {
      if (this._liveRegion) this._liveRegion.textContent = msg;
      setTimeout(() => { if (this._liveRegion) this._liveRegion.textContent = ''; }, 4000);
    }, 10);
  }

  // ── DK-136: Trigger Log Drawer ────────────────────────────────────────────

  /**
   * Open the trigger log drawer. Builds it once, then reuses.
   */
  _openTriggerLogDrawer() {
    if (!this._triggerLogDrawer) {
      this._triggerLogDrawer = this._buildTriggerLogDrawer();
      document.body.appendChild(this._triggerLogDrawer);
    }

    this._triggerLogDrawerOpen = true;
    this._triggerLogDrawer.classList.remove('adv-drawer-hidden');
    this._triggerLogDrawer.setAttribute('aria-hidden', 'false');

    const firstFocusable = this._triggerLogDrawer.querySelector('button, [tabindex="0"]');
    if (firstFocusable) firstFocusable.focus();

    if (this._triggerLogEntries === null) {
      this._fetchTriggerLogEntries();
    } else {
      this._renderTriggerLogBody();
    }
  }

  /**
   * Close the trigger log drawer.
   */
  _closeTriggerLogDrawer() {
    if (!this._triggerLogDrawer) return;
    this._triggerLogDrawerOpen = false;
    this._triggerLogDrawer.classList.add('adv-drawer-hidden');
    this._triggerLogDrawer.setAttribute('aria-hidden', 'true');
    if (this._triggerLogBtn) this._triggerLogBtn.focus();
  }

  /**
   * Build the trigger log drawer DOM once.
   * @returns {HTMLElement}
   */
  _buildTriggerLogDrawer() {
    const self = this;

    const backdrop = el('div', {
      className: 'adv-drawer-backdrop',
      'aria-hidden': 'true',
      onClick: () => self._closeTriggerLogDrawer(),
    });

    const panel = el('div', {
      className: 'adv-drawer-panel adv-trigger-log-drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Advisor trigger log',
    });

    // Header
    const closeBtn = el('button', {
      className: 'adv-drawer-close',
      'aria-label': 'Close trigger log',
      title: 'Close',
      onClick: () => self._closeTriggerLogDrawer(),
    }, '✕');

    const refreshBtn = el('button', {
      className: 'adv-drawer-refresh',
      'aria-label': 'Refresh trigger log',
      title: 'Refresh',
      onClick: () => {
        self._triggerLogEntries = null;
        self._fetchTriggerLogEntries();
      },
    }, '↻');

    const drawerTitle = el('h2', { className: 'adv-drawer-title' }, 'Trigger Log');

    // Filter bar — by persona
    const filterAll = el('button', {
      className: 'adv-trigger-log-filter-btn adv-trigger-log-filter-active',
      'aria-pressed': 'true',
      onClick: () => {
        self._triggerLogFilter = null;
        self._renderTriggerLogBody();
        filterAll.setAttribute('aria-pressed', 'true');
        filterAll.classList.add('adv-trigger-log-filter-active');
        [filterEngineer, filterDesign, filterProduct, filterQA].forEach(b => {
          b.setAttribute('aria-pressed', 'false');
          b.classList.remove('adv-trigger-log-filter-active');
        });
      },
    }, 'All');

    const makeFilterBtn = (pid, label) => el('button', {
      className: 'adv-trigger-log-filter-btn',
      'aria-pressed': 'false',
      onClick: () => {
        self._triggerLogFilter = pid;
        self._renderTriggerLogBody();
        filterAll.setAttribute('aria-pressed', 'false');
        filterAll.classList.remove('adv-trigger-log-filter-active');
        [filterEngineer, filterDesign, filterProduct, filterQA].forEach(b => {
          const active = b.dataset.persona === pid;
          b.setAttribute('aria-pressed', String(active));
          b.classList.toggle('adv-trigger-log-filter-active', active);
        });
      },
    }, label);

    const filterEngineer = makeFilterBtn('engineer', 'Engineer');
    filterEngineer.dataset.persona = 'engineer';
    const filterDesign = makeFilterBtn('design', 'Design');
    filterDesign.dataset.persona = 'design';
    const filterProduct = makeFilterBtn('product', 'Product');
    filterProduct.dataset.persona = 'product';
    const filterQA = makeFilterBtn('qa', 'QA');
    filterQA.dataset.persona = 'qa';

    const filterBar = el('div', { className: 'adv-trigger-log-filter-bar', role: 'group', 'aria-label': 'Filter by persona' },
      filterAll,
      filterEngineer,
      filterDesign,
      filterProduct,
      filterQA,
    );

    const headerRow = el('div', { className: 'adv-drawer-header' },
      drawerTitle,
      el('div', { className: 'adv-drawer-header-actions' },
        refreshBtn,
        closeBtn,
      ),
    );

    // Body — holds loading spinner or table
    const body = el('div', { className: 'adv-trigger-log-body' });
    this._triggerLogBodyEl = body;
    this._triggerLogFilterAll = filterAll;
    this._triggerLogFilterBtns = [filterEngineer, filterDesign, filterProduct, filterQA];

    panel.appendChild(headerRow);
    panel.appendChild(filterBar);
    panel.appendChild(body);

    const overlay = el('div', {
      className: 'adv-drawer-overlay adv-drawer-hidden',
      role: 'presentation',
    });
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);

    return overlay;
  }

  /**
   * Fetch trigger log entries from Firestore.
   */
  async _fetchTriggerLogEntries() {
    if (this._triggerLogLoading) return;
    this._triggerLogLoading = true;
    if (this._triggerLogBodyEl) {
      this._triggerLogBodyEl.textContent = '';
      this._triggerLogBodyEl.appendChild(
        el('div', { className: 'adv-trigger-log-loading' }, 'Loading…')
      );
    }

    try {
      let query = this.db.collection('advisorTriggerLog')
        .orderBy('triggeredAt', 'desc')
        .limit(100);

      const snap = await query.get();
      this._triggerLogEntries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      this._triggerLogEntries = [];
      console.error('Failed to load trigger log:', err);
    } finally {
      this._triggerLogLoading = false;
      this._renderTriggerLogBody();
    }
  }

  /**
   * Render the trigger log table body.
   */
  _renderTriggerLogBody() {
    if (!this._triggerLogBodyEl) return;
    this._triggerLogBodyEl.textContent = '';

    const entries = this._triggerLogEntries || [];
    const filtered = this._triggerLogFilter
      ? entries.filter(e => e.personaId === this._triggerLogFilter)
      : entries;

    if (filtered.length === 0) {
      const emptyMsg = entries.length === 0
        ? 'No trigger events yet. Runs are logged here when triggered by webhook, ticket-close count, or manual button.'
        : 'No entries for this persona.';
      this._triggerLogBodyEl.appendChild(
        el('div', { className: 'adv-trigger-log-empty' }, emptyMsg)
      );
      return;
    }

    // Table with columns: Persona | Trigger | When | Proposals
    const thead = el('thead', {},
      el('tr', {},
        el('th', { scope: 'col' }, 'Persona'),
        el('th', { scope: 'col' }, 'Trigger'),
        el('th', { scope: 'col' }, 'When'),
        el('th', { scope: 'col' }, 'Proposals'),
      ),
    );

    const TRIGGER_LABELS = {
      manual: 'Manual',
      webhook: 'Webhook / Deploy',
      ticketCloseCount: 'Ticket batch',
      interval: 'Scheduled',
    };

    const PERSONA_LABELS = {
      engineer: 'Engineer',
      design: 'Design',
      product: 'Product',
      qa: 'QA',
    };

    const rows = filtered.map(entry => {
      const personaLabel = PERSONA_LABELS[entry.personaId] || entry.personaId;
      const triggerLabel = TRIGGER_LABELS[entry.trigger] || entry.trigger;
      const whenText = entry.triggeredAt ? (formatRelative(entry.triggeredAt) || new Date(entry.triggeredAt).toLocaleString()) : '—';
      const proposalsText = entry.proposalsCreated != null ? String(entry.proposalsCreated) : '—';
      const byText = entry.triggeredBy && entry.triggeredBy !== 'system' && entry.triggeredBy !== 'webhook'
        ? ` (${entry.triggeredBy})`
        : '';

      return el('tr', { className: 'adv-trigger-log-row' },
        el('td', {}, personaLabel),
        el('td', {}, triggerLabel + byText),
        el('td', {},
          el('time', { datetime: entry.triggeredAt || '' }, whenText),
        ),
        el('td', {}, proposalsText),
      );
    });

    const tbody = el('tbody', {}, ...rows);
    const table = el('table', {
      className: 'adv-trigger-log-table',
      'aria-label': 'Trigger log',
    }, thead, tbody);

    this._triggerLogBodyEl.appendChild(table);
  }
}
