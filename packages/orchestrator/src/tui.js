// @docket/orchestrator — Fancy three-pane terminal UI (TUI)
// Mirrors the web UI layout:
//   Left pane:   EPD Advisor (engineer / design / product personas)
//   Center pane: Ticket Management (active, paused, queue, errors)
//   Right pane:  Workers / Orchestrator / Maintenance
//
// Press TAB to cycle focus between panes, arrows/Enter to navigate,
// standard controls within each pane.

// ── ANSI escape helpers ──────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const UNDERLINE = `${ESC}4m`;
const INVERSE = `${ESC}7m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;

const RED     = `${ESC}31m`;
const GREEN   = `${ESC}32m`;
const YELLOW  = `${ESC}33m`;
const MAGENTA = `${ESC}35m`;
const CYAN    = `${ESC}36m`;
const WHITE   = `${ESC}37m`;

const BG_BLACK = `${ESC}40m`;
const BG_BLUE  = `${ESC}44m`;

// Unicode box-drawing
const TL = '┌'; const TR = '┐'; const BL = '└'; const BR = '┘';
const H  = '─'; const V  = '│';

// Active border (focused pane uses bright cyan)
const BORDER_ACTIVE = `${ESC}96m`; // bright cyan
const BORDER_DIM    = `${ESC}2;36m`; // dim cyan

// ── String helpers ───────────────────────────────────────────────────────────

/** Strip ANSI escapes from a string */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible length of a string (excluding ANSI escapes) */
function visLen(str) {
  return stripAnsi(str).length;
}

/** Pad/truncate a string to exactly `width` visible characters */
function padEnd(str, width, fill = ' ') {
  const vl = visLen(str);
  if (vl >= width) {
    // Need to truncate: walk through string preserving ANSI codes, stop at `width` visible chars
    let count = 0;
    const s = str;
    let result = '';
    let j = 0;
    while (j < s.length && count < width) {
      if (s[j] === '\x1b') {
        // Find end of escape sequence
        const start = j;
        j++;
        while (j < s.length && s[j] !== 'm') j++;
        j++;
        result += s.slice(start, j);
      } else {
        result += s[j];
        count++;
        j++;
      }
    }
    return result + RESET;
  }
  return str + fill.repeat(width - vl);
}

/** Format elapsed milliseconds */
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return `${m}m${ss}s`;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}h${mm}m`;
}

/** Format ISO or Date for display */
function fmtTime(val) {
  if (!val) return '—';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Relative time label (e.g. "3m ago") */
function fmtAgo(isoOrMs) {
  if (!isoOrMs) return '';
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.now() - new Date(isoOrMs).getTime();
  return `${fmtElapsed(ms)} ago`;
}

// ── Box-drawing helpers ──────────────────────────────────────────────────────

/**
 * Draw a box into a flat char array (direct write to output strings).
 * Returns an array of strings, one per row of the box.
 *
 * @param {number} width - outer width including borders
 * @param {number} height - outer height including borders
 * @param {string} title - optional title shown in top border
 * @param {boolean} focused - if true, use bright border color
 * @returns {string[]} array of `height` strings
 */
function buildBox(width, height, title = '', focused = false) {
  const borderColor = focused ? BORDER_ACTIVE : BORDER_DIM;
  const inner = Math.max(0, width - 2);
  const lines = [];

  // Top border
  if (title) {
    const t = ` ${BOLD}${focused ? CYAN : DIM + WHITE}${title}${RESET}${borderColor} `;
    const tLen = visLen(` ${title} `);
    const leftDashes = Math.max(0, Math.floor((inner - tLen) / 2));
    const rightDashes = Math.max(0, inner - tLen - leftDashes);
    lines.push(
      borderColor + TL +
      H.repeat(leftDashes) + t +
      H.repeat(rightDashes) + TR + RESET
    );
  } else {
    lines.push(borderColor + TL + H.repeat(inner) + TR + RESET);
  }

  // Middle rows
  for (let i = 0; i < height - 2; i++) {
    lines.push(borderColor + V + RESET + ' '.repeat(inner) + borderColor + V + RESET);
  }

  // Bottom border
  lines.push(borderColor + BL + H.repeat(inner) + BR + RESET);

  return lines;
}

// ── Pane renderers ───────────────────────────────────────────────────────────

// Each pane renderer takes config + state and returns an array of strings,
// one per row (full width of the pane including its border).

/**
 * Render the LEFT pane: EPD Advisor personas
 *
 * @param {number} width - pane width (including border)
 * @param {number} height - pane height (including border)
 * @param {boolean} focused
 * @param {object} state - { advisorState, leftCursor, leftScroll }
 */
function renderLeftPane(width, height, focused, state) {
  const inner = width - 2;
  const innerH = height - 2;
  const { advisorState, leftCursor, leftScroll } = state;

  const box = buildBox(width, height, 'Advisors', focused);

  // Build content rows
  const rows = [];

  const personas = ['engineer', 'design', 'product'];
  const personaLabels = { engineer: 'Engineer', design: 'Design', product: 'Product' };
  const personaIcons = { engineer: '⚙', design: '🎨', product: '📋' };

  for (let pi = 0; pi < personas.length; pi++) {
    const pName = personas[pi];
    const pData = advisorState?.[pName] || null;
    const isSelected = leftCursor === pi;

    // Persona header row
    const icon = personaIcons[pName];
    const label = personaLabels[pName];
    const statusStr = pData ? pData.status : 'unknown';
    let statusColor;
    if (statusStr === 'running') statusColor = GREEN;
    else if (statusStr === 'idle') statusColor = DIM + WHITE;
    else if (statusStr === 'paused') statusColor = YELLOW;
    else statusColor = DIM;

    const headerBg = isSelected && focused ? `${BG_BLUE}${WHITE}` : (isSelected ? `${INVERSE}` : '');
    const reset = RESET;

    let headerLine = `${headerBg}${BOLD} ${icon} ${label}${reset}`;
    const statusTag = `${statusColor}${statusStr}${RESET}`;
    const headerRight = ` ${statusTag}`;
    const headerLeftLen = visLen(` ${icon} ${label}`);
    const headerRightLen = visLen(` ${statusStr}`);
    const spacer = Math.max(1, inner - headerLeftLen - headerRightLen);
    headerLine = `${headerBg}${BOLD} ${icon} ${label}${reset}${' '.repeat(spacer)}${headerRight}`;

    rows.push(padEnd(headerLine, inner));

    if (pData) {
      // Last activity
      const activity = pData.lastActivity || '—';
      const actTrunc = activity.length > inner - 4 ? activity.slice(0, inner - 7) + '...' : activity;
      rows.push(padEnd(`${DIM}  ${actTrunc}${RESET}`, inner));

      // Next run / stats
      const nextRun = pData.nextRunAt
        ? `next: ${fmtTime(pData.nextRunAt)}`
        : '';
      const cycles = pData.cycleCount ? `cycles: ${pData.cycleCount}` : '';
      const tickets = pData.ticketsCreated ? `tickets: ${pData.ticketsCreated}` : '';
      const statsLine = [cycles, tickets, nextRun].filter(Boolean).join('  ');
      if (statsLine) {
        rows.push(padEnd(`${DIM}  ${statsLine}${RESET}`, inner));
      }

      // Show last 2 log entries if selected
      if (isSelected && pData.activityLog && pData.activityLog.length > 0) {
        const logEntries = pData.activityLog.slice(0, 3);
        for (const entry of logEntries) {
          const t = fmtTime(entry.at);
          const msg = entry.msg || '';
          const msgTrunc = msg.length > inner - 12 ? msg.slice(0, inner - 15) + '...' : msg;
          rows.push(padEnd(`${DIM}  ${t} ${msgTrunc}${RESET}`, inner));
        }
      }
    } else {
      rows.push(padEnd(`${DIM}  (not configured)${RESET}`, inner));
    }

    // Divider between personas (except after last)
    if (pi < personas.length - 1) {
      const bc = focused ? BORDER_ACTIVE : BORDER_DIM;
      rows.push(`${bc}${H.repeat(inner)}${RESET}`);
    }
  }

  // Scroll hint
  const totalRows = rows.length;
  const scroll = Math.max(0, Math.min(leftScroll, Math.max(0, totalRows - innerH)));
  const visible = rows.slice(scroll, scroll + innerH);

  // Pad to fill pane
  while (visible.length < innerH) {
    visible.push(' '.repeat(inner));
  }

  // Overlay rows into box
  const bc = focused ? BORDER_ACTIVE : BORDER_DIM;
  const result = [box[0]];
  for (let i = 0; i < innerH; i++) {
    result.push(bc + V + RESET + padEnd(visible[i], inner) + bc + V + RESET);
  }
  result.push(box[box.length - 1]);

  return result;
}

/**
 * Render the CENTER pane: Ticket Management
 *
 * @param {number} width
 * @param {number} height
 * @param {boolean} focused
 * @param {object} state - { activeWorkers, pausedWorkers, queue, recentErrors, ticketInfoCache, workerLogs, config, centerTab, centerCursor, centerScroll, detailDocId, detailScroll }
 */
function renderCenterPane(width, height, focused, state) {
  const inner = width - 2;
  const innerH = height - 2;
  const bc = focused ? BORDER_ACTIVE : BORDER_DIM;

  const {
    activeWorkers, pausedWorkers, queue, recentErrors,
    ticketInfoCache, workerLogs, config,
    centerTab, centerCursor, centerScroll,
    detailDocId, detailScroll,
  } = state;

  const box = buildBox(width, height, 'Ticket Management', focused);
  const rows = [];

  // Tab bar: Active | Paused | Queue | Errors
  const tabs = ['Active', 'Paused', 'Queue', 'Errors'];
  const tabCounts = [
    activeWorkers.size,
    pausedWorkers.size,
    queue.length,
    (recentErrors || []).length,
  ];
  let tabBar = '';
  for (let i = 0; i < tabs.length; i++) {
    const isActive = centerTab === i;
    const cnt = tabCounts[i];
    const cntStr = cnt > 0 ? `(${cnt})` : '';
    if (isActive && focused) {
      tabBar += `${BG_BLUE}${WHITE}${BOLD} ${tabs[i]}${cntStr ? ' ' + cntStr : ''} ${RESET}`;
    } else if (isActive) {
      tabBar += `${UNDERLINE}${BOLD} ${tabs[i]}${cntStr ? ' ' + cntStr : ''} ${RESET}`;
    } else {
      tabBar += `${DIM} ${tabs[i]}${cntStr ? ' ' + cntStr : ''} ${RESET}`;
    }
    if (i < tabs.length - 1) tabBar += `${DIM}│${RESET}`;
  }
  rows.push(padEnd(tabBar, inner));

  // Divider under tabs
  rows.push(`${bc}${H.repeat(inner)}${RESET}`);

  // Detail view
  if (detailDocId) {
    const info = ticketInfoCache.get(detailDocId) || {};
    const logs = workerLogs.get(detailDocId) || [];
    const workerState = activeWorkers.get(detailDocId) || pausedWorkers.get(detailDocId);

    rows.push(padEnd(`${BOLD} ${CYAN}${info.ticketId || detailDocId.slice(0, 8)}${RESET}${BOLD} — ${info.title || '(no title)'}${RESET}`, inner));

    if (workerState) {
      const elapsed = workerState.startedAt ? fmtElapsed(Date.now() - workerState.startedAt) : '';
      const cost = workerState.costUsd > 0 ? `  ${GREEN}$${workerState.costUsd.toFixed(2)}${RESET}` : '';
      const phase = workerState.phase ? `  ${DIM}${workerState.phase}${RESET}` : '';
      rows.push(padEnd(`${DIM} elapsed: ${elapsed}${RESET}${cost}${phase}`, inner));
    }

    rows.push(`${DIM}${H.repeat(inner)}${RESET}`);

    // Log lines
    const logAreaH = innerH - rows.length - 1;
    const scroll = Math.max(0, Math.min(detailScroll, Math.max(0, logs.length - logAreaH)));
    const visLogs = logs.slice(scroll, scroll + logAreaH);

    for (const line of visLogs) {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, ''); // strip for display
      rows.push(padEnd(`${DIM} ${clean}${RESET}`, inner));
    }

    if (logs.length === 0) {
      rows.push(padEnd(`${DIM} (no logs yet)${RESET}`, inner));
    }

    // Scroll indicator
    if (logs.length > logAreaH) {
      const pct = Math.round((scroll / Math.max(1, logs.length - logAreaH)) * 100);
      rows.push(padEnd(`${DIM} ↕ ${scroll + 1}-${Math.min(scroll + logAreaH, logs.length)}/${logs.length} (${pct}%)  ESC: back${RESET}`, inner));
    }
  } else {
    // List view based on active tab
    let entries = [];
    if (centerTab === 0) {
      entries = [...activeWorkers.entries()].map(([docId, w]) => {
        const info = ticketInfoCache.get(docId) || {};
        return { docId, ticketId: info.ticketId || w.ticketId || docId.slice(0, 8), title: info.title || '', projectId: info.projectId || w.projectId || '', elapsed: w.startedAt ? fmtElapsed(Date.now() - w.startedAt) : '', cost: w.costUsd > 0 ? `$${w.costUsd.toFixed(2)}` : '', phase: w.phase || '', color: GREEN };
      });
    } else if (centerTab === 1) {
      entries = [...pausedWorkers.entries()].map(([docId, w]) => {
        const info = ticketInfoCache.get(docId) || {};
        return { docId, ticketId: info.ticketId || w.ticketId || docId.slice(0, 8), title: info.title || '', projectId: info.projectId || w.projectId || '', question: w.question || '', color: YELLOW };
      });
    } else if (centerTab === 2) {
      entries = queue.map((q) => ({
        docId: q.docId, ticketId: q.ticketId || q.docId?.slice(0, 8) || '?', title: q.title || '', projectId: q.projectId || '', color: MAGENTA,
      }));
    } else if (centerTab === 3) {
      entries = (recentErrors || []).map((e) => ({
        docId: e.docId, ticketId: e.ticketId || '?', title: e.error || '', projectId: e.projectId || '', ago: fmtAgo(e.timestamp), color: RED,
      }));
    }

    if (entries.length === 0) {
      rows.push(padEnd(`${DIM} (none)${RESET}`, inner));
    } else {
      const scroll = Math.max(0, Math.min(centerScroll, Math.max(0, entries.length - (innerH - rows.length - 1))));
      const visEntries = entries.slice(scroll, scroll + (innerH - rows.length));

      for (let i = 0; i < visEntries.length; i++) {
        const e = visEntries[i];
        const absIdx = scroll + i;
        const isSelected = centerCursor === absIdx;
        const prefix = isSelected && focused ? `${BG_BLUE}${WHITE}▶${RESET}` : (isSelected ? `${INVERSE}▶${RESET}` : ' ');
        const proj = e.projectId ? `${DIM}[${e.projectId}]${RESET} ` : '';
        const tid = `${e.color}${BOLD}${e.ticketId}${RESET}`;
        const title = e.title ? ` ${e.title}` : '';
        let extras = '';
        if (e.elapsed) extras += ` ${DIM}${e.elapsed}${RESET}`;
        if (e.cost) extras += ` ${GREEN}${e.cost}${RESET}`;
        if (e.phase) extras += ` ${DIM}(${e.phase})${RESET}`;
        if (e.question) extras += ` ${DIM}Q: ${e.question.slice(0, 30)}${RESET}`;
        if (e.ago) extras += ` ${DIM}${e.ago}${RESET}`;

        const line = `${prefix}${proj}${tid}${title}${extras}`;
        rows.push(padEnd(line, inner));
      }

      // Scroll indicator if needed
      if (entries.length > innerH - rows.length) {
        rows.push(padEnd(`${DIM} ↕ ${scroll + 1}-${Math.min(scroll + (innerH - rows.length), entries.length)}/${entries.length}${RESET}`, inner));
      }
    }

    // Capacity bar for active tab
    if (centerTab === 0) {
      const activeCount = activeWorkers.size;
      const maxW = config.maxWorkers;
      const dots = [];
      for (let i = 0; i < maxW; i++) {
        dots.push(i < activeCount ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`);
      }
      const capLine = ` ${dots.join('')} ${activeCount}/${maxW} workers`;
      // Insert capacity line after tab+divider
      rows.splice(2, 0, padEnd(capLine, inner));
    }
  }

  // Pad to fill
  while (rows.length < innerH) rows.push(' '.repeat(inner));

  // Assemble
  const result = [box[0]];
  for (let i = 0; i < innerH; i++) {
    result.push(bc + V + RESET + padEnd(rows[i] || ' '.repeat(inner), inner) + bc + V + RESET);
  }
  result.push(box[box.length - 1]);

  return result;
}

/**
 * Render the RIGHT pane: Workers / Orchestrator / Maintenance
 *
 * @param {number} width
 * @param {number} height
 * @param {boolean} focused
 * @param {object} state
 */
function renderRightPane(width, height, focused, state) {
  const inner = width - 2;
  const innerH = height - 2;
  const bc = focused ? BORDER_ACTIVE : BORDER_DIM;

  const {
    activeWorkers, pausedWorkers, queue, recentErrors,
    maintenanceStatus, config, workerLogs, ticketInfoCache,
    rightTab, rightCursor, rightScroll,
  } = state;

  const box = buildBox(width, height, 'Workers & Ops', focused);
  const rows = [];

  // Tab bar: Workers | Queue | Maintenance
  const tabs = ['Workers', 'Queue', 'Maint'];
  const tabCounts = [activeWorkers.size + pausedWorkers.size, queue.length, null];
  let tabBar = '';
  for (let i = 0; i < tabs.length; i++) {
    const isActive = rightTab === i;
    const cnt = tabCounts[i];
    const cntStr = cnt != null && cnt > 0 ? `(${cnt})` : '';
    if (isActive && focused) {
      tabBar += `${BG_BLUE}${WHITE}${BOLD} ${tabs[i]}${cntStr ? ' ' + cntStr : ''} ${RESET}`;
    } else if (isActive) {
      tabBar += `${UNDERLINE}${BOLD} ${tabs[i]}${cntStr ? ' ' + cntStr : ''} ${RESET}`;
    } else {
      tabBar += `${DIM} ${tabs[i]}${cntStr ? ' ' + cntStr : ''} ${RESET}`;
    }
    if (i < tabs.length - 1) tabBar += `${DIM}│${RESET}`;
  }
  rows.push(padEnd(tabBar, inner));
  rows.push(`${bc}${H.repeat(inner)}${RESET}`);

  if (rightTab === 0) {
    // Workers view — active + paused
    const activeEntries = [...activeWorkers.entries()];
    const pausedEntries = [...pausedWorkers.entries()];

    if (activeEntries.length > 0) {
      rows.push(padEnd(`${GREEN}${BOLD} Active (${activeEntries.length})${RESET}`, inner));
      for (let i = 0; i < activeEntries.length; i++) {
        const [docId, w] = activeEntries[i];
        const info = ticketInfoCache.get(docId) || {};
        const isSelected = rightCursor === i && focused;
        const prefix = isSelected ? `${BG_BLUE}${WHITE}▶${RESET}` : ' ';
        const tid = `${GREEN}${info.ticketId || w.ticketId || docId.slice(0, 8)}${RESET}`;
        const elapsed = w.startedAt ? ` ${DIM}${fmtElapsed(Date.now() - w.startedAt)}${RESET}` : '';
        const cost = w.costUsd > 0 ? ` ${GREEN}$${w.costUsd.toFixed(2)}${RESET}` : '';
        const phase = w.phase ? ` ${DIM}(${w.phase})${RESET}` : '';
        rows.push(padEnd(`${prefix}${tid}${elapsed}${cost}${phase}`, inner));
      }
    }

    if (pausedEntries.length > 0) {
      rows.push(padEnd(`${YELLOW}${BOLD} Paused (${pausedEntries.length})${RESET}`, inner));
      for (let i = 0; i < pausedEntries.length; i++) {
        const [docId, w] = pausedEntries[i];
        const info = ticketInfoCache.get(docId) || {};
        const isSelected = rightCursor === (activeEntries.length + i) && focused;
        const prefix = isSelected ? `${BG_BLUE}${WHITE}▶${RESET}` : ' ';
        const tid = `${YELLOW}${info.ticketId || w.ticketId || docId.slice(0, 8)}${RESET}`;
        const q = w.question ? ` ${DIM}Q: ${w.question.slice(0, inner - 15)}${RESET}` : '';
        rows.push(padEnd(`${prefix}${tid}${q}`, inner));
      }
    }

    if (activeEntries.length === 0 && pausedEntries.length === 0) {
      rows.push(padEnd(`${DIM} (no active workers)${RESET}`, inner));
    }

    // Capacity
    rows.push(`${bc}${H.repeat(inner)}${RESET}`);
    const maxW = config.maxWorkers;
    const activeCount = activeWorkers.size;
    const dots = [];
    for (let i = 0; i < Math.min(maxW, inner - 15); i++) {
      dots.push(i < activeCount ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`);
    }
    rows.push(padEnd(` Capacity: ${dots.join('')} ${activeCount}/${maxW}`, inner));
    rows.push(padEnd(`${DIM} +/- pool  r rekick  m maint${RESET}`, inner));

  } else if (rightTab === 1) {
    // Queue view
    if (queue.length === 0) {
      rows.push(padEnd(`${DIM} Queue is empty${RESET}`, inner));
    } else {
      const scroll = Math.max(0, Math.min(rightScroll, Math.max(0, queue.length - (innerH - 3))));
      const visible = queue.slice(scroll, scroll + (innerH - 3));
      for (let i = 0; i < visible.length; i++) {
        const q = visible[i];
        const absIdx = scroll + i;
        const isSelected = rightCursor === absIdx && focused;
        const prefix = isSelected ? `${BG_BLUE}${WHITE}▶${RESET}` : ' ';
        const idx = `${DIM}${absIdx + 1}.${RESET}`;
        const tid = `${MAGENTA}${q.ticketId || q.docId?.slice(0, 8) || '?'}${RESET}`;
        const title = q.title ? ` ${q.title.slice(0, inner - 15)}` : '';
        rows.push(padEnd(`${prefix}${idx} ${tid}${title}`, inner));
      }
      if (queue.length > innerH - 3) {
        rows.push(padEnd(`${DIM} ↕ ${scroll + 1}-${Math.min(scroll + (innerH - 3), queue.length)}/${queue.length}  J/K reorder${RESET}`, inner));
      }
    }

  } else if (rightTab === 2) {
    // Maintenance view
    const maint = maintenanceStatus;
    if (maint) {
      let statusColor = DIM;
      if (maint.status === 'running') statusColor = GREEN;
      else if (maint.status === 'idle') statusColor = DIM;

      rows.push(padEnd(` Status: ${statusColor}${maint.status || '?'}${RESET}`, inner));

      if (maint.status === 'running') {
        const elapsed = maint.startedAt ? fmtElapsed(Date.now() - new Date(maint.startedAt).getTime()) : '';
        const phase = maint.phase || '';
        rows.push(padEnd(` ${DIM}Running for ${elapsed}${phase ? ' — ' + phase : ''}${RESET}`, inner));
        const projects = maint.projects?.length ? ` [${maint.projects.join(', ')}]` : '';
        if (projects) rows.push(padEnd(`${DIM}${projects}${RESET}`, inner));
      } else if (maint.status === 'idle') {
        const ago = maint.completedAt ? ` last run ${fmtAgo(maint.completedAt)}` : '';
        rows.push(padEnd(`${DIM}${ago}${RESET}`, inner));
        const r = maint.result || {};
        if (r.fixed != null || r.skipped != null || r.failed != null) {
          rows.push(padEnd(`${DIM} fixed:${r.fixed ?? 0} skipped:${r.skipped ?? 0} failed:${r.failed ?? 0}${RESET}`, inner));
        }
        if (maint.error) {
          rows.push(padEnd(` ${RED}Error: ${maint.error.slice(0, inner - 10)}${RESET}`, inner));
        }
      }
    } else {
      rows.push(padEnd(`${DIM} No maintenance data${RESET}`, inner));
    }
    rows.push(`${bc}${H.repeat(inner)}${RESET}`);
    rows.push(padEnd(`${DIM} m: run now  d: classic${RESET}`, inner));

    // Recent errors summary
    const errors = recentErrors || [];
    if (errors.length > 0) {
      rows.push(`${bc}${H.repeat(inner)}${RESET}`);
      rows.push(padEnd(`${RED}${BOLD} Recent Errors (${errors.length})${RESET}`, inner));
      for (const e of errors.slice(0, 4)) {
        const ago = fmtAgo(e.timestamp);
        const errMsg = (e.error || '').slice(0, inner - 15);
        rows.push(padEnd(` ${RED}${e.ticketId}${RESET} ${DIM}${errMsg}${RESET}`, inner));
        rows.push(padEnd(`  ${DIM}${ago}${RESET}`, inner));
      }
    }
  }

  // Pad to fill
  while (rows.length < innerH) rows.push(' '.repeat(inner));

  // Assemble
  const result = [box[0]];
  for (let i = 0; i < innerH; i++) {
    result.push(bc + V + RESET + padEnd(rows[i] || ' '.repeat(inner), inner) + bc + V + RESET);
  }
  result.push(box[box.length - 1]);

  return result;
}

/**
 * Render the title bar (top row)
 */
function renderTitleBar(cols, state) {
  const { activeWorkers, pausedWorkers, queue, config, focusedPane } = state;
  const active = activeWorkers.size;
  const paused = pausedWorkers.size;
  const queued = queue.length;
  const maxW = config.maxWorkers;

  const title = `${BOLD}${WHITE} ◆ docket orchestrator${RESET}`;
  const stats = `${GREEN}${active}${RESET}${DIM}/${maxW} active${RESET}  ${YELLOW}${paused}${RESET}${DIM} paused${RESET}  ${MAGENTA}${queued}${RESET}${DIM} queued${RESET}`;
  const hint = `${DIM}TAB: focus  q: quit${RESET}`;

  const titleLen = visLen(' ◆ docket orchestrator');
  const statsLen = visLen(`${active}/${maxW} active  ${paused} paused  ${queued} queued`);
  const hintLen = visLen('TAB: focus  q: quit');

  const spacer1 = Math.max(1, Math.floor((cols - titleLen - statsLen - hintLen) / 2));
  const spacer2 = Math.max(1, cols - titleLen - statsLen - hintLen - spacer1);

  const line = `${BG_BLACK}${title}${' '.repeat(spacer1)}${stats}${' '.repeat(spacer2)}${hint}${RESET}`;
  return padEnd(line, cols);
}

/**
 * Render the help bar (bottom row)
 */
function renderHelpBar(cols, state) {
  const { focusedPane, detailDocId } = state;

  let items = [];

  if (focusedPane === 0) {
    // Left pane (Advisor)
    items = ['↑/↓: select', 'Enter: run now', 'p: pause/resume', 'TAB: next pane'];
  } else if (focusedPane === 1) {
    // Center pane (Tickets)
    if (detailDocId) {
      items = ['↑/↓: scroll logs', 'ESC: back', 'TAB: next pane'];
    } else {
      items = ['←/→ or h/l: tab', '↑/↓: select', 'Enter: detail', 'TAB: next pane'];
    }
  } else if (focusedPane === 2) {
    // Right pane (Workers)
    items = ['←/→ or h/l: tab', '↑/↓: select', 'J/K: reorder queue', 'TAB: next pane'];
  }

  items.push('d: classic view');
  items.push('q: quit');

  return `  ${DIM}${items.join('  │  ')}${RESET}`;
}

// ── TUI controller ───────────────────────────────────────────────────────────

/**
 * Create the fancy three-pane terminal UI.
 *
 * @param {object} options - same shape as createDashboard
 * @returns {object} { open, close, render, handleKey, isOpen }
 */
export function createTUI({
  activeWorkers, pausedWorkers, queue, ticketInfoCache, workerLogs,
  recentErrors, config, maintenanceStatus: maintenanceStatusRef,
  advisorState: advisorStateRef,
  onRunAdvisorNow,
  onPauseAdvisor,
}) {
  let _isOpen = false;

  // ── UI State ─────────────────────────────────────────────────────────────
  let focusedPane = 1; // 0=left, 1=center, 2=right

  // Left pane state
  let leftCursor = 0;
  let leftScroll = 0;

  // Center pane state
  let centerTab = 0; // 0=active,1=paused,2=queue,3=errors
  let centerCursor = 0;
  let centerScroll = 0;
  let detailDocId = null;
  let detailScroll = 0;

  // Right pane state
  let rightTab = 0; // 0=workers,1=queue,2=maintenance
  let rightCursor = 0;
  let rightScroll = 0;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function open() {
    _isOpen = true;
    process.stdout.write(HIDE_CURSOR);
    process.stdout.write(ALT_SCREEN_ON);
    render();
  }

  function close() {
    _isOpen = false;
    process.stdout.write(ALT_SCREEN_OFF);
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR_SCREEN);
  }

  function isOpen() {
    return _isOpen;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!_isOpen) return;

    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;

    // Layout: title(1) + panes(rows-2) + help(1)
    const titleH = 1;
    const helpH = 1;
    const paneH = Math.max(10, rows - titleH - helpH);

    // Pane widths: left=25%, center=50%, right=25%
    // Ensure total never exceeds cols (narrow terminals would make centerW negative)
    const rawLeft = Math.max(24, Math.floor(cols * 0.24));
    const rawRight = Math.max(24, Math.floor(cols * 0.24));
    const minCenter = 24;
    const minCols = rawLeft + rawRight + minCenter;
    const effectiveCols = Math.max(cols, minCols);
    const leftW = Math.max(24, Math.floor(effectiveCols * 0.24));
    const rightW = Math.max(24, Math.floor(effectiveCols * 0.24));
    const centerW = effectiveCols - leftW - rightW;

    // Get advisor state snapshot
    const advisorState = advisorStateRef ? advisorStateRef() : null;
    const maintenanceStatus = maintenanceStatusRef ? maintenanceStatusRef() : null;

    // Shared state for pane renderers
    const sharedState = {
      activeWorkers, pausedWorkers, queue, recentErrors: recentErrors || [],
      ticketInfoCache, workerLogs, config, maintenanceStatus,
      advisorState,
      focusedPane, detailDocId,
    };

    // Render title bar
    const titleLine = renderTitleBar(cols, sharedState);

    // Render panes
    const leftLines = renderLeftPane(leftW, paneH, focusedPane === 0, {
      ...sharedState, leftCursor, leftScroll,
    });
    const centerLines = renderCenterPane(centerW, paneH, focusedPane === 1, {
      ...sharedState, centerTab, centerCursor, centerScroll, detailScroll,
    });
    const rightLines = renderRightPane(rightW, paneH, focusedPane === 2, {
      ...sharedState, rightTab, rightCursor, rightScroll,
    });

    // Render help bar
    const helpLine = renderHelpBar(cols, { focusedPane, detailDocId });

    // Compose frame
    const outLines = [titleLine];
    for (let i = 0; i < paneH; i++) {
      const l = leftLines[i] || '';
      const c = centerLines[i] || '';
      const r = rightLines[i] || '';
      // Concatenate without extra separators (borders provided by each pane)
      // But we need to merge at boundaries: left's right border and center's left border would double up.
      // Solution: left and right panes use full-width box; center pane starts at leftW+1.
      // Since each pane draws its own borders, concatenation is:
      //   left's last char = '│' (right border)
      //   center's first char = '│' (left border) — this creates a doubled border
      // To avoid this: strip right border of left pane and left border of center pane.
      // Similarly strip right border of center and left border of right.
      // Instead, let's just concatenate and accept the shared border (it looks fine).
      outLines.push(l + c + r);
    }
    outLines.push(helpLine);

    // Write to terminal
    const output = CLEAR_SCREEN + outLines.join('\n');
    process.stdout.write(output);
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  function handleKey(key) {
    if (!_isOpen) return false;

    // Global keys
    if (key === 'q') {
      close();
      return 'quit';
    }

    if (key === '\x03') { // Ctrl+C
      close();
      return 'quit';
    }

    if (key === '\t') {
      // Cycle focus
      focusedPane = (focusedPane + 1) % 3;
      render();
      return true;
    }

    if (key === '\x1b' || key === '\x1b\x1b') {
      // ESC: close detail view or close TUI
      if (detailDocId) {
        detailDocId = null;
        detailScroll = 0;
        render();
        return true;
      }
      close();
      return true;
    }

    // Delegate to focused pane
    if (focusedPane === 0) return handleLeftKey(key);
    if (focusedPane === 1) return handleCenterKey(key);
    if (focusedPane === 2) return handleRightKey(key);

    return true;
  }

  function handleLeftKey(key) {
    const personas = ['engineer', 'design', 'product'];
    const advisorState = advisorStateRef ? advisorStateRef() : null;

    if (key === '\x1b[A' || key === 'k') {
      leftCursor = Math.max(0, leftCursor - 1);
      render();
      return true;
    }
    if (key === '\x1b[B' || key === 'j') {
      leftCursor = Math.min(personas.length - 1, leftCursor + 1);
      render();
      return true;
    }
    if (key === '\r' || key === '\n') {
      // Run now for selected persona
      const persona = personas[leftCursor];
      if (onRunAdvisorNow) onRunAdvisorNow(persona);
      render();
      return true;
    }
    if (key === 'p') {
      // Pause/resume selected persona
      const persona = personas[leftCursor];
      if (onPauseAdvisor) onPauseAdvisor(persona);
      render();
      return true;
    }

    // Scroll up/down
    if (key === '\x1b[5~') { leftScroll = Math.max(0, leftScroll - 5); render(); return true; }
    if (key === '\x1b[6~') { leftScroll += 5; render(); return true; }

    return true;
  }

  function handleCenterKey(key) {
    const tabs = 4;

    if (detailDocId) {
      // Detail view keys
      const logs = workerLogs.get(detailDocId) || [];
      if (key === '\x1b[A' || key === 'k') {
        detailScroll = Math.max(0, detailScroll - 1);
        render();
        return true;
      }
      if (key === '\x1b[B' || key === 'j') {
        detailScroll = Math.min(Math.max(0, logs.length - 5), detailScroll + 1);
        render();
        return true;
      }
      if (key === 't') { detailScroll = 0; render(); return true; }
      if (key === 'G') { detailScroll = Math.max(0, logs.length - 5); render(); return true; }
      return true;
    }

    // Tab switching: left/right arrows or h/l
    if (key === '\x1b[D' || key === 'h') {
      centerTab = (centerTab - 1 + tabs) % tabs;
      centerCursor = 0; centerScroll = 0;
      render();
      return true;
    }
    if (key === '\x1b[C' || key === 'l') {
      centerTab = (centerTab + 1) % tabs;
      centerCursor = 0; centerScroll = 0;
      render();
      return true;
    }

    // List navigation
    let entries = getTabEntries(centerTab);
    if (key === '\x1b[A' || key === 'k') {
      centerCursor = Math.max(0, centerCursor - 1);
      if (centerCursor < centerScroll) centerScroll = centerCursor;
      render();
      return true;
    }
    if (key === '\x1b[B' || key === 'j') {
      centerCursor = Math.min(Math.max(0, entries.length - 1), centerCursor + 1);
      render();
      return true;
    }

    // Enter — open detail view
    if (key === '\r' || key === '\n') {
      if (centerTab <= 1 && centerCursor < entries.length) {
        const docId = entries[centerCursor]?.docId;
        if (docId) {
          detailDocId = docId;
          const logs = workerLogs.get(docId) || [];
          detailScroll = Math.max(0, logs.length - 15);
          render();
        }
      }
      return true;
    }

    // Queue reorder (J/K)
    if (key === 'K' && centerTab === 2 && centerCursor > 0) {
      [queue[centerCursor - 1], queue[centerCursor]] = [queue[centerCursor], queue[centerCursor - 1]];
      centerCursor--;
      render();
      return true;
    }
    if (key === 'J' && centerTab === 2 && centerCursor < queue.length - 1) {
      [queue[centerCursor], queue[centerCursor + 1]] = [queue[centerCursor + 1], queue[centerCursor]];
      centerCursor++;
      render();
      return true;
    }

    // Pool size
    if (key === '+' || key === '=') return 'pool_up';
    if (key === '-') return 'pool_down';

    // Maintenance
    if (key === 'm') return 'maintenance';

    // Rekick
    if (key === 'r') { render(); return 'rekick'; }

    // Top/bottom
    if (key === 't') { centerCursor = 0; centerScroll = 0; render(); return true; }
    if (key === 'G') { centerCursor = Math.max(0, entries.length - 1); render(); return true; }

    return true;
  }

  function handleRightKey(key) {
    const tabs = 3;

    // Tab switching
    if (key === '\x1b[D' || key === 'h') {
      rightTab = (rightTab - 1 + tabs) % tabs;
      rightCursor = 0; rightScroll = 0;
      render();
      return true;
    }
    if (key === '\x1b[C' || key === 'l') {
      rightTab = (rightTab + 1) % tabs;
      rightCursor = 0; rightScroll = 0;
      render();
      return true;
    }

    // Navigation
    let maxItems = 0;
    if (rightTab === 0) maxItems = activeWorkers.size + pausedWorkers.size;
    if (rightTab === 1) maxItems = queue.length;

    if (key === '\x1b[A' || key === 'k') {
      rightCursor = Math.max(0, rightCursor - 1);
      render();
      return true;
    }
    if (key === '\x1b[B' || key === 'j') {
      rightCursor = Math.min(Math.max(0, maxItems - 1), rightCursor + 1);
      render();
      return true;
    }

    // Queue reorder (J/K)
    if (key === 'K' && rightTab === 1 && rightCursor > 0) {
      [queue[rightCursor - 1], queue[rightCursor]] = [queue[rightCursor], queue[rightCursor - 1]];
      rightCursor--;
      render();
      return true;
    }
    if (key === 'J' && rightTab === 1 && rightCursor < queue.length - 1) {
      [queue[rightCursor], queue[rightCursor + 1]] = [queue[rightCursor + 1], queue[rightCursor]];
      rightCursor++;
      render();
      return true;
    }

    // Pool size
    if (key === '+' || key === '=') return 'pool_up';
    if (key === '-') return 'pool_down';

    // Maintenance
    if (key === 'm') return 'maintenance';

    // Rekick
    if (key === 'r') { render(); return 'rekick'; }

    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getTabEntries(tab) {
    if (tab === 0) return [...activeWorkers.entries()].map(([docId]) => ({ docId }));
    if (tab === 1) return [...pausedWorkers.entries()].map(([docId]) => ({ docId }));
    if (tab === 2) return queue;
    if (tab === 3) return recentErrors || [];
    return [];
  }

  return {
    open,
    close,
    render,
    handleKey,
    get isOpen() { return _isOpen; },
  };
}
