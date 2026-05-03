// Schedule editor (DK-195) + advisorContext save handler.
// Computes the next scheduled run from a schedule config and renders
// the day/time-window UI on each persona card.

export const scheduleMixin = {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  /** @deprecated Use _saveSchedule instead. Kept for compatibility. */
  async _saveTimeWindow(id, ...args) {
    // no-op: new UI uses _saveSchedule
  },

  /** @deprecated Use _clearSchedule instead. Kept for compatibility. */
  async _clearTimeWindow(id, ...args) {
    // no-op: new UI uses _clearSchedule
  },

  /** @deprecated Use _updateScheduleUI instead. Kept for compatibility. */
  _updateTimeWindowUI(id, ...args) {
    // no-op: new UI uses _updateScheduleUI
  },

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
};
