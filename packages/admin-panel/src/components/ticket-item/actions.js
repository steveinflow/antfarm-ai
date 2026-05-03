// @docket/admin-panel — TicketItem actions mixin: state-transition buttons + exclude confirm popover
//
// Mixed into TicketItem.prototype via Object.assign in index.js.

import { el } from '../../el.js';

export const actionsMixin = {
  _renderActions() {
    const t = this.ticket;
    const buttons = [];

    // Proposed -> approve (open) or deny (wont_do)
    if (t.status === 'proposed') {
      // Check for unresolved "blocked by" links — find proposals that block this ticket
      // and haven't been accepted yet (still in 'proposed' status).
      const unresolvedBlockers = this.allTickets.filter(other => {
        if (other.id === t.id) return false;
        if (other.status !== 'proposed') return false; // already accepted = resolved
        const otherLinks = Array.isArray(other.links) ? other.links : [];
        return otherLinks.some(l => l.targetId === t.id && l.type === 'blocks');
      });

      const approveTicket = async (skipWarning) => {
        try {
          await this.onTransition(t.id, 'open', { note: 'Approved by user' });
          this.toast.success('Ticket approved.');
        } catch (err) {
          this.toast.error('Failed: ' + err.message);
        }
      };

      if (unresolvedBlockers.length > 0) {
        // Approve button with inline blocker warning on click
        const warningContainer = el('div', { className: 'tk-blocker-warning-container' });

        const approveBtn = el('button', {
          className: 'tk-btn tk-btn-success tk-btn-sm',
          onClick: async (e) => {
            e.stopPropagation();
            // Show inline warning
            warningContainer.innerHTML = '';
            const blockerName = unresolvedBlockers[0].ticketId || unresolvedBlockers[0].title || 'another proposal';
            const moreCount = unresolvedBlockers.length - 1;
            const warningText = unresolvedBlockers.length === 1
              ? `This depends on ${blockerName} which hasn't been accepted yet. Accept anyway?`
              : `This depends on ${blockerName} and ${moreCount} other${moreCount !== 1 ? 's' : ''} which haven't been accepted yet. Accept anyway?`;

            const warningEl = el('div', {
              className: 'tk-blocker-warning',
              role: 'alert',
              'aria-live': 'assertive',
              tabindex: '-1',
            },
              el('span', { className: 'tk-blocker-warning-text' }, warningText),
              el('button', {
                type: 'button',
                className: 'tk-btn tk-btn-success tk-btn-sm',
                onClick: async () => { await approveTicket(true); },
              }, 'Accept anyway'),
              el('button', {
                type: 'button',
                className: 'tk-btn tk-btn-ghost tk-btn-sm',
                onClick: () => {
                  warningContainer.innerHTML = '';
                  approveBtn.disabled = false;
                },
              }, 'Cancel'),
            );
            warningContainer.appendChild(warningEl);
            approveBtn.disabled = true;
            // Move focus to warning for screen readers
            warningEl.focus();
          },
        }, 'Approve');

        buttons.push(approveBtn);
        buttons.push(warningContainer);
      } else {
        buttons.push(el('button', {
          className: 'tk-btn tk-btn-success tk-btn-sm',
          onClick: async () => { await approveTicket(false); },
        }, 'Approve'));
      }

      buttons.push(el('button', {
        className: 'tk-btn tk-btn-danger tk-btn-sm',
        onClick: async () => {
          try {
            await this.onTransition(t.id, 'wont_do', {
              note: 'Denied by user',
            });
            this.toast.success("Ticket marked as Won't Do.");
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          }
        },
      }, 'Deny'));

      // "Not relevant" rejection button — opens inline popover for reason capture
      if (this.onReject) {
        buttons.push(this._renderRejectionButton(t));
      }

      // Snooze button — secondary action, placed after primary approve/reject
      if (this.onSnooze) {
        buttons.push(this._renderSnoozeButton(t));
      }
    }

    // Done -> reopen
    if (t.status === 'done') {
      // Reuse the existing input element so that any text the user has already
      // typed (and keyboard focus) is preserved across Firestore-triggered
      // re-renders.  render() clears _commentInput whenever the ticket status
      // changes, so this is safe.
      if (!this._commentInput) {
        this._commentInput = el('input', {
          className: 'tk-comment-input',
          placeholder: 'Optional comment...',
        });
      }
      const commentInput = this._commentInput;

      buttons.push(commentInput);

      buttons.push(el('button', {
        className: 'tk-btn tk-btn-outline tk-btn-sm',
        onClick: async () => {
          try {
            await this.onTransition(t.id, 'open', {
              note: commentInput.value.trim() || 'Reopened by user',
            });
            this.toast.success('Ticket reopened.');
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          }
        },
      }, 'Reopen'));

      buttons.push(el('button', {
        className: 'tk-btn tk-btn-success tk-btn-sm',
        onClick: async () => {
          try {
            await this.onTransition(t.id, 'verified', {
              note: commentInput.value.trim() || 'Verified by user',
            });
            this.toast.success('Ticket verified.');
          } catch (err) {
            this.toast.error('Failed: ' + err.message);
          }
        },
      }, 'Verify'));
    }

    // "Exclude this path/URL" button — DK-128
    // Shown on proposed advisor tickets (Engineer or Design) when onExclude is wired.
    // Pre-populates the exclusion pattern from the ticket's first fileRef (Engineer)
    // or leaves an empty input for Design (since URL is not stored on the ticket).
    if (this.onExclude && t.status === 'proposed' && t.advisorPersona) {
      const isEngineer = t.advisorPersona === 'engineer';
      const isDesign = t.advisorPersona === 'design';

      // Only show for engineer (needs fileRefs) and design
      if (isEngineer || isDesign) {
        // Pre-populate: for engineer, use the directory of the first fileRef
        let prePopulated = '';
        if (isEngineer && Array.isArray(t.fileRefs) && t.fileRefs.length > 0) {
          const firstPath = t.fileRefs[0].path || '';
          // Suggest directory glob (e.g. "vendor/stripe/**" from "vendor/stripe/foo.js")
          const lastSlash = firstPath.lastIndexOf('/');
          prePopulated = lastSlash > 0 ? firstPath.slice(0, lastSlash) + '/**' : firstPath;
        }

        const btnLabel = isEngineer ? 'Exclude this path' : 'Exclude this URL';
        const excludeBtn = el('button', {
          className: 'tk-btn tk-btn-ghost tk-btn-sm tk-exclude-btn',
          type: 'button',
          title: `Add to ${isEngineer ? 'Engineer' : 'Design'} exclusion list — ${isEngineer ? 'Engineer' : 'Design'} will skip this ${isEngineer ? 'path' : 'URL'} in future runs`,
          onClick: (e) => {
            e.stopPropagation();
            this._renderExcludeConfirm(t, prePopulated, excludeBtn);
          },
        }, btnLabel);
        buttons.push(excludeBtn);
      }
    }

    // Mark Critical button — available on open tickets that are not yet critical.
    // Marks the ticket as critical so the orchestrator spawns a worker immediately,
    // bypassing the normal max-worker cap (matching the behavior of the creation checkbox).
    if (this.onMarkCritical && t.status === 'open' && !t.critical) {
      const markCriticalBtn = el('button', {
        className: 'tk-btn tk-btn-critical tk-btn-sm',
        title: 'Mark as critical — the orchestrator will spawn a worker immediately, above the normal cap',
        onClick: async (e) => {
          e.stopPropagation();
          markCriticalBtn.disabled = true;
          markCriticalBtn.textContent = 'Marking…';
          try {
            await this.onMarkCritical(t.id);
            this.toast.success(`${t.ticketId} marked as critical — worker will spawn immediately.`);
          } catch (err) {
            this.toast.error('Failed to mark critical: ' + err.message);
            markCriticalBtn.disabled = false;
            markCriticalBtn.textContent = '⚡ Mark Critical';
          }
        },
      }, '⚡ Mark Critical');
      buttons.push(markCriticalBtn);
    }

    // Reset to Open button (admin only, for in_progress or blocked tickets)
    if (this.isAdmin() && (t.status === 'in_progress' || t.status === 'blocked')) {
      buttons.push(el('button', {
        className: 'tk-btn tk-btn-warning tk-btn-sm',
        title: `Reset ${t.ticketId} back to open status — the worker will be available for a fresh attempt`,
        onClick: async (e) => {
          e.stopPropagation();
          const confirmed = window.confirm(
            `Reset ${t.ticketId} back to open? The orchestrator can then assign a fresh worker.`
          );
          if (!confirmed) return;
          try {
            await this.onTransition(t.id, 'open', {
              note: `Reset to open by admin (was ${t.status})`,
            });
            this.toast.success(`Ticket ${t.ticketId} reset to open.`);
          } catch (err) {
            this.toast.error('Failed to reset: ' + err.message);
          }
        },
      }, 'Reset to Open'));
    }

    // Delete button (admin only)
    if (this.isAdmin() && this.onDelete) {
      buttons.push(el('button', {
        className: 'tk-btn tk-btn-danger tk-btn-sm',
        onClick: async (e) => {
          e.stopPropagation();
          const confirmed = window.confirm(
            `Delete ticket ${t.ticketId}: "${t.title}"? This cannot be undone.`
          );
          if (!confirmed) return;
          try {
            await this.onDelete(t.id);
            this.toast.success(`Ticket ${t.ticketId} deleted.`);
          } catch (err) {
            this.toast.error('Failed to delete: ' + err.message);
          }
        },
      }, 'Delete'));
    }

    if (buttons.length === 0) return null;

    return el('div', { className: 'tk-ticket-actions' }, buttons);
  }

  /**
   * Render a small inline "confirm exclusion" mini-form below the exclude button.
   * Allows user to confirm/edit the pre-populated pattern before saving.
   *
   * @param {object} t - The ticket
   * @param {string} prePopulated - Pre-filled pattern
   * @param {HTMLElement} triggerBtn - The button that opened this form (for positioning)
   */,

  _renderExcludeConfirm(t, prePopulated, triggerBtn) {
    // Remove any existing popover
    const existing = this.el?.querySelector('.tk-exclude-popover');
    if (existing) { existing.remove(); return; }

    const isEngineer = t.advisorPersona === 'engineer';
    const personaId = t.advisorPersona; // 'engineer' | 'design'
    const inputLabel = isEngineer ? 'Glob pattern to exclude:' : 'URL prefix to exclude:';
    const placeholder = isEngineer ? 'e.g. vendor/**, legacy/**' : 'e.g. https://example.com/admin/';
    const MAX_LEN = 200;

    const patternInput = el('input', {
      type: 'text',
      className: 'tk-exclude-input',
      value: prePopulated,
      placeholder,
      maxLength: MAX_LEN,
      'aria-label': inputLabel,
    });

    const validationEl = el('span', {
      className: 'tk-exclude-validation',
      role: 'status',
      'aria-live': 'polite',
    });

    const validateInput = () => {
      const v = patternInput.value.trim();
      if (!v) {
        validationEl.textContent = '';
        return false;
      }
      if (v.length > MAX_LEN) {
        validationEl.textContent = '✗ Too long (max 200 chars)';
        return false;
      }
      if (isEngineer && /\*{3,}|\*\*\/\*\*/.test(v)) {
        validationEl.textContent = '✗ Repeated wildcards — simplify to **';
        return false;
      }
      if (!isEngineer) {
        const lower = v.toLowerCase();
        if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
          validationEl.textContent = '✗ Pattern cannot match javascript: or data: URIs';
          return false;
        }
      }
      validationEl.textContent = '✓ valid';
      return true;
    };

    patternInput.addEventListener('input', validateInput);

    const confirmBtn = el('button', {
      type: 'button',
      className: 'tk-btn tk-btn-success tk-btn-sm',
      onClick: async () => {
        const v = patternInput.value.trim();
        if (!v || !validateInput()) return;
        try {
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Saving…';
          await this.onExclude({ personaId, pattern: v });
          popover.remove();
          this.toast.success(`Exclusion added: ${v}`);
        } catch (err) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Exclude';
          validationEl.textContent = `✗ Save failed`;
        }
      },
    }, 'Exclude');

    const cancelBtn = el('button', {
      type: 'button',
      className: 'tk-btn tk-btn-ghost tk-btn-sm',
      onClick: () => popover.remove(),
    }, 'Cancel');

    const popover = el('div', { className: 'tk-exclude-popover', role: 'dialog', 'aria-label': 'Add exclusion pattern' },
      el('label', { className: 'tk-exclude-label' }, inputLabel),
      patternInput,
      validationEl,
      el('div', { className: 'tk-exclude-popover-actions' },
        confirmBtn,
        cancelBtn,
      ),
    );

    // Insert after trigger button's parent row
    triggerBtn.closest('.tk-ticket-actions')?.after(popover);
    // Focus the input for immediate editing
    patternInput.focus();
    if (prePopulated) {
      patternInput.select();
      validateInput();
    }
  },

};
