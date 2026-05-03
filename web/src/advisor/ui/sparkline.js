// Sparkline + acceptance-rate helpers for the performance dashboard.
// Bucket tickets into per-week acceptance rates and render as inline SVG.

import { toMs } from './format.js';
import { ACCEPTED_STATUSES, REJECTED_STATUSES } from '../config/statuses.js';

/**
 * Aggregate tickets into per-week acceptance rate buckets for the sparkline.
 * Returns an array of rate values (0–1) per week, oldest first.
 * Weeks with no tickets produce null (displayed as gap).
 *
 * @param {Array<{status: string, createdAt: *}>} tickets
 * @param {number} windowDays - 30 or 90
 * @returns {Array<number|null>}
 */
export function computeSparkline(tickets, windowDays) {
  const numWeeks = Math.ceil(windowDays / 7);
  const buckets = Array.from({ length: numWeeks }, () => ({ accepted: 0, total: 0 }));
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  for (const t of tickets) {
    const ms = toMs(t.createdAt);
    if (!ms) continue;
    const age = now - ms;
    if (age < 0 || age > windowMs) continue;
    // Which week bucket? Week 0 = oldest
    const weekIdx = numWeeks - 1 - Math.floor(age / (7 * 24 * 60 * 60 * 1000));
    const idx = Math.max(0, Math.min(numWeeks - 1, weekIdx));
    buckets[idx].total++;
    if (ACCEPTED_STATUSES.has(t.status)) buckets[idx].accepted++;
  }

  return buckets.map(b => b.total === 0 ? null : b.accepted / b.total);
}

/**
 * Compute aggregate stats from a list of tickets.
 * @returns {{ generated: number, accepted: number, rejected: number, snoozed: number, proposed: number }}
 */
export function computeStats(tickets) {
  let accepted = 0, rejected = 0, snoozed = 0, proposed = 0;
  for (const t of tickets) {
    if (ACCEPTED_STATUSES.has(t.status)) accepted++;
    else if (REJECTED_STATUSES.has(t.status)) rejected++;
    else if (t.status === 'proposed') proposed++;
    // snoozed: not an explicit status in this system, but if ever added it would go here
  }
  return {
    generated: tickets.length,
    accepted,
    rejected,
    snoozed: 0, // placeholder — no snoozed status exists yet
    proposed,
  };
}

/**
 * Determine the acceptance rate health category.
 * >50% → green, 20–50% → yellow, <20% → red.
 * @param {number} rate 0–1
 * @returns {'green'|'yellow'|'red'}
 */
export function healthFromRate(rate) {
  if (rate > 0.5) return 'green';
  if (rate >= 0.2) return 'yellow';
  return 'red';
}

/**
 * Build an SVG sparkline from rate values.
 * Null values produce a gap (no bar).
 *
 * @param {Array<number|null>} rates - 0–1 values or null
 * @param {string} ariaLabel - accessible description
 * @returns {SVGElement}
 */
export function buildSparklineSvg(rates, ariaLabel) {
  const W = 120, H = 28;
  const barW = Math.max(2, Math.floor((W - rates.length) / rates.length));
  const gap = 1;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-label', ariaLabel);
  svg.setAttribute('role', 'img');
  svg.setAttribute('class', 'adv-sparkline');

  // Baseline
  const baseline = document.createElementNS(svgNS, 'line');
  baseline.setAttribute('x1', '0');
  baseline.setAttribute('y1', String(H - 1));
  baseline.setAttribute('x2', String(W));
  baseline.setAttribute('y2', String(H - 1));
  baseline.setAttribute('class', 'adv-sparkline-baseline');
  svg.appendChild(baseline);

  rates.forEach((rate, i) => {
    if (rate === null) return; // gap for empty weeks
    const x = i * (barW + gap);
    const barH = Math.max(2, Math.round(rate * (H - 4)));
    const y = H - barH - 1;
    const color = rate > 0.5 ? 'adv-sparkline-bar-green'
      : rate >= 0.2 ? 'adv-sparkline-bar-yellow'
      : 'adv-sparkline-bar-red';
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(barH));
    rect.setAttribute('class', `adv-sparkline-bar ${color}`);
    svg.appendChild(rect);
  });

  return svg;
}

/**
 * Build an accessible description of a sparkline for screen readers.
 */
export function buildSparklineAriaLabel(rates, windowDays) {
  const validRates = rates.filter(r => r !== null);
  if (validRates.length === 0) return `Acceptance rate data unavailable over ${windowDays} days`;
  const first = Math.round((validRates[0] ?? 0) * 100);
  const last = Math.round((validRates[validRates.length - 1] ?? 0) * 100);
  const trend = last > first ? 'increased' : last < first ? 'decreased' : 'remained stable';
  return `Acceptance rate ${trend} from ${first}% to ${last}% over ${windowDays} days`;
}
