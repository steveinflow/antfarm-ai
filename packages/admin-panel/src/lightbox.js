// @docket/admin-panel — Lightbox overlay for full-size image preview
//
// Click the overlay (or the close button) to dismiss.

import { el } from './el.js';

export function openLightbox(src) {
  const overlay = el('div', { className: 'tk-lightbox', onClick: () => overlay.remove() },
    el('img', { src }),
    el('button', {
      className: 'tk-lightbox-close',
      onClick: (e) => { e.stopPropagation(); overlay.remove(); },
    }, '×'),
  );
  document.body.appendChild(overlay);
}
