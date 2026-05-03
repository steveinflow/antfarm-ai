// Feedback signals + DK-105 emphasis weights + activity log render.
// Per-persona feedback summary, expandable detail, and the weight-slider
// UI that lets users emphasise concerns. Also includes the inline
// activity-log rendering used by each card.

import { el } from '../ui/el.js';
import { toDate } from '../ui/format.js';
import { PERSONA_CONCERNS } from '../config/concerns.js';
import { buildWeightSummary } from '../helpers/persona.js';

export const feedbackMixin = {
  // ── Feedback signal methods ──────────────────────────────────

  /**
   * Save the per-persona feedback injection toggle to Firestore.
   * Writes to /projects/{projectId} advisorConfig.{personaId}.feedbackInjectionEnabled.
   * Operates on the currently selected project filter (or all projects if no filter).
   *
   * @param {string} personaId
   * @param {boolean} enabled
   */
  async _saveFeedbackToggle(personaId, enabled) {
    const card = this._cards[personaId];
    if (!card) return;

    // Update ARIA status text for screen readers
    if (card.feedbackToggleStatusEl) {
      card.feedbackToggleStatusEl.textContent = `Feedback injection: ${enabled ? 'on' : 'off'}`;
    }

    // Mark card as muted/labeled when injection is disabled per spec
    if (card.feedbackToggleRow) {
      card.feedbackToggleRow.classList.toggle('adv-feedback-injection-disabled', !enabled);
    }

    // Write to all projects (or the filtered project)
    const projectId = this._filterProjectId;
    if (!projectId) {
      // Write to all projects that have this persona configured
      for (const project of this._projects) {
        try {
          await this.db.collection('projects').doc(project.id).set(
            { advisorConfig: { [personaId]: { feedbackInjectionEnabled: enabled } } },
            { merge: true }
          );
        } catch (err) {
          console.warn(`Failed to save feedback toggle for ${project.id}:`, err);
        }
      }
    } else {
      try {
        await this.db.collection('projects').doc(projectId).set(
          { advisorConfig: { [personaId]: { feedbackInjectionEnabled: enabled } } },
          { merge: true }
        );
      } catch (err) {
        console.warn(`Failed to save feedback toggle for ${projectId}:`, err);
      }
    }

    // Reload stats after toggle change
    this._loadFeedbackStats(personaId);
  },

  /**
   * Toggle the feedback detail expansion for a persona card.
   * Loads stats on first open.
   *
   * @param {string} personaId
   */
  _toggleFeedbackDetail(personaId) {
    const card = this._cards[personaId];
    if (!card) return;

    const expanded = !this._feedbackDetailExpanded[personaId];
    this._feedbackDetailExpanded[personaId] = expanded;

    if (card.feedbackStatExpandBtn) {
      card.feedbackStatExpandBtn.setAttribute('aria-expanded', String(expanded));
      card.feedbackStatExpandBtn.textContent = expanded ? '▾' : '▸';
    }
    if (card.feedbackDetailEl) {
      card.feedbackDetailEl.classList.toggle('adv-hidden', !expanded);
    }

    if (expanded && !this._feedbackStats[personaId]) {
      this._loadFeedbackStats(personaId);
    }
  },

  /**
   * Load feedback stats for a persona from Firestore.
   * Aggregates feedbackEvents subcollection client-side over the recency window.
   *
   * Retries indefinitely on permission-denied while the user is authenticated —
   * the same strategy used by _subscribePersona and other onSnapshot listeners
   * (see _isPermissionDeniedTransient, DK-181, DK-206). Firestore can fire
   * permission-denied before the ID token has fully propagated; as long as the
   * user is signed in, the error is treated as transient and retried with
   * exponential backoff (capped at 60s).
   *
   * @param {string} personaId
   * @param {number} [retryDelayMs=5000] - backoff delay for the next retry attempt
   */
  async _loadFeedbackStats(personaId, retryDelayMs = 5000) {
    if (this._feedbackStatsLoading[personaId]) return;
    this._feedbackStatsLoading[personaId] = true;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      this._feedbackStatsLoading[personaId] = false;
      return;
    }

    try {
      const RECENCY_DAYS = 30;
      const RECENCY_MAX = 50;
      const MIN_THRESHOLD = 10;
      const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000);

      const snap = await this.db
        .collection('projects')
        .doc(projectId)
        .collection('feedbackEvents')
        .where('personaId', '==', personaId)
        .orderBy('timestamp', 'desc')
        .limit(RECENCY_MAX)
        .get();

      let accepted = 0, rejected = 0, snoozed = 0;
      const rejectedTicketIds = [];

      for (const doc of snap.docs) {
        const data = doc.data();
        const ts = data.timestamp?.toDate?.() ?? null;
        if (ts && ts < cutoff) break;
        if (data.decision === 'accepted') accepted++;
        else if (data.decision === 'rejected') { rejected++; rejectedTicketIds.push(data.ticketId); }
        else if (data.decision === 'snoozed') snoozed++;
      }

      const total = accepted + rejected + snoozed;
      const denominator = accepted + rejected;
      const acceptanceRate = denominator > 0 ? Math.round((accepted / denominator) * 100) : null;
      const belowThreshold = total < MIN_THRESHOLD;

      // Fetch rejected ticket categories
      const categoryCounts = {};
      for (let i = 0; i < rejectedTicketIds.length; i += 10) {
        const batch = rejectedTicketIds.slice(i, i + 10);
        if (!batch.length) break;
        try {
          const ticketSnap = await this.db
            .collection('projects')
            .doc(projectId)
            .collection('tickets')
            .where('__name__', 'in', batch)
            .get();
          for (const tDoc of ticketSnap.docs) {
            const td = tDoc.data();
            const labels = Array.isArray(td.tags) && td.tags.length > 0
              ? td.tags.filter(t => typeof t === 'string' && t.trim())
              : (typeof td.category === 'string' && td.category.trim() ? [td.category.trim()] : []);
            for (const label of labels) {
              const key = label.replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
              if (key) categoryCounts[key] = (categoryCounts[key] || 0) + 1;
            }
          }
        } catch { /* skip */ }
      }

      const topRejectedCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => ({ label, count }));

      this._feedbackStats[personaId] = {
        accepted, rejected, snoozed, total,
        acceptanceRate, belowThreshold,
        topRejectedCategories,
        windowDays: RECENCY_DAYS,
        windowMax: RECENCY_MAX,
        minThreshold: MIN_THRESHOLD,
        projectId,
      };

      // Read toggle state from project doc
      const projSnap = await this.db.collection('projects').doc(projectId).get();
      const injectionEnabled = projSnap.exists
        ? (projSnap.data()?.advisorConfig?.[personaId]?.feedbackInjectionEnabled !== false)
        : true;
      this._renderFeedbackStats(personaId, injectionEnabled);
    } catch (err) {
      // Use the same transient-detection helper as the onSnapshot listeners:
      // retry indefinitely while the user is authenticated (token propagation
      // can take arbitrarily long), escalate to console.error only when
      // permission-denied occurs without a signed-in user (a genuine auth problem).
      if (this._isPermissionDeniedTransient(err)) {
        const delay = Math.min(retryDelayMs, 60_000);
        console.warn(`AdvisorPanel: feedback stats error for ${personaId} (transient, retrying in ${delay}ms)`, err);
        setTimeout(() => {
          if (this._mounted) this._loadFeedbackStats(personaId, delay * 2);
        }, delay);
      } else {
        if (err.code === 'permission-denied') {
          console.error(`AdvisorPanel: feedback stats permission denied for ${personaId} (not authenticated)`, err);
        } else {
          console.warn(`Failed to load feedback stats for ${personaId}:`, err);
        }
      }
    } finally {
      this._feedbackStatsLoading[personaId] = false;
    }
  },

  /**
   * Render feedback stats into the card's feedback stat row and detail panel.
   *
   * @param {string} personaId
   * @param {boolean} injectionEnabled
   */
  _renderFeedbackStats(personaId, injectionEnabled) {
    const card = this._cards[personaId];
    const stats = this._feedbackStats[personaId];
    if (!card || !stats) return;

    // Update toggle checkbox state (without triggering onChange)
    if (card.feedbackToggleCheckbox) {
      card.feedbackToggleCheckbox.checked = injectionEnabled;
    }
    if (card.feedbackToggleStatusEl) {
      card.feedbackToggleStatusEl.textContent = `Feedback injection: ${injectionEnabled ? 'on' : 'off'}`;
    }
    if (card.feedbackToggleRow) {
      card.feedbackToggleRow.classList.toggle('adv-feedback-injection-disabled', !injectionEnabled);
    }

    // Stat row summary: "8/11 accepted, last 30 days"
    const denominator = stats.accepted + stats.rejected;
    if (card.feedbackStatSummaryEl) {
      if (stats.total === 0) {
        card.feedbackStatSummaryEl.textContent = 'No decisions recorded yet';
      } else {
        card.feedbackStatSummaryEl.textContent =
          `${stats.accepted}/${denominator} accepted, last ${stats.windowDays} days`;
      }
    }

    // Detail panel
    if (card.feedbackDetailEl) {
      card.feedbackDetailEl.innerHTML = '';

      if (stats.belowThreshold) {
        // Below threshold — show progress toward activation
        const msg = el('p', { className: 'adv-feedback-threshold-msg' },
          `Feedback mode activates after ${stats.minThreshold} decisions (${stats.total} recorded so far).`
        );
        card.feedbackDetailEl.appendChild(msg);
      } else {
        // Show acceptance rate with text + bar (not color alone per spec)
        if (stats.acceptanceRate !== null) {
          const rateLabel = `${stats.acceptanceRate}% acceptance rate`;
          const rateBar = el('div', { className: 'adv-feedback-rate-bar', 'aria-hidden': 'true' });
          const rateFill = el('div', {
            className: 'adv-feedback-rate-fill',
            style: `width: ${stats.acceptanceRate}%`,
          });
          rateBar.appendChild(rateFill);
          card.feedbackDetailEl.appendChild(
            el('div', { className: 'adv-feedback-rate-row' },
              el('span', { className: 'adv-feedback-rate-label' }, rateLabel),
              rateBar,
            )
          );
        }

        // Window scope note
        card.feedbackDetailEl.appendChild(
          el('p', { className: 'adv-feedback-window-note' },
            `Based on last ${stats.windowDays} days or last ${stats.windowMax} decisions, whichever is smaller.`
          )
        );

        // Top rejected categories — framed as signal, not failure
        if (stats.topRejectedCategories.length > 0) {
          card.feedbackDetailEl.appendChild(
            el('p', { className: 'adv-feedback-categories-label' },
              'Proposals with low acceptance (reducing frequency):'
            )
          );
          const catList = el('ul', { className: 'adv-feedback-categories-list' });
          for (const cat of stats.topRejectedCategories) {
            catList.appendChild(
              el('li', { className: 'adv-feedback-category-item' },
                `${cat.label} (${cat.count} rejected)`
              )
            );
          }
          card.feedbackDetailEl.appendChild(catList);
        }

        // Snooze note
        if (stats.snoozed > 0) {
          card.feedbackDetailEl.appendChild(
            el('p', { className: 'adv-feedback-snooze-note' },
              `${stats.snoozed} snoozed (tracked separately, not counted in acceptance rate).`
            )
          );
        }
      }
    }
  },


  _renderLog(id, activityLog) {
    const card = this._cards[id];
    if (!card || !card.logList) return;

    const entries = Array.isArray(activityLog) ? activityLog : [];
    card.logList.innerHTML = '';

    if (entries.length === 0) {
      card.logList.appendChild(
        el('div', { className: 'adv-log-empty' }, 'No activity recorded yet.')
      );
      return;
    }

    for (const entry of entries) {
      const ts = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const line = el('div', { className: 'adv-log-entry' },
        ts ? el('span', { className: 'adv-log-ts' }, ts + ' ') : null,
        el('span', { className: 'adv-log-msg' }, entry.msg || ''),
      );
      card.logList.appendChild(line);
    }
  },



  // ── DK-105: Emphasis weights ────────────────────────────────────────────────

  /**
   * Populate the weights UI from the current focused project's stored weights.
   * Called when project focus changes and on initial load.
   * Falls back to all-1 defaults when no weights are stored.
   *
   * @param {string} personaId
   */
  _updateWeightsUI(personaId) {
    const concerns = PERSONA_CONCERNS[personaId];
    if (!concerns) return;
    const inputs = this._weightsInputs[personaId];
    if (!inputs) return;

    // Resolve weights from the focused project doc
    const projectId = this._filterProjectId;
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const storedWeights = project?.weights?.[personaId] ?? {};

    // Build a full map, filling missing keys with 1
    const fullWeights = Object.fromEntries(concerns.map(k => [k, storedWeights[k] ?? 1]));
    this._weightsDraft[personaId] = { ...fullWeights };

    // Update inputs
    for (const key of concerns) {
      const inp = inputs[key];
      if (inp && document.activeElement !== inp) {
        inp.value = String(fullWeights[key]);
      }
    }

    // Update level labels
    for (const key of concerns) {
      const inp = inputs[key];
      if (!inp) continue;
      const row = inp.closest('.adv-weight-row');
      if (!row) continue;
      const lbl = row.querySelector('.adv-weight-level-label');
      if (lbl) {
        const v = fullWeights[key];
        lbl.textContent = v >= 4 ? 'High' : v === 3 ? 'Medium' : 'Low';
      }
    }

    // Update summary
    const summaryEl = this._weightsSummaryEls[personaId];
    if (summaryEl) summaryEl.textContent = buildWeightSummary(fullWeights, personaId);
  },

  /**
   * Save per-project emphasis weights to Firestore.
   * Only writes when a project is focused — weights are per-project.
   * Validates that all values are integers 1–5 before writing.
   *
   * @param {string} personaId
   */
  async _saveWeights(personaId) {
    const concerns = PERSONA_CONCERNS[personaId];
    if (!concerns) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      const refs = this._weightsSaveEls[personaId];
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Select a project first';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-err';
        setTimeout(() => {
          if (refs.statusEl) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-weights-save-status';
          }
        }, 3000);
      }
      return;
    }

    if (this._weightsSaving[personaId]) return;
    this._weightsSaving[personaId] = true;

    const refs = this._weightsSaveEls[personaId];
    if (refs?.btn) refs.btn.disabled = true;
    if (refs?.statusEl) {
      refs.statusEl.textContent = 'Saving…';
      refs.statusEl.className = 'adv-weights-save-status';
    }

    // Build validated weights map — only allowlisted keys, integers 1–5
    const draft = this._weightsDraft[personaId] ?? {};
    const weights = {};
    let valid = true;
    for (const key of concerns) {
      const v = Number(draft[key]);
      if (!Number.isInteger(v) || v < 1 || v > 5) { valid = false; break; }
      weights[key] = v;
    }

    if (!valid) {
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Invalid values — use 1–5 only';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-err';
      }
      if (refs?.btn) refs.btn.disabled = false;
      this._weightsSaving[personaId] = false;
      return;
    }

    try {
      // Optimistic update — the project listener will sync back shortly
      await this.db.collection('projects').doc(projectId).update({
        [`weights.${personaId}`]: weights,
        updatedAt: new Date().toISOString(),
      });
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Saved';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-ok';
        setTimeout(() => {
          if (refs.statusEl) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-weights-save-status';
          }
        }, 2000);
      }
    } catch (err) {
      console.error(`AdvisorPanel: failed to save weights for ${personaId}:`, err);
      if (refs?.statusEl) {
        refs.statusEl.textContent = 'Error — could not save';
        refs.statusEl.className = 'adv-weights-save-status adv-weights-save-status-err';
        setTimeout(() => {
          if (refs.statusEl) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-weights-save-status';
          }
        }, 4000);
      }
      // Roll back draft to what was stored
      this._updateWeightsUI(personaId);
    } finally {
      if (refs?.btn) refs.btn.disabled = false;
      this._weightsSaving[personaId] = false;
    }
  },

  /**
   * Save the per-persona dedup sensitivity threshold to Firestore.
   * Only accepts integers in [1, 10] (Low=1, Medium=3, High=5).
   * Shows transient "Saved" confirmation via aria-live="polite".
   *
   * @param {string} id - Persona ID
   * @param {number} threshold - Integer in [1, 10]
   * @param {HTMLElement} [savedEl] - Element to show confirmation in (must have aria-live="polite")
   * @param {function} [onTimer] - Called with setTimeout id so caller can clear
   */
  async _saveDedupThreshold(id, threshold, savedEl, onTimer) {
    // Client-side validation — must be integer in [1, 10]
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) return;
    const projectId = this._filterProjectId;
    try {
      if (projectId) {
        // Write per-project dedup threshold to project advisor settings
        await this.db.collection('projects').doc(projectId).update({
          [`advisorSettings.${id}.dedupThreshold`]: threshold,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // No project focused — write to global persona doc (affects all projects)
        await this.db.collection('advisor').doc(id).set({ dedupThreshold: threshold }, { merge: true });
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
      console.error('Failed to save dedupThreshold:', err);
      if (savedEl) {
        savedEl.textContent = 'Error';
        savedEl.className = 'adv-interval-saved adv-interval-saved-err';
      }
    }
  }
};
