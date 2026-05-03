// Per-project persona toggles + project filter + EDP indicator + YOLO toggle.
// DK-118 enable/disable toggles, header E/D/P indicator strip, and the
// project-filter dropdown that scopes the rest of the panel.

import { el } from '../ui/el.js';
import { toDate } from '../ui/format.js';
import { PERSONAS } from '../config/personas.js';
import { PERSONA_CONCERNS } from '../config/concerns.js';

export const projectControlsMixin = {
  // ── DK-118: Per-project persona enable/disable toggles ──────────────────────

  /**
   * Build the persona enable/disable toggles panel.
   * Three toggle switches for Engineer, Design, and Product personas.
   * Collapsed by default. Visible only when a project is selected.
   * Stored at projects/{projectId}.advisor.personas.{engineer,design,product}.
   */
  _buildPersonaTogglesPanel() {
    const TOGGLE_PERSONAS = [
      {
        id: 'engineer',
        label: 'Engineer analysis',
        description: 'Reviews code for security vulnerabilities, inefficiencies, and open-source safety issues.',
      },
      {
        id: 'design',
        label: 'Design analysis',
        description: 'Audits the app UI for UX friction, accessibility, and visual polish issues.',
      },
      {
        id: 'product',
        label: 'Product analysis',
        description: 'Generates feature ideas grounded in project context and user needs.',
      },
    ];

    const panel = el('div', {
      className: 'adv-persona-toggles-panel',
      style: 'display:none', // hidden until a project is selected
    });

    // Panel header — collapsible toggle
    const panelChevron = el('span', { className: 'adv-persona-toggles-chevron', 'aria-hidden': 'true' }, '▸');
    const panelHeader = el('button', {
      className: 'adv-persona-toggles-header',
      'aria-expanded': 'false',
      'aria-controls': 'adv-persona-toggles-body',
      onClick: () => {
        const isExpanded = panelHeader.getAttribute('aria-expanded') === 'true';
        panelHeader.setAttribute('aria-expanded', String(!isExpanded));
        panelChevron.textContent = isExpanded ? '▸' : '▾';
        panelBody.classList.toggle('adv-hidden', isExpanded);
      },
    },
      panelChevron,
      el('span', { className: 'adv-persona-toggles-title' }, 'Advisor'),
    );
    panel.appendChild(panelHeader);

    const panelBody = el('div', {
      className: 'adv-persona-toggles-body adv-hidden',
      id: 'adv-persona-toggles-body',
    });
    panel.appendChild(panelBody);

    panelBody.appendChild(
      el('p', { className: 'adv-persona-toggles-intro' },
        'Enable or disable individual personas for this project. Changes take effect on the next advisor cycle.'
      )
    );

    // Use fieldset/legend for accessibility (per spec)
    const projectName = this._projects.find(p => p.id === this._filterProjectId)?.name
      || this._filterProjectId || 'this project';
    const fieldset = el('fieldset', { className: 'adv-persona-toggles-fieldset' });
    const legend = el('legend', { className: 'adv-persona-toggles-legend' }, `Advisor personas for ${projectName}`);
    this._personaTogglesLegend = legend;
    fieldset.appendChild(legend);

    for (const { id, label, description } of TOGGLE_PERSONAS) {
      const rowId = `adv-persona-toggle-${id}`;
      const statusId = `adv-persona-toggle-status-${id}`;
      const undoId = `adv-persona-toggle-undo-${id}`;

      // Toggle switch (checkbox styled as switch)
      const checkbox = el('input', {
        type: 'checkbox',
        className: 'adv-persona-toggle-input',
        id: rowId,
        checked: true, // default: enabled; updated by _renderPersonaTogglesPanel
        'aria-label': `Enable ${label} for ${projectName}`,
        'aria-describedby': statusId,
        onChange: () => this._onPersonaToggleChange(id, checkbox.checked, statusId, undoId),
      });

      const onOffText = el('span', { className: 'adv-persona-toggle-onoff', 'aria-hidden': 'true' }, 'On');
      this._personaTogglesOnOffEls[id] = onOffText;

      const toggleThumb = el('span', { className: 'adv-persona-toggle-thumb' });
      const toggleTrack = el('span', { className: 'adv-persona-toggle-track', 'aria-hidden': 'true' }, toggleThumb);

      // Label wraps both the track and the text so clicking either toggles the switch.
      // The hidden checkbox is the semantic control; label provides the click area.
      const labelEl = el('label', {
        className: 'adv-persona-toggle-label',
        htmlFor: rowId,
      },
        el('div', { className: 'adv-persona-toggle-switch-wrap' },
          checkbox,
          toggleTrack,
          onOffText,
        ),
        el('span', { className: 'adv-persona-toggle-label-text' },
          el('span', { className: 'adv-persona-toggle-name' }, label),
          el('span', { className: 'adv-persona-toggle-desc' }, description),
        )
      );

      // Status / confirmation text
      const statusEl = el('div', {
        className: 'adv-persona-toggle-status',
        id: statusId,
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      });

      // Undo affordance
      const undoEl = el('div', {
        className: 'adv-persona-toggle-undo adv-hidden',
        id: undoId,
      });

      const row = el('div', { className: 'adv-persona-toggle-row' }, labelEl);

      fieldset.appendChild(row);
      fieldset.appendChild(statusEl);
      fieldset.appendChild(undoEl);

      this._personaToggleEls[id] = { checkbox, statusEl, undoEl };
    }

    panelBody.appendChild(fieldset);

    this._personaTogglesPanel = panel;
    return panel;
  },

  /**
   * Render/update the persona toggles panel for the current project.
   * Called when project data changes or project filter changes.
   */
  _renderPersonaTogglesPanel() {
    if (!this._personaTogglesPanel) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      this._personaTogglesPanel.style.display = 'none';
      return;
    }

    this._personaTogglesPanel.style.display = '';

    const project = this._projects.find(p => p.id === projectId);
    const personas = project?.advisor?.personas || {};

    // Update legend with current project name
    if (this._personaTogglesLegend) {
      const projectName = project?.name || projectId;
      this._personaTogglesLegend.textContent = `Advisor personas for ${projectName}`;
    }

    for (const id of ['engineer', 'design', 'product']) {
      const refs = this._personaToggleEls[id];
      if (!refs) continue;

      // Absent key = enabled (defaults to true)
      const enabled = personas[id] !== false;
      refs.checkbox.checked = enabled;

      // Update on/off text
      if (this._personaTogglesOnOffEls?.[id]) {
        this._personaTogglesOnOffEls[id].textContent = enabled ? 'On' : 'Off';
        this._personaTogglesOnOffEls[id].classList.toggle('adv-persona-toggle-onoff-off', !enabled);
      }

      // Update aria-label with current project name
      const projectName = project?.name || projectId;
      const labels = {
        engineer: 'Engineer analysis',
        design: 'Design analysis',
        product: 'Product analysis',
      };
      refs.checkbox.setAttribute('aria-label', `Enable ${labels[id] || id} for ${projectName}`);

      // Show disabled timestamp if persona is off
      const disabledAt = personas[`${id}DisabledAt`];
      if (!enabled && disabledAt) {
        const d = toDate(disabledAt);
        if (d) {
          const monthDay = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          // Only show timestamp if no in-flight status message
          if (!this._personaToggleSaving[id] && refs.statusEl.textContent === '') {
            refs.statusEl.textContent = `Disabled ${monthDay}`;
            refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-disabled';
          }
        }
      } else if (!this._personaToggleSaving[id] && refs.statusEl.textContent.startsWith('Disabled ')) {
        refs.statusEl.textContent = '';
        refs.statusEl.className = 'adv-persona-toggle-status';
      }
    }

    // Update the EDP indicator in the project list (project tab dropdown)
    this._renderEdpIndicator();
  },

  /**
   * Handle a persona toggle change.
   * Debounces 500ms before writing to Firestore.
   * On success: shows inline confirmation + 5-second undo affordance.
   * On failure: snaps toggle back to previous state.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   * @param {boolean} newEnabled - the new desired state
   * @param {string} statusId - ID of the status element
   * @param {string} undoId - ID of the undo element
   */
  _onPersonaToggleChange(personaId, newEnabled, statusId, undoId) {
    const projectId = this._filterProjectId;
    if (!projectId) return;

    const refs = this._personaToggleEls[personaId];
    if (!refs) return;

    // Update on/off text immediately (optimistic UI)
    if (this._personaTogglesOnOffEls?.[personaId]) {
      this._personaTogglesOnOffEls[personaId].textContent = newEnabled ? 'On' : 'Off';
      this._personaTogglesOnOffEls[personaId].classList.toggle('adv-persona-toggle-onoff-off', !newEnabled);
    }

    // Clear any existing debounce timer
    if (this._personaToggleDebounce[personaId]) {
      clearTimeout(this._personaToggleDebounce[personaId]);
      this._personaToggleDebounce[personaId] = null;
    }

    // Clear previous undo affordance
    refs.undoEl.classList.add('adv-hidden');
    refs.undoEl.innerHTML = '';

    // Show "Saving…" status
    refs.statusEl.textContent = 'Saving…';
    refs.statusEl.className = 'adv-persona-toggle-status';

    const previousEnabled = !newEnabled; // what it was before the change

    this._personaToggleDebounce[personaId] = setTimeout(async () => {
      this._personaToggleDebounce[personaId] = null;
      this._personaToggleSaving[personaId] = true;

      // Check if the persona is currently running (show "running now" notice)
      const personaState = this._states[personaId];
      const isRunning = personaState?.status === 'running';
      if (isRunning && !newEnabled) {
        refs.statusEl.textContent = `${personaId.charAt(0).toUpperCase() + personaId.slice(1)} running now — will disable after this run`;
        refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-info';
        refs.statusEl.setAttribute('aria-live', 'assertive');
      }

      try {
        const labels = {
          engineer: 'Engineer analysis',
          design: 'Design analysis',
          product: 'Product analysis',
        };
        const personaLabel = labels[personaId] || personaId;

        // Build the update
        const update = {
          [`advisor.personas.${personaId}`]: newEnabled,
          updatedAt: new Date().toISOString(),
        };

        // When disabling, also write disabledAt timestamp
        if (!newEnabled) {
          update[`advisor.personas.${personaId}DisabledAt`] = new Date().toISOString();
        } else {
          // When re-enabling, delete the disabledAt field by setting to null
          // (Firestore client SDK: use FieldValue.delete() — but we don't have it here;
          // set to null and handle null in the render logic)
          update[`advisor.personas.${personaId}DisabledAt`] = null;
        }

        await this.db.collection('projects').doc(projectId).update(update);

        this._personaToggleSaving[personaId] = false;

        // Show confirmation message
        const action = newEnabled ? 'enabled' : 'disabled';
        const effectMsg = newEnabled
          ? `${personaLabel} enabled — takes effect next cycle`
          : `${personaLabel} disabled — takes effect next cycle`;

        if (isRunning && !newEnabled) {
          refs.statusEl.textContent = `${personaId.charAt(0).toUpperCase() + personaId.slice(1)} running now — will disable after this run`;
          refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-info';
        } else {
          refs.statusEl.textContent = effectMsg;
          refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-ok';
          refs.statusEl.setAttribute('aria-live', 'polite');
        }

        // Announce to screen readers
        this._announceToSR(effectMsg);

        // Show 5-second undo affordance
        const undoBtn = el('button', {
          className: 'adv-persona-toggle-undo-btn',
          type: 'button',
          onClick: () => {
            // Revert: toggle back to the previous state
            refs.checkbox.checked = previousEnabled;
            if (this._personaTogglesOnOffEls?.[personaId]) {
              this._personaTogglesOnOffEls[personaId].textContent = previousEnabled ? 'On' : 'Off';
              this._personaTogglesOnOffEls[personaId].classList.toggle('adv-persona-toggle-onoff-off', !previousEnabled);
            }
            refs.undoEl.classList.add('adv-hidden');
            clearTimeout(refs._undoTimer);
            this._onPersonaToggleChange(personaId, previousEnabled, statusId, undoId);
          },
        }, 'Undo');

        refs.undoEl.innerHTML = '';
        refs.undoEl.appendChild(undoBtn);
        refs.undoEl.classList.remove('adv-hidden');

        // Auto-dismiss after 5 seconds
        if (refs._undoTimer) clearTimeout(refs._undoTimer);
        refs._undoTimer = setTimeout(() => {
          refs.undoEl.classList.add('adv-hidden');
          // Also clear the confirmation message after 5 seconds (unless it's the running-now message)
          if (!refs.statusEl.classList.contains('adv-persona-toggle-status-info')) {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-persona-toggle-status';
          }
        }, 5000);

      } catch (err) {
        console.error(`AdvisorPanel: failed to toggle ${personaId} for ${projectId}:`, err);
        this._personaToggleSaving[personaId] = false;

        // Snap back to previous state on failure
        refs.checkbox.checked = previousEnabled;
        if (this._personaTogglesOnOffEls?.[personaId]) {
          this._personaTogglesOnOffEls[personaId].textContent = previousEnabled ? 'On' : 'Off';
          this._personaTogglesOnOffEls[personaId].classList.toggle('adv-persona-toggle-onoff-off', !previousEnabled);
        }

        refs.statusEl.textContent = 'Error — could not save. Try again.';
        refs.statusEl.className = 'adv-persona-toggle-status adv-persona-toggle-status-err';
        refs.statusEl.setAttribute('aria-live', 'assertive');

        // Clear error after 4 seconds
        setTimeout(() => {
          if (refs.statusEl.textContent === 'Error — could not save. Try again.') {
            refs.statusEl.textContent = '';
            refs.statusEl.className = 'adv-persona-toggle-status';
          }
        }, 4000);
      }
    }, 500);
  },

  /**
   * Update the E/D/P indicator in the advisor panel header.
   * Active personas render at full opacity; inactive ones are muted (strikethrough).
   * Called whenever persona toggle state changes or project filter changes.
   */
  _renderEdpIndicator() {
    if (!this._edpIndicatorEl) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      this._edpIndicatorEl.style.display = 'none';
      return;
    }

    const project = this._projects.find(p => p.id === projectId);
    if (!project) {
      this._edpIndicatorEl.style.display = 'none';
      return;
    }

    this._edpIndicatorEl.style.display = '';
    this._edpIndicatorEl.innerHTML = '';

    const personas = project?.advisor?.personas || {};
    const parts = [
      { letter: 'E', enabled: personas.engineer !== false, title: 'Engineer analysis' },
      { letter: 'D', enabled: personas.design !== false,   title: 'Design analysis' },
      { letter: 'P', enabled: personas.product !== false,  title: 'Product analysis' },
    ];

    for (const { letter, enabled, title } of parts) {
      const span = el('span', {
        className: 'adv-edp-letter' + (enabled ? '' : ' adv-edp-letter-off'),
        title: `${title}: ${enabled ? 'enabled' : 'disabled'}`,
        'aria-label': `${title}: ${enabled ? 'on' : 'off'}`,
      }, letter);
      this._edpIndicatorEl.appendChild(span);
    }
  },

  _renderProjects() {
    // Update the context panel with fresh project data
    this._renderContextPanel();
    this._renderYoloToggle();
    this._renderPersonaInstructionsPanel();
    // DK-118: Update persona enable/disable toggles when project data changes
    this._renderPersonaTogglesPanel();
    // DK-194: Update consensus gate panel (enabled persona count may have changed)
    this._renderConsensusGatePanel();
    // DK-128: Update exclusion tag lists when project data changes
    for (const personaId of ['engineer', 'design']) {
      this._renderExclusionTags(personaId);
      this._loadExclusionSkipCount(personaId);
    }
    // DK-101: Update focus areas UI for all three personas
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderFocusAreas(personaId);
    }
    // DK-187: Focus constraints UI reads from /advisor/{personaId}.focus (persona-level, not project)
    // No need to re-render on project change — handled by _subscribePersona listener.

    // DK-302: Update priorities preview and dismissible banner when project data changes
    const project = this._projects.find(p => p.id === this._filterProjectId);
    const priorities = project?.priorities || '';
    for (const personaId of ['engineer', 'design', 'product', 'qa']) {
      this._updatePrioritiesPreview(personaId, priorities);
    }
    // Show banner if priorities is empty AND at least one persona has run recently
    const hasPriorities = !!(priorities.trim());
    const anyPersonaRan = PERSONAS.some(({ id }) => this._states[id]?.lastRunAt);
    this._updatePrioritiesBanner(!hasPriorities && anyPersonaRan);

    // DK-134: Update scoped focus UI (chip arrays per project) for all three personas
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderScopedFocus(personaId);
    }
    // DK-134: Update scope summary bar after all persona scopes are rendered
    this._updateScopeSummaryBar();
    // DK-112: Update topic exclusion rule tags when project data changes
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderTopicExclusions(personaId);
    }
    // DK-124: Update advisor pins chip lists when project data changes
    for (const personaId of ['engineer', 'design']) {
      this._renderPins(personaId);
    }
  },

  /** Render/update the YOLO toggle button for the current project. */
  _renderYoloToggle() {
    if (!this._yoloBtn) return;
    const projectId = this._filterProjectId;
    if (!projectId) {
      this._yoloBtn.style.display = 'none';
      return;
    }
    this._yoloBtn.style.display = '';
    const project = this._projects.find(p => p.id === projectId);
    const isOn = !!(project?.yoloMode);
    this._yoloBtn.textContent = isOn ? 'Auto-Accept: ON' : 'Auto-Accept';
    this._yoloBtn.classList.toggle('adv-yolo-on', isOn);
    this._yoloBtn.title = isOn
      ? 'Auto-Accept is ON — new advisor tickets go directly to the backlog without review. Click to turn off.'
      : 'Auto-Accept is OFF — new advisor tickets require review before entering the backlog. Click to turn on.';
  },

  /** Toggle YOLO mode on/off for the current project. */
  async _toggleYoloMode() {
    const projectId = this._filterProjectId;
    if (!projectId || !this._yoloBtn) return;
    const project = this._projects.find(p => p.id === projectId);
    const newMode = !(project?.yoloMode);
    this._yoloBtn.disabled = true;
    try {
      await this.db.collection('projects').doc(projectId).update({
        yoloMode: newMode,
        updatedAt: new Date().toISOString(),
      });
      // onSnapshot on _projects will fire and call _renderYoloToggle automatically

      // When enabling YOLO mode, bulk-accept all existing proposed tickets
      if (newMode) {
        await this._acceptAllProposedTickets(projectId);
      }
    } catch (err) {
      console.error('AdvisorPanel: failed to toggle YOLO mode', err);
    } finally {
      if (this._yoloBtn) this._yoloBtn.disabled = false;
    }
  },

  /** Bulk-transition all proposed tickets in the given project to open. */
  async _acceptAllProposedTickets(projectId) {
    const snap = await this.db
      .collection('projects')
      .doc(projectId)
      .collection('tickets')
      .where('status', '==', 'proposed')
      .get();

    if (snap.empty) return;

    const now = new Date().toISOString();
    // Firestore batches are limited to 500 operations; chunk if needed
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 500) {
      const batch = this.db.batch();
      const chunk = docs.slice(i, i + 500);
      for (const doc of chunk) {
        const data = doc.data();
        const history = data.statusHistory || [];
        history.push({ from: 'proposed', to: 'open', at: now, note: 'Accepted via YOLO mode' });
        batch.update(doc.ref, { status: 'open', statusHistory: history, updatedAt: now });
      }
      await batch.commit();
    }
  },

  // ── Project filter ────────────────────────────────────────────

  /**
   * Set which project to show in the EPD pane.
   * @param {string|null} projectId - null or 'all' means show all projects;
   *   a project ID string means show only that project.
   */
  setProjectFilter(projectId) {
    const newFilter = (projectId === 'all' || projectId == null) ? null : projectId;
    if (this._filterProjectId === newFilter) return;
    this._filterProjectId = newFilter;
    // Clear persona instructions state when project changes
    this._personaInstrDirty = {};
    this._personaInstrLastFetched = {};
    this._personaInstrUseGlobal = {};         // reset scope mode; will re-default on render
    this._personaInstrTabsInitialized = false; // reset tab init flag
    // DK-118: Clear persona toggle debounce timers and status when project changes
    for (const id of Object.keys(this._personaToggleDebounce)) {
      if (this._personaToggleDebounce[id]) {
        clearTimeout(this._personaToggleDebounce[id]);
        this._personaToggleDebounce[id] = null;
      }
    }
    for (const id of Object.keys(this._personaToggleEls)) {
      const refs = this._personaToggleEls[id];
      if (refs) {
        if (refs._undoTimer) clearTimeout(refs._undoTimer);
        refs.undoEl?.classList.add('adv-hidden');
        if (refs.statusEl) {
          refs.statusEl.textContent = '';
          refs.statusEl.className = 'adv-persona-toggle-status';
        }
      }
    }
    // Reset context preset state when project changes
    this._lastAppliedPresetId = null;
    this._contextDirty = false;
    // Reset per-session hint state (DK-120)
    this._contextFocused = false;
    this._contextModifiedThisSession = false;
    // Subscribe to the new project's presets (will be done in _renderContextPanel too,
    // but triggering here ensures it starts promptly on project switch)
    this._subscribePresets(newFilter);
    this._renderProjects(); // also updates context panel via _renderContextPanel()
    // DK-105: Refresh emphasis weights UI to show the new project's stored weights
    for (const key of Object.keys(PERSONA_CONCERNS)) {
      this._updateWeightsUI(key);
    }
    // DK-101: Refresh focus areas UI when project filter changes
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderFocusAreas(personaId);
    }
    // DK-124: Refresh advisor pins UI when project filter changes
    for (const personaId of ['engineer', 'design']) {
      this._renderPins(personaId);
    }
    // DK-134: Refresh scoped focus UI and scope summary bar when project filter changes
    for (const personaId of ['engineer', 'design', 'product']) {
      this._renderScopedFocus(personaId);
    }
    this._updateScopeSummaryBar();
    // DK-319: Re-subscribe to directive for each built-in persona under the new project
    for (const persona of PERSONAS) {
      this._subscribeDirective(persona.id, newFilter);
    }
    // Reload feedback stats for all built-in personas when project filter changes
    for (const persona of PERSONAS) {
      this._feedbackStats[persona.id] = null; // invalidate cache
      this._loadFeedbackStats(persona.id);
    }
    // Reload history for all personas so that the run summary line and history
    // panel always reflect only runs for the newly selected project.
    // We reload unconditionally (not just for personas that had history opened)
    // because the run summary line in each card uses history data — if history
    // was never loaded for a persona, the summary would fall back to the global
    // _states[id].lastRunAt which spans all projects, showing cross-project data.
    const allPersonaIds = [
      ...PERSONAS.map(p => p.id),
      ...this._customPersonas.map(p => p.id || p._docId).filter(Boolean),
    ];
    for (const id of allPersonaIds) {
      // Re-query with the new project filter. _loadHistoryRuns immediately sets
      // _historyRuns[id] = null (loading state) before the async query fires,
      // then calls _renderCard once results arrive. We also call _renderCard
      // immediately after so the run summary clears stale cross-project data
      // while the new query is in flight.
      this._loadHistoryRuns(id);
      this._renderCard(id);
    }
  }
};
