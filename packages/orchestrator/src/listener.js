// Firestore listeners — one per project subcollection
// Watches for new open tickets assigned to the configured userId.

/**
 * Start a real-time listener for open tickets in a specific project.
 *
 * Watches: projects/{projectId}/tickets where status == 'open' and userId == userId
 *
 * Calls `onNewTicket(docId, ticketData, projectId)` for each new open ticket
 * that appears (not already known).
 *
 * @param {object} db - Firestore instance
 * @param {string} projectId - Project document ID
 * @param {string} userId - User ID (unused, kept for API compat)
 * @param {object} callbacks
 * @param {function} callbacks.onNewTicket - Called with (docId, ticketData, projectId)
 * @param {function} [callbacks.onError] - Called with (error)
 * @returns {function} unsubscribe - Call to stop listening
 */
export function startProjectListener(db, projectId, userId, callbacks) {
  const { onNewTicket, onError } = callbacks;

  const query = db
    .collection('projects')
    .doc(projectId)
    .collection('tickets')
    .where('status', '==', 'open');

  const unsubscribe = query.onSnapshot(
    (snapshot) => {
      const now = new Date();
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          if (data.status === 'open') {
            // Skip tickets that are currently snoozed (snoozedUntil is in the future).
            // Snoozed tickets resurface automatically when snoozedUntil <= now on next read.
            if (data.snoozedUntil != null) {
              const snoozedUntilDate = new Date(data.snoozedUntil);
              if (!isNaN(snoozedUntilDate.getTime()) && snoozedUntilDate > now) {
                continue;
              }
            }
            onNewTicket(change.doc.id, data, projectId);
          }
        }
      }
    },
    (error) => {
      console.error(`[listener] Error in ${projectId} listener:`, error.message);
      if (onError) onError(error);
    },
  );

  return unsubscribe;
}

/**
 * Start a real-time listener for blocked tickets in a specific project.
 *
 * Watches: projects/{projectId}/tickets where status == 'blocked'
 *
 * Calls `onBlockedTicket(docId, ticketData, projectId)` whenever a ticket
 * transitions into the 'blocked' state (added or modified to blocked).
 *
 * @param {object} db - Firestore instance
 * @param {string} projectId - Project document ID
 * @param {object} callbacks
 * @param {function} callbacks.onBlockedTicket - Called with (docId, ticketData, projectId)
 * @param {function} [callbacks.onError] - Called with (error)
 * @returns {function} unsubscribe - Call to stop listening
 */
export function startBlockedTicketListener(db, projectId, callbacks) {
  const { onBlockedTicket, onError } = callbacks;

  const query = db
    .collection('projects')
    .doc(projectId)
    .collection('tickets')
    .where('status', '==', 'blocked');

  const unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          if (data.status === 'blocked') {
            onBlockedTicket(change.doc.id, data, projectId);
          }
        }
      }
    },
    (error) => {
      console.error(`[listener] Error in ${projectId} blocked listener:`, error.message);
      if (onError) onError(error);
    },
  );

  return unsubscribe;
}

/**
 * Start a real-time listener for open tickets that have critical === true.
 *
 * Watches: projects/{projectId}/tickets where status == 'open' AND critical == true
 *
 * Fires onCriticalTicket(docId, ticketData, projectId) for every 'added' or
 * 'modified' event that matches the filter.  The orchestrator uses this to
 * upgrade a queued ticket's priority when the critical flag is set after the
 * ticket was already enqueued.
 *
 * @param {object} db - Firestore instance
 * @param {string} projectId - Project document ID
 * @param {object} callbacks
 * @param {function} callbacks.onCriticalTicket - Called with (docId, ticketData, projectId)
 * @param {function} [callbacks.onError] - Called with (error)
 * @returns {function} unsubscribe - Call to stop listening
 */
export function startCriticalTicketListener(db, projectId, callbacks) {
  const { onCriticalTicket, onError } = callbacks;

  const query = db
    .collection('projects')
    .doc(projectId)
    .collection('tickets')
    .where('status', '==', 'open')
    .where('critical', '==', true);

  const unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          if (data.status === 'open' && data.critical === true) {
            onCriticalTicket(change.doc.id, data, projectId);
          }
        }
      }
    },
    (error) => {
      console.error(`[listener] Error in ${projectId} critical listener:`, error.message);
      if (onError) onError(error);
    },
  );

  return unsubscribe;
}

/**
 * Start a listener on a single ticket document.
 * Used to watch paused (waiting_for_user) tickets for status changes.
 *
 * @param {object} db - Firestore instance
 * @param {string} projectId - Project document ID
 * @param {string} docId - Ticket document ID
 * @param {function} callback - Called with (docData) on every change
 * @returns {function} unsubscribe
 */
export function startDocumentListener(db, projectId, docId, callback) {
  const docRef = db
    .collection('projects')
    .doc(projectId)
    .collection('tickets')
    .doc(docId);

  const unsubscribe = docRef.onSnapshot(
    (snapshot) => {
      if (snapshot.exists) {
        callback({ id: snapshot.id, ...snapshot.data() });
      }
    },
    (error) => {
      console.error(`[listener] Error watching ${projectId}/${docId}:`, error.message);
    },
  );

  return unsubscribe;
}

/**
 * Start a single collection-level listener for all paused (waiting_for_user) tickets
 * in a project. Replaces per-ticket document listeners with one shared query so that
 * the number of open Firestore connections stays constant regardless of how many
 * tickets are paused.
 *
 * Calls `onTicketChanged(docId, ticketData, projectId)` when a ticket's status changes
 * *away* from waiting_for_user (Firestore fires a 'removed' change because the
 * document no longer matches the query filter).  That is the signal that the user has
 * responded and the paused worker should be resumed.
 *
 * @param {object} db - Firestore instance
 * @param {string} projectId - Project document ID
 * @param {object} callbacks
 * @param {function} callbacks.onTicketChanged - Called with (docId, ticketData, projectId)
 * @param {function} [callbacks.onError] - Called with (error)
 * @returns {function} unsubscribe - Call to stop listening
 */
export function startPausedTicketsListener(db, projectId, callbacks) {
  const { onTicketChanged, onError } = callbacks;

  const query = db
    .collection('projects')
    .doc(projectId)
    .collection('tickets')
    .where('status', '==', 'waiting_for_user');

  const unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        // 'removed' fires when the ticket's status changes away from
        // waiting_for_user (it leaves the query result set). That is the
        // signal we need to resume the paused worker.
        if (change.type === 'removed') {
          const data = change.doc.data();
          onTicketChanged(change.doc.id, data, projectId);
        }
      }
    },
    (error) => {
      console.error(`[listener] Error in ${projectId} paused-tickets listener:`, error.message);
      if (onError) onError(error);
    },
  );

  return unsubscribe;
}
