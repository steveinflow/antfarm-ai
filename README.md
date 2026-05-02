# Docket

A self-hosted ticket system where AI agents propose, work, and ship tickets autonomously.

Two swarms of Claude agents on opposite sides of the same backlog: one **proposes** tickets by auditing source code, screenshots, and product surface area. The other **completes** them — each in an isolated git worktree, merged through a queue, deployed via canary, all visible in real time through a Firestore-backed UI.

I built this as a tool for shipping side projects without having to write tickets myself or babysit a queue of agents. It's published here as a portfolio piece.

---

## What it actually does

A typical day in the life of a ticket:

1. The **advisor** daemon wakes up. The Engineer persona scans your source for security and complexity issues. The Design persona drives Playwright through your app's flows and asks Claude Vision what's wrong with the UX. The Product persona generates feature ideas grounded in a project description, then runs them past the Engineer and Design personas for a consensus review.
2. Surviving proposals land in Firestore as `proposed` tickets. You triage them in the web UI — accept, reject, or edit.
3. Accepted tickets become `open`. The **orchestrator** daemon picks one up, creates a git worktree at `.claude/worktrees/{ticketId}/`, spawns a Claude Code agent with a tailored prompt, and lets it work.
4. The agent commits, rebases onto `master`, runs preflight checks, and marks the ticket `done` via the CLI.
5. The orchestrator merges through a per-repo queue (so version bumps don't collide), bumps the version everywhere, runs `npm run deploy:canary`, and records the deployed version on the ticket.
6. You promote canary → release with a button click in the UI.

If a worker gets stuck, it can ask a question and pause (`waiting_for_user`). If a merge or deploy fails, the maintenance worker retries the post-merge pipeline on a schedule. If the orchestrator dies mid-flight, on restart it reclaims orphaned `in_progress` tickets and re-spawns workers.

---

## Architecture

```
┌──────────────────┐                        ┌──────────────────┐
│   advisor        │   proposes tickets →   │                  │
│   (engineer,     │  ───────────────────▶  │                  │
│    design,       │                        │                  │
│    product,      │                        │    Firestore     │
│    custom...)    │                        │   (source of     │
└──────────────────┘                        │     truth)       │
                                            │                  │
┌──────────────────┐                        │                  │
│   orchestrator   │   claims → works →     │                  │
│   (worker pool,  │   merges → deploys →   │                  │
│    merge queue,  │  ◀───────────────────▶ │                  │
│    deploy        │                        │                  │
│    pipeline,     │                        │                  │
│    maintenance)  │                        └──────────────────┘
└──────────────────┘                                ▲   │
                                                    │   ▼
                                            ┌──────────────────┐
                                            │   web UI         │
                                            │   (React,        │
                                            │   real-time      │
                                            │   listeners)     │
                                            └──────────────────┘
```

| Package | Purpose |
|---|---|
| `packages/core` | `TicketService`, `ProjectService`, status state machine |
| `packages/orchestrator` | Daemon — worker pool, merge queue, deploy pipeline, maintenance worker |
| `packages/advisor` | Daemon — AI personas that propose tickets on a schedule |
| `packages/cli` | The `docket` CLI used by both humans and worker agents |
| `packages/admin-panel` | Embeddable admin UI bundle (esbuild) |
| `web/` | React/webpack frontend |

---

## What I think is interesting about it

**Producer/consumer split with two AI swarms.** Most "AI on tickets" tools are one-sided — either an AI works your tickets, or an AI helps you write them. Docket runs both sides as independent daemons that meet in Firestore, so the backlog is always growing on its own and always being drawn down on its own. Each persona has its own loop, its own model, its own scoping rules.

**Worktree isolation.** Every worker gets a fresh git worktree at `.claude/worktrees/{ticketId}/`. Multiple agents can work in parallel on the same repo without stepping on each other, and the working tree on `master` is never touched by an agent. Merges go through a queue so version bumps serialize cleanly.

**Live config via Firestore.** Most things you'd want to tune at runtime — `intervalHours` per persona, max workers, `runNow` triggers, soul prompts, maintenance status — are read from Firestore on every cycle. The web UI is just a Firestore client. No restart needed for most knob-twiddling.

**Custom personas with declarative scoping.** You can define new advisor personas in `docket.config.json` (or live in Firestore) with a system prompt, focus areas, model choice, and an optional project allowlist. The same scoring/dedup/consensus pipeline runs for built-in and custom personas alike.

**Consensus gate.** When the Product persona generates a feature idea, it doesn't just write the ticket — it asks the Design persona to UX-review it and the Engineer persona to security/complexity-review it. Both have to endorse before it lands. The endorsements end up on the ticket as a paper trail.

**Scoped Claude tool use.** The Engineer persona reads source via a sandboxed file scanner (`files.js`) — no shell exec, no file writes outside the worktree, max files per cycle, max bytes per file. The Design persona's Playwright session strips auth/token/session/csrf cookies before screenshots are sent to the vision model.

---

## Tech

- **Node.js** (ES modules throughout, no TypeScript)
- **Firebase Admin** v13 server-side, **Client SDK** v9.6 in the browser
- **`@anthropic-ai/claude-agent-sdk`** `query()` driving worker agents — uses Max-subscription OAuth, not API credits
- **Default models:** `claude-sonnet-4-6` for workers, `claude-haiku-4-5` for high-volume scans, `claude-opus-4-6` for ideation
- **Playwright** headless Chromium for the visual personas
- **Webpack** + **esbuild** for the frontend bundles
- Static hosting via GitHub Pages (or anywhere you can rsync to — see `DOCKET_DEPLOY_TARGET`)

---

## Quick start

You'll need: Node 20+, a Firebase project (Firestore + Auth + Hosting enabled), an Anthropic Claude account with Max subscription (for OAuth) or API key, and a target directory for static hosting.

```bash
git clone <your-fork-url> docket
cd docket
npm install

# Copy and fill in the example configs
cp docket.config.example.json docket.config.json
cp serviceAccountKey.example.json serviceAccountKey.json   # then paste your real Firebase admin SDK key

# Set up Claude OAuth (Max subscription) or API key
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=<token from setup-token>

# Set the deploy target if you'll use the deploy pipeline
export DOCKET_DEPLOY_TARGET=/absolute/path/to/your-pages-repo

# Run the orchestrator (this also starts the advisor in-process)
npm start
```

Detailed setup — Firebase config, Firestore rules, deploying the web UI, configuring the advisor — is in [`ONBOARDING.md`](ONBOARDING.md).

The repo-wide agent guide for working in this codebase is [`CLAUDE.md`](CLAUDE.md). Each package has its own `CLAUDE.md` with package-specific notes.

---

## Status

This started as a personal tool and is published as-is. Things to know before forking:

- The deploy pipeline assumes you have a separate git repo backing your static hosting (GitHub Pages style). Configure it via `DOCKET_DEPLOY_TARGET` and `config.deploy.{pagesBaseUrl,pagesRepoPath}`. If you're hosting somewhere else (Vercel, Netlify, S3), you'll need to swap out the deploy scripts in `web/package.json` and the bootstrap logic in `packages/orchestrator/src/orchestrator.js`.
- There's no test suite. The maintenance worker and preflight checks substitute for some of what tests would catch, but you should expect to read code to understand behavior.
- The web UI ships as a single bundle deployed to a static host — there's no server-side rendering. Hash-based routing is used so direct URLs survive GitHub Pages' lack of rewrite rules.
- Firestore is the source of truth for everything mutable. If you don't want a Firebase dependency, the data layer in `packages/core` is small enough to swap for something else, but the web UI's real-time listeners would need a different transport.

---

## License

MIT — see [`LICENSE`](LICENSE).
