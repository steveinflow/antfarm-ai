// @docket/admin-panel — TicketItem body mixin: detail content (description, evidence, reasoning, screenshots)
//
// Mixed into TicketItem.prototype via Object.assign in index.js.

import { el } from '../../el.js';
import { openLightbox } from '../../lightbox.js';
import { formatDate, formatDuration, formatCost } from '../../format.js';

export const bodyMixin = {
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
   */,

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
   */,

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
   */,

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
   */,

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
   */,

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
   */,

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
   */,

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
   */,

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
   */,

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
   */,

};
