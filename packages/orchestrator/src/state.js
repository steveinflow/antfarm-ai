// @docket/orchestrator — central mutable state for createOrchestrator().
//
// The orchestrator was originally one large closure where every helper
// shared lexical access to ~30 pieces of state.  Extracting concerns into
// per-module factories means each module needs an explicit handle to that
// shared state.  This file builds that handle.
//
// State is intentionally a plain object so individual fields can be reassigned
// (e.g. `state.maintenanceRunning = true`) without juggling closures of
// closures.  Maps / Sets / Arrays are mutated in place by the modules that own
// them.
//
// Anything that needs to be observable from the dashboard/TUI is a stable
// reference that gets passed to those views at construction time.

import { createMergeQueueManager } from './merge-queue.js';

const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_WORKERS_LIMIT = 128;

/**
 * Maximum number of log lines kept in memory per worker.
 * When exceeded, the oldest lines are discarded so the map does not grow
 * without bound during long-running sessions.  The Firestore flush keeps
 * its own cap of 500 lines — this in-memory cap is intentionally larger
 * so the TUI can still display a useful amount of recent history.
 */
const MAX_MEMORY_LOG_LINES = 5000;

/**
 * Build the shared state object for one orchestrator instance.
 *
 * @param {object} opts
 * @param {number} opts.maxWorkers   Initial pool size from the operator's config.
 */
export function createOrchestratorState({ maxWorkers }) {
  return {
    // ── Worker / queue collections (mutated in place) ────────────────
    /** @type {Map<string, { projectId, ticketId, worktreeDir, ac, sessionId, startedAt, phase }>} */
    activeWorkers: new Map(),
    /** @type {Array<{ docId, ticketId, projectId, error, timestamp }>} */
    recentErrors: [],
    /** @type {Map<string, { projectId, ticketId, worktreeDir, sessionId, question, unsubscribe }>} */
    pausedWorkers: new Map(),
    /** @type {Array<{ docId, ticketId, title, projectId }>} */
    queue: [],
    /** @type {Map<string, { ticketId, title, projectId }>} */
    ticketInfoCache: new Map(),
    /** @type {Map<string, string[]>} docId -> log lines */
    workerLogs: new Map(),

    // ── Listener / project bookkeeping ───────────────────────────────
    /** Listener unsubscribe functions */
    listenerUnsubs: [],
    /** Set of project IDs that already have Firestore listeners registered */
    registeredProjectIds: new Set(),
    /** Tickets currently being claimed (between queue.shift and activeWorkers.set) */
    claimingTickets: new Set(),
    /** Ticket services per project */
    ticketServices: new Map(),

    // ── Cross-cutting helpers ────────────────────────────────────────
    /** Merge queue manager */
    mergeQueueManager: createMergeQueueManager(),

    /** Maximum allowed value for maxWorkers — guards against runaway values from Firestore */
    MAX_WORKERS_LIMIT,

    /** Mutable config — shared with dashboard for live updates */
    config: { maxWorkers },

    /** Maintenance worker status — updated via Firestore listener */
    maintenanceStatus: null,

    /** Advisor persona state — updated via Firestore listener (if advisor is running) */
    advisorPersonaState: {}, // personaId -> Firestore doc data

    /** Shutdown flag */
    shuttingDown: false,

    // ── Maintenance scheduling ───────────────────────────────────────
    maintenanceTimer: null,
    maintenanceRunning: false,
    /**
     * Set to true when a maintenance run is requested while one is already running.
     * The current run will start another pass immediately when it finishes, so that
     * blocked tickets and "Run Now" clicks are never silently dropped.
     */
    pendingMaintenanceAfterCurrent: false,
    /** Debounce timer for blocked-ticket-triggered maintenance */
    blockedMaintenanceTimer: null,

    // ── Usage monitor / model fallback ───────────────────────────────
    /** Saved maxWorkers before a usage-triggered pause */
    savedMaxWorkers: null,
    /** Whether workers are currently using the fallback (Haiku) model due to Sonnet limit */
    usingFallbackModel: false,
    /**
     * Non-Sonnet mode — when true, Sonnet is paused and workers start with haiku.
     * If a worker determines the task is too complex, it can set requestUpgrade=true
     * on the ticket and the orchestrator will restart it with the upgradeModel (opus).
     * Toggled via the 'sonnetPaused' field in orchestrator/config Firestore doc.
     */
    nonSonnetMode: false,
    /**
     * Model used to upgrade a haiku worker when it signals task complexity.
     * Defaults to opus when sonnet is paused.
     */
    upgradeModel: 'claude-opus-4-5',

    // ── Firestore config snapshot bookkeeping ────────────────────────
    /** Last seen manualTrigger value from Firestore config */
    lastSeenManualTrigger: null,
    /** Last seen killSignal value from Firestore config */
    lastSeenKillSignal: null,
    /** Last seen promoteCanary values per project */
    lastSeenPromoteCanary: {}, // projectId -> last seen timestamp string

    // ── Worker spawn pacing ──────────────────────────────────────────
    /** Time (ms since epoch) when the last worker was spawned */
    lastSpawnTime: 0,
    /** Timer handle for a pending staggered dequeue */
    staggerTimer: null,

    // ── Heartbeat ────────────────────────────────────────────────────
    heartbeatTimer: null,
    HEARTBEAT_INTERVAL_MS,

    // ── Log flushing ─────────────────────────────────────────────────
    /** @type {Map<string, number>} docId -> number of lines already flushed */
    workerLogFlushedCount: new Map(),
    /** @type {Map<string, ReturnType<typeof setTimeout>>} docId -> pending flush timer */
    workerLogFlushTimers: new Map(),
    MAX_MEMORY_LOG_LINES,

    // ── Render debounce ──────────────────────────────────────────────
    renderTimer: null,
  };
}
