// @docket/admin-panel — TicketAdminPanel class
// Self-contained vanilla JS with lifecycle. All UI in one file.

import {
  createTicketService,
  createProjectService,
  createFeedbackService,
  STATUS_LABELS,
  statusLabel,
} from '@docket/core';
import { getStyles } from './styles.js';
import {
  esc,
  formatDateCompact,
  formatDate,
  formatDuration,
  formatCost,
  relativeTime,
  toISOString,
} from './format.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') { node.className = v; }
      else if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); }
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (Array.isArray(c)) c.forEach(ch => ch && node.appendChild(ch));
    else node.appendChild(c);
  }
  return node;
}

// ---------------------------------------------------------------------------
// TicketToast
// ---------------------------------------------------------------------------

class TicketToast {
  constructor() {
    this.container = null;
  }

  mount(parent) {
    this.container = el('div', { className: 'tk-toast-container' });
    parent.appendChild(this.container);
  }

  unmount() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }

  show(message, type = 'info', duration = 3500) {
    if (!this.container) return;
    const toast = el('div', { className: `tk-toast tk-toast-${type}` }, message);
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('tk-toast-exit');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, duration);
  }

  success(msg) { this.show(msg, 'success'); }
  error(msg) { this.show(msg, 'error', 5000); }
  info(msg) { this.show(msg, 'info'); }
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function openLightbox(src) {
  const overlay = el('div', { className: 'tk-lightbox', onClick: () => overlay.remove() },
    el('img', { src }),
    el('button', {
      className: 'tk-lightbox-close',
      onClick: (e) => { e.stopPropagation(); overlay.remove(); },
    }, '\u00D7'),
  );
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// TicketForm
// ---------------------------------------------------------------------------

class TicketForm {
  constructor({ onSubmit, classifyTicket, features, toast, projects, defaultProjectId }) {
    this.onSubmit = onSubmit;
    this.classifyTicket = classifyTicket;
    this.features = features;
    this.toast = toast;
    this.projects = projects || null; // array of { id, name } — if set, show project selector
    this.defaultProjectId = defaultProjectId || (projects && projects.length > 0 ? projects[0].id : null);
    this.selectedProjectId = this.defaultProjectId;
    this.screenshots = []; // data URLs
    this.el = null;
    this.submitting = false;
  }

  render() {
    this.screenshots = [];
    this.submitting = false;
    this.critical = false;
    this.selectedProjectId = this.defaultProjectId;

    // Project selector (only shown in multi-project / "All" view)
    let projectSelectorSection = null;
    if (this.projects && this.projects.length > 0) {
      const options = this.projects.map(p =>
        el('option', { value: p.id }, p.name || p.id)
      );
      const selectEl = el('select', {
        className: 'tk-form-select',
        onChange: (e) => { this.selectedProjectId = e.target.value; },
      }, ...options);
      // Set initial value to defaultProjectId
      if (this.defaultProjectId) selectEl.value = this.defaultProjectId;
      projectSelectorSection = el('div', { className: 'tk-form-group' },
        el('label', null, 'Project'),
        selectEl,
      );
      // Keep reference to update value after render
      this._projectSelect = selectEl;
    }

    const descInput = el('textarea', {
      className: 'tk-form-textarea',
      name: 'description',
      placeholder: 'Describe the ticket (bug or feature request)\u2026',
      maxlength: '10000',
    });

    // Screenshot upload
    const previewContainer = el('div', { className: 'tk-screenshot-previews' });
    let screenshotSection = null;

    if (this.features.screenshots !== false) {
      const fileInput = el('input', {
        type: 'file',
        accept: 'image/*',
        multiple: 'true',
        onChange: (e) => {
          const MAX_SCREENSHOTS = 5;
          const files = Array.from(e.target.files);
          const available = MAX_SCREENSHOTS - this.screenshots.length;
          if (available <= 0) {
            this.toast.error(`You can attach at most ${MAX_SCREENSHOTS} screenshots.`);
            e.target.value = '';
            return;
          }
          const accepted = files.slice(0, available);
          if (accepted.length < files.length) {
            this.toast.error(`Only ${available} more screenshot(s) can be added (limit is ${MAX_SCREENSHOTS}).`);
          }
          accepted.forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
              if (this.screenshots.length >= MAX_SCREENSHOTS) return;
              this.screenshots.push(ev.target.result);
              this._renderPreviews(previewContainer);
            };
            reader.readAsDataURL(file);
          });
          e.target.value = '';
        },
      });

      screenshotSection = el('div', { className: 'tk-screenshot-upload' },
        el('label', { className: 'tk-screenshot-upload-label' },
          '\uD83D\uDCCE Attach screenshots (optional)',
          fileInput,
        ),
        previewContainer,
      );
    }

    // Critical flag
    const criticalCheckbox = el('input', {
      type: 'checkbox',
      id: 'tk-critical-cb',
      onChange: (e) => { this.critical = e.target.checked; },
    });
    this._criticalCheckbox = criticalCheckbox;
    const criticalSection = el('div', { className: 'tk-form-critical' },
      criticalCheckbox,
      el('label', { htmlFor: 'tk-critical-cb' }, '\u26A1 Critical — spawn worker immediately, above max cap'),
    );

    // Submit
    const submitBtn = el('button', {
      className: 'tk-btn tk-btn-primary',
      type: 'button',
      onClick: () => this._handleSubmit(descInput, submitBtn),
    }, 'Submit');

    this.el = el('div', { className: 'tk-form' },
      projectSelectorSection,
      el('div', { className: 'tk-form-group' },
        descInput,
      ),
      screenshotSection,
      criticalSection,
      el('div', { className: 'tk-form-actions' },
        submitBtn,
      ),
    );

    return this.el;
  }

  _renderPreviews(container) {
    container.innerHTML = '';
    this.screenshots.forEach((dataUrl, i) => {
      const thumb = el('div', { className: 'tk-screenshot-thumb' },
        el('img', { src: dataUrl, onClick: () => openLightbox(dataUrl) }),
        el('button', {
          className: 'tk-screenshot-thumb-remove',
          onClick: (e) => {
            e.stopPropagation();
            this.screenshots.splice(i, 1);
            this._renderPreviews(container);
          },
        }, '\u00D7'),
      );
      container.appendChild(thumb);
    });
  }

  async _handleSubmit(descEl, btn) {
    if (this.submitting) return;
    const description = descEl.value.trim();

    if (!description) { this.toast.error('Please describe the ticket.'); return; }
    if (description.length > 10000) {
      this.toast.error(`Description is too long (${description.length.toLocaleString()} characters). Please keep it under 10,000 characters.`);
      return;
    }
    if (this.screenshots.length > 5) {
      this.toast.error('Too many screenshots. Please attach at most 5.');
      return;
    }

    this.submitting = true;
    btn.disabled = true;
    btn.classList.add('tk-btn-loading');
    btn.textContent = 'Submitting...';

    try {
      // Auto-classify if available, otherwise default to bug
      let type = 'bug';
      let title = description.split('\n')[0].slice(0, 80);

      if (this.classifyTicket) {
        try {
          const result = await this.classifyTicket(description);
          if (result && result.type) type = result.type;
          if (result && result.title) title = result.title;
        } catch (_e) {
          // Fall back to defaults
        }
      }

      await this.onSubmit({
        type,
        title,
        description,
        screenshots: this.screenshots.slice(),
        projectId: this.selectedProjectId || null,
        critical: this.critical || false,
      });
      // Reset form
      descEl.value = '';
      this.screenshots = [];
      this.critical = false;
      if (this._criticalCheckbox) this._criticalCheckbox.checked = false;
      const previews = this.el.querySelector('.tk-screenshot-previews');
      if (previews) previews.innerHTML = '';
      // Reset project selector to default
      if (this._projectSelect && this.defaultProjectId) {
        this._projectSelect.value = this.defaultProjectId;
        this.selectedProjectId = this.defaultProjectId;
      }
      this.toast.success('Ticket created!');
    } catch (err) {
      this.toast.error('Failed to create ticket: ' + err.message);
    } finally {
      this.submitting = false;
      btn.disabled = false;
      btn.classList.remove('tk-btn-loading');
      btn.textContent = 'Submit';
    }
  }
}

// ---------------------------------------------------------------------------
// TicketFilters
// ---------------------------------------------------------------------------

class TicketFilters {
  constructor({ onFilterChange, onSearchChange, onDependencyFilterChange, onSortChange }) {
    this.onFilterChange = onFilterChange;
    this.onSearchChange = onSearchChange;
    // onDependencyFilterChange: (filter: 'all'|'blocked'|'independent') => void
    this.onDependencyFilterChange = onDependencyFilterChange || null;
    // onSortChange: (sort: 'default'|'convergence') => void
    this.onSortChange = onSortChange || null;
    this.activeFilter = 'open';
    this.searchQuery = '';
    this.activeDependencyFilter = 'all'; // 'all' | 'blocked' | 'independent'
    this.activeSort = 'default'; // 'default' | 'convergence'
    this.hasConvergedTickets = false; // whether any ticket in the project has convergenceCount >= 2
    this.counts = {};
    this.el = null;
    this._tabsContainer = null;
    this._depFilterContainer = null;
    this._sortContainer = null;
  }

  render() {
    const searchInput = el('input', {
      type: 'text',
      placeholder: 'Search tickets\u2026',
      value: this.searchQuery,
      onInput: (e) => {
        this.searchQuery = e.target.value;
        this.onSearchChange(this.searchQuery);
      },
    });

    this._tabsContainer = el('div', { className: 'tk-filter-tabs' });
    this._renderTabs();

    // Dependency filter — only shown when viewing proposed tickets
    this._depFilterContainer = el('div', { className: 'tk-dep-filter', style: { display: 'none' } });
    this._renderDepFilter();

    // Sort control — only shown when at least one ticket has convergenceCount >= 2
    this._sortContainer = el('div', { className: 'tk-sort-control', style: { display: 'none' } });
    this._renderSortControl();

    this.el = el('div', { className: 'tk-filters' },
      el('div', { className: 'tk-search-bar' },
        searchInput,
      ),
      this._tabsContainer,
      this._depFilterContainer,
      this._sortContainer,
    );

    return this.el;
  }

  _renderTabs() {
    if (!this._tabsContainer) return;
    this._tabsContainer.innerHTML = '';

    const filters = [
      { key: 'proposed', label: 'Proposed' },
      { key: 'open', label: 'Open' },
      { key: 'in_progress', label: 'In Progress' },
      { key: 'blocked', label: 'Blocked' },
      { key: 'in_maintenance', label: 'Maintenance' },
      { key: 'waiting_for_user', label: 'Waiting' },
      { key: 'done', label: 'Done' },
    ];

    filters.forEach(({ key, label }) => {
      const count = this.counts[key] ?? 0;
      const isActive = this.activeFilter === key;
      const tab = el('span', {
        className: 'tk-filter-tab' + (isActive ? ' tk-active' : ''),
        onClick: () => {
          this.activeFilter = key;
          this._renderTabs();
          this.onFilterChange(key);
          // Show dependency filter only on proposed tab
          this._updateDepFilterVisibility();
        },
      }, `${label} (${count})`);
      this._tabsContainer.appendChild(tab);
    });
  }

  _updateDepFilterVisibility() {
    if (!this._depFilterContainer) return;
    const show = this.activeFilter === 'proposed';
    this._depFilterContainer.style.display = show ? '' : 'none';
  }

  _renderDepFilter() {
    if (!this._depFilterContainer) return;
    this._depFilterContainer.innerHTML = '';

    const DEP_FILTERS = [
      { key: 'all', label: 'All proposals' },
      { key: 'blocked', label: 'Show blocked proposals' },
      { key: 'independent', label: 'Show independent proposals' },
    ];

    const label = el('span', { className: 'tk-dep-filter-label' }, 'Dependencies:');
    this._depFilterContainer.appendChild(label);

    for (const { key, labelText } of DEP_FILTERS.map(f => ({ key: f.key, labelText: f.label }))) {
      const isActive = this.activeDependencyFilter === key;
      const chip = el('button', {
        type: 'button',
        className: 'tk-dep-filter-chip' + (isActive ? ' tk-active' : ''),
        'aria-pressed': String(isActive),
        onClick: () => {
          this.activeDependencyFilter = key;
          this._renderDepFilter();
          if (this.onDependencyFilterChange) this.onDependencyFilterChange(key);
        },
      }, labelText);
      this._depFilterContainer.appendChild(chip);
    }
  }

  _renderSortControl() {
    if (!this._sortContainer) return;
    this._sortContainer.innerHTML = '';

    const labelEl = el('label', {
      className: 'tk-sort-label',
      htmlFor: 'tk-sort-select',
    }, 'Sort:');

    const select = el('select', {
      id: 'tk-sort-select',
      className: 'tk-sort-select',
      'aria-label': 'Sort tickets',
      onChange: (e) => {
        this.activeSort = e.target.value;
        if (this.onSortChange) this.onSortChange(this.activeSort);
      },
    },
      el('option', { value: 'default' }, 'Default'),
      el('option', { value: 'convergence' }, 'Convergence'),
    );
    select.value = this.activeSort;

    this._sortContainer.appendChild(labelEl);
    this._sortContainer.appendChild(select);
  }

  _updateSortVisibility() {
    if (!this._sortContainer) return;
    this._sortContainer.style.display = this.hasConvergedTickets ? '' : 'none';
  }

  setCounts(counts) {
    this.counts = counts;
    this._renderTabs();
  }

  setFilter(key) {
    this.activeFilter = key;
    this._renderTabs();
    this._updateDepFilterVisibility();
  }

  setHasConvergedTickets(val) {
    this.hasConvergedTickets = val;
    this._updateSortVisibility();
  }

  setSearch(query) {
    this.searchQuery = query;
    // Update the DOM search input if it exists
    if (this.el) {
      const input = this.el.querySelector('input[type="text"]');
      if (input) input.value = query;
    }
  }
}

// ---------------------------------------------------------------------------
// TicketItem
// ---------------------------------------------------------------------------

class TicketItem {
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

// ---------------------------------------------------------------------------
// PersonaRunLog — per-persona collapsible run history panel
// ---------------------------------------------------------------------------

/**
 * PersonaRunLog — collapsible log panel showing run history for a single persona.
 *
 * Usage:
 *   const runLog = new PersonaRunLog({ db, personaId: 'engineer', personaLabel: 'Engineer', limit: 20 });
 *   body.appendChild(runLog.render());
 *
 * The panel is closed by default. On expand, it fetches run history from Firestore.
 */
class PersonaRunLog {
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

/**
 * PersonaRunLogSection — renders run log panels for all known advisor personas.
 * Queries /advisor documents on mount to discover active personas, then creates
 * one PersonaRunLog panel per persona found.
 *
 * Closed by default. No real-time subscriptions — fetch on expand.
 */
class PersonaRunLogSection {
  /**
   * @param {object} opts
   * @param {object} opts.db - Firestore web SDK instance
   * @param {number} [opts.limit=20] - Max runs to fetch per persona
   */
  constructor({ db, limit = 20 }) {
    this.db = db;
    this.limit = limit;
    this._el = null;
    this._panelsContainer = null;
    this._loaded = false;

    // Built-in persona display names
    this._BUILTIN_LABELS = {
      engineer: 'Engineer',
      design: 'Design',
      product: 'Product',
    };
  }

  render() {
    this._panelsContainer = el('div', { className: 'tk-run-log-section-panels' });

    this._el = el('div', { className: 'tk-run-log-section' },
      el('div', { className: 'tk-run-log-section-header' }, 'Advisor Run History'),
      this._panelsContainer,
    );

    // Load personas lazily on first render
    this._loadPersonas();

    return this._el;
  }

  async _loadPersonas() {
    if (this._loaded) return;
    this._loaded = true;

    let personaIds = [];
    try {
      const snap = await this.db.collection('advisor').get();
      personaIds = snap.docs.map(d => d.id);
    } catch (_err) {
      // If /advisor is not accessible or empty, fall back to built-ins
      personaIds = Object.keys(this._BUILTIN_LABELS);
    }

    if (personaIds.length === 0) {
      personaIds = Object.keys(this._BUILTIN_LABELS);
    }

    this._panelsContainer.innerHTML = '';

    for (const personaId of personaIds) {
      const label = this._BUILTIN_LABELS[personaId]
        || personaId.charAt(0).toUpperCase() + personaId.slice(1).replace(/[-_]/g, ' ');
      const runLog = new PersonaRunLog({
        db: this.db,
        personaId,
        personaLabel: label,
        limit: this.limit,
      });
      this._panelsContainer.appendChild(runLog.render());
    }
  }
}

// ---------------------------------------------------------------------------
// TicketList
// ---------------------------------------------------------------------------

class TicketList {
  constructor({ onTransition, onAnswer, onRekick, onDelete, onReject, onSnooze, onFeedback, onAddNote, onExclude, onMarkCritical, getFeedback, isAdmin, toast, onExpandChange, repoBaseUrl, allTickets, clusters, onClusterFilter, onAddLink, onRemoveLink }) {
    this.onTransition = onTransition;
    this.onAnswer = onAnswer;
    this.onRekick = onRekick;
    this.onDelete = onDelete;
    this.onReject = onReject || null;
    this.onSnooze = onSnooze || null;
    // onFeedback: async (docId, rating) => void — called when user rates an advisor ticket
    this.onFeedback = onFeedback || null;
    // onAddNote: async (docId, note) => void — called when user adds an implementation note
    this.onAddNote = onAddNote || null;
    // onExclude: async ({ personaId, pattern }) => void — called when user adds exclusion (DK-128)
    this.onExclude = onExclude || null;
    // onMarkCritical: async (docId) => void — marks ticket as critical to spawn worker immediately
    this.onMarkCritical = onMarkCritical || null;
    // getFeedback: async (docId) => { rating } | null — loads current user's rating
    this.getFeedback = getFeedback || null;
    this.isAdmin = isAdmin || (() => false);
    this.toast = toast;
    this.onExpandChange = onExpandChange || null;
    // repoBaseUrl is optional — used by TicketItem to build file ref links
    this.repoBaseUrl = repoBaseUrl || null;
    // allTickets is used by TicketItem to resolve related ticket display
    this.allTickets = allTickets || [];
    // clusters: Map<clusterId, { id, label, ticketCount }> — for cluster tag rendering
    this.clusters = clusters || new Map();
    // onClusterFilter: (clusterId) => void — called when user clicks a cluster tag
    this.onClusterFilter = onClusterFilter || null;
    // onAddLink: async (sourceDocId, targetDocId, type) => void — link creation
    this.onAddLink = onAddLink || null;
    // onRemoveLink: async (sourceDocId, targetDocId) => void — link removal
    this.onRemoveLink = onRemoveLink || null;
    // emptyState: { icon, title, message, action?: { label, onClick } } | null
    // Set by TicketAdminPanel before each render to show context-aware empty states.
    this.emptyState = null;
    this.el = null;
    this._itemsById = {}; // ticketId/docId -> TicketItem instance
    // Snapshot of last rendered tickets for incremental patching
    this._renderedTickets = []; // ordered array of ticket objects last passed to render()
    // Track clusters reference to detect changes in _patchRender
    this._renderedClusters = null;
    // Cache of loaded feedback: docId -> "relevant" | "noise" | null
    this._feedbackCache = {};
  }

  _renderEmptyState() {
    const state = this.emptyState;
    if (state && (state.icon || state.title || state.message)) {
      const children = [];
      if (state.icon) {
        children.push(el('div', { className: 'tk-empty-state-icon' }, state.icon));
      }
      if (state.title) {
        children.push(el('div', { className: 'tk-empty-state-title' }, state.title));
      }
      if (state.message) {
        children.push(el('div', { className: 'tk-empty-state-message' }, state.message));
      }
      if (state.action) {
        const btn = el('button', {
          className: 'tk-btn tk-btn-primary tk-empty-state-action',
          onClick: state.action.onClick,
        }, state.action.label);
        children.push(btn);
      }
      return el('div', { className: 'tk-empty-state' }, ...children);
    }
    // Fallback: plain message
    return el('div', { className: 'tk-ticket-list-empty' }, 'No tickets match the current filters.');
  }

  render(tickets, expandedIds) {
    // First render — build fresh DOM
    if (!this.el) {
      return this._fullRender(tickets, expandedIds);
    }
    // Subsequent renders — patch incrementally
    return this._patchRender(tickets, expandedIds);
  }

  _fullRender(tickets, expandedIds) {
    this._itemsById = {};
    this._renderedTickets = tickets ? tickets.slice() : [];

    if (!tickets || tickets.length === 0) {
      this.el = el('div', { className: 'tk-ticket-list' },
        this._renderEmptyState(),
      );
      return this.el;
    }

    const items = tickets.map(ticket => {
      const item = this._createItem(ticket, expandedIds);
      if (ticket.ticketId) this._itemsById[ticket.ticketId] = item;
      if (ticket.id) this._itemsById[ticket.id] = item;
      return item;
    });
    this.el = el('div', { className: 'tk-ticket-list' }, items.map(i => i.render()));
    return this.el;
  }

  _patchRender(tickets, expandedIds) {
    const newTickets = tickets || [];
    const oldTickets = this._renderedTickets;

    // Capture focused element before any DOM manipulation so we can restore it
    // if it gets temporarily detached (e.g. when _commentInput is reparented into
    // a freshly-built element tree during re-render).
    const focusedEl = document.activeElement;

    // Build lookup maps for O(1) access
    const newById = new Map(newTickets.map(t => [t.id, t]));
    const oldById = new Map(oldTickets.map(t => [t.id, t]));

    // Detect if clusters map changed (by reference) so we can force re-render of tagged items
    const clustersChanged = this.clusters !== this._renderedClusters;
    if (clustersChanged) {
      this._renderedClusters = this.clusters;
    }

    // Track which items were in the previous render
    const prevItemsById = { ...this._itemsById };
    const nextItemsById = {};

    // ------------------------------------------------------------------
    // Remove items that are no longer present
    // ------------------------------------------------------------------
    for (const [id, item] of Object.entries(prevItemsById)) {
      // Only act on Firestore doc ids (to avoid double-processing ticketId aliases)
      const ticket = item.ticket;
      if (!ticket || id !== ticket.id) continue; // skip ticketId aliases here
      if (!newById.has(id)) {
        if (item.el && item.el.parentNode) {
          item.el.parentNode.removeChild(item.el);
        }
        // Remove both alias keys
        if (ticket.ticketId) delete this._itemsById[ticket.ticketId];
        delete this._itemsById[ticket.id];
      }
    }

    // ------------------------------------------------------------------
    // Add or update items, build ordered fragment
    // ------------------------------------------------------------------
    const fragment = document.createDocumentFragment();
    let hasItems = false;

    for (const ticket of newTickets) {
      hasItems = true;
      const existingItem = prevItemsById[ticket.id];

      if (existingItem) {
        // Ticket already rendered — check if data or clusters changed
        const oldTicket = oldById.get(ticket.id);
        const dataChanged = !oldTicket || this._ticketChanged(oldTicket, ticket);
        // Re-render if ticket data changed or if clusters updated (may affect tag display)
        const clusterRelevant = clustersChanged && Array.isArray(ticket.clusterIds) && ticket.clusterIds.length > 0;

        if (dataChanged || clusterRelevant) {
          // Re-render this ticket item in place
          existingItem.ticket = ticket;
          existingItem.clusters = this.clusters; // propagate updated clusters
          const newEl = existingItem.render(); // returns a fresh element
          if (existingItem.el && existingItem.el !== newEl && existingItem.el.parentNode) {
            existingItem.el.parentNode.replaceChild(newEl, existingItem.el);
          }
        }
        // Preserve expansion state (already tracked in the item)
        if (ticket.ticketId) nextItemsById[ticket.ticketId] = existingItem;
        if (ticket.id) nextItemsById[ticket.id] = existingItem;
        fragment.appendChild(existingItem.el);
      } else {
        // New ticket — create fresh item
        const item = this._createItem(ticket, expandedIds);
        const node = item.render();
        if (ticket.ticketId) nextItemsById[ticket.ticketId] = item;
        if (ticket.id) nextItemsById[ticket.id] = item;
        fragment.appendChild(node);
      }
    }

    // ------------------------------------------------------------------
    // Update the container in one pass
    // ------------------------------------------------------------------
    this._itemsById = nextItemsById;
    this._renderedTickets = newTickets.slice();

    if (!hasItems) {
      // Transition to empty state
      this.el.innerHTML = '';
      this.el.appendChild(this._renderEmptyState());
    } else {
      // Replace entire children list with sorted fragment in one operation
      this.el.innerHTML = '';
      this.el.appendChild(fragment);
    }

    // Restore focus if the previously-focused element was temporarily detached
    // from the live DOM during the re-render (e.g. a text field inside a ticket
    // card whose root element was replaced). This prevents the "reopen" comment
    // input from losing focus on every Firestore-triggered render loop.
    if (focusedEl && focusedEl !== document.body && document.activeElement !== focusedEl) {
      if (document.contains(focusedEl)) {
        focusedEl.focus({ preventScroll: true });
      }
    }

    return this.el;
  }

  /**
   * Lightweight equality check — returns true if any visible field changed.
   * Avoids JSON.stringify overhead by checking only meaningful properties.
   */
  _ticketChanged(oldT, newT) {
    return (
      oldT.status !== newT.status ||
      oldT.title !== newT.title ||
      oldT.type !== newT.type ||
      oldT.description !== newT.description ||
      oldT.deployedVersion !== newT.deployedVersion ||
      oldT.pendingQuestion !== newT.pendingQuestion ||
      oldT.durationMs !== newT.durationMs ||
      oldT.costUsd !== newT.costUsd ||
      (oldT.statusHistory || []).length !== (newT.statusHistory || []).length ||
      // Evidence fields — compare lengths to detect additions
      (oldT.fileRefs || []).length !== (newT.fileRefs || []).length ||
      (oldT.relatedTicketIds || []).length !== (newT.relatedTicketIds || []).length ||
      // Cluster assignment changes
      (oldT.clusterIds || []).length !== (newT.clusterIds || []).length ||
      // Screenshot presence change
      Boolean(oldT.screenshot) !== Boolean(newT.screenshot) ||
      // Reasoning presence or summary change
      Boolean(oldT.reasoning) !== Boolean(newT.reasoning) ||
      (oldT.reasoning && newT.reasoning && oldT.reasoning.summary !== newT.reasoning.summary) ||
      // Links changes — detect additions/removals/type changes
      (oldT.links || []).length !== (newT.links || []).length ||
      Boolean(oldT.hasLinks) !== Boolean(newT.hasLinks) ||
      // Critical flag change — affects badge and action buttons
      Boolean(oldT.critical) !== Boolean(newT.critical)
    );
  }

  _createItem(ticket, expandedIds) {
    const wasExpanded = expandedIds
      ? (expandedIds.has(ticket.ticketId) || expandedIds.has(ticket.id))
      : false;
    // Pre-load any cached feedback for this ticket
    const cachedFeedback = this._feedbackCache[ticket.id] || this._feedbackCache[ticket.ticketId] || null;
    const item = new TicketItem({
      ticket,
      onTransition: this.onTransition,
      onAnswer: this.onAnswer,
      onRekick: this.onRekick,
      onDelete: this.onDelete,
      onReject: this.onReject,
      onSnooze: this.onSnooze,
      onFeedback: this.onFeedback,
      onAddNote: this.onAddNote,
      onExclude: this.onExclude,
      onMarkCritical: this.onMarkCritical,
      currentUserFeedback: cachedFeedback,
      isAdmin: this.isAdmin,
      toast: this.toast,
      initialExpanded: wasExpanded,
      onExpandChange: this.onExpandChange,
      repoBaseUrl: this.repoBaseUrl,
      allTickets: this.allTickets,
      clusters: this.clusters,
      onClusterFilter: this.onClusterFilter,
      onAddLink: this.onAddLink,
      onRemoveLink: this.onRemoveLink,
    });
    return item;
  }

  /**
   * Get a TicketItem instance by ticketId or Firestore doc id.
   * @param {string} id
   * @returns {TicketItem|null}
   */
  getItem(id) {
    return this._itemsById[id] || null;
  }
}

// ---------------------------------------------------------------------------
// TicketAdminPanel — main orchestrator
// ---------------------------------------------------------------------------

export class TicketAdminPanel {
  /**
   * @param {Object} options
   * @param {HTMLElement}  options.container      - DOM element to render into
   * @param {Object}       options.db             - Firestore instance (web SDK)
   * @param {string}       options.projectId      - which project (ignored when projectIds is set)
   * @param {string[]}    [options.projectIds]    - multiple project IDs for a unified all-projects view
   * @param {Function}     options.getUser        - () => ({ uid, email })
   * @param {Function}     options.isAdmin        - () => boolean
   * @param {Function}    [options.classifyTicket] - async (desc) => ({ type, title })
   * @param {string}      [options.theme]          - 'light' | 'dark' | 'auto'
   * @param {Object}      [options.features]       - feature flags
   * @param {Function}    [options.serverTimestamp] - () => FieldValue.serverTimestamp()
   * @param {Function}    [options.onClose]        - callback when close button is clicked
   * @param {string}      [options.storageKey]     - localStorage namespace key (defaults to projectId/projectIds)
   * @param {string}      [options.repoBaseUrl]    - optional base URL for linking file refs (e.g. https://github.com/org/repo)
   */
  constructor(options = {}) {
    this.container = options.container;
    this.db = options.db;
    this.projectId = options.projectId;
    this.projectIds = options.projectIds || null; // multi-project mode
    this.projects = options.projects || null; // [{ id, name }] for project selector in form
    this.defaultProjectId = options.defaultProjectId || null; // default selection in project selector
    this.getUser = options.getUser || (() => ({ uid: null, email: '' }));
    this._isAdmin = options.isAdmin || (() => false);
    this.classifyTicket = options.classifyTicket || null;
    this.onClose = options.onClose || null;
    this.theme = options.theme || 'auto';
    this.features = Object.assign(
      { createTicket: true, screenshots: true, rekickButton: true },
      options.features,
    );
    // repoBaseUrl is optional — used to build file ref links in the Evidence section.
    // Can also be set per-project via Firestore project doc (loaded in _startProjectVersionListeners).
    this._repoBaseUrl = options.repoBaseUrl || null;
    // Track whether caller supplied repoBaseUrl so project-doc value doesn't override it.
    this._repoBaseUrlFromOptions = Boolean(options.repoBaseUrl);

    // Resolve serverTimestamp
    this.serverTimestamp = options.serverTimestamp || this._detectServerTimestamp();
    this._arrayUnion = options.arrayUnion || this._detectArrayUnion();
    this._arrayRemove = options.arrayRemove || this._detectArrayRemove();

    // Core services — one per project
    if (this.projectIds && this.projectIds.length > 0) {
      // Multi-project mode: create a ticket service for each project
      this._ticketServices = this.projectIds.map(pid =>
        createTicketService(this.db, pid, {
          serverTimestamp: this.serverTimestamp,
          arrayUnion: this._arrayUnion,
          arrayRemove: this._arrayRemove,
        })
      );
      // Use first project's service as primary (for rekick etc.)
      this.ticketService = this._ticketServices[0];
    } else {
      this._ticketServices = null;
      this.ticketService = createTicketService(this.db, this.projectId, {
        serverTimestamp: this.serverTimestamp,
        arrayUnion: this._arrayUnion,
        arrayRemove: this._arrayRemove,
      });
    }
    this.projectService = createProjectService(this.db);
    // Feedback service — bound to the same db instance
    this._feedbackService = createFeedbackService(this.db);

    // Derive a localStorage namespace key for this panel instance.
    // Use the explicit storageKey option, or fall back to projectId / sorted projectIds.
    if (options.storageKey) {
      this._storageKey = options.storageKey;
    } else if (this.projectIds && this.projectIds.length > 0) {
      this._storageKey = 'all';
    } else {
      this._storageKey = this.projectId || 'default';
    }

    // Internal state — restored from localStorage where available
    const saved = this._loadState();
    this._tickets = [];
    this._filteredTickets = [];
    this._activeFilter = saved.activeFilter || 'open';
    this._searchQuery = saved.searchQuery || '';
    this._activeClusterFilter = null; // clusterId or null
    this._activeDependencyFilter = 'all'; // 'all' | 'blocked' | 'independent'
    this._activeSort = 'default'; // 'default' | 'convergence'
    this._mounted = false;
    this._styleEl = null;
    this._root = null;
    this._listContainer = null;
    this._unsubscribe = null;
    // track which tickets are expanded across re-renders
    this._expandedTicketIds = new Set(saved.expandedTicketIds || []);

    // Live version state: projectId -> { liveVersion, liveVersionAt }
    this._projectVersions = {}; // projectId -> liveVersion string or null
    this._projectVersionUnsubs = []; // Firestore unsub functions
    this._liveVersionEl = null; // DOM element for live version display

    // Cluster state — Map<clusterId, { id, label, ticketCount }> merged across projects
    this._clusters = new Map();
    this._clusterUnsubs = []; // Firestore unsub functions for cluster listeners

    // Sub-components
    this.toast = new TicketToast();
    this.filters = null;
    this.ticketList = null;
  }

  // -----------------------------------------------------------------------
  // localStorage helpers
  // -----------------------------------------------------------------------

  _lsKey() {
    return `docket_panel_state_${this._storageKey}`;
  }

  _loadState() {
    try {
      const raw = localStorage.getItem(this._lsKey());
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_e) {
      return {};
    }
  }

  _saveState() {
    try {
      const state = {
        activeFilter: this._activeFilter,
        searchQuery: this._searchQuery,
        expandedTicketIds: Array.from(this._expandedTicketIds),
      };
      localStorage.setItem(this._lsKey(), JSON.stringify(state));
    } catch (_e) {
      // localStorage not available or full — ignore
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async mount() {
    if (this._mounted) return;
    this._mounted = true;

    // Inject styles
    this._styleEl = document.createElement('style');
    this._styleEl.setAttribute('data-tk-admin-panel', '');
    this._styleEl.textContent = getStyles();
    document.head.appendChild(this._styleEl);

    // Root element
    this._root = el('div', { className: this._rootClass() });
    this.container.appendChild(this._root);

    // Toast
    this.toast.mount(document.body);

    // Build UI skeleton
    this._buildUI();

    // Listen to media query for auto theme
    if (this.theme === 'auto') {
      this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._mediaHandler = () => this._applyTheme();
      this._mediaQuery.addEventListener('change', this._mediaHandler);
    }

    // Load tickets
    await this.refresh();

    // Real-time listener (if supported)
    this._startRealtimeListener();

    // Project version listeners — track liveVersion on project documents
    this._startProjectVersionListeners();

    // Cluster listeners — track theme clusters for tag rendering and filtering
    this._startClusterListeners();
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;

    // Stop real-time listener
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    // Stop project version listeners
    for (const unsub of this._projectVersionUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._projectVersionUnsubs = [];

    // Stop cluster listeners
    for (const unsub of this._clusterUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._clusterUnsubs = [];

    // Remove media query listener
    if (this._mediaQuery && this._mediaHandler) {
      this._mediaQuery.removeEventListener('change', this._mediaHandler);
    }

    // Remove toast
    this.toast.unmount();

    // Remove style
    if (this._styleEl && this._styleEl.parentNode) {
      this._styleEl.parentNode.removeChild(this._styleEl);
    }
    this._styleEl = null;

    // Remove root
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
  }

  async refresh() {
    if (!this._mounted) return;
    try {
      this._showLoading();
      if (this._ticketServices && this._ticketServices.length > 0) {
        // Multi-project mode: fetch from all projects and merge
        const results = await Promise.all(this._ticketServices.map(svc => svc.listAll()));
        const merged = [].concat(...results);
        // Sort descending by ticketNumber (cross-project, best-effort)
        merged.sort((a, b) => (b.ticketNumber || 0) - (a.ticketNumber || 0));
        this._tickets = merged;
      } else {
        this._tickets = await this.ticketService.listAll();
      }
      this._applyFilters();
      this._renderList();
      this._updateCounts();
    } catch (err) {
      this.toast.error('Failed to load tickets: ' + err.message);
    }
  }

  /**
   * Find a ticket by ticketId (e.g. "DK-019") or Firestore doc id and expand it,
   * scrolling it into view. If the ticket is currently filtered out, clears
   * filters first so it becomes visible.
   *
   * @param {string} ticketId - ticketId (e.g. "DK-019") or Firestore doc id
   * @returns {boolean} true if the ticket was found and focused
   */
  focusTicket(ticketId) {
    if (!this.ticketList) return false;

    // First try to find it in the current rendered list
    let item = this.ticketList.getItem(ticketId);

    if (!item) {
      // The ticket might be filtered out — check if it exists in _tickets at all
      const ticket = this._tickets.find(
        t => t.ticketId === ticketId || t.id === ticketId
      );
      if (!ticket) return false;

      // Clear active filter, cluster filter, and search so the ticket becomes visible
      this._activeFilter = 'all';
      this._searchQuery = '';
      this._activeClusterFilter = null;
      this._saveState();
      if (this.filters) {
        this.filters.setFilter('all');
        this.filters.setSearch('');
      }
      this._applyFilters();
      this._renderList();

      item = this.ticketList.getItem(ticketId);
      if (!item) return false;
    }

    // Expand the item if not already expanded
    if (!item.expanded) {
      item._toggle();
    }

    // Scroll into view
    if (item.el) {
      item.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // UI construction
  // -----------------------------------------------------------------------

  _buildUI() {
    // Header with rekick button and close
    const headerActions = el('div', { className: 'tk-header-actions' });

    if (this.features.rekickButton && this._isAdmin()) {
      const rekickBtn = el('button', {
        className: 'tk-btn tk-btn-outline tk-btn-sm',
        onClick: async () => {
          rekickBtn.disabled = true;
          rekickBtn.classList.add('tk-btn-loading');
          rekickBtn.textContent = 'Rekicking...';
          try {
            const count = await this.ticketService.rekickOrchestrator();
            this.toast.success(`Rekicked ${count} ticket(s) to open.`);
            await this.refresh();
          } catch (err) {
            this.toast.error('Rekick failed: ' + err.message);
          } finally {
            rekickBtn.disabled = false;
            rekickBtn.classList.remove('tk-btn-loading');
            rekickBtn.textContent = '\u27F3 Rekick Orchestrator';
          }
        },
      }, '\u27F3 Rekick Orchestrator');
      headerActions.appendChild(rekickBtn);
    }

    // Token Spend button — always visible in the toolbar
    const tokenSpendBtn = el('button', {
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      title: 'View token spend breakdown',
      onClick: () => this._showTokenSpend(),
    }, '\uD83D\uDCB0 Token Spend');
    headerActions.appendChild(tokenSpendBtn);

    // Changelog button — always visible in the toolbar
    const changelogBtn = el('button', {
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      title: 'View changelog',
      onClick: () => this._showChangelog(),
    }, '\uD83D\uDCCB Changelog');
    headerActions.appendChild(changelogBtn);

    if (this.onClose) {
      const closeBtn = el('button', {
        className: 'tk-btn-close',
        onClick: () => this.onClose(),
      }, '\u00D7');
      headerActions.appendChild(closeBtn);
    }

    const header = el('div', { className: 'tk-header' },
      headerActions,
    );
    this._root.appendChild(header);

    // Body wrapper for left/right padding
    const body = el('div', { className: 'tk-panel-body' });
    this._root.appendChild(body);

    // Ticket form
    if (this.features.createTicket) {
      const form = new TicketForm({
        onSubmit: (data) => this._createTicket(data),
        classifyTicket: this.classifyTicket,
        features: this.features,
        toast: this.toast,
        projects: this.projects,
        defaultProjectId: this.defaultProjectId,
      });
      body.appendChild(form.render());
    }

    // Filters — restore saved state before first render
    this.filters = new TicketFilters({
      onFilterChange: (filter) => {
        this._activeFilter = filter;
        // Clear cluster filter when switching status tabs for a clean view
        this._activeClusterFilter = null;
        // Reset dependency filter when switching tabs
        this._activeDependencyFilter = 'all';
        this._saveState();
        this._applyFilters();
        this._renderList();
      },
      onSearchChange: (query) => {
        this._searchQuery = query;
        this._saveState();
        this._applyFilters();
        this._renderList();
      },
      onDependencyFilterChange: (depFilter) => {
        this._activeDependencyFilter = depFilter;
        this._applyFilters();
        this._renderList();
      },
      onSortChange: (sort) => {
        this._activeSort = sort;
        this._applyFilters();
        this._renderList();
      },
    });
    // Restore persisted filter/search before mounting
    this.filters.activeFilter = this._activeFilter;
    this.filters.searchQuery = this._searchQuery;
    body.appendChild(this.filters.render());

    // Live version indicator — shows the current deployed version of the project(s)
    this._liveVersionEl = el('div', { className: 'tk-live-version' });
    body.appendChild(this._liveVersionEl);

    // List container
    this._listContainer = el('div');
    body.appendChild(this._listContainer);

    // Advisor run log section — shown when runLog feature is enabled
    if (this.features.runLog !== false && this.db) {
      const runLogSection = new PersonaRunLogSection({ db: this.db, limit: 20 });
      body.appendChild(runLogSection.render());
    }
  }

  _showLoading() {
    if (!this._listContainer) return;
    // Reset ticketList so the next _renderList() call does a full (fresh) render
    // rather than trying to patch against stale DOM nodes.
    this._resetList();
    this._listContainer.innerHTML = '';

    // Build a skeleton card that matches the visual structure of a real ticket row
    const makeSkeletonCard = () =>
      el('div', { className: 'tk-skeleton-card' },
        el('div', { className: 'tk-skeleton-header' },
          el('div', { className: 'tk-skeleton-block tk-skeleton-id' }),
          el('div', { className: 'tk-skeleton-block tk-skeleton-type' }),
          el('div', { className: 'tk-skeleton-block tk-skeleton-status' }),
          el('div', { className: 'tk-skeleton-block tk-skeleton-title-line' }),
        ),
        el('div', { className: 'tk-skeleton-title-area' },
          el('div', { className: 'tk-skeleton-block tk-skeleton-title-full' }),
        ),
      );

    this._listContainer.appendChild(
      el('div', { className: 'tk-skeleton-list', role: 'status', 'aria-label': 'Loading tickets…' },
        makeSkeletonCard(),
        makeSkeletonCard(),
        makeSkeletonCard(),
        makeSkeletonCard(),
      )
    );
  }

  /**
   * Compute the context-aware empty state descriptor for the current
   * filter + ticket counts. Returns an object for TicketList.emptyState.
   */
  _computeEmptyState() {
    const hasAnyTickets = this._tickets.length > 0;
    const filter = this._activeFilter;
    const hasSearch = Boolean(this._searchQuery.trim());
    const hasCluster = Boolean(this._activeClusterFilter);

    // If a search query produced no results
    if (hasSearch) {
      return {
        icon: '🔍',
        title: 'No results found',
        message: `No tickets match "${this._searchQuery}". Try a different search term.`,
      };
    }

    // If a cluster filter produced no results
    if (hasCluster) {
      return {
        icon: '🏷️',
        title: 'No tickets in this cluster',
        message: 'No tickets are assigned to this theme cluster.',
      };
    }

    // True "no tickets yet" state — project has no tickets at all
    if (!hasAnyTickets) {
      return {
        icon: '🎉',
        title: 'No tickets yet',
        message: 'This project is all clear! Use the form above to create your first ticket, or ask the AI advisor to generate proposals.',
      };
    }

    // Filter-specific empty states when there ARE tickets, just none in this status
    const filterMessages = {
      open:            { icon: '✅', title: 'No open tickets', message: 'All caught up — nothing is waiting to be picked up.' },
      proposed:        { icon: '💡', title: 'No proposals', message: 'No tickets are waiting for review right now.' },
      in_progress:     { icon: '⚙️', title: 'Nothing in progress', message: 'No tickets are currently being worked on.' },
      done:            { icon: '📦', title: 'No completed tickets', message: 'Completed tickets will appear here once work is shipped.' },
      blocked:         { icon: '🚧', title: 'No blocked tickets', message: 'No tickets are currently blocked.' },
      in_maintenance:  { icon: '🔧', title: 'Nothing in maintenance', message: 'No tickets are currently in maintenance.' },
      waiting_for_user:{ icon: '💬', title: 'No pending questions', message: 'No tickets are waiting for your input.' },
      all:             { icon: '🗂️', title: 'No tickets', message: 'This project has no tickets yet. Use the form above to get started.' },
    };

    return filterMessages[filter] || {
      icon: '🗂️',
      title: 'No tickets',
      message: 'No tickets match the current filters.',
    };
  }

  _renderList() {
    if (!this._listContainer) return;

    if (!this.ticketList) {
      // First render — create TicketList and mount it
      this.ticketList = new TicketList({
        onTransition: (id, status, opts) => this._transitionTicket(id, status, opts),
        onAnswer: (id, answer) => this._answerQuestion(id, answer),
        onRekick: () => this.ticketService.rekickOrchestrator(),
        onDelete: (id) => this._deleteTicket(id),
        onReject: (opts) => this._rejectProposal(opts),
        onSnooze: (id, date) => this._snoozeTicket(id, date),
        onFeedback: (docId, rating) => this._handleFeedback(docId, rating),
        onAddNote: (docId, note) => this._appendNote(docId, note),
        onExclude: ({ personaId, pattern }) => this._handleExclude({ personaId, pattern }),
        onMarkCritical: (docId) => this._markCritical(docId),
        getFeedback: (docId) => this._getFeedback(docId),
        isAdmin: () => this._isAdmin(),
        toast: this.toast,
        onExpandChange: (ticketId, docId, expanded) => {
          if (expanded) {
            if (ticketId) this._expandedTicketIds.add(ticketId);
            if (docId) this._expandedTicketIds.add(docId);
          } else {
            if (ticketId) this._expandedTicketIds.delete(ticketId);
            if (docId) this._expandedTicketIds.delete(docId);
          }
          this._saveState();
        },
        repoBaseUrl: this._repoBaseUrl,
        allTickets: this._tickets,
        clusters: this._clusters,
        onClusterFilter: (clusterId) => {
          // Toggle cluster filter: click same cluster again to clear
          this._activeClusterFilter = this._activeClusterFilter === clusterId ? null : clusterId;
          this._applyFilters();
          this._renderList();
        },
        onAddLink: (sourceDocId, targetDocId, type) => this._addLink(sourceDocId, targetDocId, type),
        onRemoveLink: (sourceDocId, targetDocId) => this._removeLink(sourceDocId, targetDocId),
      });
      // Set empty state before first render
      this.ticketList.emptyState = this._computeEmptyState();
      this._listContainer.innerHTML = '';
      this._listContainer.appendChild(this.ticketList.render(this._filteredTickets, this._expandedTicketIds));
    } else {
      // Subsequent renders — patch in place (TicketList handles incremental DOM updates)
      // Update allTickets so related ticket lookups stay fresh
      this.ticketList.allTickets = this._tickets;
      // Update clusters so cluster tags stay in sync
      this.ticketList.clusters = this._clusters;
      // Refresh empty state in case filter or search changed
      this.ticketList.emptyState = this._computeEmptyState();
      this.ticketList.render(this._filteredTickets, this._expandedTicketIds);
      // Ensure the list element is still mounted (e.g. after _showLoading() cleared the container)
      if (this.ticketList.el && !this.ticketList.el.isConnected) {
        this._listContainer.innerHTML = '';
        this._listContainer.appendChild(this.ticketList.el);
      }
    }

    // Show/update the snoozed section when viewing proposed tickets (or all)
    this._renderSnoozedSection();

    // Show/update the collapsed "Rejected" section when viewing proposed or all
    this._renderRejectedSection();
  }

  /**
   * Render (or update) the collapsible "Snoozed" section that shows currently
   * snoozed proposed tickets below the active list. This section is shown
   * whenever the active filter is 'proposed' or 'all'.
   */
  _renderSnoozedSection() {
    if (!this._listContainer) return;

    // Only show in proposed or all views
    const showSnoozed = this._activeFilter === 'proposed' || this._activeFilter === 'all';

    // Remove any existing snoozed section first
    const existing = this._listContainer.querySelector('.tk-snoozed-section');
    if (existing) existing.parentNode.removeChild(existing);

    if (!showSnoozed) return;

    // Find currently snoozed proposed tickets
    const now = new Date();
    const snoozed = this._tickets.filter(t => {
      if (t.status !== 'proposed') return false;
      if (!t.snoozedUntil) return false;
      const d = new Date(t.snoozedUntil);
      return !isNaN(d.getTime()) && d > now;
    });

    if (snoozed.length === 0) return;

    // Sort by snoozedUntil ascending (earliest resurface first)
    snoozed.sort((a, b) => new Date(a.snoozedUntil) - new Date(b.snoozedUntil));

    const noun = snoozed.length === 1 ? 'proposal' : 'proposals';
    const snoozedList = el('div', { className: 'tk-snoozed-list', style: { display: 'none' } });

    snoozed.forEach(t => {
      const resurfaceStr = formatDate(t.snoozedUntil);
      const row = el('div', { className: 'tk-snoozed-row' },
        el('span', { className: 'tk-snoozed-row-title' }, t.ticketId ? `${t.ticketId}: ` : ''),
        el('span', null, t.title || ''),
        el('span', { className: 'tk-snoozed-row-resurface' }, ` — resurfaces ${resurfaceStr}`),
        el('button', {
          type: 'button',
          className: 'tk-btn tk-btn-ghost tk-btn-sm tk-snoozed-row-wake',
          'aria-label': `Wake up ${t.title} now`,
          onClick: async (e) => {
            e.stopPropagation();
            try {
              await this._snoozeTicket(t.id, null);
              this.toast.success('Proposal unsnoozed.');
            } catch (err) {
              this.toast.error('Failed: ' + err.message);
            }
          },
        }, 'Wake up'),
      );
      snoozedList.appendChild(row);
    });

    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-snoozed-toggle',
      'aria-expanded': 'false',
      'aria-label': `${snoozed.length} snoozed ${noun} — click to expand`,
      onClick: () => {
        const isOpen = snoozedList.style.display !== 'none';
        snoozedList.style.display = isOpen ? 'none' : 'block';
        toggleBtn.setAttribute('aria-expanded', String(!isOpen));
        toggleBtn.textContent = `⏰ ${snoozed.length} snoozed ${noun} ${!isOpen ? '▲' : '▼'}`;
      },
    }, `⏰ ${snoozed.length} snoozed ${noun} ▼`);

    const section = el('div', { className: 'tk-snoozed-section' },
      toggleBtn,
      snoozedList,
    );

    this._listContainer.appendChild(section);
  }

  /**
   * Render (or update) the collapsed "Rejected" section that shows rejected
   * proposed tickets below the active list. Shown when the active filter is
   * 'proposed' or 'all'. Collapsed by default — users can expand to review.
   */
  _renderRejectedSection() {
    if (!this._listContainer) return;

    // Only show in proposed or all views
    const showRejected = this._activeFilter === 'proposed' || this._activeFilter === 'all';

    // Remove any existing rejected section first
    const existing = this._listContainer.querySelector('.tk-rejected-section');
    if (existing) existing.parentNode.removeChild(existing);

    if (!showRejected) return;

    // Find rejected tickets
    const rejected = this._tickets.filter(t => t.status === 'rejected');

    if (rejected.length === 0) return;

    // Sort by updatedAt/createdAt descending (most recently rejected first)
    rejected.sort((a, b) => {
      const aDate = a.updatedAt || a.createdAt || '';
      const bDate = b.updatedAt || b.createdAt || '';
      return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
    });

    const noun = rejected.length === 1 ? 'proposal' : 'proposals';
    const rejectedList = el('div', { className: 'tk-rejected-list', style: { display: 'none' } });

    // Human-readable reason labels for display
    const REASON_LABELS = {
      off_topic:       'Off-topic',
      too_small:       'Too small',
      already_covered: 'Already covered',
      not_relevant:    'Not relevant',
    };

    rejected.forEach(t => {
      const rejectedAt = formatDate(t.updatedAt || t.createdAt);
      const reasonLabel = REASON_LABELS[t.rejectionReason] || '';
      const row = el('div', { className: 'tk-rejected-row' },
        el('span', { className: 'tk-rejected-row-title' }, t.ticketId ? `${t.ticketId}: ` : ''),
        el('span', null, t.title || ''),
        reasonLabel ? el('span', { className: 'tk-rejected-row-reason' }, ` — ${reasonLabel}`) : null,
        el('span', { className: 'tk-rejected-row-date' }, ` (${rejectedAt})`),
      );
      rejectedList.appendChild(row);
    });

    const toggleBtn = el('button', {
      type: 'button',
      className: 'tk-rejected-toggle',
      'aria-expanded': 'false',
      'aria-label': `${rejected.length} rejected ${noun} — click to expand`,
      onClick: () => {
        const isOpen = rejectedList.style.display !== 'none';
        rejectedList.style.display = isOpen ? 'none' : 'block';
        toggleBtn.setAttribute('aria-expanded', String(!isOpen));
        toggleBtn.textContent = `✕ ${rejected.length} rejected ${noun} ${!isOpen ? '▲' : '▼'}`;
      },
    }, `✕ ${rejected.length} rejected ${noun} ▼`);

    const section = el('div', { className: 'tk-rejected-section' },
      toggleBtn,
      rejectedList,
    );

    this._listContainer.appendChild(section);
  }

  /**
   * Destroy and re-create the TicketList (used after _showLoading() wipes the container).
   * @private
   */
  _resetList() {
    this.ticketList = null;
  }

  // -----------------------------------------------------------------------
  // Feedback helpers
  // -----------------------------------------------------------------------

  /**
   * Handle a user's feedback rating for an advisor-generated ticket.
   * Called from TicketItem via TicketList.onFeedback.
   *
   * Writes to the /feedback collection via feedback-service.
   * Also updates the local cache so re-renders stay consistent.
   *
   * @param {string} docId  - Firestore doc ID of the ticket
   * @param {"relevant"|"noise"} rating
   */
  async _handleFeedback(docId, rating) {
    const user = this.getUser();
    if (!user || !user.uid) {
      throw new Error('Must be signed in to rate tickets');
    }
    // Find the ticket to get its projectId
    const ticket = this._tickets.find(t => t.id === docId || t.ticketId === docId);
    const projectId = (ticket && ticket.projectId) || this.projectId;
    if (!projectId) {
      throw new Error('Could not determine projectId for feedback');
    }
    await this._feedbackService.submitFeedback({
      ticketId: docId,
      projectId,
      rating,
      userId: user.uid,
    });
    // Update local cache
    if (this.ticketList) {
      this.ticketList._feedbackCache[docId] = rating;
    }
  }

  /**
   * Handle "Exclude this path/URL" action from a ticket card. (DK-128)
   * Appends the pattern to the project's exclusions array for the given persona.
   * Enforces max 20 patterns, 200 chars per pattern.
   *
   * @param {object} opts
   * @param {string} opts.personaId - 'engineer' | 'design'
   * @param {string} opts.pattern   - The exclusion pattern to add
   * @returns {Promise<void>}
   */
  async _handleExclude({ personaId, pattern }) {
    if (!pattern || typeof pattern !== 'string') return;
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.length > 200) throw new Error('Invalid pattern');

    // Determine the project ID — use the single projectId or the first one
    const projectId = this.projectId || (this.projectIds && this.projectIds[0]);
    if (!projectId) throw new Error('No project selected');

    // Read current exclusions, append the new pattern, write back
    let currentExclusions = [];
    try {
      const snap = await this.db.collection('projects').doc(projectId).get();
      if (snap.exists) {
        const data = snap.data();
        const arr = data?.exclusions?.[personaId];
        if (Array.isArray(arr)) currentExclusions = arr;
      }
    } catch {
      // Non-fatal: proceed with empty array — safe to append to empty list
    }

    if (currentExclusions.length >= 20) {
      throw new Error('Maximum of 20 exclusion patterns already set');
    }
    if (currentExclusions.includes(trimmed)) {
      return; // Already present — idempotent, not an error
    }

    const newExclusions = [...currentExclusions, trimmed];
    await this.db.collection('projects').doc(projectId).set(
      { exclusions: { [personaId]: newExclusions } },
      { merge: true }
    );
  }

  /**
   * Get the current user's feedback for a ticket.
   * Called from TicketList.getFeedback.
   *
   * Checks the local cache first; falls back to Firestore.
   *
   * @param {string} docId - Firestore doc ID of the ticket
   * @returns {Promise<"relevant"|"noise"|null>}
   */
  async _getFeedback(docId) {
    // Check cache first
    if (this.ticketList && this.ticketList._feedbackCache[docId] !== undefined) {
      return this.ticketList._feedbackCache[docId];
    }
    const user = this.getUser();
    if (!user || !user.uid) return null;
    const data = await this._feedbackService.getFeedback(docId, user.uid);
    const rating = data ? data.rating : null;
    // Store in cache
    if (this.ticketList) {
      this.ticketList._feedbackCache[docId] = rating;
    }
    return rating;
  }

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  _applyFilters() {
    let tickets = this._tickets;

    // Status filter
    if (this._activeFilter !== 'all') {
      tickets = tickets.filter(t => t.status === this._activeFilter);
    }

    // Exclude currently snoozed proposed tickets from the main list —
    // they appear in the collapsible "Snoozed" section instead.
    // Do not apply this exclusion on the 'all' filter so snoozed tickets
    // remain searchable.
    if (this._activeFilter === 'proposed') {
      const now = new Date();
      tickets = tickets.filter(t => {
        if (!t.snoozedUntil) return true;
        const d = new Date(t.snoozedUntil);
        return isNaN(d.getTime()) || d <= now;
      });
    }

    // Cluster filter — show only tickets belonging to the selected cluster
    if (this._activeClusterFilter) {
      const cid = this._activeClusterFilter;
      tickets = tickets.filter(t =>
        Array.isArray(t.clusterIds) && t.clusterIds.includes(cid)
      );
    }

    // Dependency filter — only applies when viewing proposed tickets
    // "blocked" = has at least one incoming 'blocks' link from another proposed ticket
    // "independent" = has no incoming 'blocks' links from other proposed tickets
    if (this._activeDependencyFilter && this._activeDependencyFilter !== 'all' && this._activeFilter === 'proposed') {
      // Build a set of proposed ticket IDs that are blocked by another proposal
      const allProposed = this._tickets.filter(t => t.status === 'proposed');
      const blockedIds = new Set();
      for (const t of allProposed) {
        const links = Array.isArray(t.links) ? t.links : [];
        for (const link of links) {
          if (link.type === 'blocks') {
            // t blocks link.targetId — find if targetId is also proposed
            const target = allProposed.find(p => p.id === link.targetId);
            if (target) blockedIds.add(link.targetId);
          }
        }
      }
      if (this._activeDependencyFilter === 'blocked') {
        tickets = tickets.filter(t => blockedIds.has(t.id));
      } else if (this._activeDependencyFilter === 'independent') {
        tickets = tickets.filter(t => !blockedIds.has(t.id));
      }
    }

    // Search
    if (this._searchQuery.trim()) {
      const q = this._searchQuery.toLowerCase();
      tickets = tickets.filter(t => {
        const fields = [
          t.ticketId,
          t.title,
          t.description,
          t.type,
          t.status,
          statusLabel(t.status),
          t.userEmail,
        ];
        return fields.some(f => f && String(f).toLowerCase().includes(q));
      });
    }

    // Convergence sort — order by convergenceCount descending when active
    if (this._activeSort === 'convergence') {
      tickets = [...tickets].sort((a, b) => {
        const ca = typeof a.convergenceCount === 'number' ? a.convergenceCount : 0;
        const cb = typeof b.convergenceCount === 'number' ? b.convergenceCount : 0;
        return cb - ca; // descending
      });
    }

    // Proposed queue convergence grouping — when viewing proposed tickets, group
    // converged proposals together so reviewers see them as a set.
    // Only applies when NOT using convergence sort (which already surfaces them).
    if (this._activeFilter === 'proposed' && this._activeSort !== 'convergence') {
      tickets = this._groupProposedByConvergence(tickets);
    }

    this._filteredTickets = tickets;

    // Update sort control visibility based on whether any ticket in the full set has convergence
    if (this.filters) {
      const anyConverged = this._tickets.some(t => typeof t.convergenceCount === 'number' && t.convergenceCount >= 1);
      this.filters.setHasConvergedTickets(anyConverged);
    }
  }

  _updateCounts() {
    const counts = { all: this._tickets.length };
    const countMap = {};
    for (const t of this._tickets) {
      countMap[t.status] = (countMap[t.status] || 0) + 1;
    }
    counts.proposed = countMap.proposed || 0;
    counts.open = countMap.open || 0;
    counts.in_progress = countMap.in_progress || 0;
    counts.blocked = countMap.blocked || 0;
    counts.in_maintenance = countMap.in_maintenance || 0;
    counts.waiting_for_user = countMap.waiting_for_user || 0;
    counts.done = countMap.done || 0;

    if (this.filters) this.filters.setCounts(counts);
  }

  /**
   * Re-order proposed tickets so that convergence groups appear together.
   * Tickets with shared convergence relationships are moved adjacent to each other.
   * Non-converged tickets retain their original relative order.
   *
   * Algorithm:
   *   1. Build a union-find structure to identify convergence groups
   *   2. Assign a group-order based on the earliest index in the group
   *   3. Sort by (group-order, original-index) so groups cluster together
   *
   * @param {Array} tickets
   * @returns {Array}
   */
  _groupProposedByConvergence(tickets) {
    if (!tickets || tickets.length === 0) return tickets;

    // Map: docId -> index in tickets array
    const idxById = new Map();
    tickets.forEach((t, i) => { if (t.id) idxById.set(t.id, i); });

    // Build adjacency: for each ticket, collect all convergence partner docIds
    const groupOf = new Array(tickets.length).fill(-1).map((_, i) => i); // union-find

    function find(i) {
      if (groupOf[i] !== i) groupOf[i] = find(groupOf[i]);
      return groupOf[i];
    }
    function unite(i, j) {
      const ri = find(i), rj = find(j);
      if (ri !== rj) groupOf[ri] = rj;
    }

    tickets.forEach((t, i) => {
      const convergence = Array.isArray(t.convergence) ? t.convergence : [];
      for (const entry of convergence) {
        const j = idxById.get(entry.ticketId);
        if (j !== undefined) unite(i, j);
      }
    });

    // Assign group-order = minimum original index within each group
    const groupMinIdx = new Map();
    tickets.forEach((_, i) => {
      const root = find(i);
      const current = groupMinIdx.get(root);
      if (current === undefined || i < current) groupMinIdx.set(root, i);
    });

    // Sort by (group-min-idx, original-idx) to cluster groups
    const indexed = tickets.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => {
      const ga = groupMinIdx.get(find(a.i));
      const gb = groupMinIdx.get(find(b.i));
      if (ga !== gb) return ga - gb;
      return a.i - b.i;
    });

    return indexed.map(x => x.t);
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async _createTicket({ type, title, description, screenshots, projectId, critical }) {
    const user = this.getUser();
    // Validate projectId against the allowed list before routing (defense-in-depth).
    // An attacker modifying the DOM could submit an arbitrary projectId; clamp it to
    // a known-good value so we never write to an unintended project.
    if (projectId && this.projectIds && !this.projectIds.includes(projectId)) {
      projectId = this.defaultProjectId;
    }
    // In multi-project mode, route to the correct project's ticket service
    let svc = this.ticketService;
    if (projectId && this._ticketServices && this.projectIds) {
      const idx = this.projectIds.indexOf(projectId);
      if (idx >= 0 && this._ticketServices[idx]) {
        svc = this._ticketServices[idx];
      }
    }
    await svc.add({
      type,
      title,
      description,
      screenshots,
      userId: user.uid,
      userEmail: user.email,
      critical: critical || false,
    });
    await this.refresh();
  }

  async _transitionTicket(docId, newStatus, opts) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.transitionStatus(docId, newStatus, opts);
    await this.refresh();
  }

  async _answerQuestion(docId, answer) {
    // Transition back to in_progress with the answer as a note,
    // and clear the pending question.
    const svc = this._getTicketServiceForDoc(docId);
    await svc.transitionStatus(docId, 'in_progress', {
      note: 'User answered: ' + answer,
      pendingQuestion: null,
    });
    await this.refresh();
  }

  /**
   * Append an implementation note to a ticket's statusHistory without changing its status.
   *
   * @param {string} docId - Firestore doc id
   * @param {string} note  - Note text
   */
  async _appendNote(docId, note) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.appendHistory(docId, { note });
    await this.refresh();
  }

  async _deleteTicket(docId) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.deleteTicket(docId);
    await this.refresh();
  }

  /**
   * Mark a ticket as critical so the orchestrator spawns a worker immediately,
   * bypassing the normal max-worker cap — matching the behavior of the critical
   * checkbox on the ticket creation form.
   *
   * @param {string} docId - Firestore doc id
   */
  async _markCritical(docId) {
    const svc = this._getTicketServiceForDoc(docId);
    await svc.update(docId, { critical: true });
    await this.refresh();
  }

  /**
   * Snooze or unsnooze a proposed ticket.
   * Pass null as date to unsnooze (clear snoozedUntil).
   *
   * @param {string} docId - Firestore doc id
   * @param {Date|null} date - Target resurface date, or null to unsnooze
   */
  async _snoozeTicket(docId, date) {
    const svc = this._getTicketServiceForDoc(docId);
    if (date === null) {
      await svc.unsnoozeTicket(docId);
    } else {
      await svc.snoozeTicket(docId, date);
    }
    await this.refresh();
  }

  /**
   * Write a rejection record for a proposed ticket.
   * Called after the 4-second undo window expires.
   *
   * Firestore schema (projects/{projectId}/rejections/{id}):
   *   reason        — enum: off_topic | too_small | already_covered | not_relevant
   *   persona       — string: engineer | design | product (from ticket field)
   *   ticketTitle   — immutable snapshot of AI-generated title at rejection time
   *   ticketSummary — immutable snapshot of AI-generated one-line summary at rejection time
   *   createdAt     — ISO timestamp
   *
   * @param {object} opts
   * @param {string} opts.ticketId       - Firestore doc id of the rejected ticket
   * @param {string} opts.ticketTitle    - AI-generated title (immutable snapshot)
   * @param {string} opts.ticketSummary  - AI-generated one-line summary (immutable snapshot)
   * @param {string} opts.reason         - Rejection reason enum
   * @param {string|null} opts.persona   - Advisor persona (engineer|design|product)
   */
  async _rejectProposal({ ticketId, ticketTitle, ticketSummary, reason, persona }) {
    // Determine which project this ticket belongs to for the correct Firestore path
    const ticket = this._tickets.find(t => t.id === ticketId);
    const projectId = (ticket && ticket.projectId) || this.projectId;
    if (!projectId) {
      console.warn('[docket] Cannot record rejection — projectId unknown for ticket', ticketId);
      return;
    }

    // Validate reason is in the allowed enum set before writing
    const VALID_REASONS = ['off_topic', 'too_small', 'already_covered', 'not_relevant'];
    if (!VALID_REASONS.includes(reason)) {
      console.warn('[docket] Invalid rejection reason:', reason);
      return;
    }

    // Write directly to Firestore rejections subcollection
    try {
      const ref = this.db
        .collection('projects')
        .doc(projectId)
        .collection('rejections')
        .doc(ticketId);

      const doc = {
        reason,
        // Immutable snapshots of AI-generated content — never store user-supplied text here
        ticketTitle: typeof ticketTitle === 'string' ? ticketTitle.slice(0, 500) : '',
        ticketSummary: typeof ticketSummary === 'string' ? ticketSummary.slice(0, 500) : '',
        persona: typeof persona === 'string' ? persona.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 50) : null,
        createdAt: new Date().toISOString(),
      };

      await ref.set(doc);
    } catch (err) {
      console.warn('[docket] Rejection record save failed:', err);
    }
  }

  _getTicketServiceForDoc(docId) {
    if (!this._ticketServices || this._ticketServices.length === 0) {
      return this.ticketService;
    }
    // Find which project owns this ticket by looking in _tickets
    const ticket = this._tickets.find(t => t.id === docId);
    if (ticket && ticket.projectId) {
      const idx = (this.projectIds || []).indexOf(ticket.projectId);
      if (idx >= 0 && this._ticketServices[idx]) {
        return this._ticketServices[idx];
      }
    }
    return this.ticketService;
  }

  /**
   * Add a directional link from a source ticket to a target ticket.
   * Delegates to the ticket service for the source ticket's project.
   *
   * Cross-project linking is intentionally disallowed: both tickets must be
   * in the same project (the source ticket's project service is used for all
   * reads and writes, enforcing project scoping on the client read path).
   *
   * @param {string} sourceDocId - Firestore doc ID of the source ticket
   * @param {string} targetDocId - Firestore doc ID of the target ticket
   * @param {'blocks'|'related'|'follow-up'} type
   */
  async _addLink(sourceDocId, targetDocId, type) {
    const sourceTicket = this._tickets.find(t => t.id === sourceDocId);
    const targetTicket = this._tickets.find(t => t.id === targetDocId);

    // Enforce project scoping — both tickets must belong to the same project
    if (sourceTicket && targetTicket && sourceTicket.projectId !== targetTicket.projectId) {
      throw new Error('Cannot link tickets across different projects');
    }

    const svc = this._getTicketServiceForDoc(sourceDocId);
    await svc.addLink(sourceDocId, targetDocId, type);
    await this.refresh();
  }

  /**
   * Remove an existing link from a source ticket to a target ticket.
   *
   * @param {string} sourceDocId - Firestore doc ID of the source ticket
   * @param {string} targetDocId - Firestore doc ID of the target ticket
   */
  async _removeLink(sourceDocId, targetDocId) {
    const svc = this._getTicketServiceForDoc(sourceDocId);
    await svc.removeLink(sourceDocId, targetDocId);
    await this.refresh();
  }

  // -----------------------------------------------------------------------
  // Real-time
  // -----------------------------------------------------------------------

  /**
   * Returns true if any ticket in `changedTickets` is visible under the
   * current filter/search, or if ticket counts would change (status changed).
   * Used to skip unnecessary re-renders.
   *
   * @param {Array} changedTickets - tickets that were added/modified in this snapshot
   * @param {Array} [removedTickets] - tickets that were removed
   * @returns {boolean}
   */
  _changesAffectView(changedTickets, removedTickets) {
    // Count changes always matter (filter tabs show counts)
    if (removedTickets && removedTickets.length > 0) return true;

    for (const t of changedTickets) {
      // Does this ticket pass the active filter?
      if (this._activeFilter !== 'all' && t.status !== this._activeFilter) {
        // Status may have changed — if the ticket was previously visible it is
        // now gone; if it just became the active status it is now new.  Either
        // way the view needs updating.  We can't tell without the old status
        // here, so conservatively say yes.
        return true;
      }
      // Does it pass the search query?
      if (this._searchQuery.trim()) {
        const q = this._searchQuery.toLowerCase();
        const fields = [
          t.ticketId, t.title, t.description, t.type, t.status,
          statusLabel(t.status), t.userEmail,
        ];
        if (!fields.some(f => f && String(f).toLowerCase().includes(q))) {
          // This ticket doesn't match the search.  But it might have previously
          // matched (before the update), so we still need to re-render to remove it.
          return true;
        }
      }
      return true; // ticket is visible — definitely need to re-render
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Project version listeners
  // -----------------------------------------------------------------------

  /**
   * Subscribe to the project document(s) in Firestore to track liveVersion in real time.
   * Updates _projectVersions map and re-renders the live version indicator on changes.
   */
  _startProjectVersionListeners() {
    // Clean up any existing subscriptions
    for (const unsub of this._projectVersionUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._projectVersionUnsubs = [];

    const projectIds = this.projectIds && this.projectIds.length > 0
      ? this.projectIds
      : (this.projectId ? [this.projectId] : []);

    for (const pid of projectIds) {
      try {
        const ref = this.db.collection('projects').doc(pid);
        const unsub = ref.onSnapshot(
          (snap) => {
            const data = snap.exists ? snap.data() : {};
            this._projectVersions[pid] = data.liveVersion || null;
            this._renderLiveVersion();
            // Update repoBaseUrl from project doc if not set via constructor options.
            // In single-project mode, take the first project's repoBaseUrl.
            // Constructor-supplied value takes precedence.
            if (!this._repoBaseUrlFromOptions && data.repoBaseUrl) {
              this._repoBaseUrl = data.repoBaseUrl;
              // Propagate to existing ticketList if already mounted
              if (this.ticketList) {
                this.ticketList.repoBaseUrl = this._repoBaseUrl;
              }
            }
          },
          (_err) => {
            // Listener error — clear the version for this project
            this._projectVersions[pid] = null;
            this._renderLiveVersion();
          }
        );
        this._projectVersionUnsubs.push(unsub);
      } catch (_e) {
        // Firestore not available for this project — skip
      }
    }
  }

  /**
   * Render the live version indicator element.
   * In single-project mode shows: "Live: v1.2.3"
   * In multi-project mode shows one badge per project that has a liveVersion.
   */
  _renderLiveVersion() {
    if (!this._liveVersionEl) return;
    this._liveVersionEl.innerHTML = '';

    const projectIds = this.projectIds && this.projectIds.length > 0
      ? this.projectIds
      : (this.projectId ? [this.projectId] : []);

    const entries = projectIds
      .map(pid => ({ pid, version: this._projectVersions[pid] }))
      .filter(e => e.version);

    if (entries.length === 0) {
      // Nothing to show — keep element empty (zero height)
      return;
    }

    const isMulti = projectIds.length > 1;

    for (const { pid, version } of entries) {
      const badge = el('span', { className: 'tk-live-version-badge' },
        el('span', { className: 'tk-live-version-label' }, 'Live'),
        isMulti
          ? el('span', { className: 'tk-live-version-project' }, pid + ' ')
          : null,
        el('span', { className: 'tk-live-version-value' }, version),
      );
      this._liveVersionEl.appendChild(badge);
    }
  }

  /**
   * Show a modal to create a new Docket project.
   */
  _showNewProjectModal() {
    const overlay = el('div', { className: 'tk-changelog-overlay ' + this._rootClass() });
    const modal = el('div', { className: 'tk-changelog-modal' });

    const modalHeader = el('div', { className: 'tk-changelog-modal-header' },
      el('h2', { className: 'tk-changelog-modal-title' }, 'New Project'),
      el('button', {
        className: 'tk-btn-close',
        onClick: () => overlay.remove(),
      }, '\u00D7'),
    );

    const errorEl = el('div', { className: 'tk-form-error' });
    errorEl.style.display = 'none';

    const idInput = el('input', {
      className: 'tk-form-input',
      type: 'text',
      placeholder: 'project-id (e.g. my-app)',
    });
    const nameInput = el('input', {
      className: 'tk-form-input',
      type: 'text',
      placeholder: 'Display name (e.g. My App)',
    });
    const prefixInput = el('input', {
      className: 'tk-form-input',
      type: 'text',
      placeholder: 'Ticket prefix (e.g. MA)',
      style: 'text-transform: uppercase;',
    });

    const submitBtn = el('button', {
      className: 'tk-btn tk-btn-primary',
      onClick: async () => {
        const id = idInput.value.trim();
        const name = nameInput.value.trim();
        const prefix = prefixInput.value.trim().toUpperCase();
        errorEl.style.display = 'none';

        if (!id || !name || !prefix) {
          errorEl.textContent = 'All fields are required.';
          errorEl.style.display = 'block';
          return;
        }

        submitBtn.disabled = true;
        submitBtn.classList.add('tk-btn-loading');
        submitBtn.textContent = 'Creating...';
        try {
          await this.projectService.register({ id, name, prefix });
          overlay.remove();
          this.toast.success(`Project "${name}" created.`);
        } catch (err) {
          errorEl.textContent = err.message || 'Failed to create project.';
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.classList.remove('tk-btn-loading');
          submitBtn.textContent = 'Create Project';
        }
      },
    }, 'Create Project');

    const body = el('div', { style: 'padding: 16px; display: flex; flex-direction: column; gap: 12px;' },
      el('div', { className: 'tk-form-group' },
        el('label', {}, 'Project ID'),
        idInput,
      ),
      el('div', { className: 'tk-form-group' },
        el('label', {}, 'Display Name'),
        nameInput,
      ),
      el('div', { className: 'tk-form-group' },
        el('label', {}, 'Ticket Prefix (2-4 uppercase letters)'),
        prefixInput,
      ),
      errorEl,
      el('div', { className: 'tk-form-actions' },
        submitBtn,
      ),
    );

    modal.appendChild(modalHeader);
    modal.appendChild(body);
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    idInput.focus();
  }

  /**
   * Show a changelog modal listing done/verified tickets grouped by deployedVersion.
   * Tickets without a deployedVersion appear under "Unversioned".
   */
  _showChangelog() {
    // Gather done and verified tickets
    const changelogTickets = this._tickets.filter(
      t => t.status === 'done' || t.status === 'verified'
    );

    // Group by deployedVersion (fall back to scanning statusHistory)
    const groups = new Map(); // version -> tickets[]
    for (const t of changelogTickets) {
      const version = t.deployedVersion || this._getTicketVersion(t) || 'Unversioned';
      if (!groups.has(version)) groups.set(version, []);
      groups.get(version).push(t);
    }

    // Sort versions: semver-ish descending, "Unversioned" last
    const sortedVersions = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'Unversioned') return 1;
      if (b === 'Unversioned') return -1;
      // Compare semver parts numerically
      const partsA = a.replace(/^v/, '').split('.').map(Number);
      const partsB = b.replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsB[i] || 0) - (partsA[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

    // Build modal content
    const body = el('div', { className: 'tk-changelog-modal-body' });

    if (changelogTickets.length === 0) {
      body.appendChild(el('p', { className: 'tk-changelog-empty' }, 'No completed tickets yet.'));
    } else {
      for (const version of sortedVersions) {
        const tickets = groups.get(version);
        const isUnversioned = version === 'Unversioned';
        const heading = el('h3', { className: 'tk-changelog-version-heading' });
        if (!isUnversioned) {
          heading.appendChild(el('span', { className: 'tk-changelog-version-tag' }, version));
        }
        heading.appendChild(document.createTextNode(isUnversioned ? 'Unversioned' : ''));

        const group = el('div', { className: 'tk-changelog-version-group' }, heading);

        for (const t of tickets) {
          const statusClass = t.status === 'verified'
            ? 'tk-changelog-ticket-status tk-changelog-ticket-status-verified'
            : 'tk-changelog-ticket-status tk-changelog-ticket-status-done';
          // Find when this ticket was last marked done or verified
          const completedAt = this._getTicketCompletedAt(t);
          const row = el('div', { className: 'tk-changelog-ticket-row' },
            el('span', { className: 'tk-changelog-ticket-id' }, t.ticketId || ''),
            el('span', { className: 'tk-changelog-ticket-title' }, t.title || '(no title)'),
            el('span', { className: statusClass }, t.status),
            completedAt
              ? el('span', { className: 'tk-changelog-ticket-date' }, formatDateCompact(completedAt))
              : null,
          );
          group.appendChild(row);
        }

        body.appendChild(group);
      }
    }

    // Build overlay + modal
    const overlay = el('div', { className: 'tk-changelog-overlay ' + this._rootClass() });
    const modal = el('div', { className: 'tk-changelog-modal' });

    const modalHeader = el('div', { className: 'tk-changelog-modal-header' },
      el('h2', { className: 'tk-changelog-modal-title' }, '\uD83D\uDCCB Changelog'),
      el('button', {
        className: 'tk-btn-close',
        onClick: () => overlay.remove(),
      }, '\u00D7'),
    );

    modal.appendChild(modalHeader);
    modal.appendChild(body);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
  }

  /**
   * Show token spend breakdown modal.
   * Displays per-ticket cost/duration breakdown for done tickets, with a
   * selectable time range filter (7d, 30d, 90d, all time).
   */
  _showTokenSpend() {
    // Build the overlay/modal shell
    const overlay = el('div', { className: 'tk-changelog-overlay ' + this._rootClass() });
    const modal = el('div', { className: 'tk-changelog-modal tk-token-spend-modal' });

    const modalHeader = el('div', { className: 'tk-changelog-modal-header' },
      el('h2', { className: 'tk-changelog-modal-title' }, '\uD83D\uDCB0 Token Spend'),
      el('button', {
        className: 'tk-btn-close',
        onClick: () => overlay.remove(),
      }, '\u00D7'),
    );

    // ── Claude plan usage section ────────────────────────────────────
    // Reads planUsage from orchestrator/config doc (written by usage-monitor).
    const planSection = el('div', { className: 'tk-plan-usage-section' });
    const planContent = el('div', { className: 'tk-plan-usage-content' });
    planSection.appendChild(el('div', { className: 'tk-plan-usage-title' }, '📊 Claude Plan Limits'));
    planSection.appendChild(planContent);

    const renderPlanUsage = (planUsage) => {
      planContent.innerHTML = '';
      if (!planUsage) {
        planContent.appendChild(el('p', { className: 'tk-plan-usage-unavailable' },
          'Plan usage data unavailable. The orchestrator must be running with a valid OAuth token to track this. Run ',
          el('code', {}, 'claude auth login'),
          ' on the machine running the orchestrator.'
        ));
        return;
      }

      const { limits, checkedAt } = planUsage;

      if (!Array.isArray(limits) || limits.length === 0) {
        planContent.appendChild(el('p', { className: 'tk-plan-usage-unavailable' },
          'No active plan limits found.'
        ));
        return;
      }

      const barsEl = el('div', { className: 'tk-plan-usage-bars' });
      for (const limit of limits) {
        const pct = Math.min(100, Math.max(0, Math.round(limit.utilization || 0)));
        const colorClass = pct >= 90 ? 'tk-plan-bar-danger' : pct >= 75 ? 'tk-plan-bar-warn' : 'tk-plan-bar-ok';
        let resetLabel = '';
        if (limit.resets_at) {
          try {
            const resetDate = new Date(limit.resets_at);
            const diffMs = resetDate.getTime() - Date.now();
            if (diffMs > 0) {
              const diffH = Math.round(diffMs / 3600000);
              const diffM = Math.round(diffMs / 60000);
              resetLabel = diffH >= 2 ? ` — resets in ${diffH}h` : ` — resets in ${diffM}m`;
            } else {
              resetLabel = ' — resetting…';
            }
          } catch { /* ignore */ }
        }
        barsEl.appendChild(el('div', { className: 'tk-plan-bar-row' },
          el('div', { className: 'tk-plan-bar-label' },
            el('span', { className: 'tk-plan-bar-name' }, limit.name),
            el('span', { className: 'tk-plan-bar-pct' + (pct >= 90 ? ' tk-plan-pct-danger' : '') }, `${pct}%${resetLabel}`),
          ),
          el('div', { className: 'tk-plan-bar-track' },
            el('div', {
              className: `tk-plan-bar-fill ${colorClass}`,
              style: { width: pct + '%' },
            }),
          ),
        ));
      }
      planContent.appendChild(barsEl);

      if (checkedAt) {
        try {
          const checkedDate = new Date(checkedAt);
          const diffMs = Date.now() - checkedDate.getTime();
          const diffM = Math.round(diffMs / 60000);
          const timeLabel = diffM < 1 ? 'just now' : diffM === 1 ? '1 min ago' : `${diffM} min ago`;
          planContent.appendChild(el('p', { className: 'tk-plan-usage-checked-at' }, `Last checked ${timeLabel}`));
        } catch { /* ignore */ }
      }
    };

    // Fetch planUsage from Firestore orchestrator/config
    renderPlanUsage(null); // show loading/unavailable state initially
    this.db.collection('orchestrator').doc('config').get().then(snap => {
      if (!snap.exists) return;
      const data = snap.data();
      renderPlanUsage(data.planUsage || null);
    }).catch(() => {
      // Firestore unavailable — leave unavailable state
    });

    // Time range selector
    const ranges = [
      { label: '7 days', days: 7 },
      { label: '30 days', days: 30 },
      { label: '90 days', days: 90 },
      { label: 'All time', days: null },
    ];
    let selectedDays = 30; // default

    const body = el('div', { className: 'tk-changelog-modal-body' });

    const renderBody = () => {
      body.innerHTML = '';

      // Filter tickets: only those with costUsd > 0 (completed by an agent)
      const now = Date.now();
      const cutoff = selectedDays != null ? now - selectedDays * 24 * 60 * 60 * 1000 : null;

      const eligible = this._tickets.filter(t => {
        if (!t.costUsd || t.costUsd <= 0) return false;
        if (cutoff != null) {
          // Use createdAt or the most recent statusHistory entry timestamp
          let ts = null;
          if (t.createdAt) {
            const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
            ts = d.getTime();
          }
          if (ts == null) return true; // include if no date info
          if (ts < cutoff) return false;
        }
        return true;
      });

      // Sort by costUsd descending
      const sorted = [...eligible].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));

      // Summary totals
      const totalCost = sorted.reduce((sum, t) => sum + (t.costUsd || 0), 0);
      const totalDuration = sorted.reduce((sum, t) => sum + (t.durationMs || 0), 0);
      const ticketCount = sorted.length;

      if (ticketCount === 0) {
        body.appendChild(el('p', { className: 'tk-changelog-empty' },
          selectedDays != null
            ? `No agent spend recorded in the last ${selectedDays} days.`
            : 'No agent spend recorded yet.'
        ));
        return;
      }

      // Summary row
      const summaryEl = el('div', { className: 'tk-token-spend-summary' },
        el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Total spend'),
          el('span', { className: 'tk-token-spend-summary-value tk-token-spend-cost' },
            formatCost(totalCost) || '$0.00'
          ),
        ),
        el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Tickets'),
          el('span', { className: 'tk-token-spend-summary-value' }, String(ticketCount)),
        ),
        totalDuration > 0 ? el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Total runtime'),
          el('span', { className: 'tk-token-spend-summary-value' }, formatDuration(totalDuration) || '—'),
        ) : null,
        totalCost > 0 && ticketCount > 1 ? el('div', { className: 'tk-token-spend-summary-item' },
          el('span', { className: 'tk-token-spend-summary-label' }, 'Avg per ticket'),
          el('span', { className: 'tk-token-spend-summary-value' }, formatCost(totalCost / ticketCount) || '—'),
        ) : null,
      );
      body.appendChild(summaryEl);

      // --- Time-series chart section ---
      // Group tickets by calendar day (using createdAt timestamp)
      // Build a sorted list of days with daily and cumulative spend
      const dayMap = new Map(); // 'YYYY-MM-DD' → { cost, count }
      for (const t of eligible) {
        let dateKey = null;
        if (t.createdAt) {
          const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
          if (!isNaN(d)) {
            // Use local date string as key
            dateKey = d.toISOString().slice(0, 10);
          }
        }
        if (!dateKey) continue; // skip tickets without a timestamp
        const existing = dayMap.get(dateKey) || { cost: 0, count: 0 };
        existing.cost += t.costUsd || 0;
        existing.count += 1;
        dayMap.set(dateKey, existing);
      }

      // Only render charts when we have at least 2 data points with dates
      if (dayMap.size >= 2) {
        const days = [...dayMap.keys()].sort(); // chronological order
        const dayCosts = days.map(d => dayMap.get(d).cost);
        const maxDay = Math.max(...dayCosts);

        // Compute cumulative values
        const cumCosts = [];
        let running = 0;
        for (const c of dayCosts) { running += c; cumCosts.push(running); }
        const maxCum = running;

        // Chart dimensions
        const chartW = 660;
        const chartH = 120;
        const padL = 52; // left padding for y-axis labels
        const padR = 12;
        const padT = 10;
        const padB = 28; // bottom for x-axis labels
        const innerW = chartW - padL - padR;
        const innerH = chartH - padT - padB;
        const n = days.length;
        const barGap = 0.25; // fraction of slot for gap
        const slotW = innerW / n;
        const barW = Math.max(2, slotW * (1 - barGap));

        // SVG namespace helper
        const svgNS = 'http://www.w3.org/2000/svg';
        const svgEl = (tag, attrs, ...kids) => {
          const node = document.createElementNS(svgNS, tag);
          for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
          for (const k of kids) { if (k) node.appendChild(k); }
          return node;
        };
        const svgText = (content) => document.createTextNode(content);

        // Helper: format a cost for axis label
        const axisLabel = (v) => v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`;

        // ---- Bar chart: daily spend ----
        const barSvg = svgEl('svg', {
          width: '100%', viewBox: `0 0 ${chartW} ${chartH}`,
          class: 'tk-ts-chart',
          style: 'display:block;overflow:visible;',
        });

        // Grid lines + y-axis labels (3 lines)
        for (let i = 0; i <= 2; i++) {
          const frac = i / 2;
          const y = padT + innerH * (1 - frac);
          const val = maxDay * frac;
          barSvg.appendChild(svgEl('line', {
            x1: padL, y1: y, x2: chartW - padR, y2: y,
            class: frac === 0 ? 'tk-ts-axis' : 'tk-ts-grid',
          }));
          barSvg.appendChild(svgEl('text', {
            x: padL - 4, y: y + 4, class: 'tk-ts-label', 'text-anchor': 'end',
          }, svgText(axisLabel(val))));
        }

        // Bars
        for (let i = 0; i < n; i++) {
          const x = padL + i * slotW + (slotW - barW) / 2;
          const barH2 = maxDay > 0 ? (dayCosts[i] / maxDay) * innerH : 0;
          const y = padT + innerH - barH2;
          const bar = svgEl('rect', {
            x, y, width: barW, height: barH2,
            class: 'tk-ts-bar',
            rx: '1',
          });
          // Tooltip via title
          const titleEl = svgEl('title', {});
          titleEl.appendChild(svgText(`${days[i]}: ${axisLabel(dayCosts[i])}`));
          bar.appendChild(titleEl);
          barSvg.appendChild(bar);

          // X-axis date label — only show first, middle, last to avoid clutter
          if (i === 0 || i === Math.floor(n / 2) || i === n - 1) {
            const lx = padL + i * slotW + slotW / 2;
            // Format as M/D
            const [, mm, dd] = days[i].split('-');
            barSvg.appendChild(svgEl('text', {
              x: lx, y: chartH - 6, class: 'tk-ts-label', 'text-anchor': 'middle',
            }, svgText(`${parseInt(mm)}/${parseInt(dd)}`)));
          }
        }

        // ---- Line chart: cumulative spend ----
        const lineSvg = svgEl('svg', {
          width: '100%', viewBox: `0 0 ${chartW} ${chartH}`,
          class: 'tk-ts-chart',
          style: 'display:block;overflow:visible;',
        });

        // Grid lines + y-axis labels
        for (let i = 0; i <= 2; i++) {
          const frac = i / 2;
          const y = padT + innerH * (1 - frac);
          const val = maxCum * frac;
          lineSvg.appendChild(svgEl('line', {
            x1: padL, y1: y, x2: chartW - padR, y2: y,
            class: frac === 0 ? 'tk-ts-axis' : 'tk-ts-grid',
          }));
          lineSvg.appendChild(svgEl('text', {
            x: padL - 4, y: y + 4, class: 'tk-ts-label', 'text-anchor': 'end',
          }, svgText(axisLabel(val))));
        }

        // Build polyline points (center of each bar slot)
        const points = cumCosts.map((c, i) => {
          const px = padL + i * slotW + slotW / 2;
          const py = padT + innerH - (maxCum > 0 ? (c / maxCum) * innerH : 0);
          return `${px},${py}`;
        }).join(' ');

        // Filled area under line
        const firstPx = padL + 0 * slotW + slotW / 2;
        const lastPx = padL + (n - 1) * slotW + slotW / 2;
        const baseY = padT + innerH;
        const areaPoints = `${firstPx},${baseY} ${points} ${lastPx},${baseY}`;
        lineSvg.appendChild(svgEl('polygon', { points: areaPoints, class: 'tk-ts-area' }));
        lineSvg.appendChild(svgEl('polyline', { points, class: 'tk-ts-line' }));

        // Dots + x-axis labels
        for (let i = 0; i < n; i++) {
          const px = padL + i * slotW + slotW / 2;
          const py = padT + innerH - (maxCum > 0 ? (cumCosts[i] / maxCum) * innerH : 0);
          const dot = svgEl('circle', { cx: px, cy: py, r: '3', class: 'tk-ts-dot' });
          const titleEl = svgEl('title', {});
          titleEl.appendChild(svgText(`${days[i]}: ${axisLabel(cumCosts[i])} cumulative`));
          dot.appendChild(titleEl);
          lineSvg.appendChild(dot);

          if (i === 0 || i === Math.floor(n / 2) || i === n - 1) {
            const [, mm, dd] = days[i].split('-');
            lineSvg.appendChild(svgEl('text', {
              x: px, y: chartH - 6, class: 'tk-ts-label', 'text-anchor': 'middle',
            }, svgText(`${parseInt(mm)}/${parseInt(dd)}`)));
          }
        }

        // ---- Scatter chart: spend per ticket over time ----
        // Build sorted list of individual tickets with dates
        const ticketPoints = [];
        for (const t of eligible) {
          if (!t.createdAt) continue;
          const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
          if (isNaN(d)) continue;
          ticketPoints.push({
            dateKey: d.toISOString().slice(0, 10),
            ts: d.getTime(),
            costUsd: t.costUsd || 0,
            ticketId: t.ticketId || '',
            title: t.title || '(no title)',
          });
        }
        ticketPoints.sort((a, b) => a.ts - b.ts);

        const scatterSvg = svgEl('svg', {
          width: '100%', viewBox: `0 0 ${chartW} ${chartH}`,
          class: 'tk-ts-chart',
          style: 'display:block;overflow:visible;',
        });

        if (ticketPoints.length >= 1) {
          const maxTicket = Math.max(...ticketPoints.map(p => p.costUsd));
          const minTs = ticketPoints[0].ts;
          const maxTs = ticketPoints[ticketPoints.length - 1].ts;
          const tsRange = maxTs - minTs || 1;

          // Grid lines + y-axis labels (3 lines)
          for (let i = 0; i <= 2; i++) {
            const frac = i / 2;
            const y = padT + innerH * (1 - frac);
            const val = maxTicket * frac;
            scatterSvg.appendChild(svgEl('line', {
              x1: padL, y1: y, x2: chartW - padR, y2: y,
              class: frac === 0 ? 'tk-ts-axis' : 'tk-ts-grid',
            }));
            scatterSvg.appendChild(svgEl('text', {
              x: padL - 4, y: y + 4, class: 'tk-ts-label', 'text-anchor': 'end',
            }, svgText(axisLabel(val))));
          }

          // Lollipop: vertical stem + dot per ticket
          for (const p of ticketPoints) {
            const px = ticketPoints.length === 1
              ? padL + innerW / 2
              : padL + ((p.ts - minTs) / tsRange) * innerW;
            const py = padT + innerH - (maxTicket > 0 ? (p.costUsd / maxTicket) * innerH : 0);
            const baseY = padT + innerH;

            // Stem
            const stem = svgEl('line', {
              x1: px, y1: py, x2: px, y2: baseY,
              class: 'tk-ts-scatter-stem',
            });
            const stemTitle = svgEl('title', {});
            stemTitle.appendChild(svgText(`${p.ticketId}: ${p.title} — ${axisLabel(p.costUsd)} (${p.dateKey})`));
            stem.appendChild(stemTitle);
            scatterSvg.appendChild(stem);

            // Dot
            const dot = svgEl('circle', { cx: px, cy: py, r: '4', class: 'tk-ts-scatter-dot' });
            const dotTitle = svgEl('title', {});
            dotTitle.appendChild(svgText(`${p.ticketId}: ${p.title} — ${axisLabel(p.costUsd)} (${p.dateKey})`));
            dot.appendChild(dotTitle);
            scatterSvg.appendChild(dot);
          }

          // X-axis date labels: first, middle, last
          const labelIdxs = ticketPoints.length === 1 ? [0] : [0, Math.floor(ticketPoints.length / 2), ticketPoints.length - 1];
          for (const i of [...new Set(labelIdxs)]) {
            const p = ticketPoints[i];
            const px = ticketPoints.length === 1
              ? padL + innerW / 2
              : padL + ((p.ts - minTs) / tsRange) * innerW;
            const [, mm, dd] = p.dateKey.split('-');
            scatterSvg.appendChild(svgEl('text', {
              x: px, y: chartH - 6, class: 'tk-ts-label', 'text-anchor': 'middle',
            }, svgText(`${parseInt(mm)}/${parseInt(dd)}`)));
          }
        }

        const chartsSection = el('div', { className: 'tk-ts-charts-section' },
          el('div', { className: 'tk-ts-chart-block' },
            el('div', { className: 'tk-ts-chart-title' }, 'Daily spend'),
            barSvg,
          ),
          el('div', { className: 'tk-ts-chart-block' },
            el('div', { className: 'tk-ts-chart-title' }, 'Spend per ticket'),
            scatterSvg,
          ),
          el('div', { className: 'tk-ts-chart-block' },
            el('div', { className: 'tk-ts-chart-title' }, 'Cumulative spend'),
            lineSvg,
          ),
        );
        body.appendChild(chartsSection);
      }

      // Per-ticket breakdown table
      const tableHeader = el('div', { className: 'tk-token-spend-table-header' },
        el('span', { className: 'tk-token-spend-col-id' }, 'Ticket'),
        el('span', { className: 'tk-token-spend-col-title' }, 'Title'),
        el('span', { className: 'tk-token-spend-col-cost' }, 'Cost'),
        el('span', { className: 'tk-token-spend-col-duration' }, 'Duration'),
        el('span', { className: 'tk-token-spend-col-status' }, 'Status'),
      );
      body.appendChild(tableHeader);

      for (const t of sorted) {
        const costStr = formatCost(t.costUsd) || '—';
        const durationStr = formatDuration(t.durationMs) || '—';
        const barPct = totalCost > 0 ? Math.round((t.costUsd / totalCost) * 100) : 0;

        const row = el('div', { className: 'tk-token-spend-row' },
          el('span', { className: 'tk-token-spend-col-id' }, t.ticketId || ''),
          el('span', { className: 'tk-token-spend-col-title' }, t.title || '(no title)'),
          el('span', { className: 'tk-token-spend-col-cost' },
            el('span', { className: 'tk-token-spend-cost-label' }, costStr),
            barPct > 0 ? el('span', { className: 'tk-token-spend-bar-wrap' },
              el('span', {
                className: 'tk-token-spend-bar',
                style: { width: barPct + '%' },
                title: barPct + '% of total',
              }),
            ) : null,
          ),
          el('span', { className: 'tk-token-spend-col-duration' }, durationStr),
          el('span', {
            className: `tk-token-spend-col-status tk-token-spend-status-${t.status}`,
          }, t.status || ''),
        );
        body.appendChild(row);
      }
    };

    // Time range pill buttons
    const rangeRow = el('div', { className: 'tk-token-spend-range-row' },
      el('span', { className: 'tk-token-spend-range-label' }, 'Time range:'),
      ...ranges.map(r => {
        const btn = el('button', {
          className: 'tk-token-spend-range-btn' + (r.days === selectedDays ? ' tk-active' : ''),
          type: 'button',
          onClick: () => {
            selectedDays = r.days;
            // Update active state
            rangeRow.querySelectorAll('.tk-token-spend-range-btn').forEach(b => b.classList.remove('tk-active'));
            btn.classList.add('tk-active');
            renderBody();
          },
        }, r.label);
        return btn;
      }),
    );

    modal.appendChild(modalHeader);
    modal.appendChild(planSection);
    modal.appendChild(rangeRow);
    modal.appendChild(body);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    renderBody();
    document.body.appendChild(overlay);
  }

  /**
   * Return the timestamp when a ticket last entered done or verified status.
   * Scans statusHistory from newest to oldest. Falls back to updatedAt.
   */
  _getTicketCompletedAt(ticket) {
    const history = ticket.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if ((entry.to === 'done' || entry.to === 'verified') && entry.at) {
        return entry.at;
      }
    }
    return ticket.updatedAt || null;
  }

  /**
   * Extract version string from a ticket's statusHistory notes (fallback).
   */
  _getTicketVersion(ticket) {
    const history = ticket.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      const note = history[i].note || '';
      const match = note.match(/v\d+\.\d+(?:\.\d+)?/);
      if (match) return match[0];
    }
    return null;
  }

  /**
   * Subscribe to the clusters subcollection for each project.
   * Updates _clusters map and re-renders ticket list on changes so cluster
   * tags stay in sync (e.g. ticketCount increments appear live).
   */
  _startClusterListeners() {
    // Clean up existing subscriptions
    for (const unsub of this._clusterUnsubs) {
      try { unsub(); } catch (_e) {}
    }
    this._clusterUnsubs = [];

    const projectIds = this.projectIds && this.projectIds.length > 0
      ? this.projectIds
      : (this.projectId ? [this.projectId] : []);

    for (const pid of projectIds) {
      try {
        const ref = this.db.collection('projects').doc(pid).collection('clusters');
        const unsub = ref.onSnapshot(
          (snap) => {
            // Re-build cluster map from scratch on each update for simplicity
            // (cluster collection is expected to be small — max 50 per project)
            for (const doc of snap.docs) {
              const data = doc.data();
              this._clusters.set(doc.id, { id: doc.id, ...data });
            }
            // Remove deleted clusters
            if (snap.docChanges) {
              for (const change of snap.docChanges()) {
                if (change.type === 'removed') {
                  this._clusters.delete(change.doc.id);
                }
              }
            }
            // Propagate updated clusters to ticketList so tags re-render
            if (this.ticketList) {
              this.ticketList.clusters = this._clusters;
              this._renderList();
            }
          },
          (_err) => {
            // Listener error — silently ignore (clusters are non-critical)
          }
        );
        this._clusterUnsubs.push(unsub);
      } catch (_e) {
        // Firestore not available — skip
      }
    }
  }

  _startRealtimeListener() {
    try {
      if (this._ticketServices && this._ticketServices.length > 0) {
        // Multi-project mode: one listener per project.
        // ticketsByProject stores the latest snapshot for each project index.
        const ticketsByProject = new Array(this._ticketServices.length).fill(null).map(() => []);

        // Pending updates map: projectIndex -> {tickets, changed, removed}
        // Batched together by the debounce timer so rapid-fire updates from
        // multiple projects collapse into a single merge + render cycle.
        let pendingByProject = {};
        let debounceTimer = null;

        const flush = () => {
          debounceTimer = null;
          const pending = pendingByProject;
          pendingByProject = {};

          // Apply all pending snapshots to ticketsByProject
          let anyChanged = false;
          for (const [idxStr, update] of Object.entries(pending)) {
            const i = Number(idxStr);
            ticketsByProject[i] = update.tickets;
            if (this._changesAffectView(update.changed, update.removed)) {
              anyChanged = true;
            }
          }

          if (!anyChanged) return; // nothing visible changed — skip re-render

          // Merge and sort across all projects
          const merged = [].concat(...ticketsByProject);
          merged.sort((a, b) => (b.ticketNumber || 0) - (a.ticketNumber || 0));
          this._tickets = merged;
          this._applyFilters();
          this._renderList();
          this._updateCounts();
        };

        const unsubscribers = this._ticketServices.map((svc, i) =>
          svc.onTicketsChanged((snapshot) => {
            const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Determine which tickets actually changed in this snapshot
            const changed = [];
            const removed = [];
            if (snapshot.docChanges) {
              for (const change of snapshot.docChanges()) {
                if (change.type === 'removed') {
                  removed.push({ id: change.doc.id, ...change.doc.data() });
                } else {
                  changed.push({ id: change.doc.id, ...change.doc.data() });
                }
              }
            } else {
              // Fallback if docChanges not available — treat all as changed
              changed.push(...tickets);
            }

            // Merge into pending (later update for same project index wins)
            if (pendingByProject[i]) {
              pendingByProject[i].tickets = tickets;
              pendingByProject[i].changed.push(...changed);
              pendingByProject[i].removed.push(...removed);
            } else {
              pendingByProject[i] = { tickets, changed, removed };
            }

            // Debounce: wait one animation frame to batch updates from other projects
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flush, 16);
          })
        );

        this._unsubscribe = () => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          unsubscribers.forEach(u => u());
        };
      } else {
        // Single-project mode
        let debounceTimer = null;
        let pendingSnapshot = null;

        const flush = () => {
          debounceTimer = null;
          const snapshot = pendingSnapshot;
          pendingSnapshot = null;
          if (!snapshot) return;

          const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

          // Determine changed tickets for skip-render check
          let changed = tickets;
          let removed = [];
          if (snapshot.docChanges) {
            changed = [];
            for (const change of snapshot.docChanges()) {
              if (change.type === 'removed') {
                removed.push({ id: change.doc.id, ...change.doc.data() });
              } else {
                changed.push({ id: change.doc.id, ...change.doc.data() });
              }
            }
          }

          if (!this._changesAffectView(changed, removed)) return;

          // Snapshot is pre-sorted by ticketNumber desc (orderBy in onTicketsChanged)
          this._tickets = tickets;
          this._applyFilters();
          this._renderList();
          this._updateCounts();
        };

        this._unsubscribe = this.ticketService.onTicketsChanged((snapshot) => {
          pendingSnapshot = snapshot;
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(flush, 16);
        });

        // Wrap the plain unsubscribe to also cancel any pending timer
        const origUnsub = this._unsubscribe;
        this._unsubscribe = () => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          origUnsub();
        };
      }
    } catch (_e) {
      // Real-time not available; fall back to manual refresh
    }
  }

  // -----------------------------------------------------------------------
  // Theme
  // -----------------------------------------------------------------------

  _rootClass() {
    const dark = this._isDark();
    return 'tk-root' + (dark ? ' tk-theme-dark' : '');
  }

  _isDark() {
    if (this.theme === 'dark') return true;
    if (this.theme === 'light') return false;
    // auto
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  _applyTheme() {
    if (!this._root) return;
    this._root.className = this._rootClass();
  }

  /**
   * Programmatically change the panel's theme.
   * @param {'light'|'dark'|'auto'} theme
   */
  setTheme(theme) {
    this.theme = theme;
    this._applyTheme();
  }

  // -----------------------------------------------------------------------
  // Server timestamp detection
  // -----------------------------------------------------------------------

  _detectServerTimestamp() {
    // Try firebase global (web SDK v8 / compat)
    if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue) {
      return () => firebase.firestore.FieldValue.serverTimestamp();
    }
    // Fallback: use client date (not ideal but functional)
    return () => new Date();
  }

  _detectArrayUnion() {
    if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue) {
      return (...elements) => firebase.firestore.FieldValue.arrayUnion(...elements);
    }
    return null;
  }

  _detectArrayRemove() {
    if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue) {
      return (...elements) => firebase.firestore.FieldValue.arrayRemove(...elements);
    }
    return null;
  }
}
