/**
 * Save-on-blur utility: Auto-save form fields with visual indicators.
 *
 * Provides a consistent pattern for single-field edits across the app:
 * - Auto-save on blur (field loses focus)
 * - Debounce rapid changes
 * - Visual indicators: saving spinner → success checkmark → auto-fade
 * - Error state with optional retry
 * - No explicit Save button needed
 *
 * Usage:
 *   const control = createSaveOnBlur({
 *     element: textareaEl,
 *     onSave: async (newValue) => {
 *       await db.collection('items').doc(id).update({ field: newValue });
 *     },
 *     showIndicator: true,
 *     autoFadeAfterMs: 2000,
 *   });
 *
 *   // Later: cleanup when field is removed from DOM
 *   control.cleanup();
 */

/**
 * @param {object} options
 * @param {HTMLInputElement|HTMLTextAreaElement} options.element - form field to attach to
 * @param {function} options.onSave - async function(newValue) to persist the value
 * @param {number} [options.debounceMs=300] - delay before auto-save after blur
 * @param {boolean} [options.autoSaveOnInput=false] - if true, also auto-save after debounceMs of typing inactivity
 * @param {boolean} [options.showIndicator=true] - show visual save indicator
 * @param {string} [options.indicatorPosition='after-field'] - where to show indicator: 'after-field' | 'inline' | 'none'
 * @param {number} [options.autoFadeAfterMs=2000] - fade "saved" indicator after N milliseconds
 * @param {function} [options.onDirtyChange] - callback(isDirty: boolean) when dirty state changes
 * @param {function} [options.onError] - callback(error) when save fails
 * @param {function} [options.validate] - sync function(value) => { valid: boolean, message?: string }
 * @returns {object} control object with methods: cleanup(), resetStatus(), save(value), disable(), enable()
 */
export function createSaveOnBlur({
  element,
  onSave,
  debounceMs = 300,
  autoSaveOnInput = false,
  showIndicator = true,
  indicatorPosition = 'after-field',
  autoFadeAfterMs = 2000,
  onDirtyChange = null,
  onError = null,
  validate = null,
} = {}) {
  if (!element || typeof onSave !== 'function') {
    throw new Error('createSaveOnBlur: element and onSave are required');
  }

  let isSaving = false;
  let isDirty = false;
  let lastValue = element.value;
  let saveTimeout = null;
  let fadeTimeout = null;
  let indicatorEl = null;
  let isDisabled = false;

  // ── Indicator element ─────────────────────────────────────────────────

  function createIndicator() {
    const container = document.createElement('span');
    container.className = 'save-indicator';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');

    const icon = document.createElement('span');
    icon.className = 'save-indicator-icon';

    const text = document.createElement('span');
    text.className = 'save-indicator-text';

    container.appendChild(icon);
    container.appendChild(text);
    return container;
  }

  function showIndicator(state, message = '') {
    if (!showIndicator || indicatorPosition === 'none') return;

    if (!indicatorEl) {
      indicatorEl = createIndicator();
      if (indicatorPosition === 'after-field') {
        element.parentNode.insertBefore(indicatorEl, element.nextSibling);
      } else if (indicatorPosition === 'inline') {
        element.parentNode.appendChild(indicatorEl);
      }
    }

    const icon = indicatorEl.querySelector('.save-indicator-icon');
    const text = indicatorEl.querySelector('.save-indicator-text');

    // Remove all state classes
    indicatorEl.classList.remove('saving', 'saved', 'error');
    indicatorEl.classList.add(state);

    // Update icon and text
    if (state === 'saving') {
      icon.innerHTML = '⟳';
      icon.classList.add('spinner');
      text.textContent = 'Saving…';
    } else if (state === 'saved') {
      icon.innerHTML = '✓';
      icon.classList.remove('spinner');
      text.textContent = 'Saved';
      indicatorEl.classList.add('visible');

      // Auto-fade after delay
      if (fadeTimeout) clearTimeout(fadeTimeout);
      fadeTimeout = setTimeout(() => {
        indicatorEl.classList.remove('visible');
      }, autoFadeAfterMs);
    } else if (state === 'error') {
      icon.innerHTML = '✕';
      icon.classList.remove('spinner');
      text.textContent = message || 'Error saving';
      indicatorEl.classList.add('visible');
    }

    if (state !== 'saved') {
      indicatorEl.classList.toggle('visible', state !== '');
    }
  }

  function hideIndicator() {
    if (indicatorEl) {
      if (fadeTimeout) clearTimeout(fadeTimeout);
      indicatorEl.classList.remove('visible', 'saving', 'saved', 'error');
    }
  }

  // ── Save logic ──────────────────────────────────────────────────────

  async function performSave(value) {
    if (isDisabled || isSaving) return;
    if (value === lastValue) return; // no change

    // Validate if provided
    if (validate) {
      const result = validate(value);
      if (!result.valid) {
        showIndicator('error', result.message || 'Validation failed');
        return;
      }
    }

    isSaving = true;
    setDirty(false);
    showIndicator('saving');

    try {
      await onSave(value);
      lastValue = value;
      showIndicator('saved');
    } catch (err) {
      console.error('Save-on-blur error:', err);
      const message = err.message || 'Error saving';
      showIndicator('error', message);
      setDirty(true); // allow retry on next blur
      if (onError) onError(err);
    } finally {
      isSaving = false;
    }
  }

  function triggerSave(value) {
    if (saveTimeout) clearTimeout(saveTimeout);

    if (debounceMs > 0) {
      saveTimeout = setTimeout(() => performSave(value), debounceMs);
    } else {
      performSave(value);
    }
  }

  // ── Event listeners ──────────────────────────────────────────────────

  function setDirty(dirty) {
    if (isDirty !== dirty) {
      isDirty = dirty;
      if (onDirtyChange) onDirtyChange(dirty);
    }
  }

  const onInput = () => {
    setDirty(true);
    if (autoSaveOnInput) {
      // Debounce-on-input: save after N ms of typing inactivity
      triggerSave(element.value);
    }
  };

  const onBlur = () => {
    if (isDirty && element.value !== lastValue) {
      // Cancel any pending debounce and save immediately on blur
      if (saveTimeout) clearTimeout(saveTimeout);
      performSave(element.value);
    }
  };

  const onKeyDown = (e) => {
    // Allow Ctrl/Cmd+S to save immediately
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (saveTimeout) clearTimeout(saveTimeout);
      performSave(element.value);
    }
  };

  element.addEventListener('input', onInput);
  element.addEventListener('blur', onBlur);
  element.addEventListener('keydown', onKeyDown);

  // ── Public API ──────────────────────────────────────────────────────

  return {
    /**
     * Manually trigger a save (e.g., from a button click or external event).
     */
    save: (value) => performSave(value ?? element.value),

    /**
     * Clear the current save status indicator.
     */
    resetStatus: hideIndicator,

    /**
     * Manually show a status message.
     */
    showStatus: (state, message) => showIndicator(state, message),

    /**
     * Disable save (useful during navigation or cleanup).
     */
    disable: () => {
      isDisabled = true;
      if (saveTimeout) clearTimeout(saveTimeout);
      hideIndicator();
    },

    /**
     * Re-enable save.
     */
    enable: () => {
      isDisabled = false;
    },

    /**
     * Returns true if there are unsaved changes (user has typed but not yet saved).
     */
    isDirty: () => isDirty,

    /**
     * Update the last-saved reference value (use after programmatically setting element.value
     * to avoid a spurious auto-save when the user next blurs without making changes).
     */
    setLastValue: (value) => {
      lastValue = value ?? element.value;
      setDirty(false);
    },

    /**
     * Clean up all event listeners and indicators.
     * Call this when the field is removed from DOM.
     */
    cleanup: () => {
      element.removeEventListener('input', onInput);
      element.removeEventListener('blur', onBlur);
      element.removeEventListener('keydown', onKeyDown);
      if (saveTimeout) clearTimeout(saveTimeout);
      if (fadeTimeout) clearTimeout(fadeTimeout);
      if (indicatorEl && indicatorEl.parentNode) {
        indicatorEl.remove();
      }
    },
  };
}
