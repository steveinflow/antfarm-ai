// Dry-run / Preview Run — proposal generation, card rendering, backlog flags.
// Triggered from a persona card; writes to /advisor-dry-runs and subscribes
// for results. Renders proposal cards with backlog dedup flags and the
// reject-with-note dialog.

import { el } from '../ui/el.js';
import { showConfirmModal } from '../../confirm-modal.js';

export const dryRunMixin = {
  // ── Dry-run / Preview Run ────────────────────────────────────────────────

  /**
   * Start a dry-run for a persona. Writes a request doc to /advisor-dry-runs
   * and subscribes to it with onSnapshot to receive results.
   */
  async _startDryRun(id, label) {
    const user = this._currentUser;
    if (!user) {
      alert('You must be signed in to use Preview Run.');
      return;
    }

    const panels = this._dryRunPanels[id];
    if (!panels) return;

    // Warn about unsaved config changes (can't detect them easily without diff —
    // surface a general hint instead)
    const { panel, statusBar, proposalList, heading, promoteAllBtn, previewRunBtn } = panels;

    // Disable button during run
    previewRunBtn.disabled = true;

    // Show panel and set initial status
    panel.classList.remove('adv-hidden');
    proposalList.innerHTML = '';
    promoteAllBtn.classList.add('adv-hidden');
    this._setDryRunStatus(id, `Running ${label} persona preview…`);

    // Move keyboard focus to panel heading
    setTimeout(() => heading.focus(), 50);

    // Cancel any previous subscription for this persona
    this._cancelDryRunSubscription(id);

    try {
      // Write request doc to Firestore
      // Use firebase global (compat SDK) for FieldValue.serverTimestamp()
      const _firebase = window.firebase;
      const _serverTimestamp = _firebase?.firestore?.FieldValue?.serverTimestamp
        ? _firebase.firestore.FieldValue.serverTimestamp()
        : new Date();

      const docRef = await this.db.collection('advisor-dry-runs').add({
        personaId: id,
        userId: user.uid,
        projectId: this._filterProjectId || null,
        status: 'pending',
        createdAt: _serverTimestamp,
      });
      this._dryRunDocIds[id] = docRef.id;

      // Subscribe to doc for results
      const unsub = docRef.onSnapshot((snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        this._onDryRunUpdate(id, label, data);
      }, (err) => {
        console.error(`AdvisorPanel: dry-run listener error for ${id}:`, err);
        this._setDryRunStatus(id, `Run failed — ${err.message}`);
        if (panels.previewRunBtn) panels.previewRunBtn.disabled = false;
      });
      this._dryRunUnsubs[id] = unsub;

    } catch (err) {
      console.error('AdvisorPanel: failed to start dry run:', err);
      this._setDryRunStatus(id, `Run failed — ${err.message}`);
      previewRunBtn.disabled = false;
    }
  },

  /** Handle a snapshot update on a dry-run doc. */
  _onDryRunUpdate(id, label, data) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    const { statusBar, proposalList, promoteAllBtn, previewRunBtn } = panels;

    const { status, proposals, error, statusMessage } = data;

    if (status === 'running') {
      const msg = statusMessage
        ? `Running ${label} persona… ${statusMessage}`
        : `Running ${label} persona…`;
      this._setDryRunStatus(id, msg);
      return;
    }

    if (status === 'error') {
      this._setDryRunStatus(id, `Run failed — ${error || 'unknown error'}`);
      if (previewRunBtn) previewRunBtn.disabled = false;
      this._cancelDryRunSubscription(id);
      return;
    }

    if (status === 'done') {
      const allProposals = Array.isArray(proposals) ? proposals : [];
      const realCount  = allProposals.filter(p => !p.deduped).length;
      const dedupCount = allProposals.filter(p => p.deduped).length;
      let statusMsg = `Preview ready — ${realCount} proposal${realCount !== 1 ? 's' : ''} found.`;
      if (dedupCount > 0) statusMsg += ` (${dedupCount} would be deduped)`;
      this._setDryRunStatus(id, statusMsg);

      this._dryRunProposals[id] = allProposals;
      this._renderDryRunProposals(id, label, allProposals);

      if (realCount > 1) {
        promoteAllBtn.classList.remove('adv-hidden');
        promoteAllBtn.textContent = `Promote all (${realCount})`;
        promoteAllBtn.setAttribute('aria-label', `Promote all ${realCount} proposals to real tickets`);
      } else {
        promoteAllBtn.classList.add('adv-hidden');
      }

      if (previewRunBtn) previewRunBtn.disabled = false;
      this._cancelDryRunSubscription(id);
    }
  },

  /** Render proposal cards in the dry-run panel. */
  _renderDryRunProposals(id, label, proposals) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    const { proposalList } = panels;
    proposalList.innerHTML = '';

    // Reset suppressed count before re-render (DK-366)
    this._suppressedCount = 0;
    this._updateSuppressedCountEl();

    if (!proposals || proposals.length === 0) {
      proposalList.appendChild(
        el('div', { className: 'adv-dry-run-empty' },
          'No proposals — the persona found no new issues to report with current settings.'
        )
      );
      return;
    }

    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      const card = this._buildProposalCard(id, label, p, i);
      proposalList.appendChild(card);
    }

    // After render: if suppression is on and all proposals were suppressed, show indicator
    if (this._suppressDuplicates && this._suppressedCount === proposals.length) {
      proposalList.appendChild(
        el('div', { className: 'adv-dry-run-empty' },
          `All ${proposals.length} proposal${proposals.length !== 1 ? 's' : ''} suppressed as likely duplicates. Turn off suppression in the Backlog Check section to view them.`
        )
      );
    }
  },

  /**
   * Build a single proposal card element.
   * Enhanced with backlog dedup flagging (DK-366):
   *   - Checks PM's pasted backlog for similarity matches
   *   - Shows inline collapsed chip: "Possible duplicate — matched title"
   *   - Expands to stacked comparison view with similarity score
   *   - Three resolution actions for flagged cards
   *   - Suppression: if suppression mode is on, suppressed cards are hidden
   */
  _buildProposalCard(personaId, personaLabel, proposal, index) {
    const isDeduped = !!proposal.deduped;
    const title = String(proposal.title || '(untitled)').slice(0, 200);
    const description = String(proposal.description || '').slice(0, 3000);
    const type = String(proposal.type || 'bug');
    const reasoningSummary = proposal.reasoning_summary ? String(proposal.reasoning_summary).slice(0, 400) : null;
    const filterReason = proposal.filterReason ? String(proposal.filterReason) : null;
    // DK-188: Confidence score from the persona's self-rating (integer 1–10, or null if not available)
    const confidenceScore = (Number.isInteger(proposal.confidenceScore) && proposal.confidenceScore >= 1 && proposal.confidenceScore <= 10)
      ? proposal.confidenceScore : null;

    // Check PM's backlog for similarity match (DK-366)
    const backlogMatch = !isDeduped ? this._checkBacklogMatch(title) : { isMatch: false };
    const isFlaggedByBacklog = backlogMatch.isMatch;

    // Suppression mode: if active and this idea matches backlog, suppress it
    if (isFlaggedByBacklog && this._suppressDuplicates) {
      this._suppressedCount++;
      this._updateSuppressedCountEl();
      // Return empty element (card is suppressed — not shown)
      const suppressed = el('div', { className: 'adv-hidden', 'aria-hidden': 'true' });
      return suppressed;
    }

    const card = el('div', {
      className: [
        'adv-preview-card',
        isDeduped ? 'adv-preview-card-deduped' : '',
        isFlaggedByBacklog ? 'adv-preview-card-backlog-flagged' : '',
      ].filter(Boolean).join(' '),
      role: 'article',
      'aria-label': isFlaggedByBacklog
        ? `Possible duplicate flagged: ${title}`
        : `Proposal: ${title}`,
    });

    // Preview badge row (always shown for accessibility distinction)
    // All flagged cards must include a visible text label/icon (not color-alone)
    const badgeRow = el('div', { className: 'adv-preview-badge-row' },
      el('span', { className: 'adv-preview-badge' }, 'Preview'),
      el('span', { className: 'adv-preview-type-badge' }, type),
      isDeduped
        ? el('span', {
            className: 'adv-preview-dedup-badge',
            'aria-label': filterReason === 'duplicate' ? 'Duplicate flagged' :
              filterReason === 'low_confidence' ? 'Below confidence threshold' : 'Rejection match flagged',
          }, filterReason === 'duplicate' ? 'Would be deduped' :
             filterReason === 'low_confidence' ? `Filtered — low confidence (${proposal.confidenceScore ?? 0}/10)` :
             'Rejection match')
        : null,
      // DK-188: Confidence badge — only shown for proposals that made it through
      // Pair score with text label (not color alone) as per a11y spec.
      confidenceScore !== null && !isDeduped
        ? el('span', {
            className: 'adv-preview-confidence-badge',
            title: 'Self-rated by the persona. Use as a soft signal, not a quality certificate.',
            'aria-label': `Confidence: ${confidenceScore} of 10. Self-rated by the persona — use as a soft signal.`,
          }, `Confidence: ${confidenceScore}/10`)
        : null,
      isFlaggedByBacklog
        ? el('span', {
            className: 'adv-preview-backlog-flag-badge',
            'aria-label': 'Duplicate flagged',
          }, '⧉ Duplicate flagged')
        : null,
    );
    card.appendChild(badgeRow);

    // Title (uses textContent — AI output is untrusted)
    const titleEl = el('h4', { className: 'adv-preview-card-title' });
    titleEl.textContent = title;
    card.appendChild(titleEl);

    // ── Backlog flag inline chip (DK-366) ─────────────────────
    // Shows collapsed chip that expands into stacked comparison view.
    // Accessible: text label not color-only. ARIA live region on resolution.
    if (isFlaggedByBacklog) {
      const matchTitle = backlogMatch.matchTitle || '';
      const scoreLabel = backlogMatch.scoreLabel || '';
      const flagId = `adv-backlog-flag-${index}`;
      const comparisonId = `adv-backlog-comparison-${index}`;

      let comparisonExpanded = false;

      // Collapsed chip (default state)
      const flagChip = el('button', {
        className: 'adv-backlog-flag-chip',
        'aria-expanded': 'false',
        'aria-controls': comparisonId,
        id: flagId,
        title: 'Click to see comparison with matched backlog item',
      });
      // Use textContent — matched title is PM-entered text (treated as untrusted display input)
      const chipText = el('span', { className: 'adv-backlog-flag-chip-text' });
      chipText.textContent = `Possible duplicate — ${matchTitle.slice(0, 60)}${matchTitle.length > 60 ? '…' : ''}`;
      const chipScore = el('span', { className: 'adv-backlog-flag-chip-score' });
      chipScore.textContent = scoreLabel;

      flagChip.appendChild(el('span', { className: 'adv-backlog-flag-chip-icon', 'aria-hidden': 'true' }, '⧉'));
      flagChip.appendChild(chipText);
      flagChip.appendChild(chipScore);

      // Stacked comparison view (collapsed by default, expands on chip click)
      // Stack layout: idea above, matched ticket below — not two-column
      // (reflows at 200% zoom and viewports below 1024px)
      const comparison = el('div', {
        className: 'adv-backlog-comparison adv-hidden',
        id: comparisonId,
        role: 'region',
        'aria-label': 'Comparison with matched backlog item',
        'aria-labelledby': flagId,
      });

      const ideaPane = el('div', { className: 'adv-backlog-comparison-pane adv-backlog-comparison-idea' });
      const ideaPaneLabel = el('div', { className: 'adv-backlog-comparison-pane-label' }, 'Generated idea:');
      const ideaPaneText = el('div', { className: 'adv-backlog-comparison-pane-text' });
      ideaPaneText.textContent = title;
      ideaPane.appendChild(ideaPaneLabel);
      ideaPane.appendChild(ideaPaneText);

      const matchPane = el('div', { className: 'adv-backlog-comparison-pane adv-backlog-comparison-match' });
      const matchPaneLabel = el('div', { className: 'adv-backlog-comparison-pane-label' },
        `Matched backlog item (${scoreLabel}):`
      );
      const matchPaneText = el('div', { className: 'adv-backlog-comparison-pane-text' });
      matchPaneText.textContent = matchTitle; // PM-entered text — textContent safe
      matchPane.appendChild(matchPaneLabel);
      matchPane.appendChild(matchPaneText);

      comparison.appendChild(ideaPane);
      comparison.appendChild(matchPane);

      flagChip.addEventListener('click', () => {
        comparisonExpanded = !comparisonExpanded;
        if (comparisonExpanded) {
          comparison.classList.remove('adv-hidden');
          flagChip.setAttribute('aria-expanded', 'true');
        } else {
          comparison.classList.add('adv-hidden');
          flagChip.setAttribute('aria-expanded', 'false');
        }
      });

      card.appendChild(flagChip);
      card.appendChild(comparison);

      // ── Three resolution actions (DK-366) ───────────────────
      // Each action must have a unique accessible label that includes the idea title.
      // All buttons are keyboard-reachable with visible focus states (CSS handles focus).
      // State change is announced via ARIA live region.
      const resolutionSection = el('div', {
        className: 'adv-backlog-resolution',
        role: 'group',
        'aria-label': `Resolve duplicate flag for: ${title}`,
      });

      const resolveHeader = el('div', { className: 'adv-backlog-resolution-header' }, 'Resolve flag:');

      // Action 1: Already captured — confirm as duplicate, suppress idea, log it
      const alreadyCapturedBtn = el('button', {
        className: 'adv-backlog-resolution-btn adv-backlog-resolution-btn-captured',
        'aria-label': `Already captured — mark as duplicate: ${title}`,
        onClick: () => {
          this._resolveBacklogFlag(card, {
            action: 'already_captured',
            ideaTitle: title,
            matchedTitle: matchTitle,
            note: '',
            announcement: `Marked as already captured: ${title}`,
          });
        },
      }, 'Already captured');

      // Action 2: Keep — different angle — dismiss the flag, retain the idea
      const keepDifferentBtn = el('button', {
        className: 'adv-backlog-resolution-btn adv-backlog-resolution-btn-keep',
        'aria-label': `Keep idea — different angle: ${title}`,
        onClick: () => {
          this._resolveBacklogFlag(card, {
            action: 'keep_different',
            ideaTitle: title,
            matchedTitle: matchTitle,
            note: '',
            announcement: `Flag dismissed — kept as different angle: ${title}`,
            removeFlagOnly: true,
          });
        },
      }, 'Keep — different angle');

      // Action 3: Reject entirely — remove + log with optional note
      const rejectEntirelyBtn = el('button', {
        className: 'adv-backlog-resolution-btn adv-backlog-resolution-btn-reject',
        'aria-label': `Reject entirely: ${title}`,
        onClick: () => {
          this._openRejectNoteDialog(card, title, matchTitle);
        },
      }, 'Reject entirely');

      resolutionSection.appendChild(resolveHeader);
      resolutionSection.appendChild(alreadyCapturedBtn);
      resolutionSection.appendChild(keepDifferentBtn);
      resolutionSection.appendChild(rejectEntirelyBtn);

      card.appendChild(resolutionSection);
    }

    // Description (truncated with expand)
    const descPre = el('div', { className: 'adv-preview-card-desc adv-preview-card-desc-collapsed' });
    descPre.textContent = description;
    card.appendChild(descPre);

    // Toggle expand/collapse for description
    if (description.length > 300) {
      const expandBtn = el('button', {
        className: 'adv-preview-expand-btn',
        onClick: () => {
          const collapsed = descPre.classList.toggle('adv-preview-card-desc-collapsed');
          expandBtn.textContent = collapsed ? 'Show more' : 'Show less';
        },
      }, 'Show more');
      card.appendChild(expandBtn);
    }

    // Reasoning summary
    if (reasoningSummary) {
      const reasoningEl = el('div', { className: 'adv-preview-reasoning' });
      reasoningEl.textContent = `Why: ${reasoningSummary}`;
      card.appendChild(reasoningEl);
    }

    // Actions row (only for non-deduped proposals)
    if (!isDeduped) {
      const promoteBtn = el('button', {
        className: 'adv-preview-promote-btn',
        // Accessible name includes proposal title per spec
        'aria-label': `Promote: ${title}`,
        onClick: () => this._promoteDryRunProposal(personaId, index, title),
      }, 'Promote');

      const dismissBtn = el('button', {
        className: 'adv-preview-dismiss-btn',
        'aria-label': `Dismiss: ${title}`,
        onClick: () => this._dismissProposalCard(card),
      }, 'Dismiss');

      card.appendChild(
        el('div', { className: 'adv-preview-actions' },
          promoteBtn,
          dismissBtn,
        )
      );
    } else {
      // Deduped: show info note only
      card.appendChild(
        el('div', { className: 'adv-preview-dedup-note' },
          proposal.dedupMatchId
            ? `This proposal would be filtered — it duplicates an existing ticket.`
            : `This proposal would be filtered before reaching your board.`,
        )
      );
    }

    return card;
  },

  /**
   * Resolve a backlog flag with one of the three actions.
   * Announces the resolution via ARIA live region (DK-366).
   *
   * @param {HTMLElement} cardEl - The proposal card element
   * @param {{ action, ideaTitle, matchedTitle, note, announcement, removeFlagOnly? }} opts
   */
  _resolveBacklogFlag(cardEl, opts) {
    const { action, ideaTitle, matchedTitle, note, announcement, removeFlagOnly } = opts;

    // Log to rejection log (all actions including "keep" are logged for transparency)
    this._addToRejectionLog({ ideaTitle, matchedTitle, note, action });

    // Announce state change to screen readers
    this._announceToSR(announcement || `Flag resolved: ${ideaTitle}`);

    if (removeFlagOnly) {
      // "Keep — different angle": just remove the flag UI from the card
      cardEl.classList.remove('adv-preview-card-backlog-flagged');
      const flagChip = cardEl.querySelector('.adv-backlog-flag-chip');
      const comparison = cardEl.querySelector('.adv-backlog-comparison');
      const resolutionSection = cardEl.querySelector('.adv-backlog-resolution');
      if (flagChip) flagChip.remove();
      if (comparison) comparison.remove();
      if (resolutionSection) resolutionSection.remove();

      // Also remove the flag badge from the badge row
      const flagBadge = cardEl.querySelector('.adv-preview-backlog-flag-badge');
      if (flagBadge) flagBadge.remove();
    } else {
      // "Already captured" or "Reject entirely": remove the entire card
      cardEl.classList.add('adv-preview-card-dismissed');
      setTimeout(() => cardEl.remove(), 300);
    }
  },

  /**
   * Open a dialog for the "Reject entirely" action that collects an optional note.
   * Inline within the card (not a modal) for accessibility and keyboard flow.
   *
   * @param {HTMLElement} cardEl
   * @param {string} ideaTitle
   * @param {string} matchedTitle
   */
  _openRejectNoteDialog(cardEl, ideaTitle, matchedTitle) {
    // Remove any existing reject note dialog on this card
    const existing = cardEl.querySelector('.adv-backlog-reject-dialog');
    if (existing) { existing.remove(); return; }

    const dialog = el('div', {
      className: 'adv-backlog-reject-dialog',
      role: 'group',
      'aria-label': `Add note before rejecting: ${ideaTitle}`,
    });

    const noteLabel = el('label', {
      className: 'adv-backlog-reject-note-label',
      htmlFor: `adv-reject-note-${ideaTitle.slice(0, 20).replace(/\s/g, '-')}`,
    }, 'Note (optional — e.g. "Rejected for Q2"):');

    const noteInput = el('input', {
      type: 'text',
      className: 'adv-backlog-reject-note-input',
      id: `adv-reject-note-${ideaTitle.slice(0, 20).replace(/\s/g, '-')}`,
      placeholder: 'e.g. Rejected for Q2 — revisit if scope expands',
      maxlength: '500',
      'aria-label': `Rejection note for: ${ideaTitle}`,
    });

    const confirmRejectBtn = el('button', {
      className: 'adv-backlog-reject-confirm-btn',
      'aria-label': `Confirm reject: ${ideaTitle}`,
      onClick: () => {
        const note = noteInput.value.trim();
        this._resolveBacklogFlag(cardEl, {
          action: 'reject_entirely',
          ideaTitle,
          matchedTitle,
          note,
          announcement: `Rejected: ${ideaTitle}${note ? ` — ${note}` : ''}`,
        });
      },
    }, 'Confirm reject');

    const cancelBtn = el('button', {
      className: 'adv-backlog-reject-cancel-btn',
      'aria-label': `Cancel reject: ${ideaTitle}`,
      onClick: () => dialog.remove(),
    }, 'Cancel');

    dialog.appendChild(noteLabel);
    dialog.appendChild(noteInput);
    dialog.appendChild(el('div', { className: 'adv-backlog-reject-dialog-btns' }, confirmRejectBtn, cancelBtn));

    // Insert after the resolution section
    const resolutionSection = cardEl.querySelector('.adv-backlog-resolution');
    if (resolutionSection) {
      resolutionSection.after(dialog);
    } else {
      cardEl.appendChild(dialog);
    }

    // Focus the note input
    setTimeout(() => noteInput.focus(), 50);
  },

  /** Promote a single dry-run proposal to a real ticket. */
  async _promoteDryRunProposal(personaId, proposalIndex, title) {
    const proposals = this._dryRunProposals[personaId];
    if (!proposals || proposalIndex >= proposals.length) return;
    const proposal = proposals[proposalIndex];
    if (!proposal) return;

    // Single confirmation step per spec
    const confirmed = await showConfirmModal({
      title: 'Promote proposal?',
      message: `This will create 1 proposal in your board: "${String(proposal.title || '').slice(0, 80)}"`,
      confirm: 'Create ticket',
      danger: false,
    });
    if (!confirmed) return;

    await this._writeProposalToFirestore(personaId, [proposal]);
  },

  /** Promote all non-deduped dry-run proposals. */
  async _promoteAllDryRunProposals(personaId, personaLabel) {
    const proposals = (this._dryRunProposals[personaId] || []).filter(p => !p.deduped);
    if (proposals.length === 0) return;

    const confirmed = await showConfirmModal({
      title: `Promote all ${personaLabel} proposals?`,
      message: `This will create ${proposals.length} proposal${proposals.length !== 1 ? 's' : ''} in your board.`,
      confirm: `Create ${proposals.length} ticket${proposals.length !== 1 ? 's' : ''}`,
      danger: false,
    });
    if (!confirmed) return;

    await this._writeProposalToFirestore(personaId, proposals);
  },

  /** Write one or more proposals to Firestore tickets collection. */
  async _writeProposalToFirestore(personaId, proposals) {
    const user = this._currentUser;
    if (!user) {
      alert('You must be signed in to promote proposals.');
      return;
    }

    const panels = this._dryRunPanels[personaId];

    // Determine project — use filter project if set, else first eligible project
    const projectId = this._filterProjectId;
    if (!projectId) {
      alert('Please select a project to promote proposals into.');
      return;
    }

    const _firebase = window.firebase;
    const serverTimestamp = _firebase?.firestore?.FieldValue?.serverTimestamp
      ? () => _firebase.firestore.FieldValue.serverTimestamp()
      : () => new Date();
    const ticketsRef = this.db
      .collection('projects').doc(projectId)
      .collection('tickets');
    const projRef = this.db.collection('projects').doc(projectId);

    let successCount = 0;
    let errorCount = 0;
    for (const proposal of proposals) {
      try {
        // Atomic ticket creation with nextTicketNumber increment
        await this.db.runTransaction(async (tx) => {
          const projDoc = await tx.get(projRef);
          if (!projDoc.exists) throw new Error(`Project "${projectId}" not found`);
          const projData = projDoc.data();
          const nextNum = projData.nextTicketNumber || 1;
          const prefix = projData.prefix || 'TK';
          const ticketId = `${prefix}-${nextNum}`;

          tx.update(projRef, { nextTicketNumber: nextNum + 1 });

          const now = serverTimestamp();
          const doc = {
            ticketNumber: nextNum,
            ticketId,
            type: proposal.type || 'bug',
            title: String(proposal.title || '').slice(0, 200),
            description: String(proposal.description || '').slice(0, 10000),
            status: 'proposed',
            statusHistory: [{ to: 'proposed', at: new Date().toISOString(), note: 'Promoted from dry-run preview' }],
            pendingQuestion: null,
            userId: user.uid,
            userEmail: user.email || '',
            projectId,
            advisorPersona: proposal.advisorPersona || personaId,
            createdAt: now,
            updatedAt: now,
          };
          if (proposal.reasoning_summary) {
            doc.reasoning = { summary: String(proposal.reasoning_summary).slice(0, 500), evidence: [] };
          }
          tx.set(ticketsRef.doc(), doc);
        });

        successCount++;
      } catch (err) {
        console.error('AdvisorPanel: failed to promote proposal:', err);
        errorCount++;
      }
    }

    if (panels) {
      if (errorCount === 0) {
        this._setDryRunStatus(personaId, `${successCount} ticket${successCount !== 1 ? 's' : ''} created in your board.`);
      } else {
        this._setDryRunStatus(personaId, `${successCount} created, ${errorCount} failed.`);
      }
    }
  },

  /** Dismiss (remove) a single proposal card from the UI. */
  _dismissProposalCard(cardEl) {
    cardEl.classList.add('adv-preview-card-dismissed');
    setTimeout(() => cardEl.remove(), 300);
  },

  /** Close the dry-run panel for a persona. */
  _closeDryRunPanel(id) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    panels.panel.classList.add('adv-hidden');
    this._cancelDryRunSubscription(id);
    delete this._dryRunProposals[id];
    if (panels.previewRunBtn) panels.previewRunBtn.disabled = false;
  },

  /** Cancel any active dry-run Firestore subscription for a persona. */
  _cancelDryRunSubscription(id) {
    if (this._dryRunUnsubs[id]) {
      this._dryRunUnsubs[id]();
      delete this._dryRunUnsubs[id];
    }
    delete this._dryRunDocIds[id];
  },

  /** Update the status bar text in the dry-run panel. */
  _setDryRunStatus(id, text) {
    const panels = this._dryRunPanels[id];
    if (!panels) return;
    panels.statusBar.textContent = text;
  },

  async _togglePause(id) {
    const data = this._states[id];
    const projectId = this._filterProjectId;
    // Per-project override: read paused state from project settings when a project is focused
    const projectSettings = projectId
      ? this._projects.find(p => p.id === projectId)?.advisorSettings?.[id]
      : null;
    const isPaused = projectId
      ? (projectSettings?.paused ?? false)
      : data?.status === 'paused';

    // Disable checkbox during write to prevent double-toggle
    const card = this._cards[id];
    if (card?.pauseCheckbox) card.pauseCheckbox.disabled = true;

    try {
      if (projectId) {
        // Write per-project paused flag to project document
        await this.db.collection('projects').doc(projectId).update({
          [`advisorSettings.${id}.paused`]: !isPaused,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // No project focused — write to global persona doc (affects all projects)
        await this.db.collection('advisor').doc(id).set({ status: isPaused ? 'idle' : 'paused' }, { merge: true });
      }
    } catch (err) {
      console.error('Failed to toggle pause:', err);
      // Revert checkbox state on error (Firestore listener will re-sync when possible)
      if (card?.pauseCheckbox) card.pauseCheckbox.checked = isPaused;
    } finally {
      if (card?.pauseCheckbox) card.pauseCheckbox.disabled = false;
    }
  }
};
