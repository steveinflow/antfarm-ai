// Convergence — bilateral write of cross-persona overlap data.
//
// When a new advisor ticket is written and keyword/filepath overlap is detected
// against an existing ticket from another persona, this module records the
// relationship on both documents in a single Firestore transaction:
//   - new ticket gets a convergence array entry pointing at the existing ticket
//   - existing ticket gets a convergence array entry pointing at the new ticket
//   - both get convergenceCount incremented
//
// Schema per convergence entry:
//   { ticketId: string, personaId: string, summary: string }
//
// ticketId here is the Firestore *document* ID (not the human-readable DK-NNN).
// The UI resolves display names from the ticket list it already holds in memory.

/**
 * Write bilateral convergence data to Firestore for a new ticket and each of its
 * cross-persona matches.
 *
 * @param {object} db - Firestore admin instance (with runTransaction / collection)
 * @param {string} projectId - Firestore project document ID
 * @param {string} newDocId - Firestore document ID of the newly created ticket
 * @param {string} newTicketId - Human-readable ticket ID (e.g. 'DK-200') of the new ticket
 * @param {string} newPersona - Persona of the new ticket ('engineer'|'design'|'product')
 * @param {string} newSummary - One-line summary for the new ticket's entry in sibling's array
 * @param {Array<{ matchId: string, matchTitle: string, matchPersona: string, matchedKeywords: string }>} matches
 *   - matchId: Firestore document ID of the existing ticket
 *   - matchTitle: title of the existing ticket (used to build summary shown on new ticket)
 *   - matchPersona: persona of the existing ticket
 *   - matchedKeywords: comma-joined overlapping keywords (for logging)
 * @param {function} log - logging function
 * @returns {Promise<void>}
 */
export async function writeConvergence(db, projectId, newDocId, newTicketId, newPersona, newSummary, matches, log) {
  if (!matches || matches.length === 0) return;
  if (!db) return;

  const ticketsRef = db.collection('projects').doc(projectId).collection('tickets');

  for (const match of matches) {
    try {
      await db.runTransaction(async (tx) => {
        // Read both documents inside the transaction
        const newRef = ticketsRef.doc(newDocId);
        const existingRef = ticketsRef.doc(match.matchId);

        const [newSnap, existingSnap] = await Promise.all([
          tx.get(newRef),
          tx.get(existingRef),
        ]);

        if (!newSnap.exists || !existingSnap.exists) {
          // One of the tickets was deleted between creation and this transaction — skip
          return;
        }

        const newData = newSnap.data();
        const existingData = existingSnap.data();

        // Build entry that goes onto the new ticket (pointing at the existing one)
        const entryOnNew = {
          ticketId: match.matchId,
          personaId: match.matchPersona,
          summary: `${_personaLabel(match.matchPersona)}: ${_trimTitle(match.matchTitle)}`,
        };

        // Build entry that goes onto the existing ticket (pointing at the new one)
        const entryOnExisting = {
          ticketId: newDocId,
          personaId: newPersona,
          summary: `${_personaLabel(newPersona)}: ${newSummary}`,
        };

        // Current convergence arrays (may not exist yet)
        const newConvergence = Array.isArray(newData.convergence) ? newData.convergence : [];
        const existingConvergence = Array.isArray(existingData.convergence) ? existingData.convergence : [];

        // Deduplicate: don't add the same matchId twice (idempotent re-runs)
        const alreadyOnNew = newConvergence.some(e => e.ticketId === match.matchId);
        const alreadyOnExisting = existingConvergence.some(e => e.ticketId === newDocId);

        if (alreadyOnNew && alreadyOnExisting) return; // already recorded

        if (!alreadyOnNew) {
          newConvergence.push(entryOnNew);
        }
        if (!alreadyOnExisting) {
          existingConvergence.push(entryOnExisting);
        }

        // Write both updates inside the transaction
        tx.update(newRef, {
          convergence: newConvergence,
          convergenceCount: newConvergence.length,
        });
        tx.update(existingRef, {
          convergence: existingConvergence,
          convergenceCount: existingConvergence.length,
        });
      });

      log(`Convergence recorded: ${newTicketId} ↔ ${match.matchId} (${match.matchPersona}, keywords: ${match.matchedKeywords})`);
    } catch (err) {
      // Non-fatal — convergence writes must not block ticket creation
      log(`Convergence write failed for ${newTicketId} ↔ ${match.matchId}: ${err.message}`);
    }
  }
}

/**
 * @param {string} persona
 * @returns {string} Display label for the persona
 */
function _personaLabel(persona) {
  const labels = { engineer: 'Engineer', design: 'Design', product: 'Product' };
  return labels[persona] || persona;
}

/**
 * Trim a ticket title to a concise one-line summary (remove persona prefix, cap length).
 * @param {string} title
 * @returns {string}
 */
function _trimTitle(title) {
  // Remove persona prefix like "[Engineer] " or "[Design] "
  const clean = title.replace(/^\[(Engineer|Design|Product|QA)\]\s*/i, '');
  // Cap at 80 characters
  return clean.length > 80 ? clean.slice(0, 77) + '…' : clean;
}
