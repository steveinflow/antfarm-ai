// @docket/admin-panel — CSS extracted from styles.js (lines 2322-2614)

export const snoozeCss = `/* --- Snooze badge (in ticket header) --- */
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
`;
