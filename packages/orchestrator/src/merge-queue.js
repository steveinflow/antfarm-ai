// Merge queue — per-repo serial merge chains, parallel across repos
// Each repo gets its own serialized queue so merges don't conflict.
// After merge: version bump + deploy if project has autoDeploy enabled.

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { postMergeDeploy } from './deploy.js';

// ── Safe shell execution ─────────────────────────────────────────

/**
 * Run a git command with arguments as an array — no shell interpolation.
 * Throws an Error (with .stderr attached) if the command exits non-zero.
 *
 * @param {string[]} args  - git sub-command and its arguments (no shell quoting needed)
 * @param {object}   opts  - options: { cwd }
 * @returns {string} stdout (trimmed)
 */
function gitSafe(args, opts = {}) {
  const result = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
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

/**
 * Create a merge queue manager.
 * Returns { enqueueMerge(ticketId, repoPath, projectConfig, onLog) }
 *
 * Per-repo serial merge chains: Map<repoPath, Promise>.
 * Merges for different repos run in parallel.
 */
export function createMergeQueueManager() {
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();

  /**
   * Enqueue a merge for the given ticket branch into the default branch.
   * After merge, runs version bump + deploy if configured.
   * Returns a promise that resolves when merge + deploy completes.
   */
  function enqueueMerge(ticketId, repoPath, { projectConfig = {}, allProjects = {}, ticketService, docId, projectId, db, onLog, costUsd, durationMs } = {}) {
    const log = onLog || ((msg) => console.log(msg));
    const prev = chains.get(repoPath) || Promise.resolve();
    const next = prev
      .then(async () => {
        // Reset ticket to in_progress — it won't be truly done until deployed with a version
        if (ticketService && docId) {
          try {
            await ticketService.transitionStatus(docId, 'in_progress', {
              note: 'Merging branch and deploying...',
              workerPhase: 'merging',
              workerStartedAt: null,
            });
          } catch (err) {
            log(`[merge-queue] Failed to reset ${ticketId} to in_progress: ${err.message}`);
          }
        }
        log(`[merge-queue] Merging ${ticketId} in ${basename(repoPath)}`);
        return executeMerge(ticketId, repoPath);
      })
      .then(() => {
        log(`[merge-queue] Merge complete, starting deploy pipeline`);
        return postMergeDeploy(ticketId, repoPath, projectConfig, log, allProjects);
      })
      .then(async (version) => {
        // Persist liveVersion on the project document so the UI can display it
        if (version && db && projectId) {
          try {
            await db.collection('projects').doc(projectId).update({
              liveVersion: `v${version}`,
              liveVersionAt: new Date().toISOString(),
            });
            log(`[merge-queue] Updated project ${projectId} liveVersion to v${version}`);
          } catch (err) {
            log(`[merge-queue] Failed to update project liveVersion: ${err.message}`);
          }
        }

        if (ticketService && docId) {
          try {
            // Build extra fields to persist cost and duration on the ticket
            const extraFields = {};
            if (costUsd != null && costUsd > 0) extraFields.costUsd = costUsd;
            if (durationMs != null && durationMs > 0) extraFields.durationMs = durationMs;

            if (version) {
              await ticketService.transitionStatus(docId, 'done', {
                note: `Deployed in v${version}`,
                deployedVersion: `v${version}`,
                workerPhase: null,
                workerStartedAt: null,
                ...extraFields,
              });
              log(`[merge-queue] Marked ${ticketId} done with v${version}`);
            } else {
              await ticketService.transitionStatus(docId, 'done', {
                note: 'Merged',
                workerPhase: null,
                workerStartedAt: null,
                ...extraFields,
              });
              log(`[merge-queue] Marked ${ticketId} done (no deploy configured)`);
            }
          } catch (err) {
            log(`[merge-queue] Failed to mark ${ticketId} done: ${err.message}`);
          }
        }
      })
      .catch(async err => {
        log(`[merge-queue] Failed for ${ticketId} in ${basename(repoPath)}: ${err.message}`);
        if (err.stderr) log(`[merge-queue] stderr: ${err.stderr.toString().slice(0, 300)}`);
        if (ticketService && docId) {
          try {
            await ticketService.transitionStatus(docId, 'blocked', {
              note: `Merge/deploy failed: ${err.message.slice(0, 200)}`,
              workerPhase: null,
              workerStartedAt: null,
            });
          } catch (e) {
            log(`[merge-queue] Failed to mark ${ticketId} blocked: ${e.message}`);
          }
        }
      });

    chains.set(repoPath, next);
    return next;
  }

  return { enqueueMerge };
}

// ── Merge execution ─────────────────────────────────────────────────

function executeMerge(ticketId, repoPath) {
  const branchName = `ticket/${ticketId}`;
  const defaultBranch = getDefaultBranch(repoPath);

  try {
    // Switch to default branch
    gitSafe(['checkout', defaultBranch], { cwd: repoPath });

    // Merge the ticket branch
    gitSafe(['merge', branchName, '--no-edit'], { cwd: repoPath });

    // Delete the branch after successful merge
    gitSafe(['branch', '-d', branchName], { cwd: repoPath });

    console.log(`[merge-queue] Merged ${branchName} into ${defaultBranch} in ${basename(repoPath)}`);
  } catch (err) {
    // Merge failed — abort and preserve the branch for manual resolution
    console.error(`[merge-queue] Merge conflict or error for ${branchName} in ${basename(repoPath)}`);
    try {
      gitSafe(['merge', '--abort'], { cwd: repoPath });
    } catch {
      // Already not in a merge state — ignore
    }
    // Switch back to default branch to leave repo in clean state
    try {
      gitSafe(['checkout', defaultBranch], { cwd: repoPath });
    } catch {
      // ignore
    }
    throw new Error(`Merge failed for ${branchName}: ${err.message}`);
  }
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
