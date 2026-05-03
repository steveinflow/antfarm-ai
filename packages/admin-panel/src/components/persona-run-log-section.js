// @docket/admin-panel — PersonaRunLogSection: container that renders one PersonaRunLog per advisor persona

import { el } from '../el.js';
import { PersonaRunLog } from './persona-run-log.js';

/**
 * PersonaRunLogSection — renders run log panels for all known advisor personas.
 * Queries /advisor documents on mount to discover active personas, then creates
 * one PersonaRunLog panel per persona found.
 *
 * Closed by default. No real-time subscriptions — fetch on expand.
 */
export class PersonaRunLogSection {
  /**
   * @param {object} opts
   * @param {object} opts.db - Firestore web SDK instance
   * @param {number} [opts.limit=20] - Max runs to fetch per persona
   */
  constructor({ db, limit = 20 }) {
    this.db = db;
    this.limit = limit;
    this._el = null;
    this._panelsContainer = null;
    this._loaded = false;

    // Built-in persona display names
    this._BUILTIN_LABELS = {
      engineer: 'Engineer',
      design: 'Design',
      product: 'Product',
    };
  }

  render() {
    this._panelsContainer = el('div', { className: 'tk-run-log-section-panels' });

    this._el = el('div', { className: 'tk-run-log-section' },
      el('div', { className: 'tk-run-log-section-header' }, 'Advisor Run History'),
      this._panelsContainer,
    );

    // Load personas lazily on first render
    this._loadPersonas();

    return this._el;
  }

  async _loadPersonas() {
    if (this._loaded) return;
    this._loaded = true;

    let personaIds = [];
    try {
      const snap = await this.db.collection('advisor').get();
      personaIds = snap.docs.map(d => d.id);
    } catch (_err) {
      // If /advisor is not accessible or empty, fall back to built-ins
      personaIds = Object.keys(this._BUILTIN_LABELS);
    }

    if (personaIds.length === 0) {
      personaIds = Object.keys(this._BUILTIN_LABELS);
    }

    this._panelsContainer.innerHTML = '';

    for (const personaId of personaIds) {
      const label = this._BUILTIN_LABELS[personaId]
        || personaId.charAt(0).toUpperCase() + personaId.slice(1).replace(/[-_]/g, ' ');
      const runLog = new PersonaRunLog({
        db: this.db,
        personaId,
        personaLabel: label,
        limit: this.limit,
      });
      this._panelsContainer.appendChild(runLog.render());
    }
  }
}
