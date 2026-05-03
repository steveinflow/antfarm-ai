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
Object.assign(AdvisorPanel.prototype, triggerLogMixin, runLogMixin, backlogMixin, modalsMixin, customPersonasMixin, templatesMixin, dryRunMixin, focusMixin, historyMixin, performanceMixin, contextPanelMixin, personaInstructionsMixin, scheduleMixin, projectControlsMixin, listenersMixin, controlsMixin, feedbackMixin, collapseStateMixin, personaCardMixin);
