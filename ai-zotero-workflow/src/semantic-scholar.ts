/**
 * Semantic Scholar API client for academic paper search.
 *
 * Uses the public S2 Graph API. No API key required for basic usage,
 * but rate-limited to ~1 RPS shared globally (unauthenticated).
 *
 * API docs: https://api.semanticscholar.org/api-docs/
 */

const S2_BASE = "https://api.semanticscholar.org/graph/v1";

export interface S2Paper {
  paperId: string;
  title: string;
  abstract: string | null;
  year: number | null;
  venue: string | null;
  publicationDate: string | null;
  citationCount: number | null;
  authors: { authorId: string | null; name: string }[];
  externalIds: {
    DOI: string | null;
    ArXiv: string | null;
    PubMed: string | null;
    [key: string]: string | null;
  } | null;
  openAccessPdf: { url: string; status: string } | null;
  url: string;
  journal: { name: string | null; volume: string | null; pages: string | null } | null;
}

export interface S2SearchResult {
  total: number;
  offset: number;
  data: S2Paper[];
}

export interface SearchPapersOptions {
  query: string;
  limit?: number;
  offset?: number;
  yearFrom?: number;
  yearTo?: number;
  fieldsOfStudy?: string[];
  publicationTypes?: string[];
  sortByCitations?: boolean;
}

const REQUIRED_FIELDS = [
  "paperId",
  "externalIds",
  "url",
  "title",
  "abstract",
  "venue",
  "year",
  "publicationDate",
  "citationCount",
  "authors",
  "openAccessPdf",
  "journal",
] as const;

function buildSearchUrl(opts: SearchPapersOptions): URL {
  const url = new URL(`${S2_BASE}/paper/search`);
  url.searchParams.set("query", opts.query);
  url.searchParams.set("fields", REQUIRED_FIELDS.join(","));
  url.searchParams.set("limit", String(opts.limit ?? 10));
  if (opts.offset) url.searchParams.set("offset", String(opts.offset));

  if (opts.yearFrom || opts.yearTo) {
    const from = opts.yearFrom ?? "";
    const to = opts.yearTo ?? "";
    url.searchParams.set("year", `${from}-${to}`);
  }

  if (opts.fieldsOfStudy?.length) {
    url.searchParams.set("fieldsOfStudy", opts.fieldsOfStudy.join(","));
  }

  if (opts.publicationTypes?.length) {
    url.searchParams.set("publicationTypes", opts.publicationTypes.join(","));
  }

  return url;
}

export async function searchPapers(opts: SearchPapersOptions): Promise<S2SearchResult> {
  const url = buildSearchUrl(opts);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  // If user has an S2 API key, use it for higher rate limits
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  const res = await fetch(url.toString(), { headers });

  if (res.status === 429) {
    // Rate limited - wait and retry once
    const retryAfter = res.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    await new Promise((r) => setTimeout(r, waitMs));
    const retry = await fetch(url.toString(), { headers });
    if (!retry.ok) {
      throw new Error(`Semantic Scholar API error after retry: ${retry.status} ${await retry.text()}`);
    }
    return retry.json() as Promise<S2SearchResult>;
  }

  if (!res.ok) {
    throw new Error(`Semantic Scholar API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as S2SearchResult;

  // Optionally sort by citation count (S2 relevance sort is default)
  if (opts.sortByCitations && data.data) {
    data.data.sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
  }

  return data;
}

export async function getPaperById(
  paperId: string,
): Promise<S2Paper> {
  // paperId can be S2 ID, DOI:<doi>, ArXiv:<id>, etc.
  const url = new URL(`${S2_BASE}/paper/${encodeURIComponent(paperId)}`);
  url.searchParams.set("fields", REQUIRED_FIELDS.join(","));

  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`Semantic Scholar API error: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<S2Paper>;
}

/** Format an S2 paper into a human-readable summary. */
export function formatPaper(paper: S2Paper): string {
  const authors = paper.authors.map((a) => a.name).join(", ");
  const doi = paper.externalIds?.DOI ?? "N/A";
  const year = paper.year ?? "N/A";
  const venue = paper.venue ?? paper.journal?.name ?? "N/A";
  const citations = paper.citationCount ?? 0;
  const pdfUrl = paper.openAccessPdf?.url ?? "";
  const abstract = paper.abstract
    ? paper.abstract.length > 300
      ? paper.abstract.slice(0, 300) + "..."
      : paper.abstract
    : "No abstract available";

  return [
    `Title: ${paper.title}`,
    `Authors: ${authors}`,
    `Year: ${year} | Venue: ${venue} | Citations: ${citations}`,
    `DOI: ${doi}`,
    `S2 URL: ${paper.url}`,
    ...(pdfUrl ? [`PDF: ${pdfUrl}`] : []),
    `Abstract: ${abstract}`,
    `---`,
  ].join("\n");
}
