// Project registry service

export function createProjectService(db) {
  const projectsRef = () => db.collection('projects');

  async function register({ id, prefix, name, adminEmails, repoPath, scanPaths }) {
    if (!id || !prefix || !name) {
      throw new Error('id, prefix, and name are required');
    }
    if (!/^[A-Z]{2,4}$/.test(prefix)) {
      throw new Error('prefix must be 2-4 uppercase letters');
    }

    // Check for duplicate prefix
    const existing = await getByPrefix(prefix);
    if (existing && existing.id !== id) {
      throw new Error(`Prefix "${prefix}" already used by project "${existing.id}"`);
    }

    const now = new Date().toISOString();
    const data = {
      prefix,
      name,
      adminEmails: adminEmails || [],
      repoPath: repoPath || '',
      nextTicketNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    // Only store scanPaths if explicitly provided (undefined means "use defaults")
    if (Array.isArray(scanPaths) && scanPaths.length > 0) {
      data.scanPaths = scanPaths;
    }
    await projectsRef().doc(id).set(data, { merge: true });
    return { id, ...data };
  }

  async function get(id) {
    const doc = await projectsRef().doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async function list() {
    const snap = await projectsRef().get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  async function update(id, data) {
    data.updatedAt = new Date().toISOString();
    return projectsRef().doc(id).update(data);
  }

  async function remove(id) {
    return projectsRef().doc(id).delete();
  }

  async function getByPrefix(prefix) {
    const snap = await projectsRef().where('prefix', '==', prefix.toUpperCase()).limit(1).get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  async function isAdmin(projectId, email) {
    const project = await get(projectId);
    if (!project) return false;
    return (project.adminEmails || []).includes(email);
  }

  return { register, get, list, update, delete: remove, getByPrefix, isAdmin };
}
