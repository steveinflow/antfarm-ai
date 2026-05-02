// Cluster service — CRUD for theme clusters per project.
// Clusters are server-side only: clients may read but never write.
// Cluster assignment and creation happen in the advisor at proposal-write time.

/**
 * Sanitize a cluster label before storing.
 * Strips HTML, limits to alphanumeric + spaces + hyphens, max 30 chars.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeClusterLabel(raw) {
  if (!raw || typeof raw !== 'string') return 'Uncategorized';
  // Strip HTML tags
  const stripped = raw.replace(/<[^>]*>/g, '');
  // Keep only alphanumeric, spaces, hyphens
  const cleaned = stripped.replace(/[^a-zA-Z0-9 \-]/g, '').trim();
  // Cap at 30 characters
  const capped = cleaned.slice(0, 30).trim();
  return capped || 'Uncategorized';
}

/**
 * Create a cluster service for a given project.
 *
 * @param {object} db - Firestore Admin instance
 * @param {string} projectId
 * @returns {object} cluster service methods
 */
export function createClusterService(db, projectId) {
  const clustersRef = () =>
    db.collection('projects').doc(projectId).collection('clusters');

  /**
   * List all clusters for this project.
   * @returns {Promise<Array<{ id, label, keywords, ticketCount, createdAt }>>}
   */
  async function list() {
    const snap = await clustersRef().orderBy('ticketCount', 'desc').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Get a single cluster by Firestore document ID.
   * @param {string} clusterId
   * @returns {Promise<object|null>}
   */
  async function getById(clusterId) {
    const doc = await clustersRef().doc(clusterId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  /**
   * Count existing clusters.
   * @returns {Promise<number>}
   */
  async function count() {
    const snap = await clustersRef().get();
    return snap.size;
  }

  /**
   * Create a new cluster document. Server-side only.
   *
   * @param {{ label: string, keywords: string[] }} opts
   * @returns {Promise<{ id: string, label: string, keywords: string[], ticketCount: number, createdAt: string }>}
   */
  async function create({ label, keywords }) {
    const safeLabel = sanitizeClusterLabel(label);
    const safeKeywords = Array.isArray(keywords)
      ? keywords
          .filter(k => typeof k === 'string' && k.length > 0)
          .map(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50))
          .filter(k => k.length > 0)
          .slice(0, 100) // cap keyword array size
      : [];

    const now = new Date().toISOString();
    const data = {
      label: safeLabel,
      keywords: safeKeywords,
      ticketCount: 1,
      createdAt: now,
    };

    const ref = await clustersRef().add(data);
    return { id: ref.id, ...data };
  }

  /**
   * Increment the ticketCount on one or more clusters.
   * Used after assigning an existing cluster to a new ticket.
   *
   * Clusters are expected to be small in number (max 50) so individual
   * fetch-and-update per cluster is acceptable. Uses a batch for atomicity.
   *
   * @param {string[]} clusterIds - Firestore document IDs to increment
   * @returns {Promise<void>}
   */
  async function incrementCounts(clusterIds) {
    if (!clusterIds || clusterIds.length === 0) return;

    // Fetch current counts then batch-update
    const refs = clusterIds.map(cid => clustersRef().doc(cid));
    const docs = await Promise.all(refs.map(r => r.get()));

    const batch = db.batch();
    for (let i = 0; i < refs.length; i++) {
      if (docs[i].exists) {
        batch.update(refs[i], {
          ticketCount: (docs[i].data().ticketCount || 0) + 1,
        });
      }
    }
    await batch.commit();
  }

  return {
    list,
    getById,
    count,
    create,
    incrementCounts,
  };
}
