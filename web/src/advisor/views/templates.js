// Persona config templates — DK-141.
// User-saved bundles of advisorContext + persona instructions stored at
// /users/{uid}/advisorTemplates. Includes save/rename/preview/apply modals.

import { el } from '../ui/el.js';
import { toDate } from '../ui/format.js';

export const templatesMixin = {
  // ── Persona config templates (DK-141) ────────────────────────

  /**
   * Subscribe to the current user's persona templates collection.
   * Uses the Firebase Auth user ID from the db.app.auth() reference.
   * Unsubscribes any existing listener first.
   */
  _subscribeTemplates() {
    // Clean up any previous subscription
    if (this._templatesUnsub) { this._templatesUnsub(); this._templatesUnsub = null; }

    let uid;
    try {
      uid = this.db.app.auth().currentUser?.uid;
    } catch (_) { /* auth not available */ }
    if (!uid) {
      // Not signed in yet — re-try after a short delay (auth race)
      setTimeout(() => { if (this._mounted) this._subscribeTemplates(); }, 2000);
      return;
    }

    const ref = this.db.collection('users').doc(uid).collection('personaTemplates');
    const unsub = ref.orderBy('lastUsedAt', 'desc').onSnapshot(
      (snap) => {
        this._templates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._renderTemplatesSection();
      },
      (err) => {
        // Permission-denied may be transient (auth propagation lag)
        if (err.code !== 'permission-denied') {
          console.error('AdvisorPanel: templates listener error', err);
        }
        // Retry after backoff
        if (this._mounted) {
          setTimeout(() => { if (this._mounted) this._subscribeTemplates(); }, 8000);
        }
      }
    );
    this._templatesUnsub = unsub;
  },

  /**
   * Build the "Settings > Templates" collapsible section at the bottom of the panel.
   * Hidden from users who have zero templates to avoid empty-state friction.
   */
  _buildTemplatesSection() {
    const section = el('div', { className: 'adv-templates-section' });

    const chevron = el('span', { className: 'adv-templates-chevron', 'aria-hidden': 'true' }, '▸');
    const header = el('button', {
      className: 'adv-templates-header',
      'aria-expanded': 'false',
      'aria-controls': 'adv-templates-body',
      onClick: () => {
        const isExpanded = header.getAttribute('aria-expanded') === 'true';
        header.setAttribute('aria-expanded', String(!isExpanded));
        chevron.textContent = isExpanded ? '▸' : '▾';
        body.classList.toggle('adv-hidden', isExpanded);
      },
    },
      chevron,
      el('span', { className: 'adv-templates-header-title' }, 'Templates'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-templates-body adv-hidden',
      id: 'adv-templates-body',
      role: 'region',
      'aria-label': 'Persona config templates',
    });
    section.appendChild(body);

    this._templatesSection = section;
    this._templatesSectionBody = body;

    // Start hidden — shown only when user has at least one template
    section.style.display = 'none';

    return section;
  },

  /**
   * Re-render the templates section body.
   * Shows the section only when at least one template exists.
   */
  _renderTemplatesSection() {
    if (!this._templatesSection || !this._templatesSectionBody) return;

    // Hide entirely if no templates
    if (this._templates.length === 0) {
      this._templatesSection.style.display = 'none';
      return;
    }

    this._templatesSection.style.display = '';

    // Rebuild body content
    const body = this._templatesSectionBody;
    body.innerHTML = '';

    body.appendChild(
      el('p', { className: 'adv-templates-intro' },
        'Saved persona instruction templates. Apply one when setting up a new project.'
      )
    );

    // List of templates — keyboard-navigable with visible focus states
    const list = el('div', { className: 'adv-templates-list', role: 'list' });

    for (const tmpl of this._templates) {
      list.appendChild(this._buildTemplateRow(tmpl));
    }

    body.appendChild(list);
  },

  /**
   * Build a single template row with name, description, last-used date,
   * rename and delete actions.
   */
  _buildTemplateRow(tmpl) {
    const row = el('div', { className: 'adv-template-row', role: 'listitem' });

    const lastUsed = tmpl.lastUsedAt
      ? (tmpl.lastUsedAt.toDate ? tmpl.lastUsedAt.toDate() : new Date(tmpl.lastUsedAt))
      : (tmpl.createdAt
          ? (tmpl.createdAt.toDate ? tmpl.createdAt.toDate() : new Date(tmpl.createdAt))
          : null);

    const lastUsedStr = lastUsed
      ? lastUsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    // Inline confirm state for delete
    let deleteConfirmPending = false;
    const confirmEl = el('span', { className: 'adv-template-delete-confirm adv-hidden' }, 'Delete?');

    const deleteBtn = el('button', {
      className: 'adv-template-delete-btn',
      type: 'button',
      title: `Delete template "${tmpl.name}"`,
      'aria-label': `Delete template ${tmpl.name}`,
      onClick: async () => {
        if (!deleteConfirmPending) {
          // First click — show inline confirmation
          deleteConfirmPending = true;
          confirmEl.classList.remove('adv-hidden');
          deleteBtn.textContent = 'Yes, delete';
          deleteBtn.classList.add('adv-template-delete-btn-confirm');
          // Auto-cancel after 4 seconds
          setTimeout(() => {
            if (deleteConfirmPending) {
              deleteConfirmPending = false;
              confirmEl.classList.add('adv-hidden');
              deleteBtn.textContent = 'Delete';
              deleteBtn.classList.remove('adv-template-delete-btn-confirm');
            }
          }, 4000);
        } else {
          // Second click — proceed with delete
          await this._deleteTemplate(tmpl.id, row);
        }
      },
    }, 'Delete');

    const renameBtn = el('button', {
      className: 'adv-template-rename-btn',
      type: 'button',
      title: `Rename template "${tmpl.name}"`,
      'aria-label': `Rename template ${tmpl.name}`,
      onClick: () => this._openRenameTemplateModal(tmpl),
    }, 'Rename');

    row.appendChild(
      el('div', { className: 'adv-template-meta' },
        el('span', { className: 'adv-template-name' }, tmpl.name),
        tmpl.description
          ? el('span', { className: 'adv-template-desc' }, tmpl.description)
          : null,
        el('span', { className: 'adv-template-last-used' }, `Last used: ${lastUsedStr}`),
      )
    );

    row.appendChild(
      el('div', { className: 'adv-template-actions' },
        confirmEl,
        renameBtn,
        deleteBtn,
      )
    );

    return row;
  },

  /**
   * Delete a template from Firestore.
   * @param {string} templateId
   * @param {HTMLElement} rowEl - DOM row to remove on success
   */
  async _deleteTemplate(templateId, rowEl) {
    let uid;
    try { uid = this.db.app.auth().currentUser?.uid; } catch (_) {}
    if (!uid) return;

    try {
      await this.db.collection('users').doc(uid)
        .collection('personaTemplates').doc(templateId).delete();
      // Row will be removed when the Firestore listener fires; optimistically hide it
      if (rowEl?.parentNode) rowEl.parentNode.removeChild(rowEl);
    } catch (err) {
      console.error('Failed to delete template:', err);
    }
  },

  /**
   * Open the "Save as template" modal.
   * Captures the current persona instructions from the visible textareas.
   */
  _openSaveAsTemplateModal() {
    this._closeSaveTemplateModal(); // close any existing one

    // Collect current instruction values from the textareas
    const config = {
      instructions: this._personaInstrTextareas['engineer']?.value?.trim() || '',
      scope: this._personaInstrTextareas['design']?.value?.trim() || '',
      triggers: this._personaInstrTextareas['product']?.value?.trim() || '',
    };

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSaveTemplateModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-save-template-modal' });

    // Header
    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', { className: 'adv-soul-modal-title' }, 'Save as template'),
        el('button', {
          className: 'adv-soul-modal-close',
          title: 'Close',
          'aria-label': 'Close dialog',
          onClick: () => this._closeSaveTemplateModal(),
        }, '×'),
      )
    );

    modal.appendChild(
      el('p', { className: 'adv-soul-modal-desc' },
        'Save the current persona instructions as a named template. ' +
        'Apply it when setting up new projects to skip repeated configuration.'
      )
    );

    // Name field (required, max 60 chars)
    const nameId = 'adv-template-name-input';
    const nameCounter = el('span', { className: 'adv-template-name-counter' }, '0 / 60');
    const nameInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: nameId,
      placeholder: 'e.g. Security-focused setup',
      maxlength: '60',
      'aria-required': 'true',
      onInput: () => {
        const len = nameInput.value.length;
        nameCounter.textContent = `${len} / 60`;
        nameCounter.className = 'adv-template-name-counter' + (len > 54 ? ' adv-template-counter-warn' : '');
      },
    });

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: nameId }, 'Template name'),
          el('span', { className: 'adv-template-required' }, '(required)'),
          nameCounter,
        ),
        nameInput,
      )
    );

    // Description field (optional, max 120 chars)
    const descId = 'adv-template-desc-input';
    const descCounter = el('span', { className: 'adv-template-name-counter' }, '0 / 120');
    const descInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: descId,
      placeholder: 'One-line description (optional)',
      maxlength: '120',
      onInput: () => {
        const len = descInput.value.length;
        descCounter.textContent = `${len} / 120`;
        descCounter.className = 'adv-template-name-counter' + (len > 108 ? ' adv-template-counter-warn' : '');
      },
    });

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: descId }, 'Description'),
          descCounter,
        ),
        descInput,
      )
    );

    // Footer
    const statusEl = el('span', { className: 'adv-soul-status' });
    const cancelBtn = el('button', {
      className: 'adv-soul-reset-btn',
      type: 'button',
      onClick: () => this._closeSaveTemplateModal(),
    }, 'Cancel');

    const saveBtn = el('button', {
      className: 'adv-soul-save-btn',
      type: 'button',
      onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          statusEl.textContent = 'Name is required.';
          statusEl.className = 'adv-soul-status adv-soul-status-err';
          nameInput.focus();
          return;
        }
        await this._saveTemplate(name, descInput.value.trim(), config, saveBtn, statusEl);
      },
    }, 'Save Template');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          cancelBtn,
          saveBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._saveTemplateModal = overlay;

    // Keyboard: Escape to close
    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeSaveTemplateModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._saveTemplateModal._keyHandler = onKey;

    // Focus the name input
    setTimeout(() => nameInput.focus(), 50);
  },

  _closeSaveTemplateModal() {
    if (this._saveTemplateModal) {
      if (this._saveTemplateModal._keyHandler) {
        document.removeEventListener('keydown', this._saveTemplateModal._keyHandler);
      }
      if (this._saveTemplateModal.parentNode) {
        this._saveTemplateModal.parentNode.removeChild(this._saveTemplateModal);
      }
      this._saveTemplateModal = null;
    }
  },

  /**
   * Write a new persona template document to Firestore.
   * @param {string} name
   * @param {string} description
   * @param {{ instructions: string, scope: string, triggers: string }} config
   * @param {HTMLButtonElement} saveBtn
   * @param {HTMLElement} statusEl
   */
  async _saveTemplate(name, description, config, saveBtn, statusEl) {
    let uid;
    try { uid = this.db.app.auth().currentUser?.uid; } catch (_) {}
    if (!uid) {
      statusEl.textContent = 'Not signed in.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    // Client-side length validation (belt-and-suspenders — rules also enforce)
    if (name.length > 60) {
      statusEl.textContent = 'Name must be 60 characters or fewer.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }
    if (description.length > 120) {
      statusEl.textContent = 'Description must be 120 characters or fewer.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    const now = new Date().toISOString();
    const doc = {
      name,
      description,
      createdAt: now,
      lastUsedAt: now,
      config: {
        instructions: (config.instructions || '').slice(0, 2000),
        scope:        (config.scope        || '').slice(0, 2000),
        triggers:     (config.triggers     || '').slice(0, 2000),
      },
    };

    try {
      await this.db.collection('users').doc(uid)
        .collection('personaTemplates').add(doc);

      statusEl.textContent = '✓ Template saved!';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';
      setTimeout(() => this._closeSaveTemplateModal(), 1200);
    } catch (err) {
      console.error('Failed to save template:', err);
      statusEl.textContent = 'Error saving template.';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      saveBtn.disabled = false;
    }
  },

  /**
   * Open a rename modal for an existing template.
   * @param {{ id: string, name: string, description: string }} tmpl
   */
  _openRenameTemplateModal(tmpl) {
    this._closeSaveTemplateModal();

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSaveTemplateModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-save-template-modal' });

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', { className: 'adv-soul-modal-title' }, 'Rename template'),
        el('button', {
          className: 'adv-soul-modal-close',
          title: 'Close',
          'aria-label': 'Close dialog',
          onClick: () => this._closeSaveTemplateModal(),
        }, '×'),
      )
    );

    const nameId = 'adv-template-rename-input';
    const nameCounter = el('span', { className: 'adv-template-name-counter' }, `${tmpl.name.length} / 60`);
    const nameInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: nameId,
      maxlength: '60',
      'aria-required': 'true',
      onInput: () => {
        const len = nameInput.value.length;
        nameCounter.textContent = `${len} / 60`;
        nameCounter.className = 'adv-template-name-counter' + (len > 54 ? ' adv-template-counter-warn' : '');
      },
    });
    nameInput.value = tmpl.name;

    const descId = 'adv-template-rename-desc';
    const descCounter = el('span', { className: 'adv-template-name-counter' }, `${(tmpl.description || '').length} / 120`);
    const descInput = el('input', {
      type: 'text',
      className: 'adv-template-name-input',
      id: descId,
      maxlength: '120',
      placeholder: 'One-line description (optional)',
      onInput: () => {
        const len = descInput.value.length;
        descCounter.textContent = `${len} / 120`;
        descCounter.className = 'adv-template-name-counter' + (len > 108 ? ' adv-template-counter-warn' : '');
      },
    });
    descInput.value = tmpl.description || '';

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: nameId }, 'Template name'),
          el('span', { className: 'adv-template-required' }, '(required)'),
          nameCounter,
        ),
        nameInput,
      )
    );

    modal.appendChild(
      el('div', { className: 'adv-template-field' },
        el('div', { className: 'adv-template-field-row' },
          el('label', { className: 'adv-template-label', htmlFor: descId }, 'Description'),
          descCounter,
        ),
        descInput,
      )
    );

    const statusEl = el('span', { className: 'adv-soul-status' });
    const cancelBtn = el('button', {
      className: 'adv-soul-reset-btn',
      type: 'button',
      onClick: () => this._closeSaveTemplateModal(),
    }, 'Cancel');

    const saveBtn = el('button', {
      className: 'adv-soul-save-btn',
      type: 'button',
      onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) {
          statusEl.textContent = 'Name is required.';
          statusEl.className = 'adv-soul-status adv-soul-status-err';
          nameInput.focus();
          return;
        }
        saveBtn.disabled = true;
        statusEl.textContent = 'Saving…';
        statusEl.className = 'adv-soul-status';

        let uid;
        try { uid = this.db.app.auth().currentUser?.uid; } catch (_) {}
        if (!uid) { statusEl.textContent = 'Not signed in.'; statusEl.className = 'adv-soul-status adv-soul-status-err'; saveBtn.disabled = false; return; }

        try {
          await this.db.collection('users').doc(uid)
            .collection('personaTemplates').doc(tmpl.id)
            .update({ name, description: descInput.value.trim() });
          statusEl.textContent = '✓ Renamed!';
          statusEl.className = 'adv-soul-status adv-soul-status-ok';
          setTimeout(() => this._closeSaveTemplateModal(), 1000);
        } catch (err) {
          console.error('Failed to rename template:', err);
          statusEl.textContent = 'Error renaming.';
          statusEl.className = 'adv-soul-status adv-soul-status-err';
          saveBtn.disabled = false;
        }
      },
    }, 'Save');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          cancelBtn,
          saveBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._saveTemplateModal = overlay;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeSaveTemplateModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._saveTemplateModal._keyHandler = onKey;

    setTimeout(() => nameInput.focus(), 50);
  },

  /** Close the apply-template warning modal if open */
  _closeTemplateWarnModal() {
    if (this._templateWarnModal) {
      if (this._templateWarnModal.parentNode) {
        this._templateWarnModal.parentNode.removeChild(this._templateWarnModal);
      }
      this._templateWarnModal = null;
    }
  },

  /**
   * Show a preview of a template's fields before applying it to the project.
   * Called from the new project setup flow.
   * @param {{ name, config: { instructions, scope, triggers } }} tmpl
   * @param {function(config)} onApply - callback to receive the config after user confirms
   */
  _openTemplatePreviewModal(tmpl, onApply) {
    this._closeTemplateWarnModal();

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeTemplateWarnModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-template-preview-modal' });

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-header' },
        el('div', { className: 'adv-soul-modal-title' }, `Apply template: ${tmpl.name}`),
        el('button', {
          className: 'adv-soul-modal-close',
          title: 'Close',
          'aria-label': 'Close dialog',
          onClick: () => this._closeTemplateWarnModal(),
        }, '×'),
      )
    );

    modal.appendChild(
      el('p', { className: 'adv-soul-modal-desc' },
        'The following fields will be pre-populated. Review them after applying — ' +
        'you must explicitly save each field to commit the changes.'
      )
    );

    // Field previews — checks for project-specific content (paths/repo names)
    const PATH_PATTERN = /\b(\/[\w/-]+|[\w-]+\.(js|ts|py|go|json|yml|yaml)|https?:\/\/)/i;

    const buildFieldPreview = (label, value, personaId) => {
      if (!value) return null;

      const hasPathRef = PATH_PATTERN.test(value);

      const preview = el('div', { className: 'adv-template-preview-field' },
        el('div', { className: 'adv-template-preview-field-label' }, label),
        el('pre', { className: 'adv-template-preview-field-value' }, value),
      );

      if (hasPathRef) {
        preview.appendChild(
          el('div', { className: 'adv-template-preview-warn' },
            el('span', { className: 'adv-template-preview-warn-icon', 'aria-hidden': 'true' }, '⚠'),
            el('span', {},
              'This field may reference paths from another project — review before saving.'
            ),
          )
        );
      }

      return preview;
    };

    const previewsEl = el('div', { className: 'adv-template-previews' });

    const instructionsPreview = buildFieldPreview('Engineer instructions', tmpl.config?.instructions, 'engineer');
    const scopePreview = buildFieldPreview('Design instructions', tmpl.config?.scope, 'design');
    const triggersPreview = buildFieldPreview('Product instructions', tmpl.config?.triggers, 'product');

    if (instructionsPreview) previewsEl.appendChild(instructionsPreview);
    if (scopePreview) previewsEl.appendChild(scopePreview);
    if (triggersPreview) previewsEl.appendChild(triggersPreview);

    if (!instructionsPreview && !scopePreview && !triggersPreview) {
      previewsEl.appendChild(
        el('p', { className: 'adv-template-preview-empty' }, 'This template has no instructions saved.')
      );
    }

    modal.appendChild(previewsEl);

    const cancelBtn = el('button', {
      className: 'adv-soul-reset-btn',
      type: 'button',
      onClick: () => this._closeTemplateWarnModal(),
    }, 'Cancel');

    const applyBtn = el('button', {
      className: 'adv-soul-save-btn',
      type: 'button',
      onClick: () => {
        this._closeTemplateWarnModal();
        if (onApply) onApply(tmpl.config || {});
      },
    }, 'Apply and edit');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        el('span', {}),
        el('div', { className: 'adv-soul-modal-footer-right' },
          cancelBtn,
          applyBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._templateWarnModal = overlay;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeTemplateWarnModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._templateWarnModal._keyHandler = onKey;

    setTimeout(() => applyBtn.focus(), 50);
  },

  /**
   * Get the current list of templates (for use in the new project modal).
   * @returns {Array}
   */
  getTemplates() {
    return this._templates || [];
  }
};
