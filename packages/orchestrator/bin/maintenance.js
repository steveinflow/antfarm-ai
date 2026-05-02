#!/usr/bin/env node

// docket-maintenance — repairs broken ticket/deploy state
//
// Finds tickets that are:
//   - 'done' without a deployedVersion (incomplete deploy)
//   - 'blocked' due to merge/deploy failures
//
// For each: re-attempts merge + deploy, tags ticket with the deployed version,
// and pushes the main repo to origin.
//
// Usage:
//   docket-maintenance --config ./docket.config.json
//   docket-maintenance --config ./docket.config.json --dry-run
//   docket-maintenance --config ./docket.config.json --project docket

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { runMaintenance } from '../src/maintenance.js';

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

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(`
Usage: docket-maintenance --config <path> [options]

Options:
  --config <path>    Path to docket.config.json (required)
  --project <id>     Only check this project (default: all projects)
  --dry-run          Report problems without making any changes
  --help             Show this help
`.trim());
    process.exit(0);
  }

  const configPath = flags.config;
  if (!configPath) {
    console.error('Error: --config <path> is required.');
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
    console.error(`Error: failed to parse config: ${err.message}`);
    process.exit(1);
  }

  const configDir = dirname(resolvedConfigPath);

  // ── Firebase init ──────────────────────────────────────────────
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
    process.exit(1);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  // ── Resolve projects ───────────────────────────────────────────
  let projects = config.projects || {};
  if (flags.project) {
    if (!projects[flags.project]) {
      console.error(`Error: project "${flags.project}" not found in config.`);
      process.exit(1);
    }
    projects = { [flags.project]: projects[flags.project] };
  }

  if (Object.keys(projects).length === 0) {
    console.error('Error: no projects defined in config.');
    process.exit(1);
  }

  const dryRun = !!flags['dry-run'];
  if (dryRun) console.log('Dry run mode — no changes will be made.\n');

  console.log(`Scanning ${Object.keys(projects).length} project(s)...\n`);

  const { totalFailed } = await runMaintenance({
    db,
    projects,
    dryRun,
    allProjects: config.projects || {},
  });

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
