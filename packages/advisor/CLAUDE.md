# @docket/advisor

AI personas (Engineer, Design, Product) that autonomously create and score tickets. Runs embedded inside the orchestrator process.

## Key Files

| File | Purpose |
|------|---------|
| `src/engineer.js` | Engineer persona — reviews code, proposes tech debt / bug fix tickets |
| `src/design.js` | Design persona — reviews UI, proposes UX improvement tickets |
| `src/product.js` | Product persona — reviews app flows, proposes feature tickets |
| `src/start-advisor.js` | Entry point — boots persona loops, wires up Firestore listeners |
| `src/claude.js` | Thin wrapper around Claude SDK for persona queries |
| `src/state.js` | Persists persona state (last run, cooldown) to Firestore |
| `src/dedup.js` | Prevents duplicate ticket proposals from the same persona |
| `src/scoreProposal.js` | Scores a proposal for priority/relevance |
| `src/rejection-history.js` | Tracks rejected proposals so personas learn from feedback |
| `src/run-logger.js` | Writes persona activity logs to Firestore |
| `src/custom-persona.js` | Plugin interface for user-defined personas |
| `bin/advisor.js` | Standalone CLI entry (rarely used — normally embedded in orchestrator) |

## Persona Loop

Each persona runs on a configurable interval (`intervalHours` in config). On each cycle:
1. Reads relevant code/UI via scan paths
2. Generates proposals using Claude
3. Deduplicates against recent tickets
4. Scores proposals
5. If `reviewGate: true` in config, creates tickets in `proposed` state for user approval
6. If `reviewGate: false`, creates tickets directly in `open` state

## Config (docket.config.json → advisor section)

```json
{
  "advisor": {
    "engineer": { "intervalHours": 12, "reviewGate": true, "model": "claude-haiku-4-5-20251001" },
    "design":   { "intervalHours": 8,  "reviewGate": true },
    "product":  { "intervalHours": 24, "reviewGate": true },
    "projects": {
      "docket": {
        "repoPath": "/path/to/docket",
        "scanPaths": ["packages/core/src", "packages/orchestrator/src", "web/src"],
        "appUrl": "https://your-username.github.io/projects/docket/",
        "appFlows": ["/", "/settings", "/admin"]
      }
    }
  }
}
```

## Notes

- Changes to advisor config require an orchestrator restart to take effect.
- Persona cooldown is 2 minutes between cycles by default (prevents runaway loops on restart).
- The `scanPaths` for each project control which source files the persona reads — keep these focused to reduce token usage.
- Do not add heavyweight operations (file system walks, large reads) inside persona loops — they run frequently.

## appUrl / appFlows Configuration

**`appUrl`** must be the full base URL including any path prefix:
```
"appUrl": "https://your-username.github.io/projects/docket/"
```

**`appFlows`** must be paths **relative to the app root** — NOT including the deployment prefix:
```
"appFlows": ["/", "/settings", "/admin"]
```

Do NOT repeat the deployment prefix in `appFlows`. The base path from `appUrl` is automatically
prepended by `resolveUrl`. Setting `"appFlows": ["/projects/docket/"]` when `appUrl` already
contains `/projects/docket/` will produce doubled URLs like `.../projects/docket/projects/docket/`.
