Run through this pre-completion checklist before marking any ticket done. Work through each item in order and fix any issues found before proceeding.

## 1. Check deploy scripts are clean

Read `web/package.json` and verify the `deploy`, `deploy:canary`, and `promote:canary` scripts do NOT contain `firebase deploy --only firestore`. That line belongs only in `deploy:rules` and must not appear in the other scripts.

If you find it, remove it from the affected scripts. This is a recurring mistake — always check.

## 2. Verify no changes to dist/

Check that you have not modified any files under `web/dist/`. That directory is gitignored and rebuilt by webpack — edits there are lost on every build.

Run: `git diff --name-only` and confirm no `web/dist/` files appear.

If you edited `web/dist/index.html` thinking it would affect the version display or cache buster, you need to edit `web/src/index.html` instead (or leave it to the deploy pipeline, which handles it automatically).

## 3. All changes are committed

Run `git status` and confirm the working tree is clean. If there are uncommitted changes, commit them now with a clear message describing what changed.

## 4. Rebase onto latest master

Run:
```bash
git fetch origin && git rebase origin/master
```

Resolve any conflicts before proceeding. If the rebase fails and you cannot resolve it, report a blocker instead of marking done.

## 5. Check for obvious regressions

If you changed anything in `web/package.json` scripts or `packages/orchestrator/src/deploy.js`, re-read those files now and confirm they look correct.

## 6. Mark done

Once all items above pass:
```bash
npx @docket/cli update <TICKET-ID> --project <PROJECT-ID> --status done --note "brief summary of what changed"
```
