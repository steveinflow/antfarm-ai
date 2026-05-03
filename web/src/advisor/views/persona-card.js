// _buildPersonaCard — the monolithic builder for one persona card.
// Constructs the full DOM tree (header, controls, run results, history,
// performance, schedule, scope, weights, ticket cap, etc.) for a single
// built-in persona. Returns the populated `this._cards[id]` ref bag.

import { el } from '../ui/el.js';
import {
  PERSONA_INTERVAL_HINTS,
  PERSONA_DIRECTIVE_PLACEHOLDERS,
  PERSONA_DIRECTIVE_DESCRIPTIONS,
} from '../config/personas.js';
import {
  PERSONA_CONCERNS,
  CONCERN_META,
  WEIGHT_PRESETS,
} from '../config/concerns.js';
import { buildWeightSummary, createAvatarEl } from '../helpers/persona.js';
import { createSaveOnBlur } from '../../save-on-blur.js';

export const personaCardMixin = {
  _buildPersonaCard({ id, label, defaultHours }) {
    const card = el('div', { className: 'adv-card' });

    // ── Collapse toggle ────────────────────────────────────────
    const isInitiallyCollapsed = this._collapsedPersonas.has(id);
    const collapseBtn = el('button', {
      className: 'adv-collapse-btn',
      title: isInitiallyCollapsed ? 'Expand' : 'Collapse',
      'aria-expanded': String(!isInitiallyCollapsed),
      'aria-controls': `adv-card-body-${id}`,
      onClick: () => this._toggleCardCollapse(id),
    }, isInitiallyCollapsed ? '▸' : '▾');

    // ── Card header ────────────────────────────────────────────
    const statusDot  = el('span', { className: 'adv-dot adv-dot-unknown', title: 'Advisor offline' });
    const statusText = el('span', { className: 'adv-status-text' }, 'Waiting…');

    // Soul button — label included so it's clear which advisor's soul this edits
    const soulBtn = el('button', {
      className: 'adv-soul-btn',
      title: `Edit ${label} soul prompt`,
      onClick: () => this._openSoulModal(id, label),
    }, `${label} Soul`);

    // DK-365: Constraints button — opens constraint config modal
    // Only shown for the product persona (constraints are a product-focus feature)
    const constraintsBtn = id === 'product' ? el('button', {
      className: 'adv-constraints-btn',
      title: 'Configure persona constraints (budget, platform, complexity, risk)',
      'aria-label': 'Configure constraints for Product persona',
      onClick: () => this._openConstraintModal(id, label),
    }, 'Constraints') : null;

    // DK-365: Constraint chip — shown in header when constraints are active
    // Hidden until constraints are set for this persona + project
    const constraintChipEl = id === 'product' ? el('span', {
      className: 'adv-constraint-chip adv-hidden',
      title: 'Constraints are active — click Constraints to view or edit',
      'aria-label': 'Constraints active',
    }) : null;
    if (constraintChipEl) this._constraintChipEls[id] = constraintChipEl;

    // Pause toggle — labeled button per DK-111 spec.
    // Button text reads "Pause <Name>" / "Resume <Name>".
    // aria-label includes the persona name: "Pause <Name> persona" / "Resume <Name> persona".
    // Disabled while the persona is running (in-progress guard per spec).
    // pauseCheckbox and pauseTextEl are kept as null so existing _renderCard
    // branches that check card.pauseCheckbox/pauseTextEl degrade gracefully.
    const pauseCheckbox = null;
    const pauseTextEl = null;
    const pauseBtn = el('button', {
      type: 'button',
      className: 'adv-pause-btn',
      'aria-label': `Pause ${label} persona`,
      onClick: () => this._togglePause(id),
    }, `Pause ${label}`);

    // Run now button — opens inline prompt expander (DK-321)
    const runNowBtn = el('button', {
      className: 'adv-run-now-btn',
      'aria-label': `Run ${label} persona now`,
      'aria-expanded': 'false',
      'aria-controls': `adv-run-prompt-${id}`,
      title: 'Run now',
      onClick: () => this._toggleRunPrompt(id),
    }, 'Run Now');

    // Stats toggle button — opens the performance dashboard expansion
    const statsBtn = el('button', {
      className: 'adv-stats-btn',
      title: 'View performance stats',
      'aria-expanded': 'false',
      onClick: () => this._togglePerfDash(id),
    }, 'Stats ▸');

    // Run state label — shown below the button row while/after running
    const runStateEl = el('div', {
      className: 'adv-run-state',
      'aria-live': 'polite',
      role: 'status',
    });

    // Time hint
    const timeHintEl = el('span', { className: 'adv-run-time-hint' }, 'Usually 30–60s');

    // Compact summary shown only when the card is collapsed.
    // Displays next-run countdown or current status inline in the header.
    const collapsedSummaryEl = el('span', {
      className: 'adv-card-collapsed-summary',
      'aria-hidden': 'true',
    });

    // Inline countdown shown in the card header, next to the pause button.
    // Hidden when the card is collapsed (collapsed summary covers that case).
    // DK-111: Use <time> element so datetime attribute can carry machine-readable ISO value.
    const headerCountdownEl = el('time', {
      className: 'adv-header-countdown',
      'aria-live': 'polite',
    }, '—');

    // DK-134: Scope config drawer — chip-based UI for path filters + topic tags.
    // Engineer: include path chips + exclude path chips + topic tag chips.
    // Design/Product: topic tag chips only.
    // Collapsed by default; gear icon in header toggles it open.
    const SCOPED_FOCUS_PERSONAS = new Set(['engineer', 'design', 'product']);
    let scopedFocusDotEl = null;
    let scopedFocusGearBtn = null;
    let scopedFocusDrawerEl = null;

    if (SCOPED_FOCUS_PERSONAS.has(id)) {
      // Initialize per-persona chip data
      this._scopedFocusChips[id] = { topics: [], include: [], exclude: [] };

      // Active dot — shown when any constraint is non-empty; hidden otherwise.
      scopedFocusDotEl = el('span', {
        className: 'adv-scope-dot adv-hidden',
        'aria-label': 'Scope constraints active',
        title: '',  // updated dynamically
        'aria-hidden': 'false',
      });

      // Gear icon button — toggles the inline drawer
      const scopedDrawerId = `adv-scope-drawer-${id}`;
      scopedFocusGearBtn = el('button', {
        type: 'button',
        className: 'adv-scope-gear-btn',
        title: 'Configure persona scope',
        'aria-label': `Configure scope for ${label} persona`,
        'aria-expanded': 'false',
        'aria-controls': scopedDrawerId,
        onClick: () => this._toggleScopedFocusDrawer(id),
      }, '⚙');

      // ── Chip builder helper (local to this card build) ────
      const makeChipList = (fieldKey, ariaLabel) => el('div', {
        className: 'adv-scope-chip-list',
        role: 'list',
        'aria-label': ariaLabel,
      });

      const makeChipInput = (inputId, placeholder, maxlen) => el('input', {
        type: 'text',
        id: inputId,
        className: 'adv-scope-chip-input',
        placeholder,
        maxlength: String(maxlen || 200),
        autocomplete: 'off',
      });

      // ── Topic tag chips ────────────────────────────────────
      const topicsChipListEl = makeChipList('topics', 'Active topic tags');
      const topicsInputId = `adv-scope-topics-input-${id}`;
      const topicsInputEl = makeChipInput(topicsInputId, 'Add topic tag…', 50);

      // Suggested tags on first open (reduced blank-slate friction)
      const SUGGESTED_TOPICS = ['performance', 'security', 'accessibility', 'billing'];
      const suggestedRow = el('div', { className: 'adv-scope-suggestions' },
        el('span', { className: 'adv-scope-suggestions-label' }, 'Suggestions: '),
        ...SUGGESTED_TOPICS.map(tag => el('button', {
          type: 'button',
          className: 'adv-scope-suggestion-chip',
          onClick: () => this._addScopedFocusChip(id, 'topics', tag),
        }, tag)),
      );

      topicsInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._addScopedFocusChipFromInput(id, 'topics', topicsInputEl); }
        if (e.key === 'Backspace' && !topicsInputEl.value) { e.preventDefault(); this._removeLastScopedFocusChip(id, 'topics'); }
      });

      const topicsAddBtn = el('button', {
        type: 'button',
        className: 'adv-scope-chip-add-btn',
        title: 'Add topic tag',
        onClick: () => this._addScopedFocusChipFromInput(id, 'topics', topicsInputEl),
      }, 'Add');

      const topicsField = el('div', { className: 'adv-scope-field' },
        el('label', { className: 'adv-scope-field-label', htmlFor: topicsInputId },
          'Topic focus',
          el('span', { className: 'adv-scope-field-hint-inline' }, ' — max 50 chars each')
        ),
        topicsChipListEl,
        el('div', { className: 'adv-scope-input-row' },
          topicsInputEl,
          topicsAddBtn,
        ),
        suggestedRow,
      );

      // ── Path filter chips (engineer only) ─────────────────
      let includeChipListEl = null;
      let includeInputEl = null;
      let excludeChipListEl = null;
      let excludeInputEl = null;
      let fileCountBadgeEl = null;
      let testScopeBtn = null;
      let pathsSection = null;

      if (id === 'engineer') {
        includeChipListEl = makeChipList('include', 'Active include path patterns');
        const includeInputId = `adv-scope-include-input-${id}`;
        includeInputEl = makeChipInput(includeInputId, 'e.g. src/auth/**', 200);

        includeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addScopedFocusChipFromInput(id, 'include', includeInputEl); }
          if (e.key === 'Backspace' && !includeInputEl.value) { e.preventDefault(); this._removeLastScopedFocusChip(id, 'include'); }
        });

        const includeAddBtn = el('button', {
          type: 'button',
          className: 'adv-scope-chip-add-btn',
          title: 'Add include pattern',
          onClick: () => this._addScopedFocusChipFromInput(id, 'include', includeInputEl),
        }, 'Add');

        excludeChipListEl = makeChipList('exclude', 'Active exclude path patterns');
        const excludeInputId = `adv-scope-exclude-input-${id}`;
        excludeInputEl = makeChipInput(excludeInputId, 'e.g. **/*.test.js', 200);

        excludeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addScopedFocusChipFromInput(id, 'exclude', excludeInputEl); }
          if (e.key === 'Backspace' && !excludeInputEl.value) { e.preventDefault(); this._removeLastScopedFocusChip(id, 'exclude'); }
        });

        const excludeAddBtn = el('button', {
          type: 'button',
          className: 'adv-scope-chip-add-btn',
          title: 'Add exclude pattern',
          onClick: () => this._addScopedFocusChipFromInput(id, 'exclude', excludeInputEl),
        }, 'Add');

        fileCountBadgeEl = el('span', {
          className: 'adv-scope-file-count adv-hidden',
          'aria-live': 'polite',
        });

        testScopeBtn = el('button', {
          type: 'button',
          className: 'adv-scope-test-btn',
          title: 'Test scope — resolve patterns against project root and count matching files',
          onClick: () => this._testScopedFocus(id),
        }, 'Test scope');

        pathsSection = el('div', { className: 'adv-scope-paths-section' },
          el('div', { className: 'adv-scope-field' },
            el('label', { className: 'adv-scope-field-label', htmlFor: includeInputId },
              'Path filters — include',
              el('span', { className: 'adv-scope-field-hint-inline' }, ' — glob patterns (e.g. src/auth/**)'),
            ),
            el('div', { className: 'adv-scope-glob-hint' }, 'Glob syntax: ', el('code', {}, 'src/auth/**'), ', ', el('code', {}, '**/*.test.js')),
            includeChipListEl,
            el('div', { className: 'adv-scope-input-row' },
              includeInputEl,
              includeAddBtn,
            ),
          ),
          el('div', { className: 'adv-scope-field' },
            el('label', { className: 'adv-scope-field-label', htmlFor: excludeInputId },
              'Path filters — exclude',
            ),
            excludeChipListEl,
            el('div', { className: 'adv-scope-input-row' },
              excludeInputEl,
              excludeAddBtn,
            ),
          ),
          el('div', { className: 'adv-scope-test-row' },
            testScopeBtn,
            fileCountBadgeEl,
          ),
        );
      }

      // ── Save status + controls ─────────────────────────────
      const saveStatusEl = el('span', {
        className: 'adv-scope-save-status',
        role: 'status',
        'aria-live': 'polite',
      });

      const noFilesWarningEl = el('div', {
        className: 'adv-scope-no-files-warning adv-hidden',
        role: 'alert',
      }, '0 files matched configured scope on last cycle — check your path patterns.');

      const clearScopeLink = el('button', {
        type: 'button',
        className: 'adv-scope-clear-link',
        title: 'Clear all scope constraints for this persona',
        onClick: () => this._clearScopedFocus(id),
      }, 'Clear scope');

      const saveBtn = el('button', {
        type: 'button',
        className: 'adv-scope-save-btn',
        onClick: () => this._saveScopedFocus(id),
      }, 'Save');

      const drawerInner = el('div', { className: 'adv-scope-drawer-inner' },
        el('div', { className: 'adv-scope-drawer-header' },
          el('span', { className: 'adv-scope-drawer-title' }, 'Scope'),
          el('span', { className: 'adv-scope-drawer-default' }, 'Entire codebase by default'),
          clearScopeLink,
        ),
        topicsField,
        pathsSection,
        noFilesWarningEl,
        el('div', { className: 'adv-scope-actions' },
          saveBtn,
          saveStatusEl,
        ),
        el('div', { className: 'adv-scope-project-note' },
          'Scope applies to this project only'
        ),
      );

      scopedFocusDrawerEl = el('div', {
        className: 'adv-scope-drawer adv-hidden',
        id: scopedDrawerId,
      }, drawerInner);

      // Store refs
      this._scopedFocusState[id] = {
        drawerEl: scopedFocusDrawerEl,
        dotEl: scopedFocusDotEl,
        gearBtn: scopedFocusGearBtn,
        topicsChipListEl,
        topicsInputEl,
        includeChipListEl,   // null for design/product
        includeInputEl,      // null for design/product
        excludeChipListEl,   // null for design/product
        excludeInputEl,      // null for design/product
        fileCountBadgeEl,    // null for design/product
        testScopeBtn,        // null for design/product
        saveStatusEl,
        noFilesWarningEl,
        clearScopeLink,
        drawerOpen: false,
      };
    }

    card.appendChild(
      el('div', { className: 'adv-card-header' },
        el('div', { className: 'adv-card-header-left' },
          collapseBtn,
          statusDot,
          el('span', { className: 'adv-persona-label' }, label),
          scopedFocusDotEl,
          scopedFocusGearBtn,
          statusText,
          constraintChipEl,
          collapsedSummaryEl,
        ),
        el('div', { className: 'adv-card-header-right' },
          soulBtn,
          constraintsBtn,
          headerCountdownEl,
          runNowBtn,
          pauseBtn,
        ),
      )
    );

    // DK-301: Scope focus drawer — inserted between card header and card body.
    // Hidden by default; expanded when gear icon is clicked.
    if (scopedFocusDrawerEl) card.appendChild(scopedFocusDrawerEl);

    // ── Card body (collapsible) ────────────────────────────────
    const cardBody = el('div', {
      className: 'adv-card-body' + (isInitiallyCollapsed ? ' adv-hidden' : ''),
      id: `adv-card-body-${id}`,
    });
    if (isInitiallyCollapsed) card.classList.add('adv-card-collapsed');
    card.appendChild(cardBody);

    // ── Persona title (always visible in body) ────────────────
    cardBody.appendChild(el('div', { className: 'adv-card-body-title' }, `${label} Advisor`));

    // ── Avatar ─────────────────────────────────────────────────
    const avatarEl = createAvatarEl(id, 'idle');
    if (avatarEl) cardBody.appendChild(avatarEl);

    // ── Focus Directive (DK-039) ───────────────────────────────
    // Inline, directly below the persona name / avatar. One click to edit,
    // blur or Enter to save, Escape to cancel. 500-char hard limit.
    // Shows "Focused" badge when a directive is set, "Freeform" when empty.
    const directiveLabelId = `adv-directive-label-${id}`;
    const directiveInputId = `adv-directive-input-${id}`;

    // One-line persona description (shown above the directive input)
    const directivePersonaDesc = el('p', { className: 'adv-directive-persona-desc' },
      PERSONA_DIRECTIVE_DESCRIPTIONS[id] || ''
    );

    // Status badge — "Focused" or "Freeform". Never color-only; always includes text.
    const directiveBadge = el('span', {
      className: 'adv-directive-badge adv-directive-badge-freeform',
      'aria-label': 'Directive status: Freeform',
    }, 'Freeform');

    // Timestamp — "Focus set 3 days ago"
    const directiveTimestamp = el('span', { className: 'adv-directive-ts adv-hidden' });

    // Staleness nudge — shown when directive is 14+ days old
    const directiveStaleness = el('span', { className: 'adv-directive-stale adv-hidden' },
      'This directive is 14+ days old — still relevant?'
    );

    // Next run indicator — "next run in ~Xh"
    const directiveNextRun = el('span', { className: 'adv-directive-next-run' });

    // Display row — shown in non-editing state (click to edit)
    const directiveDisplayText = el('span', {
      className: 'adv-directive-display-text',
      'aria-hidden': 'true',
    }, '');

    const directiveEditBtn = el('button', {
      className: 'adv-directive-edit-btn',
      type: 'button',
      title: 'Click to edit focus directive',
      'aria-label': `Edit focus directive for ${label} persona`,
      onClick: () => this._openDirectiveEdit(id),
    }, 'Edit');

    const directiveDisplayRow = el('div', { className: 'adv-directive-display-row' },
      directiveBadge,
      directiveDisplayText,
      directiveEditBtn,
    );

    // Edit row — shown in editing state
    const directiveLabel = el('label', {
      className: 'adv-directive-label',
      id: directiveLabelId,
      htmlFor: directiveInputId,
    }, 'Focus directive');

    const directiveCounter = el('span', {
      className: 'adv-directive-counter',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }, '0 / 500');

    const directiveInput = el('input', {
      type: 'text',
      className: 'adv-directive-input',
      id: directiveInputId,
      placeholder: PERSONA_DIRECTIVE_PLACEHOLDERS[id] || 'e.g. focus on this area',
      maxlength: '500',
      'aria-labelledby': directiveLabelId,
      'aria-describedby': `adv-directive-counter-${id} adv-directive-hint-${id}`,
      onInput: () => {
        const len = directiveInput.value.length;
        directiveCounter.textContent = `${len} / 500`;
        directiveCounter.className = 'adv-directive-counter' + (len > 480 ? ' adv-directive-counter-warn' : '');
        // Announce to assistive technology on input (not only on submission)
        directiveCounter.setAttribute('aria-live', 'polite');
      },
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._saveDirective(id, directiveInput.value); }
        if (e.key === 'Escape') { e.preventDefault(); this._cancelDirectiveEdit(id); }
      },
      onBlur: () => this._saveDirective(id, directiveInput.value),
    });
    directiveCounter.id = `adv-directive-counter-${id}`;

    // Character count hint — nudges users toward specificity
    const directiveHint = el('p', {
      className: 'adv-directive-hint',
      id: `adv-directive-hint-${id}`,
    }, '10–500 characters works best.');

    // "Applies on next cycle" note — static, always shown in edit mode
    const directiveAppliesNote = el('p', { className: 'adv-directive-applies-note' },
      'Applies on next cycle.'
    );

    // Inline save confirmation — aria-live="polite" for screen reader feedback
    const directiveSaveStatus = el('span', {
      className: 'adv-directive-save-status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }, '');

    const directiveSaveBtn = el('button', {
      className: 'adv-directive-save-btn',
      type: 'button',
      title: 'Save focus directive',
      onMousedown: (e) => e.preventDefault(), // prevent blur before click
      onClick: () => this._saveDirective(id, directiveInput.value),
    }, 'Save');

    // Clear button — shows "×" per spec, resets to empty without manual deletion
    const directiveClearBtn = el('button', {
      className: 'adv-directive-clear-btn',
      type: 'button',
      title: 'Clear directive — return to freeform',
      'aria-label': 'Clear focus directive',
      onMousedown: (e) => e.preventDefault(), // prevent blur before click
      onClick: () => this._saveDirective(id, ''),
    }, '×');

    const directiveCancelBtn = el('button', {
      className: 'adv-directive-cancel-btn',
      type: 'button',
      title: 'Cancel editing',
      onMousedown: (e) => e.preventDefault(), // prevent blur before click
      onClick: () => this._cancelDirectiveEdit(id),
    }, 'Cancel');

    const directiveEditRow = el('div', { className: 'adv-directive-edit-row adv-hidden' },
      el('div', { className: 'adv-directive-edit-header' },
        directiveLabel,
        directiveCounter,
      ),
      directiveInput,
      directiveHint,
      el('div', { className: 'adv-directive-edit-actions' },
        directiveSaveBtn,
        directiveClearBtn,
        directiveCancelBtn,
        directiveSaveStatus,
      ),
      directiveAppliesNote,
    );

    // Hidden by default; _renderDirective reveals it when a project is selected
    const directiveSection = el('div', { className: 'adv-directive-section adv-hidden' },
      directivePersonaDesc,
      el('div', { className: 'adv-directive-meta' },
        directiveDisplayRow,
        directiveTimestamp,
        directiveStaleness,
        directiveNextRun,
      ),
      directiveEditRow,
    );

    cardBody.appendChild(directiveSection);

    // Store directive element refs for later updates
    this._directiveEls[id] = {
      sectionEl: directiveSection,
      badgeEl: directiveBadge,
      inputEl: directiveInput,
      labelEl: directiveLabel,
      timestampEl: directiveTimestamp,
      stalenessEl: directiveStaleness,
      clearBtn: directiveClearBtn,
      nextRunEl: directiveNextRun,
      counterEl: directiveCounter,
      editRow: directiveEditRow,
      displayRow: directiveDisplayRow,
      displayText: directiveDisplayText,
      editBtn: directiveEditBtn,
      saveStatusEl: directiveSaveStatus,
    };

    // ── Focus prompt area ──────────────────────────────────────
    // Collapsed by default. Expandable with a "Focus area (optional)" label.
    const focusLabel = el('label', {
      className: 'adv-focus-label',
      htmlFor: `adv-focus-${id}`,
    }, 'Focus area (optional)');

    const focusCounter = el('span', { className: 'adv-focus-counter' }, '0 / 256');

    const focusTextarea = el('textarea', {
      className: 'adv-focus-textarea',
      id: `adv-focus-${id}`,
      placeholder: 'e.g. review the advisor deduplication logic',
      maxlength: '256',
      rows: '2',
      onInput: () => {
        const len = focusTextarea.value.length;
        focusCounter.textContent = `${len} / 256`;
        focusCounter.className = 'adv-focus-counter' + (len > 240 ? ' adv-focus-counter-warn' : '');
      },
    });

    const chipsEl = el('div', { className: 'adv-focus-chips adv-hidden' });

    // Toggle button for the focus area.
    // Focus area starts expanded by default (primary control); only collapses after
    // a focus prompt has been saved. The toggle lets users re-collapse/expand manually.
    const focusToggleBtn = el('button', {
      className: 'adv-focus-toggle',
      type: 'button',
      'aria-expanded': 'true',
      'aria-controls': `adv-focus-area-${id}`,
      onClick: () => {
        const isExpanded = focusToggleBtn.getAttribute('aria-expanded') === 'true';
        focusToggleBtn.setAttribute('aria-expanded', String(!isExpanded));
        focusArea.classList.toggle('adv-focus-area-open', !isExpanded);
        // When collapsing: show saved focus preview if one exists, else plain label
        const savedText = focusToggleBtn.dataset.savedFocus || '';
        if (isExpanded) {
          // Collapsing — show preview if there's a saved prompt
          focusToggleBtn.textContent = savedText ? 'Focus● ▸' : 'Focus ▸';
          focusToggleBtn.title = savedText
            ? `Saved focus active: "${savedText}"`
            : 'Set a focus area for the next run';
          // Show inline preview when collapsing
          const previewEl = this._cards[id]?.focusPreviewEl;
          if (previewEl && savedText) {
            const maxLen = 40;
            const preview = savedText.length > maxLen ? savedText.slice(0, maxLen) + '…' : savedText;
            previewEl.textContent = preview;
            previewEl.title = savedText;
            previewEl.className = 'adv-focus-preview';
          }
        } else {
          // Expanding — hide preview
          focusToggleBtn.textContent = savedText ? 'Focus● ▾' : 'Focus ▾';
          const previewEl = this._cards[id]?.focusPreviewEl;
          if (previewEl) {
            previewEl.textContent = '';
            previewEl.className = 'adv-focus-preview adv-hidden';
          }
          focusTextarea.focus();
        }
        this._focusManuallyToggled = this._focusManuallyToggled || {};
        this._focusManuallyToggled[id] = true;
      },
    }, 'Focus ▾');

    // Unsaved-changes dot — shown while the user is typing before auto-save fires (DK-315).
    const focusDirtyDot = el('span', {
      className: 'adv-focus-dirty-dot adv-hidden',
      title: 'Unsaved changes — will auto-save shortly',
      'aria-hidden': 'true',
    }, '●');

    // Indicator showing the currently saved focus prompt (from Firestore).
    // Hidden when no saved focus is set.
    const savedFocusEl = el('div', { className: 'adv-saved-focus adv-hidden' });

    const focusArea = el('div', {
      className: 'adv-focus-area adv-focus-area-open',
      id: `adv-focus-area-${id}`,
    },
      el('div', { className: 'adv-focus-header' },
        focusLabel,
        focusCounter,
      ),
      focusTextarea,
      chipsEl,
      el('div', { className: 'adv-focus-actions' },
        focusDirtyDot,
        savedFocusEl,
      ),
    );

    // Attach auto-save behavior (DK-315): debounce-on-input (800ms) + save on blur.
    // Uses _autoSaveFocusPrompt which saves without clearing or collapsing.
    const focusSaveControl = createSaveOnBlur({
      element: focusTextarea,
      onSave: async (value) => {
        await this._autoSaveFocusPrompt(id, value);
      },
      debounceMs: 800,
      autoSaveOnInput: true,
      showIndicator: true,
      indicatorPosition: 'inline',
      autoFadeAfterMs: 2000,
      onDirtyChange: (dirty) => {
        focusDirtyDot.classList.toggle('adv-hidden', !dirty);
      },
    });
    this._focusSaveControls[id] = focusSaveControl;

    // ── Inline Run-prompt expander (DK-321) ───────────────────────────────
    // Revealed when user clicks "Run Now". Single-line input (no multi-line),
    // 150-char hard cap, Escape to dismiss, Enter to submit.
    const runPromptHintId = `adv-run-prompt-hint-${id}`;
    const runPromptInput = el('input', {
      type: 'text',
      className: 'adv-run-prompt-input',
      placeholder: 'focus on the new auth module',
      maxlength: '150',
      'aria-label': 'Optional focus for this run only',
      'aria-describedby': runPromptHintId,
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submitRunPrompt(id); }
        if (e.key === 'Escape') { e.preventDefault(); this._closeRunPrompt(id); }
      },
    });
    const runPromptCounter = el('span', { className: 'adv-run-prompt-counter' }, '0 / 150');
    runPromptInput.addEventListener('input', () => {
      const len = runPromptInput.value.length;
      runPromptCounter.textContent = `${len} / 150`;
      runPromptCounter.className = 'adv-run-prompt-counter' + (len > 130 ? ' adv-run-prompt-counter-warn' : '');
    });
    const runPromptHintEl = el('span', {
      className: 'adv-run-prompt-hint',
      id: runPromptHintId,
    }, 'Optional — override for this run only');

    // ── DK-367: Scope input ───────────────────────────────────────────────
    // "Focus on:" — an optional free-text field that aims the run at a specific
    // part of the product. Scoped runs produce denser, more targeted output.
    const runScopeLabelId = `adv-run-scope-label-${id}`;
    const runScopeInputId = `adv-run-scope-input-${id}`;
    const runScopeNudgeId = `adv-run-scope-nudge-${id}`;

    // Known vague scope strings that should trigger the quality nudge
    const VAGUE_SCOPE_PATTERNS = ['the app', 'everything', 'all of it', 'the whole app', 'all', 'app'];

    const runScopeInput = el('input', {
      type: 'text',
      className: 'adv-run-scope-input',
      id: runScopeInputId,
      placeholder: 'onboarding, step 2 — email verification',
      maxlength: '500',
      'aria-labelledby': runScopeLabelId,
      'aria-describedby': runScopeNudgeId,
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submitRunPrompt(id); }
        if (e.key === 'Escape') { e.preventDefault(); this._closeRunPrompt(id); }
      },
    });
    const runScopeNudge = el('span', {
      className: 'adv-run-scope-nudge adv-hidden',
      id: runScopeNudgeId,
      role: 'status',
      'aria-live': 'polite',
    }, 'Try being more specific — e.g., "account settings > notifications tab."');
    runScopeInput.addEventListener('input', () => {
      const val = runScopeInput.value.trim();
      const isTooShort = val.length > 0 && val.length < 10;
      const isVague = VAGUE_SCOPE_PATTERNS.some(p => val.toLowerCase() === p);
      if (isTooShort || isVague) {
        runScopeNudge.classList.remove('adv-hidden');
      } else {
        runScopeNudge.classList.add('adv-hidden');
      }
    });
    const runScopeLabelEl = el('label', {
      className: 'adv-run-scope-label',
      id: runScopeLabelId,
      for: runScopeInputId,
    }, 'Focus on:');

    const runScopeRow = el('div', { className: 'adv-run-scope-row' },
      runScopeLabelEl,
      runScopeInput,
    );

    const runPromptSubmitBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-submit',
      onClick: () => this._submitRunPrompt(id),
    }, 'Run');
    const runPromptCancelBtn = el('button', {
      type: 'button',
      className: 'adv-run-prompt-cancel',
      onClick: () => this._closeRunPrompt(id),
    }, 'Cancel');
    const runPromptExpander = el('div', {
      className: 'adv-run-prompt-expander adv-hidden',
      id: `adv-run-prompt-${id}`,
      role: 'group',
      'aria-label': 'Run with optional focus prompt',
    },
      el('div', { className: 'adv-run-prompt-header' },
        runPromptHintEl,
        runPromptCounter,
      ),
      runPromptInput,
      runScopeRow,
      runScopeNudge,
      el('div', { className: 'adv-run-prompt-actions' },
        runPromptSubmitBtn,
        runPromptCancelBtn,
      ),
    );

    cardBody.appendChild(runPromptExpander);
    cardBody.appendChild(
      el('div', { className: 'adv-focus-row' },
        el('div', { className: 'adv-run-state-row' },
          runStateEl,
          timeHintEl,
        ),
      )
    );
    // ── Activity log (expandable) ──────────────────────────────
    const logToggleBtn = el('button', {
      className: 'adv-log-toggle',
      type: 'button',
      title: 'Show activity log',
      'aria-expanded': 'false',
      'aria-controls': `adv-log-container-${id}`,
      onClick: () => this._toggleLog(id),
    }, 'Log ▸');

    const logClearBtn = el('button', {
      className: 'adv-log-clear-btn adv-hidden',
      title: 'Clear activity log',
      'aria-label': 'Clear activity log',
      onClick: () => this._clearLog(id),
    }, '✕');

    const logContainer = el('div', { className: 'adv-log-container adv-log-hidden', id: `adv-log-container-${id}` });
    const logList = el('div', { className: 'adv-log-list' });
    logContainer.appendChild(logList);

    // ── Footer: schedule controls (single row) ─────────────────
    // Interval input — spec requires a visible <label> element (not just placeholder).
    const intervalInputId = `adv-interval-${id}`;
    const intervalValidationEl = el('span', {
      className: 'adv-interval-validation',
      role: 'alert',
      'aria-live': 'polite',
    });
    const intervalSavedEl = el('span', { className: 'adv-interval-saved' }); // transient "Saved"
    let intervalSavedTimer = null;

    // Unit selector: hours (default) or minutes
    const intervalUnitSelect = el('select', {
      className: 'adv-interval-unit-select',
      'aria-label': 'Interval unit',
    },
      el('option', { value: 'hours' }, 'hours'),
      el('option', { value: 'minutes' }, 'minutes'),
    );

    // DK-111: min interval is 0.25h (15 min). Hours mode allows floats; minutes mode
    // stays integer. step=0.25 in hours mode so arrow keys snap to quarter-hours.
    const MIN_HOURS = 0.25;
    const getIntervalIsMinutes = () => intervalUnitSelect.value === 'minutes';
    const getIntervalMax = () => getIntervalIsMinutes() ? 60 : 168;
    const getIntervalMin = () => getIntervalIsMinutes() ? 1 : MIN_HOURS;
    const getIntervalStep = () => getIntervalIsMinutes() ? '1' : '0.25';

    // Shared validation helper — returns { valid, warn, errMsg }
    const validateIntervalInput = () => {
      const raw = intervalInput.value;
      const isMinutes = getIntervalIsMinutes();
      const min = getIntervalMin();
      const max = getIntervalMax();
      const v = parseFloat(raw);
      if (!raw || isNaN(v) || v < min || v > max) {
        return { valid: false, warn: false, errMsg: isMinutes
          ? `Enter a whole number 1–${max}`
          : `Enter a number ${min}–${max} (minimum 0.25 = 15 min)` };
      }
      if (isMinutes && !Number.isInteger(v)) {
        return { valid: false, warn: false, errMsg: `Enter a whole number 1–${max}` };
      }
      // Soft warning: hours < 1 (spec: show warning, not error)
      if (!isMinutes && v < 1) {
        return { valid: true, warn: true, errMsg: null };
      }
      return { valid: true, warn: false, errMsg: null };
    };

    const applyIntervalValidation = () => {
      const { valid, warn, errMsg } = validateIntervalInput();
      if (!valid) {
        intervalValidationEl.textContent = errMsg;
        intervalValidationEl.className = 'adv-interval-validation adv-interval-validation-err';
      } else if (warn) {
        intervalValidationEl.textContent = 'Intervals under 1 hour run frequently — check resource usage.';
        intervalValidationEl.className = 'adv-interval-validation adv-interval-validation-warn';
      } else {
        intervalValidationEl.textContent = '';
        intervalValidationEl.className = 'adv-interval-validation';
      }
    };

    const intervalInput = el('input', {
      className: 'adv-interval-input',
      type: 'number',
      id: intervalInputId,
      'aria-label': 'Run interval',
      min: String(MIN_HOURS),
      max: '168',
      step: '0.25',
      value: String(defaultHours),
      // Inline validation on change (not on submit per spec)
      onInput: applyIntervalValidation,
      // Confirm on blur (per spec)
      onBlur: () => {
        const { valid } = validateIntervalInput();
        if (valid) {
          this._saveInterval(id, intervalInput.value, intervalUnitSelect.value, intervalSavedEl, (timer) => {
            if (intervalSavedTimer) clearTimeout(intervalSavedTimer);
            intervalSavedTimer = timer;
          });
        }
      },
      // Confirm on Enter (per spec)
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          intervalInput.blur();
        }
      },
    });

    // When unit changes, update min/max/step constraints and re-validate; save if valid
    intervalUnitSelect.addEventListener('change', () => {
      const isMinutes = getIntervalIsMinutes();
      const max = getIntervalMax();
      const min = getIntervalMin();
      intervalInput.max = String(max);
      intervalInput.min = String(min);
      intervalInput.step = getIntervalStep();
      const v = parseFloat(intervalInput.value);
      // Clamp to max when switching from hours → minutes (e.g. 24h → 24m is fine, 168h → 60m)
      if (!isNaN(v) && v > max) {
        intervalInput.value = String(max);
      }
      // Clamp to integer when switching to minutes
      if (isMinutes && !isNaN(v) && !Number.isInteger(v)) {
        intervalInput.value = String(Math.max(1, Math.ceil(v)));
      }
      applyIntervalValidation();
      // Save updated unit+value immediately on unit change if valid
      const { valid } = validateIntervalInput();
      if (valid) {
        this._saveInterval(id, intervalInput.value, intervalUnitSelect.value, intervalSavedEl, (timer) => {
          if (intervalSavedTimer) clearTimeout(intervalSavedTimer);
          intervalSavedTimer = timer;
        });
      }
    });

    // Visible <label> element for the interval input (not just placeholder per spec)
    const intervalLabel = el('label', {
      className: 'adv-interval-label-el',
      htmlFor: intervalInputId,
    }, 'Every');

    // Per-persona hint text (spec: "small per-persona note for the interval field").
    // DK-111: Design hint includes headless Chrome note so users make informed throttling decisions.
    // title attribute gives the full text as a browser tooltip.
    const hintText = PERSONA_INTERVAL_HINTS[id] || '';
    const intervalHintEl = el('span', {
      className: 'adv-interval-hint',
      title: hintText,
    }, hintText);

    // ── Ticket cap input ───────────────────────────────────────
    // Inline number input (range 1–50). Visible without expanding.
    // Tooltip explains throttle framing per spec.
    const capInputId = `adv-cap-${id}`;
    const capSavedEl = el('span', { className: 'adv-interval-saved' });
    let capSavedTimer = null;

    const capInput = el('input', {
      className: 'adv-cap-input',
      type: 'number',
      id: capInputId,
      min: '1',
      max: '50',
      value: '3',
      title: 'Top-ranked tickets by impact are created first; others are deferred.',
      'aria-label': 'Max tickets per run',
      onInput: () => {
        const v = parseInt(capInput.value, 10);
        if (!capInput.value || isNaN(v) || v < 1 || v > 50 || !Number.isInteger(v)) {
          capInput.classList.add('adv-cap-input-invalid');
        } else {
          capInput.classList.remove('adv-cap-input-invalid');
        }
      },
      onBlur: () => {
        const v = parseInt(capInput.value, 10);
        if (capInput.value && !isNaN(v) && v >= 1 && v <= 50 && Number.isInteger(v)) {
          this._saveTicketCap(id, v, capSavedEl, (timer) => {
            if (capSavedTimer) clearTimeout(capSavedTimer);
            capSavedTimer = timer;
          });
        }
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          capInput.blur();
        }
      },
    });

    const capLabel = el('label', {
      className: 'adv-cap-label',
      htmlFor: capInputId,
    }, 'Cap:');

    // ── Preview Run button (dry-run trigger) ──────────────────────
    // Secondary-weight text button per spec — exploratory action, not primary.
    const previewRunBtn = el('button', {
      className: 'adv-preview-run-btn',
      'aria-label': `Preview Run: ${label} persona`,
      title: 'Run a preview — see what this persona would propose without creating real tickets',
      onClick: () => this._startDryRun(id, label),
    }, 'Preview Run');

    // ── Preview panel (dry-run results) ─────────────────────────
    // Full-width panel that expands below the card body.
    // aria-live so screen readers announce status changes.
    const dryRunPanel = el('div', {
      className: 'adv-dry-run-panel adv-hidden',
      id: `adv-dry-run-panel-${id}`,
      role: 'region',
      'aria-label': `${label} persona preview results`,
    });

    const dryRunStatusBar = el('div', {
      className: 'adv-dry-run-status-bar',
      role: 'status',
      'aria-live': 'polite',
    });

    const dryRunPanelHeading = el('h3', {
      className: 'adv-dry-run-panel-heading',
      tabIndex: '-1',
    }, `${label} — Preview Run`);

    const dryRunProposalList = el('div', {
      className: 'adv-dry-run-proposal-list',
    });

    const dryRunCloseBtn = el('button', {
      className: 'adv-dry-run-close-btn',
      'aria-label': 'Close preview panel',
      onClick: () => this._closeDryRunPanel(id),
    }, '✕ Close');

    const dryRunPromoteAllBtn = el('button', {
      className: 'adv-dry-run-promote-all-btn adv-hidden',
      'aria-label': 'Promote all proposals to real tickets',
      onClick: () => this._promoteAllDryRunProposals(id, label),
    }, 'Promote all');

    const dryRunPanelHeaderRow = el('div', { className: 'adv-dry-run-panel-header-row' },
      dryRunPanelHeading,
      el('div', { className: 'adv-dry-run-panel-header-actions' },
        dryRunPromoteAllBtn,
        dryRunCloseBtn,
      ),
    );

    dryRunPanel.appendChild(dryRunStatusBar);
    dryRunPanel.appendChild(dryRunPanelHeaderRow);
    dryRunPanel.appendChild(dryRunProposalList);

    // Store dry-run panel references (panel appended to cardBody below, after footer)
    this._dryRunPanels[id] = {
      panel: dryRunPanel,
      statusBar: dryRunStatusBar,
      proposalList: dryRunProposalList,
      heading: dryRunPanelHeading,
      promoteAllBtn: dryRunPromoteAllBtn,
      previewRunBtn,
    };

    // ── Last run info line (DK-303) ────────────────────────────────────────
    // Single scannable line below card header: "Last run 2h ago — 2 tickets created"
    // or "Never run". Updated by _renderCard when state changes.
    const lastRunLineEl = el('div', {
      className: 'adv-last-run-line',
    }, 'Never run');
    cardBody.appendChild(lastRunLineEl);

    // DK-302: Collapsed one-line priorities preview — shown below last-run line
    // so users can correlate persona output with what priorities were set at the time.
    const prioritiesPreviewEl = el('div', {
      className: 'adv-priorities-preview',
      title: 'Current priorities used by this persona',
      style: 'display:none',
    });
    this._prioritiesPreviewEls[id] = prioritiesPreviewEl;
    cardBody.appendChild(prioritiesPreviewEl);

    // ── Schedule row: [Every] [input] [unit] · cap [cap input] [saved] ──
    // Essential scheduling controls only. Countdown moves to the card header.
    // Preview Run moved to secondary actions section below.
    const scheduleFooter = el('div', { className: 'adv-card-footer' },
      el('div', { className: 'adv-schedule-row' },
        intervalLabel,
        intervalInput,
        intervalUnitSelect,
        el('span', { className: 'adv-schedule-sep' }, '·'),
        capLabel,
        capInput,
        intervalSavedEl,
        capSavedEl,
      ),
      intervalValidationEl,
      intervalHintEl,
    );
    cardBody.appendChild(scheduleFooter);

    // ── Schedule section (DK-195) ───────────────────────────────────────────
    // Collapsible "Custom schedule" disclosure. Default closed.
    // Stores: schedule: { timezone, allowedDays, windowStart, windowEnd } in Firestore.
    // Backward-compatible: existing allowedHours field left untouched in daemon.
    const timeWindowBodyId = `adv-time-window-body-${id}`;
    let timeWindowOpen = false;

    // Detect browser timezone for default
    const browserTz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch { return 'UTC'; }
    })();

    // ── Timezone selector ─────────────────────────────────────────────────
    // Common IANA timezones. Users can type a custom value via the text input fallback.
    const COMMON_TIMEZONES = [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Anchorage', 'America/Adak', 'Pacific/Honolulu',
      'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
      'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
      'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland',
    ];
    // Ensure browser tz is in the list
    const tzOptions = COMMON_TIMEZONES.includes(browserTz)
      ? COMMON_TIMEZONES
      : [browserTz, ...COMMON_TIMEZONES];

    const tzSelect = el('select', {
      className: 'adv-tz-select',
      'aria-label': 'Timezone',
      id: `adv-tz-${id}`,
    }, ...tzOptions.map(tz => el('option', { value: tz, selected: tz === browserTz }, tz)));

    // ── Time inputs ───────────────────────────────────────────────────────
    const startTimeInput = el('input', {
      type: 'time',
      className: 'adv-time-input',
      'aria-label': 'Active from',
      id: `adv-start-time-${id}`,
      value: '21:00',
    });

    const endTimeInput = el('input', {
      type: 'time',
      className: 'adv-time-input',
      'aria-label': 'Until',
      id: `adv-end-time-${id}`,
      value: '06:00',
    });

    // Plain-language hint (e.g. "9 hours active" or "overnight window")
    const schedDurationEl = el('span', { className: 'adv-time-window-duration' });

    function updateTimeHint() {
      const s = startTimeInput.value; // "HH:MM"
      const e = endTimeInput.value;
      if (!s || !e) { schedDurationEl.textContent = ''; return; }
      const [sh, sm] = s.split(':').map(Number);
      const [eh, em] = e.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin   = eh * 60 + em;
      let durationMin;
      if (startMin < endMin) {
        durationMin = endMin - startMin;
      } else if (startMin > endMin) {
        durationMin = (24 * 60 - startMin) + endMin; // overnight
      } else {
        schedDurationEl.textContent = '(0 hours — same start and end)';
        return;
      }
      const h = Math.floor(durationMin / 60);
      const m = durationMin % 60;
      const label = startMin > endMin ? 'overnight window' : `${h > 0 ? h + 'h' : ''}${m > 0 ? ' ' + m + 'm' : ''} active`;
      schedDurationEl.textContent = `(${label.trim()})`;
    }
    updateTimeHint();

    // ── Day-of-week toggle pills ──────────────────────────────────────────
    // Uses JS day integers: 0=Sun, 1=Mon, …, 6=Sat (matches Date.getDay())
    const DAYS = [
      { dayInt: 1, key: 'mon', label: 'M',  ariaLabel: 'Monday'    },
      { dayInt: 2, key: 'tue', label: 'T',  ariaLabel: 'Tuesday'   },
      { dayInt: 3, key: 'wed', label: 'W',  ariaLabel: 'Wednesday' },
      { dayInt: 4, key: 'thu', label: 'T',  ariaLabel: 'Thursday'  },
      { dayInt: 5, key: 'fri', label: 'F',  ariaLabel: 'Friday'    },
      { dayInt: 6, key: 'sat', label: 'S',  ariaLabel: 'Saturday'  },
      { dayInt: 0, key: 'sun', label: 'S',  ariaLabel: 'Sunday'    },
    ];
    // Default: Mon–Fri (days 1-5)
    const defaultDayInts = new Set([1, 2, 3, 4, 5]);
    const dayButtons = {};
    const dayButtonEls = DAYS.map(({ dayInt, key, label, ariaLabel }) => {
      const active = defaultDayInts.has(dayInt);
      const btn = el('button', {
        type: 'button',
        className: 'adv-day-btn' + (active ? ' adv-day-btn-active' : ''),
        'aria-pressed': String(active),
        'aria-label': ariaLabel,
        'data-day': String(dayInt),
        onClick: () => {
          const pressed = btn.getAttribute('aria-pressed') === 'true';
          btn.setAttribute('aria-pressed', String(!pressed));
          btn.classList.toggle('adv-day-btn-active', !pressed);
          this._saveSchedule(id, tzSelect, startTimeInput, endTimeInput, dayButtons, timeWindowSavedEl, nextRunEl, noRunsWarningEl);
        },
      }, label);
      dayButtons[key] = btn;
      return btn;
    });

    // Fieldset wrapper for accessibility
    const dayFieldset = el('fieldset', { className: 'adv-day-fieldset' },
      el('legend', { className: 'adv-day-legend' }, 'Active days'),
      el('div', { className: 'adv-day-row' }, ...dayButtonEls),
    );

    // ── Next run / last ran display ───────────────────────────────────────
    const nextRunEl = el('div', {
      className: 'adv-schedule-next-run',
      'aria-live': 'polite',
    });

    // ── No-runs warning ───────────────────────────────────────────────────
    const noRunsWarningEl = el('div', {
      className: 'adv-schedule-no-runs-warning adv-hidden',
      role: 'alert',
    }, 'This schedule has no runs in the next 7 days.');

    const timeWindowSavedEl = el('span', {
      className: 'adv-interval-saved',
      role: 'status',
      'aria-live': 'polite',
    });

    // "Clear schedule" button — removes the restriction
    const clearWindowBtn = el('button', {
      type: 'button',
      className: 'adv-time-window-clear-btn',
      title: 'Remove schedule — run at any time',
      onClick: () => this._clearSchedule(id, timeWindowSavedEl, nextRunEl, noRunsWarningEl),
    }, 'Clear schedule');

    // Save on change for all schedule inputs
    const saveScheduleOnChange = () =>
      this._saveSchedule(id, tzSelect, startTimeInput, endTimeInput, dayButtons, timeWindowSavedEl, nextRunEl, noRunsWarningEl);
    tzSelect.addEventListener('change', saveScheduleOnChange);
    startTimeInput.addEventListener('change', () => { updateTimeHint(); saveScheduleOnChange(); });
    endTimeInput.addEventListener('change', () => { updateTimeHint(); saveScheduleOnChange(); });

    const timeWindowBody = el('div', {
      className: 'adv-time-window-body adv-hidden',
      id: timeWindowBodyId,
    },
      el('p', { className: 'adv-time-window-hint' },
        'Scheduled runs only. "Run Now" always fires.'
      ),
      el('div', { className: 'adv-time-window-tz-row' },
        el('label', { htmlFor: `adv-tz-${id}`, className: 'adv-time-label' }, 'Timezone'),
        tzSelect,
      ),
      el('div', { className: 'adv-time-window-hours' },
        el('label', { htmlFor: `adv-start-time-${id}`, className: 'adv-time-label' }, 'Active from'),
        startTimeInput,
        el('label', { htmlFor: `adv-end-time-${id}`, className: 'adv-time-label' }, 'Until'),
        endTimeInput,
        schedDurationEl,
      ),
      dayFieldset,
      noRunsWarningEl,
      nextRunEl,
      el('div', { className: 'adv-time-window-actions' },
        clearWindowBtn,
        timeWindowSavedEl,
      ),
    );

    const timeWindowToggleBtn = el('button', {
      type: 'button',
      className: 'adv-time-window-toggle',
      'aria-expanded': 'false',
      'aria-controls': timeWindowBodyId,
      onClick: () => {
        timeWindowOpen = !timeWindowOpen;
        timeWindowBody.classList.toggle('adv-hidden', !timeWindowOpen);
        timeWindowToggleBtn.setAttribute('aria-expanded', String(timeWindowOpen));
        timeWindowToggleBtn.textContent = timeWindowOpen ? 'Custom schedule ▾' : 'Custom schedule ▸';
      },
    }, 'Custom schedule ▸');

    const timeWindowSection = el('div', { className: 'adv-time-window-section' },
      timeWindowToggleBtn,
      timeWindowBody,
    );
    cardBody.appendChild(timeWindowSection);

    // ── DK-136: Trigger pills section ─────────────────────────────────────
    // Shows active trigger conditions as pills: "every 12h", "on deploy", "manual"
    // Plus a progress counter for ticket-close triggers: "3/5 tickets closed"
    const triggerPillsEl = el('div', { className: 'adv-trigger-pills' });
    const triggerProgressEl = el('div', {
      className: 'adv-trigger-progress',
      style: 'display:none',
    });

    // Initial pills are rendered; updated in _renderCard when intervalHours changes
    // Interval pill is always shown
    const intervalPill = el('span', {
      className: 'adv-trigger-pill adv-trigger-pill-interval',
      title: 'Scheduled interval trigger',
    });
    triggerPillsEl.appendChild(intervalPill);

    // "on deploy" pill — shown if webhook trigger is configured (read from Firestore config)
    const webhookPill = el('span', {
      className: 'adv-trigger-pill adv-trigger-pill-webhook adv-hidden',
      title: 'Webhook / deploy trigger active — configure DOCKET_WEBHOOK_SECRET env var',
    }, 'on deploy');
    triggerPillsEl.appendChild(webhookPill);

    // "manual" pill — always shown (Run Now button provides this)
    const manualPill = el('span', {
      className: 'adv-trigger-pill adv-trigger-pill-manual',
      title: 'Manual trigger via Run Now button',
    }, 'manual');
    triggerPillsEl.appendChild(manualPill);

    const triggersSection = el('div', { className: 'adv-triggers-section' },
      el('div', { className: 'adv-triggers-row' },
        triggerPillsEl,
        triggerProgressEl,
      ),
    );
    cardBody.appendChild(triggersSection);

    // ── Dedup sensitivity control (DK-130) ────────────────────────────────
    // Segmented control: Low / Medium / High. Controls per-persona keyword overlap
    // threshold for duplicate detection. Stored as integer in Firestore.
    // Default: Medium (3). Writes on change; shows inline "Saved" confirmation.
    const DEDUP_OPTIONS = [
      {
        value: 1,
        label: 'Low',
        description: 'Only near-identical tickets are filtered. May allow near-duplicates through.',
        secondary: 'Low (~1 keyword match)',
      },
      {
        value: 3,
        label: 'Medium',
        description: 'Tickets with significant keyword overlap are filtered. Recommended starting point.',
        secondary: 'Medium (~3 keyword matches)',
      },
      {
        value: 5,
        label: 'High',
        description: 'Any topical overlap triggers filtering. May suppress real issues.',
        secondary: 'High (~5 keyword matches)',
      },
    ];

    const dedupGroupId = `adv-dedup-${id}`;
    const dedupSavedEl = el('span', {
      className: 'adv-interval-saved',
      role: 'status',
      'aria-live': 'polite',
    });
    let dedupSavedTimer = null;

    // Build radio buttons for each sensitivity level
    const dedupRadioButtons = DEDUP_OPTIONS.map((opt) => {
      const radioId = `${dedupGroupId}-${opt.label.toLowerCase()}`;

      // Info icon with tooltip — focusable, one sentence per label
      const tooltipId = `${radioId}-tooltip`;
      const infoIcon = el('button', {
        type: 'button',
        className: 'adv-dedup-tooltip-trigger',
        'aria-label': `Info: ${opt.label} sensitivity`,
        'aria-describedby': tooltipId,
        tabIndex: '0',
        onClick: (e) => {
          e.stopPropagation();
          const tooltip = document.getElementById(tooltipId);
          if (tooltip) {
            const isVisible = tooltip.getAttribute('aria-hidden') === 'false';
            tooltip.setAttribute('aria-hidden', isVisible ? 'true' : 'false');
            tooltip.classList.toggle('adv-dedup-tooltip-visible', !isVisible);
          }
        },
        onBlur: () => {
          const tooltip = document.getElementById(tooltipId);
          if (tooltip) {
            tooltip.setAttribute('aria-hidden', 'true');
            tooltip.classList.remove('adv-dedup-tooltip-visible');
          }
        },
      }, 'ⓘ');

      const tooltip = el('span', {
        className: 'adv-dedup-tooltip',
        id: tooltipId,
        role: 'tooltip',
        'aria-hidden': 'true',
      }, opt.description);

      const radioInput = el('input', {
        type: 'radio',
        className: 'adv-dedup-radio',
        name: dedupGroupId,
        id: radioId,
        value: String(opt.value),
        onChange: () => {
          // Update visual state for all buttons in this group
          const allRadios = dedupRadioRow.querySelectorAll('.adv-dedup-option');
          allRadios.forEach(btn => btn.setAttribute('aria-checked', 'false'));
          optionEl.setAttribute('aria-checked', 'true');
          // Save to Firestore
          this._saveDedupThreshold(id, opt.value, dedupSavedEl, (timer) => {
            if (dedupSavedTimer) clearTimeout(dedupSavedTimer);
            dedupSavedTimer = timer;
          });
        },
      });

      // Visible label showing secondary (numeric) info
      const optionLabel = el('label', {
        className: 'adv-dedup-option-label',
        htmlFor: radioId,
        title: opt.secondary,
      }, opt.label);

      const optionEl = el('span', {
        className: 'adv-dedup-option',
        role: 'radio',
        'aria-checked': opt.value === 3 ? 'true' : 'false', // default Medium
        'aria-label': `${opt.secondary}`,
        onClick: () => {
          radioInput.click();
        },
        onKeyDown: (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            radioInput.click();
          }
        },
        tabIndex: '-1', // tabIndex managed via radioInput for keyboard nav
      },
        radioInput,
        optionLabel,
        infoIcon,
        tooltip,
      );

      return optionEl;
    });

    const dedupLabelEl = el('span', {
      className: 'adv-dedup-label',
      id: `${dedupGroupId}-label`,
    }, 'Dedup:');

    const dedupRadioRow = el('div', {
      className: 'adv-dedup-row',
      role: 'radiogroup',
      'aria-labelledby': `${dedupGroupId}-label`,
    },
      dedupLabelEl,
      el('span', { className: 'adv-dedup-options' }, ...dedupRadioButtons),
      dedupSavedEl,
    );

    const dedupLatencyNote = el('span', {
      className: 'adv-dedup-latency-note',
    }, 'Changes take effect on the next advisor cycle.');

    const dedupRow = el('div', { className: 'adv-dedup-section' },
      dedupRadioRow,
      dedupLatencyNote,
    );
    cardBody.appendChild(dedupRow);

    // ── Secondary actions row: [Preview Run] ──
    // Separated from schedule controls to reduce cognitive load on the main footer.
    // Placed below schedule for less visual prominence.
    const secondaryActionsRow = el('div', {
      className: 'adv-secondary-actions-row',
    },
      previewRunBtn,
    );
    cardBody.appendChild(secondaryActionsRow);

    // Dry-run panel goes below the schedule footer, still inside the card body.
    // Hidden by default; shown when user clicks "Preview Run".
    cardBody.appendChild(dryRunPanel);

    // ── Performance subsection (collapsible) ───────────────────
    // Starts collapsed by default (expanded key absent from set)
    const perfSectionKey = `${id}:performance`;
    const perfSectionExpanded = this._collapsedCardSections.has(perfSectionKey);
    const perfChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, perfSectionExpanded ? '▾' : '▸');
    const perfSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(perfSectionExpanded),
      'aria-controls': `adv-perf-section-${id}`,
      onClick: () => this._toggleCardSection(perfSectionKey, perfSectionBody, perfChevron, perfSectionHeader),
    },
      perfChevron,
      el('span', {}, 'Performance'),
    );
    cardBody.appendChild(perfSectionHeader);

    const perfSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-perf-section-${id}`,
    });
    if (!perfSectionExpanded) perfSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(perfSectionBody);

    // ── Stats row ──────────────────────────────────────────────
    const ticketsEl = el('span', { className: 'adv-stat-val' }, '0');
    const cyclesEl  = el('span', { className: 'adv-stat-val' }, '0');

    perfSectionBody.appendChild(
      el('div', { className: 'adv-stats' },
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Tickets '),
          ticketsEl,
        ),
        el('span', { className: 'adv-stat' },
          el('span', { className: 'adv-stat-label' }, 'Cycles '),
          cyclesEl,
        ),
        statsBtn,
      )
    );

    // ── Feedback injection toggle ──────────────────────────────
    // "Use my decisions to improve proposals." toggle, defaults on.
    // Adjacent to interval controls per spec.
    const feedbackToggleId = `adv-feedback-toggle-${id}`;
    const feedbackToggleCheckbox = el('input', {
      type: 'checkbox',
      className: 'adv-feedback-toggle-checkbox',
      id: feedbackToggleId,
      checked: true,
      'aria-describedby': `adv-feedback-toggle-status-${id}`,
      onChange: () => this._saveFeedbackToggle(id, feedbackToggleCheckbox.checked),
    });
    const feedbackToggleStatusEl = el('span', {
      className: 'adv-feedback-toggle-status',
      id: `adv-feedback-toggle-status-${id}`,
      'aria-live': 'polite',
    }, 'Feedback injection: on');

    const feedbackToggleRow = el('div', { className: 'adv-feedback-toggle-row' },
      el('label', {
        className: 'adv-feedback-toggle-label',
        htmlFor: feedbackToggleId,
      },
        feedbackToggleCheckbox,
        el('span', { className: 'adv-feedback-toggle-text' }, 'Use my decisions to improve proposals'),
      ),
      feedbackToggleStatusEl,
    );
    perfSectionBody.appendChild(feedbackToggleRow);

    // ── Feedback stat row ──────────────────────────────────────
    // Collapsed by default. Shows accepted/rejected counts per spec.
    // Expands to show top rejected categories with signal framing.
    const feedbackStatSummaryEl = el('span', { className: 'adv-feedback-stat-summary' }, '');
    const feedbackStatExpandBtn = el('button', {
      className: 'adv-feedback-stat-expand',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `adv-feedback-detail-${id}`,
    }, '▸');

    const feedbackStatRow = el('div', {
      className: 'adv-feedback-stat-row',
      role: 'button',
      tabindex: '0',
      onClick: () => this._toggleFeedbackDetail(id),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._toggleFeedbackDetail(id);
        }
      },
    },
      feedbackStatExpandBtn,
      el('span', { className: 'adv-feedback-stat-label' }, `${label}: `),
      feedbackStatSummaryEl,
    );

    const feedbackDetailEl = el('div', {
      className: 'adv-feedback-detail adv-hidden',
      id: `adv-feedback-detail-${id}`,
    });

    perfSectionBody.appendChild(feedbackStatRow);
    perfSectionBody.appendChild(feedbackDetailEl);

    // ── Exclusion list (Engineer: glob patterns, Design: URL patterns) ──
    // Only shown for personas that scan files (engineer) or URLs (design).
    // Product persona is out of scope per spec.
    let exclusionSectionEl = null;
    let exclusionTagListEl = null;
    let exclusionInputEl = null;
    let exclusionValidationEl = null;
    let exclusionAddBtn = null;
    let exclusionSkipCountEl = null;

    if (id === 'engineer' || id === 'design') {
      const isEngineer = id === 'engineer';
      const exclusionSectionId = `adv-exclusion-section-${id}`;
      const exclusionInputId = `adv-exclusion-input-${id}`;
      const exclusionLabel = isEngineer ? 'File exclusions' : 'URL exclusions';
      const exclusionPlaceholder = isEngineer ? 'e.g. vendor/**, legacy/**' : 'e.g. https://example.com/admin/';
      const exclusionHint = isEngineer
        ? 'Glob patterns — files/dirs this persona will always skip.'
        : 'URL prefixes — pages this persona will always skip.';

      // Visible label for the input (not placeholder-only per a11y spec)
      const exclusionLabelEl = el('label', {
        className: 'adv-exclusion-label',
        htmlFor: exclusionInputId,
      }, exclusionLabel);

      // Live validation output — uses aria-live="polite" per a11y spec
      exclusionValidationEl = el('span', {
        className: 'adv-exclusion-validation',
        role: 'status',
        'aria-live': 'polite',
      });

      exclusionInputEl = el('input', {
        type: 'text',
        id: exclusionInputId,
        className: 'adv-exclusion-input',
        placeholder: exclusionPlaceholder,
        maxLength: 200,
        'aria-label': exclusionLabel,
        'aria-describedby': `adv-exclusion-validation-${id}`,
        onInput: () => this._validateExclusionInput(id, exclusionInputEl, exclusionValidationEl),
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._addExclusion(id, exclusionInputEl, exclusionValidationEl);
          }
        },
      });
      exclusionValidationEl.id = `adv-exclusion-validation-${id}`;

      exclusionAddBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-add-btn',
        title: `Add ${isEngineer ? 'glob' : 'URL'} exclusion pattern`,
        onClick: () => this._addExclusion(id, exclusionInputEl, exclusionValidationEl),
      }, 'Add');

      // Tag list — shows current exclusion patterns as deletable tags
      exclusionTagListEl = el('div', {
        className: 'adv-exclusion-tag-list',
        role: 'list',
        'aria-label': `Active ${exclusionLabel.toLowerCase()}`,
      });

      // Suppression counter — "N skipped this week" (loaded from advisorRuns)
      exclusionSkipCountEl = el('div', {
        className: 'adv-exclusion-skip-count adv-hidden',
        'aria-live': 'polite',
      });

      exclusionSectionEl = el('div', {
        className: 'adv-exclusion-section',
        id: exclusionSectionId,
      },
        el('div', { className: 'adv-exclusion-hint' }, exclusionHint),
        exclusionTagListEl,
        el('div', { className: 'adv-exclusion-input-row' },
          exclusionLabelEl,
          exclusionInputEl,
          exclusionAddBtn,
        ),
        exclusionValidationEl,
        exclusionSkipCountEl,
      );

      perfSectionBody.appendChild(exclusionSectionEl);
    }

    // ── DK-101: Focus Areas ────────────────────────────────────
    // Collapsible section per persona. Collapsed by default; shows a summary
    // chip in the header when constraints are active.
    // Engineer: includePaths + excludePaths (chip inputs, glob patterns)
    // Design: urlPatterns (chip inputs, relative paths only)
    // Product: targetSegment + businessGoal (plain text fields, max 200 chars)
    let focusAreasSectionEl = null;
    let focusAreasChipData = {}; // { fieldKey: HTMLElement } for chip lists
    let focusAreasInputs = {};   // { fieldKey: HTMLInputElement | HTMLTextAreaElement }
    let focusAreasSummaryChipEl = null; // header chip "N constraints active"
    let focusAreasSectionOpen = false;

    const FOCUS_AREAS_PERSONAS = new Set(['engineer', 'design', 'product']);
    if (FOCUS_AREAS_PERSONAS.has(id)) {
      const focusSectionId = `adv-focus-areas-${id}`;
      const focusSectionBodyId = `adv-focus-areas-body-${id}`;

      // ── Summary chip (shown in header when any constraint active) ──
      focusAreasSummaryChipEl = el('span', {
        className: 'adv-focus-areas-summary-chip adv-hidden',
        'aria-label': 'Focus area constraints active',
        title: 'Scope constraints are narrowing this persona\'s analysis',
      });

      // ── Collapse toggle ──
      const focusAreasToggle = el('button', {
        type: 'button',
        className: 'adv-focus-areas-toggle',
        'aria-expanded': 'false',
        'aria-controls': focusSectionBodyId,
        id: focusSectionId,
        onClick: () => {
          focusAreasSectionOpen = !focusAreasSectionOpen;
          focusAreasToggle.setAttribute('aria-expanded', String(focusAreasSectionOpen));
          focusAreasSectionBodyEl.classList.toggle('adv-hidden', !focusAreasSectionOpen);
          focusAreasToggle.textContent = focusAreasSectionOpen ? 'Focus Areas ▾' : 'Focus Areas ▸';
        },
      }, 'Focus Areas ▸');

      // ── Section body ──
      const focusAreasFields = [];

      if (id === 'engineer') {
        // includePaths chip input
        const includeListEl = el('div', {
          className: 'adv-focus-areas-chip-list',
          role: 'list',
          'aria-label': 'Active include paths',
        });
        focusAreasChipData['includePaths'] = includeListEl;

        const includeInputId = `adv-focus-areas-include-${id}`;
        const includeInputEl = el('input', {
          type: 'text',
          id: includeInputId,
          className: 'adv-focus-areas-input',
          placeholder: 'e.g. src/payments',
          maxlength: '200',
          'aria-label': 'Add include path',
        });
        focusAreasInputs['includePaths'] = includeInputEl;

        includeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addFocusAreaChip(id, 'includePaths', includeInputEl); }
          if (e.key === 'Backspace' && !includeInputEl.value) { e.preventDefault(); this._removeLastFocusAreaChip(id, 'includePaths'); }
        });

        const includeAddBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-add-btn',
          title: 'Add include path',
          onClick: () => this._addFocusAreaChip(id, 'includePaths', includeInputEl),
        }, 'Add');

        const excludeListEl = el('div', {
          className: 'adv-focus-areas-chip-list',
          role: 'list',
          'aria-label': 'Active exclude paths',
        });
        focusAreasChipData['excludePaths'] = excludeListEl;

        const excludeInputId = `adv-focus-areas-exclude-${id}`;
        const excludeInputEl = el('input', {
          type: 'text',
          id: excludeInputId,
          className: 'adv-focus-areas-input',
          placeholder: 'e.g. src/__tests__',
          maxlength: '200',
          'aria-label': 'Add exclude path',
        });
        focusAreasInputs['excludePaths'] = excludeInputEl;

        excludeInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addFocusAreaChip(id, 'excludePaths', excludeInputEl); }
          if (e.key === 'Backspace' && !excludeInputEl.value) { e.preventDefault(); this._removeLastFocusAreaChip(id, 'excludePaths'); }
        });

        const excludeAddBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-add-btn',
          title: 'Add exclude path',
          onClick: () => this._addFocusAreaChip(id, 'excludePaths', excludeInputEl),
        }, 'Add');

        focusAreasFields.push(
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: includeInputId }, 'Include paths'),
            el('div', { className: 'adv-focus-areas-hint' }, 'Relative to project root. Glob patterns supported. Empty = scan everything.'),
            includeListEl,
            el('div', { className: 'adv-focus-areas-input-row' },
              includeInputEl,
              includeAddBtn,
            ),
          ),
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: excludeInputId }, 'Exclude paths'),
            el('div', { className: 'adv-focus-areas-hint' }, 'Relative to project root. Glob patterns supported.'),
            excludeListEl,
            el('div', { className: 'adv-focus-areas-input-row' },
              excludeInputEl,
              excludeAddBtn,
            ),
          ),
        );
      } else if (id === 'design') {
        // urlPatterns chip input
        const urlListEl = el('div', {
          className: 'adv-focus-areas-chip-list',
          role: 'list',
          'aria-label': 'Active URL patterns',
        });
        focusAreasChipData['urlPatterns'] = urlListEl;

        const urlInputId = `adv-focus-areas-url-${id}`;
        const urlInputEl = el('input', {
          type: 'text',
          id: urlInputId,
          className: 'adv-focus-areas-input',
          placeholder: 'e.g. /checkout/**',
          maxlength: '200',
          'aria-label': 'Add URL pattern',
        });
        focusAreasInputs['urlPatterns'] = urlInputEl;

        urlInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._addFocusAreaChip(id, 'urlPatterns', urlInputEl); }
          if (e.key === 'Backspace' && !urlInputEl.value) { e.preventDefault(); this._removeLastFocusAreaChip(id, 'urlPatterns'); }
        });

        const urlAddBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-add-btn',
          title: 'Add URL pattern',
          onClick: () => this._addFocusAreaChip(id, 'urlPatterns', urlInputEl),
        }, 'Add');

        focusAreasFields.push(
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: urlInputId }, 'URL patterns'),
            el('div', { className: 'adv-focus-areas-hint' }, 'Relative paths only — e.g. /checkout/**, /login. No scheme or hostname.'),
            urlListEl,
            el('div', { className: 'adv-focus-areas-input-row' },
              urlInputEl,
              urlAddBtn,
            ),
          ),
        );
      } else if (id === 'product') {
        // targetSegment text field (single line, max 200)
        const segmentInputId = `adv-focus-areas-segment-${id}`;
        const segmentInputEl = el('input', {
          type: 'text',
          id: segmentInputId,
          className: 'adv-focus-areas-text-input',
          placeholder: 'e.g. SMB users',
          maxlength: '200',
          'aria-label': 'Target segment',
        });
        focusAreasInputs['targetSegment'] = segmentInputEl;

        // businessGoal text field (single line, max 200)
        const goalInputId = `adv-focus-areas-goal-${id}`;
        const goalInputEl = el('input', {
          type: 'text',
          id: goalInputId,
          className: 'adv-focus-areas-text-input',
          placeholder: 'e.g. reduce churn',
          maxlength: '200',
          'aria-label': 'Business goal',
        });
        focusAreasInputs['businessGoal'] = goalInputEl;

        // Save button for product (chip-style inputs save on add; text fields need explicit save)
        const productFocusSaveStatusEl = el('span', {
          className: 'adv-focus-areas-save-status',
          role: 'status',
          'aria-live': 'polite',
        });
        focusAreasInputs['_saveStatusEl'] = productFocusSaveStatusEl;

        const productFocusSaveBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-save-btn',
          onClick: () => this._saveProductFocusAreas(id),
        }, 'Save');

        focusAreasFields.push(
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: segmentInputId }, 'Target segment'),
            el('div', { className: 'adv-focus-areas-hint' }, 'e.g. "enterprise users" — prepended as context to each run.'),
            segmentInputEl,
          ),
          el('div', { className: 'adv-focus-areas-field' },
            el('label', { className: 'adv-focus-areas-label', htmlFor: goalInputId }, 'Business goal'),
            el('div', { className: 'adv-focus-areas-hint' }, 'e.g. "reduce churn" — prepended as context to each run.'),
            goalInputEl,
          ),
          el('div', { className: 'adv-focus-areas-actions' },
            productFocusSaveBtn,
            productFocusSaveStatusEl,
            el('span', { className: 'adv-focus-areas-next-run-note' }, 'Applies on next scheduled run.'),
          ),
        );
      }

      const focusAreasNote = el('div', { className: 'adv-focus-areas-note' },
        'Changes apply on the next scheduled run.',
      );

      const focusAreasSectionBodyEl = el('div', {
        className: 'adv-focus-areas-body adv-hidden',
        id: focusSectionBodyId,
      },
        ...focusAreasFields,
        id !== 'product' ? focusAreasNote : null,
      );

      focusAreasSectionEl = el('div', { className: 'adv-focus-areas-section' },
        el('div', { className: 'adv-focus-areas-header' },
          focusAreasToggle,
          focusAreasSummaryChipEl,
        ),
        focusAreasSectionBodyEl,
      );

      // Store refs for render updates
      this._focusAreasState = this._focusAreasState || {};
      this._focusAreasState[id] = {
        sectionEl: focusAreasSectionEl,
        bodyEl: focusAreasSectionBodyEl,
        toggleEl: focusAreasToggle,
        summaryChipEl: focusAreasSummaryChipEl,
        chipData: focusAreasChipData,
        inputs: focusAreasInputs,
      };

      perfSectionBody.appendChild(focusAreasSectionEl);
    }

    // ── DK-124: Focus area pinning ──────────────────────────────
    // Shown for engineer and design only (product has no file/URL mappings).
    // Engineer: file glob patterns — pinned files appear first in the scan list.
    // Design: URL path patterns — pinned URLs appear first in the screenshot queue.
    // Save on explicit button press (not on keystroke/blur) — changes affect agent behavior.
    // Data: stored at project.advisorPins.{engineer|design} as string[].
    const PINS_PERSONAS = new Set(['engineer', 'design']);
    if (PINS_PERSONAS.has(id)) {
      const pinsSectionId = `adv-pins-section-${id}`;
      const pinsBodyId = `adv-pins-body-${id}`;
      let pinsSectionOpen = false;

      // Per-persona metadata
      const pinsMeta = id === 'engineer'
        ? {
            label: 'Focus areas',
            inputLabel: 'Pinned file globs',
            placeholder: 'e.g. src/payments/**',
            hint: 'Relative globs only — these paths run first. The full codebase is still included.',
            addAriaLabel: 'Add pinned file glob',
            chipAriaLabel: 'Active pinned file globs',
            maxLen: 64,
          }
        : {
            label: 'Focus areas',
            inputLabel: 'Pinned URL paths',
            placeholder: '/checkout',
            hint: 'Relative paths starting with /. These pages are screenshotted first. The full audit still runs.',
            addAriaLabel: 'Add pinned URL path',
            chipAriaLabel: 'Active pinned URL paths',
            maxLen: 200,
          };

      // Summary chip (shown in header when any pin is active)
      const pinsSummaryChipEl = el('span', {
        className: 'adv-pins-summary-chip adv-hidden',
        'aria-label': 'Focus area pins active',
        title: 'This persona will prioritize your pinned paths on each run',
      });

      // Collapse toggle
      const pinsToggleBtn = el('button', {
        type: 'button',
        className: 'adv-pins-toggle',
        'aria-expanded': 'false',
        'aria-controls': pinsBodyId,
        id: pinsSectionId,
        onClick: () => {
          pinsSectionOpen = !pinsSectionOpen;
          pinsToggleBtn.setAttribute('aria-expanded', String(pinsSectionOpen));
          pinsBodyEl.classList.toggle('adv-hidden', !pinsSectionOpen);
          pinsToggleBtn.textContent = pinsSectionOpen ? `${pinsMeta.label} ▾` : `${pinsMeta.label} ▸`;
        },
      }, `${pinsMeta.label} ▸`);

      // Chip list (read-only display; remove is via delete button on each chip)
      const pinsChipListEl = el('div', {
        className: 'adv-pins-chip-list',
        role: 'list',
        'aria-label': pinsMeta.chipAriaLabel,
      });

      // Validation message element
      const pinsValidationEl = el('span', {
        className: 'adv-pins-validation',
        role: 'status',
        'aria-live': 'polite',
      });

      // Text input
      const pinsInputId = `adv-pins-input-${id}`;
      const pinsInputEl = el('input', {
        type: 'text',
        id: pinsInputId,
        className: 'adv-pins-input',
        placeholder: pinsMeta.placeholder,
        maxlength: String(pinsMeta.maxLen),
        'aria-label': pinsMeta.addAriaLabel,
        'aria-describedby': `adv-pins-validation-${id}`,
      });
      pinsValidationEl.id = `adv-pins-validation-${id}`;

      pinsInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._addPinsChip(id, pinsInputEl, pinsValidationEl);
        }
        if (e.key === 'Backspace' && !pinsInputEl.value) {
          e.preventDefault();
          this._removeLastPinsChip(id, pinsValidationEl);
        }
      });

      // Add button
      const pinsAddBtn = el('button', {
        type: 'button',
        className: 'adv-pins-add-btn',
        title: pinsMeta.addAriaLabel,
        onClick: () => this._addPinsChip(id, pinsInputEl, pinsValidationEl),
      }, 'Add');

      // Save button + status
      const pinsSaveStatusEl = el('span', {
        className: 'adv-pins-save-status',
        role: 'status',
        'aria-live': 'polite',
      });
      const pinsSaveBtn = el('button', {
        type: 'button',
        className: 'adv-pins-save-btn',
        title: 'Save pinned focus areas',
        onClick: () => this._savePins(id),
      }, 'Save');

      // Staleness warning — surfaced when a pin target no longer exists
      const pinsStaleEl = el('div', {
        className: 'adv-pins-stale adv-hidden',
        role: 'status',
        'aria-live': 'polite',
      });

      // "Weighted, not exclusive" callout — conveyed in text per accessibility requirement
      const pinsWeightNote = el('div', { className: 'adv-pins-weight-note' },
        'These paths run first — the full codebase is still included.',
      );

      // Section body
      const pinsBodyEl = el('div', {
        className: 'adv-pins-body adv-hidden',
        id: pinsBodyId,
      },
        pinsStaleEl,
        el('div', { className: 'adv-pins-field' },
          el('label', { className: 'adv-pins-label', htmlFor: pinsInputId }, pinsMeta.inputLabel),
          el('div', { className: 'adv-pins-hint' }, pinsMeta.hint),
          pinsChipListEl,
          el('div', { className: 'adv-pins-input-row' },
            pinsInputEl,
            pinsAddBtn,
          ),
          pinsValidationEl,
        ),
        pinsWeightNote,
        el('div', { className: 'adv-pins-actions' },
          pinsSaveBtn,
          pinsSaveStatusEl,
        ),
        el('div', { className: 'adv-focus-areas-note' }, 'Applies on next scheduled run.'),
      );

      const pinsSectionEl = el('div', { className: 'adv-pins-section' },
        el('div', { className: 'adv-pins-header' },
          pinsToggleBtn,
          pinsSummaryChipEl,
        ),
        pinsBodyEl,
      );

      // Store refs
      this._pinsState = this._pinsState || {};
      this._pinsState[id] = {
        sectionEl: pinsSectionEl,
        bodyEl: pinsBodyEl,
        toggleEl: pinsToggleBtn,
        summaryChipEl: pinsSummaryChipEl,
        chipListEl: pinsChipListEl,
        inputEl: pinsInputEl,
        saveBtn: pinsSaveBtn,
        saveStatusEl: pinsSaveStatusEl,
        stalenessEl: pinsStaleEl,
        validationEl: pinsValidationEl,
      };
      this._pinsDraft[id] = [];

      perfSectionBody.appendChild(pinsSectionEl);
    }

    // ── DK-187: Persona focus constraints (scope targeting) ────
    // Only shown for engineer, design, and product personas.
    // Focus is per-persona (not per-project): stored at /advisor/{personaId}.focus
    // and validated server-side on every daemon read.
    const FOCUS_CONSTRAINTS_PERSONAS = new Set(['engineer', 'design', 'product']);
    if (FOCUS_CONSTRAINTS_PERSONAS.has(id)) {
      const fcSectionId = `adv-fc-section-${id}`;
      const fcBodyId = `adv-fc-body-${id}`;
      let fcSectionOpen = false;
      let fcDirty = false;

      // Label and placeholder vary per persona
      const fcMeta = {
        engineer: {
          label: 'Prompt Focus: File Globs',
          placeholder: 'e.g. src/payments/**',
          hint: 'Glob patterns (relative). Empty = analyse all files.',
          summaryUnit: 'glob',
        },
        design: {
          label: 'Prompt Focus: Route Paths',
          placeholder: 'e.g. /checkout',
          hint: 'Route paths starting with /. Empty = audit all routes.',
          summaryUnit: 'route',
        },
        product: {
          label: 'Prompt Focus: Keywords',
          placeholder: 'e.g. billing',
          hint: 'Feature keywords. Empty = surface ideas across all areas.',
          summaryUnit: 'keyword',
        },
      }[id];

      const fcFieldKey = { engineer: 'globs', design: 'routes', product: 'keywords' }[id];

      // Summary chip shown in header when focus is active
      const fcSummaryChipEl = el('span', {
        className: 'adv-fc-summary-chip adv-hidden',
        title: `Prompt focus constraints are active for this persona`,
      });

      // Chip list
      const fcChipListEl = el('div', {
        className: 'adv-focus-areas-chip-list',
        role: 'list',
        'aria-label': `Active ${fcMeta.summaryUnit}s`,
      });

      // Text input
      const fcInputId = `adv-fc-input-${id}`;
      const fcInputEl = el('input', {
        type: 'text',
        id: fcInputId,
        className: 'adv-focus-areas-input',
        placeholder: fcMeta.placeholder,
        maxlength: id === 'product' ? '50' : '100',
        'aria-label': `Add ${fcMeta.summaryUnit}`,
      });

      // Mark dirty on input
      fcInputEl.addEventListener('input', () => {
        if (!fcDirty) {
          fcDirty = true;
          if (this._focusConstraintsState[id]) this._focusConstraintsState[id].dirty = true;
          const { saveBtn } = this._focusConstraintsState[id] || {};
          if (saveBtn) saveBtn.classList.add('adv-fc-save-dirty');
        }
      });

      // Enter to add, Backspace on empty to remove last chip
      fcInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._addFocusConstraintChip(id, fcInputEl); }
        if (e.key === 'Backspace' && !fcInputEl.value) { e.preventDefault(); this._removeLastFocusConstraintChip(id); }
      });

      // Add button
      const fcAddBtn = el('button', {
        type: 'button',
        className: 'adv-focus-areas-add-btn',
        title: `Add ${fcMeta.summaryUnit}`,
        onClick: () => this._addFocusConstraintChip(id, fcInputEl),
      }, 'Add');

      // Save button + status
      const fcSaveStatusEl = el('span', {
        className: 'adv-fc-save-status',
        role: 'status',
        'aria-live': 'polite',
      });
      const fcSaveBtn = el('button', {
        type: 'button',
        className: 'adv-fc-save-btn',
        title: 'Save focus constraints',
        onClick: () => this._saveFocusConstraints(id),
      }, 'Save');

      // Clear button (one-click return to unconstrained mode)
      const fcClearBtn = el('button', {
        type: 'button',
        className: 'adv-fc-clear-btn',
        title: 'Clear all focus constraints — return to watching everything',
        onClick: () => this._clearFocusConstraints(id),
      }, 'Clear focus');

      // Collapse toggle
      const fcToggleBtn = el('button', {
        type: 'button',
        className: 'adv-fc-toggle',
        'aria-expanded': 'false',
        'aria-controls': fcBodyId,
        id: fcSectionId,
        onClick: () => {
          fcSectionOpen = !fcSectionOpen;
          fcToggleBtn.setAttribute('aria-expanded', String(fcSectionOpen));
          fcBodyEl.classList.toggle('adv-hidden', !fcSectionOpen);
          fcToggleBtn.textContent = fcSectionOpen ? 'Focus… ▾' : 'Focus… ▸';
          if (fcSectionOpen && this._mounted) {
            // Move focus into input when expanding (accessibility spec)
            setTimeout(() => fcInputEl.focus(), 50);
          }
        },
      }, 'Focus… ▸');

      // Body
      const fcBodyEl = el('div', {
        className: 'adv-fc-body adv-hidden',
        id: fcBodyId,
      },
        el('div', { className: 'adv-focus-areas-field' },
          el('label', { className: 'adv-focus-areas-label', htmlFor: fcInputId }, fcMeta.label),
          el('div', { className: 'adv-focus-areas-hint' }, fcMeta.hint),
          fcChipListEl,
          el('div', { className: 'adv-focus-areas-input-row' },
            fcInputEl,
            fcAddBtn,
          ),
        ),
        el('div', { className: 'adv-fc-actions' },
          fcSaveBtn,
          fcClearBtn,
          fcSaveStatusEl,
        ),
        el('div', { className: 'adv-focus-areas-note' }, 'Applies on next scheduled run.'),
      );

      const fcSectionEl = el('div', { className: 'adv-fc-section' },
        el('div', { className: 'adv-fc-header' },
          fcToggleBtn,
          fcSummaryChipEl,
        ),
        fcBodyEl,
      );

      // Store refs
      this._focusConstraintsState = this._focusConstraintsState || {};
      this._focusConstraintsState[id] = {
        sectionEl: fcSectionEl,
        bodyEl: fcBodyEl,
        toggleEl: fcToggleBtn,
        summaryChipEl: fcSummaryChipEl,
        chipListEl: fcChipListEl,
        inputEl: fcInputEl,
        saveBtn: fcSaveBtn,
        saveStatusEl: fcSaveStatusEl,
        clearBtn: fcClearBtn,
        fieldKey: fcFieldKey,
        dirty: false,
      };

      perfSectionBody.appendChild(fcSectionEl);
    }

    // ── DK-112: Topic Exclusion Rules ─────────────────────────
    // Shown for engineer, design, and product personas.
    // Lets users define a list of topics this persona should never propose.
    // Stored at project.advisor.topicExclusions.{personaId} as string[].
    // Injected into the system prompt at runtime by prompt-builder.js.
    let topicExclTagListEl = null;
    let topicExclInputEl = null;
    let topicExclValidationEl = null;
    let topicExclAddBtn = null;
    let topicExclSectionEl = null;

    const TOPIC_EXCL_PERSONAS = new Set(['engineer', 'design', 'product']);
    if (TOPIC_EXCL_PERSONAS.has(id)) {
      const texSectionId = `adv-tex-section-${id}`;
      const texInputId = `adv-tex-input-${id}`;

      topicExclValidationEl = el('span', {
        className: 'adv-exclusion-validation',
        role: 'status',
        'aria-live': 'polite',
        id: `adv-tex-validation-${id}`,
      });

      topicExclInputEl = el('input', {
        type: 'text',
        id: texInputId,
        className: 'adv-exclusion-input',
        placeholder: 'e.g. dark mode, authentication, onboarding',
        maxLength: 100,
        'aria-label': 'Add topic exclusion rule',
        'aria-describedby': `adv-tex-validation-${id}`,
        onInput: () => this._validateTopicExclInput(topicExclInputEl, topicExclValidationEl),
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._addTopicExclusion(id, topicExclInputEl, topicExclValidationEl);
          }
        },
      });

      topicExclAddBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-add-btn',
        title: 'Add topic exclusion rule',
        onClick: () => this._addTopicExclusion(id, topicExclInputEl, topicExclValidationEl),
      }, 'Add');

      topicExclTagListEl = el('div', {
        className: 'adv-exclusion-tag-list',
        role: 'list',
        'aria-label': 'Active topic exclusion rules',
      });

      // Cold start placeholder — shown when rules list is empty
      const topicExclEmptyEl = el('span', {
        className: 'adv-exclusion-empty adv-tex-empty',
      }, 'No exclusion rules set. The fastest way to add rules is via the "Never suggest" button on proposal cards in the triage queue.');

      topicExclTagListEl.appendChild(topicExclEmptyEl);

      topicExclSectionEl = el('div', {
        className: 'adv-exclusion-section adv-tex-section',
        id: texSectionId,
      },
        el('div', { className: 'adv-exclusion-hint' },
          'Topics this persona should never propose. Plain keywords or short phrases — no globs or regex.',
        ),
        topicExclTagListEl,
        el('div', { className: 'adv-exclusion-input-row' },
          el('label', { className: 'adv-exclusion-label', htmlFor: texInputId }, 'Topic exclusions'),
          topicExclInputEl,
          topicExclAddBtn,
        ),
        topicExclValidationEl,
      );

      perfSectionBody.appendChild(topicExclSectionEl);
    }

    // ── DK-105: Emphasis weights ───────────────────────────────
    // Only shown for the three built-in advisor personas that support weights.
    // (QA persona is out of scope for v1.)
    const weightConcerns = PERSONA_CONCERNS[id];
    if (weightConcerns) {
      const weightSectionId = `adv-weights-section-${id}`;
      const weightHeadingId = `adv-weights-heading-${id}`;

      // Default weights (all 1) — used until project data loads or overrides
      const defaultWeights = Object.fromEntries(weightConcerns.map(k => [k, 1]));
      this._weightsDraft[id] = { ...defaultWeights };
      this._weightsInputs[id] = {};

      // ── Summary line (plain-language description of current weights) ──
      const weightSummaryEl = el('p', {
        className: 'adv-weights-summary',
        role: 'status',
        'aria-live': 'polite',
      }, buildWeightSummary(defaultWeights, id));
      this._weightsSummaryEls[id] = weightSummaryEl;

      // ── Cross-persona note (one line of helper text per spec) ──
      const crossPersonaNote = el('p', { className: 'adv-weights-cross-persona-note' },
        'These weights apply within this persona only — they do not affect other personas\u2019 output or global ticket ordering.',
      );

      // ── Preset profile buttons ──────────────────────────────
      const presets = WEIGHT_PRESETS[id] || [];
      const presetRow = el('div', { className: 'adv-weights-preset-row', role: 'group', 'aria-label': 'Preset profiles' });
      for (const preset of presets) {
        const presetBtn = el('button', {
          type: 'button',
          className: 'adv-weights-preset-btn',
          title: `Apply "${preset.label}" preset`,
          onClick: () => {
            // Apply preset to draft and update inputs
            for (const k of weightConcerns) {
              const v = preset.weights[k] ?? 1;
              this._weightsDraft[id][k] = v;
              const inp = this._weightsInputs[id]?.[k];
              if (inp) inp.value = String(v);
            }
            // Regenerate summary
            if (this._weightsSummaryEls[id]) {
              this._weightsSummaryEls[id].textContent = buildWeightSummary(this._weightsDraft[id], id);
            }
          },
        }, preset.label);
        presetRow.appendChild(presetBtn);
      }

      // ── Concern rows (numeric input + label + description) ───
      const concernsContainer = el('div', { className: 'adv-weights-concerns' });
      for (const key of weightConcerns) {
        const meta = CONCERN_META[key] || { label: key, desc: '' };
        const inputId = `adv-weight-${id}-${key}`;
        const numInput = el('input', {
          type: 'number',
          className: 'adv-weight-input',
          id: inputId,
          min: '1',
          max: '5',
          value: '1',
          'aria-label': `${meta.label} weight (1–5)`,
          title: meta.desc,
          onInput: () => {
            const v = parseInt(numInput.value, 10);
            if (Number.isInteger(v) && v >= 1 && v <= 5) {
              this._weightsDraft[id][key] = v;
              // Update summary live
              if (this._weightsSummaryEls[id]) {
                this._weightsSummaryEls[id].textContent = buildWeightSummary(this._weightsDraft[id], id);
              }
            }
          },
        });
        this._weightsInputs[id][key] = numInput;

        // Text label (High/Medium/Low) adjacent to input — accessibility requirement
        const weightLevelEl = el('span', { className: 'adv-weight-level-label', 'aria-hidden': 'true' });
        numInput.addEventListener('input', () => {
          const v = parseInt(numInput.value, 10);
          weightLevelEl.textContent = v >= 4 ? 'High' : v === 3 ? 'Medium' : 'Low';
        });
        // Initialize
        weightLevelEl.textContent = 'Low';

        concernsContainer.appendChild(
          el('div', { className: 'adv-weight-row' },
            numInput,
            weightLevelEl,
            el('label', { htmlFor: inputId, className: 'adv-weight-label' },
              el('strong', {}, meta.label),
              el('span', { className: 'adv-weight-desc' }, ` — ${meta.desc}`),
            ),
          )
        );
      }

      // ── Save button + status ─────────────────────────────────
      const weightSaveStatusEl = el('span', {
        className: 'adv-weights-save-status',
        role: 'status',
        'aria-live': 'polite',
      });
      const weightSaveBtn = el('button', {
        type: 'button',
        className: 'adv-weights-save-btn',
        onClick: () => this._saveWeights(id),
      }, 'Save weights');

      // ── Reset button ─────────────────────────────────────────
      const weightResetBtn = el('button', {
        type: 'button',
        className: 'adv-weights-reset-btn',
        title: 'Reset all weights to default (1)',
        onClick: () => {
          for (const k of weightConcerns) {
            this._weightsDraft[id][k] = 1;
            const inp = this._weightsInputs[id]?.[k];
            if (inp) inp.value = '1';
          }
          // Update level labels
          const levelLabels = weightSectionEl.querySelectorAll('.adv-weight-level-label');
          levelLabels.forEach(lbl => { lbl.textContent = 'Low'; });
          if (this._weightsSummaryEls[id]) {
            this._weightsSummaryEls[id].textContent = buildWeightSummary(this._weightsDraft[id], id);
          }
        },
      }, 'Reset to defaults');

      this._weightsSaveEls[id] = { btn: weightSaveBtn, statusEl: weightSaveStatusEl };

      const weightSaveRow = el('div', { className: 'adv-weights-save-row' },
        weightSaveBtn,
        weightResetBtn,
        weightSaveStatusEl,
      );

      const weightSectionEl = el('section', {
        className: 'adv-weights-section',
        id: weightSectionId,
        'aria-labelledby': weightHeadingId,
      },
        el('h4', {
          className: 'adv-weights-heading',
          id: weightHeadingId,
        }, 'Emphasis weights'),
        crossPersonaNote,
        presetRow,
        concernsContainer,
        weightSummaryEl,
        weightSaveRow,
      );

      perfSectionBody.appendChild(weightSectionEl);
    }

    // ── Run summary line ───────────────────────────────────────
    // e.g. "ran 4h ago · 0 proposals"
    const runSummaryEl = el('div', { className: 'adv-run-summary' }, '—');
    perfSectionBody.appendChild(runSummaryEl);

    // ── Performance dashboard expansion ────────────────────────
    const perfDashContainer = el('div', { className: 'adv-perf-dash adv-perf-dash-hidden' });
    perfSectionBody.appendChild(perfDashContainer);
    this._perfDashContainers[id] = perfDashContainer;

    // ── Activity subsection (collapsible) ──────────────────────
    // Starts collapsed by default (expanded key absent from set)
    const actSectionKey = `${id}:activity`;
    const actSectionExpanded = this._collapsedCardSections.has(actSectionKey);
    const actChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, actSectionExpanded ? '▾' : '▸');
    const actSectionHeader = el('button', {
      className: 'adv-card-subsection-header',
      'aria-expanded': String(actSectionExpanded),
      'aria-controls': `adv-act-section-${id}`,
      onClick: () => this._toggleCardSection(actSectionKey, actSectionBody, actChevron, actSectionHeader),
    },
      actChevron,
      el('span', {}, 'Activity'),
    );
    cardBody.appendChild(actSectionHeader);

    const actSectionBody = el('div', {
      className: 'adv-card-subsection-body',
      id: `adv-act-section-${id}`,
    });
    if (!actSectionExpanded) actSectionBody.classList.add('adv-hidden');
    cardBody.appendChild(actSectionBody);

    // ── Per-card history (collapsed by default) ─────────────────
    const historyToggleBtn = el('button', {
      className: 'adv-card-history-toggle',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `adv-card-history-${id}`,
      onClick: () => this._toggleCardHistory(id),
    }, 'History ▸');

    const historyRefreshBtn = el('button', {
      className: 'adv-history-refresh-btn adv-hidden',
      title: 'Refresh run history',
      'aria-label': 'Refresh history',
      onClick: () => this._loadHistoryRuns(id),
    }, '↺');

    const testRailsBtn = id === 'qa' ? el('button', {
      className: 'adv-card-history-toggle adv-test-rails-btn',
      type: 'button',
      title: 'View and edit QA test rails',
      onClick: () => this._openTestRailsModal(),
    }, 'Test Rails ▸') : null;

    // Inline preview of the saved focus prompt — visible when focus area is collapsed
    // and a saved focus prompt is set. Hidden when expanded or no saved prompt.
    const focusPreviewEl = el('span', {
      className: 'adv-focus-preview adv-hidden',
      'aria-hidden': 'true',
    });

    const historyHeaderRow = el('div', { className: 'adv-card-history-header' },
      focusToggleBtn,
      focusPreviewEl,
      logToggleBtn,
      logClearBtn,
      testRailsBtn,
      historyToggleBtn,
      historyRefreshBtn,
    );

    const historyPanel = el('div', {
      className: 'adv-card-history-panel adv-hidden',
      id: `adv-card-history-${id}`,
    });
    this._historyPanels[id] = historyPanel;

    actSectionBody.appendChild(historyHeaderRow);
    actSectionBody.appendChild(focusArea);
    actSectionBody.appendChild(logContainer);
    actSectionBody.appendChild(historyPanel);

    this._cards[id] = { card, cardBody, collapseBtn, collapsedSummaryEl, avatarEl, statusDot, statusText, soulBtn, constraintsBtn, constraintChipEl, statsBtn, pauseBtn, pauseCheckbox, pauseTextEl, runNowBtn, runPromptExpander, runPromptInput, runPromptSubmitBtn, runPromptCancelBtn, runScopeInput, runScopeNudge, previewRunBtn, runStateEl, timeHintEl, focusTextarea, focusToggleBtn, focusPreviewEl, focusDirtyDot, savedFocusEl, activityEl: null, logToggleBtn, logClearBtn, logContainer, logList, countdownEl: headerCountdownEl, intervalInput, intervalUnitSelect, intervalSavedEl, ticketsEl, cyclesEl, runSummaryEl, historyToggleBtn, historyRefreshBtn, historyPanel, testRailsBtn, feedbackToggleCheckbox, feedbackToggleStatusEl, feedbackToggleRow, feedbackStatSummaryEl, feedbackStatExpandBtn, feedbackStatRow, feedbackDetailEl, capInput, capSavedEl, exclusionSectionEl, exclusionTagListEl, exclusionInputEl, exclusionValidationEl, exclusionAddBtn, exclusionSkipCountEl, dedupRadioRow, dedupSavedEl, lastRunLineEl,
      // DK-195: timezone-aware schedule refs
      tzSelect, startTimeInput, endTimeInput, nextRunEl, noRunsWarningEl,
      // legacy schedule refs (null = replaced by new UI; kept so old checks don't crash)
      startHourSelect: null, endHourSelect: null, dayButtons, timeWindowSavedEl, timeWindowBody, timeWindowToggleBtn,
      // DK-112: topic exclusion rules refs
      topicExclTagListEl, topicExclInputEl, topicExclValidationEl, topicExclAddBtn, topicExclSectionEl,
      // DK-136: trigger pills + progress counter
      intervalPill, webhookPill, manualPill, triggerProgressEl };
    return card;
  }




};
