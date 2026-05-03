// @docket/admin-panel — CSS extracted from styles.js (lines 3782-3926)

export const convergenceCss = `/* ==========================================================
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
`;
