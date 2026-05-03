// @docket/admin-panel — TicketItem: per-ticket card with header, detail, evidence, actions

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
  _renderQuickActions() {
    const t = this.ticket;

    const approveBtn = el('button', {
      className: 'tk-btn tk-btn-success tk-btn-sm tk-quick-approve',
      title: 'Approve this ticket',
      onClick: async (e) => {
        e.stopPropagation(); // don't toggle the card
        approveBtn.disabled = true;
        approveBtn.textContent = 'Approving…';
        try {
          await this.onTransition(t.id, 'open', { note: 'Approved by user' });
          this.toast.success('Ticket approved.');
        } catch (err) {
          this.toast.error('Failed: ' + err.message);
          approveBtn.disabled = false;
          approveBtn.textContent = '✓ Approve';
        }
      },
    }, '✓ Approve');

    const denyBtn = el('button', {
      className: 'tk-btn tk-btn-danger tk-btn-sm tk-quick-deny',
      title: 'Deny this ticket',
      onClick: async (e) => {
        e.stopPropagation(); // don't toggle the card
        denyBtn.disabled = true;
        denyBtn.textContent = 'Denying…';
        try {
          await this.onTransition(t.id, 'wont_do', { note: 'Denied by user' });
          this.toast.success("Ticket denied.");
        } catch (err) {
          this.toast.error('Failed: ' + err.message);
          denyBtn.disabled = false;
          denyBtn.textContent = '✗ Deny';
        }
      },
    }, '✗ Deny');

    return el('div', { className: 'tk-quick-actions' }, approveBtn, denyBtn);
  }

  _renderDetail() {
    const t = this.ticket;
    const parts = [];

    // Description
    if (t.description) {
      parts.push(el('div', { className: 'tk-ticket-description' }, t.description));
    }

    // Meta
    const created = t.createdAt ? formatDate(t.createdAt) : '';
    if (created) {
      parts.push(el('div', { className: 'tk-ticket-meta' }, 'Created: ' + created));
    }

    // Advisor attribution (DK-189) — shown on advisor-generated tickets
    // Displays: "via Advisor / Engineer — Feb 27, 2026"
    // Clicking opens the run log drawer pre-scrolled to the originating run.
    if (t.advisorPersona) {
      const personaDisplayNames = {
        engineer: 'Engineer', design: 'Design', product: 'Product', qa: 'QA',
      };
      const personaLabel = personaDisplayNames[t.advisorPersona] || t.advisorPersona;
      const createdDate = t.createdAt
        ? (() => {
            const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
            return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          })()
        : '';

      const advisorRunId = t.advisorRunId || null;

      const attributionText = `via Advisor / ${personaLabel}${createdDate ? ` — ${createdDate}` : ''}`;

      const attrEl = advisorRunId
        ? el('button', {
            className: 'tk-advisor-attribution tk-advisor-attribution-link',
            type: 'button',
            title: 'Open run log for this ticket',
            'aria-label': `${attributionText} — click to view in run log`,
            onClick: () => {
              // Dispatch a custom event to open the run log drawer.
              // The host app (web/src/index.js) listens for this event.
              window.dispatchEvent(new CustomEvent('docket:open-run-log', {
                detail: { runId: advisorRunId },
                bubbles: true,
              }));
            },
          }, attributionText)
        : el('span', {
            className: 'tk-advisor-attribution',
            'aria-label': attributionText,
          }, attributionText);

      parts.push(el('div', { className: 'tk-advisor-attribution-row' }, attrEl));
    }

    // Cost and duration — shown for done/verified tickets
    if (t.status === 'done' || t.status === 'verified') {
      const duration = formatDuration(t.durationMs);
      const cost = formatCost(t.costUsd);
      if (duration || cost) {
        const metaParts = [];
        if (duration) metaParts.push(el('span', { className: 'tk-ticket-stat' },
          el('span', { className: 'tk-ticket-stat-icon' }, '⏱'),
          ' ' + duration,
        ));
        if (cost) metaParts.push(el('span', { className: 'tk-ticket-stat' },
          el('span', { className: 'tk-ticket-stat-icon' }, '💰'),
          ' ' + cost,
        ));
        parts.push(el('div', { className: 'tk-ticket-stats' }, metaParts));
      }
    }

    // Screenshots
    if (t.screenshots && t.screenshots.length) {
      const thumbs = t.screenshots.map(src =>
        el('div', { className: 'tk-ticket-screenshot-thumb', onClick: () => openLightbox(src) },
          el('img', { src }),
        )
      );
      parts.push(el('div', { className: 'tk-ticket-screenshots' }, thumbs));
    }

    // Evidence section — shown when advisor-enriched evidence fields are present
    const evidenceEl = this._renderEvidence();
    if (evidenceEl) parts.push(evidenceEl);

    // Links section — dependency and relationship links
    const linksEl = this._renderLinksSection();
    if (linksEl) parts.push(linksEl);

    // Convergence section — "Also flagged by" other personas
    const convergenceEl = this._renderConvergenceSection();
    if (convergenceEl) parts.push(convergenceEl);

    // DK-126: Consensus section — shown on Product-generated tickets with consensusMetadata
    const consensusEl = this._renderConsensusSection();
    if (consensusEl) parts.push(consensusEl);

    // Feedback widget — shown on advisor-generated tickets (any status).
    // Evaluates suggestion quality; semantically separate from accept/reject.
    const feedbackEl = this._renderFeedbackWidget();
    if (feedbackEl) parts.push(feedbackEl);

    // Timeline
    if (t.statusHistory && t.statusHistory.length) {
      const historyItems = t.statusHistory.map(entry => {
        const dotCls = `tk-timeline-dot tk-timeline-dot-${entry.to}`;
        return el('div', { className: 'tk-timeline-item' },
          el('span', { className: dotCls }),
          el('span', { className: 'tk-timeline-status' }, statusLabel(entry.to)),
          entry.from ? el('span', null, ' (from ' + statusLabel(entry.from) + ')') : null,
          el('span', { className: 'tk-timeline-time' }, ' \u2014 ' + (entry.at ? formatDate(entry.at) : '')),
          entry.note ? el('span', { className: 'tk-timeline-note' }, entry.note) : null,
        );
      });

      // Snooze history entries — rendered inline with status timeline
      const snoozeItems = (t.snoozeHistory || []).map(entry => {
        const snoozedAtStr = entry.snoozedAt ? formatDate(entry.snoozedAt) : '?';
        const snoozedUntilStr = entry.snoozedUntil ? formatDate(entry.snoozedUntil) : '?';
        return el('div', { className: 'tk-timeline-item tk-timeline-item-snooze' },
          el('span', { className: 'tk-timeline-dot tk-timeline-dot-snooze' }),
          el('span', { className: 'tk-timeline-status' }, 'Snoozed'),
          el('span', { className: 'tk-timeline-time' }, ` \u2014 ${snoozedAtStr}`),
          el('span', { className: 'tk-timeline-note' }, `Resurfaces ${snoozedUntilStr}`),
        );
      });

      const allTimelineItems = [...historyItems, ...snoozeItems];

      parts.push(el('div', { className: 'tk-timeline' },
        el('div', { className: 'tk-timeline-title' }, 'Status History'),
        el('div', { className: 'tk-timeline-list' }, allTimelineItems),
      ));
    }

    // Implementation notes — inline note input for active tickets
    // Shown for statuses where progress notes are most useful.
    if (this.onAddNote && (t.status === 'open' || t.status === 'in_progress' || t.status === 'blocked')) {
      // Reuse the existing input element so that any text the user has already
      // typed (and keyboard focus) is preserved across Firestore-triggered re-renders.
      if (!this._noteInput) {
        this._noteInput = el('input', {
          className: 'tk-note-input',
          placeholder: 'Add implementation note...',
        });
      }
      const noteInput = this._noteInput;

      const addNoteBtn = el('button', {
        className: 'tk-btn tk-btn-outline tk-btn-sm',
        onClick: async () => {
          const note = noteInput.value.trim();
          if (!note) { this.toast.error('Please enter a note.'); return; }
          addNoteBtn.disabled = true;
          addNoteBtn.textContent = 'Adding...';
          try {
            await this.onAddNote(t.id, note);
            noteInput.value = '';
            this.toast.success('Note added.');
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          } finally {
            addNoteBtn.disabled = false;
            addNoteBtn.textContent = 'Add Note';
          }
        },
      }, 'Add Note');

      parts.push(el('div', { className: 'tk-add-note-section' },
        noteInput,
        addNoteBtn,
      ));
    }

    // Waiting for user -- question + answer
    if (t.status === 'waiting_for_user' && t.pendingQuestion) {
      // Reuse the existing textarea so the user's in-progress answer and focus
      // are not lost when a Firestore update triggers a re-render.
      if (!this._answerTextarea) {
        this._answerTextarea = el('textarea', {
          className: 'tk-answer-textarea',
          placeholder: 'Type your answer...',
        });
      }
      const textarea = this._answerTextarea;

      const submitAnswer = el('button', {
        className: 'tk-btn tk-btn-primary tk-btn-sm',
        onClick: async () => {
          const answer = textarea.value.trim();
          if (!answer) { this.toast.error('Please enter an answer.'); return; }
          submitAnswer.disabled = true;
          submitAnswer.classList.add('tk-btn-loading');
          submitAnswer.textContent = 'Submitting...';
          try {
            await this.onAnswer(t.id, answer);
            this.toast.success('Answer submitted.');
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          } finally {
            submitAnswer.disabled = false;
            submitAnswer.classList.remove('tk-btn-loading');
            submitAnswer.textContent = 'Submit Answer';
          }
        },
      }, 'Submit Answer');

      parts.push(el('div', { className: 'tk-question-section' },
        el('div', { className: 'tk-question-label' }, 'Pending Question'),
        el('div', { className: 'tk-question-text' }, t.pendingQuestion),
        textarea,
        submitAnswer,
      ));
    }

    // Reasoning section — shown on proposed tickets (collapsed by default)
    // Positioned below description and above the sticky bottom actions so the primary
    // CTA (approve/reject) stays above the fold. Rendered before actions are prepended.
    if (t.status === 'proposed') {
      const reasoningEl = this._renderReasoning();
      if (reasoningEl) parts.push(reasoningEl);
    }

    // Suppression notice — shown on proposed tickets that match previously rejected proposals
    if (t.status === 'proposed' && t.suppressedCount > 0) {
      const noun = t.suppressedCount === 1 ? 'time' : 'times';
      parts.unshift(el('div', {
        className: 'tk-suppressed-notice',
        role: 'note',
        'aria-label': `Similar proposals have been suppressed ${t.suppressedCount} ${noun}`,
      }, `Similar proposals have been suppressed ${t.suppressedCount} ${noun}.`));
    }

    // Actions — for proposed and done tickets show at the top so primary actions are immediately visible
    const actions = this._renderActions();
    if (actions) {
      if (t.status === 'proposed' || t.status === 'done') {
        parts.unshift(actions);
        // Sticky bottom actions — duplicate below reasoning so users don't scroll back up
        // after reading evidence. Only added when reasoning is present.
        if (t.status === 'proposed' && t.reasoning && t.reasoning.summary) {
          parts.push(this._renderActions());
        }
      } else {
        parts.push(actions);
      }
    }

    return el('div', { className: 'tk-ticket-detail' }, parts);
  }

  // ── Rejection popover ───────────────────────────────────────────────────

  /**
   * Render the "Not relevant" button that triggers the rejection popover.
   * @param {object} t - ticket
   * @returns {HTMLElement} container with button and popover slot
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
  _renderEvidenceBadge(t) {
    const reasoning = t.reasoning;
    if (!reasoning) return null;

    // Determine badge label from evidence array
    const evidence = Array.isArray(reasoning.evidence) ? reasoning.evidence : [];
    const hasFile = evidence.some(e => e.type === 'file');
    const hasScreenshot = evidence.some(e => e.type === 'screenshot');

    let label, cssClass;
    if (hasFile && hasScreenshot) {
      label = 'file + screenshot';
      cssClass = 'tk-evidence-badge tk-evidence-badge-mixed';
    } else if (hasFile) {
      label = 'file cited';
      cssClass = 'tk-evidence-badge tk-evidence-badge-file';
    } else if (hasScreenshot) {
      label = 'screenshot attached';
      cssClass = 'tk-evidence-badge tk-evidence-badge-screenshot';
    } else {
      label = 'reasoning only';
      cssClass = 'tk-evidence-badge tk-evidence-badge-summary';
    }

    return el('span', {
      className: cssClass,
      'aria-label': `Evidence type: ${label}`,
      title: `Evidence type: ${label}`,
    }, label);
  }

  // ── Cluster tags ──────────────────────────────────────────────────────────

  /**
   * Render inline cluster tags for a ticket.
   * Tags are shown on proposed and open tickets that have clusterIds.
   * Each tag is a button that filters the list by that cluster.
   * A "new theme" indicator is shown on clusters created at the same time
   * as this ticket (i.e. this ticket was the first in the cluster).
   *
   * Returns null if the ticket has no clusters or clusters data is empty.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */
  _renderClusterTags(t) {
    const ids = Array.isArray(t.clusterIds) ? t.clusterIds : [];
    if (ids.length === 0) return null;
    if (!this.clusters || this.clusters.size === 0) return null;

    const tags = [];
    for (const cid of ids) {
      const cluster = this.clusters.get(cid);
      if (!cluster) continue;

      const label = cluster.label || 'Uncategorized';
      const count = cluster.ticketCount || 0;
      const isNew = cluster.ticketCount === 1; // this ticket was first in this cluster

      // Accessible label: "Filter by cluster: Auth, 7 tickets"
      const ariaLabel = `Filter by cluster: ${label}, ${count} ${count === 1 ? 'ticket' : 'tickets'}`;

      const tag = el('button', {
        type: 'button',
        className: 'tk-cluster-tag' + (isNew ? ' tk-cluster-tag-new' : ''),
        'aria-label': ariaLabel,
        title: ariaLabel,
        tabindex: '0',
        onClick: (e) => {
          e.stopPropagation(); // don't toggle ticket expansion
          if (this.onClusterFilter) this.onClusterFilter(cid);
        },
      },
        el('span', { className: 'tk-cluster-tag-label' }, label),
        el('span', { className: 'tk-cluster-tag-count', 'aria-hidden': 'true' }, String(count)),
        isNew ? el('span', { className: 'tk-cluster-tag-new-indicator', 'aria-label': 'New theme' }, '★') : null,
      );

      tags.push(tag);
    }

    if (tags.length === 0) return null;

    return el('div', { className: 'tk-cluster-tags', 'aria-label': 'Theme clusters' }, tags);
  }

  // ── Links badge (card-level) ──────────────────────────────────────────────

  /**
   * Render a compact relationship badge on the card header.
   * Shows "blocked by N", "blocks N", "N related", "N follow-up" counts.
   * Returns null if the ticket has no links.
   *
   * The badge is keyboard-accessible: Enter/Space opens the detail expand.
   * Color is not used as the sole differentiator — text labels are present.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */
  _renderLinksBadge(t) {
    const links = Array.isArray(t.links) ? t.links : [];
    if (links.length === 0) return null;

    // Tally by type
    const counts = { blocks: 0, related: 0, 'follow-up': 0 };
    for (const link of links) {
      if (link.type && counts[link.type] !== undefined) counts[link.type]++;
    }

    const parts = [];
    if (counts.blocks > 0) {
      parts.push(el('span', { className: 'tk-links-badge-part tk-links-badge-blocks' },
        `blocks ${counts.blocks}`
      ));
    }
    if (counts.related > 0) {
      parts.push(el('span', { className: 'tk-links-badge-part tk-links-badge-related' },
        `${counts.related} related`
      ));
    }
    if (counts['follow-up'] > 0) {
      parts.push(el('span', { className: 'tk-links-badge-part tk-links-badge-followup' },
        `${counts['follow-up']} follow-up`
      ));
    }

    if (parts.length === 0) return null;

    const ariaLabel = `Linked: ${parts.map(p => p.textContent).join(', ')}`;
    return el('span', {
      className: 'tk-links-badge',
      'aria-label': ariaLabel,
      title: ariaLabel,
    }, ...parts);
  }

  // ── Convergence badge (card-level) ───────────────────────────────────────

  /**
   * Render a convergence badge when 2+ personas independently flagged the same area.
   * Shows "N personas" as text — count is always part of the visible label.
   * Only shown when convergenceCount >= 2.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */
  _renderConvergenceBadge(t) {
    const count = typeof t.convergenceCount === 'number' ? t.convergenceCount : 0;
    if (count < 1) return null;
    // convergenceCount is the number of *other* tickets that converge, so total personas = count + 1
    const totalPersonas = count + 1;
    if (totalPersonas < 2) return null;
    const label = `${totalPersonas} personas`;
    return el('span', {
      className: 'tk-convergence-badge',
      'aria-label': `Also flagged by ${count} other persona${count === 1 ? '' : 's'}`,
      title: `Also flagged by ${count} other persona${count === 1 ? '' : 's'}`,
    }, label);
  }

  // ── Convergence section (detail view) ────────────────────────────────────

  /**
   * Render the "Also flagged by" collapsible section in the ticket detail view.
   * Shows sibling tickets from other personas that independently flagged the same area.
   * Each entry links to the sibling ticket and shows the persona + brief description.
   * Only rendered when convergence array has at least one entry.
   *
   * Section is keyboard-navigable via native <details>/<summary> elements.
   * aria-expanded is kept in sync on toggle for screen readers.
   *
   * @returns {HTMLElement|null}
   */
  _renderConvergenceSection() {
    const t = this.ticket;
    const convergence = Array.isArray(t.convergence) ? t.convergence : [];
    if (convergence.length === 0) return null;

    const self = this;
    const contentId = `tk-convergence-content-${t.id || t.ticketId}`;

    const items = convergence.map(entry => {
      const sibling = this.allTickets ? this.allTickets.find(tk => tk.id === entry.ticketId) : null;
      const displayId = sibling ? (sibling.ticketId || entry.ticketId) : entry.ticketId;
      const summary = entry.summary || '';

      const idEl = el('span', { className: 'tk-convergence-item-id' }, displayId);
      const summaryEl = el('span', { className: 'tk-convergence-item-summary' }, summary);

      // Link to the sibling ticket — fires a custom event that the host app can handle
      // to scroll/expand the sibling ticket. Falls back to no-op if not handled.
      const linkEl = el('a', {
        className: 'tk-convergence-item-link',
        href: '#',
        'aria-label': `View ticket ${displayId}: ${summary}`,
        onClick: (e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('docket:open-ticket', {
            detail: { ticketId: entry.ticketId },
            bubbles: true,
          }));
        },
      }, idEl);

      return el('li', {
        className: 'tk-convergence-item',
        role: 'listitem',
      }, linkEl, summaryEl);
    });

    const contentEl = el('div', {
      className: 'tk-convergence-content' + (this._convergenceExpanded ? ' tk-convergence-content-open' : ''),
      id: contentId,
    },
      el('ul', {
        className: 'tk-convergence-list',
        role: 'list',
        'aria-label': 'Also flagged by other personas',
      }, ...items),
    );

    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-convergence-toggle',
      'aria-expanded': String(!!this._convergenceExpanded),
      'aria-controls': contentId,
      onClick: () => {
        self._convergenceExpanded = !self._convergenceExpanded;
        toggleBtn.setAttribute('aria-expanded', String(self._convergenceExpanded));
        if (self._convergenceExpanded) {
          contentEl.classList.add('tk-convergence-content-open');
          toggleBtn.querySelector('.tk-convergence-toggle-icon').textContent = '▾';
        } else {
          contentEl.classList.remove('tk-convergence-content-open');
          toggleBtn.querySelector('.tk-convergence-toggle-icon').textContent = '▸';
        }
      },
    },
      el('span', { className: 'tk-convergence-toggle-icon', 'aria-hidden': 'true' },
        this._convergenceExpanded ? '▾' : '▸',
      ),
      `Also flagged by (${convergence.length})`,
    );

    return el('div', { className: 'tk-convergence-section' },
      toggleBtn,
      contentEl,
    );
  }

  // ── Consensus badge + section (DK-126) ──────────────────────────────────

  /**
   * Derive consensus state from a ticket's consensusMetadata.
   * Returns 'agree' | 'partial' | 'split' | null (if no metadata).
   *
   * - agree: both design and engineer approved
   * - split: both flagged
   * - partial: one approved, one flagged
   *
   * @param {object} t - ticket
   * @returns {'agree'|'partial'|'split'|null}
   */
  _getConsensusState(t) {
    const cm = t.consensusMetadata;
    if (!cm || typeof cm !== 'object') return null;
    const dv = cm.design && cm.design.verdict;
    const ev = cm.engineer && cm.engineer.verdict;
    if (!dv || !ev) return null;
    if (dv === 'approved' && ev === 'approved') return 'agree';
    if (dv === 'flagged' && ev === 'flagged') return 'split';
    return 'partial';
  }

  /**
   * Render a consensus badge for the ticket card header.
   * Three states: full agreement (✓), partial (△), split (✗).
   * Uses both color AND text/icon so color-blind users can distinguish.
   * Returns null if no consensusMetadata is present.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */
  _renderConsensusBadge(t) {
    const state = this._getConsensusState(t);
    if (!state) return null;

    const config = {
      agree:   { icon: '✓', label: 'agreed', cls: 'tk-consensus-agree',   title: 'Design + Engineer both approved' },
      partial: { icon: '△', label: 'partial', cls: 'tk-consensus-partial', title: 'Design + Engineer partially agreed' },
      split:   { icon: '✗', label: 'split',   cls: 'tk-consensus-split',   title: 'Design + Engineer disagreed' },
    }[state];

    const ariaLabel = `Consensus: ${config.title}`;
    return el('span', {
      className: `tk-consensus-badge ${config.cls}`,
      'aria-label': ariaLabel,
      title: config.title,
    },
      el('i', { className: 'tk-consensus-badge-icon', 'aria-hidden': 'true' }, config.icon),
      ` ${config.label}`,
    );
  }

  /**
   * Render the collapsible "Show consensus" disclosure accordion for the ticket
   * detail view. Collapsed by default. Only shown when consensusMetadata is present.
   *
   * Accessibility:
   *  - toggle button uses aria-expanded + aria-controls
   *  - on expand, focus is moved into the content area
   *  - persona rows use standard contrast and font-size (not fine print)
   *
   * @returns {HTMLElement|null}
   */
  _renderConsensusSection() {
    const t = this.ticket;
    const cm = t.consensusMetadata;
    if (!cm || typeof cm !== 'object') return null;

    // Require at least one persona entry
    const hasDesign = cm.design && cm.design.verdict;
    const hasEngineer = cm.engineer && cm.engineer.verdict;
    if (!hasDesign && !hasEngineer) return null;

    const self = this;
    const contentId = `tk-consensus-content-${t.id || t.ticketId}`;
    const DISPLAY_CAP = 160; // truncate summaries in the UI at this length

    function renderPersonaRow(personaKey, entry) {
      if (!entry || !entry.verdict) return null;
      const verdict = entry.verdict === 'flagged' ? 'flagged' : 'approved';
      const summaryRaw = (typeof entry.summary === 'string') ? entry.summary : '';
      const truncated = summaryRaw.length > DISPLAY_CAP;
      const displaySummary = truncated ? summaryRaw.slice(0, DISPLAY_CAP).trimEnd() + '…' : summaryRaw;

      const verdictEl = el('span', {
        className: `tk-consensus-verdict tk-verdict-${verdict}`,
      },
        verdict === 'approved' ? '✓ approved' : '✗ flagged',
      );

      const summaryEl = el('p', { className: 'tk-consensus-summary' }, displaySummary);

      // "Read more" expand for long summaries — replaces text in place
      let readMoreBtn = null;
      if (truncated) {
        readMoreBtn = el('button', {
          type: 'button',
          className: 'tk-consensus-read-more',
          'aria-label': `Show full ${personaKey} review`,
          onClick: () => {
            summaryEl.textContent = summaryRaw;
            readMoreBtn.remove();
          },
        }, 'read more');
      }

      return el('div', {
        className: 'tk-consensus-persona-row',
        role: 'listitem',
      },
        el('div', { className: 'tk-consensus-persona-header' },
          el('span', { className: 'tk-consensus-persona-name' }, personaKey),
          verdictEl,
        ),
        summaryEl,
        readMoreBtn,
      );
    }

    const personaRows = [];
    // Spec orders: Engineer, Design
    if (hasEngineer) {
      const row = renderPersonaRow('Engineer', cm.engineer);
      if (row) personaRows.push(row);
    }
    if (hasDesign) {
      const row = renderPersonaRow('Design', cm.design);
      if (row) personaRows.push(row);
    }
    if (personaRows.length === 0) return null;

    // Split + proposed callout: if split and ticket is proposed, add a note
    const state = this._getConsensusState(t);
    let splitNote = null;
    if (state === 'split' && t.status === 'proposed') {
      splitNote = el('p', { className: 'tk-consensus-framing' },
        'Split consensus does not gate ticket creation — it informs your review. Accept or reject based on your own judgment.',
      );
    }

    const contentEl = el('div', {
      className: 'tk-consensus-content' + (this._consensusExpanded ? ' tk-consensus-content-open' : ''),
      id: contentId,
      // tab index so focus can be moved here on expand
      tabIndex: -1,
    },
      el('p', { className: 'tk-consensus-framing' },
        'Personas may disagree — this reflects healthy review, not a system error.',
      ),
      splitNote,
      el('div', {
        className: 'tk-consensus-personas',
        role: 'list',
        'aria-label': 'Persona verdicts',
      }, ...personaRows),
    );

    const toggleLabel = this._consensusExpanded ? '▾' : '▸';
    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-consensus-toggle',
      'aria-expanded': String(!!this._consensusExpanded),
      'aria-controls': contentId,
      onClick: () => {
        self._consensusExpanded = !self._consensusExpanded;
        toggleBtn.setAttribute('aria-expanded', String(self._consensusExpanded));
        const iconEl = toggleBtn.querySelector('.tk-consensus-toggle-icon');
        if (self._consensusExpanded) {
          contentEl.classList.add('tk-consensus-content-open');
          if (iconEl) iconEl.textContent = '▾';
          // Move focus into content on open so screen reader users aren't stranded
          contentEl.focus();
        } else {
          contentEl.classList.remove('tk-consensus-content-open');
          if (iconEl) iconEl.textContent = '▸';
        }
      },
    },
      el('span', { className: 'tk-consensus-toggle-icon', 'aria-hidden': 'true' }, toggleLabel),
      ' Show consensus',
    );

    return el('div', { className: 'tk-consensus-section' },
      toggleBtn,
      contentEl,
    );
  }

  // ── Reasoning section ────────────────────────────────────────────────────

  /**
   * Render the "Why was this proposed?" <details> accordion for proposed tickets.
   * Collapsed by default — uses a native <details>/<summary> element for
   * accessibility (screen reader support without JavaScript).
   *
   * Returns null if there is no reasoning on the ticket.
   *
   * @returns {HTMLElement|null}
   */
  _renderReasoning() {
    const t = this.ticket;
    const reasoning = t.reasoning;

    // If reasoning is missing or has no summary, show the empty state note
    // (per spec: "Do not show an empty accordion — that erodes trust faster
    // than omitting the section.")
    if (!reasoning || !reasoning.summary) return null;

    const evidence = Array.isArray(reasoning.evidence) ? reasoning.evidence : [];

    // Build the inner content
    const contentParts = [];

    // Lead with summary sentence
    contentParts.push(el('p', { className: 'tk-reasoning-summary' }, reasoning.summary));

    if (evidence.length === 0) {
      // Empty state — no evidence attached
      contentParts.push(el('p', { className: 'tk-reasoning-empty' },
        'File reference unavailable — review manually.'
      ));
    } else {
      for (const entry of evidence) {
        if (entry.type === 'file') {
          contentParts.push(this._renderReasoningFileEvidence(entry));
        } else if (entry.type === 'screenshot') {
          contentParts.push(this._renderReasoningScreenshotEvidence(entry));
        }
      }
    }

    // Build <details>/<summary> for native disclosure behavior
    const details = document.createElement('details');
    details.className = 'tk-reasoning';

    const summary = document.createElement('summary');
    summary.className = 'tk-reasoning-summary-toggle';
    summary.textContent = 'Why was this proposed?';
    details.appendChild(summary);

    const body = el('div', { className: 'tk-reasoning-body' }, contentParts);
    details.appendChild(body);

    return details;
  }

  /**
   * Render a file evidence entry within the reasoning section.
   * Shows: "Engineer finding" label + file path:lineRange + code context note.
   *
   * @param {{ type: 'file', path: string, lineStart?: number, lineEnd?: number, note: string }} entry
   * @returns {HTMLElement}
   */
  _renderReasoningFileEvidence(entry) {
    const lineRange = entry.lineStart != null
      ? (entry.lineEnd != null && entry.lineEnd !== entry.lineStart
          ? `${entry.path}:${entry.lineStart}–${entry.lineEnd}`
          : `${entry.path}:${entry.lineStart}`)
      : entry.path;

    const ariaLabel = entry.lineStart != null
      ? `Engineer finding: ${entry.path}, lines ${entry.lineStart}${entry.lineEnd && entry.lineEnd !== entry.lineStart ? ' to ' + entry.lineEnd : ''}`
      : `Engineer finding: ${entry.path}`;

    return el('div', { className: 'tk-reasoning-evidence tk-reasoning-evidence-file' },
      el('div', { className: 'tk-reasoning-evidence-label' }, 'Engineer finding'),
      el('pre', { className: 'tk-reasoning-code', role: 'region', 'aria-label': ariaLabel },
        el('code', null, lineRange),
      ),
      entry.note ? el('p', { className: 'tk-reasoning-note' }, entry.note) : null,
    );
  }

  /**
   * Render a screenshot evidence entry within the reasoning section.
   * Shows: "Flagged region" label + capturedAt timestamp + note.
   * The screenshot image is not displayed here (it lives in the Evidence section);
   * this entry surfaces the metadata that helps users understand the flagged region.
   *
   * @param {{ type: 'screenshot', storageRef: string, capturedAt: string, note: string }} entry
   * @returns {HTMLElement}
   */
  _renderReasoningScreenshotEvidence(entry) {
    const capturedLabel = entry.capturedAt
      ? `Captured: ${formatDate(entry.capturedAt)}`
      : null;

    return el('div', { className: 'tk-reasoning-evidence tk-reasoning-evidence-screenshot' },
      el('div', { className: 'tk-reasoning-evidence-label' }, 'Design finding'),
      capturedLabel ? el('div', { className: 'tk-reasoning-captured-at' }, capturedLabel) : null,
      entry.note ? el('p', { className: 'tk-reasoning-note' }, entry.note) : null,
    );
  }

  // ── Feedback widget ─────────────────────────────────────────────────────

  /**
   * Render the thumbs up/down feedback widget for advisor-generated tickets.
   * Only shown when the ticket has an advisorPersona field and onFeedback is set.
   *
   * Behavior:
   *  - Muted/ghost style by default, visible on hover (CSS handles this).
   *  - Single click to rate — no confirmation dialog.
   *  - After rating, show the selected state with fill + aria update.
   *  - First-use nudge: one-time inline message shown after first rating.
   *  - Semantically distinct from accept/reject — evaluates quality, not disposition.
   *
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
  _renderEvidence() {
    const t = this.ticket;
    const hasFileRefs = Array.isArray(t.fileRefs) && t.fileRefs.length > 0;
    const hasScreenshot = t.screenshot && t.screenshot.storageUrl;
    const hasRelatedTickets = Array.isArray(t.relatedTicketIds) && t.relatedTicketIds.length > 0;

    if (!hasFileRefs && !hasScreenshot && !hasRelatedTickets) return null;

    const self = this;

    // Staleness warning — if commitSha present and repoBaseUrl configured,
    // surface a note that references are pinned to a specific commit.
    const firstRef = hasFileRefs ? t.fileRefs[0] : null;
    const pinnedSha = firstRef && firstRef.commitSha ? firstRef.commitSha : null;

    // Build the inner content of the evidence panel
    const contentEl = el('div', {
      className: 'tk-evidence-content',
      id: `tk-evidence-content-${t.id || t.ticketId}`,
    });

    // Staleness notice
    if (pinnedSha) {
      contentEl.appendChild(el('div', {
        className: 'tk-evidence-staleness',
        role: 'note',
      }, `References generated at ${pinnedSha.slice(0, 8)} — file may have changed.`));
    }

    // ── File refs subsection ──────────────────────────────────────────────
    if (hasFileRefs) {
      const DISPLAY_CAP = 5;
      const refs = t.fileRefs;
      const displayed = refs.slice(0, DISPLAY_CAP);
      const hiddenCount = refs.length - displayed.length;

      const refEls = displayed.map(ref => this._renderFileRef(ref));

      const refsContainer = el('div', { className: 'tk-evidence-file-refs' }, refEls);

      // "Show N more" affordance
      if (hiddenCount > 0) {
        const showMoreBtn = el('button', {
          className: 'tk-evidence-show-more',
          type: 'button',
          onClick: () => {
            // Render remaining refs and remove the button
            refs.slice(DISPLAY_CAP).forEach(ref => {
              refsContainer.insertBefore(this._renderFileRef(ref), showMoreBtn);
            });
            showMoreBtn.remove();
          },
        }, `Show ${hiddenCount} more\u2026`);
        refsContainer.appendChild(showMoreBtn);
      }

      contentEl.appendChild(el('div', { className: 'tk-evidence-section' },
        el('div', { className: 'tk-evidence-section-label' }, 'File References'),
        refsContainer,
      ));
    }

    // ── Screenshot subsection ─────────────────────────────────────────────
    if (hasScreenshot) {
      const shot = t.screenshot;
      // storageUrl is gs:// — we can't directly render it in an <img>.
      // We render the screenshot container with an appropriate message when
      // the URL is a gs:// Storage path (requires signed URL to display).
      // If a downloadUrl (https://) is present, use that.
      const displayUrl = shot.downloadUrl || null;
      const screenshotSection = this._renderScreenshotSection(shot, displayUrl);
      contentEl.appendChild(screenshotSection);
    }

    // ── Related tickets subsection ────────────────────────────────────────
    if (hasRelatedTickets) {
      const relatedEls = t.relatedTicketIds.map(rid => {
        const related = this.allTickets.find(tk => tk.id === rid);
        if (!related) return null;
        const statusCls = `tk-ticket-status tk-ticket-status-${related.status}`;
        return el('span', { className: 'tk-evidence-related-item' },
          el('a', {
            className: 'tk-evidence-related-link',
            href: '#',
            onClick: (e) => { e.preventDefault(); },
            'aria-label': `Related ticket: ${related.ticketId || rid} — ${related.title || ''}`,
          },
            el('span', { className: 'tk-evidence-related-id' }, related.ticketId || rid),
          ),
          related.status ? el('span', { className: statusCls }, related.status) : null,
        );
      }).filter(Boolean);

      if (relatedEls.length > 0) {
        contentEl.appendChild(el('div', { className: 'tk-evidence-section' },
          el('div', { className: 'tk-evidence-section-label' }, 'See Also'),
          el('div', { className: 'tk-evidence-related-list', role: 'list' }, relatedEls),
        ));
      }
    }

    // ── Disclosure toggle button ──────────────────────────────────────────
    const panelId = `tk-evidence-content-${t.id || t.ticketId}`;
    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-evidence-toggle',
      'aria-expanded': String(self._evidenceExpanded),
      'aria-controls': panelId,
      onClick: () => {
        self._evidenceExpanded = !self._evidenceExpanded;
        toggleBtn.setAttribute('aria-expanded', String(self._evidenceExpanded));
        if (self._evidenceExpanded) {
          contentEl.classList.add('tk-evidence-content-open');
          toggleBtn.querySelector('.tk-evidence-toggle-icon').textContent = '▾';
        } else {
          contentEl.classList.remove('tk-evidence-content-open');
          toggleBtn.querySelector('.tk-evidence-toggle-icon').textContent = '▸';
        }
      },
    },
      el('span', { className: 'tk-evidence-toggle-icon' }, self._evidenceExpanded ? '▾' : '▸'),
      ' Evidence',
    );

    // Apply initial expanded state
    if (self._evidenceExpanded) {
      contentEl.classList.add('tk-evidence-content-open');
    }

    return el('div', { className: 'tk-evidence' },
      toggleBtn,
      contentEl,
    );
  }

  /**
   * Render a single file reference chip.
   * @param {{ path: string, lineStart?: number, lineEnd?: number, commitSha?: string }} ref
   */
  _renderFileRef(ref) {
    const label = ref.lineStart != null
      ? `${ref.path}:${ref.lineStart}`
      : ref.path;
    const fullLabel = ref.lineEnd != null && ref.lineEnd !== ref.lineStart
      ? `${ref.path}:${ref.lineStart}-${ref.lineEnd}`
      : label;

    const ariaLabel = ref.lineStart != null
      ? `File reference: ${ref.path}, line ${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? ` to ${ref.lineEnd}` : ''}`
      : `File reference: ${ref.path}`;

    // Build link URL if repoBaseUrl is set
    let linkUrl = null;
    if (this.repoBaseUrl && ref.commitSha) {
      const sha = ref.commitSha;
      const lineHash = ref.lineStart != null ? `#L${ref.lineStart}` : '';
      linkUrl = `${this.repoBaseUrl}/blob/${sha}/${ref.path}${lineHash}`;
    }

    const chipInner = linkUrl
      ? el('a', {
          href: linkUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'tk-file-ref-link',
          'aria-label': ariaLabel,
          title: fullLabel,
        }, label)
      : el('span', {
          className: 'tk-file-ref-text',
          title: fullLabel,
          'aria-label': ariaLabel,
        }, label);

    // Copy-to-clipboard button
    const copyBtn = el('button', {
      type: 'button',
      className: 'tk-file-ref-copy',
      'aria-label': `Copy path: ${fullLabel}`,
      title: 'Copy to clipboard',
      onClick: (e) => {
        e.stopPropagation();
        navigator.clipboard && navigator.clipboard.writeText(fullLabel).catch(() => {});
      },
    }, '\uD83D\uDCCB');

    return el('span', { className: 'tk-file-ref-chip', role: 'listitem' },
      chipInner,
      copyBtn,
    );
  }

  /**
   * Render the screenshot panel with bounding box annotations.
   * @param {{ storageUrl: string, capturedAt?: string, annotations?: Array, downloadUrl?: string }} shot
   * @param {string|null} displayUrl
   */
  _renderScreenshotSection(shot, displayUrl) {
    const annotations = Array.isArray(shot.annotations) ? shot.annotations : [];

    let screenshotContent;
    if (displayUrl) {
      // Build alt text describing what is flagged
      const altAnnotations = annotations.map(a => a.label).filter(Boolean).join('; ');
      const altText = altAnnotations
        ? `Screenshot with annotations: ${altAnnotations}`
        : 'Captured screenshot';

      // Wrapper for image + annotation overlays
      const imgWrapper = el('div', { className: 'tk-screenshot-annotated' });

      const img = el('img', {
        src: displayUrl,
        alt: altText,
        className: 'tk-screenshot-img',
        onClick: () => this._openAnnotatedLightbox(displayUrl, annotations, altText),
      });
      imgWrapper.appendChild(img);

      // Render bounding box overlays
      for (const ann of annotations) {
        if (
          typeof ann.x !== 'number' || typeof ann.y !== 'number' ||
          typeof ann.width !== 'number' || typeof ann.height !== 'number'
        ) continue;

        const overlay = el('div', {
          className: 'tk-annotation-box',
          style: {
            left: ann.x + 'px',
            top: ann.y + 'px',
            width: ann.width + 'px',
            height: ann.height + 'px',
          },
          'aria-label': ann.label || 'annotation',
        });

        if (ann.label) {
          overlay.appendChild(el('span', { className: 'tk-annotation-label' }, ann.label));
        }

        imgWrapper.appendChild(overlay);
      }

      screenshotContent = imgWrapper;
    } else {
      // gs:// URL — cannot display directly; show a note
      screenshotContent = el('div', { className: 'tk-screenshot-storage-note' },
        'Screenshot stored in Firebase Storage. ',
        el('span', { className: 'tk-screenshot-storage-path' }, shot.storageUrl || ''),
      );
    }

    return el('div', { className: 'tk-evidence-section' },
      el('div', { className: 'tk-evidence-section-label' }, 'Screenshot'),
      screenshotContent,
    );
  }

  /**
   * Open a lightbox with annotation overlays rendered on top of the image.
   */
  _openAnnotatedLightbox(src, annotations, altText) {
    const overlay = el('div', {
      className: 'tk-lightbox',
      onClick: () => overlay.remove(),
    });

    const closeBtn = el('button', {
      className: 'tk-lightbox-close',
      'aria-label': 'Close lightbox',
      onClick: (e) => { e.stopPropagation(); overlay.remove(); },
    }, '\u00D7');

    // Image + annotation wrapper
    const imgWrapper = el('div', {
      className: 'tk-screenshot-annotated tk-lightbox-annotated',
      onClick: (e) => e.stopPropagation(),
    });

    const img = el('img', { src, alt: altText || 'Screenshot' });
    imgWrapper.appendChild(img);

    for (const ann of annotations) {
      if (
        typeof ann.x !== 'number' || typeof ann.y !== 'number' ||
        typeof ann.width !== 'number' || typeof ann.height !== 'number'
      ) continue;

      const box = el('div', {
        className: 'tk-annotation-box',
        style: {
          left: ann.x + 'px',
          top: ann.y + 'px',
          width: ann.width + 'px',
          height: ann.height + 'px',
        },
        'aria-label': ann.label || 'annotation',
      });

      if (ann.label) {
        box.appendChild(el('span', { className: 'tk-annotation-label' }, ann.label));
      }

      imgWrapper.appendChild(box);
    }

    overlay.appendChild(closeBtn);
    overlay.appendChild(imgWrapper);
    document.body.appendChild(overlay);
  }

  // ── Links section (detail view) ──────────────────────────────────────────

  /**
   * Render the "Links" section in the detail view.
   * Shows flat "must happen before / can happen after" lists.
   * Returns null if the ticket has no outgoing links.
   *
   * @returns {HTMLElement|null}
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
