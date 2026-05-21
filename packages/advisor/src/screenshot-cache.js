// Screenshot source for visual custom personas.
//
// A custom persona marked `visual: true` analyzes rendered UI screenshots.
// Instead of driving a browser itself (see browser-session.js for that path),
// it delegates capture to an operator-configured shell command
// (`screenshotCommand` in docket.config.json) that writes PNGs into
// `screenshotDir`. Capture can be expensive, and persona cycles run on a
// timer, so results are cached: the command only re-runs when the directory's
// PNGs are older than CACHE_TTL_MS.
//
// getScreenshots() returns an array of PNG Buffers ready to hand to
// askWithImages(). It throws on capture failure; callers (custom-persona.js)
// catch and fall back to text-only analysis.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_IMAGES = 12;

function pngFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .map((f) => join(dir, f))
    .sort();
}

function newestMtimeMs(files) {
  let newest = 0;
  for (const f of files) {
    try {
      newest = Math.max(newest, statSync(f).mtimeMs);
    } catch {
      // file vanished between readdir and stat — ignore
    }
  }
  return newest;
}

/**
 * Capture (or reuse cached) screenshots for a project and return PNG buffers.
 *
 * @param {string} projectId
 * @param {{ screenshotCommand?: string, screenshotDir?: string, repoPath?: string }} ssConfig
 *   - screenshotCommand: shell command that writes PNGs into screenshotDir
 *   - screenshotDir:     directory the command populates and we read from
 *   - repoPath:          cwd for the command (defaults to process.cwd())
 * @returns {Promise<Buffer[]>} PNG buffers (empty array if nothing was produced)
 */
export async function getScreenshots(projectId, ssConfig) {
  const { screenshotCommand, screenshotDir, repoPath } = ssConfig || {};
  if (!screenshotCommand || !screenshotDir) return [];

  mkdirSync(screenshotDir, { recursive: true });

  let files = pngFiles(screenshotDir);
  const fresh = files.length > 0 && (Date.now() - newestMtimeMs(files)) < CACHE_TTL_MS;

  if (!fresh) {
    // screenshotCommand is operator config (docket.config.json), same trust
    // level as the git commands run elsewhere in the advisor.
    execSync(screenshotCommand, {
      cwd: repoPath || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
    });
    files = pngFiles(screenshotDir);
  }

  return files.slice(0, MAX_IMAGES).map((f) => readFileSync(f));
}
