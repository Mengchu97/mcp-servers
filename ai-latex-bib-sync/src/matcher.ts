/**
 * Match BibTeX entries to Zotero items by DOI and title similarity.
 *
 * Three-phase algorithm:
 * 1. DOI exact match (case-insensitive, stripped prefixes)
 * 2. Title fuzzy match (Jaccard word-set similarity >= 0.85)
 * 3. Categorize results
 */

import type { BibEntry, MatchResult, ZoteroItem } from "./types.js";

/**
 * Normalize a DOI string: lowercase, strip "https://doi.org/" prefix.
 */
export function normalizeDoi(doi: string): string {
  let normalized = doi.trim().toLowerCase();
  // Strip common URL prefixes
  const prefixes = [
    "https://doi.org/",
    "http://doi.org/",
    "https://dx.doi.org/",
    "http://dx.doi.org/",
  ];
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  return normalized;
}

/**
 * Normalize a title for comparison: strip LaTeX commands, lowercase, remove punctuation.
 */
export function normalizeTitle(title: string): string {
  let normalized = title;

  // Strip LaTeX commands like {\...} or \...
  normalized = normalized.replace(/\{\\[^}]*\}/g, " ");
  normalized = normalized.replace(/\\[a-zA-Z]+\{[^}]*\}/g, " ");
  normalized = normalized.replace(/\\[a-zA-Z]+/g, " ");
  // Remove remaining braces
  normalized = normalized.replace(/[{}]/g, "");

  // Lowercase
  normalized = normalized.toLowerCase();

  // Remove punctuation (keep spaces and alphanumeric)
  normalized = normalized.replace(/[^a-z0-9\s]/g, " ");

  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Compute Jaccard word-set similarity between two normalized titles.
 * similarity = |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(titleA: string, titleB: string): number {
  const wordsA = new Set(titleA.split(/\s+/).filter((w) => w.length > 0));
  const wordsB = new Set(titleB.split(/\s+/).filter((w) => w.length > 0));

  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union;
}

/**
 * Check if the shorter normalized title is a substring of the longer one.
 */
function isSubstringMatch(normA: string, normB: string): boolean {
  if (normA.length === 0 || normB.length === 0) return false;
  if (normA.length <= normB.length) {
    return normB.includes(normA);
  }
  return normA.includes(normB);
}

/**
 * Compute edit distance between two strings (Levenshtein).
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

/**
 * Match BibTeX entries to Zotero items using a three-phase algorithm.
 *
 * Phase 1: DOI exact match (case-insensitive, prefix-stripped)
 * Phase 2: Title fuzzy match (Jaccard similarity >= 0.85, or edit distance <= 3, or substring)
 * Phase 3: Categorize into matched and unmatched
 */
export function matchEntries(
  bibEntries: BibEntry[],
  zoteroItems: ZoteroItem[],
): MatchResult {
  const byDoi: Array<{ bib: BibEntry; zotero: ZoteroItem }> = [];
  const byTitle: Array<{
    bib: BibEntry;
    zotero: ZoteroItem;
    similarity: number;
  }> = [];
  const onlyInBib: BibEntry[] = [];
  const onlyInZotero: ZoteroItem[] = [];

  // Track which items have been matched
  const matchedBibKeys = new Set<string>();
  const matchedZoteroKeys = new Set<string>();

  // --- Phase 1: DOI exact match ---
  const doiToBib = new Map<string, BibEntry>();
  for (const entry of bibEntries) {
    const doi = entry.doi ?? entry.fields.doi;
    if (doi) {
      doiToBib.set(normalizeDoi(doi), entry);
    }
  }

  const doiToZotero = new Map<string, ZoteroItem>();
  for (const item of zoteroItems) {
    const doi = item.data.DOI;
    if (doi) {
      doiToZotero.set(normalizeDoi(doi), item);
    }
  }

  for (const [doi, bib] of doiToBib) {
    const zotero = doiToZotero.get(doi);
    if (zotero) {
      byDoi.push({ bib, zotero });
      matchedBibKeys.add(bib.key);
      matchedZoteroKeys.add(zotero.key);
    }
  }

  // --- Phase 2: Title fuzzy match ---
  const unmatchedBib = bibEntries.filter((e) => !matchedBibKeys.has(e.key));
  const unmatchedZotero = zoteroItems.filter(
    (i) => !matchedZoteroKeys.has(i.key),
  );

  // Pre-normalize Zotero titles
  const zoteroNormTitles = unmatchedZotero.map((item) => ({
    item,
    normTitle: normalizeTitle(item.data.title ?? ""),
  }));

  const SIMILARITY_THRESHOLD = 0.85;
  const EDIT_DISTANCE_LIMIT = 3;

  for (const bib of unmatchedBib) {
    const bibNormTitle = normalizeTitle(bib.title ?? bib.fields.title ?? "");
    if (!bibNormTitle) continue;

    let bestMatch: { item: ZoteroItem; similarity: number } | null = null;

    for (const { item, normTitle } of zoteroNormTitles) {
      if (matchedZoteroKeys.has(item.key)) continue;
      if (!normTitle) continue;

      // Check Jaccard similarity
      const similarity = jaccardSimilarity(bibNormTitle, normTitle);
      const shorterLen = Math.min(bibNormTitle.length, normTitle.length);
      const ed = editDistance(bibNormTitle, normTitle);

      if (
        similarity >= SIMILARITY_THRESHOLD ||
        ed <= EDIT_DISTANCE_LIMIT ||
        isSubstringMatch(bibNormTitle, normTitle)
      ) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { item, similarity };
        }
      }
    }

    if (bestMatch) {
      byTitle.push({
        bib,
        zotero: bestMatch.item,
        similarity: bestMatch.similarity,
      });
      matchedBibKeys.add(bib.key);
      matchedZoteroKeys.add(bestMatch.item.key);
    }
  }

  // --- Phase 3: Categorize ---
  for (const entry of bibEntries) {
    if (!matchedBibKeys.has(entry.key)) {
      onlyInBib.push(entry);
    }
  }

  for (const item of zoteroItems) {
    if (!matchedZoteroKeys.has(item.key)) {
      onlyInZotero.push(item);
    }
  }

  return { byDoi, byTitle, onlyInBib, onlyInZotero };
}
