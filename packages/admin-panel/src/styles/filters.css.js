// @docket/admin-panel — CSS extracted from styles.js (lines 371-443)

export const filtersCss = `/* --- Filter Tabs --- */
.tk-filters {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.tk-search-bar {
  position: relative;
}

.tk-search-bar input {
  width: 100%;
  padding: 10px 12px;
  font-size: 0.9rem;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  font-family: var(--tk-font);
  transition: border-color var(--tk-transition);
}

.tk-search-bar input:focus {
  outline: none;
  border-color: var(--tk-primary);
}

.tk-search-bar input::placeholder {
  color: var(--tk-text-secondary);
}

.tk-filter-tabs {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  padding-left: 12px;
  border-bottom: 1px solid var(--tk-border);
}

.tk-filter-tab {
  font-size: 0.9rem;
  font-weight: 500;
  background: none;
  border: none;
  color: var(--tk-text-secondary);
  cursor: pointer;
  padding: 4px 0;
  font-family: var(--tk-font);
  transition: color var(--tk-transition);
  position: relative;
}

.tk-filter-tab:hover {
  color: var(--tk-text);
}

.tk-filter-tab.tk-active {
  color: var(--tk-primary);
}

.tk-filter-tab.tk-active::after {
  content: '';
  position: absolute;
  bottom: -9px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--tk-primary);
}
`;
