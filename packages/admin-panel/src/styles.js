// @docket/admin-panel — CSS styles
// All classes prefixed with tk- for isolation.
// Themeable via CSS custom properties.
//
// Per-component CSS chunks live in ./styles/. This file composes them in original order.

import { resetCss } from './styles/reset.css.js';
import { buttonsCss } from './styles/buttons.css.js';
import { formCss } from './styles/form.css.js';
import { filtersCss } from './styles/filters.css.js';
import { ticketCss } from './styles/ticket.css.js';
import { lightboxToastCss } from './styles/lightbox-toast.css.js';
import { rejectionCss } from './styles/rejection.css.js';
import { evidenceCss } from './styles/evidence.css.js';
import { runLogCss } from './styles/run-log.css.js';
import { snoozeCss } from './styles/snooze.css.js';
import { modalsCss } from './styles/modals.css.js';
import { feedbackCss } from './styles/feedback.css.js';
import { linksCss } from './styles/links.css.js';
import { convergenceCss } from './styles/convergence.css.js';
import { consensusCss } from './styles/consensus.css.js';

export function getStyles() {
  return '\n' + (
    resetCss + '\n' + buttonsCss + '\n' + formCss + '\n' + filtersCss + '\n' + ticketCss + '\n' + lightboxToastCss + '\n' + rejectionCss + '\n' + evidenceCss + '\n' + runLogCss + '\n' + snoozeCss + '\n' + modalsCss + '\n' + feedbackCss + '\n' + linksCss + '\n' + convergenceCss + '\n' + consensusCss
  ) + '\n';
}
