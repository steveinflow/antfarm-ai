// @docket/orchestrator — error description helper.
// Maps raw errors thrown by the agent SDK / Node to user-friendly one-liners
// that the dashboard / TUI / log file can display without leaking stack traces.

export function describeError(err) {
  const msg = err.message || String(err);

  if (/nested|CLAUDECODE|cannot be launched inside/i.test(msg)) {
    return 'Nested session blocked. Unset CLAUDECODE env var before running orchestrator.';
  }
  if (/aborted by user/i.test(msg) || /process aborted/i.test(msg)) {
    return 'Claude Code process aborted. Check: claude --version, accept ToS, or run claude login.';
  }
  if (/ANTHROPIC_API_KEY/i.test(msg) || /api key/i.test(msg) || /401/i.test(msg) || /authentication/i.test(msg)) {
    return 'ANTHROPIC_API_KEY is missing or invalid. Set it in your shell environment.';
  }
  if (/ENOENT/i.test(msg) && /git/i.test(msg)) {
    return `Git not found or repo path invalid: ${msg}`;
  }
  if (/worktree/i.test(msg)) {
    return `Worktree error: ${msg}`;
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) {
    return `Network error: ${msg}`;
  }
  if (/permission denied/i.test(msg)) {
    return `Permission denied: ${msg}`;
  }
  if (/rate limit/i.test(msg) || /429/i.test(msg)) {
    return `Rate limited by API: ${msg}`;
  }
  if (/overloaded/i.test(msg) || /503/i.test(msg) || /529/i.test(msg)) {
    return `API overloaded: ${msg}`;
  }

  return msg;
}
