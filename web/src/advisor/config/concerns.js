// Persona concern weights — DK-105.
// Concern keys are hardcoded; user-supplied keys must never reach Firestore or the prompt.

/** Allowlisted concern keys per persona (must match weight-builder.js). */
export const PERSONA_CONCERNS = {
  engineer: ['security', 'performance', 'maintainability'],
  design:   ['layout', 'copy', 'flow'],
  product:  ['user_value', 'feasibility', 'strategic_fit'],
};

/** Human-readable labels and inline descriptions for each concern key. */
export const CONCERN_META = {
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
export const WEIGHT_PRESETS = {
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
