// Usage monitor — periodically checks Claude Max plan usage and pauses
// the orchestrator if any limit reaches the configured threshold.
//
// API endpoint: GET https://api.anthropic.com/api/oauth/usage
// Response shape:
//   {
//     five_hour:        { utilization: 65, resets_at: <iso-string> },  // current session
//     seven_day:        { utilization: 35, resets_at: <iso-string> },  // weekly all models
//     seven_day_sonnet: { utilization: 46, resets_at: <iso-string> },  // weekly Sonnet only
//   }
//
// Token requirements:
//   The endpoint requires an OAuth token with the "user:profile" scope.
//   The CLAUDE_CODE_OAUTH_TOKEN (setup-token) has limited scopes and will
//   receive a permission_error. To enable proactive usage checking, the user
//   must either:
//     a) Run `claude auth login` (stores full OAuth credentials in keychain /
//        ~/.claude/.credentials.json), OR
//     b) Set usageCheckToken in docket.config.json → orchestrator section.
//
//   Without a valid token the monitor falls back to silent noop — workers
//   are unaffected but the proactive 90% pause is unavailable.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';

// ── Token resolution ─────────────────────────────────────────────────────────

/**
 * Try to find an OAuth token with user:profile scope.
 * Priority:
 *   1. Explicit token from config (usageCheckToken)
 *   2. ~/.claude/.credentials.json (plaintext storage written by `claude auth login`)
 *   3. CLAUDE_CODE_OAUTH_TOKEN env var (setup-token — will likely fail scope check)
 */
function resolveUsageToken(explicitToken) {
  if (explicitToken) return explicitToken;

  // Try plaintext credentials file written by `claude auth login`
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credPath)) {
    try {
      const data = JSON.parse(readFileSync(credPath, 'utf-8'));
      if (data?.accessToken) return data.accessToken;
    } catch {
      // malformed file — ignore
    }
  }

  // Fall back to setup-token (may lack user:profile scope)
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

// ── API call ─────────────────────────────────────────────────────────────────

/**
 * Fetch current Max plan usage from the Anthropic API.
 * Returns null if the endpoint is unavailable (scope error, network, etc).
 *
 * @param {string} token  OAuth token
 * @returns {Promise<{five_hour, seven_day, seven_day_sonnet}|null>}
 */
async function fetchUsage(token) {
  try {
    const res = await fetch(USAGE_API, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': ANTHROPIC_BETA,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `HTTP ${res.status}`;
      if (res.status === 403 || body?.error?.type === 'permission_error') {
        // Scope insufficient — don't keep spamming, return a special sentinel
        return { _scopeError: true };
      }
      throw new Error(msg);
    }

    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error('Request timed out');
    }
    throw err;
  }
}

// ── Main factory ─────────────────────────────────────────────────────────────

/**
 * Create a usage monitor that runs alongside the orchestrator.
 *
 * @param {object} opts
 * @param {Function} opts.onPause      Called when usage crosses threshold; receives { reason, resumeAt }
 * @param {Function} opts.onResume     Called when usage drops back below threshold (or reset fires)
 * @param {Function} [opts.onFallback]   Called when Sonnet-only weekly limit crosses fallbackThreshold; receives { reason }
 * @param {Function} [opts.onFallbackRecover]  Called when Sonnet-only weekly limit drops back below fallbackThreshold
 * @param {Function} [opts.onUsageUpdate]  Called with the latest usage data after every successful check; receives { limits, checkedAt }
 * @param {Function} opts.writeLog     writeLogFile function for orchestrator logging
 * @param {number}   [opts.intervalMs]   Check interval (default 30 min)
 * @param {number}   [opts.threshold]    Pause threshold 0–100 (default 90)
 * @param {number}   [opts.fallbackThreshold]  Sonnet→Haiku fallback threshold 0–100 (default 80)
 * @param {string}   [opts.token]        Explicit OAuth token override
 * @returns {{ start, stop }}
 */
export function createUsageMonitor({
  onPause,
  onResume,
  onFallback,
  onFallbackRecover,
  onUsageUpdate,
  writeLog,
  intervalMs = 30 * 60 * 1000,
  threshold = 90,
  fallbackThreshold = 80,
  token: explicitToken = null,
} = {}) {
  let timer = null;
  let resumeTimer = null;
  let paused = false;
  let inFallback = false;
  let scopeErrorLogged = false;
  let token = null;

  function log(msg) {
    if (writeLog) writeLog(`[usage-monitor] ${msg}`);
    else console.log(`[usage-monitor] ${msg}`);
  }

  function scheduleResume(resumeAt) {
    if (resumeTimer) clearTimeout(resumeTimer);
    const delay = Math.max(0, new Date(resumeAt).getTime() - Date.now());
    const mins = Math.round(delay / 60000);
    log(`Scheduling resume in ${mins}m at ${new Date(resumeAt).toLocaleTimeString()}`);
    resumeTimer = setTimeout(() => {
      if (paused) {
        paused = false;
        log('Session has reset — resuming workers');
        if (onResume) onResume();
      }
    }, delay);
  }

  async function check() {
    if (!token) return;

    let data;
    try {
      data = await fetchUsage(token);
    } catch (err) {
      log(`Usage check failed: ${err.message}`);
      return;
    }

    if (!data) return;

    if (data._scopeError) {
      if (!scopeErrorLogged) {
        scopeErrorLogged = true;
        log(
          'Usage check unavailable — token lacks user:profile scope. ' +
          'Run `claude auth login` or set orchestrator.usageCheckToken in config to enable.'
        );
      }
      return;
    }

    // Determine the highest utilization and its reset time
    const limits = [
      { name: 'current session', ...data.five_hour },
      { name: 'weekly (all models)', ...data.seven_day },
      { name: 'weekly (Sonnet)', ...data.seven_day_sonnet },
    ].filter(l => typeof l.utilization === 'number');

    if (limits.length === 0) {
      log('Usage data received but no active limits found');
      return;
    }

    const highest = limits.reduce((a, b) => (a.utilization >= b.utilization ? a : b));
    log(`Usage: ${limits.map(l => `${l.name} ${Math.round(l.utilization)}%`).join(' | ')}`);

    // Emit usage data to caller for Firestore persistence / UI display
    if (onUsageUpdate) {
      onUsageUpdate({ limits, checkedAt: new Date().toISOString() });
    }

    // ── Sonnet-only fallback check ──────────────────────────────────
    // When the Sonnet-only weekly limit crosses fallbackThreshold, switch
    // new workers to Haiku instead of pausing entirely.
    const sonnetLimit = limits.find(l => l.name === 'weekly (Sonnet)');
    if (sonnetLimit) {
      if (!inFallback && sonnetLimit.utilization >= fallbackThreshold) {
        inFallback = true;
        const reason = `weekly (Sonnet) at ${Math.round(sonnetLimit.utilization)}% (fallback threshold ${fallbackThreshold}%)`;
        log(`Sonnet limit reached — falling back to Haiku for new workers`);
        if (onFallback) onFallback({ reason });
      } else if (inFallback && sonnetLimit.utilization < fallbackThreshold) {
        inFallback = false;
        log(`Sonnet usage back below fallback threshold (${Math.round(sonnetLimit.utilization)}%) — resuming Sonnet`);
        if (onFallbackRecover) onFallbackRecover();
      }
    }

    if (!paused && highest.utilization >= threshold) {
      paused = true;
      const reason = `${highest.name} at ${Math.round(highest.utilization)}% (threshold ${threshold}%)`;
      log(`Pausing workers — ${reason}`);
      if (onPause) onPause({ reason, resumeAt: highest.resets_at });
      if (highest.resets_at) scheduleResume(highest.resets_at);
    } else if (paused && highest.utilization < threshold) {
      // All limits back below threshold (e.g., next check after reset)
      paused = false;
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      log(`Usage back below threshold (${Math.round(highest.utilization)}%) — resuming workers`);
      if (onResume) onResume();
    }
  }

  return {
    start() {
      token = resolveUsageToken(explicitToken);
      if (!token) {
        log('No OAuth token available — usage monitoring disabled');
        return;
      }

      // Run an initial check immediately, then on the interval
      check();
      timer = setInterval(check, intervalMs);
      log(`Started — checking every ${Math.round(intervalMs / 60000)}m, threshold ${threshold}%`);
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    },
  };
}
