// Pure formatting helpers used by AdvisorPanel views.
// Converts Firestore Timestamps / ISO strings / Dates to display strings.

/** Convert a Firestore Timestamp or Date-like value to a JS Date. */
export function toDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  // Firestore Timestamp (has .toDate())
  if (typeof val.toDate === 'function') return val.toDate();
  // ISO string or number
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a Firestore Timestamp or ISO string to milliseconds since epoch.
 * Returns 0 when unresolvable.
 */
export function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Compute a UTC ISO string for N days ago from now. */
export function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export function formatCountdown(isoStr) {
  if (!isoStr) return null;
  const ms = new Date(isoStr).getTime() - Date.now();
  if (ms <= 0) return 'soon';
  const totalMins = Math.floor(ms / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatRelative(isoStr) {
  if (!isoStr) return null;
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Format a UTC hour integer (0–23) as 12-hour local time label.
 * e.g., 9 → "9:00 AM", 18 → "6:00 PM"
 */
export function formatHour12(utcHour) {
  // Create a UTC date for today at that hour, then format in local time
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Format durationMs (already rounded to nearest second) as a human string. */
export function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Format a relative timestamp from a Firestore Timestamp or Date. */
export function formatRelativeTs(val) {
  const d = toDate(val);
  if (!d) return null;
  return formatRelative(d.toISOString());
}

/** Format an absolute datetime for aria-label / title attributes. */
export function formatAbsolute(val) {
  const d = toDate(val);
  if (!d) return '';
  return d.toLocaleString();
}

/**
 * Build a summary line for the last run, per the DK-303 spec.
 * Format: "Last run 2h ago — 2 tickets created" or "Never run"
 */
export function formatLastRunLine(lastRunAt, lastRunTicketCount) {
  if (!lastRunAt) return 'Never run';
  const ago = formatRelativeTs(lastRunAt);
  const ticketPart = lastRunTicketCount != null
    ? ` — ${lastRunTicketCount} ticket${lastRunTicketCount === 1 ? '' : 's'} created`
    : '';
  return `Last run ${ago || 'recently'}${ticketPart}`;
}
