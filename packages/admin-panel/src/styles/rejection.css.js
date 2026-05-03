// @docket/admin-panel — CSS extracted from styles.js (lines 1194-1393)

export const rejectionCss = `/* --- Rejection UI --- */

/* Suppression notice — shown on proposed tickets that match rejected proposals */
.tk-suppressed-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  margin: 8px 0;
  font-size: 0.8rem;
  font-weight: 500;
  color: #7a5900;
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: var(--tk-radius);
}

.tk-theme-dark .tk-suppressed-notice {
  color: #ffcc80;
  background: #2d2510;
  border-color: #5a4500;
}

/* Container for the "Not relevant" button + popover slot */
.tk-rejection-container {
  position: relative;
  display: inline-block;
}

/* Inline rejection popover */
.tk-rejection-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 1000;
  min-width: 220px;
  background: var(--tk-bg);
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  box-shadow: var(--tk-shadow-lg);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* If popover would overflow to the right, align right instead */
@media (max-width: 400px) {
  .tk-rejection-popover {
    left: auto;
    right: 0;
  }
}

.tk-rejection-popover-title {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--tk-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}

/* Cancel (✕) button in top-right of popover */
.tk-rejection-cancel {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: var(--tk-text-secondary);
  font-size: 0.9rem;
  cursor: pointer;
  padding: 2px 6px;
  line-height: 1;
  border-radius: 4px;
  font-family: var(--tk-font);
  transition: background var(--tk-transition), color var(--tk-transition);
}

.tk-rejection-cancel:hover {
  background: var(--tk-bg-secondary);
  color: var(--tk-text);
}

.tk-rejection-cancel:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
}

/* Group of preset reason buttons */
.tk-rejection-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Individual preset reason button */
.tk-rejection-option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  font-size: 0.875rem;
  font-family: var(--tk-font);
  background: var(--tk-bg-secondary);
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  color: var(--tk-text);
  cursor: pointer;
  transition: background var(--tk-transition), border-color var(--tk-transition);
}

.tk-rejection-option:hover:not(:disabled) {
  background: var(--tk-tag-bg);
  border-color: var(--tk-primary);
  color: var(--tk-primary);
}

.tk-rejection-option:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: -1px;
}

/* "Other" container — revealed when "Other" option is clicked */
.tk-rejection-other {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}

.tk-rejection-other-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  font-size: 0.875rem;
  font-family: var(--tk-font);
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  transition: border-color var(--tk-transition);
}

.tk-rejection-other-input:focus {
  outline: none;
  border-color: var(--tk-primary);
}

.tk-rejection-other-input::placeholder {
  color: var(--tk-text-secondary);
}

.tk-rejection-other-actions {
  display: flex;
  justify-content: flex-end;
}

/* Undo toast — distinct from standard toasts; uses warning color */
.tk-toast-undo {
  background: #37474f;
  color: #fff;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: var(--tk-radius);
  font-size: 0.9rem;
  font-family: var(--tk-font);
  box-shadow: var(--tk-shadow-lg);
  pointer-events: auto;
  animation: tk-toast-in 0.3s ease forwards;
  max-width: 360px;
}

.tk-toast-undo-btn {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 0.82rem;
  font-family: var(--tk-font);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--tk-transition);
  flex-shrink: 0;
}

.tk-toast-undo-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.tk-toast-undo-btn:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
`;
