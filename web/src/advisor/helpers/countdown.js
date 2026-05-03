// Next-run countdown helpers — DK-303.
// Prefer the orchestrator-written nextRunAt when available; fall back to
// computing from lastRunAt + interval for older records.

import { toDate } from '../ui/format.js';

/**
 * Compute the next scheduled run as a relative countdown string.
 * Per spec (DK-303): read nextRunAt directly from Firestore — orchestrator writes it.
 * Falls back to computing from lastRunAt + interval when nextRunAt is unavailable.
 * Returns strings like "in 3h 20m", "in 45m", "soon" (past due), or null if no data.
 *
 * @param {string|object|null} nextRunAt - Firestore nextRunAt Timestamp or ISO string
 * @param {string|object|null} lastRunAt - Firestore Timestamp or ISO string (fallback)
 * @param {number|null} intervalHours - run interval in hours (ignored if intervalMinutes set)
 * @param {number|null} [intervalMinutes] - run interval in minutes (takes priority over intervalHours)
 * @returns {string|null}
 */
export function computeNextRunCountdown(nextRunAt, lastRunAt, intervalHours, intervalMinutes) {
  // Prefer Firestore nextRunAt (written by orchestrator per DK-303 spec)
  const nextDate = toDate(nextRunAt);
  if (nextDate) {
    const remaining = nextDate.getTime() - Date.now();
    if (remaining <= 0) return 'soon';
    const totalMins = Math.floor(remaining / 60_000);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  }
  // Fallback: compute from lastRunAt + interval
  return _computeNextRunCountdownLegacy(lastRunAt, intervalHours, intervalMinutes);
}

/** Legacy countdown computation from lastRunAt + interval (fallback). */
export function _computeNextRunCountdownLegacy(lastRunAt, intervalHours, intervalMinutes) {
  const intervalMs = (intervalMinutes != null && intervalMinutes > 0)
    ? intervalMinutes * 60_000
    : (intervalHours ? intervalHours * 3600_000 : null);
  if (!lastRunAt || !intervalMs) return null;
  const lastDate = toDate(lastRunAt);
  if (!lastDate) return null;
  const nextMs = lastDate.getTime() + intervalMs;
  const remaining = nextMs - Date.now();
  if (remaining <= 0) return 'soon';
  const totalMins = Math.floor(remaining / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}
