// Advisor dry-run service.
//
// Handles the /advisor-dry-runs collection on behalf of the advisor daemon.
// When the web UI writes a request doc with status == 'pending', the daemon
// picks it up here, runs the persona with dryRun: true, and writes results back.
//
// Rate limiting (server-side):
//   - One concurrent dry run per user at a time
//   - 60-second cooldown per persona per user after a completed run
//
// Cleanup:
//   - All dry-run docs are given a ttl field (24 h from creation).
//   - On daemon startup, expired docs are deleted.

import admin from 'firebase-admin';

const COL = 'advisor-dry-runs';
const TTL_MS = 24 * 60 * 60 * 1000;        // 24 hours
const COOLDOWN_MS = 60 * 1000;              // 60 seconds per-persona per-user
const MAX_PROPOSALS_PER_RUN = 20;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [dry-run] ${msg}`);
}

/**
 * Delete expired dry-run docs (ttl < now).
 * Called once on daemon startup.
 *
 * @param {object} db - Firestore Admin instance
 */
export async function cleanupExpiredDryRuns(db) {
  try {
    const now = admin.firestore.Timestamp.now();
    const snap = await db.collection(COL)
      .where('ttl', '<', now)
      .get();
    if (snap.empty) return;
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    log(`Cleaned up ${snap.size} expired dry-run doc(s)`);
  } catch (err) {
    log(`Cleanup warning (non-fatal): ${err.message}`);
  }
}

/**
 * Start listening for pending dry-run requests.
 * Returns an unsubscribe function.
 *
 * @param {object} db - Firestore Admin instance
 * @param {object} personaRunners - { personaId: async (opts) => proposals[] }
 * @returns {function} unsubscribe
 */
export function startDryRunListener(db, personaRunners) {
  const unsub = db.collection(COL)
    .where('status', '==', 'pending')
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const doc = change.doc;
        const data = doc.data();
        // Process asynchronously — do not await inside the snapshot callback
        processDryRunRequest(db, doc.ref, data, personaRunners)
          .catch(err => log(`Unhandled error for ${doc.id}: ${err.message}`));
      }
    }, (err) => {
      log(`Listener error (will reconnect): ${err.message}`);
    });

  return unsub;
}

/**
 * Process one dry-run request doc.
 *
 * @param {object} db
 * @param {object} docRef - DocumentReference for the dry-run doc
 * @param {object} data - doc data snapshot
 * @param {object} personaRunners
 */
async function processDryRunRequest(db, docRef, data, personaRunners) {
  const { personaId, userId, projectId, createdAt } = data;

  // ── Claim + distributed concurrency check ────────────────────────────────
  //
  // We atomically claim this doc AND verify no other doc for this user is
  // currently 'running' — all inside a single transaction.  This is safe
  // across multiple daemon instances because Firestore transactions use
  // optimistic concurrency: if any read doc changes between our read and
  // commit, the transaction retries or aborts.
  //
  // We use a dedicated per-user lock document in 'advisor-dry-run-locks'
  // (userId as the doc ID) rather than querying the main collection inside
  // a transaction (collection queries inside transactions have extra
  // constraints and can be expensive). The lock doc has the shape:
  //   { runningDocId: string | null }
  // A non-null runningDocId means that user already has a run in progress.
  // We set it atomically when claiming and clear it when the run finishes.

  const lockRef = db.collection('advisor-dry-run-locks').doc(userId);

  let concurrencyRejected = false;
  try {
    await db.runTransaction(async (tx) => {
      // Read the dry-run doc to ensure it is still pending
      const snap = await tx.get(docRef);
      if (!snap.exists || snap.data().status !== 'pending') {
        throw new Error('already_claimed');
      }

      // Read the per-user lock doc
      const lockSnap = await tx.get(lockRef);
      const runningDocId = lockSnap.exists ? lockSnap.data().runningDocId : null;

      if (runningDocId) {
        // Another instance is already processing a dry run for this user.
        // Reject this doc immediately inside the transaction so the caller
        // sees a terminal status right away.
        concurrencyRejected = true;
        tx.update(docRef, {
          status: 'error',
          error: 'A dry run is already in progress for your account. Please wait for it to finish.',
          finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return; // commit the error update; do NOT claim the lock
      }

      // Claim the doc and acquire the lock in one atomic write
      tx.update(docRef, {
        status: 'running',
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(lockRef, { runningDocId: docRef.id }, { merge: true });
    });
  } catch (err) {
    if (err.message === 'already_claimed') return; // another worker got it
    log(`Failed to claim dry-run ${docRef.id}: ${err.message}`);
    return;
  }

  if (concurrencyRejected) {
    log(`Rate limit: user ${userId} already has a dry run in progress — rejected ${docRef.id}`);
    return;
  }

  // ── Cooldown check ────────────────────────────────────────────────────────
  // 60-second cooldown per persona per user (already Firestore-based, distributed-safe)

  const cooldownKey = `${userId}_${personaId}`;
  const lastRunRef = db.collection('advisor-dry-run-meta').doc(cooldownKey);
  try {
    const metaSnap = await lastRunRef.get();
    if (metaSnap.exists) {
      const lastAt = metaSnap.data().lastRunAt?.toDate?.();
      if (lastAt && Date.now() - lastAt.getTime() < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastAt.getTime())) / 1000);
        log(`Rate limit: cooldown active for ${userId}/${personaId} — ${remaining}s remaining`);
        await docRef.update({
          status: 'error',
          error: `Please wait ${remaining} seconds before running another ${personaId} preview.`,
          finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Release the lock before returning
        await lockRef.set({ runningDocId: null }, { merge: true });
        return;
      }
    }
  } catch (err) {
    // Non-fatal: continue without cooldown check if meta read fails
    log(`Could not read cooldown meta for ${cooldownKey}: ${err.message}`);
  }

  // ── Run ──────────────────────────────────────────────────────────────────

  log(`Starting dry run for ${personaId} (user: ${userId}, project: ${projectId || 'all'})`);

  let proposals = [];
  let errorMsg = null;

  try {
    const runner = personaRunners[personaId];
    if (!runner) {
      throw new Error(`No runner registered for persona "${personaId}"`);
    }

    const onProgress = (msg) => {
      // Fire-and-forget progress update — updates the doc's statusMessage field
      docRef.update({ statusMessage: msg }).catch(() => {});
    };

    proposals = await runner({
      projectId: projectId || null,
      onProgress,
      dryRun: true,
    });

    // Sanitize: cap proposals, ensure each is a plain object
    if (!Array.isArray(proposals)) proposals = [];
    proposals = proposals
      .slice(0, MAX_PROPOSALS_PER_RUN)
      .map(p => sanitizeProposal(p));

    log(`Dry run complete for ${personaId}: ${proposals.length} proposal(s)`);
  } catch (err) {
    errorMsg = err.message || String(err);
    log(`Dry run error for ${personaId}: ${errorMsg}`);
    if (process.env.DEBUG) console.error(err);
  } finally {
    // Always release the distributed lock when the run finishes (or errors)
    try {
      await lockRef.set({ runningDocId: null }, { merge: true });
    } catch (lockErr) {
      log(`Warning: could not release lock for user ${userId}: ${lockErr.message}`);
    }
  }

  // ── Write result ─────────────────────────────────────────────────────────

  const ttl = admin.firestore.Timestamp.fromDate(new Date(Date.now() + TTL_MS));

  if (errorMsg) {
    await docRef.update({
      status: 'error',
      error: errorMsg,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttl,
    });
  } else {
    await docRef.update({
      status: 'done',
      proposals,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttl,
    });
  }

  // Update cooldown metadata
  try {
    await lastRunRef.set({ lastRunAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (err) {
    log(`Could not write cooldown meta for ${cooldownKey}: ${err.message}`);
  }
}

/**
 * Sanitize a proposal object from a dry run.
 * Strips any internal fields that should not be written to the client.
 * All text fields are treated as untrusted — sanitization happens at render time.
 *
 * @param {object} p - raw proposal
 * @returns {object} sanitized proposal
 */
function sanitizeProposal(p) {
  if (!p || typeof p !== 'object') return {};
  // Allow only known safe fields
  const safe = {};
  const ALLOWED_STRING_FIELDS = ['title', 'description', 'type', 'severity', 'file', 'recommendation', 'reasoning_summary', 'advisorPersona', 'filterReason', 'deduped', 'dedupMatchId'];
  const ALLOWED_NUMBER_FIELDS = ['lineStart', 'lineEnd', 'impact', 'effort'];
  const ALLOWED_BOOL_FIELDS = ['deduped'];

  for (const f of ALLOWED_STRING_FIELDS) {
    if (typeof p[f] === 'string') safe[f] = p[f].slice(0, 4000);
  }
  for (const f of ALLOWED_NUMBER_FIELDS) {
    if (typeof p[f] === 'number') safe[f] = p[f];
  }
  for (const f of ALLOWED_BOOL_FIELDS) {
    if (typeof p[f] === 'boolean') safe[f] = p[f];
  }
  return safe;
}
