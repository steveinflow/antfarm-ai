// @docket/admin-panel — CSS extracted from styles.js (lines 99-200)

export const buttonsCss = `/* --- Buttons --- */
.tk-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 0.875rem;
  font-weight: 500;
  border: none;
  border-radius: var(--tk-radius);
  cursor: pointer;
  transition: background var(--tk-transition), opacity var(--tk-transition);
  font-family: var(--tk-font);
  line-height: 1.4;
}

/* Truly-disabled controls: flat grey fill + muted text — distinct from loading states.
   Do NOT use opacity here; opacity-fade is reserved for in-flight/loading states. */
.tk-btn:disabled {
  background: var(--tk-disabled-bg) !important;
  color: var(--tk-disabled-text) !important;
  border-color: var(--tk-disabled-border) !important;
  cursor: not-allowed;
  box-shadow: none;
}

/* Loading / in-flight state: opacity fade signals "processing, please wait".
   Apply .tk-btn-loading alongside the button's variant class while an async
   operation is running. The button should also be disabled to prevent double-submit. */
.tk-btn-loading {
  opacity: 0.65;
  cursor: wait;
  pointer-events: none;
}

.tk-btn-primary {
  background: var(--tk-primary);
  color: #fff;
}
.tk-btn-primary:hover:not(:disabled) {
  background: var(--tk-primary-hover);
}

.tk-btn-danger {
  background: var(--tk-danger);
  color: #fff;
}
.tk-btn-danger:hover:not(:disabled) {
  background: var(--tk-danger-hover);
}

.tk-btn-success {
  background: var(--tk-success);
  color: #fff;
}
.tk-btn-success:hover:not(:disabled) {
  background: var(--tk-success-hover);
}

.tk-btn-outline {
  background: transparent;
  color: var(--tk-text);
  border: 1px solid var(--tk-border);
}
.tk-btn-outline:hover:not(:disabled) {
  background: var(--tk-bg-secondary);
}

.tk-btn-sm {
  padding: 4px 10px;
  font-size: 0.8rem;
}

.tk-btn-ghost {
  background: transparent;
  color: var(--tk-text-secondary);
  border: 1px solid transparent;
}
.tk-btn-ghost:hover:not(:disabled) {
  background: var(--tk-bg-secondary);
  color: var(--tk-text);
  border-color: var(--tk-border);
}

.tk-btn-critical {
  background: #c53030;
  color: #fff;
  border-color: #c53030;
}
.tk-btn-critical:hover:not(:disabled) {
  background: #9b2c2c;
  border-color: #9b2c2c;
}
.tk-theme-dark .tk-btn-critical {
  background: #e53e3e;
  border-color: #e53e3e;
}
.tk-theme-dark .tk-btn-critical:hover:not(:disabled) {
  background: #c53030;
  border-color: #c53030;
}
`;
