// Per-card history panel and last-run breakdown rendering.
// Shows recent advisorRuns inline within a persona card, with rejected,
// created, and scan-list sections.

import { el } from '../ui/el.js';
import { formatRelativeTs, formatAbsolute, formatDuration } from '../ui/format.js';
import {
  ERROR_REASON_LABELS,
  REJECTION_REASON_LABELS,
  REJECTION_REASON_ICONS,
} from '../config/labels.js';
import { PERSONAS } from '../config/personas.js';
import { rejectionCounts, buildWhyText, buildRunTrendText } from '../helpers/persona.js';

export const historyMixin = {
  // ── Per-card history toggle ───────────────────────────────────

  _toggleCardHistory(personaId) {
    const isOpen = !this._historyOpen[personaId];
    this._historyOpen[personaId] = isOpen;

    const card = this._cards[personaId];
    const panel = this._historyPanels[personaId];
    if (!card || !panel) return;

    if (isOpen) {
      panel.classList.remove('adv-hidden');
      card.historyToggleBtn.textContent = 'History ▾';
      card.historyToggleBtn.setAttribute('aria-expanded', 'true');
      card.historyRefreshBtn.classList.remove('adv-hidden');
      // Load runs if not yet loaded
      if (!this._historyRuns[personaId]) {
        this._loadHistoryRuns(personaId);
      }
    } else {
      panel.classList.add('adv-hidden');
      card.historyToggleBtn.textContent = 'History ▸';
      card.historyToggleBtn.setAttribute('aria-expanded', 'false');
      card.historyRefreshBtn.classList.add('adv-hidden');
    }
  },

  /**
   * Subscribe to the advisorRuns collection for a given persona.
   * Shows a loading state, then renders runs when data arrives.
   * When a project is selected (_filterProjectId is set), the query is scoped
   * to that project only. When no project is selected (null), all projects are
   * shown for this persona.
   * On error, retries with exponential backoff (matches the pattern used by
   * _subscribePersona and _subscribeCustomPersonas) so transient auth failures
   * on page load self-heal once the Firebase ID token is ready.
   */
  _loadHistoryRuns(personaId, retryDelayMs = 5000) {
    // Cancel any existing listener for this persona
    if (this._historyUnsubs[personaId]) {
      this._historyUnsubs[personaId]();
      delete this._historyUnsubs[personaId];
    }

    this._historyLoading[personaId] = true;
    this._historyRuns[personaId] = null;
    this._renderHistoryPanel(personaId);

    let query = this.db.collection('advisorRuns')
      .where('persona', '==', personaId);
    // Scope to the currently selected project when one is active
    if (this._filterProjectId) {
      query = query.where('projectId', '==', this._filterProjectId);
    }
    query = query.orderBy('startedAt', 'desc').limit(20);

    const unsub = query.onSnapshot(
      (snap) => {
        this._historyLoading[personaId] = false;
        this._historyRuns[personaId] = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        this._renderHistoryPanel(personaId);
        // Re-render persona card so the summary line picks up the latest run
        this._renderCard(personaId);
      },
      (err) => {
        if (this._isPermissionDeniedTransient(err)) {
          console.warn(`AdvisorPanel: history listener error for ${personaId} (transient, retrying)`, err);
        } else {
          console.error(`AdvisorPanel: history listener error for ${personaId}`, err);
        }
        this._historyLoading[personaId] = false;
        if (this._historyRuns[personaId] === null) {
          // Show empty state rather than hanging spinner on error
          this._historyRuns[personaId] = [];
        }
        this._renderHistoryPanel(personaId);
        // Firestore terminates the listener on error. Schedule a retry so the
        // panel automatically recovers once permissions are in place (e.g. after
        // a transient auth token delay on page load or a rules re-deploy).
        if (this._mounted) {
          const delay = Math.min(retryDelayMs, 60_000); // cap at 60s
          setTimeout(() => {
            if (this._mounted) this._loadHistoryRuns(personaId, delay * 2);
          }, delay);
        }
      }
    );

    this._historyUnsubs[personaId] = unsub;
  },

  _renderHistoryPanel(personaId) {
    const panel = this._historyPanels[personaId];
    if (!panel) return;
    panel.innerHTML = '';

    if (this._historyLoading[personaId]) {
      panel.appendChild(el('div', { className: 'adv-history-loading', 'aria-busy': 'true' },
        el('span', { className: 'adv-history-spinner', 'aria-hidden': 'true' }),
        el('span', {}, 'Loading…'),
      ));
      return;
    }

    const runs = this._historyRuns[personaId];
    if (!runs || runs.length === 0) {
      const persona = PERSONAS.find(p => p.id === personaId);
      const hours = persona ? persona.defaultHours : '?';
      panel.appendChild(
        el('div', { className: 'adv-history-empty' },
          `Runs every ~${hours}h — more history will appear over time.`
        )
      );
      return;
    }

    if (runs.length < 3) {
      const persona = PERSONAS.find(p => p.id === personaId);
      const hours = persona ? persona.defaultHours : '?';
      panel.appendChild(
        el('div', { className: 'adv-history-hint' },
          `Runs every ~${hours}h — more history will appear over time.`
        )
      );
    }

    // 7-run trend summary (above the list)
    const trendText = buildRunTrendText(runs);
    if (trendText) {
      panel.appendChild(
        el('div', { className: 'adv-history-trend' }, trendText)
      );
    }

    const list = el('div', { className: 'adv-history-list' });

    for (const run of runs) {
      list.appendChild(this._buildHistoryRow(run, personaId));
    }

    panel.appendChild(list);
  },

  _buildHistoryRow(run, personaId) {
    const runId = run._id || `${run.startedAt}-${run.status}`;
    const isExpanded = !!this._historyExpanded[runId];

    const relTime = formatRelativeTs(run.startedAt) || '—';
    const absTime = formatAbsolute(run.startedAt);

    // Derive counts from rich arrays (new schema) or fall back to legacy scalar fields
    const created = Array.isArray(run.created) ? run.created : [];
    const rejected = Array.isArray(run.rejected) ? run.rejected : [];
    const scanned = Array.isArray(run.scanned) ? run.scanned : [];
    const createdCount = created.length || run.proposalsCreated || 0;
    const rejectedCount = rejected.length;

    // Status badge: completed / failed / running (new schema) or ok/quiet/error (legacy)
    const statusNorm = run.status === 'ok' ? 'completed'
      : run.status === 'quiet' ? 'completed'
      : run.status === 'error' ? 'failed'
      : run.status || 'completed';

    const statusClass = {
      completed: 'adv-badge-ok',
      failed:    'adv-badge-error',
      running:   'adv-badge-quiet',
    }[statusNorm] || 'adv-badge-ok';

    const statusLabel = {
      completed: 'ok',
      failed:    'error',
      running:   'running',
    }[statusNorm] || statusNorm;

    // Detail region id
    const detailId = `adv-run-detail-${runId}`;

    // ── Collapsed row ──────────────────────────────────────────
    const triggerBtn = el('button', {
      className: 'adv-history-row-trigger',
      'aria-expanded': String(isExpanded),
      'aria-controls': detailId,
      onClick: () => {
        const nowExpanded = !this._historyExpanded[runId];
        this._historyExpanded[runId] = nowExpanded;
        // Re-render the panel to reflect the new expanded state
        this._renderHistoryPanel(personaId);
      },
    });

    triggerBtn.appendChild(
      el('span', {
        className: 'adv-history-row-time',
        title: absTime,
        'aria-label': `${relTime} (${absTime})`,
      }, relTime)
    );

    triggerBtn.appendChild(
      el('span', { className: `adv-badge ${statusClass}` }, statusLabel)
    );

    // DK-367: Scope chip — shown inline when run has a scopeText
    const scopeText = typeof run.scopeText === 'string' && run.scopeText.trim()
      ? run.scopeText.trim()
      : null;
    if (scopeText) {
      const truncatedScope = scopeText.length > 40 ? scopeText.slice(0, 40) + '…' : scopeText;
      triggerBtn.appendChild(
        el('span', {
          className: 'adv-history-scope-chip',
          title: scopeText,
          'aria-label': `Run scoped to: ${scopeText}`,
        }, `Focus: ${truncatedScope}`)
      );
    }

    // Summary: "2 created · 3 rejected · 5/8 relevant" (new schema) or legacy "N proposals"
    const summaryParts = [];
    if (createdCount > 0) summaryParts.push(`${createdCount} created`);
    if (rejectedCount > 0) {
      // Group by reason for the summary
      const byCounts = rejectionCounts(rejected);
      const bucketStr = Object.entries(byCounts)
        .map(([reason, n]) => `${n} ${REJECTION_REASON_LABELS[reason] || reason}`)
        .join(', ');
      summaryParts.push(`${rejectedCount} rejected${bucketStr ? ` (${bucketStr})` : ''}`);
    }
    // Feedback ratio: only shown when at least one ticket has been rated
    if (run.feedbackSummary && run.feedbackSummary.total > 0) {
      const fs = run.feedbackSummary;
      summaryParts.push(`${fs.relevant}/${fs.total} relevant`);
    }
    if (summaryParts.length === 0 && createdCount === 0 && rejectedCount === 0) {
      summaryParts.push('nothing found');
    }

    triggerBtn.appendChild(
      el('span', { className: 'adv-history-row-proposals' }, summaryParts.join(' · '))
    );

    triggerBtn.appendChild(
      el('span', { className: 'adv-history-row-chevron', 'aria-hidden': 'true' },
        isExpanded ? '▾' : '▸'
      )
    );

    const row = el('div', { className: 'adv-history-row' }, triggerBtn);

    // ── Expanded detail ────────────────────────────────────────
    const detail = el('div', {
      className: 'adv-history-detail' + (isExpanded ? '' : ' adv-hidden'),
      id: detailId,
      role: 'region',
    });

    if (isExpanded) {
      const duration = formatDuration(run.durationMs);

      // DK-367: Scope callout — shown when run was scoped to a specific area
      if (scopeText) {
        detail.appendChild(
          el('div', { className: 'adv-history-scope-callout', role: 'note' },
            el('span', { className: 'adv-history-scope-callout-label' }, 'This run was scoped to:'),
            ' ',
            el('span', { className: 'adv-history-scope-callout-value' }, scopeText),
            el('span', { className: 'adv-history-scope-callout-hint' }, ' — results will differ from unscoped runs.')
          )
        );
      }

      // Duration
      detail.appendChild(el('div', { className: 'adv-history-detail-row' },
        el('span', { className: 'adv-detail-label' }, 'Duration'),
        el('span', { className: 'adv-detail-val' }, duration),
      ));

      // Error (if any)
      const errorReason = run.error || run.errorReason;
      if ((statusNorm === 'failed' || run.status === 'error') && errorReason) {
        const errorLabel = ERROR_REASON_LABELS[errorReason] || errorReason;
        detail.appendChild(el('div', { className: 'adv-history-detail-row adv-history-detail-error' },
          el('span', { className: 'adv-detail-label' }, 'Error'),
          el('span', { className: 'adv-detail-val adv-detail-val-error' }, errorLabel),
        ));
      }

      // ── Feedback ratio ────────────────────────────────────────
      // feedbackSummary is written by the aggregate job after a run completes.
      // Shows as "N / M relevant" where N=relevant, M=total rated.
      // Only displayed when at least one ticket has been rated.
      if (run.feedbackSummary && run.feedbackSummary.total > 0) {
        const fs = run.feedbackSummary;
        const ratioText = `${fs.relevant} / ${fs.total} relevant`;
        detail.appendChild(el('div', { className: 'adv-history-detail-row' },
          el('span', { className: 'adv-detail-label' }, 'Feedback'),
          el('span', { className: 'adv-detail-val adv-feedback-ratio' }, ratioText),
        ));
      }

      // ── Rejected tickets section (lead with this per design notes) ──
      if (rejected.length > 0) {
        detail.appendChild(this._buildRejectedSection(rejected));
      }

      // ── Created tickets section ─────────────────────────────
      if (created.length > 0) {
        detail.appendChild(this._buildCreatedSection(created));
      }

      // ── Scan list ────────────────────────────────────────────
      if (scanned.length > 0) {
        detail.appendChild(this._buildScanListSection(scanned, personaId));
      } else {
        // Legacy fields
        const files = run.filesScanned ?? 0;
        const urls  = run.urlsScanned ?? 0;
        if (files > 0 || urls > 0) {
          const scanCount = personaId === 'design' ? urls : files;
          const scanLabel = personaId === 'design' ? 'URLs scanned' : 'Files scanned';
          detail.appendChild(el('div', { className: 'adv-history-detail-row' },
            el('span', { className: 'adv-detail-label' }, scanLabel),
            el('span', { className: 'adv-detail-val' }, String(scanCount)),
          ));
        }
      }
    }

    row.appendChild(detail);
    return row;
  },

  /**
   * Build the rejected tickets section for an expanded run detail.
   * Groups items by rejection reason.
   *
   * @param {Array<{title, reason, matchedTicketId?, score?}>} rejected
   * @returns {HTMLElement}
   */
  _buildRejectedSection(rejected) {
    const section = el('div', { className: 'adv-run-rejected-section' });
    section.appendChild(
      el('div', { className: 'adv-run-section-header' }, 'Rejected')
    );

    // Group by reason
    const groups = {};
    for (const item of rejected) {
      const r = item.reason || 'unknown';
      if (!groups[r]) groups[r] = [];
      groups[r].push(item);
    }

    for (const [reason, items] of Object.entries(groups)) {
      const label = REJECTION_REASON_LABELS[reason] || reason;
      const icon = REJECTION_REASON_ICONS[reason] || '○';
      const groupId = `adv-rej-group-${reason}-${Math.random().toString(36).slice(2, 7)}`;

      const groupHeader = el('button', {
        className: 'adv-rej-group-header',
        'aria-expanded': 'false',
        'aria-controls': groupId,
        onClick: () => {
          const isExp = groupHeader.getAttribute('aria-expanded') === 'true';
          groupHeader.setAttribute('aria-expanded', String(!isExp));
          groupList.classList.toggle('adv-hidden', isExp);
          groupChevron.textContent = isExp ? '▸' : '▾';
        },
      });

      const groupChevron = el('span', { className: 'adv-rej-chevron', 'aria-hidden': 'true' }, '▸');
      groupHeader.appendChild(
        el('span', {
          className: `adv-rej-reason-badge adv-rej-reason-${reason}`,
          'aria-label': label,
        },
          el('span', { 'aria-hidden': 'true' }, icon),
          el('span', {}, ` ${label}`)
        )
      );
      groupHeader.appendChild(
        el('span', { className: 'adv-rej-count' }, `${items.length}`)
      );
      groupHeader.appendChild(groupChevron);

      const groupList = el('ul', { className: 'adv-rej-list adv-hidden', id: groupId, role: 'list' });
      for (const item of items) {
        const li = el('li', { className: 'adv-rej-item' });

        const titleEl = el('span', { className: 'adv-rej-title' }, item.title);
        li.appendChild(titleEl);

        // "why?" tooltip
        const whyText = buildWhyText(item);
        if (whyText) {
          const whyBtn = el('button', {
            className: 'adv-rej-why-btn',
            'aria-label': `Why this was rejected: ${whyText}`,
            title: whyText,
          }, 'why?');
          li.appendChild(whyBtn);
        }

        groupList.appendChild(li);
      }

      section.appendChild(groupHeader);
      section.appendChild(groupList);
    }

    return section;
  },

  /**
   * Build the created tickets section (ticket IDs linking to the board).
   * @param {string[]} created - Array of ticket IDs
   * @returns {HTMLElement}
   */
  _buildCreatedSection(created) {
    const section = el('div', { className: 'adv-run-created-section' });
    section.appendChild(
      el('div', { className: 'adv-run-section-header' }, `Created (${created.length})`)
    );

    const list = el('ul', { className: 'adv-created-list', role: 'list' });
    for (const ticketId of created) {
      // Ticket IDs are Firestore doc IDs — link to ticket on the board
      const li = el('li', { className: 'adv-created-item' });
      // Use a hash-based link so clicking navigates to the ticket in the SPA
      const link = el('a', {
        className: 'adv-created-link',
        href: `#ticket/${ticketId}`,
        title: `View ticket ${ticketId}`,
      }, ticketId.slice(0, 12) + (ticketId.length > 12 ? '…' : ''));
      li.appendChild(link);
      list.appendChild(li);
    }
    section.appendChild(list);

    return section;
  },

  /**
   * Build the scan list section with a 10-item cap + "show N more" expansion.
   * @param {string[]} scanned - Array of file paths or sanitized URLs
   * @param {string} personaId
   * @returns {HTMLElement}
   */
  _buildScanListSection(scanned, personaId) {
    const SCAN_CAP = 10;
    const section = el('div', { className: 'adv-run-scan-section' });
    const label = personaId === 'design' ? 'URLs scanned' : 'Files scanned';

    section.appendChild(
      el('div', { className: 'adv-run-section-header' }, `${label} (${scanned.length})`)
    );

    const visible = scanned.slice(0, SCAN_CAP);
    const overflow = scanned.slice(SCAN_CAP);

    const list = el('ul', { className: 'adv-scan-list', role: 'list' });
    for (const path of visible) {
      list.appendChild(
        el('li', { className: 'adv-scan-item' },
          el('span', {
            className: 'adv-scan-path',
            title: path,
            'aria-label': path,
          }, path)
        )
      );
    }
    section.appendChild(list);

    if (overflow.length > 0) {
      const moreId = `adv-scan-more-${Math.random().toString(36).slice(2, 7)}`;
      const moreList = el('ul', { className: 'adv-scan-list adv-hidden', id: moreId, role: 'list' });
      for (const path of overflow) {
        moreList.appendChild(
          el('li', { className: 'adv-scan-item' },
            el('span', {
              className: 'adv-scan-path',
              title: path,
              'aria-label': path,
            }, path)
          )
        );
      }

      const moreBtn = el('button', {
        className: 'adv-scan-more-btn',
        'aria-expanded': 'false',
        'aria-controls': moreId,
        onClick: () => {
          const isExp = moreBtn.getAttribute('aria-expanded') === 'true';
          moreBtn.setAttribute('aria-expanded', String(!isExp));
          moreList.classList.toggle('adv-hidden', isExp);
          moreBtn.textContent = isExp ? `Show ${overflow.length} more` : 'Show less';
        },
      }, `Show ${overflow.length} more`);

      section.appendChild(moreBtn);
      section.appendChild(moreList);
    }

    return section;
  }
};
