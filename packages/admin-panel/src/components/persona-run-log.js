// @docket/admin-panel — PersonaRunLog: per-persona collapsible run history panel

import { el } from '../el.js';
import { relativeTime, toISOString } from '../format.js';

/**
 * PersonaRunLog — collapsible log panel showing run history for a single persona.
 *
 * Usage:
 *   const runLog = new PersonaRunLog({ db, personaId: 'engineer', personaLabel: 'Engineer', limit: 20 });
 *   body.appendChild(runLog.render());
 *
 * The panel is closed by default. On expand, it fetches run history from Firestore.
 */
export class PersonaRunLog {
  /**
   * @param {object} opts
   * @param {object} opts.db          - Firestore web SDK instance
   * @param {string} opts.personaId   - Persona ID (e.g. "engineer", "design", "product")
   * @param {string} opts.personaLabel - Display name (e.g. "Engineer")
   * @param {number} [opts.limit=20]  - Max runs to fetch
   * @param {Function} [opts.getTicketUrl] - (ticketId: string) => string — optional URL builder for matched tickets
   */
  constructor({ db, personaId, personaLabel, limit = 20, getTicketUrl }) {
    this.db = db;
    this.personaId = personaId;
    this.personaLabel = personaLabel;
    this.limit = limit;
    this.getTicketUrl = getTicketUrl || null;
    this._expanded = false;
    this._runs = null; // null = not fetched yet, [] = fetched (empty), [...] = fetched
    this._loading = false;
    this._error = null;
    this._el = null;
    this._contentEl = null;
    this._toggleBtn = null;
    // Page size for skipped reasons lists
    this._PAGE_SIZE = 20;
  }

  render() {
    const panelId = `tk-run-log-${this.personaId}`;

    this._contentEl = el('div', {
      className: 'tk-run-log-content',
      id: panelId,
      hidden: true,
    });

    this._toggleBtn = el('button', {
      type: 'button',
      className: 'tk-run-log-toggle',
      'aria-expanded': 'false',
      'aria-controls': panelId,
      onClick: () => this._toggle(),
    },
      el('span', { className: 'tk-run-log-toggle-icon', 'aria-hidden': 'true' }, '▶'),
      el('span', { className: 'tk-run-log-toggle-label' },
        `${this.personaLabel} Run Log`,
      ),
    );

    this._el = el('div', { className: 'tk-run-log' },
      this._toggleBtn,
      this._contentEl,
    );

    return this._el;
  }

  async _toggle() {
    this._expanded = !this._expanded;
    this._toggleBtn.setAttribute('aria-expanded', String(this._expanded));
    const icon = this._toggleBtn.querySelector('.tk-run-log-toggle-icon');
    if (icon) icon.textContent = this._expanded ? '▼' : '▶';

    if (this._expanded) {
      this._contentEl.removeAttribute('hidden');
      if (this._runs === null && !this._loading) {
        await this._fetchRuns();
      } else {
        this._renderContent();
      }
    } else {
      this._contentEl.setAttribute('hidden', '');
    }
  }

  async _fetchRuns() {
    this._loading = true;
    this._error = null;
    this._renderContent(); // show loading state

    try {
      const snap = await this.db
        .collection('advisor')
        .doc(this.personaId)
        .collection('runs')
        .orderBy('startedAt', 'desc')
        .limit(this.limit)
        .get();
      this._runs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      this._error = err.message || 'Failed to load run history';
      this._runs = null;
    } finally {
      this._loading = false;
      this._renderContent();
    }
  }

  _renderContent() {
    this._contentEl.innerHTML = '';

    if (this._loading) {
      this._contentEl.appendChild(
        el('div', { className: 'tk-run-log-loading' },
          el('span', { className: 'tk-spinner', 'aria-hidden': 'true' }),
          'Loading run history\u2026',
        )
      );
      return;
    }

    if (this._error) {
      this._contentEl.appendChild(
        el('div', { className: 'tk-run-log-error', role: 'alert' },
          `Error: ${this._error}`,
        )
      );
      return;
    }

    if (!this._runs || this._runs.length === 0) {
      this._contentEl.appendChild(
        el('div', { className: 'tk-run-log-empty' },
          'No runs yet \u2014 this persona has not executed since being configured.',
        )
      );
      return;
    }

    const runsEl = el('div', { className: 'tk-run-log-list', role: 'list' });

    this._runs.forEach((run, idx) => {
      runsEl.appendChild(this._renderRunCard(run, idx === 0));
    });

    this._contentEl.appendChild(runsEl);
  }

  /**
   * Render a single run as a summary card with expandable detail.
   *
   * @param {object} run - Run document from Firestore
   * @param {boolean} defaultExpanded - Whether to expand the card by default
   */
  _renderRunCard(run, defaultExpanded) {
    const cardId = `tk-run-card-${run.id}`;
    let isExpanded = defaultExpanded;

    const created = run.proposalsCreated || 0;
    const skipped = run.proposalsSkipped || 0;
    const errors = run.error ? 1 : 0;

    // Outcome summary chips
    const chips = [];
    chips.push(el('span', {
      className: `tk-run-chip tk-run-chip-created`,
      'aria-label': `${created} proposal${created !== 1 ? 's' : ''} created`,
    },
      el('span', { className: 'tk-run-chip-icon', 'aria-hidden': 'true' }, '\u2714'),
      ` ${created} created`,
    ));
    if (skipped > 0) {
      chips.push(el('span', {
        className: 'tk-run-chip tk-run-chip-skipped',
        'aria-label': `${skipped} proposal${skipped !== 1 ? 's' : ''} suppressed`,
      },
        el('span', { className: 'tk-run-chip-icon', 'aria-hidden': 'true' }, '\u23ED'),
        ` ${skipped} suppressed`,
      ));
    }
    if (errors > 0) {
      chips.push(el('span', {
        className: 'tk-run-chip tk-run-chip-error',
        'aria-label': '1 error',
      },
        el('span', { className: 'tk-run-chip-icon', 'aria-hidden': 'true' }, '\u26A0'),
        ' 1 error',
      ));
    }

    // Timestamp
    const ts = run.startedAt;
    const isoStr = toISOString(ts);
    const relStr = relativeTime(ts);
    const timeEl = isoStr
      ? el('time', { className: 'tk-run-time', datetime: isoStr }, relStr)
      : el('span', { className: 'tk-run-time' }, relStr);

    // Collapsed header
    const summaryEl = el('div', { className: 'tk-run-card-summary' },
      timeEl,
      el('div', { className: 'tk-run-chips' }, chips),
    );

    // Detail content (initially hidden if not defaultExpanded)
    const detailEl = el('div', {
      className: 'tk-run-card-detail',
      id: cardId,
    });
    if (!isExpanded) detailEl.setAttribute('hidden', '');
    this._renderRunDetail(run, detailEl);

    // Toggle button
    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-run-card-toggle',
      'aria-expanded': String(isExpanded),
      'aria-controls': cardId,
      onClick: () => {
        isExpanded = !isExpanded;
        toggleBtn.setAttribute('aria-expanded', String(isExpanded));
        const icon = toggleBtn.querySelector('.tk-run-card-icon');
        if (icon) icon.textContent = isExpanded ? '▼' : '▶';
        if (isExpanded) {
          detailEl.removeAttribute('hidden');
        } else {
          detailEl.setAttribute('hidden', '');
        }
      },
    },
      el('span', { className: 'tk-run-card-icon', 'aria-hidden': 'true' }, isExpanded ? '▼' : '▶'),
      summaryEl,
    );

    return el('div', {
      className: 'tk-run-card',
      role: 'listitem',
    },
      toggleBtn,
      detailEl,
    );
  }

  /**
   * Render the detail section of a run card.
   *
   * @param {object} run - Run document
   * @param {HTMLElement} container - Element to populate
   */
  _renderRunDetail(run, container) {
    const created = run.proposalsCreated || 0;
    const skipped = run.proposalsSkipped || 0;
    const filesScanned = run.filesScanned || 0;

    // Outcome summary line
    const summaryParts = [];
    summaryParts.push(`${created} proposal${created !== 1 ? 's' : ''} created`);
    summaryParts.push(`${skipped} suppressed`);
    if (filesScanned > 0) summaryParts.push(`${filesScanned} file${filesScanned !== 1 ? 's' : ''} scanned`);

    container.appendChild(
      el('p', { className: 'tk-run-detail-summary' }, summaryParts.join(', '))
    );

    // Error section
    if (run.error) {
      container.appendChild(
        el('div', { className: 'tk-run-detail-error', role: 'alert' },
          el('span', { className: 'tk-run-chip-icon', 'aria-hidden': 'true' }, '\u26A0'),
          ` ${run.error}`,
        )
      );
    }

    // Skipped reasons list
    const reasons = Array.isArray(run.skippedReasons) ? run.skippedReasons : [];
    if (reasons.length > 0) {
      container.appendChild(this._renderSkippedList(reasons));
    } else if (skipped > 0 && created === 0) {
      // Proposals were suppressed but skippedReasons array is empty (older run format)
      container.appendChild(
        el('p', { className: 'tk-run-detail-quiet' },
          'Last run produced no proposals \u2014 all candidates were suppressed as duplicates.'
        )
      );
    }
  }

  /**
   * Render the paginated list of skipped proposals.
   *
   * @param {Array} reasons - Array of { title, reason, matchedTicketId? }
   * @returns {HTMLElement}
   */
  _renderSkippedList(reasons) {
    const PAGE = this._PAGE_SIZE;
    let offset = 0;

    const listEl = el('div', { className: 'tk-run-skipped' });
    listEl.appendChild(
      el('div', { className: 'tk-run-skipped-label' },
        `Suppressed proposals (${reasons.length})`,
      )
    );

    const itemsContainer = el('ul', {
      className: 'tk-run-skipped-list',
      'aria-label': 'Suppressed proposals',
    });
    listEl.appendChild(itemsContainer);

    const renderPage = () => {
      const page = reasons.slice(offset, offset + PAGE);
      page.forEach(r => {
        itemsContainer.appendChild(this._renderSkippedItem(r));
      });
      offset += page.length;
    };

    renderPage();

    if (reasons.length > PAGE) {
      const remaining = reasons.length - offset;
      const showMoreBtn = el('button', {
        type: 'button',
        className: 'tk-run-show-more',
        onClick: () => {
          renderPage();
          const newRemaining = reasons.length - offset;
          if (newRemaining <= 0) {
            showMoreBtn.remove();
          } else {
            showMoreBtn.textContent = `Show ${Math.min(PAGE, newRemaining)} more\u2026`;
          }
        },
      }, `Show ${Math.min(PAGE, remaining)} more\u2026`);
      listEl.appendChild(showMoreBtn);
    }

    return listEl;
  }

  /**
   * Render a single suppressed proposal entry.
   *
   * @param {{ title: string, reason: string, matchedTicketId?: string }} item
   * @returns {HTMLElement}
   */
  _renderSkippedItem(item) {
    const titleEl = el('span', { className: 'tk-run-skipped-title' }, item.title || '(untitled)');
    const reasonEl = el('span', { className: 'tk-run-skipped-reason' }, item.reason || 'suppressed');

    const children = [titleEl, el('span', { 'aria-hidden': 'true' }, ' \u2014 '), reasonEl];

    if (item.matchedTicketId && this.getTicketUrl) {
      const url = this.getTicketUrl(item.matchedTicketId);
      if (url) {
        children.push(
          el('span', { 'aria-hidden': 'true' }, ' ('),
          el('a', {
            href: url,
            className: 'tk-run-skipped-link',
            target: '_blank',
            rel: 'noopener noreferrer',
          }, 'matched ticket'),
          el('span', { 'aria-hidden': 'true' }, ')'),
        );
      }
    }

    return el('li', { className: 'tk-run-skipped-item' }, children);
  }
}
