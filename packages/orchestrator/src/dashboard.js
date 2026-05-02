// Terminal ANSI dashboard — shows active workers, paused tickets, and queue.
// Box drawing with sections, cursor navigation, detail views, keyboard shortcuts.

const ESC = '\x1b[';
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const MAGENTA = `${ESC}35m`;
const WHITE = `${ESC}37m`;
const BG_BLUE = `${ESC}44m`;
const INVERSE = `${ESC}7m`;

/**
 * Create a dashboard controller.
 *
 * @param {object} state
 * @param {Map} state.activeWorkers - docId -> worker state
 * @param {Map} state.pausedWorkers - docId -> paused worker state
 * @param {Array} state.queue - queued ticket entries
 * @param {Map} state.ticketInfoCache - docId -> { ticketId, title, projectId }
 * @param {Map} state.workerLogs - docId -> string[] log lines
 * @param {number} state.maxWorkers
 * @param {object|null} [state.maintenanceStatus] - maintenance worker status (or null)
 * @returns {object} { open, close, render, handleKey, isOpen }
 */
export function createDashboard({ activeWorkers, pausedWorkers, queue, ticketInfoCache, workerLogs, recentErrors, config, maintenanceStatus }) {
  let _isOpen = false;
  let cursorIndex = 0;
  let section = 'active'; // 'active' | 'paused' | 'queue' | 'errors'
  let detailDocId = null;
  let detailScrollOffset = 0;
  let verboseMode = false;

  function open() {
    _isOpen = true;
    cursorIndex = 0;
    section = 'active';
    detailDocId = null;
    process.stdout.write(HIDE_CURSOR);
    render();
  }

  function close() {
    _isOpen = false;
    detailDocId = null;
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR_SCREEN);
  }

  function isOpen() {
    return _isOpen;
  }

  // ── Rendering ─────────────────────────────────────────────────

  function render() {
    if (!_isOpen) return;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    if (detailDocId) {
      renderDetail(cols, rows);
    } else {
      renderOverview(cols, rows);
    }
  }

  function renderOverview(cols, rows) {
    const lines = [];

    // Title bar
    lines.push(titleBar('Orchestrator Dashboard', cols));
    lines.push('');

    // Capacity dots + error indicator
    const activeCount = activeWorkers.size;
    const maxW = config.maxWorkers;
    const errorCount = (recentErrors || []).length;
    const dots = [];
    for (let i = 0; i < maxW; i++) {
      dots.push(i < activeCount ? `${GREEN}\u25CF${RESET}` : `${DIM}\u25CB${RESET}`);
    }
    const errorTag = errorCount > 0 ? `  ${RED}\u25CF ${errorCount} error${errorCount > 1 ? 's' : ''}${RESET}` : '';
    lines.push(`  Capacity: ${dots.join(' ')}  (${activeCount}/${maxW})${errorTag}`);
    lines.push('');

    // ── Maintenance Worker section ──────────────────────────────
    const maint = maintenanceStatus;
    if (maint && maint.status === 'running') {
      lines.push(sectionHeader(`${MAGENTA}Maintenance Worker${RESET}`, 1, cols));
      const elapsed = maint.startedAt
        ? ` ${DIM}${formatElapsed(Date.now() - new Date(maint.startedAt).getTime())}${RESET}`
        : '';
      const phase = maint.phase ? ` ${DIM}(${maint.phase})${RESET}` : '';
      const projects = maint.projects && maint.projects.length
        ? ` ${DIM}[${maint.projects.join(', ')}]${RESET}`
        : '';
      const dryRunTag = maint.dryRun ? ` ${YELLOW}dry-run${RESET}` : '';
      lines.push(`   ${MAGENTA}maintenance${RESET}${projects}${elapsed}${phase}${dryRunTag}`);
      lines.push('');
    } else if (maint && maint.status === 'idle' && maint.completedAt) {
      // Show recent completion briefly (within last 5 minutes)
      const completedMs = Date.now() - new Date(maint.completedAt).getTime();
      if (completedMs < 5 * 60 * 1000) {
        lines.push(sectionHeader(`${DIM}Maintenance Worker${RESET}`, 0, cols));
        const ago = formatElapsed(completedMs);
        const r = maint.result || {};
        const summary = `fixed: ${r.fixed ?? 0}, skipped: ${r.skipped ?? 0}, failed: ${r.failed ?? 0}`;
        lines.push(`   ${DIM}last run ${ago} ago — ${summary}${RESET}`);
        lines.push('');
      }
    }

    // ── Active Workers section ──────────────────────────────────
    lines.push(sectionHeader('Active Workers', activeWorkers.size, cols));
    const activeEntries = [...activeWorkers.entries()];
    if (activeEntries.length === 0) {
      lines.push(`  ${DIM}(none)${RESET}`);
    } else {
      for (let i = 0; i < activeEntries.length; i++) {
        const [docId, worker] = activeEntries[i];
        const info = ticketInfoCache.get(docId) || {};
        const selected = section === 'active' && cursorIndex === i;
        const prefix = selected ? `${INVERSE} > ${RESET}` : '   ';
        const projTag = info.projectId ? `${DIM}[${info.projectId}]${RESET} ` : '';
        const ticketTag = `${CYAN}${info.ticketId || docId.slice(0, 8)}${RESET}`;
        const title = info.title ? ` ${info.title}` : '';
        const elapsed = worker.startedAt ? formatElapsed(Date.now() - worker.startedAt) : '';
        const cost = worker.costUsd > 0 ? ` ${GREEN}$${worker.costUsd.toFixed(2)}${RESET}` : '';
        const phase = worker.phase ? ` ${DIM}(${worker.phase})${RESET}` : '';
        lines.push(`${prefix}${projTag}${ticketTag}${title} ${DIM}${elapsed}${RESET}${cost}${phase}`);
      }
    }
    lines.push('');

    // ── Paused / Waiting section ────────────────────────────────
    lines.push(sectionHeader('Waiting for User', pausedWorkers.size, cols));
    const pausedEntries = [...pausedWorkers.entries()];
    if (pausedEntries.length === 0) {
      lines.push(`  ${DIM}(none)${RESET}`);
    } else {
      for (let i = 0; i < pausedEntries.length; i++) {
        const [docId, worker] = pausedEntries[i];
        const info = ticketInfoCache.get(docId) || {};
        const globalIdx = activeEntries.length + i;
        const selected = section === 'paused' && cursorIndex === i;
        const prefix = selected ? `${INVERSE} > ${RESET}` : '   ';
        const projTag = info.projectId ? `${DIM}[${info.projectId}]${RESET} ` : '';
        const ticketTag = `${YELLOW}${info.ticketId || docId.slice(0, 8)}${RESET}`;
        const title = info.title ? ` ${info.title}` : '';
        const question = worker.question ? ` ${DIM}Q: ${worker.question}${RESET}` : '';
        lines.push(`${prefix}${projTag}${ticketTag}${title}${question}`);
      }
    }
    lines.push('');

    // ── Queue section ───────────────────────────────────────────
    lines.push(sectionHeader('Queue', queue.length, cols));
    if (queue.length === 0) {
      lines.push(`  ${DIM}(none)${RESET}`);
    } else {
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        const selected = section === 'queue' && cursorIndex === i;
        const prefix = selected ? `${INVERSE} > ${RESET}` : '   ';
        const projTag = entry.projectId ? `${DIM}[${entry.projectId}]${RESET} ` : '';
        const ticketTag = `${MAGENTA}${entry.ticketId || entry.docId?.slice(0, 8) || '?'}${RESET}`;
        const title = entry.title ? ` ${entry.title}` : '';
        lines.push(`${prefix}${projTag}${ticketTag}${title}`);
      }
    }
    lines.push('');

    // ── Errors section ────────────────────────────────────────
    const errors = recentErrors || [];
    if (errors.length > 0) {
      lines.push(sectionHeader(`${RED}Errors${RESET}`, errors.length, cols));
      for (let i = 0; i < errors.length; i++) {
        const entry = errors[i];
        const selected = section === 'errors' && cursorIndex === i;
        const prefix = selected ? `${INVERSE} > ${RESET}` : '   ';
        const projTag = entry.projectId ? `${DIM}[${entry.projectId}]${RESET} ` : '';
        const ticketTag = `${RED}${entry.ticketId || '?'}${RESET}`;
        const ago = formatElapsed(Date.now() - entry.timestamp);
        const errMsg = entry.error.length > cols - 40
          ? entry.error.slice(0, cols - 43) + '...'
          : entry.error;
        lines.push(`${prefix}${projTag}${ticketTag} ${RED}${errMsg}${RESET} ${DIM}${ago} ago${RESET}`);
      }
      lines.push('');
    }

    // ── Help bar ────────────────────────────────────────────────
    lines.push(helpBar(cols));

    // Write to terminal
    process.stdout.write(CLEAR_SCREEN);
    process.stdout.write(lines.join('\n'));
  }

  function renderDetail(cols, rows) {
    const lines = [];
    const info = ticketInfoCache.get(detailDocId) || {};
    const logs = workerLogs.get(detailDocId) || [];

    lines.push(titleBar(`Worker Detail: ${info.ticketId || detailDocId.slice(0, 8)}`, cols));
    lines.push('');

    const projTag = info.projectId ? `[${info.projectId}] ` : '';
    lines.push(`  ${BOLD}${projTag}${info.ticketId || '?'}${RESET}: ${info.title || '(no title)'}`);
    lines.push('');

    lines.push(sectionHeader('Logs', logs.length, cols));

    // Show logs with scroll offset
    const maxLogLines = rows - 8;
    const startIdx = Math.max(0, detailScrollOffset);
    const visibleLogs = logs.slice(startIdx, startIdx + maxLogLines);

    if (visibleLogs.length === 0) {
      lines.push(`  ${DIM}(no logs yet)${RESET}`);
    } else {
      for (const line of visibleLogs) {
        // Truncate long lines
        const truncated = line.length > cols - 4 ? line.slice(0, cols - 7) + '...' : line;
        lines.push(`  ${truncated}`);
      }
    }

    if (logs.length > maxLogLines) {
      lines.push('');
      lines.push(`  ${DIM}Showing ${startIdx + 1}-${Math.min(startIdx + maxLogLines, logs.length)} of ${logs.length} lines. Use arrows to scroll.${RESET}`);
    }

    lines.push('');
    lines.push(`  ${DIM}ESC: back  |  j/k: scroll  |  t: top  |  v: verbose${RESET}`);

    process.stdout.write(CLEAR_SCREEN);
    process.stdout.write(lines.join('\n'));
  }

  // ── Key handling ──────────────────────────────────────────────

  function handleKey(key) {
    if (!_isOpen) return false;

    // ESC — close detail or close dashboard
    if (key === '\x1b' || key === '\x1b\x1b') {
      if (detailDocId) {
        detailDocId = null;
        detailScrollOffset = 0;
        render();
      } else {
        close();
      }
      return true;
    }

    // q — quit
    if (key === 'q') {
      close();
      return 'quit';
    }

    // Detail view controls
    if (detailDocId) {
      return handleDetailKey(key);
    }

    // Overview controls
    return handleOverviewKey(key);
  }

  function handleDetailKey(key) {
    const logs = workerLogs.get(detailDocId) || [];

    // Up arrow / k
    if (key === '\x1b[A' || key === 'k') {
      detailScrollOffset = Math.max(0, detailScrollOffset - 1);
      render();
      return true;
    }
    // Down arrow / j
    if (key === '\x1b[B' || key === 'j') {
      detailScrollOffset = Math.min(Math.max(0, logs.length - 5), detailScrollOffset + 1);
      render();
      return true;
    }
    // t — jump to top
    if (key === 't') {
      detailScrollOffset = 0;
      render();
      return true;
    }
    // v — toggle verbose
    if (key === 'v') {
      verboseMode = !verboseMode;
      render();
      return true;
    }

    return true; // consume all keys in detail mode
  }

  function handleOverviewKey(key) {
    const activeEntries = [...activeWorkers.entries()];
    const pausedEntries = [...pausedWorkers.entries()];

    // Tab — cycle sections
    if (key === '\t') {
      const hasErrors = (recentErrors || []).length > 0;
      if (section === 'active') section = 'paused';
      else if (section === 'paused') section = 'queue';
      else if (section === 'queue') section = hasErrors ? 'errors' : 'active';
      else section = 'active';
      cursorIndex = 0;
      render();
      return true;
    }

    // Up arrow / k
    if (key === '\x1b[A' || key === 'k') {
      cursorIndex = Math.max(0, cursorIndex - 1);
      render();
      return true;
    }

    // Down arrow / j
    if (key === '\x1b[B' || key === 'j') {
      const maxIdx = getSectionLength(section, activeEntries, pausedEntries) - 1;
      cursorIndex = Math.min(Math.max(0, maxIdx), cursorIndex + 1);
      render();
      return true;
    }

    // Enter — open detail view for selected worker
    if (key === '\r' || key === '\n') {
      const docId = getSelectedDocId(section, activeEntries, pausedEntries);
      if (docId) {
        detailDocId = docId;
        detailScrollOffset = Math.max(0, (workerLogs.get(docId) || []).length - 10);
        render();
      }
      return true;
    }

    // t — jump to top
    if (key === 't') {
      cursorIndex = 0;
      render();
      return true;
    }

    // K — move queue item up
    if (key === 'K' && section === 'queue' && cursorIndex > 0) {
      [queue[cursorIndex - 1], queue[cursorIndex]] = [queue[cursorIndex], queue[cursorIndex - 1]];
      cursorIndex--;
      render();
      return true;
    }

    // J — move queue item down
    if (key === 'J' && section === 'queue' && cursorIndex < queue.length - 1) {
      [queue[cursorIndex], queue[cursorIndex + 1]] = [queue[cursorIndex + 1], queue[cursorIndex]];
      cursorIndex++;
      render();
      return true;
    }

    // v — toggle verbose
    if (key === 'v') {
      verboseMode = !verboseMode;
      render();
      return true;
    }

    // + / = — increase worker pool
    if (key === '+' || key === '=') {
      return 'pool_up';
    }

    // - — decrease worker pool
    if (key === '-') {
      return 'pool_down';
    }

    // m — manually trigger maintenance worker
    if (key === 'm') {
      return 'maintenance';
    }

    // r — rekick / return to overview
    if (key === 'r') {
      render();
      return 'rekick';
    }

    return true; // consume all keys when dashboard is open
  }

  // ── Helpers ───────────────────────────────────────────────────

  function getSectionLength(sec, activeEntries, pausedEntries) {
    if (sec === 'active') return activeEntries.length;
    if (sec === 'paused') return pausedEntries.length;
    if (sec === 'errors') return (recentErrors || []).length;
    return queue.length;
  }

  function getSelectedDocId(sec, activeEntries, pausedEntries) {
    if (sec === 'active' && cursorIndex < activeEntries.length) {
      return activeEntries[cursorIndex][0];
    }
    if (sec === 'paused' && cursorIndex < pausedEntries.length) {
      return pausedEntries[cursorIndex][0];
    }
    if (sec === 'queue' && cursorIndex < queue.length) {
      return queue[cursorIndex].docId;
    }
    return null;
  }

  return { open, close, render, handleKey, get isOpen() { return _isOpen; } };
}

// ── Drawing helpers ─────────────────────────────────────────────────

function titleBar(text, cols) {
  const padded = ` ${text} `;
  const remaining = Math.max(0, cols - padded.length);
  return `${BG_BLUE}${WHITE}${BOLD}${padded}${' '.repeat(remaining)}${RESET}`;
}

function sectionHeader(text, count, cols) {
  const label = `  ${BOLD}${text}${RESET} ${DIM}(${count})${RESET}`;
  return label;
}

function helpBar(cols) {
  const items = [
    'TAB: section',
    'j/k: navigate',
    'Enter: detail',
    'J/K: reorder',
    '+/-: pool size',
    'r: rekick',
    'm: maintenance',
    'q: quit',
    'ESC: close',
  ];
  return `  ${DIM}${items.join('  |  ')}${RESET}`;
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins}m`;
}
