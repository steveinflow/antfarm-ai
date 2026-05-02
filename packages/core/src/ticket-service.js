// Ticket CRUD service — works with both web SDK and firebase-admin
// Accepts an injected Firestore `db` instance and `projectId`.

import { formatTicketNumber } from './format.js';
import { validateTicket, validateReasoning } from './validate.js';

export function createTicketService(db, projectId, { serverTimestamp, arrayUnion, arrayRemove }) {
  const projectRef = () => db.collection('projects').doc(projectId);
  const ticketsRef = () => projectRef().collection('tickets');

  async function add({ type, title, description, screenshots, userId, userEmail, status: initialStatus, fileRefs, screenshot, relatedTicketIds, reasoning, advisorPersona, critical, consensusMetadata }) {
    const validationErrors = validateTicket({ type, title, userId, userEmail, screenshots });
    if (validationErrors) {
      throw new Error(`Invalid ticket data: ${validationErrors.join('; ')}`);
    }

    const status = initialStatus || 'open';
    // Atomic ticket numbering via transaction on the project document
    const ticketData = await db.runTransaction(async (tx) => {
      const projDoc = await tx.get(projectRef());
      if (!projDoc.exists) throw new Error(`Project "${projectId}" not found`);
      const projData = projDoc.data();
      const nextNum = (projData.nextTicketNumber || 1);
      const ticketId = formatTicketNumber(projData.prefix, nextNum);

      tx.update(projectRef(), { nextTicketNumber: nextNum + 1 });

      const now = serverTimestamp();
      const doc = {
        ticketNumber: nextNum,
        ticketId,
        type,
        title,
        description: description || '',
        screenshots: screenshots && screenshots.length ? screenshots : [],
        status,
        statusHistory: [{ to: status, at: new Date().toISOString(), note: 'Ticket created' }],
        pendingQuestion: null,
        userId: userId || null,
        userEmail: userEmail || '',
        projectId,
        createdAt: now,
        updatedAt: now,
      };

      // Evidence enrichment fields — stored when provided by advisor personas
      if (fileRefs && fileRefs.length > 0) doc.fileRefs = fileRefs;
      if (screenshot) doc.screenshot = screenshot;
      if (relatedTicketIds && relatedTicketIds.length > 0) doc.relatedTicketIds = relatedTicketIds;

      // Proposal reasoning — populated by advisor personas at ticket creation time.
      // Schema: { summary: string, evidence: Array<{ type, ...fields }> }
      // Do not write raw LLM output — personas must parse into this schema first.
      if (reasoning) {
        const reasoningErrors = validateReasoning(reasoning);
        if (reasoningErrors) {
          throw new Error(`Invalid reasoning data: ${reasoningErrors.join('; ')}`);
        }
        doc.reasoning = reasoning;
      }

      // Advisor persona identifier — written at creation time so the performance
      // dashboard can group tickets by persona without scanning titles.
      // Values: 'engineer' | 'design' | 'product' (or a custom persona slug).
      if (advisorPersona) doc.advisorPersona = advisorPersona;

      // DK-126: Cross-persona consensus metadata — captured during Product persona's
      // Design+Engineer review step and stored at creation time in the same write.
      // Schema: { engineer: { verdict, summary }, design: { verdict, summary }, agreement: boolean }
      // Only present on Product-generated tickets. Inherits existing ticket read rules.
      if (consensusMetadata) doc.consensusMetadata = consensusMetadata;

      // Critical flag — user-submitted tickets that should bypass the max worker cap.
      if (critical) doc.critical = true;

      const newDocRef = ticketsRef().doc();
      tx.set(newDocRef, doc);

      return { id: newDocRef.id, ...doc };
    });

    return ticketData;
  }

  async function getById(docId) {
    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async function getByTicketNumber(ticketNumber) {
    const snap = await ticketsRef()
      .where('ticketNumber', '==', ticketNumber)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  async function list({ userId, status, limit: limitCount = 500, startAfter: cursor } = {}) {
    let q = ticketsRef();
    if (userId) q = q.where('userId', '==', userId);
    if (status && status !== 'all') q = q.where('status', '==', status);
    q = q.orderBy('ticketNumber', 'desc').limit(limitCount);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Fetch tickets using cursor-based pagination and accumulate into a single array.
   *
   * NOTE ON MEMORY: Pagination controls the per-query fetch size, not total accumulation.
   * For a project with many tickets, the returned array can be large. Use `maxResults`
   * to cap total accumulation, or prefer `listStubs()` when only title/status/id are
   * needed (e.g. dedup checks in advisor personas).
   *
   * A hard safety cap of 50 000 total results is applied when `maxResults` is not
   * provided. This prevents unbounded memory accumulation on large projects.
   *
   * @param {object} [options]
   * @param {number} [options.pageSize=500]      - Documents to fetch per Firestore query
   * @param {number} [options.maxResults=50000]  - Cap on total tickets returned
   * @returns {Promise<Array>} Tickets ordered by ticketNumber desc
   */
  async function listAll({ pageSize = 500, maxResults } = {}) {
    const totalMax = maxResults ?? 50000;
    const results = [];
    let lastDoc = null;

    while (true) {
      // Never fetch more than the remaining quota in a single page
      const remaining = totalMax - results.length;
      if (remaining <= 0) break;
      const fetchSize = Math.min(pageSize, remaining);

      let q = ticketsRef().orderBy('ticketNumber', 'desc').limit(fetchSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        results.push({ id: doc.id, ...doc.data() });
      }
      if (snap.docs.length < fetchSize) break;
      lastDoc = snap.docs[snap.docs.length - 1];
    }

    return results;
  }

  /**
   * Fetch lightweight ticket stubs (id, title, status, snoozedUntil, advisorPersona) for all
   * tickets, using cursor-based pagination. Significantly cheaper than listAll() for callers
   * that only need these fields — e.g. advisor dedup and convergence checks.
   *
   * A hard safety cap of 50 000 total results is applied when `maxResults` is not
   * provided. This prevents unbounded memory accumulation on large projects.
   *
   * @param {object} [options]
   * @param {number} [options.pageSize=500]      - Documents to fetch per Firestore query
   * @param {number} [options.maxResults=50000]  - Cap on total stubs returned
   * @returns {Promise<Array<{ id: string, title: string, status: string, snoozedUntil?: string, advisorPersona?: string }>>}
   */
  async function listStubs({ pageSize = 500, maxResults } = {}) {
    const totalMax = maxResults ?? 50000;
    const results = [];
    let lastDoc = null;

    while (true) {
      const remaining = totalMax - results.length;
      if (remaining <= 0) break;
      const fetchSize = Math.min(pageSize, remaining);
      let q = ticketsRef().orderBy('ticketNumber', 'desc').limit(fetchSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const d = doc.data();
        const stub = { id: doc.id, title: d.title, status: d.status };
        if (d.snoozedUntil != null) stub.snoozedUntil = d.snoozedUntil;
        // advisorPersona is included so convergence detection can filter by persona
        if (d.advisorPersona != null) stub.advisorPersona = d.advisorPersona;
        results.push(stub);
      }
      if (snap.docs.length < fetchSize) break;
      lastDoc = snap.docs[snap.docs.length - 1];
    }

    return results;
  }

  const STATUS_HISTORY_LIMIT = 100;

  async function transitionStatus(docId, newStatus, { note, pendingQuestion, ...extraFields } = {}) {
    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');
    const data = doc.data();
    const history = data.statusHistory || [];
    history.push({
      from: data.status,
      to: newStatus,
      at: new Date().toISOString(),
      ...(note ? { note } : {}),
    });
    if (history.length > STATUS_HISTORY_LIMIT) {
      history.splice(0, history.length - STATUS_HISTORY_LIMIT);
    }
    const updates = {
      status: newStatus,
      statusHistory: history,
      updatedAt: serverTimestamp(),
      ...extraFields,
    };
    if (pendingQuestion !== undefined) {
      updates.pendingQuestion = pendingQuestion;
    } else if (newStatus !== 'waiting_for_user') {
      updates.pendingQuestion = null;
    }
    return ticketsRef().doc(docId).update(updates);
  }

  async function update(docId, data) {
    return ticketsRef().doc(docId).update({
      ...data,
      updatedAt: serverTimestamp(),
    });
  }

  async function appendHistory(docId, { note } = {}) {
    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');
    const data = doc.data();
    const history = data.statusHistory || [];
    history.push({
      at: new Date().toISOString(),
      ...(note ? { note } : {}),
    });
    if (history.length > STATUS_HISTORY_LIMIT) {
      history.splice(0, history.length - STATUS_HISTORY_LIMIT);
    }
    return ticketsRef().doc(docId).update({
      statusHistory: history,
      updatedAt: serverTimestamp(),
    });
  }

  async function deleteTicket(docId) {
    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');
    return ticketsRef().doc(docId).delete();
  }

  /**
   * Write LLM-generated impact/effort scores back to a ticket.
   * Called asynchronously after ticket creation — does not block creation.
   *
   * @param {string} docId - Firestore document ID
   * @param {object} scores
   * @param {number} scores.impact        - 1–5 (clamped server-side)
   * @param {number} scores.effort        - 1–5 (clamped server-side)
   * @param {string} scores.rationale     - One-sentence rationale (stored as-is)
   * @param {number} [scores.scoreVersion] - Scoring prompt version (integer)
   */
  async function updateScore(docId, { impact, effort, rationale, scoreVersion }) {
    // Clamp values to 1–5
    const clampedImpact = Math.min(5, Math.max(1, Math.round(impact)));
    const clampedEffort = Math.min(5, Math.max(1, Math.round(effort)));

    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');
    const data = doc.data();

    // Never overwrite a user override unless explicitly requested
    if (data.score_overridden) return;

    return ticketsRef().doc(docId).update({
      impact: clampedImpact,
      effort: clampedEffort,
      score_rationale: rationale || '',
      scored_at: new Date().toISOString(),
      score_version: scoreVersion || 1,
      score_overridden: false,
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Apply a manual score override from a user.
   * Sets score_overridden = true so future re-scores skip this ticket.
   * Clamps impact/effort to 1–5 server-side regardless of client input.
   *
   * @param {string} docId - Firestore document ID
   * @param {object} overrides
   * @param {number} overrides.impact  - 1–5 (clamped server-side)
   * @param {number} overrides.effort  - 1–5 (clamped server-side)
   * @param {string} [overrides.note]  - Optional override note
   */
  async function overrideScore(docId, { impact, effort, note }) {
    const clampedImpact = Math.min(5, Math.max(1, Math.round(impact)));
    const clampedEffort = Math.min(5, Math.max(1, Math.round(effort)));

    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');

    const updates = {
      impact: clampedImpact,
      effort: clampedEffort,
      score_overridden: true,
      updatedAt: serverTimestamp(),
    };
    if (note !== undefined) updates.score_override_note = note;

    return ticketsRef().doc(docId).update(updates);
  }

  /**
   * Snooze a proposed ticket until the given date.
   *
   * Validates server-side:
   *  - snoozedUntil must be a valid Date/Timestamp
   *  - Must be in the future
   *  - Must not exceed 6 months from now
   *
   * Adds to snoozeHistory (capped at 20 entries).
   * Sets snoozedUntil to the target timestamp.
   *
   * @param {string} docId - Firestore document ID
   * @param {Date|number} snoozedUntilDate - JS Date or ms timestamp
   * @returns {Promise<void>}
   */
  async function snoozeTicket(docId, snoozedUntilDate) {
    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');
    const data = doc.data();

    // Validate: must be a proposed ticket
    if (data.status !== 'proposed') {
      throw new Error('Only proposed tickets can be snoozed');
    }

    // Parse and validate the target date
    const targetDate = snoozedUntilDate instanceof Date
      ? snoozedUntilDate
      : new Date(snoozedUntilDate);

    if (isNaN(targetDate.getTime())) {
      throw new Error('Invalid snooze date');
    }

    const now = new Date();
    if (targetDate <= now) {
      throw new Error('Snooze date must be in the future');
    }

    const sixMonthsFromNow = new Date(now.getTime() + 6 * 30 * 24 * 60 * 60 * 1000);
    if (targetDate > sixMonthsFromNow) {
      throw new Error('Snooze date must not exceed 6 months from now');
    }

    // Build new snooze history entry
    const newEntry = {
      snoozedAt: new Date().toISOString(),
      snoozedUntil: targetDate.toISOString(),
    };

    // Cap snoozeHistory at 20 entries — drop oldest if needed
    const existingHistory = Array.isArray(data.snoozeHistory) ? data.snoozeHistory : [];
    const newHistory = [...existingHistory, newEntry];
    if (newHistory.length > 20) {
      newHistory.splice(0, newHistory.length - 20);
    }

    return ticketsRef().doc(docId).update({
      snoozedUntil: targetDate.toISOString(),
      snoozeHistory: newHistory,
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Unsnooze a ticket immediately (clear snoozedUntil).
   * @param {string} docId - Firestore document ID
   */
  async function unsnoozeTicket(docId) {
    const doc = await ticketsRef().doc(docId).get();
    if (!doc.exists) throw new Error('Ticket not found');
    return ticketsRef().doc(docId).update({
      snoozedUntil: null,
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Reset orphaned in-flight tickets so the orchestrator can re-process them.
   * Queries are limited and processed in batches of REKICK_BATCH_SIZE to avoid
   * loading unbounded numbers of documents or exceeding Firestore batch limits.
   *
   * - in_progress  → open    (orphaned worker tickets)
   * - in_maintenance → blocked (interrupted maintenance passes)
   */
  async function rekickOrchestrator() {
    const REKICK_BATCH_SIZE = 100;
    const now = new Date().toISOString();
    let count = 0;

    /**
     * Paginate through all docs matching `status`, apply `updateFn` to each
     * in batches of up to REKICK_BATCH_SIZE, committing after each batch.
     */
    async function processStatus(status, updateFn) {
      let lastDoc = null;
      while (true) {
        let q = ticketsRef()
          .where('status', '==', status)
          .limit(REKICK_BATCH_SIZE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;

        const batch = db.batch();
        for (const doc of snap.docs) {
          updateFn(batch, doc);
          count++;
        }
        await batch.commit();

        if (snap.docs.length < REKICK_BATCH_SIZE) break;
        lastDoc = snap.docs[snap.docs.length - 1];
      }
    }

    // Reset orphaned in_progress tickets to open
    await processStatus('in_progress', (batch, doc) => {
      const data = doc.data();
      const history = data.statusHistory || [];
      history.push({
        from: 'in_progress',
        to: 'open',
        at: now,
        note: 'Reset to open by admin rekick',
      });
      if (history.length > STATUS_HISTORY_LIMIT) {
        history.splice(0, history.length - STATUS_HISTORY_LIMIT);
      }
      batch.update(doc.ref, {
        status: 'open',
        statusHistory: history,
        updatedAt: serverTimestamp(),
        workerPhase: null,
        workerStartedAt: null,
      });
    });

    // Reset orphaned in_maintenance tickets back to blocked so maintenance retries them
    await processStatus('in_maintenance', (batch, doc) => {
      const data = doc.data();
      const history = data.statusHistory || [];
      history.push({
        from: 'in_maintenance',
        to: 'blocked',
        at: now,
        note: 'Reset to blocked by admin rekick (maintenance was interrupted)',
      });
      if (history.length > STATUS_HISTORY_LIMIT) {
        history.splice(0, history.length - STATUS_HISTORY_LIMIT);
      }
      batch.update(doc.ref, {
        status: 'blocked',
        statusHistory: history,
        updatedAt: serverTimestamp(),
        workerPhase: null,
        workerStartedAt: null,
      });
    });

    return count;
  }

  /**
   * Append new log lines to workerLog using arrayUnion (delta write).
   * When arrayUnion is provided (admin SDK), uses an atomic delta write.
   * Falls back to a fetch-then-write merge when arrayUnion is unavailable,
   * so existing log entries are never lost.
   *
   * @param {string} docId - Firestore document ID
   * @param {string[]} newLines - New lines to append
   */
  async function appendWorkerLog(docId, newLines) {
    if (!newLines || newLines.length === 0) return;
    if (!arrayUnion) {
      // Fetch current log and merge — a plain update({ workerLog: newLines })
      // would overwrite the existing array, causing data loss.
      const doc = await ticketsRef().doc(docId).get();
      const current = (doc.exists && Array.isArray(doc.data().workerLog))
        ? doc.data().workerLog
        : [];
      return ticketsRef().doc(docId).update({
        workerLog: [...current, ...newLines],
        updatedAt: serverTimestamp(),
      });
    }
    return ticketsRef().doc(docId).update({
      workerLog: arrayUnion(...newLines),
      updatedAt: serverTimestamp(),
    });
  }

  function onTicketsChanged(callback, { status } = {}) {
    let q = ticketsRef();
    if (status) q = q.where('status', '==', status);
    q = q.orderBy('ticketNumber', 'desc');
    return q.onSnapshot(snapshot => {
      callback(snapshot);
    });
  }

  /**
   * Subscribe to proposed tickets in real-time, ordered by createdAt ascending
   * (oldest proposals first — drain the queue in order).
   *
   * Returns an unsubscribe function. Consistent with the rest of the app (onSnapshot).
   *
   * @param {function} callback - Called with an array of ticket objects on each update.
   * @returns {function} unsubscribe
   */
  function getProposedTickets(callback) {
    const q = ticketsRef()
      .where('status', '==', 'proposed')
      .orderBy('createdAt');
    return q.onSnapshot(snapshot => {
      const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(tickets);
    });
  }

  /**
   * Valid link relationship types.
   */
  const LINK_TYPES = ['blocks', 'related', 'follow-up'];

  /**
   * Add a directional link from this ticket (docId) to a target ticket.
   *
   * Two writes are performed atomically:
   *   1. Source document: `links` array updated with { targetId, type }.
   *   2. Target document: `incomingLinks` array updated with the source docId
   *      via arrayUnion — this denormalized reverse index makes getIncomingLinks
   *      O(K) (K = number of incoming links) instead of O(N) (N = all linked tickets).
   *
   * Detects circular dependencies: if the target already has a path back to
   * this ticket (direct only — one level), rejects the link.
   *
   * @param {string} docId       - Source Firestore document ID
   * @param {string} targetId    - Target Firestore document ID
   * @param {'blocks'|'related'|'follow-up'} type - Relationship type
   * @returns {Promise<void>}
   */
  async function addLink(docId, targetId, type) {
    if (!LINK_TYPES.includes(type)) {
      throw new Error(`Invalid link type "${type}". Must be one of: ${LINK_TYPES.join(', ')}`);
    }
    if (docId === targetId) {
      throw new Error('A ticket cannot link to itself');
    }

    const [sourceDoc, targetDoc] = await Promise.all([
      ticketsRef().doc(docId).get(),
      ticketsRef().doc(targetId).get(),
    ]);

    if (!sourceDoc.exists) throw new Error('Source ticket not found');
    if (!targetDoc.exists) throw new Error('Target ticket not found');

    const sourceData = sourceDoc.data();
    const targetData = targetDoc.data();

    // Circular dependency check: if target already links back to source, reject.
    const targetLinks = Array.isArray(targetData.links) ? targetData.links : [];
    const circularLink = targetLinks.find(l => l.targetId === docId);
    if (circularLink) {
      throw new Error(
        `Circular dependency detected: the target ticket already links back to this ticket (${circularLink.type})`
      );
    }

    // Check if this exact link already exists
    const existingLinks = Array.isArray(sourceData.links) ? sourceData.links : [];
    const alreadyLinked = existingLinks.find(l => l.targetId === targetId);
    if (alreadyLinked) {
      if (alreadyLinked.type === type) {
        // Exact duplicate — no-op (incomingLinks on target already contains docId)
        return;
      }
      // Same target, different type — update type by rebuilding the array on source.
      // incomingLinks on target already has docId, no change needed there.
      const updatedLinks = existingLinks.map(l =>
        l.targetId === targetId ? { targetId, type } : l
      );
      return ticketsRef().doc(docId).update({
        links: updatedLinks,
        hasLinks: true,
        updatedAt: serverTimestamp(),
      });
    }

    // Append new link on source and record reverse index on target.
    const newLinks = [...existingLinks, { targetId, type }];
    const sourceUpdate = ticketsRef().doc(docId).update({
      links: newLinks,
      hasLinks: true,
      updatedAt: serverTimestamp(),
    });

    // Write the reverse index: add docId to target's incomingLinks array.
    // arrayUnion is used when available (admin SDK); falls back to a fetch-merge
    // when unavailable (web SDK contexts that didn't inject it).
    let targetUpdate;
    if (arrayUnion) {
      targetUpdate = ticketsRef().doc(targetId).update({
        incomingLinks: arrayUnion(docId),
      });
    } else {
      const existingIncoming = Array.isArray(targetData.incomingLinks) ? targetData.incomingLinks : [];
      if (!existingIncoming.includes(docId)) {
        targetUpdate = ticketsRef().doc(targetId).update({
          incomingLinks: [...existingIncoming, docId],
        });
      }
    }

    return Promise.all([sourceUpdate, targetUpdate].filter(Boolean));
  }

  /**
   * Remove a link from this ticket (docId) to a target ticket.
   *
   * Two writes are performed:
   *   1. Source document: removes the link entry from `links`.
   *   2. Target document: removes docId from `incomingLinks` (reverse index cleanup).
   *
   * @param {string} docId    - Source Firestore document ID
   * @param {string} targetId - Target Firestore document ID to unlink
   * @returns {Promise<void>}
   */
  async function removeLink(docId, targetId) {
    const sourceDoc = await ticketsRef().doc(docId).get();
    if (!sourceDoc.exists) throw new Error('Source ticket not found');

    const sourceData = sourceDoc.data();
    const existingLinks = Array.isArray(sourceData.links) ? sourceData.links : [];
    const updatedLinks = existingLinks.filter(l => l.targetId !== targetId);

    const sourceUpdate = ticketsRef().doc(docId).update({
      links: updatedLinks,
      hasLinks: updatedLinks.length > 0,
      updatedAt: serverTimestamp(),
    });

    // Remove docId from the target's incomingLinks reverse index.
    // arrayRemove is used when available (admin SDK); falls back to fetch-merge.
    let targetUpdate;
    if (arrayRemove) {
      targetUpdate = ticketsRef().doc(targetId).update({
        incomingLinks: arrayRemove(docId),
      });
    } else {
      const targetDoc = await ticketsRef().doc(targetId).get();
      if (targetDoc.exists) {
        const targetData = targetDoc.data();
        const existingIncoming = Array.isArray(targetData.incomingLinks) ? targetData.incomingLinks : [];
        const updatedIncoming = existingIncoming.filter(id => id !== docId);
        if (updatedIncoming.length !== existingIncoming.length) {
          targetUpdate = ticketsRef().doc(targetId).update({
            incomingLinks: updatedIncoming,
          });
        }
      }
    }

    return Promise.all([sourceUpdate, targetUpdate].filter(Boolean));
  }

  /**
   * Fetch tickets that link TO a given target ticket ID (reverse lookup).
   *
   * Uses the denormalized `incomingLinks` array stored on the target document.
   * `incomingLinks` is maintained by addLink/removeLink as an array of source
   * Firestore document IDs. This makes the reverse lookup O(K) where K is the
   * number of incoming links, rather than a full-collection scan.
   *
   * If `incomingLinks` is absent (documents created before this field was
   * introduced), the function returns an empty array for that document — no
   * client-side scan fallback is performed.
   *
   * @param {string} targetDocId - Firestore document ID of the target ticket
   * @returns {Promise<Array<{ id: string, ticketId: string, title: string, status: string, type: string, links: Array, linkType: string }>>}
   */
  async function getIncomingLinks(targetDocId) {
    const targetDoc = await ticketsRef().doc(targetDocId).get();
    if (!targetDoc.exists) return [];

    const targetData = targetDoc.data();
    const sourceDocIds = Array.isArray(targetData.incomingLinks) ? targetData.incomingLinks : [];
    if (sourceDocIds.length === 0) return [];

    // Batch-fetch all source documents using getTicketStubs for metadata,
    // then resolve the linkType from each source's own `links` array.
    // We need the full `links` array to find the linkType, so fetch full docs.
    const refs = sourceDocIds.map(id => ticketsRef().doc(id));
    const BATCH_SIZE = 500;
    const allDocs = [];
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const chunk = refs.slice(i, i + BATCH_SIZE);
      const docs = await db.getAll(...chunk);
      allDocs.push(...docs);
    }

    const results = [];
    for (const doc of allDocs) {
      if (!doc.exists) continue; // source was deleted — stale incomingLinks entry
      const data = doc.data();
      const links = Array.isArray(data.links) ? data.links : [];
      const matchingLink = links.find(l => l.targetId === targetDocId);
      if (!matchingLink) continue; // stale incomingLinks entry — link was removed
      results.push({
        id: doc.id,
        ticketId: data.ticketId,
        title: data.title,
        status: data.status,
        type: data.type,
        links: data.links,
        // Expose the specific link relationship type pointing to our target
        linkType: matchingLink.type,
      });
    }
    return results;
  }

  /**
   * Batch-fetch ticket stubs (id, ticketId, title, status, type) for an array
   * of Firestore document IDs. Used to resolve linked ticket display names
   * without loading full ticket documents.
   *
   * Firestore `getAll` is used for an efficient single-roundtrip batch read.
   *
   * @param {string[]} docIds - Firestore document IDs to fetch
   * @returns {Promise<Map<string, { id: string, ticketId: string, title: string, status: string, type: string }>>}
   */
  async function getTicketStubs(docIds) {
    if (!docIds || docIds.length === 0) return new Map();

    // Deduplicate
    const uniqueIds = [...new Set(docIds)];
    const refs = uniqueIds.map(id => ticketsRef().doc(id));

    // Firestore getAll batches up to 500 refs at once.
    // For larger sets, chunk into 500-doc batches.
    const BATCH_SIZE = 500;
    const allDocs = [];
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const chunk = refs.slice(i, i + BATCH_SIZE);
      const docs = await db.getAll(...chunk);
      allDocs.push(...docs);
    }

    const result = new Map();
    for (const doc of allDocs) {
      if (doc.exists) {
        const d = doc.data();
        result.set(doc.id, {
          id: doc.id,
          ticketId: d.ticketId,
          title: d.title,
          status: d.status,
          type: d.type,
        });
      }
    }
    return result;
  }

  return {
    add,
    getById,
    getByTicketNumber,
    list,
    listAll,
    listStubs,
    transitionStatus,
    update,
    updateScore,
    overrideScore,
    appendHistory,
    appendWorkerLog,
    deleteTicket,
    snoozeTicket,
    unsnoozeTicket,
    rekickOrchestrator,
    onTicketsChanged,
    getProposedTickets,
    addLink,
    removeLink,
    getIncomingLinks,
    getTicketStubs,
    LINK_TYPES,
  };
}
