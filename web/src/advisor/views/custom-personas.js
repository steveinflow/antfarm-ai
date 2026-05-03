// Custom personas — render, edit, save, delete.
// User-defined Claude personas living under /advisorPersonas/{slug}.
// Includes the create/edit modal, preview pane, validation, and the
// volume warning shown when many personas would run together.

import { el } from '../ui/el.js';
import {
  PERSONAS,
  RESERVED_NAMES,
  CUSTOM_PERSONA_MODELS,
  SCHEDULE_PRESETS,
  CUSTOM_PERSONA_STARTER,
} from '../config/personas.js';
import { DEFAULT_SOUL_PROMPTS } from '../config/soul-prompts.js';
import { sanitizePromptValue, slugifyName } from '../helpers/persona.js';
import { showConfirmModal } from '../../confirm-modal.js';
import { createSaveOnBlur } from '../../save-on-blur.js';

export const customPersonasMixin = {
  // ── Custom persona rendering ─────────────────────────────────

  /**
   * Render custom persona cards into the custom personas body container.
   * Called whenever the /advisorPersonas collection snapshot updates.
   */
  _renderCustomPersonas() {
    if (!this._customPersonasBody) return;
    this._customPersonasBody.innerHTML = '';

    // Update Add button's disabled state based on cap
    const MAX_CUSTOM_PERSONAS = 10;
    if (this._addPersonaBtn) {
      const atCap = this._customPersonas.length >= MAX_CUSTOM_PERSONAS;
      this._addPersonaBtn.disabled = atCap;
      this._addPersonaBtn.title = atCap
        ? `Maximum of ${MAX_CUSTOM_PERSONAS} custom personas reached`
        : 'Create a new custom persona';
    }

    if (this._customPersonas.length === 0) {
      this._customPersonasBody.appendChild(
        el('div', { className: 'adv-custom-empty' },
          'No custom personas yet. Click "+ Add Persona" to create one.'
        )
      );
      return;
    }

    // Aggregate volume warning — shown when >3 personas are enabled with intervals < 12h.
    // Stored in a dedicated container so it can be updated without re-rendering cards.
    const warningContainer = el('div', { className: 'adv-volume-warning-container' });
    this._volumeWarningEl = warningContainer;
    this._updateVolumeWarning();
    this._customPersonasBody.appendChild(warningContainer);

    for (const persona of this._customPersonas) {
      const pid = persona.id || persona._docId;
      this._customPersonasBody.appendChild(this._buildCustomPersonaCard(persona, pid));
    }
  },

  /**
   * Update the volume warning element in place (without re-rendering persona cards).
   * Called when persona states change.
   */
  _updateVolumeWarning() {
    if (!this._volumeWarningEl) return;
    this._volumeWarningEl.innerHTML = '';
    const warning = this._buildVolumeWarning();
    if (warning) {
      this._volumeWarningEl.appendChild(warning);
    }
  },

  /**
   * Build the aggregate volume warning element if conditions are met.
   * Triggered when there are more than 3 personas enabled with intervals < 12h.
   * Returns null if no warning is needed.
   *
   * @returns {HTMLElement|null}
   */
  _buildVolumeWarning() {
    const HIGH_VOLUME_PERSONA_THRESHOLD = 3;
    const HIGH_VOLUME_INTERVAL_THRESHOLD_H = 12;

    // Count enabled personas with short intervals across built-ins + custom
    let highFrequencyCount = 0;
    let minIntervalH = Infinity;

    // Check built-in personas
    for (const { id, defaultHours } of PERSONAS) {
      const state = this._states[id];
      if (!state || state.status === 'paused') continue; // skip disabled
      const intervalH = state.intervalHours ?? defaultHours;
      if (intervalH < HIGH_VOLUME_INTERVAL_THRESHOLD_H) {
        highFrequencyCount++;
        minIntervalH = Math.min(minIntervalH, intervalH);
      }
    }

    // Check custom personas
    for (const persona of this._customPersonas) {
      const pid = persona.id || persona._docId;
      const state = this._states[pid];
      if (state?.status === 'paused') continue; // skip disabled
      // Use persona doc's intervalHours as source of truth for custom personas
      const intervalH = state?.intervalHours ?? persona.intervalHours ?? 24;
      if (intervalH < HIGH_VOLUME_INTERVAL_THRESHOLD_H) {
        highFrequencyCount++;
        minIntervalH = Math.min(minIntervalH, intervalH);
      }
    }

    if (highFrequencyCount <= HIGH_VOLUME_PERSONA_THRESHOLD) return null;
    if (minIntervalH === Infinity) return null;

    const intervalLabel = minIntervalH < 1
      ? `${Math.round(minIntervalH * 60)}m`
      : `${minIntervalH}h`;

    return el('div', {
      className: 'adv-volume-warning',
      role: 'alert',
    },
      el('span', { className: 'adv-volume-warning-icon', 'aria-hidden': 'true' }, '⚠'),
      ` High ticket volume expected — ${highFrequencyCount} personas running every ${intervalLabel}.`,
    );
  },

  /**
   * Build a status card for a custom persona.
   * Mirrors the built-in persona card layout but adds a "Custom" badge
   * and edit/delete controls.
   *
   * @param {object} persona - Custom persona definition from Firestore /advisorPersonas
   * @param {string} pid - Stable persona ID (slugified name)
   */
  _buildCustomPersonaCard(persona, pid) {
    const card = el('div', { className: 'adv-card adv-card-custom' });

    // ── Collapse toggle ────────────────────────────────────────
    const isInitiallyCollapsed = this._collapsedPersonas.has(pid);
    const collapseBtn = el('button', {
      className: 'adv-collapse-btn',
      title: isInitiallyCollapsed ? 'Expand' : 'Collapse',
      'aria-expanded': String(!isInitiallyCollapsed),
      'aria-controls': `adv-card-body-${pid}`,
      onClick: () => this._toggleCardCollapse(pid),
    }, isInitiallyCollapsed ? '▸' : '▾');

    // ── Card header ────────────────────────────────────────────
    const statusDot  = el('span', { className: 'adv-dot adv-dot-unknown', title: 'Advisor offline' });
    const statusText = el('span', { className: 'adv-status-text' }, 'Waiting…');

    // "Custom" badge — text label so it's not color-only
    const customBadge = el('span', {
      className: 'adv-custom-badge',
      'aria-label': 'Custom persona',
    }, 'Custom');

    // Edit button
    const editBtn = el('button', {
      className: 'adv-custom-edit-btn',
      title: `Edit ${persona.name}`,
      onClick: () => this._openCustomPersonaModal(pid),
    }, 'Edit');

    // Pause toggle — checkbox + adjacent text (same pattern as built-in cards)
    // aria-label includes the persona name per spec: "Enable <Name> persona"
    const customPauseCheckboxId = `adv-pause-${pid}`;
    const customPauseCheckbox = el('input', {
      type: 'checkbox',
      className: 'adv-pause-checkbox',
      id: customPauseCheckboxId,
      'aria-label': `Enable ${persona.name || pid} persona`,
      title: 'Pause / Resume this persona',
      onChange: () => this._togglePause(pid),
    });
    const customPauseTextEl = el('span', { className: 'adv-pause-text' }, 'Active');
    const pauseBtn = el('label', {
      className: 'adv-pause-label',
      htmlFor: customPauseCheckboxId,
    }, customPauseCheckbox, customPauseTextEl);

    // Run now button — opens inline prompt expander (DK-321)
    const runNowBtn = el('button', {
      className: 'adv-run-now-btn',
      'aria-label': `Run ${persona.name || pid} persona now`,
      'aria-expanded': 'false',
      'aria-controls': `adv-run-prompt-${pid}`,
      title: 'Run now',
      onClick: () => this._toggleRunPrompt(pid),
    }, 'Run Now');

    // Run state label
    const runStateEl = el('div', {
      className: 'adv-run-state',
      'aria-live': 'polite',
      role: 'status',
    });

    const timeHintEl = el('span', { className: 'adv-run-time-hint' }, 'Usually 30–60s');

    card.appendChild(
      el('div', { className: 'adv-card-header' },
        el('div', { className: 'adv-card-header-left' },
          collapseBtn,
          statusDot,
          el('span', { className: 'adv-persona-label' }, persona.name || pid),
          customBadge,
          statusText,
        ),
        el('div', { className: 'adv-card-header-right' },
          editBtn,
          runNowBtn,
          pauseBtn,
        ),
      )
    );

    // ── Card body (collapsible) ────────────────────────────────
    const cardBody = el('div', {
      className: 'adv-card-body' + (isInitiallyCollapsed ? ' adv-hidden' : ''),
      id: `adv-card-body-${pid}`,
    });
    if (isInitiallyCollapsed) card.classList.add('adv-card-collapsed');
    card.appendChild(cardBody);

    // ── Persona title (always visible in body) ────────────────
    cardBody.appendChild(el('div', { className: 'adv-card-body-title' }, `${persona.name || pid} Advisor`));

    // ── Description: focus areas ───────────────────────────────
    const focusAreas = persona.focusAreas || [];
    if (focusAreas.length > 0) {
      const descEl = el('div', { className: 'adv-custom-desc' });
      const list = el('ul', { className: 'adv-custom-focus-list' });
      for (const area of focusAreas) {
        list.appendChild(el('li', {}, area));
      }
      descEl.appendChild(list);
      cardBody.appendChild(descEl);
    }

    // ── Focus prompt area ──────────────────────────────────────
    const customFocusCounter = el('span', { className: 'adv-focus-counter' }, '0 / 256');

    const customFocusTextarea = el('textarea', {
      className: 'adv-focus-textarea',
      id: `adv-focus-${pid}`,
      placeholder: 'e.g. review the advisor deduplication logic',
      maxlength: '256',
      rows: '2',
      onInput: () => {
        const len = customFocusTextarea.value.length;
        customFocusCounter.textContent = `${len} / 256`;
        customFocusCounter.className = 'adv-focus-counter' + (len > 240 ? ' adv-focus-counter-warn' : '');
      },
    });

    const customChipsEl = el('div', { className: 'adv-focus-chips adv-hidden' });

    // Focus area starts expanded by default (primary control); only collapses after
    // a focus prompt has been saved. The toggle lets users re-collapse/expand manually.
    const customFocusToggleBtn = el('button', {
      className: 'adv-focus-toggle',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `adv-focus-area-${pid}`,
      onClick: () => {
        const isExpanded = customFocusToggleBtn.getAttribute('aria-expanded') === 'true';
        customFocusToggleBtn.setAttribute('aria-expanded', String(!isExpanded));
        customFocusArea.classList.toggle('adv-focus-area-open', !isExpanded);
        const savedText = customFocusToggleBtn.dataset.savedFocus || '';
        if (isExpanded) {
          // Collapsing — show preview if there's a saved prompt
          customFocusToggleBtn.textContent = savedText ? 'Focus● ▸' : 'Focus ▸';
          customFocusToggleBtn.title = savedText
            ? `Saved focus active: "${savedText}"`
            : 'Set a focus area for the next run';
          // Show inline preview when collapsing
          const previewEl = this._cards[pid]?.focusPreviewEl;
          if (previewEl && savedText) {
            const maxLen = 40;
            const preview = savedText.length > maxLen ? savedText.slice(0, maxLen) + '…' : savedText;
            previewEl.textContent = preview;
            previewEl.title = savedText;
            previewEl.className = 'adv-focus-preview';
          }
        } else {
          // Expanding — hide preview
          customFocusToggleBtn.textContent = savedText ? 'Focus● ▾' : 'Focus ▾';
          const previewEl = this._cards[pid]?.focusPreviewEl;
          if (previewEl) {
            previewEl.textContent = '';
            previewEl.className = 'adv-focus-preview adv-hidden';
          }
          customFocusTextarea.focus();
        }
        this._focusManuallyToggled = this._focusManuallyToggled || {};
        this._focusManuallyToggled[pid] = true;
      },
    }, 'Focus ▾');

    // Unsaved-changes dot — shown while the user is typing before auto-save fires (DK-315).
    const customFocusDirtyDot = el('span', {
      className: 'adv-focus-dirty-dot adv-hidden',
      title: 'Unsaved changes — will auto-save shortly',
      'aria-hidden': 'true',
    }, '●');

    const customSavedFocusEl = el('div', { className: 'adv-saved-focus adv-hidden' });

    const customFocusArea = el('div', {
      className: 'adv-focus-area adv-focus-area-open',
      id: `adv-focus-area-${pid}`,
    },
      el('div', { className: 'adv-focus-header' },
        el('label', { className: 'adv-focus-label', htmlFor: `adv-focus-${pid}` }, 'Focus area (optional)'),
        customFocusCounter,
      ),
      customFocusTextarea,
      customChipsEl,
      el('div', { className: 'adv-focus-actions' },
        customFocusDirtyDot,
        customSavedFocusEl,
      ),
    );

    // Attach auto-save behavior (DK-315): debounce-on-input (800ms) + save on blur.
    const customFocusSaveControl = createSaveOnBlur({
      element: customFocusTextarea,
      onSave: async (value) => {
        await this._autoSaveFocusPrompt(pid, value);
      },
      debounceMs: 800,
      autoSaveOnInput: true,
      showIndicator: true,
      indicatorPosition: 'inline',
      autoFadeAfterMs: 2000,
      onDirtyChange: (dirty) => {
        customFocusDirtyDot.classList.toggle('adv-hidden', !dirty);
      },
    });
    this._focusSaveControls[pid] = customFocusSaveControl;

    // ── Inline Run-prompt expander (DK-321) ───────────────────────────────
    const customRunPromptHintId = `adv-run-prompt-hint-${pid}`;
    const customRunPromptInput = el('input', {
      type: 'text',
      className: 'adv-run-prompt-input',
      placeholder: 'focus on the new auth module',
      maxlength: '150',
      'aria-label': 'Optional focus for this run only',
      'aria-describedby': customRunPromptHintId,
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submitRunPrompt(pid); }
        if (e.key === 'Escape') { e.preventDefault(); this._closeRunPrompt(pid); }
      },
    });
    const customRunPromptCounter = el('span', { className: 'adv-run-prompt-counter' }, '0 / 150');
    customRunPromptInput.addEventListener('input', () => {
      const len = customRunPromptInput.value.length;
      customRunPromptCounter.textContent = `${len} / 150`;
      customRunPromptCounter.className = 'adv-run-prompt-counter' + (len > 130 ? ' adv-run-prompt-counter-warn' : '');
    });
    const customRunPromptSubmitBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-submit',
      onClick: () => this._submitRunPrompt(pid),
    }, 'Run');
    const customRunPromptCancelBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-cancel',
      onClick: () => this._closeRunPrompt(pid),
    }, 'Cancel');
    const customRunPromptExpander = el('div', {
      className: 'adv-run-prompt-expander adv-hidden',
      id: `adv-run-prompt-${pid}`,
      role: 'group',
      'aria-label': 'Run with optional focus prompt',
    },
      el('div', { className: 'adv-run-prompt-header' },
        el('span', { className: 'adv-run-prompt-hint', id: customRunPromptHintId }, 'Optional — override for this run only'),
        customRunPromptCounter,
      ),
      customRunPromptInput,
      el('div', { className: 'adv-run-prompt-actions' },
        customRunPromptSubmitBtn,
        customRunPromptCancelBtn,
      ),
    );

    cardBody.appendChild(customRunPromptExpander);
    cardBody.appendChild(
      el('div', { className: 'adv-focus-row' },
        el('div', { className: 'adv-run-state-row' },
          runStateEl,
          timeHintEl,
        ),
      )
    );
    cardBody.appendChild(customFocusArea);

    // ── Last activity ──────────────────────────────────────────
    const activityEl = el('div', { className: 'adv-activity' }, '—');
    cardBody.appendChild(activityEl);

    // ── Recent output snippets ─────────────────────────────────
    // Shows last run summary so user can see if persona is producing useful output
    const runSummaryEl = el('div', { className: 'adv-run-summary' }, 'No runs yet');
    cardBody.appendChild(runSummaryEl);

    // ── Footer: next run info ──────────────────────────────────
    // aria-live="polite" so updates are announced to screen readers
    const countdownEl = el('span', {
      className: 'adv-countdown',
      'aria-live': 'polite',
    }, '—');

    // Show schedule label from intervalHours
    const intervalHours = persona.intervalHours || 24;
    const scheduleLabel = this._hoursToScheduleLabel(intervalHours);
    const scheduleEl = el('span', { className: 'adv-custom-schedule' }, scheduleLabel);

    cardBody.appendChild(
      el('div', { className: 'adv-card-footer' },
        el('div', { className: 'adv-countdown-row' },
          el('span', { className: 'adv-countdown-label' }, 'Next run'),
          countdownEl,
        ),
        el('div', { className: 'adv-custom-schedule-row' },
          el('span', { className: 'adv-interval-label' }, 'Schedule'),
          scheduleEl,
        ),
      )
    );

    // ── Performance subsection (custom card, collapsible) ───────
    // Starts collapsed by default (expanded key absent from set)
    const customPerfSectionKey = `${pid}:performance`;
    const customPerfSectionExpanded = this._collapsedCardSections.has(customPerfSectionKey);
    const customPerfChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, customPerfSectionExpanded ? '▾' : '▸');
    const customPerfSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(customPerfSectionExpanded),
      'aria-controls': `adv-perf-section-${pid}`,
      onClick: () => this._toggleCardSection(customPerfSectionKey, customPerfSectionBody, customPerfChevron, customPerfSectionHeader),
    },
      customPerfChevron,
      el('span', {}, 'Performance'),
    );
    cardBody.appendChild(customPerfSectionHeader);

    const customPerfSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-perf-section-${pid}`,
    });
    if (!customPerfSectionExpanded) customPerfSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(customPerfSectionBody);

    // ── Stats row ──────────────────────────────────────────────
    const ticketsEl = el('span', { className: 'adv-stat-val' }, '0');
    const cyclesEl  = el('span', { className: 'adv-stat-val' }, '0');

    customPerfSectionBody.appendChild(
      el('div', { className: 'adv-stats' },
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Tickets '),
          ticketsEl,
        ),
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Cycles '),
          cyclesEl,
        ),
      )
    );

    // ── Activity subsection (custom card, collapsible) ──────────
    // Starts collapsed by default (expanded key absent from set)
    const customActSectionKey = `${pid}:activity`;
    const customActSectionExpanded = this._collapsedCardSections.has(customActSectionKey);
    const customActChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, customActSectionExpanded ? '▾' : '▸');
    const customActSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(customActSectionExpanded),
      'aria-controls': `adv-act-section-${pid}`,
      onClick: () => this._toggleCardSection(customActSectionKey, customActSectionBody, customActChevron, customActSectionHeader),
    },
      customActChevron,
      el('span', {}, 'Activity'),
    );
    cardBody.appendChild(customActSectionHeader);

    const customActSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-act-section-${pid}`,
    });
    if (!customActSectionExpanded) customActSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(customActSectionBody);

    // ── Per-card history (collapsed by default) ─────────────────
    const customHistoryToggleBtn = el('button', {
      className: 'adv-card-history-toggle',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `adv-card-history-${pid}`,
      onClick: () => this._toggleCardHistory(pid),
    }, 'History ▸');

    const customHistoryRefreshBtn = el('button', {
      className: 'adv-history-refresh-btn adv-hidden',
      title: 'Refresh run history',
      'aria-label': 'Refresh history',
      onClick: () => this._loadHistoryRuns(pid),
    }, '↺');

    // Inline preview of the saved focus prompt — visible when focus area is collapsed
    // and a saved focus prompt is set. Hidden when expanded or no saved prompt.
    const customFocusPreviewEl = el('span', {
      className: 'adv-focus-preview adv-hidden',
      'aria-hidden': 'true',
    });

    const customHistoryHeaderRow = el('div', { className: 'adv-card-history-header' },
      customFocusToggleBtn,
      customFocusPreviewEl,
      customHistoryToggleBtn,
      customHistoryRefreshBtn,
    );

    const customHistoryPanel = el('div', {
      className: 'adv-card-history-panel adv-hidden',
      id: `adv-card-history-${pid}`,
    });
    this._historyPanels[pid] = customHistoryPanel;

    customActSectionBody.appendChild(customHistoryHeaderRow);
    customActSectionBody.appendChild(customHistoryPanel);

    // Store card refs for live updates from _renderCard()
    this._cards[pid] = {
      card,
      cardBody,
      collapseBtn,
      avatarEl: null,
      statusDot,
      statusText,
      soulBtn: null,
      pauseBtn,
      pauseCheckbox: customPauseCheckbox,
      pauseTextEl: customPauseTextEl,
      runNowBtn,
      runPromptExpander: customRunPromptExpander,
      runPromptInput: customRunPromptInput,
      runPromptSubmitBtn: customRunPromptSubmitBtn,
      runPromptCancelBtn: customRunPromptCancelBtn,
      runStateEl,
      timeHintEl,
      focusTextarea: customFocusTextarea,
      focusToggleBtn: customFocusToggleBtn,
      focusPreviewEl: customFocusPreviewEl,
      focusDirtyDot: customFocusDirtyDot,
      savedFocusEl: customSavedFocusEl,
      activityEl,
      logToggleBtn: null,
      logContainer: null,
      logList: null,
      countdownEl,
      intervalInput: null,
      ticketsEl,
      cyclesEl,
      runSummaryEl,
      scheduleEl,
      historyToggleBtn: customHistoryToggleBtn,
      historyRefreshBtn: customHistoryRefreshBtn,
      historyPanel: customHistoryPanel,
    };

    return card;
  },

  /** Convert intervalHours to a human-readable schedule label. */
  _hoursToScheduleLabel(hours) {
    for (const preset of SCHEDULE_PRESETS) {
      if (preset.hours === hours) return preset.label;
    }
    return `Every ${hours}h`;
  },

  // ── Custom persona modal ──────────────────────────────────────

  /**
   * Open the single-scroll custom persona create/edit modal.
   * All fields (Name, Focus, Prompt, Model, Schedule) are shown at once
   * with a live preview card in the right panel.
   *
   * @param {string|null} personaId - null to create new, string to edit existing
   */
  _openCustomPersonaModal(personaId) {
    this._closeCustomModal();

    // Find existing persona data if editing
    const existing = personaId
      ? this._customPersonas.find(p => (p.id || p._docId) === personaId)
      : null;

    // State for the modal form
    const formState = {
      name: existing?.name || '',
      systemPrompt: existing?.systemPrompt || CUSTOM_PERSONA_STARTER,
      model: existing?.model || 'claude-sonnet-4-6',
      intervalHours: existing?.intervalHours || 24,
      focusAreas: existing?.focusAreas ? existing.focusAreas.join(', ') : '',
      isEditing: !!existing,
      originalId: personaId || null,
    };

    // Overlay
    const overlay = el('div', {
      className: 'adv-custom-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeCustomModal(); },
    });

    // Modal box (wider to accommodate side-by-side layout)
    const modal = el('div', {
      className: 'adv-custom-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-custom-modal-title',
    });
    overlay.appendChild(modal);

    // Header
    const titleEl = el('div', {
      className: 'adv-custom-modal-title',
      id: 'adv-custom-modal-title',
    }, formState.isEditing ? `Edit "${existing.name}"` : 'New Custom Persona');

    const closeBtn = el('button', {
      className: 'adv-soul-modal-close',
      title: 'Close',
      'aria-label': 'Close modal',
      onClick: () => this._closeCustomModal(),
    }, '×');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' }, titleEl, closeBtn)
    );

    // Live preview card
    const previewCard = el('div', { className: 'adv-card adv-card-custom adv-card-preview' });
    const previewPane = el('div', { className: 'adv-custom-preview-pane' },
      el('div', { className: 'adv-custom-preview-label' }, 'Preview'),
      previewCard,
    );

    // Single-scroll form (all fields visible at once)
    const formPane = el('div', { className: 'adv-custom-form-pane' });
    this._renderCustomModalForm(formPane, previewCard, formState);

    // Two-column body: form | preview
    modal.appendChild(
      el('div', { className: 'adv-custom-modal-body' }, formPane, previewPane)
    );

    // Footer with status + action buttons
    const statusEl = el('span', { className: 'adv-soul-status' });

    const saveBtn = el('button', {
      className: 'adv-custom-save-btn',
      onClick: async () => {
        await this._saveCustomPersona(formState, saveBtn, statusEl);
      },
    }, formState.isEditing ? 'Save Changes' : 'Create Persona');

    // Delete button (only shown when editing)
    let deleteBtn = null;
    if (formState.isEditing) {
      deleteBtn = el('button', {
        className: 'adv-custom-delete-btn',
        onClick: () => this._confirmDeleteCustomPersona(personaId, existing.name),
      }, 'Delete');
    }

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          deleteBtn,
          saveBtn,
        ),
      )
    );

    // Initialize preview card
    this._updatePreviewCard(previewCard, formState);

    document.body.appendChild(overlay);
    this._customModal = overlay;

    // Focus the first input
    setTimeout(() => {
      const firstInput = modal.querySelector('input, textarea, select');
      if (firstInput) firstInput.focus();
    }, 50);
  },

  /**
   * Render all form fields into the given container.
   * All sections (Name & Role, Prompt/Instructions, Schedule defaults) are
   * rendered at once in a single scrollable column — no step navigation needed.
   */
  _renderCustomModalForm(formPane, previewCard, formState) {
    // ── Section: Name & Role ──────────────────────────────────

    formPane.appendChild(
      el('div', { className: 'adv-custom-section-heading' }, 'Name & Role')
    );

    // Name field
    const nameLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-name',
    }, 'Persona Name');
    const nameInput = el('input', {
      id: 'adv-custom-name',
      className: 'adv-custom-input',
      type: 'text',
      placeholder: 'e.g. Accessibility, i18n, SEO…',
      maxlength: '64',
      value: formState.name,
    });
    nameInput.addEventListener('input', () => {
      formState.name = nameInput.value;
      this._updatePreviewCard(previewCard, formState);
    });

    formPane.appendChild(nameLabel);
    formPane.appendChild(nameInput);

    // Focus areas field
    const focusLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-focus',
    }, 'Focus Areas (comma-separated, optional)');
    const focusInput = el('input', {
      id: 'adv-custom-focus',
      className: 'adv-custom-input',
      type: 'text',
      placeholder: 'e.g. WCAG 2.1 AA, keyboard navigation, color contrast',
      value: formState.focusAreas,
    });
    focusInput.addEventListener('input', () => {
      formState.focusAreas = focusInput.value;
      this._updatePreviewCard(previewCard, formState);
    });

    formPane.appendChild(focusLabel);
    formPane.appendChild(focusInput);

    // ── Section: Prompt / Instructions ───────────────────────

    formPane.appendChild(
      el('div', { className: 'adv-custom-section-heading' }, 'Prompt / Instructions')
    );

    // System prompt field
    const promptLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-prompt',
    }, 'System Prompt');

    // "View built-in example" link — opens Engineer persona's system prompt read-only.
    // Primary tool for reducing blank-page paralysis (spec requirement).
    const viewExampleBtn = el('button', {
      className: 'adv-custom-example-link',
      type: 'button',
      title: 'See an example of a built-in persona prompt',
      onClick: () => this._openBuiltInExampleModal(),
    }, 'View built-in example ▸');

    const promptLabelRow = el('div', { className: 'adv-custom-label-row' },
      promptLabel,
      viewExampleBtn,
    );

    const promptCharCount = el('span', { className: 'adv-custom-char-count' }, `${formState.systemPrompt.length} chars`);
    const promptHint = el('div', { className: 'adv-custom-hint' },
      'Defines what this persona reviews and how it reasons. Pre-filled with a starter template.'
    );
    const promptTextarea = el('textarea', {
      id: 'adv-custom-prompt',
      className: 'adv-custom-textarea',
      rows: '8',
      placeholder: 'Describe the persona\'s focus and review criteria…',
    });
    promptTextarea.value = formState.systemPrompt;
    promptTextarea.addEventListener('input', () => {
      formState.systemPrompt = promptTextarea.value;
      promptCharCount.textContent = `${promptTextarea.value.length} chars`;
      this._updatePreviewCard(previewCard, formState);
    });

    // "Preview prompt" button — shows the assembled prompt (system prompt + context bundle).
    const previewPromptBtn = el('button', {
      className: 'adv-custom-preview-prompt-btn',
      type: 'button',
      title: 'Preview the full prompt that will be sent to the model',
      onClick: () => this._openPromptPreviewModal(formState),
    }, 'Preview prompt');

    formPane.appendChild(promptLabelRow);
    formPane.appendChild(promptHint);
    formPane.appendChild(promptTextarea);
    formPane.appendChild(
      el('div', { className: 'adv-custom-prompt-footer' },
        promptCharCount,
        previewPromptBtn,
      )
    );

    // ── Section: Schedule defaults ───────────────────────────

    formPane.appendChild(
      el('div', { className: 'adv-custom-section-heading' }, 'Schedule defaults')
    );

    // Model selection
    const modelLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-model',
    }, 'Model');

    const modelSelect = el('select', {
      id: 'adv-custom-model',
      className: 'adv-custom-select',
    });
    for (const { value, label } of CUSTOM_PERSONA_MODELS) {
      const opt = el('option', { value }, label);
      if (value === formState.model) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    modelSelect.addEventListener('change', () => {
      formState.model = modelSelect.value;
      this._updatePreviewCard(previewCard, formState);
    });

    formPane.appendChild(modelLabel);
    formPane.appendChild(modelSelect);

    // Schedule selection
    const scheduleLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-schedule',
    }, 'Schedule');

    const scheduleHint = el('div', { className: 'adv-custom-hint' },
      'Minimum interval is every 1 hour.'
    );

    const scheduleSelect = el('select', {
      id: 'adv-custom-schedule',
      className: 'adv-custom-select',
    });

    // Check if current intervalHours matches a preset
    const matchedPreset = SCHEDULE_PRESETS.find(p => p.hours === formState.intervalHours);
    const isCustom = !matchedPreset || matchedPreset.hours === null;

    for (const preset of SCHEDULE_PRESETS) {
      const opt = el('option', { value: preset.hours !== null ? String(preset.hours) : 'custom' }, preset.label);
      if ((preset.hours === formState.intervalHours) || (preset.hours === null && isCustom)) {
        opt.selected = true;
      }
      scheduleSelect.appendChild(opt);
    }

    // Custom hours input (shown only when "Custom…" is selected)
    const customHoursWrapper = el('div', { className: 'adv-custom-hours-wrapper' });
    const customHoursLabel = el('label', {
      className: 'adv-custom-label',
      for: 'adv-custom-hours',
    }, 'Custom interval (hours, minimum 1)');
    const customHoursInput = el('input', {
      id: 'adv-custom-hours',
      className: 'adv-custom-input',
      type: 'number',
      min: '1',
      max: '8760',
      value: String(formState.intervalHours),
    });
    customHoursWrapper.appendChild(customHoursLabel);
    customHoursWrapper.appendChild(customHoursInput);
    customHoursWrapper.style.display = isCustom ? '' : 'none';

    customHoursInput.addEventListener('input', () => {
      const h = parseInt(customHoursInput.value, 10);
      if (Number.isFinite(h) && h >= 1) {
        formState.intervalHours = h;
        this._updatePreviewCard(previewCard, formState);
      }
    });

    scheduleSelect.addEventListener('change', () => {
      const val = scheduleSelect.value;
      if (val === 'custom') {
        customHoursWrapper.style.display = '';
        customHoursInput.focus();
      } else {
        customHoursWrapper.style.display = 'none';
        formState.intervalHours = parseInt(val, 10);
        this._updatePreviewCard(previewCard, formState);
      }
    });

    formPane.appendChild(scheduleLabel);
    formPane.appendChild(scheduleHint);
    formPane.appendChild(scheduleSelect);
    formPane.appendChild(customHoursWrapper);

    // Tool permissions note
    formPane.appendChild(
      el('div', { className: 'adv-custom-permissions-note' },
        'Custom personas run with the same scoped tool permissions as built-in personas. No elevated access.'
      )
    );
  },

  /**
   * Update the live preview card based on current form state.
   */
  _updatePreviewCard(previewCard, formState) {
    previewCard.innerHTML = '';

    const name = formState.name.trim() || 'Untitled';
    const scheduleLabel = this._hoursToScheduleLabel(formState.intervalHours);
    const modelLabel = CUSTOM_PERSONA_MODELS.find(m => m.value === formState.model)?.label || formState.model;

    previewCard.appendChild(
      el('div', { className: 'adv-card-header' },
        el('div', { className: 'adv-card-header-left' },
          el('span', { className: 'adv-dot adv-dot-idle' }),
          el('span', { className: 'adv-persona-label' }, name),
          el('span', { className: 'adv-custom-badge' }, 'Custom'),
          el('span', { className: 'adv-status-text' }, 'Idle'),
        ),
      )
    );

    // Focus areas preview
    if (formState.focusAreas.trim()) {
      const areas = formState.focusAreas.split(',').map(s => s.trim()).filter(Boolean);
      if (areas.length > 0) {
        previewCard.appendChild(
          el('div', { className: 'adv-custom-focus-preview' },
            areas.map(a => el('span', { className: 'adv-focus-tag' }, a))
          )
        );
      }
    }

    previewCard.appendChild(
      el('div', { className: 'adv-card-footer' },
        el('div', { className: 'adv-custom-schedule-row' },
          el('span', { className: 'adv-interval-label' }, 'Schedule'),
          el('span', { className: 'adv-custom-schedule' }, scheduleLabel),
        ),
        el('div', { className: 'adv-custom-schedule-row' },
          el('span', { className: 'adv-interval-label' }, 'Model'),
          el('span', { className: 'adv-custom-schedule' }, modelLabel),
        ),
      )
    );
  },

  /** Validate all form fields. Returns error string or null. */
  _validateForm(formState) {
    const name = formState.name.trim();
    if (!name) return 'Persona name is required.';
    if (RESERVED_NAMES.has(name)) return `"${name}" is a reserved name. Choose a different name.`;
    if (name.length > 64) return 'Name must be 64 characters or fewer.';

    // Check for name collision with existing custom personas (when creating new)
    if (!formState.isEditing) {
      const newId = slugifyName(name);
      const collision = this._customPersonas.find(p => (p.id || p._docId) === newId);
      if (collision) return `A persona named "${collision.name}" already exists.`;
    }

    if (!formState.systemPrompt.trim()) return 'System prompt is required.';
    return null;
  },

  _closeCustomModal() {
    if (this._customModal) {
      if (this._customModal.parentNode) this._customModal.parentNode.removeChild(this._customModal);
      this._customModal = null;
    }
  },

  /**
   * Open a read-only view of the Engineer persona's system prompt.
   * Reduces blank-page paralysis when writing a new custom persona prompt.
   */
  _openBuiltInExampleModal() {
    const overlay = el('div', {
      className: 'adv-custom-overlay adv-example-overlay',
      onClick: (e) => { if (e.target === overlay) overlay.parentNode?.removeChild(overlay); },
    });

    const modal = el('div', {
      className: 'adv-custom-modal adv-example-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-example-modal-title',
    });

    const closeBtn = el('button', {
      className: 'adv-soul-modal-close',
      title: 'Close',
      'aria-label': 'Close example',
      onClick: () => overlay.parentNode?.removeChild(overlay),
    }, '×');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', {
          className: 'adv-custom-modal-title',
          id: 'adv-example-modal-title',
        }, 'Built-in Example: Engineer Persona'),
        closeBtn,
      )
    );

    const promptEl = el('pre', {
      className: 'adv-example-prompt',
      'aria-label': 'Engineer persona system prompt (read-only)',
    });
    // Use textContent — never innerHTML — to safely display the prompt
    promptEl.textContent = DEFAULT_SOUL_PROMPTS.engineer;

    modal.appendChild(
      el('div', { className: 'adv-example-modal-body' },
        el('p', { className: 'adv-custom-hint' },
          'This is the Engineer persona\'s default system prompt. Use it as a reference when writing your own.'
        ),
        promptEl,
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Keyboard dismiss
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.parentNode?.removeChild(overlay);
    });

    setTimeout(() => closeBtn.focus(), 50);
  },

  /**
   * Open a modal showing the assembled prompt preview for a custom persona.
   * Shows: system prompt + the standard context bundle description.
   * This surfaces what the model will actually receive.
   *
   * @param {object} formState - Current form state
   */
  _openPromptPreviewModal(formState) {
    const name = formState.name.trim() || 'Untitled';
    const systemPrompt = formState.systemPrompt.trim() || '(no system prompt)';

    // Build a representative preview of the assembled prompt
    const projectContext = this._projects.find(p => p.id === this._filterProjectId)?.advisorContext || '';
    const contextSection = projectContext
      ? `## Project Context\n${projectContext}\n\n`
      : '(no project context — add context in project settings)\n\n';

    const preview = [
      '=== SYSTEM PROMPT ===',
      systemPrompt,
      '',
      '=== USER PROMPT (assembled by daemon) ===',
      contextSection + 'You are reviewing this project. Based on your focus areas and the project context above, identify the most important issues or improvements.\n\nRespond with a JSON array...',
      '',
      '--- Note: The daemon appends the project context, rejection history, and focus prompt at runtime. ---',
    ].join('\n');

    const overlay = el('div', {
      className: 'adv-custom-overlay adv-preview-overlay',
      onClick: (e) => { if (e.target === overlay) overlay.parentNode?.removeChild(overlay); },
    });

    const modal = el('div', {
      className: 'adv-custom-modal adv-preview-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-preview-modal-title',
    });

    const closeBtn = el('button', {
      className: 'adv-soul-modal-close',
      title: 'Close',
      'aria-label': 'Close prompt preview',
      onClick: () => overlay.parentNode?.removeChild(overlay),
    }, '×');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', {
          className: 'adv-custom-modal-title',
          id: 'adv-preview-modal-title',
        }, `Prompt Preview: ${name}`),
        closeBtn,
      )
    );

    const promptEl = el('pre', {
      className: 'adv-example-prompt',
      'aria-label': `Assembled prompt preview for ${name} persona`,
    });
    // Use textContent — never innerHTML
    promptEl.textContent = preview;

    modal.appendChild(
      el('div', { className: 'adv-example-modal-body' },
        el('p', { className: 'adv-custom-hint' },
          'This shows what the model will receive. The daemon appends project context, rejection history, and any focus prompt at runtime.'
        ),
        promptEl,
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.parentNode?.removeChild(overlay);
    });

    setTimeout(() => closeBtn.focus(), 50);
  },

  // ── Custom persona save / delete ─────────────────────────────

  /**
   * Save a custom persona to Firestore /advisorPersonas/{id}.
   * Also writes to /advisor/{id} to initialize state if creating new.
   */
  async _saveCustomPersona(formState, saveBtn, statusEl) {
    // Validate all fields before saving
    const validationError = this._validateForm(formState);
    if (validationError) {
      statusEl.textContent = validationError;
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    // Enforce maximum of 10 custom personas per project (client-side check)
    const MAX_CUSTOM_PERSONAS = 10;
    if (!formState.isEditing && this._customPersonas.length >= MAX_CUSTOM_PERSONAS) {
      statusEl.textContent = `Maximum of ${MAX_CUSTOM_PERSONAS} custom personas reached.`;
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    const name = sanitizePromptValue(formState.name.trim());
    const systemPrompt = formState.systemPrompt.replace(/<\/?system>|<\|/g, '').trim();
    const model = formState.model || 'claude-sonnet-4-6';
    const intervalHours = Math.max(1, Number(formState.intervalHours) || 24);
    const focusAreas = formState.focusAreas
      ? formState.focusAreas.split(',').map(s => sanitizePromptValue(s.trim())).filter(Boolean)
      : [];

    const id = formState.originalId || slugifyName(name);

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    try {
      const personaData = { type: 'custom', id, name, systemPrompt, model, intervalHours, focusAreas };

      // Write persona definition to /advisorPersonas/{id}
      await this.db.collection('advisorPersonas').doc(id).set(personaData);

      // Initialize state document in /advisor/{id} if creating new
      if (!formState.isEditing) {
        const stateRef = this.db.collection('advisor').doc(id);
        const stateSnap = await stateRef.get();
        if (!stateSnap.exists) {
          await stateRef.set({
            status: 'idle',
            intervalHours,
            lastRunAt: null,
            nextRunAt: null,
            lastActivity: null,
            activityLog: [],
            cycleCount: 0,
            ticketsCreated: 0,
            error: null,
            startedAt: new Date().toISOString(),
            runNow: null,
            soulPrompt: null,
          });
        }
      } else {
        // Update interval on state doc when editing
        await this.db.collection('advisor').doc(id).set({ intervalHours }, { merge: true });
      }

      statusEl.textContent = formState.isEditing ? 'Saved' : 'Persona created';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';

      // Announce to screen readers
      if (this._liveRegion) {
        this._liveRegion.textContent = formState.isEditing
          ? `"${name}" persona updated.`
          : `"${name}" persona created.`;
        setTimeout(() => { if (this._liveRegion) this._liveRegion.textContent = ''; }, 3000);
      }

      setTimeout(() => this._closeCustomModal(), 800);
    } catch (err) {
      console.error('Failed to save custom persona:', err);
      statusEl.textContent = 'Error saving persona';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  },

  /**
   * Show a confirmation dialog before deleting a custom persona.
   * Echoes the persona name in the confirmation prompt.
   */
  async _confirmDeleteCustomPersona(personaId, personaName) {
    this._closeCustomModal();

    const confirmed = await showConfirmModal({
      title: `Delete "${personaName}"?`,
      message: 'Past tickets generated by this persona are not affected. Future runs will stop.',
      confirm: 'Delete',
      danger: true,
    });
    if (!confirmed) return;

    await this._deleteCustomPersona(personaId, personaName, null, null);
  },

  /**
   * Delete a custom persona from Firestore /advisorPersonas/{id}.
   * Does NOT delete the /advisor/{id} state doc (preserves run history).
   */
  async _deleteCustomPersona(personaId, personaName, statusEl, onSuccess) {
    try {
      await this.db.collection('advisorPersonas').doc(personaId).delete();

      // Announce to screen readers
      if (this._liveRegion) {
        this._liveRegion.textContent = `"${personaName}" persona deleted.`;
        setTimeout(() => { if (this._liveRegion) this._liveRegion.textContent = ''; }, 3000);
      }

      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Failed to delete custom persona:', err);
      if (statusEl) {
        statusEl.textContent = 'Error deleting persona';
        statusEl.className = 'adv-soul-status adv-soul-status-err';
      }
    }
  }
};
