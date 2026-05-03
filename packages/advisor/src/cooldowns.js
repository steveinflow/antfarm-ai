// @docket/advisor — Per-persona cooldown configuration (DK-321).
// Extracted from start-advisor.js for navigability.
//
// Design uses Playwright + Vision (most expensive) — 15-minute cooldown.
// Engineer and Product — 5-minute cooldown.
// QA — 5-minute cooldown (same as engineer).
// Override via environment: ADVISOR_COOLDOWN_MS (global), or ADVISOR_COOLDOWN_DESIGN_MS.

export const COOLDOWN_MS_DEFAULT = Number(process.env.ADVISOR_COOLDOWN_MS) || 5 * 60 * 1000;  // 5 min
export const COOLDOWN_MS_DESIGN  = Number(process.env.ADVISOR_COOLDOWN_DESIGN_MS) || 15 * 60 * 1000; // 15 min

// 5-minute cooldown between on-demand runs (DK-303). Enforced server-side only.
export const RUN_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

export function getCooldownMs(personaId) {
  if (personaId === 'design') return COOLDOWN_MS_DESIGN;
  return COOLDOWN_MS_DEFAULT;
}
