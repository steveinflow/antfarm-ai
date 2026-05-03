// @docket/admin-panel — CSS extracted from styles.js (lines 444-1013)

export const ticketCss = `/* --- Ticket List --- */
.tk-ticket-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tk-ticket-list-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--tk-text-secondary);
  font-size: 0.95rem;
}

/* --- Empty State — rich centered placeholder with icon, headline, and optional CTA --- */
.tk-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 32px;
  gap: 10px;
}

.tk-empty-state-icon {
  font-size: 2.2rem;
  line-height: 1;
  margin-bottom: 4px;
  user-select: none;
}

.tk-empty-state-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--tk-text);
}

.tk-empty-state-message {
  font-size: 0.88rem;
  color: var(--tk-text-secondary);
  max-width: 320px;
  line-height: 1.5;
}

.tk-empty-state-action {
  margin-top: 8px;
}

/* --- Ticket Item --- */
.tk-ticket-item {
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
  transition: box-shadow var(--tk-transition);
  background: var(--tk-bg);
}

.tk-ticket-item:hover {
  box-shadow: var(--tk-shadow);
}

.tk-ticket-item.tk-expanded {
  box-shadow: var(--tk-shadow-lg);
}

.tk-ticket-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  flex-wrap: wrap;
}

.tk-ticket-header:hover {
  background: var(--tk-bg-secondary);
}

.tk-btn-close {
  background: none;
  border: none;
  color: var(--tk-text-secondary);
  font-size: 1.4rem;
  cursor: pointer;
  padding: 4px 8px;
  line-height: 1;
  transition: color var(--tk-transition);
}

.tk-btn-close:hover {
  color: var(--tk-text);
}

.tk-ticket-id {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--tk-primary);
  white-space: nowrap;
}

.tk-ticket-title {
  font-size: 0.95rem;
  font-weight: 600;
  padding: 0 16px 12px 16px;
  word-break: break-word;
}

/* --- Quick Actions Bar (always visible, no expand needed) --- */
.tk-quick-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 10px 16px;
}

.tk-quick-approve {
  /* Slightly more compact than default sm to keep the row tight */
  font-size: 0.78rem;
  padding: 3px 10px;
}

.tk-quick-deny {
  /* Match quick-approve sizing for a consistent pair */
  font-size: 0.78rem;
  padding: 3px 10px;
}

.tk-ticket-version-badge {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
  background: #e8f5e9;
  color: #2e7d32;
}

.tk-theme-dark .tk-ticket-version-badge {
  background: #1b3a1b;
  color: #81c784;
}

/* Timestamp showing when the ticket last entered its current status */
.tk-ticket-status-date {
  margin-left: auto;
  font-size: 0.7rem;
  color: var(--tk-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

/* Live version indicator — shown below the filter tabs */
.tk-live-version {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 10px 0;
  min-height: 0;
}

.tk-live-version:empty {
  padding: 0;
}

.tk-live-version-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.72rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 999px;
  background: #e8f5e9;
  color: #2e7d32;
  white-space: nowrap;
}

.tk-live-version-label {
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  font-size: 0.65rem;
  opacity: 0.75;
}

.tk-live-version-project {
  opacity: 0.7;
  font-style: italic;
}

.tk-live-version-value {
  font-weight: 700;
}

.tk-theme-dark .tk-live-version-badge {
  background: #1b3a1b;
  color: #81c784;
}

.tk-ticket-type {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.tk-ticket-type-bug {
  background: #fde8e8;
  color: #c0392b;
}

.tk-ticket-type-feature {
  background: #e8f0fd;
  color: #2b6cb0;
}

.tk-theme-dark .tk-ticket-type-bug {
  background: #3d1e1e;
  color: #ef9a9a;
}

.tk-theme-dark .tk-ticket-type-feature {
  background: #1e2d3d;
  color: #90caf9;
}

/* --- Status Pills --- */
.tk-ticket-status {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.tk-ticket-status-proposed {
  background: #ede7f6;
  color: #4527a0;
}
.tk-ticket-status-wont_do {
  background: #f5f5f5;
  color: #616161;
}
.tk-ticket-status-open {
  background: #e8f5e9;
  color: #2e7d32;
}
.tk-ticket-status-in_progress {
  background: #e3f2fd;
  color: #1565c0;
}
.tk-ticket-status-blocked {
  background: #fdecea;
  color: #b71c1c;
}
.tk-ticket-status-waiting_for_user {
  background: #fff3e0;
  color: #e65100;
}
.tk-ticket-status-done {
  background: #f3e5f5;
  color: #7b1fa2;
}
.tk-ticket-status-verified {
  background: #e0f2f1;
  color: #00695c;
}

.tk-theme-dark .tk-ticket-status-proposed {
  background: #2a1a4a;
  color: #b39ddb;
}
.tk-theme-dark .tk-ticket-status-wont_do {
  background: #2a2a2a;
  color: #9e9e9e;
}
.tk-theme-dark .tk-ticket-status-open {
  background: #1b3a1b;
  color: #81c784;
}
.tk-theme-dark .tk-ticket-status-in_progress {
  background: #1a2a3d;
  color: #64b5f6;
}
.tk-theme-dark .tk-ticket-status-blocked {
  background: #3a1a1a;
  color: #ef9a9a;
}
.tk-theme-dark .tk-ticket-status-waiting_for_user {
  background: #3d2a1a;
  color: #ffb74d;
}
.tk-theme-dark .tk-ticket-status-done {
  background: #2d1a3d;
  color: #ce93d8;
}
.tk-theme-dark .tk-ticket-status-verified {
  background: #1a2d2a;
  color: #80cbc4;
}

/* --- Ticket Detail (expanded) --- */
.tk-ticket-detail {
  display: none;
  padding: 0 16px 16px 16px;
  border-top: 1px solid var(--tk-border);
}

.tk-expanded .tk-ticket-detail {
  display: block;
}

.tk-ticket-description {
  font-size: 0.9rem;
  color: var(--tk-text);
  margin: 12px 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.tk-ticket-meta {
  font-size: 0.8rem;
  color: var(--tk-text-secondary);
  margin-bottom: 12px;
}

.tk-ticket-stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.tk-ticket-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  background: #e8f5e9;
  color: #2e7d32;
}

.tk-theme-dark .tk-ticket-stat {
  background: #1b3a1b;
  color: #81c784;
}

.tk-ticket-stat-icon {
  font-size: 0.75rem;
}

.tk-ticket-screenshots {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.tk-ticket-screenshot-thumb {
  width: 80px;
  height: 80px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--tk-border);
  cursor: pointer;
  transition: transform var(--tk-transition);
}

.tk-ticket-screenshot-thumb:hover {
  transform: scale(1.05);
}

.tk-ticket-screenshot-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* --- Status History Timeline --- */
.tk-timeline {
  margin: 16px 0;
}

.tk-timeline-title {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--tk-text-secondary);
}

.tk-timeline-list {
  position: relative;
  padding-left: 20px;
  border-left: 2px solid var(--tk-border);
}

.tk-timeline-item {
  position: relative;
  padding: 4px 0 12px 12px;
  font-size: 0.8rem;
  color: var(--tk-text-secondary);
}

.tk-timeline-item:last-child {
  padding-bottom: 0;
}

.tk-timeline-dot {
  position: absolute;
  left: -27px;
  top: 7px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--tk-border);
  border: 2px solid var(--tk-bg);
}

.tk-timeline-dot-proposed { background: #4527a0; }
.tk-timeline-dot-open { background: #2e7d32; }
.tk-timeline-dot-in_progress,
.tk-timeline-dot-blocked { background: #1565c0; }
.tk-timeline-dot-waiting_for_user { background: #e65100; }
.tk-timeline-dot-done { background: #7b1fa2; }
.tk-timeline-dot-verified { background: #00695c; }
.tk-timeline-dot-wont_do { background: #616161; }

.tk-timeline-status {
  font-weight: 600;
  color: var(--tk-text);
}

.tk-timeline-note {
  display: block;
  margin-top: 2px;
  font-style: italic;
}

.tk-timeline-time {
  font-size: 0.75rem;
}

/* --- Question Section (waiting for user) --- */
.tk-question-section {
  margin: 12px 0;
  padding: 12px 16px;
  border-left: 4px solid var(--tk-warning);
  background: #fff8e1;
  border-radius: 0 var(--tk-radius) var(--tk-radius) 0;
}

.tk-theme-dark .tk-question-section {
  background: #2d2a1a;
}

.tk-question-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--tk-warning);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.tk-question-text {
  font-size: 0.9rem;
  color: var(--tk-text);
  margin-bottom: 8px;
}

.tk-answer-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px 12px;
  font-size: 0.9rem;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  font-family: var(--tk-font);
  resize: vertical;
  margin-bottom: 8px;
}

.tk-answer-textarea:focus {
  outline: none;
  border-color: var(--tk-primary);
}

.tk-answer-textarea::placeholder {
  color: var(--tk-text-secondary);
}

/* --- Ticket Actions --- */
.tk-ticket-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--tk-border);
}

.tk-comment-input {
  flex: 1;
  min-width: 150px;
  padding: 6px 12px;
  font-size: 0.85rem;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  font-family: var(--tk-font);
}

.tk-comment-input:focus {
  outline: none;
  border-color: var(--tk-primary);
}

.tk-comment-input::placeholder {
  color: var(--tk-text-secondary);
}

/* --- Add Note Section --- */
.tk-add-note-section {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--tk-border);
}

.tk-note-input {
  flex: 1;
  min-width: 150px;
  padding: 6px 12px;
  font-size: 0.85rem;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  font-family: var(--tk-font);
}

.tk-note-input:focus {
  outline: none;
  border-color: var(--tk-primary);
}

.tk-note-input::placeholder {
  color: var(--tk-text-secondary);
}
`;
