// @docket/admin-panel — TicketItem header mixin: quick actions row + status/badges
//
// Extracted from TicketItem to keep ticket-item/index.js focused on lifecycle.
// Mixed into TicketItem.prototype via Object.assign in index.js.

import { el } from '../../el.js';

export const headerMixin = {
  _renderQuickActions() {
    const t = this.ticket;

    const approveBtn = el('button', {
      className: 'tk-btn tk-btn-success tk-btn-sm tk-quick-approve',
      title: 'Approve this ticket',
      onClick: async (e) => {
        e.stopPropagation(); // don't toggle the card
        approveBtn.disabled = true;
        approveBtn.textContent = 'Approving…';
        try {
          await this.onTransition(t.id, 'open', { note: 'Approved by user' });
          this.toast.success('Ticket approved.');
        } catch (err) {
          this.toast.error('Failed: ' + err.message);
          approveBtn.disabled = false;
          approveBtn.textContent = '✓ Approve';
        }
      },
    }, '✓ Approve');

    const denyBtn = el('button', {
      className: 'tk-btn tk-btn-danger tk-btn-sm tk-quick-deny',
      title: 'Deny this ticket',
      onClick: async (e) => {
        e.stopPropagation(); // don't toggle the card
        denyBtn.disabled = true;
        denyBtn.textContent = 'Denying…';
        try {
          await this.onTransition(t.id, 'wont_do', { note: 'Denied by user' });
          this.toast.success("Ticket denied.");
        } catch (err) {
          this.toast.error('Failed: ' + err.message);
          denyBtn.disabled = false;
          denyBtn.textContent = '✗ Deny';
        }
      },
    }, '✗ Deny');

    return el('div', { className: 'tk-quick-actions' }, approveBtn, denyBtn);
  }
,

  _renderEvidenceBadge(t) {
    const reasoning = t.reasoning;
    if (!reasoning) return null;

    // Determine badge label from evidence array
    const evidence = Array.isArray(reasoning.evidence) ? reasoning.evidence : [];
    const hasFile = evidence.some(e => e.type === 'file');
    const hasScreenshot = evidence.some(e => e.type === 'screenshot');

    let label, cssClass;
    if (hasFile && hasScreenshot) {
      label = 'file + screenshot';
      cssClass = 'tk-evidence-badge tk-evidence-badge-mixed';
    } else if (hasFile) {
      label = 'file cited';
      cssClass = 'tk-evidence-badge tk-evidence-badge-file';
    } else if (hasScreenshot) {
      label = 'screenshot attached';
      cssClass = 'tk-evidence-badge tk-evidence-badge-screenshot';
    } else {
      label = 'reasoning only';
      cssClass = 'tk-evidence-badge tk-evidence-badge-summary';
    }

    return el('span', {
      className: cssClass,
      'aria-label': `Evidence type: ${label}`,
      title: `Evidence type: ${label}`,
    }, label);
  }

  // ── Cluster tags ──────────────────────────────────────────────────────────

  /**
   * Render inline cluster tags for a ticket.
   * Tags are shown on proposed and open tickets that have clusterIds.
   * Each tag is a button that filters the list by that cluster.
   * A "new theme" indicator is shown on clusters created at the same time
   * as this ticket (i.e. this ticket was the first in the cluster).
   *
   * Returns null if the ticket has no clusters or clusters data is empty.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */,

  _renderClusterTags(t) {
    const ids = Array.isArray(t.clusterIds) ? t.clusterIds : [];
    if (ids.length === 0) return null;
    if (!this.clusters || this.clusters.size === 0) return null;

    const tags = [];
    for (const cid of ids) {
      const cluster = this.clusters.get(cid);
      if (!cluster) continue;

      const label = cluster.label || 'Uncategorized';
      const count = cluster.ticketCount || 0;
      const isNew = cluster.ticketCount === 1; // this ticket was first in this cluster

      // Accessible label: "Filter by cluster: Auth, 7 tickets"
      const ariaLabel = `Filter by cluster: ${label}, ${count} ${count === 1 ? 'ticket' : 'tickets'}`;

      const tag = el('button', {
        type: 'button',
        className: 'tk-cluster-tag' + (isNew ? ' tk-cluster-tag-new' : ''),
        'aria-label': ariaLabel,
        title: ariaLabel,
        tabindex: '0',
        onClick: (e) => {
          e.stopPropagation(); // don't toggle ticket expansion
          if (this.onClusterFilter) this.onClusterFilter(cid);
        },
      },
        el('span', { className: 'tk-cluster-tag-label' }, label),
        el('span', { className: 'tk-cluster-tag-count', 'aria-hidden': 'true' }, String(count)),
        isNew ? el('span', { className: 'tk-cluster-tag-new-indicator', 'aria-label': 'New theme' }, '★') : null,
      );

      tags.push(tag);
    }

    if (tags.length === 0) return null;

    return el('div', { className: 'tk-cluster-tags', 'aria-label': 'Theme clusters' }, tags);
  }

  // ── Links badge (card-level) ──────────────────────────────────────────────

  /**
   * Render a compact relationship badge on the card header.
   * Shows "blocked by N", "blocks N", "N related", "N follow-up" counts.
   * Returns null if the ticket has no links.
   *
   * The badge is keyboard-accessible: Enter/Space opens the detail expand.
   * Color is not used as the sole differentiator — text labels are present.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */,

  _renderLinksBadge(t) {
    const links = Array.isArray(t.links) ? t.links : [];
    if (links.length === 0) return null;

    // Tally by type
    const counts = { blocks: 0, related: 0, 'follow-up': 0 };
    for (const link of links) {
      if (link.type && counts[link.type] !== undefined) counts[link.type]++;
    }

    const parts = [];
    if (counts.blocks > 0) {
      parts.push(el('span', { className: 'tk-links-badge-part tk-links-badge-blocks' },
        `blocks ${counts.blocks}`
      ));
    }
    if (counts.related > 0) {
      parts.push(el('span', { className: 'tk-links-badge-part tk-links-badge-related' },
        `${counts.related} related`
      ));
    }
    if (counts['follow-up'] > 0) {
      parts.push(el('span', { className: 'tk-links-badge-part tk-links-badge-followup' },
        `${counts['follow-up']} follow-up`
      ));
    }

    if (parts.length === 0) return null;

    const ariaLabel = `Linked: ${parts.map(p => p.textContent).join(', ')}`;
    return el('span', {
      className: 'tk-links-badge',
      'aria-label': ariaLabel,
      title: ariaLabel,
    }, ...parts);
  }

  // ── Convergence badge (card-level) ───────────────────────────────────────

  /**
   * Render a convergence badge when 2+ personas independently flagged the same area.
   * Shows "N personas" as text — count is always part of the visible label.
   * Only shown when convergenceCount >= 2.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */,

  _renderConvergenceBadge(t) {
    const count = typeof t.convergenceCount === 'number' ? t.convergenceCount : 0;
    if (count < 1) return null;
    // convergenceCount is the number of *other* tickets that converge, so total personas = count + 1
    const totalPersonas = count + 1;
    if (totalPersonas < 2) return null;
    const label = `${totalPersonas} personas`;
    return el('span', {
      className: 'tk-convergence-badge',
      'aria-label': `Also flagged by ${count} other persona${count === 1 ? '' : 's'}`,
      title: `Also flagged by ${count} other persona${count === 1 ? '' : 's'}`,
    }, label);
  }

  // ── Convergence section (detail view) ────────────────────────────────────

  /**
   * Render the "Also flagged by" collapsible section in the ticket detail view.
   * Shows sibling tickets from other personas that independently flagged the same area.
   * Each entry links to the sibling ticket and shows the persona + brief description.
   * Only rendered when convergence array has at least one entry.
   *
   * Section is keyboard-navigable via native <details>/<summary> elements.
   * aria-expanded is kept in sync on toggle for screen readers.
   *
   * @returns {HTMLElement|null}
   */,

  _getConsensusState(t) {
    const cm = t.consensusMetadata;
    if (!cm || typeof cm !== 'object') return null;
    const dv = cm.design && cm.design.verdict;
    const ev = cm.engineer && cm.engineer.verdict;
    if (!dv || !ev) return null;
    if (dv === 'approved' && ev === 'approved') return 'agree';
    if (dv === 'flagged' && ev === 'flagged') return 'split';
    return 'partial';
  }

  /**
   * Render a consensus badge for the ticket card header.
   * Three states: full agreement (✓), partial (△), split (✗).
   * Uses both color AND text/icon so color-blind users can distinguish.
   * Returns null if no consensusMetadata is present.
   *
   * @param {object} t - ticket
   * @returns {HTMLElement|null}
   */,

  _renderConsensusBadge(t) {
    const state = this._getConsensusState(t);
    if (!state) return null;

    const config = {
      agree:   { icon: '✓', label: 'agreed', cls: 'tk-consensus-agree',   title: 'Design + Engineer both approved' },
      partial: { icon: '△', label: 'partial', cls: 'tk-consensus-partial', title: 'Design + Engineer partially agreed' },
      split:   { icon: '✗', label: 'split',   cls: 'tk-consensus-split',   title: 'Design + Engineer disagreed' },
    }[state];

    const ariaLabel = `Consensus: ${config.title}`;
    return el('span', {
      className: `tk-consensus-badge ${config.cls}`,
      'aria-label': ariaLabel,
      title: config.title,
    },
      el('i', { className: 'tk-consensus-badge-icon', 'aria-hidden': 'true' }, config.icon),
      ` ${config.label}`,
    );
  }

  /**
   * Render the collapsible "Show consensus" disclosure accordion for the ticket
   * detail view. Collapsed by default. Only shown when consensusMetadata is present.
   *
   * Accessibility:
   *  - toggle button uses aria-expanded + aria-controls
   *  - on expand, focus is moved into the content area
   *  - persona rows use standard contrast and font-size (not fine print)
   *
   * @returns {HTMLElement|null}
   */,

};
