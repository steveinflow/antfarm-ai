// Design persona — audits the app UI using headless Chromium.
// Called once per project per cycle. Receives project context from Firestore.
//
// Requires Playwright: npm install playwright && npx playwright install chromium

import { ask, askWithImages } from './claude.js';
import { checkDuplicate, checkRejectionMatch, getValidatedDedupThreshold, checkConvergence } from './dedup.js';
import { writeConvergence } from './convergence.js';
import { fetchRejections, formatRejectionHistory } from './rejection-history.js';
import { assignClusters } from './cluster.js';
import { captureSession, resolveUrl, checkUrlReachable, isSafeUrl } from './browser-session.js';
import { annotateScreenshot } from './annotate-screenshot.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeExclusionPatterns, isUrlExcluded } from './exclusion-utils.js';

import { getValidatedCap } from './engineer.js';
import { scoreProposal } from './scoreProposal.js';
import { FILTER_REASONS } from './filter-reasons.js';
import { validateFocus, buildFocusConstraintBlock } from './focus-validator.js';
import { injectPriorities, injectTopicExclusions, injectRejectionHistory, injectFocusDirective, injectCustomInstructions, buildScopeBlock } from './prompt-builder.js';
import { sanitizeSystemPrompt } from './custom-personas-config.js';
import { buildInitialConsensus } from './consensus.js';

// ── Impact ranking ────────────────────────────────────────────────────────
// Rank design issues by type: accessibility and ux friction first, then
// visual polish, then new-feature requests.
const DESIGN_TYPE_RANK = { accessibility: 0, ux: 1, visual: 2, 'new-feature': 3 };

function sortDesignByImpact(issues) {
  return [...issues].sort((a, b) => {
    const ra = DESIGN_TYPE_RANK[a.type] ?? 2;
    const rb = DESIGN_TYPE_RANK[b.type] ?? 2;
    return ra - rb;
  });
}

// ── Cookie / localStorage safety ─────────────────────────────────────────
// These patterns match names commonly used for auth tokens, session IDs,
// CSRF tokens, and other sensitive credentials.  Injecting them from config
// would allow session hijacking, especially when combined with SSRF.
//
// Keys that match any of these patterns are silently dropped; a warning is
// logged so operators know why a configured value was not applied.
const SENSITIVE_KEY_PATTERNS = [
  /session/i,
  /\bsid\b/i,
  /\bauth/i,
  /\btoken/i,
  /\bjwt\b/i,
  /\bcsrf\b/i,
  /\bxsrf\b/i,
  /\bsecret/i,
  /\bcredential/i,
  /\bpassword/i,
  /\bapikey/i,
  /\bapi[_-]?key/i,
  /\baccess[_-]?key/i,
  /\bprivate[_-]?key/i,
  /\brefresh[_-]?token/i,
  /\baccess[_-]?token/i,
  /\bid[_-]?token/i,
];

function isSensitiveKey(name) {
  return SENSITIVE_KEY_PATTERNS.some(re => re.test(name));
}

/**
 * Filter an array of Playwright cookie objects, removing any whose name
 * matches a sensitive-key pattern.  Returns the safe subset.
 */
function filterCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  const safe = [];
  for (const cookie of cookies) {
    if (isSensitiveKey(cookie.name || '')) {
      log(`Blocked injection of sensitive cookie: "${cookie.name}"`);
    } else {
      safe.push(cookie);
    }
  }
  return safe;
}

/**
 * Filter a localStorage key-value map, removing entries whose key matches
 * a sensitive-key pattern.  Returns a new object with only the safe entries.
 */
function filterLocalStorage(items) {
  if (!items || typeof items !== 'object') return {};
  const safe = {};
  for (const [key, value] of Object.entries(items)) {
    if (isSensitiveKey(key)) {
      log(`Blocked injection of sensitive localStorage key: "${key}"`);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

const SYSTEM_PROMPT = `You are a senior UX designer and visual design expert auditing a web application. You are opinionated, thorough, and proactive — your job is to find things to improve, not to give a clean bill of health.

Your focus areas:
1. Visual aesthetics — inconsistent spacing, jarring colors, rough edges, unpolished elements
2. UX friction — unnecessary clicks, unclear labels, confusing flows, missing affordances
3. Usability — missing loading states, unhelpful error messages, poor empty states
4. Accessibility basics — contrast issues, missing focus styles, non-descriptive buttons
5. Simplification opportunities — controls, forms, or flows that could be collapsed, merged, or removed entirely
6. Standardization gaps — similar UI patterns implemented differently in different parts of the app (e.g. inconsistent button styles, mixed modal vs inline editing, different date formats)
7. New controls or shortcuts that would meaningfully reduce friction for the user

Be specific about what you see. Reference visual elements by their position and appearance.
Actively look for things to improve — err on the side of flagging more issues rather than fewer. If something could be simpler or more consistent, flag it.`;

function screenshotPrompt(urlList, focusPrompt) {
  // DK-321: User hint uses explicit header clearly separated from system instructions.
  const focusSection = focusPrompt
    ? `\n\n---\nUser context (one-time override):\n${focusPrompt}\nPrioritise issues within this focus area. Only report issues outside this area if they are severe.\n`
    : '';
  return `Review these screenshots of the application and identify UI issues. You should find issues — if everything looked perfect you would not be here.
${focusSection}
Pay special attention to:
- UI elements that could be simplified (e.g. multi-step forms that could be one step, controls that could be removed or merged)
- Inconsistencies where similar things are presented differently (e.g. two screens that do similar things but use different patterns, mixed button styles, inconsistent spacing)
- Anything that looks unpolished, cluttered, or harder to use than it needs to be

For each issue, respond with a JSON array of objects:
{
  "title": "Short ticket title (max 80 chars)",
  "description": "What the problem is and where it appears",
  "suggestion": "How to improve it",
  "type": "ux" | "visual" | "accessibility" | "new-feature",
  "confidence": 7,
  "annotations": [
    {
      "x": 120,
      "y": 340,
      "width": 200,
      "height": 60,
      "label": "short label describing the problem (e.g. 'missing focus ring')"
    }
  ]
}

annotations is optional — include it only when you can identify a specific visual region in the screenshot that illustrates the issue.
x, y are the top-left corner of the bounding box in pixels. width and height are the bounding box dimensions.
Each annotation label must be concise (max 40 chars) and describe the specific problem in that region.
confidence is an integer 1–10 rating how certain you are this is a real, actionable UI issue worth a ticket (10 = certain, 1 = speculative). Be honest — do not inflate scores.

Aim to return at least 3-5 issues. Only return [] if the UI is genuinely flawless.
Respond ONLY with valid JSON — no prose, no markdown fences.

These screenshots are from: ${urlList}`;
}

/**
 * Prompt variant for screenshots captured during an interactive Playwright session.
 * Includes step context so Claude understands what state the UI is in at each screenshot.
 */
function interactiveScreenshotPrompt(stepSummary, focusPrompt) {
  // DK-321: User hint uses explicit header clearly separated from system instructions.
  const focusSection = focusPrompt
    ? `\n\n---\nUser context (one-time override):\n${focusPrompt}\nPrioritise issues within this focus area. Only report issues outside this area if they are severe.\n`
    : '';
  return `Review these screenshots from an interactive session with the application. Each screenshot was captured after a specific user action, so you can see the app in real states (filled forms, loaded content, post-interaction UI) rather than just empty page loads.
${focusSection}
Step context for each screenshot:
${stepSummary}

Pay special attention to:
- UI elements that could be simplified (e.g. multi-step flows that could be one step, controls that could be removed or merged)
- Inconsistencies where similar things are presented differently across states
- Anything that looks unpolished, cluttered, or harder to use than it needs to be
- Feedback quality — does the app clearly communicate what happened after each action?
- Empty states, loading states, or post-action states that are unclear or missing

For each issue, respond with a JSON array of objects:
{
  "title": "Short ticket title (max 80 chars)",
  "description": "What the problem is and where it appears",
  "suggestion": "How to improve it",
  "type": "ux" | "visual" | "accessibility" | "new-feature",
  "confidence": 7,
  "annotations": [
    {
      "x": 120,
      "y": 340,
      "width": 200,
      "height": 60,
      "label": "short label describing the problem (e.g. 'missing focus ring')"
    }
  ]
}

annotations is optional — include it only when you can identify a specific visual region.
confidence is an integer 1–10 rating how certain you are this is a real, actionable UI issue worth a ticket (10 = certain, 1 = speculative). Be honest — do not inflate scores.
Aim to return at least 3-5 issues. Only return [] if the UI is genuinely flawless.
Respond ONLY with valid JSON — no prose, no markdown fences.`;
}

function textAuditPrompt(advisorContext, focusPrompt) {
  // DK-321: User hint uses explicit header clearly separated from system instructions.
  const focusSection = focusPrompt
    ? `\n\n---\nUser context (one-time override):\n${focusPrompt}\nPrioritise issues within this focus area. Only report issues outside this area if they are severe.\n`
    : '';
  // SECURITY (DK-306): sanitize user-controlled advisorContext before interpolating into the prompt.
  const safeContext = sanitizeSystemPrompt(advisorContext || '');
  return `Without screenshots, review this app based on its context and known UX patterns.
Identify at least 5 meaningful UX improvements this app could benefit from. Be thorough and opinionated — look for simplification opportunities, standardization gaps, and friction points.
${focusSection}
Consider:
- Flows or forms that are likely more complex than they need to be
- UI patterns that are commonly inconsistent across similar apps (e.g. mixed modal vs inline editing, inconsistent empty states)
- Common usability problems for this type of app (missing loading states, unclear error messages, hard-to-scan lists)
- Anything that could be merged, removed, or made more consistent

Product context:
${safeContext}

Respond with a JSON array of objects with this shape:
{
  "title": "Short ticket title (max 80 chars)",
  "description": "What the problem is and where it appears",
  "suggestion": "How to improve it",
  "type": "ux" | "visual" | "accessibility" | "new-feature",
  "confidence": 7
}

confidence is an integer 1–10 rating how certain you are this is a real, actionable UI issue worth a ticket (10 = certain, 1 = speculative). Be honest — do not inflate scores.
Respond ONLY with valid JSON — no prose, no markdown fences.`;
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [design] ${msg}`);
}

function parseIssues(raw) {
  if (!raw || !raw.trim()) return [];

  // Strip markdown code fences and try a direct parse first
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {} // eslint-disable-line no-empty

  // Claude Code agents often narrate while reading files, so the JSON array may
  // be embedded in prose.  Extract the first [...] block and parse that.
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

/**
 * Upload a screenshot buffer to Firebase Storage and return the gs:// URL.
 * Only uploaded URLs explicitly configured — callers decide when to call this.
 *
 * @param {object} storage - Firebase Storage bucket (from admin.storage().bucket())
 * @param {Buffer} buffer  - PNG screenshot buffer
 * @param {string} ticketId - Firestore ticket doc id (used as the storage path)
 * @returns {Promise<string>} gs:// URL
 */
async function uploadScreenshot(storage, buffer, ticketId) {
  const storagePath = `advisor/screenshots/${ticketId}.png`;
  const file = storage.file(storagePath);
  await file.save(buffer, {
    metadata: { contentType: 'image/png' },
  });
  return `gs://${storage.name}/${storagePath}`;
}

/**
 * @param {object} opts
 * @param {object} opts.config   - advisor.design config (model, reviewGate, cookies, localStorage)
 * @param {object} [opts.storage] - Firebase Storage bucket instance (admin.storage().bucket()).
 *                                  If provided, screenshots are uploaded to Storage and the gs:// URL
 *                                  is stored on the ticket. If absent, screenshots are not stored.
 *                                  WARNING: Screenshots are stored and visible to anyone with project access.
 *                                  Only configure URLs you intend to have screenshots of.
 */
export function createDesigner({ config, storage, screenshotDir = null }) {
  const model = config.model || 'claude-sonnet-4-6';

  // Save all screenshots from a run to screenshotDir for local inspection.
  // Returns the directory path if saved successfully, null otherwise.
  function saveScreenshots(projectId, timestamp, items, report) {
    if (!screenshotDir || !items.length) return null;
    try {
      const ts = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
      const dir = join(screenshotDir, projectId, ts);
      mkdirSync(dir, { recursive: true });
      items.forEach(({ name, buffer }, i) => {
        const safeName = String(name).replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60).trim();
        const filename = `${String(i + 1).padStart(2, '0')}_${safeName}.png`;
        writeFileSync(join(dir, filename), buffer);
      });
      report(`Screenshots saved → ${dir}`);
      return dir;
    } catch (err) {
      report(`Warning: could not save screenshots: ${err.message}`);
      return null;
    }
  }

  async function captureScreenshots(appUrl, flows, { localStorage: projectLocalStorage, cookies: projectCookies } = {}) {
    // SSRF guard: validate appUrl before launching any browser.
    // appUrl comes from Firestore config (user-controlled) and must not point
    // at localhost, private IP ranges, or cloud metadata endpoints.
    const appUrlSsrfCheck = isSafeUrl(appUrl);
    if (!appUrlSsrfCheck.safe) {
      throw new Error(`SSRF guard: appUrl "${appUrl}" is not allowed — ${appUrlSsrfCheck.reason}`);
    }

    let chromium;
    try {
      const pw = await import('playwright');
      chromium = pw.chromium;
    } catch {
      throw new Error('Playwright not installed. Run: npm install playwright && npx playwright install chromium');
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // Merge design-wide cookies/localStorage with per-project overrides, then
    // filter out any keys that match sensitive patterns (session tokens, auth
    // cookies, CSRF tokens, etc.).  Values come from user-controlled
    // docket.config.json so filtering is required to prevent session hijacking.
    const mergedCookies = filterCookies([...(config.cookies || []), ...(projectCookies || [])]);
    const mergedLocalStorage = filterLocalStorage({ ...(config.localStorage || {}), ...(projectLocalStorage || {}) });

    if (mergedCookies.length > 0) {
      await context.addCookies(mergedCookies);
    }
    if (Object.keys(mergedLocalStorage).length > 0) {
      await context.addInitScript((items) => {
        for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
      }, mergedLocalStorage);
    }

    const screenshots = [];
    const page = await context.newPage();

    for (const flow of flows) {
      const url = resolveUrl(appUrl, flow);
      log(`Navigating to ${url}`);

      // SSRF guard: re-validate each resolved URL in case a flow entry was an
      // absolute URL pointing at a private target (resolveUrl passes through
      // absolute URLs unchanged when flow starts with 'http').
      const ssrfCheck = isSafeUrl(url);
      if (!ssrfCheck.safe) {
        log(`Skipping ${url} — SSRF guard: ${ssrfCheck.reason}`);
        continue;
      }

      // Validate URL before navigating — a 4xx/5xx means we'd screenshot an error
      // page rather than the actual application.
      const { ok: urlOk, status: urlStatus } = await checkUrlReachable(url);
      if (!urlOk) {
        log(`Skipping ${url} — HTTP ${urlStatus || 'error'} (check appUrl / appFlows config)`);
        continue;
      }

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForTimeout(1_000);
        const buf = await page.screenshot({ fullPage: true, type: 'png' });
        screenshots.push({ url, buffer: buf });
        log(`Captured ${url} (${Math.round(buf.length / 1024)}KB)`);
      } catch (err) {
        log(`Failed to capture ${url}: ${err.message}`);
      }
    }

    await browser.close();
    return screenshots;
  }

  /**
   * Audit one project.
   *
   * @param {object} opts
   * @param {object} opts.project       - Firestore project doc (id, name, advisorContext)
   * @param {string} [opts.appUrl]      - App URL to screenshot (from config.projects[id])
   * @param {string[]} [opts.flows]     - URL paths to visit (static navigation)
   * @param {object[]} [opts.qaFlows]   - Interactive flow definitions (shared with QA persona)
   *                                      When present, an interactive Playwright session is run
   *                                      instead of static URL navigation, giving richer screenshots.
   * @param {object} opts.ticketService
   * @param {Function} [opts.onActivity] - Optional callback(msg) for live activity reporting
   * @param {string|null} [opts.soulPrompt] - Optional system prompt override (from Firestore)
   * @param {string|null} [opts.focusPrompt] - Optional on-demand focus prompt (appended after delimiter)
   * @param {string|null} [opts.scopeText] - Optional focus scope for this run (DK-367) — injected as [SCOPE:] block
   * @param {string|null} [opts.feedbackContextBlock] - Optional feedback signal block to append to system prompt
   * @param {object} [opts.runLogger] - Optional RunLogger accumulator (from createRunLogger)
   * @param {number} [opts.ticketCap] - Max tickets to create this run (default 3, range 1–50)
   * @param {number} [opts.dedupThreshold] - Dedup sensitivity integer from Firestore (1–10, default 3).
   *   Passed to checkDuplicate/checkRejectionMatch; clamped by getValidatedDedupThreshold before use.
   * @param {string|null} [opts.personaInstructions] - Optional project-specific instructions appended to system prompt
   * @param {string[]} [opts.exclusions] - URL prefix patterns to skip (from Firestore project exclusions.design)
   * @param {string|null} [opts.weightPriorityLine] - DK-105: Optional priority line built from per-project emphasis weights
   * @param {boolean} [opts.dryRun] - When true, skip writing tickets; return proposals array instead
   * @param {string[]} [opts.urlPatterns] - Relative URL path patterns to restrict the scan to (focusAreas.design).
   *                                        Only paths whose relative form matches at least one pattern are visited.
   *                                        Full URLs and hostnames are rejected — base URL is always injected server-side.
   * @param {string|null} [opts.directive] - DK-319: Per-persona per-project focus directive (plain text, already sanitized)
   * @param {object|null} [opts.focus] - DK-187: Validated focus config from Firestore { routes: string[] }.
   *   Injected as a <focus_constraints> block into the system prompt. Pre-validated by validateFocus().
   * @param {string|null} [opts.priorities] - DK-302: Current team priorities from advisorContext.priorities.
   *   Injected before all other prompt modifiers when non-empty. Trim and cap enforced by prompt-builder.
   * @param {string|null} [opts.focusAreaTopics] - DK-301: Comma-separated topic keywords (legacy string format).
   *   Injected as a labeled context block. Treated as untrusted freeform content, not instructions.
   * @param {string[]} [opts.scopeTopics] - DK-134: Topic tags from per-project scope.topics[].
   *   Takes precedence over focusAreaTopics when set. Injected via buildScopeBlock().
   * @param {string[]|null} [opts.pinnedUrls] - DK-124: Validated relative URL paths from advisorPins.design.
   *   Pinned paths are moved to the front of the flows queue (prepend-then-continue). Non-pinned flows
   *   still run after pinned ones — pins are weighted, not exclusive.
   *   Validation: must start with '/', must not contain '://' or start with '//'.
   *   The full URL is constructed by appending each pin to appUrl (server-controlled) — never used raw.
   * @param {number} [opts.minConfidence] - DK-188: Minimum confidence score (1–10). Issues scoring below
   *   this threshold are discarded and logged instead of creating tickets. Default 5 if missing.
   * @param {object|null} [opts.consensusGate] - Cross-persona consensus gate config (DK-194).
   *   When enabled, tickets are written with a consensus field and stay in 'proposed' until
   *   enough other personas have endorsed them. Shape: { enabled, threshold }.
   *   When null or disabled, behaviour is unchanged (yoloMode still controls proposed vs open).
   * @returns {Promise<{ ticketsCreated: number, lastActivity: string, proposals?: object[] }>}
   */
  async function runAudit({ project, appUrl, flows = ['/'], qaFlows, projectLocalStorage, projectCookies, ticketService, db, onActivity, soulPrompt, focusPrompt, scopeText, feedbackContextBlock, runLogger, ticketCap, dedupThreshold, personaInstructions, exclusions, weightPriorityLine, dryRun = false, urlPatterns, directive, focus, priorities, focusAreaTopics, topicExclusions, pinnedUrls, minConfidence, consensusGate = null, scopeTopics }) {
    const report = (msg) => {
      log(`[${project.id}] ${msg}`);
      if (onActivity) onActivity(`${project.id}: ${msg}`);
    };

    report('Starting UX audit…');

    // Apply URL exclusion patterns — filter flows and qaFlows before Playwright navigates.
    // Patterns are validated at write time; sanitizeExclusionPatterns handles runtime safety.
    const rawUrlExclusions = Array.isArray(exclusions) ? exclusions : [];
    const safeUrlExclusions = sanitizeExclusionPatterns(rawUrlExclusions, 'url', (msg) => {
      log(`[${project.id}] Warning: ${msg}`);
    });
    let exclusionSkipCount = 0;

    // DK-101: focusAreas urlPatterns — restrict flows to only paths matching the given patterns.
    // Patterns must be relative paths (no scheme, no host). Absolute URLs are rejected with a warning.
    // The base URL is always injected server-side — never from user-supplied data — to prevent SSRF.
    const rawUrlPatterns = Array.isArray(urlPatterns) ? urlPatterns : [];
    const safeUrlPatterns = [];
    for (const p of rawUrlPatterns) {
      if (typeof p !== 'string' || p.trim().length === 0) continue;
      const trimmed = p.trim().toLowerCase();
      // Reject patterns that include a scheme or host — relative paths only
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed) || /^\/\//.test(trimmed)) {
        log(`[${project.id}] Warning: Rejecting urlPattern "${p}": must be a relative path (no scheme or host). The base URL is injected server-side.`);
        continue;
      }
      safeUrlPatterns.push(p.trim());
    }
    if (safeUrlPatterns.length > 0) {
      report(`Focus: restricting scan to ${safeUrlPatterns.length} URL pattern(s): ${safeUrlPatterns.join(', ')}`);
    }

    // Filter static flows list
    let filteredFlows = flows;

    // Apply urlPatterns restriction first (focusAreas) — only keep flows that match a pattern
    if (safeUrlPatterns.length > 0) {
      filteredFlows = filteredFlows.filter(flow => {
        // Match the flow path against each pattern using simple prefix/glob-like comparison
        // We keep the comparison to the relative path only (not the full URL)
        return safeUrlPatterns.some(pattern => {
          // Glob-style: pattern ending in '**' matches any path starting with the prefix
          if (pattern.endsWith('**')) {
            const prefix = pattern.slice(0, -2);
            return flow === prefix || flow.startsWith(prefix);
          }
          if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            return flow.startsWith(prefix);
          }
          // Exact match or prefix match
          return flow === pattern || flow.startsWith(pattern);
        });
      });
      if (filteredFlows.length === 0) {
        report('Focus urlPatterns matched no flows — skipping screenshot capture');
      } else {
        report(`Focus urlPatterns: ${filteredFlows.length} of ${flows.length} flow(s) selected`);
      }
    }

    if (safeUrlExclusions.length > 0 && appUrl) {
      filteredFlows = filteredFlows.filter(flow => {
        const fullUrl = resolveUrl(appUrl, flow);
        if (isUrlExcluded(fullUrl, safeUrlExclusions)) {
          log(`[${project.id}] Excluding URL: ${fullUrl}`);
          exclusionSkipCount++;
          return false;
        }
        return true;
      });
      if (exclusionSkipCount > 0) {
        report(`Excluded ${exclusionSkipCount} URL(s) by exclusion patterns`);
      }
    }

    // DK-124: advisorPins.design — validated relative URL paths to prioritize.
    // Pinned paths are prepended to the flows queue; remaining flows follow.
    // The full URL is always constructed server-side by appending the pin to appUrl.
    // Validation: must start with '/', must not contain '://' or start with '//'
    const rawPinnedUrls = Array.isArray(pinnedUrls) ? pinnedUrls : [];
    const safePinnedUrls = rawPinnedUrls.filter(u => {
      if (typeof u !== 'string' || !u.startsWith('/')) return false;
      if (u.startsWith('//') || /^[a-z][a-z0-9+\-.]*:\/\//i.test(u)) return false;
      return true;
    }).slice(0, 20);

    if (safePinnedUrls.length > 0) {
      report(`Pins: ${safePinnedUrls.length} pinned URL(s) will be prioritized`);
      // Deduplicate: pinned URLs that already appear in filteredFlows are moved to front
      // (not duplicated). New pinned URLs not yet in filteredFlows are also prepended.
      const filteredSet = new Set(filteredFlows);
      const pinnedInFlows = safePinnedUrls.filter(u => filteredSet.has(u));
      const pinnedNew = safePinnedUrls.filter(u => !filteredSet.has(u));
      const nonPinned = filteredFlows.filter(u => !safePinnedUrls.includes(u));
      filteredFlows = [...pinnedInFlows, ...pinnedNew, ...nonPinned];
    }

    // Fetch rejection history for this project (for dedup and prompt injection)
    const rejections = db ? await fetchRejections(db, project.id) : [];
    if (rejections.length > 0) {
      report(`${rejections.length} rejection(s) in history`);
    }
    const rejectionHistoryBlock = formatRejectionHistory(rejections, 'design');

    // SECURITY (DK-392): sanitize soulPrompt before use — it is user-controllable via Firestore
    // and must not be interpolated raw into the system prompt (prompt injection risk).
    const baseSystemPrompt = sanitizeSystemPrompt(soulPrompt) || SYSTEM_PROMPT;
    // DK-302: Inject current team priorities as the first shared block in the system prompt.
    // Only injected when non-empty after trimming — no block produced for empty/missing priorities.
    const baseSystemWithPriorities = injectPriorities(baseSystemPrompt, priorities);
    if (priorities?.trim()) report(`Current priorities active (${priorities.trim().length} chars)`);
    // DK-367: Inject scope as a clearly delimited block early in the system prompt.
    // Scope narrows the design audit to a specific surface, flow, or segment.
    const baseSystemWithScope = scopeText
      ? `${baseSystemWithPriorities}\n\n[SCOPE: ${scopeText}]\nFocus your analysis exclusively on the scope defined above.`
      : baseSystemWithPriorities;
    // SECURITY (DK-306): sanitize user-controlled advisorContext before interpolating into the prompt.
    const safeAdvisorContext = sanitizeSystemPrompt(project.advisorContext || '');
    const systemWithContext = safeAdvisorContext.trim()
      ? `${baseSystemWithScope}\n\n## Product Context\n${safeAdvisorContext.trim()}`
      : baseSystemWithScope;

    // DK-133: Inject custom instructions (project override ?? global fallback) after base prompt.
    // Uses clearly delimited block so logs distinguish user content from system content.
    const systemWithInstructions = injectCustomInstructions(systemWithContext, personaInstructions);
    // DK-039: Inject per-persona per-project focus directive after project-specific instructions.
    // Uses injectFocusDirective() from prompt-builder.js which wraps the directive in clearly
    // delimited [FOCUS START] / [FOCUS END] markers per spec. Only injected when non-empty.
    const systemWithDirective = injectFocusDirective(systemWithInstructions, directive);

    // DK-321: User hint under explicit header — clearly separated from system instructions.
    const systemWithFocus = focusPrompt
      ? `${systemWithDirective}\n\n---\nUser context (one-time override):\n${focusPrompt}`
      : systemWithDirective;
    // Append feedback context block at the end of the system prompt if available.
    // Contains only aggregated numeric stats and category labels — no raw ticket content.
    const systemWithFeedback = feedbackContextBlock
      ? `${systemWithFocus}\n\n---\n${feedbackContextBlock}`
      : systemWithFocus;
    // DK-105: Append weight priority line if any concern weight differs from default (1).
    // When all weights are at default, nothing is injected — current behavior is preserved.
    const systemWithWeights = weightPriorityLine
      ? `${systemWithFeedback}\n\n${weightPriorityLine}`
      : systemWithFeedback;
    // DK-187: Inject focus constraints if set. Values are pre-validated by validateFocus()
    // before reaching here — only safe strings are included. Wrapped in XML-style tags so
    // the model treats them as data, not instructions.
    const focusConstraintBlock = buildFocusConstraintBlock(focus || null, 'design');
    if (focusConstraintBlock) {
      report(`Focus constraints active: ${focus?.routes?.length || 0} route(s)`);
    }
    const systemWithFocusConstraints = focusConstraintBlock
      ? `${systemWithWeights}\n\n${focusConstraintBlock}`
      : systemWithWeights;
    // DK-134: Inject per-project scope topics via buildScopeBlock (new array format).
    // Falls back to legacy DK-301 string focusAreaTopics when scopeTopics is empty.
    const safeScopeTopics = Array.isArray(scopeTopics) ? scopeTopics : [];
    const newScopeBlock = buildScopeBlock({ topics: safeScopeTopics });
    let systemWithFocusArea = systemWithFocusConstraints;
    if (newScopeBlock) {
      report(`Scope topics active: [${safeScopeTopics.join(', ')}]`);
      systemWithFocusArea = `${systemWithFocusConstraints}\n\n---\n${newScopeBlock}`;
    } else {
      // Legacy DK-301 string format
      const designFocusAreaTopicsSafe = (typeof focusAreaTopics === 'string' && focusAreaTopics.trim())
        ? focusAreaTopics.trim().slice(0, 300)
        : null;
      if (designFocusAreaTopicsSafe) {
        const designFocusAreaBlock = `Focus constraints (user-defined):\nTopics: ${designFocusAreaTopicsSafe}\n\nLimit your analysis to the above scope.`;
        report(`Scope focus active: topics="${designFocusAreaTopicsSafe}"`);
        systemWithFocusArea = `${systemWithFocusConstraints}\n\n---\n${designFocusAreaBlock}`;
      }
    }
    // DK-320: Inject rejection history after main persona instructions, before output format/exclusions.
    // The block contains only immutable server-side snapshots — no user-supplied text.
    const systemWithRejections = injectRejectionHistory(systemWithFocusArea, rejectionHistoryBlock);
    if (rejectionHistoryBlock) {
      report(`Rejection history injected (${rejections.length} rejection(s))`);
    }
    // DK-112: Inject per-persona topic exclusion rules at the end of the system prompt.
    // These tell the model which topics to never propose. Sanitized by prompt-builder.
    const effectiveSystemPrompt = injectTopicExclusions(systemWithRejections, topicExclusions);
    if (Array.isArray(topicExclusions) && topicExclusions.length > 0) {
      report(`Topic exclusions active: ${topicExclusions.length} rule(s)`);
    }

    // Use listStubs() for dedup — only needs title/status/snoozedUntil/id,
    // not full ticket documents. Falls back to listAll() for older service instances.
    const existingTickets = await (ticketService.listStubs || ticketService.listAll).call(ticketService);
    let issues = [];
    let capturedScreenshotBuffer = null;
    let capturedAt = null;

    // Log scanned URLs (query-string-stripped) to the run logger
    // Only log non-excluded URLs so the run log reflects what was actually scanned.
    if (runLogger && appUrl) {
      for (const flow of filteredFlows) {
        const fullUrl = resolveUrl(appUrl, flow);
        runLogger.addScanned(fullUrl); // sanitizeUrl is called inside addScanned
      }
    }

    if (appUrl && qaFlows && qaFlows.length > 0) {
      // Interactive session — run through qaFlows with Playwright, giving richer
      // screenshots that show the app in real interactive states.
      let stepResults = [];
      try {
        report(`Running interactive session (${qaFlows.length} flow(s))…`);
        stepResults = await captureSession(appUrl, qaFlows, { onLog: (msg) => log(`[${project.id}] ${msg}`), localStorage: filterLocalStorage(projectLocalStorage), cookies: filterCookies(projectCookies) });
        report(`Session complete — ${stepResults.length} screenshot(s) captured`);
      } catch (err) {
        log(`[${project.id}] Interactive session failed: ${err.message} — falling back to static screenshots`);
      }

      if (stepResults.length > 0) {
        const imageBuffers = stepResults.map(s => s.screenshot);
        const stepSummary = stepResults.map((s, i) =>
          `Screenshot ${i + 1} — Flow: "${s.flowName}" / Step: "${s.stepName}"`
        ).join('\n');
        report(`Analysing ${stepResults.length} screenshot(s)…`);
        const raw = await askWithImages(effectiveSystemPrompt, imageBuffers, interactiveScreenshotPrompt(stepSummary, focusPrompt), { model });
        issues = parseIssues(raw);
        capturedScreenshotBuffer = stepResults[0]?.screenshot || null;
        capturedAt = new Date().toISOString();
        const savedFolderInteractive = saveScreenshots(project.id, capturedAt, stepResults.map(s => ({ name: `${s.flowName} — ${s.stepName}`, buffer: s.screenshot })), report);
        // DK-405: record screenshot folder in run log so the history drawer can link to it
        if (savedFolderInteractive && runLogger) runLogger.setScreenshotFolder(savedFolderInteractive);
      } else {
        // Interactive session failed — fall back to static URL screenshots
        report('Falling back to static screenshot capture…');
        let screenshots = null;
        try {
          screenshots = await captureScreenshots(appUrl, filteredFlows, { localStorage: projectLocalStorage, cookies: projectCookies });
        } catch (err) {
          log(`[${project.id}] Static screenshot capture also failed: ${err.message} — running text audit`);
        }
        if (screenshots && screenshots.length > 0) {
          const imageBuffers = screenshots.map(s => s.buffer);
          const urlList = screenshots.map(s => s.url).join(', ');
          const raw = await askWithImages(effectiveSystemPrompt, imageBuffers, screenshotPrompt(urlList, focusPrompt), { model });
          issues = parseIssues(raw);
          capturedScreenshotBuffer = screenshots[0]?.buffer || null;
          capturedAt = new Date().toISOString();
          const savedFolderFallback = saveScreenshots(project.id, capturedAt, screenshots.map(s => ({ name: s.url, buffer: s.buffer })), report);
          // DK-405: record screenshot folder in run log so the history drawer can link to it
          if (savedFolderFallback && runLogger) runLogger.setScreenshotFolder(savedFolderFallback);
        } else {
          report('Running text-based audit…');
          issues = await runTextAudit(effectiveSystemPrompt, project.advisorContext, focusPrompt);
        }
      }
    } else if (appUrl) {
      // Static navigation — original behaviour: navigate to URL paths and screenshot
      let screenshots = null;
      try {
        report('Capturing screenshots…');
        screenshots = await captureScreenshots(appUrl, filteredFlows, { localStorage: projectLocalStorage, cookies: projectCookies });
      } catch (err) {
        log(`[${project.id}] Screenshot capture failed: ${err.message} — falling back to text audit`);
      }

      if (screenshots && screenshots.length > 0) {
        const imageBuffers = screenshots.map(s => s.buffer);
        const urlList = screenshots.map(s => s.url).join(', ');
        report(`Analyzing ${screenshots.length} screenshot(s)…`);
        const raw = await askWithImages(effectiveSystemPrompt, imageBuffers, screenshotPrompt(urlList, focusPrompt), { model });
        issues = parseIssues(raw);
        capturedScreenshotBuffer = screenshots[0]?.buffer || null;
        capturedAt = new Date().toISOString();
        const savedFolderStatic = saveScreenshots(project.id, capturedAt, screenshots.map(s => ({ name: s.url, buffer: s.buffer })), report);
        // DK-405: record screenshot folder in run log so the history drawer can link to it
        if (savedFolderStatic && runLogger) runLogger.setScreenshotFolder(savedFolderStatic);
      } else {
        report('Running text-based audit…');
        issues = await runTextAudit(effectiveSystemPrompt, project.advisorContext, focusPrompt);
      }
    } else {
      report('Running text-based audit…');
      issues = await runTextAudit(effectiveSystemPrompt, project.advisorContext, focusPrompt);
    }

    if (issues.length === 0) {
      report('No UX issues found');
      return { ticketsCreated: 0, exclusionSkipCount, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no UX issues found` };
    }

    // Apply per-run ticket cap: rank by impact type, then slice.
    const cap = getValidatedCap(ticketCap);
    const rankedIssues = sortDesignByImpact(issues);
    const issuesToCreate = rankedIssues.slice(0, cap);
    const deferredCount = rankedIssues.length - issuesToCreate.length;
    if (deferredCount > 0) {
      report(`Applying cap: creating ${issuesToCreate.length} of ${rankedIssues.length} candidates (${deferredCount} deferred)`);
      // DK-189: record deferred proposals as filtered by run cap
      if (runLogger) {
        for (let i = 0; i < deferredCount; i++) runLogger.addFiltered(FILTER_REASONS.RATE_LIMIT);
      }
    }
    log(`[${project.id}] Design: ${issuesToCreate.length} of ${rankedIssues.length} candidates this run${deferredCount > 0 ? ` (${deferredCount} deferred)` : ''}`);

    // Per-persona dedup sensitivity (DK-130). Clamped to [1, 10]; defaults to 3 (Medium).
    const effectiveDedupThreshold = getValidatedDedupThreshold(dedupThreshold);

    // DK-188: Validate minConfidence — must be integer 1–10, default 5.
    const effectiveMinConfidence = (Number.isInteger(minConfidence) && minConfidence >= 1 && minConfidence <= 10)
      ? minConfidence
      : 5;

    report(`Found ${rankedIssues.length} issue(s) — ${dryRun ? 'previewing' : 'creating'} up to ${cap} ticket(s)…`);
    let created = 0;
    let discardedCount = 0;
    const skippedReasons = [];
    const dryRunProposals = []; // populated when dryRun: true
    for (const issue of issuesToCreate) {
      if (!issue.title || !issue.description) continue;

      // DK-188: Confidence threshold check.
      // Parse score from the issue object (integer 1–10). Any non-integer or out-of-range value scores 0 — discard.
      const rawScore = issue.confidence;
      const confidenceScore = (Number.isInteger(rawScore) && rawScore >= 1 && rawScore <= 10) ? rawScore : 0;
      if (confidenceScore < effectiveMinConfidence) {
        log(`[${project.id}] ${dryRun ? '[dry-run] ' : ''}Skip (confidence ${confidenceScore} < threshold ${effectiveMinConfidence}): ${issue.title}`);
        skippedReasons.push({ title: `[Design] ${issue.title}`, reason: `low_confidence: score ${confidenceScore}` });
        if (runLogger) {
          runLogger.addRejected({ title: issue.title, reason: 'low_confidence', score: confidenceScore });
          runLogger.addFiltered(FILTER_REASONS.LOW_CONFIDENCE);
        }
        // DK-188: Write discard record to Firestore (never silent).
        if (db && !dryRun) {
          db.collection('advisor').doc('discards').collection('items').add({
            persona: 'design',
            score: confidenceScore,
            threshold: effectiveMinConfidence,
            ticketDraft: { title: `[Design] ${issue.title}`, summary: (issue.description || '').slice(0, 500) },
            projectId: project.id,
            timestamp: new Date(),
          }).catch(err => log(`[${project.id}] Failed to write discard record: ${err.message}`));
        }
        discardedCount++;
        if (dryRun) {
          dryRunProposals.push({
            title: `[Design] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: issue.type === 'new-feature' ? 'feature' : 'bug',
            advisorPersona: 'design',
            deduped: true,
            filterReason: 'low_confidence',
            confidenceScore,
          });
        }
        continue;
      }

      const { isDuplicate, matchTitle, matchId, matchedKeywords } = checkDuplicate(existingTickets, issue.title, effectiveDedupThreshold);
      if (isDuplicate) {
        log(`[${project.id}] ${dryRun ? '[dry-run] ' : ''}Skip (duplicate of "${matchTitle}"): ${issue.title}`);
        const matchedTicket = existingTickets.find(t => t.title === matchTitle);
        skippedReasons.push({
          title: `[Design] ${issue.title}`,
          reason: `duplicate: similar to existing ticket`,
          ...(matchedTicket?.id ? { matchedTicketId: matchedTicket.id } : {}),
        });
        if (dryRun) {
          dryRunProposals.push({
            title: `[Design] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: issue.type === 'new-feature' ? 'feature' : 'bug',
            advisorPersona: 'design',
            deduped: true,
            dedupMatchId: matchId || null,
            filterReason: 'duplicate',
          });
        }
        if (runLogger) {
          runLogger.addRejected({ title: issue.title, reason: 'duplicate', matchedTicketId: matchId });
          if (matchId && matchedKeywords) {
            runLogger.addDeduped({ summary: matchedKeywords, blockedBy: matchId });
          }
        }
        continue;
      }

      const { isSuppressed, matchTitle: rejMatchTitle, matchCount } = checkRejectionMatch(rejections, issue.title, effectiveDedupThreshold);
      if (isSuppressed) {
        log(`[${project.id}] ${dryRun ? '[dry-run] ' : ''}Skip (matches ${matchCount} rejection(s), similar to "${rejMatchTitle}"): ${issue.title}`);
        skippedReasons.push({
          title: `[Design] ${issue.title}`,
          reason: `duplicate: ${matchCount}% overlap with rejected proposal`,
        });
        if (dryRun) {
          dryRunProposals.push({
            title: `[Design] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: issue.type === 'new-feature' ? 'feature' : 'bug',
            advisorPersona: 'design',
            deduped: true,
            filterReason: 'rejection_match',
          });
        }
        if (runLogger) {
          runLogger.addRejected({ title: issue.title, reason: 'threshold' });
          runLogger.addFiltered(FILTER_REASONS.REJECTION_MATCH);
        }
        continue;
      }

      const type = issue.type === 'new-feature' ? 'feature' : 'bug';
      const ticketDescription = buildTicketDescription(issue);
      const reasoningSummary = buildReasoningSummary(issue);

      if (dryRun) {
        // Dry-run: collect proposal without writing to Firestore.
        // Playwright runs as normal in dry-run mode (screenshot capture already happened above).
        // We don't upload to Storage since there's no ticket ID to key on.
        dryRunProposals.push({
          title: `[Design] ${issue.title}`,
          description: ticketDescription,
          type,
          advisorPersona: 'design',
          reasoning_summary: reasoningSummary,
          deduped: false,
          confidenceScore,
        });
        created++;
        existingTickets.push({ title: `[Design] ${issue.title}`, status: 'proposed' });
        log(`[${project.id}] [dry-run] Proposed: ${issue.title}`);
        continue;
      }

      // Respect yoloMode and consensusGate to determine initial status.
      // consensusGate takes precedence over yoloMode when enabled: tickets always
      // start as 'proposed' and are promoted by checkAndPromote in consensus.js.
      const consensusEnabled = consensusGate?.enabled && typeof consensusGate?.threshold === 'number';
      const initialStatus = (consensusEnabled || !project.yoloMode) ? 'proposed' : 'open';
      if (consensusEnabled) {
        log(`[${project.id}] consensusGate enabled (threshold=${consensusGate.threshold}) → creating ticket as 'proposed'`);
      } else {
        log(`[${project.id}] yoloMode=${project.yoloMode} → creating ticket as '${initialStatus}'`);
      }
      // DK-189: include advisorRunId for ticket attribution back to this run
      const advisorRunId = runLogger ? runLogger.getRunId() : null;
      // DK-194: build initial consensus metadata when gate is enabled
      const consensusField = consensusEnabled
        ? buildInitialConsensus('design', consensusGate.threshold)
        : undefined;
      const ticketPayload = {
        type,
        title: `[Design] ${issue.title}`,
        description: ticketDescription,
        userId: null,
        userEmail: 'advisor@docket.app',
        status: initialStatus,
        advisorPersona: 'design',
        // DK-188: Store the self-rated confidence score on the ticket for UI display.
        ...(confidenceScore > 0 ? { advisorConfidence: confidenceScore } : {}),
        ...(advisorRunId ? { advisorRunId } : {}),
        ...(consensusField ? { consensus: consensusField } : {}),
      };

      // Helper: assign clusters after ticket creation (fire-and-forget errors)
      const _assignDesignClusters = async (ticket) => {
        if (!db) return;
        try {
          const clusterIds = await assignClusters({
            db,
            projectId: project.id,
            title: `[Design] ${issue.title}`,
            description: ticketDescription,
          });
          if (clusterIds.length > 0) {
            await ticketService.update(ticket.id, { clusterIds });
            log(`[${project.id}] Clustered ${ticket.ticketId} → [${clusterIds.join(', ')}]`);
          }
        } catch (err) {
          log(`[${project.id}] Cluster assignment failed for ${ticket.ticketId}: ${err.message}`);
        }
      };

      // Build screenshot enrichment if we have a captured screenshot
      if (storage && capturedScreenshotBuffer && capturedAt) {
        try {
          // Upload screenshot to Firebase Storage — path uses ticketId assigned by Firestore
          // We create the ticket first, then update it with the storageUrl
          const ticket = await ticketService.add(ticketPayload);
          const annotations = buildAnnotations(issue);
          // Render bounding-box annotations onto the screenshot before uploading,
          // so the stored image visually shows what the design issue refers to.
          const annotatedBuffer = annotations.length > 0
            ? await annotateScreenshot(capturedScreenshotBuffer, annotations)
            : capturedScreenshotBuffer;
          const storageUrl = await uploadScreenshot(storage, annotatedBuffer, ticket.id);
          const screenshotData = {
            storageUrl,
            capturedAt,
            ...(annotations.length > 0 ? { annotations } : {}),
          };
          // Build reasoning with screenshot evidence — storageRef + capturedAt
          const reasoning = {
            summary: reasoningSummary,
            evidence: [
              {
                type: 'screenshot',
                storageRef: storageUrl,
                capturedAt,
                note: buildAnnotationNote(issue, annotations),
              },
            ],
          };
          await ticketService.update(ticket.id, { screenshot: screenshotData, reasoning });
          await _assignDesignClusters(ticket);
          log(`[${project.id}] Created ${ticket.ticketId} with ${annotations.length > 0 ? 'annotated ' : ''}screenshot: ${issue.title}`);
          if (runLogger) runLogger.addCreated(ticket.id);
          created++;
          existingTickets.push({ id: ticket.id, title: ticket.title, status: 'proposed', advisorPersona: 'design' });

          // Cross-persona convergence detection
          try {
            const convergenceMatches = checkConvergence(existingTickets, ticket.title, 'design', [], effectiveDedupThreshold);
            if (convergenceMatches.length > 0) {
              log(`[${project.id}] ${ticket.ticketId} converges with ${convergenceMatches.length} other ticket(s)`);
              await writeConvergence(db, project.id, ticket.id, ticket.ticketId, 'design', issue.title, convergenceMatches, (msg) => log(`[${project.id}] ${msg}`));
            }
          } catch (err) {
            log(`[${project.id}] Convergence check failed for ${ticket.ticketId}: ${err.message}`);
          }

          // Async score — fires after ticket write, does not block creation.
          const _ticketContentWithScreenshot = `${ticket.title}\n\n${ticketDescription}`;
          scoreProposal(_ticketContentWithScreenshot).then(scores => {
            if (!scores) {
              log(`[${project.id}] Scoring returned null for ${ticket.ticketId} — skipping`);
              return;
            }
            return ticketService.updateScore(ticket.id, scores).then(() => {
              log(`[${project.id}] Scored ${ticket.ticketId}: impact=${scores.impact} effort=${scores.effort}`);
            });
          }).catch(err => {
            log(`[${project.id}] Async score write failed for ${ticket.ticketId}: ${err.message}`);
          });
          continue;
        } catch (uploadErr) {
          log(`[${project.id}] Screenshot upload failed: ${uploadErr.message} — creating ticket without screenshot`);
          // Fall through to create ticket without screenshot
        }
      }

      // No screenshot — still include reasoning with summary only
      const reasoning = { summary: reasoningSummary, evidence: [] };
      const ticket = await ticketService.add({ ...ticketPayload, reasoning });
      await _assignDesignClusters(ticket);

      log(`[${project.id}] Created ${ticket.ticketId}: ${issue.title}`);
      if (runLogger) runLogger.addCreated(ticket.id);
      created++;
      existingTickets.push({ id: ticket.id, title: ticket.title, status: 'proposed', advisorPersona: 'design' });

      // Cross-persona convergence detection
      try {
        const convergenceMatches = checkConvergence(existingTickets, ticket.title, 'design', [], effectiveDedupThreshold);
        if (convergenceMatches.length > 0) {
          log(`[${project.id}] ${ticket.ticketId} converges with ${convergenceMatches.length} other ticket(s)`);
          await writeConvergence(db, project.id, ticket.id, ticket.ticketId, 'design', issue.title, convergenceMatches, (msg) => log(`[${project.id}] ${msg}`));
        }
      } catch (err) {
        log(`[${project.id}] Convergence check failed for ${ticket.ticketId}: ${err.message}`);
      }

      // Async score — fires after ticket write, does not block creation.
      const ticketContent = `${ticket.title}\n\n${ticketDescription}`;
      scoreProposal(ticketContent).then(scores => {
        if (!scores) {
          log(`[${project.id}] Scoring returned null for ${ticket.ticketId} — skipping`);
          return;
        }
        return ticketService.updateScore(ticket.id, scores).then(() => {
          log(`[${project.id}] Scored ${ticket.ticketId}: impact=${scores.impact} effort=${scores.effort}`);
        });
      }).catch(err => {
        log(`[${project.id}] Async score write failed for ${ticket.ticketId}: ${err.message}`);
      });
    }

    const deferredSummary = deferredCount > 0 ? ` (${deferredCount} deferred by cap)` : '';
    const discardedSummary = discardedCount > 0 ? ` (${discardedCount} below confidence threshold)` : '';
    if (dryRun) {
      report(`Preview complete — ${dryRunProposals.filter(p => !p.deduped).length} proposal(s) found (${dryRunProposals.filter(p => p.deduped).length} deduped)`);
      return {
        ticketsCreated: 0,
        proposalsSkipped: skippedReasons.length,
        skippedReasons,
        proposals: dryRunProposals,
        lastActivity: `${project.id}: dry-run preview — ${dryRunProposals.filter(p => !p.deduped).length} proposals`,
      };
    }
    report(`Audit complete — ${created} ticket(s) created${deferredSummary}${discardedSummary}`);
    return {
      ticketsCreated: created,
      exclusionSkipCount,
      proposalsSkipped: skippedReasons.length,
      skippedReasons,
      discardedCount,
      lastActivity: `${project.id}: ${created > 0 ? `${created} ticket(s) created${deferredSummary}` : 'no new issues'}`,
    };
  }

  async function runTextAudit(systemPrompt, advisorContext, focusPrompt) {
    const raw = await ask(systemPrompt, textAuditPrompt(advisorContext || 'A web application', focusPrompt), { model });
    return parseIssues(raw);
  }

  return { runAudit };
}

/**
 * Extract and validate bounding box annotations from an issue.
 * Returns a clean array of { x, y, width, height, label } objects.
 */
function buildAnnotations(issue) {
  if (!Array.isArray(issue.annotations)) return [];
  const valid = [];
  for (const ann of issue.annotations) {
    if (
      typeof ann.x === 'number' &&
      typeof ann.y === 'number' &&
      typeof ann.width === 'number' &&
      typeof ann.height === 'number' &&
      typeof ann.label === 'string' &&
      ann.label.trim().length > 0
    ) {
      valid.push({
        x: Math.round(ann.x),
        y: Math.round(ann.y),
        width: Math.round(ann.width),
        height: Math.round(ann.height),
        label: ann.label.trim().slice(0, 40),
      });
    }
  }
  return valid;
}

/**
 * Build a one-sentence reasoning summary for a Design issue.
 * References the issue type and title so users can understand the finding at a glance.
 *
 * @param {object} issue - Parsed issue from LLM
 * @returns {string}
 */
function buildReasoningSummary(issue) {
  const typeLabel = {
    ux: 'UX friction',
    visual: 'visual inconsistency',
    accessibility: 'accessibility issue',
    'new-feature': 'feature opportunity',
  }[issue.type] || 'design issue';
  return `Design flagged a ${typeLabel}: ${issue.title}.`;
}

/**
 * Build a short annotation note string from the first annotation label (if any),
 * or fall back to the issue suggestion / description.
 * This becomes the evidence entry's note field — it must be a short critique string,
 * never a raw screenshot or code excerpt.
 *
 * @param {object} issue - Parsed issue from LLM
 * @param {Array} annotations - Validated annotation objects
 * @returns {string}
 */
function buildAnnotationNote(issue, annotations) {
  if (annotations.length > 0 && annotations[0].label) {
    return annotations[0].label.slice(0, 200);
  }
  const text = issue.suggestion || issue.description || issue.title;
  return text.split('.')[0].trim().slice(0, 200);
}

function buildTicketDescription(issue) {
  const parts = [];
  parts.push('## Issue');
  parts.push(issue.description);
  parts.push('');
  if (issue.suggestion) { parts.push('## Suggestion'); parts.push(issue.suggestion); parts.push(''); }
  if (issue.type) { parts.push(`**Type:** ${issue.type}`); parts.push(''); }
  parts.push('---');
  parts.push('*Generated by EPD Advisor — Design persona*');
  return parts.join('\n');
}
