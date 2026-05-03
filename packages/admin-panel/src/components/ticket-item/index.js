// @docket/admin-panel — TicketItem: per-ticket card with header, detail, evidence, actions
//
// The class definition holds the constructor + lifecycle (render, _toggle, version/status helpers).
// Render-region methods are split into prototype mixins (one file per UI region) and applied
// at the bottom of this file via Object.assign(TicketItem.prototype, ...).

import { statusLabel } from '@docket/core';
import { el } from '../../el.js';
import { formatDate, formatDateCompact } from '../../format.js';
import { headerMixin } from './header.js';
import { bodyMixin } from './body.js';
import { activityMixin } from './activity.js';
import { actionsMixin } from './actions.js';

export class TicketItem {
  constructor({ ticket, onTransition, onAnswer, onRekick, onDelete, onReject, onSnooze, onFeedback, onAddNote, onExclude, onMarkCritical, currentUserFeedback, isAdmin, toast, initialExpanded, onExpandChange, repoBaseUrl, allTickets, clusters, onClusterFilter, onAddLink, onRemoveLink }) {
    this.ticket = ticket;
    this.onTransition = onTransition;
    this.onAnswer = onAnswer;
    this.onRekick = onRekick;
    this.onDelete = onDelete;
    this.onReject = onReject || null; // async ({ ticketId, ticketTitle, reason, freeText }) => void
    this.onSnooze = onSnooze || null; // async (docId, snoozedUntilDate) => void
    // onFeedback: async (docId, rating) => void — called when user rates an advisor ticket
    this.onFeedback = onFeedback || null;
    // onAddNote: async (docId, note) => void — called when user adds an implementation note
    this.onAddNote = onAddNote || null;
    // onExclude: async ({ personaId, pattern }) => void — called when user excludes a path/URL (DK-128)
    this.onExclude = onExclude || null;
    // onMarkCritical: async (docId) => void — marks ticket as critical to spawn worker immediately
    this.onMarkCritical = onMarkCritical || null;
    // currentUserFeedback: "relevant" | "noise" | null — pre-loaded rating for this ticket
    this.currentUserFeedback = currentUserFeedback || null;
    this.isAdmin = isAdmin || (() => false);
    this.toast = toast;
    this.expanded = initialExpanded || false;
    this.onExpandChange = onExpandChange || null;
    // repoBaseUrl is optional — used to link file refs to source code
    this.repoBaseUrl = repoBaseUrl || null;
    // allTickets is used to resolve related ticket display (id -> { ticketId, title, status })
    this.allTickets = allTickets || [];
    // clusters: Map<clusterId, { id, label, ticketCount }> for rendering cluster tags
    this.clusters = clusters || new Map();
    // onClusterFilter: (clusterId) => void — called when user clicks a cluster tag
    this.onClusterFilter = onClusterFilter || null;
    // onAddLink: async (sourceDocId, targetDocId, type) => void — link creation
    this.onAddLink = onAddLink || null;
    // onRemoveLink: async (sourceDocId, targetDocId) => void — link removal
    this.onRemoveLink = onRemoveLink || null;
    this.el = null;
    // Persistent input elements — reused across re-renders to preserve focus and typed text
    this._commentInput = null;
    this._answerTextarea = null;
    this._noteInput = null;
    this._lastStatusForInputs = null;
    // Rejection popover state
    this._rejectionPopover = null;
    this._rejectionUndoTimer = null;
    // Snooze popover state
    this._snoozePopover = null;
    this._snoozeUndoTimer = null;
    // Link proposals popover state
    this._linkPopover = null;
    // Evidence section collapse state — collapsed by default
    this._evidenceExpanded = false;
    // Links section collapse state — collapsed by default
    this._linksExpanded = false;
    // Convergence section collapse state — collapsed by default
    this._convergenceExpanded = false;
    // Consensus section collapse state — collapsed by default (DK-126)
    this._consensusExpanded = false;
  }

  render() {
    const t = this.ticket;

    // If the ticket's status has changed since the last render, any cached
    // input elements are no longer valid for this status — reset them so fresh
    // elements are created for the new state.
    if (this._lastStatusForInputs !== t.status) {
      this._commentInput = null;
      this._answerTextarea = null;
      this._noteInput = null;
      this._lastStatusForInputs = t.status;
    }

    const statusCls = `tk-ticket-status tk-ticket-status-${t.status}`;
    const typeCls = `tk-ticket-type tk-ticket-type-${t.type}`;

    // Header
    const version = this._getVersion(t);
    // Evidence type badge — shown on proposed tickets to help users prioritize triage
    const evidenceBadge = t.status === 'proposed' ? this._renderEvidenceBadge(t) : null;
    // Snoozed badge — shown when ticket is currently snoozed (proposed + snoozedUntil in future)
    const snoozedBadge = this._isSnoozed(t)
      ? el('span', { className: 'tk-snoozed-badge', 'aria-label': `Snoozed until ${formatDate(t.snoozedUntil)}` }, '⏰ Snoozed')
      : null;
    // Date of last status change — prefer the most recent statusHistory entry matching
    // the current status, then fall back to updatedAt or createdAt.
    const statusAt = this._getStatusAt(t);
    const statusAtEl = statusAt
      ? el('span', { className: 'tk-ticket-status-date' }, formatDateCompact(statusAt))
      : null;

    // Links badge — shows relationship summary on the card header
    const linksBadge = this._renderLinksBadge(t);
    // Critical badge — shown when ticket has critical flag set
    const criticalBadge = t.critical
      ? el('span', { className: 'tk-critical-badge', title: 'Critical — spawns worker immediately, above max cap' }, '⚡ Critical')
      : null;
    // Convergence badge — shown when 2+ personas independently flagged the same area
    const convergenceBadge = this._renderConvergenceBadge(t);
    // DK-126: Consensus badge — shown on Product-generated tickets with consensusMetadata
    const consensusBadge = this._renderConsensusBadge(t);

    const header = el('div', { className: 'tk-ticket-header', onClick: () => this._toggle() },
      el('span', { className: 'tk-ticket-id' }, t.ticketId || ''),
      el('span', { className: typeCls }, t.type || ''),
      el('span', { className: statusCls }, statusLabel(t.status)),
      version ? el('span', { className: 'tk-ticket-version-badge' }, version) : null,
      snoozedBadge,
      evidenceBadge,
      criticalBadge,
      linksBadge,
      convergenceBadge,
      consensusBadge,
      statusAtEl,
    );

    // Title
    const titleEl = el('div', { className: 'tk-ticket-title' }, t.title || '');

    // Cluster tags — shown on proposed/open tickets that have been assigned to clusters
    const clusterTagsEl = this._renderClusterTags(t);

    // Quick actions — always visible (no expand required), shown on proposed tickets
    const quickActions = t.status === 'proposed' ? this._renderQuickActions() : null;

    // Detail
    const detail = this._renderDetail();

    this.el = el('div', { className: 'tk-ticket-item' }, header, titleEl, clusterTagsEl, quickActions, detail);
    // Restore expanded state from a previous render
    if (this.expanded) {
      this.el.classList.add('tk-expanded');
    }
    return this.el;
  }

  _getVersion(ticket) {
    // Prefer the deployedVersion field set directly by the merge/deploy pipeline
    if (ticket.deployedVersion) return ticket.deployedVersion;
    // Fall back to scanning status history notes for version strings
    const history = ticket.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      const note = history[i].note || '';
      const match = note.match(/v\d+\.\d+(?:\.\d+)?/);
      if (match) return match[0];
    }
    return null;
  }

  /**
   * Return the timestamp when this ticket last entered its current status.
   * Scans statusHistory from newest to oldest for an entry whose `to` matches
   * the current status. Falls back to updatedAt, then createdAt.
   */
  _getStatusAt(ticket) {
    const history = ticket.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].to === ticket.status && history[i].at) {
        return history[i].at;
      }
    }
    return ticket.updatedAt || ticket.createdAt || null;
  }

  _toggle() {
    this.expanded = !this.expanded;
    if (this.expanded) {
      this.el.classList.add('tk-expanded');
    } else {
      this.el.classList.remove('tk-expanded');
    }
    // Notify the panel so it can track expansion state across re-renders
    if (this.onExpandChange) {
      this.onExpandChange(this.ticket.ticketId, this.ticket.id, this.expanded);
    }
  }

  /**
   * Render a quick-action bar that is always visible (no expand required).
   * Currently shown only for proposed tickets so users can approve without
   * having to click to expand first.
   */
}

Object.assign(TicketItem.prototype, headerMixin);
Object.assign(TicketItem.prototype, bodyMixin);
Object.assign(TicketItem.prototype, activityMixin);
Object.assign(TicketItem.prototype, actionsMixin);
