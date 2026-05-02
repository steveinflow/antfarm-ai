// Theme clustering — assigns tickets to clusters based on keyword overlap.
// Runs server-side at proposal creation time. Never called from the client.
//
// Algorithm:
//   1. Extract keywords from ticket title + description (strip stopwords, word freq)
//   2. Load existing clusters for the project
//   3. Score keyword overlap vs each cluster's keywords array
//   4. If overlap >= threshold, assign to that cluster (multi-cluster supported)
//   5. If no match and cluster cap not reached, create a new cluster
//   6. Extract 1–2 word label from highest-frequency nouns; fall back to "Uncategorized"
//   7. Increment ticketCount on matched/created clusters

import { createClusterService, sanitizeClusterLabel } from '@docket/core';

// ── Constants ────────────────────────────────────────────────────────────────

const CLUSTER_OVERLAP_THRESHOLD = 0.3; // minimum overlap to assign to existing cluster
const CLUSTER_CAP = 50;               // max clusters per project

// Extended stop-word list — common verbs and articles stripped so only nouns remain
const STOP_WORDS = new Set([
  // Common English words
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'be', 'as', 'it',
  'its', 'this', 'that', 'not', 'no', 'so', 'do', 'we', 'our', 'us',
  'can', 'will', 'would', 'could', 'should', 'may', 'might',
  // Software-specific filler words
  'add', 'fix', 'update', 'improve', 'issue', 'bug', 'feature', 'new',
  'get', 'set', 'use', 'make', 'let', 'also', 'more', 'when', 'then',
  'each', 'all', 'any', 'some', 'have', 'has', 'had', 'been',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract keyword set from text (title + description).
 * Returns an array of unique lowercase non-stopword words (length > 2).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  // Deduplicate and return as array
  return [...new Set(words)];
}

/**
 * Compute keyword overlap ratio between two keyword arrays.
 * Uses Jaccard-like: intersection / min(|A|, |B|).
 *
 * @param {string[]} kwA
 * @param {string[]} kwB
 * @returns {number} 0–1
 */
function overlapRatio(kwA, kwB) {
  if (!kwA.length || !kwB.length) return 0;
  const setA = new Set(kwA);
  const setB = new Set(kwB);
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / Math.min(setA.size, setB.size);
}

/**
 * Extract a 1–2 word label candidate from a keyword frequency map.
 * Returns "Uncategorized" when confidence is too low.
 *
 * Strategy:
 *   - Count word frequency across title + description
 *   - Prefer 2-gram (bigram) combinations of top words that appear together in original text
 *   - Fall back to single highest-frequency non-stopword word
 *   - If nothing qualifies, return "Uncategorized"
 *
 * @param {string} title
 * @param {string} description
 * @returns {string} 1–2 word label, title-cased
 */
function extractLabel(title, description) {
  const text = `${title} ${description}`;
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (words.length === 0) return 'Uncategorized';

  // Count word frequency
  const freq = new Map();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  // Find top word
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return 'Uncategorized';

  const topWord = sorted[0][0];

  // Attempt a 2-word label: top word + second most frequent word that appears adjacent
  if (sorted.length >= 2) {
    const secondWord = sorted[1][0];
    // Check if topWord and secondWord appear adjacent in title (for coherent 2-gram)
    const titleLower = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const bigramForward = `${topWord} ${secondWord}`;
    const bigramReverse = `${secondWord} ${topWord}`;
    if (titleLower.includes(bigramForward)) {
      return toTitleCase(bigramForward);
    }
    if (titleLower.includes(bigramReverse)) {
      return toTitleCase(bigramReverse);
    }
  }

  // Single word — must have appeared at least twice (frequency check for confidence)
  if (sorted[0][1] >= 2 || words.length <= 2) {
    return toTitleCase(topWord);
  }

  // Low confidence — single occurrence only in short text
  return toTitleCase(topWord);
}

/**
 * Title-case a word or phrase.
 * @param {string} str
 * @returns {string}
 */
function toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assign a newly-created ticket to theme clusters.
 *
 * Called server-side at proposal write time (inside the advisor daemon).
 * Returns the clusterIds assigned to this ticket (may be empty or multiple).
 *
 * @param {object} opts
 * @param {object} opts.db          - Firestore Admin instance
 * @param {string} opts.projectId
 * @param {string} opts.title       - Ticket title
 * @param {string} [opts.description] - Ticket description (optional)
 * @returns {Promise<string[]>}     - Array of clusterIds assigned (may be empty)
 */
export async function assignClusters({ db, projectId, title, description = '' }) {
  const clusterService = createClusterService(db, projectId);

  // Extract keywords from this ticket
  const ticketKeywords = extractKeywords(`${title} ${description}`);

  // No usable keywords — label as Uncategorized if clusters exist, else skip
  if (ticketKeywords.length === 0) {
    return await _handleUncategorized(clusterService, db, title, description);
  }

  // Load existing clusters
  const existingClusters = await clusterService.list();

  // Score overlap with each existing cluster
  const matched = [];
  for (const cluster of existingClusters) {
    const clusterKw = Array.isArray(cluster.keywords) ? cluster.keywords : [];
    const ratio = overlapRatio(ticketKeywords, clusterKw);
    if (ratio >= CLUSTER_OVERLAP_THRESHOLD) {
      matched.push(cluster.id);
    }
  }

  if (matched.length > 0) {
    // Assign to matched clusters and increment their counts
    await clusterService.incrementCounts(matched);
    return matched;
  }

  // No match — create a new cluster if under cap
  const currentCount = existingClusters.length;
  if (currentCount >= CLUSTER_CAP) {
    // Cap reached — find or create "Uncategorized"
    return await _handleUncategorized(clusterService, db, title, description);
  }

  // Extract label for new cluster
  const label = extractLabel(title, description);

  // Create new cluster — keywords limited to top 30 for storage efficiency
  const topKeywords = ticketKeywords.slice(0, 30);
  const newCluster = await clusterService.create({
    label: sanitizeClusterLabel(label),
    keywords: topKeywords,
  });

  return [newCluster.id];
}

/**
 * Handle the "Uncategorized" path: find existing Uncategorized cluster or create one.
 *
 * @param {object} clusterService
 * @param {object} db
 * @param {string} title
 * @param {string} description
 * @returns {Promise<string[]>}
 */
async function _handleUncategorized(clusterService, db, title, description) {
  const all = await clusterService.list();
  const uncategorized = all.find(c => c.label === 'Uncategorized');
  if (uncategorized) {
    await clusterService.incrementCounts([uncategorized.id]);
    return [uncategorized.id];
  }

  // Only create Uncategorized if we have at least some cluster volume
  // (avoids polluting small projects with an Uncategorized bucket on the first ticket)
  if (all.length > 0) {
    const newCluster = await clusterService.create({
      label: 'Uncategorized',
      keywords: [],
    });
    return [newCluster.id];
  }

  // No clusters yet and no keywords — skip assignment entirely
  return [];
}
