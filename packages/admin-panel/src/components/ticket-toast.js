// @docket/admin-panel — TicketToast: bottom-of-screen toast notification stack

import { el } from '../el.js';

export class TicketToast {
  constructor() {
    this.container = null;
  }

  mount(parent) {
    this.container = el('div', { className: 'tk-toast-container' });
    parent.appendChild(this.container);
  }

  unmount() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }

  show(message, type = 'info', duration = 3500) {
    if (!this.container) return;
    const toast = el('div', { className: `tk-toast tk-toast-${type}` }, message);
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('tk-toast-exit');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, duration);
  }

  success(msg) { this.show(msg, 'success'); }
  error(msg) { this.show(msg, 'error', 5000); }
  info(msg) { this.show(msg, 'info'); }
}
