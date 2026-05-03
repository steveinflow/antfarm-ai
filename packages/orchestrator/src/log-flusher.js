// @docket/orchestrator — worker log buffering + Firestore flush.
//
// Each worker accumulates log lines into an in-memory buffer
// (state.workerLogs).  This module batches periodic writes of the new
// lines to Firestore so the web UI's per-ticket log view stays current
// without a per-line round trip.
//
// Also exports the orchestrator's "onLog" / "onWorkerLog" callbacks that
// are passed down to spawnWorker / resumeWorker — they are simple
// composers over appendWorkerLogLine + scheduleLogFlush + (optional)
// scheduleRender + console fallback.

/**
 * Keep only the last 500 lines in Firestore to avoid doc size limits.
 */
const MAX_FIRESTORE_LOG_LINES = 500;

/**
 * @param {object} state    Shared orchestrator state.
 * @param {object} deps
 * @param {Function} deps.writeLogFile
 * @param {Function} deps.getTicketService    projectId -> TicketService
 * @param {Function} deps.scheduleRender
 * @param {object}   deps.tui
 * @param {object}   deps.dashboard
 */
export function createLogFlusher(state, deps) {
  const {
    activeWorkers,
    pausedWorkers,
    ticketInfoCache,
    workerLogs,
    workerLogFlushedCount,
    workerLogFlushTimers,
    MAX_MEMORY_LOG_LINES,
  } = state;
  const { writeLogFile, getTicketService, scheduleRender, tui, dashboard } = deps;

  /**
   * Schedule a debounced flush of new worker log lines to Firestore.
   * Batches writes so we don't hammer Firestore on every log line.
   */
  function scheduleLogFlush(docId) {
    if (workerLogFlushTimers.has(docId)) return;
    const timer = setTimeout(() => {
      workerLogFlushTimers.delete(docId);
      flushWorkerLog(docId);
    }, 2000);
    workerLogFlushTimers.set(docId, timer);
  }

  function flushWorkerLog(docId) {
    const lines = workerLogs.get(docId);
    if (!lines || lines.length === 0) return;
    const alreadyFlushed = workerLogFlushedCount.get(docId) || 0;
    const newLines = lines.slice(alreadyFlushed);
    if (newLines.length === 0) return;

    // Find the project for this docId
    const workerState = activeWorkers.get(docId) || pausedWorkers.get(docId);
    const info = ticketInfoCache.get(docId);
    const projectId = workerState?.projectId || info?.projectId;
    if (!projectId) return;

    const ticketService = getTicketService(projectId);
    workerLogFlushedCount.set(docId, lines.length);

    if (lines.length <= MAX_FIRESTORE_LOG_LINES) {
      // Fast path: append only the new delta lines using arrayUnion.
      // This avoids rewriting previously-flushed lines on every flush.
      ticketService.appendWorkerLog(docId, newLines).catch(err => {
        writeLogFile(`Failed to append worker log for ${docId.slice(0, 8)}: ${err.message}`);
      });
    } else {
      // Trim path: total lines exceeded the cap — do a full overwrite with
      // the trimmed set so the stored array stays within document size limits.
      const allLines = lines.slice(-MAX_FIRESTORE_LOG_LINES);
      ticketService.update(docId, { workerLog: allLines }).catch(err => {
        writeLogFile(`Failed to flush worker log for ${docId.slice(0, 8)}: ${err.message}`);
      });
    }
  }

  /**
   * Append a log line to the in-memory workerLogs buffer for docId.
   * Trims the oldest entries when the buffer exceeds MAX_MEMORY_LOG_LINES so
   * long-running workers do not cause unbounded memory growth.
   * Also adjusts the flushed-line counter so the next Firestore flush still
   * sends only the truly new (unflushed) delta, even after a trim.
   */
  function appendWorkerLogLine(docId, formatted) {
    if (!workerLogs.has(docId)) workerLogs.set(docId, []);
    const lines = workerLogs.get(docId);
    lines.push(formatted);
    if (lines.length > MAX_MEMORY_LOG_LINES) {
      const excess = lines.length - MAX_MEMORY_LOG_LINES;
      lines.splice(0, excess);
      // Keep the flushed-count consistent: after trimming, the new logical
      // position of the first unflushed line has shifted by `excess` rows.
      // Clamp to zero so we never record a negative count.
      const prev = workerLogFlushedCount.get(docId) || 0;
      workerLogFlushedCount.set(docId, Math.max(0, prev - excess));
    }
  }

  function onLog(docId, line) {
    const ts = new Date().toISOString().slice(11, 19);
    const formatted = `[${ts}] ${line}`;
    // Don't write to stdout when TUI or dashboard is open — it corrupts the display.
    // All output goes to log file + workerLogs.
    if (!tui.isOpen && !dashboard.isOpen) console.log(formatted);
    writeLogFile(`[${docId.slice(0, 8)}] ${line}`);
    appendWorkerLogLine(docId, formatted);
    scheduleLogFlush(docId);
  }

  function onWorkerLog(docId, line) {
    const ts = new Date().toISOString().slice(11, 19);
    const formatted = `[${ts}] ${line}`;
    writeLogFile(`[${docId.slice(0, 8)}] ${line}`);
    appendWorkerLogLine(docId, formatted);
    scheduleLogFlush(docId);
    scheduleRender();
  }

  return { scheduleLogFlush, flushWorkerLog, appendWorkerLogLine, onLog, onWorkerLog };
}
