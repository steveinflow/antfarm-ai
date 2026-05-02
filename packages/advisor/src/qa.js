// QA persona — drives a headless browser through defined flows and files tickets for failures.
// Playwright must be installed: npm install playwright && npx playwright install chromium
//
// CRITICAL: Only interacts with draft content. Never publishes or modifies public-facing content.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask, askWithImages } from './claude.js';
import { checkDuplicate, checkRejectionMatch } from './dedup.js';
import { fetchRejections, formatRejectionHistory } from './rejection-history.js';
import { assignClusters } from './cluster.js';
import { getValidatedCap } from './engineer.js';
import { captureSession } from './browser-session.js';
import { sanitizeSystemPrompt } from './custom-personas-config.js';

// ── Severity ranking ──────────────────────────────────────────────────────────
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2 };

function sortBySeverity(issues) {
  return [...issues].sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
  );
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `CRITICAL: You are operating on a live production app that real users can see.
Only interact with DRAFT content. Never publish, never modify, never delete
anything that is already published or visible to the public. If a flow requires
publishing to test it, stop and file a ticket noting the limitation instead.

---

You are a senior QA engineer doing exploratory testing on a live web application.

You receive screenshots captured during a Playwright session walking through the app's
main flows, along with the name of each step and any console errors that occurred.
Your job is to identify real, user-facing failures.

Your responsibilities:
1. Spot broken functionality — things that don't work, throw errors, or produce wrong output
2. Catch missing feedback — actions with no response, spinners that never resolve,
   silent failures where the user wouldn't know something went wrong
3. Flag broken states — UI that becomes unresponsive, corrupted layout after an action,
   data that doesn't persist when it should
4. Note console errors that surface to the user or indicate a crash path
5. Identify flows that are impossible to complete (dead ends, broken navigation)

Be precise and actionable. Only file tickets for observable failures a real user would hit.

Do NOT flag:
- Subjective design preferences (that's the design persona's job)
- Code quality or security issues (that's the engineer persona's job)
- Minor cosmetic misalignments that don't impair use
- Theoretical edge cases you didn't actually trigger during the session
- Anything already visible in the existing open tickets

Prioritize: broken > silent failure > unrecoverable state > missing feedback.
For each issue, describe exactly what you did, what you expected, and what happened instead.`;

// ── Prompts ───────────────────────────────────────────────────────────────────

function analysisPrompt(stepSummary, urlLabel) {
  return `Review these screenshots from a QA session on: ${urlLabel}

Each screenshot corresponds to a specific step. Step context:

${stepSummary}

For each issue found, respond with a JSON array of objects:
{
  "title": "Short ticket title (max 80 chars)",
  "description": "Clear explanation of what failed",
  "stepsToReproduce": "Exact sequence of actions that triggered this",
  "expected": "What should have happened",
  "actual": "What actually happened instead",
  "severity": "critical" | "high" | "medium",
  "consoleErrors": "Relevant console errors if any (omit if none)"
}

Only include severity "medium" or above. Return [] if no real failures were observed.
Respond ONLY with valid JSON — no prose, no markdown fences.`;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [qa] ${msg}`);
}

// ── Test Rails — Firestore persistence ────────────────────────────────────────
// Rails stored at /advisor/qa  { testRails: { [projectId]: [...] } }
// Each rail: { id, name, description, steps, addedAt, addedByFeature, lastRunAt, lastResult }

function makeRailId() {
  return `rail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function configFlowsToRails(flows) {
  return flows.map(f => ({
    id: makeRailId(),
    name: f.name,
    description: '',
    steps: f.steps || [],
    critical: true,   // config-defined flows always run every cycle
    addedAt: new Date().toISOString(),
    addedByFeature: null,
    lastRunAt: null,
    lastResult: null,
  }));
}

// Get git log + changed files since a given ISO timestamp.
// Returns { commits, changedFiles } — both empty strings on failure.
function getChangelogSince(repoPath, since) {
  try {
    const sinceArg = new Date(since).toISOString();
    const commits = execSync(
      `git log --since="${sinceArg}" --no-merges --oneline`,
      { cwd: repoPath, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const rawFiles = execSync(
      `git log --since="${sinceArg}" --no-merges --name-only --pretty=format:""`,
      { cwd: repoPath, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const changedFiles = [...new Set(rawFiles.split('\n').filter(Boolean))].join('\n');
    return { commits, changedFiles };
  } catch {
    return { commits: '', changedFiles: '' };
  }
}

// Select which rails to run this cycle:
//   critical (critical !== false): always run
//   periodic (critical === false): run if not run recently (threshold = intervalHours * 2)
function selectRailsForCycle(rails, intervalHours) {
  const critical = rails.filter(r => r.critical !== false);
  const periodic = rails.filter(r => r.critical === false);
  const thresholdMs = (intervalHours || 6) * 2 * 60 * 60 * 1000;
  const now = Date.now();
  const duePeriodic = periodic.filter(r =>
    !r.lastRunAt || (now - new Date(r.lastRunAt).getTime()) > thresholdMs
  );
  return { critical, duePeriodic, selected: [...critical, ...duePeriodic] };
}

async function loadTestRails(db, projectId) {
  const snap = await db.collection('advisor').doc('qa').get();
  if (!snap.exists) return null;
  const map = snap.data()?.testRails;
  if (!map || !(projectId in map)) return null;
  return Array.isArray(map[projectId]) ? map[projectId] : [];
}

async function saveTestRails(db, projectId, rails) {
  await db.collection('advisor').doc('qa').set(
    { testRails: { [projectId]: rails } },
    { merge: true }
  );
}

function generateRailsPrompt(commits, changedFiles, existingNames) {
  const existing = existingNames.size > 0
    ? [...existingNames].map(n => `  - ${n}`).join('\n')
    : '  (none)';
  return `You are a QA engineer building a Playwright regression test suite.

Changelog since last QA run:
\`\`\`
${commits || '(no commits)'}
\`\`\`

Changed files:
\`\`\`
${changedFiles || '(unknown)'}
\`\`\`

Existing rails (do NOT create duplicates of these):
${existing}

Task: for each change that touches user-facing functionality, generate a test rail.
Skip: refactors with no UX change, CI fixes, copy tweaks, backend-only changes, version bumps.

For each rail, set "critical" based on importance:
  critical: true  — core flows every user hits (main navigation, primary CRUD, auth). Run EVERY cycle.
  critical: false — secondary or edge-case flows. Run periodically.

IMPORTANT: Steps must only interact with DRAFT content. Never click "Publish" or submit publicly.

Valid step actions:
  navigate  { "action": "navigate", "value": "/path", "label": "..." }
  click     { "action": "click", "selector": "CSS", "label": "..." }
  fill      { "action": "fill", "selector": "CSS", "value": "text", "label": "..." }
  wait      { "action": "wait", "ms": 1000, "label": "..." }
  screenshot{ "action": "screenshot", "label": "..." }
  scroll    { "action": "scroll", "direction": "down", "label": "..." }

Respond with a JSON array. Each element:
{
  "name": "Short descriptive rail name",
  "description": "What this verifies",
  "critical": true | false,
  "steps": [ ...step objects... ]
}

Return [] if no changes warrant new test rails. Respond ONLY with valid JSON — no prose, no fences.`;
}

function parseRails(raw) {
  if (!raw || !raw.trim()) return [];

  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {} // eslint-disable-line no-empty

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {} // eslint-disable-line no-empty
  }

  const preview = raw.slice(0, 300).replace(/\n/g, ' ');
  log(`Failed to parse rail discovery response as JSON. Raw response preview: "${preview}"`);
  return [];
}

async function discoverNewRails({ db, project, rails, repoPath, model }) {
  // Get the last run time from the QA persona doc
  const personaSnap = await db.collection('advisor').doc('qa').get();
  const lastRunAt = personaSnap.exists ? personaSnap.data()?.lastRunAt : null;
  if (!lastRunAt) return []; // No prior run — nothing to diff against

  if (!repoPath) {
    log(`[${project.id}] No repoPath configured — skipping changelog discovery`);
    return [];
  }

  const { commits, changedFiles } = getChangelogSince(repoPath, lastRunAt);
  if (!commits) {
    log(`[${project.id}] No commits since last run — skipping discovery`);
    return [];
  }

  log(`[${project.id}] Discovery: changelog has ${commits.split('\n').length} commit(s) since last run`);

  const existingNames = new Set(rails.map(r => r.name));

  let raw;
  try {
    raw = await ask(
      'You are a QA engineer generating Playwright regression tests.',
      generateRailsPrompt(commits, changedFiles, existingNames),
      { model }
    );
  } catch (err) {
    log(`[${project.id}] Discovery Claude call failed: ${err.message}`);
    return [];
  }

  const generated = parseRails(raw);
  return generated.map(r => ({
    id: makeRailId(),
    name: r.name,
    description: r.description || '',
    critical: r.critical !== false, // default to critical if Claude omits it
    steps: Array.isArray(r.steps) ? r.steps : [],
    addedAt: new Date().toISOString(),
    addedByFeature: null,
    lastRunAt: null,
    lastResult: null,
  }));
}

// ── JSON parsing ──────────────────────────────────────────────────────────────

function parseIssues(raw) {
  if (!raw || !raw.trim()) return [];

  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {} // eslint-disable-line no-empty

  // Extract first [...] block to handle agent narration before the JSON
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {} // eslint-disable-line no-empty
  }

  const preview = raw.slice(0, 300).replace(/\n/g, ' ');
  log(`Failed to parse response as JSON — skipping. Raw response preview: "${preview}"`);
  return [];
}

// ── Ticket builder ────────────────────────────────────────────────────────────

function buildTicketDescription(issue) {
  const parts = ['## Issue', issue.description, ''];
  if (issue.stepsToReproduce) {
    parts.push('## Steps to Reproduce', issue.stepsToReproduce, '');
  }
  if (issue.expected) parts.push(`**Expected:** ${issue.expected}`, '');
  if (issue.actual)   parts.push(`**Actual:** ${issue.actual}`, '');
  if (issue.consoleErrors) {
    parts.push('## Console Errors', '```', issue.consoleErrors, '```', '');
  }
  parts.push(`**Severity:** ${issue.severity}`, '', '---', '*Generated by EPD Advisor — QA persona*');
  return parts.join('\n');
}

// ── Screenshot persistence ─────────────────────────────────────────────────────

/**
 * Save QA session screenshots to a local directory for inspection.
 * Creates: screenshotDir/{projectId}/{timestamp}/{nn}_{flowName}_{stepName}.png
 *
 * @param {string}   screenshotDir - Root directory to save under
 * @param {string}   projectId
 * @param {string}   timestamp     - ISO timestamp (used as folder name)
 * @param {Array<{flowName: string, stepName: string, screenshot: Buffer}>} stepResults
 * @param {Function} report        - Logging callback
 * @returns {string|null} The directory path if saved, null otherwise
 */
function saveScreenshots(screenshotDir, projectId, timestamp, stepResults, report) {
  if (!screenshotDir || !stepResults.length) return null;
  try {
    const ts = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
    const dir = join(screenshotDir, projectId, ts);
    mkdirSync(dir, { recursive: true });
    stepResults.forEach(({ flowName, stepName, screenshot }, i) => {
      const safeName = `${String(flowName).replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 30)}_${String(stepName).replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 30)}`;
      const filename = `${String(i + 1).padStart(2, '0')}_${safeName}.png`;
      writeFileSync(join(dir, filename), screenshot);
    });
    report(`Screenshots saved → ${dir}`);
    return dir;
  } catch (err) {
    report(`Warning: could not save screenshots: ${err.message}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object} opts.config       - advisor.qa config (model, etc.)
 * @param {string} [opts.screenshotDir] - Directory to save QA screenshots for local inspection
 */
export function createQA({ config, screenshotDir = null }) {
  const model = config.model || 'claude-sonnet-4-6';

  /**
   * Run a QA session for one project.
   *
   * @param {object} opts
   * @param {object}   opts.project       - Firestore project doc
   * @param {string}   opts.appUrl        - App URL to test
   * @param {object[]} opts.flows         - Flow definitions (from config.qaFlows, used for initial seeding)
   * @param {string}   [opts.repoPath]    - Absolute path to project git repo (enables changelog discovery)
   * @param {object}   opts.ticketService
   * @param {object}   [opts.db]
   * @param {Function} [opts.onActivity]
   * @param {string|null} [opts.soulPrompt]
   * @param {string|null} [opts.focusPrompt]
   * @param {string|null} [opts.scopeText] - Optional focus scope for this run (DK-367) — injected as [SCOPE:] block
   * @param {string|null} [opts.feedbackContextBlock]
   * @param {object}   [opts.runLogger]
   * @param {number}   [opts.ticketCap]
   * @param {boolean}  [opts.dryRun] - When true, skip writing tickets; return proposals array instead
   */
  async function runAudit({ project, appUrl, flows = [], repoPath, projectLocalStorage, projectCookies, ticketService, db, onActivity, soulPrompt, focusPrompt, scopeText, feedbackContextBlock, runLogger, ticketCap, dryRun = false }) {
    const intervalHours = config.intervalHours || 6;
    const report = (msg) => {
      log(`[${project.id}] ${msg}`);
      if (onActivity) onActivity(`${project.id}: ${msg}`);
    };

    if (!appUrl) {
      report('No appUrl configured — skipping');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no appUrl` };
    }

    // ── Load or seed test rails ────────────────────────────────
    let rails = [];
    if (db) {
      try {
        const stored = await loadTestRails(db, project.id);
        if (stored !== null) {
          rails = stored;
        } else if (flows.length > 0) {
          rails = configFlowsToRails(flows);
          await saveTestRails(db, project.id, rails);
          report(`Seeded ${rails.length} test rail(s) from config`);
        }
      } catch (err) {
        rails = configFlowsToRails(flows);
        report(`Rail load failed, using config flows: ${err.message}`);
      }
    } else {
      rails = configFlowsToRails(flows);
    }

    if (rails.length === 0) {
      report('No test rails configured — skipping');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no rails` };
    }

    // ── Discover new rails from git changelog ─────────────────
    if (db) {
      try {
        const newRails = await discoverNewRails({ db, project, rails, repoPath, model });
        if (newRails.length > 0) {
          rails = [...rails, ...newRails];
          await saveTestRails(db, project.id, rails);
          const critCount = newRails.filter(r => r.critical !== false).length;
          const perCount  = newRails.length - critCount;
          report(`Discovered ${newRails.length} new rail(s) from changelog (${critCount} critical, ${perCount} periodic)`);
        }
      } catch (err) {
        report(`Changelog discovery skipped: ${err.message}`);
      }
    }

    // ── Select rails for this cycle ────────────────────────────
    const { critical, duePeriodic, selected } = selectRailsForCycle(rails, intervalHours);
    const skippedCount = rails.length - selected.length;
    report(
      `Running ${selected.length} rail(s): ${critical.length} critical` +
      (duePeriodic.length > 0 ? ` + ${duePeriodic.length} periodic` : '') +
      (skippedCount > 0 ? ` (${skippedCount} periodic skipped — not due)` : '')
    );

    if (selected.length === 0) {
      report('No rails due this cycle — skipping');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no rails due` };
    }

    // Playwright session uses only the selected rails for this cycle
    const railsToRun = selected;

    if (runLogger) runLogger.addScanned(appUrl);
    const rejections = db ? await fetchRejections(db, project.id) : [];
    if (rejections.length > 0) report(`${rejections.length} rejection(s) in history`);
    const rejectionHistoryBlock = formatRejectionHistory(rejections, 'qa');

    // Build effective system prompt
    const baseSystemPrompt = soulPrompt || SYSTEM_PROMPT;
    // DK-367: Inject scope as a clearly delimited block early in the system prompt.
    // Scope narrows the QA audit to a specific surface, flow, or segment.
    const baseSystemWithScope = scopeText
      ? `${baseSystemPrompt}\n\n[SCOPE: ${scopeText}]\nFocus your analysis exclusively on the scope defined above.`
      : baseSystemPrompt;
    // SECURITY (DK-306): sanitize user-controlled advisorContext before interpolating into the prompt.
    const safeAdvisorContext = sanitizeSystemPrompt(project.advisorContext || '');
    const systemWithContext = safeAdvisorContext.trim()
      ? `${baseSystemWithScope}\n\n## App Context\n${safeAdvisorContext.trim()}`
      : baseSystemWithScope;
    const systemWithRejections = rejectionHistoryBlock
      ? `${systemWithContext}\n\n${rejectionHistoryBlock}\n\nDo NOT flag issues similar to the rejected ones above.`
      : systemWithContext;
    const systemWithFocus = focusPrompt
      ? `${systemWithRejections}\n\n---\nFocus for this run: ${focusPrompt}`
      : systemWithRejections;
    const effectiveSystemPrompt = feedbackContextBlock
      ? `${systemWithFocus}\n\n---\n${feedbackContextBlock}`
      : systemWithFocus;

    // Run the Playwright session
    let stepResults = [];
    let screenshotFolderPath = null;
    try {
      report('Launching Playwright session…');
      stepResults = await captureSession(appUrl, railsToRun, { onLog: (msg) => log(`[${project.id}] ${msg}`), localStorage: projectLocalStorage, cookies: projectCookies });
      report(`Session complete — ${stepResults.length} screenshot(s) captured`);
    } catch (err) {
      report(`Playwright session failed: ${err.message}`);
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: session error` };
    }

    // Save screenshots to disk so they can be inspected after the run
    if (stepResults.length > 0) {
      const capturedAt = new Date().toISOString();
      screenshotFolderPath = saveScreenshots(screenshotDir, project.id, capturedAt, stepResults, report);
      // DK-405: record the folder path in the run log so the history drawer can link to it
      if (screenshotFolderPath && runLogger) runLogger.setScreenshotFolder(screenshotFolderPath);
    }

    // ── Update per-rail pass/fail results ──────────────────────
    if (db && stepResults.length > 0) {
      const resultsByFlow = {};
      for (const s of stepResults) {
        if (!resultsByFlow[s.flowName]) resultsByFlow[s.flowName] = [];
        resultsByFlow[s.flowName].push(s);
      }
      const updatedRails = rails.map(rail => {
        const results = resultsByFlow[rail.name];
        if (!results) return rail;
        const failed = results.some(s => s.stepFailed);
        const hasErrors = results.some(s => s.consoleErrors.length > 0);
        return {
          ...rail,
          lastRunAt: new Date().toISOString(),
          lastResult: failed ? 'fail' : (hasErrors ? 'warn' : 'pass'),
        };
      });
      rails = updatedRails;
      try {
        await saveTestRails(db, project.id, updatedRails);
      } catch (err) {
        log(`[${project.id}] Failed to save rail results: ${err.message}`);
      }
    }

    if (stepResults.length === 0) {
      report('No screenshots captured — skipping analysis');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no screenshots` };
    }

    // Build the step context block that accompanies the screenshots
    const stepSummary = stepResults.map((s, i) => {
      const lines = [`Screenshot ${i + 1} — Flow: "${s.flowName}" / Step: "${s.stepName}"`];
      if (s.stepFailed) lines.push(`  ⚠ Step action failed: ${s.stepError}`);
      if (s.consoleErrors.length > 0) lines.push(`  Console errors: ${s.consoleErrors.join('; ')}`);
      return lines.join('\n');
    }).join('\n\n');

    // Analyse all screenshots in one Claude call
    report(`Analysing ${stepResults.length} screenshot(s) with Claude…`);
    let raw;
    try {
      const imageBuffers = stepResults.map(s => s.screenshot);
      raw = await askWithImages(effectiveSystemPrompt, imageBuffers, analysisPrompt(stepSummary, appUrl), { model });
    } catch (err) {
      report(`Analysis failed: ${err.message}`);
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: analysis error` };
    }

    const allIssues = parseIssues(raw);
    log(`[${project.id}] QA found ${allIssues.length} issue(s)`);

    if (allIssues.length === 0) {
      report('No issues found');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no issues found` };
    }

    // Apply ticket cap
    const cap = getValidatedCap(ticketCap);
    const rankedIssues = sortBySeverity(allIssues);
    const issuesToCreate = rankedIssues.slice(0, cap);
    const deferredCount = rankedIssues.length - issuesToCreate.length;
    if (deferredCount > 0) {
      report(`Applying cap: creating ${issuesToCreate.length} of ${rankedIssues.length} (${deferredCount} deferred)`);
    }

    report(`Found ${rankedIssues.length} issue(s) — ${dryRun ? 'previewing' : 'creating'} up to ${cap} ticket(s)…`);

    // Use listStubs() for dedup — only needs title/status/snoozedUntil/id,
    // not full ticket documents. Falls back to listAll() for older service instances.
    const existingTickets = await (ticketService.listStubs || ticketService.listAll).call(ticketService);
    let created = 0;
    const skippedReasons = [];
    const dryRunProposals = []; // populated when dryRun: true

    for (const issue of issuesToCreate) {
      if (!issue.title || !issue.description) continue;

      const { isDuplicate, matchTitle, matchId } = checkDuplicate(existingTickets, issue.title);
      if (isDuplicate) {
        log(`[${project.id}] ${dryRun ? '[dry-run] ' : ''}Skip (duplicate of "${matchTitle}"): ${issue.title}`);
        const matchedTicket = existingTickets.find(t => t.title === matchTitle);
        skippedReasons.push({
          title: `[QA] ${issue.title}`,
          reason: 'duplicate: similar to existing ticket',
          ...(matchedTicket?.id ? { matchedTicketId: matchedTicket.id } : {}),
        });
        if (dryRun) {
          dryRunProposals.push({
            title: `[QA] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: 'bug',
            severity: issue.severity,
            advisorPersona: 'qa',
            deduped: true,
            dedupMatchId: matchId || null,
            filterReason: 'duplicate',
          });
        }
        if (runLogger) runLogger.addRejected({ title: issue.title, reason: 'duplicate', matchedTicketId: matchId });
        continue;
      }

      const { isSuppressed, matchTitle: rejMatchTitle, matchCount } = checkRejectionMatch(rejections, issue.title);
      if (isSuppressed) {
        log(`[${project.id}] ${dryRun ? '[dry-run] ' : ''}Skip (matches ${matchCount} rejection(s), similar to "${rejMatchTitle}"): ${issue.title}`);
        skippedReasons.push({
          title: `[QA] ${issue.title}`,
          reason: `duplicate: ${matchCount}% overlap with rejected proposal`,
        });
        if (dryRun) {
          dryRunProposals.push({
            title: `[QA] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: 'bug',
            severity: issue.severity,
            advisorPersona: 'qa',
            deduped: true,
            filterReason: 'rejection_match',
          });
        }
        if (runLogger) runLogger.addRejected({ title: issue.title, reason: 'threshold' });
        continue;
      }

      const ticketDescription = buildTicketDescription(issue);
      const reasoning = {
        summary: `QA session flagged a ${issue.severity || 'medium'}-severity issue: ${issue.title}.`,
        evidence: [],
      };

      if (dryRun) {
        // Dry-run: collect proposal without writing to Firestore
        dryRunProposals.push({
          title: `[QA] ${issue.title}`,
          description: ticketDescription,
          type: 'bug',
          severity: issue.severity,
          advisorPersona: 'qa',
          reasoning_summary: reasoning.summary,
          deduped: false,
        });
        created++;
        existingTickets.push({ title: `[QA] ${issue.title}`, status: 'proposed' });
        log(`[${project.id}] [dry-run] Proposed: ${issue.title}`);
        continue;
      }

      const initialStatus = project.yoloMode ? 'open' : 'proposed';
      log(`[${project.id}] yoloMode=${project.yoloMode} → creating ticket as '${initialStatus}'`);

      const ticket = await ticketService.add({
        type: 'bug',
        title: `[QA] ${issue.title}`,
        description: ticketDescription,
        userId: null,
        userEmail: 'advisor@docket.app',
        status: initialStatus,
        reasoning,
        advisorPersona: 'qa',
      });

      if (db) {
        try {
          const clusterIds = await assignClusters({
            db,
            projectId: project.id,
            title: `[QA] ${issue.title}`,
            description: ticketDescription,
          });
          if (clusterIds.length > 0) {
            await ticketService.update(ticket.id, { clusterIds });
            log(`[${project.id}] Clustered ${ticket.ticketId} → [${clusterIds.join(', ')}]`);
          }
        } catch (err) {
          log(`[${project.id}] Cluster assignment failed for ${ticket.ticketId}: ${err.message}`);
        }
      }

      log(`[${project.id}] Created ${ticket.ticketId}: ${issue.title}`);
      if (runLogger) runLogger.addCreated(ticket.id);
      created++;
      existingTickets.push({ title: ticket.title, status: 'open' });
    }

    const deferredSummary = deferredCount > 0 ? ` (${deferredCount} deferred by cap)` : '';
    const screenshotSuffix = screenshotFolderPath ? ` | screenshots → ${screenshotFolderPath}` : '';
    if (dryRun) {
      report(`Preview complete — ${dryRunProposals.filter(p => !p.deduped).length} proposal(s) found (${dryRunProposals.filter(p => p.deduped).length} deduped)`);
      return {
        ticketsCreated: 0,
        proposalsSkipped: skippedReasons.length,
        skippedReasons,
        proposals: dryRunProposals,
        lastActivity: `${project.id}: dry-run preview — ${dryRunProposals.filter(p => !p.deduped).length} proposals${screenshotSuffix}`,
      };
    }
    report(`QA complete — ${created} ticket(s) created${deferredSummary}`);
    return {
      ticketsCreated: created,
      proposalsSkipped: skippedReasons.length,
      skippedReasons,
      lastActivity: `${project.id}: ${created > 0 ? `${created} ticket(s) created${deferredSummary}` : 'no issues found'}${screenshotSuffix}`,
    };
  }

  return { runAudit };
}
