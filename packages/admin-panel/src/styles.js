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

export function getStyles() {
  return '\n' + (
    resetCss + '\n' + buttonsCss + '\n' + formCss + '\n' + filtersCss + '\n' + ticketCss + '\n' + lightboxToastCss + '\n' + rejectionCss + '\n' + `/* --- Evidence Section --- */

/* Disclosure toggle button */
.tk-evidence {
  margin: 12px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

.tk-evidence-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  border: none;
  border-radius: 0;
  color: var(--tk-text-secondary);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: var(--tk-font);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  text-align: left;
  transition: background var(--tk-transition), color var(--tk-transition);
}

.tk-evidence-toggle:hover,
.tk-evidence-toggle:focus-visible {
  background: var(--tk-border);
  color: var(--tk-text);
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}

.tk-evidence-toggle-icon {
  font-size: 0.75rem;
  line-height: 1;
  flex-shrink: 0;
}

/* Collapsible content — hidden by default */
.tk-evidence-content {
  display: none;
  padding: 12px;
}

.tk-evidence-content.tk-evidence-content-open {
  display: block;
}

/* Staleness warning */
.tk-evidence-staleness {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 10px;
  font-size: 0.78rem;
  color: #7a5900;
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: var(--tk-radius);
}

.tk-theme-dark .tk-evidence-staleness {
  color: #ffcc80;
  background: #2d2510;
  border-color: #5a4500;
}

/* Sub-section within evidence */
.tk-evidence-section {
  margin-bottom: 12px;
}

.tk-evidence-section:last-child {
  margin-bottom: 0;
}

.tk-evidence-section-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--tk-text-secondary);
  margin-bottom: 6px;
}

/* File reference chips */
.tk-evidence-file-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tk-file-ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--tk-bg-secondary);
  border: 1px solid var(--tk-border);
  border-radius: 4px;
  font-size: 0.78rem;
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
}

.tk-file-ref-link {
  color: var(--tk-primary);
  text-decoration: none;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-file-ref-link:hover {
  text-decoration: underline;
}

.tk-file-ref-link:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
  border-radius: 2px;
}

.tk-file-ref-text {
  color: var(--tk-text);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-file-ref-copy {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--tk-text-secondary);
  line-height: 1;
  transition: color var(--tk-transition);
  flex-shrink: 0;
}

.tk-file-ref-copy:hover {
  color: var(--tk-primary);
}

.tk-file-ref-copy:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
  border-radius: 2px;
}

/* "Show N more" affordance */
.tk-evidence-show-more {
  display: inline-block;
  padding: 3px 8px;
  font-size: 0.78rem;
  color: var(--tk-primary);
  background: none;
  border: 1px dashed var(--tk-primary);
  border-radius: 4px;
  cursor: pointer;
  font-family: var(--tk-font);
  transition: background var(--tk-transition);
}

.tk-evidence-show-more:hover {
  background: var(--tk-tag-bg);
}

.tk-evidence-show-more:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
}

/* Screenshot with annotation overlays */
.tk-screenshot-annotated {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.tk-screenshot-img {
  display: block;
  max-width: 100%;
  max-height: 300px;
  object-fit: contain;
  border-radius: var(--tk-radius);
  cursor: pointer;
  border: 1px solid var(--tk-border);
}

/* Lightbox variant — full size */
.tk-lightbox-annotated .tk-screenshot-img {
  max-height: 80vh;
  max-width: 88vw;
}

/* Bounding box annotation overlay */
.tk-annotation-box {
  position: absolute;
  border: 2px solid #e53e3e;
  border-radius: 2px;
  pointer-events: none;
}

.tk-annotation-label {
  position: absolute;
  top: -1px;
  left: -1px;
  background: #e53e3e;
  color: #fff;
  font-size: 0.65rem;
  font-family: var(--tk-font);
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 0 0 2px 0;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Storage note (gs:// URL — not directly renderable) */
.tk-screenshot-storage-note {
  font-size: 0.8rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  padding: 6px 0;
}

.tk-screenshot-storage-path {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 0.75rem;
  color: var(--tk-text-secondary);
  word-break: break-all;
}

/* Related tickets "See Also" row */
.tk-evidence-related-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tk-evidence-related-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tk-evidence-related-link {
  text-decoration: none;
}

.tk-evidence-related-link:hover .tk-evidence-related-id {
  text-decoration: underline;
}

.tk-evidence-related-link:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
  border-radius: 2px;
}

.tk-evidence-related-id {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--tk-primary);
}

/* --- Evidence Type Badges (list-level, proposed tickets) --- */
.tk-evidence-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
  /* Visible text label — not icon/color only, per accessibility requirements */
}

.tk-evidence-badge-file {
  background: #e8f0fd;
  color: #1a56b8;
  border: 1px solid #b3c8f5;
}

.tk-evidence-badge-screenshot {
  background: #fce8f3;
  color: #9c1e6e;
  border: 1px solid #f0b3d8;
}

.tk-evidence-badge-mixed {
  background: #f0e8fd;
  color: #5a1b99;
  border: 1px solid #d3b3f5;
}

.tk-evidence-badge-summary {
  background: var(--tk-bg-secondary);
  color: var(--tk-text-secondary);
  border: 1px solid var(--tk-border);
}

.tk-theme-dark .tk-evidence-badge-file {
  background: #1a2d4a;
  color: #90b8f0;
  border-color: #2a4a7a;
}

.tk-theme-dark .tk-evidence-badge-screenshot {
  background: #3a1a2d;
  color: #f090d0;
  border-color: #6a2a4a;
}

.tk-theme-dark .tk-evidence-badge-mixed {
  background: #2a1a3d;
  color: #c090f0;
  border-color: #4a2a6a;
}

/* --- Cluster Tags (inline on ticket cards) --- */

/* Container row — shown below the ticket title, above the detail section */
.tk-cluster-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 0 16px 10px 16px;
}

/* Individual cluster filter button */
.tk-cluster-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px 2px 8px;
  font-size: 0.72rem;
  font-weight: 600;
  border: 1px solid #b3c8f5;
  border-radius: 999px;
  background: #e8f0fd;
  color: #1a56b8;
  cursor: pointer;
  font-family: var(--tk-font);
  transition: background var(--tk-transition), border-color var(--tk-transition), color var(--tk-transition);
  white-space: nowrap;
  /* Keyboard focus ring — required for accessibility */
}

.tk-cluster-tag:hover {
  background: #d0e0fb;
  border-color: #7aaaf0;
}

.tk-cluster-tag:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
}

/* Count badge — shows ticket count for this cluster */
.tk-cluster-tag-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 0.65rem;
  font-weight: 700;
  background: #1a56b8;
  color: #fff;
  border-radius: 999px;
  line-height: 1;
}

/* "New theme" star indicator — shown on tags whose cluster was just created */
.tk-cluster-tag-new-indicator {
  font-size: 0.6rem;
  color: #e67e22;
  line-height: 1;
}

/* New-theme variant — slightly warmer tint to distinguish first-time clusters */
.tk-cluster-tag.tk-cluster-tag-new {
  border-color: #f0c080;
  background: #fef6e8;
  color: #8a4800;
}

.tk-cluster-tag.tk-cluster-tag-new:hover {
  background: #fde8c0;
  border-color: #e0a040;
}

.tk-cluster-tag.tk-cluster-tag-new .tk-cluster-tag-count {
  background: #8a4800;
}

/* Dark theme overrides */
.tk-theme-dark .tk-cluster-tag {
  background: #1a2d4a;
  color: #90b8f0;
  border-color: #2a4a7a;
}

.tk-theme-dark .tk-cluster-tag:hover {
  background: #1e3560;
  border-color: #4a7ab8;
}

.tk-theme-dark .tk-cluster-tag-count {
  background: #4a7ab8;
  color: #fff;
}

.tk-theme-dark .tk-cluster-tag.tk-cluster-tag-new {
  background: #2d2010;
  color: #f0b870;
  border-color: #6a4a20;
}

.tk-theme-dark .tk-cluster-tag.tk-cluster-tag-new:hover {
  background: #3a2810;
  border-color: #9a6a30;
}

.tk-theme-dark .tk-cluster-tag.tk-cluster-tag-new .tk-cluster-tag-count {
  background: #9a6a30;
}

.tk-theme-dark .tk-cluster-tag-new-indicator {
  color: #f0b060;
}

/* --- Reasoning Section (<details>/<summary> accordion) --- */
.tk-reasoning {
  margin: 16px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

/* <summary> toggle — styled to match the existing evidence toggle button */
.tk-reasoning-summary-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  color: var(--tk-text-secondary);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: var(--tk-font);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  list-style: none; /* hide native triangle in some browsers */
  transition: background var(--tk-transition), color var(--tk-transition);
  /* Minimum 4.5:1 contrast on bg-secondary — verified against theme values */
}

/* Remove default marker in WebKit/Blink */
.tk-reasoning-summary-toggle::-webkit-details-marker {
  display: none;
}

.tk-reasoning-summary-toggle::before {
  content: '▸';
  font-size: 0.72rem;
  line-height: 1;
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

details.tk-reasoning[open] .tk-reasoning-summary-toggle::before {
  content: '▾';
}

.tk-reasoning-summary-toggle:hover,
.tk-reasoning-summary-toggle:focus-visible {
  background: var(--tk-border);
  color: var(--tk-text);
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}

.tk-reasoning-body {
  padding: 12px;
}

/* Lead summary sentence */
.tk-reasoning-summary {
  font-size: 0.88rem;
  color: var(--tk-text);
  margin: 0 0 12px 0;
  line-height: 1.5;
}

/* Empty state — shown when evidence array is empty */
.tk-reasoning-empty {
  font-size: 0.82rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  margin: 0;
}

/* Individual evidence entry */
.tk-reasoning-evidence {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--tk-radius);
  border-left: 3px solid var(--tk-border);
  background: var(--tk-bg-secondary);
}

.tk-reasoning-evidence:last-child {
  margin-bottom: 0;
}

/* Visible text label (not color/icon only) */
.tk-reasoning-evidence-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.tk-reasoning-evidence-file {
  border-left-color: #1a56b8;
}

.tk-reasoning-evidence-file .tk-reasoning-evidence-label {
  color: #1a56b8;
}

.tk-theme-dark .tk-reasoning-evidence-file {
  border-left-color: #6b8aff;
}

.tk-theme-dark .tk-reasoning-evidence-file .tk-reasoning-evidence-label {
  color: #6b8aff;
}

.tk-reasoning-evidence-screenshot {
  border-left-color: #9c1e6e;
}

.tk-reasoning-evidence-screenshot .tk-reasoning-evidence-label {
  color: #9c1e6e;
}

.tk-theme-dark .tk-reasoning-evidence-screenshot {
  border-left-color: #f090d0;
}

.tk-theme-dark .tk-reasoning-evidence-screenshot .tk-reasoning-evidence-label {
  color: #f090d0;
}

/* Code snippet — file path + line range
   Meets 4.5:1 contrast requirement per accessibility spec */
.tk-reasoning-code {
  margin: 0 0 8px 0;
  padding: 6px 10px;
  background: #1e1e2e;
  color: #cdd6f4;
  border-radius: 4px;
  font-size: 0.78rem;
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  overflow-x: auto;
  white-space: pre;
  /* color #cdd6f4 on #1e1e2e = 11.7:1 contrast ratio — well above 4.5:1 minimum */
}

.tk-theme-dark .tk-reasoning-code {
  background: #12121e;
  color: #cdd6f4;
}

.tk-reasoning-code code {
  font-family: inherit;
  font-size: inherit;
  background: none;
  padding: 0;
  color: inherit;
}

/* Captured-at timestamp for screenshot evidence */
.tk-reasoning-captured-at {
  font-size: 0.75rem;
  color: var(--tk-text-secondary);
  margin-bottom: 6px;
}

/* Short critique note */
.tk-reasoning-note {
  font-size: 0.82rem;
  color: var(--tk-text);
  margin: 4px 0 0 0;
  line-height: 1.4;
}
` + '\n' + `/* --- Advisor Run Log --- */

.tk-run-log-section {
  margin-top: 24px;
  border-top: 1px solid var(--tk-border);
  padding-top: 16px;
}

.tk-run-log-section-header {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--tk-text-secondary);
  margin-bottom: 8px;
}

.tk-run-log {
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  margin-bottom: 8px;
  overflow: hidden;
  background: var(--tk-bg);
}

.tk-run-log-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  background: var(--tk-bg-secondary);
  border: none;
  border-radius: 0;
  cursor: pointer;
  font-family: var(--tk-font);
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--tk-text);
  text-align: left;
}

.tk-run-log-toggle:hover,
.tk-run-log-toggle:focus-visible {
  background: var(--tk-border);
  outline: none;
}

.tk-run-log-toggle:focus-visible {
  box-shadow: inset 0 0 0 2px var(--tk-primary);
}

.tk-run-log-toggle-icon {
  font-size: 0.65rem;
  color: var(--tk-text-secondary);
  flex-shrink: 0;
}

.tk-run-log-toggle-label {
  flex: 1;
}

.tk-run-log-content {
  padding: 12px 14px;
}

.tk-run-log-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--tk-text-secondary);
  padding: 8px 0;
}

.tk-run-log-error {
  font-size: 0.85rem;
  color: var(--tk-danger);
  padding: 8px 0;
}

.tk-run-log-empty {
  font-size: 0.85rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  padding: 8px 0;
}

.tk-run-log-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Run card */

.tk-run-card {
  border: 1px solid var(--tk-border);
  border-radius: calc(var(--tk-radius) - 2px);
  overflow: hidden;
}

.tk-run-card-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  background: var(--tk-bg);
  border: none;
  cursor: pointer;
  font-family: var(--tk-font);
  text-align: left;
}

.tk-run-card-toggle:hover,
.tk-run-card-toggle:focus-visible {
  background: var(--tk-bg-secondary);
  outline: none;
}

.tk-run-card-toggle:focus-visible {
  box-shadow: inset 0 0 0 2px var(--tk-primary);
}

.tk-run-card-icon {
  font-size: 0.6rem;
  color: var(--tk-text-secondary);
  flex-shrink: 0;
  margin-top: 3px;
}

.tk-run-card-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.tk-run-time {
  font-size: 0.82rem;
  color: var(--tk-text-secondary);
  flex-shrink: 0;
}

.tk-run-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tk-run-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 12px;
  white-space: nowrap;
}

.tk-run-chip-created {
  background: #e8f5e9;
  color: #2e7d32;
}

.tk-theme-dark .tk-run-chip-created {
  background: #1b3a1c;
  color: #81c784;
}

.tk-run-chip-skipped {
  background: #fff3e0;
  color: #e65100;
}

.tk-theme-dark .tk-run-chip-skipped {
  background: #3a2010;
  color: #ffb74d;
}

.tk-run-chip-error {
  background: #fce4ec;
  color: #c62828;
}

.tk-theme-dark .tk-run-chip-error {
  background: #3a1010;
  color: #ef9a9a;
}

.tk-run-chip-icon {
  font-style: normal;
}

/* Run card detail */

.tk-run-card-detail {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--tk-border);
  background: var(--tk-bg);
}

.tk-run-card-detail[hidden] {
  display: none;
}

.tk-run-detail-summary {
  font-size: 0.85rem;
  color: var(--tk-text);
  margin: 0 0 10px 0;
}

.tk-run-detail-error {
  font-size: 0.82rem;
  color: var(--tk-danger);
  padding: 6px 10px;
  border-radius: var(--tk-radius);
  background: #fff0f0;
  margin-bottom: 10px;
}

.tk-theme-dark .tk-run-detail-error {
  background: #2a1010;
}

.tk-run-detail-quiet {
  font-size: 0.85rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  margin: 0;
}

/* Skipped reasons list */

.tk-run-skipped {
  margin-top: 4px;
}

.tk-run-skipped-label {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--tk-text-secondary);
  margin-bottom: 6px;
}

.tk-run-skipped-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tk-run-skipped-item {
  font-size: 0.82rem;
  color: var(--tk-text);
  padding: 5px 8px;
  border-radius: 4px;
  background: var(--tk-bg-secondary);
  line-height: 1.4;
}

.tk-run-skipped-title {
  font-weight: 500;
}

.tk-run-skipped-reason {
  color: var(--tk-text-secondary);
  font-size: 0.8rem;
}

.tk-run-skipped-link {
  color: var(--tk-primary);
  text-decoration: none;
  font-size: 0.8rem;
}

.tk-run-skipped-link:hover {
  text-decoration: underline;
}

.tk-run-show-more {
  display: block;
  margin-top: 6px;
  padding: 4px 10px;
  font-size: 0.8rem;
  color: var(--tk-primary);
  background: none;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  cursor: pointer;
  font-family: var(--tk-font);
}

.tk-run-show-more:hover {
  background: var(--tk-bg-secondary);
}

.tk-run-show-more:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
}
` + '\n' + `/* --- Snooze badge (in ticket header) --- */
.tk-snoozed-badge {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  background: #fff8e1;
  color: #e65100;
  border: 1px solid #ffe082;
  white-space: nowrap;
}

.tk-theme-dark .tk-snoozed-badge {
  background: #3d2a00;
  color: #ffb74d;
  border-color: #5c3d00;
}

/* --- Critical badge — shown on ticket header when critical flag is set --- */
.tk-critical-badge {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 999px;
  background: #fff5f5;
  color: #c53030;
  border: 1px solid #feb2b2;
  white-space: nowrap;
}

.tk-theme-dark .tk-critical-badge {
  background: #3d0000;
  color: #fc8181;
  border-color: #7b0000;
}

/* --- Snooze action container (inline with rejection container) --- */
.tk-snooze-container {
  position: relative;
  display: inline-block;
}

/* --- Snooze popover --- */
.tk-snooze-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 200;
  background: var(--tk-bg);
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  box-shadow: var(--tk-shadow-lg);
  padding: 14px 16px 14px;
  min-width: 230px;
  max-width: 300px;
}

.tk-snooze-popover-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--tk-text);
  margin-bottom: 10px;
}

.tk-snooze-cancel {
  position: absolute;
  top: 8px;
  right: 10px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--tk-text-secondary);
  padding: 2px 4px;
  line-height: 1;
  border-radius: 4px;
}

.tk-snooze-cancel:hover {
  background: var(--tk-bg-secondary);
}

/* --- Snooze preset chips --- */
.tk-snooze-presets {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.tk-snooze-preset {
  font-size: 0.82rem;
  font-weight: 500;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--tk-border);
  background: var(--tk-bg-secondary);
  color: var(--tk-text);
  cursor: pointer;
  transition: background var(--tk-transition), color var(--tk-transition);
}

.tk-snooze-preset:hover,
.tk-snooze-preset:focus {
  background: var(--tk-primary);
  color: #fff;
  border-color: var(--tk-primary);
  outline: none;
}

/* --- Custom date row --- */
.tk-snooze-custom-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.tk-snooze-date-input {
  flex: 1;
  font-size: 0.82rem;
  padding: 5px 8px;
  border: 1px solid var(--tk-border);
  border-radius: 6px;
  background: var(--tk-bg);
  color: var(--tk-text);
  outline: none;
}

.tk-snooze-date-input:focus {
  border-color: var(--tk-primary);
  box-shadow: 0 0 0 2px rgba(79,107,237,0.15);
}

.tk-snooze-date-input::placeholder {
  color: var(--tk-text-secondary);
}

/* --- Snoozed collapsible section below the active proposal list --- */
.tk-snoozed-section {
  margin-top: 16px;
  border-top: 1px solid var(--tk-border);
  padding-top: 10px;
}

.tk-snoozed-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--tk-text-secondary);
  padding: 4px 0;
  display: block;
  width: 100%;
  text-align: left;
  border-radius: 4px;
}

.tk-snoozed-toggle:hover,
.tk-snoozed-toggle:focus {
  color: var(--tk-text);
  outline: none;
  text-decoration: underline;
}

.tk-snoozed-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tk-snoozed-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--tk-text);
  padding: 6px 10px;
  background: var(--tk-bg-secondary);
  border-radius: 6px;
  border: 1px solid var(--tk-border);
}

.tk-snoozed-row-title {
  font-weight: 600;
  color: var(--tk-text-secondary);
  white-space: nowrap;
}

.tk-snoozed-row-resurface {
  color: var(--tk-text-secondary);
  font-style: italic;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tk-snoozed-row-wake {
  margin-left: auto;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Rejected section (DK-320) ─────────────────────────────────────────── */

.tk-rejected-section {
  margin-top: 16px;
  border-top: 1px solid var(--tk-border);
  padding-top: 10px;
}

.tk-rejected-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--tk-text-secondary);
  padding: 4px 0;
  display: block;
  width: 100%;
  text-align: left;
  border-radius: 4px;
}

.tk-rejected-toggle:hover,
.tk-rejected-toggle:focus {
  color: var(--tk-text);
  outline: none;
  text-decoration: underline;
}

.tk-rejected-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tk-rejected-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--tk-text-secondary);
  padding: 6px 10px;
  background: var(--tk-bg-secondary);
  border-radius: 6px;
  border: 1px solid var(--tk-border);
  opacity: 0.8;
}

.tk-rejected-row-title {
  font-weight: 600;
  color: var(--tk-text-secondary);
  white-space: nowrap;
}

.tk-rejected-row-reason {
  font-style: italic;
  color: var(--tk-text-secondary);
}

.tk-rejected-row-date {
  color: var(--tk-text-secondary);
  margin-left: auto;
  white-space: nowrap;
  flex-shrink: 0;
  font-size: 0.78rem;
}

/* --- Snooze timeline entries --- */
.tk-timeline-dot-snooze {
  background: #ff8f00;
}

.tk-timeline-item-snooze .tk-timeline-status {
  color: #e65100;
  font-weight: 600;
}

.tk-theme-dark .tk-timeline-dot-snooze {
  background: #ffb74d;
}

.tk-theme-dark .tk-timeline-item-snooze .tk-timeline-status {
  color: #ffb74d;
}
` + '\n' + `/* --- Changelog modal --- */
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
