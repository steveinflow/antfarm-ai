// AdvisorPanel — left sidebar showing EPD Advisor persona status.
// Reads /advisor/{product,design,engineer} from Firestore in real-time.
// Writes pause/resume and intervalHours changes back.
// Shows a Context button in the header for editing the current project's advisorContext.
// History tab: queries advisorRuns collection per persona, last 20 runs.
// Performance dashboard: per-persona stats (generated/accepted/rejected/snoozed)
//   with 30/90-day filter and CSS sparkline. Inline expansion within each persona card.

import { showConfirmModal } from './confirm-modal.js';
import { createSaveOnBlur } from './save-on-blur.js';
import {
  PERSONAS,
  PERSONA_INTERVAL_HINTS,
  PERSONA_DIRECTIVE_PLACEHOLDERS,
  PERSONA_DIRECTIVE_DESCRIPTIONS,
  RESERVED_NAMES,
  CUSTOM_PERSONA_MODELS,
  SCHEDULE_PRESETS,
  CUSTOM_PERSONA_STARTER,
  CONTEXT_EXAMPLES,
  CONTEXT_KNOWN_BAD,
  PERSONA_DISPLAY_NAMES,
  PERSONA_AVATARS,
} from './advisor/config/personas.js';
import {
  PERSONA_CONCERNS,
  CONCERN_META,
  WEIGHT_PRESETS,
} from './advisor/config/concerns.js';
import { DEFAULT_SOUL_PROMPTS } from './advisor/config/soul-prompts.js';
import {
  ERROR_REASON_LABELS,
  FILTER_REASON_LABELS,
  REJECTION_REASON_LABELS,
  REJECTION_REASON_ICONS,
  HEALTH_META,
} from './advisor/config/labels.js';
import {
  ACCEPTED_STATUSES,
  REJECTED_STATUSES,
} from './advisor/config/statuses.js';
import { el } from './advisor/ui/el.js';
import {
  toDate,
  toMs,
  daysAgo,
  formatCountdown,
  formatRelative,
  formatHour12,
  formatDuration,
  formatRelativeTs,
  formatAbsolute,
  formatLastRunLine,
} from './advisor/ui/format.js';
import {
  computeSparkline,
  computeStats,
  healthFromRate,
  buildSparklineSvg,
  buildSparklineAriaLabel,
} from './advisor/ui/sparkline.js';

import {
  getContextQuality,
  slugifyName,
  sanitizePromptValue,
  filterReasonLabel,
  buildWeightSummary,
  rejectionCounts,
  buildWhyText,
  buildRunTrendText,
  createAvatarEl,
} from './advisor/helpers/persona.js';
import {
  computeNextRunCountdown,
  _computeNextRunCountdownLegacy,
} from './advisor/helpers/countdown.js';
import { triggerLogMixin } from './advisor/views/trigger-log.js';
import { runLogMixin } from './advisor/views/run-log.js';
import { backlogMixin } from './advisor/views/backlog.js';
import { modalsMixin } from './advisor/views/modals.js';
import { customPersonasMixin } from './advisor/views/custom-personas.js';
import { templatesMixin } from './advisor/views/templates.js';
import { dryRunMixin } from './advisor/views/dry-run.js';
import { focusMixin } from './advisor/views/focus.js';
import { historyMixin } from './advisor/views/history.js';

/**
 * AdvisorPanel
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {object} opts.db - Firestore client instance
 */
export class AdvisorPanel {
  constructor({ container, db }) {
    this.container = container;
    this.db = db;

    this._mounted = false;
    this._root = null;
    this._unsubs = [];
    this._states = {}; // personaId -> Firestore data
    this._cards  = {}; // personaId -> { el, fields... }
    this._ticker = null;
    this._logExpanded = {}; // personaId -> boolean
    this._statesReceived = {}; // personaId -> boolean — true once we've received at least one snapshot

    // Projects data (still subscribed for context editing; section at bottom removed)
    this._projects = [];         // current project list (all from Firestore)
    this._filterProjectId = null; // null = show all, string = show only this project

    // YOLO mode toggle button (in panel header)
    this._yoloBtn = null;

    // Pause All button (in panel header) — pauses/resumes all built-in personas globally
    this._pauseAllBtn = null;

    // Context panel (top of panel, for current project's advisorContext)
    this._contextPanel = null;       // container element
    this._contextTextarea = null;    // textarea element
    this._contextActionBtn = null;   // edit/save button
    this._contextStatusEl = null;    // status text element
    this._contextPanelOpen = false;  // whether context panel is expanded

    // DK-302: Current Priorities field state
    // Per-project short-form priorities injected into all persona system prompts.
    // Stored at projects/{id}.advisorContext.priorities + .prioritiesUpdatedAt
    this._prioritiesTextarea = null;     // textarea element
    this._prioritiesCharCountEl = null;  // live character counter element
    this._prioritiesTimestampEl = null;  // relative "Updated X ago" element
    this._prioritiesSaveStatusEl = null; // ARIA live region for "Saved" confirmation
    this._prioritiesDebounceTimer = null; // debounce timer id
    this._prioritiesBannerEl = null;     // dismissible "Add priorities" banner element
    this._prioritiesBannerDismissed = false; // session-level dismiss state
    this._prioritiesPreviewEls = {};     // personaId -> one-line preview element in run results

    // Advisor context presets (DK-193) — named advisorContext configurations per project
    this._presets = [];                  // array of { id, name, advisorContext, createdAt, updatedAt }
    this._presetsUnsub = null;           // Firestore unsubscribe for presets listener
    this._presetsProjectId = null;       // project ID currently subscribed for presets
    this._presetSelectEl = null;         // <select> dropdown element
    this._presetSaveAsBtn = null;        // "Save as…" button element
    this._presetDriftEl = null;          // "edited" indicator + Revert link element
    this._presetDeleteBtn = null;        // delete-preset button element
    this._presetSaveModal = null;        // active "Save as preset" modal overlay
    this._presetDeleteModal = null;      // active delete-preset confirm modal overlay
    this._lastAppliedPresetId = null;    // ID of last applied preset (for drift detection)
    this._contextDirty = false;          // true when textarea differs from last applied preset
    this._contextCharCountEl = null;     // character count element beneath textarea
    this._contextQualityEl = null;       // quality indicator element (DK-120)
    this._contextFocused = false;        // true while textarea has focus (DK-120)
    this._contextModifiedThisSession = false; // true once user edits field this session (DK-120)

    // Persona instructions panel (DK-133) — tabbed editor for per-persona custom instructions
    this._personaInstrPanel = null;          // container element
    this._personaInstrOpen = {};             // personaId -> boolean (section expanded) — kept for compat
    this._personaInstrTextareas = {};        // personaId -> textarea element (project instructions)
    this._personaInstrGlobalTextareas = {};  // personaId -> textarea element (global instructions, read-only display)
    this._personaInstrSaveBtns = {};         // personaId -> save button element
    this._personaInstrStatusEls = {};        // personaId -> status element
    this._personaInstrLastSavedEls = {};     // personaId -> last-saved element
    this._personaInstrDirty = {};            // personaId -> boolean (unsaved changes)
    this._personaInstrSaveControls = {};     // (kept for compat, no longer used for new save flow)
    this._personaInstrActiveTab = 'engineer'; // currently selected tab
    this._personaInstrUseGlobal = {};        // personaId -> boolean (true = use global, not project override)
    this._personaInstrGlobalData = {};       // personaId -> string (global instructions from /advisor/{personaId})
    this._personaInstrLastFetched = {};      // personaId -> string (last Firestore value, for dirty detection)
    this._personaInstrGlobalUnsub = null;    // Firestore unsubscribe for /advisor/* listener
    this._personaInstrLiveRegion = null;     // aria-live region for save confirmations

    // Soul modal
    this._soulModal = null;      // modal overlay element (appended to document.body)
    this._soulModalPersonaId = null;

    // Focus prompt auto-save (DK-353)
    this._focusSaveControls = {};    // personaId -> save-on-blur control object

    // Persona config templates (DK-141)
    this._templates = [];              // array of { id, name, description, createdAt, lastUsedAt, config }
    this._templatesUnsub = null;       // Firestore unsubscribe for templates listener
    this._templatesSection = null;     // container element for the Templates section
    this._templatesSectionBody = null; // collapsible body element
    this._saveTemplateModal = null;    // active Save as template modal overlay
    this._templateWarnModal = null;    // active apply-template warning modal overlay

    // Test Rails modal (QA persona only)
    this._testRailsModal = null;

    // Per-card history (collapsed by default inside each persona card)
    this._historyPanels  = {};        // personaId -> panel container element
    this._historyRuns    = {};        // personaId -> array of run records (or null = not loaded)
    this._historyLoading = {};        // personaId -> boolean
    this._historyOpen    = {};        // personaId -> boolean (is the history section expanded?)
    this._historyUnsubs  = {};        // personaId -> unsubscribe fn for active query
    this._historyExpanded = {};       // runId -> boolean (expanded state of each row)

    // Custom personas
    this._customPersonas = [];       // array of custom persona definitions from Firestore
    this._customPersonasBody = null; // container element for custom persona cards
    this._customModal = null;        // active custom persona modal overlay
    this._liveRegion = null;         // ARIA live region for status announcements
    this._volumeWarningEl = null;    // volume warning element (updated on state changes)
    this._addPersonaBtn = null;      // "Add Persona" button (disabled when at cap)

    // Performance dashboard
    this._perfDashExpanded = {};     // personaId -> boolean (is the dashboard expanded?)
    this._perfDashData = {};         // personaId -> { tickets, fetchedAt } | null
    this._perfDashLoading = {};      // personaId -> boolean
    this._perfDashWindowDays = 30;   // current time window (30 or 90)
    this._perfDashContainers = {};   // personaId -> the collapsible dashboard container el

    // On-demand run timers — per-persona elapsed time intervals
    this._runTimers = {};            // personaId -> setInterval id

    // Current user (for trigger requestedBy field)
    this._currentUser = null;

    // Feedback signal state
    this._feedbackDetailExpanded = {};  // personaId -> boolean
    this._feedbackStats = {};           // personaId -> stats object | null
    this._feedbackStatsLoading = {};    // personaId -> boolean

    // DK-128: Exclusion list state
    // Engineer exclusions are glob patterns (string[]) stored at project.exclusions.engineer
    // Design exclusions are URL prefix patterns (string[]) stored at project.exclusions.design
    this._exclusionSaving = {};         // personaId -> boolean (save in progress)

    // DK-112: Topic exclusion rules state
    // Stored at project.advisor.topicExclusions.{engineer,design,product} as string[]
    // Injected into system prompt at runtime — admins only, prompt injection risk.
    this._topicExclSaving = {};         // personaId -> boolean (save in progress)

    // Collapsible cards — persisted in localStorage
    this._collapsedPersonas = this._loadCollapsedState(); // Set<personaId>

    // Collapsible top-level sidebar sections — persisted in localStorage
    this._collapsedSections = this._loadSectionCollapseState(); // Set<sectionId>

    // Collapsible per-card subsections (Activity, Performance) — persisted in localStorage
    this._collapsedCardSections = this._loadCardSectionCollapseState(); // Set<"personaId:sectionId">

    // Run log drawer (DK-189) — right-side drawer showing last 20 advisor runs
    this._runLogDrawer = null;         // drawer overlay element (appended to document.body)
    this._runLogDrawerOpen = false;    // current open/close state
    this._runLogRuns = null;           // array of run records | null (not yet loaded)
    this._runLogLoading = false;       // loading spinner state
    this._runLogExpanded = {};         // runId -> boolean (expanded accordion rows)
    this._runLogBtn = null;            // trigger button element (set in _buildUI)
    this._runLogTicketTitles = {};     // docId -> title (cache for ticket title lookup)
    // Pre-scrolled run ID from ticket attribution click (DK-189)
    this._runLogFocusRunId = null;     // runId to highlight/scroll to on open

    // DK-136: Trigger log drawer — shows advisorTriggerLog entries
    this._triggerLogDrawer = null;      // drawer overlay element (appended to document.body)
    this._triggerLogDrawerOpen = false; // current open/close state
    this._triggerLogEntries = null;     // array of log entries | null (not yet loaded)
    this._triggerLogLoading = false;    // loading spinner state
    this._triggerLogBtn = null;         // trigger button element (set in _buildUI)
    this._triggerLogFilter = null;      // persona filter: null = all, string = specific persona

    // Dry-run / Preview Run state
    this._dryRunPanels = {};           // personaId -> { panel, statusBar, proposalList, heading, promoteAllBtn, previewRunBtn }
    this._dryRunDocIds = {};           // personaId -> Firestore doc ID of in-flight dry run
    this._dryRunUnsubs = {};           // personaId -> unsubscribe function for doc listener
    this._dryRunProposals = {};        // personaId -> array of proposal objects from done run

    // Backlog deduplication (DK-366)
    this._backlogItems = [];           // array of { title: string } — parsed from PM paste input
    this._backlogSection = null;       // container element
    this._backlogTextarea = null;      // paste input textarea
    this._backlogItemCount = null;     // element showing "N items loaded"
    this._suppressDuplicates = false;  // per-session suppression toggle
    this._suppressedCount = 0;         // count of ideas suppressed this session
    this._suppressCountEl = null;      // element showing suppressed count
    this._rejectionLog = this._loadRejectionLog(); // per-session rejection log entries
    this._rejectionLogSection = null;  // container for rejection log UI
    this._rejectionLogBody = null;     // scrollable body of rejection log
    this._rejectionLogList = null;     // list element inside rejection log body
    this._rejectionLogSearch = '';     // current search filter string

    // DK-105: Persona emphasis weights state
    // Per-persona draft weights (before save). Keyed by personaId.
    // Populated from project.weights.<personaId> on project focus; all-1 defaults otherwise.
    this._weightsDraft = {};           // personaId -> { concernKey: int }
    this._weightsSaving = {};          // personaId -> boolean (save in progress)
    this._weightsSummaryEls = {};      // personaId -> span element showing plain-language summary
    this._weightsInputs = {};          // personaId -> { concernKey: <input type=number> }
    this._weightsSaveEls = {};         // personaId -> { btn, statusEl }

    // DK-101: Per-persona focus areas state
    // Stores references to UI elements built in _buildPersonaCard.
    // Populated at card-build time; updated when project data changes.
    this._focusAreasState = {};        // personaId -> { sectionEl, bodyEl, toggleEl, summaryChipEl, chipData, inputs }
    this._focusAreasSaving = {};       // personaId -> boolean (save in progress)

    // DK-365: Persona constraint state
    this._constraintModal = null;      // modal overlay element (appended to document.body)
    this._constraintModalPersonaId = null;
    this._constraintDraft = {};        // personaId -> { budget_range, platform_target, audience_segment, complexity_cap, risk_tolerance }
    this._constraintChipEls = {};      // personaId -> chip element in card header

    // DK-319: Per-persona per-project focus directive state
    // Directives are stored at advisor/{personaId}/projects/{projectId} in Firestore.
    // The UI shows inline below the persona name: Freeform (empty) or Focused (set).
    this._directiveUnsubs = {};        // personaId -> unsubscribe fn for directive listener
    this._directiveData = {};          // personaId -> { directive, directiveUpdatedAt } | null
    this._directiveSaving = {};        // personaId -> boolean (save in progress)
    this._directiveEditing = {};       // personaId -> boolean (inline input visible)
    this._directiveEls = {};           // personaId -> { sectionEl, badgeEl, inputEl, labelEl, timestampEl, stalenessEl, clearBtn, nextRunEl, counterEl, editRow, displayRow }

    // DK-187: Persona focus constraints state
    // Stores references to UI elements built in _buildPersonaCard.
    // Data is read from /advisor/{personaId}.focus and written back on save.
    this._focusConstraintsState = {};  // personaId -> { sectionEl, bodyEl, toggleEl, summaryChipEl, chipListEl, inputEl, saveBtn, saveStatusEl, clearBtn, dirty }
    this._focusConstraintsSaving = {}; // personaId -> boolean (save in progress)

    // DK-118: Per-project persona enable/disable toggles
    // Stored at projects/{projectId}.advisor.personas.{engineer,design,product} in Firestore.
    // Absent keys default to true (enabled). Writes are debounced 500ms.
    this._personaTogglesPanel = null;    // container element
    this._personaTogglesLegend = null;   // <legend> element for fieldset grouping
    this._personaToggleEls = {};         // personaId -> { checkbox, statusEl, undoEl }
    this._personaTogglesOnOffEls = {};   // personaId -> <span> showing On/Off text
    this._personaToggleSaving = {};      // personaId -> boolean (save in progress)
    this._personaToggleDebounce = {};    // personaId -> setTimeout id
    this._edpIndicatorEl = null;         // EDP indicator element in the panel header

    // DK-134: Per-persona per-project scope config (include/exclude path chips + topic tag chips).
    // New schema stored at advisor.projects.<projectId>.<personaId>.scope.{include,exclude,topics}.
    // Backward compat: also reads old DK-301 focusAreas.{topics,paths} strings.
    // UI: gear icon on persona label → inline config drawer with chip inputs.
    this._scopedFocusState = {};       // personaId -> { drawerEl, dotEl, gearBtn, topicsChipListEl, topicsInputEl, includeChipListEl, includeInputEl, excludeChipListEl, excludeInputEl, saveStatusEl, fileCountBadgeEl, noFilesWarningEl, clearLinkEl, drawerOpen }
    this._scopedFocusSaving = {};      // personaId -> boolean
    this._scopedFocusChips = {};       // personaId -> { topics: string[], include: string[], exclude: string[] }
    this._scopeSummaryBar = null;      // scope summary bar element (DK-134)

    // DK-124: Per-persona per-project advisor pins.
    // Engineer: file glob pins (stored at project.advisorPins.engineer[]).
    // Design: URL path pins (stored at project.advisorPins.design[]).
    // Product: no pins (not applicable).
    // UI: collapsible "Focus areas" row inside the advisor config section.
    this._pinsState = {};              // personaId -> { sectionEl, bodyEl, toggleEl, summaryChipEl, chipListEl, inputEl, saveBtn, saveStatusEl, stalenessEl }
    this._pinsSaving = {};             // personaId -> boolean (save in progress)
    this._pinsDraft = {};              // personaId -> string[] (current edited state before save)

    // DK-188: Confidence threshold state.
    // Global threshold stored at /advisor/config.minConfidence in Firestore.
    // UI: labeled radio group (Low/Medium/High/Strict) with discard log below.
    this._minConfidence = 5;           // current threshold (1–10), loaded from Firestore
    this._confidenceUnsub = null;      // Firestore listener
    this._confidenceRadioEls = {};     // { value: <input type=radio> }
    this._confidenceStatusEl = null;   // status message element
    this._discardsSection = null;      // discard log container
    this._discardsBody = null;         // discard list element
    this._discardsSaving = false;      // true while saving threshold

    // DK-194: Cross-persona consensus gate state.
    // Stored at /advisor/consensusGate in Firestore. Same pattern as the pause toggle.
    // UI: toggle + threshold selector in the AdvisorPanel (workspace-level setting).
    this._consensusGate = null;          // current Firestore doc data | null
    this._consensusGatePanel = null;     // container element
    this._consensusGateToggle = null;    // <input type="checkbox"> element
    this._consensusGateThreshold = null; // <input type="number"> element
    this._consensusGateStatus = null;    // status/error message element
    this._consensusGateSaving = false;   // save in progress
  }

  /**
   * Set the current user for trigger attribution.
   * @param {object|null} user - Firebase Auth user object
   */
  setCurrentUser(user) {
    this._currentUser = user;
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;

    this._root = el('div', { className: 'adv-panel' });
    this.container.appendChild(this._root);

    this._buildUI();
    this._startListeners();

    // Refresh countdowns every 30s
    this._ticker = setInterval(() => {
      if (this._mounted) this._refreshCountdowns();
    }, 30_000);
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;

    for (const u of this._unsubs) u();
    this._unsubs = [];

    // Clean up any active history listeners
    for (const unsub of Object.values(this._historyUnsubs)) {
      if (typeof unsub === 'function') unsub();
    }
    this._historyUnsubs = {};

    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }

    // Stop all per-card run timers
    if (this._runTimers) {
      for (const id of Object.keys(this._runTimers)) this._stopRunTimer(id);
      this._runTimers = {};
    }

    // Cancel any active dry-run subscriptions
    for (const id of Object.keys(this._dryRunUnsubs || {})) {
      this._cancelDryRunSubscription(id);
    }
    this._dryRunUnsubs = {};
    this._dryRunDocIds = {};

    // DK-118: Cancel any pending persona toggle debounce timers
    for (const id of Object.keys(this._personaToggleDebounce || {})) {
      if (this._personaToggleDebounce[id]) {
        clearTimeout(this._personaToggleDebounce[id]);
      }
    }
    this._personaToggleDebounce = {};
    // Cancel undo timers
    for (const refs of Object.values(this._personaToggleEls || {})) {
      if (refs?._undoTimer) clearTimeout(refs._undoTimer);
    }

    if (this._root?.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;

    this._statesReceived = {};
    this._closeSoulModal();
    this._closeConstraintModal();
    this._closeCustomModal();
    this._closeSaveTemplateModal();
    this._closeTemplateWarnModal();

    // Unsubscribe templates listener
    if (this._templatesUnsub) { this._templatesUnsub(); this._templatesUnsub = null; }

    // Unsubscribe presets listener (DK-193)
    if (this._presetsUnsub) { this._presetsUnsub(); this._presetsUnsub = null; }

    // DK-133: Unsubscribe global persona instructions listener
    if (this._personaInstrGlobalUnsub) { this._personaInstrGlobalUnsub(); this._personaInstrGlobalUnsub = null; }

    // Clear last-saved interval timers in instruction panels
    for (const id of ['engineer', 'design', 'product']) {
      const lastSavedEl = this._personaInstrLastSavedEls?.[id];
      if (lastSavedEl?._interval) { clearInterval(lastSavedEl._interval); lastSavedEl._interval = null; }
    }

    // Close any open preset modals
    this._closeSavePresetModal();
    this._closeDeletePresetModal();
  }

  // ── Collapse state ──────────────────────────────────────────

  _loadCollapsedState() {
    try {
      const raw = localStorage.getItem('adv-collapsed-personas');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: collapse all built-in persona card bodies on first visit.
    // Users can expand individual cards they need to configure.
    return new Set(PERSONAS.map(p => p.id));
  }

  _saveCollapsedState() {
    try {
      localStorage.setItem('adv-collapsed-personas', JSON.stringify([...this._collapsedPersonas]));
    } catch (_) { /* ignore */ }
  }

  // ── Section collapse state (top-level sidebar sections) ─────

  _loadSectionCollapseState() {
    try {
      const raw = localStorage.getItem('adv-collapsed-sections');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: 'personas' section is expanded; 'custom' section starts collapsed.
    return new Set(['custom']);
  }

  _saveSectionCollapseState() {
    try {
      localStorage.setItem('adv-collapsed-sections', JSON.stringify([...this._collapsedSections]));
    } catch (_) { /* ignore */ }
  }

  _toggleSectionCollapse(sectionId, bodyEl, chevronEl, headerEl) {
    const isCollapsed = this._collapsedSections.has(sectionId);
    if (isCollapsed) {
      this._collapsedSections.delete(sectionId);
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'true');
    } else {
      this._collapsedSections.add(sectionId);
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'false');
    }
    this._saveSectionCollapseState();
  }

  // ── Per-card subsection collapse state (Activity, Performance) ──

  // Per-card subsection collapse state uses an INVERTED set:
  // _collapsedCardSections stores keys that are EXPLICITLY EXPANDED.
  // A key absent from the set = collapsed (default for Activity & Performance).
  // This means new subsections (including custom persona subsections) start
  // collapsed by default without needing to pre-populate the set.
  _loadCardSectionCollapseState() {
    try {
      const raw = localStorage.getItem('adv-expanded-card-sections');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: empty set = all subsections collapsed (Activity & Performance start hidden)
    return new Set();
  }

  _saveCardSectionCollapseState() {
    try {
      localStorage.setItem('adv-expanded-card-sections', JSON.stringify([...this._collapsedCardSections]));
    } catch (_) { /* ignore */ }
  }

  // key is in the set = explicitly expanded; absent = collapsed.
  _toggleCardSection(key, bodyEl, chevronEl, headerEl) {
    const isExpanded = this._collapsedCardSections.has(key);
    if (isExpanded) {
      // Collapse it
      this._collapsedCardSections.delete(key);
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'false');
    } else {
      // Expand it
      this._collapsedCardSections.add(key);
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'true');
    }
    this._saveCardSectionCollapseState();
  }

  _toggleCardCollapse(id) {
    const card = this._cards[id];
    if (!card || !card.cardBody) return;
    const isCollapsed = this._collapsedPersonas.has(id);
    if (isCollapsed) {
      this._collapsedPersonas.delete(id);
      card.cardBody.classList.remove('adv-hidden');
      card.card.classList.remove('adv-card-collapsed');
      card.collapseBtn.textContent = '▾';
      card.collapseBtn.title = 'Collapse';
      card.collapseBtn.setAttribute('aria-expanded', 'true');
    } else {
      this._collapsedPersonas.add(id);
      card.cardBody.classList.add('adv-hidden');
      card.card.classList.add('adv-card-collapsed');
      card.collapseBtn.textContent = '▸';
      card.collapseBtn.title = 'Expand';
      card.collapseBtn.setAttribute('aria-expanded', 'false');
    }
    this._saveCollapsedState();
  }

  // ── UI construction ──────────────────────────────────────────

  _buildUI() {
    // ARIA live region — announces status changes to screen readers
    this._liveRegion = el('div', {
      'aria-live': 'polite',
      'aria-atomic': 'true',
      className: 'adv-live-region',
    });
    this._root.appendChild(this._liveRegion);

    // Header
    const contextBtn = el('button', {
      className: 'adv-context-btn',
      title: 'Edit project context',
      style: 'display:none', // hidden until a project is selected
      onClick: () => this._toggleContextPanel(),
    }, 'Context');
    this._contextBtn = contextBtn;

    const yoloBtn = el('button', {
      className: 'adv-yolo-btn',
      title: 'Auto-Accept mode: new advisor tickets skip review and go straight to the backlog',
      style: 'display:none', // hidden until a project is selected
      onClick: () => this._toggleYoloMode(),
    }, 'Auto-Accept');
    this._yoloBtn = yoloBtn;

    // Run log button — opens the right-side drawer (DK-189)
    const runLogBtn = el('button', {
      className: 'adv-run-log-btn',
      title: 'View recent advisor run log',
      'aria-label': 'Open advisor run log',
      onClick: () => this._openRunLogDrawer(),
    }, 'Run log');
    this._runLogBtn = runLogBtn;

    // DK-136: Trigger log button — opens the trigger log drawer
    const triggerLogBtn = el('button', {
      className: 'adv-trigger-log-btn',
      title: 'View event trigger history (webhook, ticket-close, manual)',
      'aria-label': 'Open trigger log',
      onClick: () => this._openTriggerLogDrawer(),
    }, 'Trigger log');
    this._triggerLogBtn = triggerLogBtn;

    // Pause All button — pauses or resumes all built-in personas globally
    const pauseAllBtn = el('button', {
      className: 'adv-pause-all-btn',
      title: 'Pause all advisors',
      'aria-label': 'Pause all advisors',
      onClick: () => this._pauseAllAdvisors(),
    }, 'Pause All');
    this._pauseAllBtn = pauseAllBtn;

    // Status legend help button — explains the outlined-ring dot style used for advisor activity
    const legendBtn = el('button', {
      className: 'status-legend-btn',
      title: 'Status dot legend',
      'aria-label': 'Status dot legend',
      'data-legend': '○  Advisor: outlined ring = advisor activity\n●  Workers: solid dot = ticket/worker state',
    }, '?');

    // DK-118: EDP indicator — shows which personas are enabled for the current project
    const edpIndicator = el('div', {
      className: 'adv-edp-indicator',
      style: 'display:none', // hidden until a project is selected
      'aria-label': 'Personas active for current project',
      title: 'E=Engineer, D=Design, P=Product — strikethrough = disabled',
    });
    this._edpIndicatorEl = edpIndicator;

    this._root.appendChild(
      el('div', { className: 'adv-header' },
        el('div', { className: 'adv-header-left' },
          el('span', { className: 'adv-title' }, 'Advisors'),
          legendBtn,
          edpIndicator,
        ),
        el('div', { className: 'adv-header-right' },
          pauseAllBtn,
          runLogBtn,
          triggerLogBtn,
          yoloBtn,
          contextBtn,
        ),
      )
    );

    // Context panel — inline editor for current project's advisorContext
    this._root.appendChild(this._buildContextPanel());

    // DK-118: Per-project persona enable/disable toggles panel
    this._root.appendChild(this._buildPersonaTogglesPanel());

    // DK-194: Cross-persona consensus gate panel (workspace-level setting)
    this._root.appendChild(this._buildConsensusGatePanel());

    // Persona instructions panel — per-project additional instructions for each persona
    this._root.appendChild(this._buildPersonaInstructionsPanel());

    // DK-302: Dismissible banner shown when priorities is empty and an advisor has run recently.
    // One banner per panel — not per persona card. Shown above the first persona card.
    const prioritiesBannerEl = el('div', {
      className: 'adv-priorities-banner',
      role: 'alert',
      style: 'display:none',
    },
      el('span', { className: 'adv-priorities-banner-text' },
        'Suggestions may be off-target. ',
        el('button', {
          className: 'adv-priorities-banner-link',
          onClick: () => {
            // Open the context panel so the user can set priorities
            if (!this._contextPanelOpen) this._toggleContextPanel();
            if (this._prioritiesTextarea) setTimeout(() => this._prioritiesTextarea.focus(), 120);
          },
        }, 'Add current priorities in project settings.')
      ),
      el('button', {
        className: 'adv-priorities-banner-dismiss',
        'aria-label': 'Dismiss this suggestion',
        onClick: (e) => {
          e.stopPropagation();
          this._prioritiesBannerDismissed = true;
          this._updatePrioritiesBanner(false);
        },
      }, '✕')
    );
    this._prioritiesBannerEl = prioritiesBannerEl;
    this._root.appendChild(prioritiesBannerEl);

    // DK-134: Scope summary bar — one-line scope summary per persona.
    // Hidden when all personas are using full codebase (no scope set).
    // Shows e.g. "Engineer: src/auth/**, +security | Design: entire codebase"
    this._scopeSummaryBar = el('div', {
      className: 'adv-scope-summary-bar adv-hidden',
      'aria-label': 'Persona scope summary',
    });
    this._root.appendChild(this._scopeSummaryBar);

    // ── Built-in personas — flat list, no intermediate section header ──
    for (const persona of PERSONAS) {
      this._root.appendChild(this._buildPersonaCard(persona));
    }

    // Acceptance rate summary table (DK-196)
    this._root.appendChild(this._buildAcceptanceRateSection());

    // Custom personas — flat, with Add Persona button
    this._root.appendChild(this._buildCustomPersonasSection());

    // Persona config templates (DK-141) — Settings > Templates section
    this._root.appendChild(this._buildTemplatesSection());

    // DK-188: Confidence threshold selector and filtered discards log
    this._root.appendChild(this._buildConfidenceSection());

    // Backlog deduplication (DK-366) — paste-and-parse backlog input + rejection log
    this._root.appendChild(this._buildBacklogSection());
  }

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

  // ── Performance dashboard ────────────────────────────────────

  /**
   * Toggle the performance dashboard for a persona.
   * Loads data on first open; subsequent opens use cached data.
   */
  _togglePerfDash(personaId) {
    const isExpanded = !this._perfDashExpanded[personaId];
    this._perfDashExpanded[personaId] = isExpanded;

    const container = this._perfDashContainers[personaId];
    const card = this._cards[personaId];
    if (!container || !card) return;

    if (isExpanded) {
      container.classList.remove('adv-perf-dash-hidden');
      card.statsBtn.textContent = 'Stats ▾';
      card.statsBtn.setAttribute('aria-expanded', 'true');
      // Load data if not already loaded
      if (!this._perfDashData[personaId]) {
        this._loadPerfDash(personaId);
      } else {
        this._renderPerfDash(personaId);
      }
    } else {
      container.classList.add('adv-perf-dash-hidden');
      card.statsBtn.textContent = 'Stats ▸';
      card.statsBtn.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * Load performance data for a persona from Firestore.
   * Uses a collectionGroup query across all projects.
   * Data is not auto-refreshed — user can manually refresh.
   */
  async _loadPerfDash(personaId) {
    this._perfDashLoading[personaId] = true;
    this._renderPerfDash(personaId);

    try {
      const windowMs = this._perfDashWindowDays * 24 * 60 * 60 * 1000;
      // Use a Date object (not an ISO string) for the Firestore range query.
      // tickets.createdAt is stored as a Firestore serverTimestamp (Timestamp type).
      // Firestore cannot compare a Timestamp field against a string value — the
      // query would return empty results. The Firebase compat SDK accepts a JS Date
      // as a valid Timestamp comparator.
      const since = new Date(Date.now() - windowMs);

      // collectionGroup query: tickets across all projects where advisorPersona matches
      const snap = await this.db.collectionGroup('tickets')
        .where('advisorPersona', '==', personaId)
        .where('createdAt', '>=', since)
        .get();

      const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this._perfDashData[personaId] = { tickets, fetchedAt: new Date() };
    } catch (err) {
      console.error(`AdvisorPanel: failed to load perf data for ${personaId}`, err);
      this._perfDashData[personaId] = { tickets: [], fetchedAt: new Date(), error: err.message };
    } finally {
      this._perfDashLoading[personaId] = false;
      this._renderPerfDash(personaId);
    }
  }

  /**
   * Render the performance dashboard into its container.
   * Called after data loads and when the time window changes.
   */
  _renderPerfDash(personaId) {
    const container = this._perfDashContainers[personaId];
    if (!container) return;
    container.innerHTML = '';

    // ── Header row: time filter + refresh ──────────────────────
    const windowDays = this._perfDashWindowDays;
    const make30Btn = el('button', {
      className: 'adv-perf-filter-btn' + (windowDays === 30 ? ' adv-perf-filter-btn-active' : ''),
      'aria-pressed': String(windowDays === 30),
      onClick: () => {
        if (this._perfDashWindowDays !== 30) {
          this._perfDashWindowDays = 30;
          // Clear cached data so it reloads with new window
          for (const pid of Object.keys(this._perfDashExpanded)) {
            if (this._perfDashExpanded[pid]) {
              this._perfDashData[pid] = null;
              this._loadPerfDash(pid);
            }
          }
        }
      },
    }, '30d');

    const make90Btn = el('button', {
      className: 'adv-perf-filter-btn' + (windowDays === 90 ? ' adv-perf-filter-btn-active' : ''),
      'aria-pressed': String(windowDays === 90),
      onClick: () => {
        if (this._perfDashWindowDays !== 90) {
          this._perfDashWindowDays = 90;
          for (const pid of Object.keys(this._perfDashExpanded)) {
            if (this._perfDashExpanded[pid]) {
              this._perfDashData[pid] = null;
              this._loadPerfDash(pid);
            }
          }
        }
      },
    }, '90d');

    const data = this._perfDashData[personaId];
    const isLoading = this._perfDashLoading[personaId];

    // Refresh button + last updated timestamp
    const refreshBtn = el('button', {
      className: 'adv-perf-refresh-btn',
      title: 'Refresh stats',
      disabled: isLoading,
      onClick: () => {
        this._perfDashData[personaId] = null;
        this._loadPerfDash(personaId);
      },
    }, isLoading ? '…' : '↺');

    const fetchedAtStr = data?.fetchedAt
      ? `Updated ${data.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    container.appendChild(
      el('div', { className: 'adv-perf-header' },
        el('div', { className: 'adv-perf-filter-group', role: 'group', 'aria-label': 'Time window' },
          make30Btn,
          make90Btn,
        ),
        el('div', { className: 'adv-perf-refresh-row' },
          el('span', { className: 'adv-perf-updated' }, fetchedAtStr),
          refreshBtn,
        ),
      )
    );

    // ── Loading state ──────────────────────────────────────────
    if (isLoading) {
      container.appendChild(
        el('div', { className: 'adv-perf-loading', 'aria-busy': 'true' },
          el('span', { 'aria-hidden': 'true', className: 'adv-history-spinner' }),
          el('span', {}, 'Loading stats…'),
        )
      );
      return;
    }

    // ── Error state ────────────────────────────────────────────
    if (!data) {
      container.appendChild(
        el('div', { className: 'adv-perf-empty' }, 'Click ↺ to load stats.')
      );
      return;
    }

    if (data.error) {
      container.appendChild(
        el('div', { className: 'adv-perf-error' }, `Could not load stats: ${data.error}`)
      );
      return;
    }

    // ── Cold start check ───────────────────────────────────────
    const personaState = this._states[personaId];
    const cycleCount = personaState?.cycleCount ?? 0;
    const MIN_CYCLES = 5;

    if (cycleCount < MIN_CYCLES) {
      container.appendChild(
        el('div', { className: 'adv-perf-cold-start' },
          el('span', { className: 'adv-perf-cold-icon', 'aria-hidden': 'true' }, '🌱'),
          el('p', { className: 'adv-perf-cold-msg' },
            `Not enough data yet. ${cycleCount} of ${MIN_CYCLES} cycles completed. ` +
            `Stats will appear once this persona has run at least ${MIN_CYCLES} times.`
          ),
        )
      );
      return;
    }

    const tickets = data.tickets;
    const stats = computeStats(tickets);

    // ── Health indicator ───────────────────────────────────────
    const acceptanceRate = stats.generated > 0 ? stats.accepted / stats.generated : 0;
    const health = healthFromRate(acceptanceRate);
    const healthMeta = HEALTH_META[health];

    container.appendChild(
      el('div', { className: 'adv-perf-health' },
        el('span', {
          className: `adv-perf-dot ${healthMeta.cls}`,
          'aria-hidden': 'true',
        }),
        el('span', { className: 'adv-perf-health-label' }, healthMeta.label),
        el('span', { className: 'adv-perf-rate' },
          `${Math.round(acceptanceRate * 100)}% acceptance`
        ),
      )
    );

    // ── Summary stats ──────────────────────────────────────────
    const statItems = [
      { label: 'Generated', value: stats.generated, sub: '' },
      { label: 'Accepted',  value: stats.accepted,  sub: stats.generated > 0 ? `${Math.round(stats.accepted / stats.generated * 100)}%` : '' },
      { label: 'Rejected',  value: stats.rejected,  sub: stats.generated > 0 ? `${Math.round(stats.rejected / stats.generated * 100)}%` : '' },
      { label: 'Pending',   value: stats.proposed,  sub: '' },
    ];

    const statRow = el('div', { className: 'adv-perf-stats-row' });
    for (const s of statItems) {
      statRow.appendChild(
        el('div', { className: 'adv-perf-stat' },
          el('span', { className: 'adv-perf-stat-val' }, String(s.value)),
          el('span', { className: 'adv-perf-stat-label' }, s.label),
          s.sub ? el('span', { className: 'adv-perf-stat-sub' }, s.sub) : null,
        )
      );
    }
    container.appendChild(statRow);

    // Snoozed footnote
    container.appendChild(
      el('p', { className: 'adv-perf-snooze-note' },
        '* Snoozed proposals (dismissed temporarily) are included in Pending until acted on.'
      )
    );

    // ── Sparkline ──────────────────────────────────────────────
    const sparkRates = computeSparkline(tickets, windowDays);
    const ariaLabel = buildSparklineAriaLabel(sparkRates, windowDays);

    container.appendChild(
      el('div', { className: 'adv-perf-sparkline-wrap' },
        el('span', { className: 'adv-perf-spark-label' }, `Acceptance rate / week (${windowDays}d)`),
        buildSparklineSvg(sparkRates, ariaLabel),
      )
    );

    // ── Last / next run timestamps ─────────────────────────────
    // Next run is computed client-side from lastRunAt + intervalHours per spec.
    if (personaState) {
      const lastRun = personaState.lastRunAt
        ? new Date(personaState.lastRunAt).toLocaleString()
        : '—';
      // Compute nextRunAt client-side; do not read it from Firestore
      const lastRunDate = toDate(personaState.lastRunAt);
      const iHours = personaState.intervalHours ?? (PERSONAS.find(p => p.id === personaId)?.defaultHours ?? 24);
      const nextRunMs = lastRunDate ? lastRunDate.getTime() + iHours * 3600_000 : 0;
      const nextRun = nextRunMs > 0 ? new Date(nextRunMs).toLocaleString() : '—';
      const nextRunLabel = nextRunMs > Date.now() ? nextRun : 'Soon';

      container.appendChild(
        el('div', { className: 'adv-perf-timestamps' },
          el('div', { className: 'adv-perf-ts-row' },
            el('span', { className: 'adv-perf-ts-label' }, 'Last run'),
            el('span', { className: 'adv-perf-ts-val' }, lastRun),
          ),
          el('div', { className: 'adv-perf-ts-row' },
            el('span', { className: 'adv-perf-ts-label' }, 'Next run'),
            el('span', { className: 'adv-perf-ts-val' }, nextRunLabel),
          ),
        )
      );
    }

    // ── Inline frequency control ───────────────────────────────
    const personaCard = this._cards[personaId];
    const currentHours = personaState?.intervalHours ?? (PERSONAS.find(p => p.id === personaId)?.defaultHours ?? 24);
    const freqInput = el('input', {
      className: 'adv-interval-input adv-perf-freq-input',
      type: 'number',
      min: '1',
      max: '168',
      value: String(currentHours),
      title: 'Interval in hours',
      'aria-label': 'Run interval in hours',
    });
    const freqSaveBtn = el('button', {
      className: 'adv-interval-save',
      title: 'Save interval',
      onClick: () => this._saveInterval(personaId, freqInput.value, 'hours'),
    }, 'Save');

    container.appendChild(
      el('div', { className: 'adv-perf-freq' },
        el('span', { className: 'adv-perf-freq-label' }, 'Run every'),
        freqInput,
        el('span', { className: 'adv-perf-freq-unit' }, 'hours'),
        freqSaveBtn,
      )
    );

    // Keep freqInput in sync if personaState updates
    if (personaCard) personaCard._perfFreqInput = freqInput;
  }

  _buildCustomPersonasSection() {
    const section = el('div', { className: 'adv-custom-section' });

    this._customPersonasBody = el('div', { className: 'adv-custom-body', id: 'adv-custom-body' });

    // "Add" button — always visible, disabled when at cap
    const addBtn = el('button', {
      className: 'adv-custom-add-btn',
      title: 'Create a new custom persona',
      onClick: () => this._openCustomPersonaModal(null),
    }, '+ Add Persona');
    this._addPersonaBtn = addBtn;

    section.appendChild(
      el('div', { className: 'adv-custom-add-row' },
        addBtn,
      )
    );

    section.appendChild(this._customPersonasBody);

    return section;
  }

  /**
   * Build the acceptance rate summary table section (DK-196).
   * Shows a collapsible table with one row per persona:
   *   persona name | proposed | accepted | rejected | acceptance rate %
   * Data is loaded from feedbackEvents on first expand.
   */
  _buildAcceptanceRateSection() {
    const section = el('div', { className: 'adv-acceptance-section' });

    // Collapsible header
    const isExpanded = this._collapsedCardSections.has('acceptance-rate');
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');
    const header = el('button', {
      className: 'adv-acceptance-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-acceptance-body',
      onClick: () => this._toggleAcceptanceSection(body, chevron, header),
    },
      chevron,
      el('span', {}, 'Acceptance Rates'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-acceptance-body',
      id: 'adv-acceptance-body',
    });
    if (!isExpanded) body.classList.add('adv-hidden');
    section.appendChild(body);

    this._acceptanceBody = body;

    if (isExpanded) {
      this._loadAcceptanceRates();
    }

    return section;
  }

  _toggleAcceptanceSection(bodyEl, chevronEl, headerEl) {
    const isExpanded = this._collapsedCardSections.has('acceptance-rate');
    if (isExpanded) {
      // Collapse
      this._collapsedCardSections.delete('acceptance-rate');
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      headerEl.setAttribute('aria-expanded', 'false');
    } else {
      // Expand and load
      this._collapsedCardSections.add('acceptance-rate');
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      headerEl.setAttribute('aria-expanded', 'true');
      this._loadAcceptanceRates();
    }
    this._saveCardSectionCollapseState();
  }

  /**
   * Load acceptance rate data for all personas from feedbackEvents.
   * Queries the last 90 days across all projects the user can see.
   * Renders a table with: persona | proposed | accepted | rejected | rate%
   */
  async _loadAcceptanceRates() {
    if (!this._acceptanceBody) return;
    this._acceptanceBody.innerHTML = '';
    this._acceptanceBody.appendChild(
      el('div', { className: 'adv-acceptance-loading' },
        el('span', { 'aria-hidden': 'true', className: 'adv-history-spinner' }),
        el('span', {}, 'Loading…'),
      )
    );

    try {
      const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
      if (!projectId) {
        this._acceptanceBody.innerHTML = '';
        this._acceptanceBody.appendChild(
          el('div', { className: 'adv-acceptance-empty' }, 'No project selected.')
        );
        return;
      }

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Fetch all feedbackEvents across all built-in personas in parallel
      const allPersonaIds = [
        ...PERSONAS.map(p => p.id),
        ...this._customPersonas.map(p => p.id || p._docId).filter(Boolean),
      ];

      const results = await Promise.all(
        allPersonaIds.map(async (pid) => {
          try {
            const snap = await this.db
              .collection('projects')
              .doc(projectId)
              .collection('feedbackEvents')
              .where('personaId', '==', pid)
              .orderBy('timestamp', 'desc')
              .limit(200)
              .get();

            let accepted = 0, rejected = 0;
            for (const doc of snap.docs) {
              const data = doc.data();
              const ts = data.timestamp?.toDate?.() ?? null;
              if (ts && ts < cutoff) break;
              if (data.decision === 'accepted') accepted++;
              else if (data.decision === 'rejected') rejected++;
            }
            const total = accepted + rejected;
            const rate = total > 0 ? Math.round(accepted / total * 100) : null;
            return { personaId: pid, accepted, rejected, total, rate };
          } catch {
            return { personaId: pid, accepted: 0, rejected: 0, total: 0, rate: null, error: true };
          }
        })
      );

      // Filter to personas with any data
      const withData = results.filter(r => r.total > 0 || r.error);
      const allEmpty = withData.length === 0;

      this._acceptanceBody.innerHTML = '';

      if (allEmpty) {
        this._acceptanceBody.appendChild(
          el('div', { className: 'adv-acceptance-empty' },
            'No feedback recorded yet. Accept or reject proposals to see rates.'
          )
        );
        return;
      }

      // Build table
      const table = el('table', {
        className: 'adv-acceptance-table',
        'aria-label': 'Acceptance rates by persona',
      });

      // Header row
      const thead = el('thead', {});
      thead.appendChild(
        el('tr', {},
          el('th', { scope: 'col' }, 'Persona'),
          el('th', { scope: 'col' }, 'Accepted'),
          el('th', { scope: 'col' }, 'Rejected'),
          el('th', { scope: 'col' }, 'Rate'),
          el('th', { scope: 'col' }, 'Quality'),
        )
      );
      table.appendChild(thead);

      const tbody = el('tbody', {});
      for (const row of results) {
        if (row.total === 0 && !row.error) continue;

        const personaLabel = PERSONAS.find(p => p.id === row.personaId)?.label
          || this._customPersonas.find(p => (p.id || p._docId) === row.personaId)?.name
          || row.personaId;

        const rateStr = row.rate !== null ? `${row.rate}%` : '—';
        let qualityLabel = '—';
        let qualityCls = '';
        if (row.rate !== null) {
          if (row.rate > 50) { qualityLabel = 'Healthy'; qualityCls = 'adv-acceptance-quality-green'; }
          else if (row.rate >= 20) { qualityLabel = 'Fair'; qualityCls = 'adv-acceptance-quality-yellow'; }
          else { qualityLabel = 'Low'; qualityCls = 'adv-acceptance-quality-red'; }
        }

        tbody.appendChild(
          el('tr', {},
            el('td', { className: 'adv-acceptance-persona' }, personaLabel),
            el('td', { className: 'adv-acceptance-num' }, String(row.accepted)),
            el('td', { className: 'adv-acceptance-num' }, String(row.rejected)),
            el('td', { className: 'adv-acceptance-rate' }, rateStr),
            el('td', { className: `adv-acceptance-quality ${qualityCls}` }, qualityLabel),
          )
        );
      }
      table.appendChild(tbody);
      this._acceptanceBody.appendChild(table);

      // Note about time window
      this._acceptanceBody.appendChild(
        el('p', { className: 'adv-acceptance-note' }, 'Based on last 90 days of feedback.')
      );
    } catch (err) {
      console.warn('AdvisorPanel: failed to load acceptance rates', err);
      this._acceptanceBody.innerHTML = '';
      this._acceptanceBody.appendChild(
        el('div', { className: 'adv-acceptance-error' }, 'Could not load acceptance rates.')
      );
    }
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * Update the priorities timestamp element from a raw priorities updated-at string.
   * @param {string|null} prioritiesUpdatedAt
   */
  _updatePrioritiesTimestamp(prioritiesUpdatedAt) {
    if (!this._prioritiesTimestampEl) return;
    const { text, stale } = this._formatPrioritiesTimestamp(prioritiesUpdatedAt);
    this._prioritiesTimestampEl.textContent = text;
    this._prioritiesTimestampEl.classList.toggle('adv-priorities-timestamp--stale', stale);
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  _closeSavePresetModal() {
    if (!this._presetSaveModal) return;
    if (this._presetSaveModal._keyHandler) {
      document.removeEventListener('keydown', this._presetSaveModal._keyHandler);
    }
    this._presetSaveModal.remove();
    this._presetSaveModal = null;
  }

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
  }

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
  }

  _closeDeletePresetModal() {
    if (!this._presetDeleteModal) return;
    if (this._presetDeleteModal._keyHandler) {
      document.removeEventListener('keydown', this._presetDeleteModal._keyHandler);
    }
    this._presetDeleteModal.remove();
    this._presetDeleteModal = null;
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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

  _buildProjectsSection() {
    // Legacy method kept for compatibility — no longer added to DOM.
    // Projects section has been replaced by the header Context button.
    return el('div', { style: 'display:none' });
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }


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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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

  // ── Controls ─────────────────────────────────────────────────

  /** @deprecated — kept for backward compat; new code calls _triggerRun */
  async _runNow(id) {
    await this._triggerRun(id, null);
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * Auto-save path (called from debounce/blur via save-on-blur control).
   * Saves to Firestore but does NOT clear the textarea or collapse the focus area.
   * The value parameter is the raw string value from the textarea.
   */
  async _autoSaveFocusPrompt(id, rawValue) {
    const sanitizedFocus = this._sanitizeFocusPrompt(rawValue);
    await this._persistFocusPrompt(id, sanitizedFocus);
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  /** Stop the per-card elapsed timer for a persona. */
  _stopRunTimer(id) {
    if (this._runTimers?.[id]) {
      clearInterval(this._runTimers[id]);
      delete this._runTimers[id];
    }
  }


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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  /** @deprecated Use _saveSchedule instead. Kept for compatibility. */
  async _saveTimeWindow(id, ...args) {
    // no-op: new UI uses _saveSchedule
  }

  /** @deprecated Use _clearSchedule instead. Kept for compatibility. */
  async _clearTimeWindow(id, ...args) {
    // no-op: new UI uses _clearSchedule
  }

  /** @deprecated Use _updateScheduleUI instead. Kept for compatibility. */
  _updateTimeWindowUI(id, ...args) {
    // no-op: new UI uses _updateScheduleUI
  }

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

}


// Attach feature mixins to the prototype. Each mixin is a plain object whose
// methods are copied onto AdvisorPanel.prototype, preserving `this` semantics.
Object.assign(AdvisorPanel.prototype, triggerLogMixin, runLogMixin, backlogMixin, modalsMixin, customPersonasMixin, templatesMixin, dryRunMixin, focusMixin, historyMixin);
