// Trigger Log Drawer — DK-136.
// Mixin attached to AdvisorPanel.prototype. Maintains drawer state on `this`,
// reads /advisorTriggerLog from Firestore, and renders a filterable table.

import { el } from '../ui/el.js';
import { formatRelative } from '../ui/format.js';

export const triggerLogMixin = {
  // ── DK-136: Trigger Log Drawer ────────────────────────────────────────────

  /**
   * Open the trigger log drawer. Builds it once, then reuses.
   */
  _openTriggerLogDrawer() {
    if (!this._triggerLogDrawer) {
      this._triggerLogDrawer = this._buildTriggerLogDrawer();
      document.body.appendChild(this._triggerLogDrawer);
    }

    this._triggerLogDrawerOpen = true;
    this._triggerLogDrawer.classList.remove('adv-drawer-hidden');
    this._triggerLogDrawer.setAttribute('aria-hidden', 'false');

    const firstFocusable = this._triggerLogDrawer.querySelector('button, [tabindex="0"]');
    if (firstFocusable) firstFocusable.focus();

    if (this._triggerLogEntries === null) {
      this._fetchTriggerLogEntries();
    } else {
      this._renderTriggerLogBody();
    }
  },

  /**
   * Close the trigger log drawer.
   */
  _closeTriggerLogDrawer() {
    if (!this._triggerLogDrawer) return;
    this._triggerLogDrawerOpen = false;
    this._triggerLogDrawer.classList.add('adv-drawer-hidden');
    this._triggerLogDrawer.setAttribute('aria-hidden', 'true');
    if (this._triggerLogBtn) this._triggerLogBtn.focus();
  },

  /**
   * Build the trigger log drawer DOM once.
   * @returns {HTMLElement}
   */
  _buildTriggerLogDrawer() {
    const self = this;

    const backdrop = el('div', {
      className: 'adv-drawer-backdrop',
      'aria-hidden': 'true',
      onClick: () => self._closeTriggerLogDrawer(),
    });

    const panel = el('div', {
      className: 'adv-drawer-panel adv-trigger-log-drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Advisor trigger log',
    });

    // Header
    const closeBtn = el('button', {
      className: 'adv-drawer-close',
      'aria-label': 'Close trigger log',
      title: 'Close',
      onClick: () => self._closeTriggerLogDrawer(),
    }, '✕');

    const refreshBtn = el('button', {
      className: 'adv-drawer-refresh',
      'aria-label': 'Refresh trigger log',
      title: 'Refresh',
      onClick: () => {
        self._triggerLogEntries = null;
        self._fetchTriggerLogEntries();
      },
    }, '↻');

    const drawerTitle = el('h2', { className: 'adv-drawer-title' }, 'Trigger Log');

    // Filter bar — by persona
    const filterAll = el('button', {
      className: 'adv-trigger-log-filter-btn adv-trigger-log-filter-active',
      'aria-pressed': 'true',
      onClick: () => {
        self._triggerLogFilter = null;
        self._renderTriggerLogBody();
        filterAll.setAttribute('aria-pressed', 'true');
        filterAll.classList.add('adv-trigger-log-filter-active');
        [filterEngineer, filterDesign, filterProduct, filterQA].forEach(b => {
          b.setAttribute('aria-pressed', 'false');
          b.classList.remove('adv-trigger-log-filter-active');
        });
      },
    }, 'All');

    const makeFilterBtn = (pid, label) => el('button', {
      className: 'adv-trigger-log-filter-btn',
      'aria-pressed': 'false',
      onClick: () => {
        self._triggerLogFilter = pid;
        self._renderTriggerLogBody();
        filterAll.setAttribute('aria-pressed', 'false');
        filterAll.classList.remove('adv-trigger-log-filter-active');
        [filterEngineer, filterDesign, filterProduct, filterQA].forEach(b => {
          const active = b.dataset.persona === pid;
          b.setAttribute('aria-pressed', String(active));
          b.classList.toggle('adv-trigger-log-filter-active', active);
        });
      },
    }, label);

    const filterEngineer = makeFilterBtn('engineer', 'Engineer');
    filterEngineer.dataset.persona = 'engineer';
    const filterDesign = makeFilterBtn('design', 'Design');
    filterDesign.dataset.persona = 'design';
    const filterProduct = makeFilterBtn('product', 'Product');
    filterProduct.dataset.persona = 'product';
    const filterQA = makeFilterBtn('qa', 'QA');
    filterQA.dataset.persona = 'qa';

    const filterBar = el('div', { className: 'adv-trigger-log-filter-bar', role: 'group', 'aria-label': 'Filter by persona' },
      filterAll,
      filterEngineer,
      filterDesign,
      filterProduct,
      filterQA,
    );

    const headerRow = el('div', { className: 'adv-drawer-header' },
      drawerTitle,
      el('div', { className: 'adv-drawer-header-actions' },
        refreshBtn,
        closeBtn,
      ),
    );

    // Body — holds loading spinner or table
    const body = el('div', { className: 'adv-trigger-log-body' });
    this._triggerLogBodyEl = body;
    this._triggerLogFilterAll = filterAll;
    this._triggerLogFilterBtns = [filterEngineer, filterDesign, filterProduct, filterQA];

    panel.appendChild(headerRow);
    panel.appendChild(filterBar);
    panel.appendChild(body);

    const overlay = el('div', {
      className: 'adv-drawer-overlay adv-drawer-hidden',
      role: 'presentation',
    });
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);

    return overlay;
  },

  /**
   * Fetch trigger log entries from Firestore.
   */
  async _fetchTriggerLogEntries() {
    if (this._triggerLogLoading) return;
    this._triggerLogLoading = true;
    if (this._triggerLogBodyEl) {
      this._triggerLogBodyEl.textContent = '';
      this._triggerLogBodyEl.appendChild(
        el('div', { className: 'adv-trigger-log-loading' }, 'Loading…')
      );
    }

    try {
      let query = this.db.collection('advisorTriggerLog')
        .orderBy('triggeredAt', 'desc')
        .limit(100);

      const snap = await query.get();
      this._triggerLogEntries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      this._triggerLogEntries = [];
      console.error('Failed to load trigger log:', err);
    } finally {
      this._triggerLogLoading = false;
      this._renderTriggerLogBody();
    }
  },

  /**
   * Render the trigger log table body.
   */
  _renderTriggerLogBody() {
    if (!this._triggerLogBodyEl) return;
    this._triggerLogBodyEl.textContent = '';

    const entries = this._triggerLogEntries || [];
    const filtered = this._triggerLogFilter
      ? entries.filter(e => e.personaId === this._triggerLogFilter)
      : entries;

    if (filtered.length === 0) {
      const emptyMsg = entries.length === 0
        ? 'No trigger events yet. Runs are logged here when triggered by webhook, ticket-close count, or manual button.'
        : 'No entries for this persona.';
      this._triggerLogBodyEl.appendChild(
        el('div', { className: 'adv-trigger-log-empty' }, emptyMsg)
      );
      return;
    }

    // Table with columns: Persona | Trigger | When | Proposals
    const thead = el('thead', {},
      el('tr', {},
        el('th', { scope: 'col' }, 'Persona'),
        el('th', { scope: 'col' }, 'Trigger'),
        el('th', { scope: 'col' }, 'When'),
        el('th', { scope: 'col' }, 'Proposals'),
      ),
    );

    const TRIGGER_LABELS = {
      manual: 'Manual',
      webhook: 'Webhook / Deploy',
      ticketCloseCount: 'Ticket batch',
      interval: 'Scheduled',
    };

    const PERSONA_LABELS = {
      engineer: 'Engineer',
      design: 'Design',
      product: 'Product',
      qa: 'QA',
    };

    const rows = filtered.map(entry => {
      const personaLabel = PERSONA_LABELS[entry.personaId] || entry.personaId;
      const triggerLabel = TRIGGER_LABELS[entry.trigger] || entry.trigger;
      const whenText = entry.triggeredAt ? (formatRelative(entry.triggeredAt) || new Date(entry.triggeredAt).toLocaleString()) : '—';
      const proposalsText = entry.proposalsCreated != null ? String(entry.proposalsCreated) : '—';
      const byText = entry.triggeredBy && entry.triggeredBy !== 'system' && entry.triggeredBy !== 'webhook'
        ? ` (${entry.triggeredBy})`
        : '';

      return el('tr', { className: 'adv-trigger-log-row' },
        el('td', {}, personaLabel),
        el('td', {}, triggerLabel + byText),
        el('td', {},
          el('time', { datetime: entry.triggeredAt || '' }, whenText),
        ),
        el('td', {}, proposalsText),
      );
    });

    const tbody = el('tbody', {}, ...rows);
    const table = el('table', {
      className: 'adv-trigger-log-table',
      'aria-label': 'Trigger log',
    }, thead, tbody);

    this._triggerLogBodyEl.appendChild(table);
  }
};
