// @docket/admin-panel — CSS extracted from styles.js (lines 2013-2321)

export const runLogCss = `/* --- Advisor Run Log --- */

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
`;
