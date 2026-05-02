// Persona constraint serializer — DK-365
//
// Converts a persona constraints object into a human-readable block
// prepended to the system prompt. The serializer is deterministic and
// auditable: same input always produces the same output.
//
// Constraints are stored on the project document at:
//   project.advisorSettings.<personaId>.constraints
//
// Shape:
// {
//   budget_range:     { min: number, max: number },   // dollars
//   platform_target:  string[],                       // ['web', 'mobile', 'desktop', 'api']
//   audience_segment: string,                         // max 200 chars
//   complexity_cap:   'low' | 'medium' | 'high',
//   risk_tolerance:   'conservative' | 'moderate' | 'balanced' | 'adventurous' | 'aggressive'
// }
//
// Validation is enforced server-side (here) before the prompt is built.
// Client-side validation is UX only.

// ── Enum allowlists ───────────────────────────────────────────────────────

const VALID_COMPLEXITY_CAPS = new Set(['low', 'medium', 'high']);
const VALID_RISK_TOLERANCES = new Set(['conservative', 'moderate', 'balanced', 'adventurous', 'aggressive']);
const VALID_PLATFORMS       = new Set(['web', 'mobile', 'desktop', 'api']);

const AUDIENCE_MAX_CHARS = 200;

// Strip prompt injection patterns from audience_segment
// (triple backticks, XML-style system tags, instruction override phrases)
const AUDIENCE_BLOCKLIST_RE = /```|<\/?system>|<\|im_start\||<\|im_end\||ignore previous|ignore all previous/gi;
const AUDIENCE_ALLOWLIST_RE = /[^a-zA-Z0-9 ,.\-_():&'/]/g; // keep common readable chars

// ── Budget label helpers ──────────────────────────────────────────────────

const BUDGET_ANCHORS = [
  { max: 0,       label: 'Zero / no budget' },
  { max: 5000,    label: 'Bootstrapped' },
  { max: 25000,   label: 'Small seed' },
  { max: 100000,  label: 'Seed-funded' },
  { max: 250000,  label: 'Series A range' },
  { max: 500000,  label: 'Series A+' },
  { max: Infinity, label: 'Funded / enterprise' },
];

function budgetLabel(value) {
  for (const anchor of BUDGET_ANCHORS) {
    if (value <= anchor.max) return anchor.label;
  }
  return 'Funded';
}

function formatBudget(min, max) {
  const fmt = (n) => n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1000
    ? `$${(n / 1000).toFixed(0)}K`
    : `$${n}`;

  if (min === max) return `${fmt(min)} (${budgetLabel(min)})`;
  if (max >= 500000) return `${fmt(min)}–${fmt(max)}+ (${budgetLabel(max)})`;
  return `${fmt(min)}–${fmt(max)} (${budgetLabel(max)})`;
}

// ── Platform display names ────────────────────────────────────────────────

const PLATFORM_LABELS = {
  web:     'Web',
  mobile:  'Mobile',
  desktop: 'Desktop',
  api:     'API/Backend',
};

// ── Risk tolerance display names ──────────────────────────────────────────

const RISK_LABELS = {
  conservative: 'Conservative',
  moderate:     'Moderate',
  balanced:     'Balanced',
  adventurous:  'Adventurous',
  aggressive:   'Aggressive',
};

// ── Complexity display names ──────────────────────────────────────────────

const COMPLEXITY_LABELS = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
};

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Validate and sanitize a raw constraints object.
 * Returns a validated constraints object with only known keys.
 * Throws a descriptive error if any field fails validation.
 *
 * @param {unknown} raw
 * @returns {{ budget_range?: {min:number,max:number}, platform_target?: string[], audience_segment?: string, complexity_cap?: string, risk_tolerance?: string }}
 */
export function validateConstraints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('constraints must be a plain object');
  }

  // Reject unknown keys
  const KNOWN_KEYS = new Set(['budget_range', 'platform_target', 'audience_segment', 'complexity_cap', 'risk_tolerance']);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`Unknown constraint key: "${key}"`);
    }
  }

  const out = {};

  // budget_range
  if ('budget_range' in raw) {
    const br = raw.budget_range;
    if (!br || typeof br !== 'object' || Array.isArray(br)) {
      throw new Error('budget_range must be an object with min and max');
    }
    const min = Number(br.min);
    const max = Number(br.max);
    if (!Number.isFinite(min) || min < 0) throw new Error('budget_range.min must be a non-negative number');
    if (!Number.isFinite(max) || max < 0) throw new Error('budget_range.max must be a non-negative number');
    if (min > max) throw new Error('budget_range.min must be ≤ max');
    if (max > 10_000_000) throw new Error('budget_range.max must be ≤ $10,000,000');
    out.budget_range = { min: Math.floor(min), max: Math.floor(max) };
  }

  // platform_target
  if ('platform_target' in raw) {
    const pt = raw.platform_target;
    if (!Array.isArray(pt)) throw new Error('platform_target must be an array');
    const validated = [];
    for (const p of pt) {
      if (typeof p !== 'string' || !VALID_PLATFORMS.has(p)) {
        throw new Error(`platform_target contains invalid value: "${p}". Allowed: ${[...VALID_PLATFORMS].join(', ')}`);
      }
      if (!validated.includes(p)) validated.push(p);
    }
    out.platform_target = validated;
  }

  // audience_segment
  if ('audience_segment' in raw) {
    const as_ = raw.audience_segment;
    if (typeof as_ !== 'string') throw new Error('audience_segment must be a string');
    if (as_.length > AUDIENCE_MAX_CHARS) {
      throw new Error(`audience_segment must be ≤ ${AUDIENCE_MAX_CHARS} characters`);
    }
    // Strip injection patterns and non-allowlisted characters
    const sanitized = as_
      .replace(AUDIENCE_BLOCKLIST_RE, '')
      .replace(AUDIENCE_ALLOWLIST_RE, '')
      .trim();
    out.audience_segment = sanitized;
  }

  // complexity_cap
  if ('complexity_cap' in raw) {
    const cc = raw.complexity_cap;
    if (typeof cc !== 'string' || !VALID_COMPLEXITY_CAPS.has(cc)) {
      throw new Error(`complexity_cap must be one of: ${[...VALID_COMPLEXITY_CAPS].join(', ')}`);
    }
    out.complexity_cap = cc;
  }

  // risk_tolerance
  if ('risk_tolerance' in raw) {
    const rt = raw.risk_tolerance;
    if (typeof rt !== 'string' || !VALID_RISK_TOLERANCES.has(rt)) {
      throw new Error(`risk_tolerance must be one of: ${[...VALID_RISK_TOLERANCES].join(', ')}`);
    }
    out.risk_tolerance = rt;
  }

  return out;
}

// ── Conflict detection ────────────────────────────────────────────────────

/**
 * Check for logically conflicting constraints.
 * Returns an array of plain-language conflict messages (empty = no conflicts).
 *
 * @param {{ budget_range?, complexity_cap?, platform_target?, risk_tolerance? }} constraints
 * @returns {string[]}
 */
export function detectConstraintConflicts(constraints) {
  const conflicts = [];

  if (!constraints || typeof constraints !== 'object') return conflicts;

  // Zero budget + high complexity
  if (constraints.budget_range && constraints.complexity_cap === 'high') {
    const { min, max } = constraints.budget_range;
    if (max <= 5000) {
      conflicts.push(
        'High complexity ideas typically require engineering investment. Consider raising your budget range or lowering complexity to "Medium" or "Low".'
      );
    }
  }

  // Zero budget + aggressive risk
  if (constraints.budget_range && constraints.risk_tolerance === 'aggressive') {
    const { max } = constraints.budget_range;
    if (max <= 5000) {
      conflicts.push(
        'Aggressive risk tolerance with a near-zero budget may produce ideas that are hard to execute. Consider "Moderate" risk or a higher budget range.'
      );
    }
  }

  // Desktop-only + mobile-only would be both selected — not a conflict (user chose both platforms)
  // Only flag if NO platform is selected (empty array)
  if (Array.isArray(constraints.platform_target) && constraints.platform_target.length === 0) {
    conflicts.push(
      'No platform target selected. Select at least one platform so ideas are grounded in a delivery context.'
    );
  }

  return conflicts;
}

// ── Serializer ────────────────────────────────────────────────────────────

/**
 * Serialize a validated constraints object into a human-readable block
 * suitable for injection into a persona system prompt.
 *
 * Returns null if the constraints object is empty or null.
 * The returned string is ready to prepend to the system prompt with a newline separator.
 *
 * @param {{ budget_range?, platform_target?, audience_segment?, complexity_cap?, risk_tolerance? }|null} constraints
 * @returns {string|null}
 */
export function serializeConstraints(constraints) {
  if (!constraints || typeof constraints !== 'object') return null;

  const lines = [];

  if (constraints.budget_range) {
    const { min, max } = constraints.budget_range;
    lines.push(`Budget: ${formatBudget(min, max)}`);
  }

  if (Array.isArray(constraints.platform_target) && constraints.platform_target.length > 0) {
    const labels = constraints.platform_target.map(p => PLATFORM_LABELS[p] || p);
    lines.push(`Platform: ${labels.join(', ')}`);
  }

  if (constraints.audience_segment) {
    lines.push(`Audience: ${constraints.audience_segment}`);
  }

  if (constraints.complexity_cap) {
    lines.push(`Complexity: ${COMPLEXITY_LABELS[constraints.complexity_cap] || constraints.complexity_cap}`);
  }

  if (constraints.risk_tolerance) {
    lines.push(`Risk tolerance: ${RISK_LABELS[constraints.risk_tolerance] || constraints.risk_tolerance}`);
  }

  if (lines.length === 0) return null;

  return `[Constraints]\n${lines.join('\n')}`;
}

/**
 * Build a human-readable constraint summary for display in ticket output headers.
 * Returns null if no constraints are set.
 * Example: "mobile-only · budget under $10K · low complexity"
 *
 * @param {{ budget_range?, platform_target?, audience_segment?, complexity_cap?, risk_tolerance? }|null} constraints
 * @returns {string|null}
 */
export function buildConstraintSummary(constraints) {
  if (!constraints || typeof constraints !== 'object') return null;

  const parts = [];

  if (Array.isArray(constraints.platform_target) && constraints.platform_target.length > 0) {
    if (constraints.platform_target.length === 1) {
      parts.push(`${PLATFORM_LABELS[constraints.platform_target[0]] || constraints.platform_target[0]}-only`);
    } else {
      parts.push(constraints.platform_target.map(p => PLATFORM_LABELS[p] || p).join(' & '));
    }
  }

  if (constraints.budget_range) {
    const { min, max } = constraints.budget_range;
    if (max <= 5000) {
      parts.push('zero engineering cost');
    } else if (max <= 25000) {
      parts.push(`budget under ${max >= 1000 ? `$${max / 1000}K` : `$${max}`}`);
    } else if (max <= 100000) {
      parts.push(`budget under $${max / 1000}K`);
    } else {
      parts.push('funded');
    }
  }

  if (constraints.complexity_cap) {
    parts.push(`${constraints.complexity_cap} complexity`);
  }

  if (parts.length === 0) return null;
  return parts.join(' · ');
}

// ── Merge (per-run override) ──────────────────────────────────────────────

/**
 * Merge saved persona constraints with per-run override constraints.
 * Run overrides win on conflict. The merge is a simple shallow object merge.
 * Per-run overrides are ephemeral — callers must NOT persist the result.
 *
 * @param {{ [key: string]: unknown }|null} saved     - Saved persona constraints
 * @param {{ [key: string]: unknown }|null} runOverride - Per-run override (shadows saved)
 * @returns {{ [key: string]: unknown }|null}
 */
export function mergeConstraints(saved, runOverride) {
  if (!saved && !runOverride) return null;
  if (!saved) return runOverride;
  if (!runOverride) return saved;
  return { ...saved, ...runOverride };
}

// ── Default constraints per persona ───────────────────────────────────────

/**
 * Sensible default constraints for each persona type.
 * These are applied when a persona has no user-configured constraints.
 * All fields set to minimal values so the prompt is not overly constrained by default.
 */
export const DEFAULT_CONSTRAINTS = {
  product: {
    platform_target: ['web', 'mobile'],
    complexity_cap:  'medium',
    risk_tolerance:  'balanced',
  },
  design: {
    platform_target: ['web', 'mobile'],
    complexity_cap:  'medium',
    risk_tolerance:  'moderate',
  },
  engineer: {
    platform_target: ['web', 'mobile'],
    complexity_cap:  'medium',
    risk_tolerance:  'moderate',
  },
};

// ── Preset definitions ────────────────────────────────────────────────────

export const CONSTRAINT_PRESETS = [
  {
    id:    'lean_mvp',
    label: 'Lean MVP',
    description: 'Low complexity, bootstrapped budget, mobile + web, broad consumer audience.',
    constraints: {
      budget_range:     { min: 0, max: 25000 },
      platform_target:  ['mobile', 'web'],
      audience_segment: 'Broad consumer',
      complexity_cap:   'low',
      risk_tolerance:   'moderate',
    },
  },
  {
    id:    'enterprise_safe',
    label: 'Enterprise-safe',
    description: 'Medium complexity, funded, web-only, enterprise segment, conservative risk.',
    constraints: {
      budget_range:     { min: 50000, max: 500000 },
      platform_target:  ['web'],
      audience_segment: 'Enterprise',
      complexity_cap:   'medium',
      risk_tolerance:   'conservative',
    },
  },
  {
    id:    'consumer_mobile',
    label: 'Consumer Mobile',
    description: 'Low-medium complexity, moderate budget, mobile-only, broad consumer audience.',
    constraints: {
      budget_range:     { min: 5000, max: 100000 },
      platform_target:  ['mobile'],
      audience_segment: 'Broad consumer',
      complexity_cap:   'low',
      risk_tolerance:   'moderate',
    },
  },
];
