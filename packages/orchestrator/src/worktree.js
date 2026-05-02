// Worktree management — parameterized by repoPath
// Creates isolated git worktrees under {repoPath}/.claude/worktrees/{ticketId}

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Run a git command safely without shell interpolation.
 * Uses spawnSync with an explicit args array — no shell is invoked.
 * Returns stdout as a trimmed string, or throws on non-zero exit.
 */
function git(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
    // Explicitly never use a shell so that args are never interpreted
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(
      `git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr ?? ''}`.trim()
    );
    err.stderr = result.stderr;
    err.status = result.status;
    throw err;
  }
  return (result.stdout ?? '').trim();
}

/**
 * Create (or reuse) a git worktree for a ticket.
 * Worktrees live under {repoPath}/.claude/worktrees/{ticketId}.
 * Returns the absolute worktree directory path.
 */
export function createWorktree(ticketId, repoPath) {
  const branchName = `ticket/${ticketId}`;
  const worktreeBase = join(repoPath, '.claude', 'worktrees');
  const worktreeDir = join(worktreeBase, ticketId);

  // Ensure base directory exists
  mkdirSync(worktreeBase, { recursive: true });

  // Check if this worktree is already registered with git
  const registered = isWorktreeRegistered(worktreeDir, repoPath);

  if (registered && existsSync(worktreeDir)) {
    // Worktree exists and is registered — reuse it
    // Pull latest from main/master to keep it fresh
    try {
      const defaultBranch = getDefaultBranch(repoPath);
      git(['rebase', defaultBranch], { cwd: worktreeDir });
    } catch {
      // Rebase failed — abort and continue with what we have
      try {
        git(['rebase', '--abort'], { cwd: worktreeDir });
      } catch {
        // ignore
      }
    }
    return worktreeDir;
  }

  if (registered && !existsSync(worktreeDir)) {
    // Registered but directory is gone — prune and recreate
    try {
      git(['worktree', 'prune'], { cwd: repoPath });
    } catch {
      // ignore
    }
  }

  if (existsSync(worktreeDir)) {
    // Directory exists but not registered — remove it
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  // Delete branch if it already exists (stale from previous attempt)
  try {
    git(['branch', '-D', branchName], { cwd: repoPath });
  } catch {
    // Branch doesn't exist — that's fine
  }

  // Create worktree with a new branch off the default branch
  const defaultBranch = getDefaultBranch(repoPath);
  git(['worktree', 'add', '-b', branchName, worktreeDir, defaultBranch], {
    cwd: repoPath,
  });

  return worktreeDir;
}

/**
 * Clean up a worktree directory and prune git's worktree list.
 */
export function cleanupWorktree(dir, repoPath) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    git(['worktree', 'prune'], { cwd: repoPath });
  } catch {
    // ignore
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function isWorktreeRegistered(worktreeDir, repoPath) {
  try {
    const output = git(['worktree', 'list', '--porcelain'], { cwd: repoPath });
    return output.includes(worktreeDir);
  } catch {
    return false;
  }
}

function getDefaultBranch(repoPath) {
  // Try to determine the default branch (main or master)
  try {
    const result = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
    // refs/remotes/origin/main → main
    return result.split('/').pop();
  } catch {
    // Fallback: check if main exists, otherwise master
    try {
      git(['rev-parse', '--verify', 'main'], { cwd: repoPath });
      return 'main';
    } catch {
      return 'master';
    }
  }
}
