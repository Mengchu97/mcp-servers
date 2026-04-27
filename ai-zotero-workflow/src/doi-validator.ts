/**
 * DOI dual-validation module.
 *
 * Two-stage gate before any paper enters Zotero:
 *   Gate 1 — Field completeness: DOI must be a non-empty string.
 *   Gate 2 — Network verification: DOI must resolve via doi.org Handle API.
 *
 * A paper is only allowed through if it passes BOTH gates.
 * LLM-generated or guessed DOIs are never accepted.
 */

import type { S2Paper } from "./semantic-scholar.js";

// --- Types ---

export type RejectReason =
  | "missing_doi"
  | "empty_doi"
  | "malformed_doi"
  | "doi_not_found"
  | "doi_network_error"
  | "doi_timeout";

export interface ValidatedPaper {
  paper: S2Paper;
  doi: string;
}

export interface RejectedPaper {
  paper: S2Paper;
  reason: RejectReason;
  detail: string;
}

export interface ValidationResult {
  accepted: ValidatedPaper[];
  rejected: RejectedPaper[];
}

// --- Gate 1: Field completeness ---

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s]+$/;

/**
 * Gate 1: Check that a paper has a real, non-empty DOI field from the API.
 * Returns the DOI string if valid, or a RejectReason if not.
 */
function checkFieldCompleteness(paper: S2Paper): { doi: string } | { reject: RejectReason; detail: string } {
  const ids = paper.externalIds;

  if (!ids) {
    return { reject: "missing_doi", detail: "externalIds object is null" };
  }

  if (ids.DOI === null || ids.DOI === undefined) {
    return { reject: "missing_doi", detail: `No DOI in externalIds for "${paper.title}"` };
  }

  const doi = ids.DOI.trim();
  if (doi.length === 0) {
    return { reject: "empty_doi", detail: `DOI field is empty for "${paper.title}"` };
  }

  // Basic structural sanity: DOIs start with "10." followed by a prefix/suffix
  if (!DOI_PATTERN.test(doi)) {
    return { reject: "malformed_doi", detail: `DOI "${doi}" does not match expected pattern for "${paper.title}"` };
  }

  return { doi };
}

// --- Gate 2: Network verification ---

const DOI_HANDLE_API = "https://doi.org/api/handles/";
const VERIFY_TIMEOUT_MS = 5000;
const MAX_CONCURRENT = 5;

interface HandleApiResponse {
  responseCode: number; // 1 = success, 100 = not found, 2 = error
  handle: string;
  values?: Array<{ type: string; data: { value: unknown } }>;
}

/**
 * Gate 2: Verify a DOI actually resolves via the Handle System API.
 * GET https://doi.org/api/handles/{doi}
 *
 * Returns true if the DOI exists (responseCode 1).
 * Returns false if not found (404 or responseCode 100) or on network error.
 */
async function verifyDoiExists(doi: string): Promise<{ valid: boolean; detail: string }> {
  const url = `${DOI_HANDLE_API}${encodeURIComponent(doi)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status === 404) {
      return { valid: false, detail: `DOI "${doi}" returned 404 — handle does not exist` };
    }

    if (!res.ok) {
      return { valid: false, detail: `DOI "${doi}" returned HTTP ${res.status}` };
    }

    const body = (await res.json()) as HandleApiResponse;

    // responseCode: 1 = success (handle exists), 100 = not found, 200 = stale, 2 = error
    if (body.responseCode === 1) {
      return { valid: true, detail: `DOI "${doi}" verified via Handle API` };
    }

    if (body.responseCode === 100) {
      return { valid: false, detail: `DOI "${doi}" not found in Handle System (responseCode 100)` };
    }

    return { valid: false, detail: `DOI "${doi}" unexpected responseCode ${body.responseCode}` };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { valid: false, detail: `DOI "${doi}" verification timed out after ${VERIFY_TIMEOUT_MS}ms` };
    }
    return { valid: false, detail: `DOI "${doi}" network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Parallel gate 2 with concurrency limit ---

async function verifyDoisInBatches(
  papers: Array<{ paper: S2Paper; doi: string }>,
): Promise<Array<{ paper: S2Paper; doi: string; verified: boolean; detail: string }>> {
  const results: Array<{ paper: S2Paper; doi: string; verified: boolean; detail: string }> = [];

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < papers.length; i += MAX_CONCURRENT) {
    const batch = papers.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const verifyResult = await verifyDoiExists(entry.doi);
        return {
          paper: entry.paper,
          doi: entry.doi,
          verified: verifyResult.valid,
          detail: verifyResult.detail,
        };
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

// --- Public API ---

/**
 * Dual-validate an array of S2 papers.
 *
 * Papers are first checked for DOI field completeness (Gate 1),
 * then verified against doi.org Handle API (Gate 2).
 * Only papers passing both gates are returned as accepted.
 */
export async function validatePapers(papers: S2Paper[]): Promise<ValidationResult> {
  const accepted: ValidatedPaper[] = [];
  const rejected: RejectedPaper[] = [];

  // --- Gate 1: Field completeness (synchronous) ---
  const gate1Passed: Array<{ paper: S2Paper; doi: string }> = [];

  for (const paper of papers) {
    const result = checkFieldCompleteness(paper);
    if ("doi" in result) {
      gate1Passed.push({ paper, doi: result.doi });
    } else {
      rejected.push({ paper, reason: result.reject, detail: result.detail });
    }
  }

  // --- Gate 2: Network verification (async, batched) ---
  if (gate1Passed.length > 0) {
    const verified = await verifyDoisInBatches(gate1Passed);

    for (const entry of verified) {
      if (entry.verified) {
        accepted.push({ paper: entry.paper, doi: entry.doi });
      } else {
        rejected.push({ paper: entry.paper, reason: "doi_not_found", detail: entry.detail });
      }
    }
  }

  return { accepted, rejected };
}

/**
 * Quick synchronous check — only Gate 1.
 * Useful for filtering before display, without network calls.
 */
export function filterPapersWithDoi(papers: S2Paper[]): {
  withDoi: Array<{ paper: S2Paper; doi: string }>;
  withoutDoi: RejectedPaper[];
} {
  const withDoi: Array<{ paper: S2Paper; doi: string }> = [];
  const withoutDoi: RejectedPaper[] = [];

  for (const paper of papers) {
    const result = checkFieldCompleteness(paper);
    if ("doi" in result) {
      withDoi.push({ paper, doi: result.doi });
    } else {
      withoutDoi.push({ paper, reason: result.reject, detail: result.detail });
    }
  }

  return { withDoi, withoutDoi };
}
