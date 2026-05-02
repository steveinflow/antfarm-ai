# @docket/cli

Command-line tool for ticket management. Used by both humans and worker agents.

## Commands

```bash
npx @docket/cli add --project <id> --title "..." [--description "..."] [--type bug|feature|chore]
npx @docket/cli update <ticketId> --project <id> --status <status> [--note "..."] [--question "..."] [--wip '{...}']
npx @docket/cli list --project <id> [--status open]
npx @docket/cli done <ticketId> --project <id>
npx @docket/cli projects
```

## Key Files

| File | Purpose |
|------|---------|
| `bin/tickets.js` | CLI entry point, routes to subcommands |
| `src/config.js` | Reads Firebase config + userId from environment or config file |
| `src/commands/add.js` | Create a new ticket |
| `src/commands/update.js` | Update status, add note, save WIP, ask question |
| `src/commands/list.js` | List tickets (filterable by status) |
| `src/commands/done.js` | Mark a ticket done (shorthand) |
| `src/commands/init.js` | Interactive setup for new projects |
| `src/commands/scaffold.js` | Scaffold new docket config |

## WIP Format

When saving work-in-progress state, pass JSON to `--wip`:

```bash
npx @docket/cli update DK-123 --project docket --wip '{
  "goal": "what you are trying to achieve",
  "plan": ["step 1", "step 2"],
  "progress": ["completed items"],
  "discoveries": ["important findings"],
  "roadblocks": ["what is blocking you"]
}'
```

Always include `--wip` when setting status to `waiting_for_user`.

## Agent Usage Pattern

```bash
# Post a progress note (do this often so the user can see activity)
npx @docket/cli update DK-123 --project docket --note "Found the bug in orchestrator.js line 145"

# Ask the user a question and pause
npx @docket/cli update DK-123 --project docket --status waiting_for_user \
  --question "Should I use X or Y approach?" \
  --wip '{"goal":"...","progress":["..."]}'

# Mark done (orchestrator handles merge + deploy automatically)
npx @docket/cli update DK-123 --project docket --status done --note "Fixed the stagger bug"

# Report a blocker
npx @docket/cli update DK-123 --project docket --status blocked \
  --note "Cannot merge — conflict in web/src/index.html that I cannot resolve"
```
