Run a quick sanity check on the deploy scripts to catch common corruption issues.

## Check 1: firebase deploy in wrong scripts

Read `web/package.json` and look at the `scripts` section. The string `firebase deploy --only firestore` must appear ONLY in the `deploy:rules` script, never in `deploy`, `deploy:canary`, or `promote:canary`.

Report: PASS or FAIL with the exact script contents if failing.

## Check 2: src/index.html version patterns

Read `web/src/index.html` and verify:
- There is exactly one match for the pattern `>v\d+\.\d+\.\d+<` (the version display)
- There is exactly one match for the pattern `bundle\.js\?v=\d+` (the cache buster)

Report both values found (e.g., `v0.4.236`, `bundle.js?v=246`).

## Check 3: dist/ not tracked

Run `git ls-files web/dist/` and confirm no files from `web/dist/` are tracked by git. If any appear, they should not be committed.

## Check 4: Package versions in sync

Read `package.json` in each of these paths and confirm they all have the same `version` value:
- `web/package.json`
- `packages/core/package.json`
- `packages/orchestrator/package.json`
- `packages/cli/package.json`
- `packages/admin-panel/package.json`

Report any mismatches.

## Summary

Report overall PASS/FAIL for each check with a one-line explanation of any issues found.
