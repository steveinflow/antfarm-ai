# Onboarding a New Project onto Docket

This guide walks through everything needed to add a new project to the docket ticketing system — from Firebase credentials to the orchestrator picking up tickets automatically.

---

## Quick Start — Scaffold from a Single Prompt

The fastest way to create a new project is the `scaffold` command. It uses Claude AI to derive project metadata from a plain-English description and registers everything in one step:

```bash
npx @docket/cli scaffold "A markdown blog editor with live preview"
```

Claude will propose an id, prefix, and name — then register the project in Firestore and add it to `docket.config.json` automatically. You can override any field:

```bash
npx @docket/cli scaffold "E-commerce store" \
  --id shop \
  --prefix SH \
  --name "My Shop" \
  --repo-path /path/to/repo \
  --admin-email me@example.com
```

Use `--dry-run` to preview what would be created without making any changes.

Once scaffolded, continue from [Step 3](#step-3--set-up-the-git-repository) below.

---

## Manual Setup

The steps below walk through the full manual setup process.

---

## Overview

Docket has two layers of "project registration":

1. **Firestore** — the project document (`projects/{id}`) that the web UI and ticket system use
2. **`docket.config.json`** — local config that tells the orchestrator and advisor where the code lives and how to deploy

Both layers are required for full orchestrator support (AI-powered ticket solving). Firestore alone is sufficient for manual ticket management via the CLI or web UI.

---

## Prerequisites

- Node.js 18+
- A Firebase service account key (`serviceAccountKey.json`) for your Firebase project
- The docket repo cloned locally
- `npm install` run at the root

---

## Step 1 — Register the Project in Firestore

Use the CLI to create the Firestore project document. This is required for any ticket operations.

```bash
npx @docket/cli projects add \
  --id <project-id> \
  --prefix <PREFIX> \
  --name "<Human Readable Name>" \
  [--repo-path /absolute/path/to/repo] \
  [--admin-email you@example.com]
```

**Field rules:**
- `--id` — unique slug, used in ticket IDs (e.g. `blog-editor`)
- `--prefix` — 2–4 uppercase letters, used in ticket IDs (e.g. `BE`). Must be unique across all projects.
- `--name` — display name shown in the web UI
- `--repo-path` — (optional) absolute path to the project repo on the orchestrator's machine
- `--admin-email` — (optional) Google email that gets admin access in the web UI

**Example:**
```bash
npx @docket/cli projects add \
  --id blog-editor \
  --prefix BE \
  --name "Blog Editor" \
  --repo-path /Users/me/dev/blog-editor \
  --admin-email me@example.com
```

Verify the project was created:
```bash
npx @docket/cli projects list
```

---

## Step 2 — Add the Project to `docket.config.json`

The orchestrator reads project settings from `docket.config.json`. Without this, the orchestrator won't watch for or execute tickets in the new project.

Open `docket.config.json` and add an entry under `projects`:

```json
{
  "projects": {
    "blog-editor": {
      "repoPath": "/Users/me/dev/blog-editor",
      "autoDeploy": true,
      "deployCommand": "npm run deploy",
      "canaryDeployCommand": "npm run deploy:canary",
      "promoteCommand": "npm run promote:canary"
    }
  }
}
```

When `canaryDeployCommand` is set, the orchestrator deploys to a canary/staging URL on each merge instead of production. Use the **Promote to Release** button in the Docket UI (or run `promoteCommand` directly) to push the canary build to production.

Add the canary npm scripts to the project's `package.json`:
```json
{
  "scripts": {
    "deploy:canary": "npm run build && rsync -av --delete dist/ \"$DOCKET_DEPLOY_TARGET\"/projects/my-app-canary/ && (cd \"$DOCKET_DEPLOY_TARGET\" && git add projects/my-app-canary && (git diff --cached --quiet || git commit -m 'Deploy my-app canary') && git push origin master) && git push origin master",
    "promote:canary": "rsync -av --delete \"$DOCKET_DEPLOY_TARGET\"/projects/my-app-canary/ \"$DOCKET_DEPLOY_TARGET\"/projects/my-app/ && (cd \"$DOCKET_DEPLOY_TARGET\" && git add projects/my-app && (git diff --cached --quiet || git commit -m 'Promote my-app canary to release') && git push origin master)"
  }
}
```

### Common project config fields

| Field | Required | Description |
|-------|----------|-------------|
| `repoPath` | Yes (for orchestrator) | Absolute path to the project git repo |
| `autoDeploy` | No | Whether the orchestrator should run the deploy command after merging |
| `deployCommand` | No | Shell command to run for deployment (e.g. `npm run deploy`) |
| `canaryDeployCommand` | No | Command for canary/staging deploys |
| `promoteCommand` | No | Command to promote canary to production |
| `versionPaths` | No | Array of directories to bump versions in (for monorepos) |
| `versionFiles` | No | Array of specific files to bump versions in |
| `webDir` | No | Sub-directory where the web build lives (for version detection) |
| `dependents` | No | Array of project IDs to also deploy after this one |

### Minimal config for orchestrator (no auto-deploy)
```json
{
  "projects": {
    "my-project": {
      "repoPath": "/Users/me/dev/my-project"
    }
  }
}
```

---

## Step 3 — Set Up the Git Repository

The orchestrator creates git worktrees to isolate each ticket's work. The project repo must:

1. **Be a git repository** (`git init` or cloned from remote)
2. **Have a `main` or `master` branch** (workers rebase onto `origin/main` before marking tickets done)
3. **Have a remote configured** (`git remote add origin <url>`) so workers can push branches

```bash
cd /path/to/your-project
git init
git remote add origin git@github.com:you/your-project.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

---

## Step 4 — (Optional) Enable the Advisor

The advisor personas (Engineer, Design, Product) automatically propose tickets based on code analysis and UI audits. To enable them for your new project, you need to:

### 4a. Set `advisorContext` on the project document

The `advisorContext` field is a short description of the project that the advisor uses to generate relevant tickets. Projects without `advisorContext` are skipped by the advisor.

Set it in the web UI: open the **Advisor** panel → **Projects** section → find your project and edit the context text box. Save it there.

**Example `advisorContext`:**
```
Blog Editor is a browser-based markdown editor for writing and publishing blog posts.
It uses a custom lexer/parser for markdown rendering, Firebase for auth and storage,
and deploys to GitHub Pages. Users expect a distraction-free writing experience with
live preview, auto-save, and one-click publish. Known pain points: slow initial load,
no offline support, mobile editing is clunky.
```

### 4b. Add advisor config to `docket.config.json`

Under the `advisor.projects` section, add per-project settings:

```json
{
  "advisor": {
    "engineer": {
      "intervalHours": 12,
      "reviewGate": true
    },
    "design": {
      "intervalHours": 8,
      "reviewGate": true
    },
    "product": {
      "intervalHours": 24,
      "reviewGate": true
    },
    "projects": {
      "blog-editor": {
        "repoPath": "/Users/me/dev/blog-editor",
        "scanPaths": ["src", "lib"],
        "appUrl": "https://me.github.io/blog-editor/",
        "appFlows": ["/blog-editor/"]
      }
    }
  }
}
```

**Advisor project fields:**

| Field | Personas | Description |
|-------|----------|-------------|
| `repoPath` | Engineer, Product | Absolute path to the project repo (for code scanning) |
| `scanPaths` | Engineer, Product | Array of directories to scan (relative to `repoPath`) |
| `appUrl` | Design | Full URL to the live app (for Playwright screenshot audits) |
| `appFlows` | Design | Array of URL paths to navigate during UI audits |

---

## Step 5 — Initialize the Docket Panel in the App (Optional)

If your project has an HTML file (e.g. a single-page app), you can embed the docket admin panel directly in it. This lets users file tickets without leaving the app.

```bash
npx @docket/cli init path/to/your/app.html \
  --id blog-editor \
  --prefix BE \
  --name "Blog Editor" \
  --admin-email you@example.com
```

This command:
1. Registers the project in Firestore (if not already done)
2. Copies `admin-panel.min.js` next to the HTML file
3. Injects a floating action button (FAB), drawer UI, and Firebase initialization into the HTML

The injected panel uses Google Auth. Users click the pencil icon (✎) to open the ticket drawer.

> **Note:** The HTML file must be served over HTTP(S) — Firebase auth does not work on `file://` protocol.

---

## Step 6 — Restart the Orchestrator

After editing `docket.config.json`, restart the orchestrator so it picks up the new project:

```bash
npm start
# or:
npx docket-orchestrator --config ./docket.config.json
```

The orchestrator will log:
```
[orchestrator] Listening on blog-editor
```

---

## Step 7 — Create Your First Ticket

Test the setup by creating a ticket in the new project:

```bash
npx @docket/cli add \
  --project blog-editor \
  --type feature \
  "Hello world — first ticket"
```

Then open it for the orchestrator to pick up:

```bash
npx @docket/cli update BE-001 --project blog-editor --status open
```

Or use the web UI to set the ticket to **Open**.

The orchestrator should pick it up within seconds and start working on it.

---

## Full `docket.config.json` Example

```json
{
  "firebaseKeyPath": "./serviceAccountKey.json",
  "defaults": {
    "userId": "your-firebase-uid-here"
  },
  "projects": {
    "blog-editor": {
      "repoPath": "/Users/me/dev/blog-editor",
      "autoDeploy": true,
      "deployCommand": "npm run deploy",
      "canaryDeployCommand": "npm run deploy:canary",
      "promoteCommand": "npm run promote:canary",
      "versionFiles": ["editor.html"]
    }
  },
  "orchestrator": {
    "maxWorkers": 4,
    "model": "claude-sonnet-4-6"
  },
  "advisor": {
    "engineer": {
      "intervalHours": 12,
      "reviewGate": true
    },
    "design": {
      "intervalHours": 8,
      "reviewGate": true
    },
    "product": {
      "intervalHours": 24,
      "reviewGate": true
    },
    "projects": {
      "blog-editor": {
        "repoPath": "/Users/me/dev/blog-editor",
        "scanPaths": ["src"],
        "appUrl": "https://me.github.io/blog-editor/",
        "appFlows": ["/blog-editor/"]
      }
    }
  }
}
```

---

## Troubleshooting

### Orchestrator doesn't pick up tickets
- Confirm the project is in `docket.config.json` under `"projects"` (not just in Firestore)
- Confirm `repoPath` is correct and the repo exists
- Confirm the git repo has a `main` branch and a remote configured
- Check the orchestrator logs (press `t` in the TUI to see active workers)

### "Prefix already used" error
Each project prefix must be unique. Run `npx @docket/cli projects list` to see existing prefixes.

### Worker creates worktree but fails immediately
- Ensure the repo at `repoPath` is a valid git repo (`git rev-parse --is-inside-work-tree`)
- Ensure `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set in the orchestrator's environment

### Advisor doesn't propose tickets for my project
- The project must have a non-empty `advisorContext` field in its Firestore document
- The project must be listed under `advisor.projects` in `docket.config.json` with at least `repoPath` (for Engineer/Product) or `appUrl` (for Design)

### `docket init` fails with "admin-panel.min.js not found"
Run `npm run build` in `packages/admin-panel` first to produce the built file.
