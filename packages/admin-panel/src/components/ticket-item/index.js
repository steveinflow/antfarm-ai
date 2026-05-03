// @docket/admin-panel — TicketItem: per-ticket card with header, detail, evidence, actions
//
// The class definition holds the constructor + lifecycle (render, _toggle, version/status helpers).
// Render-region methods are split into prototype mixins (one file per UI region) and applied
// at the bottom of this file via Object.assign(TicketItem.prototype, ...).

import { statusLabel } from '@docket/core';
import { el } from '../../el.js';
import { openLightbox } from '../../lightbox.js';
import {
  formatDate,
  formatDateCompact,
  formatDuration,
  formatCost,
  toISOString,
} from '../../format.js';
import { headerMixin } from './header.js';
import { bodyMixin } from './body.js';

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
  _renderRejectionButton(t) {
    const self = this;
    const container = el('div', { className: 'tk-rejection-container' });

    const btn = el('button', {
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': 'Not relevant — provide a rejection reason',
      onClick: (e) => {
        e.stopPropagation();
        if (self._rejectionPopover && self._rejectionPopover.parentNode) {
          self._closeRejectionPopover(btn);
        } else {
          btn.setAttribute('aria-expanded', 'true');
          const popover = self._buildRejectionPopover(t, () => {
            btn.setAttribute('aria-expanded', 'false');
          });
          container.appendChild(popover);
          self._rejectionPopover = popover;
          const first = popover.querySelector('button, input');
          if (first) first.focus();
        }
      },
    }, 'Not relevant');

    // Close popover on Escape from the trigger button
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') self._closeRejectionPopover(btn);
    });

    container.appendChild(btn);
    return container;
  }

  _closeRejectionPopover(triggerBtn) {
    if (this._rejectionPopover && this._rejectionPopover.parentNode) {
      this._rejectionPopover.parentNode.removeChild(this._rejectionPopover);
    }
    this._rejectionPopover = null;
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', 'false');
      triggerBtn.focus();
    }
  }

  /**
   * Build the inline rejection reason popover.
   * Keyboard: Tab cycles through options, Enter to confirm, Escape to cancel.
   * @param {object} t - ticket
   * @param {Function} onClose - called when popover closes
   */
  _buildRejectionPopover(t, onClose) {
    const self = this;
    // Reason options from spec — user-facing labels, not system internals
    const REASONS = [
      { value: 'off_topic',        label: 'Off-topic' },
      { value: 'too_small',        label: 'Too small to be worth a ticket' },
      { value: 'already_covered',  label: 'Already covered elsewhere' },
      { value: 'not_relevant',     label: 'Not relevant to this project right now' },
    ];

    const close = () => {
      self._closeRejectionPopover(null);
      if (onClose) onClose();
    };

    const submitRejection = async (reason) => {
      close();

      // Transition ticket to rejected immediately (card collapses/fades)
      try {
        await self.onTransition(t.id, 'rejected', { note: `Rejected: "${reason}"` });
      } catch (err) {
        self.toast.error('Failed to reject: ' + err.message);
        return;
      }

      // Show 4-second undo toast before finalizing rejection record (spec: 4s)
      const undoDiv = el('div', { className: 'tk-toast tk-toast-undo', role: 'status', 'aria-live': 'polite' });
      const undoBtn = el('button', {
        type: 'button',
        className: 'tk-toast-undo-btn',
        'aria-label': 'Undo rejection',
        onClick: async () => {
          clearTimeout(self._rejectionUndoTimer);
          if (undoDiv.parentNode) undoDiv.parentNode.removeChild(undoDiv);
          try {
            await self.onTransition(t.id, 'proposed', { note: 'Rejection undone' });
            self.toast.info('Rejection undone.');
          } catch (err) {
            self.toast.error('Undo failed: ' + err.message);
          }
        },
      }, 'Undo');

      undoDiv.appendChild(document.createTextNode('Proposal rejected. '));
      undoDiv.appendChild(undoBtn);

      // Add to toast container and focus undo button immediately (keyboard-reachable)
      const toastContainer = document.querySelector('.tk-toast-container');
      if (toastContainer) {
        toastContainer.appendChild(undoDiv);
        undoBtn.focus();
      }

      // 4-second undo window, then finalize rejection record
      self._rejectionUndoTimer = setTimeout(async () => {
        if (undoDiv.parentNode) undoDiv.parentNode.removeChild(undoDiv);
        // Finalize: write rejection record
        if (self.onReject) {
          try {
            await self.onReject({
              ticketId: t.id,
              ticketTitle: t.title,
              ticketSummary: t.summary || t.description || '',
              reason,
              persona: t.advisorPersona || t.persona || null,
            });
          } catch (err) {
            console.warn('[docket] Rejection record save failed:', err);
          }
        }
      }, 4000);
    };

    const optionsList = el('div', {
      className: 'tk-rejection-options',
      role: 'group',
      'aria-label': 'Rejection reasons',
    });
    let firstChipBtn = null;
    for (const r of REASONS) {
      const optBtn = el('button', {
        type: 'button',
        className: 'tk-rejection-option',
        // Accessible label per spec: "Reject: Off-topic" not just "Off-topic"
        'aria-label': `Reject: ${r.label}`,
        onClick: async () => {
          // Tapping a chip commits immediately — no separate confirm step
          await submitRejection(r.value);
        },
      }, r.label);
      optBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); optBtn.click(); }
      });
      optionsList.appendChild(optBtn);
      if (!firstChipBtn) firstChipBtn = optBtn;
    }

    const cancelBtn = el('button', {
      type: 'button',
      className: 'tk-rejection-cancel',
      'aria-label': 'Cancel — close rejection popover',
      onClick: close,
    }, '✕');
    cancelBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { e.preventDefault(); close(); }
    });

    const popover = el('div', {
      className: 'tk-rejection-popover',
      role: 'dialog',
      'aria-label': 'Rejection reason',
      'aria-modal': 'false',
    },
      cancelBtn,
      el('div', { className: 'tk-rejection-popover-title' }, 'Why reject this?'),
      optionsList,
    );

    // Move focus to first chip when popover opens (spec: focus first chip on expand)
    requestAnimationFrame(() => {
      if (firstChipBtn) firstChipBtn.focus();
    });

    // Trap Tab within popover
    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        popover.querySelectorAll('button:not([disabled])')
      ).filter(node => node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    return popover;
  }

  // ── Snooze helpers ──────────────────────────────────────────────────────

  /**
   * Returns true if the ticket is currently snoozed (snoozedUntil is in the future).
   * @param {object} t - ticket
   * @returns {boolean}
   */
  _isSnoozed(t) {
    if (!t.snoozedUntil) return false;
    const d = new Date(t.snoozedUntil);
    return !isNaN(d.getTime()) && d > new Date();
  }

  /**
   * Render the snooze button for proposed tickets.
   * Secondary action — placed after Accept/Reject/Not-relevant.
   * @param {object} t - ticket
   * @returns {HTMLElement}
   */
  _renderSnoozeButton(t) {
    const self = this;
    const container = el('div', { className: 'tk-snooze-container' });

    const label = this._isSnoozed(t) ? '⏰ Snoozed' : '⏰ Snooze';
    const btn = el('button', {
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': 'Snooze — defer this proposal until a later date',
      onClick: (e) => {
        e.stopPropagation();
        if (self._snoozePopover && self._snoozePopover.parentNode) {
          self._closeSnoozePopover(btn);
        } else {
          btn.setAttribute('aria-expanded', 'true');
          const popover = self._buildSnoozePopover(t, () => {
            btn.setAttribute('aria-expanded', 'false');
          });
          container.appendChild(popover);
          self._snoozePopover = popover;
          const first = popover.querySelector('button, input');
          if (first) first.focus();
        }
      },
    }, label);

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') self._closeSnoozePopover(btn);
    });

    container.appendChild(btn);
    return container;
  }

  _closeSnoozePopover(triggerBtn) {
    if (this._snoozePopover && this._snoozePopover.parentNode) {
      this._snoozePopover.parentNode.removeChild(this._snoozePopover);
    }
    this._snoozePopover = null;
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', 'false');
      triggerBtn.focus();
    }
  }

  /**
   * Build the inline snooze duration popover.
   * Shows preset chips (2 weeks, 1 month) and a custom date input.
   * @param {object} t - ticket
   * @param {Function} onClose - called when popover closes
   */
  _buildSnoozePopover(t, onClose) {
    const self = this;

    // Default snooze date: 2 weeks from today
    const twoWeeksFromNow = new Date();
    twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);
    const defaultDateStr = twoWeeksFromNow.toISOString().slice(0, 10); // YYYY-MM-DD

    // Minimum date is tomorrow (snooze must be in the future)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const minDateStr = tomorrow.toISOString().slice(0, 10);

    // Maximum date is 6 months from now
    const sixMonths = new Date();
    sixMonths.setDate(sixMonths.getDate() + 180);
    const maxDateStr = sixMonths.toISOString().slice(0, 10);

    const close = () => {
      self._closeSnoozePopover(null);
      if (onClose) onClose();
    };

    const executeSnooze = async (targetDate) => {
      close();
      try {
        await self.onSnooze(t.id, targetDate);
      } catch (err) {
        self.toast.error('Failed to snooze: ' + err.message);
        return;
      }

      // Show 5-second undo toast
      const undoDiv = el('div', { className: 'tk-toast tk-toast-undo', role: 'status', 'aria-live': 'polite' });
      const undoBtn = el('button', {
        type: 'button',
        className: 'tk-toast-undo-btn',
        'aria-label': 'Undo snooze',
        onClick: async () => {
          clearTimeout(self._snoozeUndoTimer);
          if (undoDiv.parentNode) undoDiv.parentNode.removeChild(undoDiv);
          try {
            await self.onSnooze(t.id, null); // null = unsnooze
            self.toast.info('Snooze undone.');
          } catch (err) {
            self.toast.error('Undo failed: ' + err.message);
          }
        },
      }, 'Undo');

      const resurfaceStr = targetDate ? formatDate(targetDate.toISOString()) : '';
      undoDiv.appendChild(document.createTextNode(`Snoozed until ${resurfaceStr}. `));
      undoDiv.appendChild(undoBtn);

      const toastContainer = document.querySelector('.tk-toast-container');
      if (toastContainer) {
        toastContainer.appendChild(undoDiv);
        undoBtn.focus();
      }

      self._snoozeUndoTimer = setTimeout(() => {
        if (undoDiv.parentNode) undoDiv.parentNode.removeChild(undoDiv);
      }, 5000);
    };

    // Helper: compute snooze target from days offset
    const dateFromDays = (days) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return d;
    };

    // Custom date input — native <input type="date">, defaults to 2 weeks out
    const customDateInput = el('input', {
      type: 'date',
      className: 'tk-snooze-date-input',
      value: defaultDateStr,
      min: minDateStr,
      max: maxDateStr,
      'aria-label': 'Custom snooze date',
    });

    const customSubmitBtn = el('button', {
      type: 'button',
      className: 'tk-btn tk-btn-primary tk-btn-sm',
      'aria-label': 'Confirm custom snooze date',
      onClick: async () => {
        const val = customDateInput.value;
        if (!val) {
          self.toast.error('Please select a date.');
          return;
        }
        const targetDate = new Date(val + 'T00:00:00');
        if (isNaN(targetDate.getTime())) {
          self.toast.error('Invalid date.');
          return;
        }
        await executeSnooze(targetDate);
      },
    }, 'Snooze');

    customDateInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); customSubmitBtn.click(); }
      if (e.key === 'Escape') close();
    });

    const cancelBtn = el('button', {
      type: 'button',
      className: 'tk-snooze-cancel',
      'aria-label': 'Cancel — close snooze popover',
      onClick: close,
    }, '✕');
    cancelBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    const presets = el('div', { className: 'tk-snooze-presets', role: 'group', 'aria-label': 'Snooze duration presets' });
    const presetDefs = [
      { label: '2 weeks', days: 14 },
      { label: '1 month', days: 30 },
    ];
    for (const p of presetDefs) {
      const presetBtn = el('button', {
        type: 'button',
        className: 'tk-snooze-preset',
        'aria-label': `Snooze for ${p.label}`,
        onClick: async () => { await executeSnooze(dateFromDays(p.days)); },
      }, p.label);
      presetBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { e.preventDefault(); presetBtn.click(); }
      });
      presets.appendChild(presetBtn);
    }

    const customRow = el('div', { className: 'tk-snooze-custom-row' },
      customDateInput,
      customSubmitBtn,
    );

    const popover = el('div', {
      className: 'tk-snooze-popover',
      role: 'dialog',
      'aria-label': 'Snooze this proposal',
      'aria-modal': 'false',
    },
      cancelBtn,
      el('div', { className: 'tk-snooze-popover-title' }, 'Snooze until…'),
      presets,
      customRow,
    );

    // Trap Tab within popover
    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        popover.querySelectorAll('button:not([disabled]), input:not([disabled])')
      ).filter(node => node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    return popover;
  }

  // ── Evidence type badge (list-level) ────────────────────────────────────

  /**
   * Render a small evidence type badge for a proposed ticket header.
   * Lets users see at a glance what kind of evidence backs a proposal so they
   * can prioritize which proposals to open.
   *
   * Returns null if there is no reasoning or evidence to signal.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */
  _renderFeedbackWidget() {
    const t = this.ticket;
    // Only show for advisor-generated tickets (presence of persona field)
    if (!t.advisorPersona && !t.persona) return null;
    if (!this.onFeedback) return null;

    const self = this;
    const currentRating = this.currentUserFeedback;

    const thumbsUp = el('button', {
      type: 'button',
      className: 'tk-feedback-btn tk-feedback-up' + (currentRating === 'relevant' ? ' tk-feedback-selected' : ''),
      'aria-label': 'Mark as relevant',
      'aria-pressed': String(currentRating === 'relevant'),
      title: 'Relevant',
      onClick: async (e) => {
        e.stopPropagation();
        await self._submitFeedback('relevant', thumbsUp, thumbsDown, nudgeEl);
      },
    },
      el('span', { className: 'tk-feedback-icon', 'aria-hidden': 'true' }, '👍'),
      el('span', { className: 'tk-feedback-label' }, 'Relevant'),
    );

    const thumbsDown = el('button', {
      type: 'button',
      className: 'tk-feedback-btn tk-feedback-down' + (currentRating === 'noise' ? ' tk-feedback-selected' : ''),
      'aria-label': 'Mark as not relevant',
      'aria-pressed': String(currentRating === 'noise'),
      title: 'Not relevant',
      onClick: async (e) => {
        e.stopPropagation();
        await self._submitFeedback('noise', thumbsUp, thumbsDown, nudgeEl);
      },
    },
      el('span', { className: 'tk-feedback-icon', 'aria-hidden': 'true' }, '👎'),
      el('span', { className: 'tk-feedback-label' }, 'Not relevant'),
    );

    // First-use nudge element (hidden by default, shown once after first rating)
    const nudgeEl = el('span', {
      className: 'tk-feedback-nudge tk-feedback-nudge-hidden',
      role: 'status',
      'aria-live': 'polite',
    }, 'This helps tune future suggestions.');

    return el('div', { className: 'tk-feedback-widget', 'aria-label': 'Rate suggestion quality' },
      el('span', { className: 'tk-feedback-prompt' }, 'Was this suggestion useful?'),
      el('span', { className: 'tk-feedback-buttons' }, thumbsUp, thumbsDown),
      nudgeEl,
    );
  }

  /**
   * Submit feedback for this ticket and update button states.
   *
   * @param {"relevant"|"noise"} rating
   * @param {HTMLElement} upBtn
   * @param {HTMLElement} downBtn
   * @param {HTMLElement} nudgeEl
   */
  async _submitFeedback(rating, upBtn, downBtn, nudgeEl) {
    const t = this.ticket;
    const wasFirstRating = !this.currentUserFeedback;

    // Optimistic UI update — update button states immediately
    this.currentUserFeedback = rating;

    if (rating === 'relevant') {
      upBtn.classList.add('tk-feedback-selected');
      upBtn.setAttribute('aria-pressed', 'true');
      downBtn.classList.remove('tk-feedback-selected');
      downBtn.setAttribute('aria-pressed', 'false');
    } else {
      downBtn.classList.add('tk-feedback-selected');
      downBtn.setAttribute('aria-pressed', 'true');
      upBtn.classList.remove('tk-feedback-selected');
      upBtn.setAttribute('aria-pressed', 'false');
    }

    // Show first-use nudge (once per browser session, stored in sessionStorage)
    const NUDGE_KEY = 'docket_feedback_nudge_shown';
    if (wasFirstRating && nudgeEl && !sessionStorage.getItem(NUDGE_KEY)) {
      sessionStorage.setItem(NUDGE_KEY, '1');
      nudgeEl.classList.remove('tk-feedback-nudge-hidden');
      // Hide nudge after 4 seconds
      setTimeout(() => {
        nudgeEl.classList.add('tk-feedback-nudge-hidden');
      }, 4000);
    }

    // Persist to Firestore
    try {
      await this.onFeedback(t.id, rating);
    } catch (err) {
      // Revert optimistic update on error
      this.currentUserFeedback = wasFirstRating ? null : (rating === 'relevant' ? 'noise' : 'relevant');
      if (this.toast) this.toast.error('Failed to save feedback: ' + err.message);
    }
  }

  // ── Evidence section ────────────────────────────────────────────────────

  /**
   * Render the collapsible "Evidence" section for advisor-enriched tickets.
   * Returns null if no evidence fields are present on the ticket.
   *
   * Evidence subsections (rendered conditionally):
   *  - File refs (Engineer) — fileRefs: [{ path, lineStart, lineEnd, commitSha }]
   *  - Screenshot + annotations (Design) — screenshot: { storageUrl, capturedAt, annotations }
   *  - Related tickets (Product) — relatedTicketIds: [id, ...]
   */
  _renderLinksSection() {
    const t = this.ticket;
    const links = Array.isArray(t.links) ? t.links : [];
    if (links.length === 0 && !this.onAddLink) return null;

    const self = this;
    const contentId = `tk-links-content-${t.id || t.ticketId}`;

    const contentEl = el('div', {
      className: 'tk-links-content' + (this._linksExpanded ? ' tk-links-content-open' : ''),
      id: contentId,
    });

    // Build the content
    const renderContent = () => {
      contentEl.innerHTML = '';

      if (links.length === 0) {
        contentEl.appendChild(el('div', { className: 'tk-links-empty' }, 'No links yet.'));
      } else {
        // Group links by type
        const blocksLinks = links.filter(l => l.type === 'blocks');
        const relatedLinks = links.filter(l => l.type === 'related');
        const followUpLinks = links.filter(l => l.type === 'follow-up');

        const renderLinkGroup = (groupLinks, label) => {
          if (groupLinks.length === 0) return null;
          const items = groupLinks.map(link => {
            const target = self.allTickets.find(tk => tk.id === link.targetId);
            const displayId = target ? (target.ticketId || link.targetId) : link.targetId;
            const displayTitle = target ? target.title : '(loading…)';
            const statusCls = target ? `tk-ticket-status tk-ticket-status-${target.status}` : '';

            const removeBtn = self.onRemoveLink
              ? el('button', {
                  type: 'button',
                  className: 'tk-link-remove-btn',
                  'aria-label': `Remove link to ${displayId}`,
                  title: 'Remove link',
                  onClick: async (e) => {
                    e.stopPropagation();
                    try {
                      await self.onRemoveLink(t.id, link.targetId);
                      self.toast.success(`Link removed.`);
                    } catch (err) {
                      self.toast.error('Failed to remove link: ' + err.message);
                    }
                  },
                }, '×')
              : null;

            return el('li', {
              className: 'tk-link-item',
              role: 'listitem',
            },
              el('span', { className: 'tk-link-item-id' }, displayId),
              target && target.status ? el('span', { className: statusCls }, target.status) : null,
              el('span', { className: 'tk-link-item-title' }, displayTitle),
              removeBtn,
            );
          });

          return el('div', { className: 'tk-link-group' },
            el('div', { className: 'tk-link-group-label' }, label),
            el('ul', { className: 'tk-link-list', role: 'list' }, items),
          );
        };

        const blocksEl = renderLinkGroup(blocksLinks, 'Must happen before');
        const relatedEl = renderLinkGroup(relatedLinks, 'Related');
        const followUpEl = renderLinkGroup(followUpLinks, 'Can happen after');
        if (blocksEl) contentEl.appendChild(blocksEl);
        if (relatedEl) contentEl.appendChild(relatedEl);
        if (followUpEl) contentEl.appendChild(followUpEl);
      }

      // "Link proposals" button
      if (self.onAddLink) {
        contentEl.appendChild(self._renderLinkProposalsButton(t));
      }
    };

    renderContent();

    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-links-toggle',
      'aria-expanded': String(this._linksExpanded),
      'aria-controls': contentId,
      onClick: () => {
        self._linksExpanded = !self._linksExpanded;
        toggleBtn.setAttribute('aria-expanded', String(self._linksExpanded));
        if (self._linksExpanded) {
          contentEl.classList.add('tk-links-content-open');
          toggleBtn.querySelector('.tk-links-toggle-icon').textContent = '▾';
        } else {
          contentEl.classList.remove('tk-links-content-open');
          toggleBtn.querySelector('.tk-links-toggle-icon').textContent = '▸';
        }
      },
    },
      el('span', { className: 'tk-links-toggle-icon' }, this._linksExpanded ? '▾' : '▸'),
      ' Links',
      links.length > 0 ? el('span', { className: 'tk-links-toggle-count' }, ` (${links.length})`) : null,
    );

    return el('div', { className: 'tk-links-section' },
      toggleBtn,
      contentEl,
    );
  }

  // ── Link proposals popover ───────────────────────────────────────────────

  /**
   * Render the "Link proposals" button that opens a command-palette style search.
   * @param {object} t - ticket
   * @returns {HTMLElement}
   */
  _renderLinkProposalsButton(t) {
    const self = this;
    const container = el('div', { className: 'tk-link-proposals-container' });

    const btn = el('button', {
      type: 'button',
      className: 'tk-btn tk-btn-ghost tk-btn-sm tk-link-proposals-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': 'Link proposals — add a relationship to another ticket',
      onClick: (e) => {
        e.stopPropagation();
        if (self._linkPopover && self._linkPopover.parentNode) {
          self._closeLinkPopover(btn);
        } else {
          btn.setAttribute('aria-expanded', 'true');
          const popover = self._buildLinkPopover(t, () => {
            btn.setAttribute('aria-expanded', 'false');
          });
          container.appendChild(popover);
          self._linkPopover = popover;
          const searchInput = popover.querySelector('.tk-link-search-input');
          if (searchInput) searchInput.focus();
        }
      },
    }, '＋ Link proposals');

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') self._closeLinkPopover(btn);
    });

    container.appendChild(btn);
    return container;
  }

  _closeLinkPopover(triggerBtn) {
    if (this._linkPopover && this._linkPopover.parentNode) {
      this._linkPopover.parentNode.removeChild(this._linkPopover);
    }
    this._linkPopover = null;
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', 'false');
      triggerBtn.focus();
    }
  }

  /**
   * Build the link search-and-select popover.
   * Allows typing to filter tickets by ID or title, then selecting relationship type.
   *
   * @param {object} t - source ticket
   * @param {Function} onClose
   */
  _buildLinkPopover(t, onClose) {
    const self = this;
    const LINK_TYPES = ['blocks', 'related', 'follow-up'];
    const TYPE_LABELS = {
      'blocks': 'Blocks (must happen before)',
      'related': 'Related',
      'follow-up': 'Follow-up (can happen after)',
    };

    let selectedType = 'related';
    let searchQuery = '';
    const existingLinks = Array.isArray(t.links) ? t.links : [];

    const close = () => {
      self._closeLinkPopover(null);
      if (onClose) onClose();
    };

    // Type selector
    const typeSelect = el('select', {
      className: 'tk-link-type-select',
      'aria-label': 'Relationship type',
      onChange: (e) => { selectedType = e.target.value; },
    },
      ...LINK_TYPES.map(tp =>
        el('option', { value: tp, ...(tp === selectedType ? { selected: 'selected' } : {}) },
          TYPE_LABELS[tp]
        )
      )
    );

    // Results container
    const resultsEl = el('div', { className: 'tk-link-results', role: 'listbox', 'aria-label': 'Ticket search results' });

    const renderResults = (query) => {
      resultsEl.innerHTML = '';

      // Filter allTickets: exclude self, exclude already-linked
      const alreadyLinkedIds = new Set(existingLinks.map(l => l.targetId));
      alreadyLinkedIds.add(t.id); // exclude self

      const q = query.trim().toLowerCase();
      const filtered = self.allTickets.filter(tk => {
        if (alreadyLinkedIds.has(tk.id)) return false;
        if (!q) return true; // show all when no query
        const fields = [tk.ticketId, tk.title];
        return fields.some(f => f && String(f).toLowerCase().includes(q));
      }).slice(0, 10); // cap at 10 results

      if (filtered.length === 0) {
        resultsEl.appendChild(el('div', { className: 'tk-link-results-empty' },
          q ? 'No tickets found.' : 'Type to search for tickets.'
        ));
        return;
      }

      for (const candidate of filtered) {
        const statusCls = `tk-ticket-status tk-ticket-status-${candidate.status}`;
        const item = el('div', {
          className: 'tk-link-result-item',
          role: 'option',
          tabindex: '0',
          'aria-label': `${candidate.ticketId}: ${candidate.title}`,
          onClick: async () => {
            item.setAttribute('aria-disabled', 'true');
            item.classList.add('tk-link-result-item-loading');
            try {
              await self.onAddLink(t.id, candidate.id, selectedType);
              self.toast.success(`Linked to ${candidate.ticketId}.`);
              close();
            } catch (err) {
              self.toast.error('Failed to add link: ' + err.message);
              item.removeAttribute('aria-disabled');
              item.classList.remove('tk-link-result-item-loading');
            }
          },
        },
          el('span', { className: 'tk-link-result-id' }, candidate.ticketId || ''),
          el('span', { className: statusCls }, candidate.status || ''),
          el('span', { className: 'tk-link-result-title' }, candidate.title || ''),
        );

        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
          if (e.key === 'Escape') close();
        });

        resultsEl.appendChild(item);
      }
    };

    // Initial render with no query
    renderResults('');

    const searchInput = el('input', {
      type: 'search',
      className: 'tk-link-search-input',
      placeholder: 'Search by ticket ID or title…',
      'aria-label': 'Search for tickets to link',
      'aria-autocomplete': 'list',
      'aria-controls': 'tk-link-results',
      onInput: (e) => {
        searchQuery = e.target.value;
        renderResults(searchQuery);
      },
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown') {
        const first = resultsEl.querySelector('.tk-link-result-item');
        if (first) { e.preventDefault(); first.focus(); }
      }
    });

    resultsEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const next = document.activeElement.nextElementSibling;
        if (next && next.classList.contains('tk-link-result-item')) { e.preventDefault(); next.focus(); }
      }
      if (e.key === 'ArrowUp') {
        const prev = document.activeElement.previousElementSibling;
        if (prev && prev.classList.contains('tk-link-result-item')) {
          e.preventDefault(); prev.focus();
        } else {
          e.preventDefault(); searchInput.focus();
        }
      }
      if (e.key === 'Escape') close();
    });

    const cancelBtn = el('button', {
      type: 'button',
      className: 'tk-link-popover-cancel',
      'aria-label': 'Cancel — close link proposals popover',
      onClick: close,
    }, '✕');
    cancelBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    const popover = el('div', {
      className: 'tk-link-popover',
      role: 'dialog',
      'aria-label': 'Link proposals',
      'aria-modal': 'false',
    },
      cancelBtn,
      el('div', { className: 'tk-link-popover-title' }, 'Link proposals'),
      el('div', { className: 'tk-link-type-row' },
        el('label', { 'for': 'tk-link-type-select' }, 'Relationship:'),
        typeSelect,
      ),
      searchInput,
      resultsEl,
    );

    // Trap Tab within popover
    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        popover.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')
      ).filter(node => node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    return popover;
  }

  _renderActions() {
    const t = this.ticket;
    const buttons = [];

    // Proposed -> approve (open) or deny (wont_do)
    if (t.status === 'proposed') {
      // Check for unresolved "blocked by" links — find proposals that block this ticket
      // and haven't been accepted yet (still in 'proposed' status).
      const unresolvedBlockers = this.allTickets.filter(other => {
        if (other.id === t.id) return false;
        if (other.status !== 'proposed') return false; // already accepted = resolved
        const otherLinks = Array.isArray(other.links) ? other.links : [];
        return otherLinks.some(l => l.targetId === t.id && l.type === 'blocks');
      });

      const approveTicket = async (skipWarning) => {
        try {
          await this.onTransition(t.id, 'open', { note: 'Approved by user' });
          this.toast.success('Ticket approved.');
        } catch (err) {
          this.toast.error('Failed: ' + err.message);
        }
      };

      if (unresolvedBlockers.length > 0) {
        // Approve button with inline blocker warning on click
        const warningContainer = el('div', { className: 'tk-blocker-warning-container' });

        const approveBtn = el('button', {
          className: 'tk-btn tk-btn-success tk-btn-sm',
          onClick: async (e) => {
            e.stopPropagation();
            // Show inline warning
            warningContainer.innerHTML = '';
            const blockerName = unresolvedBlockers[0].ticketId || unresolvedBlockers[0].title || 'another proposal';
            const moreCount = unresolvedBlockers.length - 1;
            const warningText = unresolvedBlockers.length === 1
              ? `This depends on ${blockerName} which hasn't been accepted yet. Accept anyway?`
              : `This depends on ${blockerName} and ${moreCount} other${moreCount !== 1 ? 's' : ''} which haven't been accepted yet. Accept anyway?`;

            const warningEl = el('div', {
              className: 'tk-blocker-warning',
              role: 'alert',
              'aria-live': 'assertive',
              tabindex: '-1',
            },
              el('span', { className: 'tk-blocker-warning-text' }, warningText),
              el('button', {
                type: 'button',
                className: 'tk-btn tk-btn-success tk-btn-sm',
                onClick: async () => { await approveTicket(true); },
              }, 'Accept anyway'),
              el('button', {
                type: 'button',
                className: 'tk-btn tk-btn-ghost tk-btn-sm',
                onClick: () => {
                  warningContainer.innerHTML = '';
                  approveBtn.disabled = false;
                },
              }, 'Cancel'),
            );
            warningContainer.appendChild(warningEl);
            approveBtn.disabled = true;
            // Move focus to warning for screen readers
            warningEl.focus();
          },
        }, 'Approve');

        buttons.push(approveBtn);
        buttons.push(warningContainer);
      } else {
        buttons.push(el('button', {
          className: 'tk-btn tk-btn-success tk-btn-sm',
          onClick: async () => { await approveTicket(false); },
        }, 'Approve'));
      }

      buttons.push(el('button', {
        className: 'tk-btn tk-btn-danger tk-btn-sm',
        onClick: async () => {
          try {
            await this.onTransition(t.id, 'wont_do', {
              note: 'Denied by user',
            });
            this.toast.success("Ticket marked as Won't Do.");
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          }
        },
      }, 'Deny'));

      // "Not relevant" rejection button — opens inline popover for reason capture
      if (this.onReject) {
        buttons.push(this._renderRejectionButton(t));
      }

      // Snooze button — secondary action, placed after primary approve/reject
      if (this.onSnooze) {
        buttons.push(this._renderSnoozeButton(t));
      }
    }

    // Done -> reopen
    if (t.status === 'done') {
      // Reuse the existing input element so that any text the user has already
      // typed (and keyboard focus) is preserved across Firestore-triggered
      // re-renders.  render() clears _commentInput whenever the ticket status
      // changes, so this is safe.
      if (!this._commentInput) {
        this._commentInput = el('input', {
          className: 'tk-comment-input',
          placeholder: 'Optional comment...',
        });
      }
      const commentInput = this._commentInput;

      buttons.push(commentInput);

      buttons.push(el('button', {
        className: 'tk-btn tk-btn-outline tk-btn-sm',
        onClick: async () => {
          try {
            await this.onTransition(t.id, 'open', {
              note: commentInput.value.trim() || 'Reopened by user',
            });
            this.toast.success('Ticket reopened.');
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          }
        },
      }, 'Reopen'));

      buttons.push(el('button', {
        className: 'tk-btn tk-btn-success tk-btn-sm',
        onClick: async () => {
          try {
            await this.onTransition(t.id, 'verified', {
              note: commentInput.value.trim() || 'Verified by user',
            });
            this.toast.success('Ticket verified.');
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          }
        },
      }, 'Verify'));
    }

    // "Exclude this path/URL" button — DK-128
    // Shown on proposed advisor tickets (Engineer or Design) when onExclude is wired.
    // Pre-populates the exclusion pattern from the ticket's first fileRef (Engineer)
    // or leaves an empty input for Design (since URL is not stored on the ticket).
    if (this.onExclude && t.status === 'proposed' && t.advisorPersona) {
      const isEngineer = t.advisorPersona === 'engineer';
      const isDesign = t.advisorPersona === 'design';

      // Only show for engineer (needs fileRefs) and design
      if (isEngineer || isDesign) {
        // Pre-populate: for engineer, use the directory of the first fileRef
        let prePopulated = '';
        if (isEngineer && Array.isArray(t.fileRefs) && t.fileRefs.length > 0) {
          const firstPath = t.fileRefs[0].path || '';
          // Suggest directory glob (e.g. "vendor/stripe/**" from "vendor/stripe/foo.js")
          const lastSlash = firstPath.lastIndexOf('/');
          prePopulated = lastSlash > 0 ? firstPath.slice(0, lastSlash) + '/**' : firstPath;
        }

        const btnLabel = isEngineer ? 'Exclude this path' : 'Exclude this URL';
        const excludeBtn = el('button', {
          className: 'tk-btn tk-btn-ghost tk-btn-sm tk-exclude-btn',
          type: 'button',
          title: `Add to ${isEngineer ? 'Engineer' : 'Design'} exclusion list — ${isEngineer ? 'Engineer' : 'Design'} will skip this ${isEngineer ? 'path' : 'URL'} in future runs`,
          onClick: (e) => {
            e.stopPropagation();
            this._renderExcludeConfirm(t, prePopulated, excludeBtn);
          },
        }, btnLabel);
        buttons.push(excludeBtn);
      }
    }

    // Mark Critical button — available on open tickets that are not yet critical.
    // Marks the ticket as critical so the orchestrator spawns a worker immediately,
    // bypassing the normal max-worker cap (matching the behavior of the creation checkbox).
    if (this.onMarkCritical && t.status === 'open' && !t.critical) {
      const markCriticalBtn = el('button', {
        className: 'tk-btn tk-btn-critical tk-btn-sm',
        title: 'Mark as critical — the orchestrator will spawn a worker immediately, above the normal cap',
        onClick: async (e) => {
          e.stopPropagation();
          markCriticalBtn.disabled = true;
          markCriticalBtn.textContent = 'Marking…';
          try {
            await this.onMarkCritical(t.id);
            this.toast.success(`${t.ticketId} marked as critical — worker will spawn immediately.`);
          } catch (err) {
            this.toast.error('Failed to mark critical: ' + err.message);
            markCriticalBtn.disabled = false;
            markCriticalBtn.textContent = '⚡ Mark Critical';
          }
        },
      }, '⚡ Mark Critical');
      buttons.push(markCriticalBtn);
    }

    // Reset to Open button (admin only, for in_progress or blocked tickets)
    if (this.isAdmin() && (t.status === 'in_progress' || t.status === 'blocked')) {
      buttons.push(el('button', {
        className: 'tk-btn tk-btn-warning tk-btn-sm',
        title: `Reset ${t.ticketId} back to open status — the worker will be available for a fresh attempt`,
        onClick: async (e) => {
          e.stopPropagation();
          const confirmed = window.confirm(
            `Reset ${t.ticketId} back to open? The orchestrator can then assign a fresh worker.`
          );
          if (!confirmed) return;
          try {
            await this.onTransition(t.id, 'open', {
              note: `Reset to open by admin (was ${t.status})`,
            });
            this.toast.success(`Ticket ${t.ticketId} reset to open.`);
          } catch (err) {
            this.toast.error('Failed to reset: ' + err.message);
          }
        },
      }, 'Reset to Open'));
    }

    // Delete button (admin only)
    if (this.isAdmin() && this.onDelete) {
      buttons.push(el('button', {
        className: 'tk-btn tk-btn-danger tk-btn-sm',
        onClick: async (e) => {
          e.stopPropagation();
          const confirmed = window.confirm(
            `Delete ticket ${t.ticketId}: "${t.title}"? This cannot be undone.`
          );
          if (!confirmed) return;
          try {
            await this.onDelete(t.id);
            this.toast.success(`Ticket ${t.ticketId} deleted.`);
          } catch (err) {
            this.toast.error('Failed to delete: ' + err.message);
          }
        },
      }, 'Delete'));
    }

    if (buttons.length === 0) return null;

    return el('div', { className: 'tk-ticket-actions' }, buttons);
  }

  /**
   * Render a small inline "confirm exclusion" mini-form below the exclude button.
   * Allows user to confirm/edit the pre-populated pattern before saving.
   *
   * @param {object} t - The ticket
   * @param {string} prePopulated - Pre-filled pattern
   * @param {HTMLElement} triggerBtn - The button that opened this form (for positioning)
   */
  _renderExcludeConfirm(t, prePopulated, triggerBtn) {
    // Remove any existing popover
    const existing = this.el?.querySelector('.tk-exclude-popover');
    if (existing) { existing.remove(); return; }

    const isEngineer = t.advisorPersona === 'engineer';
    const personaId = t.advisorPersona; // 'engineer' | 'design'
    const inputLabel = isEngineer ? 'Glob pattern to exclude:' : 'URL prefix to exclude:';
    const placeholder = isEngineer ? 'e.g. vendor/**, legacy/**' : 'e.g. https://example.com/admin/';
    const MAX_LEN = 200;

    const patternInput = el('input', {
      type: 'text',
      className: 'tk-exclude-input',
      value: prePopulated,
      placeholder,
      maxLength: MAX_LEN,
      'aria-label': inputLabel,
    });

    const validationEl = el('span', {
      className: 'tk-exclude-validation',
      role: 'status',
      'aria-live': 'polite',
    });

    const validateInput = () => {
      const v = patternInput.value.trim();
      if (!v) {
        validationEl.textContent = '';
        return false;
      }
      if (v.length > MAX_LEN) {
        validationEl.textContent = '✗ Too long (max 200 chars)';
        return false;
      }
      if (isEngineer && /\*{3,}|\*\*\/\*\*/.test(v)) {
        validationEl.textContent = '✗ Repeated wildcards — simplify to **';
        return false;
      }
      if (!isEngineer) {
        const lower = v.toLowerCase();
        if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
          validationEl.textContent = '✗ Pattern cannot match javascript: or data: URIs';
          return false;
        }
      }
      validationEl.textContent = '✓ valid';
      return true;
    };

    patternInput.addEventListener('input', validateInput);

    const confirmBtn = el('button', {
      type: 'button',
      className: 'tk-btn tk-btn-success tk-btn-sm',
      onClick: async () => {
        const v = patternInput.value.trim();
        if (!v || !validateInput()) return;
        try {
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Saving…';
          await this.onExclude({ personaId, pattern: v });
          popover.remove();
          this.toast.success(`Exclusion added: ${v}`);
        } catch (err) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Exclude';
          validationEl.textContent = `✗ Save failed`;
        }
      },
    }, 'Exclude');

    const cancelBtn = el('button', {
      type: 'button',
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      onClick: () => popover.remove(),
    }, 'Cancel');

    const popover = el('div', { className: 'tk-exclude-popover', role: 'dialog', 'aria-label': 'Add exclusion pattern' },
      el('label', { className: 'tk-exclude-label' }, inputLabel),
      patternInput,
      validationEl,
      el('div', { className: 'tk-exclude-popover-actions' },
        confirmBtn,
        cancelBtn,
      ),
    );

    // Insert after trigger button's parent row
    triggerBtn.closest('.tk-ticket-actions')?.after(popover);
    // Focus the input for immediate editing
    patternInput.focus();
    if (prePopulated) {
      patternInput.select();
      validateInput();
    }
  }
}

Object.assign(TicketItem.prototype, headerMixin);
Object.assign(TicketItem.prototype, bodyMixin);
