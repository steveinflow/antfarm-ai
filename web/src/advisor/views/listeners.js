// Firestore listener wiring + consensus-gate panel.
// onSnapshot subscribers for /advisor/{personaId}, /projects, /advisor/_consensusGate
// and /advisorPersonas, with permission-denied retry logic.

import { el } from '../ui/el.js';
import { PERSONAS } from '../config/personas.js';
import { PERSONA_CONCERNS } from '../config/concerns.js';

export const listenersMixin = {
  // ── Firestore listeners ──────────────────────────────────────

  _startListeners() {
    // Built-in persona state listeners
    for (const { id } of PERSONAS) {
      this._subscribePersona(id);
    }

    // Custom persona definitions listener
    this._subscribeCustomPersonas();

    // Projects listener
    this._subscribeProjects();

    // DK-194: Consensus gate Firestore listener (/advisor/consensusGate)
    this._subscribeConsensusGate();

    // Feedback stats — load once at mount (deferred slightly so project list loads first)
    setTimeout(() => {
      if (this._mounted) {
        for (const { id } of PERSONAS) {
          this._loadFeedbackStats(id);
        }
      }
    }, 2000);

    // Persona config templates — subscribe when auth user is available (DK-141)
    this._subscribeTemplates();

    // DK-188: Subscribe to global confidence threshold config
    this._subscribeConfidenceConfig();
  },

  // Returns true when a permission-denied error should be treated as a transient
  // auth race rather than a genuine permissions problem.
  //
  // Firestore can fire permission-denied before the Firebase ID token has fully
  // propagated to the Firestore client — even after getIdToken() has been called.
  // As long as the user is still authenticated, the listener retry will self-heal,
  // so we log these as console.warn (not console.error) to keep the console clean.
  //
  // We only escalate to console.error when the user is NOT signed in (a genuine
  // auth problem that the retry loop cannot fix by itself).
  _isPermissionDeniedTransient(err) {
    if (err.code !== 'permission-denied') return false;
    try {
      return !!this.db.app.auth().currentUser;
    } catch (_) {
      // If we can't access auth state, fall back to treating it as transient
      // (the retry loop will keep trying; a real error will surface eventually).
      return true;
    }
  },

  // Subscribe (or re-subscribe) to a single persona's Firestore document.
  // On error the listener is dead, so we retry after a backoff delay so the
  // panel resumes updating once permissions are restored (e.g. after rule deploy).
  _subscribePersona(id, retryDelayMs = 5000) {
    const ref = this.db.collection('advisor').doc(id);
    const unsub = ref.onSnapshot(
      (snap) => {
        this._statesReceived[id] = true;
        this._states[id] = snap.exists ? snap.data() : null;
        this._renderCard(id);
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn(`AdvisorPanel: listener error for ${id} (transient, retrying)`, err);
        } else {
          console.error(`AdvisorPanel: listener error for ${id}`, err);
        }
        // Do not clear state on error — preserve last known state so the panel
        // continues to show the correct status instead of incorrectly showing "Offline".
        // Only set to null (and show Offline) if we have never received any data.
        if (!this._statesReceived[id]) {
          this._states[id] = null;
          this._renderCard(id);
        }
        // Firestore terminates the listener on error. Schedule a retry so the
        // panel automatically recovers once permissions are in place.
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000); // cap at 60s
          setTimeout(() => {
            if (this._mounted) this._subscribePersona(id, delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(unsub);
  },

  // Subscribe (or re-subscribe) to the projects collection.
  _subscribeProjects(retryDelayMs = 5000) {
    const projectsUnsub = this.db.collection('projects').onSnapshot(
      (snap) => {
        this._projects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._projects.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        this._renderProjects();
        // Re-render all persona cards when project data changes: advisor settings
        // (pause, interval, ticketCap, savedFocusPrompt) are now stored per-project
        // in the project doc, so card display must update when project data changes.
        if (this._filterProjectId) {
          for (const { id } of PERSONAS) {
            this._renderCard(id);
          }
          // DK-105: Refresh emphasis weights UI to reflect the latest stored weights
          for (const key of Object.keys(PERSONA_CONCERNS)) {
            this._updateWeightsUI(key);
          }
        }
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn('AdvisorPanel: projects listener error (transient, retrying)', err);
        } else {
          console.error('AdvisorPanel: projects listener error', err);
        }
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000);
          setTimeout(() => {
            if (this._mounted) this._subscribeProjects(delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(projectsUnsub);
  },

  // DK-194: Subscribe to /advisor/consensusGate Firestore document.
  // Mirrors the pause toggle pattern. Writes from the UI go here; the daemon reads this.
  _subscribeConsensusGate(retryDelayMs = 5000) {
    const ref = this.db.collection('advisor').doc('consensusGate');
    const unsub = ref.onSnapshot(
      (snap) => {
        this._consensusGate = snap.exists ? snap.data() : null;
        this._renderConsensusGatePanel();
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn('AdvisorPanel: consensusGate listener error (transient, retrying)', err);
        } else {
          console.error('AdvisorPanel: consensusGate listener error', err);
        }
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000);
          setTimeout(() => {
            if (this._mounted) this._subscribeConsensusGate(delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(unsub);
  },

  /** Build the cross-review consensus gate panel (DK-194). */
  _buildConsensusGatePanel() {
    const panel = el('div', {
      className: 'adv-consensus-gate-panel',
    });

    // Panel header — collapsible toggle (matches persona toggles panel pattern)
    const panelChevron = el('span', { className: 'adv-consensus-gate-chevron', 'aria-hidden': 'true' }, '▸');
    const panelHeader = el('button', {
      className: 'adv-persona-toggles-header', // reuse style
      'aria-expanded': 'false',
      'aria-controls': 'adv-consensus-gate-body',
      onClick: () => {
        const isExpanded = panelHeader.getAttribute('aria-expanded') === 'true';
        panelHeader.setAttribute('aria-expanded', String(!isExpanded));
        panelChevron.textContent = isExpanded ? '▸' : '▾';
        panelBody.classList.toggle('adv-hidden', isExpanded);
      },
    },
      panelChevron,
      el('span', { className: 'adv-persona-toggles-title' }, 'Cross-review gate'),
    );
    panel.appendChild(panelHeader);

    const panelBody = el('div', {
      className: 'adv-persona-toggles-body adv-hidden',
      id: 'adv-consensus-gate-body',
    });
    panel.appendChild(panelBody);

    panelBody.appendChild(
      el('p', { className: 'adv-persona-toggles-intro' },
        'Require cross-review before tickets are created. When enabled, a ticket proposed by one advisor must be endorsed by other personas before it moves to the backlog.'
      )
    );

    // Toggle row
    const toggleId = 'adv-consensus-gate-toggle';
    const toggle = el('input', {
      type: 'checkbox',
      id: toggleId,
      className: 'adv-persona-toggle-input',
      'aria-label': 'Require cross-review before tickets are created',
      'aria-describedby': 'adv-consensus-gate-status',
      onChange: () => this._onConsensusGateToggle(toggle.checked),
    });
    this._consensusGateToggle = toggle;

    const toggleThumb = el('span', { className: 'adv-persona-toggle-thumb' });
    const toggleTrack = el('span', { className: 'adv-persona-toggle-track', 'aria-hidden': 'true' }, toggleThumb);
    const toggleLabel = el('label', {
      className: 'adv-persona-toggle-label',
      htmlFor: toggleId,
    },
      el('div', { className: 'adv-persona-toggle-switch-wrap' }, toggle, toggleTrack),
      el('span', { className: 'adv-persona-toggle-label-text' },
        el('span', { className: 'adv-persona-toggle-name' }, 'Require cross-review before tickets are created'),
      )
    );

    panelBody.appendChild(el('div', { className: 'adv-persona-toggle-row' }, toggleLabel));

    // Threshold row
    const thresholdId = 'adv-consensus-gate-threshold';
    const thresholdInput = el('input', {
      type: 'number',
      id: thresholdId,
      min: '2',
      max: '3',
      value: '2',
      className: 'adv-consensus-gate-threshold-input',
      'aria-label': 'Number of personas that must agree',
      'aria-describedby': 'adv-consensus-gate-threshold-desc adv-consensus-gate-status',
      onChange: () => this._onConsensusGateThresholdChange(thresholdInput.value),
      onInput: () => this._validateConsensusGateThreshold(thresholdInput.value),
    });
    this._consensusGateThreshold = thresholdInput;

    const thresholdDesc = el('span', {
      id: 'adv-consensus-gate-threshold-desc',
      className: 'adv-consensus-gate-threshold-desc',
    }, 'of 3 personas must agree');
    this._consensusGateThresholdDesc = thresholdDesc;

    panelBody.appendChild(
      el('div', { className: 'adv-consensus-gate-threshold-row' },
        el('label', { htmlFor: thresholdId, className: 'adv-consensus-gate-threshold-label' },
          'Threshold: '
        ),
        thresholdInput,
        thresholdDesc,
      )
    );

    // Status / validation message
    const statusEl = el('div', {
      id: 'adv-consensus-gate-status',
      className: 'adv-consensus-gate-status',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    this._consensusGateStatus = statusEl;
    panelBody.appendChild(statusEl);

    this._consensusGatePanel = panel;
    return panel;
  },

  /** Render/update the consensus gate panel from Firestore data. */
  _renderConsensusGatePanel() {
    if (!this._consensusGateToggle || !this._consensusGateThreshold) return;

    const data = this._consensusGate || {};
    const enabled = !!data.enabled;
    const threshold = typeof data.threshold === 'number' ? data.threshold : 2;

    this._consensusGateToggle.checked = enabled;
    this._consensusGateThreshold.value = String(threshold);
    this._consensusGateThreshold.disabled = !enabled;

    // Update threshold descriptor: "of N personas must agree"
    const enabledCount = this._getEnabledPersonaCount();
    if (this._consensusGateThresholdDesc) {
      this._consensusGateThresholdDesc.textContent = `of ${enabledCount} persona${enabledCount !== 1 ? 's' : ''} must agree`;
      this._consensusGateThreshold.max = String(enabledCount);
    }

    // Clear status if no errors
    if (this._consensusGateStatus) {
      this._consensusGateStatus.textContent = '';
      this._consensusGateStatus.className = 'adv-consensus-gate-status';
    }

    // Show contextual note when first enabled
    if (enabled && this._consensusGateStatus && !this._consensusGateStatus.textContent) {
      this._consensusGateStatus.textContent =
        'Cross-review is active. Pending tickets may take time to accumulate endorsements depending on persona intervals.';
      this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-note';
    }
  },

  /** Return the count of currently enabled (non-disabled) built-in personas. */
  _getEnabledPersonaCount() {
    // Count personas that are not explicitly disabled for the current project.
    // Absent keys = enabled (default). Uses the same logic as _renderPersonaTogglesPanel.
    const project = this._projects.find(p => p.id === this._filterProjectId);
    const personas = project?.advisor?.personas || {};
    let count = 0;
    for (const id of ['engineer', 'design', 'product']) {
      if (personas[id] !== false) count++;
    }
    // Fall back to total built-in count if no project selected
    return count > 0 ? count : 3;
  },

  /** Validate consensus gate threshold and show inline error if needed. */
  _validateConsensusGateThreshold(rawValue) {
    if (!this._consensusGateStatus) return true;
    const val = parseInt(rawValue, 10);
    const enabledCount = this._getEnabledPersonaCount();
    if (!Number.isInteger(val) || val < 2) {
      this._consensusGateStatus.textContent = 'Threshold must be at least 2.';
      this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-error';
      return false;
    }
    if (val > enabledCount) {
      this._consensusGateStatus.textContent = `Only ${enabledCount} persona${enabledCount !== 1 ? 's' : ''} are enabled — threshold cannot be ${val}.`;
      this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-error';
      return false;
    }
    this._consensusGateStatus.textContent = '';
    this._consensusGateStatus.className = 'adv-consensus-gate-status';
    return true;
  },

  /** Handle consensus gate toggle change. */
  async _onConsensusGateToggle(enabled) {
    if (this._consensusGateSaving) return;
    this._consensusGateSaving = true;
    if (this._consensusGateToggle) this._consensusGateToggle.disabled = true;
    try {
      const threshold = parseInt(this._consensusGateThreshold?.value || '2', 10);
      const safeThreshold = Number.isInteger(threshold) && threshold >= 2 ? threshold : 2;
      if (enabled && !this._validateConsensusGateThreshold(String(safeThreshold))) {
        // Validation failed — revert toggle
        if (this._consensusGateToggle) this._consensusGateToggle.checked = false;
        return;
      }
      await this.db.collection('advisor').doc('consensusGate').set({
        enabled,
        threshold: safeThreshold,
        maxProposedTickets: this._consensusGate?.maxProposedTickets ?? 5,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      // onSnapshot will fire and update the UI
    } catch (err) {
      console.error('AdvisorPanel: failed to update consensus gate', err);
      if (this._consensusGateStatus) {
        this._consensusGateStatus.textContent = 'Failed to save — please try again.';
        this._consensusGateStatus.className = 'adv-consensus-gate-status adv-consensus-gate-error';
      }
    } finally {
      this._consensusGateSaving = false;
      if (this._consensusGateToggle) this._consensusGateToggle.disabled = false;
    }
  },

  /** Handle consensus gate threshold change. */
  async _onConsensusGateThresholdChange(rawValue) {
    if (!this._validateConsensusGateThreshold(rawValue)) return;
    if (this._consensusGateSaving) return;
    const val = parseInt(rawValue, 10);
    const enabled = !!this._consensusGate?.enabled;
    if (!enabled) return; // only save when gate is on
    this._consensusGateSaving = true;
    try {
      await this.db.collection('advisor').doc('consensusGate').set({
        threshold: val,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (err) {
      console.error('AdvisorPanel: failed to update consensus gate threshold', err);
    } finally {
      this._consensusGateSaving = false;
    }
  },

  // Subscribe to /advisorPersonas collection (custom persona definitions).
  // When a custom persona is added/removed, also subscribe/unsubscribe
  // to its /advisor/{id} state document for live status.
  _subscribeCustomPersonas(retryDelayMs = 5000) {
    const unsub = this.db.collection('advisorPersonas').onSnapshot(
      (snap) => {
        const personas = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
        personas.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

        // Subscribe to state for any new custom personas
        const currentIds = new Set(this._customPersonas.map(p => p.id));
        for (const p of personas) {
          const pid = p.id || p._docId;
          if (!currentIds.has(pid) && !this._cards[pid]) {
            this._subscribePersona(pid);
          }
        }

        this._customPersonas = personas;
        this._renderCustomPersonas();
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn('AdvisorPanel: custom personas listener error (transient, retrying)', err);
        } else {
          console.error('AdvisorPanel: custom personas listener error', err);
        }
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000);
          setTimeout(() => {
            if (this._mounted) this._subscribeCustomPersonas(delay * 2);
          }, delay);
        }
      }
    );
    this._unsubs.push(unsub);
  }
};
