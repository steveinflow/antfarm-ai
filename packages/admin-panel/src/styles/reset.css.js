// @docket/admin-panel — CSS extracted from styles.js (lines 7-98)

export const resetCss = `/* ========================================================
   Ticket Admin Panel — tk- namespaced styles
   ======================================================== */

/* --- Theme custom properties --- */
.tk-root {
  --tk-primary: #4f6bed;
  --tk-primary-hover: #3b53d1;
  --tk-bg: #ffffff;
  --tk-bg-secondary: #f5f6fa;
  --tk-text: #1a1a2e;
  --tk-text-secondary: #6b7280;
  --tk-border: #e0e0e0;
  --tk-radius: 8px;
  --tk-transition: 0.2s ease;
  --tk-danger: #e74c3c;
  --tk-danger-hover: #c0392b;
  --tk-success: #27ae60;
  --tk-success-hover: #1e8449;
  --tk-warning: #f39c12;
  --tk-tag-bg: #eef1fb;
  --tk-tag-text: #4f6bed;
  --tk-shadow: 0 1px 3px rgba(0,0,0,0.08);
  --tk-shadow-lg: 0 4px 12px rgba(0,0,0,0.12);
  --tk-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  /* Disabled state — distinct from loading/opacity states */
  --tk-disabled-bg: #e8e9ec;
  --tk-disabled-text: #a0a4b0;
  --tk-disabled-border: #d0d2d8;
}

.tk-root.tk-theme-dark {
  --tk-primary: #6b8aff;
  --tk-primary-hover: #8da4ff;
  --tk-bg: #1a1a2e;
  --tk-bg-secondary: #23233d;
  --tk-text: #e8e8ed;
  --tk-text-secondary: #9ca3af;
  --tk-border: #333355;
  --tk-danger: #ef5350;
  --tk-danger-hover: #f44336;
  --tk-success: #4caf50;
  --tk-success-hover: #66bb6a;
  --tk-warning: #ffb74d;
  --tk-tag-bg: #2a2a4a;
  --tk-tag-text: #8da4ff;
  --tk-shadow: 0 1px 3px rgba(0,0,0,0.3);
  --tk-shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
  /* Disabled state — dark theme */
  --tk-disabled-bg: #2a2a3e;
  --tk-disabled-text: #5a5e72;
  --tk-disabled-border: #333355;
}

/* --- Root reset --- */
.tk-root {
  font-family: var(--tk-font);
  color: var(--tk-text);
  background: var(--tk-bg);
  line-height: 1.5;
  box-sizing: border-box;
}

.tk-root *, .tk-root *::before, .tk-root *::after {
  box-sizing: border-box;
}

/* --- Layout --- */
.tk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px;
  margin-bottom: 8px;
}

.tk-panel-body {
  padding: 0 16px;
}

.tk-header-title {
  font-size: 1.4rem;
  font-weight: 700;
  margin: 0;
}

.tk-header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
`;
