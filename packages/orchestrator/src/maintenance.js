// Maintenance worker — diagnoses and repairs broken ticket/deploy state.
//
// Handles two problem classes per project:
//   1. Tickets 'done' without deployedVersion → branch was never merged/deployed
//   2. Tickets 'blocked' due to failed merge/deploy → re-attempt after rebase
//
// Strategy: batch all fixable tickets per project into a single merge + deploy
// pass so they share one version bump, then tag each ticket with that version.

import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import admin from 'firebase-admin';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createTicketService } from '@docket/core';
import { postMergeDeploy } from './deploy.js';

const MAINTENANCE_MODEL = 'claude-opus-4-6';

// ── Input validation ─────────────────────────────────────────────

/**
 * Validate a ticket ID against a strict whitelist (alphanumeric + hyphens only).
 * Ticket IDs are derived from Firestore data and appear in shell commands, so
 * they must never contain shell metacharacters.
 *
 * @param {string} ticketId
 * @returns {string} The validated ticketId
 * @throws {Error} If ticketId contains characters outside [A-Za-z0-9-]
 */
function validateTicketId(ticketId) {
  if (typeof ticketId !== 'string' || !/^[A-Za-z0-9-]+$/.test(ticketId)) {
    throw new Error(`Invalid ticketId "${ticketId}" — must contain only alphanumerics and hyphens`);
  }
  return ticketId;
}

/**
 * Validate a git branch name returned by getDefaultBranch().
 * Branch names must not contain characters that could escape from shell arguments.
 * Permits: alphanumerics, hyphens, underscores, forward slashes, and dots —
 * the characters that appear in legitimate branch names.
 *
 * @param {string} branch
 * @returns {string} The validated branch name
 * @throws {Error} If branch contains disallowed characters
 */
function validateBranchName(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name "${branch}" — must contain only alphanumerics, hyphens, underscores, slashes, and dots`);
  }
  return branch;
}

// ── Firestore status helpers ─────────────────────────────────────

const MAINTENANCE_DOC_PATH = ['orchestrator', 'maintenance'];

/**
 * Publish maintenance worker status to Firestore so the dashboard
 * and web UI can display it separately from regular ticket workers.
 *
 * @param {object} db - Firestore instance
 * @param {object} status - Fields to merge into the maintenance doc
 */
async function publishStatus(db, status) {
  try {
    await db.collection(MAINTENANCE_DOC_PATH[0]).doc(MAINTENANCE_DOC_PATH[1]).set(
      { ...status, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch {
    // Best-effort — don't let status publishing break maintenance
  }
}

/**
 * Run a maintenance pass over all configured projects.
 *
 * @param {object} options
 * @param {object} options.db           - Firestore instance
 * @param {object} options.projects     - projectId → projectConfig map
 * @param {boolean} [options.dryRun]    - Report issues only, make no changes
 * @param {object} [options.allProjects]- Full map for deploy cascade resolution
 * @param {function} [options.onLog]    - Optional log sink (in addition to console.log)
 */
export async function runMaintenance({ db, projects, dryRun = false, allProjects = {}, onLog }) {
  let totalFixed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalRemaining = 0;

  // Collect all log lines for this run so we can publish them to Firestore
  // for display in the web UI's maintenance panel.
  const runLogs = [];
  const collectLog = (msg) => {
    runLogs.push(msg);
    if (onLog) onLog(msg);
  };

  const projectIds = Object.keys(projects);
  const startedAt = new Date().toISOString();

  // Announce that maintenance is starting
  await publishStatus(db, {
    status: 'running',
    startedAt,
    projects: projectIds,
    phase: 'scanning',
    dryRun,
    result: null,
    lastRunLogs: null,
  });

  for (const [projectId, projectConfig] of Object.entries(projects)) {
    const { fixed, skipped, failed, remaining } = await runProjectMaintenance({
      projectId,
      projectConfig,
      db,
      dryRun,
      allProjects,
      onLog: collectLog,
    });
    totalFixed += fixed;
    totalSkipped += skipped;
    totalFailed += failed;
    totalRemaining += (remaining || 0);
  }

  const result = { fixed: totalFixed, skipped: totalSkipped, failed: totalFailed };

  const summary = `── Maintenance complete — fixed: ${totalFixed}, skipped: ${totalSkipped}, failed: ${totalFailed}, remaining: ${totalRemaining}`;
  collectLog(summary);
  if (!onLog) console.log(`\n${summary}`);

  // Mark maintenance as complete, publishing the full log for UI inspection
  await publishStatus(db, {
    status: 'idle',
    phase: 'done',
    result,
    completedAt: new Date().toISOString(),
    lastRunLogs: runLogs.slice(-300),
  });

  // Only signal chaining if we actually made progress — otherwise the caller
  // would immediately retry a broken deploy in a tight loop.
  return { totalFixed, totalSkipped, totalFailed, hasMoreProblems: totalFixed > 0 && totalRemaining > 0 };
}

// ── Per-project pass ─────────────────────────────────────────────

async function runProjectMaintenance({ projectId, projectConfig, db, dryRun, allProjects, onLog }) {
  const repoPath = projectConfig.repoPath;
  const log = (msg) => {
    const line = `[maintenance:${projectId}] ${msg}`;
    if (!onLog) console.log(line);
    else onLog(line);
  };
  // updatePhase removed — per-step status writes were wasteful (Firestore write per phase).
  // The run-level publishStatus calls in runMaintenance are sufficient.

  if (!repoPath || !existsSync(repoPath)) {
    log(`Skipping — repoPath not found: ${repoPath ? basename(repoPath) : '(none)'}`);
    return { fixed: 0, skipped: 0, failed: 0 };
  }

  const ticketService = createTicketService(db, projectId, {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  });

  const defaultBranch = validateBranchName(getDefaultBranch(repoPath));

  // Filtered query — only read tickets that actually need attention.
  // Previously used listAll() which reads every ticket on every pass (very wasteful).
  const snap = await db
    .collection('projects').doc(projectId)
    .collection('tickets')
    .where('status', 'in', ['blocked', 'in_maintenance'])
    .get();
  const problems = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (problems.length === 0) {
    log('All tickets healthy — nothing to do.');
    return { fixed: 0, skipped: 0, failed: 0, remaining: 0 };
  }

  // Work on ONE ticket per pass to avoid partial-batch failures and infinite loops.
  // Priority: blocked first (fresh problems), then in_maintenance (already attempted).
  // For in_maintenance retries, prefer the OLDEST ticket (lowest number) so a
  // repeatedly-failing deploy doesn't starve others.
  const ticket =
    problems.find(t => t.status === 'blocked') ||
    [...problems].reverse().find(t => t.status === 'in_maintenance');

  const remaining = problems.length - 1;
  log(`Found ${problems.length} ticket(s) needing attention. Working on: ${ticket.ticketId} [${ticket.status}]`);
  if (remaining > 0) log(`  (${remaining} more will be handled in subsequent passes)`);
  for (const h of (ticket.statusHistory || []).slice(-3)) {
    log(`    history: ${h.from || '?'} → ${h.to}${h.note ? ` — ${h.note.slice(0, 80)}` : ''}`);
  }

  // Retry limit: if maintenance has failed consecutively 5+ times, give up.
  // Prevents infinite retry loops on permanently broken tickets.
  // Count consecutive maintenance-related entries from the end of history:
  //   - appendHistory notes starting with "Maintenance:" (failure records, no `to` field)
  //   - transitionStatus entries with to === 'in_maintenance'
  const MAX_MAINTENANCE_RETRIES = 5;
  const history = ticket.statusHistory || [];
  let consecutiveFailures = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const isMaintenanceTransition = h.to === 'in_maintenance';
    const isMaintenanceNote = !h.to && h.note && /^maintenance:/i.test(h.note);
    if (isMaintenanceTransition || isMaintenanceNote) {
      consecutiveFailures++;
    } else {
      break;
    }
  }
  if (consecutiveFailures >= MAX_MAINTENANCE_RETRIES) {
    const giveUpNote = `Maintenance: giving up after ${consecutiveFailures} consecutive failures. Manual intervention required.`;
    log(`  ${ticket.ticketId} — ${giveUpNote}`);
    try {
      await ticketService.transitionStatus(ticket.id, 'blocked', { note: giveUpNote });
    } catch (err) {
      log(`  ${ticket.ticketId} — failed to transition to blocked: ${err.message}`);
    }
    return { fixed: 0, skipped: 0, failed: 1, remaining };
  }

  if (dryRun) {
    log('Dry run — not making changes.');
    return { fixed: 0, skipped: problems.length, failed: 0, remaining: 0 };
  }

  // ── Step 1: claim as in_maintenance (skip if already claimed) ───
  if (ticket.status !== 'in_maintenance') {
    try {
      await ticketService.transitionStatus(ticket.id, 'in_maintenance', {
        note: 'Maintenance worker: investigating and repairing...',
      });
    } catch (err) {
      log(`  ${ticket.ticketId} — failed to claim: ${err.message}`);
      return { fixed: 0, skipped: 1, failed: 0, remaining };
    }
  } else {
    log(`  ${ticket.ticketId} — already in_maintenance, retrying...`);
  }

  // ── Step 2: merge any unmerged branch ───────────────────────────
  // Validate ticketId before using it in git commands.  The value comes from
  // Firestore and must not contain shell metacharacters.
  let safeTicketId;
  try {
    safeTicketId = validateTicketId(ticket.ticketId);
  } catch (err) {
    log(`  ${ticket.ticketId} — ${err.message}`);
    await ticketService.appendHistory(ticket.id, { note: err.message.slice(0, 500) }).catch(() => {});
    return { fixed: 0, skipped: 0, failed: 1, remaining };
  }
  const branchName = `ticket/${safeTicketId}`;

  // Abort any lingering merge/rebase state first
  try { execFileSync('git', ['merge', '--abort'], { cwd: repoPath, stdio: 'pipe' }); } catch {}
  try { execFileSync('git', ['rebase', '--abort'], { cwd: repoPath, stdio: 'pipe' }); } catch {}

  // Auto-commit any dirty working tree files (typically leftover from a previous
  // failed deploy or version bump) so merge/rebase can proceed cleanly.
  ensureCleanWorkingTree(repoPath, log);

  try {
    execFileSync('git', ['checkout', defaultBranch], { cwd: repoPath, stdio: 'pipe' });
  } catch (err) {
    log(`Fatal: Cannot checkout ${defaultBranch}: ${err.message}`);
    await ticketService.appendHistory(ticket.id, { note: `Maintenance: Cannot checkout ${defaultBranch}: ${err.message.slice(0, 250)}` }).catch(() => {});
    return { fixed: 0, skipped: 0, failed: 1, remaining };
  }

  if (!gitBranchExists(branchName, repoPath)) {
    log(`  ${ticket.ticketId} — no branch (already merged or missing), redeploying to tag`);
    // Fall through to deploy step — just need a version bump to tag this ticket
  } else {
    log(`  ${ticket.ticketId} — branch exists, rebasing onto ${defaultBranch}...`);

    let alreadyMerged = false;

    // Rebase the ticket branch onto the default branch.
    // On conflict, Claude Opus is invoked to resolve intelligently using ticket
    // context — it may discard features if needed to unblock the pipeline.
    try {
      execFileSync('git', ['rebase', defaultBranch, branchName], { cwd: repoPath, stdio: 'pipe' });
    } catch (rebaseErr) {
      // Unstaged changes during rebase: auto-commit them, abort rebase, and retry.
      if (/unstaged changes/i.test(rebaseErr.message)) {
        try { execSync('git rebase --abort', { cwd: repoPath, stdio: 'pipe' }); } catch {}
        log(`  ${ticket.ticketId} — rebase blocked by unstaged changes, auto-committing and falling back to merge`);
        ensureCleanWorkingTree(repoPath, log);
        alreadyMerged = await tryMergeWithClaudeBackup({ ticket, branchName, defaultBranch, repoPath, ticketService, log, remaining });
        if (alreadyMerged === null) return { fixed: 0, skipped: 0, failed: 1, remaining };
      } else {

      // Conflicts: try Claude Opus to resolve them and continue the rebase.
      const rebaseConflicts = getConflictedFiles(repoPath);
      if (rebaseConflicts.length > 0) {
        log(`  ${ticket.ticketId} — rebase has ${rebaseConflicts.length} conflict(s), invoking ${MAINTENANCE_MODEL}...`);
        const claudeResolved = await resolveConflictsWithClaude({ ticket, repoPath, defaultBranch, isRebase: true, log });
        if (claudeResolved) {
          log(`  ${ticket.ticketId} — Claude resolved rebase conflicts, proceeding to merge`);
          // alreadyMerged stays false — rebase done, still need the final merge below
        } else {
          try { execSync('git rebase --abort', { cwd: repoPath, stdio: 'pipe' }); } catch {}
          log(`  ${ticket.ticketId} — Claude rebase resolution failed, falling back to direct merge...`);
          alreadyMerged = await tryMergeWithClaudeBackup({ ticket, branchName, defaultBranch, repoPath, ticketService, log, remaining });
          if (alreadyMerged === null) return { fixed: 0, skipped: 0, failed: 1, remaining };
        }
      } else {
        // Rebase failed for a non-conflict reason — abort and try direct merge.
        try { execSync('git rebase --abort', { cwd: repoPath, stdio: 'pipe' }); } catch {}
        log(`  ${ticket.ticketId} — rebase failed (${rebaseErr.message.slice(0, 120).trim()}), falling back to direct merge...`);
        alreadyMerged = await tryMergeWithClaudeBackup({ ticket, branchName, defaultBranch, repoPath, ticketService, log, remaining });
        if (alreadyMerged === null) return { fixed: 0, skipped: 0, failed: 1, remaining };
      }
      } // end else (not unstaged changes)
    }

    if (!alreadyMerged) {
      log(`  ${ticket.ticketId} — merging...`);
      const merged = await tryMergeWithClaudeBackup({ ticket, branchName, defaultBranch, repoPath, ticketService, log, remaining });
      if (merged === null) return { fixed: 0, skipped: 0, failed: 1, remaining };
    }
  }

  // ── Step 3: deploy ───────────────────────────────────────────────
  log(`Running deploy pipeline for: ${ticket.ticketId}`);

  let deployedVersion = null;
  try {
    deployedVersion = await postMergeDeploy(
      ticket.ticketId,
      repoPath,
      projectConfig,
      (msg) => log(`  [deploy] ${msg}`),
      allProjects,
    );
  } catch (err) {
    log(`Deploy failed for ${ticket.ticketId}: ${err.message}`);
    await ticketService.appendHistory(ticket.id, { note: `Maintenance: Deploy failed: ${err.message.slice(0, 250)}` }).catch(() => {});
    return { fixed: 0, skipped: 0, failed: 1, remaining };
  }

  // ── Step 4: push main repo to remote ────────────────────────────
  try {
    execFileSync('git', ['push', 'origin', defaultBranch], { cwd: repoPath, stdio: 'pipe' });
    log(`Pushed ${defaultBranch} to origin`);
  } catch (err) {
    log(`Warning: push to origin failed: ${err.message}`);
    // Non-fatal — the deploy already pushed to the static site
  }

  // ── Step 5: tag the fixed ticket ────────────────────────────────
  if (deployedVersion) {
    try {
      await db.collection('projects').doc(projectId).update({
        liveVersion: `v${deployedVersion}`,
        liveVersionAt: new Date().toISOString(),
      });
      log(`Updated project ${projectId} liveVersion to v${deployedVersion}`);
    } catch (err) {
      log(`Failed to update project liveVersion: ${err.message}`);
    }
  }

  try {
    if (deployedVersion) {
      await ticketService.transitionStatus(ticket.id, 'done', {
        note: `Deployed in v${deployedVersion}`,
        deployedVersion: `v${deployedVersion}`,
      });
      log(`  ${ticket.ticketId} — done (v${deployedVersion})`);
    } else {
      await ticketService.transitionStatus(ticket.id, 'done', { note: 'Merged (no deploy configured)' });
      log(`  ${ticket.ticketId} — done (no deploy)`);
    }
  } catch (err) {
    log(`  ${ticket.ticketId} — failed to mark done: ${err.message}`);
    return { fixed: 0, skipped: 0, failed: 1, remaining };
  }

  return { fixed: 1, skipped: 0, failed: 0, remaining };
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Discard any dirty tracked files so git operations can proceed cleanly.
 *
 * Dirty state on the default branch is almost always from a previous
 * deploy cycle (version bumps, auto-commits that didn't complete).
 * These files will be regenerated by the deploy pipeline, so discarding
 * them is safe and correct.
 *
 * We intentionally do NOT use `git add -A` or auto-commit here, because
 * that would blindly stage and commit any sensitive files (credentials,
 * .env files, API keys) that may have been left in the working tree.
 * Instead we use `git reset --hard HEAD` which only resets tracked files
 * and never touches untracked files, avoiding any risk of committing
 * sensitive data.
 *
 * If there are untracked files in the working tree, they are left alone —
 * they do not block rebase/merge operations and should not be committed
 * by automated processes.
 *
 * @param {string} repoPath
 * @param {function} log
 */
function ensureCleanWorkingTree(repoPath, log) {
  const dirty = getDirtyFiles(repoPath);
  if (!dirty) return;
  const fileCount = dirty.split('\n').filter(Boolean).length;
  log(`Working tree has ${fileCount} uncommitted change(s) — discarding before maintenance (deploy artifacts)`);
  log(`Dirty files:\n${dirty}`);
  try {
    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoPath, stdio: 'pipe' });
    log(`Discarded ${fileCount} file(s) via git reset --hard HEAD`);
  } catch (err) {
    log(`git reset --hard failed (non-fatal): ${err.message.slice(0, 150)}`);
  }
}

/**
 * Return the porcelain dirty-file listing for repoPath, or null if clean.
 *
 * @param {string} repoPath
 * @returns {string|null}
 */
function getDirtyFiles(repoPath) {
  try {
    const out = execSync('git status --porcelain', {
      cwd: repoPath, encoding: 'utf-8', stdio: 'pipe',
    });
    // Ignore untracked files (??) — they don't affect rebase/merge operations.
    const dirty = out.split('\n').filter(l => l.trim() && !l.startsWith('??')).join('\n').trim();
    return dirty || null;
  } catch {
    return null;
  }
}

function getLastNote(ticket, toStatus) {
  const history = ticket.statusHistory || [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].to === toStatus && history[i].note) return history[i].note;
  }
  return null;
}

function branchHasUnmergedCommits(branchName, repoPath, defaultBranch) {
  try {
    const out = execFileSync(
      'git', ['log', `${defaultBranch}..${branchName}`, '--oneline'],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function gitBranchExists(branchName, repoPath) {
  try {
    execFileSync('git', ['rev-parse', '--verify', branchName], { cwd: repoPath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getDefaultBranch(repoPath) {
  try {
    const result = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result.split('/').pop();
  } catch {
    try {
      execSync('git rev-parse --verify main', { cwd: repoPath, stdio: 'pipe' });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

// ── Conflict helpers ──────────────────────────────────────────────

function getConflictedFiles(repoPath) {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', {
      cwd: repoPath, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getRecentCommitLog(repoPath, branch, n = 8) {
  try {
    // Use execFileSync with an args array (no shell spawning) so that
    // branch and n are never interpreted as shell tokens — defence-in-depth
    // even though branch is already validated by validateBranchName().
    return execFileSync(
      'git', ['log', branch, '--oneline', `-${String(n)}`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '(unable to read commit log)';
  }
}

function isRebaseInProgress(repoPath) {
  return existsSync(join(repoPath, '.git', 'rebase-merge')) ||
         existsSync(join(repoPath, '.git', 'rebase-apply'));
}

function isMergeInProgress(repoPath) {
  return existsSync(join(repoPath, '.git', 'MERGE_HEAD'));
}

/**
 * Attempt a direct merge of branchName into defaultBranch.
 * If the merge has conflicts, invoke Claude Opus to resolve them.
 * Returns true if merged, null if hard failure.
 *
 * @returns {Promise<true|null>}
 */
async function tryMergeWithClaudeBackup({ ticket, branchName, defaultBranch, repoPath, ticketService, log, remaining }) {
  try {
    execFileSync('git', ['checkout', defaultBranch], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['merge', branchName, '--no-edit'], { cwd: repoPath, stdio: 'pipe' });
    try { execFileSync('git', ['branch', '-d', branchName], { cwd: repoPath, stdio: 'pipe' }); } catch {}
    log(`  ${ticket.ticketId} — merged via direct merge`);
    return true;
  } catch (mergeErr) {
    const mergeConflicts = getConflictedFiles(repoPath);
    if (mergeConflicts.length > 0) {
      log(`  ${ticket.ticketId} — merge has ${mergeConflicts.length} conflict(s), invoking ${MAINTENANCE_MODEL}...`);
      const claudeResolved = await resolveConflictsWithClaude({ ticket, repoPath, defaultBranch, isRebase: false, log });
      if (claudeResolved) {
        try { execFileSync('git', ['branch', '-d', branchName], { cwd: repoPath, stdio: 'pipe' }); } catch {}
        log(`  ${ticket.ticketId} — Claude resolved merge conflicts`);
        return true;
      }
    }
    try { execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' }); } catch {}
    const failMsg = `Maintenance: all resolution strategies (rebase, direct merge, Claude Opus) failed. Manual intervention required. Merge error: ${mergeErr.message.slice(0, 200)}`;
    log(`  ${ticket.ticketId} — ${failMsg}`);
    await ticketService.appendHistory(ticket.id, { note: failMsg.slice(0, 500) }).catch(() => {});
    return null;
  }
}

/**
 * Invoke Claude Opus to resolve merge/rebase conflicts using ticket context.
 * Claude reads the conflicted files, resolves them, then runs the appropriate
 * continue command. May discard ticket features if needed to unblock the pipeline.
 *
 * @returns {Promise<boolean>} true if the operation completed without conflicts
 */
async function resolveConflictsWithClaude({ ticket, repoPath, defaultBranch, isRebase, log }) {
  const conflictedFiles = getConflictedFiles(repoPath);
  if (conflictedFiles.length === 0) return true;

  const recentLog = getRecentCommitLog(repoPath, defaultBranch, 8);
  const continueCmd = isRebase
    ? 'GIT_EDITOR=true git rebase --continue'
    : 'git commit --no-edit';

  const prompt = `<system>
You are a git conflict resolution assistant for an automated maintenance pipeline.
Your job: resolve all merge conflicts and complete the ${isRebase ? 'rebase' : 'merge'} operation.

Be aggressive. Resolve every conflict even if it means partially or fully losing the ticket's changes.
The goal is to unblock the pipeline. Prefer keeping the main branch (HEAD) version when in doubt.
Never leave conflict markers in files.
</system>

Ticket: ${ticket.ticketId} — ${ticket.title}
${ticket.description ? `Description: ${ticket.description.slice(0, 600)}` : ''}

Conflicted files (${conflictedFiles.length}): ${conflictedFiles.join(', ')}

Recent commits on ${defaultBranch}:
${recentLog}

Steps:
1. For each conflicted file, use Read to view the conflict markers
2. Use Edit to resolve all <<<<<<< ======= >>>>>>> markers — choose the version that best fits the ticket's intent; if unsure, keep the HEAD (main branch) version
3. Stage only the resolved conflict files explicitly (do NOT use git add -A or git add .):
   git add -- ${conflictedFiles.map(f => JSON.stringify(f)).join(' ')} && ${continueCmd}

Do not leave any conflict markers. Complete all steps before responding.`;

  const ac = new AbortController();
  const timer = setTimeout(() => {
    log(`  [${MAINTENANCE_MODEL}] conflict resolution timed out`);
    ac.abort();
  }, 5 * 60 * 1000);

  try {
    const stream = query({
      prompt,
      options: {
        cwd: repoPath,
        model: MAINTENANCE_MODEL,
        allowedTools: ['Read', 'Edit', 'Bash'],
        permissionMode: 'bypassPermissions',
        abortController: ac,
      },
    });
    for await (const msg of stream) {
      if (msg.type === 'result') {
        log(`  [${MAINTENANCE_MODEL}] ${msg.subtype || 'done'}`);
      }
    }
    const success = isRebase ? !isRebaseInProgress(repoPath) : !isMergeInProgress(repoPath);
    if (!success) log(`  [${MAINTENANCE_MODEL}] operation not complete after Claude finished`);
    return success;
  } catch (err) {
    log(`  [${MAINTENANCE_MODEL}] error: ${err.message?.slice(0, 200)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
