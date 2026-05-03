// Collapse-state persistence — top-level sections, per-card collapse,
// and per-card-subsection (Activity / Performance) state.
// All state lives in localStorage; only the keys differ.

import { PERSONAS } from '../config/personas.js';

export const collapseStateMixin = {
  // ── Collapse state ──────────────────────────────────────────

  _loadCollapsedState() {
    try {
      const raw = localStorage.getItem('adv-collapsed-personas');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: collapse all built-in persona card bodies on first visit.
    // Users can expand individual cards they need to configure.
    return new Set(PERSONAS.map(p => p.id));
  },

  _saveCollapsedState() {
    try {
      localStorage.setItem('adv-collapsed-personas', JSON.stringify([...this._collapsedPersonas]));
    } catch (_) { /* ignore */ }
  },

  // ── Section collapse state (top-level sidebar sections) ─────

  _loadSectionCollapseState() {
    try {
      const raw = localStorage.getItem('adv-collapsed-sections');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: 'personas' section is expanded; 'custom' section starts collapsed.
    return new Set(['custom']);
  },

  _saveSectionCollapseState() {
    try {
      localStorage.setItem('adv-collapsed-sections', JSON.stringify([...this._collapsedSections]));
    } catch (_) { /* ignore */ }
  },

  _toggleSectionCollapse(sectionId, bodyEl, chevronEl, headerEl) {
    const isCollapsed = this._collapsedSections.has(sectionId);
    if (isCollapsed) {
      this._collapsedSections.delete(sectionId);
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'true');
    } else {
      this._collapsedSections.add(sectionId);
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'false');
    }
    this._saveSectionCollapseState();
  },

  // ── Per-card subsection collapse state (Activity, Performance) ──

  // Per-card subsection collapse state uses an INVERTED set:
  // _collapsedCardSections stores keys that are EXPLICITLY EXPANDED.
  // A key absent from the set = collapsed (default for Activity & Performance).
  // This means new subsections (including custom persona subsections) start
  // collapsed by default without needing to pre-populate the set.
  _loadCardSectionCollapseState() {
    try {
      const raw = localStorage.getItem('adv-expanded-card-sections');
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Default: empty set = all subsections collapsed (Activity & Performance start hidden)
    return new Set();
  },

  _saveCardSectionCollapseState() {
    try {
      localStorage.setItem('adv-expanded-card-sections', JSON.stringify([...this._collapsedCardSections]));
    } catch (_) { /* ignore */ }
  },

  // key is in the set = explicitly expanded; absent = collapsed.
  _toggleCardSection(key, bodyEl, chevronEl, headerEl) {
    const isExpanded = this._collapsedCardSections.has(key);
    if (isExpanded) {
      // Collapse it
      this._collapsedCardSections.delete(key);
      bodyEl.classList.add('adv-hidden');
      chevronEl.textContent = '▸';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'false');
    } else {
      // Expand it
      this._collapsedCardSections.add(key);
      bodyEl.classList.remove('adv-hidden');
      chevronEl.textContent = '▾';
      if (headerEl) headerEl.setAttribute('aria-expanded', 'true');
    }
    this._saveCardSectionCollapseState();
  },

  _toggleCardCollapse(id) {
    const card = this._cards[id];
    if (!card || !card.cardBody) return;
    const isCollapsed = this._collapsedPersonas.has(id);
    if (isCollapsed) {
      this._collapsedPersonas.delete(id);
      card.cardBody.classList.remove('adv-hidden');
      card.card.classList.remove('adv-card-collapsed');
      card.collapseBtn.textContent = '▾';
      card.collapseBtn.title = 'Collapse';
      card.collapseBtn.setAttribute('aria-expanded', 'true');
    } else {
      this._collapsedPersonas.add(id);
      card.cardBody.classList.add('adv-hidden');
      card.card.classList.add('adv-card-collapsed');
      card.collapseBtn.textContent = '▸';
      card.collapseBtn.title = 'Expand';
      card.collapseBtn.setAttribute('aria-expanded', 'false');
    }
    this._saveCollapsedState();
  }
};
