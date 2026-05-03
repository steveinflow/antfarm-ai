// Project context panel + DK-302 priorities + DK-193 named presets.
// Top-of-panel area for editing the per-project advisorContext, the
// short-form priorities sentence, and saving/loading named presets.

import { el } from '../ui/el.js';
import { toDate } from '../ui/format.js';
import { CONTEXT_EXAMPLES } from '../config/personas.js';
import { getContextQuality } from '../helpers/persona.js';

export const contextPanelMixin = {
  _buildContextPanel() {
    const panel = el('div', { className: 'adv-context-panel', style: 'display:none' });

    // ── DK-302: Current Priorities field ──────────────────────────────────
    // Placed at the top of the context panel — first thing to configure.
    // Per-project: the field is scoped per project; project name is visible in the header
    // (set via the project filter selector, shown in the same panel context).
    const MAX_PRIORITIES_CHARS = 500;
    const prioritiesCharCountId = 'adv-priorities-charcount';
    const prioritiesSaveStatusId = 'adv-priorities-save-status';

    const prioritiesLabel = el('label', {
      className: 'adv-priorities-label',
      htmlFor: 'adv-priorities-textarea',
    }, 'Current Priorities');
    const prioritiesSubLabel = el('div', { className: 'adv-priorities-sublabel' },
      'Used by all advisor personas when generating suggestions.'
    );
    const prioritiesLabelRow = el('div', { className: 'adv-priorities-label-row' },
      prioritiesLabel,
      prioritiesSubLabel,
    );
    panel.appendChild(prioritiesLabelRow);

    // ARIA live region for "Saved" confirmation — must be announced to screen readers
    const prioritiesSaveStatusEl = el('span', {
      id: prioritiesSaveStatusId,
      className: 'adv-priorities-save-status',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    this._prioritiesSaveStatusEl = prioritiesSaveStatusEl;
    panel.appendChild(prioritiesSaveStatusEl);

    const prioritiesTextarea = el('textarea', {
      id: 'adv-priorities-textarea',
      className: 'adv-priorities-textarea',
      placeholder: 'e.g., shipping payments by March 15, deprioritize infra work',
      rows: '3',
      maxlength: String(MAX_PRIORITIES_CHARS),
      'aria-describedby': `${prioritiesCharCountId} ${prioritiesSaveStatusId}`,
      onInput: () => {
        this._onPrioritiesInput(prioritiesTextarea, prioritiesCharCountEl, MAX_PRIORITIES_CHARS);
      },
    });
    this._prioritiesTextarea = prioritiesTextarea;
    panel.appendChild(prioritiesTextarea);

    // Live character counter — always visible, updated on input
    const prioritiesCharCountEl = el('div', {
      id: prioritiesCharCountId,
      className: 'adv-priorities-charcount',
    }, `0 / ${MAX_PRIORITIES_CHARS}`);
    this._prioritiesCharCountEl = prioritiesCharCountEl;
    panel.appendChild(prioritiesCharCountEl);

    // Relative timestamp for last update + timing note
    const prioritiesTimestampEl = el('div', { className: 'adv-priorities-timestamp' });
    this._prioritiesTimestampEl = prioritiesTimestampEl;
    panel.appendChild(prioritiesTimestampEl);

    // Timing expectation line
    panel.appendChild(
      el('div', { className: 'adv-priorities-timing-note' },
        'Changes take effect on the next scheduled advisor run.'
      )
    );

    // Section divider before Global Context
    panel.appendChild(el('div', { className: 'adv-priorities-divider' }));

    // Section label — communicates this is a global setting, not per-persona
    const label = el('div', { className: 'adv-context-panel-label' },
      el('span', { className: 'adv-context-panel-label-icon' }, '⊕'),
      'Global Context',
    );
    panel.appendChild(label);

    // ── Preset selector row ────────────────────────────────────────────────
    // Dropdown showing active preset name (or "Custom" when edited)
    const presetSelect = el('select', {
      className: 'adv-preset-select',
      'aria-label': 'Active context preset',
      onChange: () => this._onPresetSelectChange(presetSelect),
    });
    this._presetSelectEl = presetSelect;

    // "edited" drift indicator + Revert link (hidden until drift detected)
    const driftEl = el('span', { className: 'adv-preset-drift', 'aria-live': 'polite', role: 'status' });
    this._presetDriftEl = driftEl;

    // Delete preset button (shown only when a named preset is active)
    const deletePresetBtn = el('button', {
      className: 'adv-preset-delete-btn',
      title: 'Delete this preset',
      'aria-label': 'Delete active preset',
      style: 'display:none',
      onClick: () => this._openDeletePresetModal(),
    }, '✕');
    this._presetDeleteBtn = deletePresetBtn;

    const selectorRow = el('div', { className: 'adv-preset-selector-row' },
      presetSelect,
      deletePresetBtn,
      driftEl,
    );
    panel.appendChild(selectorRow);

    // ── Context textarea ───────────────────────────────────────────────────
    const MAX_CONTEXT_CHARS = 4000;

    const textarea = el('textarea', {
      className: 'adv-context-textarea',
      placeholder: CONTEXT_EXAMPLES,
      rows: '5',
      maxlength: String(MAX_CONTEXT_CHARS),
      'aria-label': 'Project context for AI advisors',
      onInput: () => {
        this._onContextTextareaInput(textarea);
      },
      onFocus: () => {
        this._contextFocused = true;
        this._contextModifiedThisSession = true;
        this._updateContextHints(textarea);
      },
      onBlur: () => {
        this._contextFocused = false;
        this._updateContextHints(textarea);
      },
    });
    panel.appendChild(textarea);

    // Character count — aria-live so screen readers announce changes.
    // Visibility is gated: shown on focus, or on blur if out of suggested range.
    const charCountEl = el('div', {
      className: 'adv-context-charcount',
      'aria-live': 'polite',
      role: 'status',
    });
    panel.appendChild(charCountEl);
    this._contextCharCountEl = charCountEl;

    // Quality indicator — shown only when the field is focused or has been modified
    // this session. Purely informational; never a blocker.
    const qualityEl = el('div', { className: 'adv-context-quality' });
    panel.appendChild(qualityEl);
    this._contextQualityEl = qualityEl;

    // ── Footer: status + Save as… + Save ─────────────────────────────────
    const footer = el('div', { className: 'adv-context-panel-footer' });
    const statusEl = el('span', { className: 'adv-context-status', role: 'status', 'aria-live': 'polite' });

    // "Save as…" button — always visible (not hover-only per spec)
    const saveAsBtn = el('button', {
      className: 'adv-context-save-as',
      onClick: () => this._openSavePresetModal(textarea.value),
    }, 'Save as…');
    this._presetSaveAsBtn = saveAsBtn;

    // Save button — saves the live context to the project doc
    const actionBtn = el('button', {
      className: 'adv-context-edit',
      onClick: () => {
        const projectId = this._filterProjectId;
        if (!projectId) return;
        this._saveContext(projectId, textarea.value, actionBtn, statusEl);
      },
    }, 'Save');

    footer.appendChild(statusEl);
    footer.appendChild(saveAsBtn);
    footer.appendChild(actionBtn);
    panel.appendChild(footer);

    this._contextPanel = panel;
    this._contextTextarea = textarea;
    this._contextActionBtn = actionBtn;
    this._contextStatusEl = statusEl;

    return panel;
  },

  /**
   * Called when the user types in the context textarea.
   * Updates character count, quality indicator, and drift indicator.
   */
  _onContextTextareaInput(textarea) {
    this._contextModifiedThisSession = true;
    this._updateContextHints(textarea);
    // Drift detection: if the user has edited from a known preset, mark dirty
    this._contextDirty = true;
    this._updatePresetDriftIndicator();
  },

  // ── DK-302: Current Priorities field handlers ─────────────────────────────

  /**
   * Called when the user types in the priorities textarea.
   * Updates character counter and schedules a debounced autosave.
   * @param {HTMLTextAreaElement} textarea
   * @param {HTMLElement} charCountEl
   * @param {number} maxChars
   */
  _onPrioritiesInput(textarea, charCountEl, maxChars) {
    const len = textarea.value.length;
    if (charCountEl) {
      charCountEl.textContent = `${len} / ${maxChars}`;
      charCountEl.classList.toggle('adv-priorities-charcount--warn', len > maxChars * 0.8);
      charCountEl.classList.toggle('adv-priorities-charcount--over', len > maxChars);
    }
    // Debounced autosave (~1s)
    if (this._prioritiesDebounceTimer) clearTimeout(this._prioritiesDebounceTimer);
    this._prioritiesDebounceTimer = setTimeout(() => {
      const projectId = this._filterProjectId;
      if (projectId) this._savePriorities(projectId, textarea.value);
    }, 1000);
  },

  /**
   * Save the priorities field to Firestore.
   * Trims whitespace, strips null bytes, enforces 500-char limit server-side.
   * On success, shows a quiet "Saved" confirmation via ARIA live region (3s).
   * @param {string} projectId
   * @param {string} rawText
   */
  async _savePriorities(projectId, rawText) {
    if (!projectId) return;
    // Trim and strip null bytes (server-side also enforces 500 char limit)
    const trimmed = rawText.replace(/\0/g, '').trim().slice(0, 500);
    try {
      await this.db.collection('projects').doc(projectId).update({
        priorities: trimmed,
        prioritiesUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Show "Saved" confirmation via ARIA live region
      if (this._prioritiesSaveStatusEl) {
        this._prioritiesSaveStatusEl.textContent = 'Saved';
        setTimeout(() => {
          if (this._prioritiesSaveStatusEl) this._prioritiesSaveStatusEl.textContent = '';
        }, 3000);
      }
    } catch (err) {
      console.error('Failed to save priorities:', err);
    }
  },

  /**
   * Format a relative timestamp for the priorities field.
   * Returns "Updated 2 days ago." style text, or empty if no timestamp.
   * @param {string|null} isoStr
   * @returns {{ text: string, stale: boolean }}
   */
  _formatPrioritiesTimestamp(isoStr) {
    if (!isoStr) return { text: '', stale: false };
    const ms = Date.now() - new Date(isoStr).getTime();
    if (ms < 0) return { text: '', stale: false };
    const mins = Math.floor(ms / 60_000);
    let text;
    if (mins < 1) text = 'Updated just now.';
    else if (mins < 60) text = `Updated ${mins} minute${mins === 1 ? '' : 's'} ago.`;
    else {
      const h = Math.floor(mins / 60);
      if (h < 24) text = `Updated ${h} hour${h === 1 ? '' : 's'} ago.`;
      else {
        const days = Math.floor(h / 24);
        text = `Updated ${days} day${days === 1 ? '' : 's'} ago.`;
      }
    }
    // 14+ days = stale indicator
    const stale = ms > 14 * 24 * 60 * 60 * 1000;
    return { text, stale };
  },

  /**
   * Update the priorities timestamp element from a raw priorities updated-at string.
   * @param {string|null} prioritiesUpdatedAt
   */
  _updatePrioritiesTimestamp(prioritiesUpdatedAt) {
    if (!this._prioritiesTimestampEl) return;
    const { text, stale } = this._formatPrioritiesTimestamp(prioritiesUpdatedAt);
    this._prioritiesTimestampEl.textContent = text;
    this._prioritiesTimestampEl.classList.toggle('adv-priorities-timestamp--stale', stale);
  },

  /**
   * Update the "Add priorities" dismissible banner shown in the advisor output section
   * when priorities is empty and an advisor has run recently.
   * @param {boolean} showBanner
   */
  _updatePrioritiesBanner(showBanner) {
    if (!this._prioritiesBannerEl) return;
    if (this._prioritiesBannerDismissed) {
      this._prioritiesBannerEl.style.display = 'none';
      return;
    }
    this._prioritiesBannerEl.style.display = showBanner ? '' : 'none';
  },

  /**
   * Update the Update the collapsed one-line preview of current priorities for a persona card.
   * @param {string} personaId
   * @param {string|null} priorities
   */
  _updatePrioritiesPreview(personaId, priorities) {
    const el = this._prioritiesPreviewEls[personaId];
    if (!el) return;
    const trimmed = (priorities || '').trim();
    if (trimmed) {
      // Truncate to one line (120 chars)
      const preview = trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed;
      el.textContent = `Priorities: ${preview}`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  },

  /**
   * Update the character counter and quality indicator based on the current
   * textarea value and focus state (DK-120).
   *
   * Character counter:
   *   - Always shown on focus.
   *   - Hidden on blur only if content is within the 100-400 char suggested range.
   *   - Shows count against the 4000-char hard max (warn at 80%, over at 100%).
   *   - Marks out-of-range (< 50 or > 600) at boundaries.
   *
   * Quality indicator:
   *   - Only shown when the field is focused or has been modified this session.
   *   - Never blocks saving. Informational only.
   *
   * @param {HTMLTextAreaElement} textarea
   */
  _updateContextHints(textarea) {
    const value = textarea ? textarea.value : '';
    const len = value.length;
    const MAX = 4000;
    const SUGGESTED_MIN = 100;
    const SUGGESTED_MAX = 400;

    // ── Character counter ──────────────────────────────────────────────────
    if (this._contextCharCountEl) {
      const focused = this._contextFocused;
      const withinSuggestedRange = len >= SUGGESTED_MIN && len <= SUGGESTED_MAX;
      // Show on focus always; show on blur if out of suggested range or near hard max
      const shouldShow = focused || !withinSuggestedRange || len > MAX * 0.8;

      if (shouldShow) {
        // Show count / range; append suggested range hint when focused and not near max
        if (len <= MAX * 0.8) {
          this._contextCharCountEl.textContent = `${len} / ${SUGGESTED_MAX} suggested`;
        } else {
          this._contextCharCountEl.textContent = `${len} / ${MAX}`;
        }
        this._contextCharCountEl.classList.toggle('adv-context-charcount--boundary', len < 50 || len > 600);
        this._contextCharCountEl.classList.toggle('adv-context-charcount--warn', len > MAX * 0.9);
        this._contextCharCountEl.classList.toggle('adv-context-charcount--over', len > MAX);
      } else {
        this._contextCharCountEl.textContent = '';
        this._contextCharCountEl.className = 'adv-context-charcount';
      }
    }

    // ── Quality indicator ──────────────────────────────────────────────────
    if (this._contextQualityEl) {
      const active = this._contextFocused || this._contextModifiedThisSession;
      if (active && len > 0) {
        const quality = getContextQuality(value);
        this._contextQualityEl.textContent = `Context: ${quality}`;
        this._contextQualityEl.className = `adv-context-quality adv-context-quality--${quality}`;
      } else {
        this._contextQualityEl.textContent = '';
        this._contextQualityEl.className = 'adv-context-quality';
      }
    }
  },

  /**
   * Update the drift indicator based on whether the current textarea value
   * matches the last applied preset.
   */
  _updatePresetDriftIndicator() {
    if (!this._presetDriftEl || !this._presetSelectEl) return;

    const currentText = this._contextTextarea?.value ?? '';
    const activePreset = this._presets.find(p => p.id === this._lastAppliedPresetId);

    const isDrifted = this._lastAppliedPresetId && activePreset
      && currentText.trim() !== (activePreset.advisorContext || '').trim();

    if (isDrifted) {
      // Show "edited" indicator with Revert link
      this._presetDriftEl.textContent = '';
      const editedSpan = el('span', { className: 'adv-preset-drift-label' }, 'edited');
      const revertLink = el('button', {
        className: 'adv-preset-revert-link',
        onClick: () => {
          if (this._contextTextarea && activePreset) {
            this._contextTextarea.value = activePreset.advisorContext || '';
            this._contextDirty = false;
            // Update hints without triggering dirty flag
            this._updateContextHints(this._contextTextarea);
            this._updatePresetDriftIndicator();
            this._updatePresetSelector();
          }
        },
      }, 'Revert');
      this._presetDriftEl.appendChild(editedSpan);
      this._presetDriftEl.appendChild(document.createTextNode(' — '));
      this._presetDriftEl.appendChild(revertLink);
      this._presetDriftEl.style.display = '';

      // Show "Custom" in the selector
      this._updatePresetSelectorValue('__custom__');
    } else {
      this._presetDriftEl.textContent = '';
      this._presetDriftEl.style.display = 'none';
      this._updatePresetSelectorValue(this._lastAppliedPresetId || '__none__');
    }
  },

  /**
   * Update just the selected value in the preset dropdown without rebuilding it.
   */
  _updatePresetSelectorValue(value) {
    if (!this._presetSelectEl) return;
    // Ensure the value exists as an option; if not, fall back
    const opts = Array.from(this._presetSelectEl.options).map(o => o.value);
    if (opts.includes(value)) {
      this._presetSelectEl.value = value;
    }
  },

  /**
   * Called when the user changes the preset dropdown selection.
   */
  _onPresetSelectChange(selectEl) {
    const value = selectEl.value;
    if (value === '__none__' || value === '__custom__') return;

    const preset = this._presets.find(p => p.id === value);
    if (!preset) return;

    // If current context has been edited, warn inline before applying
    const currentText = this._contextTextarea?.value ?? '';
    const isEdited = this._lastAppliedPresetId
      ? this._contextDirty
      : currentText.trim().length > 0;

    if (isEdited) {
      // Show inline warning element — replace with warning then apply
      if (this._presetDriftEl) {
        this._presetDriftEl.textContent = '';
        const warnEl = el('span', {
          className: 'adv-preset-switch-warn',
          role: 'alert',
          'aria-live': 'assertive',
        }, 'Unsaved changes will be lost. ');
        const applyLink = el('button', {
          className: 'adv-preset-revert-link',
          onClick: () => this._applyPreset(preset),
        }, 'Apply anyway');
        const cancelLink = el('button', {
          className: 'adv-preset-revert-link',
          style: 'margin-left:6px',
          onClick: () => {
            // Revert dropdown to previous value
            this._updatePresetDriftIndicator();
            this._updatePresetSelectorValue(this._lastAppliedPresetId || '__none__');
          },
        }, 'Cancel');
        this._presetDriftEl.appendChild(warnEl);
        this._presetDriftEl.appendChild(applyLink);
        this._presetDriftEl.appendChild(cancelLink);
        this._presetDriftEl.style.display = '';
      }
    } else {
      this._applyPreset(preset);
    }
  },

  /**
   * Apply a preset: set textarea value + update activePresetId on project doc.
   */
  async _applyPreset(preset) {
    const projectId = this._filterProjectId;
    if (!projectId || !preset) return;

    // Apply to textarea immediately (optimistic)
    if (this._contextTextarea) {
      this._contextTextarea.value = preset.advisorContext || '';
    }
    this._lastAppliedPresetId = preset.id;
    this._contextDirty = false;
    this._updateContextHints(this._contextTextarea);
    this._updatePresetDriftIndicator();
    this._updatePresetSelector();

    // Persist advisorContext + activePresetId to Firestore
    try {
      await this.db.collection('projects').doc(projectId).update({
        advisorContext: (preset.advisorContext || '').trim(),
        activePresetId: preset.id,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('AdvisorPanel: failed to apply preset', err);
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = 'Error applying preset';
        this._contextStatusEl.className = 'adv-context-status adv-context-status-err';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 3000);
      }
    }
  },

  /**
   * Rebuild the preset <select> options list.
   */
  _updatePresetSelector() {
    const select = this._presetSelectEl;
    if (!select) return;

    const currentVal = select.value;
    select.textContent = '';

    // "(no preset)" option
    const noneOpt = document.createElement('option');
    noneOpt.value = '__none__';
    noneOpt.textContent = '— No preset —';
    select.appendChild(noneOpt);

    // "Custom" option (only shown when drift detected)
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom';
    select.appendChild(customOpt);

    for (const preset of this._presets) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;

      // Hover tooltip: last-modified date + first 80 chars of context
      const modDate = preset.updatedAt
        ? new Date(preset.updatedAt.toDate ? preset.updatedAt.toDate() : preset.updatedAt)
            .toLocaleDateString()
        : '';
      const preview = (preset.advisorContext || '').slice(0, 80);
      opt.title = [modDate, preview].filter(Boolean).join(' — ');

      select.appendChild(opt);
    }

    // Restore value
    const opts = Array.from(select.options).map(o => o.value);
    if (opts.includes(currentVal)) {
      select.value = currentVal;
    } else {
      select.value = this._lastAppliedPresetId || '__none__';
    }

    // Show/hide delete button based on whether a named preset is selected
    const selectedId = select.value;
    if (this._presetDeleteBtn) {
      const isNamedPreset = selectedId !== '__none__' && selectedId !== '__custom__';
      this._presetDeleteBtn.style.display = isNamedPreset ? '' : 'none';
    }
  },

  /**
   * Subscribe to the advisorTemplates subcollection for the given project.
   * Unsubscribes from any previously watched project first.
   */
  _subscribePresets(projectId) {
    if (this._presetsUnsub) {
      this._presetsUnsub();
      this._presetsUnsub = null;
    }
    this._presetsProjectId = projectId;
    this._presets = [];

    if (!projectId) {
      this._updatePresetSelector();
      return;
    }

    const ref = this.db.collection('projects').doc(projectId).collection('advisorTemplates');
    const unsub = ref.orderBy('createdAt').onSnapshot(
      (snap) => {
        this._presets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._updatePresetSelector();
        this._updatePresetDriftIndicator();
      },
      (err) => {
        if (err.code !== 'permission-denied') {
          console.error('AdvisorPanel: presets listener error', err);
        }
        if (this._mounted && this._presetsProjectId === projectId) {
          setTimeout(() => {
            if (this._mounted && this._presetsProjectId === projectId) {
              this._subscribePresets(projectId);
            }
          }, 8000);
        }
      }
    );
    this._presetsUnsub = unsub;
  },

  /**
   * Open the "Save as preset" modal.
   * Pre-populates suggested names on the user's first save.
   */
  _openSavePresetModal(currentContextText) {
    if (this._presetSaveModal) return; // already open

    const projectId = this._filterProjectId;
    if (!projectId) return;

    // Validate context length before opening modal
    if (!currentContextText || !currentContextText.trim()) {
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = 'Context is empty — nothing to save.';
        this._contextStatusEl.className = 'adv-context-status adv-context-status-err';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 3000);
      }
      return;
    }
    if (currentContextText.length > 4000) {
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = 'Context exceeds 4,000 characters — please shorten it first.';
        this._contextStatusEl.className = 'adv-context-status adv-context-status-err';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 4000);
      }
      return;
    }

    const SUGGESTED_NAMES = ['Pre-launch', 'Growth', 'Debt cleanup'];
    const MIN_NAME_LEN = 1;
    const MAX_NAME_LEN = 48;

    const overlay = el('div', {
      className: 'adv-modal-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSavePresetModal(); },
    });

    const modal = el('div', { className: 'adv-modal adv-preset-save-modal' });

    const header = el('div', { className: 'adv-modal-header' },
      el('div', { className: 'adv-modal-title' }, 'Save as preset'),
      el('button', {
        className: 'adv-modal-close',
        'aria-label': 'Close',
        onClick: () => this._closeSavePresetModal(),
      }, '×'),
    );
    modal.appendChild(header);

    // Name input
    const nameLabel = el('label', { className: 'adv-modal-label', htmlFor: 'adv-preset-name-input' }, 'Preset name');
    const nameInput = el('input', {
      type: 'text',
      id: 'adv-preset-name-input',
      className: 'adv-modal-input',
      placeholder: 'e.g. Pre-launch',
      maxlength: String(MAX_NAME_LEN),
      'aria-required': 'true',
    });

    const nameCountEl = el('div', { className: 'adv-modal-charcount' });
    const updateNameCount = () => {
      const len = nameInput.value.length;
      nameCountEl.textContent = len > MAX_NAME_LEN * 0.7 ? `${len} / ${MAX_NAME_LEN}` : '';
      nameCountEl.classList.toggle('adv-modal-charcount--warn', len > MAX_NAME_LEN * 0.85);
    };
    nameInput.addEventListener('input', updateNameCount);

    // Suggested name buttons (first save experience)
    const suggestionsEl = el('div', { className: 'adv-preset-suggestions' });
    for (const sug of SUGGESTED_NAMES) {
      const btn = el('button', {
        className: 'adv-preset-suggestion-btn',
        type: 'button',
        onClick: () => {
          nameInput.value = sug;
          updateNameCount();
          nameInput.focus();
        },
      }, sug);
      suggestionsEl.appendChild(btn);
    }

    // Validation error el
    const nameErrEl = el('div', {
      className: 'adv-modal-err',
      role: 'alert',
      'aria-live': 'assertive',
      style: 'display:none',
    });

    const saveBtn = el('button', {
      className: 'adv-modal-save-btn',
      type: 'button',
      onClick: () => this._savePreset(nameInput.value, currentContextText, saveBtn, nameErrEl),
    }, 'Save preset');

    const cancelBtn = el('button', {
      className: 'adv-modal-cancel-btn',
      type: 'button',
      onClick: () => this._closeSavePresetModal(),
    }, 'Cancel');

    const actions = el('div', { className: 'adv-modal-actions' }, saveBtn, cancelBtn);

    modal.appendChild(nameLabel);
    modal.appendChild(nameInput);
    modal.appendChild(nameCountEl);
    modal.appendChild(suggestionsEl);
    modal.appendChild(nameErrEl);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._presetSaveModal = overlay;

    // Keyboard: Enter saves, Escape closes
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { this._closeSavePresetModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._presetSaveModal._keyHandler = onKey;

    setTimeout(() => nameInput.focus(), 50);
  },

  _closeSavePresetModal() {
    if (!this._presetSaveModal) return;
    if (this._presetSaveModal._keyHandler) {
      document.removeEventListener('keydown', this._presetSaveModal._keyHandler);
    }
    this._presetSaveModal.remove();
    this._presetSaveModal = null;
  },

  /**
   * Persist a new or overwritten preset to Firestore.
   */
  async _savePreset(name, contextText, saveBtn, nameErrEl) {
    const trimmedName = (name || '').trim();
    const MIN = 1, MAX = 48;

    // Validate name
    if (trimmedName.length < MIN) {
      nameErrEl.textContent = 'Name is required.';
      nameErrEl.style.display = '';
      return;
    }
    if (trimmedName.length > MAX) {
      nameErrEl.textContent = `Name must be ${MAX} characters or fewer.`;
      nameErrEl.style.display = '';
      return;
    }

    // Validate context
    if ((contextText || '').length > 4000) {
      nameErrEl.textContent = 'Context exceeds 4,000 characters.';
      nameErrEl.style.display = '';
      return;
    }

    const projectId = this._filterProjectId;
    if (!projectId) return;

    saveBtn.disabled = true;
    nameErrEl.style.display = 'none';

    // Check if a preset with this name already exists → overwrite it
    const existing = this._presets.find(p => p.name === trimmedName);

    try {
      const now = new Date().toISOString();
      if (existing) {
        await this.db.collection('projects').doc(projectId)
          .collection('advisorTemplates').doc(existing.id).update({
            name: trimmedName,
            advisorContext: contextText.trim(),
            updatedAt: now,
          });
        this._lastAppliedPresetId = existing.id;
      } else {
        const docRef = await this.db.collection('projects').doc(projectId)
          .collection('advisorTemplates').add({
            name: trimmedName,
            advisorContext: contextText.trim(),
            createdAt: now,
            updatedAt: now,
          });
        this._lastAppliedPresetId = docRef.id;
      }

      // Also update activePresetId on the project
      await this.db.collection('projects').doc(projectId).update({
        activePresetId: this._lastAppliedPresetId,
        updatedAt: now,
      });

      this._contextDirty = false;
      this._closeSavePresetModal();
      this._updatePresetSelector();
      this._updatePresetDriftIndicator();

      // Show success in status element
      if (this._contextStatusEl) {
        this._contextStatusEl.textContent = `Preset "${trimmedName}" saved`;
        this._contextStatusEl.className = 'adv-context-status adv-context-status-ok';
        setTimeout(() => {
          if (this._contextStatusEl) {
            this._contextStatusEl.textContent = '';
            this._contextStatusEl.className = 'adv-context-status';
          }
        }, 2500);
      }
    } catch (err) {
      console.error('AdvisorPanel: failed to save preset', err);
      nameErrEl.textContent = 'Save failed — please try again.';
      nameErrEl.style.display = '';
      saveBtn.disabled = false;
    }
  },

  /**
   * Open the delete-preset confirmation modal.
   */
  _openDeletePresetModal() {
    if (this._presetDeleteModal) return;
    const projectId = this._filterProjectId;
    if (!projectId) return;
    const presetId = this._presetSelectEl?.value;
    if (!presetId || presetId === '__none__' || presetId === '__custom__') return;
    const preset = this._presets.find(p => p.id === presetId);
    if (!preset) return;

    const overlay = el('div', {
      className: 'adv-modal-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeDeletePresetModal(); },
    });
    const modal = el('div', { className: 'adv-modal adv-preset-delete-modal' });

    modal.appendChild(el('div', { className: 'adv-modal-header' },
      el('div', { className: 'adv-modal-title' }, 'Delete preset'),
      el('button', {
        className: 'adv-modal-close',
        'aria-label': 'Close',
        onClick: () => this._closeDeletePresetModal(),
      }, '×'),
    ));

    modal.appendChild(el('p', { className: 'adv-modal-body' },
      `Delete preset "${preset.name}"? This cannot be undone.`,
    ));

    const deleteBtn = el('button', {
      className: 'adv-modal-delete-btn',
      type: 'button',
      role: 'alert',
      onClick: async () => {
        deleteBtn.disabled = true;
        try {
          await this.db.collection('projects').doc(projectId)
            .collection('advisorTemplates').doc(preset.id).delete();

          // Clear activePresetId if this was the active one
          if (this._lastAppliedPresetId === preset.id) {
            this._lastAppliedPresetId = null;
            await this.db.collection('projects').doc(projectId).update({
              activePresetId: null,
              updatedAt: new Date().toISOString(),
            });
          }
          this._closeDeletePresetModal();
        } catch (err) {
          console.error('AdvisorPanel: failed to delete preset', err);
          deleteBtn.disabled = false;
        }
      },
    }, 'Delete');

    const cancelBtn = el('button', {
      className: 'adv-modal-cancel-btn',
      type: 'button',
      onClick: () => this._closeDeletePresetModal(),
    }, 'Cancel');

    modal.appendChild(el('div', { className: 'adv-modal-actions' }, deleteBtn, cancelBtn));
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._presetDeleteModal = overlay;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeDeletePresetModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._presetDeleteModal._keyHandler = onKey;

    setTimeout(() => deleteBtn.focus(), 50);
  },

  _closeDeletePresetModal() {
    if (!this._presetDeleteModal) return;
    if (this._presetDeleteModal._keyHandler) {
      document.removeEventListener('keydown', this._presetDeleteModal._keyHandler);
    }
    this._presetDeleteModal.remove();
    this._presetDeleteModal = null;
  }
};
