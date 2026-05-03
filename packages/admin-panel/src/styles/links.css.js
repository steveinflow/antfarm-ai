// @docket/admin-panel — CSS extracted from styles.js (lines 3374-3781)

export const linksCss = `/* ==========================================================
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
`;
