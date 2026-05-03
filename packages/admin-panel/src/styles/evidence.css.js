// @docket/admin-panel — CSS extracted from styles.js (lines 1394-2012)

export const evidenceCss = `/* --- Evidence Section --- */

/* Disclosure toggle button */
.tk-evidence {
  margin: 12px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

.tk-evidence-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  border: none;
  border-radius: 0;
  color: var(--tk-text-secondary);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: var(--tk-font);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  text-align: left;
  transition: background var(--tk-transition), color var(--tk-transition);
}

.tk-evidence-toggle:hover,
.tk-evidence-toggle:focus-visible {
  background: var(--tk-border);
  color: var(--tk-text);
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}

.tk-evidence-toggle-icon {
  font-size: 0.75rem;
  line-height: 1;
  flex-shrink: 0;
}

/* Collapsible content — hidden by default */
.tk-evidence-content {
  display: none;
  padding: 12px;
}

.tk-evidence-content.tk-evidence-content-open {
  display: block;
}

/* Staleness warning */
.tk-evidence-staleness {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 10px;
  font-size: 0.78rem;
  color: #7a5900;
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: var(--tk-radius);
}

.tk-theme-dark .tk-evidence-staleness {
  color: #ffcc80;
  background: #2d2510;
  border-color: #5a4500;
}

/* Sub-section within evidence */
.tk-evidence-section {
  margin-bottom: 12px;
}

.tk-evidence-section:last-child {
  margin-bottom: 0;
}

.tk-evidence-section-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--tk-text-secondary);
  margin-bottom: 6px;
}

/* File reference chips */
.tk-evidence-file-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tk-file-ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--tk-bg-secondary);
  border: 1px solid var(--tk-border);
  border-radius: 4px;
  font-size: 0.78rem;
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
}

.tk-file-ref-link {
  color: var(--tk-primary);
  text-decoration: none;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-file-ref-link:hover {
  text-decoration: underline;
}

.tk-file-ref-link:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
  border-radius: 2px;
}

.tk-file-ref-text {
  color: var(--tk-text);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-file-ref-copy {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--tk-text-secondary);
  line-height: 1;
  transition: color var(--tk-transition);
  flex-shrink: 0;
}

.tk-file-ref-copy:hover {
  color: var(--tk-primary);
}

.tk-file-ref-copy:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 1px;
  border-radius: 2px;
}

/* "Show N more" affordance */
.tk-evidence-show-more {
  display: inline-block;
  padding: 3px 8px;
  font-size: 0.78rem;
  color: var(--tk-primary);
  background: none;
  border: 1px dashed var(--tk-primary);
  border-radius: 4px;
  cursor: pointer;
  font-family: var(--tk-font);
  transition: background var(--tk-transition);
}

.tk-evidence-show-more:hover {
  background: var(--tk-tag-bg);
}

.tk-evidence-show-more:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
}

/* Screenshot with annotation overlays */
.tk-screenshot-annotated {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.tk-screenshot-img {
  display: block;
  max-width: 100%;
  max-height: 300px;
  object-fit: contain;
  border-radius: var(--tk-radius);
  cursor: pointer;
  border: 1px solid var(--tk-border);
}

/* Lightbox variant — full size */
.tk-lightbox-annotated .tk-screenshot-img {
  max-height: 80vh;
  max-width: 88vw;
}

/* Bounding box annotation overlay */
.tk-annotation-box {
  position: absolute;
  border: 2px solid #e53e3e;
  border-radius: 2px;
  pointer-events: none;
}

.tk-annotation-label {
  position: absolute;
  top: -1px;
  left: -1px;
  background: #e53e3e;
  color: #fff;
  font-size: 0.65rem;
  font-family: var(--tk-font);
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 0 0 2px 0;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Storage note (gs:// URL — not directly renderable) */
.tk-screenshot-storage-note {
  font-size: 0.8rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  padding: 6px 0;
}

.tk-screenshot-storage-path {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 0.75rem;
  color: var(--tk-text-secondary);
  word-break: break-all;
}

/* Related tickets "See Also" row */
.tk-evidence-related-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tk-evidence-related-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tk-evidence-related-link {
  text-decoration: none;
}

.tk-evidence-related-link:hover .tk-evidence-related-id {
  text-decoration: underline;
}

.tk-evidence-related-link:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
  border-radius: 2px;
}

.tk-evidence-related-id {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--tk-primary);
}

/* --- Evidence Type Badges (list-level, proposed tickets) --- */
.tk-evidence-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
  /* Visible text label — not icon/color only, per accessibility requirements */
}

.tk-evidence-badge-file {
  background: #e8f0fd;
  color: #1a56b8;
  border: 1px solid #b3c8f5;
}

.tk-evidence-badge-screenshot {
  background: #fce8f3;
  color: #9c1e6e;
  border: 1px solid #f0b3d8;
}

.tk-evidence-badge-mixed {
  background: #f0e8fd;
  color: #5a1b99;
  border: 1px solid #d3b3f5;
}

.tk-evidence-badge-summary {
  background: var(--tk-bg-secondary);
  color: var(--tk-text-secondary);
  border: 1px solid var(--tk-border);
}

.tk-theme-dark .tk-evidence-badge-file {
  background: #1a2d4a;
  color: #90b8f0;
  border-color: #2a4a7a;
}

.tk-theme-dark .tk-evidence-badge-screenshot {
  background: #3a1a2d;
  color: #f090d0;
  border-color: #6a2a4a;
}

.tk-theme-dark .tk-evidence-badge-mixed {
  background: #2a1a3d;
  color: #c090f0;
  border-color: #4a2a6a;
}

/* --- Cluster Tags (inline on ticket cards) --- */

/* Container row — shown below the ticket title, above the detail section */
.tk-cluster-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 0 16px 10px 16px;
}

/* Individual cluster filter button */
.tk-cluster-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px 2px 8px;
  font-size: 0.72rem;
  font-weight: 600;
  border: 1px solid #b3c8f5;
  border-radius: 999px;
  background: #e8f0fd;
  color: #1a56b8;
  cursor: pointer;
  font-family: var(--tk-font);
  transition: background var(--tk-transition), border-color var(--tk-transition), color var(--tk-transition);
  white-space: nowrap;
  /* Keyboard focus ring — required for accessibility */
}

.tk-cluster-tag:hover {
  background: #d0e0fb;
  border-color: #7aaaf0;
}

.tk-cluster-tag:focus-visible {
  outline: 2px solid var(--tk-primary);
  outline-offset: 2px;
}

/* Count badge — shows ticket count for this cluster */
.tk-cluster-tag-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 0.65rem;
  font-weight: 700;
  background: #1a56b8;
  color: #fff;
  border-radius: 999px;
  line-height: 1;
}

/* "New theme" star indicator — shown on tags whose cluster was just created */
.tk-cluster-tag-new-indicator {
  font-size: 0.6rem;
  color: #e67e22;
  line-height: 1;
}

/* New-theme variant — slightly warmer tint to distinguish first-time clusters */
.tk-cluster-tag.tk-cluster-tag-new {
  border-color: #f0c080;
  background: #fef6e8;
  color: #8a4800;
}

.tk-cluster-tag.tk-cluster-tag-new:hover {
  background: #fde8c0;
  border-color: #e0a040;
}

.tk-cluster-tag.tk-cluster-tag-new .tk-cluster-tag-count {
  background: #8a4800;
}

/* Dark theme overrides */
.tk-theme-dark .tk-cluster-tag {
  background: #1a2d4a;
  color: #90b8f0;
  border-color: #2a4a7a;
}

.tk-theme-dark .tk-cluster-tag:hover {
  background: #1e3560;
  border-color: #4a7ab8;
}

.tk-theme-dark .tk-cluster-tag-count {
  background: #4a7ab8;
  color: #fff;
}

.tk-theme-dark .tk-cluster-tag.tk-cluster-tag-new {
  background: #2d2010;
  color: #f0b870;
  border-color: #6a4a20;
}

.tk-theme-dark .tk-cluster-tag.tk-cluster-tag-new:hover {
  background: #3a2810;
  border-color: #9a6a30;
}

.tk-theme-dark .tk-cluster-tag.tk-cluster-tag-new .tk-cluster-tag-count {
  background: #9a6a30;
}

.tk-theme-dark .tk-cluster-tag-new-indicator {
  color: #f0b060;
}

/* --- Reasoning Section (<details>/<summary> accordion) --- */
.tk-reasoning {
  margin: 16px 0;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
}

/* <summary> toggle — styled to match the existing evidence toggle button */
.tk-reasoning-summary-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--tk-bg-secondary);
  color: var(--tk-text-secondary);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: var(--tk-font);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  list-style: none; /* hide native triangle in some browsers */
  transition: background var(--tk-transition), color var(--tk-transition);
  /* Minimum 4.5:1 contrast on bg-secondary — verified against theme values */
}

/* Remove default marker in WebKit/Blink */
.tk-reasoning-summary-toggle::-webkit-details-marker {
  display: none;
}

.tk-reasoning-summary-toggle::before {
  content: '▸';
  font-size: 0.72rem;
  line-height: 1;
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

details.tk-reasoning[open] .tk-reasoning-summary-toggle::before {
  content: '▾';
}

.tk-reasoning-summary-toggle:hover,
.tk-reasoning-summary-toggle:focus-visible {
  background: var(--tk-border);
  color: var(--tk-text);
  outline: 2px solid var(--tk-primary);
  outline-offset: -2px;
}

.tk-reasoning-body {
  padding: 12px;
}

/* Lead summary sentence */
.tk-reasoning-summary {
  font-size: 0.88rem;
  color: var(--tk-text);
  margin: 0 0 12px 0;
  line-height: 1.5;
}

/* Empty state — shown when evidence array is empty */
.tk-reasoning-empty {
  font-size: 0.82rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  margin: 0;
}

/* Individual evidence entry */
.tk-reasoning-evidence {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--tk-radius);
  border-left: 3px solid var(--tk-border);
  background: var(--tk-bg-secondary);
}

.tk-reasoning-evidence:last-child {
  margin-bottom: 0;
}

/* Visible text label (not color/icon only) */
.tk-reasoning-evidence-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.tk-reasoning-evidence-file {
  border-left-color: #1a56b8;
}

.tk-reasoning-evidence-file .tk-reasoning-evidence-label {
  color: #1a56b8;
}

.tk-theme-dark .tk-reasoning-evidence-file {
  border-left-color: #6b8aff;
}

.tk-theme-dark .tk-reasoning-evidence-file .tk-reasoning-evidence-label {
  color: #6b8aff;
}

.tk-reasoning-evidence-screenshot {
  border-left-color: #9c1e6e;
}

.tk-reasoning-evidence-screenshot .tk-reasoning-evidence-label {
  color: #9c1e6e;
}

.tk-theme-dark .tk-reasoning-evidence-screenshot {
  border-left-color: #f090d0;
}

.tk-theme-dark .tk-reasoning-evidence-screenshot .tk-reasoning-evidence-label {
  color: #f090d0;
}

/* Code snippet — file path + line range
   Meets 4.5:1 contrast requirement per accessibility spec */
.tk-reasoning-code {
  margin: 0 0 8px 0;
  padding: 6px 10px;
  background: #1e1e2e;
  color: #cdd6f4;
  border-radius: 4px;
  font-size: 0.78rem;
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  overflow-x: auto;
  white-space: pre;
  /* color #cdd6f4 on #1e1e2e = 11.7:1 contrast ratio — well above 4.5:1 minimum */
}

.tk-theme-dark .tk-reasoning-code {
  background: #12121e;
  color: #cdd6f4;
}

.tk-reasoning-code code {
  font-family: inherit;
  font-size: inherit;
  background: none;
  padding: 0;
  color: inherit;
}

/* Captured-at timestamp for screenshot evidence */
.tk-reasoning-captured-at {
  font-size: 0.75rem;
  color: var(--tk-text-secondary);
  margin-bottom: 6px;
}

/* Short critique note */
.tk-reasoning-note {
  font-size: 0.82rem;
  color: var(--tk-text);
  margin: 4px 0 0 0;
  line-height: 1.4;
}
`;
