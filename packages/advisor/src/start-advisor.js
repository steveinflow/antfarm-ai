// @docket/advisor — programmatic entry point
// Exported so other packages (e.g. the orchestrator) can embed the advisor
// without spawning a separate process.
//
// Usage:
//   import { startAdvisor } from '@docket/advisor';
//   const stopAdvisor = await startAdvisor({ db, advisorConfig });
//   // later:
//   stopAdvisor();

import admin from 'firebase-admin';
import { createTicketService, createProjectService, createFeedbackService } from '@docket/core';
import { createEngineer } from './engineer.js';
import { createDesigner } from './design.js';
import { createProductManager } from './product.js';
import { createQA } from './qa.js';
import { createPersonaState } from './state.js';
import { createRunLogger, sanitizeError } from './run-logger.js';
import { loadCustomPersonas, sanitizeFocusPrompt } from './custom-personas-config.js';
import { createCustomPersona } from './custom-persona.js';
import { createAdvisorFeedbackService } from './advisor-feedback-service.js';
import { cleanupExpiredDryRuns, startDryRunListener } from './dry-run.js';
import { buildWeightPriorityLine } from './weight-builder.js';
import { startWebhookServer } from './webhook-server.js';
import { startTicketCloseTriggers } from './trigger-listeners.js';
import { validateConstraints } from './constraints.js';
import { validateFocus } from './focus-validator.js';
import { getValidatedMinConfidence, sanitizeUserHint, sanitizeDirective } from './validators.js';
import { getCooldownMs, RUN_REQUEST_COOLDOWN_MS } from './cooldowns.js';
import { readDirective } from './directive.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const _advisorDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCREENSHOT_DIR = resolve(_advisorDir, '../../orchestrator/logs/advisor-screenshots');

function log(persona, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${persona}] ${msg}`);
}

// ── Time window helpers (DK-303) ────────────────────────────────────────────
// Validates allowedHours config from Firestore before use.
// Returns true if valid, false and logs a warning if not.
const VALID_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/**
 * Validate an allowedHours config object.
 * @param {*} raw - raw value from Firestore
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAllowedHours(raw) {
  if (raw == null) return { valid: true, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['allowedHours must be an object'] };
  }
  const errors = [];
  const { start, end, days } = raw;
  if (!Number.isInteger(start) || start < 0 || start > 23) {
    errors.push(`allowedHours.start must be integer 0–23 (got ${start})`);
  }
  if (!Number.isInteger(end) || end < 0 || end > 23) {
    errors.push(`allowedHours.end must be integer 0–23 (got ${end})`);
  }
  if (!Array.isArray(days)) {
    errors.push('allowedHours.days must be an array');
  } else {
    const invalid = days.filter(d => !VALID_DAYS.has(d));
    if (invalid.length > 0) errors.push(`allowedHours.days contains invalid values: ${invalid.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}

// Day abbreviation to JS Date.getUTCDay() index (0=Sun, 1=Mon, ...)
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Check if the given UTC timestamp falls within the allowedHours window.
 * Handles overnight windows (e.g., start=22, end=06 wraps across midnight).
 * @param {{ start: number, end: number, days: string[] }} allowedHours - validated config
 * @param {Date} nowUtc - current UTC time
 * @returns {boolean}
 */
function isWithinWindow(allowedHours, nowUtc) {
  const utcDay = nowUtc.getUTCDay(); // 0=Sun ... 6=Sat
  const utcHour = nowUtc.getUTCHours();
  const { start, end, days } = allowedHours;

  // Check if today's day abbreviation is in the allowed set
  const todayAbbr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][utcDay];
  if (!days.includes(todayAbbr)) return false;

  if (start <= end) {
    // Normal window (e.g., 9–18): hour must be in [start, end)
    return utcHour >= start && utcHour < end;
  } else {
    // Overnight window (e.g., 22–06): hour >= start OR hour < end
    return utcHour >= start || utcHour < end;
  }
}

/**
 * Calculate milliseconds until the next window opens.
 * Scans forward up to 7 days to find the next open slot.
 * @param {{ start: number, end: number, days: string[] }} allowedHours - validated config
 * @param {Date} nowUtc - current UTC time
 * @returns {number} milliseconds to wait (0 if already in window)
 */
function msUntilWindowOpen(allowedHours, nowUtc) {
  if (isWithinWindow(allowedHours, nowUtc)) return 0;
  const { start, days } = allowedHours;
  // Try each hour slot up to 7*24 hours ahead
  for (let h = 1; h <= 7 * 24; h++) {
    const candidate = new Date(nowUtc.getTime() + h * 3_600_000);
    if (isWithinWindow(allowedHours, candidate)) return h * 3_600_000;
  }
  // No window found in next 7 days — shouldn't happen with valid config
  return 24 * 3_600_000; // retry in 24h
}

// ── Schedule helpers (DK-195) ────────────────────────────────────────────────
// New "schedule" field: { timezone, allowedDays, windowStart, windowEnd }
// timezone: IANA string (e.g. "America/New_York")
// allowedDays: array of JS day integers (0=Sun, 1=Mon, ..., 6=Sat)
// windowStart / windowEnd: "HH:MM" 24-hour strings (e.g. "21:00", "06:00")
// Backward-compatible: if schedule is absent, falls back to allowedHours check.

/**
 * Parse an "HH:MM" string to total minutes (0–1439).
 * Returns -1 if invalid.
 */
function parseMinutes(hhmm) {
  if (typeof hhmm !== 'string') return -1;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/**
 * Validate a schedule config object (DK-195).
 * @param {*} raw - raw value from Firestore
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSchedule(raw) {
  if (raw == null) return { valid: true, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['schedule must be an object'] };
  }
  const errors = [];
  const { timezone, allowedDays, windowStart, windowEnd } = raw;

  // Validate timezone (IANA string)
  if (typeof timezone !== 'string' || !timezone) {
    errors.push('schedule.timezone must be a non-empty string');
  } else {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      errors.push(`schedule.timezone is not a valid IANA timezone: "${timezone}"`);
    }
  }

  // Validate allowedDays: array of integers 0–6
  if (!Array.isArray(allowedDays)) {
    errors.push('schedule.allowedDays must be an array');
  } else {
    const invalid = allowedDays.filter(d => !Number.isInteger(d) || d < 0 || d > 6);
    if (invalid.length > 0) errors.push(`schedule.allowedDays contains invalid values: ${invalid.join(', ')}`);
  }

  // Validate windowStart / windowEnd: "HH:MM"
  if (parseMinutes(windowStart) === -1) {
    errors.push(`schedule.windowStart must be "HH:MM" (got ${windowStart})`);
  }
  if (parseMinutes(windowEnd) === -1) {
    errors.push(`schedule.windowEnd must be "HH:MM" (got ${windowEnd})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if the given timestamp falls within the schedule window (DK-195).
 * Uses Intl.DateTimeFormat with the stored IANA timezone — no dependencies needed.
 * Handles overnight windows (e.g. windowStart="21:00", windowEnd="06:00").
 * @param {{ timezone: string, allowedDays: number[], windowStart: string, windowEnd: string }} schedule
 * @param {Date} now
 * @returns {boolean}
 */
function isWithinSchedule(schedule, now) {
  if (!schedule) return true;
  const { timezone, allowedDays, windowStart, windowEnd } = schedule;

  // Get local day-of-week and HH:MM in the persona's timezone using Intl
  let localDay, localMinutes;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    }).formatToParts(now);

    const dayStr = parts.find(p => p.type === 'weekday')?.value?.toLowerCase();
    const hourStr = parts.find(p => p.type === 'hour')?.value;
    const minStr  = parts.find(p => p.type === 'minute')?.value;

    // Intl weekday short: 'Sun','Mon','Tue','Wed','Thu','Fri','Sat'
    const WEEKDAY_TO_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    localDay = WEEKDAY_TO_INDEX[dayStr];
    if (localDay === undefined) return true; // defensive: skip check if parse fails

    const h = parseInt(hourStr, 10);
    const m = parseInt(minStr, 10);
    // hour12:false can yield '24' for midnight — normalize
    localMinutes = (h === 24 ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
  } catch {
    // If timezone is invalid or Intl fails, skip the check (log + run anyway)
    return true;
  }

  // Check day
  if (!allowedDays.includes(localDay)) return false;

  // Check time window (supports overnight: start > end)
  const s = parseMinutes(windowStart);
  const e = parseMinutes(windowEnd);
  if (s === -1 || e === -1) return true; // defensive

  if (s <= e) {
    return localMinutes >= s && localMinutes < e;
  } else {
    // Overnight: e.g. 21:00–06:00 → active from 21:00 to 23:59 and 00:00 to 05:59
    return localMinutes >= s || localMinutes < e;
  }
}

/**
 * Calculate milliseconds until the next schedule window opens (DK-195).
 * Walks forward in 1-minute increments up to 8 days. Returns 24h if nothing found.
 * @param {{ timezone: string, allowedDays: number[], windowStart: string, windowEnd: string }} schedule
 * @param {Date} now
 * @returns {number} milliseconds to wait
 */
function msUntilScheduleOpen(schedule, now) {
  if (isWithinSchedule(schedule, now)) return 0;
  // Walk forward in 1-minute steps to find the exact window open moment
  const s = parseMinutes(schedule.windowStart);
  if (s === -1) return 24 * 3_600_000;

  // Jump to the next candidate start time to avoid scanning 11,520 minutes naively.
  // Try each day in the next 8 days, at windowStart.
  for (let d = 0; d < 8; d++) {
    const candidate = new Date(now.getTime() + d * 86_400_000);
    // Set to windowStart time in local timezone via a rough approach:
    // Walk the candidate forward to the start of windowStart hour:minute
    const startH = Math.floor(s / 60);
    const startM = s % 60;
    // Build a date string in the target timezone at the candidate day + window start
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: schedule.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(candidate);
      const year  = parts.find(p => p.type === 'year')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day   = parts.find(p => p.type === 'day')?.value;
      if (!year || !month || !day) continue;

      // Construct a timestamp string and parse it — this finds the UTC equivalent of
      // windowStart on that calendar day in the target timezone.
      const localStr = `${year}-${month}-${day}T${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`;
      // Use a trick: format a known UTC time to find the offset at that instant.
      // We approximate by checking the candidate offset: parse localStr as if UTC
      // then adjust by the actual offset at that point.
      const naive = new Date(localStr + 'Z'); // treat as UTC first
      const offsetMs = getTimezoneOffsetMs(schedule.timezone, naive);
      const windowOpenUtc = new Date(naive.getTime() - offsetMs);

      if (windowOpenUtc.getTime() > now.getTime() && isWithinSchedule(schedule, windowOpenUtc)) {
        return windowOpenUtc.getTime() - now.getTime();
      }
    } catch {
      // ignore parse errors for individual days
    }
  }
  return 24 * 3_600_000; // retry in 24h
}

/**
 * Get the UTC offset in milliseconds for a given IANA timezone at a given instant.
 * Positive = timezone is ahead of UTC (e.g. UTC+5 → +18,000,000ms).
 * @param {string} tz
 * @param {Date} date
 * @returns {number}
 */
function getTimezoneOffsetMs(tz, date) {
  // Format the date in both UTC and the target timezone, compare
  const utcStr = new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
  const localStr = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
  // Parse both as if they were UTC to get the difference
  const parseAsUTC = (s) => {
    // en locale: "MM/DD/YYYY, HH:MM:SS"
    const [datePart, timePart] = s.split(', ');
    if (!datePart || !timePart) return NaN;
    const [mm, dd, yyyy] = datePart.split('/');
    return Date.UTC(+yyyy, +mm - 1, +dd, ...timePart.split(':').map(Number));
  };
  return parseAsUTC(localStr) - parseAsUTC(utcStr);
}

// ── Persona loop ──────────────────────────────────────────────────────────
// Uses setTimeout (not setInterval) so the next cycle is always scheduled
// AFTER the current one completes. Reads intervalHours from Firestore each
// time so UI-driven changes take effect on the next cycle.
//
// runFn signature: (onActivity, focusPrompt, projectId, scopeText) => Promise<{ ticketsCreated, lastActivity }>
// focusPrompt is non-null only for on-demand trigger runs.
// projectId is non-null only for on-demand trigger runs scoped to a specific project.
// scopeText is non-null only when the user provided a focus scope for this run (DK-367).

function startPersonaLoop(name, defaultIntervalHours, runFn, personaState, { cooldownMs } = {}) {
  const _cooldownMs = cooldownMs ?? getCooldownMs(name);
  let stopped = false;
  let totalTickets = 0;
  let cycleCount = 0;
  let pendingTimer = null;
  let isRunning = false;
  let runNowPending = false;

  // Per-persona in-memory lock. Single-process daemon makes this safe without
  // distributed locking. Also tracks the focus prompt, project filter, and scope for a pending trigger.
  let _pendingTrigger = null; // { focusPrompt, requestedBy, projectId, scopeText } | null

  // Active onActivity callback (set while a cycle is running, null otherwise).
  // Used to route log messages to Firestore during a cycle.
  let _onActivity = null;

  // Log to terminal and, when a cycle is active, also to Firestore via onActivity.
  function logAndReport(msg) {
    log(name, msg);
    if (_onActivity) _onActivity(msg);
  }

  // Run a cycle now (on-demand).
  // If already running, schedule an immediate follow-up cycle.
  function triggerNow(focusPrompt = null, requestedBy = null, projectId = null, scopeText = null) {
    if (stopped) return;
    if (isRunning) {
      logAndReport('On-demand trigger while running — will run again immediately after');
      runNowPending = true;
      _pendingTrigger = { focusPrompt, requestedBy, projectId, scopeText };
      return;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    _pendingTrigger = { focusPrompt, requestedBy, projectId, scopeText };
    log(name, 'On-demand trigger — starting cycle');
    tick();
  }

  // Watch for legacy runNow flag from the web UI (backward compat).
  const unsubRunNow = personaState.watchRunNow(() => {
    log(name, 'runNow flag detected');
    triggerNow(null, null);
  });

  // Watch for on-demand trigger (new DK-099 path).
  const unsubTrigger = personaState.watchTrigger(({ focusPrompt, requestedBy, requestedAt, projectId, scopeText }) => {
    log(name, `On-demand trigger received (requestedBy: ${requestedBy || 'unknown'}${projectId ? `, project: ${projectId}` : ''}${scopeText ? `, scope: "${scopeText.slice(0, 40)}"` : ''})`);
    // Consume the trigger document immediately to prevent re-fires
    personaState.clearTrigger().catch(() => {});
    // DK-321: Server-side sanitization of focusPrompt before it reaches buildPrompt().
    // Strip newlines + enforce 150-char cap regardless of what the client sent.
    const sanitizedHint = sanitizeUserHint(focusPrompt);
    // DK-367: Sanitize scopeText — strip newlines, enforce 500-char cap.
    const sanitizedScope = scopeText && typeof scopeText === 'string'
      ? (scopeText.replace(/[\r\n\u2028\u2029]/g, ' ').trim().slice(0, 500) || null)
      : null;
    triggerNow(sanitizedHint, requestedBy, projectId, sanitizedScope);
  });

  // Watch for runRequestedAt (DK-303) — new simple on-demand trigger path.
  // The UI writes runRequestedAt; the daemon validates cooldown, clears it, and fires.
  const unsubRunRequested = personaState.watchRunRequested
    ? personaState.watchRunRequested(async ({ requestedAt }) => {
        log(name, `runRequestedAt detected: ${requestedAt}`);
        // Cooldown enforcement: if lastRunAt is within 5 minutes, reject and surface error.
        const state = await personaState.read();
        const lastRunAt = state?.lastRunAt ?? null;
        if (lastRunAt) {
          const elapsed = Date.now() - new Date(lastRunAt).getTime();
          if (elapsed < RUN_REQUEST_COOLDOWN_MS) {
            const remainingSec = Math.ceil((RUN_REQUEST_COOLDOWN_MS - elapsed) / 1000);
            log(name, `runRequestedAt rejected — cooldown active (${remainingSec}s remaining)`);
            await personaState.clearRunRequested(`Cooldown active — please wait ${remainingSec}s before running again`).catch(() => {});
            return;
          }
        }
        // Clear the field immediately to prevent re-fire on restart.
        await personaState.clearRunRequested(null).catch(() => {});
        // Fire the run (same as the existing on-demand trigger path).
        triggerNow(null, null, null, null);
      })
    : () => {}; // no-op unsubscribe if method not available

  async function tick() {
    if (stopped) return;

    isRunning = false; // reset before reading state (set true once we start work)
    _onActivity = null;

    // Read current state from Firestore (may have been updated by UI)
    const state = await personaState.read();
    // intervalMinutes takes priority when set (allows sub-hour cadence).
    // Otherwise fall back to intervalHours (legacy / default).
    let intervalMs;
    let intervalHours;
    if (state?.intervalMinutes != null && Number.isFinite(state.intervalMinutes) && state.intervalMinutes > 0) {
      intervalMs = state.intervalMinutes * 60_000;
      intervalHours = state.intervalMinutes / 60; // for logging purposes
    } else {
      intervalHours = state?.intervalHours ?? defaultIntervalHours;
      intervalMs = intervalHours * 3_600_000;
    }

    // DK-111: minimum interval lowered to 0.25h (15 min) from 1h to support the
    // sub-hour interval controls added to the admin UI.
    // intervalMinutes is exempt from this floor (already bounded to >= 1 min by UI).
    const MIN_INTERVAL_MS = 0.25 * 60 * 60_000; // 15 minutes
    if (intervalMs < MIN_INTERVAL_MS && state?.intervalMinutes == null) {
      log(name, `Interval ${intervalHours}h is below 0.25h floor — clamping to 0.25h`);
      intervalMs = MIN_INTERVAL_MS;
      intervalHours = 0.25;
    }
    const paused = state?.status === 'paused';

    // If legacy runNow was set, clear it so UI button re-enables.
    const runNowTriggered = !!state?.runNow;
    if (runNowTriggered) {
      await personaState.clearRunNow();
    }

    // Consume any pending trigger (set by watchTrigger or watchRunNow callbacks)
    const currentTrigger = _pendingTrigger;
    _pendingTrigger = null;
    const isOnDemand = !!(runNowTriggered || currentTrigger);

    if (paused && !isOnDemand) {
      log(name, 'Paused — skipping cycle');
      pendingTimer = setTimeout(tick, intervalMs);
      return;
    }

    if (paused && isOnDemand) {
      log(name, 'Paused but on-demand trigger — running cycle');
    }

    // ── Time window enforcement (DK-303 / DK-195) ────────────────────────
    // For scheduled runs only: check schedule window. On-demand runs always fire.
    // New "schedule" field (DK-195) takes priority over legacy "allowedHours" (DK-303).
    if (!isOnDemand) {
      const schedule = state?.schedule ?? null;
      const allowedHours = state?.allowedHours ?? null;

      if (schedule !== null) {
        // New schedule field: timezone-aware, HH:MM windows, integer day array
        const { valid, errors } = validateSchedule(schedule);
        if (!valid) {
          log(name, `schedule config invalid — skipping window check (will run): ${errors.join('; ')}`);
          // Fall through and run anyway per spec
        } else {
          const now = new Date();
          if (!isWithinSchedule(schedule, now)) {
            const waitMs = msUntilScheduleOpen(schedule, now);
            const waitMin = Math.round(waitMs / 60_000);
            log(name, `Outside schedule window — sleeping ${waitMin}m until window opens`);
            pendingTimer = setTimeout(tick, waitMs);
            return;
          }
        }
      } else if (allowedHours !== null) {
        // Legacy allowedHours field: UTC hours + string day abbreviations
        const { valid, errors } = validateAllowedHours(allowedHours);
        if (!valid) {
          log(name, `allowedHours config invalid — skipping window check: ${errors.join('; ')}`);
          // Fall through and run anyway (log and skip per spec)
        } else {
          const nowUtc = new Date();
          if (!isWithinWindow(allowedHours, nowUtc)) {
            const waitMs = msUntilWindowOpen(allowedHours, nowUtc);
            const waitMin = Math.round(waitMs / 60_000);
            log(name, `Outside allowed hours window — sleeping ${waitMin}m until window opens`);
            pendingTimer = setTimeout(tick, waitMs);
            return;
          }
        }
      }
    } else if (paused) {
      // On-demand run while paused — log notice per spec
      log(name, 'Persona is paused — this run is once-only and will not resume the schedule');
    }

    // Cooldown check for on-demand runs: the UI already shows a confirmation
    // dialog when cooldown is active, so if a trigger arrives the user has
    // explicitly chosen to run again — always honour it.
    // (Scheduled runs are unaffected: cooldownUntil is only written after
    // on-demand runs, so a scheduled tick will never hit an active cooldown.)

    isRunning = true;

    // Update accumulated stats from stored state
    totalTickets = state?.ticketsCreated ?? totalTickets;
    cycleCount   = state?.cycleCount    ?? cycleCount;

    const triggerFocusPrompt = currentTrigger?.focusPrompt ?? null;
    const requestedBy = currentTrigger?.requestedBy ?? null;
    const triggerProjectId = currentTrigger?.projectId ?? null;
    // DK-367: scopeText from trigger (null for scheduled runs)
    const triggerScopeText = currentTrigger?.scopeText ?? null;

    // Read saved focus prompt (set by web UI, persists until consumed by a run).
    // For on-demand runs: trigger's focusPrompt takes priority; fall back to saved.
    // For scheduled runs: use savedFocusPrompt if present.
    const savedFocusPrompt = await personaState.getSavedFocusPrompt();
    const focusPrompt = triggerFocusPrompt ?? savedFocusPrompt;
    // Track whether the saved focus prompt was consumed so we can clear it after the run.
    const consumedSavedFocus = !triggerFocusPrompt && !!savedFocusPrompt;

    // Log the focus prompt for audit trail
    if (focusPrompt) {
      if (consumedSavedFocus) {
        log(name, `Saved focus area active for this run: "${focusPrompt}"`);
      } else {
        log(name, `Focus prompt for this run: "${focusPrompt}" (requestedBy: ${requestedBy || 'unknown'})`);
      }
    }
    if (triggerProjectId) {
      log(name, `Project filter for this run: ${triggerProjectId}`);
    }
    if (triggerScopeText) {
      log(name, `Scope for this run: "${triggerScopeText}"`);
    }

    // Callback that each persona calls to report live progress.
    // Writes to Firestore so the web UI shows real-time activity.
    const onActivity = (msg) => {
      personaState.setRunning(msg).catch(() => {}); // fire-and-forget
    };
    _onActivity = onActivity;

    // Report focus area as first activity log entry so it appears in the UI log
    if (focusPrompt) {
      const focusSource = consumedSavedFocus ? 'Saved focus area' : 'Focus area';
      await personaState.setRunning(`${focusSource}: "${focusPrompt}"`);
    } else {
      await personaState.setRunning('Starting cycle…');
    }
    log(name, 'Cycle starting');

    let result = { ticketsCreated: 0, lastActivity: 'Cycle completed' };
    let error = null;

    let cycleError = null; // the raw error (server-side only — never surfaced to UI)
    try {
      result = await runFn(onActivity, focusPrompt, triggerProjectId, triggerScopeText) ?? result;
    } catch (err) {
      cycleError = err;
      error = err.message || String(err);
      result.lastActivity = `Error: ${error}`;
      logAndReport(`Cycle failed: ${error}`);
      if (process.env.DEBUG) console.error(err);
    }

    // Clear the saved focus prompt now that it has been consumed by this run.
    if (consumedSavedFocus) {
      await personaState.clearSavedFocusPrompt().catch(() => {});
      log(name, 'Saved focus area cleared after use');
    }

    isRunning = false;
    _onActivity = null;
    totalTickets += result.ticketsCreated;
    cycleCount   += 1;

    const nextRunAt = new Date(Date.now() + intervalMs);

    // For on-demand runs, set cooldownUntil using per-persona cooldown (DK-321).
    // Design: 15-minute cooldown (Playwright + Vision is expensive).
    // All others: 5-minute cooldown.
    const cooldownUntil = isOnDemand
      ? new Date(Date.now() + _cooldownMs).toISOString()
      : null;

    // DK-321: lastRunError is a generic message written to Firestore when a run fails.
    // Full error details stay in server logs only — never raw stack traces to the client.
    const lastRunError = cycleError ? 'Run failed' : null;

    await personaState.setIdle({
      lastActivity:       result.lastActivity,
      ticketsCreated:     totalTickets,
      cycleCount,
      nextRunAt,
      error,
      lastRunTickets:     isOnDemand ? result.ticketsCreated : null,
      lastRunTicketCount: result.ticketsCreated, // DK-303: always written for the last-run line
      lastRunBy:          isOnDemand ? requestedBy : null,
      cooldownUntil,
      lastRunError,
    });

    // DK-136: Write trigger log entry for every completed run.
    // trigger type: 'manual' for on-demand, 'interval' for scheduled.
    if (personaState.writeTriggerLog) {
      const triggerType = isOnDemand ? 'manual' : 'interval';
      personaState.writeTriggerLog({
        trigger: triggerType,
        triggeredAt: new Date().toISOString(),
        triggeredBy: requestedBy || (isOnDemand ? 'manual' : 'system'),
        proposalsCreated: result.ticketsCreated ?? 0,
      }).catch(() => {}); // fire-and-forget — log failure is non-fatal
    }

    if (runNowPending) {
      runNowPending = false;
      log(name, `Cycle done. On-demand pending — starting next cycle immediately`);
      pendingTimer = setTimeout(tick, 0);
    } else {
      log(name, `Cycle done. Waiting for on-demand trigger.`);
      // On-demand only: do not schedule the next tick automatically.
      // The persona will run again only when triggerNow() is called
      // via the web UI, CLI, webhook, or ticket-close-count trigger.
    }
  }

  // On-demand only: do not auto-start a cycle on boot.
  // Personas wait for an explicit trigger (web UI, CLI, webhook, etc.).
  log(name, 'Ready (on-demand only — waiting for trigger)');
  return () => {
    stopped = true;
    _onActivity = null;
    unsubRunNow();
    unsubTrigger();
    if (typeof unsubRunRequested === 'function') unsubRunRequested();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
  };
}

// ── startAdvisor ──────────────────────────────────────────────────────────
// Starts all configured advisor personas.
//
// @param {object} options
// @param {object} options.db            - Firestore instance (firebase-admin)
// @param {object} options.advisorConfig - The "advisor" section from docket.config.json
// @returns {Promise<function>}          - Returns a stop() function to shut down all personas

export async function startAdvisor({ db, advisorConfig }) {
  const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
  const makeTicketService = (projectId) =>
    createTicketService(db, projectId, { serverTimestamp });

  const projectService = createProjectService(db);
  const projectsCfg = advisorConfig.projects || {};
  const feedbackService = createAdvisorFeedbackService(db);

  const stoppers = [];
  let personaCount = 0;

  // ── Engineer ───────────────────────────────────────────────────────────
  if (advisorConfig.engineer) {
    const cfg = advisorConfig.engineer;
    const hours = cfg.intervalHours || 12;
    const engineerModel = cfg.model || 'claude-haiku-4-5-20251001';
    const engineer = createEngineer({ config: cfg });
    const state = createPersonaState(db, 'engineer');
    await state.init(hours);
    log('engineer', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('engineer', hours, async (onActivity, focusPrompt, triggerProjectId, scopeText) => {
      const report = (msg) => { log('engineer', msg); onActivity(msg); };

      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) report('Using custom soul prompt from Firestore');
      if (focusPrompt) report(`Focus prompt active: "${focusPrompt}"`);
      if (triggerProjectId) report(`Project filter active: ${triggerProjectId}`);
      if (scopeText) report(`Scope active: "${scopeText}"`);

      const projects = await projectService.list();
      const allEligible = projects.filter(p => p.advisorContext?.trim());
      const eligible = triggerProjectId
        ? allEligible.filter(p => p.id === triggerProjectId)
        : allEligible;
      if (triggerProjectId && eligible.length === 0) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        if (targetProject) {
          report(`Project "${triggerProjectId}" has no advisorContext set — add context in project settings to enable advisor`);
        } else {
          report(`Project "${triggerProjectId}" not found — skipping`);
        }
      } else if (!triggerProjectId && allEligible.length === 0 && projects.length > 0) {
        const projectIds = projects.map(p => p.id).join(', ');
        report(`No projects have advisorContext set (found: ${projectIds}) — add context in project settings to enable advisor`);
      } else {
        report(`Found ${eligible.length} project(s) with advisorContext${triggerProjectId ? ` (filtered to: ${triggerProjectId})` : ''}`);
      }

      let totalTickets = 0;
      const activities = [];

      // If no projects are eligible due to missing advisorContext, record that in activities
      // so the UI shows a clear message rather than a generic "No eligible projects".
      if (eligible.length === 0 && projects.length > 0 && !triggerProjectId) {
        activities.push('No projects have advisorContext set — add context in project settings to enable advisor');
      } else if (eligible.length === 0 && triggerProjectId) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        activities.push(targetProject
          ? `Project "${triggerProjectId}" has no advisorContext set — add context in project settings`
          : `Project "${triggerProjectId}" not found`);
      }

      // Read ticketCap and dedupThreshold once per run as global defaults; per-project overrides applied below.
      // Defaults to 3 inside getValidatedCap/getValidatedDedupThreshold if missing or invalid.
      const engineerPersonaDoc = await state.read();
      const engineerTicketCapGlobal = engineerPersonaDoc?.ticketCap ?? undefined;
      const engineerDedupThresholdGlobal = engineerPersonaDoc?.dedupThreshold ?? undefined;
      // DK-133: Read global custom instructions for Engineer persona.
      // Used as fallback when a project has no per-project personaInstructions override.
      const engineerGlobalCustomInstructions = (typeof engineerPersonaDoc?.customInstructions === 'string')
        ? engineerPersonaDoc.customInstructions
        : null;

      for (const project of eligible) {
        // DK-118: Check per-project persona enabled state before running.
        // Absent key defaults to true (enabled). Only explicit false disables.
        if (project.advisor?.personas?.engineer === false && !triggerProjectId) {
          report(`[${project.id}] Engineer disabled for this project — skipping`);
          activities.push(`${project.id}: disabled`);
          continue;
        }

        // Per-project advisor settings: paused, ticketCap, dedupThreshold, savedFocusPrompt
        const projectPersonaSettings = project.advisorSettings?.engineer ?? null;

        // Skip this project if the engineer persona is paused specifically for it
        if (projectPersonaSettings?.paused === true) {
          report(`[${project.id}] Engineer paused for this project — skipping`);
          activities.push(`${project.id}: paused`);
          continue;
        }

        // Per-project ticketCap overrides global default
        const engineerTicketCap = projectPersonaSettings?.ticketCap !== undefined
          ? projectPersonaSettings.ticketCap
          : engineerTicketCapGlobal;

        // Per-project dedupThreshold overrides global default (DK-130)
        const engineerDedupThreshold = projectPersonaSettings?.dedupThreshold !== undefined
          ? projectPersonaSettings.dedupThreshold
          : engineerDedupThresholdGlobal;

        // Per-project savedFocusPrompt: for scheduled runs, use per-project prompt if set;
        // triggerFocusPrompt (on-demand) always takes precedence over per-project saved prompt.
        // SECURITY: sanitizeFocusPrompt() is applied here because this value is read directly
        // from the project document (bypassing state.js) and flows into the LLM prompt.
        const projectSavedFocusPrompt = sanitizeFocusPrompt(projectPersonaSettings?.savedFocusPrompt ?? null);
        const effectiveFocusPrompt = focusPrompt ?? projectSavedFocusPrompt;
        const consumedProjectFocus = !focusPrompt && !!projectSavedFocusPrompt;

        const pCfg = projectsCfg[project.id] || {};
        const repoPath = pCfg.repoPath || project.repoPath;
        // scanPaths resolution order: config file → Firestore project doc → scan repo root
        const scanPaths = pCfg.scanPaths || project.scanPaths || ['.'];

        if (!repoPath) {
          report(`[${project.id}] No repoPath configured — skipping`);
          activities.push(`${project.id}: no repoPath`);
          continue;
        }

        // Fetch feedback injection block for this persona + project
        // Wrapped in try/catch — a missing Firestore index (FAILED_PRECONDITION) must not
        // abort the entire advisor run; gracefully degrade to no feedback context.
        let feedbackContextBlock = null;
        try {
          const injectionEnabled = await feedbackService.getFeedbackInjectionEnabled(project.id, 'engineer');
          feedbackContextBlock = await feedbackService.buildInjectionBlock(project.id, 'engineer', injectionEnabled);
          if (feedbackContextBlock) {
            report(`[${project.id}] Feedback context available — injecting into prompt`);
          }
        } catch (fbErr) {
          report(`[${project.id}] Feedback context unavailable (${fbErr.message}) — continuing without it`);
        }

        const runLogger = createRunLogger({ db, persona: 'engineer', projectId: project.id, scopeText: scopeText || null });
        let cycleStatus = 'completed';
        let cycleError = null;
        let proposalsCreated = 0;

        try {
          const ticketService = makeTicketService(project.id);
          // DK-133: Resolve instructions — project override takes priority over global.
          // One level of fallback only. No merge. resolveCustomInstructions handles sanitization.
          const personaInstructions = project.personaInstructions?.engineer?.trim() || engineerGlobalCustomInstructions || null;
          // Exclusions are stored in the Firestore project doc under exclusions.engineer
          // (string[] of glob patterns). Fall back to empty array if not set.
          const exclusions = Array.isArray(project.exclusions?.engineer) ? project.exclusions.engineer : [];
          // DK-105: Build weight priority line from per-project weights (returns null if all-default).
          const weightPriorityLine = buildWeightPriorityLine(project.weights?.engineer, 'engineer');
          if (weightPriorityLine) report(`[${project.id}] Engineer emphasis weights active`);
          // DK-101: focusAreas — per-persona path constraints from Firestore
          // Stored at advisor.projects.<projectId>.engineer.includePaths / excludePaths
          const engineerFocusAreas = project.advisor?.projects?.[project.id]?.engineer ?? {};
          const includePaths = Array.isArray(engineerFocusAreas.includePaths) ? engineerFocusAreas.includePaths : [];
          const excludePaths = Array.isArray(engineerFocusAreas.excludePaths) ? engineerFocusAreas.excludePaths : [];
          if (includePaths.length > 0) report(`[${project.id}] Engineer focus: ${includePaths.length} includePath(s) active`);
          if (excludePaths.length > 0) report(`[${project.id}] Engineer focus: ${excludePaths.length} excludePath(s) active`);
          // DK-134: Scope config — topics (tag array) + include/exclude glob arrays per project.
          // New schema stored at advisor.projects.<projectId>.engineer.scope.{include,exclude,topics}.
          // Falls back to DK-301 legacy string fields (focusAreas.engineer.{topics,paths}).
          const engineerNewScope = project.advisor?.projects?.[project.id]?.engineer?.scope ?? {};
          const engineerScopedFocus = project.advisor?.projects?.[project.id]?.focusAreas?.engineer ?? {};

          // Topics: prefer array, fall back to comma-split legacy string
          let scopeTopicsArr = Array.isArray(engineerNewScope.topics) ? engineerNewScope.topics : [];
          if (scopeTopicsArr.length === 0 && typeof engineerScopedFocus.topics === 'string' && engineerScopedFocus.topics.trim()) {
            scopeTopicsArr = engineerScopedFocus.topics.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
          }
          // Sanitize: strip control characters and cap length per topic
          scopeTopicsArr = scopeTopicsArr
            .map(t => typeof t === 'string' ? t.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 50) : '')
            .filter(Boolean);

          // Include paths: prefer new array, fall back to legacy paths string as single-element array
          let scopeIncludeArr = Array.isArray(engineerNewScope.include) ? engineerNewScope.include : [];
          if (scopeIncludeArr.length === 0 && typeof engineerScopedFocus.paths === 'string' && engineerScopedFocus.paths.trim()) {
            const legacyPath = engineerScopedFocus.paths.trim().slice(0, 200);
            if (legacyPath && !legacyPath.startsWith('/') && !legacyPath.startsWith('..')) {
              scopeIncludeArr = [legacyPath];
            }
          }
          // Sanitize: reject traversal, cap length
          scopeIncludeArr = scopeIncludeArr
            .map(p => typeof p === 'string' ? p.trim().slice(0, 200) : '')
            .filter(p => p && !p.startsWith('/') && !p.startsWith('..') && !/^[A-Za-z]:[\\/]/.test(p))
            .slice(0, 25);

          // Exclude paths (DK-134 new)
          let scopeExcludeArr = Array.isArray(engineerNewScope.exclude) ? engineerNewScope.exclude : [];
          scopeExcludeArr = scopeExcludeArr
            .map(p => typeof p === 'string' ? p.trim().slice(0, 200) : '')
            .filter(p => p && !p.startsWith('/') && !p.startsWith('..') && !/^[A-Za-z]:[\\/]/.test(p))
            .slice(0, 25);

          // Build legacy-compat strings for existing persona parameters
          const focusAreaTopics = scopeTopicsArr.length > 0 ? scopeTopicsArr.join(', ') : null;
          const focusAreaPaths  = scopeIncludeArr.length > 0 ? scopeIncludeArr[0] : null; // legacy: first include only

          if (scopeTopicsArr.length > 0) report(`[${project.id}] Engineer scope topics: [${scopeTopicsArr.join(', ')}]`);
          if (scopeIncludeArr.length > 0) report(`[${project.id}] Engineer scope include: ${scopeIncludeArr.length} pattern(s)`);
          if (scopeExcludeArr.length > 0) report(`[${project.id}] Engineer scope exclude: ${scopeExcludeArr.length} pattern(s)`);
          // DK-319: Read per-persona per-project directive (stored as subcollection doc)
          const directive = await readDirective(db, 'engineer', project.id);
          if (directive) report(`[${project.id}] Focus directive active: "${directive.slice(0, 60)}${directive.length > 60 ? '…' : ''}"`);
          // DK-187: Read and validate focus constraints from /advisor/engineer.focus
          // Stored on the persona doc (not per-project) — focus is per-persona per-project
          // but for simplicity stored at the persona level; daemon validates on every read.
          const engineerPersonaFocus = engineerPersonaDoc?.focus ?? null;
          const validatedEngineerFocus = validateFocus(engineerPersonaFocus, 'engineer', (msg) => {
            report(`[${project.id}] Engineer focus validation warning: ${msg}`);
          });
          if (validatedEngineerFocus?.globs?.length > 0) {
            report(`[${project.id}] Engineer prompt focus: ${validatedEngineerFocus.globs.length} glob(s)`);
          }
          // DK-112: Read per-persona topic exclusion rules from Firestore.
          // Stored at advisor.topicExclusions.engineer as string[]. Sanitized in prompt-builder.
          const topicExclusions = Array.isArray(project.advisor?.topicExclusions?.engineer)
            ? project.advisor.topicExclusions.engineer
            : [];
          if (topicExclusions.length > 0) report(`[${project.id}] Engineer topic exclusions: ${topicExclusions.length} rule(s)`);
          // DK-124: Read advisorPins.engineer from project doc — validated relative globs.
          // Stored as string[] at project.advisorPins.engineer. Re-validated in engineer.js before use.
          const rawEngineerPins = Array.isArray(project.advisorPins?.engineer)
            ? project.advisorPins.engineer
            : [];
          const pinnedGlobs = rawEngineerPins.filter(g => typeof g === 'string').slice(0, 20);
          if (pinnedGlobs.length > 0) report(`[${project.id}] Engineer pins: ${pinnedGlobs.length} pinned glob(s)`);
          // DK-188: Read global minConfidence — Firestore /advisor/config overrides docket.config.json.
          const globalConfigSnap = db ? await db.collection('advisor').doc('config').get().catch(() => null) : null;
          const firestoreMinConfidence = globalConfigSnap?.data()?.minConfidence;
          const minConfidence = getValidatedMinConfidence(firestoreMinConfidence ?? advisorConfig.minConfidence);
          if (minConfidence !== 5) report(`[${project.id}] Confidence threshold: ${minConfidence}`);
          // DK-134: Pass new scope arrays to runAudit (scopeInclude, scopeExclude, scopeTopics)
          const result = await engineer.runAudit({ project, repoPath, scanPaths, ticketService, db, onActivity, soulPrompt, focusPrompt: effectiveFocusPrompt, scopeText: scopeText || null, feedbackContextBlock, runLogger, ticketCap: engineerTicketCap, dedupThreshold: engineerDedupThreshold, personaInstructions, exclusions, weightPriorityLine, includePaths, excludePaths, directive, focus: validatedEngineerFocus, priorities: project.priorities || null, focusAreaTopics, focusAreaPaths, topicExclusions, pinnedGlobs, minConfidence, scopeInclude: scopeIncludeArr, scopeExclude: scopeExcludeArr, scopeTopics: scopeTopicsArr });
          proposalsCreated = result.ticketsCreated;
          cycleStatus = 'completed';
          totalTickets += result.ticketsCreated;
          // DK-128: propagate exclusion skip count to run logger for suppression tracking
          if (result.exclusionSkipCount > 0) runLogger.addExclusionSkips(result.exclusionSkipCount);
          // DK-134: propagate scope-matched-zero flag to run logger for run history surfacing
          if (result.scopeMatchedZero === true) runLogger.setScopeMatchedZero(true);
          activities.push(result.lastActivity);
          // DK-134: Write back no-files warning and file count for scope feedback.
          const hasScopeFilter = scopeIncludeArr.length > 0 || scopeExcludeArr.length > 0 || !!focusAreaPaths;
          if (hasScopeFilter) {
            const noFilesMatched = result.scopeMatchedZero === true || result.focusAreaPathsMatchedZero === true;
            const scopeFileCount = typeof result.scopeFileCount === 'number' ? result.scopeFileCount : null;
            try {
              await db.collection('projects').doc(project.id).set(
                {
                  advisor: {
                    projects: {
                      [project.id]: {
                        focusAreaWarnings: { engineer: { noFilesMatched } },
                        ...(scopeFileCount !== null ? { scopeFileCount: { engineer: scopeFileCount } } : {}),
                      },
                    },
                  },
                },
                { merge: true }
              );
            } catch (warnErr) {
              log('engineer', `[${project.id}] Warning: failed to write scope feedback: ${warnErr.message}`);
            }
          }
        } catch (err) {
          cycleStatus = 'failed';
          cycleError = sanitizeError(err);
          activities.push(`${project.id}: error — ${err.message || 'unknown'}`);
          log('engineer', `[${project.id}] Cycle error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        } finally {
          await runLogger.flush(cycleStatus, cycleError);
          // Clear per-project savedFocusPrompt after it has been consumed
          if (consumedProjectFocus) {
            try {
              await db.collection('projects').doc(project.id).update({
                'advisorSettings.engineer.savedFocusPrompt': null,
              });
              log('engineer', `[${project.id}] Per-project saved focus area cleared after use`);
            } catch (clearErr) {
              log('engineer', `[${project.id}] Warning: failed to clear per-project savedFocusPrompt: ${clearErr.message}`);
            }
          }
        }
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── Design ─────────────────────────────────────────────────────────────
  if (advisorConfig.design) {
    const cfg = advisorConfig.design;
    const hours = cfg.intervalHours || 6;
    // Pass the Firebase Storage bucket so screenshots can be uploaded.
    // Access is restricted to authenticated project members via Storage rules.
    let storageBucket = null;
    try {
      storageBucket = admin.storage().bucket();
    } catch {
      log('design', 'Firebase Storage not available — screenshots will not be stored');
    }
    const screenshotDir = cfg.screenshotDir !== undefined ? cfg.screenshotDir : DEFAULT_SCREENSHOT_DIR;
    const designer = createDesigner({ config: cfg, storage: storageBucket, screenshotDir });
    const state = createPersonaState(db, 'design');
    await state.init(hours);
    log('design', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('design', hours, async (onActivity, focusPrompt, triggerProjectId, scopeText) => {
      const report = (msg) => { log('design', msg); onActivity(msg); };

      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) report('Using custom soul prompt from Firestore');
      if (focusPrompt) report(`Focus prompt active: "${focusPrompt}"`);
      if (triggerProjectId) report(`Project filter active: ${triggerProjectId}`);
      if (scopeText) report(`Scope active: "${scopeText}"`);

      const projects = await projectService.list();
      const allEligible = projects.filter(p => p.advisorContext?.trim());
      const eligible = triggerProjectId
        ? allEligible.filter(p => p.id === triggerProjectId)
        : allEligible;
      if (triggerProjectId && eligible.length === 0) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        if (targetProject) {
          report(`Project "${triggerProjectId}" has no advisorContext set — add context in project settings to enable advisor`);
        } else {
          report(`Project "${triggerProjectId}" not found — skipping`);
        }
      } else if (!triggerProjectId && allEligible.length === 0 && projects.length > 0) {
        const projectIds = projects.map(p => p.id).join(', ');
        report(`No projects have advisorContext set (found: ${projectIds}) — add context in project settings to enable advisor`);
      } else {
        report(`Found ${eligible.length} project(s) with advisorContext${triggerProjectId ? ` (filtered to: ${triggerProjectId})` : ''}`);
      }

      let totalTickets = 0;
      const activities = [];

      // If no projects are eligible due to missing advisorContext, record that in activities
      // so the UI shows a clear message rather than a generic "No eligible projects".
      if (eligible.length === 0 && projects.length > 0 && !triggerProjectId) {
        activities.push('No projects have advisorContext set — add context in project settings to enable advisor');
      } else if (eligible.length === 0 && triggerProjectId) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        activities.push(targetProject
          ? `Project "${triggerProjectId}" has no advisorContext set — add context in project settings`
          : `Project "${triggerProjectId}" not found`);
      }

      // Read ticketCap and dedupThreshold once per run as global defaults; per-project overrides applied below.
      const designPersonaDoc = await state.read();
      const designTicketCapGlobal = designPersonaDoc?.ticketCap ?? undefined;
      const designDedupThresholdGlobal = designPersonaDoc?.dedupThreshold ?? undefined;
      // DK-133: Read global custom instructions for Design persona.
      const designGlobalCustomInstructions = (typeof designPersonaDoc?.customInstructions === 'string')
        ? designPersonaDoc.customInstructions
        : null;

      for (const project of eligible) {
        // DK-118: Check per-project persona enabled state before running.
        // Absent key defaults to true (enabled). Only explicit false disables.
        if (project.advisor?.personas?.design === false && !triggerProjectId) {
          report(`[${project.id}] Design disabled for this project — skipping`);
          activities.push(`${project.id}: disabled`);
          continue;
        }

        // Per-project advisor settings: paused, ticketCap, dedupThreshold, savedFocusPrompt
        const projectPersonaSettings = project.advisorSettings?.design ?? null;

        // Skip this project if the design persona is paused specifically for it
        if (projectPersonaSettings?.paused === true) {
          report(`[${project.id}] Design paused for this project — skipping`);
          activities.push(`${project.id}: paused`);
          continue;
        }

        // Per-project ticketCap overrides global default
        const designTicketCap = projectPersonaSettings?.ticketCap !== undefined
          ? projectPersonaSettings.ticketCap
          : designTicketCapGlobal;

        // Per-project dedupThreshold overrides global default (DK-130)
        const designDedupThreshold = projectPersonaSettings?.dedupThreshold !== undefined
          ? projectPersonaSettings.dedupThreshold
          : designDedupThresholdGlobal;

        // Per-project savedFocusPrompt: for scheduled runs, use per-project prompt if set
        // SECURITY: sanitizeFocusPrompt() is applied here because this value is read directly
        // from the project document (bypassing state.js) and flows into the LLM prompt.
        const projectSavedFocusPrompt = sanitizeFocusPrompt(projectPersonaSettings?.savedFocusPrompt ?? null);
        const effectiveFocusPrompt = focusPrompt ?? projectSavedFocusPrompt;
        const consumedProjectFocus = !focusPrompt && !!projectSavedFocusPrompt;

        const pCfg = projectsCfg[project.id] || {};
        const appUrl = pCfg.appUrl || project.canaryUrl || project.releaseUrl;
        const flows = pCfg.appFlows || ['/'];

        // Warn if any appFlows entry duplicates the base path already present in appUrl.
        // e.g. appUrl="https://host/projects/docket/" + appFlows=["/projects/docket/"]
        // produces doubled URLs like .../projects/docket//projects/docket/ (DK-296).
        if (appUrl && Array.isArray(pCfg.appFlows)) {
          try {
            const basePath = new URL(appUrl).pathname.replace(/\/$/, '');
            if (basePath && basePath !== '/') {
              for (const flow of pCfg.appFlows) {
                if (typeof flow === 'string' && flow.replace(/\/$/, '') === basePath) {
                  report(`[${project.id}] WARNING: appFlows entry "${flow}" duplicates the base path in appUrl. ` +
                    `Use relative paths like "/" or "/settings" instead. See advisor/CLAUDE.md for details.`);
                }
              }
            }
          } catch (_) { /* non-fatal */ }
        }

        const qaFlows = pCfg.qaFlows || null;
        const projectLocalStorage = pCfg.localStorage || null;
        const projectCookies = pCfg.cookies || null;

        // Fetch feedback injection block for this persona + project
        // Wrapped in try/catch — a missing Firestore index (FAILED_PRECONDITION) must not
        // abort the entire advisor run; gracefully degrade to no feedback context.
        let feedbackContextBlock = null;
        try {
          const injectionEnabled = await feedbackService.getFeedbackInjectionEnabled(project.id, 'design');
          feedbackContextBlock = await feedbackService.buildInjectionBlock(project.id, 'design', injectionEnabled);
          if (feedbackContextBlock) {
            report(`[${project.id}] Feedback context available — injecting into prompt`);
          }
        } catch (fbErr) {
          report(`[${project.id}] Feedback context unavailable (${fbErr.message}) — continuing without it`);
        }

        const runLogger = createRunLogger({ db, persona: 'design', projectId: project.id, scopeText: scopeText || null });
        let cycleStatus = 'completed';
        let cycleError = null;
        let proposalsCreated = 0;

        try {
          const ticketService = makeTicketService(project.id);
          // DK-133: Resolve instructions — project override takes priority over global.
          const personaInstructions = project.personaInstructions?.design?.trim() || designGlobalCustomInstructions || null;
          // Exclusions are stored in the Firestore project doc under exclusions.design
          // (string[] of URL prefix patterns). Fall back to empty array if not set.
          const exclusions = Array.isArray(project.exclusions?.design) ? project.exclusions.design : [];
          // DK-105: Build weight priority line from per-project weights (returns null if all-default).
          const weightPriorityLine = buildWeightPriorityLine(project.weights?.design, 'design');
          if (weightPriorityLine) report(`[${project.id}] Design emphasis weights active`);
          // DK-101: focusAreas — per-persona URL patterns from Firestore
          // Stored at advisor.projects.<projectId>.design.urlPatterns
          const designFocusAreas = project.advisor?.projects?.[project.id]?.design ?? {};
          const urlPatterns = Array.isArray(designFocusAreas.urlPatterns) ? designFocusAreas.urlPatterns : [];
          if (urlPatterns.length > 0) report(`[${project.id}] Design focus: ${urlPatterns.length} URL pattern(s) active`);
          // DK-134: Scope config — topics (tag array) per project.
          // New schema stored at advisor.projects.<projectId>.design.scope.{topics}.
          // Falls back to DK-301 legacy string at focusAreas.design.topics.
          const designNewScope = project.advisor?.projects?.[project.id]?.design?.scope ?? {};
          const designScopedFocus = project.advisor?.projects?.[project.id]?.focusAreas?.design ?? {};

          let designScopeTopicsArr = Array.isArray(designNewScope.topics) ? designNewScope.topics : [];
          if (designScopeTopicsArr.length === 0 && typeof designScopedFocus.topics === 'string' && designScopedFocus.topics.trim()) {
            designScopeTopicsArr = designScopedFocus.topics.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
          }
          designScopeTopicsArr = designScopeTopicsArr
            .map(t => typeof t === 'string' ? t.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 50) : '')
            .filter(Boolean);

          const designFocusAreaTopics = designScopeTopicsArr.length > 0 ? designScopeTopicsArr.join(', ') : null;
          if (designScopeTopicsArr.length > 0) report(`[${project.id}] Design scope topics: [${designScopeTopicsArr.join(', ')}]`);
          // DK-319: Read per-persona per-project directive (stored as subcollection doc)
          const directive = await readDirective(db, 'design', project.id);
          if (directive) report(`[${project.id}] Focus directive active: "${directive.slice(0, 60)}${directive.length > 60 ? '…' : ''}"`);
          // DK-187: Read and validate focus constraints from /advisor/design.focus
          const designPersonaFocus = designPersonaDoc?.focus ?? null;
          const validatedDesignFocus = validateFocus(designPersonaFocus, 'design', (msg) => {
            report(`[${project.id}] Design focus validation warning: ${msg}`);
          });
          if (validatedDesignFocus?.routes?.length > 0) {
            report(`[${project.id}] Design prompt focus: ${validatedDesignFocus.routes.length} route(s)`);
          }
          // DK-112: Read per-persona topic exclusion rules from Firestore.
          // Stored at advisor.topicExclusions.design as string[]. Sanitized in prompt-builder.
          const designTopicExclusions = Array.isArray(project.advisor?.topicExclusions?.design)
            ? project.advisor.topicExclusions.design
            : [];
          if (designTopicExclusions.length > 0) report(`[${project.id}] Design topic exclusions: ${designTopicExclusions.length} rule(s)`);
          // DK-124: Read advisorPins.design from project doc — validated relative URL paths.
          // Stored as string[] at project.advisorPins.design. Re-validated in design.js before use.
          const rawDesignPins = Array.isArray(project.advisorPins?.design)
            ? project.advisorPins.design
            : [];
          const pinnedUrls = rawDesignPins.filter(u => typeof u === 'string').slice(0, 20);
          if (pinnedUrls.length > 0) report(`[${project.id}] Design pins: ${pinnedUrls.length} pinned URL(s)`);
          // DK-188: Read global minConfidence — Firestore /advisor/config overrides docket.config.json.
          const globalConfigSnap2 = db ? await db.collection('advisor').doc('config').get().catch(() => null) : null;
          const firestoreMinConfidence2 = globalConfigSnap2?.data()?.minConfidence;
          const minConfidence2 = getValidatedMinConfidence(firestoreMinConfidence2 ?? advisorConfig.minConfidence);
          if (minConfidence2 !== 5) report(`[${project.id}] Confidence threshold: ${minConfidence2}`);
          // DK-134: Pass new scopeTopics array to runAudit
          const result = await designer.runAudit({ project, appUrl, flows, qaFlows, projectLocalStorage, projectCookies, ticketService, db, onActivity, soulPrompt, focusPrompt: effectiveFocusPrompt, scopeText: scopeText || null, feedbackContextBlock, runLogger, ticketCap: designTicketCap, dedupThreshold: designDedupThreshold, personaInstructions, exclusions, weightPriorityLine, urlPatterns, directive, focus: validatedDesignFocus, priorities: project.priorities || null, focusAreaTopics: designFocusAreaTopics || null, topicExclusions: designTopicExclusions, pinnedUrls, minConfidence: minConfidence2, scopeTopics: designScopeTopicsArr });
          proposalsCreated = result.ticketsCreated;
          cycleStatus = 'completed';
          totalTickets += result.ticketsCreated;
          // DK-128: propagate exclusion skip count to run logger for suppression tracking
          if (result.exclusionSkipCount > 0) runLogger.addExclusionSkips(result.exclusionSkipCount);
          activities.push(result.lastActivity);
        } catch (err) {
          cycleStatus = 'failed';
          cycleError = sanitizeError(err);
          activities.push(`${project.id}: error — ${err.message || 'unknown'}`);
          log('design', `[${project.id}] Cycle error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        } finally {
          await runLogger.flush(cycleStatus, cycleError);
          // Clear per-project savedFocusPrompt after it has been consumed
          if (consumedProjectFocus) {
            try {
              await db.collection('projects').doc(project.id).update({
                'advisorSettings.design.savedFocusPrompt': null,
              });
              log('design', `[${project.id}] Per-project saved focus area cleared after use`);
            } catch (clearErr) {
              log('design', `[${project.id}] Warning: failed to clear per-project savedFocusPrompt: ${clearErr.message}`);
            }
          }
        }
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── Product ────────────────────────────────────────────────────────────
  if (advisorConfig.product) {
    const cfg = advisorConfig.product;
    const hours = cfg.intervalHours || 24;
    const pm = createProductManager({ config: cfg });
    const state = createPersonaState(db, 'product');
    await state.init(hours);
    log('product', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('product', hours, async (onActivity, focusPrompt, triggerProjectId, scopeText) => {
      const report = (msg) => { log('product', msg); onActivity(msg); };

      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) report('Using custom soul prompt from Firestore');
      if (focusPrompt) report(`Focus prompt active: "${focusPrompt}"`);
      if (triggerProjectId) report(`Project filter active: ${triggerProjectId}`);
      if (scopeText) report(`Scope active: "${scopeText}"`);

      const projects = await projectService.list();
      const allEligible = projects.filter(p => p.advisorContext?.trim());
      const eligible = triggerProjectId
        ? allEligible.filter(p => p.id === triggerProjectId)
        : allEligible;
      if (triggerProjectId && eligible.length === 0) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        if (targetProject) {
          report(`Project "${triggerProjectId}" has no advisorContext set — add context in project settings to enable advisor`);
        } else {
          report(`Project "${triggerProjectId}" not found — skipping`);
        }
      } else if (!triggerProjectId && allEligible.length === 0 && projects.length > 0) {
        const projectIds = projects.map(p => p.id).join(', ');
        report(`No projects have advisorContext set (found: ${projectIds}) — add context in project settings to enable advisor`);
      } else {
        report(`Found ${eligible.length} project(s) with advisorContext${triggerProjectId ? ` (filtered to: ${triggerProjectId})` : ''}`);
      }

      let totalTickets = 0;
      const activities = [];

      // If no projects are eligible due to missing advisorContext, record that in activities
      // so the UI shows a clear message rather than a generic "No eligible projects".
      if (eligible.length === 0 && projects.length > 0 && !triggerProjectId) {
        activities.push('No projects have advisorContext set — add context in project settings to enable advisor');
      } else if (eligible.length === 0 && triggerProjectId) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        activities.push(targetProject
          ? `Project "${triggerProjectId}" has no advisorContext set — add context in project settings`
          : `Project "${triggerProjectId}" not found`);
      }

      // Read ticketCap and dedupThreshold once per run as global defaults; per-project overrides applied below.
      const productPersonaDoc = await state.read();
      const productTicketCapGlobal = productPersonaDoc?.ticketCap ?? undefined;
      const productDedupThresholdGlobal = productPersonaDoc?.dedupThreshold ?? undefined;
      // DK-133: Read global custom instructions for Product persona.
      const productGlobalCustomInstructions = (typeof productPersonaDoc?.customInstructions === 'string')
        ? productPersonaDoc.customInstructions
        : null;

      for (const project of eligible) {
        // DK-118: Check per-project persona enabled state before running.
        // Absent key defaults to true (enabled). Only explicit false disables.
        if (project.advisor?.personas?.product === false && !triggerProjectId) {
          report(`[${project.id}] Product disabled for this project — skipping`);
          activities.push(`${project.id}: disabled`);
          continue;
        }

        // Per-project advisor settings: paused, ticketCap, dedupThreshold, savedFocusPrompt
        const projectPersonaSettings = project.advisorSettings?.product ?? null;

        // Skip this project if the product persona is paused specifically for it
        if (projectPersonaSettings?.paused === true) {
          report(`[${project.id}] Product paused for this project — skipping`);
          activities.push(`${project.id}: paused`);
          continue;
        }

        // Per-project ticketCap overrides global default
        const productTicketCap = projectPersonaSettings?.ticketCap !== undefined
          ? projectPersonaSettings.ticketCap
          : productTicketCapGlobal;

        // Per-project dedupThreshold overrides global default (DK-130)
        const productDedupThreshold = projectPersonaSettings?.dedupThreshold !== undefined
          ? projectPersonaSettings.dedupThreshold
          : productDedupThresholdGlobal;

        // Per-project savedFocusPrompt: for scheduled runs, use per-project prompt if set
        // SECURITY: sanitizeFocusPrompt() is applied here because this value is read directly
        // from the project document (bypassing state.js) and flows into the LLM prompt.
        const projectSavedFocusPrompt = sanitizeFocusPrompt(projectPersonaSettings?.savedFocusPrompt ?? null);
        const effectiveFocusPrompt = focusPrompt ?? projectSavedFocusPrompt;
        const consumedProjectFocus = !focusPrompt && !!projectSavedFocusPrompt;

        const pCfg = projectsCfg[project.id] || {};
        const repoPath = pCfg.repoPath || project.repoPath;
        // scanPaths resolution order: config file → Firestore project doc → scan repo root
        const scanPaths = pCfg.scanPaths || project.scanPaths || ['.'];

        // Capture commit SHA for flag fileRefs
        let commitSha = null;
        if (repoPath) {
          try {
            const { execSync } = await import('node:child_process');
            commitSha = execSync('git rev-parse HEAD', {
              cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch {
            // git unavailable or not a git repo — flagRefs will omit commitSha
          }
        }

        // Fetch feedback injection block for this persona + project
        // Wrapped in try/catch — a missing Firestore index (FAILED_PRECONDITION) must not
        // abort the entire advisor run; gracefully degrade to no feedback context.
        let feedbackContextBlock = null;
        try {
          const injectionEnabled = await feedbackService.getFeedbackInjectionEnabled(project.id, 'product');
          feedbackContextBlock = await feedbackService.buildInjectionBlock(project.id, 'product', injectionEnabled);
          if (feedbackContextBlock) {
            report(`[${project.id}] Feedback context available — injecting into prompt`);
          }
        } catch (fbErr) {
          report(`[${project.id}] Feedback context unavailable (${fbErr.message}) — continuing without it`);
        }

        const runLogger = createRunLogger({ db, persona: 'product', projectId: project.id, scopeText: scopeText || null });
        let cycleStatus = 'completed';
        let cycleError = null;
        let proposalsCreated = 0;

        try {
          const ticketService = makeTicketService(project.id);
          // DK-133: Resolve instructions — project override takes priority over global.
          const personaInstructions = project.personaInstructions?.product?.trim() || productGlobalCustomInstructions || null;
          // DK-105: Build weight priority line from per-project weights (returns null if all-default).
          const weightPriorityLine = buildWeightPriorityLine(project.weights?.product, 'product');
          if (weightPriorityLine) report(`[${project.id}] Product emphasis weights active`);
          // DK-101: focusAreas — per-persona product context from Firestore
          // Stored at advisor.projects.<projectId>.product.targetSegment / businessGoal
          const productFocusAreas = project.advisor?.projects?.[project.id]?.product ?? {};
          const targetSegment = typeof productFocusAreas.targetSegment === 'string' ? productFocusAreas.targetSegment : null;
          const businessGoal = typeof productFocusAreas.businessGoal === 'string' ? productFocusAreas.businessGoal : null;
          if (targetSegment) report(`[${project.id}] Product focus: targetSegment = "${targetSegment.slice(0, 40)}"`);
          if (businessGoal) report(`[${project.id}] Product focus: businessGoal = "${businessGoal.slice(0, 40)}"`);
          // DK-134: Scope config — topics (tag array) per project.
          // New schema stored at advisor.projects.<projectId>.product.scope.{topics}.
          // Falls back to DK-301 legacy string at focusAreas.product.topics.
          const productNewScope = project.advisor?.projects?.[project.id]?.product?.scope ?? {};
          const productScopedFocus = project.advisor?.projects?.[project.id]?.focusAreas?.product ?? {};

          let productScopeTopicsArr = Array.isArray(productNewScope.topics) ? productNewScope.topics : [];
          if (productScopeTopicsArr.length === 0 && typeof productScopedFocus.topics === 'string' && productScopedFocus.topics.trim()) {
            productScopeTopicsArr = productScopedFocus.topics.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
          }
          productScopeTopicsArr = productScopeTopicsArr
            .map(t => typeof t === 'string' ? t.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 50) : '')
            .filter(Boolean);

          const productFocusAreaTopics = productScopeTopicsArr.length > 0 ? productScopeTopicsArr.join(', ') : null;
          if (productScopeTopicsArr.length > 0) report(`[${project.id}] Product scope topics: [${productScopeTopicsArr.join(', ')}]`);
          // DK-365: Read and validate saved constraints from per-project advisor settings.
          // Constraints are stored at project.advisorSettings.product.constraints
          // Validation is performed here (server-side) before passing to the persona.
          let productConstraints = null;
          const rawConstraints = projectPersonaSettings?.constraints ?? null;
          if (rawConstraints) {
            try {
              productConstraints = validateConstraints(rawConstraints);
              report(`[${project.id}] Product constraints active`);
            } catch (cErr) {
              report(`[${project.id}] Product constraints invalid (${cErr.message}) — running without constraints`);
            }
          }
          // Per-run override constraints come from the trigger doc (ephemeral, not stored)
          const triggerConstraintOverride = null; // reserved for future trigger-level overrides
          // DK-319: Read per-persona per-project directive (stored as subcollection doc)
          const directive = await readDirective(db, 'product', project.id);
          if (directive) report(`[${project.id}] Focus directive active: "${directive.slice(0, 60)}${directive.length > 60 ? '…' : ''}"`);
          // DK-187: Read and validate focus constraints from /advisor/product.focus
          const productPersonaFocus = productPersonaDoc?.focus ?? null;
          const validatedProductFocus = validateFocus(productPersonaFocus, 'product', (msg) => {
            report(`[${project.id}] Product focus validation warning: ${msg}`);
          });
          if (validatedProductFocus?.keywords?.length > 0) {
            report(`[${project.id}] Product prompt focus: ${validatedProductFocus.keywords.length} keyword(s)`);
          }
          // DK-112: Read per-persona topic exclusion rules from Firestore.
          // Stored at advisor.topicExclusions.product as string[]. Sanitized in prompt-builder.
          const productTopicExclusions = Array.isArray(project.advisor?.topicExclusions?.product)
            ? project.advisor.topicExclusions.product
            : [];
          if (productTopicExclusions.length > 0) report(`[${project.id}] Product topic exclusions: ${productTopicExclusions.length} rule(s)`);
          // DK-188: Read global minConfidence — Firestore /advisor/config overrides docket.config.json.
          const globalConfigSnap = db ? await db.collection('advisor').doc('config').get().catch(() => null) : null;
          const firestoreMinConfidence = globalConfigSnap?.data()?.minConfidence;
          const minConfidence = getValidatedMinConfidence(firestoreMinConfidence ?? advisorConfig.minConfidence);
          if (minConfidence !== 5) report(`[${project.id}] Confidence threshold: ${minConfidence}`);
          // DK-134: Pass scopeTopics array to runCycle
          const result = await pm.runCycle({ project, ticketService, db, repoPath, scanPaths, commitSha, onActivity, soulPrompt, focusPrompt: effectiveFocusPrompt, scopeText: scopeText || null, feedbackContextBlock, runLogger, ticketCap: productTicketCap, dedupThreshold: productDedupThreshold, personaInstructions, weightPriorityLine, constraints: productConstraints, constraintOverride: triggerConstraintOverride, targetSegment, businessGoal, directive, focus: validatedProductFocus, priorities: project.priorities || null, focusAreaTopics: productFocusAreaTopics || null, topicExclusions: productTopicExclusions, minConfidence, scopeTopics: productScopeTopicsArr });
          proposalsCreated = result.ticketsCreated;
          cycleStatus = 'completed';
          totalTickets += result.ticketsCreated;
          activities.push(result.lastActivity);
        } catch (err) {
          cycleStatus = 'failed';
          cycleError = sanitizeError(err);
          activities.push(`${project.id}: error — ${err.message || 'unknown'}`);
          log('product', `[${project.id}] Cycle error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        } finally {
          await runLogger.flush(cycleStatus, cycleError);
          // Clear per-project savedFocusPrompt after it has been consumed
          if (consumedProjectFocus) {
            try {
              await db.collection('projects').doc(project.id).update({
                'advisorSettings.product.savedFocusPrompt': null,
              });
              log('product', `[${project.id}] Per-project saved focus area cleared after use`);
            } catch (clearErr) {
              log('product', `[${project.id}] Warning: failed to clear per-project savedFocusPrompt: ${clearErr.message}`);
            }
          }
        }
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── QA ─────────────────────────────────────────────────────────────────
  if (advisorConfig.qa) {
    const cfg = advisorConfig.qa;
    const hours = cfg.intervalHours || 6;
    const screenshotDir = cfg.screenshotDir !== undefined ? cfg.screenshotDir : DEFAULT_SCREENSHOT_DIR;
    const qa = createQA({ config: cfg, screenshotDir });
    const state = createPersonaState(db, 'qa');
    await state.init(hours);
    log('qa', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('qa', hours, async (onActivity, focusPrompt, triggerProjectId, scopeText) => {
      const report = (msg) => { log('qa', msg); onActivity(msg); };

      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) report('Using custom soul prompt from Firestore');
      if (focusPrompt) report(`Focus prompt active: "${focusPrompt}"`);
      if (triggerProjectId) report(`Project filter active: ${triggerProjectId}`);
      if (scopeText) report(`Scope active: "${scopeText}"`);

      const projects = await projectService.list();
      const allEligible = projects.filter(p => p.advisorContext?.trim());
      const eligible = triggerProjectId
        ? allEligible.filter(p => p.id === triggerProjectId)
        : allEligible;
      if (triggerProjectId && eligible.length === 0) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        if (targetProject) {
          report(`Project "${triggerProjectId}" has no advisorContext set — add context in project settings to enable advisor`);
        } else {
          report(`Project "${triggerProjectId}" not found — skipping`);
        }
      } else if (!triggerProjectId && allEligible.length === 0 && projects.length > 0) {
        const projectIds = projects.map(p => p.id).join(', ');
        report(`No projects have advisorContext set (found: ${projectIds}) — add context in project settings to enable advisor`);
      } else {
        report(`Found ${eligible.length} project(s) with advisorContext${triggerProjectId ? ` (filtered to: ${triggerProjectId})` : ''}`);
      }

      let totalTickets = 0;
      const activities = [];

      // If no projects are eligible due to missing advisorContext, record that in activities
      // so the UI shows a clear message rather than a generic "No eligible projects".
      if (eligible.length === 0 && projects.length > 0 && !triggerProjectId) {
        activities.push('No projects have advisorContext set — add context in project settings to enable advisor');
      } else if (eligible.length === 0 && triggerProjectId) {
        const targetProject = projects.find(p => p.id === triggerProjectId);
        activities.push(targetProject
          ? `Project "${triggerProjectId}" has no advisorContext set — add context in project settings`
          : `Project "${triggerProjectId}" not found`);
      }

      // Read ticketCap once per run as global default; per-project override applied below.
      const qaPersonaDoc = await state.read();
      const qaTicketCapGlobal = qaPersonaDoc?.ticketCap ?? undefined;

      for (const project of eligible) {
        // Per-project advisor settings: paused, ticketCap, savedFocusPrompt
        const projectPersonaSettings = project.advisorSettings?.qa ?? null;

        // Skip this project if the QA persona is paused specifically for it
        if (projectPersonaSettings?.paused === true) {
          report(`[${project.id}] QA paused for this project — skipping`);
          activities.push(`${project.id}: paused`);
          continue;
        }

        // Per-project ticketCap overrides global default
        const qaTicketCap = projectPersonaSettings?.ticketCap !== undefined
          ? projectPersonaSettings.ticketCap
          : qaTicketCapGlobal;

        // Per-project savedFocusPrompt: for scheduled runs, use per-project prompt if set
        // SECURITY: sanitizeFocusPrompt() is applied here because this value is read directly
        // from the project document (bypassing state.js) and flows into the LLM prompt.
        const projectSavedFocusPrompt = sanitizeFocusPrompt(projectPersonaSettings?.savedFocusPrompt ?? null);
        const effectiveFocusPrompt = focusPrompt ?? projectSavedFocusPrompt;
        const consumedProjectFocus = !focusPrompt && !!projectSavedFocusPrompt;

        const pCfg = projectsCfg[project.id] || {};
        const appUrl = pCfg.appUrl || project.canaryUrl || project.releaseUrl;
        const flows = pCfg.qaFlows || [];
        const repoPath = pCfg.repoPath || project.repoPath || null;
        const projectLocalStorage = pCfg.localStorage || null;
        const projectCookies = pCfg.cookies || null;

        if (!appUrl) {
          // No QA config for this project — skip silently
          continue;
        }

        let feedbackContextBlock = null;
        try {
          const injectionEnabled = await feedbackService.getFeedbackInjectionEnabled(project.id, 'qa');
          feedbackContextBlock = await feedbackService.buildInjectionBlock(project.id, 'qa', injectionEnabled);
          if (feedbackContextBlock) {
            report(`[${project.id}] Feedback context available — injecting into prompt`);
          }
        } catch (fbErr) {
          report(`[${project.id}] Feedback context unavailable (${fbErr.message}) — continuing without it`);
        }

        const runLogger = createRunLogger({ db, persona: 'qa', projectId: project.id, scopeText: scopeText || null });
        let cycleStatus = 'completed';
        let cycleError = null;

        try {
          const ticketService = makeTicketService(project.id);
          const result = await qa.runAudit({ project, appUrl, flows, repoPath, projectLocalStorage, projectCookies, ticketService, db, onActivity, soulPrompt, focusPrompt: effectiveFocusPrompt, scopeText: scopeText || null, feedbackContextBlock, runLogger, ticketCap: qaTicketCap });
          cycleStatus = 'completed';
          totalTickets += result.ticketsCreated;
          activities.push(result.lastActivity);
        } catch (err) {
          cycleStatus = 'failed';
          cycleError = sanitizeError(err);
          activities.push(`${project.id}: error — ${err.message || 'unknown'}`);
          log('qa', `[${project.id}] Cycle error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        } finally {
          await runLogger.flush(cycleStatus, cycleError);
          // Clear per-project savedFocusPrompt after it has been consumed
          if (consumedProjectFocus) {
            try {
              await db.collection('projects').doc(project.id).update({
                'advisorSettings.qa.savedFocusPrompt': null,
              });
              log('qa', `[${project.id}] Per-project saved focus area cleared after use`);
            } catch (clearErr) {
              log('qa', `[${project.id}] Warning: failed to clear per-project savedFocusPrompt: ${clearErr.message}`);
            }
          }
        }
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── Custom personas (from docket.config.json) ──────────────────────────
  const { personas: configPersonas, warnings } = loadCustomPersonas(advisorConfig);
  for (const warning of warnings) {
    log('advisor', `Warning: ${warning}`);
  }

  // Build screenshot config map for visual custom personas
  const projectScreenshotConfigs = {};
  for (const [projectId, pCfg] of Object.entries(projectsCfg)) {
    if (pCfg.screenshotCommand && pCfg.screenshotDir) {
      projectScreenshotConfigs[projectId] = {
        screenshotCommand: pCfg.screenshotCommand,
        screenshotDir: pCfg.screenshotDir,
        repoPath: pCfg.repoPath,
      };
    }
  }

  // Track running custom persona loops by id so we can start/stop them
  // as Firestore persona documents are created/deleted.
  const customPersonaStoppers = {}; // personaId -> stop()

  async function startCustomPersonaLoop(personaCfg) {
    if (customPersonaStoppers[personaCfg.id]) {
      log(personaCfg.id, `Already running — skipping duplicate start`);
      return;
    }
    const hours = personaCfg.intervalHours;
    const runner = createCustomPersona(personaCfg);
    const state = createPersonaState(db, personaCfg.id);
    await state.init(hours);
    log(personaCfg.id, `Starting custom persona "${personaCfg.name}" — interval ${hours}h`);

    const stop = startPersonaLoop(personaCfg.id, hours, async (onActivity, focusPrompt, triggerProjectId, scopeText) => {
      const report = (msg) => { log(personaCfg.id, msg); onActivity(msg); };

      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) report('Using custom soul prompt from Firestore');
      if (focusPrompt) report(`Focus prompt active: "${focusPrompt}"`);
      if (triggerProjectId) report(`Project filter active: ${triggerProjectId}`);
      if (scopeText) report(`Scope active: "${scopeText}"`);

      return runner.runCycle({
        db,
        projectService,
        makeTicketService,
        onActivity: report,
        soulPrompt,
        focusPrompt,
        triggerProjectId,
        scopeText: scopeText || null,
        projectScreenshotConfigs,
      });
    }, state);

    customPersonaStoppers[personaCfg.id] = stop;
    stoppers.push(stop);
  }

  // Start config-file personas and sync definitions to /advisorPersonas for the web UI
  for (const personaCfg of configPersonas) {
    await startCustomPersonaLoop(personaCfg);
    personaCount++;
    // Sync to /advisorPersonas so the web advisor panel can display them
    try {
      await db.collection('advisorPersonas').doc(personaCfg.id).set({
        name: personaCfg.name,
        systemPrompt: personaCfg.systemPrompt,
        model: personaCfg.model,
        intervalHours: personaCfg.intervalHours,
        focusAreas: personaCfg.focusAreas || [],
        ...(personaCfg.projects ? { projects: personaCfg.projects } : {}),
        ...(personaCfg.visual ? { visual: true } : {}),
        source: 'config',
      }, { merge: true });
    } catch (err) {
      log(personaCfg.id, `Warning: failed to sync persona to Firestore: ${err.message}`);
    }
  }

  // ── Watch Firestore /advisorPersonas for dynamic personas ───────────────
  // The web UI writes persona definitions to /advisorPersonas/{id}.
  // We pick them up here at startup and watch for newly created personas.
  // Deletions and edits take effect on the next daemon restart (existing loops
  // run to completion rather than being killed mid-cycle).
  const { validatePersona } = await import('./custom-personas-config.js');

  // Maximum number of custom personas that the daemon will run concurrently.
  // Checked at startup and each time a new 'added' event fires from Firestore.
  const MAX_CUSTOM_PERSONAS_PER_DAEMON = 10;

  const firestorePersonasUnsub = db.collection('advisorPersonas').onSnapshot(
    async (snap) => {
      // Count of currently active Firestore-sourced custom personas
      const activeFirestorePersonas = Object.keys(customPersonaStoppers).filter(
        id => !configPersonas.find(p => p.id === id)
      );

      for (const docChange of snap.docChanges()) {
        const data = docChange.doc.data();
        if (docChange.type === 'added' || docChange.type === 'modified') {
          if (customPersonaStoppers[data.id]) continue; // already running

          // Enforce maximum of 10 custom personas server-side
          if (activeFirestorePersonas.length >= MAX_CUSTOM_PERSONAS_PER_DAEMON) {
            log('advisor', `Custom persona "${data.name || data.id}" skipped: maximum of ${MAX_CUSTOM_PERSONAS_PER_DAEMON} custom personas reached`);
            continue;
          }

          const { persona, errors } = validatePersona(data);
          if (errors.length > 0) {
            log('advisor', `Custom persona "${data.name || data.id}" skipped: ${errors.join('; ')}`);
            continue;
          }
          try {
            await startCustomPersonaLoop(persona);
            activeFirestorePersonas.push(persona.id);
            personaCount++;
          } catch (err) {
            log('advisor', `Failed to start custom persona "${persona.name}": ${err.message}`);
          }
        }
        // Note: 'removed' — running loops are not killed; they finish naturally.
        // The next daemon restart will not re-add the deleted persona.
      }
    },
    (err) => {
      log('advisor', `Warning: could not watch /advisorPersonas — ${err.message}`);
    }
  );
  stoppers.push(() => firestorePersonasUnsub());

  if (personaCount === 0) {
    log('advisor', 'Warning: no personas configured under "advisor" (need "engineer", "design", and/or "product")');
  } else {
    log('advisor', `EPD Advisor running with ${personaCount} persona(s)`);
  }

  // ── Feedback aggregate job ─────────────────────────────────────────────
  // Runs every hour. Queries recent advisorRuns docs that have a `created`
  // array (i.e. new-schema runs with ticket IDs) and updates feedbackSummary
  // by tallying the /feedback collection for each run's ticket set.
  //
  // This is intentionally a read-heavy aggregate — it re-computes on every
  // pass so late-arriving ratings are reflected without additional bookkeeping.
  // For v1 with low ticket volume this is acceptable; revisit if volumes grow.
  const FEEDBACK_AGGREGATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  // Look back at runs from the last 30 days (covers the run retention window)
  const FEEDBACK_LOOKBACK_DAYS = 30;

  let feedbackAggregateTimer = null;
  let feedbackAggregateStopped = false;

  async function runFeedbackAggregate() {
    if (feedbackAggregateStopped) return;
    try {
      const feedbackService = createFeedbackService(db);
      const cutoff = new Date(Date.now() - FEEDBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Query recent completed runs that have the new-schema `created` array
      const snap = await db.collection('advisorRuns')
        .where('finishedAt', '>=', cutoff)
        .where('status', '==', 'completed')
        .get();

      if (snap.empty) {
        feedbackAggregateTimer = setTimeout(runFeedbackAggregate, FEEDBACK_AGGREGATE_INTERVAL_MS);
        return;
      }

      let updated = 0;
      for (const doc of snap.docs) {
        const run = doc.data();
        const ticketIds = Array.isArray(run.created) && run.created.length > 0
          ? run.created
          : null;
        if (!ticketIds) continue; // legacy run with no created array — skip

        const summary = await feedbackService.tallyFeedbackForTickets(ticketIds);

        // Only write if summary has changed (avoid unnecessary writes)
        const existing = run.feedbackSummary;
        const unchanged = existing
          && existing.relevant === summary.relevant
          && existing.noise === summary.noise
          && existing.total === summary.total;

        if (!unchanged) {
          await doc.ref.update({ feedbackSummary: summary });
          updated++;
        }
      }

      if (updated > 0) {
        log('advisor', `Feedback aggregate: updated ${updated} run(s)`);
      }
    } catch (err) {
      log('advisor', `Feedback aggregate error (non-fatal): ${err.message}`);
    }

    if (!feedbackAggregateStopped) {
      feedbackAggregateTimer = setTimeout(runFeedbackAggregate, FEEDBACK_AGGREGATE_INTERVAL_MS);
    }
  }

  // Start immediately, then repeat
  feedbackAggregateTimer = setTimeout(runFeedbackAggregate, 0);
  stoppers.push(() => {
    feedbackAggregateStopped = true;
    if (feedbackAggregateTimer !== null) clearTimeout(feedbackAggregateTimer);
  });

  // ── Dry-run listener ───────────────────────────────────────────────────
  // Listens for /advisor-dry-runs docs with status == 'pending' and runs
  // the appropriate persona with dryRun: true. Results are written back to
  // the same doc; the UI subscribes via onSnapshot.

  // Cleanup expired docs first (non-fatal)
  await cleanupExpiredDryRuns(db);

  // Build persona runner map keyed by personaId.
  // Each runner receives { projectId, onProgress, dryRun: true } and returns
  // a proposals array. We resolve project config from Firestore each time so
  // the runner always sees the latest saved settings.
  const dryRunPersonaRunners = {};

  if (advisorConfig.engineer) {
    const cfg = advisorConfig.engineer;
    const engineerInst = createEngineer({ config: cfg });
    dryRunPersonaRunners.engineer = async ({ projectId, onProgress }) => {
      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim() && (!projectId || p.id === projectId));
      if (eligible.length === 0) return [];
      const allProposals = [];
      for (const project of eligible) {
        const pCfg = projectsCfg[project.id] || {};
        const repoPath = pCfg.repoPath || project.repoPath;
        const scanPaths = pCfg.scanPaths || project.scanPaths || ['.'];
        if (!repoPath) continue;
        const ticketService = makeTicketService(project.id);
        // DK-133: Dry-run uses project instructions only (no global fallback for previews).
        const personaInstructions = project.personaInstructions?.engineer?.trim() || null;
        // Per-project dedupThreshold for dry-run (DK-130)
        const dedupThreshold = project.advisorSettings?.engineer?.dedupThreshold ?? undefined;
        const result = await engineerInst.runAudit({
          project, repoPath, scanPaths, ticketService, db,
          onActivity: onProgress, dryRun: true, personaInstructions, dedupThreshold,
          priorities: project.priorities || null,
        });
        if (Array.isArray(result.proposals)) allProposals.push(...result.proposals);
      }
      return allProposals;
    };
  }

  if (advisorConfig.design) {
    const cfg = advisorConfig.design;
    let storageBucket = null;
    try { storageBucket = admin.storage().bucket(); } catch {}
    const screenshotDir = cfg.screenshotDir !== undefined ? cfg.screenshotDir : DEFAULT_SCREENSHOT_DIR;
    const designerInst = createDesigner({ config: cfg, storage: storageBucket, screenshotDir });
    dryRunPersonaRunners.design = async ({ projectId, onProgress }) => {
      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim() && (!projectId || p.id === projectId));
      if (eligible.length === 0) return [];
      const allProposals = [];
      for (const project of eligible) {
        const pCfg = projectsCfg[project.id] || {};
        const appUrl = pCfg.appUrl || project.canaryUrl || project.releaseUrl;
        const flows = pCfg.appFlows || ['/'];

        // Warn if any appFlows entry duplicates the base path already present in appUrl (DK-296).
        if (appUrl && Array.isArray(pCfg.appFlows)) {
          try {
            const basePath = new URL(appUrl).pathname.replace(/\/$/, '');
            if (basePath && basePath !== '/') {
              for (const flow of pCfg.appFlows) {
                if (typeof flow === 'string' && flow.replace(/\/$/, '') === basePath) {
                  report(`[${project.id}] WARNING: appFlows entry "${flow}" duplicates the base path in appUrl. ` +
                    `Use relative paths like "/" or "/settings" instead. See advisor/CLAUDE.md for details.`);
                }
              }
            }
          } catch (_) { /* non-fatal */ }
        }

        const qaFlows = pCfg.qaFlows || null;
        const projectLocalStorage = pCfg.localStorage || null;
        const projectCookies = pCfg.cookies || null;
        const ticketService = makeTicketService(project.id);
        // DK-133: Dry-run uses project instructions only (no global fallback for previews).
        const personaInstructions = project.personaInstructions?.design?.trim() || null;
        // Per-project dedupThreshold for dry-run (DK-130)
        const dedupThreshold = project.advisorSettings?.design?.dedupThreshold ?? undefined;
        const result = await designerInst.runAudit({
          project, appUrl, flows, qaFlows, projectLocalStorage, projectCookies,
          ticketService, db, onActivity: onProgress, dryRun: true, personaInstructions, dedupThreshold,
          priorities: project.priorities || null,
        });
        if (Array.isArray(result.proposals)) allProposals.push(...result.proposals);
      }
      return allProposals;
    };
  }

  if (advisorConfig.product) {
    const cfg = advisorConfig.product;
    const pmInst = createProductManager({ config: cfg });
    dryRunPersonaRunners.product = async ({ projectId, onProgress }) => {
      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim() && (!projectId || p.id === projectId));
      if (eligible.length === 0) return [];
      const allProposals = [];
      for (const project of eligible) {
        const pCfg = projectsCfg[project.id] || {};
        const repoPath = pCfg.repoPath || project.repoPath;
        const scanPaths = pCfg.scanPaths || project.scanPaths || ['.'];
        const ticketService = makeTicketService(project.id);
        // DK-133: Dry-run uses project instructions only (no global fallback for previews).
        const personaInstructions = project.personaInstructions?.product?.trim() || null;
        // Per-project dedupThreshold for dry-run (DK-130)
        const dedupThreshold = project.advisorSettings?.product?.dedupThreshold ?? undefined;
        // DK-365: Pass constraints for dry-run previews too
        let dryRunConstraints = null;
        const rawDryConstraints = project.advisorSettings?.product?.constraints ?? null;
        if (rawDryConstraints) {
          try { dryRunConstraints = validateConstraints(rawDryConstraints); } catch (_) { /* ignore invalid */ }
        }
        const result = await pmInst.runCycle({
          project, ticketService, db, repoPath, scanPaths,
          onActivity: onProgress, dryRun: true, personaInstructions, dedupThreshold,
          constraints: dryRunConstraints,
          priorities: project.priorities || null,
        });
        if (Array.isArray(result.proposals)) allProposals.push(...result.proposals);
      }
      return allProposals;
    };
  }

  if (advisorConfig.qa) {
    const cfg = advisorConfig.qa;
    const screenshotDirQa = cfg.screenshotDir !== undefined ? cfg.screenshotDir : DEFAULT_SCREENSHOT_DIR;
    const qaInst = createQA({ config: cfg, screenshotDir: screenshotDirQa });
    dryRunPersonaRunners.qa = async ({ projectId, onProgress }) => {
      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim() && (!projectId || p.id === projectId));
      if (eligible.length === 0) return [];
      const allProposals = [];
      for (const project of eligible) {
        const pCfg = projectsCfg[project.id] || {};
        const appUrl = pCfg.appUrl || project.canaryUrl || project.releaseUrl;
        const flows = pCfg.qaFlows || [];
        const projectLocalStorage = pCfg.localStorage || null;
        const projectCookies = pCfg.cookies || null;
        if (!appUrl) continue;
        const ticketService = makeTicketService(project.id);
        const result = await qaInst.runAudit({
          project, appUrl, flows, db, projectLocalStorage, projectCookies,
          ticketService, onActivity: onProgress, dryRun: true,
        });
        if (Array.isArray(result.proposals)) allProposals.push(...result.proposals);
      }
      return allProposals;
    };
  }

  const dryRunUnsub = startDryRunListener(db, dryRunPersonaRunners);
  stoppers.push(dryRunUnsub);
  log('advisor', 'Dry-run listener active');

  // ── DK-136: Event-based persona run triggers ──────────────────────────────
  // Ticket-close-count auto-triggers disabled — all advisors are on-demand only.
  // Manual triggers (web UI "Run Now", CLI, webhooks) still work via the
  // watchTrigger / watchRunRequested listeners in each persona loop.

  // Start webhook server (DK-136). Only starts if DOCKET_WEBHOOK_SECRET env var is set.
  // Personas must have triggers.webhook: true in config to accept webhook triggers.
  {
    const webhookPersonas = ['engineer', 'design', 'product', 'qa']
      .filter(pid => advisorConfig[pid]?.triggers?.webhook === true);
    const { stop: stopWebhook } = startWebhookServer({ db, enabledPersonas: webhookPersonas });
    stoppers.push(stopWebhook);
  }

  // Return a stop() function that shuts down all persona loops
  return function stopAdvisor() {
    log('advisor', 'Shutting down advisor personas…');
    for (const stop of stoppers) stop();
  };
}
