// @docket/admin-panel — CSS extracted from styles.js (lines 3214-3373)

export const feedbackCss = `/* --- Feedback widget --- */

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
`;
