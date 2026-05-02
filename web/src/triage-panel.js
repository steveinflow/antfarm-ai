import { showConfirmModal } from './confirm-modal.js';

/**
 * TriagePanel — batch proposal review UI (DK-114)
 *
 * A full-page triage view where users can scan all `proposed` tickets and
 * accept or reject them inline with keyboard shortcuts and bulk actions.
 *
 * Usage:
 *   const panel = new TriagePanel({ container, db, projectIds, projects, getUser, serverTimestamp });
 *   panel.mount();
 *   panel.unmount();
 */

const LS_SORT_KEY = 'docket_triage_sort';
const LS_EFFORT_KEY = 'docket_triage_effort_max';

// Quick-select rejection reason labels (DK-196)
const REJECT_QUICK_REASONS = [
  { value: 'already_done', label: 'Already done' },
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'too_vague',    label: 'Too vague' },
  { value: 'other',        label: 'Other' },
];

export class TriagePanel {
  constructor({ container, db, projectIds, projects, getUser, serverTimestamp }) {
    this._container = container;
    this._db = db;
    this._projectIds = projectIds || [];
    this._projects = projects || [];   // [{ id, name }]
    this._getUser = getUser;
    this._serverTimestamp = serverTimestamp;

    // Component state
    this._tickets = [];           // all proposed tickets (real-time)
    this._selectedIds = new Set(); // checked card IDs
    this._focusedIndex = 0;       // keyboard nav index
    this._filterProjectId = null; // null = all projects
    this._lastAction = null;      // { ticketIds: [id], fromStatus: 'proposed', toStatus: 'open'|'rejected' }
    this._sessionAccepted = 0;
    this._sessionRejected = 0;
    this._sessionSnoozed = 0;
    this._unsubscribes = [];      // Firestore listeners cleanup fns
    this._el = null;              // root DOM element
    this._keydownHandler = null;
    this._toastTimeout = null;

    // Active override popover state
    this._popoverTicketId = null;
    this._popoverOutsideHandler = null;

    // Active rejection reason form state (DK-196)
    this._rejectFormTicketId = null;  // ticket.id whose form is open

    // DK-104: Expanded description state (E key)
    this._expandedTicketId = null;    // ticket.id whose description is expanded

    // Help modal state (DK-318)
    this._helpModalEl = null;
    this._helpModalKeydownHandler = null;
  }

  // ── localStorage helpers ──────────────────────────────────────────────────

  _loadPref(key, defaultVal) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultVal;
      const parsed = JSON.parse(raw);
      return parsed;
    } catch (_) {
      return defaultVal;
    }
  }

  _savePref(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  // ── Public API ────────────────────────────────────────────────────────────

  mount() {
    this._render();
    this._attachKeyboardListener();
    this._startListeners();
  }

  unmount() {
    this._detachKeyboardListener();
    this._closeScorePopover();
    this._closeHelpModal();
    this._unsubscribes.forEach(fn => fn());
    this._unsubscribes = [];
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
    this._el = null;
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
    this._expandedTicketId = null;
  }

  // ── Firestore listeners ───────────────────────────────────────────────────

  _startListeners() {
    // One listener per project for proposed tickets
    for (const projectId of this._projectIds) {
      const q = this._db
        .collection('projects')
        .doc(projectId)
        .collection('tickets')
        .where('status', '==', 'proposed')
        .orderBy('ticketNumber', 'desc');

      const unsub = q.onSnapshot(snap => {
        // Merge tickets from all projects
        const incoming = snap.docs.map(doc => ({
          id: doc.id,
          projectId,
          ...doc.data(),
        }));

        // Replace tickets belonging to this project
        this._tickets = [
          ...this._tickets.filter(t => t.projectId !== projectId),
          ...incoming,
        ];
        // Sort descending by createdAt (newest first) across all projects
        this._tickets.sort((a, b) => {
          const ta = a.createdAt
            ? (typeof a.createdAt.toMillis === 'function' ? a.createdAt.toMillis() : new Date(a.createdAt).getTime())
            : (a.ticketNumber || 0);
          const tb = b.createdAt
            ? (typeof b.createdAt.toMillis === 'function' ? b.createdAt.toMillis() : new Date(b.createdAt).getTime())
            : (b.ticketNumber || 0);
          return tb - ta;
        });

        this._updateCards();
      });

      this._unsubscribes.push(unsub);
    }
  }

  // ── Computed helpers ──────────────────────────────────────────────────────

  _filteredTickets() {
    const now = Date.now();
    return this._tickets.filter(t => {
      // Project filter
      if (this._filterProjectId && t.projectId !== this._filterProjectId) return false;
      // Filter out snoozed tickets (DK-104: snoozeUntil in the future)
      if (!t.snoozedUntil) return true;
      const until = typeof t.snoozedUntil === 'string'
        ? new Date(t.snoozedUntil).getTime()
        : (t.snoozedUntil.toMillis ? t.snoozedUntil.toMillis() : Number(t.snoozedUntil));
      return until <= now;
    });
  }

  _projectName(projectId) {
    const p = this._projects.find(x => x.id === projectId);
    return p ? (p.name || p.id) : projectId;
  }

  /** Format a Firestore Timestamp or ISO string as a short date, e.g. "Jan 5" or "Dec 31" */
  _formatTicketDate(val) {
    if (!val) return null;
    let d;
    if (typeof val.toDate === 'function') {
      d = val.toDate();
    } else if (typeof val === 'string') {
      d = new Date(val);
    } else {
      d = new Date(val);
    }
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _render() {
    const el = document.createElement('div');
    el.className = 'triage-root';
    el.innerHTML = `
      <div class="triage-header">
        <div class="triage-header-left">
          <h2 class="triage-title">Triage</h2>
          <select class="triage-project-filter" id="triage-project-filter" aria-label="Filter by project">
            <option value="">All projects</option>
          </select>
          <span class="triage-progress" id="triage-progress" aria-live="polite" aria-atomic="true"></span>
        </div>
        <div class="triage-header-right">
          <button class="triage-deny-all-btn triage-deny-all-hidden" id="triage-deny-all" aria-label="Deny all visible proposals">Deny All</button>
          <button class="triage-help-btn" id="triage-help-btn" aria-label="Keyboard shortcuts (?)">?</button>
          <button class="triage-close-btn" id="triage-close-btn" aria-label="Close triage view">✕</button>
        </div>
      </div>
      <div class="triage-card-list" id="triage-card-list" aria-live="polite" aria-label="Proposed tickets"></div>
      <div class="triage-bulk-bar triage-bulk-bar-hidden" id="triage-bulk-bar" role="toolbar" aria-label="Bulk actions">
        <span class="triage-bulk-count" id="triage-bulk-count"></span>
        <button class="triage-bulk-btn triage-bulk-accept" id="triage-bulk-accept">Accept</button>
        <button class="triage-bulk-btn triage-bulk-reject" id="triage-bulk-reject">Reject</button>
      </div>
      <div class="triage-toast triage-toast-hidden" id="triage-toast" role="status" aria-live="polite"></div>
    `;
    this._container.appendChild(el);
    this._el = el;

    // Bind static buttons
    el.querySelector('#triage-help-btn').addEventListener('click', () => {
      this._openHelpModal();
    });

    el.querySelector('#triage-close-btn').addEventListener('click', () => {
      this._dispatchClose();
    });

    el.querySelector('#triage-bulk-accept').addEventListener('click', () => {
      this._bulkAccept();
    });

    el.querySelector('#triage-bulk-reject').addEventListener('click', () => {
      this._bulkReject();
    });

    // Project filter dropdown
    const filterSelect = el.querySelector('#triage-project-filter');
    // Populate project options from tickets (only projects that have proposed tickets)
    this._populateProjectFilter();
    filterSelect.addEventListener('change', () => {
      this._filterProjectId = filterSelect.value || null;
      this._selectedIds.clear();
      this._focusedIndex = 0;
      this._updateCards();
      this._updateDenyAllBtn();
    });

    // Deny All button
    el.querySelector('#triage-deny-all').addEventListener('click', () => {
      this._denyAllVisible();
    });

    // Show keyboard shortcut legend on first use
    this._maybeShowLegend();

    // Initial render of dynamic parts
    this._updateCards();
  }

  _maybeShowLegend() {
    const LEGEND_KEY = 'docket_triage_legend_shown';
    try {
      if (localStorage.getItem(LEGEND_KEY)) return;
      localStorage.setItem(LEGEND_KEY, '1');
    } catch (_) {}

    const legend = document.createElement('div');
    legend.className = 'triage-legend';
    legend.setAttribute('role', 'note');
    legend.innerHTML = `
      <span class="triage-legend-title">Keyboard shortcuts</span>
      <span class="triage-legend-item"><kbd>J</kbd> Next</span>
      <span class="triage-legend-item"><kbd>K</kbd> Prev</span>
      <span class="triage-legend-item"><kbd>A</kbd> Accept</span>
      <span class="triage-legend-item"><kbd>R</kbd> Reject</span>
      <span class="triage-legend-item"><kbd>S</kbd> Snooze</span>
      <span class="triage-legend-item"><kbd>E</kbd> Expand</span>
      <span class="triage-legend-item"><kbd>U</kbd> Undo</span>
      <span class="triage-legend-item triage-legend-hint"><kbd>?</kbd> Full list</span>
      <button class="triage-legend-dismiss" aria-label="Dismiss keyboard shortcuts">Got it</button>
    `;
    legend.querySelector('.triage-legend-dismiss').addEventListener('click', () => {
      legend.remove();
    });
    this._el.insertBefore(legend, this._el.querySelector('#triage-card-list'));
  }


  _updateCards() {
    this._populateProjectFilter();
    this._updateDenyAllBtn();
    const list = this._el && this._el.querySelector('#triage-card-list');
    const progress = this._el && this._el.querySelector('#triage-progress');
    if (!list) return;

    const filtered = this._filteredTickets();
    const total = this._sessionAccepted + this._sessionRejected + this._sessionSnoozed + filtered.length;

    if (progress) {
      progress.textContent = filtered.length > 0
        ? `${filtered.length} remaining`
        : '';
    }

    // Remove selected IDs that are no longer in filtered list
    for (const id of this._selectedIds) {
      if (!filtered.find(t => t.id === id)) {
        this._selectedIds.delete(id);
      }
    }

    list.innerHTML = '';

    if (filtered.length === 0) {
      const processed = this._sessionAccepted + this._sessionRejected + this._sessionSnoozed;
      list.innerHTML = `
        <div class="triage-empty" id="triage-empty" tabindex="-1">
          <div class="triage-empty-icon">✓</div>
          <div class="triage-empty-title">Queue clear</div>
          ${processed > 0
            ? `<div class="triage-empty-sub">${processed} proposal${processed !== 1 ? 's' : ''} processed this session
               (${this._sessionAccepted} accepted, ${this._sessionRejected} rejected, ${this._sessionSnoozed} snoozed)</div>`
            : '<div class="triage-empty-sub">No proposed tickets right now.</div>'
          }
        </div>
      `;
      this._updateBulkBar();
      return;
    }

    // Clamp focused index
    if (this._focusedIndex >= filtered.length) {
      this._focusedIndex = Math.max(0, filtered.length - 1);
    }

    filtered.forEach((ticket, idx) => {
      const card = this._buildCard(ticket, idx);
      list.appendChild(card);
    });

    this._updateBulkBar();

    // Restore focus to current card
    this._moveFocusToIndex(this._focusedIndex, { scroll: false });
  }

  _buildCard(ticket, idx) {
    const isSelected = this._selectedIds.has(ticket.id);
    const isFocused = idx === this._focusedIndex;

    const card = document.createElement('div');
    card.className = 'triage-card' + (isFocused ? ' triage-card-focused' : '');
    card.setAttribute('data-ticket-id', ticket.id);
    card.setAttribute('data-idx', String(idx));
    card.setAttribute('tabindex', isFocused ? '0' : '-1');
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', `Ticket ${ticket.ticketId || ''}: ${ticket.title || 'Untitled'}`);

    // Checkbox — escape ticket.id for safe use inside innerHTML attribute values
    const checkboxId = `triage-cb-${this._escHtml(ticket.id)}`;
    const personaLabel = ticket.advisorPersona
      ? ticket.advisorPersona.charAt(0).toUpperCase() + ticket.advisorPersona.slice(1)
      : null;

    // Summary from reasoning.summary or description snippet
    const summary = (ticket.reasoning && ticket.reasoning.summary)
      ? ticket.reasoning.summary
      : (ticket.description ? ticket.description.slice(0, 120) : '');

    // Advisor rationale — ticket spec calls for advisorRationale field; fall back to reasoning.summary
    const rationale = ticket.advisorRationale || null;

    // DK-194: Cross-review endorsement row (shown when ticket has consensus metadata)
    const consensusHtml = this._buildEndorsementRowHtml(ticket);

    // Full description for expand (E key) — DK-104
    const fullDescription = ticket.description || '';
    const isExpanded = this._expandedTicketId === ticket.id;

    // Project name — only show if multi-project
    const showProject = this._projectIds.length > 1;
    const projectName = showProject ? this._projectName(ticket.projectId) : null;

    // Score badge
    const scoreBadgeHtml = this._buildScoreBadgeHtml(ticket);

    // Date display
    const dateStr = this._formatTicketDate(ticket.createdAt);

    card.innerHTML = `
      <label class="triage-card-checkbox-wrap">
        <input type="checkbox" class="triage-card-checkbox"
          id="${checkboxId}"
          ${isSelected ? 'checked' : ''}
          aria-label="Select ticket ${ticket.ticketId || ''}">
      </label>
      <div class="triage-card-body">
        <div class="triage-card-meta">
          ${ticket.ticketId ? `<span class="triage-card-id">${this._escHtml(ticket.ticketId)}</span>` : ''}
          ${personaLabel ? `<span class="triage-card-persona triage-persona-${this._escHtml(ticket.advisorPersona)}">${this._escHtml(personaLabel)}</span>` : ''}
          ${projectName ? `<span class="triage-card-project">${this._escHtml(projectName)}</span>` : ''}
          ${dateStr ? `<span class="triage-card-date">${this._escHtml(dateStr)}</span>` : ''}
          ${scoreBadgeHtml}
        </div>
        <div class="triage-card-title">${this._escHtml(ticket.title || 'Untitled')}</div>
        ${summary ? `<div class="triage-card-summary">${this._escHtml(summary)}</div>` : ''}
        ${rationale ? `<div class="triage-card-rationale"><span class="triage-rationale-label">Why proposed:</span> ${this._escHtml(rationale)}</div>` : ''}
        ${consensusHtml}
        ${fullDescription ? `<div class="triage-card-full-desc ${isExpanded ? 'triage-card-full-desc-expanded' : ''}" aria-label="Full description">${this._escHtml(fullDescription)}</div>` : ''}
        <div class="triage-card-actions">
          <button class="triage-action-btn triage-action-accept" data-ticket-id="${this._escHtml(ticket.id)}" aria-label="Accept: ${this._escHtml(ticket.title || ticket.ticketId || 'ticket')}">Accept<kbd class="triage-action-key" aria-hidden="true">A</kbd></button>
          <button class="triage-action-btn triage-action-reject" data-ticket-id="${this._escHtml(ticket.id)}" aria-label="Reject: ${this._escHtml(ticket.title || ticket.ticketId || 'ticket')}">Reject<kbd class="triage-action-key" aria-hidden="true">R</kbd></button>
          <button class="triage-action-btn triage-action-snooze" data-ticket-id="${this._escHtml(ticket.id)}" aria-label="Snooze: ${this._escHtml(ticket.title || ticket.ticketId || 'ticket')}">Snooze<kbd class="triage-action-key" aria-hidden="true">S</kbd></button>
          ${fullDescription ? `<button class="triage-action-btn triage-action-expand ${isExpanded ? 'triage-action-expand-active' : ''}" data-ticket-id="${this._escHtml(ticket.id)}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} full description" aria-expanded="${isExpanded}">${isExpanded ? 'Collapse' : 'Expand'}<kbd class="triage-action-key" aria-hidden="true">E</kbd></button>` : ''}
          ${ticket.advisorPersona ? `<button class="triage-action-btn triage-action-never-suggest" data-ticket-id="${this._escHtml(ticket.id)}" aria-label="Never suggest this topic from ${this._escHtml(personaLabel || ticket.advisorPersona)}">Never suggest</button>` : ''}
        </div>
      </div>
    `;

    // Checkbox change
    card.querySelector('.triage-card-checkbox').addEventListener('change', (e) => {
      if (e.target.checked) {
        this._selectedIds.add(ticket.id);
      } else {
        this._selectedIds.delete(ticket.id);
      }
      this._updateBulkBar();
    });

    // Accept / reject buttons
    card.querySelector('.triage-action-accept').addEventListener('click', (e) => {
      e.stopPropagation();
      this._acceptTicket(ticket);
    });
    card.querySelector('.triage-action-reject').addEventListener('click', (e) => {
      e.stopPropagation();
      this._rejectTicket(ticket);
    });
    card.querySelector('.triage-action-snooze').addEventListener('click', (e) => {
      e.stopPropagation();
      this._snoozeTicket(ticket);
    });

    // DK-104: Expand/collapse full description button
    const expandBtn = card.querySelector('.triage-action-expand');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleExpand(ticket.id);
      });
    }

    // DK-112: "Never suggest" button — adds a topic exclusion rule for this persona
    const neverSuggestBtn = card.querySelector('.triage-action-never-suggest');
    if (neverSuggestBtn) {
      neverSuggestBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._addTopicExclusionFromCard(ticket);
      });
    }

    // Score badge click → open override popover
    const badge = card.querySelector('.triage-score-badge');
    if (badge) {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openScorePopover(ticket, badge);
      });
      badge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          this._openScorePopover(ticket, badge);
        }
      });
    }

    // Click on card body focuses it
    card.addEventListener('click', (e) => {
      if (e.target.closest('.triage-card-actions') || e.target.closest('.triage-card-checkbox-wrap') || e.target.closest('.triage-score-badge')) return;
      this._focusedIndex = idx;
      this._moveFocusToIndex(idx);
    });

    card.addEventListener('focus', () => {
      this._focusedIndex = idx;
      // Update focused class without re-rendering
      this._el.querySelectorAll('.triage-card').forEach((c, i) => {
        c.classList.toggle('triage-card-focused', i === idx);
        c.setAttribute('tabindex', i === idx ? '0' : '-1');
      });
    });

    return card;
  }

  // ── Expand/collapse full description (DK-104, E key) ─────────────────────

  /**
   * Toggle the full description expand state for the given ticket.
   * Updates the card in-place without full re-render.
   */
  _toggleExpand(ticketId) {
    const wasExpanded = this._expandedTicketId === ticketId;
    this._expandedTicketId = wasExpanded ? null : ticketId;

    if (!this._el) return;
    const card = this._el.querySelector(`[data-ticket-id="${CSS.escape(ticketId)}"]`);
    if (!card) return;

    const descEl = card.querySelector('.triage-card-full-desc');
    const expandBtn = card.querySelector('.triage-action-expand');
    const isNowExpanded = this._expandedTicketId === ticketId;

    if (descEl) {
      descEl.classList.toggle('triage-card-full-desc-expanded', isNowExpanded);
    }
    if (expandBtn) {
      expandBtn.textContent = '';
      expandBtn.appendChild(document.createTextNode(isNowExpanded ? 'Collapse' : 'Expand'));
      const kbd = document.createElement('kbd');
      kbd.className = 'triage-action-key';
      kbd.setAttribute('aria-hidden', 'true');
      kbd.textContent = 'E';
      expandBtn.appendChild(kbd);
      expandBtn.classList.toggle('triage-action-expand-active', isNowExpanded);
      expandBtn.setAttribute('aria-expanded', String(isNowExpanded));
      expandBtn.setAttribute('aria-label', (isNowExpanded ? 'Collapse' : 'Expand') + ' full description');
    }
  }

  // ── Score badge ───────────────────────────────────────────────────────────

  /**
   * DK-194: Build the endorsement row HTML for a proposed ticket.
   * Shows one icon per enabled persona (filled=approved, outlined=pending, ×=rejected).
   * Uses shape+label (not color alone) per accessibility spec.
   * Returns empty string if ticket has no consensus field.
   *
   * @param {object} ticket
   * @returns {string} HTML string
   */
  _buildEndorsementRowHtml(ticket) {
    const consensus = ticket.consensus;
    if (!consensus || !consensus.proposedBy) return '';

    const { proposedBy, required, endorsements = [] } = consensus;
    const PERSONAS = ['engineer', 'design', 'product'];
    const enabledPersonas = PERSONAS.filter(p => p !== proposedBy);

    const icons = enabledPersonas.map(persona => {
      const endorsement = endorsements.find(e => e.persona === persona);
      let stateClass, stateIcon, stateLabel, tooltip;
      if (!endorsement) {
        stateClass = 'adv-endorsement-icon-pending';
        stateIcon = '○'; // outlined circle = pending
        stateLabel = 'pending';
        tooltip = `${persona}: not yet reviewed`;
      } else if (endorsement.approved) {
        stateClass = 'adv-endorsement-icon-approved';
        stateIcon = '●'; // filled circle = approved
        stateLabel = 'approved';
        tooltip = `${persona}: approved — ${this._escHtml(endorsement.reason || '')}`;
      } else {
        stateClass = 'adv-endorsement-icon-rejected';
        stateIcon = '✕'; // × = rejected
        stateLabel = 'rejected';
        tooltip = `${persona}: rejected — ${this._escHtml(endorsement.reason || '')}`;
      }
      const shortName = persona.charAt(0).toUpperCase() + persona.slice(1, 3);
      return `<span class="adv-endorsement-icon ${stateClass}" tabindex="0" role="img"
        aria-label="${this._escHtml(persona + ': ' + stateLabel)}"
        title="${this._escHtml(tooltip)}">${stateIcon} ${this._escHtml(shortName)}</span>`;
    });

    const approvals = endorsements.filter(e => e.approved).length;
    return `<div class="adv-endorsement-row" aria-label="Cross-review: ${approvals} of ${required} required endorsements">
      <span class="adv-endorsement-label">Cross-review:</span>
      ${icons.join('')}
      <span class="adv-endorsement-label">${approvals}/${required}</span>
    </div>`;
  }

  _buildScoreBadgeHtml(ticket) {
    // Scoring in progress (no impact yet but not explicitly null — waiting for async write)
    // We distinguish "never scored" (impact == null/undefined) from "has score"
    const hasScore = ticket.impact != null && ticket.effort != null;
    const isOverridden = ticket.score_overridden === true;

    if (!hasScore) {
      // Show skeleton "scoring..." indicator
      return `<span class="triage-score-badge triage-score-pending" aria-label="Scoring in progress">scoring…</span>`;
    }

    const impactLabel = this._scoreLevelLabel(ticket.impact);
    const effortLabel = this._scoreLevelLabel(ticket.effort);
    const overriddenAttr = isOverridden ? ' triage-score-overridden' : '';

    return `<button
      class="triage-score-badge${overriddenAttr}"
      tabindex="0"
      aria-label="Impact: ${ticket.impact} out of 5, ${impactLabel}. Effort: ${ticket.effort} out of 5, ${effortLabel}.${isOverridden ? ' Score manually edited.' : ''} Click to edit scores."
      title="${isOverridden ? 'Score manually overridden — click to edit' : 'Click to override impact / effort scores'}"
    >I: ${ticket.impact} / E: ${ticket.effort}${isOverridden ? ' ✎' : ''}</button>`;
  }

  _scoreLevelLabel(score) {
    if (score <= 1) return 'low';
    if (score <= 3) return 'medium';
    return 'high';
  }

  // ── Override popover ──────────────────────────────────────────────────────

  /**
   * Open an inline popover attached to the score badge for the given ticket.
   * Fully keyboard-navigable: Tab to open, arrow keys to step, Enter to confirm, Escape to cancel.
   */
  _openScorePopover(ticket, anchorEl) {
    // Close any existing popover
    this._closeScorePopover();

    this._popoverTicketId = ticket.id;

    const impactVal = ticket.impact || 3;
    const effortVal = ticket.effort || 3;
    const rationale = ticket.score_rationale || '';

    // Stale score indicator
    const scoredAt = ticket.scored_at;
    let staleHtml = '';
    if (scoredAt) {
      const daysDiff = Math.floor((Date.now() - new Date(scoredAt).getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff > 14) {
        staleHtml = `<div class="triage-popover-stale">scored ${daysDiff} days ago</div>`;
      }
    }

    const rationaleHtml = rationale
      ? `<div class="triage-popover-rationale">${this._escHtml(rationale.slice(0, 150))}</div>`
      : '';

    const popover = document.createElement('div');
    popover.className = 'triage-score-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-label', 'Override impact and effort scores');
    popover.innerHTML = `
      <div class="triage-popover-header">Score Override</div>
      ${rationaleHtml}
      ${staleHtml}
      <div class="triage-popover-field">
        <label class="triage-popover-label" for="popover-impact">Impact (1–5)</label>
        <div class="triage-popover-stepper" role="group" aria-label="Impact score stepper">
          <button class="triage-stepper-btn" id="popover-impact-dec" aria-label="Decrease impact">−</button>
          <span class="triage-stepper-val" id="popover-impact-val" aria-label="Impact: ${impactVal} — ${this._scoreLevelLabel(impactVal)}">${impactVal}</span>
          <span class="triage-stepper-level" id="popover-impact-level">${this._scoreLevelLabel(impactVal)}</span>
          <button class="triage-stepper-btn" id="popover-impact-inc" aria-label="Increase impact">+</button>
        </div>
      </div>
      <div class="triage-popover-field">
        <label class="triage-popover-label" for="popover-effort">Effort (1–5)</label>
        <div class="triage-popover-stepper" role="group" aria-label="Effort score stepper">
          <button class="triage-stepper-btn" id="popover-effort-dec" aria-label="Decrease effort">−</button>
          <span class="triage-stepper-val" id="popover-effort-val" aria-label="Effort: ${effortVal} — ${this._scoreLevelLabel(effortVal)}">${effortVal}</span>
          <span class="triage-stepper-level" id="popover-effort-level">${this._scoreLevelLabel(effortVal)}</span>
          <button class="triage-stepper-btn" id="popover-effort-inc" aria-label="Increase effort">+</button>
        </div>
      </div>
      <div class="triage-popover-field">
        <label class="triage-popover-label" for="popover-note">Note (optional)</label>
        <input type="text" class="triage-popover-note" id="popover-note" placeholder="Reason for override…" maxlength="200">
      </div>
      <div class="triage-popover-actions">
        <button class="triage-popover-rescore" id="popover-rescore">Re-score</button>
        <button class="triage-popover-cancel" id="popover-cancel">Cancel</button>
        <button class="triage-popover-confirm" id="popover-confirm">Save</button>
      </div>
    `;

    // Track values via closure
    let curImpact = impactVal;
    let curEffort = effortVal;

    const updateImpactDisplay = () => {
      popover.querySelector('#popover-impact-val').textContent = curImpact;
      popover.querySelector('#popover-impact-val').setAttribute('aria-label', `Impact: ${curImpact} — ${this._scoreLevelLabel(curImpact)}`);
      popover.querySelector('#popover-impact-level').textContent = this._scoreLevelLabel(curImpact);
    };
    const updateEffortDisplay = () => {
      popover.querySelector('#popover-effort-val').textContent = curEffort;
      popover.querySelector('#popover-effort-val').setAttribute('aria-label', `Effort: ${curEffort} — ${this._scoreLevelLabel(curEffort)}`);
      popover.querySelector('#popover-effort-level').textContent = this._scoreLevelLabel(curEffort);
    };

    popover.querySelector('#popover-impact-dec').addEventListener('click', () => {
      if (curImpact > 1) { curImpact--; updateImpactDisplay(); }
    });
    popover.querySelector('#popover-impact-inc').addEventListener('click', () => {
      if (curImpact < 5) { curImpact++; updateImpactDisplay(); }
    });
    popover.querySelector('#popover-effort-dec').addEventListener('click', () => {
      if (curEffort > 1) { curEffort--; updateEffortDisplay(); }
    });
    popover.querySelector('#popover-effort-inc').addEventListener('click', () => {
      if (curEffort < 5) { curEffort++; updateEffortDisplay(); }
    });

    popover.querySelector('#popover-cancel').addEventListener('click', () => {
      this._closeScorePopover();
      anchorEl.focus();
    });

    popover.querySelector('#popover-confirm').addEventListener('click', async () => {
      const note = popover.querySelector('#popover-note').value.trim();
      this._closeScorePopover();
      await this._saveScoreOverride(ticket, curImpact, curEffort, note);
      anchorEl.focus();
    });

    popover.querySelector('#popover-rescore').addEventListener('click', async () => {
      this._closeScorePopover();
      await this._rescoreTicket(ticket);
    });

    // Keyboard: Escape closes, Enter on confirm saves
    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._closeScorePopover();
        anchorEl.focus();
      }
    });

    // Position popover below the anchor element
    anchorEl.parentNode.style.position = 'relative';
    anchorEl.parentNode.appendChild(popover);

    // Focus first interactive element
    setTimeout(() => {
      const firstBtn = popover.querySelector('#popover-impact-dec');
      if (firstBtn) firstBtn.focus();
    }, 0);

    // Click-outside to close
    this._popoverOutsideHandler = (e) => {
      if (!popover.contains(e.target) && e.target !== anchorEl) {
        this._closeScorePopover();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', this._popoverOutsideHandler);
    }, 0);
  }

  _closeScorePopover() {
    if (!this._el) return;
    const existing = this._el.querySelector('.triage-score-popover');
    if (existing) existing.remove();
    this._popoverTicketId = null;
    if (this._popoverOutsideHandler) {
      document.removeEventListener('click', this._popoverOutsideHandler);
      this._popoverOutsideHandler = null;
    }
  }

  async _saveScoreOverride(ticket, impact, effort, note) {
    try {
      const docRef = this._db
        .collection('projects')
        .doc(ticket.projectId)
        .collection('tickets')
        .doc(ticket.id);

      const updates = {
        impact: Math.min(5, Math.max(1, impact)),
        effort: Math.min(5, Math.max(1, effort)),
        score_overridden: true,
        updatedAt: this._serverTimestamp(),
      };
      if (note) updates.score_override_note = note;

      await docRef.update(updates);
      this._showToast('Score saved.', { undo: false });
    } catch (err) {
      console.error('Score override failed:', err);
      this._showToast('Score save failed.', { undo: false, error: true });
    }
  }

  async _rescoreTicket(ticket) {
    // If score was manually overridden, confirm before proceeding
    if (ticket.score_overridden) {
      const confirmed = await showConfirmModal({
        title: 'Replace manual score?',
        message: 'This ticket has a manually-set score. Re-scoring will replace it.',
        confirm: 'Re-score',
        danger: true,
      });
      if (!confirmed) return;
    }

    // Clear the score fields so the UI shows "scoring…"
    try {
      const docRef = this._db
        .collection('projects')
        .doc(ticket.projectId)
        .collection('tickets')
        .doc(ticket.id);

      // Reset score fields so UI shows pending state; actual re-score is advisory-side only
      // The advisor scoreProposal function can't be called from the browser directly,
      // so we set a rescore_requested flag for the advisor to pick up.
      await docRef.update({
        rescore_requested: true,
        score_overridden: false,
        impact: null,
        effort: null,
        updatedAt: this._serverTimestamp(),
      });
      this._showToast('Re-score requested.', { undo: false });
    } catch (err) {
      console.error('Re-score request failed:', err);
      this._showToast('Re-score request failed.', { undo: false, error: true });
    }
  }

  _updateBulkBar() {
    const bar = this._el && this._el.querySelector('#triage-bulk-bar');
    const countEl = this._el && this._el.querySelector('#triage-bulk-count');
    if (!bar || !countEl) return;
    const count = this._selectedIds.size;
    if (count > 0) {
      bar.classList.remove('triage-bulk-bar-hidden');
      countEl.textContent = `${count} selected`;
    } else {
      bar.classList.add('triage-bulk-bar-hidden');
    }
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────

  _attachKeyboardListener() {
    this._keydownHandler = (e) => this._handleKeydown(e);
    // Attach to document to capture keys regardless of focus within triage
    document.addEventListener('keydown', this._keydownHandler);
  }

  _detachKeyboardListener() {
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
  }

  _handleKeydown(e) {
    // Only handle keys when triage is mounted and focus is inside triage
    // OR when no input/textarea is focused (avoid interfering with other inputs)
    if (!this._el) return;
    const active = document.activeElement;
    const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    // If focus is outside triage root entirely (and in an input), don't intercept.
    // Also don't intercept keyboard shortcuts when focus is inside the reject form
    // (user is typing a reason), except Escape which the form handles itself.
    if (inInput && !this._el.contains(active)) return;
    if (inInput && active.closest('.triage-reject-form')) return;

    const filtered = this._filteredTickets();

    switch (e.key) {
      case 'j':
      case 'J':
        if (filtered.length > 0) {
          e.preventDefault();
          this._focusedIndex = Math.min(this._focusedIndex + 1, filtered.length - 1);
          this._moveFocusToIndex(this._focusedIndex);
        }
        break;

      case 'k':
      case 'K':
        if (filtered.length > 0) {
          e.preventDefault();
          this._focusedIndex = Math.max(this._focusedIndex - 1, 0);
          this._moveFocusToIndex(this._focusedIndex);
        }
        break;

      case 'a':
      case 'A':
        if (filtered.length > 0 && this._focusedIndex < filtered.length) {
          e.preventDefault();
          this._acceptTicket(filtered[this._focusedIndex]);
        }
        break;

      case 'r':
      case 'R':
        if (filtered.length > 0 && this._focusedIndex < filtered.length) {
          e.preventDefault();
          this._rejectTicket(filtered[this._focusedIndex]);
        }
        break;

      case 's':
      case 'S':
        if (filtered.length > 0 && this._focusedIndex < filtered.length) {
          e.preventDefault();
          this._snoozeTicket(filtered[this._focusedIndex]);
        }
        break;

      case 'e':
      case 'E':
        if (filtered.length > 0 && this._focusedIndex < filtered.length) {
          e.preventDefault();
          this._toggleExpand(filtered[this._focusedIndex].id);
        }
        break;

      case 'u':
      case 'U':
        if (this._lastAction) {
          e.preventDefault();
          this._undo();
        }
        break;

      case '?':
        if (!inInput) {
          e.preventDefault();
          this._openHelpModal();
        }
        break;
    }
  }

  // ── Help modal (DK-318) ───────────────────────────────────────────────────

  _openHelpModal() {
    // Only one at a time
    if (this._helpModalEl) {
      this._closeHelpModal();
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'triage-help-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Keyboard shortcuts');

    overlay.innerHTML = `
      <div class="triage-help-modal">
        <div class="triage-help-header">
          <span class="triage-help-title">Keyboard Shortcuts</span>
          <button class="triage-help-close" aria-label="Close keyboard shortcuts">✕</button>
        </div>
        <div class="triage-help-body">
          <div class="triage-help-section">
            <div class="triage-help-section-title">Navigation</div>
            <div class="triage-help-row"><kbd>J</kbd><span>Next ticket</span></div>
            <div class="triage-help-row"><kbd>K</kbd><span>Previous ticket</span></div>
          </div>
          <div class="triage-help-section">
            <div class="triage-help-section-title">Actions</div>
            <div class="triage-help-row"><kbd>A</kbd><span>Accept focused ticket</span></div>
            <div class="triage-help-row"><kbd>R</kbd><span>Reject focused ticket</span></div>
            <div class="triage-help-row"><kbd>S</kbd><span>Snooze focused ticket (7 days)</span></div>
            <div class="triage-help-row"><kbd>E</kbd><span>Expand / collapse description</span></div>
            <div class="triage-help-row"><kbd>U</kbd><span>Undo last action</span></div>
          </div>
          <div class="triage-help-section">
            <div class="triage-help-section-title">General</div>
            <div class="triage-help-row"><kbd>?</kbd><span>Open / close this help</span></div>
            <div class="triage-help-row"><kbd>Esc</kbd><span>Close overlay / cancel</span></div>
          </div>
        </div>
        <div class="triage-help-footer">
          Shortcuts are disabled while typing in a text field.
        </div>
      </div>
    `;

    this._helpModalEl = overlay;

    overlay.querySelector('.triage-help-close').addEventListener('click', () => {
      this._closeHelpModal();
    });

    // Click outside modal dialog closes it
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeHelpModal();
    });

    // Escape key closes it
    this._helpModalKeydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._closeHelpModal();
      }
    };
    document.addEventListener('keydown', this._helpModalKeydownHandler, true);

    document.body.appendChild(overlay);

    // Focus the close button
    overlay.querySelector('.triage-help-close').focus();
  }

  _closeHelpModal() {
    if (this._helpModalEl) {
      if (this._helpModalKeydownHandler) {
        document.removeEventListener('keydown', this._helpModalKeydownHandler, true);
        this._helpModalKeydownHandler = null;
      }
      this._helpModalEl.remove();
      this._helpModalEl = null;
      // Return focus to help button if it's still mounted
      const helpBtn = this._el && this._el.querySelector('#triage-help-btn');
      if (helpBtn) helpBtn.focus();
    }
  }

  _moveFocusToIndex(idx, { scroll = true } = {}) {
    if (!this._el) return;
    const cards = this._el.querySelectorAll('.triage-card');
    cards.forEach((card, i) => {
      const isFocused = i === idx;
      card.classList.toggle('triage-card-focused', isFocused);
      card.setAttribute('tabindex', isFocused ? '0' : '-1');
    });
    const target = cards[idx];
    if (target) {
      target.focus({ preventScroll: !scroll });
      if (scroll) {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    } else {
      // No cards — focus empty state
      const emptyEl = this._el.querySelector('#triage-empty');
      if (emptyEl) emptyEl.focus();
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async _acceptTicket(ticket) {
    const filtered = this._filteredTickets();
    const idx = filtered.findIndex(t => t.id === ticket.id);

    // Optimistic: remove card with animation
    this._animateRemoveCard(ticket.id, () => {
      this._sessionAccepted++;
      // After animation, advance focus
      const newFiltered = this._filteredTickets();
      if (newFiltered.length > 0) {
        this._focusedIndex = Math.min(idx, newFiltered.length - 1);
        this._moveFocusToIndex(this._focusedIndex);
      } else {
        const emptyEl = this._el && this._el.querySelector('#triage-empty');
        if (emptyEl) emptyEl.focus();
      }
    });

    // Store undo state (before write)
    this._lastAction = { ticketIds: [ticket.id], projectId: ticket.projectId, fromStatus: 'proposed', toStatus: 'open' };

    // Close any open rejection form for this ticket
    this._closeRejectForm();

    const user = this._getUser ? this._getUser() : null;
    const userId = user?.uid || null;

    try {
      await this._transitionTicket(ticket, 'open', {
        feedback: {
          action: 'accepted',
          reason: null,
          quickSelectReason: null,
          userId,
          timestamp: this._serverTimestamp(),
        },
      });
      this._recordFeedbackEvent(ticket, 'accepted', null, null);
      this._showToast(`Accepted — moved to backlog.`, { undo: true });
    } catch (err) {
      console.error('Accept failed:', err);
      this._showToast('Accept failed. Please try again.', { undo: false, error: true });
      this._lastAction = null;
    }
  }

  async _rejectTicket(ticket) {
    // If there's already a form open for this ticket, close it and reject immediately.
    // If there's a form for a different ticket, close it first.
    if (this._rejectFormTicketId === ticket.id) {
      this._closeRejectForm();
      await this._doReject(ticket, null, null);
      return;
    }
    this._closeRejectForm();
    this._showRejectReasonForm(ticket);
  }

  /**
   * Show an inline rejection reason form below the given ticket's card.
   * Offers quick-select options + optional freetext. Submitting (or pressing
   * Reject with no selection) calls _doReject immediately.
   *
   * @param {object} ticket - The ticket being rejected
   */
  _showRejectReasonForm(ticket) {
    if (!this._el) return;
    const card = this._el.querySelector(`[data-ticket-id="${CSS.escape(ticket.id)}"]`);
    if (!card) {
      // Card not in DOM — reject immediately without form
      this._doReject(ticket, null, null);
      return;
    }

    this._rejectFormTicketId = ticket.id;

    const form = document.createElement('div');
    form.className = 'triage-reject-form';
    form.setAttribute('role', 'group');
    form.setAttribute('aria-label', 'Rejection reason (optional)');

    // Quick-select chips
    let selectedQuick = null;
    const chipsRow = document.createElement('div');
    chipsRow.className = 'triage-reject-chips';

    const chipBtns = REJECT_QUICK_REASONS.map(({ value, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'triage-reject-chip';
      btn.textContent = label;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        if (selectedQuick === value) {
          selectedQuick = null;
          btn.classList.remove('triage-reject-chip-active');
          btn.setAttribute('aria-pressed', 'false');
        } else {
          selectedQuick = value;
          chipBtns.forEach(b => {
            b.classList.remove('triage-reject-chip-active');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('triage-reject-chip-active');
          btn.setAttribute('aria-pressed', 'true');
        }
      });
      chipsRow.appendChild(btn);
      return btn;
    });

    // Freetext input
    const freetextId = `triage-reject-text-${ticket.id}`;
    const freetextLabel = document.createElement('label');
    freetextLabel.className = 'triage-reject-freetext-label';
    freetextLabel.htmlFor = freetextId;
    freetextLabel.textContent = 'Details (optional)';

    const freetext = document.createElement('textarea');
    freetext.className = 'triage-reject-freetext';
    freetext.id = freetextId;
    freetext.placeholder = 'Optional — describe why';
    freetext.rows = 2;
    freetext.maxLength = 500;
    freetext.setAttribute('aria-label', 'Rejection reason details (optional)');

    // Action row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'triage-reject-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'triage-reject-confirm';
    confirmBtn.textContent = '✕ Dismiss';
    confirmBtn.setAttribute('aria-label', `Confirm dismissal of: ${ticket.title || ticket.ticketId || 'ticket'}`);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'triage-reject-cancel';
    cancelBtn.textContent = 'Cancel';

    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(confirmBtn);

    form.appendChild(chipsRow);
    form.appendChild(freetextLabel);
    form.appendChild(freetext);
    form.appendChild(actionsRow);

    // Insert after the card
    card.insertAdjacentElement('afterend', form);

    // Focus the freetext so keyboard users can type or Tab to buttons
    // (per spec: focus moves into inline reason field when it expands)
    freetext.focus();

    confirmBtn.addEventListener('click', () => {
      const text = freetext.value.trim().slice(0, 500) || null;
      this._closeRejectForm();
      this._doReject(ticket, selectedQuick, text);
    });

    cancelBtn.addEventListener('click', () => {
      this._closeRejectForm();
      // Return focus to the reject button on the card
      const rejectBtn = card.querySelector('.triage-action-reject');
      if (rejectBtn) rejectBtn.focus();
    });

    // Keyboard: Escape cancels
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._closeRejectForm();
        const rejectBtn = card.querySelector('.triage-action-reject');
        if (rejectBtn) rejectBtn.focus();
      }
    });
  }

  /**
   * Close any open inline rejection reason form.
   */
  _closeRejectForm() {
    if (!this._el) return;
    const existing = this._el.querySelector('.triage-reject-form');
    if (existing) existing.remove();
    this._rejectFormTicketId = null;
  }

  /**
   * Execute the reject action, writing status transition + feedback object to Firestore.
   *
   * @param {object} ticket
   * @param {string|null} quickSelectReason - one of REJECT_QUICK_REASONS values or null
   * @param {string|null} freetextReason - free-form text (max 500 chars) or null
   */
  async _doReject(ticket, quickSelectReason, freetextReason) {
    const filtered = this._filteredTickets();
    const idx = filtered.findIndex(t => t.id === ticket.id);

    this._animateRemoveCard(ticket.id, () => {
      this._sessionRejected++;
      const newFiltered = this._filteredTickets();
      if (newFiltered.length > 0) {
        this._focusedIndex = Math.min(idx, newFiltered.length - 1);
        this._moveFocusToIndex(this._focusedIndex);
      } else {
        const emptyEl = this._el && this._el.querySelector('#triage-empty');
        if (emptyEl) emptyEl.focus();
      }
    });

    const user = this._getUser ? this._getUser() : null;
    const userId = user?.uid || null;

    this._lastAction = {
      ticketIds: [ticket.id],
      projectId: ticket.projectId,
      fromStatus: 'proposed',
      toStatus: 'rejected',
    };

    try {
      await this._transitionTicket(ticket, 'rejected', {
        feedback: {
          action: 'rejected',
          reason: freetextReason || null,
          quickSelectReason: quickSelectReason || null,
          userId,
          timestamp: this._serverTimestamp(),
        },
      });
      this._recordFeedbackEvent(ticket, 'rejected', quickSelectReason, freetextReason);
      this._showToast(`Rejected.`, { undo: true });
    } catch (err) {
      console.error('Reject failed:', err);
      this._showToast('Reject failed. Please try again.', { undo: false, error: true });
      this._lastAction = null;
    }
  }

  async _snoozeTicket(ticket) {
    const filtered = this._filteredTickets();
    const idx = filtered.findIndex(t => t.id === ticket.id);

    // Compute snooze date before writing so we can show it on the card
    const snoozeDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const snoozedUntil = snoozeDate.toISOString();

    // DK-104: Show "Returns <date>" on the card for ~1.5s before advancing
    const returnDateStr = snoozeDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    this._showSnoozeFeedbackOnCard(ticket.id, `Returns ${returnDateStr}`);

    try {
      const docRef = this._db
        .collection('projects')
        .doc(ticket.projectId)
        .collection('tickets')
        .doc(ticket.id);
      await docRef.update({
        snoozedUntil,
        updatedAt: this._serverTimestamp(),
      });
      this._recordFeedbackEvent(ticket, 'snoozed');
    } catch (err) {
      console.error('Snooze failed:', err);
      this._showToast('Snooze failed. Please try again.', { undo: false, error: true });
      // Remove the snooze feedback label on failure
      this._clearSnoozeFeedbackOnCard(ticket.id);
      return;
    }

    // Wait 1.5s showing the return date, then advance
    await new Promise(resolve => setTimeout(resolve, 1500));

    this._animateRemoveCard(ticket.id, () => {
      this._sessionSnoozed++;
      const newFiltered = this._filteredTickets();
      if (newFiltered.length > 0) {
        this._focusedIndex = Math.min(idx, newFiltered.length - 1);
        this._moveFocusToIndex(this._focusedIndex);
      } else {
        const emptyEl = this._el && this._el.querySelector('#triage-empty');
        if (emptyEl) emptyEl.focus();
      }
    });
  }

  /**
   * Show a brief "Returns <date>" label on the card (DK-104 snooze feedback).
   */
  _showSnoozeFeedbackOnCard(ticketId, message) {
    if (!this._el) return;
    const card = this._el.querySelector(`[data-ticket-id="${CSS.escape(ticketId)}"]`);
    if (!card) return;
    // Remove any existing snooze feedback
    this._clearSnoozeFeedbackOnCard(ticketId);
    const label = document.createElement('div');
    label.className = 'triage-snooze-feedback';
    label.setAttribute('aria-live', 'polite');
    label.textContent = message;
    card.querySelector('.triage-card-body').appendChild(label);
  }

  /**
   * Remove the snooze feedback label from the card if present.
   */
  _clearSnoozeFeedbackOnCard(ticketId) {
    if (!this._el) return;
    const card = this._el.querySelector(`[data-ticket-id="${CSS.escape(ticketId)}"]`);
    if (!card) return;
    const label = card.querySelector('.triage-snooze-feedback');
    if (label) label.remove();
  }

  /**
   * Record an accept/reject/snooze decision as a feedback event in Firestore.
   * Fire-and-forget: errors are logged but do not block the UI action.
   *
   * @param {object} ticket - Ticket object from the triage list
   * @param {'accepted'|'rejected'|'snoozed'} decision
   * @param {string|null} [quickSelectReason] - quick-select label (reject only)
   * @param {string|null} [freetextReason] - freetext reason (reject only)
   */
  _recordFeedbackEvent(ticket, decision, quickSelectReason = null, freetextReason = null) {
    const user = this._getUser ? this._getUser() : null;
    const userId = user?.uid;
    if (!userId || !ticket.projectId || !ticket.id) return;
    const personaId = ticket.advisorPersona;
    if (!personaId) return; // only record for advisor proposals

    const event = {
      personaId,
      ticketId: ticket.id,
      decision,
      userId,
      // Note: timestamp is set server-side by Firestore rules context;
      // we use the client-provided serverTimestamp for consistency with other writes.
      timestamp: this._serverTimestamp(),
    };

    if (quickSelectReason) event.quickSelectReason = quickSelectReason;
    if (freetextReason) event.reason = freetextReason;

    this._db
      .collection('projects')
      .doc(ticket.projectId)
      .collection('feedbackEvents')
      .add(event)
      .catch(err => {
        console.warn('Failed to record feedback event:', err);
      });
  }

  async _bulkAccept() {
    if (this._selectedIds.size === 0) return;
    const ids = Array.from(this._selectedIds);
    const tickets = this._filteredTickets().filter(t => ids.includes(t.id));

    // Clear selection
    this._selectedIds.clear();
    this._lastAction = null; // no undo after bulk

    // Optimistic: remove all selected cards
    for (const t of tickets) {
      this._animateRemoveCard(t.id, null);
    }
    this._sessionAccepted += tickets.length;

    try {
      await this._batchTransition(tickets, 'open');
      this._showToast(`Accepted ${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} — moved to backlog.`, { undo: false });
      // Re-focus after bulk
      const remaining = this._filteredTickets();
      if (remaining.length > 0) {
        this._focusedIndex = 0;
        this._moveFocusToIndex(0);
      }
    } catch (err) {
      console.error('Bulk accept failed:', err);
      this._showToast('Bulk accept failed. Please try again.', { undo: false, error: true });
    }
  }

  async _bulkReject() {
    if (this._selectedIds.size === 0) return;
    const count = this._selectedIds.size;

    // Confirm step for bulk reject
    const confirmed = await showConfirmModal({
      title: `Reject ${count} ticket${count !== 1 ? 's' : ''}?`,
      message: 'Rejected tickets are kept in Firestore but removed from the triage queue.',
      confirm: 'Reject',
      danger: true,
    });
    if (!confirmed) return;

    const ids = Array.from(this._selectedIds);
    const tickets = this._filteredTickets().filter(t => ids.includes(t.id));

    this._selectedIds.clear();
    this._lastAction = null; // no undo after bulk

    for (const t of tickets) {
      this._animateRemoveCard(t.id, null);
    }
    this._sessionRejected += tickets.length;

    try {
      await this._batchTransition(tickets, 'rejected');
      this._showToast(`Rejected ${tickets.length} ticket${tickets.length !== 1 ? 's' : ''}.`, { undo: false });
      const remaining = this._filteredTickets();
      if (remaining.length > 0) {
        this._focusedIndex = 0;
        this._moveFocusToIndex(0);
      }
    } catch (err) {
      console.error('Bulk reject failed:', err);
      this._showToast('Bulk reject failed. Please try again.', { undo: false, error: true });
    }
  }

  _populateProjectFilter() {
    const select = this._el && this._el.querySelector('#triage-project-filter');
    if (!select) return;
    // Collect unique project IDs from current tickets
    const projectIds = [...new Set(this._tickets.map(t => t.projectId))].sort();
    // Keep current selection
    const current = select.value;
    // Clear options after "All projects"
    while (select.options.length > 1) select.remove(1);
    for (const pid of projectIds) {
      const opt = document.createElement('option');
      opt.value = pid;
      opt.textContent = this._projectName(pid);
      select.appendChild(opt);
    }
    select.value = current || '';
  }

  _updateDenyAllBtn() {
    const btn = this._el && this._el.querySelector('#triage-deny-all');
    if (!btn) return;
    const filtered = this._filteredTickets();
    if (filtered.length > 0) {
      btn.classList.remove('triage-deny-all-hidden');
      btn.textContent = `Deny All (${filtered.length})`;
    } else {
      btn.classList.add('triage-deny-all-hidden');
    }
  }

  async _denyAllVisible() {
    const tickets = this._filteredTickets();
    if (tickets.length === 0) return;

    const projectLabel = this._filterProjectId
      ? this._projectName(this._filterProjectId)
      : 'all projects';
    const confirmed = await showConfirmModal({
      title: `Deny all ${tickets.length} proposal${tickets.length !== 1 ? 's' : ''}?`,
      message: `This will reject all visible proposed tickets for ${projectLabel}.`,
      confirm: 'Deny All',
      danger: true,
    });
    if (!confirmed) return;

    this._selectedIds.clear();
    this._lastAction = null;

    for (const t of tickets) {
      this._animateRemoveCard(t.id, null);
    }
    this._sessionRejected += tickets.length;

    try {
      await this._batchTransition(tickets, 'rejected');
      this._showToast(`Denied ${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} for ${projectLabel}.`, { undo: false });
      this._updateDenyAllBtn();
      const remaining = this._filteredTickets();
      if (remaining.length > 0) {
        this._focusedIndex = 0;
        this._moveFocusToIndex(0);
      }
    } catch (err) {
      console.error('Deny all failed:', err);
      this._showToast('Deny all failed. Please try again.', { undo: false, error: true });
    }
  }

  async _undo() {
    if (!this._lastAction) return;
    const { ticketIds, projectId, fromStatus, toStatus } = this._lastAction;
    this._lastAction = null;

    try {
      // Reverse the transition
      const reverseStatus = fromStatus; // go back to 'proposed'
      for (const ticketId of ticketIds) {
        const docRef = this._db
          .collection('projects')
          .doc(projectId)
          .collection('tickets')
          .doc(ticketId);
        const doc = await docRef.get();
        if (!doc.exists) continue;
        const data = doc.data();
        // Only undo if still in the toStatus (in case Firestore reconciled)
        if (data.status !== toStatus) continue;
        const history = data.statusHistory || [];
        history.push({
          from: toStatus,
          to: reverseStatus,
          at: new Date().toISOString(),
          note: 'Undone via triage',
        });
        await docRef.update({
          status: reverseStatus,
          statusHistory: history,
          feedback: null,
          updatedAt: this._serverTimestamp(),
        });
      }
      this._showToast('Undone.', { undo: false });
    } catch (err) {
      console.error('Undo failed:', err);
      this._showToast('Undo failed.', { undo: false, error: true });
    }
  }

  // ── Firestore writes ──────────────────────────────────────────────────────

  async _transitionTicket(ticket, newStatus, extraFields = {}) {
    const docRef = this._db
      .collection('projects')
      .doc(ticket.projectId)
      .collection('tickets')
      .doc(ticket.id);

    const doc = await docRef.get();
    if (!doc.exists) return;
    const data = doc.data();
    const history = data.statusHistory || [];
    const noteMap = { open: 'Accepted via triage', rejected: 'Rejected via triage', dismissed: 'Dismissed via triage' };
    history.push({
      from: data.status,
      to: newStatus,
      at: new Date().toISOString(),
      note: noteMap[newStatus] || `Transitioned to ${newStatus} via triage`,
    });
    return docRef.update({
      status: newStatus,
      statusHistory: history,
      pendingQuestion: null,
      updatedAt: this._serverTimestamp(),
      ...extraFields,
    });
  }

  async _batchTransition(tickets, newStatus) {
    // Group by project for batch writes (one batch per project)
    const byProject = {};
    for (const t of tickets) {
      if (!byProject[t.projectId]) byProject[t.projectId] = [];
      byProject[t.projectId].push(t);
    }

    for (const [projectId, projectTickets] of Object.entries(byProject)) {
      const batch = this._db.batch();
      const now = new Date().toISOString();

      for (const ticket of projectTickets) {
        const docRef = this._db
          .collection('projects')
          .doc(projectId)
          .collection('tickets')
          .doc(ticket.id);

        // We do a best-effort batch update without reading each doc first
        // (statusHistory will be appended server-side if needed, but for simplicity
        // we build the history entry here using the known fromStatus)
        batch.update(docRef, {
          status: newStatus,
          pendingQuestion: null,
          updatedAt: this._serverTimestamp(),
          // Note: statusHistory cannot be atomically appended in a batch without reading.
          // We omit it here; the real-time listener will reconcile.
        });
      }

      await batch.commit();
    }
  }

  // ── Animation ─────────────────────────────────────────────────────────────

  _animateRemoveCard(ticketId, callback) {
    if (!this._el) return;
    const card = this._el.querySelector(`[data-ticket-id="${CSS.escape(ticketId)}"]`);
    if (!card) {
      if (callback) callback();
      return;
    }

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
      card.remove();
      if (callback) callback();
    } else {
      card.classList.add('triage-card-removing');
      const onEnd = () => {
        card.remove();
        if (callback) callback();
      };
      card.addEventListener('animationend', onEnd, { once: true });
      card.addEventListener('transitionend', onEnd, { once: true });
      // Fallback if animation doesn't fire
      setTimeout(() => {
        if (card.parentNode) {
          card.remove();
          if (callback) callback();
        }
      }, 350);
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  // ── DK-112: Topic exclusion via proposal card ─────────────────────────────

  /**
   * Add a topic exclusion rule derived from the ticket title, scoped to the
   * generating persona. Called by the "Never suggest" button on proposal cards.
   *
   * Derives the rule text from the ticket title (trimmed, max 100 chars).
   * Shows an undo toast immediately after adding.
   *
   * @param {object} ticket - Ticket object from triage list
   */
  async _addTopicExclusionFromCard(ticket) {
    const personaId = ticket.advisorPersona;
    if (!personaId) return;

    const projectId = ticket.projectId;
    if (!projectId) return;

    // Derive rule text from title — truncate to 100 chars (server-side limit)
    const rawTitle = (ticket.title || '').trim();
    const ruleText = rawTitle.slice(0, 100);
    if (!ruleText) return;

    // Validate: reject injection patterns (mirrors prompt-builder.js server-side checks)
    const INJECTION_PATTERNS = [/\n/, /\bignore\b/i, /system:/i, /assistant:/i, /\bprompt\b/i, /<\/?[a-z]+>/i];
    for (const re of INJECTION_PATTERNS) {
      if (re.test(ruleText)) {
        this._showToast('Cannot add exclusion: title contains reserved content.', { undo: false, error: true });
        return;
      }
    }

    // Read current rules from Firestore (fire-and-forget read first to avoid overwrite races)
    let currentRules = [];
    try {
      const snap = await this._db.collection('projects').doc(projectId).get();
      if (snap.exists) {
        const data = snap.data();
        const rules = data?.advisor?.topicExclusions?.[personaId];
        if (Array.isArray(rules)) currentRules = rules;
      }
    } catch (err) {
      console.warn('DK-112: failed to read current topic exclusions:', err);
    }

    // Cap at 25 rules
    if (currentRules.length >= 25) {
      this._showToast(`Cannot add exclusion: maximum of 25 rules reached for ${personaId}.`, { undo: false, error: true });
      return;
    }

    // Avoid exact duplicates silently
    if (currentRules.includes(ruleText)) {
      this._showToast(`"${ruleText.slice(0, 40)}…" is already in the ${personaId} exclusion list.`, { undo: false });
      return;
    }

    const newRules = [...currentRules, ruleText];

    try {
      await this._db.collection('projects').doc(projectId).set(
        { advisor: { topicExclusions: { [personaId]: newRules } } },
        { merge: true }
      );
      const personaLabel = personaId.charAt(0).toUpperCase() + personaId.slice(1);
      const displayRule = ruleText.length > 40 ? ruleText.slice(0, 40) + '…' : ruleText;
      this._showToast(
        `${personaLabel} will never suggest "${displayRule}" again.`,
        {
          undo: true,
          onUndo: async () => {
            try {
              // Remove the newly-added rule on undo
              const snap2 = await this._db.collection('projects').doc(projectId).get();
              const latestRules = snap2.exists
                ? (snap2.data()?.advisor?.topicExclusions?.[personaId] ?? [])
                : [];
              const rolledBack = latestRules.filter(r => r !== ruleText);
              await this._db.collection('projects').doc(projectId).set(
                { advisor: { topicExclusions: { [personaId]: rolledBack } } },
                { merge: true }
              );
            } catch (undoErr) {
              console.warn('DK-112: undo failed:', undoErr);
            }
          },
        },
      );
    } catch (err) {
      console.error('DK-112: failed to save topic exclusion:', err);
      this._showToast('Failed to add exclusion. Please try again.', { undo: false, error: true });
    }
  }

  _showToast(message, { undo = false, error = false, onUndo = null } = {}) {
    const toast = this._el && this._el.querySelector('#triage-toast');
    if (!toast) return;

    if (this._toastTimeout) {
      clearTimeout(this._toastTimeout);
      this._toastTimeout = null;
    }

    toast.classList.toggle('triage-toast-error', !!error);
    toast.classList.remove('triage-toast-hidden');

    // Support custom onUndo callback (DK-112) or fall back to the standard _undo() action
    const hasUndo = undo && (onUndo || this._lastAction);
    if (hasUndo) {
      toast.innerHTML = `${this._escHtml(message)} <button class="triage-toast-undo" aria-label="Undo last action">Undo</button>`;
      toast.querySelector('.triage-toast-undo').addEventListener('click', () => {
        if (onUndo) {
          onUndo();
        } else {
          this._undo();
        }
        toast.classList.add('triage-toast-hidden');
        if (this._toastTimeout) {
          clearTimeout(this._toastTimeout);
          this._toastTimeout = null;
        }
      });
    } else {
      toast.textContent = message;
    }

    this._toastTimeout = setTimeout(() => {
      toast.classList.add('triage-toast-hidden');
      this._lastAction = null; // after undo window closes, decision is permanent
    }, 5000);
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  _dispatchClose() {
    this._el && this._el.dispatchEvent(new CustomEvent('triage:close', { bubbles: true }));
  }

  // ── Utils ─────────────────────────────────────────────────────────────────

  _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
