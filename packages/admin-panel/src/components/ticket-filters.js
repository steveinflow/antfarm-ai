// @docket/admin-panel — TicketFilters: search bar + status tabs + dependency filter + sort control

import { el } from '../el.js';

export class TicketFilters {
  constructor({ onFilterChange, onSearchChange, onDependencyFilterChange, onSortChange }) {
    this.onFilterChange = onFilterChange;
    this.onSearchChange = onSearchChange;
    // onDependencyFilterChange: (filter: 'all'|'blocked'|'independent') => void
    this.onDependencyFilterChange = onDependencyFilterChange || null;
    // onSortChange: (sort: 'default'|'convergence') => void
    this.onSortChange = onSortChange || null;
    this.activeFilter = 'open';
    this.searchQuery = '';
    this.activeDependencyFilter = 'all'; // 'all' | 'blocked' | 'independent'
    this.activeSort = 'default'; // 'default' | 'convergence'
    this.hasConvergedTickets = false; // whether any ticket in the project has convergenceCount >= 2
    this.counts = {};
    this.el = null;
    this._tabsContainer = null;
    this._depFilterContainer = null;
    this._sortContainer = null;
  }

  render() {
    const searchInput = el('input', {
      type: 'text',
      placeholder: 'Search tickets…',
      value: this.searchQuery,
      onInput: (e) => {
        this.searchQuery = e.target.value;
        this.onSearchChange(this.searchQuery);
      },
    });

    this._tabsContainer = el('div', { className: 'tk-filter-tabs' });
    this._renderTabs();

    // Dependency filter — only shown when viewing proposed tickets
    this._depFilterContainer = el('div', { className: 'tk-dep-filter', style: { display: 'none' } });
    this._renderDepFilter();

    // Sort control — only shown when at least one ticket has convergenceCount >= 2
    this._sortContainer = el('div', { className: 'tk-sort-control', style: { display: 'none' } });
    this._renderSortControl();

    this.el = el('div', { className: 'tk-filters' },
      el('div', { className: 'tk-search-bar' },
        searchInput,
      ),
      this._tabsContainer,
      this._depFilterContainer,
      this._sortContainer,
    );

    return this.el;
  }

  _renderTabs() {
    if (!this._tabsContainer) return;
    this._tabsContainer.innerHTML = '';

    const filters = [
      { key: 'proposed', label: 'Proposed' },
      { key: 'open', label: 'Open' },
      { key: 'in_progress', label: 'In Progress' },
      { key: 'blocked', label: 'Blocked' },
      { key: 'in_maintenance', label: 'Maintenance' },
      { key: 'waiting_for_user', label: 'Waiting' },
      { key: 'done', label: 'Done' },
    ];

    filters.forEach(({ key, label }) => {
      const count = this.counts[key] ?? 0;
      const isActive = this.activeFilter === key;
      const tab = el('span', {
        className: 'tk-filter-tab' + (isActive ? ' tk-active' : ''),
        onClick: () => {
          this.activeFilter = key;
          this._renderTabs();
          this.onFilterChange(key);
          // Show dependency filter only on proposed tab
          this._updateDepFilterVisibility();
        },
      }, `${label} (${count})`);
      this._tabsContainer.appendChild(tab);
    });
  }

  _updateDepFilterVisibility() {
    if (!this._depFilterContainer) return;
    const show = this.activeFilter === 'proposed';
    this._depFilterContainer.style.display = show ? '' : 'none';
  }

  _renderDepFilter() {
    if (!this._depFilterContainer) return;
    this._depFilterContainer.innerHTML = '';

    const DEP_FILTERS = [
      { key: 'all', label: 'All proposals' },
      { key: 'blocked', label: 'Show blocked proposals' },
      { key: 'independent', label: 'Show independent proposals' },
    ];

    const label = el('span', { className: 'tk-dep-filter-label' }, 'Dependencies:');
    this._depFilterContainer.appendChild(label);

    for (const { key, labelText } of DEP_FILTERS.map(f => ({ key: f.key, labelText: f.label }))) {
      const isActive = this.activeDependencyFilter === key;
      const chip = el('button', {
        type: 'button',
        className: 'tk-dep-filter-chip' + (isActive ? ' tk-active' : ''),
        'aria-pressed': String(isActive),
        onClick: () => {
          this.activeDependencyFilter = key;
          this._renderDepFilter();
          if (this.onDependencyFilterChange) this.onDependencyFilterChange(key);
        },
      }, labelText);
      this._depFilterContainer.appendChild(chip);
    }
  }

  _renderSortControl() {
    if (!this._sortContainer) return;
    this._sortContainer.innerHTML = '';

    const labelEl = el('label', {
      className: 'tk-sort-label',
      htmlFor: 'tk-sort-select',
    }, 'Sort:');

    const select = el('select', {
      id: 'tk-sort-select',
      className: 'tk-sort-select',
      'aria-label': 'Sort tickets',
      onChange: (e) => {
        this.activeSort = e.target.value;
        if (this.onSortChange) this.onSortChange(this.activeSort);
      },
    },
      el('option', { value: 'default' }, 'Default'),
      el('option', { value: 'convergence' }, 'Convergence'),
    );
    select.value = this.activeSort;

    this._sortContainer.appendChild(labelEl);
    this._sortContainer.appendChild(select);
  }

  _updateSortVisibility() {
    if (!this._sortContainer) return;
    this._sortContainer.style.display = this.hasConvergedTickets ? '' : 'none';
  }

  setCounts(counts) {
    this.counts = counts;
    this._renderTabs();
  }

  setFilter(key) {
    this.activeFilter = key;
    this._renderTabs();
    this._updateDepFilterVisibility();
  }

  setHasConvergedTickets(val) {
    this.hasConvergedTickets = val;
    this._updateSortVisibility();
  }

  setSearch(query) {
    this.searchQuery = query;
    // Update the DOM search input if it exists
    if (this.el) {
      const input = this.el.querySelector('input[type="text"]');
      if (input) input.value = query;
    }
  }
}
