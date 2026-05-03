// @docket/admin-panel — TicketForm: bug/feature submission form with screenshot upload

import { el } from '../el.js';
import { openLightbox } from '../lightbox.js';

export class TicketForm {
  constructor({ onSubmit, classifyTicket, features, toast, projects, defaultProjectId }) {
    this.onSubmit = onSubmit;
    this.classifyTicket = classifyTicket;
    this.features = features;
    this.toast = toast;
    this.projects = projects || null; // array of { id, name } — if set, show project selector
    this.defaultProjectId = defaultProjectId || (projects && projects.length > 0 ? projects[0].id : null);
    this.selectedProjectId = this.defaultProjectId;
    this.screenshots = []; // data URLs
    this.el = null;
    this.submitting = false;
  }

  render() {
    this.screenshots = [];
    this.submitting = false;
    this.critical = false;
    this.selectedProjectId = this.defaultProjectId;

    // Project selector (only shown in multi-project / "All" view)
    let projectSelectorSection = null;
    if (this.projects && this.projects.length > 0) {
      const options = this.projects.map(p =>
        el('option', { value: p.id }, p.name || p.id)
      );
      const selectEl = el('select', {
        className: 'tk-form-select',
        onChange: (e) => { this.selectedProjectId = e.target.value; },
      }, ...options);
      // Set initial value to defaultProjectId
      if (this.defaultProjectId) selectEl.value = this.defaultProjectId;
      projectSelectorSection = el('div', { className: 'tk-form-group' },
        el('label', null, 'Project'),
        selectEl,
      );
      // Keep reference to update value after render
      this._projectSelect = selectEl;
    }

    const descInput = el('textarea', {
      className: 'tk-form-textarea',
      name: 'description',
      placeholder: 'Describe the ticket (bug or feature request)…',
      maxlength: '10000',
    });

    // Screenshot upload
    const previewContainer = el('div', { className: 'tk-screenshot-previews' });
    let screenshotSection = null;

    if (this.features.screenshots !== false) {
      const fileInput = el('input', {
        type: 'file',
        accept: 'image/*',
        multiple: 'true',
        onChange: (e) => {
          const MAX_SCREENSHOTS = 5;
          const files = Array.from(e.target.files);
          const available = MAX_SCREENSHOTS - this.screenshots.length;
          if (available <= 0) {
            this.toast.error(`You can attach at most ${MAX_SCREENSHOTS} screenshots.`);
            e.target.value = '';
            return;
          }
          const accepted = files.slice(0, available);
          if (accepted.length < files.length) {
            this.toast.error(`Only ${available} more screenshot(s) can be added (limit is ${MAX_SCREENSHOTS}).`);
          }
          accepted.forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
              if (this.screenshots.length >= MAX_SCREENSHOTS) return;
              this.screenshots.push(ev.target.result);
              this._renderPreviews(previewContainer);
            };
            reader.readAsDataURL(file);
          });
          e.target.value = '';
        },
      });

      screenshotSection = el('div', { className: 'tk-screenshot-upload' },
        el('label', { className: 'tk-screenshot-upload-label' },
          '📎 Attach screenshots (optional)',
          fileInput,
        ),
        previewContainer,
      );
    }

    // Critical flag
    const criticalCheckbox = el('input', {
      type: 'checkbox',
      id: 'tk-critical-cb',
      onChange: (e) => { this.critical = e.target.checked; },
    });
    this._criticalCheckbox = criticalCheckbox;
    const criticalSection = el('div', { className: 'tk-form-critical' },
      criticalCheckbox,
      el('label', { htmlFor: 'tk-critical-cb' }, '⚡ Critical — spawn worker immediately, above max cap'),
    );

    // Submit
    const submitBtn = el('button', {
      className: 'tk-btn tk-btn-primary',
      type: 'button',
      onClick: () => this._handleSubmit(descInput, submitBtn),
    }, 'Submit');

    this.el = el('div', { className: 'tk-form' },
      projectSelectorSection,
      el('div', { className: 'tk-form-group' },
        descInput,
      ),
      screenshotSection,
      criticalSection,
      el('div', { className: 'tk-form-actions' },
        submitBtn,
      ),
    );

    return this.el;
  }

  _renderPreviews(container) {
    container.innerHTML = '';
    this.screenshots.forEach((dataUrl, i) => {
      const thumb = el('div', { className: 'tk-screenshot-thumb' },
        el('img', { src: dataUrl, onClick: () => openLightbox(dataUrl) }),
        el('button', {
          className: 'tk-screenshot-thumb-remove',
          onClick: (e) => {
            e.stopPropagation();
            this.screenshots.splice(i, 1);
            this._renderPreviews(container);
          },
        }, '×'),
      );
      container.appendChild(thumb);
    });
  }

  async _handleSubmit(descEl, btn) {
    if (this.submitting) return;
    const description = descEl.value.trim();

    if (!description) { this.toast.error('Please describe the ticket.'); return; }
    if (description.length > 10000) {
      this.toast.error(`Description is too long (${description.length.toLocaleString()} characters). Please keep it under 10,000 characters.`);
      return;
    }
    if (this.screenshots.length > 5) {
      this.toast.error('Too many screenshots. Please attach at most 5.');
      return;
    }

    this.submitting = true;
    btn.disabled = true;
    btn.classList.add('tk-btn-loading');
    btn.textContent = 'Submitting...';

    try {
      // Auto-classify if available, otherwise default to bug
      let type = 'bug';
      let title = description.split('\n')[0].slice(0, 80);

      if (this.classifyTicket) {
        try {
          const result = await this.classifyTicket(description);
          if (result && result.type) type = result.type;
          if (result && result.title) title = result.title;
        } catch (_e) {
          // Fall back to defaults
        }
      }

      await this.onSubmit({
        type,
        title,
        description,
        screenshots: this.screenshots.slice(),
        projectId: this.selectedProjectId || null,
        critical: this.critical || false,
      });
      // Reset form
      descEl.value = '';
      this.screenshots = [];
      this.critical = false;
      if (this._criticalCheckbox) this._criticalCheckbox.checked = false;
      const previews = this.el.querySelector('.tk-screenshot-previews');
      if (previews) previews.innerHTML = '';
      // Reset project selector to default
      if (this._projectSelect && this.defaultProjectId) {
        this._projectSelect.value = this.defaultProjectId;
        this.selectedProjectId = this.defaultProjectId;
      }
      this.toast.success('Ticket created!');
    } catch (err) {
      this.toast.error('Failed to create ticket: ' + err.message);
    } finally {
      this.submitting = false;
      btn.disabled = false;
      btn.classList.remove('tk-btn-loading');
      btn.textContent = 'Submit';
    }
  }
}
