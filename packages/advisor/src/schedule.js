// @docket/advisor — Schedule helpers (DK-195).
// Extracted from start-advisor.js for navigability.
//
// New "schedule" field: { timezone, allowedDays, windowStart, windowEnd }
// timezone: IANA string (e.g. "America/New_York")
// allowedDays: array of JS day integers (0=Sun, 1=Mon, ..., 6=Sat)
// windowStart / windowEnd: "HH:MM" 24-hour strings (e.g. "21:00", "06:00")
// Backward-compatible: if schedule is absent, falls back to allowedHours check.

/**
 * Parse an "HH:MM" string to total minutes (0–1439).
 * Returns -1 if invalid.
 */
export function parseMinutes(hhmm) {
  if (typeof hhmm !== 'string') return -1;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/**
 * Validate a schedule config object (DK-195).
 * @param {*} raw - raw value from Firestore
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSchedule(raw) {
  if (raw == null) return { valid: true, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['schedule must be an object'] };
  }
  const errors = [];
  const { timezone, allowedDays, windowStart, windowEnd } = raw;

  // Validate timezone (IANA string)
  if (typeof timezone !== 'string' || !timezone) {
    errors.push('schedule.timezone must be a non-empty string');
  } else {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      errors.push(`schedule.timezone is not a valid IANA timezone: "${timezone}"`);
    }
  }

  // Validate allowedDays: array of integers 0–6
  if (!Array.isArray(allowedDays)) {
    errors.push('schedule.allowedDays must be an array');
  } else {
    const invalid = allowedDays.filter(d => !Number.isInteger(d) || d < 0 || d > 6);
    if (invalid.length > 0) errors.push(`schedule.allowedDays contains invalid values: ${invalid.join(', ')}`);
  }

  // Validate windowStart / windowEnd: "HH:MM"
  if (parseMinutes(windowStart) === -1) {
    errors.push(`schedule.windowStart must be "HH:MM" (got ${windowStart})`);
  }
  if (parseMinutes(windowEnd) === -1) {
    errors.push(`schedule.windowEnd must be "HH:MM" (got ${windowEnd})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if the given timestamp falls within the schedule window (DK-195).
 * Uses Intl.DateTimeFormat with the stored IANA timezone — no dependencies needed.
 * Handles overnight windows (e.g. windowStart="21:00", windowEnd="06:00").
 * @param {{ timezone: string, allowedDays: number[], windowStart: string, windowEnd: string }} schedule
 * @param {Date} now
 * @returns {boolean}
 */
export function isWithinSchedule(schedule, now) {
  if (!schedule) return true;
  const { timezone, allowedDays, windowStart, windowEnd } = schedule;

  // Get local day-of-week and HH:MM in the persona's timezone using Intl
  let localDay, localMinutes;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    }).formatToParts(now);

    const dayStr = parts.find(p => p.type === 'weekday')?.value?.toLowerCase();
    const hourStr = parts.find(p => p.type === 'hour')?.value;
    const minStr  = parts.find(p => p.type === 'minute')?.value;

    // Intl weekday short: 'Sun','Mon','Tue','Wed','Thu','Fri','Sat'
    const WEEKDAY_TO_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    localDay = WEEKDAY_TO_INDEX[dayStr];
    if (localDay === undefined) return true; // defensive: skip check if parse fails

    const h = parseInt(hourStr, 10);
    const m = parseInt(minStr, 10);
    // hour12:false can yield '24' for midnight — normalize
    localMinutes = (h === 24 ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
  } catch {
    // If timezone is invalid or Intl fails, skip the check (log + run anyway)
    return true;
  }

  // Check day
  if (!allowedDays.includes(localDay)) return false;

  // Check time window (supports overnight: start > end)
  const s = parseMinutes(windowStart);
  const e = parseMinutes(windowEnd);
  if (s === -1 || e === -1) return true; // defensive

  if (s <= e) {
    return localMinutes >= s && localMinutes < e;
  } else {
    // Overnight: e.g. 21:00–06:00 → active from 21:00 to 23:59 and 00:00 to 05:59
    return localMinutes >= s || localMinutes < e;
  }
}

/**
 * Calculate milliseconds until the next schedule window opens (DK-195).
 * Walks forward in 1-minute increments up to 8 days. Returns 24h if nothing found.
 * @param {{ timezone: string, allowedDays: number[], windowStart: string, windowEnd: string }} schedule
 * @param {Date} now
 * @returns {number} milliseconds to wait
 */
export function msUntilScheduleOpen(schedule, now) {
  if (isWithinSchedule(schedule, now)) return 0;
  // Walk forward in 1-minute steps to find the exact window open moment
  const s = parseMinutes(schedule.windowStart);
  if (s === -1) return 24 * 3_600_000;

  // Jump to the next candidate start time to avoid scanning 11,520 minutes naively.
  // Try each day in the next 8 days, at windowStart.
  for (let d = 0; d < 8; d++) {
    const candidate = new Date(now.getTime() + d * 86_400_000);
    // Set to windowStart time in local timezone via a rough approach:
    // Walk the candidate forward to the start of windowStart hour:minute
    const startH = Math.floor(s / 60);
    const startM = s % 60;
    // Build a date string in the target timezone at the candidate day + window start
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: schedule.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(candidate);
      const year  = parts.find(p => p.type === 'year')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day   = parts.find(p => p.type === 'day')?.value;
      if (!year || !month || !day) continue;

      // Construct a timestamp string and parse it — this finds the UTC equivalent of
      // windowStart on that calendar day in the target timezone.
      const localStr = `${year}-${month}-${day}T${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`;
      // Use a trick: format a known UTC time to find the offset at that instant.
      // We approximate by checking the candidate offset: parse localStr as if UTC
      // then adjust by the actual offset at that point.
      const naive = new Date(localStr + 'Z'); // treat as UTC first
      const offsetMs = getTimezoneOffsetMs(schedule.timezone, naive);
      const windowOpenUtc = new Date(naive.getTime() - offsetMs);

      if (windowOpenUtc.getTime() > now.getTime() && isWithinSchedule(schedule, windowOpenUtc)) {
        return windowOpenUtc.getTime() - now.getTime();
      }
    } catch {
      // ignore parse errors for individual days
    }
  }
  return 24 * 3_600_000; // retry in 24h
}

/**
 * Get the UTC offset in milliseconds for a given IANA timezone at a given instant.
 * Positive = timezone is ahead of UTC (e.g. UTC+5 → +18,000,000ms).
 * @param {string} tz
 * @param {Date} date
 * @returns {number}
 */
export function getTimezoneOffsetMs(tz, date) {
  // Format the date in both UTC and the target timezone, compare
  const utcStr = new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
  const localStr = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
  // Parse both as if they were UTC to get the difference
  const parseAsUTC = (s) => {
    // en locale: "MM/DD/YYYY, HH:MM:SS"
    const [datePart, timePart] = s.split(', ');
    if (!datePart || !timePart) return NaN;
    const [mm, dd, yyyy] = datePart.split('/');
    return Date.UTC(+yyyy, +mm - 1, +dd, ...timePart.split(':').map(Number));
  };
  return parseAsUTC(localStr) - parseAsUTC(utcStr);
}
