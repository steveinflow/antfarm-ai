// run-logger.js — writes a single audit record to Firestore at the end of each
// advisor persona cycle. Records are append-only (never updated after write).
//
// Collection: advisorRuns
// Document ID: auto-generated
// Fields: see RunLogger and writeRunRecord() JSDoc below.
//
// New (DK-189) structured fields written at flush():
//   ticketsCreated:  string[]  — Firestore ticket IDs (same as `created`)
//   ticketsDeduped:  { summary: string, blockedBy: string }[]
//                   summary = matched keywords phrase (e.g. "login error handling, auth flow")
//                   blockedBy = Firestore ticket doc ID of the existing ticket
//   ticketsFiltered: { count: number, reasons: string[] }
//                   count = proposals not created for non-dedup reasons
//                   reasons = array of FILTER_REASONS enum codes
//
// New (DK-367) scope field:
//   scopeText:       string | null  — free-text scope from the run trigger
//                   Stored alongside the run for history display.
//                   Max 500 chars (enforced in createRunLogger).
//
// New (DK-380): intermediate progress writes — debounced 3s after each
//   addScanned / addCreated / addDeduped / addFiltered call so the web UI
//   receives live updates while the advisor is running.

const COLLECTION = 'advisorRuns';

/**
 * Classify an error into a safe category string.
 * Never write raw error.message or stack traces to Firestore.
 *
 * @param {Error|unknown} err
 * @returns {string}
 */
export function sanitizeError(err) {
  const msg = (err instanceof Error ? err.message : String(err)) || '';
  if (/rate.?limit/i.test(msg))              return 'rate_limit';
  if (/timeout/i.test(msg))                  return 'timeout';
  if (/no.?codebase|codebase.?path/i.test(msg)) return 'no_codebase_access';
  if (/ENOTFOUND|ECONNREFUSED|network/i.test(msg)) return 'api_unreachable';
  return 'api_error';
}

/**
 * Strip query string from a URL and return the path-only form.
 * Logs only the origin + pathname so no sensitive query params are stored.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function sanitizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.origin + u.pathname;
  } catch {
    // Not a full URL — return as-is (likely already a path)
    return rawUrl;
  }
}

/**
 * RunLogger — accumulates scanned/rejected/created entries during a persona cycle
 * and flushes a single Firestore write at the end.
 *
 * Usage:
 *   const logger = createRunLogger({ db, persona, projectId });
 *   logger.addScanned('/src/foo.js');
 *   logger.addRejected({ title: 'Foo', reason: 'duplicate', matchedTicketId: 'abc' });
 *   logger.addCreated('ticket-id-123');
 *   await logger.flush('completed');  // or flush('failed', 'rate_limit')
 *
 * The accumulator writes the document once in flush(). Call flush() in a finally
 * block so failures are always captured.
 *
 * Once finishedAt is set the document is treated as immutable — flush() is a no-op
 * if called again.
 */
export function createRunLogger({ db, persona, projectId, scopeText = null }) {
  const startedAt = new Date();
  const scanned = [];    // string[]
  const rejected = [];   // { title, reason, matchedTicketId?, score? }[]  (legacy field)
  const created = [];    // string[]  — ticket IDs

  // DK-189 structured fields for the run log drawer
  const ticketsDeduped = [];   // { summary: string, blockedBy: string }[]
  const filteredReasons = [];  // string[]  — FILTER_REASONS enum codes (one per filtered proposal)

  // DK-128: exclusion skip counter — files or URLs skipped due to user-configured exclusion patterns
  let _exclusionSkipCount = 0;

  // DK-134: scope matched-zero flag — true when scope filters were set but matched no files
  let _scopeMatchedZero = false;

  // DK-405: local screenshot folder path — set when design/QA saves screenshots to disk.
  // Stored in the run record so the history drawer can show a link to the folder.
  let _screenshotFolder = null;

  // DK-367: scope text — free-text scope from the run trigger (max 500 chars).
  // Null if the run was unscoped.
  const _scopeText = scopeText && typeof scopeText === 'string'
    ? scopeText.slice(0, 500)
    : null;

  let _docRef = null;
  let _flushed = false;

  // DK-380: debounced intermediate progress write.
  // A timer handle; reset on every add* call.  Fires 3 s after the last
  // mutation so we emit live progress without hammering Firestore on every
  // addScanned() call in a tight loop.
  let _progressTimer = null;
  let _pendingProgressBeforeStart = false; // true if add* was called before _docRef resolved
  const PROGRESS_DEBOUNCE_MS = 3000;

  function _scheduleProgressWrite() {
    if (_flushed) return;          // already finalized — skip
    if (!_docRef) {
      // _writeStart() hasn't resolved yet; set a flag so we schedule once it does
      _pendingProgressBeforeStart = true;
      return;
    }
    if (_progressTimer) clearTimeout(_progressTimer);
    _progressTimer = setTimeout(() => {
      _progressTimer = null;
      _writeProgress();
    }, PROGRESS_DEBOUNCE_MS);
  }

  async function _writeProgress() {
    if (_flushed || !_docRef) return;
    const ticketsFiltered = {
      count: filteredReasons.length,
      reasons: [...new Set(filteredReasons)],
    };
    try {
      await _docRef.update({
        scanned,
        rejected,
        created,
        ticketsCreated: created,
        ticketsDeduped,
        ticketsFiltered,
        exclusionSkipCount: _exclusionSkipCount,
      });
    } catch (err) {
      // Non-fatal — progress writes are best-effort
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.error(`[${ts}] [run-logger] Failed to write progress record: ${err.message}`);
    }
  }

  // Write the "running" sentinel immediately so the document exists
  // before the cycle completes (supports future in-flight visibility).
  // Non-fatal: errors here are suppressed.
  async function _writeStart() {
    try {
      const ref = await db.collection(COLLECTION).add({
        persona,
        projectId,
        scopeText: _scopeText,
        startedAt,
        finishedAt: null,
        status: 'running',
        scanned: [],
        rejected: [],
        created: [],
        ticketsCreated: [],
        ticketsDeduped: [],
        ticketsFiltered: { count: 0, reasons: [] },
        exclusionSkipCount: 0,
        error: null,
      });
      _docRef = ref;
      // If any add* calls arrived before _docRef was available, schedule a
      // progress write now that we have the document reference.
      if (_pendingProgressBeforeStart && !_flushed) {
        _pendingProgressBeforeStart = false;
        _scheduleProgressWrite();
      }
    } catch (err) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.error(`[${ts}] [run-logger] Failed to write start record: ${err.message}`);
    }
  }

  /**
   * Record a file path or URL that was scanned during this cycle.
   * For URLs, strip the query string before storing.
   *
   * @param {string} pathOrUrl
   */
  function addScanned(pathOrUrl) {
    scanned.push(sanitizeUrl(pathOrUrl));
    _scheduleProgressWrite();
  }

  /**
   * Record a rejected proposal (legacy field — use addDeduped/addFiltered for new code).
   *
   * @param {object} opts
   * @param {string} opts.title           - Proposal title
   * @param {'duplicate'|'low_confidence'|'threshold'} opts.reason - Rejection reason
   * @param {string} [opts.matchedTicketId] - For duplicate: the matched ticket's ID
   * @param {number} [opts.score]           - For low_confidence: the confidence score
   */
  function addRejected({ title, reason, matchedTicketId, score }) {
    const entry = { title, reason };
    if (matchedTicketId != null) entry.matchedTicketId = matchedTicketId;
    if (score != null) entry.score = score;
    rejected.push(entry);
    _scheduleProgressWrite();
  }

  /**
   * Record a ticket that was created during this cycle.
   * @param {string} ticketId - Firestore document ID for the ticket
   */
  function addCreated(ticketId) {
    created.push(ticketId);
    _scheduleProgressWrite();
  }

  /**
   * Record a deduplication hit (proposal blocked by an existing ticket).
   * Stores structured data for the run log drawer — never free-form AI prose.
   *
   * @param {object} opts
   * @param {string} opts.summary   - Matched keywords phrase (e.g. "login error handling, auth flow")
   *                                  Derived from the overlap keywords at match time — not AI output.
   * @param {string} opts.blockedBy - Firestore ticket doc ID of the existing ticket that blocked this proposal
   */
  function addDeduped({ summary, blockedBy }) {
    if (!summary || !blockedBy) return; // defensive: skip malformed entries
    ticketsDeduped.push({ summary: String(summary).slice(0, 200), blockedBy: String(blockedBy) });
    _scheduleProgressWrite();
  }

  /**
   * Record a proposal that was filtered/skipped for a non-dedup reason.
   * Use FILTER_REASONS enum codes — never free-form text.
   *
   * @param {string} reasonCode - One of the FILTER_REASONS enum values
   */
  function addFiltered(reasonCode) {
    filteredReasons.push(String(reasonCode));
    _scheduleProgressWrite();
  }

  /**
   * Record files or URLs skipped because they matched a user-configured exclusion pattern.
   * Used for the suppression counter ("N suggestions skipped this week").
   *
   * @param {number} count - Number of files/URLs excluded during this run
   */
  function addExclusionSkips(count) {
    if (typeof count === 'number' && count > 0) {
      _exclusionSkipCount += count;
      _scheduleProgressWrite();
    }
  }

  /**
   * DK-134: Mark that scope filters matched zero files.
   * Captured in the run log document so the UI can surface it as a warning.
   */
  function setScopeMatchedZero(matched) {
    _scopeMatchedZero = matched === true;
  }

  /**
   * DK-405: Record the local filesystem path where screenshots were saved for this run.
   * Only set when a screenshotDir is configured and screenshots were captured.
   * Stored in the run record so the history drawer can link to the folder.
   *
   * @param {string|null} folderPath - Absolute local path to the screenshot folder, or null
   */
  function setScreenshotFolder(folderPath) {
    if (typeof folderPath === 'string' && folderPath.trim().length > 0) {
      _screenshotFolder = folderPath.trim();
    }
  }

  /**
   * Return the Firestore document ID for the running record.
   * Available after the start document has been written (async).
   * Returns null before _writeStart() resolves.
   *
   * Used by personas to set advisorRunId on created tickets.
   *
   * @returns {string|null}
   */
  function getRunId() {
    return _docRef ? _docRef.id : null;
  }

  /**
   * Finalize the run record in Firestore.
   * Updates the start document (if created) or writes a new one.
   * Once called, the document is immutable — subsequent calls are no-ops.
   *
   * @param {'completed'|'failed'} status
   * @param {string|null} [error] - Sanitized error category (required when status === 'failed')
   * @returns {Promise<void>}
   */
  async function flush(status, error = null) {
    if (_flushed) return;
    _flushed = true;
    // Cancel any pending debounced progress write — flush() supersedes it.
    if (_progressTimer) {
      clearTimeout(_progressTimer);
      _progressTimer = null;
    }

    const finishedAt = new Date();
    const durationMs = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000) * 1000;

    // Build the structured ticketsFiltered object from accumulated reason codes
    const ticketsFiltered = {
      count: filteredReasons.length,
      reasons: [...new Set(filteredReasons)], // deduplicate reason codes
    };

    const data = {
      persona,
      projectId,
      scopeText: _scopeText,
      startedAt,
      finishedAt,
      durationMs,
      status,
      scanned,
      rejected,
      created,
      // DK-189 structured fields
      ticketsCreated:  created,         // same data as `created`, named per spec
      ticketsDeduped,
      ticketsFiltered,
      // DK-128: exclusion suppression counter
      exclusionSkipCount: _exclusionSkipCount,
      // DK-134: scope matched-zero flag
      ...((_scopeMatchedZero) ? { scopeMatchedZero: true } : {}),
      // DK-405: local screenshot folder path (design/QA personas only)
      ...(_screenshotFolder ? { screenshotFolder: _screenshotFolder } : {}),
      error: error || null,
    };

    try {
      if (_docRef) {
        await _docRef.update({
          finishedAt,
          durationMs,
          status,
          scanned,
          rejected,
          created,
          ticketsCreated: created,
          ticketsDeduped,
          ticketsFiltered,
          exclusionSkipCount: _exclusionSkipCount,
          ...(_scopeMatchedZero ? { scopeMatchedZero: true } : {}),
          // DK-405: local screenshot folder path (design/QA personas only)
          ...(_screenshotFolder ? { screenshotFolder: _screenshotFolder } : {}),
          error: error || null,
        });
      } else {
        await db.collection(COLLECTION).add(data);
      }
    } catch (err) {
      // Non-fatal: log but never throw from the finally block
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.error(`[${ts}] [run-logger] Failed to flush run record: ${err.message}`);
    }
  }

  // Start the initial write immediately (fire-and-forget)
  _writeStart();

  return { addScanned, addRejected, addCreated, addDeduped, addFiltered, addExclusionSkips, setScopeMatchedZero, setScreenshotFolder, getRunId, flush };
}

/**
 * Write one run record to Firestore at the end of a persona cycle.
 * Call this in the `finally` block so both success and failure are captured.
 *
 * @deprecated Use createRunLogger() for new code. This function remains for
 * backward compatibility and will delegate to the new RunLogger internally.
 *
 * @param {object} opts
 * @param {object} opts.db            - Firestore Admin SDK instance
 * @param {string} opts.persona       - "engineer" | "design" | "product"
 * @param {string} opts.projectId     - Project ID (Firestore document ID in /projects)
 * @param {Date}   opts.startedAt     - When this cycle started
 * @param {number} opts.filesScanned  - Count of files scanned (0 for design/product)
 * @param {number} opts.urlsScanned   - Count of URLs scanned (design only; 0 for others)
 * @param {number} opts.proposalsCreated - Number of tickets created
 * @param {string} opts.model         - Model string used for this run
 * @param {string} opts.status        - "ok" | "quiet" | "error"
 * @param {string|null} [opts.errorReason] - Sanitized error category (only when status === "error")
 * @returns {Promise<void>}
 */
export async function writeRunRecord({
  db,
  persona,
  projectId,
  startedAt,
  filesScanned,
  urlsScanned,
  proposalsCreated,
  model,
  status,
  errorReason = null,
}) {
  const now = new Date();
  const durationMs = now.getTime() - startedAt.getTime();
  // Round to nearest second to avoid exposing precise API latency
  const durationMs_rounded = Math.round(durationMs / 1000) * 1000;

  const record = {
    persona,
    projectId,
    startedAt,
    durationMs: durationMs_rounded,
    filesScanned: filesScanned || 0,
    urlsScanned: urlsScanned || 0,
    proposalsCreated: proposalsCreated || 0,
    model: model || '',
    status,
  };

  if (status === 'error' && errorReason) {
    record.errorReason = errorReason;
  }

  try {
    await db.collection(COLLECTION).add(record);
  } catch (err) {
    // Non-fatal: log but never throw from the finally block
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.error(`[${ts}] [run-logger] Failed to write advisorRuns record: ${err.message}`);
  }
}
