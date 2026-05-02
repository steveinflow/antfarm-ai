#!/usr/bin/env node

// @docket/cli — entry point
// Parse argv, load config, init firebase-admin, route to commands.

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { resolveConfig } from '../src/config.js';

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true; // boolean flag
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { positional, flags };
}

// ── Firebase init ───────────────────────────────────────────────────

function initFirebase(config) {
  // Priority: DOCKET_FIREBASE_KEY_PATH env → config.firebaseKeyPath → ./serviceAccountKey.json next to config
  let keyPath = process.env.DOCKET_FIREBASE_KEY_PATH;

  if (!keyPath && config.firebaseKeyPath) {
    // Resolve relative paths against the config file's directory
    if (config._configDir) {
      keyPath = resolve(config._configDir, config.firebaseKeyPath);
    } else {
      keyPath = resolve(config.firebaseKeyPath);
    }
  }

  if (!keyPath && config._configDir) {
    const candidate = resolve(config._configDir, 'serviceAccountKey.json');
    if (existsSync(candidate)) keyPath = candidate;
  }

  if (!keyPath) {
    const candidate = resolve(process.cwd(), 'serviceAccountKey.json');
    if (existsSync(candidate)) keyPath = candidate;
  }

  if (!keyPath || !existsSync(keyPath)) {
    console.error('Error: Firebase service account key not found.');
    console.error('Set DOCKET_FIREBASE_KEY_PATH, add firebaseKeyPath to docket.config.json,');
    console.error('or place serviceAccountKey.json next to your config file.');
    process.exit(1);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin.firestore();
}

// ── Command routing ─────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || flags.help) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  // Resolve config (merges CLI flags → env → config file → defaults)
  const config = await resolveConfig(flags);
  const db = initFirebase(config);

  const ctx = { db, admin, config, flags, positional };

  switch (command) {
    case 'list':
    case 'ls': {
      const { run } = await import('../src/commands/list.js');
      await run(ctx);
      break;
    }
    case 'add':
    case 'new': {
      const { run } = await import('../src/commands/add.js');
      await run(ctx);
      break;
    }
    case 'update': {
      const { run } = await import('../src/commands/update.js');
      await run(ctx);
      break;
    }
    case 'done': {
      const { run } = await import('../src/commands/done.js');
      await run(ctx);
      break;
    }
    case 'delete': {
      const { run } = await import('../src/commands/delete.js');
      await run(ctx);
      break;
    }
    case 'seed': {
      const { run } = await import('../src/commands/seed.js');
      await run(ctx);
      break;
    }
    case 'projects': {
      const { run } = await import('../src/commands/projects.js');
      await run(ctx);
      break;
    }
    case 'init': {
      const { run } = await import('../src/commands/init.js');
      await run(ctx);
      break;
    }
    case 'scaffold': {
      const { run } = await import('../src/commands/scaffold.js');
      await run(ctx);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`
Usage: docket <command> [options]

Commands:
  list|ls             List tickets
  add|new             Add a ticket
  update <ID>         Update a ticket (e.g., docket update KB-005 --status done)
  done <ID>           Shortcut for update --status done
  delete <ID>         Delete a ticket permanently (--force skips confirmation)
  seed                Seed sample tickets
  projects <sub>      Manage projects (list, add)
  init <html-file>    Initialize docket in an HTML file
  scaffold <prompt>   Create a new project from a single description

Global flags:
  --project <id>      Override default project
  --user <id>         Override default userId
  --json              Output as JSON
  --help              Show this help
`.trim());
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
