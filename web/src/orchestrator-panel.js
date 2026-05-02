// OrchestratorPanel — web-based view of the orchestrator state
// Reads ticket status from Firestore to show active agents, waiting tickets,
// and the open queue. Updates in real-time via Firestore listeners.

import { showConfirmModal } from './confirm-modal.js';

/**
 * Create a DOM element with attributes and children.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {...(Node|string|null)} children
 */
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

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function getElapsedSince(ts) {
  if (!ts) return null;
  let date;
  if (ts && typeof ts.toDate === 'function') {
    date = ts.toDate();
  } else if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === 'string') {
    date = new Date(ts);
  } else {
    return null;
  }
  const ms = Date.now() - date.getTime();
  if (ms < 0) return null;
  return formatElapsed(ms);
}

function formatDate(val) {
  if (!val) return '';
  const opts = {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    timeZoneName: 'short',
  };
  if (val && typeof val.toDate === 'function') return val.toDate().toLocaleString('en-US', opts);
  const d = typeof val === 'string' ? new Date(val) : val;
  return isNaN(d) ? String(val) : d.toLocaleString('en-US', opts);
}

function statusLabel(status) {
  const labels = {
    open: 'Open',
    in_progress: 'In Progress',
    in_maintenance: 'In Maintenance',
    waiting_for_user: 'Waiting for User',
    blocked: 'Blocked',
    done: 'Done',
    verified: 'Verified',
  };
  return labels[status] || status;
}

// The orchestrator writes a lastHeartbeat timestamp every 15 s.
// If the heartbeat is older than this threshold we consider the orchestrator offline.
const HEARTBEAT_STALE_MS = 90_000; // 90 seconds (1.5× the 60 s write interval)

/**
 * OrchestratorPanel — displays agent status in the web UI.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {Object} opts.db - Firestore instance
 * @param {string[]} opts.projectIds - projects to monitor
 * @param {Function} [opts.onTicketClick] - called with (ticket) when a ticket row is clicked
 * @param {Function} [opts.onDelete] - optional async (projectId, docId) => void called when admin deletes a ticket
 */
export class OrchestratorPanel {
  constructor({ container, db, projectIds, onTicketClick, onDelete }) {
    this.container = container;
    this.db = db;
    this.projectIds = projectIds || [];
    this._onTicketClickCallback = onTicketClick || null;
    this.onDelete = onDelete || null;

    this._mounted = false;
    this._root = null;
    this._unsubscribers = [];
    this._ticketsByProject = {}; // projectId -> tickets[]
    this._projectOnline = {}; // projectId -> boolean (online state per project)
    this._allTickets = [];
    this._elapsedTimer = null;
    this._activeSection = null; // DOM ref
    this._waitingSection = null;
    this._queueSection = null;
    this._maintenanceSection = null; // DOM ref for maintenance worker
    this._statusDot = null;
    this._statusText = null;
    this._lastUpdate = null;

    // Loading state — true until the first Firestore snapshot is received.
    // While loading, skeleton placeholder rows are shown in each section.
    this._loading = true;

    // Pool size state
    this._maxWorkers = null; // null = unknown
    this._poolSizeEl = null;
    this._configUnsub = null;

    // Non-sonnet mode (sonnet paused) state
    this._sonnetPaused = false;
    this._sonnetPausedBtn = null; // DOM ref for the toggle button

    // Orchestrator heartbeat state
    // lastHeartbeat is written by the orchestrator every 15 s.
    // If null/missing or older than HEARTBEAT_STALE_MS, the orchestrator is offline.
    this._lastHeartbeat = undefined; // undefined = not yet received; null = explicitly offline; string = ISO timestamp
    this._heartbeatCheckTimer = null;
    this._orchestratorOnline = null; // null = unknown, true = online, false = offline

    // Maintenance worker state
    this._maintenanceStatus = null;
    this._maintenanceUnsub = null;
    this._maintenanceLogsExpanded = false;

    // Detail view state — restore from localStorage
    this._selectedTicketId = this._loadSelectedTicketId(); // composite key: `${projectId}/${ticketId}`
    this._detailPanel = null;

    // Stable ordering for the active list: maps ticketKey -> insertion sequence number.
    // A ticket keeps its position in the active list as long as it stays active,
    // even when updatedAt changes on heartbeat/progress-note updates.
    this._activeOrder = new Map(); // ticketKey -> seqNum
    this._activeOrderSeq = 0;

    // Master worker chat state
    this._masterWorkerExpanded = this._loadMasterWorkerExpanded();
    this._masterWorkerStatus = null; // Firestore doc data: { status, messages, pausedWorkers }
    this._masterWorkerUnsub = null;
    this._masterWorkerSection = null; // DOM ref
    this._masterWorkerInput = null; // DOM ref for textarea
    this._masterWorkerMessages = null; // DOM ref for message list
    this._masterWorkerSending = false;

    // Section collapse state — each section (active/waiting/queue) can be collapsed
    // Default: active expanded, waiting expanded, queue collapsed when empty
    this._sectionCollapsed = this._loadSectionCollapsed();
  }

  // ── localStorage helpers ──────────────────────────────────────────

  _loadSelectedTicketId() {
    try {
      return localStorage.getItem('docket_orch_selected_ticket') || null;
    } catch (_e) {
      return null;
    }
  }

  _saveSelectedTicketId(key) {
    try {
      if (key) {
        localStorage.setItem('docket_orch_selected_ticket', key);
      } else {
        localStorage.removeItem('docket_orch_selected_ticket');
      }
    } catch (_e) {
      // localStorage not available — ignore
    }
  }

  _loadMasterWorkerExpanded() {
    try {
      return localStorage.getItem('docket_master_worker_expanded') === 'true';
    } catch (_e) {
      return false;
    }
  }

  _saveMasterWorkerExpanded(val) {
    try {
      localStorage.setItem('docket_master_worker_expanded', val ? 'true' : 'false');
    } catch (_e) {}
  }

  _loadSectionCollapsed() {
    try {
      const raw = localStorage.getItem('docket_orch_section_collapsed');
      return raw ? JSON.parse(raw) : {};
    } catch (_e) {
      return {};
    }
  }

  _saveSectionCollapsed() {
    try {
      localStorage.setItem('docket_orch_section_collapsed', JSON.stringify(this._sectionCollapsed));
    } catch (_e) {}
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;

    this._root = el('div', { className: 'orch-panel' });
    this.container.appendChild(this._root);

    this._buildUI();
    this._startListeners();
    this._startConfigListener();
    this._startMaintenanceListener();
    this._startMasterWorkerListener();
    this._startHeartbeatCheck();

    // Refresh elapsed timers every 10s
    this._elapsedTimer = setInterval(() => {
      if (this._mounted) {
        this._renderSections();
        this._renderMaintenanceSection();
      }
    }, 10000);
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;

    this._unsubscribers.forEach(u => u());
    this._unsubscribers = [];

    if (this._configUnsub) {
      this._configUnsub();
      this._configUnsub = null;
    }

    if (this._maintenanceUnsub) {
      this._maintenanceUnsub();
      this._maintenanceUnsub = null;
    }

    if (this._masterWorkerUnsub) {
      this._masterWorkerUnsub();
      this._masterWorkerUnsub = null;
    }

    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }

    this._stopHeartbeatCheck();

    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
  }

  updateProjects(projectIds) {
    this.projectIds = projectIds || [];
    // Remove stale projects
    for (const pid of Object.keys(this._ticketsByProject)) {
      if (!this.projectIds.includes(pid)) {
        delete this._ticketsByProject[pid];
        delete this._projectOnline[pid];
      }
    }
    this._stopListeners();
    this._startListeners();
  }

  // ── UI Construction ─────────────────────────────────────────────

  _buildUI() {
    // Pool size controls
    const poolDecBtn = el('button', {
      className: 'orch-pool-btn',
      title: 'Decrease worker pool size',
      onClick: () => this._adjustPoolSize(-1),
    }, '−');

    this._poolSizeEl = el('span', { className: 'orch-pool-size' }, '…');

    const poolIncBtn = el('button', {
      className: 'orch-pool-btn',
      title: 'Increase worker pool size',
      onClick: () => this._adjustPoolSize(+1),
    }, '+');

    const poolControls = el('div', { className: 'orch-pool-controls' },
      el('span', { className: 'orch-pool-label' }, 'pool:'),
      poolDecBtn,
      this._poolSizeEl,
      poolIncBtn,
    );

    // Kill server button
    const killBtn = el('button', {
      className: 'orch-kill-btn',
      title: 'Kill the orchestrator server',
      onClick: () => this._killServer(),
    }, '⏹ Kill');

    // Sonnet paused toggle button
    this._sonnetPausedBtn = el('button', {
      className: 'orch-sonnet-pause-btn',
      title: 'Pause Sonnet and enable non-sonnet mode: workers start with Haiku, upgrade to Opus for complex tasks',
      onClick: () => this._toggleSonnetPaused(),
    }, '☀ Sonnet');
    this._renderSonnetPausedBtn();

    // Header
    const header = el('div', { className: 'orch-header' },
      el('div', { className: 'orch-header-left' },
        el('span', { className: 'orch-title' }, 'Workers'),
        el('div', { className: 'orch-status-indicator' },
          (this._statusDot = el('span', { className: 'orch-status-dot orch-status-unknown' })),
          (this._statusText = el('span', { className: 'orch-status-text' }, 'Connecting…')),
        ),
      ),
      el('div', { className: 'orch-header-right' },
        poolControls,
        this._sonnetPausedBtn,
        killBtn,
      ),
    );
    this._root.appendChild(header);

    // Body
    const body = el('div', { className: 'orch-body' });
    this._root.appendChild(body);

    // Master Worker chat section (shown at the top)
    this._masterWorkerSection = el('div', { className: 'orch-section orch-master-worker-section' });
    body.appendChild(this._masterWorkerSection);
    this._renderMasterWorkerSection();

    // Active Workers section
    this._activeSection = el('div', { className: 'orch-section' });
    body.appendChild(this._activeSection);

    // Waiting for User section
    this._waitingSection = el('div', { className: 'orch-section' });
    body.appendChild(this._waitingSection);

    // Queue section
    this._queueSection = el('div', { className: 'orch-section' });
    body.appendChild(this._queueSection);

    // Maintenance Worker section (shown at the bottom)
    this._maintenanceSection = el('div', { className: 'orch-section orch-maintenance-section orch-maintenance-hidden' });
    body.appendChild(this._maintenanceSection);

    // Detail panel (hidden by default)
    this._detailPanel = el('div', { className: 'orch-detail-panel orch-detail-hidden' });
    this._root.appendChild(this._detailPanel);

    // Initial render
    this._renderSections();
  }

  // ── Data ────────────────────────────────────────────────────────

  _startListeners() {
    for (const projectId of this.projectIds) {
      if (!this._ticketsByProject[projectId]) {
        this._ticketsByProject[projectId] = [];
      }

      const ticketsRef = this.db
        .collection('projects')
        .doc(projectId)
        .collection('tickets');

      // Listen to all non-verified tickets so we can show the full picture.
      // No orderBy — adding orderBy on a different field than the where clause
      // requires a composite Firestore index. We sort client-side in _merge instead.
      const unsub = ticketsRef
        .where('status', 'in', ['open', 'in_progress', 'in_maintenance', 'waiting_for_user', 'blocked'])
        .onSnapshot(
          (snapshot) => {
            this._ticketsByProject[projectId] = snapshot.docs.map(doc => ({
              id: doc.id,
              projectId,
              ...doc.data(),
            }));
            this._projectOnline[projectId] = true;
            // Clear loading state on first successful snapshot from any project
            this._loading = false;
            this._merge();
            this._updateStatus();
          },
          (_err) => {
            // Firestore error — mark this project offline
            this._ticketsByProject[projectId] = [];
            this._projectOnline[projectId] = false;
            // Also clear loading on error so we don't show skeletons forever
            this._loading = false;
            this._merge();
            this._updateStatus();
          }
        );

      this._unsubscribers.push(unsub);
    }
  }

  _stopListeners() {
    this._unsubscribers.forEach(u => u());
    this._unsubscribers = [];
  }

  // ── Pool size config ─────────────────────────────────────────────

  _startConfigListener() {
    const configRef = this.db.collection('orchestrator').doc('config');
    this._configUnsub = configRef.onSnapshot(
      (snap) => {
        const data = snap.exists ? snap.data() : {};
        this._maxWorkers = typeof data.maxWorkers === 'number' ? data.maxWorkers : null;
        this._renderPoolSize();
        // Track the orchestrator heartbeat (written every 15 s while running)
        this._lastHeartbeat = data.lastHeartbeat !== undefined ? data.lastHeartbeat : null;
        this._updateOrchestratorOnline();
        this._updateStatus();
        // Track non-sonnet mode (sonnet paused)
        this._sonnetPaused = data.sonnetPaused === true;
        this._renderSonnetPausedBtn();
      },
      () => {
        // Firestore error — leave pool size as unknown
        this._maxWorkers = null;
        this._renderPoolSize();
      }
    );
  }

  /**
   * Recompute _orchestratorOnline based on the most recent heartbeat timestamp.
   * - undefined (not yet received): null (unknown)
   * - null or missing: false (orchestrator explicitly offline or never started)
   * - ISO timestamp within HEARTBEAT_STALE_MS: true (online)
   * - ISO timestamp older than HEARTBEAT_STALE_MS: false (stale — orchestrator crashed/stopped)
   */
  _updateOrchestratorOnline() {
    if (this._lastHeartbeat === undefined) {
      // Haven't received config snapshot yet
      this._orchestratorOnline = null;
      return;
    }
    if (!this._lastHeartbeat) {
      // Explicitly set to null by orchestrator on clean shutdown, or never started
      this._orchestratorOnline = false;
      return;
    }
    const age = Date.now() - new Date(this._lastHeartbeat).getTime();
    this._orchestratorOnline = age < HEARTBEAT_STALE_MS;
  }

  _startHeartbeatCheck() {
    // Re-evaluate staleness periodically so the UI updates even when there
    // are no new Firestore snapshots coming in (e.g. after a crash).
    if (this._heartbeatCheckTimer) return;
    this._heartbeatCheckTimer = setInterval(() => {
      if (!this._mounted) return;
      this._updateOrchestratorOnline();
      this._updateStatus();
    }, 10_000); // check every 10 s
  }

  _stopHeartbeatCheck() {
    if (this._heartbeatCheckTimer) {
      clearInterval(this._heartbeatCheckTimer);
      this._heartbeatCheckTimer = null;
    }
  }

  _renderPoolSize() {
    if (!this._poolSizeEl) return;
    if (this._maxWorkers === null) {
      this._poolSizeEl.textContent = '…';
    } else {
      this._poolSizeEl.textContent = String(this._maxWorkers);
    }
  }

  _renderMaintenanceSection() {
    if (!this._maintenanceSection) return;
    const maint = this._maintenanceStatus;

    const isRunning = maint && maint.status === 'running';
    const hasResult = maint && maint.status === 'idle' && maint.completedAt;

    // Always visible
    this._maintenanceSection.classList.remove('orch-maintenance-hidden');
    this._maintenanceSection.innerHTML = '';

    // Section header
    let badge;
    if (isRunning) {
      badge = el('span', { className: 'orch-maintenance-badge orch-maintenance-badge-running' }, 'running');
    } else if (hasResult) {
      badge = el('span', { className: 'orch-maintenance-badge orch-maintenance-badge-done' }, 'done');
    } else {
      badge = el('span', { className: 'orch-maintenance-badge orch-maintenance-badge-idle' }, 'idle');
    }

    const runBtnAttrs = {
      className: 'orch-maintenance-run-btn' + (isRunning ? ' orch-maintenance-run-btn-disabled' : ''),
      title: isRunning ? 'Maintenance is already running' : 'Run maintenance now',
      onClick: () => { if (!isRunning) this._triggerMaintenance(); },
    };
    if (isRunning) runBtnAttrs.disabled = 'disabled';
    const runBtn = el('button', runBtnAttrs, 'Run Now');

    const header = el('div', { className: 'orch-section-header' },
      el('span', { className: 'orch-section-title orch-maintenance-title' }, 'Maintenance Worker'),
      el('div', { className: 'orch-maintenance-header-right' },
        badge,
        runBtn,
      ),
    );
    this._maintenanceSection.appendChild(header);

    // Content row
    const row = el('div', { className: 'orch-maintenance-row' });

    if (isRunning) {
      if (maint.phase) {
        row.appendChild(
          el('div', { className: 'orch-maintenance-phase' }, maint.phase)
        );
      }
      if (maint.projects && maint.projects.length) {
        row.appendChild(
          el('div', { className: 'orch-maintenance-meta' },
            el('span', { className: 'orch-maintenance-meta-label' }, 'Projects: '),
            maint.projects.join(', '),
          )
        );
      }
      const elapsed = maint.startedAt ? getElapsedSince(maint.startedAt) : null;
      if (elapsed) {
        row.appendChild(
          el('div', { className: 'orch-maintenance-meta' },
            el('span', { className: 'orch-maintenance-meta-label' }, 'Elapsed: '),
            elapsed,
          )
        );
      }
      if (maint.dryRun) {
        row.appendChild(
          el('div', { className: 'orch-maintenance-meta' },
            el('span', { className: 'orch-maintenance-dry-run' }, 'dry-run mode'),
          )
        );
      }
    } else if (hasResult) {
      const r = maint.result || {};
      row.appendChild(
        el('div', { className: 'orch-maintenance-result' },
          el('span', { className: 'orch-maintenance-result-item' },
            el('span', { className: 'orch-maintenance-meta-label' }, 'Fixed: '),
            String(r.fixed ?? 0),
          ),
          el('span', { className: 'orch-maintenance-result-sep' }, '·'),
          el('span', { className: 'orch-maintenance-result-item' },
            el('span', { className: 'orch-maintenance-meta-label' }, 'Skipped: '),
            String(r.skipped ?? 0),
          ),
          el('span', { className: 'orch-maintenance-result-sep' }, '·'),
          el('span', { className: 'orch-maintenance-result-item' + (r.failed > 0 ? ' orch-maintenance-result-failed' : '') },
            el('span', { className: 'orch-maintenance-meta-label' }, 'Failed: '),
            String(r.failed ?? 0),
          ),
        )
      );
      const completedAgo = getElapsedSince(maint.completedAt);
      if (completedAgo) {
        row.appendChild(
          el('div', { className: 'orch-maintenance-meta' },
            el('span', { className: 'orch-maintenance-meta-label' }, 'Last run: '),
            `${completedAgo} ago`,
          )
        );
      }
    } else {
      row.appendChild(
        el('div', { className: 'orch-maintenance-meta orch-maintenance-never' }, 'No runs yet')
      );
    }

    this._maintenanceSection.appendChild(row);

    // Expandable log section — available after any completed run
    const logs = maint && maint.lastRunLogs;
    if (logs && logs.length > 0) {
      const expanded = this._maintenanceLogsExpanded;
      const toggleBtn = el('button', {
        className: 'orch-maintenance-logs-toggle',
        onClick: () => {
          this._maintenanceLogsExpanded = !this._maintenanceLogsExpanded;
          this._renderMaintenanceSection();
        },
      }, expanded ? '▾ Hide logs' : `▸ Show logs (${logs.length})`);
      this._maintenanceSection.appendChild(toggleBtn);

      if (expanded) {
        const logList = el('div', { className: 'orch-maintenance-log-list' },
          ...logs.map(line => {
            // Highlight error/warning lines
            const cls = /fail|error|fatal/i.test(line)
              ? 'orch-maintenance-log-line orch-maintenance-log-error'
              : /warn/i.test(line)
                ? 'orch-maintenance-log-line orch-maintenance-log-warn'
                : 'orch-maintenance-log-line';
            return el('div', { className: cls }, line);
          })
        );
        this._maintenanceSection.appendChild(logList);
      }
    }
  }

  _startMasterWorkerListener() {
    const masterWorkerRef = this.db.collection('orchestrator').doc('masterWorker');
    this._masterWorkerUnsub = masterWorkerRef.onSnapshot(
      (snap) => {
        this._masterWorkerStatus = snap.exists ? snap.data() : null;
        this._renderMasterWorkerSection();
      },
      () => {
        // Ignore errors — master worker state is optional
        this._masterWorkerStatus = null;
        this._renderMasterWorkerSection();
      }
    );
  }

  _renderMasterWorkerSection() {
    if (!this._masterWorkerSection) return;
    const mw = this._masterWorkerStatus;
    const expanded = this._masterWorkerExpanded;
    const isResponding = mw && mw.status === 'responding';
    const isPaused = mw && mw.status === 'paused';

    this._masterWorkerSection.innerHTML = '';

    // ── Header ──
    const statusBadge = isResponding
      ? el('span', { className: 'orch-mw-badge orch-mw-badge-responding' }, 'responding')
      : isPaused
        ? el('span', { className: 'orch-mw-badge orch-mw-badge-paused' }, 'paused')
        : el('span', { className: 'orch-mw-badge orch-mw-badge-idle' }, 'idle');

    const toggleBtn = el('button', {
      className: 'orch-mw-toggle',
      title: expanded ? 'Collapse master worker chat' : 'Expand master worker chat',
      onClick: () => {
        this._masterWorkerExpanded = !this._masterWorkerExpanded;
        this._saveMasterWorkerExpanded(this._masterWorkerExpanded);
        this._renderMasterWorkerSection();
      },
    }, expanded ? '▾' : '▸');

    const header = el('div', { className: 'orch-section-header orch-mw-header' },
      el('div', { className: 'orch-mw-header-left' },
        toggleBtn,
        el('span', { className: 'orch-section-title orch-mw-title' }, 'Master Worker'),
        statusBadge,
      ),
    );
    this._masterWorkerSection.appendChild(header);

    if (!expanded) return;

    // ── Paused workers notice ──
    if (isResponding && mw.pausedWorkerCount > 0) {
      const unpauseBtn = el('button', {
        className: 'orch-mw-unpause-btn',
        title: 'Force-unpause all workers by resetting master worker to idle',
        onClick: () => this._unpauseMasterWorker(),
      }, '▶ Unpause all');

      this._masterWorkerSection.appendChild(
        el('div', { className: 'orch-mw-pause-notice' },
          el('span', {}, `⏸ ${mw.pausedWorkerCount} worker${mw.pausedWorkerCount !== 1 ? 's' : ''} paused`),
          unpauseBtn,
        )
      );
    }

    // ── Message list ──
    const messages = (mw && mw.messages) ? mw.messages : [];
    const messageList = el('div', { className: 'orch-mw-messages' });
    this._masterWorkerMessages = messageList;

    if (messages.length === 0) {
      messageList.appendChild(
        el('div', { className: 'orch-mw-empty' },
          'Send a message to start a conversation with the master worker.'
        )
      );
    } else {
      for (const msg of messages) {
        const isUser = msg.role === 'user';
        const msgEl = el('div', { className: `orch-mw-message orch-mw-message-${isUser ? 'user' : 'assistant'}` },
          el('div', { className: 'orch-mw-message-role' }, isUser ? 'You' : 'Master Worker'),
          el('div', { className: 'orch-mw-message-text' }, msg.text || ''),
        );
        if (msg.at) {
          const ts = new Date(typeof msg.at.toDate === 'function' ? msg.at.toDate() : msg.at)
            .toISOString().slice(11, 19);
          msgEl.appendChild(el('div', { className: 'orch-mw-message-ts' }, ts));
        }
        // Render console link for assistant messages that have one
        if (!isUser && msg.consoleLink) {
          const linkEl = el('div', { className: 'orch-mw-console-link' });
          const anchor = document.createElement('a');
          anchor.href = msg.consoleLink;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          anchor.className = 'orch-mw-console-link-anchor';
          anchor.textContent = '↗ Open in Claude console';
          linkEl.appendChild(anchor);
          msgEl.appendChild(linkEl);
        }
        messageList.appendChild(msgEl);
      }
    }

    // Show typing indicator when responding
    if (isResponding) {
      messageList.appendChild(
        el('div', { className: 'orch-mw-message orch-mw-message-assistant orch-mw-typing' },
          el('div', { className: 'orch-mw-message-role' }, 'Master Worker'),
          el('div', { className: 'orch-mw-typing-dots' },
            el('span'), el('span'), el('span')
          ),
        )
      );
    }

    this._masterWorkerSection.appendChild(messageList);

    // Scroll to bottom
    requestAnimationFrame(() => {
      if (messageList) messageList.scrollTop = messageList.scrollHeight;
    });

    // ── Input area ──
    if (!isResponding) {
      const inputRow = el('div', { className: 'orch-mw-input-row' });

      this._masterWorkerInput = el('textarea', {
        className: 'orch-mw-input',
        placeholder: 'Ask the master worker…',
        rows: '2',
      });

      // Submit on Enter (Shift+Enter for newline)
      this._masterWorkerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._sendMasterWorkerMessage();
        }
      });

      const sendBtn = el('button', {
        className: 'orch-mw-send-btn',
        title: 'Send message',
        onClick: () => this._sendMasterWorkerMessage(),
      }, 'Send');

      inputRow.appendChild(this._masterWorkerInput);
      inputRow.appendChild(sendBtn);
      this._masterWorkerSection.appendChild(inputRow);
    }
  }

  async _sendMasterWorkerMessage() {
    if (this._masterWorkerSending) return;
    const input = this._masterWorkerInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    this._masterWorkerSending = true;
    input.disabled = true;

    try {
      const now = new Date().toISOString();
      const existing = this._masterWorkerStatus;
      const prevMessages = (existing && existing.messages) ? existing.messages : [];

      // Append user message and set status to 'pending' so the orchestrator picks it up
      await this.db.collection('orchestrator').doc('masterWorker').set({
        status: 'pending',
        messages: [
          ...prevMessages,
          { role: 'user', text, at: now },
        ],
        updatedAt: now,
      }, { merge: false });

      input.value = '';
    } catch (err) {
      alert('Failed to send message: ' + err.message);
    } finally {
      this._masterWorkerSending = false;
      if (input) input.disabled = false;
    }
  }

  async _unpauseMasterWorker() {
    const mw = this._masterWorkerStatus;
    if (!mw || mw.status !== 'responding') return;

    const confirmed = await showConfirmModal({
      title: 'Force-unpause all workers?',
      message:
        'This will reset the master worker to idle so workers can resume. ' +
        'The current master worker response will be cancelled.',
      confirm: 'Unpause',
      danger: true,
    });
    if (!confirmed) return;

    const now = new Date().toISOString();
    try {
      await this.db.collection('orchestrator').doc('masterWorker').set({
        status: 'idle',
        pausedWorkerCount: 0,
        updatedAt: now,
      }, { merge: true });
    } catch (err) {
      alert('Failed to unpause workers: ' + err.message);
    }
  }

  _startMaintenanceListener() {
    const maintenanceRef = this.db.collection('orchestrator').doc('maintenance');
    this._maintenanceUnsub = maintenanceRef.onSnapshot(
      (snap) => {
        this._maintenanceStatus = snap.exists ? snap.data() : null;
        this._renderMaintenanceSection();
      },
      () => {
        // Ignore errors — maintenance status is optional
        this._maintenanceStatus = null;
        this._renderMaintenanceSection();
      }
    );
  }

  async _markTicketDone(ticket, note = 'Manually resolved via admin panel') {
    const now = new Date().toISOString();
    const history = [
      ...(ticket.statusHistory || []),
      { from: ticket.status, to: 'done', at: now, note },
    ];
    await this.db
      .collection('projects')
      .doc(ticket.projectId)
      .collection('tickets')
      .doc(ticket.id)
      .update({ status: 'done', statusHistory: history, updatedAt: now });
  }

  async _resolveAllBlocked(blockedTickets) {
    const count = blockedTickets.length;
    const confirmed = await showConfirmModal({
      title: `Mark ${count} blocked ticket${count !== 1 ? 's' : ''} as Done?`,
      message: blockedTickets.map(t => `${t.ticketId}: ${t.title || '(no title)'}`).join('\n'),
      confirm: 'Mark Done',
      danger: true,
    });
    if (!confirmed) return;
    const errors = [];
    for (const ticket of blockedTickets) {
      try {
        await this._markTicketDone(ticket, 'Bulk-resolved: manually marked done via admin panel');
      } catch (err) {
        errors.push(`${ticket.ticketId}: ${err.message}`);
      }
    }
    if (errors.length) {
      alert('Some tickets failed to update:\n' + errors.join('\n'));
    }
  }

  _triggerMaintenance() {
    // Write a manualTrigger timestamp to the config doc. The orchestrator
    // watches this field and starts a maintenance pass when it changes.
    this.db.collection('orchestrator').doc('config').set(
      { manualTrigger: new Date().toISOString() },
      { merge: true }
    ).catch(() => {
      // Best-effort — ignore write failures
    });
  }

  async _killServer() {
    const confirmed = await showConfirmModal({
      title: 'Kill the orchestrator server?',
      message:
        'This will stop all active workers and shut down the server. ' +
        'In-progress tickets will be reset to open.',
      confirm: 'Kill Server',
      danger: true,
    });
    if (!confirmed) return;

    // Write a killSignal timestamp to the config doc. The orchestrator
    // watches this field and calls process.exit(0) when it changes.
    this.db.collection('orchestrator').doc('config').set(
      { killSignal: new Date().toISOString() },
      { merge: true }
    ).catch(() => {
      // Best-effort — ignore write failures
    });
  }

  _adjustPoolSize(delta) {
    const current = this._maxWorkers;
    let next;
    if (current === null) {
      // Default to 4 if unknown
      next = delta > 0 ? 5 : 3;
    } else {
      next = Math.max(1, current + delta);
    }
    // Optimistic UI update
    this._maxWorkers = next;
    this._renderPoolSize();
    // Write to Firestore
    this.db.collection('orchestrator').doc('config').set(
      { maxWorkers: next },
      { merge: true }
    ).catch(() => {
      // Revert on failure
      this._maxWorkers = current;
      this._renderPoolSize();
    });
  }

  /**
   * Render the sonnet-paused toggle button to reflect current state.
   * Active (paused) = non-sonnet mode, workers use Haiku + Opus upgrade.
   * Inactive = normal Sonnet mode.
   */
  _renderSonnetPausedBtn() {
    if (!this._sonnetPausedBtn) return;
    if (this._sonnetPaused) {
      this._sonnetPausedBtn.textContent = '⏸ Non-Sonnet';
      this._sonnetPausedBtn.className = 'orch-sonnet-pause-btn orch-sonnet-pause-btn-active';
      this._sonnetPausedBtn.title = 'Non-sonnet mode active: workers use Haiku (Opus for complex tasks). Click to resume Sonnet.';
    } else {
      this._sonnetPausedBtn.textContent = '☀ Sonnet';
      this._sonnetPausedBtn.className = 'orch-sonnet-pause-btn';
      this._sonnetPausedBtn.title = 'Click to pause Sonnet and enable non-sonnet mode: workers start with Haiku, upgrade to Opus for complex tasks.';
    }
  }

  async _toggleSonnetPaused() {
    const next = !this._sonnetPaused;
    const label = next ? 'Pause Sonnet (enable non-sonnet mode)?' : 'Resume Sonnet?';
    const message = next
      ? 'Workers will start with Haiku and upgrade to Opus for complex tasks. Sonnet will not be used.'
      : 'Workers will resume using Sonnet as the primary model.';

    const confirmed = await showConfirmModal({
      title: label,
      message,
      confirm: next ? 'Pause Sonnet' : 'Resume Sonnet',
      danger: next,
    });
    if (!confirmed) return;

    // Optimistic update
    this._sonnetPaused = next;
    this._renderSonnetPausedBtn();

    this.db.collection('orchestrator').doc('config').set(
      { sonnetPaused: next },
      { merge: true }
    ).catch(() => {
      // Revert on failure
      this._sonnetPaused = !next;
      this._renderSonnetPausedBtn();
    });
  }

  _merge() {
    const all = [];
    for (const tickets of Object.values(this._ticketsByProject)) {
      all.push(...tickets);
    }
    // Sort by updatedAt descending so newest activity appears first.
    all.sort((a, b) => {
      const ta = a.updatedAt?.toDate?.() ?? (a.updatedAt ? new Date(a.updatedAt) : new Date(0));
      const tb = b.updatedAt?.toDate?.() ?? (b.updatedAt ? new Date(b.updatedAt) : new Date(0));
      return tb - ta;
    });
    this._allTickets = all;
    this._lastUpdate = Date.now();
    this._renderSections();

    // Refresh detail panel if the selected ticket was updated
    if (this._selectedTicketId) {
      const ticket = this._allTickets.find(t => this._ticketKey(t) === this._selectedTicketId);
      if (ticket) {
        this._renderDetailPanel(ticket);
      } else {
        // Ticket no longer visible (e.g. verified) — close the detail panel
        this._closeDetailPanel();
      }
    }
  }

  _ticketKey(ticket) {
    return `${ticket.projectId}/${ticket.id}`;
  }

  // ── Status indicator ────────────────────────────────────────────

  _updateStatus() {
    if (!this._statusDot || !this._statusText) return;

    // Determine overall online state from per-project states.
    // We are "online" if at least one project listener has connected successfully,
    // and "offline" only if every project listener has explicitly failed.
    // While still connecting (no state recorded yet) we show "Connecting…".
    const projectIds = this.projectIds;
    const onlineStates = projectIds.map(pid => this._projectOnline[pid]);
    const hasAnyOnline = onlineStates.some(s => s === true);
    const allFailed = onlineStates.length > 0 && onlineStates.every(s => s === false);

    const activeCount = this._allTickets.filter(
      t => t.status === 'in_progress' || t.status === 'blocked' || t.status === 'in_maintenance'
    ).length;

    if (allFailed) {
      // Restore dot, remove spinner if present
      this._statusDot.style.display = '';
      const indicatorFailed = this._statusDot.parentElement;
      if (indicatorFailed) {
        const sp = indicatorFailed.querySelector('.orch-status-spinner');
        if (sp) indicatorFailed.removeChild(sp);
      }
      this._statusDot.className = 'orch-status-dot orch-status-offline';
      this._statusDot.title = 'Worker orchestrator: offline';
      this._statusText.textContent = 'Offline';
      return;
    }

    if (!hasAnyOnline) {
      // Still waiting for at least one listener to resolve — show spinner
      this._statusDot.className = 'orch-status-dot orch-status-unknown';
      this._statusDot.title = 'Worker orchestrator: connecting';
      this._statusDot.style.display = 'none';
      // Replace dot with spinner if not already shown
      const indicator = this._statusDot.parentElement;
      if (indicator && !indicator.querySelector('.orch-status-spinner')) {
        const spinner = el('span', { className: 'orch-status-spinner', title: 'Worker orchestrator: connecting' });
        indicator.insertBefore(spinner, this._statusDot);
      }
      this._statusText.textContent = 'Connecting…';
      return;
    }

    // Once we have data, remove any spinner and restore the dot
    this._statusDot.style.display = '';
    const indicator2 = this._statusDot.parentElement;
    if (indicator2) {
      const spinner = indicator2.querySelector('.orch-status-spinner');
      if (spinner) indicator2.removeChild(spinner);
    }

    // If the orchestrator heartbeat is known to be stale or explicitly offline,
    // show the server as offline even if Firestore still reports in_progress tickets
    // (those are cached/stale values from before the orchestrator stopped).
    if (this._orchestratorOnline === false) {
      this._statusDot.className = 'orch-status-dot orch-status-offline';
      this._statusDot.title = 'Worker orchestrator: offline';
      this._statusText.textContent = 'Server offline';
      return;
    }

    // orchestratorOnline === null means we haven't received the config snapshot yet;
    // treat it as "connecting" if we also haven't confirmed any active agents.
    if (this._orchestratorOnline === null && activeCount === 0) {
      this._statusDot.className = 'orch-status-dot orch-status-unknown';
      this._statusDot.title = 'Worker orchestrator: connecting';
      this._statusText.textContent = 'Connecting…';
      return;
    }

    if (activeCount > 0) {
      this._statusDot.className = 'orch-status-dot orch-status-running';
      this._statusDot.title = `Worker orchestrator: ${activeCount} agent${activeCount !== 1 ? 's' : ''} running`;
      this._statusText.textContent = `Running · ${activeCount} agent${activeCount !== 1 ? 's' : ''}`;
    } else {
      this._statusDot.className = 'orch-status-dot orch-status-idle';
      this._statusDot.title = 'Worker orchestrator: idle';
      this._statusText.textContent = 'Idle';
    }
  }

  // ── Rendering ────────────────────────────────────────────────────

  _renderSections() {
    if (!this._mounted || !this._activeSection) return;

    const active = this._allTickets.filter(
      t => t.status === 'in_progress' || t.status === 'blocked' || t.status === 'in_maintenance'
    );
    const waiting = this._allTickets.filter(t => t.status === 'waiting_for_user');
    const queue = this._allTickets.filter(t => t.status === 'open');

    // Maintain stable ordering for the active list: assign a sequence number the
    // first time each ticket appears as active, then sort by that number so the
    // list only changes when tickets enter or leave the active set — not on every
    // heartbeat/progress-note update that changes updatedAt.
    const activeKeys = new Set(active.map(t => this._ticketKey(t)));
    // Remove departed tickets from the order map
    for (const key of this._activeOrder.keys()) {
      if (!activeKeys.has(key)) this._activeOrder.delete(key);
    }
    // Assign sequence numbers to newly-arriving tickets
    for (const ticket of active) {
      const key = this._ticketKey(ticket);
      if (!this._activeOrder.has(key)) {
        this._activeOrder.set(key, this._activeOrderSeq++);
      }
    }
    // Sort active list by insertion order (stable)
    active.sort((a, b) => this._activeOrder.get(this._ticketKey(a)) - this._activeOrder.get(this._ticketKey(b)));

    const blockedTickets = active.filter(t => t.status === 'blocked');
    const resolveBtn = blockedTickets.length > 0
      ? el('button', {
          className: 'orch-resolve-blocked-btn',
          title: `Mark all ${blockedTickets.length} blocked ticket(s) as Done`,
          onClick: (e) => { e.stopPropagation(); this._resolveAllBlocked(blockedTickets); },
        }, `Resolve blocked (${blockedTickets.length})`)
      : null;

    // When the orchestrator is offline, in_progress/in_maintenance tickets are
    // stale cached data — the server is not actually running them. Show them
    // with a visual indicator so users understand these are not live agents.
    const serverOffline = this._orchestratorOnline === false;

    // While loading, show skeleton rows instead of "None" placeholders
    const loading = this._loading;
    this._renderSection(this._activeSection, 'Active', active, 'active', resolveBtn, serverOffline, loading);
    this._renderSection(this._waitingSection, 'Waiting for User', waiting, 'waiting', null, false, loading);
    this._renderSection(this._queueSection, 'Queue', queue, 'queue', null, false, loading);
  }

  _renderSection(sectionEl, title, tickets, type, headerAction = null, serverOffline = false, loading = false) {
    if (!sectionEl) return;
    sectionEl.innerHTML = '';

    const isCollapsed = !!this._sectionCollapsed[type];

    const toggleBtn = el('button', {
      className: 'orch-section-toggle',
      title: isCollapsed ? `Expand ${title}` : `Collapse ${title}`,
      onClick: (e) => {
        e.stopPropagation();
        this._sectionCollapsed[type] = !this._sectionCollapsed[type];
        this._saveSectionCollapsed();
        this._renderSections();
      },
    }, isCollapsed ? '▸' : '▾');

    // While loading, show "…" in the count badge instead of "0"
    const countText = loading ? '…' : String(tickets.length);
    const countAndAction = el('div', { className: 'orch-section-header-right' },
      el('span', { className: `orch-section-count orch-section-count-${type}` }, countText),
      headerAction,
    );
    const header = el('div', {
      className: 'orch-section-header orch-section-header-clickable',
      onClick: () => {
        this._sectionCollapsed[type] = !this._sectionCollapsed[type];
        this._saveSectionCollapsed();
        this._renderSections();
      },
    },
      el('div', { className: 'orch-section-header-left' },
        toggleBtn,
        el('span', { className: 'orch-section-title' }, title),
      ),
      countAndAction,
    );
    sectionEl.appendChild(header);

    if (isCollapsed) return;

    // While data is loading for the first time, show skeleton placeholder rows
    if (loading) {
      sectionEl.appendChild(this._renderSkeletonRows(type));
      return;
    }

    // When the server is offline and there are stale active tickets, show a
    // notice so users know these are not live — the server is not running them.
    if (serverOffline && tickets.length > 0) {
      sectionEl.appendChild(
        el('div', { className: 'orch-server-offline-notice' },
          'Server offline — these tickets are not actively running'
        )
      );
    }

    if (tickets.length === 0) {
      sectionEl.appendChild(
        el('div', { className: 'orch-empty' }, 'None')
      );
    } else {
      const list = el('div', { className: 'orch-ticket-list' });
      for (const ticket of tickets) {
        list.appendChild(this._renderTicketRow(ticket, type));
      }
      sectionEl.appendChild(list);
    }
  }

  /**
   * Render 3 skeleton placeholder rows while ticket data is loading.
   * Matches the visual structure of real ticket rows so the layout
   * doesn't shift when content arrives.
   * @param {string} type - 'active' | 'waiting' | 'queue'
   */
  _renderSkeletonRows(type) {
    const showDot = type === 'active' || type === 'waiting';
    const showPhase = type === 'active';
    const list = el('div', { className: 'orch-skeleton-list' });

    for (let i = 0; i < 3; i++) {
      const topLine = el('div', { className: 'orch-skeleton-top' });

      // Status dot placeholder
      if (showDot) {
        topLine.appendChild(el('span', { className: 'orch-skeleton-dot' }));
      }
      // ID chip
      topLine.appendChild(el('span', { className: 'orch-skeleton-block orch-skeleton-id' }));
      // Phase badge (active only)
      if (showPhase) {
        topLine.appendChild(el('span', { className: 'orch-skeleton-block orch-skeleton-phase' }));
      }
      // Elapsed (pushes to the right)
      if (type !== 'queue') {
        topLine.appendChild(el('span', { className: 'orch-skeleton-block orch-skeleton-elapsed' }));
      }

      const row = el('div', { className: 'orch-skeleton-row' },
        topLine,
        el('div', { className: 'orch-skeleton-block orch-skeleton-title' }),
      );
      list.appendChild(row);
    }

    return list;
  }

  _renderTicketRow(ticket, type) {
    const key = this._ticketKey(ticket);
    const isSelected = this._selectedTicketId === key;

    // Determine status dot class for active tickets
    let dotCls = null;
    if (type === 'active') {
      const masterIsResponding = this._masterWorkerStatus && this._masterWorkerStatus.status === 'responding';
      if (ticket.status === 'blocked') dotCls = 'orch-row-dot-blocked';
      else if (ticket.status === 'in_maintenance') dotCls = 'orch-row-dot-maintenance';
      else if (ticket.workerPhase === 'merging') dotCls = 'orch-row-dot-merging';
      else if (masterIsResponding) dotCls = 'orch-row-dot-paused';
      else dotCls = 'orch-row-dot-running';
    } else if (type === 'waiting') {
      dotCls = 'orch-row-dot-waiting';
    }

    const row = el('div', {
      className: `orch-ticket-row orch-ticket-${type}${isSelected ? ' orch-ticket-selected' : ''}`,
      onClick: () => this._onTicketRowClick(ticket),
    });

    // Top line: status dot + project + ticket ID + elapsed
    const topLine = el('div', { className: 'orch-ticket-top' });

    // Status dot (active and waiting tickets only) — inline with the top line
    if (dotCls) {
      topLine.appendChild(el('span', { className: `orch-row-dot ${dotCls}` }));
    }

    if (ticket.projectId) {
      topLine.appendChild(
        el('span', { className: 'orch-ticket-project' }, ticket.projectId)
      );
    }

    topLine.appendChild(
      el('span', { className: `orch-ticket-id orch-ticket-id-${type}` }, ticket.ticketId || '?')
    );

    if (type === 'active') {
      const elapsed = getElapsedSince(ticket.workerStartedAt) || getElapsedSince(ticket.createdAt);
      if (elapsed) {
        topLine.appendChild(
          el('span', { className: 'orch-ticket-elapsed' }, elapsed)
        );
      }

      // Phase indicator + status dot
      const masterIsResponding = this._masterWorkerStatus && this._masterWorkerStatus.status === 'responding';
      let phaseCls, phaseLabel;
      if (ticket.status === 'blocked') {
        phaseCls = 'blocked'; phaseLabel = 'blocked';
      } else if (ticket.status === 'in_maintenance') {
        phaseCls = 'maintenance'; phaseLabel = 'maintenance';
      } else if (ticket.workerPhase === 'merging') {
        phaseCls = 'merging'; phaseLabel = 'merging';
      } else if (masterIsResponding) {
        phaseCls = 'paused'; phaseLabel = 'paused';
      } else {
        phaseCls = 'running'; phaseLabel = 'running';
      }
      topLine.appendChild(
        el('span', { className: `orch-ticket-phase orch-ticket-phase-${phaseCls}` }, phaseLabel)
      );
    }

    if (type === 'waiting') {
      const elapsed = getElapsedSince(ticket.updatedAt);
      if (elapsed) {
        topLine.appendChild(
          el('span', { className: 'orch-ticket-elapsed' }, elapsed)
        );
      }
    }

    row.appendChild(topLine);

    // Title line
    if (ticket.title) {
      row.appendChild(
        el('div', { className: 'orch-ticket-title' }, ticket.title)
      );
    }

    // Pending question (for waiting tickets)
    if (type === 'waiting' && ticket.pendingQuestion) {
      row.appendChild(
        el('div', { className: 'orch-ticket-question' },
          el('span', { className: 'orch-ticket-question-label' }, 'Q: '),
          ticket.pendingQuestion,
        )
      );
    }

    return row;
  }

  // ── Detail Panel ─────────────────────────────────────────────────

  _onTicketRowClick(ticket) {
    const key = this._ticketKey(ticket);
    if (this._selectedTicketId === key) {
      // Toggle off
      this._closeDetailPanel();
    } else {
      this._selectedTicketId = key;
      this._saveSelectedTicketId(key);
      this._renderDetailPanel(ticket);
      this._renderSections(); // re-render rows to update selected state
    }
    // Notify external listener (e.g. to navigate to the ticket in the admin panel)
    if (this._onTicketClickCallback) {
      this._onTicketClickCallback(ticket);
    }
  }

  _closeDetailPanel() {
    this._selectedTicketId = null;
    this._saveSelectedTicketId(null);
    if (this._detailPanel) {
      this._detailPanel.innerHTML = '';
      this._detailPanel.classList.add('orch-detail-hidden');
    }
    this._renderSections(); // re-render to clear selected highlights
  }

  _renderDetailPanel(ticket) {
    if (!this._detailPanel) return;
    this._detailPanel.innerHTML = '';
    this._detailPanel.classList.remove('orch-detail-hidden');

    const type = ticket.status === 'in_progress' || ticket.status === 'blocked'
      ? 'active'
      : ticket.status === 'waiting_for_user'
        ? 'waiting'
        : 'queue';

    // Header
    const closeBtn = el('button', {
      className: 'orch-detail-close',
      onClick: () => this._closeDetailPanel(),
    }, '×');

    // Delete button (only shown when onDelete callback is provided)
    const headerButtons = el('div', { className: 'orch-detail-header-btns' }, closeBtn);

    // Mark Done button for blocked/in_maintenance tickets
    if (ticket.status === 'blocked' || ticket.status === 'in_maintenance') {
      const markDoneBtn = el('button', {
        className: 'orch-detail-mark-done',
        onClick: async (e) => {
          e.stopPropagation();
          try {
            await this._markTicketDone(ticket);
          } catch (err) {
            alert('Failed to mark ticket as done: ' + err.message);
          }
        },
      }, 'Mark Done');
      headerButtons.insertBefore(markDoneBtn, closeBtn);
    }

    if (this.onDelete) {
      const deleteBtn = el('button', {
        className: 'orch-detail-delete',
        onClick: async (e) => {
          e.stopPropagation();
          const label = ticket.ticketId || ticket.id;
          const confirmed = await showConfirmModal({
            title: `Delete ticket ${label}?`,
            message: `"${ticket.title}"\n\nThis action cannot be undone.`,
            confirm: 'Delete',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await this.onDelete(ticket.projectId, ticket.id);
            this._closeDetailPanel();
          } catch (err) {
            alert('Failed to delete ticket: ' + err.message);
          }
        },
      }, 'Delete');
      headerButtons.insertBefore(deleteBtn, closeBtn);
    }

    const titleRow = el('div', { className: 'orch-detail-title-row' },
      el('div', { className: 'orch-detail-ids' },
        ticket.projectId
          ? el('span', { className: 'orch-ticket-project' }, ticket.projectId)
          : null,
        el('span', { className: `orch-ticket-id orch-ticket-id-${type}` }, ticket.ticketId || '?'),
      ),
      headerButtons,
    );

    const statusRow = el('div', { className: 'orch-detail-status-row' },
      el('span', { className: `orch-detail-status orch-detail-status-${ticket.status}` },
        statusLabel(ticket.status)
      ),
      ticket.type
        ? el('span', { className: 'orch-detail-type' }, ticket.type)
        : null,
    );

    const headerEl = el('div', { className: 'orch-detail-header' },
      titleRow,
      statusRow,
    );
    this._detailPanel.appendChild(headerEl);

    // Title
    if (ticket.title) {
      this._detailPanel.appendChild(
        el('div', { className: 'orch-detail-ticket-title' }, ticket.title)
      );
    }

    // Feedback badge (DK-196) — read-only badge showing accept/reject decision
    if (ticket.feedback && ticket.feedback.action) {
      const fb = ticket.feedback;
      const isAccepted = fb.action === 'accepted';
      let badgeText = isAccepted ? '✓ Accepted' : '✕ Rejected';
      if (!isAccepted && fb.quickSelectReason) {
        // Map quick-select value to display label
        const QUICK_LABELS = {
          already_done: 'Already done',
          not_relevant: 'Not relevant',
          too_vague:    'Too vague',
          other:        'Other',
        };
        const reasonLabel = QUICK_LABELS[fb.quickSelectReason] || fb.quickSelectReason;
        badgeText = `✕ Rejected — ${reasonLabel}`;
      } else if (!isAccepted && fb.reason) {
        const snippet = fb.reason.length > 40 ? fb.reason.slice(0, 40) + '…' : fb.reason;
        badgeText = `✕ Rejected — ${snippet}`;
      }
      const badgeCls = isAccepted ? 'orch-feedback-badge orch-feedback-badge-accepted' : 'orch-feedback-badge orch-feedback-badge-rejected';
      this._detailPanel.appendChild(
        el('div', { className: badgeCls, title: fb.reason || fb.quickSelectReason || fb.action }, badgeText)
      );
    }

    const body = el('div', { className: 'orch-detail-body' });
    this._detailPanel.appendChild(body);

    // Elapsed time (for active/waiting)
    if (type === 'active' || type === 'waiting') {
      const elapsed = (type === 'active' ? getElapsedSince(ticket.workerStartedAt) : null)
        || getElapsedSince(ticket.updatedAt)
        || getElapsedSince(ticket.createdAt);
      if (elapsed) {
        body.appendChild(
          el('div', { className: 'orch-detail-meta' },
            el('span', { className: 'orch-detail-meta-label' }, 'Elapsed: '),
            elapsed,
          )
        );
      }
    }

    // Description
    if (ticket.description) {
      body.appendChild(
        el('div', { className: 'orch-detail-section' },
          el('div', { className: 'orch-detail-section-title' }, 'Description'),
          el('div', { className: 'orch-detail-description' }, ticket.description),
        )
      );
    }

    // Pending question (waiting for user)
    if (ticket.status === 'waiting_for_user' && ticket.pendingQuestion) {
      body.appendChild(
        el('div', { className: 'orch-detail-section orch-detail-question-section' },
          el('div', { className: 'orch-detail-section-title' }, 'Pending Question'),
          el('div', { className: 'orch-detail-question-text' }, ticket.pendingQuestion),
        )
      );
    }

    // Logs — prefer workerLog (rich terminal logs) if available,
    // otherwise fall back to note entries from statusHistory.
    const workerLogLines = ticket.workerLog && ticket.workerLog.length ? ticket.workerLog : null;
    const logEntries = (ticket.statusHistory || []).filter(e => e.note);
    {
      let items;
      let title;
      if (workerLogLines) {
        // workerLog entries are already formatted as "[HH:MM:SS] ..." strings
        title = `Logs (${workerLogLines.length})`;
        // Show most-recent first (reverse order matches terminal dashboard scroll-to-bottom behaviour)
        items = [...workerLogLines].reverse().map(line => {
          // Split timestamp prefix from message for separate styling
          const m = line.match(/^(\[\d{2}:\d{2}:\d{2}\])\s?(.*)/s);
          if (m) {
            return el('div', { className: 'orch-log-line' },
              el('span', { className: 'orch-log-ts' }, m[1] + ' '),
              m[2],
            );
          }
          return el('div', { className: 'orch-log-line' }, line);
        });
      } else if (logEntries.length) {
        title = `Logs (${logEntries.length})`;
        items = [...logEntries].reverse().map(entry => {
          const ts = entry.at
            ? new Date(
                typeof entry.at.toDate === 'function' ? entry.at.toDate() : entry.at
              ).toISOString().slice(11, 19)
            : null;
          const prefix = ts ? el('span', { className: 'orch-log-ts' }, `[${ts}] `) : null;
          return el('div', { className: 'orch-log-line' }, prefix, entry.note);
        });
      } else {
        title = 'Logs';
        items = [el('div', { className: 'orch-log-empty' }, 'No logs yet.')];
      }

      body.appendChild(
        el('div', { className: 'orch-detail-section' },
          el('div', { className: 'orch-detail-section-title' }, title),
          el('div', { className: 'orch-log-list' }, items),
        )
      );
    }

    // Dates
    const createdStr = ticket.createdAt ? formatDate(ticket.createdAt) : null;
    const updatedStr = ticket.updatedAt ? formatDate(ticket.updatedAt) : null;
    if (createdStr || updatedStr) {
      const metaItems = [];
      if (createdStr) {
        metaItems.push(el('div', { className: 'orch-detail-meta' },
          el('span', { className: 'orch-detail-meta-label' }, 'Created: '),
          createdStr,
        ));
      }
      if (updatedStr) {
        metaItems.push(el('div', { className: 'orch-detail-meta' },
          el('span', { className: 'orch-detail-meta-label' }, 'Updated: '),
          updatedStr,
        ));
      }
      body.appendChild(el('div', { className: 'orch-detail-section' }, metaItems));
    }
  }
}
