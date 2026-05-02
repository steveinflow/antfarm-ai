// Product persona — generates feature ideas and runs them through
// a Design + Engineer consensus before creating tickets.
// Called once per project per cycle. Uses project.advisorContext for grounding.
//
// Flow:
//   1. PM generates up to 10 ideas grounded in the project's advisorContext
//   2. Design and Engineer review each in parallel
//   3. PM synthesizes feedback into a rich ticket description
//   4. Ticket is created for each idea

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, resolve, sep } from 'node:path';
import { ask } from './claude.js';
import { checkDuplicate, checkRejectionMatch, getValidatedDedupThreshold, checkConvergence } from './dedup.js';
import { writeConvergence } from './convergence.js';
import { fetchRejections, formatRejectionHistory } from './rejection-history.js';
import { assignClusters } from './cluster.js';
import { scoreProposal } from './scoreProposal.js';

import { getValidatedCap } from './engineer.js';
import { FILTER_REASONS } from './filter-reasons.js';
import { serializeConstraints, mergeConstraints, buildConstraintSummary } from './constraints.js';
import { validateFocus, buildFocusConstraintBlock } from './focus-validator.js';
import { injectPriorities, injectTopicExclusions, injectRejectionHistory, injectFocusDirective, injectCustomInstructions, buildScopeBlock } from './prompt-builder.js';
import { sanitizeSystemPrompt } from './custom-personas-config.js';
import { buildInitialConsensus } from './consensus.js';

// ── Feature flag grep patterns ────────────────────────────────────────────
// Static patterns for common feature flag / config check function names.
// We grep for these rather than evaluating flags at runtime.
const FLAG_FUNCTION_PATTERNS = [
  /\bisFeatureEnabled\s*\(/,
  /\bgetFlag\s*\(/,
  /\buseFlag\s*\(/,
  /\bfeatureFlag\s*\(/,
  /\bflag\s*\.\s*isEnabled\s*\(/,
  /\bgetConfig\s*\(/,
  /\bconfig\s*\.\s*get\s*\(/,
  /\benv\s*\.\s*FEATURE_/,
  /process\.env\.FEATURE_/,
];

const FLAG_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', 'tmp']);
const FLAG_SOURCE_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx']);
const FLAG_MAX_FILE_SIZE = 100 * 1024;
const FLAG_MAX_FILES = 80;
const FLAG_MAX_REFS = 10; // store top 10, display caps at 5

/**
 * Grep source files statically for feature flag / config check patterns.
 * Returns fileRefs sorted by number of matches (most relevant first).
 * Never stores code snippets — only file paths and line numbers.
 *
 * @param {string} repoPath - Absolute path to repo root
 * @param {string[]} scanPaths - Subdirectories to scan
 * @param {string|null} commitSha - Current HEAD SHA
 * @returns {Promise<Array<{ path, lineStart, lineEnd, commitSha }>>}
 */
async function grepFlagRefs(repoPath, scanPaths, commitSha) {
  const refs = []; // { path, lineStart, lineEnd, commitSha, _score }
  const seen = new Set(); // dedup by path

  async function walk(dir, base) {
    if (refs.length >= FLAG_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (refs.length >= FLAG_MAX_FILES) break;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (FLAG_SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath, base);
      } else if (entry.isFile()) {
        if (!FLAG_SOURCE_EXTS.has(extname(entry.name))) continue;
        if (seen.has(fullPath)) continue;
        try {
          const info = await stat(fullPath);
          if (info.size > FLAG_MAX_FILE_SIZE) continue;
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const matchedLines = [];
          for (let i = 0; i < lines.length; i++) {
            if (FLAG_FUNCTION_PATTERNS.some(re => re.test(lines[i]))) {
              matchedLines.push(i + 1); // 1-based
            }
          }
          if (matchedLines.length > 0) {
            seen.add(fullPath);
            const relPath = relative(base, fullPath);
            refs.push({
              path: relPath,
              lineStart: matchedLines[0],
              lineEnd: matchedLines[matchedLines.length - 1],
              commitSha: commitSha || undefined,
              _score: matchedLines.length,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  const realBase = resolve(repoPath);
  for (const sub of (scanPaths && scanPaths.length > 0 ? scanPaths : ['.'])) {
    const target = join(repoPath, sub);
    const realTarget = resolve(target);
    if (!realTarget.startsWith(realBase + sep) && realTarget !== realBase) continue;
    await walk(target, realBase);
    if (refs.length >= FLAG_MAX_FILES) break;
  }

  // Sort by score (most matches first) and cap at FLAG_MAX_REFS
  refs.sort((a, b) => b._score - a._score);
  return refs.slice(0, FLAG_MAX_REFS).map(({ _score, ...r }) => r);
}

// ── Related ticket matching ───────────────────────────────────────────────
const RELATED_LOWER_THRESHOLD = 0.3; // lower than dedup threshold to catch broader relations
const RELATED_UPPER_THRESHOLD = 0.6; // below this means related (not duplicate)

/**
 * Find tickets that are semantically related to a new idea title,
 * but not so similar they would be duplicates.
 *
 * @param {Array<{ id: string, title: string, status: string }>} existingTickets
 * @param {string} newTitle
 * @returns {string[]} array of Firestore doc IDs for related tickets
 */
function findRelatedTicketIds(existingTickets, newTitle) {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'be', 'as', 'it',
    'its', 'this', 'that', 'add', 'fix', 'update', 'improve', 'issue',
  ]);

  function kw(title) {
    return new Set(
      title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    );
  }

  function overlap(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let common = 0;
    for (const w of setA) if (setB.has(w)) common++;
    return common / Math.min(setA.size, setB.size);
  }

  const newKw = kw(newTitle);
  const related = [];

  for (const ticket of existingTickets) {
    if (!ticket.id) continue;
    const tkw = kw(ticket.title);
    const ratio = overlap(newKw, tkw);
    if (ratio >= RELATED_LOWER_THRESHOLD && ratio < RELATED_UPPER_THRESHOLD) {
      related.push(ticket.id);
    }
  }

  return related.slice(0, 5); // cap at 5 related tickets
}

// ── System prompts ───────────────────────────────────────────────

const PM_SYSTEM = `You are a senior product manager.
You think deeply about user needs, competitive positioning, and long-term product direction.
You prioritize simplicity, eliminate friction, and avoid feature bloat.
You have strong opinions about what makes software great: fast, predictable, gets out of the way.`;

const DESIGN_REVIEW_SYSTEM = `You are a senior UX designer reviewing a proposed product feature.
Think through the user journey: How will users discover this? What's the interaction model?
Where could this add friction? What's the simplest UI pattern that serves the need?
Be constructive and specific.`;

const ENGINEER_REVIEW_SYSTEM = `You are a senior engineer reviewing a proposed product feature.
The codebase should be suitable for open source. Think about: implementation complexity,
security implications, performance impact, and whether the approach is sound for an open codebase.
Flag anything that could be a security risk, an over-engineering trap, or hidden complexity.
Be direct and specific. If something is simple to build correctly, say so.`;

// ── Prompts ──────────────────────────────────────────────────────

function ideationPrompt({ advisorContext, existingTicketTitles }) {
  // SECURITY (DK-306): sanitize user-controlled advisorContext before interpolating into the prompt.
  const safeContext = sanitizeSystemPrompt(advisorContext || '');
  return `You are the PM for this product:

${safeContext}

---

Existing open tickets (do NOT propose duplicates of these):
${existingTicketTitles.length > 0 ? existingTicketTitles.map(t => `- ${t}`).join('\n') : '(none)'}

Generate up to 10 valuable feature ideas for this product right now.
Ground your thinking in the product context above — stay true to the product's purpose and direction.
Think about: what would make this noticeably better for its primary user?
What friction exists in the current workflow? What are the next natural steps given the stated direction?
Rank them from most to least valuable. Only include ideas that are clearly distinct from each other and from existing tickets.

Respond with a JSON array of objects:
[
  {
    "title": "Feature name (max 60 chars)",
    "rationale": "Why this is the right feature to build now (2-3 sentences)",
    "userStory": "As a [user], I want to [action] so that [benefit]",
    "scope": "What's in scope (bullet points)",
    "outOfScope": "What's explicitly NOT in scope"
  }
]

Respond ONLY with valid JSON — no prose, no markdown fences.`;
}

function designReviewPrompt(idea) {
  return `Review this proposed feature:

**Feature:** ${idea.title}
**Rationale:** ${idea.rationale}
**User story:** ${idea.userStory}
**Scope:** ${idea.scope}

As a UX designer, provide:
1. Key UX considerations for implementation
2. Suggested interaction patterns or UI elements
3. Potential friction points to watch out for
4. Any accessibility concerns

Keep it focused and actionable (3-5 bullet points per section max).
Respond in plain text.`;
}

function engineerReviewPrompt(idea) {
  return `Review this proposed feature for a web app intended for open source:

**Feature:** ${idea.title}
**Rationale:** ${idea.rationale}
**User story:** ${idea.userStory}
**Scope:** ${idea.scope}

As a security-focused engineer, provide:
1. Light implementation notes — recommended approach
2. Security considerations specific to this feature
3. Things to explicitly avoid (anti-patterns, over-engineering traps)
4. Estimated complexity: low / medium / high (with brief reason)

Keep it practical. Respond in plain text.`;
}

function synthesisPrompt(idea, designFeedback, engineerFeedback) {
  return `You proposed this feature:

**Feature:** ${idea.title}
**Rationale:** ${idea.rationale}
**User story:** ${idea.userStory}
**Scope:** ${idea.scope}
**Out of scope:** ${idea.outOfScope}

Your Design colleague said:
${designFeedback}

Your Engineer colleague said:
${engineerFeedback}

Now write the final ticket description. It should be clear enough that a developer
can pick it up and implement it without needing to ask questions.

Include these sections (use markdown headers):
## Feature
## User Need
## Design Notes
## Implementation Notes
## Things to Avoid
## Out of Scope

End with: ---
*Generated by EPD Advisor — Product/Design/Engineer consensus*

After the ticket description, on its own line at the very end, append your confidence rating:
CONFIDENCE: <integer 1-10>
Rate how confident you are this is a genuinely valuable, actionable feature worth building now. Be honest — do not inflate scores.

Write the ticket description now:`;
}

// ── Consensus metadata ───────────────────────────────────────────────────

const CONSENSUS_SUMMARY_MAX = 300; // hard cap per ticket spec

/**
 * Strip HTML tags from a string and collapse whitespace.
 * Used to sanitize LLM summaries before storage — never trust raw LLM output.
 *
 * @param {string} str
 * @returns {string}
 */
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract a verdict ('approved' | 'flagged') and a short summary from a
 * persona review response.
 *
 * Heuristic: look for explicit positive/negative signal words in the first
 * paragraph of the response to determine verdict. The summary is the first
 * 1–2 sentences of the response, stripped and capped.
 *
 * This does NOT make a second API call — it parses the text that was already
 * returned by the Design or Engineer review step.
 *
 * @param {string} responseText - Raw text response from a design/engineer review
 * @returns {{ verdict: 'approved'|'flagged', summary: string }}
 */
function extractConsensusEntry(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return { verdict: 'approved', summary: '' };
  }

  // Determine verdict from negative signal words in the response.
  // Any mention of high risk, serious concern, or security issue → 'flagged'.
  const lower = responseText.toLowerCase();
  const NEGATIVE_SIGNALS = [
    'security risk', 'security concern', 'security issue',
    'serious concern', 'serious issue', 'serious problem',
    'high risk', 'significant risk', 'critical risk',
    'should not', 'must not', 'avoid this',
    'would flag', 'flagging', 'flagged',
    'reject', 'rejected', 'not recommend',
    'dangerous', 'unsafe', 'problematic',
    'over-engineer', 'overenginer',
  ];
  const hasNegative = NEGATIVE_SIGNALS.some(sig => lower.includes(sig));
  const verdict = hasNegative ? 'flagged' : 'approved';

  // Extract summary: first 2 sentences of the response, stripped and capped.
  const cleaned = stripHtml(responseText);
  // Split on sentence boundaries, then take up to 2 sentences
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const summary = sentences.slice(0, 2).join(' ').slice(0, CONSENSUS_SUMMARY_MAX);

  return { verdict, summary };
}

/**
 * Build the consensusMetadata object to store on the ticket.
 * Both summary strings are sanitized: HTML stripped and capped at 300 chars.
 *
 * @param {string} designFeedback - Raw design review response text
 * @param {string} engineerFeedback - Raw engineer review response text
 * @returns {{ engineer: { verdict, summary }, design: { verdict, summary }, agreement: boolean }}
 */
function buildConsensusMetadata(designFeedback, engineerFeedback) {
  const design = extractConsensusEntry(designFeedback);
  const engineer = extractConsensusEntry(engineerFeedback);
  const agreement = design.verdict === 'approved' && engineer.verdict === 'approved';
  return { engineer, design, agreement };
}

// ── Logger ───────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [product] ${msg}`);
}

function parseIdeas(raw) {
  if (!raw || !raw.trim()) return [];

  const tryParse = (str) => {
    const cleaned = str.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
    const parsed = JSON.parse(cleaned);
    const ideas = Array.isArray(parsed) ? parsed : [parsed];
    return ideas.filter(idea => idea?.title);
  };

  try {
    return tryParse(raw);
  } catch {} // eslint-disable-line no-empty

  // Extract first [...] or {...} block to handle agent narration before the JSON
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { return tryParse(raw.slice(arrStart, arrEnd + 1)); } catch {} // eslint-disable-line no-empty
  }
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try { return tryParse(raw.slice(objStart, objEnd + 1)); } catch {} // eslint-disable-line no-empty
  }

  const preview = raw.slice(0, 300).replace(/\n/g, ' ');
  log(`Failed to parse ideas JSON. Raw response preview: "${preview}"`);
  return [];
}

/**
 * Build a one-sentence reasoning summary for a Product idea.
 * Uses the idea's rationale (first sentence) so the summary is grounded in
 * the PM's stated reasoning, not reconstructed by the model.
 *
 * @param {object} idea - Parsed idea with title and rationale fields
 * @returns {string}
 */
function buildProductReasoningSummary(idea) {
  if (idea.rationale) {
    // Use the first sentence of the rationale, capped at 200 chars
    const firstSentence = idea.rationale.split(/[.!?]/)[0].trim();
    if (firstSentence.length > 0) {
      return `Product proposed "${idea.title}": ${firstSentence}.`;
    }
  }
  if (idea.userStory) {
    return `Product proposed "${idea.title}" based on user need: ${idea.userStory.slice(0, 150)}.`;
  }
  return `Product proposed "${idea.title}" as a valuable feature improvement.`;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object} opts.config - advisor.product config (model, reviewGate)
 */
export function createProductManager({ config }) {
  const model = config.model || 'claude-sonnet-4-6';

  /**
   * Run one product cycle for a single project.
   *
   * @param {object} opts
   * @param {object} opts.project        - Firestore project doc (id, name, advisorContext)
   * @param {object} opts.ticketService
   * @param {object} [opts.db]           - Firestore Admin instance (for rejection history)
   * @param {string} [opts.repoPath]     - Absolute path to repo (for flag grep)
   * @param {string[]} [opts.scanPaths]  - Subdirs to scan for flag patterns (relative to repoPath)
   * @param {string|null} [opts.commitSha] - HEAD commit SHA captured at scan time
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
   * @param {string|null} [opts.weightPriorityLine] - DK-105: Optional priority line built from per-project emphasis weights
   * @param {object|null} [opts.constraints] - DK-365: Saved persona constraints (budget, platform, audience, complexity, risk)
   * @param {object|null} [opts.constraintOverride] - DK-365: Per-run constraint override (shadows saved constraints for this run only; never persisted)
   * @param {boolean} [opts.dryRun] - When true, skip writing tickets; return proposals array instead
   * @param {string|null} [opts.targetSegment] - DK-101: Focus on a specific user segment (e.g. "SMB users"), max 200 chars
   * @param {string|null} [opts.businessGoal] - DK-101: Business goal context (e.g. "reduce churn"), max 200 chars
   * @param {string|null} [opts.directive] - DK-319: Per-persona per-project focus directive (plain text, already sanitized)
   * @param {object|null} [opts.focus] - DK-187: Validated focus config from Firestore { keywords: string[] }.
   *   Injected as a <focus_constraints> block into the system prompt. Pre-validated by validateFocus().
   * @param {string|null} [opts.priorities] - DK-302: Current team priorities from advisorContext.priorities.
   *   Injected before all other prompt modifiers when non-empty. Trim and cap enforced by prompt-builder.
   * @param {string|null} [opts.focusAreaTopics] - DK-301: Comma-separated topic keywords (legacy string format).
   * @param {string[]} [opts.scopeTopics] - DK-134: Topic tags from per-project scope.topics[]. New array format.
   *   Injected as a labeled context block. Treated as untrusted freeform content, not instructions.
   * @param {number} [opts.minConfidence] - DK-188: Minimum confidence score (1–10). Ideas scoring below
   *   this threshold are discarded and logged instead of creating tickets. Default 5 if missing.
   * @param {object|null} [opts.consensusGate] - Cross-persona consensus gate config (DK-194).
   *   When enabled, tickets are written with a consensus field and stay in 'proposed' until
   *   enough other personas have endorsed them. Shape: { enabled, threshold }.
   *   When enabled, the inline Design+Engineer review step is skipped — cross-review happens
   *   asynchronously via Firestore instead. When null or disabled, the existing inline review
   *   step runs and yoloMode controls whether tickets are created as proposed vs open.
   * @returns {Promise<{ ticketsCreated: number, lastActivity: string, proposals?: object[] }>}
   */
  async function runCycle({ project, ticketService, db, repoPath, scanPaths, commitSha, onActivity, soulPrompt, focusPrompt, scopeText, feedbackContextBlock, runLogger, ticketCap, dedupThreshold, personaInstructions, weightPriorityLine, constraints = null, constraintOverride = null, dryRun = false, targetSegment, businessGoal, directive, focus, priorities, focusAreaTopics, topicExclusions, minConfidence, consensusGate = null, scopeTopics }) {
    const report = (msg) => {
      log(`[${project.id}] ${msg}`);
      if (onActivity) onActivity(`${project.id}: ${msg}`);
    };

    report('Starting product cycle…');

    const advisorContext = project.advisorContext;
    if (!advisorContext?.trim()) {
      report('No advisorContext — skipping');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: no context set` };
    }

    // DK-101: Product focusAreas — prepend targetSegment and businessGoal as context.
    // Both fields are capped at 200 characters (server-side enforcement).
    // This is a simple prompt prepend: no structural change to the prompt builder.
    const safeTargetSegment = (typeof targetSegment === 'string' && targetSegment.trim())
      ? targetSegment.trim().slice(0, 200)
      : null;
    const safeBusinessGoal = (typeof businessGoal === 'string' && businessGoal.trim())
      ? businessGoal.trim().slice(0, 200)
      : null;

    if (safeTargetSegment) report(`Focus: target segment = "${safeTargetSegment}"`);
    if (safeBusinessGoal) report(`Focus: business goal = "${safeBusinessGoal}"`);

    // Use listStubs() for dedup — only needs title/status/snoozedUntil/id,
    // not full ticket documents. Falls back to listAll() for older service instances.
    const existingTickets = await (ticketService.listStubs || ticketService.listAll).call(ticketService);
    const openTitles = existingTickets
      .filter(t => t.status === 'open' || t.status === 'in_progress')
      .map(t => t.title);

    log(`[${project.id}] ${existingTickets.length} total tickets, ${openTitles.length} open`);

    // Fetch rejection history for this project (for dedup and prompt injection)
    const rejections = db ? await fetchRejections(db, project.id) : [];
    if (rejections.length > 0) {
      report(`${rejections.length} rejection(s) in history`);
    }
    const rejectionHistoryBlock = formatRejectionHistory(rejections, 'product');

    // SECURITY (DK-392): sanitize soulPrompt before use — it is user-controllable via Firestore
    // and must not be interpolated raw into the system prompt (prompt injection risk).
    const basePmSystem = sanitizeSystemPrompt(soulPrompt) || PM_SYSTEM;
    // DK-302: Inject current team priorities as the first shared block in the system prompt.
    // Only injected when non-empty after trimming — no block produced for empty/missing priorities.
    const basePmSystemWithPriorities = injectPriorities(basePmSystem, priorities);
    if (priorities?.trim()) report(`Current priorities active (${priorities.trim().length} chars)`);
    // DK-367: Inject scope as a clearly delimited block early in the system prompt.
    // Scope narrows the idea generation to a specific surface, flow, or segment.
    const basePmSystemWithScope = scopeText
      ? `${basePmSystemWithPriorities}\n\n[SCOPE: ${scopeText}]\nFocus your analysis exclusively on the scope defined above.`
      : basePmSystemWithPriorities;
    // DK-101: Prepend focusAreas context (targetSegment, businessGoal) as plain context lines.
    // Injected before project-specific instructions — a one-liner that grounds the run.
    const focusLines = [];
    if (safeTargetSegment) focusLines.push(`Focus on: ${safeTargetSegment}.`);
    if (safeBusinessGoal) focusLines.push(`Business goal: ${safeBusinessGoal}.`);
    const basePmSystemWithFocus = focusLines.length > 0
      ? `${basePmSystemWithScope}\n\n${focusLines.join(' ')}`
      : basePmSystemWithScope;
    // DK-133: Inject custom instructions (project override ?? global fallback) after base prompt.
    // Uses clearly delimited block so logs distinguish user content from system content.
    const pmSystemWithInstructions = injectCustomInstructions(basePmSystemWithFocus, personaInstructions);
    // DK-039: Inject per-persona per-project focus directive after project-specific instructions.
    // Uses injectFocusDirective() from prompt-builder.js which wraps the directive in clearly
    // delimited [FOCUS START] / [FOCUS END] markers per spec. Only injected when non-empty.
    const pmSystemWithDirective = injectFocusDirective(pmSystemWithInstructions, directive);
    // DK-321: Append user hint under an explicit header — clearly separated from system instructions.
    const pmSystemWithFocus = focusPrompt
      ? `${pmSystemWithDirective}\n\n---\nUser context (one-time override):\n${focusPrompt}`
      : pmSystemWithDirective;
    // Append feedback context block at the end of the system prompt if available.
    // Contains only aggregated numeric stats and category labels — no raw ticket content.
    const pmSystemWithFeedback = feedbackContextBlock
      ? `${pmSystemWithFocus}\n\n---\n${feedbackContextBlock}`
      : pmSystemWithFocus;
    // DK-105: Append weight priority line if any concern weight differs from default (1).
    // When all weights are at default, nothing is injected — current behavior is preserved.
    const pmSystemWithWeights = weightPriorityLine
      ? `${pmSystemWithFeedback}\n\n${weightPriorityLine}`
      : pmSystemWithFeedback;
    // DK-365: Merge saved constraints with per-run override, then serialize into prompt block.
    // Per-run overrides are ephemeral — they shadow saved constraints for this run only.
    const effectiveConstraints = mergeConstraints(constraints, constraintOverride);
    const constraintBlock = serializeConstraints(effectiveConstraints);
    if (constraintBlock) {
      report(`Constraints active: ${buildConstraintSummary(effectiveConstraints) || 'yes'}`);
    }
    const pmSystemWithConstraints = constraintBlock
      ? `${pmSystemWithWeights}\n\n${constraintBlock}`
      : pmSystemWithWeights;
    // DK-187: Inject focus constraints if set. Values are pre-validated by validateFocus()
    // before reaching here — only safe strings are included. Wrapped in XML-style tags so
    // the model treats them as data, not instructions.
    const focusConstraintBlock = buildFocusConstraintBlock(focus || null, 'product');
    if (focusConstraintBlock) {
      report(`Focus constraints active: ${focus?.keywords?.length || 0} keyword(s)`);
    }
    const pmSystemWithFocusConstraints = focusConstraintBlock
      ? `${pmSystemWithConstraints}\n\n${focusConstraintBlock}`
      : pmSystemWithConstraints;
    // DK-134: Inject per-project scope topics via buildScopeBlock (new array format).
    // Falls back to legacy DK-301 string focusAreaTopics when scopeTopics is empty.
    const safeScopeTopics = Array.isArray(scopeTopics) ? scopeTopics : [];
    const newProductScopeBlock = buildScopeBlock({ topics: safeScopeTopics });
    let pmSystemWithFocusArea = pmSystemWithFocusConstraints;
    if (newProductScopeBlock) {
      report(`Scope topics active: [${safeScopeTopics.join(', ')}]`);
      pmSystemWithFocusArea = `${pmSystemWithFocusConstraints}\n\n---\n${newProductScopeBlock}`;
    } else {
      // Legacy DK-301 string format
      const productFocusAreaTopicsSafe = (typeof focusAreaTopics === 'string' && focusAreaTopics.trim())
        ? focusAreaTopics.trim().slice(0, 300)
        : null;
      if (productFocusAreaTopicsSafe) {
        const productFocusAreaBlock = `Focus constraints (user-defined):\nTopics: ${productFocusAreaTopicsSafe}\n\nLimit your analysis to the above scope.`;
        report(`Scope focus active: topics="${productFocusAreaTopicsSafe}"`);
        pmSystemWithFocusArea = `${pmSystemWithFocusConstraints}\n\n---\n${productFocusAreaBlock}`;
      }
    }
    // DK-320: Inject rejection history after main persona instructions, before output format/exclusions.
    // The block contains only immutable server-side snapshots — no user-supplied text.
    const pmSystemWithRejections = injectRejectionHistory(pmSystemWithFocusArea, rejectionHistoryBlock);
    if (rejectionHistoryBlock) {
      report(`Rejection history injected (${rejections.length} rejection(s))`);
    }
    // DK-112: Inject per-persona topic exclusion rules at the end of the system prompt.
    // These tell the model which topics to never propose. Sanitized by prompt-builder.
    const effectivePmSystem = injectTopicExclusions(pmSystemWithRejections, topicExclusions);
    if (Array.isArray(topicExclusions) && topicExclusions.length > 0) {
      report(`Topic exclusions active: ${topicExclusions.length} rule(s)`);
    }

    // Step 1: Generate up to 10 ideas
    report('Generating feature ideas…');
    const ideasRaw = await ask(effectivePmSystem, ideationPrompt({ advisorContext, existingTicketTitles: openTitles }), { model });
    const ideas = parseIdeas(ideasRaw);

    if (ideas.length === 0) {
      report('Failed to generate valid ideas — skipping');
      return { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: `${project.id}: idea generation failed` };
    }

    report(`Generated ${ideas.length} idea(s)`);

    // Per-persona dedup sensitivity (DK-130). Clamped to [1, 10]; defaults to 3 (Medium).
    const effectiveDedupThreshold = getValidatedDedupThreshold(dedupThreshold);

    // DK-188: Validate minConfidence — must be integer 1–10, default 5.
    const effectiveMinConfidence = (Number.isInteger(minConfidence) && minConfidence >= 1 && minConfidence <= 10)
      ? minConfidence
      : 5;

    // Filter out duplicates against open tickets and rejection history
    const skippedReasons = [];
    const uniqueIdeas = ideas.filter(idea => {
      const { isDuplicate, matchTitle, matchId, matchedKeywords } = checkDuplicate(existingTickets, idea.title, effectiveDedupThreshold);
      if (isDuplicate) {
        log(`[${project.id}] "${idea.title}" too similar to "${matchTitle}" — skipping`);
        const matchedTicket = existingTickets.find(t => t.title === matchTitle);
        skippedReasons.push({
          title: `[Product] ${idea.title}`,
          reason: `duplicate: similar to existing ticket`,
          ...(matchedTicket?.id ? { matchedTicketId: matchedTicket.id } : {}),
        });
        if (runLogger) {
          runLogger.addRejected({ title: idea.title, reason: 'duplicate', matchedTicketId: matchId });
          // DK-189: record structured dedup hit for the run log drawer
          if (matchId && matchedKeywords) {
            runLogger.addDeduped({ summary: matchedKeywords, blockedBy: matchId });
          }
        }
        return false;
      }
      const { isSuppressed, matchTitle: rejMatchTitle, matchCount } = checkRejectionMatch(rejections, idea.title, effectiveDedupThreshold);
      if (isSuppressed) {
        log(`[${project.id}] "${idea.title}" matches rejected proposal "${rejMatchTitle}" (${matchCount} similar rejection(s)) — skipping`);
        skippedReasons.push({
          title: `[Product] ${idea.title}`,
          reason: `duplicate: ${matchCount}% overlap with rejected proposal`,
        });
        if (runLogger) {
          runLogger.addRejected({ title: idea.title, reason: 'threshold' });
          runLogger.addFiltered(FILTER_REASONS.REJECTION_MATCH);
        }
        return false;
      }
      return true;
    });

    if (uniqueIdeas.length === 0) {
      report('All ideas were duplicates or matched rejections — skipping');
      return { ticketsCreated: 0, proposalsSkipped: skippedReasons.length, skippedReasons, lastActivity: `${project.id}: all ideas were duplicates or rejected` };
    }

    // Apply per-run ticket cap. The PM already ranks ideas from most to least
    // valuable in the ideation prompt response — preserve that order, just slice.
    const cap = getValidatedCap(ticketCap);
    const ideasToCreate = uniqueIdeas.slice(0, cap);
    const deferredCount = uniqueIdeas.length - ideasToCreate.length;
    if (deferredCount > 0) {
      report(`Applying cap: creating ${ideasToCreate.length} of ${uniqueIdeas.length} candidates (${deferredCount} deferred)`);
      // DK-189: record deferred proposals as filtered by run cap
      if (runLogger) {
        for (let i = 0; i < deferredCount; i++) runLogger.addFiltered(FILTER_REASONS.RATE_LIMIT);
      }
    }
    log(`[${project.id}] Product: ${ideasToCreate.length} of ${uniqueIdeas.length} candidates this run${deferredCount > 0 ? ` (${deferredCount} deferred)` : ''}`);

    report(`${ideasToCreate.length} unique idea(s) to process (cap: ${cap})`);

    // Pre-compute flag fileRefs once per cycle (shared across all ideas in this project run)
    let flagFileRefs = [];
    if (repoPath) {
      try {
        flagFileRefs = await grepFlagRefs(repoPath, scanPaths || ['src'], commitSha || null);
        if (flagFileRefs.length > 0) {
          report(`Found ${flagFileRefs.length} config/flag reference(s) in source`);
        }
      } catch (err) {
        log(`[${project.id}] Flag grep failed: ${err.message}`);
      }
    }

    // DK-194: check whether the shared consensus gate is enabled.
    // When enabled, the inline Design+Engineer review step is skipped — cross-review
    // happens asynchronously via Firestore (each persona evaluates proposed tickets on
    // its own timer cycle). The ticket is written with a consensus field instead.
    const consensusEnabled = consensusGate?.enabled && typeof consensusGate?.threshold === 'number';

    // Step 2–4: Process each capped idea sequentially
    const createdTitles = [];
    let discardedCount = 0;
    const dryRunProposals = []; // populated when dryRun: true
    for (const idea of ideasToCreate) {
      let designFeedback = null;
      let engineerFeedback = null;
      let consensusMetadata = null;

      if (consensusEnabled) {
        // DK-194: Skip inline review — cross-persona gate handles this asynchronously.
        report(`Skipping inline review for "${idea.title}" — consensus gate will evaluate asynchronously`);
      } else {
        // Step 2: Design + Engineer review in parallel (existing inline review path).
        report(`Reviewing "${idea.title}"…`);
        [designFeedback, engineerFeedback] = await Promise.all([
          ask(DESIGN_REVIEW_SYSTEM, designReviewPrompt(idea), { model }),
          ask(ENGINEER_REVIEW_SYSTEM, engineerReviewPrompt(idea), { model }),
        ]);

        // DK-126: Extract consensus metadata from the review responses at capture time.
        // No second API call — parsed directly from the text already returned above.
        consensusMetadata = buildConsensusMetadata(designFeedback, engineerFeedback);
        report(`Inline review: design=${consensusMetadata.design.verdict}, engineer=${consensusMetadata.engineer.verdict}, agreement=${consensusMetadata.agreement}`);
      }

      // Step 3: Synthesize ticket description.
      // When using the consensus gate, synthesize without design/engineer feedback
      // (those are async and not yet available). The synthesis prompt gracefully
      // handles null feedback values by omitting those sections.
      report(`Synthesizing ticket for "${idea.title}"…`);
      // DK-194: When consensus gate is enabled, synthesize without Design/Engineer feedback
      // (cross-review happens async via Firestore). When disabled, use inline feedback.
      const synthesisRaw = consensusEnabled
        ? await ask(effectivePmSystem, synthesisPrompt(idea, '(cross-review pending)', '(cross-review pending)'), { model, maxTokens: 2048 })
        : await ask(effectivePmSystem, synthesisPrompt(idea, designFeedback, engineerFeedback), { model, maxTokens: 2048 });

      // DK-188: Parse CONFIDENCE score from the end of the synthesis output.
      // The regex matches "CONFIDENCE: N" on its own line (N = 1–10).
      // Any parse failure scores 0 — treated as below any threshold (discard).
      const confidenceMatch = synthesisRaw.match(/^CONFIDENCE:\s*([1-9]|10)\s*$/m);
      const confidenceScore = confidenceMatch ? parseInt(confidenceMatch[1], 10) : 0;

      // Strip the CONFIDENCE line from the description before storing.
      const rawDescription = synthesisRaw.replace(/^CONFIDENCE:\s*([1-9]|10)\s*\n?/m, '').trimEnd();

      // DK-188: Check confidence threshold. Discard if below minimum.
      if (confidenceScore < effectiveMinConfidence) {
        log(`[${project.id}] ${dryRun ? '[dry-run] ' : ''}Skip (confidence ${confidenceScore} < threshold ${effectiveMinConfidence}): ${idea.title}`);
        skippedReasons.push({ title: `[Product] ${idea.title}`, reason: `low_confidence: score ${confidenceScore}` });
        if (runLogger) {
          runLogger.addRejected({ title: idea.title, reason: 'low_confidence', score: confidenceScore });
          runLogger.addFiltered(FILTER_REASONS.LOW_CONFIDENCE);
        }
        // DK-188: Write discard record to Firestore (never silent).
        if (db && !dryRun) {
          db.collection('advisor').doc('discards').collection('items').add({
            persona: 'product',
            score: confidenceScore,
            threshold: effectiveMinConfidence,
            ticketDraft: { title: `[Product] ${idea.title}`, summary: (rawDescription || '').slice(0, 500) },
            projectId: project.id,
            timestamp: new Date(),
          }).catch(err => log(`[${project.id}] Failed to write discard record: ${err.message}`));
        }
        discardedCount++;
        if (dryRun) {
          dryRunProposals.push({
            title: `[Product] ${idea.title}`,
            description: rawDescription,
            type: 'feature',
            advisorPersona: 'product',
            deduped: true,
            filterReason: 'low_confidence',
            confidenceScore,
          });
        }
        continue;
      }

      // DK-365: Prepend constraint summary to the output description.
      // The summary is visible only to the persona owner (enforced by Firestore rules).
      // audience_segment is excluded from the visible header to avoid PII exposure in output.
      const constraintSummary = buildConstraintSummary(effectiveConstraints);
      const description = constraintSummary
        ? `*Ideas generated for: ${constraintSummary}.*\n\n${rawDescription}`
        : rawDescription;

      // Collect related ticket IDs (tickets with some keyword overlap, below the duplicate threshold)
      const relatedTicketIds = findRelatedTicketIds(existingTickets, idea.title);

      // Build reasoning — Product persona provides summary only; evidence array is empty.
      const reasoning = {
        summary: buildProductReasoningSummary(idea),
        evidence: [],
      };

      if (dryRun) {
        // Dry-run: collect proposal without writing to Firestore
        dryRunProposals.push({
          title: `[Product] ${idea.title}`,
          description,
          type: 'feature',
          advisorPersona: 'product',
          reasoning_summary: reasoning.summary,
          deduped: false,
          confidenceScore,
        });
        createdTitles.push(idea.title);
        existingTickets.push({ title: `[Product] ${idea.title}`, status: 'proposed' });
        log(`[${project.id}] [dry-run] Proposed: ${idea.title}`);
        continue;
      }

      // Step 4: Create ticket.
      // Respect yoloMode and consensusGate to determine initial status.
      // consensusGate takes precedence: tickets always start as 'proposed' and are
      // promoted asynchronously by checkAndPromote in consensus.js.
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
        ? buildInitialConsensus('product', consensusGate.threshold)
        : undefined;
      const ticket = await ticketService.add({
        type: 'feature',
        title: `[Product] ${idea.title}`,
        description,
        userId: null,
        userEmail: 'advisor@docket.app',
        status: initialStatus,
        relatedTicketIds: relatedTicketIds.length > 0 ? relatedTicketIds : undefined,
        fileRefs: flagFileRefs.length > 0 ? flagFileRefs : undefined,
        reasoning,
        advisorPersona: 'product',
        // DK-126: Store inline consensus metadata when gate is NOT enabled.
        // When the gate IS enabled, the consensus field holds the cross-persona endorsements.
        ...(consensusMetadata ? { consensusMetadata } : {}),
        ...(consensusField ? { consensus: consensusField } : {}),
        // DK-188: Store the self-rated confidence score on the ticket for UI display.
        ...(confidenceScore > 0 ? { advisorConfidence: confidenceScore } : {}),
        ...(advisorRunId ? { advisorRunId } : {}),
      });

      // Step 5: Assign theme clusters (server-side, post-create)
      if (db) {
        try {
          const clusterIds = await assignClusters({
            db,
            projectId: project.id,
            title: `[Product] ${idea.title}`,
            description,
          });
          if (clusterIds.length > 0) {
            await ticketService.update(ticket.id, { clusterIds });
            log(`[${project.id}] Clustered ${ticket.ticketId} → [${clusterIds.join(', ')}]`);
          }
        } catch (err) {
          log(`[${project.id}] Cluster assignment failed for ${ticket.ticketId}: ${err.message}`);
        }
      }

      log(`[${project.id}] Created ${ticket.ticketId}: ${idea.title}${relatedTicketIds.length > 0 ? ` (${relatedTicketIds.length} related)` : ''}`);
      if (runLogger) runLogger.addCreated(ticket.id);
      createdTitles.push(idea.title);
      existingTickets.push({ id: ticket.id, title: ticket.title, status: 'proposed', advisorPersona: 'product' });

      // Cross-persona convergence detection — check overlap against other personas' proposed tickets.
      if (db) {
        try {
          const newFilePaths = (flagFileRefs || []).map(r => r.path).filter(Boolean);
          const convergenceMatches = checkConvergence(
            existingTickets,
            ticket.title,
            'product',
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
              'product',
              idea.title,
              convergenceMatches,
              (msg) => log(`[${project.id}] ${msg}`),
            );
          }
        } catch (err) {
          log(`[${project.id}] Convergence check failed for ${ticket.ticketId}: ${err.message}`);
        }
      }

      // Step 6: Async score — fires after ticket write, does not block creation.
      // If scoring fails, the ticket remains with null scores (handled gracefully in UI).
      const ticketContent = `${ticket.title}\n\n${description}`;
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
      report(`Preview complete — ${dryRunProposals.length} proposal(s) found`);
      return {
        ticketsCreated: 0,
        proposalsSkipped: skippedReasons.length,
        skippedReasons,
        proposals: dryRunProposals,
        lastActivity: `${project.id}: dry-run preview — ${dryRunProposals.length} proposals`,
      };
    }
    return {
      ticketsCreated: createdTitles.length,
      proposalsSkipped: skippedReasons.length,
      skippedReasons,
      discardedCount,
      lastActivity: `${project.id}: created ${createdTitles.length} ticket(s)${deferredSummary}${discardedSummary}: ${createdTitles.map(t => `"${t}"`).join(', ')}`,
    };
  }

  return { runCycle };
}
