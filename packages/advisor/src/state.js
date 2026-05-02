// Firestore state for EPD advisor personas.
// The daemon writes here; the web UI reads and writes controls back.
//
// Collection: /advisor/{personaId}
// Shape:
//   status:              'idle' | 'running' | 'paused'
//   intervalHours:       number
//   lastRunAt:           ISO string | null
//   lastRunTicketCount:  number | null  — ticket count from the most recent run (scheduled or on-demand)
//   nextRunAt:           ISO string | null — written by orchestrator after each run; UI reads directly
//   lastActivity:        string | null
//   activityLog:         Array<{ at: ISO string, msg: string }> — last N activity entries (newest first)
//   cycleCount:          number
//   ticketsCreated:      number
//   error:               string | null
//   startedAt:           ISO string
//   ticketCap:           number | null   — max tickets to create per run (1–50); set by web UI; default 3
//   runNow:              boolean | null  — set true by the web UI to trigger an immediate cycle
//   soulPrompt:          string | null   — custom system prompt override; null means use the hardcoded default
//   savedFocusPrompt:    string | null   — persisted focus area set by the web UI; used on the next
//                                         scheduled (or on-demand) run then cleared automatically
//   runRequestedAt:      ISO string | null — set by the web UI to request an on-demand run (DK-303);
//                                           orchestrator clears it after pickup (or on cooldown violation)
//   allowedHours:        { start: 0-23, end: 0-23, days: string[] } | null — legacy time window (DK-303)
//                                           start/end in UTC hours; days = subset of ['mon','tue','wed','thu','fri','sat','sun']
//                                           null means no restriction (run any time).
//                                           Superseded by 'schedule' when both are present.
//   schedule:            { timezone, allowedDays, windowStart, windowEnd } | null — timezone-aware schedule (DK-195)
//                                           timezone: IANA string (e.g. "America/New_York")
//                                           allowedDays: number[] — JS day integers (0=Sun … 6=Sat)
//                                           windowStart / windowEnd: "HH:MM" 24h strings
//                                           null means no restriction (run any time).
//                                           Takes priority over allowedHours when both present.
//
// On-demand trigger sub-document fields (DK-099):
//   trigger:         { requestedAt: ISO, focusPrompt: string|null, requestedBy: string|null } | null
//   state:           'idle' | 'running' (mirrors status; used by UI for on-demand run state)
//   lastRunTickets:  number | null  — ticket count from most recent on-demand run
//   lastRunBy:       string | null  — requestedBy from most recent on-demand trigger
//   cooldownUntil:   ISO string | null — if set and in the future, UI shows cooldown nudge
//
// Trigger log (DK-136) — separate top-level collection:
// Collection: /advisorTriggerLog
// Shape:
//   personaId:        'engineer' | 'design' | 'product' | 'qa'
//   trigger:          'manual' | 'webhook' | 'ticketCloseCount' | 'interval'
//   triggeredAt:      ISO string
//   triggeredBy:      string — user email/uid for manual; 'system' for automated; 'webhook' for webhook
//   proposalsCreated: number | null — filled in after run completes; null while pending

const COL = 'advisor';
const MAX_LOG_ENTRIES = 50;

// ── Prompt injection prevention ──────────────────────────────────────────────
// WARNING: soulPrompt and savedFocusPrompt are user-controlled strings that
// flow directly into LLM system/focus prompts sent to the Claude API.
// Always sanitize these values at both read and write time to prevent prompt
// injection attacks. Never pass raw user-supplied text to LLM system prompts.
//
// Length limits:
const SOUL_PROMPT_MAX_CHARS      = 500;  // soulPrompt replaces the entire system prompt
const SAVED_FOCUS_PROMPT_MAX_CHARS = 200; // savedFocusPrompt is appended as a focus directive

// Prompt-delimiter characters that could break prompt structure
const PROMPT_DELIMITER_RE = /<\/?system>|<\|/g;

// Role-switching / injection phrases (case-insensitive substring check)
const INJECTION_PHRASES = [
  'ignore previous instructions',
  'you are now',
  'disregard',
  'new persona',
  'system:',
];

/**
 * Sanitize a soulPrompt value:
 *  - Strip prompt-delimiter characters (preserve newlines — they're valid in system prompts)
 *  - Enforce SOUL_PROMPT_MAX_CHARS length cap
 *  - Remove known injection phrases
 *  - Return null if empty after sanitization
 *
 * @param {string} val
 * @returns {string|null}
 */
function sanitizeSoulPrompt(val) {
  if (typeof val !== 'string') return null;
  let s = val.slice(0, SOUL_PROMPT_MAX_CHARS);
  const lower = s.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      s = s.replace(re, '');
    }
  }
  s = s.replace(PROMPT_DELIMITER_RE, '').trim();
  return s.length > 0 ? s : null;
}

/**
 * Sanitize a savedFocusPrompt value:
 *  - Strip prompt-delimiter characters and newlines (focus prompts are single-line)
 *  - Enforce SAVED_FOCUS_PROMPT_MAX_CHARS length cap
 *  - Remove known injection phrases
 *  - Return null if empty after sanitization
 *
 * @param {string} val
 * @returns {string|null}
 */
function sanitizeSavedFocusPrompt(val) {
  if (typeof val !== 'string') return null;
  let s = val.slice(0, SAVED_FOCUS_PROMPT_MAX_CHARS);
  const lower = s.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      s = s.replace(re, '');
    }
  }
  s = s.replace(PROMPT_DELIMITER_RE, '').replace(/[\r\n\u2028\u2029]/g, ' ').trim();
  return s.length > 0 ? s : null;
}

export function createPersonaState(db, personaId) {
  const ref = db.collection(COL).doc(personaId);

  // Called on daemon startup. Always starts paused so personas do not run
  // automatically when the server restarts. The user must manually resume
  // each persona from the advisor panel.
  async function init(defaultIntervalHours) {
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : {};
    // Reset operational state and preserve user-set settings (intervalHours,
    // intervalMinutes, ticketCap, soulPrompt, savedFocusPrompt, etc.).
    // Always start paused on server startup regardless of prior state.
    // The user wakes each persona via the Resume button in the advisor panel.
    const update = {
      status:          'paused',
      // Preserve existing interval settings; only set default if absent.
      intervalHours:   prev.intervalHours   ?? defaultIntervalHours,
      lastRunAt:       prev.lastRunAt        ?? null,
      nextRunAt:       null,
      lastActivity:    prev.lastActivity     ?? null,
      activityLog:     prev.activityLog      ?? [],
      cycleCount:      prev.cycleCount       ?? 0,
      ticketsCreated:  prev.ticketsCreated   ?? 0,
      error:           null,
      startedAt:       new Date().toISOString(),
    };
    // Preserve intervalMinutes only if set (sub-hour cadence)
    if (prev.intervalMinutes !== undefined) update.intervalMinutes = prev.intervalMinutes;
    // Use merge: true so user-configured fields not listed here
    // (ticketCap, soulPrompt, savedFocusPrompt, etc.) survive daemon restarts.
    await ref.set(update, { merge: true });
  }

  // In-memory state for the current running cycle.
  // _preCycleLog: the activityLog entries that existed before this cycle started.
  // _cycleEntries: new entries added during this cycle (newest first).
  let _preCycleLog = [];
  let _cycleEntries = [];

  async function setRunning(activity) {
    // If this is the first call in a cycle, snapshot the existing log so we
    // can prepend new entries without reading Firestore on every update.
    if (_cycleEntries.length === 0) {
      const snap = await ref.get();
      _preCycleLog = snap.exists ? (snap.data()?.activityLog || []) : [];
    }
    const entry = { at: new Date().toISOString(), msg: activity };
    _cycleEntries.unshift(entry); // newest first
    // Merge cycle entries with pre-cycle log, capped at MAX_LOG_ENTRIES.
    const activityLog = [..._cycleEntries, ..._preCycleLog].slice(0, MAX_LOG_ENTRIES);
    await ref.set({ status: 'running', lastActivity: activity, error: null, activityLog }, { merge: true });
  }

  async function setIdle({ lastActivity, ticketsCreated, cycleCount, nextRunAt, error = null, lastRunTickets = null, lastRunBy = null, cooldownUntil = null, lastRunError = null, lastRunTicketCount = null }) {
    // Activity log entries were already written in real-time by setRunning().
    // Just add a final summary entry if it differs from the last cycle entry.
    const finalMsg = error ? `Error: ${error}` : (lastActivity || 'Cycle completed');
    const lastCycleMsg = _cycleEntries.length > 0 ? _cycleEntries[0].msg : null;
    let cycleEntries = _cycleEntries;
    if (lastCycleMsg !== finalMsg) {
      const finalEntry = { at: new Date().toISOString(), msg: finalMsg };
      cycleEntries = [finalEntry, ..._cycleEntries];
    }
    const activityLog = [...cycleEntries, ..._preCycleLog].slice(0, MAX_LOG_ENTRIES);
    // Reset cycle state
    _cycleEntries = [];
    _preCycleLog = [];
    const idleUpdate = {
      status: 'idle',
      lastRunAt: new Date().toISOString(),
      nextRunAt: nextRunAt instanceof Date ? nextRunAt.toISOString() : (nextRunAt ?? null),
      lastActivity,
      activityLog,
      ticketsCreated,
      cycleCount,
      error,
      // DK-321: lastRunError is a generic failure message surfaced to the UI.
      // null clears it on a successful run.
      lastRunError: lastRunError ?? null,
      // DK-303: lastRunTicketCount — ticket count from the most recent run (any type).
      // Written on every run (scheduled or on-demand). null if unknown.
      lastRunTicketCount: lastRunTicketCount !== null ? lastRunTicketCount : (lastRunTickets !== null ? lastRunTickets : null),
    };
    if (lastRunTickets !== null) idleUpdate.lastRunTickets = lastRunTickets;
    if (lastRunBy !== null) idleUpdate.lastRunBy = lastRunBy;
    if (cooldownUntil !== null) idleUpdate.cooldownUntil = cooldownUntil;
    await ref.set(idleUpdate, { merge: true });
  }

  // Read current status and intervalHours without a live listener.
  async function read() {
    const snap = await ref.get();
    return snap.exists ? snap.data() : null;
  }

  // Clear the runNow flag after the daemon picks it up.
  async function clearRunNow() {
    await ref.set({ runNow: false }, { merge: true });
  }

  // Watch for runNow flag changes. Calls onRunNow() when runNow becomes true.
  // Returns an unsubscribe function.
  function watchRunNow(onRunNow) {
    return ref.onSnapshot((snap) => {
      if (snap.exists && snap.data()?.runNow === true) {
        onRunNow();
      }
    });
  }

  // Read the soulPrompt field. Returns null if not set (use hardcoded default).
  // SECURITY: sanitizeSoulPrompt() is applied at read time to defend against
  // values written by older clients or direct Firestore writes that bypassed
  // the write-time sanitization in setSoulPrompt().
  async function getSoulPrompt() {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const val = snap.data()?.soulPrompt;
    return sanitizeSoulPrompt(val);
  }

  // Write a new soulPrompt value. Pass null or '' to clear (revert to default).
  // SECURITY: sanitizeSoulPrompt() is applied at write time to enforce length
  // limits and strip injection patterns before the value reaches Firestore.
  // This field flows directly into the LLM system prompt — never skip sanitization.
  async function setSoulPrompt(text) {
    const value = sanitizeSoulPrompt(text);
    await ref.set({ soulPrompt: value }, { merge: true });
  }

  // ── Saved focus prompt (DK-239) ────────────────────────────────────────
  // The web UI writes a saved focus prompt that persists across sessions.
  // The daemon reads it at the start of the next run (scheduled or on-demand),
  // logs it, uses it, and clears it so it only applies once.

  // Read the current savedFocusPrompt field. Returns null if not set.
  // SECURITY: sanitizeSavedFocusPrompt() is applied at read time to defend
  // against values written by older clients or direct Firestore writes that
  // bypassed write-time sanitization. This field is appended to LLM prompts.
  async function getSavedFocusPrompt() {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const val = snap.data()?.savedFocusPrompt;
    return sanitizeSavedFocusPrompt(val);
  }

  // Write a new savedFocusPrompt value. Pass null or '' to clear.
  // SECURITY: sanitizeSavedFocusPrompt() is applied at write time to enforce
  // length limits and strip injection patterns before the value reaches Firestore.
  // This field flows directly into LLM focus prompts — never skip sanitization.
  async function setSavedFocusPrompt(text) {
    const value = sanitizeSavedFocusPrompt(text);
    await ref.set({ savedFocusPrompt: value }, { merge: true });
  }

  // Clear the savedFocusPrompt after it has been used in a run.
  async function clearSavedFocusPrompt() {
    await ref.set({ savedFocusPrompt: null }, { merge: true });
  }

  // ── On-demand trigger (DK-099) ─────────────────────────────────────────
  // The web UI writes a trigger field on the /advisor/{personaId} doc.
  // The daemon watches for it and consumes it.

  // Watch for on-demand trigger field changes.
  // Calls onTrigger({ focusPrompt, requestedBy, requestedAt, projectId }) when a trigger arrives.
  // Returns an unsubscribe function.
  function watchTrigger(onTrigger) {
    return ref.onSnapshot((snap) => {
      if (!snap.exists) return;
      const data = snap.data();
      const trigger = data?.trigger;
      // A trigger is pending when it is an object with a requestedAt field and
      // the 'consumed' flag is not set.
      if (trigger && typeof trigger === 'object' && trigger.requestedAt && !trigger.consumed) {
        onTrigger({
          focusPrompt: trigger.focusPrompt ?? null,
          requestedBy: trigger.requestedBy ?? null,
          requestedAt: trigger.requestedAt,
          projectId: trigger.projectId ?? null,
        });
      }
    });
  }

  // Read the current trigger data without a listener (one-shot).
  // Returns null if no unconsumed trigger is present.
  async function getTriggerData() {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const trigger = snap.data()?.trigger;
    if (trigger && typeof trigger === 'object' && trigger.requestedAt && !trigger.consumed) {
      return {
        focusPrompt: trigger.focusPrompt ?? null,
        requestedBy: trigger.requestedBy ?? null,
        requestedAt: trigger.requestedAt,
        projectId: trigger.projectId ?? null,
      };
    }
    return null;
  }

  // Mark the trigger as consumed so the daemon doesn't re-process it.
  // We update the trigger field rather than deleting so the UI can read the
  // consumed state; the trigger is fully superseded once the run completes.
  async function clearTrigger() {
    await ref.set({ trigger: { consumed: true } }, { merge: true });
  }

  // ── runRequestedAt (DK-303) ────────────────────────────────────────────
  // The web UI writes runRequestedAt to request an on-demand run.
  // The orchestrator reads it on each tick, validates cooldown, clears it,
  // then fires the run. A stale value after restart will be cleared on first tick.

  // Watch for runRequestedAt field. Calls onRequest() when a request arrives.
  // Returns an unsubscribe function.
  function watchRunRequested(onRequest) {
    return ref.onSnapshot((snap) => {
      if (!snap.exists) return;
      const data = snap.data();
      if (data?.runRequestedAt && typeof data.runRequestedAt === 'string') {
        onRequest({ requestedAt: data.runRequestedAt });
      }
    });
  }

  // Clear runRequestedAt after pickup (or on cooldown violation).
  // Also writes an optional errorState field to surface cooldown errors to the UI.
  async function clearRunRequested(errorState = null) {
    const update = { runRequestedAt: null };
    if (errorState !== null) update.runRequestedError = errorState;
    else update.runRequestedError = null;
    await ref.set(update, { merge: true });
  }

  // ── allowedHours (DK-303) ─────────────────────────────────────────────
  // allowedHours: { start: 0-23, end: 0-23, days: string[] } | null
  // Governs scheduled runs only — on-demand runs always fire.
  // Stored in UTC hours; displayed in browser local time.

  // Read the current allowedHours configuration. Returns null if not set.
  async function getAllowedHours() {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const val = snap.data()?.allowedHours;
    return (val && typeof val === 'object') ? val : null;
  }

  // ── Trigger log (DK-136) ──────────────────────────────────────────────────
  // Write a trigger log entry to /advisorTriggerLog.
  // Called after each run completes to record proposals created.
  // Also called by webhook-server.js and trigger-listeners.js at trigger time.
  //
  // @param {{ trigger: string, triggeredAt: string, triggeredBy: string, proposalsCreated: number|null }} entry
  async function writeTriggerLog({ trigger, triggeredAt, triggeredBy, proposalsCreated }) {
    await db.collection('advisorTriggerLog').add({
      personaId: personaId,
      trigger,
      triggeredAt: triggeredAt || new Date().toISOString(),
      triggeredBy: triggeredBy || 'system',
      proposalsCreated: proposalsCreated ?? null,
    });
  }

  return { init, setRunning, setIdle, read, clearRunNow, watchRunNow, getSoulPrompt, setSoulPrompt, getSavedFocusPrompt, setSavedFocusPrompt, clearSavedFocusPrompt, watchTrigger, getTriggerData, clearTrigger, watchRunRequested, clearRunRequested, getAllowedHours, writeTriggerLog };
}
