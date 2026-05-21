#!/usr/bin/env node

// @docket/orchestrator — CLI entry point
// Usage: docket-orchestrator --config ./docket.config.json [--user <userId>]

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { createOrchestrator } from '../src/orchestrator.js';
import { startAdvisor } from '@docket/advisor';

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
    i++;
  }
  return flags;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(`
Usage: docket-orchestrator --config <path> [--user <userId>]

Options:
  --config <path>   Path to docket.config.json (required)
  --user <userId>   Override default userId from config
  --help            Show this help
`.trim());
    process.exit(0);
  }

  // ── Load config ─────────────────────────────────────────────────
  const configPath = flags.config;
  if (!configPath) {
    console.error('Error: --config <path> is required.');
    console.error('Example: docket-orchestrator --config ./docket.config.json');
    process.exit(1);
  }

  const resolvedConfigPath = resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    console.error(`Error: config file not found: ${resolvedConfigPath}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(resolvedConfigPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse config file: ${err.message}`);
    process.exit(1);
  }

  const configDir = dirname(resolvedConfigPath);

  // ── Firebase init ───────────────────────────────────────────────
  let keyPath = process.env.DOCKET_FIREBASE_KEY_PATH;

  if (!keyPath && config.firebaseKeyPath) {
    keyPath = resolve(configDir, config.firebaseKeyPath);
  }

  if (!keyPath) {
    const candidate = resolve(configDir, 'serviceAccountKey.json');
    if (existsSync(candidate)) keyPath = candidate;
  }

  if (!keyPath || !existsSync(keyPath)) {
    console.error('Error: Firebase service account key not found.');
    console.error('Set DOCKET_FIREBASE_KEY_PATH or add firebaseKeyPath to config.');
    process.exit(1);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  const db = admin.firestore();

  // ── Resolve settings ────────────────────────────────────────────
  const userId = flags.user || config.defaults?.userId || null;
  if (!userId) {
    console.error('Error: userId is required. Pass --user or set defaults.userId in config.');
    process.exit(1);
  }

  const projects = config.projects || {};
  if (Object.keys(projects).length === 0) {
    console.error('Error: no projects defined in config.');
    process.exit(1);
  }

  const orchConfig = config.orchestrator || {};
  const deployConfig = config.deploy || {};

  // ── Clean environment for worker subprocesses ──────────────────
  // Workers spawn `claude` CLI as subprocesses. If the orchestrator
  // itself was launched from inside a Claude Code session, CLAUDECODE
  // will be set and the subprocess will refuse to start.
  delete process.env.CLAUDECODE;

  // ── Validate auth ──────────────────────────────────────────────
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('Error: CLAUDE_CODE_OAUTH_TOKEN is not set.');
    console.error('Workers will be billed against API credits instead of your Max subscription.');
    console.error('');
    console.error('To fix:');
    console.error('  1. Run: claude setup-token');
    console.error('  2. Add to ~/.zshrc: export CLAUDE_CODE_OAUTH_TOKEN=<token>');
    console.error('  3. Restart your terminal and re-run the orchestrator.');
    process.exit(1);
  }

  // ── Create and start orchestrator ───────────────────────────────
  // bypassPermissions: opt-in flag to fully disable SDK permission checks.
  // Default is false (uses 'acceptEdits' mode). Only enable in trusted
  // development environments where full autonomy is explicitly approved.
  // Set via orchestrator.bypassPermissions: true in docket.config.json.
  if (orchConfig.bypassPermissions === true) {
    console.warn('[orchestrator] WARNING: bypassPermissions=true is set in config.');
    console.warn('[orchestrator] All SDK permission checks will be disabled for worker sessions.');
    console.warn('[orchestrator] Only use this in trusted development environments.');
  }

  const orchestrator = createOrchestrator({
    db,
    projects,
    maxWorkers: orchConfig.maxWorkers || 4,
    model: orchConfig.model || 'claude-sonnet-4-6',
    fallbackModel: orchConfig.fallbackModel || 'claude-haiku-4-5',
    userId,
    firebaseKeyPath: keyPath,
    workerIdleTimeoutMs: orchConfig.workerIdleTimeoutMs || 1800000,
    workerCooldownMs: orchConfig.workerCooldownMs ?? 5 * 60 * 1000,
    workerStaggerMs: orchConfig.workerStaggerMs || 10000,
    maintenanceIntervalMs: orchConfig.maintenanceIntervalMs || 5 * 60 * 1000,
    usageCheckIntervalMs: orchConfig.usageCheckIntervalMs || 30 * 60 * 1000,
    usagePauseThreshold: orchConfig.usagePauseThreshold ?? 90,
    usageFallbackThreshold: orchConfig.usageFallbackThreshold ?? 80,
    usageCheckToken: orchConfig.usageCheckToken || null,
    bypassPermissions: orchConfig.bypassPermissions === true,
    pagesBaseUrl: deployConfig.pagesBaseUrl || null,
    pagesRepoPath: deployConfig.pagesRepoPath || null,
  });

  await orchestrator.start();

  // ── Silence console after TUI opens ────────────────────────────
  // The TUI uses the alternate screen buffer. Any console output from
  // in-process modules (advisor, maintenance) corrupts the display.
  // Redirect all console output to the orchestrator log file.
  const logFile = resolve(import.meta.dirname, '..', 'logs', 'orchestrator.log');
  const silentLog = (...args) => {
    try {
      const ts = new Date().toISOString();
      appendFileSync(logFile, `${ts} ${args.join(' ')}\n`);
    } catch { /* ignore */ }
  };
  console.log = silentLog;
  console.warn = silentLog;
  console.error = silentLog;

  // ── Start EPD Advisor (if configured) ───────────────────────────
  // If the config contains an "advisor" section, start the Engineer,
  // Design, and Product personas in-process alongside the orchestrator.
  if (config.advisor) {
    try {
      await startAdvisor({ db, advisorConfig: config.advisor });
    } catch (err) {
      silentLog(`[advisor] Failed to start: ${err.message || err}`);
      // Non-fatal — orchestrator continues even if advisor fails to start.
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
