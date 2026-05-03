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
import { activityMixin } from './activity.js';

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
Object.assign(TicketItem.prototype, activityMixin);
