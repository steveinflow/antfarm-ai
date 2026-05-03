// @docket/admin-panel — CSS extracted from styles.js (lines 3927-4114)

export const consensusCss = `/* ==========================================================
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
}`;
