// @docket/advisor — Legacy "allowedHours" time-window helpers (DK-303).
// Extracted from start-advisor.js for navigability.
//
// Validates allowedHours config from Firestore before use.
// Returns true if valid, false and logs a warning if not.

const VALID_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

// Day abbreviation to JS Date.getUTCDay() index (0=Sun, 1=Mon, ...)
// eslint-disable-next-line no-unused-vars
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Validate an allowedHours config object.
 * @param {*} raw - raw value from Firestore
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAllowedHours(raw) {
  if (raw == null) return { valid: true, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['allowedHours must be an object'] };
  }
  const errors = [];
  const { start, end, days } = raw;
  if (!Number.isInteger(start) || start < 0 || start > 23) {
    errors.push(`allowedHours.start must be integer 0–23 (got ${start})`);
  }
  if (!Number.isInteger(end) || end < 0 || end > 23) {
    errors.push(`allowedHours.end must be integer 0–23 (got ${end})`);
  }
  if (!Array.isArray(days)) {
    errors.push('allowedHours.days must be an array');
  } else {
    const invalid = days.filter(d => !VALID_DAYS.has(d));
    if (invalid.length > 0) errors.push(`allowedHours.days contains invalid values: ${invalid.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Check if the given UTC timestamp falls within the allowedHours window.
 * Handles overnight windows (e.g., start=22, end=06 wraps across midnight).
 * @param {{ start: number, end: number, days: string[] }} allowedHours - validated config
 * @param {Date} nowUtc - current UTC time
 * @returns {boolean}
 */
export function isWithinWindow(allowedHours, nowUtc) {
  const utcDay = nowUtc.getUTCDay(); // 0=Sun ... 6=Sat
  const utcHour = nowUtc.getUTCHours();
  const { start, end, days } = allowedHours;

  // Check if today's day abbreviation is in the allowed set
  const todayAbbr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][utcDay];
  if (!days.includes(todayAbbr)) return false;

  if (start <= end) {
    // Normal window (e.g., 9–18): hour must be in [start, end)
    return utcHour >= start && utcHour < end;
  } else {
    // Overnight window (e.g., 22–06): hour >= start OR hour < end
    return utcHour >= start || utcHour < end;
  }
}

/**
 * Calculate milliseconds until the next window opens.
 * Scans forward up to 7 days to find the next open slot.
 * @param {{ start: number, end: number, days: string[] }} allowedHours - validated config
 * @param {Date} nowUtc - current UTC time
 * @returns {number} milliseconds to wait (0 if already in window)
 */
export function msUntilWindowOpen(allowedHours, nowUtc) {
  if (isWithinWindow(allowedHours, nowUtc)) return 0;
  // eslint-disable-next-line no-unused-vars
  const { start, days } = allowedHours;
  // Try each hour slot up to 7*24 hours ahead
  for (let h = 1; h <= 7 * 24; h++) {
    const candidate = new Date(nowUtc.getTime() + h * 3_600_000);
    if (isWithinWindow(allowedHours, candidate)) return h * 3_600_000;
  }
  // No window found in next 7 days — shouldn't happen with valid config
  return 24 * 3_600_000; // retry in 24h
}
