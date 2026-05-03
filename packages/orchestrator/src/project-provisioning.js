// @docket/orchestrator — project repo + .claude/settings.json provisioning
// and first-time bootstrap.
//
// Three concerns live together because they all run on the
// "discovered a new project" code path:
//   - getDefaultRepoBase / ensureProjectRepo: derive a repoPath from a
//     sibling project, init git, persist to Firestore.
//   - ensureClaudeSettings: drop a default .claude/settings.json so worker
//     sessions in acceptEdits mode can run git/npm/etc.
//   - bootstrapNewProject: create the very first ticket so the agent has
//     something to do, plus seed liveVersion / canary URL / placeholder
//     pages so the deploy pipeline and web UI work from minute zero.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_AGENT_PERMISSIONS = {
  permissions: {
    allow: [
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git fetch:*)',
      'Bash(git rebase:*)',
      'Bash(git checkout:*)',
      'Bash(git branch:*)',
      'Bash(git stash:*)',
      'Bash(git merge:*)',
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(git show:*)',
      'Bash(git rev-parse:*)',
      'Bash(npm:*)',
      'Bash(npx:*)',
      'Bash(node:*)',
      'Bash(ls:*)',
      'Bash(find:*)',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(wc:*)',
      'Bash(tree:*)',
      'Bash(pwd:*)',
      'Bash(which:*)',
      'Bash(echo:*)',
      'Bash(mkdir:*)',
      'Bash(cp:*)',
      'Bash(mv:*)',
      'Bash(rm:*)',
      'Bash(chmod:*)',
      'Bash(grep:*)',
      'Bash(sed:*)',
      'Bash(awk:*)',
      'Bash(sort:*)',
      'Bash(uniq:*)',
      'Bash(basename:*)',
      'Bash(dirname:*)',
      'Bash(bash:*)',
      'Bash(sh:*)',
    ],
    deny: [
      'Bash(git push:*)',
      'Bash(git reset --hard:*)',
    ],
  },
};

/**
 * @param {object} _state   Unused — provisioning has no shared mutable state.
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.projects                In-memory project registry.
 * @param {Function} deps.writeLogFile
 * @param {Function} deps.getTicketService      projectId -> TicketService
 * @param {string|null} deps.pagesBaseUrl
 * @param {string|null} deps.pagesRepoPath
 */
export function createProvisioning(_state, deps) {
  const { db, projects, writeLogFile, getTicketService, pagesBaseUrl, pagesRepoPath } = deps;

  /**
   * Derive a default repo base directory from existing project configs.
   * Takes the parent directory of the first configured project's repoPath.
   */
  function getDefaultRepoBase() {
    for (const cfg of Object.values(projects)) {
      if (cfg.repoPath) return dirname(cfg.repoPath);
    }
    return null;
  }

  /**
   * Ensure a project has a valid repoPath.  If missing, auto-provision one
   * by deriving it from existing project configs, creating the directory and
   * initialising a git repo if needed, then persisting to Firestore.
   *
   * @returns {boolean} true if repoPath is now valid, false if provisioning failed.
   */
  async function ensureProjectRepo(projectId, projectConfig) {
    if (projectConfig?.repoPath) return true;

    const base = getDefaultRepoBase();
    if (!base) {
      writeLogFile(`[${projectId}] Cannot auto-provision repoPath — no existing project has a repoPath configured`);
      return false;
    }

    const repoPath = join(base, projectId);
    writeLogFile(`[${projectId}] Auto-provisioning repoPath: ${basename(repoPath)}`);

    // Create directory if needed
    if (!existsSync(repoPath)) {
      mkdirSync(repoPath, { recursive: true });
      writeLogFile(`[${projectId}] Created directory ${basename(repoPath)}`);
    }

    // Init git repo if needed
    if (!existsSync(join(repoPath, '.git'))) {
      try {
        execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });

        // Seed package.json so the deploy pipeline has a version to bump from.
        const pkgPath = join(repoPath, 'package.json');
        if (!existsSync(pkgPath)) {
          const pkg = { name: projectId, version: '0.0.1', private: true };
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        }

        execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'ignore' });
        writeLogFile(`[${projectId}] Initialised git repo at ${basename(repoPath)}`);
      } catch (err) {
        writeLogFile(`[${projectId}] Failed to init git repo: ${err.message}`);
        return false;
      }
    }

    // Persist to Firestore
    try {
      await db.collection('projects').doc(projectId).set(
        { repoPath },
        { merge: true }
      );
      writeLogFile(`[${projectId}] Persisted repoPath to Firestore`);
    } catch (err) {
      writeLogFile(`[${projectId}] Failed to persist repoPath to Firestore: ${err.message}`);
      // Still usable locally even if Firestore write fails
    }

    // Update in-memory config
    if (!projects[projectId]) {
      projects[projectId] = { repoPath };
    } else {
      projects[projectId].repoPath = repoPath;
    }
    if (projectConfig) projectConfig.repoPath = repoPath;

    return true;
  }

  /**
   * Ensures the project repo has a .claude/settings.json with bash permissions
   * that agent workers need in acceptEdits mode.  Without this file, the SDK
   * sandbox blocks git write commands, build tools, and other essential CLI
   * operations — causing workers to spin uselessly trying workarounds.
   *
   * Only creates the file if it doesn't already exist (never overwrites
   * user-customised settings).
   */
  function ensureClaudeSettings(repoPath, projectId) {
    if (!repoPath) return;

    const settingsPath = join(repoPath, '.claude', 'settings.json');
    if (existsSync(settingsPath)) return;

    const claudeDir = join(repoPath, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    writeFileSync(settingsPath, JSON.stringify(DEFAULT_AGENT_PERMISSIONS, null, 2) + '\n');
    writeLogFile(`[${projectId}] Created .claude/settings.json with default agent permissions`);
  }

  /**
   * When a brand-new project is discovered with zero tickets, create a
   * bootstrap ticket that instructs the agent to scaffold the initial app.
   */
  async function bootstrapNewProject(projectId, projectData) {
    const ticketService = getTicketService(projectId);

    // Only bootstrap if the project has no tickets yet.
    const existing = await db
      .collection('projects').doc(projectId)
      .collection('tickets')
      .limit(1)
      .get();
    if (!existing.empty) return;

    const name = projectData.name || projectId;
    const context = projectData.advisorContext || '';

    // Set initial version and URL fields so the deploy pipeline, web UI
    // version indicators, and canary/release links work from the start.
    try {
      const now = new Date().toISOString();
      const fields = {
        liveVersion: 'v0.0.1',
        liveVersionAt: now,
        autoDeploy: true,
        canaryDeployCommand: 'npm run deploy:canary',
        promoteCommand: 'npm run promote:canary',
      };

      // Derive canary/release URLs from the configured pages base, and
      // create placeholder pages in the local pages repo (if configured)
      // so the links don't 404 before the first deploy.
      if (pagesBaseUrl) {
        fields.canaryUrl = `${pagesBaseUrl}/${projectId}-canary/`;
        fields.releaseUrl = `${pagesBaseUrl}/${projectId}/`;
      }

      if (pagesRepoPath && existsSync(pagesRepoPath)) {
        const pagesProjects = join(pagesRepoPath, 'projects');
        if (!existsSync(pagesProjects)) {
          mkdirSync(pagesProjects, { recursive: true });
        }

        const placeholder = [
          '<!doctype html><html lang="en"><head><meta charset="UTF-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
          `<title>${name}</title>`,
          '<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#aaa}p{text-align:center;font-size:1.2rem}</style>',
          `</head><body><p>${name} — awaiting first deploy</p></body></html>`,
        ].join('\n');

        for (const dir of [projectId, `${projectId}-canary`]) {
          const dirPath = join(pagesProjects, dir);
          if (!existsSync(dirPath)) {
            mkdirSync(dirPath, { recursive: true });
            writeFileSync(join(dirPath, 'index.html'), placeholder);
          }
        }

        try {
          execFileSync('git', ['add', `projects/${projectId}`, `projects/${projectId}-canary`], { cwd: pagesRepoPath, stdio: 'ignore' });
          execFileSync('git', ['commit', '-m', `Add placeholder pages for ${projectId}`], { cwd: pagesRepoPath, stdio: 'ignore' });
          execFileSync('git', ['push', 'origin', 'master'], { cwd: pagesRepoPath, stdio: 'ignore' });
          writeLogFile(`[${projectId}] Created and pushed placeholder pages`);
        } catch (err) {
          writeLogFile(`[${projectId}] Failed to push placeholder pages: ${err.message}`);
        }
      }

      await db.collection('projects').doc(projectId).set(fields, { merge: true });
      writeLogFile(`[${projectId}] Initialised version and URL fields`);
    } catch (err) {
      writeLogFile(`[${projectId}] Failed to set initial project fields: ${err.message}`);
    }

    const description = [
      `Set up the initial project scaffold for **${name}**.`,
      '',
      context ? `## Project description` : '',
      context ? context : '',
      context ? '' : '',
      '## What to do',
      '',
      '1. Look at what already exists in the repo (if anything).',
      '2. Based on the project description above, create a sensible initial project structure:',
      '   - `package.json` with name, scripts, and core dependencies',
      '   - Entry point / source files for the main application',
      '   - A `.gitignore` appropriate for the stack',
      '   - A brief `README.md` explaining what the project is and how to run it',
      '3. Take a real first swing at building the core functionality — don\'t just scaffold, actually implement the main idea as far as you can.',
      '4. Make sure the project builds and runs without errors.',
      '5. Commit your work and mark this ticket done.',
    ].filter(l => l !== '').join('\n');

    try {
      const ticket = await ticketService.add({
        type: 'feature',
        title: `Bootstrap ${name}`,
        description,
        userId: null,
        userEmail: 'orchestrator@docket.app',
        status: 'open',
      });
      writeLogFile(`[${projectId}] Created bootstrap ticket ${ticket.ticketId}: Bootstrap ${name}`);
    } catch (err) {
      writeLogFile(`[${projectId}] Failed to create bootstrap ticket: ${err.message}`);
    }
  }

  return { getDefaultRepoBase, ensureProjectRepo, ensureClaudeSettings, bootstrapNewProject };
}
