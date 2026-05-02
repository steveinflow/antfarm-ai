// Engineer persona — audits the codebase for security issues and inefficiencies.
// Called once per project per cycle. Receives project context from Firestore.

import { execSync } from 'node:child_process';
import pm from 'picomatch';
import { ask } from './claude.js';
import { scanFiles, scanFilesWithPins, batchFiles, formatFileBatch } from './files.js';
import { checkDuplicate, checkRejectionMatch, getValidatedDedupThreshold, checkConvergence } from './dedup.js';
import { writeConvergence } from './convergence.js';
import { fetchRejections, formatRejectionHistory } from './rejection-history.js';
import { assignClusters } from './cluster.js';
import { scoreProposal } from './scoreProposal.js';
import { FILTER_REASONS } from './filter-reasons.js';
import { validateFocus, buildFocusConstraintBlock } from './focus-validator.js';
import { injectPriorities, injectTopicExclusions, injectRejectionHistory, injectFocusDirective, injectCustomInstructions, buildScopeBlock } from './prompt-builder.js';
import { sanitizeSystemPrompt } from './custom-personas-config.js';
import { buildInitialConsensus } from './consensus.js';

/**
 * Get the current HEAD commit SHA for a repo path.
 * Returns null if git is unavailable or the directory is not a git repo.
 */
function getCommitSha(repoPath) {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a senior security engineer and open source advocate reviewing code for a web application.

Your responsibilities:
1. Identify security vulnerabilities (OWASP Top 10, injection, auth issues, exposed secrets, etc.)
2. Flag anything that would be embarrassing or problematic in an open source codebase
   (hardcoded credentials, personal data in code, insecure defaults, debug backdoors)
3. Spot meaningful inefficiencies (N+1 queries, unbounded loops, memory leaks, blocking async patterns)
4. Note missing input validation at system boundaries

Be precise and actionable. Only flag real issues — not theoretical or minor stylistic concerns.
Prioritize: security > open-source safety > meaningful performance > minor quality.`;

function analysisPrompt(projectContext) {
  // SECURITY (DK-306): sanitize user-controlled advisorContext before interpolating into the prompt.
  const safeContext = sanitizeSystemPrompt(projectContext || '');
  return `${safeContext.trim() ? `## Project Context\n${safeContext.trim()}\n\n` : ''}Review the following source files for security issues, open-source safety concerns, and significant inefficiencies.

For each issue found, respond with a JSON array of objects with this shape:
{
  "severity": "critical" | "high" | "medium",
  "title": "Short title for a ticket (max 80 chars)",
  "description": "Clear explanation of the issue",
  "file": "path/to/file.js",
  "lineStart": 42,
  "lineEnd": 55,
  "recommendation": "How to fix it",
  "avoidance": "What not to do when fixing",
  "confidence": 7
}

lineStart and lineEnd are 1-based line numbers referencing the specific lines containing the issue.
If you cannot identify specific lines, omit lineStart and lineEnd.
confidence is an integer 1–10 rating how certain you are this is a real, actionable issue worth a ticket (10 = certain, 1 = speculative). Be honest — do not inflate scores.
Only include severity "medium" or above. If no issues are found, return an empty array [].
Respond ONLY with valid JSON — no prose, no markdown fences.

Files to review:

`;
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [engineer] ${msg}`);
}

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
  log(`Failed to parse response as JSON — skipping batch. Raw response preview: "${preview}"`);
  return [];
}

/**
 * Validate and return a safe ticketCap value.
 * Must be an integer in [1, 50]. Defaults to 3 if missing/invalid.
 *
 * @param {*} raw - Value from Firestore persona config
 * @returns {number} Validated cap (1–50)
 */
export function getValidatedCap(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 50) return n;
  return 3; // safe default
}

/**
 * Sort engineer issues by severity (critical > high > medium).
 * Returns a new array (does not mutate).
 *
 * @param {object[]} issues
 * @returns {object[]}
 */
function sortByImpact(issues) {
  const SEVERITY_RANK = { critical: 0, high: 1, medium: 2 };
  return [...issues].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 3;
    const rb = SEVERITY_RANK[b.severity] ?? 3;
    return ra - rb;
  });
}

/**
 * @param {object} opts
 * @param {object} opts.config - advisor.engineer config (model, reviewGate)
 */
export function createEngineer({ config }) {
  const model = config.model || 'claude-haiku-4-5-20251001';

  /**
   * Audit one project.
   *
   * @param {object} opts
   * @param {object} opts.project     - Firestore project doc (id, name, advisorContext, repoPath)
   * @param {string} opts.repoPath    - Absolute path to repo
   * @param {string[]} opts.scanPaths - Subdirs to scan, relative to repoPath
   * @param {object} opts.ticketService
   * @param {object} [opts.db]        - Firestore Admin instance (for rejection history)
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
   * @param {string[]} [opts.exclusions] - Glob patterns of files/dirs to skip (from Firestore project exclusions.engineer)
   * @param {string|null} [opts.weightPriorityLine] - DK-105: Optional priority line built from per-project emphasis weights
   * @param {boolean} [opts.dryRun] - When true, skip writing tickets; return proposals array instead
   * @param {string[]} [opts.includePaths] - Glob patterns — only matching files are scanned (focusAreas.engineer)
   * @param {string[]} [opts.excludePaths] - Glob patterns — matching files are dropped from scan (focusAreas.engineer)
   * @param {string|null} [opts.directive] - DK-319: Per-persona per-project focus directive (plain text, already sanitized)
   * @param {object|null} [opts.focus] - DK-187: Validated focus config from Firestore { globs: string[] }.
   *   Injected as a <focus_constraints> block into the system prompt. Pre-validated by validateFocus().
   * @param {string|null} [opts.priorities] - DK-302: Current team priorities from advisorContext.priorities.
   *   Injected before all other prompt modifiers when non-empty. Trim and cap enforced by prompt-builder.
   * @param {string|null} [opts.focusAreaTopics] - DK-301: Comma-separated topic keywords from per-project focusAreas (legacy string).
   *   Injected as a labeled context block in the system prompt. Treated as untrusted freeform content.
   * @param {string|null} [opts.focusAreaPaths] - DK-301: Path glob from per-project focusAreas.engineer.paths (legacy string).
   *   Used to filter the file list via micromatch/picomatch before the prompt is built.
   * @param {string[]|null} [opts.topicExclusions] - DK-112: Array of topic exclusion rules for this persona.
   *   Injected as "Do not propose tickets related to: ..." at the end of the system prompt.
   *   Sanitized and capped by injectTopicExclusions in prompt-builder.js.
   * @param {string[]|null} [opts.pinnedGlobs] - DK-124: Validated relative glob patterns from advisorPins.engineer.
   *   Matching files are moved to the front of the scan list (prepend-then-continue). Non-pinned files
   *   are still included after pinned ones — pins are weighted, not exclusive.
   *   All globs are re-validated here before use. Max 20 globs, max 64 chars each (enforced at write).
   * @param {number} [opts.minConfidence] - DK-188: Minimum confidence score (1–10). Issues scoring below
   *   this threshold are discarded and logged instead of creating tickets. Default 5 if missing.
   * @param {object|null} [opts.consensusGate] - Cross-persona consensus gate config (DK-194).
   *   When enabled, tickets are written with a consensus field and stay in 'proposed' until
   *   enough other personas have endorsed them. Shape: { enabled, threshold }.
   *   When null or disabled, behaviour is unchanged (yoloMode still controls proposed vs open).
   * @param {string[]} [opts.scopeInclude] - DK-134: Include glob patterns from per-project scope.include[].
   *   Applied after DK-101 includePaths/excludePaths. All validated server-side before passing here.
   * @param {string[]} [opts.scopeExclude] - DK-134: Exclude glob patterns from per-project scope.exclude[].
   *   Applied after include filtering. All validated server-side.
   * @param {string[]} [opts.scopeTopics] - DK-134: Topic tags from per-project scope.topics[].
   *   Injected into the prompt as a scope directive.
   * @returns {Promise<{ ticketsCreated: number, filesScanned: number, lastActivity: string, focusAreaPathsMatchedZero?: boolean, scopeMatchedZero?: boolean, scopeFileCount?: number, proposals?: object[] }>}
   */
  async function runAudit({ project, repoPath, scanPaths, ticketService, db, onActivity, soulPrompt, focusPrompt, scopeText, feedbackContextBlock, runLogger, ticketCap, dedupThreshold, personaInstructions, exclusions, weightPriorityLine, dryRun = false, includePaths, excludePaths, directive, focus, priorities, focusAreaTopics, focusAreaPaths, topicExclusions, pinnedGlobs, minConfidence, consensusGate = null, scopeInclude, scopeExclude, scopeTopics }) {
    const report = (msg) => {
      log(`[${project.id}] ${msg}`);
      if (onActivity) onActivity(`${project.id}: ${msg}`);
    };

    report(`Starting audit of ${repoPath}`);

    // Capture the commit SHA once at scan time — used for all fileRefs in this cycle
    const commitSha = getCommitSha(repoPath);
    if (commitSha) {
      report(`Scanning at commit ${commitSha.slice(0, 8)}`);
    }

    // Count files excluded by user-configured exclusion patterns for suppression tracking.
    let exclusionSkipCount = 0;
    const exclusionPatterns = Array.isArray(exclusions) ? exclusions : [];
    if (exclusionPatterns.length > 0) {
      report(`Applying ${exclusionPatterns.length} exclusion pattern(s)`);
    }

    // focusAreas: includePaths narrows the scan; excludePaths drop files after inclusion.
    const safeIncludePaths = Array.isArray(includePaths) ? includePaths : [];
    const safeExcludePaths = Array.isArray(excludePaths) ? excludePaths : [];
    if (safeIncludePaths.length > 0) {
      report(`Focus: scanning only ${safeIncludePaths.length} include path(s): ${safeIncludePaths.join(', ')}`);
    }
    if (safeExcludePaths.length > 0) {
      report(`Focus: excluding ${safeExcludePaths.length} path(s): ${safeExcludePaths.join(', ')}`);
    }

    // DK-124: advisorPins.engineer — validated relative glob patterns to prioritize.
    // Pinned files appear at the front of the scan list; unpinned files follow.
    // Pins are weighted (prepend-then-continue), not exclusive.
    const safePinnedGlobs = Array.isArray(pinnedGlobs)
      ? pinnedGlobs.filter(g => typeof g === 'string').slice(0, 20)
      : [];
    if (safePinnedGlobs.length > 0) {
      report(`Pins: ${safePinnedGlobs.length} pinned glob(s) will be prioritized: ${safePinnedGlobs.join(', ')}`);
    }

    const scanOptions = {
      exclusions: exclusionPatterns,
      includePaths: safeIncludePaths,
      excludePaths: safeExcludePaths,
      onExcluded: () => { exclusionSkipCount++; },
      onWarn: (msg) => { report(`Warning: ${msg}`); },
    };

    let files = safePinnedGlobs.length > 0
      ? await scanFilesWithPins(repoPath, scanPaths, safePinnedGlobs, scanOptions)
      : await scanFiles(repoPath, scanPaths, scanOptions);
    if (exclusionSkipCount > 0) {
      report(`Excluded ${exclusionSkipCount} file(s) by exclusion patterns`);
    }
    report(`Found ${files.length} files to review`);

    // DK-301 (legacy): Apply focusAreaPaths glob filter — single string pattern.
    // DK-134: If new scopeInclude array is set, skip legacy focusAreaPaths (new takes precedence).
    const safeScopeInclude = Array.isArray(scopeInclude) ? scopeInclude.filter(p => typeof p === 'string' && p && !p.startsWith('/') && !p.startsWith('..')) : [];
    const safeScopeExclude = Array.isArray(scopeExclude) ? scopeExclude.filter(p => typeof p === 'string' && p && !p.startsWith('/') && !p.startsWith('..')) : [];

    let focusAreaPathsMatchedZero = false;
    let scopeMatchedZero = false;
    let scopeFileCount = null;

    if (safeScopeInclude.length > 0 || safeScopeExclude.length > 0) {
      // DK-134: New scope include/exclude arrays — apply both filters.
      // Include: keep only files matching at least one include pattern (if any).
      // Exclude: remove files matching any exclude pattern.
      let filtered = files;
      if (safeScopeInclude.length > 0) {
        const includeMatchers = safeScopeInclude.map(p => pm(p, { dot: true }));
        filtered = filtered.filter(f => includeMatchers.some(m => m(f.path)));
        report(`Scope include filter (${safeScopeInclude.length} pattern(s)): ${filtered.length} of ${files.length} file(s) matched`);
      }
      if (safeScopeExclude.length > 0) {
        const excludeMatchers = safeScopeExclude.map(p => pm(p, { dot: true }));
        const beforeExclude = filtered.length;
        filtered = filtered.filter(f => !excludeMatchers.some(m => m(f.path)));
        if (beforeExclude !== filtered.length) {
          report(`Scope exclude filter (${safeScopeExclude.length} pattern(s)): removed ${beforeExclude - filtered.length} file(s)`);
        }
      }
      scopeFileCount = filtered.length;
      if (filtered.length === 0) {
        report('Warning: scope filters matched zero files — check your path patterns');
        scopeMatchedZero = true;
        // Don't abort — continue with empty file list so "no files" is surfaced in run log
      } else {
        files = filtered;
      }
    } else if (focusAreaPaths && typeof focusAreaPaths === 'string' && focusAreaPaths.trim()) {
      // DK-301 legacy: single glob string
      const rawPattern = focusAreaPaths.trim();
      // Safety: reject absolute paths and traversal sequences
      const isSafePattern = !rawPattern.startsWith('/') &&
        !rawPattern.startsWith('..') &&
        !/^[A-Za-z]:[\\/]/.test(rawPattern);
      if (!isSafePattern) {
        report(`Warning: focusAreaPaths "${rawPattern}" rejected (absolute path or traversal) — scanning all files`);
      } else {
        const isMatch = pm(rawPattern, { dot: true });
        const filtered = files.filter(f => isMatch(f.path));
        report(`Scope paths filter "${rawPattern}": ${filtered.length} of ${files.length} file(s) matched`);
        scopeFileCount = filtered.length;
        if (filtered.length === 0) {
          report('Warning: scope path filter matched zero files — check your path constraint');
          focusAreaPathsMatchedZero = true;
        } else {
          files = filtered;
        }
      }
    }

    // Log scanned file paths to the run logger
    if (runLogger) {
      for (const f of files) runLogger.addScanned(f.path);
    }

    if (files.length === 0) {
      const noFilesReason = scopeMatchedZero
        ? 'No files matched configured scope'
        : 'No files found — check repoPath and scanPaths';
      report(noFilesReason);
      return { ticketsCreated: 0, filesScanned: 0, exclusionSkipCount, focusAreaPathsMatchedZero, scopeMatchedZero, scopeFileCount: scopeFileCount ?? 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: ${noFilesReason.toLowerCase()}` };
    }

    // Use listStubs() for dedup — only needs title/status/snoozedUntil/id,
    // not full ticket documents. Falls back to listAll() for older service instances.
    const existingTickets = await (ticketService.listStubs || ticketService.listAll).call(ticketService);

    // Fetch rejection history for this project (for dedup and prompt injection)
    const rejections = db ? await fetchRejections(db, project.id) : [];
    if (rejections.length > 0) {
      report(`${rejections.length} rejection(s) in history`);
    }
    const rejectionHistoryBlock = formatRejectionHistory(rejections, 'engineer');

    const batches = batchFiles(files);
    report(`Processing ${batches.length} batch(es)…`);

    const allIssues = [];
    const basePrompt = analysisPrompt(project.advisorContext);
    // SECURITY (DK-392): sanitize soulPrompt before use — it is user-controllable via Firestore
    // and must not be interpolated raw into the system prompt (prompt injection risk).
    const effectiveSystemPrompt = sanitizeSystemPrompt(soulPrompt) || SYSTEM_PROMPT;
    // DK-302: Inject current team priorities as the first shared block in the system prompt.
    // Only injected when non-empty after trimming — no block produced for empty/missing priorities.
    const effectiveSystemWithPriorities = injectPriorities(effectiveSystemPrompt, priorities);
    if (priorities?.trim()) report(`Current priorities active (${priorities.trim().length} chars)`);
    // DK-367: Inject scope as a clearly delimited block early in the system prompt.
    // Scope narrows the analysis to a specific surface, flow, or segment.
    const effectiveSystemWithScope = scopeText
      ? `${effectiveSystemWithPriorities}\n\n[SCOPE: ${scopeText}]\nFocus your analysis exclusively on the scope defined above.`
      : effectiveSystemWithPriorities;
    // DK-133: Inject custom instructions (project override ?? global fallback) after base prompt.
    // Uses clearly delimited block so logs distinguish user content from system content.
    const effectiveSystemWithInstructions = injectCustomInstructions(effectiveSystemWithScope, personaInstructions);
    // DK-039: Inject per-persona per-project focus directive after project-specific instructions.
    // Uses injectFocusDirective() from prompt-builder.js which wraps the directive in clearly
    // delimited [FOCUS START] / [FOCUS END] markers per spec. Only injected when non-empty.
    const effectiveSystemWithDirective = injectFocusDirective(effectiveSystemWithInstructions, directive);
    // DK-321: Append user hint under an explicit header — clearly separated from system instructions.
    // The header signals to the model this is a one-time user override.
    const effectiveSystemWithFocus = focusPrompt
      ? `${effectiveSystemWithDirective}\n\n---\nUser context (one-time override):\n${focusPrompt}`
      : effectiveSystemWithDirective;
    // Append feedback context block at the end of the system prompt if available.
    // Contains only aggregated numeric stats and category labels — no raw ticket content.
    const effectiveSystemWithFeedback = feedbackContextBlock
      ? `${effectiveSystemWithFocus}\n\n---\n${feedbackContextBlock}`
      : effectiveSystemWithFocus;
    // DK-105: Append weight priority line if any concern weight differs from default (1).
    // When all weights are at default, nothing is injected — current behavior is preserved.
    const effectiveSystemWithWeights = weightPriorityLine
      ? `${effectiveSystemWithFeedback}\n\n${weightPriorityLine}`
      : effectiveSystemWithFeedback;
    // DK-187: Inject focus constraints if set. Values are pre-validated by validateFocus()
    // before reaching here — only safe strings are included. Wrapped in XML-style tags so
    // the model treats them as data, not instructions.
    const focusConstraintBlock = buildFocusConstraintBlock(focus || null, 'engineer');
    if (focusConstraintBlock) {
      report(`Focus constraints active: ${focus?.globs?.length || 0} glob(s)`);
    }
    const effectiveSystemWithFocusConstraints = focusConstraintBlock
      ? `${effectiveSystemWithWeights}\n\n${focusConstraintBlock}`
      : effectiveSystemWithWeights;
    // DK-134: Inject per-project scope config (topics + include/exclude paths) via buildScopeBlock.
    // New scope arrays take precedence over legacy DK-301 string fields.
    // All values are sanitized server-side in start-advisor.js before reaching here;
    // buildScopeBlock applies a final sanitization pass before prompt injection.
    const safeScopeTopics = Array.isArray(scopeTopics) ? scopeTopics : [];
    const newScopeBlock = buildScopeBlock({
      topics: safeScopeTopics,
      include: safeScopeInclude,
      exclude: safeScopeExclude,
    });

    // DK-301 legacy: Inject focusAreaTopics/focusAreaPaths if new scope block is not set.
    // Both serve the same purpose — new scope block wins when present.
    let effectiveSystemWithFocusArea = effectiveSystemWithFocusConstraints;
    if (newScopeBlock) {
      report(`Scope block active: ${safeScopeTopics.length} topic(s), ${safeScopeInclude.length} include(s), ${safeScopeExclude.length} exclude(s)`);
      effectiveSystemWithFocusArea = `${effectiveSystemWithFocusConstraints}\n\n---\n${newScopeBlock}`;
    } else {
      // Legacy DK-301 focus area string injection
      const focusAreaLines = [];
      if (focusAreaTopics && typeof focusAreaTopics === 'string' && focusAreaTopics.trim()) {
        focusAreaLines.push(`Topics: ${focusAreaTopics.trim().slice(0, 300)}`);
      }
      if (focusAreaPaths && typeof focusAreaPaths === 'string' && focusAreaPaths.trim()) {
        focusAreaLines.push(`Paths: ${focusAreaPaths.trim().slice(0, 300)}`);
      }
      if (focusAreaLines.length > 0) {
        const focusAreaBlock = `Focus constraints (user-defined):\n${focusAreaLines.join('\n')}\n\nLimit your analysis to the above scope.`;
        report(`Scope focus active: ${focusAreaLines.join('; ')}`);
        effectiveSystemWithFocusArea = `${effectiveSystemWithFocusConstraints}\n\n---\n${focusAreaBlock}`;
      }
    }
    // DK-320: Inject rejection history after main persona instructions, before output format instructions.
    // The block contains only immutable server-side snapshots — no user-supplied text.
    const effectiveSystemWithRejections = injectRejectionHistory(effectiveSystemWithFocusArea, rejectionHistoryBlock);
    if (rejectionHistoryBlock) {
      report(`Rejection history injected (${rejections.length} rejection(s))`);
    }
    // DK-112: Inject per-persona topic exclusion rules at the end of the system prompt.
    // These tell the model which topics to never propose. Sanitized by prompt-builder.
    const effectiveSystemFinal = injectTopicExclusions(effectiveSystemWithRejections, topicExclusions);
    if (Array.isArray(topicExclusions) && topicExclusions.length > 0) {
      report(`Topic exclusions active: ${topicExclusions.length} rule(s)`);
    }

    for (let i = 0; i < batches.length; i++) {
      report(`Batch ${i + 1}/${batches.length}…`);
      const fileText = formatFileBatch(batches[i]);
      const raw = await ask(effectiveSystemFinal, basePrompt + fileText, { model });
      const issues = parseIssues(raw);
      log(`[${project.id}] Batch ${i + 1}: ${issues.length} issue(s)`);
      allIssues.push(...issues);
    }

    if (allIssues.length === 0) {
      report('No issues found');
      return { ticketsCreated: 0, filesScanned: files.length, exclusionSkipCount, focusAreaPathsMatchedZero, scopeMatchedZero, scopeFileCount, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no issues found` };
    }

    // Apply per-run ticket cap: rank by severity, then slice.
    const cap = getValidatedCap(ticketCap);
    const rankedIssues = sortByImpact(allIssues);
    const issuesToCreate = rankedIssues.slice(0, cap);
    const deferredCount = rankedIssues.length - issuesToCreate.length;
    if (deferredCount > 0) {
      report(`Applying cap: creating ${issuesToCreate.length} of ${rankedIssues.length} candidates (${deferredCount} deferred)`);
      // DK-189: record deferred proposals as filtered by run cap
      if (runLogger) {
        for (let i = 0; i < deferredCount; i++) runLogger.addFiltered(FILTER_REASONS.RATE_LIMIT);
      }
    }
    log(`[${project.id}] Engineer: ${issuesToCreate.length} of ${rankedIssues.length} candidates this run${deferredCount > 0 ? ` (${deferredCount} deferred)` : ''}`);

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
        skippedReasons.push({ title: `[Engineer] ${issue.title}`, reason: `low_confidence: score ${confidenceScore}` });
        if (runLogger) {
          runLogger.addRejected({ title: issue.title, reason: 'low_confidence', score: confidenceScore });
          runLogger.addFiltered(FILTER_REASONS.LOW_CONFIDENCE);
        }
        // DK-188: Write discard record to Firestore (never silent).
        if (db && !dryRun) {
          db.collection('advisor').doc('discards').collection('items').add({
            persona: 'engineer',
            score: confidenceScore,
            threshold: effectiveMinConfidence,
            ticketDraft: { title: `[Engineer] ${issue.title}`, summary: (issue.description || '').slice(0, 500) },
            projectId: project.id,
            timestamp: new Date(),
          }).catch(err => log(`[${project.id}] Failed to write discard record: ${err.message}`));
        }
        discardedCount++;
        if (dryRun) {
          dryRunProposals.push({
            title: `[Engineer] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: 'bug',
            severity: issue.severity,
            advisorPersona: 'engineer',
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
          title: `[Engineer] ${issue.title}`,
          reason: `duplicate: similar to existing ticket`,
          ...(matchedTicket?.id ? { matchedTicketId: matchedTicket.id } : {}),
        });
        if (dryRun) {
          // Surface deduped proposals in preview so user sees same filtering as live run
          dryRunProposals.push({
            title: `[Engineer] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: 'bug',
            severity: issue.severity,
            advisorPersona: 'engineer',
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
          title: `[Engineer] ${issue.title}`,
          reason: `duplicate: ${matchCount}% overlap with rejected proposal`,
        });
        if (dryRun) {
          dryRunProposals.push({
            title: `[Engineer] ${issue.title}`,
            description: buildTicketDescription(issue),
            type: 'bug',
            severity: issue.severity,
            advisorPersona: 'engineer',
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

      // Build fileRefs for this issue — ranked by relevance (single ref per issue, ranked first)
      const fileRefs = buildFileRefs(issue, commitSha);

      // Build structured reasoning — summary + file evidence entries.
      // Evidence entries are derived from the scanner output (fileRefs), NOT from
      // raw LLM text. The note field is a short critique string, never a code excerpt.
      const reasoning = buildReasoning(issue, fileRefs);

      const ticketDescription = buildTicketDescription(issue);

      if (dryRun) {
        // Dry-run: collect proposal without writing to Firestore
        dryRunProposals.push({
          title: `[Engineer] ${issue.title}`,
          description: ticketDescription,
          type: 'bug',
          severity: issue.severity,
          file: issue.file || null,
          lineStart: issue.lineStart ?? null,
          lineEnd: issue.lineEnd ?? null,
          advisorPersona: 'engineer',
          reasoning_summary: reasoning?.summary || null,
          deduped: false,
          confidenceScore,
        });
        created++;
        existingTickets.push({ title: `[Engineer] ${issue.title}`, status: 'proposed' });
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
        ? buildInitialConsensus('engineer', consensusGate.threshold)
        : undefined;
      const ticket = await ticketService.add({
        type: 'bug',
        title: `[Engineer] ${issue.title}`,
        description: ticketDescription,
        userId: null,
        userEmail: 'advisor@docket.app',
        status: initialStatus,
        fileRefs: fileRefs.length > 0 ? fileRefs : undefined,
        reasoning,
        advisorPersona: 'engineer',
        // DK-188: Store the self-rated confidence score on the ticket for UI display.
        ...(confidenceScore > 0 ? { advisorConfidence: confidenceScore } : {}),
        ...(advisorRunId ? { advisorRunId } : {}),
        ...(consensusField ? { consensus: consensusField } : {}),
      });

      // Assign theme clusters (server-side, post-create)
      if (db) {
        try {
          const clusterIds = await assignClusters({
            db,
            projectId: project.id,
            title: `[Engineer] ${issue.title}`,
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
      existingTickets.push({ id: ticket.id, title: ticket.title, status: 'proposed', advisorPersona: 'engineer' });

      // Cross-persona convergence detection — check overlap against other personas' proposed tickets.
      // Uses the same keyword threshold as dedup but inverted: record instead of skip.
      if (db) {
        try {
          const newFilePaths = (fileRefs || []).map(r => r.path).filter(Boolean);
          const convergenceMatches = checkConvergence(
            existingTickets,
            ticket.title,
            'engineer',
            newFilePaths,
            effectiveDedupThreshold,
          );
          if (convergenceMatches.length > 0) {
            log(`[${project.id}] ${ticket.ticketId} converges with ${convergenceMatches.length} other ticket(s)`);
            await writeConvergence(
              db,
              project.id,
              ticket.id,
              ticket.ticketId,
              'engineer',
              issue.title,
              convergenceMatches,
              (msg) => log(`[${project.id}] ${msg}`),
            );
          }
        } catch (err) {
          log(`[${project.id}] Convergence check failed for ${ticket.ticketId}: ${err.message}`);
        }
      }

      // Async score — fires after ticket write, does not block creation.
      // If scoring fails, the ticket remains with null scores (handled gracefully in UI).
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
        filesScanned: files.length,
        proposalsSkipped: skippedReasons.length,
        skippedReasons,
        proposals: dryRunProposals,
        lastActivity: `${project.id}: dry-run preview — ${dryRunProposals.filter(p => !p.deduped).length} proposals`,
      };
    }
    report(`Audit complete — ${created} ticket(s) created${deferredSummary}${discardedSummary}`);
    return {
      ticketsCreated: created,
      filesScanned: files.length,
      exclusionSkipCount,
      focusAreaPathsMatchedZero,
      scopeMatchedZero,
      scopeFileCount,
      proposalsSkipped: skippedReasons.length,
      skippedReasons,
      discardedCount,
      lastActivity: `${project.id}: ${created > 0 ? `${created} ticket(s) created${deferredSummary}` : 'no new issues'}`,
    };
  }

  return { runAudit };
}

/**
 * Build fileRefs array for a single issue.
 * Stores top 10; UI caps at 5. Ranked by specificity (line range present = higher relevance).
 *
 * @param {object} issue - Parsed issue with file, lineStart, lineEnd fields
 * @param {string|null} commitSha - Current HEAD SHA captured at scan time
 * @returns {Array<{ path: string, lineStart?: number, lineEnd?: number, commitSha: string|null }>}
 */
function buildFileRefs(issue, commitSha) {
  if (!issue.file) return [];
  const ref = { path: issue.file };
  if (issue.lineStart != null && Number.isInteger(issue.lineStart)) {
    ref.lineStart = issue.lineStart;
    if (issue.lineEnd != null && Number.isInteger(issue.lineEnd)) {
      ref.lineEnd = issue.lineEnd;
    }
  }
  if (commitSha) ref.commitSha = commitSha;
  return [ref];
}

/**
 * Build the structured reasoning object for an Engineer ticket.
 *
 * Summary: one sentence explaining what was flagged and where.
 * Evidence: file-type entries derived from scanner output (fileRefs), not raw LLM output.
 * The note field is a short critique string — never a raw code excerpt.
 *
 * @param {object} issue - Parsed issue from LLM
 * @param {Array} fileRefs - Already-built fileRefs for this issue
 * @returns {{ summary: string, evidence: Array }}
 */
function buildReasoning(issue, fileRefs) {
  // Compose a one-sentence summary: severity + title + file location if available
  let summary = `Engineer flagged a ${issue.severity || 'medium'}-severity issue: ${issue.title}.`;
  if (issue.file) {
    const lineInfo = issue.lineStart != null ? ` at line ${issue.lineStart}` : '';
    summary = `Engineer flagged a ${issue.severity || 'medium'}-severity issue in ${issue.file}${lineInfo}: ${issue.title}.`;
  }

  // Build evidence entries from fileRefs — one entry per ref.
  // note is derived from the issue's recommendation or description (short critique),
  // never a raw code excerpt.
  const evidence = fileRefs.map(ref => {
    const noteText = issue.recommendation
      ? issue.recommendation.split('.')[0].trim().slice(0, 200)
      : issue.description
        ? issue.description.split('.')[0].trim().slice(0, 200)
        : issue.title;
    return {
      type: 'file',
      path: ref.path,
      ...(ref.lineStart != null ? { lineStart: ref.lineStart } : {}),
      ...(ref.lineEnd != null ? { lineEnd: ref.lineEnd } : {}),
      note: noteText,
    };
  });

  return { summary, evidence };
}

function buildTicketDescription(issue) {
  const parts = [];
  parts.push('## Issue');
  parts.push(issue.description);
  parts.push('');
  if (issue.file) { parts.push(`**File:** \`${issue.file}\``); parts.push(''); }
  parts.push(`**Severity:** ${issue.severity}`);
  parts.push('');
  if (issue.recommendation) { parts.push('## Recommendation'); parts.push(issue.recommendation); parts.push(''); }
  if (issue.avoidance) { parts.push('## Things to Avoid'); parts.push(issue.avoidance); parts.push(''); }
  parts.push('---');
  parts.push('*Generated by EPD Advisor — Engineer persona*');
  return parts.join('\n');
}
