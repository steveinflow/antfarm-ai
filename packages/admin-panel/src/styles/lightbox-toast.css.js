// @docket/admin-panel — CSS extracted from styles.js (lines 1014-1193)

export const lightboxToastCss = `/* --- Lightbox --- */
.tk-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.tk-lightbox img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: var(--tk-radius);
  box-shadow: var(--tk-shadow-lg);
}

.tk-lightbox-close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 36px;
  height: 36px;
  background: rgba(255,255,255,0.15);
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 1.2rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tk-lightbox-close:hover {
  background: rgba(255,255,255,0.3);
}

/* --- Toast Notifications --- */
.tk-toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 10001;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.tk-toast {
  padding: 12px 20px;
  border-radius: var(--tk-radius);
  color: #fff;
  font-size: 0.9rem;
  font-family: var(--tk-font);
  box-shadow: var(--tk-shadow-lg);
  pointer-events: auto;
  animation: tk-toast-in 0.3s ease forwards;
  max-width: 360px;
}

.tk-toast-success {
  background: var(--tk-success);
}
.tk-toast-error {
  background: var(--tk-danger);
}
.tk-toast-info {
  background: var(--tk-primary);
}

.tk-toast-exit {
  animation: tk-toast-out 0.3s ease forwards;
}

@keyframes tk-toast-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes tk-toast-out {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(12px); }
}

/* --- Loading spinner --- */
.tk-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--tk-text-secondary);
  gap: 8px;
}

.tk-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--tk-border);
  border-top-color: var(--tk-primary);
  border-radius: 50%;
  animation: tk-spin 0.7s linear infinite;
}

@keyframes tk-spin {
  to { transform: rotate(360deg); }
}

/* --- Skeleton loader --- */
.tk-skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.tk-skeleton-card {
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  overflow: hidden;
  background: var(--tk-bg);
}

.tk-skeleton-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}

.tk-skeleton-block {
  background: var(--tk-border);
  border-radius: 4px;
  animation: tk-skeleton-pulse 1.6s ease-in-out infinite;
}

.tk-skeleton-id {
  width: 56px;
  height: 14px;
  flex-shrink: 0;
}

.tk-skeleton-type {
  width: 42px;
  height: 18px;
  border-radius: 3px;
  flex-shrink: 0;
}

.tk-skeleton-status {
  width: 68px;
  height: 18px;
  border-radius: 3px;
  flex-shrink: 0;
}

.tk-skeleton-title-line {
  height: 14px;
  flex: 1;
  min-width: 0;
}

.tk-skeleton-title-area {
  padding: 0 16px 12px 16px;
}

.tk-skeleton-title-full {
  height: 14px;
  width: 72%;
}

@keyframes tk-skeleton-pulse {
  0%   { opacity: 1; }
  50%  { opacity: 0.4; }
  100% { opacity: 1; }
}
`;
