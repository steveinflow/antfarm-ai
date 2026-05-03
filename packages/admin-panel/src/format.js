// @docket/admin-panel — formatting helpers (HTML escape, dates, durations, costs)

export function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

export function formatDateCompact(val) {
  if (!val) return '';
  const opts = {
    timeZone: 'America/New_York',
    month: 'numeric', day: 'numeric', year: '2-digit',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  };
  if (val.toDate) return val.toDate().toLocaleString('en-US', opts);
  const d = typeof val === 'string' ? new Date(val) : val;
  return isNaN(d) ? String(val) : d.toLocaleString('en-US', opts);
}

export function formatDate(val) {
  if (!val) return '';
  const opts = {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    timeZoneName: 'short',
  };
  // Firestore Timestamp
  if (val.toDate) return val.toDate().toLocaleString('en-US', opts);
  // ISO string or Date
  const d = typeof val === 'string' ? new Date(val) : val;
  return isNaN(d) ? String(val) : d.toLocaleString('en-US', opts);
}

export function formatDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatCost(usd) {
  if (usd == null || usd <= 0) return null;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Render a relative timestamp like "2 hours ago", "just now", etc.
 * @param {Date|object} val - Date, Firestore Timestamp, or ISO string
 * @returns {string}
 */
export function relativeTime(val) {
  if (!val) return '';
  let date;
  if (val && typeof val.toDate === 'function') {
    date = val.toDate();
  } else if (val instanceof Date) {
    date = val;
  } else {
    date = new Date(val);
  }
  if (isNaN(date)) return '';
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo} month${diffMo !== 1 ? 's' : ''} ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr} year${diffYr !== 1 ? 's' : ''} ago`;
}

/**
 * Get the ISO datetime string from a Firestore Timestamp or Date or string.
 * Used for <time datetime="..."> elements.
 */
export function toISOString(val) {
  if (!val) return '';
  if (val && typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
}
