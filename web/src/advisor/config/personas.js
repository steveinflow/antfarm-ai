// Persona configuration constants for the AdvisorPanel.
// Pure data — no DOM dependencies. Imported by advisor-panel.js and view modules.

export const PERSONAS = [
  { id: 'product',  label: 'Product',  defaultHours: 24 },
  { id: 'design',   label: 'Design',   defaultHours: 6  },
  { id: 'engineer', label: 'Engineer', defaultHours: 12 },
  { id: 'qa',       label: 'QA',       defaultHours: 6  },
];

// Per-persona hint text shown below the interval input (spec requirement).
// Warns admins about resource-intensive personas.
export const PERSONA_INTERVAL_HINTS = {
  product:  'Runs across all projects — daily or less is typical.',
  // DK-111: Design tooltip — note headless Chrome usage so users make informed throttling decisions.
  design:   'Uses headless Chrome to capture visual snapshots — heavier than other personas. Throttle generously.',
  engineer: 'Scans the codebase — 12h minimum recommended.',
  qa:       'Runs Playwright browser flows — 6h minimum recommended.',
};

// DK-039: Per-persona example placeholders for the focus directive input.
// Shown as placeholder text in the inline input to reduce blank-page paralysis.
export const PERSONA_DIRECTIVE_PLACEHOLDERS = {
  engineer: 'e.g. only audit src/auth and src/payments',
  design:   'e.g. focus on mobile onboarding flow',
  product:  'e.g. ideas for reducing checkout drop-off',
  qa:       'e.g. test the checkout and payment flows',
};

// DK-039: One-liner descriptions shown below each persona header in the directive section.
// Helps users unfamiliar with persona distinctions understand what each one does.
export const PERSONA_DIRECTIVE_DESCRIPTIONS = {
  engineer: 'Reviews your codebase for security vulnerabilities, performance issues, and code quality.',
  design:   'Captures screenshots of your app and audits the UI for usability and accessibility issues.',
  product:  'Generates feature ideas grounded in your project context and team priorities.',
  qa:       'Runs browser flows against your app to find broken functionality and regressions.',
};

// Reserved names that cannot be used for custom personas
export const RESERVED_NAMES = new Set(['Engineer', 'Design', 'Product', 'QA']);

// Valid models for custom personas, labeled by behavior
export const CUSTOM_PERSONA_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku — fast, low cost' },
  { value: 'claude-sonnet-4-6',         label: 'Sonnet — balanced' },
  { value: 'claude-opus-4-5',           label: 'Opus — thorough, slower' },
];

// Schedule presets — translate human-readable labels to/from intervalHours
// Ordered per spec: 1h, 6h, 12h, 24h, 48h plus a Custom option.
export const SCHEDULE_PRESETS = [
  { label: 'Every 1 hour',   hours: 1   },
  { label: 'Every 6 hours',  hours: 6   },
  { label: 'Every 12 hours', hours: 12  },
  { label: 'Every 24 hours', hours: 24  },
  { label: 'Every 48 hours', hours: 48  },
  { label: 'Custom…',        hours: null },
];

// Starter template for new custom persona system prompts
export const CUSTOM_PERSONA_STARTER = `You are a specialist reviewer focused on [your focus area].

Your responsibilities:
1. [Primary responsibility]
2. [Secondary responsibility]
3. [Additional concern]

Be specific and actionable. Only flag real issues — not theoretical edge cases.
Prioritize by impact: [high priority] > [medium priority] > [low priority].`;

// DK-120: Advisor context quality hints — example placeholder text shown in textarea.
// Two realistic project types joined with \n so users see variety.
export const CONTEXT_EXAMPLES = [
  'B2B fintech SaaS for mid-market accounting teams. Core workflows: invoice approval, audit trails, multi-entity reporting.',
  'Consumer mobile app for habit tracking. Growth stage, iOS-first. Key metrics: D7 retention and streak completion rate.',
].join('\n');

// Known-bad short values treated as minimal regardless of length.
export const CONTEXT_KNOWN_BAD = ['my app', 'todo app', 'test', ''];

// ── Persona display name mapping ─────────────────────────────
// Maps personaId to human-readable persona name for the run log drawer.
export const PERSONA_DISPLAY_NAMES = {
  engineer: 'Engineer',
  design:   'Design',
  product:  'Product',
  qa:       'QA',
};

// ── Persona avatar SVGs ───────────────────────────────────────
// Each persona has an idle and a working SVG representation.
// The working state shows them actively engaged (typing, drawing, reviewing code).

export const PERSONA_AVATARS = {
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
