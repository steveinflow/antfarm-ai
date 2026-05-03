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
import { performanceMixin } from './advisor/views/performance.js';
import { contextPanelMixin } from './advisor/views/context-panel.js';
import { personaInstructionsMixin } from './advisor/views/persona-instructions.js';
import { scheduleMixin } from './advisor/views/schedule.js';
import { projectControlsMixin } from './advisor/views/project-controls.js';
import { listenersMixin } from './advisor/views/listeners.js';
import { controlsMixin } from './advisor/views/controls.js';
import { feedbackMixin } from './advisor/views/feedback.js';
import { collapseStateMixin } from './advisor/views/collapse-state.js';
import { personaCardMixin } from './advisor/views/persona-card.js';
import { cardRenderMixin } from './advisor/views/card-render.js';

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

  _buildProjectsSection() {
    // Legacy method kept for compatibility — no longer added to DOM.
    // Projects section has been replaced by the header Context button.
    return el('div', { style: 'display:none' });
  }




}


// Attach feature mixins to the prototype. Each mixin is a plain object whose
// methods are copied onto AdvisorPanel.prototype, preserving `this` semantics.
Object.assign(AdvisorPanel.prototype, triggerLogMixin, runLogMixin, backlogMixin, modalsMixin, customPersonasMixin, templatesMixin, dryRunMixin, focusMixin, historyMixin, performanceMixin, contextPanelMixin, personaInstructionsMixin, scheduleMixin, projectControlsMixin, listenersMixin, controlsMixin, feedbackMixin, collapseStateMixin, personaCardMixin, cardRenderMixin);
