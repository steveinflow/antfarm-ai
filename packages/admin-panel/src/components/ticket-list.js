// @docket/admin-panel — TicketList: ordered list of TicketItems with incremental patch rendering

import { el } from '../el.js';
import { TicketItem } from './ticket-item/index.js';

export class TicketList {
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
