# @docket/web

React/webpack frontend. Deployed to whatever static-hosting target is configured via `DOCKET_DEPLOY_TARGET` — for example `your-username.github.io/projects/docket/` (release) and `your-username.github.io/projects/docket-canary/` (canary).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.html` | **Edit this, not dist/.** Contains version string + cache buster. |
| `src/index.js` | App entry point, auto-reload banner detection, version polling |
| `src/404.html` | GitHub Pages SPA fallback — redirects unknown paths to the app root. |
| `src/sw.js` | Service worker — caches `version.json` for offline version detection |
| `src/styles.css` | Global styles |
| `webpack.config.js` | Build config: CopyHtmlPlugin, version.json writer, canary favicon swap |
| `package.json` | Deploy scripts — see rules below |
| `dist/` | **Gitignored. Do not edit.** Rebuilt by webpack on every deploy. |

## Version Pattern in src/index.html

Two things to update (deploy.js does this automatically — do not do it manually):

1. **Version display text** — regex `/(>v)[\d.]+(<)/g`:
   ```html
   <span>v0.4.235</span>  →  <span>v0.4.236</span>
   ```

2. **Cache buster** — regex `/(bundle\.js\?v=)(\d+)/`:
   ```html
   <script src="bundle.js?v=245">  →  <script src="bundle.js?v=246">
   ```

## Deploy Scripts in package.json

```
build           — webpack production build → dist/
build:canary    — DOCKET_ENV=canary webpack → dist/ (swaps favicon to orange)
deploy          — build + rsync dist/ → docket/ + git push
deploy:canary   — build:canary + rsync dist/ → docket-canary/ + git push
deploy:rules    — firebase deploy --only firestore (rules only, separate)
promote:canary  — rsync docket-canary/ → docket/ + git push (no rebuild)
```

## CRITICAL: What NOT To Do

- **Do not add `firebase deploy --only firestore` to `deploy`, `deploy:canary`, or `promote:canary` scripts.** Firestore rules are deployed separately via `deploy:rules` only. This line keeps getting added by mistake — check that it is NOT there.
- **Do not edit `dist/` files.** They are gitignored and overwritten by every build.
- **Do not run `npm run deploy` from a worktree.** The orchestrator's merge pipeline calls deploy commands after merge via the main repo, not from worktrees.
- **Do not bump versions manually** in `src/index.html` or `package.json`. The deploy pipeline (`deploy.js`) handles this.

## Canary vs Release

- Canary build: `DOCKET_ENV=canary` is set → webpack.config.js swaps the favicon to orange
- Canary URL: configured via `deploy.pagesBaseUrl` in `docket.config.json` (e.g. `https://your-username.github.io/projects/docket-canary/`)
- Release URL: same base, without the `-canary` suffix (e.g. `https://your-username.github.io/projects/docket/`)
- Post-merge deploys always go to **canary** (`canaryDeployCommand` in config)
- Promotion from canary → release is done via the "Promote to Release" button in the web UI (admin only, canary URL only)

## Routing — GitHub Pages SPA Constraint

Docket is deployed as a **static site on GitHub Pages**, which has no server-side rewrite support. This means:

- **Any direct URL or browser refresh** on a non-existent path returns `404.html` instead of `index.html`.
- **Hash-based routing** (`/#triage`) was chosen as the solution because hash fragments are client-only and never sent to the server — GitHub Pages never sees them, so hash routes work natively with zero server config.

### Files involved

| File | Role |
|------|------|
| `src/404.html` | Served by GitHub Pages on unknown paths. Finds the deployment root and redirects there (3 s countdown). The hash fragment is preserved across `location.replace()`, so `/#triage` links survive the redirect. |
| `src/index.js` | Reads `window.location.hash` on load to restore state (e.g. `#triage` → open triage panel). |

### If you add path-based routes in the future

If Docket ever adopts path-based client-side routing (React Router history mode, etc.), `src/404.html` will need to encode the current pathname + search string into a query parameter and `src/index.html` / `src/index.js` will need to read it back and call `history.replaceState`. See [rafgraph/spa-github-pages](https://github.com/rafgraph/spa-github-pages) for the canonical pattern.

## Development

```bash
npm run start    # webpack dev server with hot reload
npm run watch    # watch mode (no server)
npm run build    # production build to dist/
```
