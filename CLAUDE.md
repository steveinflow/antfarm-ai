# Docket — Agent Guide

You are working in an isolated git worktree. Your cwd IS the repo root for this worktree. Use relative paths. Do not touch files outside this directory.

## Package Map

| Package | Purpose |
|---------|---------|
| `packages/core` | Shared services: `TicketService`, `ProjectService`, status machine (`STATUSES`, `VALID_TRANSITIONS`) |
| `packages/orchestrator` | Main daemon: worker pool, merge queue, deploy pipeline, maintenance worker |
| `packages/advisor` | AI personas (engineer/design/product) that create tickets |
| `packages/cli` | `docket` CLI for ticket operations (`add`, `update`, `list`, `done`) |
| `packages/admin-panel` | Admin UI bundle (esbuild → `dist/`) |
| `web` | React/webpack frontend, deployed to the path configured by `DOCKET_DEPLOY_TARGET` (e.g. `your-username.github.io/projects/docket/`) |

## Status Machine

```
proposed → open → in_progress → done
                             → blocked (merge/deploy failed — maintenance retries)
                             → waiting_for_user (you asked a question)
in_maintenance → done | blocked | open
done → open (reopened)
```

## Completing a Ticket

1. Commit all changes with a clear message.
2. Rebase onto latest master:
   ```bash
   git fetch origin && git rebase origin/master
   ```
3. Run `/preflight` to verify nothing is broken.
4. Mark done:
   ```bash
   npx @docket/cli update <TICKET-ID> --project <PROJECT-ID> --status done --note "summary"
   ```

## Version Bumping — Rules

- **Source of truth:** `web/package.json` → `version` field (patch increments: `0.4.235` → `0.4.236`)
- **Edit `web/src/index.html`** — NOT `web/dist/index.html` (dist/ is gitignored, rebuilt by webpack)
- Two patterns to update in `src/index.html`:
  - Version text: `>v0.4.235<` → `>v0.4.236<`
  - Cache buster: `bundle.js?v=245` → `bundle.js?v=246`
- All packages in `versionPaths` get the same version: `web/`, `packages/admin-panel/`, `packages/cli/`, `packages/core/`, `packages/orchestrator/`
- The orchestrator's `deploy.js` handles this automatically after merge — **you do not bump versions manually**

## Deploy Rules — What NOT To Do

- **Never add `firebase deploy --only firestore` to `web/package.json` deploy scripts.** It does not belong there. Firestore rules are deployed separately via `firestoreRulesCommand` after promotion, not as part of every deploy.
- **Never edit `web/dist/`** — it is gitignored and rebuilt every deploy. Changes will be lost.
- **Never edit `dist/index.html`** — only `src/index.html` persists.
- **Do not run `npm run deploy` or `npm run deploy:canary` manually** from a worktree. The orchestrator handles deploys after merge.
- **Do not push from a worktree.** The merge queue pushes after merge.

## Deploy Flow (for reference)

After you mark a ticket done, the orchestrator:
1. Merges your branch into master
2. Bumps version in all versionPaths + updates `src/index.html`
3. Runs `npm run deploy:canary` (deploys to docket-canary, not release)
4. Updates `liveVersion` in Firestore, marks ticket done with `deployedVersion`

Promotion from canary → release is a separate manual step via the web UI.

## Key Files to Read First

For orchestrator changes: `packages/orchestrator/src/orchestrator.js`, `worker.js`, `deploy.js`
For deploy pipeline: `packages/orchestrator/src/deploy.js`, `web/package.json` scripts
For ticket state: `packages/core/src/statuses.js`
For web UI: `web/src/index.js`, `web/src/index.html`
For advisor personas: `packages/advisor/src/engineer.js`, `design.js`, `product.js`
