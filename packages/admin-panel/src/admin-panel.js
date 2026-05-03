// @docket/admin-panel — TicketAdminPanel class
// Self-contained vanilla JS with lifecycle. All UI in one file.

import {
  createTicketService,
  createProjectService,
  createFeedbackService,
  STATUS_LABELS,
  statusLabel,
} from '@docket/core';
import { getStyles } from './styles.js';
import {
  esc,
  formatDateCompact,
  formatDate,
  formatDuration,
  formatCost,
  relativeTime,
  toISOString,
} from './format.js';
import { el } from './el.js';
import { openLightbox } from './lightbox.js';
import { TicketToast } from './components/ticket-toast.js';
import { TicketForm } from './components/ticket-form.js';
import { TicketFilters } from './components/ticket-filters.js';
import { PersonaRunLogSection } from './components/persona-run-log-section.js';
import { TicketItem } from './components/ticket-item/index.js';

// ---------------------------------------------------------------------------
// TicketList
// ---------------------------------------------------------------------------

class TicketList {
  constructor({ onTransition, onAnswer, onRekick, onDelete, onReject, onSnooze, onFeedback, onAddNote, onExclude, onMarkCritical, getFeedback, isAdmin, toast, onExpandChange, repoBaseUrl, allTickets, clusters, onClusterFilter, onAddLink, onRemoveLink }) {
    this.onTransition = onTransition;
    this.onAnswer = onAnswer;
    this.onRekick = onRekick;
    this.onDelete = onDelete;
    this.onReject = onReject || null;
    this.onSnooze = onSnooze || null;
    // onFeedback: async (docId, rating) => void — called when user rates an advisor ticket
    this.onFeedback = onFeedback || null;
    // onAddNote: async (docId, note) => void — called when user adds an implementation note
    this.onAddNote = onAddNote || null;
    // onExclude: async ({ personaId, pattern }) => void — called when user adds exclusion (DK-128)
    this.onExclude = onExclude || null;
    // onMarkCritical: async (docId) => void — marks ticket as critical to spawn worker immediately
    this.onMarkCritical = onMarkCritical || null;
    // getFeedback: async (docId) => { rating } | null — loads current user's rating
    this.getFeedback = getFeedback || null;
    this.isAdmin = isAdmin || (() => false);
    this.toast = toast;
    this.onExpandChange = onExpandChange || null;
    // repoBaseUrl is optional — used by TicketItem to build file ref links
    this.repoBaseUrl = repoBaseUrl || null;
    // allTickets is used by TicketItem to resolve related ticket display
    this.allTickets = allTickets || [];
    // clusters: Map<clusterId, { id, label, ticketCount }> — for cluster tag rendering
    this.clusters = clusters || new Map();
    // onClusterFilter: (clusterId) => void — called when user clicks a cluster tag
    this.onClusterFilter = onClusterFilter || null;
    // onAddLink: async (sourceDocId, targetDocId, type) => void — link creation
    this.onAddLink = onAddLink || null;
    // onRemoveLink: async (sourceDocId, targetDocId) => void — link removal
    this.onRemoveLink = onRemoveLink || null;
    // emptyState: { icon, title, message, action?: { label, onClick } } | null
    // Set by TicketAdminPanel before each render to show context-aware empty states.
    this.emptyState = null;
    this.el = null;
    this._itemsById = {}; // ticketId/docId -> TicketItem instance
    // Snapshot of last rendered tickets for incremental patching
    this._renderedTickets = []; // ordered array of ticket objects last passed to render()
    // Track clusters reference to detect changes in _patchRender
    this._renderedClusters = null;
    // Cache of loaded feedback: docId -> "relevant" | "noise" | null
    this._feedbackCache = {};
  }

  _renderEmptyState() {
    const state = this.emptyState;
    if (state && (state.icon || state.title || state.message)) {
      const children = [];
      if (state.icon) {
        children.push(el('div', { className: 'tk-empty-state-icon' }, state.icon));
      }
      if (state.title) {
        children.push(el('div', { className: 'tk-empty-state-title' }, state.title));
      }
      if (state.message) {
        children.push(el('div', { className: 'tk-empty-state-message' }, state.message));
      }
      if (state.action) {
        const btn = el('button', {
          className: 'tk-btn tk-btn-primary tk-empty-state-action',
          onClick: state.action.onClick,
        }, state.action.label);
        children.push(btn);
      }
      return el('div', { className: 'tk-empty-state' }, ...children);
    }
    // Fallback: plain message
    return el('div', { className: 'tk-ticket-list-empty' }, 'No tickets match the current filters.');
  }

  render(tickets, expandedIds) {
    // First render — build fresh DOM
    if (!this.el) {
      return this._fullRender(tickets, expandedIds);
    }
    // Subsequent renders — patch incrementally
    return this._patchRender(tickets, expandedIds);
  }

  _fullRender(tickets, expandedIds) {
    this._itemsById = {};
    this._renderedTickets = tickets ? tickets.slice() : [];

    if (!tickets || tickets.length === 0) {
      this.el = el('div', { className: 'tk-ticket-list' },
        this._renderEmptyState(),
      );
      return this.el;
    }

    const items = tickets.map(ticket => {
      const item = this._createItem(ticket, expandedIds);
      if (ticket.ticketId) this._itemsById[ticket.ticketId] = item;
      if (ticket.id) this._itemsById[ticket.id] = item;
      return item;
    });
    this.el = el('div', { className: 'tk-ticket-list' }, items.map(i => i.render()));
    return this.el;
  }

  _patchRender(tickets, expandedIds) {
    const newTickets = tickets || [];
    const oldTickets = this._renderedTickets;

    // Capture focused element before any DOM manipulation so we can restore it
    // if it gets temporarily detached (e.g. when _commentInput is reparented into
    // a freshly-built element tree during re-render).
    const focusedEl = document.activeElement;

    // Build lookup maps for O(1) access
    const newById = new Map(newTickets.map(t => [t.id, t]));
    const oldById = new Map(oldTickets.map(t => [t.id, t]));

    // Detect if clusters map changed (by reference) so we can force re-render of tagged items
    const clustersChanged = this.clusters !== this._renderedClusters;
    if (clustersChanged) {
      this._renderedClusters = this.clusters;
    }

    // Track which items were in the previous render
    const prevItemsById = { ...this._itemsById };
    const nextItemsById = {};

    // ------------------------------------------------------------------
    // Remove items that are no longer present
    // ------------------------------------------------------------------
    for (const [id, item] of Object.entries(prevItemsById)) {
      // Only act on Firestore doc ids (to avoid double-processing ticketId aliases)
      const ticket = item.ticket;
      if (!ticket || id !== ticket.id) continue; // skip ticketId aliases here
      if (!newById.has(id)) {
        if (item.el && item.el.parentNode) {
          item.el.parentNode.removeChild(item.el);
        }
        // Remove both alias keys
        if (ticket.ticketId) delete this._itemsById[ticket.ticketId];
        delete this._itemsById[ticket.id];
      }
    }

    // ------------------------------------------------------------------
    // Add or update items, build ordered fragment
    // ------------------------------------------------------------------
    const fragment = document.createDocumentFragment();
    let hasItems = false;

    for (const ticket of newTickets) {
      hasItems = true;
      const existingItem = prevItemsById[ticket.id];

      if (existingItem) {
        // Ticket already rendered — check if data or clusters changed
        const oldTicket = oldById.get(ticket.id);
        const dataChanged = !oldTicket || this._ticketChanged(oldTicket, ticket);
        // Re-render if ticket data changed or if clusters updated (may affect tag display)
        const clusterRelevant = clustersChanged && Array.isArray(ticket.clusterIds) && ticket.clusterIds.length > 0;

        if (dataChanged || clusterRelevant) {
          // Re-render this ticket item in place
          existingItem.ticket = ticket;
          existingItem.clusters = this.clusters; // propagate updated clusters
          const newEl = existingItem.render(); // returns a fresh element
          if (existingItem.el && existingItem.el !== newEl && existingItem.el.parentNode) {
            existingItem.el.parentNode.replaceChild(newEl, existingItem.el);
          }
        }
        // Preserve expansion state (already tracked in the item)
        if (ticket.ticketId) nextItemsById[ticket.ticketId] = existingItem;
        if (ticket.id) nextItemsById[ticket.id] = existingItem;
        fragment.appendChild(existingItem.el);
      } else {
        // New ticket — create fresh item
        const item = this._createItem(ticket, expandedIds);
        const node = item.render();
        if (ticket.ticketId) nextItemsById[ticket.ticketId] = item;
        if (ticket.id) nextItemsById[ticket.id] = item;
        fragment.appendChild(node);
      }
    }

    // ------------------------------------------------------------------
    // Update the container in one pass
    // ------------------------------------------------------------------
    this._itemsById = nextItemsById;
    this._renderedTickets = newTickets.slice();

    if (!hasItems) {
      // Transition to empty state
      this.el.innerHTML = '';
      this.el.appendChild(this._renderEmptyState());
    } else {
      // Replace entire children list with sorted fragment in one operation
      this.el.innerHTML = '';
      this.el.appendChild(fragment);
    }

    // Restore focus if the previously-focused element was temporarily detached
    // from the live DOM during the re-render (e.g. a text field inside a ticket
    // card whose root element was replaced). This prevents the "reopen" comment
    // input from losing focus on every Firestore-triggered render loop.
    if (focusedEl && focusedEl !== document.body && document.activeElement !== focusedEl) {
      if (document.contains(focusedEl)) {
        focusedEl.focus({ preventScroll: true });
      }
    }

    return this.el;
  }

  /**
   * Lightweight equality check — returns true if any visible field changed.
   * Avoids JSON.stringify overhead by checking only meaningful properties.
   */
  _ticketChanged(oldT, newT) {
    return (
      oldT.status !== newT.status ||
      oldT.title !== newT.title ||
      oldT.type !== newT.type ||
      oldT.description !== newT.description ||
      oldT.deployedVersion !== newT.deployedVersion ||
      oldT.pendingQuestion !== newT.pendingQuestion ||
      oldT.durationMs !== newT.durationMs ||
      oldT.costUsd !== newT.costUsd ||
      (oldT.statusHistory || []).length !== (newT.statusHistory || []).length ||
      // Evidence fields — compare lengths to detect additions
      (oldT.fileRefs || []).length !== (newT.fileRefs || []).length ||
      (oldT.relatedTicketIds || []).length !== (newT.relatedTicketIds || []).length ||
      // Cluster assignment changes
      (oldT.clusterIds || []).length !== (newT.clusterIds || []).length ||
      // Screenshot presence change
      Boolean(oldT.screenshot) !== Boolean(newT.screenshot) ||
      // Reasoning presence or summary change
      Boolean(oldT.reasoning) !== Boolean(newT.reasoning) ||
      (oldT.reasoning && newT.reasoning && oldT.reasoning.summary !== newT.reasoning.summary) ||
      // Links changes — detect additions/removals/type changes
      (oldT.links || []).length !== (newT.links || []).length ||
      Boolean(oldT.hasLinks) !== Boolean(newT.hasLinks) ||
      // Critical flag change — affects badge and action buttons
      Boolean(oldT.critical) !== Boolean(newT.critical)
    );
  }

  _createItem(ticket, expandedIds) {
    const wasExpanded = expandedIds
      ? (expandedIds.has(ticket.ticketId) || expandedIds.has(ticket.id))
      : false;
    // Pre-load any cached feedback for this ticket
    const cachedFeedback = this._feedbackCache[ticket.id] || this._feedbackCache[ticket.ticketId] || null;
    const item = new TicketItem({
      ticket,
      onTransition: this.onTransition,
      onAnswer: this.onAnswer,
      onRekick: this.onRekick,
      onDelete: this.onDelete,
      onReject: this.onReject,
      onSnooze: this.onSnooze,
      onFeedback: this.onFeedback,
      onAddNote: this.onAddNote,
      onExclude: this.onExclude,
      onMarkCritical: this.onMarkCritical,
      currentUserFeedback: cachedFeedback,
      isAdmin: this.isAdmin,
      toast: this.toast,
      initialExpanded: wasExpanded,
      onExpandChange: this.onExpandChange,
      repoBaseUrl: this.repoBaseUrl,
      allTickets: this.allTickets,
      clusters: this.clusters,
      onClusterFilter: this.onClusterFilter,
      onAddLink: this.onAddLink,
      onRemoveLink: this.onRemoveLink,
    });
    return item;
  }

  /**
   * Get a TicketItem instance by ticketId or Firestore doc id.
   * @param {string} id
   * @returns {TicketItem|null}
   */
  getItem(id) {
    return this._itemsById[id] || null;
  }
}

// ---------------------------------------------------------------------------
// TicketAdminPanel — main orchestrator
// ---------------------------------------------------------------------------

export class TicketAdminPanel {
  /**
   * @param {Object} options
   * @param {HTMLElement}  options.container      - DOM element to render into
   * @param {Object}       options.db             - Firestore instance (web SDK)
   * @param {string}       options.projectId      - which project (ignored when projectIds is set)
   * @param {string[]}    [options.projectIds]    - multiple project IDs for a unified all-projects view
   * @param {Function}     options.getUser        - () => ({ uid, email })
   * @param {Function}     options.isAdmin        - () => boolean
   * @param {Function}    [options.classifyTicket] - async (desc) => ({ type, title })
   * @param {string}      [options.theme]          - 'light' | 'dark' | 'auto'
   * @param {Object}      [options.features]       - feature flags
   * @param {Function}    [options.serverTimestamp] - () => FieldValue.serverTimestamp()
   * @param {Function}    [options.onClose]        - callback when close button is clicked
   * @param {string}      [options.storageKey]     - localStorage namespace key (defaults to projectId/projectIds)
   * @param {string}      [options.repoBaseUrl]    - optional base URL for linking file refs (e.g. https://github.com/org/repo)
   */
  constructor(options = {}) {
    this.container = options.container;
    this.db = options.db;
    this.projectId = options.projectId;
    this.projectIds = options.projectIds || null; // multi-project mode
    this.projects = options.projects || null; // [{ id, name }] for project selector in form
    this.defaultProjectId = options.defaultProjectId || null; // default selection in project selector
    this.getUser = options.getUser || (() => ({ uid: null, email: '' }));
    this._isAdmin = options.isAdmin || (() => false);
    this.classifyTicket = options.classifyTicket || null;
    this.onClose = options.onClose || null;
    this.theme = options.theme || 'auto';
    this.features = Object.assign(
      { createTicket: true, screenshots: true, rekickButton: true },
      options.features,
    );
    // repoBaseUrl is optional — used to build file ref links in the Evidence section.
    // Can also be set per-project via Firestore project doc (loaded in _startProjectVersionListeners).
    this._repoBaseUrl = options.repoBaseUrl || null;
    // Track whether caller supplied repoBaseUrl so project-doc value doesn't override it.
    this._repoBaseUrlFromOptions = Boolean(options.repoBaseUrl);

    // Resolve serverTimestamp
    this.serverTimestamp = options.serverTimestamp || this._detectServerTimestamp();
    this._arrayUnion = options.arrayUnion || this._detectArrayUnion();
    this._arrayRemove = options.arrayRemove || this._detectArrayRemove();

    // Core services — one per project
    if (this.projectIds && this.projectIds.length > 0) {
      // Multi-project mode: create a ticket service for each project
      this._ticketServices = this.projectIds.map(pid =>
        createTicketService(this.db, pid, {
          serverTimestamp: this.serverTimestamp,
          arrayUnion: this._arrayUnion,
          arrayRemove: this._arrayRemove,
        })
      );
      // Use first project's service as primary (for rekick etc.)
      this.ticketService = this._ticketServices[0];
    } else {
      this._ticketServices = null;
      this.ticketService = createTicketService(this.db, this.projectId, {
        serverTimestamp: this.serverTimestamp,
        arrayUnion: this._arrayUnion,
        arrayRemove: this._arrayRemove,
      });
    }
    this.projectService = createProjectService(this.db);
    // Feedback service — bound to the same db instance
    this._feedbackService = createFeedbackService(this.db);

    // Derive a localStorage namespace key for this panel instance.
    // Use the explicit storageKey option, or fall back to projectId / sorted projectIds.
    if (options.storageKey) {
      this._storageKey = options.storageKey;
    } else if (this.projectIds && this.projectIds.length > 0) {
      this._storageKey = 'all';
    } else {
      this._storageKey = this.projectId || 'default';
    }

    // Internal state — restored from localStorage where available
    const saved = this._loadState();
    this._tickets = [];
    this._filteredTickets = [];
    this._activeFilter = saved.activeFilter || 'open';
    this._searchQuery = saved.searchQuery || '';
    this._activeClusterFilter = null; // clusterId or null
    this._activeDependencyFilter = 'all'; // 'all' | 'blocked' | 'independent'
    this._activeSort = 'default'; // 'default' | 'convergence'
    this._mounted = false;
    this._styleEl = null;
    this._root = null;
    this._listContainer = null;
    this._unsubscribe = null;
    // track which tickets are expanded across re-renders
    this._expandedTicketIds = new Set(saved.expandedTicketIds || []);

    // Live version state: projectId -> { liveVersion, liveVersionAt }
    this._projectVersions = {}; // projectId -> liveVersion string or null
    this._projectVersionUnsubs = []; // Firestore unsub functions
    this._liveVersionEl = null; // DOM element for live version display

    // Cluster state — Map<clusterId, { id, label, ticketCount }> merged across projects
    this._clusters = new Map();
    this._clusterUnsubs = []; // Firestore unsub functions for cluster listeners

    // Sub-components
    this.toast = new TicketToast();
    this.filters = null;
    this.ticketList = null;
  }

  // -----------------------------------------------------------------------
  // localStorage helpers
  // -----------------------------------------------------------------------

  _lsKey() {
    return `docket_panel_state_${this._storageKey}`;
  }

  _loadState() {
    try {
      const raw = localStorage.getItem(this._lsKey());
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_e) {
      return {};
    }
  }

  _saveState() {
    try {
      const state = {
        activeFilter: this._activeFilter,
        searchQuery: this._searchQuery,
        expandedTicketIds: Array.from(this._expandedTicketIds),
      };
      localStorage.setItem(this._lsKey(), JSON.stringify(state));
    } catch (_e) {
      // localStorage not available or full — ignore
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async mount() {
    if (this._mounted) return;
    this._mounted = true;

    // Inject styles
    this._styleEl = document.createElement('style');
    this._styleEl.setAttribute('data-tk-admin-panel', '');
    this._styleEl.textContent = getStyles();
    document.head.appendChild(this._styleEl);

    // Root element
    this._root = el('div', { className: this._rootClass() });
    this.container.appendChild(this._root);

    // Toast
    this.toast.mount(document.body);

    // Build UI skeleton
    this._buildUI();

    // Listen to media query for auto theme
    if (this.theme === 'auto') {
      this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._mediaHandler = () => this._applyTheme();
      this._mediaQuery.addEventListener('change', this._mediaHandler);
    }

    // Load tickets
    await this.refresh();

    // Real-time listener (if supported)
    this._startRealtimeListener();

    // Project version listeners — track liveVersion on project documents
    this._startProjectVersionListeners();

    // Cluster listeners — track theme clusters for tag rendering and filtering
    this._startClusterListeners();
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;

    // Stop real-time listener
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    // Stop project version listeners
    for (const unsub of this._projectVersionUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._projectVersionUnsubs = [];

    // Stop cluster listeners
    for (const unsub of this._clusterUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._clusterUnsubs = [];

    // Remove media query listener
    if (this._mediaQuery && this._mediaHandler) {
      this._mediaQuery.removeEventListener('change', this._mediaHandler);
    }

    // Remove toast
    this.toast.unmount();

    // Remove style
    if (this._styleEl && this._styleEl.parentNode) {
      this._styleEl.parentNode.removeChild(this._styleEl);
    }
    this._styleEl = null;

    // Remove root
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
  }

  async refresh() {
    if (!this._mounted) return;
    try {
      this._showLoading();
      if (this._ticketServices && this._ticketServices.length > 0) {
        // Multi-project mode: fetch from all projects and merge
        const results = await Promise.all(this._ticketServices.map(svc => svc.listAll()));
        const merged = [].concat(...results);
        // Sort descending by ticketNumber (cross-project, best-effort)
        merged.sort((a, b) => (b.ticketNumber || 0) - (a.ticketNumber || 0));
        this._tickets = merged;
      } else {
        this._tickets = await this.ticketService.listAll();
      }
      this._applyFilters();
      this._renderList();
      this._updateCounts();
    } catch (err) {
      this.toast.error('Failed to load tickets: ' + err.message);
    }
  }

  /**
   * Find a ticket by ticketId (e.g. "DK-019") or Firestore doc id and expand it,
   * scrolling it into view. If the ticket is currently filtered out, clears
   * filters first so it becomes visible.
   *
   * @param {string} ticketId - ticketId (e.g. "DK-019") or Firestore doc id
   * @returns {boolean} true if the ticket was found and focused
   */
  focusTicket(ticketId) {
    if (!this.ticketList) return false;

    // First try to find it in the current rendered list
    let item = this.ticketList.getItem(ticketId);

    if (!item) {
      // The ticket might be filtered out — check if it exists in _tickets at all
      const ticket = this._tickets.find(
        t => t.ticketId === ticketId || t.id === ticketId
      );
      if (!ticket) return false;

      // Clear active filter, cluster filter, and search so the ticket becomes visible
      this._activeFilter = 'all';
      this._searchQuery = '';
      this._activeClusterFilter = null;
      this._saveState();
      if (this.filters) {
        this.filters.setFilter('all');
        this.filters.setSearch('');
      }
      this._applyFilters();
      this._renderList();

      item = this.ticketList.getItem(ticketId);
      if (!item) return false;
    }

    // Expand the item if not already expanded
    if (!item.expanded) {
      item._toggle();
    }

    // Scroll into view
    if (item.el) {
      item.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // UI construction
  // -----------------------------------------------------------------------

  _buildUI() {
    // Header with rekick button and close
    const headerActions = el('div', { className: 'tk-header-actions' });

    if (this.features.rekickButton && this._isAdmin()) {
      const rekickBtn = el('button', {
        className: 'tk-btn tk-btn-outline tk-btn-sm',
        onClick: async () => {
          rekickBtn.disabled = true;
          rekickBtn.classList.add('tk-btn-loading');
          rekickBtn.textContent = 'Rekicking...';
          try {
            const count = await this.ticketService.rekickOrchestrator();
            this.toast.success(`Rekicked ${count} ticket(s) to open.`);
            await this.refresh();
          } catch (err) {
            this.toast.error('Rekick failed: ' + err.message);
          } finally {
            rekickBtn.disabled = false;
            rekickBtn.classList.remove('tk-btn-loading');
            rekickBtn.textContent = '\u27F3 Rekick Orchestrator';
          }
        },
      }, '\u27F3 Rekick Orchestrator');
      headerActions.appendChild(rekickBtn);
    }

    // Token Spend button — always visible in the toolbar
    const tokenSpendBtn = el('button', {
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      title: 'View token spend breakdown',
      onClick: () => this._showTokenSpend(),
    }, '\uD83D\uDCB0 Token Spend');
    headerActions.appendChild(tokenSpendBtn);

    // Changelog button — always visible in the toolbar
    const changelogBtn = el('button', {
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      title: 'View changelog',
      onClick: () => this._showChangelog(),
    }, '\uD83D\uDCCB Changelog');
    headerActions.appendChild(changelogBtn);

    if (this.onClose) {
      const closeBtn = el('button', {
        className: 'tk-btn-close',
        onClick: () => this.onClose(),
      }, '\u00D7');
      headerActions.appendChild(closeBtn);
    }

    const header = el('div', { className: 'tk-header' },
      headerActions,
    );
    this._root.appendChild(header);

    // Body wrapper for left/right padding
    const body = el('div', { className: 'tk-panel-body' });
    this._root.appendChild(body);

    // Ticket form
    if (this.features.createTicket) {
      const form = new TicketForm({
        onSubmit: (data) => this._createTicket(data),
        classifyTicket: this.classifyTicket,
        features: this.features,
        toast: this.toast,
        projects: this.projects,
        defaultProjectId: this.defaultProjectId,
      });
      body.appendChild(form.render());
    }

    // Filters — restore saved state before first render
    this.filters = new TicketFilters({
      onFilterChange: (filter) => {
        this._activeFilter = filter;
        // Clear cluster filter when switching status tabs for a clean view
        this._activeClusterFilter = null;
        // Reset dependency filter when switching tabs
        this._activeDependencyFilter = 'all';
        this._saveState();
        this._applyFilters();
        this._renderList();
      },
      onSearchChange: (query) => {
        this._searchQuery = query;
        this._saveState();
        this._applyFilters();
        this._renderList();
      },
      onDependencyFilterChange: (depFilter) => {
        this._activeDependencyFilter = depFilter;
        this._applyFilters();
        this._renderList();
      },
      onSortChange: (sort) => {
        this._activeSort = sort;
        this._applyFilters();
        this._renderList();
      },
    });
    // Restore persisted filter/search before mounting
    this.filters.activeFilter = this._activeFilter;
    this.filters.searchQuery = this._searchQuery;
    body.appendChild(this.filters.render());

    // Live version indicator — shows the current deployed version of the project(s)
    this._liveVersionEl = el('div', { className: 'tk-live-version' });
    body.appendChild(this._liveVersionEl);

    // List container
    this._listContainer = el('div');
    body.appendChild(this._listContainer);

    // Advisor run log section — shown when runLog feature is enabled
    if (this.features.runLog !== false && this.db) {
      const runLogSection = new PersonaRunLogSection({ db: this.db, limit: 20 });
      body.appendChild(runLogSection.render());
    }
  }

  _showLoading() {
    if (!this._listContainer) return;
    // Reset ticketList so the next _renderList() call does a full (fresh) render
    // rather than trying to patch against stale DOM nodes.
    this._resetList();
    this._listContainer.innerHTML = '';

    // Build a skeleton card that matches the visual structure of a real ticket row
    const makeSkeletonCard = () =>
      el('div', { className: 'tk-skeleton-card' },
        el('div', { className: 'tk-skeleton-header' },
          el('div', { className: 'tk-skeleton-block tk-skeleton-id' }),
          el('div', { className: 'tk-skeleton-block tk-skeleton-type' }),
          el('div', { className: 'tk-skeleton-block tk-skeleton-status' }),
          el('div', { className: 'tk-skeleton-block tk-skeleton-title-line' }),
        ),
        el('div', { className: 'tk-skeleton-title-area' },
          el('div', { className: 'tk-skeleton-block tk-skeleton-title-full' }),
        ),
      );

    this._listContainer.appendChild(
      el('div', { className: 'tk-skeleton-list', role: 'status', 'aria-label': 'Loading tickets…' },
        makeSkeletonCard(),
        makeSkeletonCard(),
        makeSkeletonCard(),
        makeSkeletonCard(),
      )
    );
  }

  /**
   * Compute the context-aware empty state descriptor for the current
   * filter + ticket counts. Returns an object for TicketList.emptyState.
   */
  _computeEmptyState() {
    const hasAnyTickets = this._tickets.length > 0;
    const filter = this._activeFilter;
    const hasSearch = Boolean(this._searchQuery.trim());
    const hasCluster = Boolean(this._activeClusterFilter);

    // If a search query produced no results
    if (hasSearch) {
      return {
        icon: '🔍',
        title: 'No results found',
        message: `No tickets match "${this._searchQuery}". Try a different search term.`,
      };
    }

    // If a cluster filter produced no results
    if (hasCluster) {
      return {
        icon: '🏷️',
        title: 'No tickets in this cluster',
        message: 'No tickets are assigned to this theme cluster.',
      };
    }

    // True "no tickets yet" state — project has no tickets at all
    if (!hasAnyTickets) {
      return {
        icon: '🎉',
        title: 'No tickets yet',
        message: 'This project is all clear! Use the form above to create your first ticket, or ask the AI advisor to generate proposals.',
      };
    }

    // Filter-specific empty states when there ARE tickets, just none in this status
    const filterMessages = {
      open:            { icon: '✅', title: 'No open tickets', message: 'All caught up — nothing is waiting to be picked up.' },
      proposed:        { icon: '💡', title: 'No proposals', message: 'No tickets are waiting for review right now.' },
      in_progress:     { icon: '⚙️', title: 'Nothing in progress', message: 'No tickets are currently being worked on.' },
      done:            { icon: '📦', title: 'No completed tickets', message: 'Completed tickets will appear here once work is shipped.' },
      blocked:         { icon: '🚧', title: 'No blocked tickets', message: 'No tickets are currently blocked.' },
      in_maintenance:  { icon: '🔧', title: 'Nothing in maintenance', message: 'No tickets are currently in maintenance.' },
      waiting_for_user:{ icon: '💬', title: 'No pending questions', message: 'No tickets are waiting for your input.' },
      all:             { icon: '🗂️', title: 'No tickets', message: 'This project has no tickets yet. Use the form above to get started.' },
    };

    return filterMessages[filter] || {
      icon: '🗂️',
      title: 'No tickets',
      message: 'No tickets match the current filters.',
    };
  }

  _renderList() {
    if (!this._listContainer) return;

    if (!this.ticketList) {
      // First render — create TicketList and mount it
      this.ticketList = new TicketList({
        onTransition: (id, status, opts) => this._transitionTicket(id, status, opts),
        onAnswer: (id, answer) => this._answerQuestion(id, answer),
        onRekick: () => this.ticketService.rekickOrchestrator(),
        onDelete: (id) => this._deleteTicket(id),
        onReject: (opts) => this._rejectProposal(opts),
        onSnooze: (id, date) => this._snoozeTicket(id, date),
        onFeedback: (docId, rating) => this._handleFeedback(docId, rating),
        onAddNote: (docId, note) => this._appendNote(docId, note),
        onExclude: ({ personaId, pattern }) => this._handleExclude({ personaId, pattern }),
        onMarkCritical: (docId) => this._markCritical(docId),
        getFeedback: (docId) => this._getFeedback(docId),
        isAdmin: () => this._isAdmin(),
        toast: this.toast,
        onExpandChange: (ticketId, docId, expanded) => {
          if (expanded) {
            if (ticketId) this._expandedTicketIds.add(ticketId);
            if (docId) this._expandedTicketIds.add(docId);
          } else {
            if (ticketId) this._expandedTicketIds.delete(ticketId);
            if (docId) this._expandedTicketIds.delete(docId);
          }
          this._saveState();
        },
        repoBaseUrl: this._repoBaseUrl,
        allTickets: this._tickets,
        clusters: this._clusters,
        onClusterFilter: (clusterId) => {
          // Toggle cluster filter: click same cluster again to clear
          this._activeClusterFilter = this._activeClusterFilter === clusterId ? null : clusterId;
          this._applyFilters();
          this._renderList();
        },
        onAddLink: (sourceDocId, targetDocId, type) => this._addLink(sourceDocId, targetDocId, type),
        onRemoveLink: (sourceDocId, targetDocId) => this._removeLink(sourceDocId, targetDocId),
      });
      // Set empty state before first render
      this.ticketList.emptyState = this._computeEmptyState();
      this._listContainer.innerHTML = '';
      this._listContainer.appendChild(this.ticketList.render(this._filteredTickets, this._expandedTicketIds));
    } else {
      // Subsequent renders — patch in place (TicketList handles incremental DOM updates)
      // Update allTickets so related ticket lookups stay fresh
      this.ticketList.allTickets = this._tickets;
      // Update clusters so cluster tags stay in sync
      this.ticketList.clusters = this._clusters;
      // Refresh empty state in case filter or search changed
      this.ticketList.emptyState = this._computeEmptyState();
      this.ticketList.render(this._filteredTickets, this._expandedTicketIds);
      // Ensure the list element is still mounted (e.g. after _showLoading() cleared the container)
      if (this.ticketList.el && !this.ticketList.el.isConnected) {
        this._listContainer.innerHTML = '';
        this._listContainer.appendChild(this.ticketList.el);
      }
    }

    // Show/update the snoozed section when viewing proposed tickets (or all)
    this._renderSnoozedSection();

    // Show/update the collapsed "Rejected" section when viewing proposed or all
    this._renderRejectedSection();
  }

  /**
   * Render (or update) the collapsible "Snoozed" section that shows currently
   * snoozed proposed tickets below the active list. This section is shown
   * whenever the active filter is 'proposed' or 'all'.
   */
  _renderSnoozedSection() {
    if (!this._listContainer) return;

    // Only show in proposed or all views
    const showSnoozed = this._activeFilter === 'proposed' || this._activeFilter === 'all';

    // Remove any existing snoozed section first
    const existing = this._listContainer.querySelector('.tk-snoozed-section');
    if (existing) existing.parentNode.removeChild(existing);

    if (!showSnoozed) return;

    // Find currently snoozed proposed tickets
    const now = new Date();
    const snoozed = this._tickets.filter(t => {
      if (t.status !== 'proposed') return false;
      if (!t.snoozedUntil) return false;
      const d = new Date(t.snoozedUntil);
      return !isNaN(d.getTime()) && d > now;
    });

    if (snoozed.length === 0) return;

    // Sort by snoozedUntil ascending (earliest resurface first)
    snoozed.sort((a, b) => new Date(a.snoozedUntil) - new Date(b.snoozedUntil));

    const noun = snoozed.length === 1 ? 'proposal' : 'proposals';
    const snoozedList = el('div', { className: 'tk-snoozed-list', style: { display: 'none' } });

    snoozed.forEach(t => {
      const resurfaceStr = formatDate(t.snoozedUntil);
      const row = el('div', { className: 'tk-snoozed-row' },
        el('span', { className: 'tk-snoozed-row-title' }, t.ticketId ? `${t.ticketId}: ` : ''),
        el('span', null, t.title || ''),
        el('span', { className: 'tk-snoozed-row-resurface' }, ` — resurfaces ${resurfaceStr}`),
        el('button', {
          type: 'button',
          className: 'tk-btn tk-btn-ghost tk-btn-sm tk-snoozed-row-wake',
          'aria-label': `Wake up ${t.title} now`,
          onClick: async (e) => {
            e.stopPropagation();
            try {
              await this._snoozeTicket(t.id, null);
              this.toast.success('Proposal unsnoozed.');
            } catch (err) {
              this.toast.error('Failed: ' + err.message);
            }
          },
        }, 'Wake up'),
      );
      snoozedList.appendChild(row);
    });

    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-snoozed-toggle',
      'aria-expanded': 'false',
      'aria-label': `${snoozed.length} snoozed ${noun} — click to expand`,
      onClick: () => {
        const isOpen = snoozedList.style.display !== 'none';
        snoozedList.style.display = isOpen ? 'none' : 'block';
        toggleBtn.setAttribute('aria-expanded', String(!isOpen));
        toggleBtn.textContent = `⏰ ${snoozed.length} snoozed ${noun} ${!isOpen ? '▲' : '▼'}`;
      },
    }, `⏰ ${snoozed.length} snoozed ${noun} ▼`);

    const section = el('div', { className: 'tk-snoozed-section' },
      toggleBtn,
      snoozedList,
    );

    this._listContainer.appendChild(section);
  }

  /**
   * Render (or update) the collapsed "Rejected" section that shows rejected
   * proposed tickets below the active list. Shown when the active filter is
   * 'proposed' or 'all'. Collapsed by default — users can expand to review.
   */
  _renderRejectedSection() {
    if (!this._listContainer) return;

    // Only show in proposed or all views
    const showRejected = this._activeFilter === 'proposed' || this._activeFilter === 'all';

    // Remove any existing rejected section first
    const existing = this._listContainer.querySelector('.tk-rejected-section');
    if (existing) existing.parentNode.removeChild(existing);

    if (!showRejected) return;

    // Find rejected tickets
    const rejected = this._tickets.filter(t => t.status === 'rejected');

    if (rejected.length === 0) return;

    // Sort by updatedAt/createdAt descending (most recently rejected first)
    rejected.sort((a, b) => {
      const aDate = a.updatedAt || a.createdAt || '';
      const bDate = b.updatedAt || b.createdAt || '';
      return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
    });

    const noun = rejected.length === 1 ? 'proposal' : 'proposals';
    const rejectedList = el('div', { className: 'tk-rejected-list', style: { display: 'none' } });

    // Human-readable reason labels for display
    const REASON_LABELS = {
      off_topic:       'Off-topic',
      too_small:       'Too small',
      already_covered: 'Already covered',
      not_relevant:    'Not relevant',
    };

    rejected.forEach(t => {
      const rejectedAt = formatDate(t.updatedAt || t.createdAt);
      const reasonLabel = REASON_LABELS[t.rejectionReason] || '';
      const row = el('div', { className: 'tk-rejected-row' },
        el('span', { className: 'tk-rejected-row-title' }, t.ticketId ? `${t.ticketId}: ` : ''),
        el('span', null, t.title || ''),
        reasonLabel ? el('span', { className: 'tk-rejected-row-reason' }, ` — ${reasonLabel}`) : null,
        el('span', { className: 'tk-rejected-row-date' }, ` (${rejectedAt})`),
      );
      rejectedList.appendChild(row);
    });

    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-rejected-toggle',
      'aria-expanded': 'false',
      'aria-label': `${rejected.length} rejected ${noun} — click to expand`,
      onClick: () => {
        const isOpen = rejectedList.style.display !== 'none';
        rejectedList.style.display = isOpen ? 'none' : 'block';
        toggleBtn.setAttribute('aria-expanded', String(!isOpen));
        toggleBtn.textContent = `✕ ${rejected.length} rejected ${noun} ${!isOpen ? '▲' : '▼'}`;
      },
    }, `✕ ${rejected.length} rejected ${noun} ▼`);

    const section = el('div', { className: 'tk-rejected-section' },
      toggleBtn,
      rejectedList,
    );

    this._listContainer.appendChild(section);
  }

  /**
   * Destroy and re-create the TicketList (used after _showLoading() wipes the container).
   * @private
   */
  _resetList() {
    this.ticketList = null;
  }

  // -----------------------------------------------------------------------
  // Feedback helpers
  // -----------------------------------------------------------------------

  /**
   * Handle a user's feedback rating for an advisor-generated ticket.
   * Called from TicketItem via TicketList.onFeedback.
   *
   * Writes to the /feedback collection via feedback-service.
   * Also updates the local cache so re-renders stay consistent.
   *
   * @param {string} docId  - Firestore doc ID of the ticket
   * @param {"relevant"|"noise"} rating
   */
  async _handleFeedback(docId, rating) {
    const user = this.getUser();
    if (!user || !user.uid) {
      throw new Error('Must be signed in to rate tickets');
    }
    // Find the ticket to get its projectId
    const ticket = this._tickets.find(t => t.id === docId || t.ticketId === docId);
    const projectId = (ticket && ticket.projectId) || this.projectId;
    if (!projectId) {
      throw new Error('Could not determine projectId for feedback');
    }
    await this._feedbackService.submitFeedback({
      ticketId: docId,
      projectId,
      rating,
      userId: user.uid,
    });
    // Update local cache
    if (this.ticketList) {
      this.ticketList._feedbackCache[docId] = rating;
    }
  }

  /**
   * Handle "Exclude this path/URL" action from a ticket card. (DK-128)
   * Appends the pattern to the project's exclusions array for the given persona.
   * Enforces max 20 patterns, 200 chars per pattern.
   *
   * @param {object} opts
   * @param {string} opts.personaId - 'engineer' | 'design'
   * @param {string} opts.pattern   - The exclusion pattern to add
   * @returns {Promise<void>}
   */
  async _handleExclude({ personaId, pattern }) {
    if (!pattern || typeof pattern !== 'string') return;
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.length > 200) throw new Error('Invalid pattern');

    // Determine the project ID — use the single projectId or the first one
    const projectId = this.projectId || (this.projectIds && this.projectIds[0]);
    if (!projectId) throw new Error('No project selected');

    // Read current exclusions, append the new pattern, write back
    let currentExclusions = [];
    try {
      const snap = await this.db.collection('projects').doc(projectId).get();
      if (snap.exists) {
        const data = snap.data();
        const arr = data?.exclusions?.[personaId];
        if (Array.isArray(arr)) currentExclusions = arr;
      }
    } catch {
      // Non-fatal: proceed with empty array — safe to append to empty list
    }

    if (currentExclusions.length >= 20) {
      throw new Error('Maximum of 20 exclusion patterns already set');
    }
    if (currentExclusions.includes(trimmed)) {
      return; // Already present — idempotent, not an error
    }

    const newExclusions = [...currentExclusions, trimmed];
    await this.db.collection('projects').doc(projectId).set(
      { exclusions: { [personaId]: newExclusions } },
      { merge: true }
    );
  }

  /**
   * Get the current user's feedback for a ticket.
   * Called from TicketList.getFeedback.
   *
   * Checks the local cache first; falls back to Firestore.
   *
   * @param {string} docId - Firestore doc ID of the ticket
   * @returns {Promise<"relevant"|"noise"|null>}
   */
  async _getFeedback(docId) {
    // Check cache first
    if (this.ticketList && this.ticketList._feedbackCache[docId] !== undefined) {
      return this.ticketList._feedbackCache[docId];
    }
    const user = this.getUser();
    if (!user || !user.uid) return null;
    const data = await this._feedbackService.getFeedback(docId, user.uid);
    const rating = data ? data.rating : null;
    // Store in cache
    if (this.ticketList) {
      this.ticketList._feedbackCache[docId] = rating;
    }
    return rating;
  }

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  _applyFilters() {
    let tickets = this._tickets;

    // Status filter
    if (this._activeFilter !== 'all') {
      tickets = tickets.filter(t => t.status === this._activeFilter);
    }

    // Exclude currently snoozed proposed tickets from the main list —
    // they appear in the collapsible "Snoozed" section instead.
    // Do not apply this exclusion on the 'all' filter so snoozed tickets
    // remain searchable.
    if (this._activeFilter === 'proposed') {
      const now = new Date();
      tickets = tickets.filter(t => {
        if (!t.snoozedUntil) return true;
        const d = new Date(t.snoozedUntil);
        return isNaN(d.getTime()) || d <= now;
      });
    }

    // Cluster filter — show only tickets belonging to the selected cluster
    if (this._activeClusterFilter) {
      const cid = this._activeClusterFilter;
      tickets = tickets.filter(t =>
        Array.isArray(t.clusterIds) && t.clusterIds.includes(cid)
      );
    }

    // Dependency filter — only applies when viewing proposed tickets
    // "blocked" = has at least one incoming 'blocks' link from another proposed ticket
    // "independent" = has no incoming 'blocks' links from other proposed tickets
    if (this._activeDependencyFilter && this._activeDependencyFilter !== 'all' && this._activeFilter === 'proposed') {
      // Build a set of proposed ticket IDs that are blocked by another proposal
      const allProposed = this._tickets.filter(t => t.status === 'proposed');
      const blockedIds = new Set();
      for (const t of allProposed) {
        const links = Array.isArray(t.links) ? t.links : [];
        for (const link of links) {
          if (link.type === 'blocks') {
            // t blocks link.targetId — find if targetId is also proposed
            const target = allProposed.find(p => p.id === link.targetId);
            if (target) blockedIds.add(link.targetId);
          }
        }
      }
      if (this._activeDependencyFilter === 'blocked') {
        tickets = tickets.filter(t => blockedIds.has(t.id));
      } else if (this._activeDependencyFilter === 'independent') {
        tickets = tickets.filter(t => !blockedIds.has(t.id));
      }
    }

    // Search
    if (this._searchQuery.trim()) {
      const q = this._searchQuery.toLowerCase();
      tickets = tickets.filter(t => {
        const fields = [
          t.ticketId,
          t.title,
          t.description,
          t.type,
          t.status,
          statusLabel(t.status),
          t.userEmail,
        ];
        return fields.some(f => f && String(f).toLowerCase().includes(q));
      });
    }

    // Convergence sort — order by convergenceCount descending when active
    if (this._activeSort === 'convergence') {
      tickets = [...tickets].sort((a, b) => {
        const ca = typeof a.convergenceCount === 'number' ? a.convergenceCount : 0;
        const cb = typeof b.convergenceCount === 'number' ? b.convergenceCount : 0;
        return cb - ca; // descending
      });
    }

    // Proposed queue convergence grouping — when viewing proposed tickets, group
    // converged proposals together so reviewers see them as a set.
    // Only applies when NOT using convergence sort (which already surfaces them).
    if (this._activeFilter === 'proposed' && this._activeSort !== 'convergence') {
      tickets = this._groupProposedByConvergence(tickets);
    }

    this._filteredTickets = tickets;

    // Update sort control visibility based on whether any ticket in the full set has convergence
    if (this.filters) {
      const anyConverged = this._tickets.some(t => typeof t.convergenceCount === 'number' && t.convergenceCount >= 1);
      this.filters.setHasConvergedTickets(anyConverged);
    }
  }

  _updateCounts() {
    const counts = { all: this._tickets.length };
    const countMap = {};
    for (const t of this._tickets) {
      countMap[t.status] = (countMap[t.status] || 0) + 1;
    }
    counts.proposed = countMap.proposed || 0;
    counts.open = countMap.open || 0;
    counts.in_progress = countMap.in_progress || 0;
    counts.blocked = countMap.blocked || 0;
    counts.in_maintenance = countMap.in_maintenance || 0;
    counts.waiting_for_user = countMap.waiting_for_user || 0;
    counts.done = countMap.done || 0;

    if (this.filters) this.filters.setCounts(counts);
  }

  /**
   * Re-order proposed tickets so that convergence groups appear together.
   * Tickets with shared convergence relationships are moved adjacent to each other.
   * Non-converged tickets retain their original relative order.
   *
   * Algorithm:
   *   1. Build a union-find structure to identify convergence groups
   *   2. Assign a group-order based on the earliest index in the group
   *   3. Sort by (group-order, original-index) so groups cluster together
   *
   * @param {Array} tickets
   * @returns {Array}
   */
  _groupProposedByConvergence(tickets) {
    if (!tickets || tickets.length === 0) return tickets;

    // Map: docId -> index in tickets array
    const idxById = new Map();
    tickets.forEach((t, i) => { if (t.id) idxById.set(t.id, i); });

    // Build adjacency: for each ticket, collect all convergence partner docIds
    const groupOf = new Array(tickets.length).fill(-1).map((_, i) => i); // union-find

    function find(i) {
      if (groupOf[i] !== i) groupOf[i] = find(groupOf[i]);
      return groupOf[i];
    }
    function unite(i, j) {
      const ri = find(i), rj = find(j);
      if (ri !== rj) groupOf[ri] = rj;
    }

    tickets.forEach((t, i) => {
      const convergence = Array.isArray(t.convergence) ? t.convergence : [];
      for (const entry of convergence) {
        const j = idxById.get(entry.ticketId);
        if (j !== undefined) unite(i, j);
      }
    });

    // Assign group-order = minimum original index within each group
    const groupMinIdx = new Map();
    tickets.forEach((_, i) => {
      const root = find(i);
      const current = groupMinIdx.get(root);
      if (current === undefined || i < current) groupMinIdx.set(root, i);
    });

    // Sort by (group-min-idx, original-idx) to cluster groups
    const indexed = tickets.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => {
      const ga = groupMinIdx.get(find(a.i));
      const gb = groupMinIdx.get(find(b.i));
      if (ga !== gb) return ga - gb;
      return a.i - b.i;
    });

    return indexed.map(x => x.t);
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async _createTicket({ type, title, description, screenshots, projectId, critical }) {
    const user = this.getUser();
    // Validate projectId against the allowed list before routing (defense-in-depth).
    // An attacker modifying the DOM could submit an arbitrary projectId; clamp it to
    // a known-good value so we never write to an unintended project.
    if (projectId && this.projectIds && !this.projectIds.includes(projectId)) {
      projectId = this.defaultProjectId;
    }
    // In multi-project mode, route to the correct project's ticket service
    let svc = this.ticketService;
    if (projectId && this._ticketServices && this.projectIds) {
      const idx = this.projectIds.indexOf(projectId);
      if (idx >= 0 && this._ticketServices[idx]) {
        svc = this._ticketServices[idx];
      }
    }
    await svc.add({
      type,
      title,
      description,
      screenshots,
      userId: user.uid,
      userEmail: user.email,
      critical: critical || false,
    });
    await this.refresh();
  }

  async _transitionTicket(docId, newStatus, opts) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.transitionStatus(docId, newStatus, opts);
    await this.refresh();
  }

  async _answerQuestion(docId, answer) {
    // Transition back to in_progress with the answer as a note,
    // and clear the pending question.
    const svc = this._getTicketServiceForDoc(docId);
    await svc.transitionStatus(docId, 'in_progress', {
      note: 'User answered: ' + answer,
      pendingQuestion: null,
    });
    await this.refresh();
  }

  /**
   * Append an implementation note to a ticket's statusHistory without changing its status.
   *
   * @param {string} docId - Firestore doc id
   * @param {string} note  - Note text
   */
  async _appendNote(docId, note) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.appendHistory(docId, { note });
    await this.refresh();
  }

  async _deleteTicket(docId) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.deleteTicket(docId);
    await this.refresh();
  }

  /**
   * Mark a ticket as critical so the orchestrator spawns a worker immediately,
   * bypassing the normal max-worker cap — matching the behavior of the critical
   * checkbox on the ticket creation form.
   *
   * @param {string} docId - Firestore doc id
   */
  async _markCritical(docId) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.update(docId, { critical: true });
    await this.refresh();
  }

  /**
   * Snooze or unsnooze a proposed ticket.
   * Pass null as date to unsnooze (clear snoozedUntil).
   *
   * @param {string} docId - Firestore doc id
   * @param {Date|null} date - Target resurface date, or null to unsnooze
   */
  async _snoozeTicket(docId, date) {
    const svc = this._getTicketServiceForDoc(docId);
    if (date === null) {
      await svc.unsnoozeTicket(docId);
    } else {
      await svc.snoozeTicket(docId, date);
    }
    await this.refresh();
  }

  /**
   * Write a rejection record for a proposed ticket.
   * Called after the 4-second undo window expires.
   *
   * Firestore schema (projects/{projectId}/rejections/{id}):
   *   reason        — enum: off_topic | too_small | already_covered | not_relevant
   *   persona       — string: engineer | design | product (from ticket field)
   *   ticketTitle   — immutable snapshot of AI-generated title at rejection time
   *   ticketSummary — immutable snapshot of AI-generated one-line summary at rejection time
   *   createdAt     — ISO timestamp
   *
   * @param {object} opts
   * @param {string} opts.ticketId       - Firestore doc id of the rejected ticket
   * @param {string} opts.ticketTitle    - AI-generated title (immutable snapshot)
   * @param {string} opts.ticketSummary  - AI-generated one-line summary (immutable snapshot)
   * @param {string} opts.reason         - Rejection reason enum
   * @param {string|null} opts.persona   - Advisor persona (engineer|design|product)
   */
  async _rejectProposal({ ticketId, ticketTitle, ticketSummary, reason, persona }) {
    // Determine which project this ticket belongs to for the correct Firestore path
    const ticket = this._tickets.find(t => t.id === ticketId);
    const projectId = (ticket && ticket.projectId) || this.projectId;
    if (!projectId) {
      console.warn('[docket] Cannot record rejection — projectId unknown for ticket', ticketId);
      return;
    }

    // Validate reason is in the allowed enum set before writing
    const VALID_REASONS = ['off_topic', 'too_small', 'already_covered', 'not_relevant'];
    if (!VALID_REASONS.includes(reason)) {
      console.warn('[docket] Invalid rejection reason:', reason);
      return;
    }

    // Write directly to Firestore rejections subcollection
    try {
      const ref = this.db
        .collection('projects')
        .doc(projectId)
        .collection('rejections')
        .doc(ticketId);

      const doc = {
        reason,
        // Immutable snapshots of AI-generated content — never store user-supplied text here
        ticketTitle: typeof ticketTitle === 'string' ? ticketTitle.slice(0, 500) : '',
        ticketSummary: typeof ticketSummary === 'string' ? ticketSummary.slice(0, 500) : '',
        persona: typeof persona === 'string' ? persona.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 50) : null,
        createdAt: new Date().toISOString(),
      };

      await ref.set(doc);
    } catch (err) {
      console.warn('[docket] Rejection record save failed:', err);
    }
  }

  _getTicketServiceForDoc(docId) {
    if (!this._ticketServices || this._ticketServices.length === 0) {
      return this.ticketService;
    }
    // Find which project owns this ticket by looking in _tickets
    const ticket = this._tickets.find(t => t.id === docId);
    if (ticket && ticket.projectId) {
      const idx = (this.projectIds || []).indexOf(ticket.projectId);
      if (idx >= 0 && this._ticketServices[idx]) {
        return this._ticketServices[idx];
      }
    }
    return this.ticketService;
  }

  /**
   * Add a directional link from a source ticket to a target ticket.
   * Delegates to the ticket service for the source ticket's project.
   *
   * Cross-project linking is intentionally disallowed: both tickets must be
   * in the same project (the source ticket's project service is used for all
   * reads and writes, enforcing project scoping on the client read path).
   *
   * @param {string} sourceDocId - Firestore doc ID of the source ticket
   * @param {string} targetDocId - Firestore doc ID of the target ticket
   * @param {'blocks'|'related'|'follow-up'} type
   */
  async _addLink(sourceDocId, targetDocId, type) {
    const sourceTicket = this._tickets.find(t => t.id === sourceDocId);
    const targetTicket = this._tickets.find(t => t.id === targetDocId);

    // Enforce project scoping — both tickets must belong to the same project
    if (sourceTicket && targetTicket && sourceTicket.projectId !== targetTicket.projectId) {
      throw new Error('Cannot link tickets across different projects');
    }

    const svc = this._getTicketServiceForDoc(sourceDocId);
    await svc.addLink(sourceDocId, targetDocId, type);
    await this.refresh();
  }

  /**
   * Remove an existing link from a source ticket to a target ticket.
   *
   * @param {string} sourceDocId - Firestore doc ID of the source ticket
   * @param {string} targetDocId - Firestore doc ID of the target ticket
   */
  async _removeLink(sourceDocId, targetDocId) {
    const svc = this._getTicketServiceForDoc(sourceDocId);
    await svc.removeLink(sourceDocId, targetDocId);
    await this.refresh();
  }

  // -----------------------------------------------------------------------
  // Real-time
  // -----------------------------------------------------------------------

  /**
   * Returns true if any ticket in `changedTickets` is visible under the
   * current filter/search, or if ticket counts would change (status changed).
   * Used to skip unnecessary re-renders.
   *
   * @param {Array} changedTickets - tickets that were added/modified in this snapshot
   * @param {Array} [removedTickets] - tickets that were removed
   * @returns {boolean}
   */
  _changesAffectView(changedTickets, removedTickets) {
    // Count changes always matter (filter tabs show counts)
    if (removedTickets && removedTickets.length > 0) return true;

    for (const t of changedTickets) {
      // Does this ticket pass the active filter?
      if (this._activeFilter !== 'all' && t.status !== this._activeFilter) {
        // Status may have changed — if the ticket was previously visible it is
        // now gone; if it just became the active status it is now new.  Either
        // way the view needs updating.  We can't tell without the old status
        // here, so conservatively say yes.
        return true;
      }
      // Does it pass the search query?
      if (this._searchQuery.trim()) {
        const q = this._searchQuery.toLowerCase();
        const fields = [
          t.ticketId, t.title, t.description, t.type, t.status,
          statusLabel(t.status), t.userEmail,
        ];
        if (!fields.some(f => f && String(f).toLowerCase().includes(q))) {
          // This ticket doesn't match the search.  But it might have previously
          // matched (before the update), so we still need to re-render to remove it.
          return true;
        }
      }
      return true; // ticket is visible — definitely need to re-render
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Project version listeners
  // -----------------------------------------------------------------------

  /**
   * Subscribe to the project document(s) in Firestore to track liveVersion in real time.
   * Updates _projectVersions map and re-renders the live version indicator on changes.
   */
  _startProjectVersionListeners() {
    // Clean up any existing subscriptions
    for (const unsub of this._projectVersionUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._projectVersionUnsubs = [];

    const projectIds = this.projectIds && this.projectIds.length > 0
      ? this.projectIds
      : (this.projectId ? [this.projectId] : []);

    for (const pid of projectIds) {
      try {
        const ref = this.db.collection('projects').doc(pid);
        const unsub = ref.onSnapshot(
          (snap) => {
            const data = snap.exists ? snap.data() : {};
            this._projectVersions[pid] = data.liveVersion || null;
            this._renderLiveVersion();
            // Update repoBaseUrl from project doc if not set via constructor options.
            // In single-project mode, take the first project's repoBaseUrl.
            // Constructor-supplied value takes precedence.
            if (!this._repoBaseUrlFromOptions && data.repoBaseUrl) {
              this._repoBaseUrl = data.repoBaseUrl;
              // Propagate to existing ticketList if already mounted
              if (this.ticketList) {
                this.ticketList.repoBaseUrl = this._repoBaseUrl;
              }
            }
          },
          (_err) => {
            // Listener error — clear the version for this project
            this._projectVersions[pid] = null;
            this._renderLiveVersion();
          }
        );
        this._projectVersionUnsubs.push(unsub);
      } catch (_e) {
        // Firestore not available for this project — skip
      }
    }
  }

  /**
   * Render the live version indicator element.
   * In single-project mode shows: "Live: v1.2.3"
   * In multi-project mode shows one badge per project that has a liveVersion.
   */
  _renderLiveVersion() {
    if (!this._liveVersionEl) return;
    this._liveVersionEl.innerHTML = '';

    const projectIds = this.projectIds && this.projectIds.length > 0
      ? this.projectIds
      : (this.projectId ? [this.projectId] : []);

    const entries = projectIds
      .map(pid => ({ pid, version: this._projectVersions[pid] }))
      .filter(e => e.version);

    if (entries.length === 0) {
      // Nothing to show — keep element empty (zero height)
      return;
    }

    const isMulti = projectIds.length > 1;

    for (const { pid, version } of entries) {
      const badge = el('span', { className: 'tk-live-version-badge' },
        el('span', { className: 'tk-live-version-label' }, 'Live'),
        isMulti
          ? el('span', { className: 'tk-live-version-project' }, pid + ' ')
          : null,
        el('span', { className: 'tk-live-version-value' }, version),
      );
      this._liveVersionEl.appendChild(badge);
    }
  }

  /**
   * Show a modal to create a new Docket project.
   */
  _showNewProjectModal() {
    const overlay = el('div', { className: 'tk-changelog-overlay ' + this._rootClass() });
    const modal = el('div', { className: 'tk-changelog-modal' });

    const modalHeader = el('div', { className: 'tk-changelog-modal-header' },
      el('h2', { className: 'tk-changelog-modal-title' }, 'New Project'),
      el('button', {
        className: 'tk-btn-close',
        onClick: () => overlay.remove(),
      }, '\u00D7'),
    );

    const errorEl = el('div', { className: 'tk-form-error' });
    errorEl.style.display = 'none';

    const idInput = el('input', {
      className: 'tk-form-input',
      type: 'text',
      placeholder: 'project-id (e.g. my-app)',
    });
    const nameInput = el('input', {
      className: 'tk-form-input',
      type: 'text',
      placeholder: 'Display name (e.g. My App)',
    });
    const prefixInput = el('input', {
      className: 'tk-form-input',
      type: 'text',
      placeholder: 'Ticket prefix (e.g. MA)',
      style: 'text-transform: uppercase;',
    });

    const submitBtn = el('button', {
      className: 'tk-btn tk-btn-primary',
      onClick: async () => {
        const id = idInput.value.trim();
        const name = nameInput.value.trim();
        const prefix = prefixInput.value.trim().toUpperCase();
        errorEl.style.display = 'none';

        if (!id || !name || !prefix) {
          errorEl.textContent = 'All fields are required.';
          errorEl.style.display = 'block';
          return;
        }

        submitBtn.disabled = true;
        submitBtn.classList.add('tk-btn-loading');
        submitBtn.textContent = 'Creating...';
        try {
          await this.projectService.register({ id, name, prefix });
          overlay.remove();
          this.toast.success(`Project "${name}" created.`);
        } catch (err) {
          errorEl.textContent = err.message || 'Failed to create project.';
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.classList.remove('tk-btn-loading');
          submitBtn.textContent = 'Create Project';
        }
      },
    }, 'Create Project');

    const body = el('div', { style: 'padding: 16px; display: flex; flex-direction: column; gap: 12px;' },
      el('div', { className: 'tk-form-group' },
        el('label', {}, 'Project ID'),
        idInput,
      ),
      el('div', { className: 'tk-form-group' },
        el('label', {}, 'Display Name'),
        nameInput,
      ),
      el('div', { className: 'tk-form-group' },
        el('label', {}, 'Ticket Prefix (2-4 uppercase letters)'),
        prefixInput,
      ),
      errorEl,
      el('div', { className: 'tk-form-actions' },
        submitBtn,
      ),
    );

    modal.appendChild(modalHeader);
    modal.appendChild(body);
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    idInput.focus();
  }

  /**
   * Show a changelog modal listing done/verified tickets grouped by deployedVersion.
   * Tickets without a deployedVersion appear under "Unversioned".
   */
  _showChangelog() {
    // Gather done and verified tickets
    const changelogTickets = this._tickets.filter(
      t => t.status === 'done' || t.status === 'verified'
    );

    // Group by deployedVersion (fall back to scanning statusHistory)
    const groups = new Map(); // version -> tickets[]
    for (const t of changelogTickets) {
      const version = t.deployedVersion || this._getTicketVersion(t) || 'Unversioned';
      if (!groups.has(version)) groups.set(version, []);
      groups.get(version).push(t);
    }

    // Sort versions: semver-ish descending, "Unversioned" last
    const sortedVersions = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'Unversioned') return 1;
      if (b === 'Unversioned') return -1;
      // Compare semver parts numerically
      const partsA = a.replace(/^v/, '').split('.').map(Number);
      const partsB = b.replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsB[i] || 0) - (partsA[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

    // Build modal content
    const body = el('div', { className: 'tk-changelog-modal-body' });

    if (changelogTickets.length === 0) {
      body.appendChild(el('p', { className: 'tk-changelog-empty' }, 'No completed tickets yet.'));
    } else {
      for (const version of sortedVersions) {
        const tickets = groups.get(version);
        const isUnversioned = version === 'Unversioned';
        const heading = el('h3', { className: 'tk-changelog-version-heading' });
        if (!isUnversioned) {
          heading.appendChild(el('span', { className: 'tk-changelog-version-tag' }, version));
        }
        heading.appendChild(document.createTextNode(isUnversioned ? 'Unversioned' : ''));

        const group = el('div', { className: 'tk-changelog-version-group' }, heading);

        for (const t of tickets) {
          const statusClass = t.status === 'verified'
            ? 'tk-changelog-ticket-status tk-changelog-ticket-status-verified'
            : 'tk-changelog-ticket-status tk-changelog-ticket-status-done';
          // Find when this ticket was last marked done or verified
          const completedAt = this._getTicketCompletedAt(t);
          const row = el('div', { className: 'tk-changelog-ticket-row' },
            el('span', { className: 'tk-changelog-ticket-id' }, t.ticketId || ''),
            el('span', { className: 'tk-changelog-ticket-title' }, t.title || '(no title)'),
            el('span', { className: statusClass }, t.status),
            completedAt
              ? el('span', { className: 'tk-changelog-ticket-date' }, formatDateCompact(completedAt))
              : null,
          );
          group.appendChild(row);
        }

        body.appendChild(group);
      }
    }

    // Build overlay + modal
    const overlay = el('div', { className: 'tk-changelog-overlay ' + this._rootClass() });
    const modal = el('div', { className: 'tk-changelog-modal' });

    const modalHeader = el('div', { className: 'tk-changelog-modal-header' },
      el('h2', { className: 'tk-changelog-modal-title' }, '\uD83D\uDCCB Changelog'),
      el('button', {
        className: 'tk-btn-close',
        onClick: () => overlay.remove(),
      }, '\u00D7'),
    );

    modal.appendChild(modalHeader);
    modal.appendChild(body);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
  }

  /**
   * Show token spend breakdown modal.
   * Displays per-ticket cost/duration breakdown for done tickets, with a
   * selectable time range filter (7d, 30d, 90d, all time).
   */
  _showTokenSpend() {
    // Build the overlay/modal shell
    const overlay = el('div', { className: 'tk-changelog-overlay ' + this._rootClass() });
    const modal = el('div', { className: 'tk-changelog-modal tk-token-spend-modal' });

    const modalHeader = el('div', { className: 'tk-changelog-modal-header' },
      el('h2', { className: 'tk-changelog-modal-title' }, '\uD83D\uDCB0 Token Spend'),
      el('button', {
        className: 'tk-btn-close',
        onClick: () => overlay.remove(),
      }, '\u00D7'),
    );

    // ── Claude plan usage section ────────────────────────────────────
    // Reads planUsage from orchestrator/config doc (written by usage-monitor).
    const planSection = el('div', { className: 'tk-plan-usage-section' });
    const planContent = el('div', { className: 'tk-plan-usage-content' });
    planSection.appendChild(el('div', { className: 'tk-plan-usage-title' }, '📊 Claude Plan Limits'));
    planSection.appendChild(planContent);

    const renderPlanUsage = (planUsage) => {
      planContent.innerHTML = '';
      if (!planUsage) {
        planContent.appendChild(el('p', { className: 'tk-plan-usage-unavailable' },
          'Plan usage data unavailable. The orchestrator must be running with a valid OAuth token to track this. Run ',
          el('code', {}, 'claude auth login'),
          ' on the machine running the orchestrator.'
        ));
        return;
      }

      const { limits, checkedAt } = planUsage;

      if (!Array.isArray(limits) || limits.length === 0) {
        planContent.appendChild(el('p', { className: 'tk-plan-usage-unavailable' },
          'No active plan limits found.'
        ));
        return;
      }

      const barsEl = el('div', { className: 'tk-plan-usage-bars' });
      for (const limit of limits) {
        const pct = Math.min(100, Math.max(0, Math.round(limit.utilization || 0)));
        const colorClass = pct >= 90 ? 'tk-plan-bar-danger' : pct >= 75 ? 'tk-plan-bar-warn' : 'tk-plan-bar-ok';
        let resetLabel = '';
        if (limit.resets_at) {
          try {
            const resetDate = new Date(limit.resets_at);
            const diffMs = resetDate.getTime() - Date.now();
            if (diffMs > 0) {
              const diffH = Math.round(diffMs / 3600000);
              const diffM = Math.round(diffMs / 60000);
              resetLabel = diffH >= 2 ? ` — resets in ${diffH}h` : ` — resets in ${diffM}m`;
            } else {
              resetLabel = ' — resetting…';
            }
          } catch { /* ignore */ }
        }
        barsEl.appendChild(el('div', { className: 'tk-plan-bar-row' },
          el('div', { className: 'tk-plan-bar-label' },
            el('span', { className: 'tk-plan-bar-name' }, limit.name),
            el('span', { className: 'tk-plan-bar-pct' + (pct >= 90 ? ' tk-plan-pct-danger' : '') }, `${pct}%${resetLabel}`),
          ),
          el('div', { className: 'tk-plan-bar-track' },
            el('div', {
              className: `tk-plan-bar-fill ${colorClass}`,
              style: { width: pct + '%' },
            }),
          ),
        ));
      }
      planContent.appendChild(barsEl);

      if (checkedAt) {
        try {
          const checkedDate = new Date(checkedAt);
          const diffMs = Date.now() - checkedDate.getTime();
          const diffM = Math.round(diffMs / 60000);
          const timeLabel = diffM < 1 ? 'just now' : diffM === 1 ? '1 min ago' : `${diffM} min ago`;
          planContent.appendChild(el('p', { className: 'tk-plan-usage-checked-at' }, `Last checked ${timeLabel}`));
        } catch { /* ignore */ }
      }
    };

    // Fetch planUsage from Firestore orchestrator/config
    renderPlanUsage(null); // show loading/unavailable state initially
    this.db.collection('orchestrator').doc('config').get().then(snap => {
      if (!snap.exists) return;
      const data = snap.data();
      renderPlanUsage(data.planUsage || null);
    }).catch(() => {
      // Firestore unavailable — leave unavailable state
    });

    // Time range selector
    const ranges = [
      { label: '7 days', days: 7 },
      { label: '30 days', days: 30 },
      { label: '90 days', days: 90 },
      { label: 'All time', days: null },
    ];
    let selectedDays = 30; // default

    const body = el('div', { className: 'tk-changelog-modal-body' });

    const renderBody = () => {
      body.innerHTML = '';

      // Filter tickets: only those with costUsd > 0 (completed by an agent)
      const now = Date.now();
      const cutoff = selectedDays != null ? now - selectedDays * 24 * 60 * 60 * 1000 : null;

      const eligible = this._tickets.filter(t => {
        if (!t.costUsd || t.costUsd <= 0) return false;
        if (cutoff != null) {
          // Use createdAt or the most recent statusHistory entry timestamp
          let ts = null;
          if (t.createdAt) {
            const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
            ts = d.getTime();
          }
          if (ts == null) return true; // include if no date info
          if (ts < cutoff) return false;
        }
        return true;
      });

      // Sort by costUsd descending
      const sorted = [...eligible].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));

      // Summary totals
      const totalCost = sorted.reduce((sum, t) => sum + (t.costUsd || 0), 0);
      const totalDuration = sorted.reduce((sum, t) => sum + (t.durationMs || 0), 0);
      const ticketCount = sorted.length;

      if (ticketCount === 0) {
        body.appendChild(el('p', { className: 'tk-changelog-empty' },
          selectedDays != null
            ? `No agent spend recorded in the last ${selectedDays} days.`
            : 'No agent spend recorded yet.'
        ));
        return;
      }

      // Summary row
      const summaryEl = el('div', { className: 'tk-token-spend-summary' },
        el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Total spend'),
          el('span', { className: 'tk-token-spend-summary-value tk-token-spend-cost' },
            formatCost(totalCost) || '$0.00'
          ),
        ),
        el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Tickets'),
          el('span', { className: 'tk-token-spend-summary-value' }, String(ticketCount)),
        ),
        totalDuration > 0 ? el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Total runtime'),
          el('span', { className: 'tk-token-spend-summary-value' }, formatDuration(totalDuration) || '—'),
        ) : null,
        totalCost > 0 && ticketCount > 1 ? el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Avg per ticket'),
          el('span', { className: 'tk-token-spend-summary-value' }, formatCost(totalCost / ticketCount) || '—'),
        ) : null,
      );
      body.appendChild(summaryEl);

      // --- Time-series chart section ---
      // Group tickets by calendar day (using createdAt timestamp)
      // Build a sorted list of days with daily and cumulative spend
      const dayMap = new Map(); // 'YYYY-MM-DD' → { cost, count }
      for (const t of eligible) {
        let dateKey = null;
        if (t.createdAt) {
          const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
          if (!isNaN(d)) {
            // Use local date string as key
            dateKey = d.toISOString().slice(0, 10);
          }
        }
        if (!dateKey) continue; // skip tickets without a timestamp
        const existing = dayMap.get(dateKey) || { cost: 0, count: 0 };
        existing.cost += t.costUsd || 0;
        existing.count += 1;
        dayMap.set(dateKey, existing);
      }

      // Only render charts when we have at least 2 data points with dates
      if (dayMap.size >= 2) {
        const days = [...dayMap.keys()].sort(); // chronological order
        const dayCosts = days.map(d => dayMap.get(d).cost);
        const maxDay = Math.max(...dayCosts);

        // Compute cumulative values
        const cumCosts = [];
        let running = 0;
        for (const c of dayCosts) { running += c; cumCosts.push(running); }
        const maxCum = running;

        // Chart dimensions
        const chartW = 660;
        const chartH = 120;
        const padL = 52; // left padding for y-axis labels
        const padR = 12;
        const padT = 10;
        const padB = 28; // bottom for x-axis labels
        const innerW = chartW - padL - padR;
        const innerH = chartH - padT - padB;
        const n = days.length;
        const barGap = 0.25; // fraction of slot for gap
        const slotW = innerW / n;
        const barW = Math.max(2, slotW * (1 - barGap));

        // SVG namespace helper
        const svgNS = 'http://www.w3.org/2000/svg';
        const svgEl = (tag, attrs, ...kids) => {
          const node = document.createElementNS(svgNS, tag);
          for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
          for (const k of kids) { if (k) node.appendChild(k); }
          return node;
        };
        const svgText = (content) => document.createTextNode(content);

        // Helper: format a cost for axis label
        const axisLabel = (v) => v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`;

        // ---- Bar chart: daily spend ----
        const barSvg = svgEl('svg', {
          width: '100%', viewBox: `0 0 ${chartW} ${chartH}`,
          class: 'tk-ts-chart',
          style: 'display:block;overflow:visible;',
        });

        // Grid lines + y-axis labels (3 lines)
        for (let i = 0; i <= 2; i++) {
          const frac = i / 2;
          const y = padT + innerH * (1 - frac);
          const val = maxDay * frac;
          barSvg.appendChild(svgEl('line', {
            x1: padL, y1: y, x2: chartW - padR, y2: y,
            class: frac === 0 ? 'tk-ts-axis' : 'tk-ts-grid',
          }));
          barSvg.appendChild(svgEl('text', {
            x: padL - 4, y: y + 4, class: 'tk-ts-label', 'text-anchor': 'end',
          }, svgText(axisLabel(val))));
        }

        // Bars
        for (let i = 0; i < n; i++) {
          const x = padL + i * slotW + (slotW - barW) / 2;
          const barH2 = maxDay > 0 ? (dayCosts[i] / maxDay) * innerH : 0;
          const y = padT + innerH - barH2;
          const bar = svgEl('rect', {
            x, y, width: barW, height: barH2,
            class: 'tk-ts-bar',
            rx: '1',
          });
          // Tooltip via title
          const titleEl = svgEl('title', {});
          titleEl.appendChild(svgText(`${days[i]}: ${axisLabel(dayCosts[i])}`));
          bar.appendChild(titleEl);
          barSvg.appendChild(bar);

          // X-axis date label — only show first, middle, last to avoid clutter
          if (i === 0 || i === Math.floor(n / 2) || i === n - 1) {
            const lx = padL + i * slotW + slotW / 2;
            // Format as M/D
            const [, mm, dd] = days[i].split('-');
            barSvg.appendChild(svgEl('text', {
              x: lx, y: chartH - 6, class: 'tk-ts-label', 'text-anchor': 'middle',
            }, svgText(`${parseInt(mm)}/${parseInt(dd)}`)));
          }
        }

        // ---- Line chart: cumulative spend ----
        const lineSvg = svgEl('svg', {
          width: '100%', viewBox: `0 0 ${chartW} ${chartH}`,
          class: 'tk-ts-chart',
          style: 'display:block;overflow:visible;',
        });

        // Grid lines + y-axis labels
        for (let i = 0; i <= 2; i++) {
          const frac = i / 2;
          const y = padT + innerH * (1 - frac);
          const val = maxCum * frac;
          lineSvg.appendChild(svgEl('line', {
            x1: padL, y1: y, x2: chartW - padR, y2: y,
            class: frac === 0 ? 'tk-ts-axis' : 'tk-ts-grid',
          }));
          lineSvg.appendChild(svgEl('text', {
            x: padL - 4, y: y + 4, class: 'tk-ts-label', 'text-anchor': 'end',
          }, svgText(axisLabel(val))));
        }

        // Build polyline points (center of each bar slot)
        const points = cumCosts.map((c, i) => {
          const px = padL + i * slotW + slotW / 2;
          const py = padT + innerH - (maxCum > 0 ? (c / maxCum) * innerH : 0);
          return `${px},${py}`;
        }).join(' ');

        // Filled area under line
        const firstPx = padL + 0 * slotW + slotW / 2;
        const lastPx = padL + (n - 1) * slotW + slotW / 2;
        const baseY = padT + innerH;
        const areaPoints = `${firstPx},${baseY} ${points} ${lastPx},${baseY}`;
        lineSvg.appendChild(svgEl('polygon', { points: areaPoints, class: 'tk-ts-area' }));
        lineSvg.appendChild(svgEl('polyline', { points, class: 'tk-ts-line' }));

        // Dots + x-axis labels
        for (let i = 0; i < n; i++) {
          const px = padL + i * slotW + slotW / 2;
          const py = padT + innerH - (maxCum > 0 ? (cumCosts[i] / maxCum) * innerH : 0);
          const dot = svgEl('circle', { cx: px, cy: py, r: '3', class: 'tk-ts-dot' });
          const titleEl = svgEl('title', {});
          titleEl.appendChild(svgText(`${days[i]}: ${axisLabel(cumCosts[i])} cumulative`));
          dot.appendChild(titleEl);
          lineSvg.appendChild(dot);

          if (i === 0 || i === Math.floor(n / 2) || i === n - 1) {
            const [, mm, dd] = days[i].split('-');
            lineSvg.appendChild(svgEl('text', {
              x: px, y: chartH - 6, class: 'tk-ts-label', 'text-anchor': 'middle',
            }, svgText(`${parseInt(mm)}/${parseInt(dd)}`)));
          }
        }

        // ---- Scatter chart: spend per ticket over time ----
        // Build sorted list of individual tickets with dates
        const ticketPoints = [];
        for (const t of eligible) {
          if (!t.createdAt) continue;
          const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
          if (isNaN(d)) continue;
          ticketPoints.push({
            dateKey: d.toISOString().slice(0, 10),
            ts: d.getTime(),
            costUsd: t.costUsd || 0,
            ticketId: t.ticketId || '',
            title: t.title || '(no title)',
          });
        }
        ticketPoints.sort((a, b) => a.ts - b.ts);

        const scatterSvg = svgEl('svg', {
          width: '100%', viewBox: `0 0 ${chartW} ${chartH}`,
          class: 'tk-ts-chart',
          style: 'display:block;overflow:visible;',
        });

        if (ticketPoints.length >= 1) {
          const maxTicket = Math.max(...ticketPoints.map(p => p.costUsd));
          const minTs = ticketPoints[0].ts;
          const maxTs = ticketPoints[ticketPoints.length - 1].ts;
          const tsRange = maxTs - minTs || 1;

          // Grid lines + y-axis labels (3 lines)
          for (let i = 0; i <= 2; i++) {
            const frac = i / 2;
            const y = padT + innerH * (1 - frac);
            const val = maxTicket * frac;
            scatterSvg.appendChild(svgEl('line', {
              x1: padL, y1: y, x2: chartW - padR, y2: y,
              class: frac === 0 ? 'tk-ts-axis' : 'tk-ts-grid',
            }));
            scatterSvg.appendChild(svgEl('text', {
              x: padL - 4, y: y + 4, class: 'tk-ts-label', 'text-anchor': 'end',
            }, svgText(axisLabel(val))));
          }

          // Lollipop: vertical stem + dot per ticket
          for (const p of ticketPoints) {
            const px = ticketPoints.length === 1
              ? padL + innerW / 2
              : padL + ((p.ts - minTs) / tsRange) * innerW;
            const py = padT + innerH - (maxTicket > 0 ? (p.costUsd / maxTicket) * innerH : 0);
            const baseY = padT + innerH;

            // Stem
            const stem = svgEl('line', {
              x1: px, y1: py, x2: px, y2: baseY,
              class: 'tk-ts-scatter-stem',
            });
            const stemTitle = svgEl('title', {});
            stemTitle.appendChild(svgText(`${p.ticketId}: ${p.title} — ${axisLabel(p.costUsd)} (${p.dateKey})`));
            stem.appendChild(stemTitle);
            scatterSvg.appendChild(stem);

            // Dot
            const dot = svgEl('circle', { cx: px, cy: py, r: '4', class: 'tk-ts-scatter-dot' });
            const dotTitle = svgEl('title', {});
            dotTitle.appendChild(svgText(`${p.ticketId}: ${p.title} — ${axisLabel(p.costUsd)} (${p.dateKey})`));
            dot.appendChild(dotTitle);
            scatterSvg.appendChild(dot);
          }

          // X-axis date labels: first, middle, last
          const labelIdxs = ticketPoints.length === 1 ? [0] : [0, Math.floor(ticketPoints.length / 2), ticketPoints.length - 1];
          for (const i of [...new Set(labelIdxs)]) {
            const p = ticketPoints[i];
            const px = ticketPoints.length === 1
              ? padL + innerW / 2
              : padL + ((p.ts - minTs) / tsRange) * innerW;
            const [, mm, dd] = p.dateKey.split('-');
            scatterSvg.appendChild(svgEl('text', {
              x: px, y: chartH - 6, class: 'tk-ts-label', 'text-anchor': 'middle',
            }, svgText(`${parseInt(mm)}/${parseInt(dd)}`)));
          }
        }

        const chartsSection = el('div', { className: 'tk-ts-charts-section' },
          el('div', { className: 'tk-ts-chart-block' },
            el('div', { className: 'tk-ts-chart-title' }, 'Daily spend'),
            barSvg,
          ),
          el('div', { className: 'tk-ts-chart-block' },
            el('div', { className: 'tk-ts-chart-title' }, 'Spend per ticket'),
            scatterSvg,
          ),
          el('div', { className: 'tk-ts-chart-block' },
            el('div', { className: 'tk-ts-chart-title' }, 'Cumulative spend'),
            lineSvg,
          ),
        );
        body.appendChild(chartsSection);
      }

      // Per-ticket breakdown table
      const tableHeader = el('div', { className: 'tk-token-spend-table-header' },
        el('span', { className: 'tk-token-spend-col-id' }, 'Ticket'),
        el('span', { className: 'tk-token-spend-col-title' }, 'Title'),
        el('span', { className: 'tk-token-spend-col-cost' }, 'Cost'),
        el('span', { className: 'tk-token-spend-col-duration' }, 'Duration'),
        el('span', { className: 'tk-token-spend-col-status' }, 'Status'),
      );
      body.appendChild(tableHeader);

      for (const t of sorted) {
        const costStr = formatCost(t.costUsd) || '—';
        const durationStr = formatDuration(t.durationMs) || '—';
        const barPct = totalCost > 0 ? Math.round((t.costUsd / totalCost) * 100) : 0;

        const row = el('div', { className: 'tk-token-spend-row' },
          el('span', { className: 'tk-token-spend-col-id' }, t.ticketId || ''),
          el('span', { className: 'tk-token-spend-col-title' }, t.title || '(no title)'),
          el('span', { className: 'tk-token-spend-col-cost' },
            el('span', { className: 'tk-token-spend-cost-label' }, costStr),
            barPct > 0 ? el('span', { className: 'tk-token-spend-bar-wrap' },
              el('span', {
                className: 'tk-token-spend-bar',
                style: { width: barPct + '%' },
                title: barPct + '% of total',
              }),
            ) : null,
          ),
          el('span', { className: 'tk-token-spend-col-duration' }, durationStr),
          el('span', {
            className: `tk-token-spend-col-status tk-token-spend-status-${t.status}`,
          }, t.status || ''),
        );
        body.appendChild(row);
      }
    };

    // Time range pill buttons
    const rangeRow = el('div', { className: 'tk-token-spend-range-row' },
      el('span', { className: 'tk-token-spend-range-label' }, 'Time range:'),
      ...ranges.map(r => {
        const btn = el('button', {
          className: 'tk-token-spend-range-btn' + (r.days === selectedDays ? ' tk-active' : ''),
          type: 'button',
          onClick: () => {
            selectedDays = r.days;
            // Update active state
            rangeRow.querySelectorAll('.tk-token-spend-range-btn').forEach(b => b.classList.remove('tk-active'));
            btn.classList.add('tk-active');
            renderBody();
          },
        }, r.label);
        return btn;
      }),
    );

    modal.appendChild(modalHeader);
    modal.appendChild(planSection);
    modal.appendChild(rangeRow);
    modal.appendChild(body);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    renderBody();
    document.body.appendChild(overlay);
  }

  /**
   * Return the timestamp when a ticket last entered done or verified status.
   * Scans statusHistory from newest to oldest. Falls back to updatedAt.
   */
  _getTicketCompletedAt(ticket) {
    const history = ticket.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if ((entry.to === 'done' || entry.to === 'verified') && entry.at) {
        return entry.at;
      }
    }
    return ticket.updatedAt || null;
  }

  /**
   * Extract version string from a ticket's statusHistory notes (fallback).
   */
  _getTicketVersion(ticket) {
    const history = ticket.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      const note = history[i].note || '';
      const match = note.match(/v\d+\.\d+(?:\.\d+)?/);
      if (match) return match[0];
    }
    return null;
  }

  /**
   * Subscribe to the clusters subcollection for each project.
   * Updates _clusters map and re-renders ticket list on changes so cluster
   * tags stay in sync (e.g. ticketCount increments appear live).
   */
  _startClusterListeners() {
    // Clean up existing subscriptions
    for (const unsub of this._clusterUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._clusterUnsubs = [];

    const projectIds = this.projectIds && this.projectIds.length > 0
      ? this.projectIds
      : (this.projectId ? [this.projectId] : []);

    for (const pid of projectIds) {
      try {
        const ref = this.db.collection('projects').doc(pid).collection('clusters');
        const unsub = ref.onSnapshot(
          (snap) => {
            // Re-build cluster map from scratch on each update for simplicity
            // (cluster collection is expected to be small — max 50 per project)
            for (const doc of snap.docs) {
              const data = doc.data();
              this._clusters.set(doc.id, { id: doc.id, ...data });
            }
            // Remove deleted clusters
            if (snap.docChanges) {
              for (const change of snap.docChanges()) {
                if (change.type === 'removed') {
                  this._clusters.delete(change.doc.id);
                }
              }
            }
            // Propagate updated clusters to ticketList so tags re-render
            if (this.ticketList) {
              this.ticketList.clusters = this._clusters;
              this._renderList();
            }
          },
          (_err) => {
            // Listener error — silently ignore (clusters are non-critical)
          }
        );
        this._clusterUnsubs.push(unsub);
      } catch (_e) {
        // Firestore not available — skip
      }
    }
  }

  _startRealtimeListener() {
    try {
      if (this._ticketServices && this._ticketServices.length > 0) {
        // Multi-project mode: one listener per project.
        // ticketsByProject stores the latest snapshot for each project index.
        const ticketsByProject = new Array(this._ticketServices.length).fill(null).map(() => []);

        // Pending updates map: projectIndex -> {tickets, changed, removed}
        // Batched together by the debounce timer so rapid-fire updates from
        // multiple projects collapse into a single merge + render cycle.
        let pendingByProject = {};
        let debounceTimer = null;

        const flush = () => {
          debounceTimer = null;
          const pending = pendingByProject;
          pendingByProject = {};

          // Apply all pending snapshots to ticketsByProject
          let anyChanged = false;
          for (const [idxStr, update] of Object.entries(pending)) {
            const i = Number(idxStr);
            ticketsByProject[i] = update.tickets;
            if (this._changesAffectView(update.changed, update.removed)) {
              anyChanged = true;
            }
          }

          if (!anyChanged) return; // nothing visible changed — skip re-render

          // Merge and sort across all projects
          const merged = [].concat(...ticketsByProject);
          merged.sort((a, b) => (b.ticketNumber || 0) - (a.ticketNumber || 0));
          this._tickets = merged;
          this._applyFilters();
          this._renderList();
          this._updateCounts();
        };

        const unsubscribers = this._ticketServices.map((svc, i) =>
          svc.onTicketsChanged((snapshot) => {
            const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Determine which tickets actually changed in this snapshot
            const changed = [];
            const removed = [];
            if (snapshot.docChanges) {
              for (const change of snapshot.docChanges()) {
                if (change.type === 'removed') {
                  removed.push({ id: change.doc.id, ...change.doc.data() });
                } else {
                  changed.push({ id: change.doc.id, ...change.doc.data() });
                }
              }
            } else {
              // Fallback if docChanges not available — treat all as changed
              changed.push(...tickets);
            }

            // Merge into pending (later update for same project index wins)
            if (pendingByProject[i]) {
              pendingByProject[i].tickets = tickets;
              pendingByProject[i].changed.push(...changed);
              pendingByProject[i].removed.push(...removed);
            } else {
              pendingByProject[i] = { tickets, changed, removed };
            }

            // Debounce: wait one animation frame to batch updates from other projects
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flush, 16);
          })
        );

        this._unsubscribe = () => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          unsubscribers.forEach(u => u());
        };
      } else {
        // Single-project mode
        let debounceTimer = null;
        let pendingSnapshot = null;

        const flush = () => {
          debounceTimer = null;
          const snapshot = pendingSnapshot;
          pendingSnapshot = null;
          if (!snapshot) return;

          const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

          // Determine changed tickets for skip-render check
          let changed = tickets;
          let removed = [];
          if (snapshot.docChanges) {
            changed = [];
            for (const change of snapshot.docChanges()) {
              if (change.type === 'removed') {
                removed.push({ id: change.doc.id, ...change.doc.data() });
              } else {
                changed.push({ id: change.doc.id, ...change.doc.data() });
              }
            }
          }

          if (!this._changesAffectView(changed, removed)) return;

          // Snapshot is pre-sorted by ticketNumber desc (orderBy in onTicketsChanged)
          this._tickets = tickets;
          this._applyFilters();
          this._renderList();
          this._updateCounts();
        };

        this._unsubscribe = this.ticketService.onTicketsChanged((snapshot) => {
          pendingSnapshot = snapshot;
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(flush, 16);
        });

        // Wrap the plain unsubscribe to also cancel any pending timer
        const origUnsub = this._unsubscribe;
        this._unsubscribe = () => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          origUnsub();
        };
      }
    } catch (_e) {
      // Real-time not available; fall back to manual refresh
    }
  }

  // -----------------------------------------------------------------------
  // Theme
  // -----------------------------------------------------------------------

  _rootClass() {
    const dark = this._isDark();
    return 'tk-root' + (dark ? ' tk-theme-dark' : '');
  }

  _isDark() {
    if (this.theme === 'dark') return true;
    if (this.theme === 'light') return false;
    // auto
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  _applyTheme() {
    if (!this._root) return;
    this._root.className = this._rootClass();
  }

  /**
   * Programmatically change the panel's theme.
   * @param {'light'|'dark'|'auto'} theme
   */
  setTheme(theme) {
    this.theme = theme;
    this._applyTheme();
  }

  // -----------------------------------------------------------------------
  // Server timestamp detection
  // -----------------------------------------------------------------------

  _detectServerTimestamp() {
    // Try firebase global (web SDK v8 / compat)
    if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue) {
      return () => firebase.firestore.FieldValue.serverTimestamp();
    }
    // Fallback: use client date (not ideal but functional)
    return () => new Date();
  }

  _detectArrayUnion() {
    if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue) {
      return (...elements) => firebase.firestore.FieldValue.arrayUnion(...elements);
    }
    return null;
  }

  _detectArrayRemove() {
    if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue) {
      return (...elements) => firebase.firestore.FieldValue.arrayRemove(...elements);
    }
    return null;
  }
}
