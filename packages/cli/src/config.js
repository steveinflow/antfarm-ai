// Config resolution with priority:
//   CLI flags  →  env vars  →  docket.config.json  →  Firestore project doc
//
// Config file search: walk upward from cwd, then try ~/.config/docket/

import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const CONFIG_FILENAME = 'docket.config.json';

// ── File search ─────────────────────────────────────────────────────

function findConfigFile() {
  // Walk upward from cwd
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  // Try ~/.config/docket/
  const globalDir = join(homedir(), '.config', 'docket');
  const globalCandidate = join(globalDir, CONFIG_FILENAME);
  if (existsSync(globalCandidate)) return globalCandidate;

  return null;
}

function loadConfigFile() {
  const configPath = findConfigFile();
  if (!configPath) return { _configDir: null };
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    raw._configDir = dirname(configPath);
    raw._configPath = configPath;
    return raw;
  } catch (err) {
    console.error(`Warning: failed to parse ${configPath}: ${err.message}`);
    return { _configDir: dirname(configPath) };
  }
}

// ── Resolve config ──────────────────────────────────────────────────

export async function resolveConfig(flags = {}) {
  // 1. Load file config (lowest priority for values)
  const fileConfig = loadConfigFile();

  // 2. Build merged config. CLI flags > env vars > file config > defaults.
  const config = {
    // Internal: where the config file lives (for resolving relative paths)
    _configDir: fileConfig._configDir,
    _configPath: fileConfig._configPath || null,

    // Firebase
    firebaseKeyPath: flags['firebase-key']
      || process.env.DOCKET_FIREBASE_KEY_PATH
      || fileConfig.firebaseKeyPath
      || null,

    // Default project
    project: flags.project
      || process.env.DOCKET_PROJECT
      || fileConfig.defaults?.project
      || null,

    // Default userId
    userId: flags.user
      || process.env.DOCKET_USER
      || fileConfig.defaults?.userId
      || null,

    // Default admin email — used when creating projects via CLI without --admin-email
    adminEmail: flags['admin-email']
      || process.env.DOCKET_ADMIN_EMAIL
      || fileConfig.defaults?.adminEmail
      || null,

    // Per-project overrides
    projects: fileConfig.projects || {},

    // Orchestrator settings (passed through for other packages)
    orchestrator: fileConfig.orchestrator || {},
  };

  return config;
}
