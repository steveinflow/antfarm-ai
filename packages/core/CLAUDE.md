# @docket/core

Shared library used by all other packages. Contains the ticket/project services, status machine, and utilities.

## Key Files

| File | Purpose |
|------|---------|
| `src/statuses.js` | **Status machine:** `STATUSES`, `VALID_TRANSITIONS`, `isValidTransition()`, `statusLabel()` |
| `src/ticket-service.js` | `TicketService` — Firestore CRUD for tickets |
| `src/project-service.js` | `ProjectService` — project metadata |
| `src/cluster-service.js` | `ClusterService` — ticket clustering/grouping |
| `src/feedback-service.js` | `FeedbackService` — user feedback on advisor proposals |
| `src/validate.js` | Input validation helpers |
| `src/format.js` | Formatting utilities (ticket display, dates) |
| `src/index.js` | Re-exports all public API |

## Status Machine

All ticket transitions are governed by `VALID_TRANSITIONS` in `statuses.js`. The state machine is enforced both in code and in Firestore security rules.

**Do not** bypass `isValidTransition()` to force a status change — this will likely fail at the Firestore rules layer anyway. If a ticket is stuck, step through valid transitions using the CLI or a migration script.

Valid transitions (abridged):
```
open → in_progress
in_progress → done | blocked | waiting_for_user
blocked → open | in_progress | in_maintenance
in_maintenance → done | blocked | open
waiting_for_user → in_progress | open
done → open | verified
```

## Adding to Core

- Keep services stateless where possible — they receive `db` as a constructor argument.
- New status values require updating `STATUSES`, `VALID_TRANSITIONS`, and the Firestore security rules (`firestore.rules` at repo root). Deploy rules separately with `npm run deploy:rules` in `web/`.
- Exported names in `index.js` are part of the public API — all other packages import from `@docket/core`.
