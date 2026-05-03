// Run Log Drawer — DK-189.
// Right-side drawer showing the last 20 advisor runs for the current project.
// Mixin attached to AdvisorPanel.prototype.

import { el } from '../ui/el.js';
import { formatRelative, formatRelativeTs, formatAbsolute, formatDuration } from '../ui/format.js';
import { ERROR_REASON_LABELS } from '../config/labels.js';
import { PERSONA_DISPLAY_NAMES } from '../config/personas.js';
import { filterReasonLabel, rejectionCounts, buildWhyText } from '../helpers/persona.js';

export const runLogMixin = {
  // ── Run Log Drawer (DK-189) ─────────────────────────────────────────────
  // Right-side drawer showing the last 20 advisor runs for the current project.
  // Triggered by the "Run log" button in the panel header.
  // Fetches once on open; manual refresh re-runs the query.
  // No onSnapshot — the log is historical.

  /**
   * Open (or re-open) the run log drawer.
   * If already open, bring it to focus and refresh.
   *
   * @param {string|null} [focusRunId] - Optional run doc ID to pre-scroll to after load.
   */
  _openRunLogDrawer(focusRunId = null) {
    this._runLogFocusRunId = focusRunId || null;

    if (!this._runLogDrawer) {
      this._runLogDrawer = this._buildRunLogDrawer();
      document.body.appendChild(this._runLogDrawer);
    }

    this._runLogDrawerOpen = true;
    this._runLogDrawer.classList.remove('adv-drawer-hidden');
    this._runLogDrawer.setAttribute('aria-hidden', 'false');

    // Trap focus inside the drawer
    const firstFocusable = this._runLogDrawer.querySelector('button, [tabindex="0"]');
    if (firstFocusable) firstFocusable.focus();

    // Load runs if not yet loaded or if stale (null means not loaded)
    if (this._runLogRuns === null || focusRunId) {
      this._fetchRunLogRuns();
    } else {
      this._renderRunLogBody();
    }
  },

  /**
   * Close the run log drawer and return focus to the trigger button.
   */
  _closeRunLogDrawer() {
    if (!this._runLogDrawer) return;
    this._runLogDrawerOpen = false;
    this._runLogDrawer.classList.add('adv-drawer-hidden');
    this._runLogDrawer.setAttribute('aria-hidden', 'true');

    // Return focus to trigger button
    if (this._runLogBtn) this._runLogBtn.focus();
  },

  /**
   * Build the run log drawer DOM once. Subsequent opens reuse this element.
   * @returns {HTMLElement}
   */
  _buildRunLogDrawer() {
    const self = this;

    // Backdrop
    const backdrop = el('div', {
      className: 'adv-drawer-backdrop',
      'aria-hidden': 'true',
      onClick: () => self._closeRunLogDrawer(),
    });

    // Drawer panel
    const panel = el('div', {
      className: 'adv-drawer-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Advisor run log',
    });

    // Header row
    const closeBtn = el('button', {
      className: 'adv-drawer-close',
      'aria-label': 'Close run log',
      title: 'Close',
      onClick: () => self._closeRunLogDrawer(),
    }, '✕');

    const refreshBtn = el('button', {
      className: 'adv-drawer-refresh',
      'aria-label': 'Refresh run log',
      title: 'Refresh',
      onClick: () => {
        self._runLogRuns = null;
        self._fetchRunLogRuns();
      },
    }, '↻ Refresh');

    const drawerTitle = el('h2', { className: 'adv-drawer-title' }, 'Advisor run log');

    const drawerHeader = el('div', { className: 'adv-drawer-header' },
      drawerTitle,
      el('div', { className: 'adv-drawer-header-actions' },
        refreshBtn,
        closeBtn,
      ),
    );

    panel.appendChild(drawerHeader);

    // Paused notice container — shown when the advisor is paused
    this._runLogPausedNotice = el('div', {
      className: 'adv-drawer-paused-notice adv-hidden',
      role: 'note',
      'aria-label': 'Advisor is paused',
    },
      el('span', { className: 'adv-drawer-paused-icon', 'aria-hidden': 'true' }, '⏸'),
      ' Advisor is paused — no recent runs.',
    );
    panel.appendChild(this._runLogPausedNotice);

    // Body container — accordion rows rendered here
    this._runLogBody = el('div', {
      className: 'adv-drawer-body',
      role: 'list',
      'aria-label': 'Run log entries',
    });
    panel.appendChild(this._runLogBody);

    // Trap keyboard navigation inside the drawer
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        self._closeRunLogDrawer();
      }
    });

    const overlay = el('div', {
      className: 'adv-drawer-overlay adv-drawer-hidden',
      'aria-hidden': 'true',
    }, backdrop, panel);

    return overlay;
  },

  /**
   * Fetch the last 20 advisor runs for the current project from Firestore.
   * Fires once — no live listener.
   */
  async _fetchRunLogRuns() {
    if (!this._runLogBody) return;

    this._runLogLoading = true;
    this._renderRunLogBody(); // show spinner

    const projectId = this._filterProjectId;

    try {
      let query = this.db.collection('advisorRuns')
        .orderBy('timestamp', 'desc')
        .limit(20);

      if (projectId) {
        query = this.db.collection('advisorRuns')
          .where('projectId', '==', projectId)
          .orderBy('timestamp', 'desc')
          .limit(20);
      } else {
        // Fall back to startedAt ordering (legacy field) if timestamp not indexed
        query = this.db.collection('advisorRuns')
          .orderBy('startedAt', 'desc')
          .limit(20);
      }

      const snap = await query.get();
      this._runLogRuns = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    } catch (err) {
      console.warn('Run log fetch failed:', err.message);
      // Try falling back to startedAt ordering if timestamp field is missing
      try {
        let fallbackQuery = this.db.collection('advisorRuns')
          .orderBy('startedAt', 'desc')
          .limit(20);
        if (projectId) {
          fallbackQuery = this.db.collection('advisorRuns')
            .where('projectId', '==', projectId)
            .orderBy('startedAt', 'desc')
            .limit(20);
        }
        const fallbackSnap = await fallbackQuery.get();
        this._runLogRuns = fallbackSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
      } catch (fallbackErr) {
        console.error('Run log fallback fetch also failed:', fallbackErr.message);
        this._runLogRuns = [];
      }
    } finally {
      this._runLogLoading = false;
      this._renderRunLogBody();

      // Scroll to focused run if specified
      if (this._runLogFocusRunId && this._runLogBody) {
        const targetRow = this._runLogBody.querySelector(`[data-run-id="${this._runLogFocusRunId}"]`);
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Expand the target run
          if (!this._runLogExpanded[this._runLogFocusRunId]) {
            this._runLogExpanded[this._runLogFocusRunId] = true;
            this._renderRunLogBody();
            const expandedRow = this._runLogBody.querySelector(`[data-run-id="${this._runLogFocusRunId}"]`);
            if (expandedRow) expandedRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          this._runLogFocusRunId = null;
        }
      }
    }
  },

  /**
   * Render the body of the run log drawer from cached data.
   * Called after fetch completes and on accordion expand/collapse.
   */
  _renderRunLogBody() {
    if (!this._runLogBody) return;
    this._runLogBody.innerHTML = '';

    // Check paused state across all personas
    const anyPaused = Object.values(this._states).some(s => s?.status === 'paused');
    if (this._runLogPausedNotice) {
      this._runLogPausedNotice.classList.toggle('adv-hidden', !anyPaused || (this._runLogRuns && this._runLogRuns.length > 0));
    }

    if (this._runLogLoading) {
      this._runLogBody.appendChild(
        el('div', { className: 'adv-drawer-loading', 'aria-busy': 'true' },
          el('span', { className: 'adv-history-spinner', 'aria-hidden': 'true' }),
          el('span', {}, ' Loading runs…'),
        )
      );
      return;
    }

    const runs = this._runLogRuns || [];

    if (runs.length === 0) {
      this._runLogBody.appendChild(
        el('div', { className: 'adv-drawer-empty' },
          'No advisor runs found for this project yet.'
        )
      );
      return;
    }

    for (const run of runs) {
      this._runLogBody.appendChild(this._buildRunLogRow(run));
    }
  },

  /**
   * Build a single accordion row for the run log drawer.
   *
   * Collapsed: persona name, timestamp, one-line summary
   * Expanded: Created tickets, Dedup hits, Filtered summary
   *
   * @param {object} run - Run log document from advisorRuns
   * @returns {HTMLElement}
   */
  _buildRunLogRow(run) {
    const runId = run._id || `run-${Math.random().toString(36).slice(2)}`;
    const isExpanded = !!this._runLogExpanded[runId];

    // Timestamp
    const ts = run.timestamp || run.startedAt || run.finishedAt;
    const relTime = formatRelativeTs(ts) || '—';
    const absTime = formatAbsolute(ts);

    // Persona label
    const personaId = run.persona || run.personaId || '?';
    const personaLabel = PERSONA_DISPLAY_NAMES[personaId] || personaId;

    // Counts from structured fields (DK-189) or fall back to legacy
    const ticketsCreated  = Array.isArray(run.ticketsCreated)  ? run.ticketsCreated
                          : Array.isArray(run.created)         ? run.created
                          : [];
    const ticketsDeduped  = Array.isArray(run.ticketsDeduped)  ? run.ticketsDeduped  : [];
    const ticketsFiltered = run.ticketsFiltered && typeof run.ticketsFiltered === 'object'
      ? run.ticketsFiltered
      : { count: Array.isArray(run.rejected) ? run.rejected.length : 0, reasons: [] };

    const createdCount = ticketsCreated.length || (run.proposalsCreated || 0);
    const dedupedCount = ticketsDeduped.length;
    const filteredCount = ticketsFiltered.count || 0;

    // Visually recede runs with nothing interesting
    const isQuiet = createdCount === 0 && dedupedCount === 0 && filteredCount === 0;

    // One-line summary: "2 created, 1 deduped, 0 filtered"
    const summaryParts = [
      `${createdCount} created`,
      `${dedupedCount} deduped`,
      `${filteredCount} filtered`,
    ];
    const summaryText = summaryParts.join(', ');

    // Detail region id
    const detailId = `adv-run-log-detail-${runId}`;

    // ── Collapsed row ──────────────────────────────────────────────────
    const triggerBtn = el('button', {
      className: 'adv-run-log-row-trigger' + (isQuiet ? ' adv-run-log-row-quiet' : ''),
      'aria-expanded': String(isExpanded),
      'aria-controls': detailId,
      onClick: () => {
        this._runLogExpanded[runId] = !this._runLogExpanded[runId];
        this._renderRunLogBody();
      },
    });

    // Status icon (not color-only — icon + text)
    if (createdCount > 0) {
      triggerBtn.appendChild(
        el('span', { className: 'adv-run-log-icon', 'aria-hidden': 'true' }, '✦')
      );
    } else if (dedupedCount > 0) {
      triggerBtn.appendChild(
        el('span', { className: 'adv-run-log-icon adv-run-log-icon-dedup', 'aria-hidden': 'true' }, '⧉')
      );
    }

    // Persona name
    triggerBtn.appendChild(
      el('span', { className: 'adv-run-log-persona' }, personaLabel)
    );

    // DK-367: Scope chip — shown inline when run has a scopeText
    const runLogScopeText = typeof run.scopeText === 'string' && run.scopeText.trim()
      ? run.scopeText.trim()
      : null;
    if (runLogScopeText) {
      const truncated = runLogScopeText.length > 40 ? runLogScopeText.slice(0, 40) + '…' : runLogScopeText;
      triggerBtn.appendChild(
        el('span', {
          className: 'adv-run-log-scope-chip',
          title: runLogScopeText,
          'aria-label': `Run scoped to: ${runLogScopeText}`,
        }, `Focus: ${truncated}`)
      );
    }

    // Timestamp
    triggerBtn.appendChild(
      el('span', {
        className: 'adv-run-log-time',
        title: absTime,
        'aria-label': `${relTime} (${absTime})`,
      }, relTime)
    );

    // One-line summary
    triggerBtn.appendChild(
      el('span', { className: 'adv-run-log-summary' }, summaryText)
    );

    // Chevron
    triggerBtn.appendChild(
      el('span', { className: 'adv-run-log-chevron', 'aria-hidden': 'true' },
        isExpanded ? '▾' : '▸'
      )
    );

    const row = el('div', {
      className: 'adv-run-log-row',
      'data-run-id': runId,
      role: 'listitem',
    }, triggerBtn);

    // ── Expanded detail ────────────────────────────────────────────────
    const detail = el('div', {
      className: 'adv-run-log-detail' + (isExpanded ? '' : ' adv-hidden'),
      id: detailId,
      role: 'region',
      'aria-label': `Run details: ${personaLabel} ${relTime}`,
    });

    if (isExpanded) {
      // DK-367: Scope callout — shown when run was scoped to a specific area
      if (runLogScopeText) {
        detail.appendChild(
          el('div', { className: 'adv-run-log-scope-callout', role: 'note' },
            el('span', { className: 'adv-run-log-scope-callout-label' }, 'This run was scoped to:'),
            ' ',
            el('span', { className: 'adv-run-log-scope-callout-value' }, runLogScopeText),
            el('span', { className: 'adv-run-log-scope-callout-hint' }, ' — results will differ from unscoped runs.')
          )
        );
      }

      // DK-134: Scope matched-zero warning — shown when scope filters matched no files.
      // Surfaced as a visible entry per spec. Not color-only: uses text label "0 files matched".
      if (run.scopeMatchedZero === true) {
        detail.appendChild(
          el('div', {
            className: 'adv-run-log-scope-no-files',
            role: 'alert',
            'aria-label': 'Scope warning: no files matched',
          },
            el('span', { className: 'adv-run-log-scope-no-files-icon', 'aria-hidden': 'true' }, '⚠'),
            el('span', { className: 'adv-run-log-scope-no-files-text' },
              '0 files matched configured scope — no tickets were generated. ',
              el('span', { className: 'adv-run-log-scope-no-files-hint' }, 'Check your path filter patterns.')
            )
          )
        );
      }

      // Created tickets
      if (ticketsCreated.length > 0) {
        detail.appendChild(this._buildRunLogCreatedSection(ticketsCreated));
      }

      // Dedup hits
      if (ticketsDeduped.length > 0) {
        detail.appendChild(this._buildRunLogDedupedSection(ticketsDeduped));
      }

      // Filtered summary
      if (filteredCount > 0) {
        detail.appendChild(this._buildRunLogFilteredSection(ticketsFiltered));
      }

      // DK-405: Screenshot folder link — shown for design/QA runs that saved screenshots locally
      const screenshotFolder = typeof run.screenshotFolder === 'string' && run.screenshotFolder.trim()
        ? run.screenshotFolder.trim()
        : null;
      if (screenshotFolder) {
        detail.appendChild(this._buildRunLogScreenshotFolderSection(screenshotFolder));
      }

      // Empty expanded state
      if (ticketsCreated.length === 0 && ticketsDeduped.length === 0 && filteredCount === 0 && !screenshotFolder) {
        detail.appendChild(
          el('div', { className: 'adv-run-log-empty-detail' }, 'Nothing to report for this run.')
        );
      }
    }

    row.appendChild(detail);
    return row;
  },

  /**
   * Build the "Created tickets" section inside an expanded run log row.
   * Each ticket is a link — shows ID by default, title if we can look it up.
   *
   * @param {string[]} ticketIds - Firestore ticket doc IDs
   * @returns {HTMLElement}
   */
  _buildRunLogCreatedSection(ticketIds) {
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon', 'aria-hidden': 'true' }, '✦'),
        ` Created (${ticketIds.length})`,
      )
    );

    const list = el('ul', { className: 'adv-run-log-ticket-list', role: 'list' });

    for (const docId of ticketIds) {
      // Prefer cached title; show doc ID as fallback
      const cachedTitle = this._runLogTicketTitles[docId];
      const linkText = cachedTitle || docId.slice(0, 16) + (docId.length > 16 ? '…' : '');
      const ariaLabel = cachedTitle
        ? `View ticket: ${cachedTitle}`
        : `View ticket ${docId}`;

      const li = el('li', { className: 'adv-run-log-ticket-item' });
      const link = el('a', {
        className: 'adv-run-log-ticket-link',
        href: `#ticket/${docId}`,
        'aria-label': ariaLabel,
        title: cachedTitle || docId,
        onClick: () => this._closeRunLogDrawer(),
      }, linkText);

      li.appendChild(link);

      // Async: fetch ticket title if not cached, then update the link text
      if (!cachedTitle) {
        this._fetchTicketTitle(docId).then(title => {
          if (title) {
            link.textContent = title;
            link.setAttribute('aria-label', `View ticket: ${title}`);
            link.title = title;
          }
        }).catch(() => {/* non-fatal */});
      }

      list.appendChild(li);
    }

    section.appendChild(list);
    return section;
  },

  /**
   * Build the "Dedup hits" section.
   * Shows blocked ticket title/link and matched keywords phrase.
   *
   * @param {Array<{summary: string, blockedBy: string}>} deduped
   * @returns {HTMLElement}
   */
  _buildRunLogDedupedSection(deduped) {
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon adv-run-log-icon-dedup', 'aria-hidden': 'true' }, '⧉'),
        ` Dedup hits (${deduped.length})`,
      )
    );

    const list = el('ul', { className: 'adv-run-log-dedup-list', role: 'list' });

    for (const hit of deduped) {
      const blockedDocId = hit.blockedBy || '';
      const summary = hit.summary || ''; // matched keywords phrase

      const cachedTitle = blockedDocId ? this._runLogTicketTitles[blockedDocId] : null;
      const linkText = cachedTitle
        ? `View duplicate: ${cachedTitle}`
        : `View duplicate ticket`;
      const ariaLabel = cachedTitle
        ? `View duplicate: ${cachedTitle}`
        : (blockedDocId ? `View duplicate ticket ${blockedDocId}` : 'Duplicate of existing ticket');

      const li = el('li', { className: 'adv-run-log-dedup-item' });

      if (blockedDocId) {
        const link = el('a', {
          className: 'adv-run-log-dedup-link',
          href: `#ticket/${blockedDocId}`,
          'aria-label': ariaLabel,
          title: cachedTitle || blockedDocId,
          onClick: () => this._closeRunLogDrawer(),
        }, linkText);

        li.appendChild(link);

        // Async title lookup
        if (!cachedTitle) {
          this._fetchTicketTitle(blockedDocId).then(title => {
            if (title) {
              link.textContent = `View duplicate: ${title}`;
              link.setAttribute('aria-label', `View duplicate: ${title}`);
              link.title = title;
            }
          }).catch(() => {/* non-fatal */});
        }
      } else {
        li.appendChild(el('span', { className: 'adv-run-log-dedup-label' }, 'Duplicate of existing ticket'));
      }

      // Matched keywords phrase (not AI prose — stored as structured data)
      if (summary) {
        li.appendChild(
          el('span', { className: 'adv-run-log-dedup-keywords' }, ` — matched: ${summary}`)
        );
      }

      list.appendChild(li);
    }

    section.appendChild(list);
    return section;
  },

  /**
   * Build the "Filtered" section with reason codes as plain-language labels.
   *
   * @param {{ count: number, reasons: string[] }} ticketsFiltered
   * @returns {HTMLElement}
   */
  _buildRunLogFilteredSection(ticketsFiltered) {
    const { count, reasons = [] } = ticketsFiltered;
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon', 'aria-hidden': 'true' }, '▽'),
        ` Filtered (${count})`,
      )
    );

    if (reasons.length > 0) {
      const list = el('ul', { className: 'adv-run-log-filtered-list', role: 'list' });
      for (const code of reasons) {
        list.appendChild(
          el('li', { className: 'adv-run-log-filtered-item' }, filterReasonLabel(code))
        );
      }
      section.appendChild(list);
    } else {
      section.appendChild(
        el('div', { className: 'adv-run-log-filtered-count' }, `${count} proposal(s) skipped`)
      );
    }

    return section;
  },

  /**
   * DK-405: Build the "Screenshots" section inside an expanded run log row.
   * Shows a file:// link to the local folder where screenshots were saved.
   * Only rendered for design/QA runs that saved screenshots to disk.
   *
   * @param {string} folderPath - Absolute local path to the screenshot folder
   * @returns {HTMLElement}
   */
  _buildRunLogScreenshotFolderSection(folderPath) {
    const section = el('div', { className: 'adv-run-log-section' });

    section.appendChild(
      el('div', { className: 'adv-run-log-section-header' },
        el('span', { className: 'adv-run-log-section-icon', 'aria-hidden': 'true' }, '📷'),
        ' Screenshots',
      )
    );

    // Encode the path for use as a file:// URL
    const fileUrl = 'file://' + folderPath.replace(/ /g, '%20');

    section.appendChild(
      el('div', { className: 'adv-run-log-screenshot-folder' },
        el('a', {
          className: 'adv-run-log-screenshot-folder-link',
          href: fileUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: folderPath,
          'aria-label': `Open screenshot folder: ${folderPath}`,
        }, folderPath),
      )
    );

    return section;
  },

  /**
   * Fetch and cache a ticket title from Firestore.
   * The cache is per-drawer-session (reset on drawer rebuild).
   *
   * @param {string} docId - Firestore ticket document ID
   * @returns {Promise<string|null>}
   */
  async _fetchTicketTitle(docId) {
    if (this._runLogTicketTitles[docId]) return this._runLogTicketTitles[docId];

    // Search all projects for the ticket
    // We don't know the projectId, so we use a collectionGroup query.
    // Fallback: try the current project's tickets subcollection first.
    try {
      const projectId = this._filterProjectId;
      if (projectId) {
        const snap = await this.db
          .collection('projects').doc(projectId)
          .collection('tickets').doc(docId)
          .get();
        if (snap.exists) {
          const title = snap.data().title || null;
          if (title) this._runLogTicketTitles[docId] = title;
          return title;
        }
      }
    } catch {/* fallback to collectionGroup */}

    // Try to find ticket across all projects via the ticketId field or doc ID
    try {
      // Try each project we know about
      for (const project of this._projects) {
        try {
          const snap = await this.db
            .collection('projects').doc(project.id)
            .collection('tickets').doc(docId)
            .get();
          if (snap.exists) {
            const title = snap.data().title || null;
            if (title) this._runLogTicketTitles[docId] = title;
            return title;
          }
        } catch {/* continue */}
      }
    } catch {/* non-fatal */}

    return null;
  }
};
