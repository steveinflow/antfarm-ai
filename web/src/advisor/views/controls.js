// Per-card controls — Run Now, focus directive, run timers, Pause All,
// interval / ticket-cap / dedup-threshold writers.

import { toDate } from '../ui/format.js';
import { PERSONAS } from '../config/personas.js';
import { computeNextRunCountdown } from '../helpers/countdown.js';

export const controlsMixin = {
  // ── Controls ─────────────────────────────────────────────────

  /** @deprecated — kept for backward compat; new code calls _triggerRun */
  async _runNow(id) {
    await this._triggerRun(id, null);
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  /**
   * Auto-save path (called from debounce/blur via save-on-blur control).
   * Saves to Firestore but does NOT clear the textarea or collapse the focus area.
   * The value parameter is the raw string value from the textarea.
   */
  async _autoSaveFocusPrompt(id, rawValue) {
    const sanitizedFocus = this._sanitizeFocusPrompt(rawValue);
    await this._persistFocusPrompt(id, sanitizedFocus);
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  /** Stop the per-card elapsed timer for a persona. */
  _stopRunTimer(id) {
    if (this._runTimers?.[id]) {
      clearInterval(this._runTimers[id]);
      delete this._runTimers[id];
    }
  },


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
  },

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
  },

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
  },

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
};
