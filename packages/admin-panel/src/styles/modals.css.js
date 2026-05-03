// @docket/admin-panel — CSS extracted from styles.js (lines 2615-3213)

export const modalsCss = `/* --- Changelog modal --- */
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
`;
