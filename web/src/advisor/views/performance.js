// Performance dashboard + acceptance-rate section.
// Inline expansion within each persona card showing 30/90-day stats,
// sparkline, and aggregate acceptance rate. ~520 lines, 4 methods.

import { el } from '../ui/el.js';
import { toDate } from '../ui/format.js';
import {
  computeSparkline,
  computeStats,
  healthFromRate,
  buildSparklineSvg,
  buildSparklineAriaLabel,
} from '../ui/sparkline.js';
import { HEALTH_META } from '../config/labels.js';
import { PERSONAS } from '../config/personas.js';

export const performanceMixin = {
  // ── Performance dashboard ────────────────────────────────────

  /**
   * Toggle the performance dashboard for a persona.
   * Loads data on first open; subsequent opens use cached data.
   */
  _togglePerfDash(personaId) {
    const isExpanded = !this._perfDashExpanded[personaId];
    this._perfDashExpanded[personaId] = isExpanded;

    const container = this._perfDashContainers[personaId];
    const card = this._cards[personaId];
    if (!container || !card) return;

    if (isExpanded) {
      container.classList.remove('adv-perf-dash-hidden');
      card.statsBtn.textContent = 'Stats ▾';
      card.statsBtn.setAttribute('aria-expanded', 'true');
      // Load data if not already loaded
      if (!this._perfDashData[personaId]) {
        this._loadPerfDash(personaId);
      } else {
        this._renderPerfDash(personaId);
      }
    } else {
      container.classList.add('adv-perf-dash-hidden');
      card.statsBtn.textContent = 'Stats ▸';
      card.statsBtn.setAttribute('aria-expanded', 'false');
    }
  },

  /**
   * Load performance data for a persona from Firestore.
   * Uses a collectionGroup query across all projects.
   * Data is not auto-refreshed — user can manually refresh.
   */
  async _loadPerfDash(personaId) {
    this._perfDashLoading[personaId] = true;
    this._renderPerfDash(personaId);

    try {
      const windowMs = this._perfDashWindowDays * 24 * 60 * 60 * 1000;
      // Use a Date object (not an ISO string) for the Firestore range query.
      // tickets.createdAt is stored as a Firestore serverTimestamp (Timestamp type).
      // Firestore cannot compare a Timestamp field against a string value — the
      // query would return empty results. The Firebase compat SDK accepts a JS Date
      // as a valid Timestamp comparator.
      const since = new Date(Date.now() - windowMs);

      // collectionGroup query: tickets across all projects where advisorPersona matches
      const snap = await this.db.collectionGroup('tickets')
        .where('advisorPersona', '==', personaId)
        .where('createdAt', '>=', since)
        .get();

      const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this._perfDashData[personaId] = { tickets, fetchedAt: new Date() };
    } catch (err) {
      console.error(`AdvisorPanel: failed to load perf data for ${personaId}`, err);
      this._perfDashData[personaId] = { tickets: [], fetchedAt: new Date(), error: err.message };
    } finally {
      this._perfDashLoading[personaId] = false;
      this._renderPerfDash(personaId);
    }
  },

  /**
   * Render the performance dashboard into its container.
   * Called after data loads and when the time window changes.
   */
  _renderPerfDash(personaId) {
    const container = this._perfDashContainers[personaId];
    if (!container) return;
    container.innerHTML = '';

    // ── Header row: time filter + refresh ──────────────────────
    const windowDays = this._perfDashWindowDays;
    const make30Btn = el('button', {
      className: 'adv-perf-filter-btn' + (windowDays === 30 ? ' adv-perf-filter-btn-active' : ''),
      'aria-pressed': String(windowDays === 30),
      onClick: () => {
        if (this._perfDashWindowDays !== 30) {
          this._perfDashWindowDays = 30;
          // Clear cached data so it reloads with new window
          for (const pid of Object.keys(this._perfDashExpanded)) {
            if (this._perfDashExpanded[pid]) {
              this._perfDashData[pid] = null;
              this._loadPerfDash(pid);
            }
          }
        }
      },
    }, '30d');

    const make90Btn = el('button', {
      className: 'adv-perf-filter-btn' + (windowDays === 90 ? ' adv-perf-filter-btn-active' : ''),
      'aria-pressed': String(windowDays === 90),
      onClick: () => {
        if (this._perfDashWindowDays !== 90) {
          this._perfDashWindowDays = 90;
          for (const pid of Object.keys(this._perfDashExpanded)) {
            if (this._perfDashExpanded[pid]) {
              this._perfDashData[pid] = null;
              this._loadPerfDash(pid);
            }
          }
        }
      },
    }, '90d');

    const data = this._perfDashData[personaId];
    const isLoading = this._perfDashLoading[personaId];

    // Refresh button + last updated timestamp
    const refreshBtn = el('button', {
      className: 'adv-perf-refresh-btn',
      title: 'Refresh stats',
      disabled: isLoading,
      onClick: () => {
        this._perfDashData[personaId] = null;
        this._loadPerfDash(personaId);
      },
    }, isLoading ? '…' : '↺');

    const fetchedAtStr = data?.fetchedAt
      ? `Updated ${data.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    container.appendChild(
      el('div', { className: 'adv-perf-header' },
        el('div', { className: 'adv-perf-filter-group', role: 'group', 'aria-label': 'Time window' },
          make30Btn,
          make90Btn,
        ),
        el('div', { className: 'adv-perf-refresh-row' },
          el('span', { className: 'adv-perf-updated' }, fetchedAtStr),
          refreshBtn,
        ),
      )
    );

    // ── Loading state ──────────────────────────────────────────
    if (isLoading) {
      container.appendChild(
        el('div', { className: 'adv-perf-loading', 'aria-busy': 'true' },
          el('span', { 'aria-hidden': 'true', className: 'adv-history-spinner' }),
          el('span', {}, 'Loading stats…'),
        )
      );
      return;
    }

    // ── Error state ────────────────────────────────────────────
    if (!data) {
      container.appendChild(
        el('div', { className: 'adv-perf-empty' }, 'Click ↺ to load stats.')
      );
      return;
    }

    if (data.error) {
      container.appendChild(
        el('div', { className: 'adv-perf-error' }, `Could not load stats: ${data.error}`)
      );
      return;
    }

    // ── Cold start check ───────────────────────────────────────
    const personaState = this._states[personaId];
    const cycleCount = personaState?.cycleCount ?? 0;
    const MIN_CYCLES = 5;

    if (cycleCount < MIN_CYCLES) {
      container.appendChild(
        el('div', { className: 'adv-perf-cold-start' },
          el('span', { className: 'adv-perf-cold-icon', 'aria-hidden': 'true' }, '🌱'),
          el('p', { className: 'adv-perf-cold-msg' },
            `Not enough data yet. ${cycleCount} of ${MIN_CYCLES} cycles completed. ` +
            `Stats will appear once this persona has run at least ${MIN_CYCLES} times.`
          ),
        )
      );
      return;
    }

    const tickets = data.tickets;
    const stats = computeStats(tickets);

    // ── Health indicator ───────────────────────────────────────
    const acceptanceRate = stats.generated > 0 ? stats.accepted / stats.generated : 0;
    const health = healthFromRate(acceptanceRate);
    const healthMeta = HEALTH_META[health];

    container.appendChild(
      el('div', { className: 'adv-perf-health' },
        el('span', {
          className: `adv-perf-dot ${healthMeta.cls}`,
          'aria-hidden': 'true',
        }),
        el('span', { className: 'adv-perf-health-label' }, healthMeta.label),
        el('span', { className: 'adv-perf-rate' },
          `${Math.round(acceptanceRate * 100)}% acceptance`
        ),
      )
    );

    // ── Summary stats ──────────────────────────────────────────
    const statItems = [
      { label: 'Generated', value: stats.generated, sub: '' },
      { label: 'Accepted',  value: stats.accepted,  sub: stats.generated > 0 ? `${Math.round(stats.accepted / stats.generated * 100)}%` : '' },
      { label: 'Rejected',  value: stats.rejected,  sub: stats.generated > 0 ? `${Math.round(stats.rejected / stats.generated * 100)}%` : '' },
      { label: 'Pending',   value: stats.proposed,  sub: '' },
    ];

    const statRow = el('div', { className: 'adv-perf-stats-row' });
    for (const s of statItems) {
      statRow.appendChild(
        el('div', { className: 'adv-perf-stat' },
          el('span', { className: 'adv-perf-stat-val' }, String(s.value)),
          el('span', { className: 'adv-perf-stat-label' }, s.label),
          s.sub ? el('span', { className: 'adv-perf-stat-sub' }, s.sub) : null,
        )
      );
    }
    container.appendChild(statRow);

    // Snoozed footnote
    container.appendChild(
      el('p', { className: 'adv-perf-snooze-note' },
        '* Snoozed proposals (dismissed temporarily) are included in Pending until acted on.'
      )
    );

    // ── Sparkline ──────────────────────────────────────────────
    const sparkRates = computeSparkline(tickets, windowDays);
    const ariaLabel = buildSparklineAriaLabel(sparkRates, windowDays);

    container.appendChild(
      el('div', { className: 'adv-perf-sparkline-wrap' },
        el('span', { className: 'adv-perf-spark-label' }, `Acceptance rate / week (${windowDays}d)`),
        buildSparklineSvg(sparkRates, ariaLabel),
      )
    );

    // ── Last / next run timestamps ─────────────────────────────
    // Next run is computed client-side from lastRunAt + intervalHours per spec.
    if (personaState) {
      const lastRun = personaState.lastRunAt
        ? new Date(personaState.lastRunAt).toLocaleString()
        : '—';
      // Compute nextRunAt client-side; do not read it from Firestore
      const lastRunDate = toDate(personaState.lastRunAt);
      const iHours = personaState.intervalHours ?? (PERSONAS.find(p => p.id === personaId)?.defaultHours ?? 24);
      const nextRunMs = lastRunDate ? lastRunDate.getTime() + iHours * 3600_000 : 0;
      const nextRun = nextRunMs > 0 ? new Date(nextRunMs).toLocaleString() : '—';
      const nextRunLabel = nextRunMs > Date.now() ? nextRun : 'Soon';

      container.appendChild(
        el('div', { className: 'adv-perf-timestamps' },
          el('div', { className: 'adv-perf-ts-row' },
            el('span', { className: 'adv-perf-ts-label' }, 'Last run'),
            el('span', { className: 'adv-perf-ts-val' }, lastRun),
          ),
          el('div', { className: 'adv-perf-ts-row' },
            el('span', { className: 'adv-perf-ts-label' }, 'Next run'),
            el('span', { className: 'adv-perf-ts-val' }, nextRunLabel),
          ),
        )
      );
    }

    // ── Inline frequency control ───────────────────────────────
    const personaCard = this._cards[personaId];
    const currentHours = personaState?.intervalHours ?? (PERSONAS.find(p => p.id === personaId)?.defaultHours ?? 24);
    const freqInput = el('input', {
      className: 'adv-interval-input adv-perf-freq-input',
      type: 'number',
      min: '1',
      max: '168',
      value: String(currentHours),
      title: 'Interval in hours',
      'aria-label': 'Run interval in hours',
    });
    const freqSaveBtn = el('button', {
      className: 'adv-interval-save',
      title: 'Save interval',
      onClick: () => this._saveInterval(personaId, freqInput.value, 'hours'),
    }, 'Save');

    container.appendChild(
      el('div', { className: 'adv-perf-freq' },
        el('span', { className: 'adv-perf-freq-label' }, 'Run every'),
        freqInput,
        el('span', { className: 'adv-perf-freq-unit' }, 'hours'),
        freqSaveBtn,
      )
    );

    // Keep freqInput in sync if personaState updates
    if (personaCard) personaCard._perfFreqInput = freqInput;
  },

  _buildCustomPersonasSection() {
    const section = el('div', { className: 'adv-custom-section' });

    this._customPersonasBody = el('div', { className: 'adv-custom-body', id: 'adv-custom-body' });

    // "Add" button — always visible, disabled when at cap
    const addBtn = el('button', {
      className: 'adv-custom-add-btn',
      title: 'Create a new custom persona',
      onClick: () => this._openCustomPersonaModal(null),
    }, '+ Add Persona');
    this._addPersonaBtn = addBtn;

    section.appendChild(
      el('div', { className: 'adv-custom-add-row' },
        addBtn,
      )
    );

    section.appendChild(this._customPersonasBody);

    return section;
  },

  /**
   * Build the acceptance rate summary table section (DK-196).
   * Shows a collapsible table with one row per persona:
   *   persona name | proposed | accepted | rejected | acceptance rate %
   * Data is loaded from feedbackEvents on first expand.
   */
  _buildAcceptanceRateSection() {
    const section = el('div', { className: 'adv-acceptance-section' });

    // Collapsible header
    const isExpanded = this._collapsedCardSections.has('acceptance-rate');
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');
    const header = el('button', {
      className: 'adv-acceptance-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-acceptance-body',
      onClick: () => this._toggleAcceptanceSection(body, chevron, header),
    },
      chevron,
      el('span', {}, 'Acceptance Rates'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-acceptance-body',
      id: 'adv-acceptance-body',
    });
    if (!isExpanded) body.classList.add('adv-hidden');
    section.appendChild(body);

    this._acceptanceBody = body;

    if (isExpanded) {
      this._loadAcceptanceRates();
    }

    return section;
  },

  _toggleAcceptanceSection(bodyEl, chevronEl, headerEl) {
    const isExpanded = this._collapsedCardSections.has('acceptance-rate');
    if (isExpanded) {
      // Collapse
      this._collapsedCardSections.delete('acceptance-rate');
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      headerEl.setAttribute('aria-expanded', 'false');
    } else {
      // Expand and load
      this._collapsedCardSections.add('acceptance-rate');
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      headerEl.setAttribute('aria-expanded', 'true');
      this._loadAcceptanceRates();
    }
    this._saveCardSectionCollapseState();
  },

  /**
   * Load acceptance rate data for all personas from feedbackEvents.
   * Queries the last 90 days across all projects the user can see.
   * Renders a table with: persona | proposed | accepted | rejected | rate%
   */
  async _loadAcceptanceRates() {
    if (!this._acceptanceBody) return;
    this._acceptanceBody.innerHTML = '';
    this._acceptanceBody.appendChild(
      el('div', { className: 'adv-acceptance-loading' },
        el('span', { 'aria-hidden': 'true', className: 'adv-history-spinner' }),
        el('span', {}, 'Loading…'),
      )
    );

    try {
      const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
      if (!projectId) {
        this._acceptanceBody.innerHTML = '';
        this._acceptanceBody.appendChild(
          el('div', { className: 'adv-acceptance-empty' }, 'No project selected.')
        );
        return;
      }

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Fetch all feedbackEvents across all built-in personas in parallel
      const allPersonaIds = [
        ...PERSONAS.map(p => p.id),
        ...this._customPersonas.map(p => p.id || p._docId).filter(Boolean),
      ];

      const results = await Promise.all(
        allPersonaIds.map(async (pid) => {
          try {
            const snap = await this.db
              .collection('projects')
              .doc(projectId)
              .collection('feedbackEvents')
              .where('personaId', '==', pid)
              .orderBy('timestamp', 'desc')
              .limit(200)
              .get();

            let accepted = 0, rejected = 0;
            for (const doc of snap.docs) {
              const data = doc.data();
              const ts = data.timestamp?.toDate?.() ?? null;
              if (ts && ts < cutoff) break;
              if (data.decision === 'accepted') accepted++;
              else if (data.decision === 'rejected') rejected++;
            }
            const total = accepted + rejected;
            const rate = total > 0 ? Math.round(accepted / total * 100) : null;
            return { personaId: pid, accepted, rejected, total, rate };
          } catch {
            return { personaId: pid, accepted: 0, rejected: 0, total: 0, rate: null, error: true };
          }
        })
      );

      // Filter to personas with any data
      const withData = results.filter(r => r.total > 0 || r.error);
      const allEmpty = withData.length === 0;

      this._acceptanceBody.innerHTML = '';

      if (allEmpty) {
        this._acceptanceBody.appendChild(
          el('div', { className: 'adv-acceptance-empty' },
            'No feedback recorded yet. Accept or reject proposals to see rates.'
          )
        );
        return;
      }

      // Build table
      const table = el('table', {
        className: 'adv-acceptance-table',
        'aria-label': 'Acceptance rates by persona',
      });

      // Header row
      const thead = el('thead', {});
      thead.appendChild(
        el('tr', {},
          el('th', { scope: 'col' }, 'Persona'),
          el('th', { scope: 'col' }, 'Accepted'),
          el('th', { scope: 'col' }, 'Rejected'),
          el('th', { scope: 'col' }, 'Rate'),
          el('th', { scope: 'col' }, 'Quality'),
        )
      );
      table.appendChild(thead);

      const tbody = el('tbody', {});
      for (const row of results) {
        if (row.total === 0 && !row.error) continue;

        const personaLabel = PERSONAS.find(p => p.id === row.personaId)?.label
          || this._customPersonas.find(p => (p.id || p._docId) === row.personaId)?.name
          || row.personaId;

        const rateStr = row.rate !== null ? `${row.rate}%` : '—';
        let qualityLabel = '—';
        let qualityCls = '';
        if (row.rate !== null) {
          if (row.rate > 50) { qualityLabel = 'Healthy'; qualityCls = 'adv-acceptance-quality-green'; }
          else if (row.rate >= 20) { qualityLabel = 'Fair'; qualityCls = 'adv-acceptance-quality-yellow'; }
          else { qualityLabel = 'Low'; qualityCls = 'adv-acceptance-quality-red'; }
        }

        tbody.appendChild(
          el('tr', {},
            el('td', { className: 'adv-acceptance-persona' }, personaLabel),
            el('td', { className: 'adv-acceptance-num' }, String(row.accepted)),
            el('td', { className: 'adv-acceptance-num' }, String(row.rejected)),
            el('td', { className: 'adv-acceptance-rate' }, rateStr),
            el('td', { className: `adv-acceptance-quality ${qualityCls}` }, qualityLabel),
          )
        );
      }
      table.appendChild(tbody);
      this._acceptanceBody.appendChild(table);

      // Note about time window
      this._acceptanceBody.appendChild(
        el('p', { className: 'adv-acceptance-note' }, 'Based on last 90 days of feedback.')
      );
    } catch (err) {
      console.warn('AdvisorPanel: failed to load acceptance rates', err);
      this._acceptanceBody.innerHTML = '';
      this._acceptanceBody.appendChild(
        el('div', { className: 'adv-acceptance-error' }, 'Could not load acceptance rates.')
      );
    }
  }
};
