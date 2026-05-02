/**
 * Shared confirmation modal utility.
 *
 * Provides a consistent, styled confirmation dialog to replace ad-hoc
 * window.confirm() calls and one-off modal implementations throughout the app.
 *
 * Usage:
 *   import { showConfirmModal } from './confirm-modal.js';
 *
 *   const ok = await showConfirmModal({
 *     title:   'Delete ticket?',
 *     message: 'This action cannot be undone.',
 *     confirm: 'Delete',
 *     cancel:  'Cancel',   // optional, default 'Cancel'
 *     danger:  true,       // optional, default true — red confirm button
 *   });
 *   if (!ok) return;
 */

/**
 * @param {object}  opts
 * @param {string}  opts.title    — bold modal heading
 * @param {string}  [opts.message] — supporting body text (may contain newlines)
 * @param {string}  [opts.confirm] — confirm button label (default: 'OK')
 * @param {string}  [opts.cancel]  — cancel button label  (default: 'Cancel')
 * @param {boolean} [opts.danger]  — true = red button, false = primary colour (default: true)
 * @returns {Promise<boolean>}
 */
export function showConfirmModal({
  title,
  message = '',
  confirm = 'OK',
  cancel = 'Cancel',
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'confirm-modal-title');
    if (message) overlay.setAttribute('aria-describedby', 'confirm-modal-message');

    const dialog = document.createElement('div');
    dialog.className = 'confirm-modal-dialog';

    // Header
    const header = document.createElement('div');
    header.className = 'confirm-modal-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'confirm-modal-title';
    titleEl.id = 'confirm-modal-title';
    titleEl.textContent = title || '';
    header.appendChild(titleEl);
    dialog.appendChild(header);

    // Body
    if (message) {
      const body = document.createElement('div');
      body.className = 'confirm-modal-body';
      const msgEl = document.createElement('p');
      msgEl.className = 'confirm-modal-message';
      msgEl.id = 'confirm-modal-message';
      msgEl.textContent = message;
      body.appendChild(msgEl);
      dialog.appendChild(body);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'confirm-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-modal-cancel';
    cancelBtn.textContent = cancel;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-modal-confirm ' + (danger ? 'confirm-danger' : 'confirm-primary');
    confirmBtn.textContent = confirm;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup(true));

    // Dismiss on Escape
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cleanup(false);
    });

    // Focus cancel by default (safer for destructive actions)
    setTimeout(() => cancelBtn.focus(), 50);
  });
}

/**
 * FormModal — a reusable modal component for multi-field forms (DK-353).
 *
 * Provides a standardized way to collect multi-field form data with:
 * - Flexible field types (text, textarea, select, checkbox)
 * - Validation and error display
 * - Status messages during async operations
 * - Proper focus management
 *
 * Usage:
 *   const modal = new FormModal({
 *     title: 'Create Project',
 *     fields: [
 *       { name: 'displayName', type: 'text', label: 'Display Name', required: true },
 *       { name: 'description', type: 'textarea', label: 'Description' }
 *     ],
 *     onSubmit: async (formData) => {
 *       await createProject(formData);
 *     }
 *   });
 *   const ok = await modal.open();
 */
export class FormModal {
  constructor(options) {
    this.options = options || {};
    this.overlay = null;
    this.formElements = {};
    this.statusEl = null;
    this.resolver = null;
    this.isSubmitting = false;
  }

  /**
   * Open the modal and return a Promise that resolves to true (submitted) or false (cancelled).
   */
  async open() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this._render();
      document.body.appendChild(this.overlay);
      // Focus first field
      const firstInput = this.overlay.querySelector('input, textarea, select');
      if (firstInput) setTimeout(() => firstInput.focus(), 50);
    });
  }

  /**
   * Close the modal and clean up.
   */
  close() {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.remove();
    }
  }

  /**
   * Show a status message (e.g., "Saving..." or error).
   */
  showStatus(message, type = 'info') {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `form-modal-status form-modal-status-${type}`;
    this.statusEl.style.display = message ? 'block' : 'none';
  }

  /**
   * Clear all status messages.
   */
  clearStatus() {
    if (this.statusEl) {
      this.statusEl.textContent = '';
      this.statusEl.className = 'form-modal-status';
      this.statusEl.style.display = 'none';
    }
  }

  _render() {
    const { title, fields = [], confirm = 'OK', cancel = 'Cancel', onSubmit, onError } = this.options;

    this.overlay = document.createElement('div');
    this.overlay.className = 'confirm-modal-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'form-modal-title');

    const dialog = document.createElement('div');
    dialog.className = 'confirm-modal-dialog';

    // Header
    const header = document.createElement('div');
    header.className = 'confirm-modal-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'confirm-modal-title';
    titleEl.id = 'form-modal-title';
    titleEl.textContent = title || '';
    header.appendChild(titleEl);
    dialog.appendChild(header);

    // Body with form
    const body = document.createElement('div');
    body.className = 'confirm-modal-body form-modal-body';

    // Status message area
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'form-modal-status';
    this.statusEl.style.display = 'none';
    body.appendChild(this.statusEl);

    // Fields
    const fieldsContainer = document.createElement('div');
    fieldsContainer.className = 'form-modal-fields';
    for (const field of fields) {
      const fieldEl = this._createField(field);
      fieldsContainer.appendChild(fieldEl);
    }
    body.appendChild(fieldsContainer);
    dialog.appendChild(body);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'confirm-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-modal-cancel';
    cancelBtn.textContent = cancel;
    cancelBtn.addEventListener('click', () => {
      this.close();
      this.resolver?.(false);
    });

    const submitBtn = document.createElement('button');
    submitBtn.className = 'confirm-modal-confirm confirm-primary';
    submitBtn.textContent = confirm;
    submitBtn.addEventListener('click', async () => {
      await this._handleSubmit(onSubmit, onError);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    dialog.appendChild(actions);
    this.overlay.appendChild(dialog);

    // Close on Escape
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
        this.resolver?.(false);
      }
    });

    // Close on backdrop click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
        this.resolver?.(false);
      }
    });
  }

  _createField(field) {
    const { name, type = 'text', label, placeholder, value = '', required = false } = field;

    const container = document.createElement('div');
    container.className = 'form-modal-field';

    if (label) {
      const labelEl = document.createElement('label');
      labelEl.className = 'form-modal-label';
      labelEl.textContent = label;
      labelEl.htmlFor = `form-field-${name}`;
      container.appendChild(labelEl);
    }

    let input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'form-modal-input form-modal-textarea';
      input.rows = '4';
    } else if (type === 'select') {
      input = document.createElement('select');
      input.className = 'form-modal-input form-modal-select';
    } else {
      input = document.createElement('input');
      input.className = 'form-modal-input';
      input.type = type;
    }

    input.id = `form-field-${name}`;
    input.name = name;
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    if (required) input.required = true;

    container.appendChild(input);
    this.formElements[name] = input;
    return container;
  }

  async _handleSubmit(onSubmit, onError) {
    if (this.isSubmitting) return;

    this.clearStatus();

    // Collect form data
    const formData = {};
    for (const [name, input] of Object.entries(this.formElements)) {
      formData[name] = input.value;
    }

    if (!onSubmit) {
      this.close();
      this.resolver?.(true);
      return;
    }

    this.isSubmitting = true;
    this.showStatus('Saving…', 'info');

    try {
      await onSubmit(formData);
      this.showStatus('Saved!', 'success');
      setTimeout(() => {
        this.close();
        this.resolver?.(true);
      }, 800);
    } catch (err) {
      console.error('FormModal submit error:', err);
      const message = err.message || 'Error saving';
      this.showStatus(message, 'error');
      this.isSubmitting = false;
      if (onError) onError(err);
    }
  }
}
