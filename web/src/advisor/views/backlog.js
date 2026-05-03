// Backlog Deduplication + Rejection Log — DK-366.
// PM-supplied backlog list, keyword-overlap match against generated ideas,
// session-level rejection log, and confidence-config UI.

import { el } from '../ui/el.js';
import { formatRelative, formatRelativeTs, toDate } from '../ui/format.js';

export const backlogMixin = {
  // ── Backlog Deduplication (DK-366) ──────────────────────────────────────────
  // PM pastes their backlog (newline- or comma-separated ticket titles).
  // Each idea generated in a dry-run preview is checked against this list
  // using keyword overlap similarity. Duplicates are flagged inline with
  // a similarity score, stacked comparison view, and three resolution actions.
  //
  // Per-session suppression toggle: "Surface with warning" (default) vs "Suppress duplicates".
  // When suppression is active, a session-level count is shown.
  //
  // Rejection log: per-session append-only log of dismissed ideas.

  /** Stop-words for keyword extraction (shared with server-side dedup.js) */
  _backlogStopWords() {
    return new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'are', 'was', 'be', 'as', 'it',
      'its', 'this', 'that', 'add', 'fix', 'update', 'improve', 'issue',
    ]);
  },

  /** Extract meaningful keywords from a title string. */
  _extractKeywords(title) {
    const stopWords = this._backlogStopWords();
    return new Set(
      String(title).toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
    );
  },

  /**
   * Compute keyword overlap ratio between two titles (0–1).
   * 1.0 = all keywords in the smaller set appear in the larger set.
   */
  _keywordOverlap(titleA, titleB) {
    const kwA = this._extractKeywords(titleA);
    const kwB = this._extractKeywords(titleB);
    if (kwA.size === 0 || kwB.size === 0) return 0;
    let common = 0;
    for (const w of kwA) if (kwB.has(w)) common++;
    return common / Math.min(kwA.size, kwB.size);
  },

  /**
   * Find the best-matching backlog item for a given idea title.
   * Returns null if no backlog is loaded or score is below threshold.
   *
   * Default threshold: 0.55 (slightly lower than server-side 0.6 — surface
   * more for PM review; erring toward flagging rather than missing duplicates).
   *
   * @param {string} ideaTitle
   * @param {number} [threshold=0.55]
   * @returns {{ matchTitle: string, score: number } | null}
   */
  _findBacklogMatch(ideaTitle, threshold = 0.55) {
    if (!this._backlogItems || this._backlogItems.length === 0) return null;
    let bestScore = 0;
    let bestTitle = null;
    for (const item of this._backlogItems) {
      const score = this._keywordOverlap(ideaTitle, item.title);
      if (score > bestScore) {
        bestScore = score;
        bestTitle = item.title;
      }
    }
    if (bestScore >= threshold) {
      return { matchTitle: bestTitle, score: bestScore };
    }
    return null;
  },

  /**
   * Parse a paste-and-parse backlog string (newline- or comma-separated).
   * Cap at 2000 items (per spec: configurable; 2000 is the default max).
   *
   * @param {string} raw
   * @returns {Array<{ title: string }>}
   */
  _parseBacklogInput(raw) {
    // Split on newlines first; fall back to commas for single-line input
    const lines = raw.split(/\n/);
    let items;
    if (lines.length > 1) {
      items = lines;
    } else {
      items = raw.split(',');
    }
    return items
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(0, 2000)
      .map(title => ({ title }));
  },

  /**
   * Build the backlog deduplication section.
   * Shows a collapsible section with:
   *   - Paste-and-parse textarea for backlog input
   *   - Suppression mode toggle (per-session)
   *   - Rejection log (searchable, with notes)
   */
  // ── DK-188: Confidence Threshold section ─────────────────────────────────
  // Global minimum confidence threshold for advisor suggestions.
  // Named radio group: Low (3) / Medium (5) / High (7) / Strict (9).
  // Threshold is stored in /advisor/config.minConfidence in Firestore,
  // read at cycle time by the daemon (overrides docket.config.json).

  // Named confidence levels as per design spec (DK-188).
  // Slider was rejected — named levels communicate intent, not false precision.
  _confidenceLevels() {
    return [
      { label: 'Low',    value: 3, description: 'Suggest most ideas, filter only very low-confidence ones' },
      { label: 'Medium', value: 5, description: 'Balanced filter — default starting point' },
      { label: 'High',   value: 7, description: 'Only high-confidence suggestions get through' },
      { label: 'Strict', value: 9, description: 'Very selective — may produce fewer tickets per cycle' },
    ];
  },

  /**
   * Subscribe to the /advisor/config Firestore doc for live minConfidence updates.
   * Persists the value in this._minConfidence and syncs the radio group.
   */
  _subscribeConfidenceConfig() {
    if (this._confidenceUnsub) { this._confidenceUnsub(); this._confidenceUnsub = null; }

    const unsub = this.db.collection('advisor').doc('config').onSnapshot((snap) => {
      if (!this._mounted) return;
      const raw = snap.exists ? snap.data()?.minConfidence : undefined;
      this._minConfidence = (Number.isInteger(raw) && raw >= 1 && raw <= 10) ? raw : 5;
      this._syncConfidenceRadios();
    }, (err) => {
      // Non-fatal — panel still works; backend uses config file default.
      console.warn('AdvisorPanel: confidence config listener error:', err.message);
    });

    this._confidenceUnsub = unsub;
    this._unsubs.push(unsub);
  },

  /** Sync all radio buttons to the current this._minConfidence value. */
  _syncConfidenceRadios() {
    const levels = this._confidenceLevels();
    // Find the nearest named level (closest value <= minConfidence)
    let best = levels[0];
    for (const lv of levels) {
      if (lv.value <= this._minConfidence) best = lv;
    }
    for (const lv of levels) {
      const input = this._confidenceRadioEls[lv.value];
      if (input) input.checked = (lv.value === best.value);
    }
  },

  /**
   * Save a new minConfidence value to Firestore.
   * Called when the user selects a different named level.
   *
   * @param {number} value - 1–10 integer
   */
  async _saveConfidenceThreshold(value) {
    if (this._discardsSaving) return;
    this._discardsSaving = true;

    const statusEl = this._confidenceStatusEl;
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'adv-confidence-status'; }

    try {
      await this.db.collection('advisor').doc('config').set({ minConfidence: value }, { merge: true });
      if (statusEl) {
        statusEl.textContent = 'Saved — takes effect on next cycle';
        statusEl.className = 'adv-confidence-status adv-confidence-status-ok';
        setTimeout(() => {
          if (statusEl) { statusEl.textContent = ''; statusEl.className = 'adv-confidence-status'; }
        }, 3000);
      }
    } catch (err) {
      console.warn('AdvisorPanel: failed to save confidence threshold:', err);
      if (statusEl) {
        statusEl.textContent = 'Save failed';
        statusEl.className = 'adv-confidence-status adv-confidence-status-err';
      }
      // Revert radio to current stored value
      this._syncConfidenceRadios();
    } finally {
      this._discardsSaving = false;
    }
  },

  /**
   * Build the confidence threshold section.
   * Shows a radio group and a collapsed discards log.
   *
   * @returns {HTMLElement}
   */
  _buildConfidenceSection() {
    const section = el('div', { className: 'adv-confidence-section' });

    // Collapsible header
    const sectionKey = 'confidence-threshold';
    const isExpanded = !this._collapsedSections.has(sectionKey);
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');

    const header = el('button', {
      className: 'adv-backlog-section-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-confidence-body',
      onClick: () => this._toggleSectionCollapse(sectionKey, body, chevron, header),
    },
      chevron,
      el('span', { className: 'adv-section-label' }, 'Confidence Threshold'),
    );

    section.appendChild(header);

    const body = el('div', {
      id: 'adv-confidence-body',
      className: 'adv-confidence-body' + (isExpanded ? '' : ' adv-hidden'),
    });

    // Callout explaining the feature (shown on first setup)
    const callout = el('p', { className: 'adv-confidence-callout' },
      'Suggestions below this confidence score are filtered out. ',
      el('span', { className: 'adv-confidence-callout-note' },
        'Raise it over time as you calibrate.'
      )
    );
    body.appendChild(callout);

    // Radio group — named levels per design spec
    const levels = this._confidenceLevels();
    const fieldset = el('fieldset', {
      className: 'adv-confidence-fieldset',
      'aria-label': 'Minimum confidence threshold',
    });
    const legend = el('legend', { className: 'adv-confidence-legend' },
      'Minimum confidence threshold',
    );
    fieldset.appendChild(legend);

    const radioGroup = el('div', {
      className: 'adv-confidence-radio-group',
      role: 'radiogroup',
      'aria-labelledby': 'adv-confidence-legend-label',
    });

    for (const lv of levels) {
      const inputId = `adv-confidence-${lv.value}`;
      const input = el('input', {
        type: 'radio',
        id: inputId,
        name: 'adv-confidence-level',
        value: String(lv.value),
        checked: lv.value === this._minConfidence || (lv.value === 5 && this._minConfidence === 5),
        onChange: () => {
          this._minConfidence = lv.value;
          this._saveConfidenceThreshold(lv.value);
        },
      });
      this._confidenceRadioEls[lv.value] = input;

      const labelEl = el('label', {
        htmlFor: inputId,
        className: 'adv-confidence-label',
        title: lv.description,
      },
        el('span', { className: 'adv-confidence-level-name' }, lv.label),
        el('span', { className: 'adv-confidence-level-value' }, ` (${lv.value}/10)`),
      );

      radioGroup.appendChild(el('div', { className: 'adv-confidence-option' }, input, labelEl));
    }

    fieldset.appendChild(radioGroup);
    body.appendChild(fieldset);

    // Status / feedback line
    const statusEl = el('span', { className: 'adv-confidence-status' });
    this._confidenceStatusEl = statusEl;
    body.appendChild(el('div', { className: 'adv-confidence-status-row' }, statusEl));

    // Discards log — collapsed sub-section
    const discardsKey = 'confidence-discards';
    const discardsExpanded = !this._collapsedSections.has(discardsKey);
    const discardsChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, discardsExpanded ? '▾' : '▸');

    const discardsHeader = el('button', {
      className: 'adv-confidence-discards-header',
      'aria-expanded': String(discardsExpanded),
      'aria-controls': 'adv-confidence-discards-body',
      onClick: () => {
        this._toggleSectionCollapse(discardsKey, discardsBody, discardsChevron, discardsHeader);
        // Lazy-load discards when first opened
        if (!this._discardsLoaded) {
          this._discardsLoaded = true;
          this._loadDiscards();
        }
      },
    },
      discardsChevron,
      el('span', { className: 'adv-confidence-discards-label' }, 'Filtered suggestions'),
    );

    const discardsBody = el('div', {
      id: 'adv-confidence-discards-body',
      className: 'adv-confidence-discards-body' + (discardsExpanded ? '' : ' adv-hidden'),
    });

    // The actual discard list — rendered in _renderDiscardsLog
    this._discardsBody = el('div', { className: 'adv-confidence-discards-list', role: 'list', tabindex: '0', 'aria-label': 'Filtered suggestions log' });
    discardsBody.appendChild(this._discardsBody);
    this._discardsSection = discardsBody;

    // Initialise with a placeholder
    this._discardsBody.appendChild(
      el('p', { className: 'adv-confidence-discards-empty' }, 'No filtered suggestions recorded yet.')
    );

    // If discards section starts expanded, load immediately
    if (discardsExpanded) {
      this._discardsLoaded = true;
      setTimeout(() => { if (this._mounted) this._loadDiscards(); }, 500);
    }

    body.appendChild(
      el('div', { className: 'adv-confidence-discards-section' },
        discardsHeader,
        discardsBody,
      )
    );

    section.appendChild(body);
    return section;
  },

  /**
   * Load the most recent discards from Firestore and render them.
   * Reads /advisor/discards/items ordered by timestamp desc, limit 20.
   */
  async _loadDiscards() {
    if (!this._discardsBody) return;

    try {
      const snap = await this.db
        .collection('advisor')
        .doc('discards')
        .collection('items')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      if (!this._mounted || !this._discardsBody) return;

      if (snap.empty) {
        this._discardsBody.innerHTML = '';
        this._discardsBody.appendChild(
          el('p', { className: 'adv-confidence-discards-empty' }, 'No filtered suggestions recorded yet.')
        );
        return;
      }

      this._discardsBody.innerHTML = '';
      for (const doc of snap.docs) {
        const d = doc.data();
        const ts = d.timestamp?.toDate?.() ?? null;
        const tsText = ts ? formatRelativeTs(ts) : '';
        const row = el('div', {
          className: 'adv-confidence-discard-row',
          role: 'listitem',
          tabindex: '0',
        },
          el('div', { className: 'adv-confidence-discard-meta' },
            el('span', { className: 'adv-confidence-discard-persona' }, d.persona || '?'),
            el('span', { className: 'adv-confidence-discard-score', 'aria-label': `Confidence score: ${d.score} of 10` },
              `Confidence: ${d.score}/10`
            ),
            el('span', { className: 'adv-confidence-discard-threshold', 'aria-label': `Threshold was: ${d.threshold}` },
              `(threshold: ${d.threshold})`
            ),
            tsText ? el('span', { className: 'adv-confidence-discard-ts' }, tsText) : null,
          ),
          el('div', { className: 'adv-confidence-discard-title' }, d.ticketDraft?.title || '(no title)'),
          d.ticketDraft?.summary ? el('div', { className: 'adv-confidence-discard-summary' }, d.ticketDraft.summary.slice(0, 120) + (d.ticketDraft.summary.length > 120 ? '…' : '')) : null,
        );
        this._discardsBody.appendChild(row);
      }
    } catch (err) {
      if (!this._mounted || !this._discardsBody) return;
      console.warn('AdvisorPanel: failed to load discards:', err.message);
      this._discardsBody.innerHTML = '';
      this._discardsBody.appendChild(
        el('p', { className: 'adv-confidence-discards-empty' }, 'Could not load filtered suggestions.')
      );
    }
  },

  _buildBacklogSection() {
    const section = el('div', { className: 'adv-backlog-section' });

    // Collapsible header
    const sectionKey = 'backlog-dedup';
    const isExpanded = !this._collapsedSections.has(sectionKey);
    const chevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, isExpanded ? '▾' : '▸');

    const header = el('button', {
      className: 'adv-backlog-section-header',
      'aria-expanded': String(isExpanded),
      'aria-controls': 'adv-backlog-body',
      onClick: () => {
        const nowExpanded = this._collapsedSections.has(sectionKey);
        if (nowExpanded) {
          this._collapsedSections.delete(sectionKey);
          body.classList.remove('adv-hidden');
          chevron.textContent = '▾';
          header.setAttribute('aria-expanded', 'true');
        } else {
          this._collapsedSections.add(sectionKey);
          body.classList.add('adv-hidden');
          chevron.textContent = '▸';
          header.setAttribute('aria-expanded', 'false');
        }
        this._saveSectionCollapseState();
      },
    },
      chevron,
      el('span', {}, 'Backlog Check'),
      el('span', { className: 'adv-backlog-section-badge', 'aria-hidden': 'true' }, '⧉'),
    );
    section.appendChild(header);

    const body = el('div', {
      className: 'adv-backlog-body',
      id: 'adv-backlog-body',
    });
    if (!isExpanded) body.classList.add('adv-hidden');

    // ── Backlog input ─────────────────────────────────────────
    const inputLabel = el('label', {
      className: 'adv-backlog-input-label',
      htmlFor: 'adv-backlog-textarea',
    }, 'Your backlog (paste titles — one per line or comma-separated):');

    const itemCountEl = el('span', { className: 'adv-backlog-item-count', 'aria-live': 'polite' }, '');
    this._backlogItemCount = itemCountEl;

    const textarea = el('textarea', {
      className: 'adv-backlog-textarea',
      id: 'adv-backlog-textarea',
      rows: '5',
      placeholder: 'Paste ticket titles here — one per line or comma-separated.\nExample:\n  Fix login page redirect\n  Add dark mode toggle\n  Improve onboarding flow',
      'aria-label': 'Backlog titles for deduplication check',
      'aria-describedby': 'adv-backlog-hint',
    });
    this._backlogTextarea = textarea;

    const hint = el('div', {
      className: 'adv-backlog-hint',
      id: 'adv-backlog-hint',
    }, 'Ideas generated in Preview Run will be checked against these titles. No data is sent externally — all matching runs in your browser.');

    const parseBtn = el('button', {
      className: 'adv-backlog-parse-btn',
      onClick: () => this._parseAndLoadBacklog(textarea.value, itemCountEl),
    }, 'Load backlog');

    const clearBtn = el('button', {
      className: 'adv-backlog-clear-btn',
      onClick: () => {
        this._backlogItems = [];
        textarea.value = '';
        itemCountEl.textContent = '';
        this._announceToSR('Backlog cleared.');
      },
    }, 'Clear');

    const inputRow = el('div', { className: 'adv-backlog-input-row' },
      parseBtn,
      clearBtn,
      itemCountEl,
    );

    body.appendChild(inputLabel);
    body.appendChild(textarea);
    body.appendChild(hint);
    body.appendChild(inputRow);

    // ── Suppression mode toggle ───────────────────────────────
    // Per-session: "Surface with warning" (default) vs "Suppress duplicates"
    const suppressSection = el('div', { className: 'adv-backlog-suppress-section' });

    const suppressToggleId = 'adv-backlog-suppress-toggle';
    const suppressLabel = el('label', {
      className: 'adv-backlog-suppress-label',
      htmlFor: suppressToggleId,
    });

    const suppressCheckbox = el('input', {
      type: 'checkbox',
      id: suppressToggleId,
      className: 'adv-backlog-suppress-checkbox',
      'aria-describedby': 'adv-backlog-suppress-desc',
      onChange: () => {
        this._suppressDuplicates = suppressCheckbox.checked;
        suppressModeText.textContent = this._suppressDuplicates
          ? 'Suppress duplicates'
          : 'Surface with warning';
        this._updateSuppressedCountEl();
        this._announceToSR(this._suppressDuplicates
          ? 'Suppression mode on — duplicate ideas will be hidden from preview results.'
          : 'Suppression mode off — duplicate ideas will be shown with a warning flag.');
      },
    });

    const suppressModeText = el('span', { className: 'adv-backlog-suppress-mode-text' }, 'Surface with warning');

    suppressLabel.appendChild(suppressCheckbox);
    suppressLabel.appendChild(suppressModeText);

    const suppressDesc = el('div', {
      className: 'adv-backlog-suppress-desc',
      id: 'adv-backlog-suppress-desc',
    }, 'When on, ideas matching your backlog are hidden entirely from preview results.');

    this._suppressCountEl = el('div', {
      className: 'adv-backlog-suppressed-count adv-hidden',
      role: 'status',
      'aria-live': 'polite',
    }, '');

    suppressSection.appendChild(suppressLabel);
    suppressSection.appendChild(suppressDesc);
    suppressSection.appendChild(this._suppressCountEl);
    body.appendChild(suppressSection);

    // ── Rejection log ─────────────────────────────────────────
    const rejLogSection = el('div', { className: 'adv-backlog-rejlog-section' });
    this._rejectionLogSection = rejLogSection;

    const rejLogHeaderKey = 'rejection-log';
    const rejLogExpanded = this._collapsedCardSections.has(rejLogHeaderKey);
    const rejLogChevron = el('span', { className: 'adv-card-subsection-chevron', 'aria-hidden': 'true' }, rejLogExpanded ? '▾' : '▸');
    const rejLogHeader = el('button', {
      className: 'adv-backlog-rejlog-header',
      'aria-expanded': String(rejLogExpanded),
      'aria-controls': 'adv-backlog-rejlog-body',
      onClick: () => this._toggleCardSection(rejLogHeaderKey, rejLogBody, rejLogChevron, rejLogHeader),
    },
      rejLogChevron,
      el('span', {}, 'Rejection Log'),
    );

    const rejLogBody = el('div', {
      className: 'adv-backlog-rejlog-body',
      id: 'adv-backlog-rejlog-body',
      role: 'region',
      'aria-label': 'Rejection log — ideas you chose to reject',
    });
    if (!rejLogExpanded) rejLogBody.classList.add('adv-hidden');
    this._rejectionLogBody = rejLogBody;

    const rejLogSearch = el('input', {
      type: 'search',
      className: 'adv-backlog-rejlog-search',
      placeholder: 'Search rejection log…',
      'aria-label': 'Search rejection log',
      onInput: () => {
        this._rejectionLogSearch = rejLogSearch.value;
        this._renderRejectionLog();
      },
    });

    const rejLogList = el('div', {
      className: 'adv-backlog-rejlog-list',
      role: 'list',
      'aria-label': 'Rejected ideas',
    });
    this._rejectionLogList = rejLogList;

    rejLogBody.appendChild(rejLogSearch);
    rejLogBody.appendChild(rejLogList);

    rejLogSection.appendChild(rejLogHeader);
    rejLogSection.appendChild(rejLogBody);
    body.appendChild(rejLogSection);

    this._backlogSection = section;
    section.appendChild(body);

    // Render rejection log on build
    this._renderRejectionLog();

    return section;
  },

  /**
   * Parse the raw textarea input and load into _backlogItems.
   * Validates input size before processing. Announces count via ARIA.
   *
   * @param {string} raw - Raw text from the textarea
   * @param {HTMLElement} countEl - Element to update with item count
   */
  _parseAndLoadBacklog(raw, countEl) {
    if (!raw || !raw.trim()) {
      countEl.textContent = 'No input — paste some ticket titles first.';
      return;
    }

    // Validate input size (cap at ~200KB of raw text to avoid browser hangs)
    if (raw.length > 200_000) {
      countEl.textContent = 'Input too large — paste up to 2,000 titles at a time.';
      return;
    }

    const items = this._parseBacklogInput(raw);
    if (items.length === 0) {
      countEl.textContent = 'No titles found — check your input format.';
      return;
    }

    this._backlogItems = items;
    const msg = `${items.length.toLocaleString()} item${items.length !== 1 ? 's' : ''} loaded`;
    countEl.textContent = msg;
    this._announceToSR(`Backlog loaded: ${msg}. Ideas in Preview Run will be checked against these titles.`);
  },

  /**
   * Update the suppressed count display element.
   * Shows/hides based on whether suppression is active and count > 0.
   */
  _updateSuppressedCountEl() {
    if (!this._suppressCountEl) return;
    if (this._suppressDuplicates && this._suppressedCount > 0) {
      this._suppressCountEl.textContent =
        `${this._suppressedCount} idea${this._suppressedCount !== 1 ? 's' : ''} suppressed as likely duplicates — turn off suppression to view them.`;
      this._suppressCountEl.classList.remove('adv-hidden');
    } else {
      this._suppressCountEl.classList.add('adv-hidden');
    }
  },

  /**
   * Check a proposal against the PM's backlog and return match info.
   * Used in _buildProposalCard to show inline dedup flags.
   *
   * @param {string} ideaTitle
   * @returns {{ isMatch: boolean, matchTitle?: string, score?: number, scoreLabel?: string } }
   */
  _checkBacklogMatch(ideaTitle) {
    const match = this._findBacklogMatch(ideaTitle);
    if (!match) return { isMatch: false };
    const pct = Math.round(match.score * 100);
    return {
      isMatch: true,
      matchTitle: match.matchTitle,
      score: match.score,
      scoreLabel: `~${pct}% similarity`,
    };
  },

  // ── Rejection log helpers ─────────────────────────────────────────────────

  /**
   * Load per-session rejection log from sessionStorage.
   * Entries: { id, ideaTitle, matchedTitle, note, dismissedAt, action }
   * action: 'already_captured' | 'keep_different' | 'reject_entirely'
   */
  _loadRejectionLog() {
    try {
      const raw = sessionStorage.getItem('adv-rejection-log');
      if (raw) return JSON.parse(raw);
    } catch (_) {/* ignore */}
    return [];
  },

  /** Persist rejection log to sessionStorage. */
  _saveRejectionLog() {
    try {
      sessionStorage.setItem('adv-rejection-log', JSON.stringify(this._rejectionLog));
    } catch (_) {/* ignore */}
  },

  /**
   * Add an entry to the rejection log and re-render.
   *
   * @param {{ ideaTitle: string, matchedTitle: string|null, note: string, action: string }} entry
   */
  _addToRejectionLog(entry) {
    const id = `rej-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this._rejectionLog.unshift({
      id,
      ideaTitle: String(entry.ideaTitle || '').slice(0, 200),
      matchedTitle: entry.matchedTitle ? String(entry.matchedTitle).slice(0, 200) : null,
      note: String(entry.note || '').slice(0, 500),
      action: entry.action || 'reject_entirely',
      dismissedAt: new Date().toISOString(),
    });
    // Cap log at 500 entries per session (not a database; just in-memory with sessionStorage backup)
    if (this._rejectionLog.length > 500) this._rejectionLog.pop();
    this._saveRejectionLog();
    this._renderRejectionLog();
  },

  /**
   * Render (or re-render) the rejection log list with current search filter.
   * Called whenever the log changes or search input changes.
   */
  _renderRejectionLog() {
    if (!this._rejectionLogList) return;
    this._rejectionLogList.innerHTML = '';

    const query = (this._rejectionLogSearch || '').toLowerCase().trim();
    const filtered = this._rejectionLog.filter(entry => {
      if (!query) return true;
      return (
        entry.ideaTitle.toLowerCase().includes(query) ||
        (entry.matchedTitle || '').toLowerCase().includes(query) ||
        (entry.note || '').toLowerCase().includes(query)
      );
    });

    if (filtered.length === 0) {
      const emptyMsg = this._rejectionLog.length === 0
        ? 'No rejected ideas yet. Use "Reject entirely" on flagged proposals to log them here.'
        : 'No results match your search.';
      this._rejectionLogList.appendChild(
        el('div', { className: 'adv-backlog-rejlog-empty' }, emptyMsg)
      );
      return;
    }

    for (const entry of filtered) {
      const actionLabels = {
        already_captured: 'Already captured',
        keep_different: 'Keep — different angle',
        reject_entirely: 'Rejected',
      };
      const actionLabel = actionLabels[entry.action] || entry.action;
      const relTime = entry.dismissedAt
        ? formatRelative(entry.dismissedAt)
        : null;

      const item = el('div', {
        className: 'adv-backlog-rejlog-item',
        role: 'listitem',
      });

      const titleEl = el('div', { className: 'adv-backlog-rejlog-item-title' });
      titleEl.textContent = entry.ideaTitle;

      const metaRow = el('div', { className: 'adv-backlog-rejlog-item-meta' });
      const actionBadge = el('span', { className: `adv-backlog-rejlog-action adv-backlog-rejlog-action-${entry.action}` });
      actionBadge.textContent = actionLabel;
      metaRow.appendChild(actionBadge);
      if (relTime) {
        metaRow.appendChild(el('span', { className: 'adv-backlog-rejlog-time' }, relTime));
      }
      if (entry.matchedTitle) {
        const matchEl = el('span', { className: 'adv-backlog-rejlog-match' });
        matchEl.textContent = `Matched: ${entry.matchedTitle}`;
        metaRow.appendChild(matchEl);
      }

      item.appendChild(titleEl);
      item.appendChild(metaRow);

      if (entry.note) {
        const noteEl = el('div', { className: 'adv-backlog-rejlog-note' });
        noteEl.textContent = `"${entry.note}"`;
        item.appendChild(noteEl);
      }

      this._rejectionLogList.appendChild(item);
    }
  }
};
