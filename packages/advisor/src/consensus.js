// Cross-persona consensus gate — shared utility.
//
// When consensusGate is enabled, tickets proposed by one persona must be
// evaluated by other enabled personas before transitioning from 'proposed'
// to 'open'. Coordination is done via Firestore — each persona evaluates
// pending proposed tickets at the start or end of its own timer cycle.
//
// Firestore ticket shape when consensusGate is enabled:
//   ticket.consensus = {
//     proposedBy:   'engineer' | 'design' | 'product',
//     required:     number   — threshold from consensusGate.threshold
//     endorsements: Array<{ persona, approved, reason }>
//   }
//
// Status transitions managed here:
//   proposed → open      (endorsements.filter(e=>e.approved).length >= required)
//   proposed → rejected  (remaining unevaluated personas cannot reach threshold)
//
// Design constraints:
//   - Each endorsement reason is hard-truncated to 200 chars before storage.
//   - No chain-of-thought is stored — only a boolean + one-line reason.
//   - checkAndPromote is thin and synchronous in logic; only Firestore writes are async.
//   - The endorsement query step in each persona caps at maxProposedTickets (default 5)
//     per cycle to bound API spend.

import { ask } from './claude.js';

// Hard cap on reason string length — enforced server-side regardless of model output.
const REASON_MAX_CHARS = 200;

// Default cap on proposed tickets evaluated per persona per cycle.
const DEFAULT_MAX_PROPOSED = 5;

// All standard built-in persona names. Used to compute the set of "other" personas.
export const STANDARD_PERSONAS = ['engineer', 'design', 'product'];

/**
 * Truncate a reason string to REASON_MAX_CHARS. Always applied before writing to Firestore.
 * @param {string} reason
 * @returns {string}
 */
function truncateReason(reason) {
  if (typeof reason !== 'string') return '';
  return reason.slice(0, REASON_MAX_CHARS).trim();
}

/**
 * Strip HTML tags and collapse whitespace from a string.
 * Used to sanitize LLM reason output before storage.
 * @param {string} str
 * @returns {string}
 */
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validate a consensusGate config object.
 *
 * Rules:
 *   - threshold must be an integer >= 2
 *   - threshold must not exceed the number of enabled personas
 *   - if either rule fails, returns { valid: false, warning: string }
 *
 * @param {object} gateConfig  - consensusGate config: { enabled, threshold, maxProposedTickets }
 * @param {string[]} enabledPersonas - persona IDs that are currently enabled
 * @returns {{ valid: boolean, warning?: string }}
 */
export function validateConsensusGate(gateConfig, enabledPersonas) {
  if (!gateConfig || !gateConfig.enabled) return { valid: false };

  const threshold = Number(gateConfig.threshold);
  if (!Number.isInteger(threshold) || threshold < 2) {
    return {
      valid: false,
      warning: `consensusGate.threshold must be an integer >= 2 (got ${gateConfig.threshold}) — disabling consensus gate`,
    };
  }

  const count = Array.isArray(enabledPersonas) ? enabledPersonas.length : 0;
  if (threshold > count) {
    return {
      valid: false,
      warning: `consensusGate.threshold (${threshold}) exceeds number of enabled personas (${count}) — disabling consensus gate`,
    };
  }

  return { valid: true };
}

/**
 * Build the initial consensus object to embed in a newly proposed ticket.
 *
 * @param {object} opts
 * @param {string} opts.proposedBy   - persona name that created this ticket
 * @param {number} opts.threshold    - required number of approvals
 * @returns {{ proposedBy: string, required: number, endorsements: [] }}
 */
export function buildInitialConsensus(proposedBy, threshold) {
  return {
    proposedBy,
    required: threshold,
    endorsements: [],
  };
}

/**
 * Evaluate a proposed ticket and return an endorsement entry.
 *
 * Sends a short query to Claude asking whether the ticket is worth pursuing.
 * Returns { persona, approved, reason } — reason is hard-truncated to 200 chars.
 *
 * @param {object} opts
 * @param {string} opts.personaName - name of the evaluating persona
 * @param {string} opts.ticketTitle - ticket title
 * @param {string} opts.ticketDescription - ticket description
 * @param {string} opts.model - Claude model to use
 * @returns {Promise<{ persona: string, approved: boolean, reason: string }>}
 */
export async function evaluateTicket({ personaName, ticketTitle, ticketDescription, model }) {
  const system = `You are a ${personaName} reviewing a proposed ticket for a software project. Be concise and direct.`;

  const prompt = `Review this proposed ticket and decide if it is worth pursuing:

**Title:** ${ticketTitle}

**Description:**
${ticketDescription.slice(0, 1000)}

Answer with:
1. A verdict: "yes" if this ticket is worth pursuing, "no" if it is not.
2. A one-line reason (max 200 characters) explaining your verdict.

Format your response exactly as:
VERDICT: yes|no
REASON: <one line reason>`;

  let raw = '';
  try {
    raw = await ask(system, prompt, { model, maxTokens: 256 });
  } catch {
    // On error, default to approved with a note — never block on API failure
    return { persona: personaName, approved: true, reason: 'Evaluation failed — defaulting to approved' };
  }

  // Parse verdict and reason from structured response
  const verdictMatch = raw.match(/VERDICT:\s*(yes|no)/i);
  const reasonMatch = raw.match(/REASON:\s*(.+)/i);

  const approved = verdictMatch ? verdictMatch[1].toLowerCase() === 'yes' : true;
  const rawReason = reasonMatch ? reasonMatch[1].trim() : raw.split('\n')[0].trim();
  const reason = truncateReason(stripHtml(rawReason));

  return { persona: personaName, approved, reason };
}

/**
 * After writing an endorsement, check if the ticket should be promoted or rejected.
 * This is the shared promotion function referenced by the ticket spec.
 *
 * Transitions:
 *   - approved endorsements >= required → transition to 'open'
 *   - remaining unevaluated + existing approvals < required → transition to 'rejected'
 *   - otherwise → leave as 'proposed'
 *
 * @param {object} opts
 * @param {object} opts.ticket       - Firestore ticket document data (must have consensus field)
 * @param {string} opts.ticketId     - Firestore document ID
 * @param {object} opts.ticketRef    - Firestore DocumentReference for this ticket
 * @param {string[]} opts.allPersonas - all enabled persona names (to compute remaining evaluators)
 * @param {Function} opts.log        - logging callback (msg: string) => void
 * @returns {Promise<'open'|'rejected'|'proposed'>} the new status
 */
export async function checkAndPromote({ ticket, ticketId, ticketRef, allPersonas, log }) {
  const consensus = ticket.consensus;
  if (!consensus) {
    log(`[consensus] ${ticketId}: no consensus field — skipping promotion check`);
    return 'proposed';
  }

  const { required, endorsements = [], proposedBy } = consensus;
  const approvals = endorsements.filter(e => e.approved).length;
  const rejections = endorsements.filter(e => !e.approved).length;

  // Compute remaining unevaluated personas (excluding the proposer and those who already evaluated)
  const evaluatedPersonas = new Set(endorsements.map(e => e.persona));
  const remainingEvaluators = allPersonas.filter(
    p => p !== proposedBy && !evaluatedPersonas.has(p)
  );
  const remainingCount = remainingEvaluators.length;

  // Check if threshold can still be reached
  const maxPossibleApprovals = approvals + remainingCount;

  if (approvals >= required) {
    // Threshold met — promote to open
    const now = new Date().toISOString();
    const history = ticket.statusHistory || [];
    history.push({
      from: 'proposed',
      to: 'open',
      at: now,
      note: `Consensus gate passed: ${approvals}/${required} approvals`,
    });
    await ticketRef.update({
      status: 'open',
      statusHistory: history,
      updatedAt: now,
    });
    log(`[consensus] ${ticketId}: promoted to open (${approvals}/${required} approvals)`);
    return 'open';
  }

  if (maxPossibleApprovals < required) {
    // Mathematically impossible to reach threshold — reject
    const now = new Date().toISOString();
    const history = ticket.statusHistory || [];
    history.push({
      from: 'proposed',
      to: 'rejected',
      at: now,
      note: `Consensus gate failed: ${rejections} rejection(s), cannot reach ${required} approvals`,
    });
    await ticketRef.update({
      status: 'rejected',
      statusHistory: history,
      updatedAt: now,
    });
    log(`[consensus] ${ticketId}: rejected (${rejections} rejection(s), only ${maxPossibleApprovals} approvals possible of ${required} required)`);
    return 'rejected';
  }

  // Still pending — leave as proposed
  log(`[consensus] ${ticketId}: pending (${approvals}/${required} approvals, ${remainingCount} evaluator(s) remaining)`);
  return 'proposed';
}

/**
 * Run the endorsement step for a persona: query Firestore for proposed tickets
 * not yet evaluated by this persona, evaluate each, append the endorsement,
 * then call checkAndPromote.
 *
 * This is called at the start of each persona's timer cycle (before generating
 * new tickets). Capped at maxProposedTickets per cycle to bound API spend.
 *
 * @param {object} opts
 * @param {string} opts.personaName     - name of the current persona (evaluator)
 * @param {object} opts.db              - Firestore Admin instance
 * @param {string} opts.projectId       - current Firestore project ID
 * @param {string} opts.model           - Claude model to use for evaluation
 * @param {string[]} opts.allPersonas   - all enabled persona names
 * @param {number} [opts.maxProposedTickets] - cap per cycle (default 5)
 * @param {Function} [opts.log]         - logging callback (msg) => void
 * @returns {Promise<{ evaluated: number, promoted: number, rejected: number }>}
 */
export async function runEndorsementStep({
  personaName,
  db,
  projectId,
  model,
  allPersonas,
  maxProposedTickets = DEFAULT_MAX_PROPOSED,
  log: logFn,
}) {
  const log = logFn || (() => {});

  // Query proposed tickets not yet evaluated by this persona.
  // Firestore doesn't support "array-not-contains" so we fetch all proposed
  // tickets with a consensus field and filter client-side (capped at 50 to
  // avoid unbounded reads; we only process up to maxProposedTickets anyway).
  let snap;
  try {
    snap = await db
      .collection('projects')
      .doc(projectId)
      .collection('tickets')
      .where('status', '==', 'proposed')
      .where('consensus', '!=', null)
      .limit(50)
      .get();
  } catch {
    // Some Firestore versions may not support '!=' on nested fields — fall back
    // to a status-only query and filter manually
    try {
      snap = await db
        .collection('projects')
        .doc(projectId)
        .collection('tickets')
        .where('status', '==', 'proposed')
        .limit(50)
        .get();
    } catch (err2) {
      log(`[consensus] endorsement query failed for ${projectId}: ${err2.message}`);
      return { evaluated: 0, promoted: 0, rejected: 0 };
    }
  }

  if (snap.empty) {
    return { evaluated: 0, promoted: 0, rejected: 0 };
  }

  // Filter: must have a consensus field, must not have been evaluated by this persona,
  // and must not have been proposed by this persona.
  const candidates = snap.docs
    .map(doc => ({ id: doc.id, ref: doc.ref, data: doc.data() }))
    .filter(({ data }) => {
      const c = data.consensus;
      if (!c) return false;
      if (c.proposedBy === personaName) return false; // proposer doesn't evaluate own ticket
      const alreadyEvaluated = (c.endorsements || []).some(e => e.persona === personaName);
      if (alreadyEvaluated) return false;
      return true;
    })
    .slice(0, maxProposedTickets);

  if (candidates.length === 0) {
    return { evaluated: 0, promoted: 0, rejected: 0 };
  }

  log(`[consensus] ${personaName}: evaluating ${candidates.length} proposed ticket(s) in ${projectId}`);

  let evaluated = 0;
  let promoted = 0;
  let rejected = 0;

  for (const { id, ref, data } of candidates) {
    try {
      // Evaluate the ticket
      const endorsement = await evaluateTicket({
        personaName,
        ticketTitle: data.title || '(no title)',
        ticketDescription: data.description || '(no description)',
        model,
      });

      // Append endorsement to the consensus.endorsements array
      const currentEndorsements = data.consensus?.endorsements || [];
      const updatedEndorsements = [...currentEndorsements, endorsement];

      await ref.update({
        'consensus.endorsements': updatedEndorsements,
        updatedAt: new Date().toISOString(),
      });

      log(`[consensus] ${personaName}: ${id} — ${endorsement.approved ? 'approved' : 'rejected'}: ${endorsement.reason}`);
      evaluated++;

      // Re-fetch the updated ticket data for promotion check
      const updatedSnap = await ref.get();
      const updatedData = updatedSnap.data();

      // Check and promote
      const newStatus = await checkAndPromote({
        ticket: updatedData,
        ticketId: id,
        ticketRef: ref,
        allPersonas,
        log,
      });

      if (newStatus === 'open') promoted++;
      else if (newStatus === 'rejected') rejected++;

    } catch (err) {
      log(`[consensus] ${personaName}: error evaluating ticket ${id}: ${err.message}`);
    }
  }

  log(`[consensus] ${personaName}: done — evaluated ${evaluated}, promoted ${promoted}, rejected ${rejected}`);
  return { evaluated, promoted, rejected };
}
