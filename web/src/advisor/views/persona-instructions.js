// Persona instructions panel — DK-133 tabbed editor.
// Per-persona custom-instructions textarea with global-vs-project scope
// toggle. Also hosts the broader context-panel toggle/render which
// shows or hides the entire context section depending on project state.

import { el } from '../ui/el.js';

export const personaInstructionsMixin = {
  // ── Persona instructions panel ────────────────────────────────────────

  /**
   * Build the persona instructions panel — three collapsible per-persona sections
   * (Engineer, Design, Product), collapsed by default. Visible only when a project
   * is selected. Reads/writes project.personaInstructions.{engineer,design,product}.
   */
  _buildPersonaInstructionsPanel() {
    // DK-133: Per-persona custom instruction editor — tabbed UI with explicit Save,
    // dirty state, global vs per-project toggle, and aria-live save confirmation.
    const INSTR_PERSONAS = [
      {
        id: 'engineer',
        label: 'Engineer',
        description: 'Reviews code for security vulnerabilities, inefficiencies, and open-source safety issues.',
        placeholder: 'e.g. Focus on security issues in the auth module only',
        globalPlaceholder: 'No global instructions set for Engineer.',
      },
      {
        id: 'design',
        label: 'Design',
        description: 'Audits the app UI for UX friction, accessibility, and visual polish issues.',
        placeholder: 'e.g. Prioritize mobile viewports, we have no desktop users',
        globalPlaceholder: 'No global instructions set for Design.',
      },
      {
        id: 'product',
        label: 'Product',
        description: 'Generates feature ideas grounded in project context and user needs.',
        placeholder: 'e.g. We are pre-revenue — ignore monetization feature ideas',
        globalPlaceholder: 'No global instructions set for Product.',
      },
    ];
    const MAX_CHARS = 4000;
    const WARN_THRESHOLD = 0.8;

    const panel = el('div', {
      className: 'adv-instr-panel',
      style: 'display:none', // hidden until a project is selected
    });

    // Panel header — collapsible toggle for the whole section
    const panelChevron = el('span', { className: 'adv-instr-panel-chevron', 'aria-hidden': 'true' }, '▸');
    const panelHeader = el('button', {
      className: 'adv-instr-panel-header',
      'aria-expanded': 'false',
      'aria-controls': 'adv-instr-panel-body',
      id: 'adv-instr-toggle',
      onClick: () => {
        const isExpanded = panelHeader.getAttribute('aria-expanded') === 'true';
        panelHeader.setAttribute('aria-expanded', String(!isExpanded));
        panelChevron.textContent = isExpanded ? '▸' : '▾';
        panelBody.classList.toggle('adv-hidden', isExpanded);
      },
    },
      panelChevron,
      el('span', { className: 'adv-instr-panel-title' }, 'Persona Instructions'),
    );
    panel.appendChild(panelHeader);

    const panelBody = el('div', {
      className: 'adv-instr-panel-body adv-hidden',
      id: 'adv-instr-panel-body',
    });
    panel.appendChild(panelBody);

    // aria-live region for save confirmations — polite so it doesn't interrupt reading
    const liveRegion = el('div', {
      'aria-live': 'polite',
      'aria-atomic': 'true',
      className: 'adv-instr-live-region',
    });
    panelBody.appendChild(liveRegion);
    this._personaInstrLiveRegion = liveRegion;

    // Scope label — tells user whether they are editing global defaults or a project override
    const scopeLabel = el('div', { className: 'adv-instr-scope-label' }, 'Editing: Global defaults');
    this._personaInstrScopeLabel = scopeLabel;
    panelBody.appendChild(scopeLabel);

    // ── Tab list ────────────────────────────────────────────────────────────
    const tabList = el('div', {
      className: 'adv-instr-tablist',
      role: 'tablist',
      'aria-label': 'Persona',
    });
    panelBody.appendChild(tabList);

    // ── Tab panels container ─────────────────────────────────────────────────
    const tabPanelsContainer = el('div', { className: 'adv-instr-tab-panels' });
    panelBody.appendChild(tabPanelsContainer);

    // Build one tab button + one panel per persona
    const tabEls = {};
    const panelEls = {};

    for (const { id, label, description, placeholder, globalPlaceholder } of INSTR_PERSONAS) {
      // ── Tab button ──────────────────────────────────────────────────────
      const tabId = `adv-instr-tab-${id}`;
      const panelId = `adv-instr-tabpanel-${id}`;

      const tabBtn = el('button', {
        className: 'adv-instr-tab',
        role: 'tab',
        'aria-selected': 'false',
        'aria-controls': panelId,
        id: tabId,
        type: 'button',
        onClick: () => this._switchPersonaInstrTab(id),
        onKeyDown: (e) => {
          // Arrow key navigation within tablist (ARIA pattern)
          const ids = INSTR_PERSONAS.map(p => p.id);
          const idx = ids.indexOf(id);
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[(idx + 1) % ids.length]);
            tabEls[ids[(idx + 1) % ids.length]]?.focus();
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[(idx - 1 + ids.length) % ids.length]);
            tabEls[ids[(idx - 1 + ids.length) % ids.length]]?.focus();
          } else if (e.key === 'Home') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[0]);
            tabEls[ids[0]]?.focus();
          } else if (e.key === 'End') {
            e.preventDefault();
            this._switchPersonaInstrTab(ids[ids.length - 1]);
            tabEls[ids[ids.length - 1]]?.focus();
          }
        },
      }, label);
      tabList.appendChild(tabBtn);
      tabEls[id] = tabBtn;

      // ── Tab panel ──────────────────────────────────────────────────────
      const tabPanel = el('div', {
        className: 'adv-instr-tabpanel adv-hidden',
        role: 'tabpanel',
        id: panelId,
        'aria-labelledby': tabId,
      });

      // Persona description
      tabPanel.appendChild(
        el('p', { className: 'adv-instr-persona-desc' }, description)
      );

      // ── Global vs per-project toggle ──────────────────────────────────
      const toggleId = `adv-instr-use-global-${id}`;
      const toggleLabel = el('label', {
        className: 'adv-instr-global-toggle-label',
        htmlFor: toggleId,
      }, 'Use global defaults');
      const toggle = el('input', {
        className: 'adv-instr-global-toggle',
        type: 'checkbox',
        id: toggleId,
        checked: true,  // default: use global
        onChange: () => {
          const useGlobal = toggle.checked;
          this._personaInstrUseGlobal[id] = useGlobal;
          this._applyPersonaInstrScopeMode(id, useGlobal);
        },
      });
      tabPanel.appendChild(
        el('div', { className: 'adv-instr-global-toggle-row' },
          toggle,
          toggleLabel,
        )
      );
      this._personaInstrGlobalToggleEls = this._personaInstrGlobalToggleEls || {};
      this._personaInstrGlobalToggleEls[id] = toggle;

      // ── Global instructions (read-only preview, shown when toggle=global) ──
      const globalTextareaId = `adv-instr-global-textarea-${id}`;
      const globalLabel = el('label', {
        className: 'adv-instr-label',
        htmlFor: globalTextareaId,
      }, 'Global instructions (read-only)');
      const globalCounterEl = el('span', { className: 'adv-instr-counter' }, '');
      const globalLabelRow = el('div', { className: 'adv-instr-label-row' }, globalLabel, globalCounterEl);

      const globalTextarea = el('textarea', {
        className: 'adv-instr-textarea adv-instr-textarea-readonly',
        id: globalTextareaId,
        placeholder: globalPlaceholder,
        rows: '5',
        readOnly: true,
        disabled: true,
      });
      this._personaInstrGlobalTextareas[id] = globalTextarea;

      const globalSection = el('div', { className: 'adv-instr-global-section' },
        globalLabelRow,
        globalTextarea,
        el('p', { className: 'adv-instr-tip' },
          'Set global defaults from the advisor settings page. Projects can override these.'
        ),
      );
      tabPanel.appendChild(globalSection);
      this._personaInstrGlobalSections = this._personaInstrGlobalSections || {};
      this._personaInstrGlobalSections[id] = globalSection;
      this._personaInstrGlobalCounterEls = this._personaInstrGlobalCounterEls || {};
      this._personaInstrGlobalCounterEls[id] = globalCounterEl;

      // ── Project-specific instructions (shown when toggle=customize) ────
      const textareaId = `adv-instr-textarea-${id}`;
      const counterEl = el('span', {
        className: 'adv-instr-counter',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }, '');
      const labelEl = el('label', {
        className: 'adv-instr-label',
        htmlFor: textareaId,
      }, 'Instructions for this project');

      const textarea = el('textarea', {
        className: 'adv-instr-textarea',
        id: textareaId,
        placeholder,
        maxlength: String(MAX_CHARS),
        rows: '5',
        onInput: () => {
          const len = textarea.value.length;
          const pct = len / MAX_CHARS;
          counterEl.textContent = len > 0 ? `${len} / ${MAX_CHARS}` : '';
          counterEl.className = 'adv-instr-counter' + (pct >= WARN_THRESHOLD ? ' adv-instr-counter-warn' : '');
          this._personaInstrDirty[id] = true;
          // Enable save button when dirty
          if (this._personaInstrSaveBtns[id]) {
            this._personaInstrSaveBtns[id].disabled = false;
          }
        },
      });
      this._personaInstrTextareas[id] = textarea;

      // Save button
      const saveBtn = el('button', {
        className: 'adv-instr-save-btn',
        type: 'button',
        disabled: true,  // enabled only when dirty
        onClick: () => this._savePersonaInstructions(id),
      }, 'Save');
      this._personaInstrSaveBtns[id] = saveBtn;

      // Last saved label
      const lastSavedEl = el('span', { className: 'adv-instr-last-saved' }, '');
      this._personaInstrLastSavedEls[id] = lastSavedEl;

      // Status element (Saving…, Error saving)
      const statusEl = el('span', { className: 'adv-instr-status' }, '');
      this._personaInstrStatusEls[id] = statusEl;

      const projectSection = el('div', { className: 'adv-instr-project-section adv-hidden' },
        el('div', { className: 'adv-instr-label-row' }, labelEl, counterEl),
        textarea,
        el('p', { className: 'adv-instr-tip' },
          'Be specific — name frameworks, compliance standards, or areas to ignore.'
        ),
        el('div', { className: 'adv-instr-footer' },
          el('div', { className: 'adv-instr-footer-meta' },
            lastSavedEl,
            statusEl,
          ),
          el('div', { className: 'adv-instr-footer-right' },
            el('span', { className: 'adv-instr-apply-note' }, 'Active on next run'),
            saveBtn,
          ),
        ),
      );
      tabPanel.appendChild(projectSection);
      this._personaInstrProjectSections = this._personaInstrProjectSections || {};
      this._personaInstrProjectSections[id] = projectSection;
      this._personaInstrCounterEls = this._personaInstrCounterEls || {};
      this._personaInstrCounterEls[id] = counterEl;

      tabPanelsContainer.appendChild(tabPanel);
      panelEls[id] = tabPanel;
    }

    // Store element maps for tab switching
    this._personaInstrTabEls = tabEls;
    this._personaInstrPanelEls = panelEls;

    // "Save as template" — captures current persona instructions as a reusable template.
    const saveAsTemplateBtn = el('button', {
      className: 'adv-instr-save-template-btn',
      type: 'button',
      title: 'Save current persona instructions as a reusable template',
      onClick: () => this._openSaveAsTemplateModal(),
    }, 'Save as template');
    this._saveAsTemplateBtn = saveAsTemplateBtn;

    panelBody.appendChild(
      el('div', { className: 'adv-instr-template-row' },
        saveAsTemplateBtn,
      )
    );

    this._personaInstrPanel = panel;

    // Subscribe to global instructions from /advisor/{personaId}
    this._subscribeGlobalInstructions();

    return panel;
  },

  /**
   * Switch the active persona instructions tab.
   * Warns user if the current tab has unsaved changes before switching.
   */
  _switchPersonaInstrTab(newId) {
    const currentId = this._personaInstrActiveTab;
    // Warn if current tab has unsaved changes
    if (currentId && currentId !== newId && this._personaInstrDirty[currentId]) {
      const confirmed = window.confirm(
        `You have unsaved changes to the ${currentId.charAt(0).toUpperCase() + currentId.slice(1)} persona instructions. Discard changes and switch tabs?`
      );
      if (!confirmed) {
        // Restore focus to current tab button
        this._personaInstrTabEls[currentId]?.focus();
        return;
      }
      // Discard changes: reset textarea to last fetched value
      const lastFetched = this._personaInstrLastFetched[currentId] || '';
      if (this._personaInstrTextareas[currentId]) {
        this._personaInstrTextareas[currentId].value = lastFetched;
      }
      this._personaInstrDirty[currentId] = false;
      if (this._personaInstrSaveBtns[currentId]) {
        this._personaInstrSaveBtns[currentId].disabled = true;
      }
      const counterEl = this._personaInstrCounterEls?.[currentId];
      if (counterEl) counterEl.textContent = '';
    }

    this._personaInstrActiveTab = newId;

    // Update tab aria-selected and visibility
    for (const [id, tabBtn] of Object.entries(this._personaInstrTabEls || {})) {
      const isActive = id === newId;
      tabBtn.setAttribute('aria-selected', String(isActive));
      tabBtn.classList.toggle('adv-instr-tab-active', isActive);
    }
    for (const [id, panelEl] of Object.entries(this._personaInstrPanelEls || {})) {
      panelEl.classList.toggle('adv-hidden', id !== newId);
    }
  },

  /**
   * Apply global or per-project scope mode for a persona instruction tab.
   * When useGlobal=true: show global textarea (read-only), hide project textarea.
   * When useGlobal=false: hide global textarea, show project textarea (editable).
   */
  _applyPersonaInstrScopeMode(personaId, useGlobal) {
    const globalSection = this._personaInstrGlobalSections?.[personaId];
    const projectSection = this._personaInstrProjectSections?.[personaId];
    if (globalSection) globalSection.classList.toggle('adv-hidden', !useGlobal);
    if (projectSection) projectSection.classList.toggle('adv-hidden', useGlobal);

    // Update scope label
    const projectId = this._filterProjectId;
    const project = this._projects.find(p => p.id === projectId);
    if (this._personaInstrScopeLabel) {
      if (!projectId) {
        this._personaInstrScopeLabel.textContent = 'Editing: Global defaults';
      } else if (useGlobal) {
        this._personaInstrScopeLabel.textContent = 'Using: Global defaults';
      } else {
        const name = project?.name || projectId;
        this._personaInstrScopeLabel.textContent = `Editing: Project — ${name}`;
      }
    }

    // Update global textarea content
    if (useGlobal) {
      const globalText = this._personaInstrGlobalData[personaId] || '';
      const globalTextarea = this._personaInstrGlobalTextareas?.[personaId];
      if (globalTextarea) {
        globalTextarea.value = globalText;
      }
      // Update global counter
      const globalCounter = this._personaInstrGlobalCounterEls?.[personaId];
      if (globalCounter) {
        globalCounter.textContent = globalText.length > 0 ? `${globalText.length} / 4000` : '';
      }
    }
  },

  /**
   * Subscribe to global persona instructions at /advisor/{engineer,design,product}.
   * These are the fallback when a project hasn't set per-project instructions.
   * Unsubscribes any existing listener first.
   */
  _subscribeGlobalInstructions() {
    if (this._personaInstrGlobalUnsub) {
      this._personaInstrGlobalUnsub();
      this._personaInstrGlobalUnsub = null;
    }
    if (!this.db) return;

    const personaIds = ['engineer', 'design', 'product'];
    const unsubs = [];

    for (const personaId of personaIds) {
      const unsub = this.db.collection('advisor').doc(personaId).onSnapshot(
        (snap) => {
          const data = snap.data() || {};
          const instructions = (typeof data.customInstructions === 'string') ? data.customInstructions : '';
          this._personaInstrGlobalData[personaId] = instructions;

          // If this persona's tab is currently showing global, refresh it
          if (this._personaInstrUseGlobal[personaId] !== false) {
            const globalTextarea = this._personaInstrGlobalTextareas?.[personaId];
            if (globalTextarea) {
              globalTextarea.value = instructions;
            }
            const globalCounter = this._personaInstrGlobalCounterEls?.[personaId];
            if (globalCounter) {
              globalCounter.textContent = instructions.length > 0 ? `${instructions.length} / 4000` : '';
            }
          }
        },
        (err) => {
          if (err.code !== 'permission-denied') {
            console.error(`AdvisorPanel: global instructions listener error for ${personaId}:`, err);
          }
        },
      );
      unsubs.push(unsub);
    }

    // Combine all unsubscribes into one
    this._personaInstrGlobalUnsub = () => unsubs.forEach(u => u());
  },

  /**
   * Save persona instructions (explicit save — no auto-save, no debounce).
   * DK-133: On save, write to Firestore. Confirm via aria-live region.
   */
  async _savePersonaInstructions(personaId) {
    const projectId = this._filterProjectId;
    if (!projectId) return;

    const textarea = this._personaInstrTextareas[personaId];
    if (!textarea) return;
    const text = textarea.value;

    if (text.length > 4000) {
      const statusEl = this._personaInstrStatusEls[personaId];
      if (statusEl) {
        statusEl.textContent = 'Too long (max 4000 characters)';
        statusEl.className = 'adv-instr-status adv-instr-status-err';
      }
      return;
    }

    const saveBtn = this._personaInstrSaveBtns[personaId];
    const statusEl = this._personaInstrStatusEls[personaId];
    const lastSavedEl = this._personaInstrLastSavedEls[personaId];

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = 'Saving…';
      statusEl.className = 'adv-instr-status';
    }

    try {
      const update = {
        [`personaInstructions.${personaId}`]: text.trim(),
        updatedAt: new Date().toISOString(),
      };
      await this.db.collection('projects').doc(projectId).update(update);

      this._personaInstrDirty[personaId] = false;
      this._personaInstrLastFetched[personaId] = text.trim();

      if (statusEl) {
        statusEl.textContent = '';
        statusEl.className = 'adv-instr-status';
      }

      // "Last saved: X minutes ago" — starts at "just now"
      if (lastSavedEl) {
        lastSavedEl.textContent = 'Last saved: just now';
        lastSavedEl._savedAt = Date.now();
        // Update every minute
        if (lastSavedEl._interval) clearInterval(lastSavedEl._interval);
        lastSavedEl._interval = setInterval(() => {
          const mins = Math.floor((Date.now() - lastSavedEl._savedAt) / 60000);
          lastSavedEl.textContent = mins < 1 ? 'Last saved: just now' : `Last saved: ${mins} minute${mins === 1 ? '' : 's'} ago`;
        }, 30000);
      }

      // aria-live confirmation
      if (this._personaInstrLiveRegion) {
        this._personaInstrLiveRegion.textContent = 'Saved — active on next run';
        setTimeout(() => {
          if (this._personaInstrLiveRegion) this._personaInstrLiveRegion.textContent = '';
        }, 4000);
      }
    } catch (err) {
      console.error(`AdvisorPanel: failed to save personaInstructions.${personaId}:`, err);
      if (statusEl) {
        statusEl.textContent = 'Error saving';
        statusEl.className = 'adv-instr-status adv-instr-status-err';
      }
      // Re-enable save so user can retry
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  /** Render/update the persona instructions panel content for the current project. */
  _renderPersonaInstructionsPanel() {
    if (!this._personaInstrPanel) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      this._personaInstrPanel.style.display = 'none';
      return;
    }

    this._personaInstrPanel.style.display = '';

    const project = this._projects.find(p => p.id === projectId);
    const instructions = project?.personaInstructions || {};

    for (const id of ['engineer', 'design', 'product']) {
      const textarea = this._personaInstrTextareas[id];
      if (!textarea) continue;

      // Only update textarea when not dirty (user hasn't typed unsaved changes)
      if (!this._personaInstrDirty[id] && document.activeElement !== textarea) {
        const value = instructions[id] || '';
        textarea.value = value;
        this._personaInstrLastFetched[id] = value;

        // Reset counter
        const counterEl = this._personaInstrCounterEls?.[id];
        if (counterEl) counterEl.textContent = '';

        // Disable save button (not dirty)
        if (this._personaInstrSaveBtns[id]) {
          this._personaInstrSaveBtns[id].disabled = true;
        }
      }

      // Determine if project has custom override (non-empty project instructions)
      const hasProjectOverride = !!(instructions[id] && instructions[id].trim());

      // Default: show global if no project override exists, unless user explicitly toggled
      if (this._personaInstrUseGlobal[id] === undefined) {
        // First load: default to global if no project instructions, project if override exists
        this._personaInstrUseGlobal[id] = !hasProjectOverride;
      }

      // Sync toggle checkbox
      const toggleEl = this._personaInstrGlobalToggleEls?.[id];
      if (toggleEl) {
        toggleEl.checked = this._personaInstrUseGlobal[id];
      }

      // Apply scope mode
      this._applyPersonaInstrScopeMode(id, this._personaInstrUseGlobal[id]);
    }

    // Activate default tab (engineer) on first render
    if (!this._personaInstrTabsInitialized) {
      this._personaInstrTabsInitialized = true;
      this._switchPersonaInstrTab('engineer');
    }

    // Update scope label for current state
    this._updatePersonaInstrScopeLabel();
  },

  /** Update the scope label to reflect the current project and active tab. */
  _updatePersonaInstrScopeLabel() {
    if (!this._personaInstrScopeLabel) return;
    const projectId = this._filterProjectId;
    const project = this._projects.find(p => p.id === projectId);
    const activeId = this._personaInstrActiveTab;
    const useGlobal = this._personaInstrUseGlobal[activeId] !== false;

    if (!projectId) {
      this._personaInstrScopeLabel.textContent = 'Editing: Global defaults';
    } else if (useGlobal) {
      this._personaInstrScopeLabel.textContent = 'Using: Global defaults';
    } else {
      const name = project?.name || projectId;
      this._personaInstrScopeLabel.textContent = `Editing: Project — ${name}`;
    }
  },

  /** Save a single persona's instructions to Firestore. */

  /** Toggle the context panel open/closed. */
  _toggleContextPanel() {
    this._contextPanelOpen = !this._contextPanelOpen;
    if (this._contextPanel) {
      this._contextPanel.style.display = this._contextPanelOpen ? '' : 'none';
    }
    if (this._contextBtn) {
      this._contextBtn.classList.toggle('adv-context-btn-active', this._contextPanelOpen);
    }
    if (this._contextPanelOpen) {
      this._renderContextPanel();
    }
  },

  /** Render/update the context panel content for the current project. */
  _renderContextPanel() {
    if (!this._contextPanel || !this._contextTextarea) return;

    const projectId = this._filterProjectId;
    if (!projectId) {
      // No project selected — hide panel and button
      this._contextPanel.style.display = 'none';
      this._contextPanelOpen = false;
      if (this._contextBtn) {
        this._contextBtn.style.display = 'none';
        this._contextBtn.classList.remove('adv-context-btn-active');
      }
      // Unsubscribe presets when no project
      if (this._presetsProjectId) {
        this._subscribePresets(null);
      }
      return;
    }

    // Show button when a project is selected
    if (this._contextBtn) this._contextBtn.style.display = '';

    // Subscribe to presets for this project if not already
    if (this._presetsProjectId !== projectId) {
      this._subscribePresets(projectId);
    }

    if (!this._contextPanelOpen) return;

    const project = this._projects.find(p => p.id === projectId);

    // Sync active preset ID from project doc
    const serverActivePresetId = project?.activePresetId || null;
    if (serverActivePresetId !== this._lastAppliedPresetId) {
      this._lastAppliedPresetId = serverActivePresetId;
      this._contextDirty = false;
    }

    // Only update textarea value when not actively dirty (avoid overwriting user edits)
    if (!this._contextDirty) {
      this._contextTextarea.value = project?.advisorContext || '';
      this._updateContextHints(this._contextTextarea);
    }

    // DK-302: Populate priorities field from project doc (no dirty guard — autosave keeps it in sync)
    if (this._prioritiesTextarea) {
      const priorities = project?.priorities || '';
      this._prioritiesTextarea.value = priorities;
      if (this._prioritiesCharCountEl) {
        const len = priorities.length;
        this._prioritiesCharCountEl.textContent = `${len} / 500`;
        this._prioritiesCharCountEl.classList.toggle('adv-priorities-charcount--warn', len > 400);
        this._prioritiesCharCountEl.classList.toggle('adv-priorities-charcount--over', len > 500);
      }
      this._updatePrioritiesTimestamp(project?.prioritiesUpdatedAt || null);
    }

    this._updatePresetSelector();
    this._updatePresetDriftIndicator();
  }
};
