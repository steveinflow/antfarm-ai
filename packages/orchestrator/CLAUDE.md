# @docket/orchestrator

Node.js daemon that manages the ticket worker pool, merge queue, and deploy pipeline.

## Key Files

| File | Purpose |
|------|---------|
| `src/orchestrator.js` | Main daemon — Firestore listeners, worker pool, stagger, maintenance scheduling |
| `src/worker.js` | Runs a Claude agent SDK session in a worktree; manages idle timeout and heartbeat |
| `src/deploy.js` | Post-merge version bump and deploy pipeline; canary promotion |
| `src/merge-queue.js` | Serialises merges per-repo so version bumps don't collide |
| `src/maintenance.js` | Repairs stuck `blocked`/`in_maintenance` tickets |
| `src/worktree.js` | Creates/reuses git worktrees at `.claude/worktrees/{ticketId}` |
| `src/prompt-builder.js` | Builds the initial prompt sent to each worker agent |
| `src/prompt-sanitizer.js` | Sanitizes all Firestore-sourced data before it enters prompts |
| `bin/orchestrator.js` | CLI entry point — parses config, inits Firebase, starts daemon |
| `bin/maintenance.js` | Standalone maintenance runner (for manual one-off repair) |

## Orchestrator State

All mutable state lives inside `createOrchestrator()`:
- `activeWorkers` — Map of docId → worker state
- `queue` — pending ticket entries waiting for a free slot
- `pausedWorkers` — workers suspended pending user answer
- `config.maxWorkers` — live-adjustable, synced with Firestore
- `lastSpawnTime` / `staggerTimer` — enforce `workerStaggerMs` between spawns

## Worker Lifecycle

```
handleNewTicket() → enqueueWithPriority() → dequeueNext()
  → claimAndSpawn() → createWorktree() → runWorkerSession()
  → [agent does work] → merge-queue → postMergeDeploy()
  → ticket marked done
```

`dequeueNext()` enforces a minimum `workerStaggerMs` (default 10 s) between spawns using `lastSpawnTime` — this prevents rate-limit queuing when multiple tickets arrive together.

## deploy.js Invariants

- **Branch guard:** `postMergeDeploy` verifies `currentBranch === defaultBranch` before touching any version files. If this check fails, it throws — do not remove this guard.
- **Version source of truth:** reads from `web/package.json`, not orchestrator's own package.json.
- **HTML update:** regex-patches `src/index.html` (two patterns: version text + cache buster). Falls back to `dist/index.html` only if `src/` doesn't exist — prefer `src/`.
- **Deploy commands** run via `runDeployCommand()` which validates the executable against an allowlist and uses `execFileSync` (no shell). Never add shell metacharacters to deploy command strings.

## Config Options (docket.config.json → orchestrator section)

```json
{
  "maxWorkers": 4,
  "model": "claude-sonnet-4-6",
  "workerIdleTimeoutMs": 1800000,
  "workerStaggerMs": 10000,
  "maintenanceIntervalMs": 300000
}
```

## Maintenance

Maintenance runs every 5 minutes and:
1. Checks for `blocked`/`in_maintenance` tickets with a `limit(1)` query (cheap)
2. Only pauses active workers if there is actual work to do
3. Re-attempts merge + full `postMergeDeploy` for one ticket per pass
4. Requires the main repo to be on the default branch — no worktrees may have master checked out

Run manually:
```bash
node bin/maintenance.js --config ../../docket.config.json [--dry-run] [--project docket]
```

## Common Mistakes

- Do not modify `heartbeatInterval` below 60 s — saves ~4,320 writes/day.
- Do not call `publishStatus()` for internal phase transitions (claiming, merging) — it burns Firestore writes. Only publish status on terminal states.
- Do not add new direct Firestore reads inside `runScheduledMaintenance()` without first checking `maintenanceHasWork()`.
