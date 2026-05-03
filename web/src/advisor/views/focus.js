// Per-persona scope, focus, pins, and exclusion editors.
// Chip-based input UIs for narrowing or pinning what each persona
// looks at. DK-101 / DK-112 / DK-124 / DK-128 / DK-134 / DK-187.

import { el } from '../ui/el.js';
import { sanitizePromptValue } from '../helpers/persona.js';

export const focusMixin = {
  // ── Exclusion management (DK-128) ───────────────────────────────────────

  /**
   * Validate an exclusion pattern input field and update the validation element.
   * Returns true if valid (caller may proceed to add).
   *
   * @param {string} personaId  - 'engineer' | 'design'
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   * @returns {boolean}
   */
  _validateExclusionInput(personaId, inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) {
      validationEl.textContent = '';
      validationEl.className = 'adv-exclusion-validation';
      return false;
    }
    if (value.length > 200) {
      validationEl.textContent = '✗ Pattern exceeds 200 characters';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return false;
    }
    if (personaId === 'engineer') {
      // Reject pathological glob patterns (repeated wildcards)
      if (/\*{3,}|\*\*\/\*\*/.test(value)) {
        validationEl.textContent = '✗ Pattern contains repeated wildcards — simplify to **';
        validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
        return false;
      }
    } else if (personaId === 'design') {
      // Reject dangerous URL patterns
      const lower = value.toLowerCase();
      if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
        validationEl.textContent = '✗ Pattern must not match javascript: or data: URIs';
        validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
        return false;
      }
    }
    // Valid
    validationEl.textContent = '✓ valid';
    validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
    return true;
  },

  /**
   * Add an exclusion pattern from the input field to Firestore.
   * Enforces max 20 patterns, 200 chars per pattern.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   */
  async _addExclusion(personaId, inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const isValid = this._validateExclusionInput(personaId, inputEl, validationEl);
    if (!isValid) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      validationEl.textContent = '✗ Select a project first';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    const project = this._projects.find(p => p.id === projectId);
    const currentExclusions = Array.isArray(project?.exclusions?.[personaId])
      ? project.exclusions[personaId]
      : [];

    // Enforce max 20 patterns
    if (currentExclusions.length >= 20) {
      validationEl.textContent = '✗ Maximum of 20 exclusion patterns reached';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    // Avoid exact duplicates
    if (currentExclusions.includes(value)) {
      validationEl.textContent = '✓ Already in exclusion list';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
      inputEl.value = '';
      return;
    }

    const newExclusions = [...currentExclusions, value];
    this._exclusionSaving[personaId] = true;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { exclusions: { [personaId]: newExclusions } },
        { merge: true }
      );
      inputEl.value = '';
      validationEl.textContent = '';
      validationEl.className = 'adv-exclusion-validation';
    } catch (err) {
      validationEl.textContent = `✗ Save failed: ${err.message}`;
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      console.warn(`AdvisorPanel: failed to save exclusion for ${personaId}:`, err);
    } finally {
      this._exclusionSaving[personaId] = false;
    }
  },

  /**
   * Remove an exclusion pattern from the list for a persona.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   * @param {string} pattern    - Pattern to remove
   */
  async _removeExclusion(personaId, pattern) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    const project = this._projects.find(p => p.id === projectId);
    const currentExclusions = Array.isArray(project?.exclusions?.[personaId])
      ? project.exclusions[personaId]
      : [];

    const newExclusions = currentExclusions.filter(p => p !== pattern);

    try {
      await this.db.collection('projects').doc(projectId).set(
        { exclusions: { [personaId]: newExclusions } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove exclusion for ${personaId}:`, err);
    }
  },

  /**
   * Render the exclusion tag list for a persona from the current project data.
   * Called from _renderProjects() whenever project data changes.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   */
  _renderExclusionTags(personaId) {
    const card = this._cards[personaId];
    if (!card || !card.exclusionTagListEl) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const patterns = Array.isArray(project?.exclusions?.[personaId])
      ? project.exclusions[personaId]
      : [];

    card.exclusionTagListEl.innerHTML = '';

    if (patterns.length === 0) {
      card.exclusionTagListEl.appendChild(
        el('span', { className: 'adv-exclusion-empty' }, 'No exclusions set.')
      );
      return;
    }

    for (const pattern of patterns) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-tag-delete',
        title: `Remove exclusion: ${pattern}`,
        'aria-label': `Remove exclusion pattern ${pattern}`,
        // Keyboard accessible: Delete and Backspace both work (per a11y spec)
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removeExclusion(personaId, pattern);
          }
        },
        onClick: () => this._removeExclusion(personaId, pattern),
      }, '×');
      // Make button focusable per a11y spec
      deleteBtn.setAttribute('tabindex', '0');

      const tag = el('span', {
        className: 'adv-exclusion-tag',
        role: 'listitem',
      },
        el('span', { className: 'adv-exclusion-tag-text' }, pattern),
        deleteBtn,
      );
      card.exclusionTagListEl.appendChild(tag);
    }
  },

  /**
   * Load and display the exclusion suppression count ("N skipped this week").
   * Queries advisorRuns from the past 7 days, sums exclusionSkipCount.
   *
   * @param {string} personaId  - 'engineer' | 'design'
   */
  async _loadExclusionSkipCount(personaId) {
    const card = this._cards[personaId];
    if (!card || !card.exclusionSkipCountEl) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const snap = await this.db.collection('advisorRuns')
        .where('persona', '==', personaId)
        .where('projectId', '==', projectId)
        .where('startedAt', '>=', cutoff)
        .where('status', '==', 'completed')
        .get();

      let total = 0;
      for (const doc of snap.docs) {
        const count = doc.data()?.exclusionSkipCount;
        if (typeof count === 'number' && count > 0) total += count;
      }

      if (total > 0) {
        card.exclusionSkipCountEl.textContent = `${total} suggestion${total === 1 ? '' : 's'} skipped this week`;
        card.exclusionSkipCountEl.classList.remove('adv-hidden');
      } else {
        card.exclusionSkipCountEl.classList.add('adv-hidden');
      }
    } catch {
      // Non-fatal — skip count is informational only
      card.exclusionSkipCountEl.classList.add('adv-hidden');
    }
  },

  // ── DK-112: Topic Exclusion Rules management ─────────────────────────────

  /**
   * Validate a topic exclusion rule input value.
   * Returns true if valid, false if invalid. Updates validationEl with feedback.
   *
   * Rules mirror the server-side sanitizeTopicExclusion() in prompt-builder.js:
   * - Max 100 characters
   * - No newlines
   * - No injection keywords (ignore, system:, assistant:, prompt, XML tags)
   *
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   * @returns {boolean}
   */
  _validateTopicExclInput(inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) {
      validationEl.textContent = '';
      validationEl.className = 'adv-exclusion-validation';
      return false;
    }
    if (value.length > 100) {
      validationEl.textContent = '✗ Rule exceeds 100 characters';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return false;
    }
    // Client-side injection pattern checks (mirrors prompt-builder.js)
    const INJECTION_PATTERNS = [
      { re: /\n/, msg: 'Rule must not contain newlines' },
      { re: /\bignore\b/i, msg: 'Rule contains reserved keyword "ignore"' },
      { re: /system:/i, msg: 'Rule contains reserved prefix "system:"' },
      { re: /assistant:/i, msg: 'Rule contains reserved prefix "assistant:"' },
      { re: /\bprompt\b/i, msg: 'Rule contains reserved keyword "prompt"' },
      { re: /<\/?[a-z]+>/i, msg: 'Rule must not contain HTML or XML tags' },
    ];
    for (const { re, msg } of INJECTION_PATTERNS) {
      if (re.test(value)) {
        validationEl.textContent = `✗ ${msg}`;
        validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
        return false;
      }
    }
    validationEl.textContent = '✓ valid';
    validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
    return true;
  },

  /**
   * Add a topic exclusion rule for a persona from the input field.
   * Writes to project.advisor.topicExclusions.{personaId} in Firestore.
   * Shows an undo toast immediately after adding.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   */
  async _addTopicExclusion(personaId, inputEl, validationEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const isValid = this._validateTopicExclInput(inputEl, validationEl);
    if (!isValid) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      validationEl.textContent = '✗ Select a project first';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    const project = this._projects.find(p => p.id === projectId);
    const currentRules = Array.isArray(project?.advisor?.topicExclusions?.[personaId])
      ? project.advisor.topicExclusions[personaId]
      : [];

    if (currentRules.length >= 25) {
      validationEl.textContent = '✗ Maximum of 25 exclusion rules reached';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      return;
    }

    if (currentRules.includes(value)) {
      validationEl.textContent = '✓ Already in exclusion list';
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
      inputEl.value = '';
      return;
    }

    const newRules = [...currentRules, value];
    this._topicExclSaving[personaId] = true;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { topicExclusions: { [personaId]: newRules } } },
        { merge: true }
      );
      inputEl.value = '';
      validationEl.textContent = `✓ Rule saved — ${personaId} will not propose "${value}"`;
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-ok';
      setTimeout(() => {
        if (validationEl.className === 'adv-exclusion-validation adv-exclusion-validation-ok') {
          validationEl.textContent = '';
          validationEl.className = 'adv-exclusion-validation';
        }
      }, 3000);
    } catch (err) {
      validationEl.textContent = `✗ Save failed: ${err.message}`;
      validationEl.className = 'adv-exclusion-validation adv-exclusion-validation-err';
      console.warn(`AdvisorPanel: failed to save topic exclusion for ${personaId}:`, err);
    } finally {
      this._topicExclSaving[personaId] = false;
    }
  },

  /**
   * Remove a topic exclusion rule from the list for a persona.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   * @param {string} rule - The rule text to remove
   */
  async _removeTopicExclusion(personaId, rule) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    const project = this._projects.find(p => p.id === projectId);
    const currentRules = Array.isArray(project?.advisor?.topicExclusions?.[personaId])
      ? project.advisor.topicExclusions[personaId]
      : [];

    const newRules = currentRules.filter(r => r !== rule);

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { topicExclusions: { [personaId]: newRules } } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove topic exclusion for ${personaId}:`, err);
    }
  },

  /**
   * Render the topic exclusion tag list for a persona from current project data.
   * Called from _renderProjects() whenever project data changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderTopicExclusions(personaId) {
    const card = this._cards[personaId];
    if (!card || !card.topicExclTagListEl) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const rules = Array.isArray(project?.advisor?.topicExclusions?.[personaId])
      ? project.advisor.topicExclusions[personaId]
      : [];

    card.topicExclTagListEl.innerHTML = '';

    if (rules.length === 0) {
      card.topicExclTagListEl.appendChild(
        el('span', { className: 'adv-exclusion-empty adv-tex-empty' },
          'No exclusion rules set. The fastest way to add rules is via the "Never suggest" button on proposal cards in the triage queue.',
        )
      );
      return;
    }

    for (const rule of rules) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-exclusion-tag-delete',
        title: `Remove exclusion rule: ${rule}`,
        'aria-label': `Remove topic exclusion rule: ${rule}`,
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removeTopicExclusion(personaId, rule);
          }
        },
        onClick: () => this._removeTopicExclusion(personaId, rule),
      }, '×');
      deleteBtn.setAttribute('tabindex', '0');

      const tag = el('span', {
        className: 'adv-exclusion-tag',
        role: 'listitem',
      },
        el('span', { className: 'adv-exclusion-tag-text' }, rule),
        deleteBtn,
      );
      card.topicExclTagListEl.appendChild(tag);
    }
  },

  // ── Focus Areas management (DK-101) ─────────────────────────────────────

  /**
   * Render the Focus Areas UI for a persona from current project data.
   * Called from _renderProjects() when project data changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderFocusAreas(personaId) {
    const state = this._focusAreasState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const focusData = project?.advisor?.projects?.[projectId]?.[personaId] ?? {};

    // ── Render chip lists for engineer and design ──────────────────
    if (personaId === 'engineer') {
      this._renderFocusChipList(personaId, 'includePaths', Array.isArray(focusData.includePaths) ? focusData.includePaths : []);
      this._renderFocusChipList(personaId, 'excludePaths', Array.isArray(focusData.excludePaths) ? focusData.excludePaths : []);
    } else if (personaId === 'design') {
      this._renderFocusChipList(personaId, 'urlPatterns', Array.isArray(focusData.urlPatterns) ? focusData.urlPatterns : []);
    } else if (personaId === 'product') {
      // Update text inputs
      const segInput = state.inputs?.['targetSegment'];
      if (segInput && !segInput.matches(':focus')) {
        segInput.value = typeof focusData.targetSegment === 'string' ? focusData.targetSegment : '';
      }
      const goalInput = state.inputs?.['businessGoal'];
      if (goalInput && !goalInput.matches(':focus')) {
        goalInput.value = typeof focusData.businessGoal === 'string' ? focusData.businessGoal : '';
      }
    }

    // ── Update summary chip ─────────────────────────────────────
    const chipEl = state.summaryChipEl;
    if (!chipEl) return;

    let activeCount = 0;
    if (personaId === 'engineer') {
      activeCount += (focusData.includePaths?.length ?? 0) + (focusData.excludePaths?.length ?? 0);
    } else if (personaId === 'design') {
      activeCount += (focusData.urlPatterns?.length ?? 0);
    } else if (personaId === 'product') {
      if (focusData.targetSegment?.trim()) activeCount++;
      if (focusData.businessGoal?.trim()) activeCount++;
    }

    if (activeCount > 0) {
      chipEl.textContent = `${activeCount} constraint${activeCount === 1 ? '' : 's'} active`;
      chipEl.classList.remove('adv-hidden');
    } else {
      chipEl.textContent = '';
      chipEl.classList.add('adv-hidden');
    }
  },

  /**
   * Render a chip list for a focus areas field.
   *
   * @param {string} personaId
   * @param {string} fieldKey - 'includePaths' | 'excludePaths' | 'urlPatterns'
   * @param {string[]} values
   */
  _renderFocusChipList(personaId, fieldKey, values) {
    const state = this._focusAreasState?.[personaId];
    if (!state) return;
    const listEl = state.chipData?.[fieldKey];
    if (!listEl) return;

    listEl.innerHTML = '';

    if (values.length === 0) {
      listEl.appendChild(el('span', { className: 'adv-focus-areas-empty' }, 'None set.'));
      return;
    }

    for (const value of values) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-focus-areas-chip-delete',
        title: `Remove: ${value}`,
        'aria-label': `Remove ${fieldKey} entry: ${value}`,
        tabindex: '0',
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removeFocusAreaChip(personaId, fieldKey, value);
          }
          if (e.key === 'ArrowLeft') {
            const prev = deleteBtn.closest('.adv-focus-areas-chip')?.previousElementSibling?.querySelector('.adv-focus-areas-chip-delete');
            if (prev) prev.focus();
          }
          if (e.key === 'ArrowRight') {
            const next = deleteBtn.closest('.adv-focus-areas-chip')?.nextElementSibling?.querySelector('.adv-focus-areas-chip-delete');
            if (next) next.focus();
          }
        },
        onClick: () => this._removeFocusAreaChip(personaId, fieldKey, value),
      }, '×');

      listEl.appendChild(
        el('span', { className: 'adv-focus-areas-chip', role: 'listitem' },
          el('span', { className: 'adv-focus-areas-chip-text' }, value),
          deleteBtn,
        )
      );
    }
  },

  /**
   * Add a chip value to a focus areas field (engineer/design chip inputs).
   * Validates the value and saves to Firestore.
   *
   * @param {string} personaId
   * @param {string} fieldKey - 'includePaths' | 'excludePaths' | 'urlPatterns'
   * @param {HTMLInputElement} inputEl
   */
  async _addFocusAreaChip(personaId, fieldKey, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    // Validation
    if (value.length > 200) return;

    // For urlPatterns: reject schemes/hostnames
    if (fieldKey === 'urlPatterns') {
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value) || /^\/\//.test(value)) {
        const state = this._focusAreasState?.[personaId];
        if (state?.inputs?.['_validationEl']) {
          state.inputs['_validationEl'].textContent = '✗ Relative paths only — no scheme or hostname';
        }
        return;
      }
    }

    // For includePaths/excludePaths: reject absolute paths
    if (fieldKey === 'includePaths' || fieldKey === 'excludePaths') {
      if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
        return; // Silently reject absolute paths — tooltip explains
      }
    }

    const project = this._projects.find(p => p.id === projectId);
    const existing = project?.advisor?.projects?.[projectId]?.[personaId]?.[fieldKey] ?? [];
    if (!Array.isArray(existing)) return;

    // Max 20 chips per field
    if (existing.length >= 20) return;

    // Avoid exact duplicates
    if (existing.includes(value)) {
      inputEl.value = '';
      return;
    }

    const newValues = [...existing, value];
    if (this._focusAreasSaving[personaId]) return;
    this._focusAreasSaving[personaId] = true;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { [personaId]: { [fieldKey]: newValues } } } } },
        { merge: true }
      );
      inputEl.value = '';
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save focusArea ${fieldKey} for ${personaId}:`, err);
    } finally {
      this._focusAreasSaving[personaId] = false;
    }
  },

  /**
   * Remove the last chip from a focus areas field.
   *
   * @param {string} personaId
   * @param {string} fieldKey
   */
  async _removeLastFocusAreaChip(personaId, fieldKey) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;
    const project = this._projects.find(p => p.id === projectId);
    const existing = project?.advisor?.projects?.[projectId]?.[personaId]?.[fieldKey] ?? [];
    if (!Array.isArray(existing) || existing.length === 0) return;
    await this._removeFocusAreaChip(personaId, fieldKey, existing[existing.length - 1]);
  },

  /**
   * Remove a specific chip value from a focus areas field.
   *
   * @param {string} personaId
   * @param {string} fieldKey
   * @param {string} value
   */
  async _removeFocusAreaChip(personaId, fieldKey, value) {
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;
    const project = this._projects.find(p => p.id === projectId);
    const existing = project?.advisor?.projects?.[projectId]?.[personaId]?.[fieldKey] ?? [];
    if (!Array.isArray(existing)) return;
    const newValues = existing.filter(v => v !== value);

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { [personaId]: { [fieldKey]: newValues } } } } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove focusArea chip for ${personaId}/${fieldKey}:`, err);
    }
  },

  /**
   * Save the product persona focus area text fields (targetSegment, businessGoal).
   *
   * @param {string} personaId - always 'product'
   */
  async _saveProductFocusAreas(personaId) {
    const state = this._focusAreasState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      const statusEl = state.inputs?.['_saveStatusEl'];
      if (statusEl) {
        statusEl.textContent = 'Select a project first';
        statusEl.className = 'adv-focus-areas-save-status adv-focus-areas-save-status-err';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'adv-focus-areas-save-status'; }, 3000);
      }
      return;
    }

    if (this._focusAreasSaving[personaId]) return;
    this._focusAreasSaving[personaId] = true;

    const statusEl = state.inputs?.['_saveStatusEl'];
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'adv-focus-areas-save-status'; }

    const targetSegment = (state.inputs?.['targetSegment']?.value ?? '').trim().slice(0, 200) || null;
    const businessGoal = (state.inputs?.['businessGoal']?.value ?? '').trim().slice(0, 200) || null;

    try {
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { product: { targetSegment, businessGoal } } } } },
        { merge: true }
      );
      if (statusEl) {
        statusEl.textContent = 'Saved — applies on next run';
        statusEl.className = 'adv-focus-areas-save-status adv-focus-areas-save-status-ok';
        setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-focus-areas-save-status'; } }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save product focusAreas:`, err);
      if (statusEl) {
        statusEl.textContent = '✗ Save failed';
        statusEl.className = 'adv-focus-areas-save-status adv-focus-areas-save-status-err';
        setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-focus-areas-save-status'; } }, 4000);
      }
    } finally {
      this._focusAreasSaving[personaId] = false;
    }
  },

  // ── DK-124: Focus area pins methods ──────────────────────────────────────

  /**
   * Render the pins chip list for a persona from project Firestore state.
   * Called after project data changes (onProjectsChange).
   *
   * @param {string} personaId - 'engineer' | 'design'
   */
  _renderPins(personaId) {
    const state = this._pinsState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const pins = Array.isArray(project?.advisorPins?.[personaId])
      ? project.advisorPins[personaId]
      : [];

    // Sync draft to Firestore state (only when not actively editing)
    if (!this._pinsSaving[personaId]) {
      this._pinsDraft[personaId] = [...pins];
    }

    // Render chip list
    this._renderPinsChipList(personaId, this._pinsDraft[personaId] ?? pins);

    // Update summary chip
    const count = (this._pinsDraft[personaId] ?? pins).length;
    if (count > 0) {
      state.summaryChipEl.textContent = `${count} pin${count === 1 ? '' : 's'} active`;
      state.summaryChipEl.classList.remove('adv-hidden');
    } else {
      state.summaryChipEl.textContent = '';
      state.summaryChipEl.classList.add('adv-hidden');
    }

    // Staleness warning: shown when the last run warned about dead pins
    // (written to project.advisorPins._stalenessWarning.{personaId})
    const staleWarning = project?.advisorPins?._stalenessWarning?.[personaId];
    if (staleWarning && typeof staleWarning === 'string') {
      state.stalenessEl.textContent = `⚠ ${staleWarning}`;
      state.stalenessEl.classList.remove('adv-hidden');
    } else {
      state.stalenessEl.textContent = '';
      state.stalenessEl.classList.add('adv-hidden');
    }
  },

  /**
   * Render the chip list UI for current draft pins.
   *
   * @param {string} personaId
   * @param {string[]} values
   */
  _renderPinsChipList(personaId, values) {
    const state = this._pinsState?.[personaId];
    if (!state) return;
    const listEl = state.chipListEl;
    if (!listEl) return;

    listEl.innerHTML = '';

    if (!values || values.length === 0) {
      listEl.appendChild(el('span', { className: 'adv-pins-empty' }, 'No pins set.'));
      return;
    }

    for (const value of values) {
      const deleteBtn = el('button', {
        type: 'button',
        className: 'adv-pins-chip-delete',
        title: `Remove: ${value}`,
        'aria-label': `Remove pin: ${value}`,
        tabindex: '0',
        onKeyDown: (e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this._removePinsChip(personaId, value);
          }
          if (e.key === 'ArrowLeft') {
            const prev = e.currentTarget.closest('[role="listitem"]')?.previousElementSibling?.querySelector('button');
            if (prev) prev.focus();
          }
          if (e.key === 'ArrowRight') {
            const next = e.currentTarget.closest('[role="listitem"]')?.nextElementSibling?.querySelector('button');
            if (next) next.focus();
          }
        },
        onClick: () => this._removePinsChip(personaId, value),
      }, '×');

      const chip = el('span', {
        className: 'adv-pins-chip',
        role: 'listitem',
      },
        el('span', { className: 'adv-pins-chip-label' }, value),
        deleteBtn,
      );
      listEl.appendChild(chip);
    }
  },

  /**
   * Validate a pin value for the given persona before adding to the draft.
   * Returns { valid: true } or { valid: false, reason: string }.
   *
   * @param {string} personaId - 'engineer' | 'design'
   * @param {string} value
   * @returns {{ valid: boolean, reason?: string }}
   */
  _validatePin(personaId, value) {
    if (!value || !value.trim()) {
      return { valid: false, reason: 'Value must not be empty' };
    }
    const v = value.trim();
    if (personaId === 'engineer') {
      if (v.length > 64) return { valid: false, reason: 'Max 64 characters per glob' };
      if (v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:[\\/]/.test(v)) {
        return { valid: false, reason: 'Relative paths only — no leading / ~ or drive letter' };
      }
      if (v.replace(/\\/g, '/').split('/').includes('..')) {
        return { valid: false, reason: 'Path must not contain ".." sequences' };
      }
    } else if (personaId === 'design') {
      if (v.length > 200) return { valid: false, reason: 'Max 200 characters per path' };
      if (!v.startsWith('/')) return { valid: false, reason: 'URL paths must start with /' };
      if (v.startsWith('//') || /^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) {
        return { valid: false, reason: 'Relative paths only — no scheme or hostname' };
      }
    }
    return { valid: true };
  },

  /**
   * Add a pin chip to the draft (local state only — saved on explicit button press).
   *
   * @param {string} personaId
   * @param {HTMLInputElement} inputEl
   * @param {HTMLElement} validationEl
   */
  _addPinsChip(personaId, inputEl, validationEl) {
    const value = (inputEl.value || '').trim();
    if (!value) return;

    const result = this._validatePin(personaId, value);
    if (!result.valid) {
      if (validationEl) {
        validationEl.textContent = `✗ ${result.reason}`;
        setTimeout(() => { if (validationEl) validationEl.textContent = ''; }, 3000);
      }
      return;
    }

    if (validationEl) validationEl.textContent = '';

    const draft = this._pinsDraft[personaId] ?? [];
    if (draft.length >= 20) {
      if (validationEl) {
        validationEl.textContent = '✗ Maximum 20 pins per persona';
        setTimeout(() => { if (validationEl) validationEl.textContent = ''; }, 3000);
      }
      return;
    }
    if (draft.includes(value)) {
      inputEl.value = '';
      return;
    }

    this._pinsDraft[personaId] = [...draft, value];
    inputEl.value = '';
    this._renderPinsChipList(personaId, this._pinsDraft[personaId]);

    // Update summary chip count
    const state = this._pinsState?.[personaId];
    const count = this._pinsDraft[personaId].length;
    if (state?.summaryChipEl) {
      state.summaryChipEl.textContent = `${count} pin${count === 1 ? '' : 's'} active`;
      state.summaryChipEl.classList.remove('adv-hidden');
    }
  },

  /**
   * Remove the last chip from the draft.
   *
   * @param {string} personaId
   * @param {HTMLElement} validationEl
   */
  _removeLastPinsChip(personaId, validationEl) {
    const draft = this._pinsDraft[personaId] ?? [];
    if (draft.length === 0) return;
    this._removePinsChip(personaId, draft[draft.length - 1]);
  },

  /**
   * Remove a specific chip value from the draft.
   *
   * @param {string} personaId
   * @param {string} value
   */
  _removePinsChip(personaId, value) {
    const draft = this._pinsDraft[personaId] ?? [];
    this._pinsDraft[personaId] = draft.filter(v => v !== value);
    this._renderPinsChipList(personaId, this._pinsDraft[personaId]);

    const state = this._pinsState?.[personaId];
    const count = this._pinsDraft[personaId].length;
    if (state?.summaryChipEl) {
      if (count > 0) {
        state.summaryChipEl.textContent = `${count} pin${count === 1 ? '' : 's'} active`;
        state.summaryChipEl.classList.remove('adv-hidden');
      } else {
        state.summaryChipEl.textContent = '';
        state.summaryChipEl.classList.add('adv-hidden');
      }
    }
  },

  /**
   * Save the current draft pins to Firestore.
   * Writes the full advisorPins.{personaId} array (not a merge) to avoid drift.
   * Shows a visible "Saved" confirmation after write.
   *
   * @param {string} personaId - 'engineer' | 'design'
   */
  async _savePins(personaId) {
    const state = this._pinsState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = 'Select a project first';
        state.saveStatusEl.className = 'adv-pins-save-status adv-pins-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-pins-save-status'; } }, 3000);
      }
      return;
    }

    if (this._pinsSaving[personaId]) return;
    this._pinsSaving[personaId] = true;

    if (state.saveBtn) state.saveBtn.disabled = true;
    if (state.saveStatusEl) {
      state.saveStatusEl.textContent = 'Saving…';
      state.saveStatusEl.className = 'adv-pins-save-status';
    }

    // Validate all draft values again before writing
    const draft = this._pinsDraft[personaId] ?? [];
    const validPins = draft.filter(v => this._validatePin(personaId, v).valid).slice(0, 20);

    try {
      // Write the full advisorPins.{personaId} field (not a sub-merge) to avoid partial-update drift.
      // Use dot-notation path so we only touch this persona's key, not the whole advisorPins map.
      await this.db.collection('projects').doc(projectId).set(
        { advisorPins: { [personaId]: validPins } },
        { merge: true },
      );

      // Clear staleness warning on explicit save (user acknowledged or fixed the issue)
      await this.db.collection('projects').doc(projectId).set(
        { advisorPins: { _stalenessWarning: { [personaId]: null } } },
        { merge: true },
      );

      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = 'Saved';
        state.saveStatusEl.className = 'adv-pins-save-status adv-pins-save-status-ok';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-pins-save-status'; } }, 2500);
      }
      if (state.stalenessEl) {
        state.stalenessEl.textContent = '';
        state.stalenessEl.classList.add('adv-hidden');
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save pins for ${personaId}:`, err);
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = '✗ Save failed';
        state.saveStatusEl.className = 'adv-pins-save-status adv-pins-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-pins-save-status'; } }, 4000);
      }
    } finally {
      this._pinsSaving[personaId] = false;
      if (state.saveBtn) state.saveBtn.disabled = false;
    }
  },

  // ── DK-187: Focus constraint methods ─────────────────────────────────────

  /**
   * Render the focus constraints chip list for a persona from Firestore state.
   * Called from _renderCard (via _states listener) and after project filter changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderFocusConstraints(personaId) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;

    const personaState = this._states[personaId];
    const focus = personaState?.focus ?? null;
    const values = Array.isArray(focus?.[state.fieldKey]) ? focus[state.fieldKey] : [];

    // Rebuild chip list
    const listEl = state.chipListEl;
    if (!listEl) return;
    listEl.innerHTML = '';

    if (values.length === 0) {
      listEl.appendChild(el('span', { className: 'adv-focus-areas-empty' }, 'Watching everything'));
    } else {
      for (const value of values) {
        const deleteBtn = el('button', {
          type: 'button',
          className: 'adv-focus-areas-chip-delete',
          title: `Remove: ${value}`,
          'aria-label': `Remove ${state.fieldKey} entry: ${value}`,
          tabindex: '0',
          onKeyDown: (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              this._removeFocusConstraintChip(personaId, value);
            }
            if (e.key === 'ArrowLeft') {
              const prev = deleteBtn.closest('.adv-focus-areas-chip')?.previousElementSibling?.querySelector('.adv-focus-areas-chip-delete');
              if (prev) prev.focus();
            }
            if (e.key === 'ArrowRight') {
              const next = deleteBtn.closest('.adv-focus-areas-chip')?.nextElementSibling?.querySelector('.adv-focus-areas-chip-delete');
              if (next) next.focus();
            }
          },
          onClick: () => this._removeFocusConstraintChip(personaId, value),
        }, '×');
        deleteBtn.setAttribute('aria-label', `Remove ${state.fieldKey} entry: ${value}`);

        listEl.appendChild(
          el('span', { className: 'adv-focus-areas-chip', role: 'listitem' },
            el('span', { className: 'adv-focus-areas-chip-text', title: value }, value),
            deleteBtn,
          )
        );
      }
    }

    // Update summary chip in header
    const summaryChip = state.summaryChipEl;
    if (summaryChip) {
      if (values.length > 0) {
        const unit = { globs: 'glob', routes: 'route', keywords: 'keyword' }[state.fieldKey] || 'item';
        summaryChip.textContent = `${values.length} ${unit}${values.length === 1 ? '' : 's'}`;
        summaryChip.title = values.join(', ');
        summaryChip.classList.remove('adv-hidden');
      } else {
        summaryChip.textContent = '';
        summaryChip.classList.add('adv-hidden');
      }
    }
  },

  /**
   * Add a chip to the focus constraints field (immediate Firestore save per chip add).
   * Validates the value client-side before writing.
   *
   * @param {string} personaId
   * @param {HTMLInputElement} inputEl
   */
  async _addFocusConstraintChip(personaId, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;

    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;

    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];

    // Enforce max per field
    const maxItems = { globs: 10, routes: 10, keywords: 20 }[state.fieldKey] ?? 10;
    if (existing.length >= maxItems) return;

    // Enforce max length
    const maxLen = { globs: 100, routes: 100, keywords: 50 }[state.fieldKey] ?? 100;
    if (value.length > maxLen) return;

    // Avoid duplicates
    if (existing.includes(value)) {
      inputEl.value = '';
      return;
    }

    // Client-side safety checks (mirroring focus-validator.js)
    if (personaId === 'engineer') {
      if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('..')) return;
      if ((value.match(/\*\*/g) || []).length > 1) return;
    }
    if (personaId === 'design') {
      if (!value.startsWith('/')) return;
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value) || /^\/\//.test(value)) return;
    }

    const newValues = [...existing, value];
    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: newValues } },
        { merge: true }
      );
      inputEl.value = '';
      // Reset dirty state (this chip was immediately saved)
      if (state) { state.dirty = false; state.saveBtn?.classList.remove('adv-fc-save-dirty'); }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to add focus constraint chip for ${personaId}:`, err);
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  },

  /**
   * Remove the last chip from the focus constraints field.
   * @param {string} personaId
   */
  async _removeLastFocusConstraintChip(personaId) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;
    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];
    if (existing.length === 0) return;
    await this._removeFocusConstraintChip(personaId, existing[existing.length - 1]);
  },

  /**
   * Remove a specific chip value from the focus constraints field.
   * Immediately saves to Firestore.
   *
   * @param {string} personaId
   * @param {string} value
   */
  async _removeFocusConstraintChip(personaId, value) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;
    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];
    const newValues = existing.filter(v => v !== value);
    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;
    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: newValues } },
        { merge: true }
      );
    } catch (err) {
      console.warn(`AdvisorPanel: failed to remove focus constraint chip for ${personaId}:`, err);
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  },

  /**
   * Save the current focus constraint chip list.
   * Called by the Save button.
   * @param {string} personaId
   */
  async _saveFocusConstraints(personaId) {
    // Chips are already saved on add/remove; Save just clears the dirty flag + shows confirmation.
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;

    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;

    const { saveBtn, saveStatusEl } = state;
    if (saveStatusEl) { saveStatusEl.textContent = 'Saving…'; saveStatusEl.className = 'adv-fc-save-status'; }

    // Get current chips from state (already saved piecemeal on add, but re-save for full replace)
    const existing = Array.isArray(this._states[personaId]?.focus?.[state.fieldKey])
      ? this._states[personaId].focus[state.fieldKey]
      : [];

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: existing } },
        { merge: true }
      );
      state.dirty = false;
      if (saveBtn) saveBtn.classList.remove('adv-fc-save-dirty');
      if (saveStatusEl) {
        saveStatusEl.textContent = '✓ Saved — applies on next run';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-ok';
        setTimeout(() => {
          if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; }
        }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save focus constraints for ${personaId}:`, err);
      if (saveStatusEl) {
        saveStatusEl.textContent = '✗ Save failed';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-err';
        setTimeout(() => { if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; } }, 4000);
      }
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  },

  /**
   * Clear all focus constraints for a persona — returns to "Watching everything".
   * @param {string} personaId
   */
  async _clearFocusConstraints(personaId) {
    const state = this._focusConstraintsState?.[personaId];
    if (!state) return;
    if (this._focusConstraintsSaving[personaId]) return;
    this._focusConstraintsSaving[personaId] = true;

    const { saveStatusEl, saveBtn } = state;
    if (saveStatusEl) { saveStatusEl.textContent = 'Clearing…'; saveStatusEl.className = 'adv-fc-save-status'; }

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { focus: { [state.fieldKey]: [] } },
        { merge: true }
      );
      state.dirty = false;
      if (saveBtn) saveBtn.classList.remove('adv-fc-save-dirty');
      if (saveStatusEl) {
        saveStatusEl.textContent = '✓ Cleared — watching everything';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-ok';
        setTimeout(() => { if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; } }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to clear focus constraints for ${personaId}:`, err);
      if (saveStatusEl) {
        saveStatusEl.textContent = '✗ Clear failed';
        saveStatusEl.className = 'adv-fc-save-status adv-fc-save-status-err';
        setTimeout(() => { if (saveStatusEl) { saveStatusEl.textContent = ''; saveStatusEl.className = 'adv-fc-save-status'; } }, 4000);
      }
    } finally {
      this._focusConstraintsSaving[personaId] = false;
    }
  },

  // ── DK-134: Scope config per persona (chip-based topics + path filters) ──────

  /**
   * Toggle the scope config drawer open/closed.
   * @param {string} personaId
   */
  _toggleScopedFocusDrawer(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;
    state.drawerOpen = !state.drawerOpen;
    state.drawerEl.classList.toggle('adv-hidden', !state.drawerOpen);
    state.gearBtn.setAttribute('aria-expanded', String(state.drawerOpen));
    state.gearBtn.title = state.drawerOpen
      ? 'Close scope focus areas'
      : 'Configure scope focus areas';
    // Move focus into topics input when opening (accessibility)
    if (state.drawerOpen && state.topicsInputEl) {
      setTimeout(() => state.topicsInputEl.focus(), 50);
    }
  },

  /**
   * Render the scoped focus UI for a persona from current project data.
   * Reads new DK-134 scope schema (arrays) with fallback to DK-301 string fields.
   * Called from _renderProjects() and setProjectFilter() when project data changes.
   *
   * @param {string} personaId - 'engineer' | 'design' | 'product'
   */
  _renderScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;

    // DK-134: Read new scope schema (arrays) stored at advisor.projects.<projectId>.<personaId>.scope
    const scopeData = project?.advisor?.projects?.[projectId]?.[personaId]?.scope ?? {};
    // Fallback: DK-301 legacy string fields at focusAreas.<personaId>
    const legacyFocusAreas = project?.advisor?.projects?.[projectId]?.focusAreas?.[personaId] ?? {};

    // Merge: prefer new array schema; fall back to legacy string parsing
    let topics = Array.isArray(scopeData.topics) ? scopeData.topics : [];
    let include = Array.isArray(scopeData.include) ? scopeData.include : [];
    let exclude = Array.isArray(scopeData.exclude) ? scopeData.exclude : [];

    // Legacy migration: if new arrays are empty but legacy string fields exist, import them
    if (topics.length === 0 && typeof legacyFocusAreas.topics === 'string' && legacyFocusAreas.topics.trim()) {
      topics = legacyFocusAreas.topics.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
    }
    if (personaId === 'engineer' && include.length === 0 && typeof legacyFocusAreas.paths === 'string' && legacyFocusAreas.paths.trim()) {
      include = [legacyFocusAreas.paths.trim()];
    }

    // Only update chip state if the drawer is not actively being edited
    if (!state.drawerOpen) {
      this._scopedFocusChips[personaId] = { topics: [...topics], include: [...include], exclude: [...exclude] };
      this._rebuildScopeChips(personaId);
    }

    // Zero-file warning: shown when advisor wrote a warning for this persona
    const noFilesWarning = project?.advisor?.projects?.[projectId]?.focusAreaWarnings?.[personaId]?.noFilesMatched === true;
    if (state.noFilesWarningEl) {
      state.noFilesWarningEl.classList.toggle('adv-hidden', !noFilesWarning || personaId !== 'engineer');
    }

    // Active dot: shown when any constraint is non-empty
    const isActive = topics.length > 0 || include.length > 0 || exclude.length > 0;
    if (state.dotEl) {
      state.dotEl.classList.toggle('adv-hidden', !isActive);
      if (isActive) {
        const parts = [];
        if (topics.length > 0) parts.push(`Topics: ${topics.join(', ')}`);
        if (include.length > 0) parts.push(`Include: ${include.join(', ')}`);
        if (exclude.length > 0) parts.push(`Exclude: ${exclude.join(', ')}`);
        state.dotEl.title = `Scoped: ${parts.join(' | ')}`;
        state.dotEl.setAttribute('aria-label', `Scope active: ${parts.join(', ')}`);
      } else {
        state.dotEl.title = '';
        state.dotEl.setAttribute('aria-label', 'Scope constraints active');
      }
    }
  },

  /**
   * Rebuild all chip DOM elements for a persona from the in-memory chip data.
   * @param {string} personaId
   */
  _rebuildScopeChips(personaId) {
    const state = this._scopedFocusState?.[personaId];
    const chips = this._scopedFocusChips?.[personaId];
    if (!state || !chips) return;

    const renderList = (listEl, chipArr, fieldKey) => {
      if (!listEl) return;
      listEl.innerHTML = '';
      for (const value of chipArr) {
        listEl.appendChild(this._makeScopeChip(personaId, fieldKey, value));
      }
    };

    renderList(state.topicsChipListEl, chips.topics, 'topics');
    if (personaId === 'engineer') {
      renderList(state.includeChipListEl, chips.include, 'include');
      renderList(state.excludeChipListEl, chips.exclude, 'exclude');
    }
  },

  /**
   * Create a removable chip element for a scope field.
   * Chip is keyboard-accessible: Tab to focus, Backspace/Delete to remove.
   */
  _makeScopeChip(personaId, fieldKey, value) {
    const removeBtn = el('button', {
      type: 'button',
      className: 'adv-scope-chip-remove',
      'aria-label': `Remove ${value}`,
      onClick: () => {
        const chips = this._scopedFocusChips[personaId];
        if (!chips) return;
        chips[fieldKey] = chips[fieldKey].filter(v => v !== value);
        this._rebuildScopeChips(personaId);
      },
    }, '×');

    const chip = el('span', {
      className: 'adv-scope-chip',
      role: 'listitem',
      tabIndex: 0,
      onKeydown: (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          const chips = this._scopedFocusChips[personaId];
          if (!chips) return;
          chips[fieldKey] = chips[fieldKey].filter(v => v !== value);
          this._rebuildScopeChips(personaId);
        }
      },
    }, value, removeBtn);

    return chip;
  },

  /**
   * Add a chip from a text input field for the given scope field.
   * Trims whitespace, enforces length cap, deduplicates.
   */
  _addScopedFocusChipFromInput(personaId, fieldKey, inputEl) {
    const raw = inputEl?.value?.trim();
    if (!raw) return;
    this._addScopedFocusChip(personaId, fieldKey, raw);
    if (inputEl) inputEl.value = '';
  },

  /**
   * Add a chip value (string) to a scope field.
   * Enforces max length, deduplicates, max 25 items per field.
   */
  _addScopedFocusChip(personaId, fieldKey, value) {
    const MAX_LEN = fieldKey === 'topics' ? 50 : 200;
    const MAX_CHIPS = 25;
    const safe = sanitizePromptValue(value?.trim() ?? '');
    if (!safe) return;
    const capped = safe.slice(0, MAX_LEN);
    // Path filters: reject absolute paths and traversal
    if ((fieldKey === 'include' || fieldKey === 'exclude') &&
        (capped.startsWith('/') || capped.startsWith('..') || /^[A-Za-z]:[\\/]/.test(capped))) {
      return;
    }
    const chips = this._scopedFocusChips[personaId];
    if (!chips) return;
    if (!Array.isArray(chips[fieldKey])) chips[fieldKey] = [];
    if (chips[fieldKey].includes(capped)) return; // deduplicate
    if (chips[fieldKey].length >= MAX_CHIPS) return; // cap
    chips[fieldKey].push(capped);
    this._rebuildScopeChips(personaId);
  },

  /**
   * Remove the last chip from a scope field (Backspace on empty input).
   */
  _removeLastScopedFocusChip(personaId, fieldKey) {
    const chips = this._scopedFocusChips[personaId];
    if (!chips || !Array.isArray(chips[fieldKey]) || chips[fieldKey].length === 0) return;
    chips[fieldKey].pop();
    this._rebuildScopeChips(personaId);
  },

  /**
   * Clear all scope constraints for a persona (topics + include + exclude).
   */
  async _clearScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;

    // Clear in-memory chip state
    this._scopedFocusChips[personaId] = { topics: [], include: [], exclude: [] };
    this._rebuildScopeChips(personaId);

    // Clear file count badge
    if (state.fileCountBadgeEl) {
      state.fileCountBadgeEl.textContent = '';
      state.fileCountBadgeEl.classList.add('adv-hidden');
    }

    // Save empty state to Firestore
    await this._saveScopedFocus(personaId);
  },

  /**
   * "Test scope" — resolve path patterns against the project root and show file count.
   * Only available for engineer persona. Reads repoPath from Firestore project doc,
   * posts to a server-side endpoint (if available) to resolve globs server-side.
   * If no endpoint, shows an informational message instead.
   */
  async _testScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state || !state.fileCountBadgeEl) return;

    const chips = this._scopedFocusChips[personaId];
    const include = chips?.include ?? [];
    const exclude = chips?.exclude ?? [];

    if (include.length === 0 && exclude.length === 0) {
      state.fileCountBadgeEl.textContent = 'Add path patterns first';
      state.fileCountBadgeEl.classList.remove('adv-hidden');
      setTimeout(() => {
        if (state.fileCountBadgeEl) {
          state.fileCountBadgeEl.textContent = '';
          state.fileCountBadgeEl.classList.add('adv-hidden');
        }
      }, 3000);
      return;
    }

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) return;

    state.fileCountBadgeEl.textContent = 'Counting…';
    state.fileCountBadgeEl.classList.remove('adv-hidden');

    try {
      // Query Firestore for the stored file count from the last cycle result.
      // Full server-side pattern resolution requires a backend endpoint.
      // For now, surface the Firestore-stored file counts from the last run.
      const projectSnap = await this.db.collection('projects').doc(projectId).get();
      const project = projectSnap.data();
      const lastCount = project?.advisor?.projects?.[projectId]?.scopeFileCount?.[personaId] ?? null;
      if (lastCount !== null && typeof lastCount === 'number') {
        state.fileCountBadgeEl.textContent = `${lastCount} file${lastCount === 1 ? '' : 's'} matched`;
      } else {
        state.fileCountBadgeEl.textContent = 'Save scope and run to see file count';
      }
    } catch (err) {
      state.fileCountBadgeEl.textContent = 'Count unavailable';
    }

    setTimeout(() => {
      if (state.fileCountBadgeEl) {
        state.fileCountBadgeEl.classList.add('adv-hidden');
        state.fileCountBadgeEl.textContent = '';
      }
    }, 8000);
  },

  /**
   * Save the scoped focus config for a persona to Firestore.
   * DK-134: Stores chip arrays at advisor.projects.<projectId>.<personaId>.scope.
   * Also writes legacy string fields for backward compat with older daemon versions.
   * @param {string} personaId
   */
  async _saveScopedFocus(personaId) {
    const state = this._scopedFocusState?.[personaId];
    if (!state) return;

    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    if (!projectId) {
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = 'Select a project first';
        state.saveStatusEl.className = 'adv-scope-save-status adv-scope-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-scope-save-status'; } }, 3000);
      }
      return;
    }

    if (this._scopedFocusSaving[personaId]) return;
    this._scopedFocusSaving[personaId] = true;

    if (state.saveStatusEl) { state.saveStatusEl.textContent = 'Saving…'; state.saveStatusEl.className = 'adv-scope-save-status'; }

    // Read from chip state (already sanitized on input)
    const chips = this._scopedFocusChips[personaId] ?? { topics: [], include: [], exclude: [] };

    // Server-side sanitization double-check: strip prompt delimiters, enforce length caps
    const safeTopics = chips.topics
      .map(t => sanitizePromptValue(t).slice(0, 50))
      .filter(Boolean)
      .slice(0, 25);

    // DK-134: New scope schema — arrays
    const scopeData = {
      topics: safeTopics,
      ...(personaId === 'engineer' ? {
        include: chips.include.map(p => sanitizePromptValue(p).slice(0, 200)).filter(Boolean).slice(0, 25),
        exclude: chips.exclude.map(p => sanitizePromptValue(p).slice(0, 200)).filter(Boolean).slice(0, 25),
      } : {}),
    };

    try {
      // Write new array schema under advisor.projects.<projectId>.<personaId>.scope
      await this.db.collection('projects').doc(projectId).set(
        { advisor: { projects: { [projectId]: { [personaId]: { scope: scopeData } } } } },
        { merge: true }
      );
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = '✓ Saved — applies on next run';
        state.saveStatusEl.className = 'adv-scope-save-status adv-scope-save-status-ok';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-scope-save-status'; } }, 3000);
      }
    } catch (err) {
      console.warn(`AdvisorPanel: failed to save scoped focus for ${personaId}:`, err);
      if (state.saveStatusEl) {
        state.saveStatusEl.textContent = '✗ Save failed';
        state.saveStatusEl.className = 'adv-scope-save-status adv-scope-save-status-err';
        setTimeout(() => { if (state.saveStatusEl) { state.saveStatusEl.textContent = ''; state.saveStatusEl.className = 'adv-scope-save-status'; } }, 4000);
      }
    } finally {
      this._scopedFocusSaving[personaId] = false;
    }
  },

  /**
   * DK-134: Update the scope summary bar shown above all persona cards.
   * Shows a one-line summary per persona (e.g. "Engineer: src/auth/**, +security").
   * Hidden when all personas have no scope set.
   */
  _updateScopeSummaryBar() {
    if (!this._scopeSummaryBar) return;
    const projectId = this._filterProjectId || (this._projects[0]?.id ?? null);
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;

    const SCOPE_PERSONAS = [
      { id: 'engineer', label: 'Engineer' },
      { id: 'design',   label: 'Design'   },
      { id: 'product',  label: 'Product'  },
    ];

    const lines = [];
    for (const { id, label } of SCOPE_PERSONAS) {
      const scopeData = project?.advisor?.projects?.[projectId]?.[id]?.scope ?? {};
      const topics = Array.isArray(scopeData.topics) ? scopeData.topics : [];
      const include = Array.isArray(scopeData.include) ? scopeData.include : [];
      // Also check chip state (in-memory changes not yet saved)
      const chipTopics = this._scopedFocusChips[id]?.topics ?? topics;
      const chipInclude = this._scopedFocusChips[id]?.include ?? include;

      const parts = [];
      if (chipInclude.length > 0) parts.push(chipInclude.join(', '));
      if (chipTopics.length > 0) parts.push('+' + chipTopics.join(', +'));

      lines.push({ label, summary: parts.length > 0 ? parts.join(' ') : 'entire codebase' });
    }

    const anyScoped = lines.some(l => l.summary !== 'entire codebase');
    this._scopeSummaryBar.classList.toggle('adv-hidden', !anyScoped);

    if (anyScoped) {
      this._scopeSummaryBar.innerHTML = '';
      for (const { label, summary } of lines) {
        const item = el('div', { className: 'adv-scope-summary-item' },
          el('span', { className: 'adv-scope-summary-persona' }, label + ':'),
          el('span', {
            className: 'adv-scope-summary-value' + (summary === 'entire codebase' ? ' adv-scope-summary-default' : ''),
            title: summary,
          }, summary),
        );
        this._scopeSummaryBar.appendChild(item);
      }
    }
  }
};
