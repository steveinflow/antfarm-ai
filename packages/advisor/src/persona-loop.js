// @docket/advisor — Persona run loop.
// Extracted from start-advisor.js for navigability.
//
// Uses setTimeout (not setInterval) so the next cycle is always scheduled
// AFTER the current one completes. Reads intervalHours from Firestore each
// time so UI-driven changes take effect on the next cycle.
//
// runFn signature: (onActivity, focusPrompt, projectId, scopeText) => Promise<{ ticketsCreated, lastActivity }>
// focusPrompt is non-null only for on-demand trigger runs.
// projectId is non-null only for on-demand trigger runs scoped to a specific project.
// scopeText is non-null only when the user provided a focus scope for this run (DK-367).

import { getCooldownMs, RUN_REQUEST_COOLDOWN_MS } from './cooldowns.js';
import { sanitizeUserHint } from './validators.js';
import { validateSchedule, isWithinSchedule, msUntilScheduleOpen } from './schedule.js';
import { validateAllowedHours, isWithinWindow, msUntilWindowOpen } from './time-windows.js';

/**
 * Start the per-persona run loop.
 *
 * @param {string} name                       persona id (used in log lines)
 * @param {number} defaultIntervalHours       fallback interval if Firestore has no override
 * @param {function} runFn                    (onActivity, focusPrompt, projectId, scopeText) => Promise<{ ticketsCreated, lastActivity }>
 * @param {object} personaState               from createPersonaState(db, name)
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs]          override per-persona cooldown
 * @param {function} [opts.log]               (persona, msg) => void; defaults to a console-only logger
 * @returns {function}                        stop() — unsubscribes listeners and cancels timers
 */
export function startPersonaLoop(name, defaultIntervalHours, runFn, personaState, { cooldownMs, log } = {}) {
  const _log = log ?? ((persona, msg) => {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] [${persona}] ${msg}`);
  });
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
    _log(name, msg);
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
    _log(name, 'On-demand trigger — starting cycle');
    tick();
  }

  // Watch for legacy runNow flag from the web UI (backward compat).
  const unsubRunNow = personaState.watchRunNow(() => {
    _log(name, 'runNow flag detected');
    triggerNow(null, null);
  });

  // Watch for on-demand trigger (new DK-099 path).
  const unsubTrigger = personaState.watchTrigger(({ focusPrompt, requestedBy, requestedAt, projectId, scopeText }) => {
    _log(name, `On-demand trigger received (requestedBy: ${requestedBy || 'unknown'}${projectId ? `, project: ${projectId}` : ''}${scopeText ? `, scope: "${scopeText.slice(0, 40)}"` : ''})`);
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
        _log(name, `runRequestedAt detected: ${requestedAt}`);
        // Cooldown enforcement: if lastRunAt is within 5 minutes, reject and surface error.
        const state = await personaState.read();
        const lastRunAt = state?.lastRunAt ?? null;
        if (lastRunAt) {
          const elapsed = Date.now() - new Date(lastRunAt).getTime();
          if (elapsed < RUN_REQUEST_COOLDOWN_MS) {
            const remainingSec = Math.ceil((RUN_REQUEST_COOLDOWN_MS - elapsed) / 1000);
            _log(name, `runRequestedAt rejected — cooldown active (${remainingSec}s remaining)`);
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
      _log(name, `Interval ${intervalHours}h is below 0.25h floor — clamping to 0.25h`);
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
      _log(name, 'Paused — skipping cycle');
      pendingTimer = setTimeout(tick, intervalMs);
      return;
    }

    if (paused && isOnDemand) {
      _log(name, 'Paused but on-demand trigger — running cycle');
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
          _log(name, `schedule config invalid — skipping window check (will run): ${errors.join('; ')}`);
          // Fall through and run anyway per spec
        } else {
          const now = new Date();
          if (!isWithinSchedule(schedule, now)) {
            const waitMs = msUntilScheduleOpen(schedule, now);
            const waitMin = Math.round(waitMs / 60_000);
            _log(name, `Outside schedule window — sleeping ${waitMin}m until window opens`);
            pendingTimer = setTimeout(tick, waitMs);
            return;
          }
        }
      } else if (allowedHours !== null) {
        // Legacy allowedHours field: UTC hours + string day abbreviations
        const { valid, errors } = validateAllowedHours(allowedHours);
        if (!valid) {
          _log(name, `allowedHours config invalid — skipping window check: ${errors.join('; ')}`);
          // Fall through and run anyway (log and skip per spec)
        } else {
          const nowUtc = new Date();
          if (!isWithinWindow(allowedHours, nowUtc)) {
            const waitMs = msUntilWindowOpen(allowedHours, nowUtc);
            const waitMin = Math.round(waitMs / 60_000);
            _log(name, `Outside allowed hours window — sleeping ${waitMin}m until window opens`);
            pendingTimer = setTimeout(tick, waitMs);
            return;
          }
        }
      }
    } else if (paused) {
      // On-demand run while paused — log notice per spec
      _log(name, 'Persona is paused — this run is once-only and will not resume the schedule');
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
        _log(name, `Saved focus area active for this run: "${focusPrompt}"`);
      } else {
        _log(name, `Focus prompt for this run: "${focusPrompt}" (requestedBy: ${requestedBy || 'unknown'})`);
      }
    }
    if (triggerProjectId) {
      _log(name, `Project filter for this run: ${triggerProjectId}`);
    }
    if (triggerScopeText) {
      _log(name, `Scope for this run: "${triggerScopeText}"`);
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
    _log(name, 'Cycle starting');

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
      _log(name, 'Saved focus area cleared after use');
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
      _log(name, `Cycle done. On-demand pending — starting next cycle immediately`);
      pendingTimer = setTimeout(tick, 0);
    } else {
      _log(name, `Cycle done. Waiting for on-demand trigger.`);
      // On-demand only: do not schedule the next tick automatically.
      // The persona will run again only when triggerNow() is called
      // via the web UI, CLI, webhook, or ticket-close-count trigger.
    }
  }

  // On-demand only: do not auto-start a cycle on boot.
  // Personas wait for an explicit trigger (web UI, CLI, webhook, etc.).
  _log(name, 'Ready (on-demand only — waiting for trigger)');
  return () => {
    stopped = true;
    _onActivity = null;
    unsubRunNow();
    unsubTrigger();
    if (typeof unsubRunRequested === 'function') unsubRunRequested();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
  };
}
