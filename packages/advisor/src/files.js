// File scanner — recursively collects source files for the engineer persona.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, resolve, sep } from 'node:path';
import pm from 'picomatch';
import { sanitizeExclusionPatterns } from './exclusion-utils.js';

// ── Security exclusion list ───────────────────────────────────────────────
// Directories that are NEVER scanned. This prevents accidentally sending
// build artefacts, VCS internals, cache files, or generated output to the
// LLM where secrets could be present (e.g. .env baked into a minified build,
// or private keys inside a .cache directory).
//
// Exclusion rationale:
//   node_modules  — third-party code, no value auditing upstream packages here
//   .git          — VCS objects; may contain historical secrets in commits
//   dist / build  — compiled output; may embed env vars from build time
//   .next         — Next.js build cache; same risk as dist/build
//   coverage      — test instrumentation artefacts
//   .cache        — tool caches (webpack, babel, etc.)
//   tmp / logs    — transient runtime files; unpredictable content
//   .claude       — Claude Code internal state; must never be sent to any API
//
// Files that are NEVER scanned (SKIP_FILES below) extend this for individual
// filenames that appear at any depth and may contain secrets:
//   .env*             — environment variable files (secrets, API keys)
//   serviceAccountKey.json — Firebase service account private key
//   docket.config.json    — may contain advisor credentials / tokens
//   *.lock / package-lock.json / yarn.lock — lock files are large and useless for auditing
//   .gitignore-matched   — anything the project marks as ignorable is presumed sensitive or irrelevant
//
// If you add a new secret-bearing file pattern, add it to SKIP_FILES below
// AND document it here so reviewers can audit the exclusion list in one place.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', 'tmp', 'logs', '.claude',
]);

// Individual filenames (basename, case-sensitive) that must never be scanned
// regardless of directory location. Matched against entry.name in the walker.
const SKIP_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'serviceAccountKey.json',
  'docket.config.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

// Additional glob-style prefix patterns — entries whose name STARTS WITH one
// of these strings are also skipped. Used for .env variants like .env.staging.
const SKIP_FILE_PREFIXES = ['.env'];

function shouldSkipFile(name) {
  if (SKIP_FILES.has(name)) return true;
  for (const prefix of SKIP_FILE_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.ts', '.tsx', '.jsx',
  '.kt', '.kts', '.java',
  '.json', '.rules', '.yaml', '.yml',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100 KB — skip very large files
const MAX_FILES = 80;             // cap total files per scan

/**
 * Validate a user-supplied focus path for the engineer persona.
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * Rules:
 *  - Must be a non-empty string
 *  - Must be relative (no leading '/')
 *  - Must not escape the project root via '..' traversal
 *  - Max 200 characters
 *
 * @param {string} rawPath
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFocusPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { valid: false, reason: 'path must be a non-empty string' };
  }
  if (rawPath.length > 200) {
    return { valid: false, reason: 'path exceeds 200 character limit' };
  }
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { valid: false, reason: 'absolute paths are not allowed — use paths relative to project root' };
  }
  // Reject traversal sequences
  const parts = trimmed.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (part === '..') {
      return { valid: false, reason: 'path must not contain ".." traversal sequences' };
    }
  }
  return { valid: true };
}

/**
 * Recursively scan a directory, returning source files.
 *
 * Exclusion patterns (from `options.exclusions`) are applied AFTER the file
 * list is enumerated within the repo root — never as arguments to fs operations.
 * This prevents path traversal via user-supplied globs.
 *
 * includePaths, if non-empty, restrict scanning to files whose repo-relative path
 * is matched by at least one of the glob patterns (picomatch).  This is the
 * security boundary for the Engineer focusAreas feature — all paths are validated
 * before use and resolved/asserted within the repo root.
 *
 * excludePaths, if non-empty, drop files matched by any glob pattern AFTER the
 * includePaths filter.  Rejection is logged (not silently dropped) so users
 * can see when their config removes files.
 *
 * @param {string} basePath - Root of the repo
 * @param {string[]} subPaths - Subdirectories to scan (relative to basePath)
 * @param {object} [options]
 * @param {string[]} [options.extensions]   - Override SOURCE_EXTENSIONS
 * @param {string[]} [options.exclusions]   - Glob patterns (picomatch) to exclude.
 *                                            Applied against repo-relative paths after enumeration.
 *                                            Invalid/dangerous patterns are silently skipped.
 * @param {function} [options.onExcluded]   - Optional callback(path) called for each excluded file.
 * @param {string[]} [options.includePaths] - Glob patterns — only files that match at least one are kept.
 *                                            Empty/missing means scan everything (no restriction).
 * @param {string[]} [options.excludePaths] - Glob patterns — files that match are dropped.
 *                                            Logged with a warning (not silently skipped).
 * @param {function} [options.onWarn]       - Optional callback(msg) for security/validation warnings.
 * @returns {Promise<Array<{ path: string, content: string }>>}
 */
export async function scanFiles(basePath, subPaths = ['.'], options = {}) {
  const exts = options.extensions
    ? new Set(options.extensions)
    : SOURCE_EXTENSIONS;

  const warn = (msg) => {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const text = `[${ts}] [files] Warning: ${msg}`;
    console.warn(text);
    if (options.onWarn) options.onWarn(msg);
  };

  // Validate and build the exclusion matcher once — picomatch is safe against
  // pathological patterns; we also pre-validate above in sanitizeExclusionPatterns.
  const rawExclusions = options.exclusions ?? [];
  const safeExclusions = sanitizeExclusionPatterns(rawExclusions, 'glob', warn);
  const isExcluded = safeExclusions.length
    ? pm(safeExclusions, { dot: true })
    : () => false;

  // ── includePaths filter (Engineer focusAreas) ─────────────────────────────
  // Each path is validated: relative-only, no traversal. Paths that fail the
  // check are logged with a WARNING and rejected — not silently skipped.
  // An empty includePaths means "scan everything" (no restriction).
  const rawInclude = Array.isArray(options.includePaths) ? options.includePaths : [];
  const safeInclude = [];
  for (const p of rawInclude) {
    const { valid, reason } = validateFocusPath(p);
    if (!valid) {
      warn(`Rejecting includePath "${p}": ${reason}`);
    } else {
      safeInclude.push(p.trim());
    }
  }
  const isIncluded = safeInclude.length
    ? pm(safeInclude, { dot: true })
    : null; // null = no restriction

  // ── excludePaths filter (Engineer focusAreas) ─────────────────────────────
  const rawExclude = Array.isArray(options.excludePaths) ? options.excludePaths : [];
  const safeExclude = [];
  for (const p of rawExclude) {
    const { valid, reason } = validateFocusPath(p);
    if (!valid) {
      warn(`Rejecting excludePath "${p}": ${reason}`);
    } else {
      safeExclude.push(p.trim());
    }
  }
  const isFocusExcluded = safeExclude.length
    ? pm(safeExclude, { dot: true })
    : () => false;

  const results = [];

  async function walk(dir) {
    if (results.length >= MAX_FILES) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory may not exist — skip silently
    }

    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (shouldSkipFile(entry.name)) continue;
        if (!exts.has(extname(entry.name))) continue;
        try {
          const info = await stat(fullPath);
          if (info.size > MAX_FILE_SIZE) continue;
          const content = await readFile(fullPath, 'utf-8');
          const relPath = relative(basePath, fullPath);

          // Apply user exclusion patterns — checked against repo-relative path
          // AFTER enumeration (not as a glob to fs.readdir or similar).
          if (isExcluded(relPath)) {
            if (options.onExcluded) options.onExcluded(relPath);
            continue;
          }

          // Apply includePaths filter (focusAreas): if set, only keep matching files.
          if (isIncluded !== null && !isIncluded(relPath)) {
            continue;
          }

          // Apply excludePaths filter (focusAreas): drop matching files.
          if (isFocusExcluded(relPath)) {
            if (options.onExcluded) options.onExcluded(relPath);
            continue;
          }

          results.push({ path: relPath, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  const realBase = resolve(basePath);

  for (const sub of subPaths) {
    const target = join(basePath, sub);
    const realTarget = resolve(target);
    if (!realTarget.startsWith(realBase + sep) && realTarget !== realBase) {
      throw new Error(`Path traversal detected: "${sub}" escapes base directory`);
    }
    await walk(target);
    if (results.length >= MAX_FILES) break;
  }

  return results;
}

/**
 * Validate a user-supplied pin glob for the engineer persona.
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * Rules (stricter than validateFocusPath — these are written to Firestore):
 *  - Must be a non-empty string
 *  - Must be relative (no leading '/', no drive letter, no '~')
 *  - Must not contain '..' traversal sequences
 *  - Max 64 characters per glob
 *
 * @param {string} rawGlob
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePinGlob(rawGlob) {
  if (typeof rawGlob !== 'string' || rawGlob.trim().length === 0) {
    return { valid: false, reason: 'glob must be a non-empty string' };
  }
  const trimmed = rawGlob.trim();
  if (trimmed.length > 64) {
    return { valid: false, reason: 'glob exceeds 64 character limit' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { valid: false, reason: 'absolute paths are not allowed — use paths relative to project root' };
  }
  const parts = trimmed.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (part === '..') {
      return { valid: false, reason: 'glob must not contain ".." traversal sequences' };
    }
  }
  return { valid: true };
}

/**
 * Scan files with pinned globs taking priority.
 *
 * Pinned globs are expanded first; matching files appear at the head of the
 * returned list. The remaining files (not matched by any pin) are appended
 * after. This ordering is the sole priority mechanism — no scoring.
 *
 * Security: every resolved path is verified to be inside basePath before
 * being included. Globs are validated with validatePinGlob() before calling
 * this function; callers must not pass unvalidated user input here.
 *
 * @param {string} basePath - Root of the repo
 * @param {string[]} subPaths - Subdirectories to scan (relative to basePath)
 * @param {string[]} pinnedGlobs - Validated relative glob patterns to prioritize
 * @param {object} [options] - Same options as scanFiles()
 * @returns {Promise<Array<{ path: string, content: string }>>}
 */
export async function scanFilesWithPins(basePath, subPaths = ['.'], pinnedGlobs = [], options = {}) {
  // Full scan (respects all existing options: exclusions, includePaths, etc.)
  const allFiles = await scanFiles(basePath, subPaths, options);

  if (!pinnedGlobs || pinnedGlobs.length === 0) {
    return allFiles;
  }

  // Build a set of safe, validated globs (reject any that fail validation)
  const safeGlobs = pinnedGlobs.filter(g => validatePinGlob(g).valid);
  if (safeGlobs.length === 0) {
    return allFiles;
  }

  const isPinned = pm(safeGlobs, { dot: true });

  // Partition into pinned (front) and unpinned (rest), preserving order within each group
  const pinned = [];
  const rest = [];
  for (const file of allFiles) {
    if (isPinned(file.path)) {
      pinned.push(file);
    } else {
      rest.push(file);
    }
  }

  return [...pinned, ...rest];
}

/**
 * Chunk an array of files into batches for API calls.
 * Keeps total character count under the limit per batch.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @param {number} [maxCharsPerBatch]
 * @returns {Array<Array<{ path: string, content: string }>>}
 */
export function batchFiles(files, maxCharsPerBatch = 80_000) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const file of files) {
    const fileChars = file.path.length + file.content.length;
    if (current.length > 0 && currentChars + fileChars > maxCharsPerBatch) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(file);
    currentChars += fileChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Format a batch of files into a single string for the prompt.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @returns {string}
 */
export function formatFileBatch(files) {
  return files.map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
}
