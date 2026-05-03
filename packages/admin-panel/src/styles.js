// @docket/admin-panel — CSS styles
// All classes prefixed with tk- for isolation.
// Themeable via CSS custom properties.
//
// Per-component CSS chunks live in ./styles/. This file composes them in original order.

import { resetCss } from './styles/reset.css.js';
import { buttonsCss } from './styles/buttons.css.js';
import { formCss } from './styles/form.css.js';
import { filtersCss } from './styles/filters.css.js';
import { ticketCss } from './styles/ticket.css.js';
import { lightboxToastCss } from './styles/lightbox-toast.css.js';
import { rejectionCss } from './styles/rejection.css.js';
import { evidenceCss } from './styles/evidence.css.js';
import { runLogCss } from './styles/run-log.css.js';
import { snoozeCss } from './styles/snooze.css.js';

export function getStyles() {
  return '\n' + (
    resetCss + '\n' + buttonsCss + '\n' + formCss + '\n' + filtersCss + '\n' + ticketCss + '\n' + lightboxToastCss + '\n' + rejectionCss + '\n' + evidenceCss + '\n' + runLogCss + '\n' + snoozeCss + '\n' + `/* --- Changelog modal --- */
.tk-changelog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tk-changelog-modal {
  background: var(--tk-bg);
  color: var(--tk-text);
  border-radius: var(--tk-radius);
  border: 1px solid var(--tk-border);
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  width: min(600px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tk-changelog-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--tk-border);
  flex-shrink: 0;
}

.tk-changelog-modal-title {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0;
}

.tk-changelog-modal-body {
  overflow-y: auto;
  padding: 16px 20px;
  flex: 1;
}

.tk-changelog-version-group {
  margin-bottom: 20px;
}

.tk-changelog-version-heading {
  font-size: 0.85rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--tk-text-secondary);
  margin: 0 0 8px 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--tk-border);
  display: flex;
  align-items: center;
  gap: 8px;
}

.tk-changelog-version-tag {
  display: inline-flex;
  align-items: center;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e8f5e9;
  color: #2e7d32;
}

.tk-theme-dark .tk-changelog-version-tag {
  background: #1b3a1b;
  color: #81c784;
}

.tk-changelog-ticket-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 0;
  font-size: 0.875rem;
  line-height: 1.4;
}

.tk-changelog-ticket-id {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--tk-text-secondary);
  white-space: nowrap;
  margin-top: 2px;
  flex-shrink: 0;
}

.tk-changelog-ticket-title {
  color: var(--tk-text);
  flex: 1;
}

.tk-changelog-ticket-status {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 2px 6px;
  border-radius: 999px;
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 2px;
}

.tk-changelog-ticket-status-done {
  background: #e3f2fd;
  color: #1565c0;
}

.tk-changelog-ticket-status-verified {
  background: #e8f5e9;
  color: #2e7d32;
}

.tk-theme-dark .tk-changelog-ticket-status-done {
  background: #1a2e44;
  color: #64b5f6;
}

.tk-theme-dark .tk-changelog-ticket-status-verified {
  background: #1b3a1b;
  color: #81c784;
}

.tk-changelog-ticket-date {
  font-size: 0.68rem;
  color: var(--tk-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 2px;
}

.tk-changelog-empty {
  color: var(--tk-text-secondary);
  font-size: 0.875rem;
  text-align: center;
  padding: 24px 0;
}

/* --- Token Spend modal --- */
.tk-token-spend-modal {
  width: min(760px, 96vw);
}

.tk-token-spend-range-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--tk-border);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.tk-token-spend-range-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--tk-text-secondary);
  white-space: nowrap;
}

.tk-token-spend-range-btn {
  background: none;
  border: 1px solid var(--tk-border);
  border-radius: 999px;
  color: var(--tk-text-secondary);
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 500;
  padding: 3px 12px;
  transition: background var(--tk-transition), color var(--tk-transition), border-color var(--tk-transition);
}

.tk-token-spend-range-btn:hover {
  border-color: var(--tk-primary);
  color: var(--tk-primary);
}

.tk-token-spend-range-btn.tk-active {
  background: var(--tk-primary);
  border-color: var(--tk-primary);
  color: #fff;
}

.tk-token-spend-summary {
  display: flex;
  gap: 24px;
  padding: 14px 0 16px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--tk-border);
  margin-bottom: 12px;
}

.tk-token-spend-summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 80px;
}

.tk-token-spend-summary-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--tk-text-secondary);
}

.tk-token-spend-summary-value {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--tk-text);
}

.tk-token-spend-cost {
  color: #2e7d32;
}

.tk-theme-dark .tk-token-spend-cost {
  color: #81c784;
}

.tk-token-spend-table-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 6px;
  border-bottom: 1px solid var(--tk-border);
  margin-bottom: 4px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--tk-text-secondary);
}

.tk-token-spend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 0.875rem;
  border-bottom: 1px solid var(--tk-border);
  line-height: 1.4;
}

.tk-token-spend-row:last-child {
  border-bottom: none;
}

.tk-token-spend-col-id {
  flex: 0 0 60px;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--tk-text-secondary);
  white-space: nowrap;
}

.tk-token-spend-col-title {
  flex: 1;
  color: var(--tk-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-token-spend-col-cost {
  flex: 0 0 120px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tk-token-spend-cost-label {
  font-weight: 600;
  color: #2e7d32;
  font-size: 0.85rem;
}

.tk-theme-dark .tk-token-spend-cost-label {
  color: #81c784;
}

.tk-token-spend-bar-wrap {
  height: 4px;
  background: var(--tk-border);
  border-radius: 2px;
  overflow: hidden;
  display: block;
}

.tk-token-spend-bar {
  display: block;
  height: 100%;
  background: #4caf50;
  border-radius: 2px;
  min-width: 2px;
}

.tk-theme-dark .tk-token-spend-bar {
  background: #66bb6a;
}

.tk-token-spend-col-duration {
  flex: 0 0 80px;
  color: var(--tk-text-secondary);
  font-size: 0.8rem;
  white-space: nowrap;
}

.tk-token-spend-col-status {
  flex: 0 0 64px;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 2px 6px;
  border-radius: 999px;
  white-space: nowrap;
  text-align: center;
  background: var(--tk-bg-secondary);
  color: var(--tk-text-secondary);
}

.tk-token-spend-status-done {
  background: #e3f2fd;
  color: #1565c0;
}

.tk-token-spend-status-verified {
  background: #e8f5e9;
  color: #2e7d32;
}

.tk-theme-dark .tk-token-spend-status-done {
  background: #1a2e44;
  color: #64b5f6;
}

.tk-theme-dark .tk-token-spend-status-verified {
  background: #1b3a1b;
  color: #81c784;
}

/* --- Claude Plan Usage section (inside token spend dialog) --- */

.tk-plan-usage-section {
  padding: 12px 16px;
  border-bottom: 1px solid var(--tk-border);
  background: var(--tk-bg);
}

.tk-plan-usage-title {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--tk-text-secondary);
  margin-bottom: 10px;
}

.tk-plan-usage-unavailable {
  font-size: 0.8rem;
  color: var(--tk-text-secondary);
  margin: 0;
  padding: 0;
  line-height: 1.4;
}

.tk-plan-usage-unavailable code {
  font-family: monospace;
  background: var(--tk-input-bg);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.78rem;
}

.tk-plan-usage-content {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.tk-plan-usage-bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tk-plan-bar-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tk-plan-bar-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.78rem;
}

.tk-plan-bar-name {
  color: var(--tk-text);
  font-weight: 500;
}

.tk-plan-bar-pct {
  color: var(--tk-text-secondary);
  font-size: 0.73rem;
}

.tk-plan-pct-danger {
  color: #d32f2f;
  font-weight: 700;
}

.tk-theme-dark .tk-plan-pct-danger {
  color: #ef9a9a;
}

.tk-plan-bar-track {
  height: 8px;
  background: var(--tk-input-bg, #f0f0f0);
  border-radius: 4px;
  overflow: hidden;
}

.tk-theme-dark .tk-plan-bar-track {
  background: #2a2a2a;
}

.tk-plan-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.tk-plan-bar-ok {
  background: #43a047;
}

.tk-plan-bar-warn {
  background: #fb8c00;
}

.tk-plan-bar-danger {
  background: #d32f2f;
}

.tk-theme-dark .tk-plan-bar-ok {
  background: #66bb6a;
}

.tk-theme-dark .tk-plan-bar-warn {
  background: #ffa726;
}

.tk-theme-dark .tk-plan-bar-danger {
  background: #ef5350;
}

.tk-plan-usage-checked-at {
  font-size: 0.7rem;
  color: var(--tk-text-secondary);
  margin: 6px 0 0;
  opacity: 0.75;
}

/* --- Token Spend time-series charts --- */

.tk-ts-charts-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px 0 16px;
  border-bottom: 1px solid var(--tk-border);
  margin-bottom: 12px;
}

.tk-ts-chart-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tk-ts-chart-title {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--tk-text-secondary);
}

.tk-ts-chart {
  width: 100%;
  height: auto;
}

/* SVG chart primitives */
.tk-ts-grid {
  stroke: var(--tk-border);
  stroke-width: 1;
}

.tk-ts-axis {
  stroke: var(--tk-border);
  stroke-width: 1.5;
}

.tk-ts-label {
  font-size: 9px;
  fill: var(--tk-text-secondary);
  font-family: inherit;
}

.tk-ts-bar {
  fill: #4caf50;
  opacity: 0.85;
  transition: opacity 0.15s;
}

.tk-ts-bar:hover {
  opacity: 1;
}

.tk-theme-dark .tk-ts-bar {
  fill: #66bb6a;
}

.tk-ts-line {
  fill: none;
  stroke: #1976d2;
  stroke-width: 1.8;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.tk-theme-dark .tk-ts-line {
  stroke: #64b5f6;
}

.tk-ts-area {
  fill: #1976d2;
  opacity: 0.08;
}

.tk-theme-dark .tk-ts-area {
  fill: #64b5f6;
  opacity: 0.1;
}

.tk-ts-dot {
  fill: #1976d2;
  stroke: var(--tk-bg);
  stroke-width: 1.5;
}

.tk-theme-dark .tk-ts-dot {
  fill: #64b5f6;
}

.tk-ts-scatter-stem {
  stroke: #4caf50;
  stroke-width: 1.5;
  opacity: 0.6;
}

.tk-theme-dark .tk-ts-scatter-stem {
  stroke: #66bb6a;
}

.tk-ts-scatter-dot {
  fill: #4caf50;
  stroke: var(--tk-bg);
  stroke-width: 1.5;
  opacity: 0.9;
  transition: opacity 0.15s, r 0.15s;
  cursor: default;
}

.tk-ts-scatter-dot:hover {
  opacity: 1;
}

.tk-theme-dark .tk-ts-scatter-dot {
  fill: #66bb6a;
}
` + '\n' + `/* --- Feedback widget --- */

/* Container sits below evidence, above timeline */
.tk-feedback-widget {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 6px 0;
  flex-wrap: wrap;
  /* Hidden by default on non-hovered cards; revealed on focus/hover via parent */
  opacity: 0.45;
  transition: opacity var(--tk-transition);
}

/* Show at full opacity when the ticket card is hovered or keyboard-focused-within */
.tk-ticket-item:hover .tk-feedback-widget,
.tk-ticket-item:focus-within .tk-feedback-widget {
  opacity: 1;
}

.tk-feedback-prompt {
  font-size: 0.8em;
  color: var(--tk-text-secondary);
  white-space: nowrap;
}

.tk-feedback-buttons {
  display: inline-flex;
  gap: 4px;
}

/* Base button style — ghost/outline */
.tk-feedback-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--tk-border);
  border-radius: 999px;
  background: transparent;
  color: var(--tk-text-secondary);
  font-size: 0.78em;
  font-family: var(--tk-font);
  cursor: pointer;
  transition: background var(--tk-transition), color var(--tk-transition), border-color var(--tk-transition);
  line-height: 1.4;
}

.tk-feedback-btn:hover {
  background: var(--tk-bg-secondary);
  color: var(--tk-text);
  border-color: var(--tk-primary);
}

/* Keyboard focus — visible focus ring (WCAG 2.2 §2.4.11) */
.tk-feedback-btn:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
}

/* Selected state — filled style so it's distinguishable without color alone */
.tk-feedback-btn.tk-feedback-selected {
  font-weight: 600;
}

.tk-feedback-up.tk-feedback-selected {
  background: #e8f5e9;
  border-color: var(--tk-success);
  color: var(--tk-success);
}

.tk-feedback-down.tk-feedback-selected {
  background: #fdecea;
  border-color: var(--tk-danger);
  color: var(--tk-danger);
}

.tk-theme-dark .tk-feedback-up.tk-feedback-selected {
  background: #1b3a1b;
  border-color: var(--tk-success);
  color: var(--tk-success);
}

.tk-theme-dark .tk-feedback-down.tk-feedback-selected {
  background: #3a1b1b;
  border-color: var(--tk-danger);
  color: var(--tk-danger);
}

.tk-feedback-icon {
  font-size: 1em;
  line-height: 1;
}

.tk-feedback-label {
  /* Always visible — do not hide label (needed for accessibility + non-color distinction) */
}

/* First-use nudge */
.tk-feedback-nudge {
  font-size: 0.78em;
  color: var(--tk-text-secondary);
  font-style: italic;
  transition: opacity 0.4s ease;
}

.tk-feedback-nudge-hidden {
  opacity: 0;
  pointer-events: none;
}

/* --- Advisor attribution --- */
.tk-advisor-attribution-row {
  margin-top: 4px;
  margin-bottom: 8px;
}

.tk-advisor-attribution {
  font-size: 0.78rem;
  color: var(--tk-text-secondary);
}

.tk-advisor-attribution-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--tk-accent, #6366f1);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.tk-advisor-attribution-link:hover {
  color: var(--tk-accent-hover, #4f46e5);
}

/* --- Responsive --- */
@media (max-width: 600px) {
  .tk-ticket-header {
    gap: 6px;
  }
  .tk-filter-tabs {
    overflow-x: auto;
    flex-wrap: nowrap;
  }
  .tk-token-spend-col-duration,
  .tk-token-spend-col-status {
    display: none;
  }
  .tk-token-spend-table-header .tk-token-spend-col-duration,
  .tk-token-spend-table-header .tk-token-spend-col-status {
    display: none;
  }
}
` + '\n' + `/* ==========================================================
   DK-142 — Dependency & relationship linking
   ========================================================== */

/* ── Links badge (card header) ─────────────────────────────── */
.tk-links-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 3px;
  vertical-align: middle;
}

.tk-links-badge-part {
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--tk-tag-bg);
  color: var(--tk-tag-text);
  white-space: nowrap;
  font-size: 11px;
}

.tk-links-badge-blocks {
  background: #fef3cd;
  color: #856404;
}
.tk-root.tk-theme-dark .tk-links-badge-blocks {
  background: #3a2d00;
  color: #ffcc44;
}

.tk-links-badge-related {
  background: var(--tk-tag-bg);
  color: var(--tk-tag-text);
}

.tk-links-badge-followup {
  background: #d4edda;
  color: #155724;
}
.tk-root.tk-theme-dark .tk-links-badge-followup {
  background: #0a2e16;
  color: #66bb6a;
}

/* ── Links section (detail view) ──────────────────────────── */
.tk-links-section {
  margin: 8px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

.tk-links-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  border: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--tk-text);
  font-family: var(--tk-font);
  transition: background var(--tk-transition);
}
.tk-links-toggle:hover {
  background: var(--tk-border);
}
.tk-links-toggle:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}

.tk-links-toggle-icon {
  font-size: 10px;
  color: var(--tk-text-secondary);
}

.tk-links-toggle-count {
  font-size: 12px;
  color: var(--tk-text-secondary);
  font-weight: 400;
}

.tk-links-content {
  display: none;
  padding: 12px;
  border-top: 1px solid var(--tk-border);
  background: var(--tk-bg);
}

.tk-links-content.tk-links-content-open {
  display: block;
}

.tk-links-empty {
  color: var(--tk-text-secondary);
  font-size: 13px;
  font-style: italic;
}

.tk-link-group {
  margin-bottom: 12px;
}
.tk-link-group:last-child {
  margin-bottom: 0;
}

.tk-link-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--tk-text-secondary);
  margin-bottom: 6px;
}

.tk-link-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tk-link-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--tk-bg-secondary);
}

.tk-link-item-id {
  font-weight: 600;
  font-size: 12px;
  color: var(--tk-primary);
  white-space: nowrap;
}

.tk-link-item-title {
  flex: 1;
  color: var(--tk-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-link-remove-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--tk-text-secondary);
  font-size: 14px;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 1;
  transition: color var(--tk-transition);
}
.tk-link-remove-btn:hover {
  color: var(--tk-danger);
}
.tk-link-remove-btn:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
}

/* ── Link Proposals button ──────────────────────────────── */
.tk-link-proposals-container {
  position: relative;
  margin-top: 8px;
}

.tk-link-proposals-btn {
  font-size: 12px;
}

/* ── Link Proposals popover ─────────────────────────────── */
.tk-link-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 300;
  background: var(--tk-bg);
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  box-shadow: var(--tk-shadow-lg);
  padding: 12px;
  width: 340px;
  max-width: calc(100vw - 32px);
}

.tk-link-popover-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--tk-text);
  margin-bottom: 10px;
}

.tk-link-popover-cancel {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--tk-text-secondary);
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}
.tk-link-popover-cancel:hover {
  background: var(--tk-bg-secondary);
  color: var(--tk-text);
}
.tk-link-popover-cancel:focus-visible {
  outline: 2px solid var(--tk-primary);
}

.tk-link-type-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}

.tk-link-type-row label {
  color: var(--tk-text-secondary);
  white-space: nowrap;
}

.tk-link-type-select {
  flex: 1;
  padding: 4px 6px;
  border: 1px solid var(--tk-border);
  border-radius: 4px;
  background: var(--tk-bg);
  color: var(--tk-text);
  font-size: 13px;
  font-family: var(--tk-font);
}
.tk-link-type-select:focus {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
  border-color: var(--tk-primary);
}

.tk-link-search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--tk-border);
  border-radius: 6px;
  background: var(--tk-bg-secondary);
  color: var(--tk-text);
  font-size: 13px;
  font-family: var(--tk-font);
  margin-bottom: 8px;
}
.tk-link-search-input:focus {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
  border-color: var(--tk-primary);
  background: var(--tk-bg);
}

.tk-link-results {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--tk-border);
  border-radius: 6px;
  background: var(--tk-bg);
}

.tk-link-results-empty {
  padding: 12px;
  color: var(--tk-text-secondary);
  font-size: 13px;
  text-align: center;
}

.tk-link-result-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 13px;
  border-bottom: 1px solid var(--tk-border);
  transition: background var(--tk-transition);
}
.tk-link-result-item:last-child {
  border-bottom: none;
}
.tk-link-result-item:hover,
.tk-link-result-item:focus {
  background: var(--tk-bg-secondary);
  outline: none;
}
.tk-link-result-item:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}
.tk-link-result-item[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}
.tk-link-result-item.tk-link-result-item-loading {
  opacity: 0.6;
}

.tk-link-result-id {
  font-weight: 600;
  color: var(--tk-primary);
  font-size: 12px;
  white-space: nowrap;
}

.tk-link-result-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tk-text);
}

/* ── Blocker accept-flow warning ──────────────────────────── */
.tk-blocker-warning-container {
  display: contents;
}

.tk-blocker-warning {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #fff3cd;
  border: 1px solid #ffc107;
  border-radius: 6px;
  font-size: 13px;
  margin-top: 4px;
  width: 100%;
}
.tk-root.tk-theme-dark .tk-blocker-warning {
  background: #3a2d00;
  border-color: #ffb74d;
}

.tk-blocker-warning-text {
  flex: 1;
  min-width: 200px;
  color: var(--tk-text);
}

/* ── Dependency filter chips ──────────────────────────────── */
.tk-dep-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 4px;
  font-size: 13px;
}

.tk-dep-filter-label {
  color: var(--tk-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.tk-dep-filter-chip {
  padding: 3px 10px;
  border-radius: 12px;
  border: 1px solid var(--tk-border);
  background: var(--tk-bg-secondary);
  color: var(--tk-text-secondary);
  font-size: 12px;
  cursor: pointer;
  font-family: var(--tk-font);
  transition: all var(--tk-transition);
}
.tk-dep-filter-chip:hover {
  border-color: var(--tk-primary);
  color: var(--tk-primary);
}
.tk-dep-filter-chip.tk-active,
.tk-dep-filter-chip[aria-pressed="true"] {
  background: var(--tk-primary);
  border-color: var(--tk-primary);
  color: #fff;
}
.tk-dep-filter-chip:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
}
` + '\n' + `/* ==========================================================
   DK-113 — Cross-persona convergence highlighting
   ========================================================== */

/* ── Convergence badge (card header) ──────────────────────── */
.tk-convergence-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  background: #ede9fe;
  color: #5b21b6;
  white-space: nowrap;
  vertical-align: middle;
  letter-spacing: 0.01em;
}
.tk-root.tk-theme-dark .tk-convergence-badge {
  background: #2e1065;
  color: #c4b5fd;
}

/* ── Convergence section (detail view) ────────────────────── */
.tk-convergence-section {
  margin: 8px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

.tk-convergence-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  font-family: var(--tk-font);
  color: var(--tk-text);
  text-align: left;
  transition: background var(--tk-transition);
}
.tk-convergence-toggle:hover {
  background: var(--tk-bg);
}
.tk-convergence-toggle:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}
.tk-convergence-toggle-icon {
  font-size: 11px;
  color: var(--tk-text-secondary);
  flex-shrink: 0;
}

.tk-convergence-content {
  display: none;
  padding: 0 12px 10px;
  background: var(--tk-bg);
}
.tk-convergence-content.tk-convergence-content-open {
  display: block;
}

.tk-convergence-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tk-convergence-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.tk-convergence-item-link {
  color: var(--tk-primary);
  text-decoration: none;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
.tk-convergence-item-link:hover {
  text-decoration: underline;
}
.tk-convergence-item-link:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
  border-radius: 2px;
}

.tk-convergence-item-id {
  font-family: monospace;
  font-size: 12px;
}

.tk-convergence-item-summary {
  color: var(--tk-text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

/* ── Sort control ─────────────────────────────────────────── */
.tk-sort-control {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.tk-sort-label {
  color: var(--tk-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.tk-sort-select {
  padding: 3px 8px;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  font-size: 12px;
  font-family: var(--tk-font);
  cursor: pointer;
}
.tk-sort-select:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
}
.tk-root.tk-theme-dark .tk-sort-select {
  background: var(--tk-bg-secondary);
  border-color: var(--tk-border);
}
` + '\n' + `/* ==========================================================
   DK-126 — Cross-persona consensus transparency
   ========================================================== */

/* ── Consensus badge (card header, list view) ────────────── */
.tk-consensus-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  vertical-align: middle;
  letter-spacing: 0.01em;
  /* Two-tone: shape + color so color-blind users can distinguish states */
}
/* Full agreement — both approved */
.tk-consensus-badge.tk-consensus-agree {
  background: #dcfce7;
  color: #15803d;
  border: 1px solid #bbf7d0;
}
.tk-root.tk-theme-dark .tk-consensus-badge.tk-consensus-agree {
  background: #14532d;
  color: #86efac;
  border-color: #166534;
}
/* Partial — one flagged */
.tk-consensus-badge.tk-consensus-partial {
  background: #fef9c3;
  color: #854d0e;
  border: 1px solid #fde047;
}
.tk-root.tk-theme-dark .tk-consensus-badge.tk-consensus-partial {
  background: #422006;
  color: #fde68a;
  border-color: #92400e;
}
/* Split — both flagged */
.tk-consensus-badge.tk-consensus-split {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}
.tk-root.tk-theme-dark .tk-consensus-badge.tk-consensus-split {
  background: #450a0a;
  color: #fca5a5;
  border-color: #7f1d1d;
}
.tk-consensus-badge-icon {
  font-style: normal;
  font-size: 10px;
  line-height: 1;
}

/* ── Consensus detail section (disclosure accordion) ──────── */
.tk-consensus-section {
  margin: 8px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

.tk-consensus-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  font-family: var(--tk-font);
  color: var(--tk-text);
  text-align: left;
  transition: background var(--tk-transition);
}
.tk-consensus-toggle:hover {
  background: var(--tk-bg);
}
.tk-consensus-toggle:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}
.tk-consensus-toggle-icon {
  font-size: 11px;
  color: var(--tk-text-secondary);
  flex-shrink: 0;
}

.tk-consensus-content {
  display: none;
  padding: 10px 12px 12px;
  background: var(--tk-bg);
}
.tk-consensus-content.tk-consensus-content-open {
  display: block;
}

.tk-consensus-framing {
  font-size: 12px;
  color: var(--tk-text-secondary);
  margin: 0 0 10px;
  font-style: italic;
  line-height: 1.4;
}

.tk-consensus-personas {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tk-consensus-persona-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--tk-bg-secondary);
  border: 1px solid var(--tk-border);
}

.tk-consensus-persona-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.tk-consensus-persona-name {
  color: var(--tk-text);
  text-transform: capitalize;
}

.tk-consensus-verdict {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}
.tk-consensus-verdict.tk-verdict-approved {
  background: #dcfce7;
  color: #15803d;
}
.tk-root.tk-theme-dark .tk-consensus-verdict.tk-verdict-approved {
  background: #14532d;
  color: #86efac;
}
.tk-consensus-verdict.tk-verdict-flagged {
  background: #fee2e2;
  color: #991b1b;
}
.tk-root.tk-theme-dark .tk-consensus-verdict.tk-verdict-flagged {
  background: #450a0a;
  color: #fca5a5;
}

.tk-consensus-summary {
  font-size: 12px;
  color: var(--tk-text-secondary);
  line-height: 1.5;
  margin: 0;
}

.tk-consensus-read-more {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--tk-primary);
  cursor: pointer;
  font-family: var(--tk-font);
  text-decoration: underline;
}
.tk-consensus-read-more:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
  border-radius: 2px;
}`
  ) + '\n';
}
