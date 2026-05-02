// Post-merge deploy — version bump, build, and deploy after a ticket branch is merged.
// Handles: package.json version bumps, dist/index.html version + cache buster, commit, deploy.
// Supports monorepos (multiple version paths, web subdirectory) and dependent project cascades.

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

/**
 * Validate that a config-supplied relative path resolves within the repository root.
 *
 * Protects against path traversal attacks where a malicious or misconfigured
 * projectConfig contains entries like "../../../etc/passwd" in versionFiles or
 * versionPaths.  Uses path.resolve() to collapse any ".." segments and then
 * checks that the resolved path starts with the canonical repoPath prefix.
 *
 * @param {string} repoPath  - Absolute path to the repository root
 * @param {string} relPath   - Relative path from projectConfig (e.g. a versionFiles entry)
 * @param {string} fieldName - Config field name (for error messages)
 * @returns {string} The resolved absolute path, guaranteed to be within repoPath
 * @throws {Error} If the resolved path escapes the repository boundary
 */
function validatePathWithinRepo(repoPath, relPath, fieldName) {
  if (typeof relPath !== 'string') {
    throw new Error(`[deploy] ${fieldName} entry must be a string, got ${typeof relPath}`);
  }

  // Resolve the canonical absolute path (collapses ".." segments)
  const canonicalRepo = resolve(repoPath);
  const resolvedPath = resolve(join(canonicalRepo, relPath));

  // The resolved path must start with the repo root followed by a separator
  // (or equal the repo root itself) to be considered within the boundary.
  const repoBoundary = canonicalRepo.endsWith('/') ? canonicalRepo : canonicalRepo + '/';
  if (resolvedPath !== canonicalRepo && !resolvedPath.startsWith(repoBoundary)) {
    throw new Error(
      `[deploy] Path traversal detected: "${relPath}" in ${fieldName} resolves to ` +
      `"${resolvedPath}", which is outside the repository root "${canonicalRepo}". ` +
      `Config paths must not contain ".." components that escape the repo boundary.`
    );
  }

  return resolvedPath;
}

/**
 * Allowlist of executable names permitted in deployCommand.
 * deployCommand is an admin-only config option and must never accept
 * untrusted / user-supplied input. This whitelist is a defence-in-depth
 * guard against config compromise or accidental misconfiguration.
 */
const ALLOWED_DEPLOY_EXECUTABLES = new Set([
  'npm', 'npx', 'yarn', 'pnpm',
  'node',
  'bash', 'sh',
  'make',
  'firebase',
  'vercel',
  'netlify',
  'docker', 'docker-compose',
  'kubectl',
  'aws',
  'gcloud',
  'az',
  'rsync',
  'scp',
]);

/**
 * Validate and safely execute a deploy command.
 *
 * Parses the command string into an executable + arguments array and runs it
 * via execFileSync (no shell spawning), which prevents shell meta-character
 * injection.  The executable must be on the ALLOWED_DEPLOY_EXECUTABLES list.
 *
 * @param {string} deployCommand  - The raw command string from projectConfig
 * @param {string} cwd            - Working directory for execution
 * @param {function} log          - Logger
 */
function runDeployCommand(deployCommand, cwd, log) {
  // Basic type guard
  if (typeof deployCommand !== 'string' || !deployCommand.trim()) {
    throw new Error('deployCommand must be a non-empty string');
  }

  // Split on whitespace into tokens (simple, no shell quoting support — deploy
  // commands should be simple enough not to require shell quoting).
  const tokens = deployCommand.trim().split(/\s+/);
  const executable = tokens[0];
  const args = tokens.slice(1);

  // Validate executable against the allowlist
  if (!ALLOWED_DEPLOY_EXECUTABLES.has(executable)) {
    throw new Error(
      `deployCommand executable "${executable}" is not in the allowed list. ` +
      `Permitted executables: ${[...ALLOWED_DEPLOY_EXECUTABLES].join(', ')}. ` +
      `deployCommand is an admin-only config option — never accept user-supplied values.`
    );
  }

  // Reject obvious shell injection attempts in the args (meta-characters that
  // only make sense in a shell context and have no place in a deploy command).
  const shellMetaRe = /[;&|`$<>(){}[\]\\!]/;
  for (const arg of args) {
    if (shellMetaRe.test(arg)) {
      throw new Error(
        `deployCommand argument "${arg}" contains a disallowed shell meta-character. ` +
        `deployCommand must not contain shell operators or substitutions.`
      );
    }
  }

  log(`[deploy] Running: ${executable} ${args.join(' ')}`);

  // execFileSync does NOT spawn a shell — the executable is invoked directly,
  // so shell meta-characters in args are treated as literal strings.
  execFileSync(executable, args, {
    cwd,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

/**
 * Run post-merge deploy pipeline for a project, then cascade to dependents.
 *
 * Config options (on projectConfig):
 *   autoDeploy            - Enable the pipeline
 *   deployCommand         - Shell command to build + deploy for release (run in webDir or repoPath)
 *   canaryDeployCommand   - Shell command to build + deploy the canary version (default: deployCommand)
 *   promoteCommand        - Shell command to promote canary to release
 *   firestoreRulesCommand - Optional command to deploy Firestore security rules (e.g. "firebase deploy --only firestore")
 *                           Run non-fatally after promoteCanary so rules stay in sync with production deploys.
 *                           Requires .firebaserc in the repo root with the Firebase project ID configured.
 *   versionPaths          - Array of relative dirs containing package.json to bump (default: ["."])
 *   webDir                - Subdirectory with dist/index.html (default: ".")
 *   versionFiles          - Array of relative file paths with >vX.Y.Z< version strings to update
 *   dependents            - Array of project IDs to cascade deploy to after this one
 *
 * @param {string} ticketId
 * @param {string} repoPath
 * @param {object} projectConfig
 * @param {function} log
 * @param {object} [allProjects] - Full projects map (for resolving dependents)
 * @returns {Promise<string|null>} The new version, or null if skipped
 */
export async function postMergeDeploy(ticketId, repoPath, projectConfig, log = console.log, allProjects = {}) {
  if (!projectConfig.autoDeploy) return null;

  log(`[deploy] Starting post-merge deploy for ${ticketId} in ${basename(repoPath)}`);

  // Guard: must be on the default branch before touching version files.
  // If the checkout failed earlier, this prevents version bumps from corrupting a ticket branch.
  const defaultBranch = getDefaultBranch(repoPath);
  const currentBranch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  if (currentBranch !== defaultBranch) {
    throw new Error(
      `[deploy] Refusing to bump version: on branch "${currentBranch}", expected "${defaultBranch}". ` +
      `Merge to ${defaultBranch} first.`
    );
  }

  // Auto-commit any dirty working-tree files before pulling. Dirty state can be
  // left by previous failed deploys or merged branches with extra working-tree changes.
  try {
    // Before auto-committing, purge any tracked files that are now gitignored.
    // This handles cases like version.json being committed before it was gitignored —
    // `git add -A` would otherwise re-commit them on every deploy.
    try {
      const ignoredTracked = execSync('git ls-files -i --exclude-standard --cached', {
        cwd: repoPath, encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      if (ignoredTracked) {
        for (const f of ignoredTracked.split('\n').filter(Boolean)) {
          try { execFileSync('git', ['rm', '--cached', f], { cwd: repoPath, stdio: 'pipe' }); } catch {}
        }
        log(`[deploy] Untracked gitignored file(s) before auto-commit: ${ignoredTracked.replace(/\n/g, ', ')}`);
      }
    } catch {}

    const dirty = gitSafe(['status', '--porcelain'], { cwd: repoPath });
    if (dirty) {
      const n = dirty.split('\n').length;
      log(`[deploy] Working tree has ${n} uncommitted file(s) — auto-committing before pull`);
      gitSafe(['add', '-A'], { cwd: repoPath });
      gitSafe(['commit', '-m', 'wip: auto-commit dirty working tree before deploy'], { cwd: repoPath });
    }
  } catch { /* ignore — pull will surface any remaining issue */ }

  // Pull latest from origin so our version bump doesn't conflict with concurrent deploys.
  // Without this, two workers running simultaneously would both read the same local version,
  // commit different bumps, and one of the `git push` calls would fail (non-fast-forward).
  // Non-fatal: new projects may have no remote configured yet, and the deploy can still succeed.
  try {
    execFileSync('git', ['pull', '--rebase', 'origin', defaultBranch], { cwd: repoPath, stdio: 'pipe' });
    log(`[deploy] Pulled latest from origin/${defaultBranch}`);
  } catch (err) {
    log(`[deploy] Warning: git pull --rebase failed (non-fatal): ${err.message.slice(0, 200)}`);
    // Abort any partial rebase state so the working tree is usable
    try { execFileSync('git', ['rebase', '--abort'], { cwd: repoPath, stdio: 'pipe' }); } catch {}
  }

  const webDir = projectConfig.webDir || '.';
  const webPath = join(repoPath, webDir);
  const versionPaths = projectConfig.versionPaths || [webDir];

  // 1. Bump version in all configured paths — use the webDir package.json as the source of truth.
  //    Projects with versionPaths: [] (e.g. Android/native apps) skip version bumping entirely.
  const webPkgPath = join(webPath, 'package.json');
  let newVersion;
  if (existsSync(webPkgPath)) {
    newVersion = readNextPatchVersion(webPkgPath);
  } else if (existsSync(join(repoPath, 'package.json'))) {
    newVersion = readNextPatchVersion(join(repoPath, 'package.json'));
  } else {
    log(`[deploy] No package.json found — skipping version bump`);
  }

  if (newVersion) {
    for (const rel of versionPaths) {
      const safeDir = validatePathWithinRepo(repoPath, rel, 'versionPaths');
      const pkgPath = join(safeDir, 'package.json');
      if (existsSync(pkgPath)) {
        setVersion(pkgPath, newVersion);
        log(`[deploy] Bumped ${rel}/package.json to ${newVersion}`);
      }
    }
  }

  // 2. Update version strings in HTML files
  // Prefer src/index.html when it exists — projects with build pipelines (e.g. CopyHtmlPlugin)
  // copy src → dist during build, which would overwrite version updates to dist/index.html.
  if (newVersion) {
    const versionFiles = projectConfig.versionFiles
      ? projectConfig.versionFiles.map(f => validatePathWithinRepo(repoPath, f, 'versionFiles'))
      : [
          existsSync(join(webPath, 'src', 'index.html'))
            ? join(webPath, 'src', 'index.html')
            : join(webPath, 'dist', 'index.html'),
        ];

    for (const filePath of versionFiles) {
      if (existsSync(filePath)) {
        const updates = updateHtmlVersion(filePath, newVersion);
        if (updates.versionUpdated) log(`[deploy] Updated version in ${filePath.split('/').pop()} to v${newVersion}`);
        if (updates.cacheBusterUpdated) log(`[deploy] Bumped cache buster to v=${updates.newCacheBuster}`);
      }
    }

    // 2b. Write version.json for client-side auto-reload detection
    const distDir = join(webPath, 'dist');
    const versionJsonPath = join(distDir, 'version.json');
    if (existsSync(distDir)) {
      writeFileSync(versionJsonPath, JSON.stringify({ version: newVersion }) + '\n');
      log(`[deploy] Wrote version.json with v${newVersion}`);
    }
  }

  // 3. Commit version bump (source files — package.json, src/index.html)
  try {
    execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
    const commitMsg = newVersion ? `v${newVersion} — ${ticketId}` : ticketId;
    execFileSync('git', ['commit', '-m', commitMsg], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    log(`[deploy] Committed ${commitMsg}`);
  } catch (err) {
    log(`[deploy] Commit failed (no changes?): ${err.message}`);
  }

  // 3b. Push to remote so the version bump (and the merged ticket branch) are
  //     backed up regardless of whether the deploy command succeeds.
  //     Non-fatal: projects without a remote configured yet will fail harmlessly.
  try {
    execFileSync('git', ['push', 'origin', defaultBranch], { cwd: repoPath, stdio: 'pipe' });
    log(`[deploy] Pushed to origin/${defaultBranch}`);
  } catch (err) {
    log(`[deploy] Push failed (non-fatal): ${err.message.slice(0, 200)}`);
  }

  // 4. Run deploy command (in webDir context)
  // Use canaryDeployCommand if configured, falling back to deployCommand.
  // When canaryDeployCommand is set, post-merge deploys go to canary rather than
  // the production release URL.  Promotion to release is done via promoteCommand,
  // triggered by the "Promote to Release" button in the Docket UI.
  //
  // SECURITY: deployCommand is validated and executed via execFileSync (no shell spawn)
  // to prevent command injection. See runDeployCommand() for details.
  // deployCommand is an ADMIN-ONLY config option — never accept user-supplied values.
  //
  // NOTE: We treat deploy command failure as a warning, NOT a fatal error.
  // The version bump has already been committed (and likely pushed via the deploy
  // script). Throwing here would prevent callers from updating liveVersion in
  // Firestore, causing the live version indicator to fall out of sync with git.
  // Deploy failures are logged and visible in the orchestrator dashboard.
  const effectiveDeployCommand = projectConfig.canaryDeployCommand || projectConfig.deployCommand;
  if (effectiveDeployCommand) {
    const deployTarget = projectConfig.canaryDeployCommand ? 'canary' : 'release';
    try {
      log(`[deploy] Deploying to ${deployTarget}...`);
      runDeployCommand(effectiveDeployCommand, webPath, log);
      log(`[deploy] Deploy to ${deployTarget} complete for ${ticketId}`);
    } catch (err) {
      // Log stdout (in err.message) and stderr separately so the full failure reason is visible.
      // NOTE: non-fatal — the version bump has already been committed and pushed.
      // Callers still update liveVersion in Firestore so the live indicator stays in sync.
      const stderr = err.stderr ? err.stderr.toString().trim() : '';
      log(`[deploy] Deploy command failed (non-fatal): ${err.message}`);
      if (stderr) log(`[deploy] stderr: ${stderr}`);
    }
  }

  // 5. Cascade to dependent projects
  const dependents = projectConfig.dependents || [];
  for (const depId of dependents) {
    const depConfig = allProjects[depId];
    if (!depConfig || !depConfig.autoDeploy) continue;
    log(`[deploy] Cascading deploy to dependent: ${depId}`);
    try {
      await postMergeDeploy(ticketId, depConfig.repoPath, depConfig, log, allProjects);
    } catch (err) {
      log(`[deploy] Dependent deploy failed for ${depId}: ${err.message}`);
    }
  }

  return newVersion;
}

/**
 * Promote canary build to the release URL.
 *
 * Runs the promoteCommand from projectConfig (e.g. "npm run promote:canary") in the
 * project's webDir.  This copies the canary build to the release deployment target.
 *
 * SECURITY: promoteCommand is validated via the same ALLOWED_DEPLOY_EXECUTABLES allowlist
 * as deployCommand.  It is an admin-only config option — never accept user-supplied values.
 *
 * @param {string} projectId
 * @param {string} repoPath
 * @param {object} projectConfig
 * @param {function} log
 * @returns {Promise<void>}
 */
export async function promoteCanary(projectId, repoPath, projectConfig, log = console.log) {
  const promoteCommand = projectConfig.promoteCommand;
  if (!promoteCommand) {
    throw new Error(
      `[promote] No promoteCommand configured for project "${projectId}". ` +
      `Add "promoteCommand": "npm run promote:canary" to your docket.config.json.`
    );
  }

  const webDir = projectConfig.webDir || '.';
  const webPath = join(repoPath, webDir);

  log(`[promote] Promoting canary to release for ${projectId}...`);
  runDeployCommand(promoteCommand, webPath, log);
  log(`[promote] Promotion complete for ${projectId}`);

  // Deploy Firestore security rules after promotion so rule changes reach
  // production at the same time as the promoted build.  Non-fatal: a rules
  // deploy failure should never roll back an already-successful promotion.
  // Requires .firebaserc in the repo root with the Firebase project ID.
  const firestoreRulesCommand = projectConfig.firestoreRulesCommand;
  if (firestoreRulesCommand) {
    try {
      log(`[promote] Deploying Firestore rules for ${projectId}...`);
      runDeployCommand(firestoreRulesCommand, repoPath, log);
      log(`[promote] Firestore rules deployed for ${projectId}`);
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().trim() : '';
      log(`[promote] Firestore rules deploy failed (non-fatal): ${err.message}`);
      if (stderr) log(`[promote] stderr: ${stderr}`);
    }
  }
}

// ── Version helpers ────────────────────────────────────────────────

function readNextPatchVersion(pkgPath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `[deploy] Failed to parse JSON in "${pkgPath}": ${err.message}`
    );
  }
  const raw = pkg.version;
  if (typeof raw !== 'string' || !/^\d+\.\d+\.\d+/.test(raw)) {
    throw new Error(
      `[deploy] Invalid version "${raw}" in ${pkgPath}. ` +
      `Expected semver format "major.minor.patch" (e.g. "1.2.3").`
    );
  }
  const [major, minor, patch] = raw.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function setVersion(pkgPath, newVersion) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `[deploy] Failed to parse JSON in "${pkgPath}": ${err.message}`
    );
  }
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// ── Git helpers ───────────────────────────────────────────────────

/**
 * Run a git command with arguments as an array — no shell interpolation.
 * Throws an Error (with .stderr attached) if the command exits non-zero.
 *
 * @param {string[]} args  - git sub-command and its arguments (no shell quoting needed)
 * @param {object}   opts  - options: { cwd, encoding }
 * @returns {string} stdout (trimmed)
 */
function gitSafe(args, opts = {}) {
  const result = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: opts.encoding ?? 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) {
    const err = result.error || new Error(`git ${args[0]} exited ${result.status}`);
    err.stderr = result.stderr || '';
    err.message = (result.stderr || err.message || '').trim();
    throw err;
  }
  return (result.stdout || '').trim();
}

function getDefaultBranch(repoPath) {
  try {
    const result = gitSafe(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
    return result.split('/').pop();
  } catch {
    try {
      gitSafe(['rev-parse', '--verify', 'main'], { cwd: repoPath });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

// ── HTML version updates ──────────────────────────────────────────

function updateHtmlVersion(indexPath, newVersion) {
  let html = readFileSync(indexPath, 'utf-8');
  const result = { versionUpdated: false, cacheBusterUpdated: false, newCacheBuster: null };

  // Update any version string pattern: v0.3.0, v1.5.2, etc.
  const versionRe = /(>v)[\d.]+(<)/g;
  if (versionRe.test(html)) {
    html = html.replace(/(>v)[\d.]+(<)/g, `$1${newVersion}$2`);
    result.versionUpdated = true;
  }

  // Update cache buster: bundle.js?v=13 → bundle.js?v=14
  const cacheBusterRe = /(bundle\.js\?v=)(\d+)/;
  const match = html.match(cacheBusterRe);
  if (match) {
    const newBuster = parseInt(match[2], 10) + 1;
    html = html.replace(cacheBusterRe, `$1${newBuster}`);
    result.cacheBusterUpdated = true;
    result.newCacheBuster = newBuster;
  }

  writeFileSync(indexPath, html);
  return result;
}
