// Persona modals — Soul, Constraint, TestRails.
// Modal-overlay dialogs that edit per-persona prompt overrides and QA test rails.
// Each open* method tears down any previous instance before mounting a new one.

import { el } from '../ui/el.js';
import { DEFAULT_SOUL_PROMPTS } from '../config/soul-prompts.js';

export const modalsMixin = {
  // ── Soul modal ───────────────────────────────────────────────

  _openSoulModal(personaId, personaLabel) {
    this._closeSoulModal(); // close any existing one

    this._soulModalPersonaId = personaId;

    const data = this._states[personaId];
    const currentSoul = (data && typeof data.soulPrompt === 'string' && data.soulPrompt.trim())
      ? data.soulPrompt.trim()
      : '';
    const defaultSoul = DEFAULT_SOUL_PROMPTS[personaId] || '';

    // Overlay
    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeSoulModal(); },
    });

    // Modal box
    const modal = el('div', { className: 'adv-soul-modal' });

    // Header
    const header = el('div', { className: 'adv-soul-modal-header' },
      el('div', { className: 'adv-soul-modal-title' }, `${personaLabel} Soul`),
      el('button', {
        className: 'adv-soul-modal-close',
        title: 'Close',
        onClick: () => this._closeSoulModal(),
      }, '×'),
    );
    modal.appendChild(header);

    // Description
    modal.appendChild(
      el('p', { className: 'adv-soul-modal-desc' },
        'The soul prompt defines this persona\'s identity and reasoning style. ' +
        'Leave blank to use the default.',
      )
    );

    // Textarea — pre-fill with the current custom soul, or the default soul if none is set
    const textarea = el('textarea', {
      className: 'adv-soul-textarea',
      rows: '12',
    });
    textarea.value = currentSoul || defaultSoul;
    modal.appendChild(textarea);

    // Footer with status + buttons
    const statusEl = el('span', { className: 'adv-soul-status' });

    const resetBtn = el('button', {
      className: 'adv-soul-reset-btn',
      title: 'Clear custom soul and revert to default',
      onClick: async () => {
        textarea.value = '';
        await this._saveSoulPrompt(personaId, '', saveBtn, statusEl);
      },
    }, 'Use default');

    const saveBtn = el('button', {
      className: 'adv-soul-save-btn',
      onClick: async () => {
        await this._saveSoulPrompt(personaId, textarea.value, saveBtn, statusEl);
      },
    }, 'Save');

    modal.appendChild(
      el('div', { className: 'adv-soul-modal-footer' },
        statusEl,
        el('div', { className: 'adv-soul-modal-footer-right' },
          resetBtn,
          saveBtn,
        ),
      )
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._soulModal = overlay;

    // Focus the textarea
    setTimeout(() => textarea.focus(), 50);
  },

  _closeSoulModal() {
    if (this._soulModal) {
      if (this._soulModal.parentNode) this._soulModal.parentNode.removeChild(this._soulModal);
      this._soulModal = null;
    }
    this._soulModalPersonaId = null;
  },

  async _saveSoulPrompt(personaId, text, saveBtn, statusEl) {
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    // SECURITY: soulPrompt flows directly into the LLM system prompt. Apply
    // the same sanitization rules used server-side: strip prompt-delimiter
    // characters, remove known injection phrases, and enforce a 500-char cap.
    // Never write raw user input to this field.
    const SOUL_PROMPT_MAX_CHARS = 500;
    const SOUL_INJECTION_PHRASES = ['ignore previous instructions', 'you are now', 'disregard', 'new persona', 'system:'];
    let sanitized = text.slice(0, SOUL_PROMPT_MAX_CHARS);
    const lowerSanitized = sanitized.toLowerCase();
    for (const phrase of SOUL_INJECTION_PHRASES) {
      if (lowerSanitized.includes(phrase)) {
        const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        sanitized = sanitized.replace(re, '');
      }
    }
    sanitized = sanitized.replace(/<\/?system>|<\|/g, '').trim();
    const value = sanitized.length > 0 ? sanitized : null; // null clears it (reverts to default)

    try {
      await this.db.collection('advisor').doc(personaId).set(
        { soulPrompt: value },
        { merge: true }
      );
      statusEl.textContent = value ? 'Saved' : 'Reverted to default';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } catch (err) {
      console.error('Failed to save soulPrompt:', err);
      statusEl.textContent = 'Error saving';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  },

  // ── Constraint modal (DK-365) ─────────────────────────────────────────────

  /**
   * Open the constraint configuration modal drawer for the given persona.
   * Constraints are stored at project.advisorSettings.<personaId>.constraints
   * and are passed to the persona's runCycle on next run.
   */
  _openConstraintModal(personaId, personaLabel) {
    this._closeConstraintModal();

    const projectId = this._filterProjectId;
    const project = projectId ? this._projects.find(p => p.id === projectId) : null;
    const saved = project?.advisorSettings?.[personaId]?.constraints ?? null;

    // Work on a deep copy of saved constraints; user can discard changes
    const draft = saved ? JSON.parse(JSON.stringify(saved)) : {};

    // ── Preset helpers ────────────────────────────────────────

    const CONSTRAINT_PRESETS_DEF = [
      {
        id: 'lean_mvp', label: 'Lean MVP',
        description: 'Low complexity, bootstrapped budget, mobile + web.',
        constraints: { budget_range: { min: 0, max: 25000 }, platform_target: ['mobile', 'web'], audience_segment: 'Broad consumer', complexity_cap: 'low', risk_tolerance: 'moderate' },
      },
      {
        id: 'enterprise_safe', label: 'Enterprise-safe',
        description: 'Medium complexity, funded, web-only, enterprise segment, conservative risk.',
        constraints: { budget_range: { min: 50000, max: 500000 }, platform_target: ['web'], audience_segment: 'Enterprise', complexity_cap: 'medium', risk_tolerance: 'conservative' },
      },
      {
        id: 'consumer_mobile', label: 'Consumer Mobile',
        description: 'Low complexity, moderate budget, mobile-only, broad consumer.',
        constraints: { budget_range: { min: 5000, max: 100000 }, platform_target: ['mobile'], audience_segment: 'Broad consumer', complexity_cap: 'low', risk_tolerance: 'moderate' },
      },
    ];

    // ── Budget slider helpers ─────────────────────────────────

    const BUDGET_STEPS = [0, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
    const BUDGET_LABELS = ['$0', '$5K', '$10K', '$25K', '$50K', '$100K', '$250K', '$500K+'];

    function formatBudgetLabel(val) {
      if (val === 0) return '$0 / Bootstrapped';
      if (val <= 5000) return '$5K / Bootstrapped';
      if (val <= 10000) return '$10K / Seed';
      if (val <= 25000) return '$25K / Small seed';
      if (val <= 50000) return '$50K / Seed-funded';
      if (val <= 100000) return '$100K / Series A range';
      if (val <= 250000) return '$250K / Series A+';
      return '$500K+ / Funded';
    }

    function stepToValue(step) { return BUDGET_STEPS[Math.min(step, BUDGET_STEPS.length - 1)] || 0; }
    function valueToStep(val) {
      let closest = 0;
      let minDiff = Infinity;
      for (let i = 0; i < BUDGET_STEPS.length; i++) {
        const diff = Math.abs(BUDGET_STEPS[i] - val);
        if (diff < minDiff) { minDiff = diff; closest = i; }
      }
      return closest;
    }

    // ── Conflict detection ────────────────────────────────────

    function detectConflicts(d) {
      const msgs = [];
      if (d.complexity_cap === 'high' && d.budget_range && d.budget_range.max <= 5000) {
        msgs.push('High complexity ideas typically require engineering investment. Consider raising your budget or lowering complexity.');
      }
      if (d.risk_tolerance === 'aggressive' && d.budget_range && d.budget_range.max <= 5000) {
        msgs.push('Aggressive risk with a zero budget may produce ideas that are hard to execute. Consider raising the budget or lowering risk.');
      }
      if (Array.isArray(d.platform_target) && d.platform_target.length === 0) {
        msgs.push('No platform selected — select at least one platform for focused ideas.');
      }
      return msgs;
    }

    // ── Count active constraints ──────────────────────────────

    function countActive(d) {
      return Object.keys(d).filter(k => {
        const v = d[k];
        if (Array.isArray(v)) return v.length > 0;
        if (v && typeof v === 'object') return true;
        return v != null && v !== '';
      }).length;
    }

    // ── Overlay + modal container ─────────────────────────────

    const overlay = el('div', {
      className: 'adv-soul-overlay adv-constraint-overlay',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'adv-constraint-modal-title',
      onClick: (e) => { if (e.target === overlay) this._closeConstraintModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-constraint-modal' });

    // Header
    const titleEl = el('span', {
      className: 'adv-soul-modal-title',
      id: 'adv-constraint-modal-title',
    }, `${personaLabel} Constraints`);

    modal.appendChild(el('div', { className: 'adv-soul-modal-header' },
      titleEl,
      el('button', {
        className: 'adv-soul-modal-close',
        title: 'Close',
        'aria-label': 'Close constraints panel',
        onClick: () => this._closeConstraintModal(),
      }, '×'),
    ));

    if (!projectId) {
      modal.appendChild(el('p', { className: 'adv-soul-modal-desc' },
        'Select a project to configure constraints.'
      ));
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      this._constraintModal = overlay;
      this._constraintModalPersonaId = personaId;
      const onKey = (e) => { if (e.key === 'Escape') { this._closeConstraintModal(); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
      this._constraintModal._keyHandler = onKey;
      return;
    }

    modal.appendChild(el('p', { className: 'adv-soul-modal-desc' },
      'Set operating constraints for this persona. Ideas generated will respect these limits. Constraints persist across sessions and apply on the next run.'
    ));

    // ── Preset row ────────────────────────────────────────────
    const presetRow = el('div', { className: 'adv-constraint-preset-row', role: 'group', 'aria-label': 'Constraint presets' });
    modal.appendChild(el('div', { className: 'adv-constraint-section' },
      el('span', { className: 'adv-constraint-section-label' }, 'Presets'),
      presetRow,
    ));

    // ── Status elements (conflict + save) ─────────────────────
    const conflictEl = el('div', {
      className: 'adv-constraint-conflict adv-hidden',
      role: 'alert',
      'aria-live': 'polite',
    });
    modal.appendChild(conflictEl);

    const statusEl = el('div', { className: 'adv-soul-status', role: 'status', 'aria-live': 'polite' });

    // ── Form fields ───────────────────────────────────────────

    const formEl = el('div', { className: 'adv-constraint-form' });

    // Helper: re-check conflicts and update UI
    const refreshConflicts = () => {
      const msgs = detectConflicts(draft);
      if (msgs.length > 0) {
        conflictEl.innerHTML = '';
        msgs.forEach(m => {
          conflictEl.appendChild(el('p', {
            className: 'adv-constraint-conflict-msg',
          }, '⚠ ' + m));
        });
        conflictEl.classList.remove('adv-hidden');
      } else {
        conflictEl.innerHTML = '';
        conflictEl.classList.add('adv-hidden');
      }
    };

    // ── 1. Budget range: dual-handle slider (simulated with two inputs) ───
    const budgetMinStep = valueToStep(draft.budget_range?.min ?? 0);
    const budgetMaxStep = valueToStep(draft.budget_range?.max ?? BUDGET_STEPS[BUDGET_STEPS.length - 1]);

    const budgetMinLabel = el('span', { className: 'adv-constraint-budget-label' }, formatBudgetLabel(stepToValue(budgetMinStep)));
    const budgetMaxLabel = el('span', { className: 'adv-constraint-budget-label' }, formatBudgetLabel(stepToValue(budgetMaxStep)));

    const budgetMinInput = el('input', {
      type: 'range',
      className: 'adv-constraint-slider',
      min: '0',
      max: String(BUDGET_STEPS.length - 1),
      step: '1',
      value: String(budgetMinStep),
      'aria-label': `Budget minimum: ${formatBudgetLabel(stepToValue(budgetMinStep))}`,
      'aria-valuemin': '0',
      'aria-valuemax': String(BUDGET_STEPS.length - 1),
      'aria-valuenow': String(budgetMinStep),
      'aria-valuetext': formatBudgetLabel(stepToValue(budgetMinStep)),
    });

    const budgetMaxInput = el('input', {
      type: 'range',
      className: 'adv-constraint-slider',
      min: '0',
      max: String(BUDGET_STEPS.length - 1),
      step: '1',
      value: String(budgetMaxStep),
      'aria-label': `Budget maximum: ${formatBudgetLabel(stepToValue(budgetMaxStep))}`,
      'aria-valuemin': '0',
      'aria-valuemax': String(BUDGET_STEPS.length - 1),
      'aria-valuenow': String(budgetMaxStep),
      'aria-valuetext': formatBudgetLabel(stepToValue(budgetMaxStep)),
    });

    budgetMinInput.addEventListener('input', () => {
      let step = parseInt(budgetMinInput.value, 10);
      const maxStep = parseInt(budgetMaxInput.value, 10);
      if (step > maxStep) { step = maxStep; budgetMinInput.value = String(step); }
      const val = stepToValue(step);
      budgetMinLabel.textContent = formatBudgetLabel(val);
      budgetMinInput.setAttribute('aria-valuenow', String(step));
      budgetMinInput.setAttribute('aria-valuetext', formatBudgetLabel(val));
      if (!draft.budget_range) draft.budget_range = { min: 0, max: BUDGET_STEPS[BUDGET_STEPS.length - 1] };
      draft.budget_range.min = val;
      refreshConflicts();
    });

    budgetMaxInput.addEventListener('input', () => {
      let step = parseInt(budgetMaxInput.value, 10);
      const minStep = parseInt(budgetMinInput.value, 10);
      if (step < minStep) { step = minStep; budgetMaxInput.value = String(step); }
      const val = stepToValue(step);
      budgetMaxLabel.textContent = formatBudgetLabel(val);
      budgetMaxInput.setAttribute('aria-valuenow', String(step));
      budgetMaxInput.setAttribute('aria-valuetext', formatBudgetLabel(val));
      if (!draft.budget_range) draft.budget_range = { min: 0, max: BUDGET_STEPS[BUDGET_STEPS.length - 1] };
      draft.budget_range.max = val;
      refreshConflicts();
    });

    // Arrow key support for sliders (keyboard operability per spec)
    [budgetMinInput, budgetMaxInput].forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          const v = Math.max(0, parseInt(inp.value, 10) - 1);
          inp.value = String(v);
          inp.dispatchEvent(new Event('input'));
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          const v = Math.min(BUDGET_STEPS.length - 1, parseInt(inp.value, 10) + 1);
          inp.value = String(v);
          inp.dispatchEvent(new Event('input'));
        }
      });
    });

    const budgetClearBtn = el('button', {
      type: 'button',
      className: 'adv-constraint-clear-btn',
      title: 'Clear budget constraint',
      onClick: () => {
        delete draft.budget_range;
        budgetMinInput.value = '0';
        budgetMaxInput.value = String(BUDGET_STEPS.length - 1);
        budgetMinLabel.textContent = formatBudgetLabel(0);
        budgetMaxLabel.textContent = formatBudgetLabel(BUDGET_STEPS[BUDGET_STEPS.length - 1]);
        refreshConflicts();
      },
    }, 'Clear');

    const budgetSection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Budget Range'),
      el('div', { className: 'adv-constraint-budget-track' },
        el('span', { className: 'adv-constraint-budget-anchor' }, '$0 / Bootstrapped'),
        el('span', { className: 'adv-constraint-budget-anchor adv-constraint-budget-anchor-right' }, '$500K+ / Funded'),
      ),
      el('div', { className: 'adv-constraint-slider-row' },
        el('span', { className: 'adv-constraint-slider-label' }, 'Min:'),
        budgetMinInput,
        budgetMinLabel,
      ),
      el('div', { className: 'adv-constraint-slider-row' },
        el('span', { className: 'adv-constraint-slider-label' }, 'Max:'),
        budgetMaxInput,
        budgetMaxLabel,
      ),
      budgetClearBtn,
    );
    formEl.appendChild(budgetSection);

    // ── 2. Risk tolerance: 5-step slider ─────────────────────
    const RISK_OPTIONS = ['conservative', 'moderate', 'balanced', 'adventurous', 'aggressive'];
    const RISK_LABELS_DISPLAY = ['Conservative', 'Moderate', 'Balanced', 'Adventurous', 'Aggressive'];
    const riskStep = RISK_OPTIONS.indexOf(draft.risk_tolerance ?? 'balanced');
    const riskValueLabel = el('span', { className: 'adv-constraint-budget-label' }, RISK_LABELS_DISPLAY[Math.max(0, riskStep)] || 'Balanced');

    const riskInput = el('input', {
      type: 'range',
      className: 'adv-constraint-slider',
      min: '0',
      max: '4',
      step: '1',
      value: String(Math.max(0, riskStep)),
      'aria-label': `Risk Tolerance: ${RISK_LABELS_DISPLAY[Math.max(0, riskStep)]} (${Math.max(0, riskStep) + 1} of 5)`,
      'aria-valuemin': '0',
      'aria-valuemax': '4',
      'aria-valuenow': String(Math.max(0, riskStep)),
      'aria-valuetext': `${RISK_LABELS_DISPLAY[Math.max(0, riskStep)]} (${Math.max(0, riskStep) + 1} of 5)`,
    });

    riskInput.addEventListener('input', () => {
      const step = parseInt(riskInput.value, 10);
      const label = RISK_LABELS_DISPLAY[step] || 'Balanced';
      riskValueLabel.textContent = label;
      riskInput.setAttribute('aria-valuenow', String(step));
      riskInput.setAttribute('aria-valuetext', `${label} (${step + 1} of 5)`);
      riskInput.setAttribute('aria-label', `Risk Tolerance: ${label} (${step + 1} of 5)`);
      draft.risk_tolerance = RISK_OPTIONS[step];
      refreshConflicts();
    });

    riskInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = Math.max(0, parseInt(riskInput.value, 10) - 1);
        riskInput.value = String(v);
        riskInput.dispatchEvent(new Event('input'));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        const v = Math.min(4, parseInt(riskInput.value, 10) + 1);
        riskInput.value = String(v);
        riskInput.dispatchEvent(new Event('input'));
      }
    });

    const riskSection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Risk Tolerance'),
      el('div', { className: 'adv-constraint-budget-track' },
        el('span', { className: 'adv-constraint-budget-anchor' }, 'Conservative'),
        el('span', { className: 'adv-constraint-budget-anchor adv-constraint-budget-anchor-right' }, 'Aggressive'),
      ),
      el('div', { className: 'adv-constraint-slider-row' },
        riskInput,
        riskValueLabel,
      ),
    );
    formEl.appendChild(riskSection);

    // ── 3. Platform target: pill-select (multi-select) ────────
    const PLATFORM_OPTIONS = [
      { value: 'web',     label: 'Web' },
      { value: 'mobile',  label: 'Mobile' },
      { value: 'desktop', label: 'Desktop' },
      { value: 'api',     label: 'API/Backend' },
    ];
    const selectedPlatforms = new Set(Array.isArray(draft.platform_target) ? draft.platform_target : []);
    const platformPills = [];

    const platformPillGroup = el('div', { className: 'adv-constraint-pill-group', role: 'group', 'aria-label': 'Platform targets (multi-select)' });
    for (const opt of PLATFORM_OPTIONS) {
      const isSelected = selectedPlatforms.has(opt.value);
      const pill = el('button', {
        type: 'button',
        className: 'adv-constraint-pill' + (isSelected ? ' adv-constraint-pill-active' : ''),
        'aria-pressed': String(isSelected),
        onClick: () => {
          const pressed = pill.getAttribute('aria-pressed') === 'true';
          if (pressed) {
            selectedPlatforms.delete(opt.value);
            pill.setAttribute('aria-pressed', 'false');
            pill.classList.remove('adv-constraint-pill-active');
          } else {
            selectedPlatforms.add(opt.value);
            pill.setAttribute('aria-pressed', 'true');
            pill.classList.add('adv-constraint-pill-active');
          }
          draft.platform_target = [...selectedPlatforms];
          refreshConflicts();
        },
      }, opt.label);
      platformPills.push(pill);
      platformPillGroup.appendChild(pill);
    }

    const platformSection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Platform Target'),
      el('span', { className: 'adv-constraint-field-hint' }, 'Select all that apply'),
      platformPillGroup,
    );
    formEl.appendChild(platformSection);

    // ── 4. Audience segment: dropdown + free text ─────────────
    const AUDIENCE_PRESETS = [
      { value: '', label: '— choose or type below —' },
      { value: 'Broad consumer', label: 'Broad consumer' },
      { value: 'SMB', label: 'SMB (small & medium business)' },
      { value: 'Enterprise', label: 'Enterprise' },
      { value: 'Developer', label: 'Developer / technical' },
      { value: 'Healthcare', label: 'Healthcare' },
      { value: 'Education', label: 'Education' },
      { value: 'Fintech', label: 'Fintech' },
    ];

    const audienceSelect = el('select', {
      className: 'adv-constraint-select',
      'aria-label': 'Audience segment preset',
      onChange: () => {
        if (audienceSelect.value) {
          audienceInput.value = audienceSelect.value;
          draft.audience_segment = audienceSelect.value;
          audienceCounter.textContent = `${audienceSelect.value.length} / 200`;
        }
      },
    });
    for (const opt of AUDIENCE_PRESETS) {
      audienceSelect.appendChild(el('option', { value: opt.value }, opt.label));
    }
    // Pre-select if saved value matches a preset
    if (draft.audience_segment) {
      const match = AUDIENCE_PRESETS.find(p => p.value === draft.audience_segment);
      if (match) audienceSelect.value = match.value;
    }

    const audienceCounter = el('span', { className: 'adv-focus-counter' }, `${(draft.audience_segment || '').length} / 200`);
    const audienceDescId = `adv-audience-desc-${personaId}`;
    const audienceInput = el('input', {
      type: 'text',
      className: 'adv-constraint-text-input',
      placeholder: 'e.g. B2B SaaS teams, 50–500 employees',
      maxlength: '200',
      value: draft.audience_segment || '',
      'aria-label': 'Audience segment (free text, max 200 characters)',
      'aria-describedby': audienceDescId,
      onInput: () => {
        const len = audienceInput.value.length;
        audienceCounter.textContent = `${len} / 200`;
        audienceCounter.className = 'adv-focus-counter' + (len > 180 ? ' adv-focus-counter-warn' : '');
        draft.audience_segment = audienceInput.value;
      },
    });

    const audienceSection = el('div', { className: 'adv-constraint-field' },
      el('div', { className: 'adv-constraint-label-row' },
        el('label', { className: 'adv-constraint-label' }, 'Audience Segment'),
        audienceCounter,
      ),
      audienceSelect,
      audienceInput,
      el('span', { className: 'adv-focus-counter', id: audienceDescId, style: 'display:none' }, 'Max 200 characters'),
    );
    formEl.appendChild(audienceSection);

    // ── 5. Complexity cap: 3-option pill-select ───────────────
    const COMPLEXITY_OPTIONS = [
      { value: 'low',    label: 'Low',    desc: 'MVP-scope ideas, minimal engineering' },
      { value: 'medium', label: 'Medium', desc: 'Standard feature complexity' },
      { value: 'high',   label: 'High',   desc: 'Platform-level changes' },
    ];

    const complexityPillGroup = el('div', { className: 'adv-constraint-pill-group', role: 'group', 'aria-label': 'Complexity cap (choose one)' });
    const complexityPills = [];
    let selectedComplexity = draft.complexity_cap || null;

    for (const opt of COMPLEXITY_OPTIONS) {
      const isSelected = selectedComplexity === opt.value;
      const pill = el('button', {
        type: 'button',
        className: 'adv-constraint-pill' + (isSelected ? ' adv-constraint-pill-active' : ''),
        title: opt.desc,
        'aria-pressed': String(isSelected),
        onClick: () => {
          complexityPills.forEach(p => {
            p.setAttribute('aria-pressed', 'false');
            p.classList.remove('adv-constraint-pill-active');
          });
          pill.setAttribute('aria-pressed', 'true');
          pill.classList.add('adv-constraint-pill-active');
          selectedComplexity = opt.value;
          draft.complexity_cap = opt.value;
          refreshConflicts();
        },
      }, opt.label);
      complexityPills.push(pill);
      complexityPillGroup.appendChild(pill);
    }

    const complexitySection = el('div', { className: 'adv-constraint-field' },
      el('label', { className: 'adv-constraint-label' }, 'Complexity Cap'),
      el('span', { className: 'adv-constraint-field-hint' }, 'Maximum scope of ideas generated'),
      complexityPillGroup,
    );
    formEl.appendChild(complexitySection);

    modal.appendChild(formEl);
    modal.appendChild(conflictEl);

    // ── Per-run override toggle ───────────────────────────────
    const overrideSection = el('details', { className: 'adv-constraint-override' });
    overrideSection.appendChild(el('summary', {}, 'Run with saved constraints / Customize for this run'));
    overrideSection.appendChild(el('p', { className: 'adv-constraint-override-hint' },
      'Override constraints are applied to the next on-demand run only and are discarded after. They do not change your saved settings.',
    ));
    modal.appendChild(overrideSection);

    // ── Preset buttons (built after form so they can reference controls) ──
    for (const preset of CONSTRAINT_PRESETS_DEF) {
      const presetBtn = el('button', {
        type: 'button',
        className: 'adv-weights-preset-btn',
        title: preset.description,
        onClick: () => {
          // Apply preset to draft
          Object.assign(draft, JSON.parse(JSON.stringify(preset.constraints)));
          // Sync UI controls from draft
          syncUIFromDraft();
          refreshConflicts();
        },
      }, preset.label);
      presetRow.appendChild(presetBtn);
    }

    // ── Reset + Clear ─────────────────────────────────────────
    const resetBtn = el('button', {
      type: 'button',
      className: 'adv-soul-cancel-btn',
      onClick: () => {
        // Reset to saved state
        const resaved = project?.advisorSettings?.[personaId]?.constraints ?? null;
        for (const k of Object.keys(draft)) delete draft[k];
        if (resaved) Object.assign(draft, JSON.parse(JSON.stringify(resaved)));
        syncUIFromDraft();
        refreshConflicts();
        statusEl.textContent = 'Reset to saved';
        statusEl.className = 'adv-soul-status';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      },
    }, 'Reset');

    const clearBtn = el('button', {
      type: 'button',
      className: 'adv-soul-cancel-btn',
      title: 'Clear all constraints',
      onClick: () => {
        for (const k of Object.keys(draft)) delete draft[k];
        syncUIFromDraft();
        refreshConflicts();
      },
    }, 'Clear all');

    const saveBtn = el('button', {
      type: 'button',
      className: 'adv-soul-save-btn',
      onClick: () => this._saveConstraints(personaId, draft, saveBtn, statusEl),
    }, 'Save constraints');

    modal.appendChild(el('div', { className: 'adv-soul-modal-footer' },
      statusEl,
      el('div', { className: 'adv-soul-modal-footer-right' },
        clearBtn,
        resetBtn,
        saveBtn,
      ),
    ));

    // ── Sync UI controls from draft (used by presets + reset) ─

    const syncUIFromDraft = () => {
      // Budget
      const bMin = valueToStep(draft.budget_range?.min ?? 0);
      const bMax = valueToStep(draft.budget_range?.max ?? BUDGET_STEPS[BUDGET_STEPS.length - 1]);
      budgetMinInput.value = String(bMin);
      budgetMaxInput.value = String(bMax);
      budgetMinLabel.textContent = formatBudgetLabel(stepToValue(bMin));
      budgetMaxLabel.textContent = formatBudgetLabel(stepToValue(bMax));
      budgetMinInput.setAttribute('aria-valuenow', String(bMin));
      budgetMinInput.setAttribute('aria-valuetext', formatBudgetLabel(stepToValue(bMin)));
      budgetMaxInput.setAttribute('aria-valuenow', String(bMax));
      budgetMaxInput.setAttribute('aria-valuetext', formatBudgetLabel(stepToValue(bMax)));

      // Risk
      const riskIdx = RISK_OPTIONS.indexOf(draft.risk_tolerance ?? 'balanced');
      const rIdx = Math.max(0, riskIdx);
      riskInput.value = String(rIdx);
      riskValueLabel.textContent = RISK_LABELS_DISPLAY[rIdx] || 'Balanced';
      riskInput.setAttribute('aria-valuenow', String(rIdx));
      riskInput.setAttribute('aria-valuetext', `${RISK_LABELS_DISPLAY[rIdx]} (${rIdx + 1} of 5)`);

      // Platform
      const newPlatforms = new Set(Array.isArray(draft.platform_target) ? draft.platform_target : []);
      selectedPlatforms.clear();
      for (const p of newPlatforms) selectedPlatforms.add(p);
      PLATFORM_OPTIONS.forEach((opt, i) => {
        const active = selectedPlatforms.has(opt.value);
        platformPills[i].setAttribute('aria-pressed', String(active));
        platformPills[i].classList.toggle('adv-constraint-pill-active', active);
      });

      // Audience
      audienceInput.value = draft.audience_segment || '';
      audienceCounter.textContent = `${(draft.audience_segment || '').length} / 200`;
      const audienceMatch = AUDIENCE_PRESETS.find(p => p.value === (draft.audience_segment || ''));
      audienceSelect.value = audienceMatch ? audienceMatch.value : '';

      // Complexity
      const newComp = draft.complexity_cap || null;
      selectedComplexity = newComp;
      COMPLEXITY_OPTIONS.forEach((opt, i) => {
        const active = opt.value === newComp;
        complexityPills[i].setAttribute('aria-pressed', String(active));
        complexityPills[i].classList.toggle('adv-constraint-pill-active', active);
      });
    };

    // Initial conflict check
    refreshConflicts();

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._constraintModal = overlay;
    this._constraintModalPersonaId = personaId;

    const onKey = (e) => {
      if (e.key === 'Escape') { this._closeConstraintModal(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    this._constraintModal._keyHandler = onKey;

    // Focus the save button
    setTimeout(() => saveBtn.focus(), 50);
  },

  _closeConstraintModal() {
    if (this._constraintModal) {
      if (this._constraintModal._keyHandler) {
        document.removeEventListener('keydown', this._constraintModal._keyHandler);
      }
      if (this._constraintModal.parentNode) this._constraintModal.parentNode.removeChild(this._constraintModal);
      this._constraintModal = null;
    }
    this._constraintModalPersonaId = null;
  },

  /**
   * Save persona constraints to Firestore.
   * Stored at project.advisorSettings.<personaId>.constraints
   * Validation is performed in the backend (start-advisor.js) before use.
   */
  async _saveConstraints(personaId, draft, saveBtn, statusEl) {
    const projectId = this._filterProjectId;
    if (!projectId) {
      statusEl.textContent = 'No project selected';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
      return;
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'adv-soul-status';

    try {
      // Build a clean constraints object from draft
      // Omit empty/default values to keep Firestore doc tidy
      const toSave = {};
      if (draft.budget_range != null) {
        toSave.budget_range = { min: draft.budget_range.min || 0, max: draft.budget_range.max || 0 };
      }
      if (Array.isArray(draft.platform_target) && draft.platform_target.length > 0) {
        toSave.platform_target = draft.platform_target;
      }
      if (draft.audience_segment?.trim()) {
        toSave.audience_segment = draft.audience_segment.trim().slice(0, 200);
      }
      if (draft.complexity_cap) {
        toSave.complexity_cap = draft.complexity_cap;
      }
      if (draft.risk_tolerance) {
        toSave.risk_tolerance = draft.risk_tolerance;
      }

      const update = {
        [`advisorSettings.${personaId}.constraints`]: Object.keys(toSave).length > 0 ? toSave : null,
        updatedAt: new Date().toISOString(),
      };
      await this.db.collection('projects').doc(projectId).update(update);

      statusEl.textContent = 'Saved';
      statusEl.className = 'adv-soul-status adv-soul-status-ok';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'adv-soul-status'; }, 2000);

      // Update chip immediately (optimistic — will also refresh from Firestore on next snapshot)
      const chipEl = this._constraintChipEls[personaId];
      if (chipEl) {
        const count = Object.keys(toSave).length;
        if (count > 0) {
          chipEl.textContent = `⚙ ${count} constraint${count === 1 ? '' : 's'} active`;
          chipEl.classList.remove('adv-hidden');
        } else {
          chipEl.classList.add('adv-hidden');
        }
      }
    } catch (err) {
      console.error('Failed to save constraints:', err);
      statusEl.textContent = 'Error saving';
      statusEl.className = 'adv-soul-status adv-soul-status-err';
    } finally {
      saveBtn.disabled = false;
    }
  },

  // ── Test Rails modal (QA persona) ────────────────────────────

  _openTestRailsModal() {
    this._closeTestRailsModal();

    const db = this.db;
    const qaData = this._states['qa'] || {};
    // Deep copy so local edits don't mutate live state
    let localRails = JSON.parse(JSON.stringify(qaData.testRails || {}));

    const overlay = el('div', {
      className: 'adv-soul-overlay',
      onClick: (e) => { if (e.target === overlay) this._closeTestRailsModal(); },
    });

    const modal = el('div', { className: 'adv-soul-modal adv-rails-modal' });

    modal.appendChild(el('div', { className: 'adv-soul-modal-header' },
      el('div', { className: 'adv-soul-modal-title' }, 'Test Rails'),
      el('button', {
        className: 'adv-soul-modal-close',
        title: 'Close',
        onClick: () => this._closeTestRailsModal(),
      }, '×'),
    ));

    modal.appendChild(el('p', { className: 'adv-soul-modal-desc' },
      'Playwright flows run each QA cycle to catch regressions. ' +
      'New rails are auto-generated from recently completed feature tickets.',
    ));

    const statusEl = el('div', { className: 'adv-rails-status' });
    const setStatus = (msg, isErr = false) => {
      statusEl.textContent = msg;
      statusEl.className = 'adv-rails-status' + (isErr ? ' adv-soul-status-err' : ' adv-soul-status-ok');
      if (!isErr) setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'adv-rails-status'; }, 2000);
    };

    const contentEl = el('div', { className: 'adv-rails-content' });

    const writeProjectRails = async (projectId, rails) => {
      await db.collection('advisor').doc('qa').set(
        { testRails: { [projectId]: rails } },
        { merge: true }
      );
      localRails[projectId] = rails;
    };

    const rebuildContent = () => {
      contentEl.innerHTML = '';
      const projectIds = Object.keys(localRails);

      if (projectIds.length === 0) {
        contentEl.appendChild(el('div', { className: 'adv-rails-empty' },
          'No test rails yet. Run QA to auto-seed from configured flows, or add one manually.',
        ));
        return;
      }

      for (const projectId of projectIds) {
        const rails = localRails[projectId] || [];
        const railsListEl = el('div', { className: 'adv-rails-list' });

        const buildRailRow = (rail) => {
          const resultClass =
            rail.lastResult === 'pass' ? 'adv-rail-pass' :
            rail.lastResult === 'fail' ? 'adv-rail-fail' :
            rail.lastResult === 'warn' ? 'adv-rail-warn' :
            'adv-rail-none';
          const resultText =
            rail.lastResult === 'pass' ? '✓' :
            rail.lastResult === 'fail' ? '✗' :
            rail.lastResult === 'warn' ? '~' : '–';
          const stepCount = Array.isArray(rail.steps) ? rail.steps.length : 0;

          const editForm = el('div', { className: 'adv-rail-edit-form adv-hidden' });

          const populateEditForm = (currentRail, isNew = false) => {
            editForm.innerHTML = '';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'adv-rail-input';
            nameInput.value = currentRail.name;
            nameInput.placeholder = 'Rail name';

            const descTA = el('textarea', { className: 'adv-rail-textarea', rows: '2', placeholder: 'What does this rail verify?' });
            descTA.value = currentRail.description || '';

            const stepsTA = el('textarea', { className: 'adv-rail-steps-textarea', rows: '10', placeholder: '[]', spellcheck: 'false' });
            stepsTA.value = JSON.stringify(currentRail.steps || [], null, 2);

            const criticalCb = document.createElement('input');
            criticalCb.type = 'checkbox';
            criticalCb.className = 'adv-rail-critical-cb';
            criticalCb.id = `adv-rail-crit-${currentRail.id}`;
            criticalCb.checked = currentRail.critical !== false;

            const criticalRow = el('div', { className: 'adv-rail-critical-row' },
              criticalCb,
              el('label', { htmlFor: `adv-rail-crit-${currentRail.id}`, className: 'adv-rail-critical-label' },
                '● Run every cycle (critical) — uncheck to run periodically',
              ),
            );

            const formStatus = el('span', { className: 'adv-soul-status' });

            const saveBtn = el('button', { className: 'adv-soul-save-btn', type: 'button',
              onClick: async () => {
                let steps;
                try { steps = JSON.parse(stepsTA.value); }
                catch { formStatus.textContent = 'Invalid JSON'; formStatus.className = 'adv-soul-status adv-soul-status-err'; return; }

                const updated = { ...currentRail, name: nameInput.value.trim() || currentRail.name, description: descTA.value.trim(), steps, critical: criticalCb.checked };
                saveBtn.disabled = true;
                formStatus.textContent = 'Saving…';
                formStatus.className = 'adv-soul-status';
                try {
                  const currentList = localRails[projectId] || [];
                  const idx = currentList.findIndex(r => r.id === updated.id);
                  const newList = idx >= 0
                    ? currentList.map((r, i) => i === idx ? updated : r)
                    : [...currentList, updated];
                  await writeProjectRails(projectId, newList);
                  setStatus('Saved');
                  rebuildContent();
                } catch (err) {
                  formStatus.textContent = 'Error: ' + err.message;
                  formStatus.className = 'adv-soul-status adv-soul-status-err';
                  saveBtn.disabled = false;
                }
              },
            }, 'Save');

            const cancelBtn = el('button', { className: 'adv-soul-reset-btn', type: 'button',
              onClick: () => {
                if (isNew) { editForm.remove(); }
                else { editForm.classList.add('adv-hidden'); }
              },
            }, 'Cancel');

            editForm.appendChild(el('div', { className: 'adv-rail-edit-fields' },
              el('label', { className: 'adv-rail-edit-label' }, 'Name'), nameInput,
              el('label', { className: 'adv-rail-edit-label' }, 'Description'), descTA,
              criticalRow,
              el('label', { className: 'adv-rail-edit-label' }, 'Steps (JSON array of step objects)'), stepsTA,
            ));
            editForm.appendChild(el('div', { className: 'adv-rail-edit-footer' }, formStatus,
              el('div', { className: 'adv-soul-modal-footer-right' }, cancelBtn, saveBtn),
            ));
          };

          const editBtn = el('button', { className: 'adv-rail-btn', type: 'button',
            onClick: () => {
              if (editForm.classList.contains('adv-hidden')) {
                populateEditForm(rail);
                editForm.classList.remove('adv-hidden');
              } else {
                editForm.classList.add('adv-hidden');
              }
            },
          }, 'Edit');

          const delBtn = el('button', { className: 'adv-rail-btn adv-rail-btn-del', type: 'button',
            onClick: async () => {
              const newList = (localRails[projectId] || []).filter(r => r.id !== rail.id);
              try {
                await writeProjectRails(projectId, newList);
                setStatus('Rail deleted');
                rebuildContent();
              } catch (err) {
                setStatus('Error: ' + err.message, true);
              }
            },
          }, '×');

          const isCritical = rail.critical !== false;
          const metaParts = [`${stepCount} step${stepCount !== 1 ? 's' : ''}`];
          if (rail.addedByFeature) metaParts.push(rail.addedByFeature);
          if (rail.lastRunAt) {
            const ago = Math.round((Date.now() - new Date(rail.lastRunAt)) / 60000);
            metaParts.push(`ran ${ago < 2 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`}`);
          }

          const row = el('div', { className: 'adv-rail-row' },
            el('span', { className: `adv-rail-result ${resultClass}`, title: rail.lastResult || 'not run' }, resultText),
            el('span', {
              className: `adv-rail-freq ${isCritical ? 'adv-rail-freq-critical' : 'adv-rail-freq-periodic'}`,
              title: isCritical ? 'Runs every cycle' : 'Runs periodically',
            }, isCritical ? '●' : '○'),
            el('span', { className: 'adv-rail-name' }, rail.name),
            el('span', { className: 'adv-rail-meta' }, metaParts.join(' · ')),
            el('div', { className: 'adv-rail-actions' }, editBtn, delBtn),
          );

          return el('div', { className: 'adv-rail-wrapper' }, row, editForm);
        };

        for (const rail of rails) {
          railsListEl.appendChild(buildRailRow(rail));
        }

        const addBtn = el('button', { className: 'adv-rails-add-btn', type: 'button',
          onClick: () => {
            const newRail = {
              id: `rail-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
              name: 'New Test Rail',
              description: '',
              steps: [],
              addedAt: new Date().toISOString(),
              addedByFeature: null,
              lastRunAt: null,
              lastResult: null,
              critical: true,
            };
            const addForm = el('div', { className: 'adv-rail-edit-form adv-rail-add-form' });
            const nameInput = document.createElement('input');
            nameInput.type = 'text'; nameInput.className = 'adv-rail-input';
            nameInput.value = newRail.name; nameInput.placeholder = 'Rail name';

            const descTA = el('textarea', { className: 'adv-rail-textarea', rows: '2', placeholder: 'What does this rail verify?' });

            const stepsTA = el('textarea', { className: 'adv-rail-steps-textarea', rows: '10', placeholder: '[]', spellcheck: 'false' });
            stepsTA.value = '[]';

            const addCritCb = document.createElement('input');
            addCritCb.type = 'checkbox'; addCritCb.className = 'adv-rail-critical-cb';
            addCritCb.id = `adv-rail-crit-new-${Date.now()}`; addCritCb.checked = true;
            const addCritRow = el('div', { className: 'adv-rail-critical-row' },
              addCritCb,
              el('label', { htmlFor: addCritCb.id, className: 'adv-rail-critical-label' },
                '● Run every cycle (critical) — uncheck to run periodically',
              ),
            );

            const formStatus = el('span', { className: 'adv-soul-status' });

            const saveBtn = el('button', { className: 'adv-soul-save-btn', type: 'button',
              onClick: async () => {
                let steps;
                try { steps = JSON.parse(stepsTA.value); }
                catch { formStatus.textContent = 'Invalid JSON'; formStatus.className = 'adv-soul-status adv-soul-status-err'; return; }
                const newEntry = { ...newRail, name: nameInput.value.trim() || newRail.name, description: descTA.value.trim(), steps, critical: addCritCb.checked };
                saveBtn.disabled = true;
                try {
                  const newList = [...(localRails[projectId] || []), newEntry];
                  await writeProjectRails(projectId, newList);
                  setStatus('Rail added');
                  rebuildContent();
                } catch (err) {
                  formStatus.textContent = 'Error: ' + err.message;
                  formStatus.className = 'adv-soul-status adv-soul-status-err';
                  saveBtn.disabled = false;
                }
              },
            }, 'Save');

            const cancelBtn = el('button', { className: 'adv-soul-reset-btn', type: 'button',
              onClick: () => addForm.remove(),
            }, 'Cancel');

            addForm.appendChild(el('div', { className: 'adv-rail-edit-fields' },
              el('label', { className: 'adv-rail-edit-label' }, 'Name'), nameInput,
              el('label', { className: 'adv-rail-edit-label' }, 'Description'), descTA,
              addCritRow,
              el('label', { className: 'adv-rail-edit-label' }, 'Steps (JSON array of step objects)'), stepsTA,
            ));
            addForm.appendChild(el('div', { className: 'adv-rail-edit-footer' }, formStatus,
              el('div', { className: 'adv-soul-modal-footer-right' }, cancelBtn, saveBtn),
            ));
            railsListEl.appendChild(addForm);
            nameInput.focus();
          },
        }, '+ Add Rail');

        contentEl.appendChild(el('div', { className: 'adv-rails-project' },
          el('div', { className: 'adv-rails-project-header' },
            el('span', { className: 'adv-rails-project-name' }, projectId),
            addBtn,
          ),
          railsListEl,
        ));
      }
    };

    rebuildContent();

    modal.appendChild(contentEl);
    modal.appendChild(statusEl);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._testRailsModal = overlay;

    // Update button state
    const card = this._cards['qa'];
    if (card?.testRailsBtn) card.testRailsBtn.textContent = 'Test Rails ▾';
  },

  _closeTestRailsModal() {
    if (this._testRailsModal) {
      if (this._testRailsModal.parentNode) this._testRailsModal.parentNode.removeChild(this._testRailsModal);
      this._testRailsModal = null;
    }
    const card = this._cards['qa'];
    if (card?.testRailsBtn) card.testRailsBtn.textContent = 'Test Rails ▸';
  }
};
