// _renderCard + countdown ticker + activity log + ARIA live region.
// Updates one persona card from its current Firestore state.

import { el } from '../ui/el.js';
import {
  toDate,
  formatRelative,
  formatRelativeTs,
  formatAbsolute,
  formatLastRunLine,
} from '../ui/format.js';
import { PERSONAS, PERSONA_AVATARS } from '../config/personas.js';
import { computeNextRunCountdown } from '../helpers/countdown.js';

export const cardRenderMixin = {
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
  },

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
  },

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
  },

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
  },







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
};
