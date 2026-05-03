// @docket/advisor — focus directive reader (DK-319).
// Extracted from start-advisor.js for navigability.

import { sanitizeDirective } from './validators.js';

/**
 * Read the focus directive for a specific persona + project from Firestore.
 * Stored at: advisor/{personaId}/projects/{projectId} → { directive, directiveUpdatedAt }
 * Returns null if not set or empty.
 *
 * @param {object} db - Firestore Admin instance
 * @param {string} personaId - 'engineer' | 'design' | 'product' | 'qa'
 * @param {string} projectId - Firestore project doc ID
 * @returns {Promise<string|null>}
 */
export async function readDirective(db, personaId, projectId) {
  try {
    const snap = await db
      .collection('advisor')
      .doc(personaId)
      .collection('projects')
      .doc(projectId)
      .get();
    if (!snap.exists) return null;
    const val = snap.data()?.directive;
    return sanitizeDirective(val);
  } catch {
    return null;
  }
}
