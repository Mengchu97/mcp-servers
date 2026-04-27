/**
 * Zotero integration module.
 *
 * Dual-strategy approach:
 * 1. Zotero Web API (primary) — full CRUD, needs ZOTERO_API_KEY + ZOTERO_USER_ID
 * 2. Local connector API (fallback) — add items only, no collection control
 *
 * Local Zotero API endpoints (port 23119):
 *   GET  /api/users/0/collections      — list collections (needs Zotero-Allowed-Request header)
 *   GET  /api/users/0/items/top        — list top-level items
 *   POST /connector/saveItems           — save items to current collection (201)
 */

import type { S2Paper } from "./semantic-scholar.js";

// --- Types ---

interface ZoteroCollection {
  key: string;
  version: number;
  data: {
    key: string;
    name: string;
    parentCollection: string | false;
    relations: Record<string, unknown>;
  };
  meta: {
    numCollections: number;
    numItems: number;
  };
}

interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

interface ZoteroItemTemplate {
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  abstractNote: string;
  publicationTitle?: string;
  date?: string;
  DOI?: string;
  url?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  collections?: string[];
  tags?: { tag: string }[];
  extra?: string;
}

interface ZoteroWriteResponse {
  successful: Record<string, { key: string; version: number }>;
  unchanged: Record<string, unknown>;
  failed: Record<string, { code: number; message: string }>;
}

// --- Config ---

const ZOTERO_API_BASE = "https://api.zotero.org";
const ZOTERO_LOCAL_PORT = parseInt(process.env.ZOTERO_LOCAL_PORT ?? "23119", 10);
const ZOTERO_LOCAL_BASE = `http://localhost:${ZOTERO_LOCAL_PORT}`;

function getZoteroUserId(): string {
  const id = process.env.ZOTERO_USER_ID;
  if (!id) {
    throw new Error(
      "ZOTERO_USER_ID environment variable is required. " +
        "Find your user ID at: https://www.zotero.org/settings/keys",
    );
  }
  return id;
}

function getZoteroApiKey(): string | null {
  return process.env.ZOTERO_API_KEY ?? null;
}

function hasWebApi(): boolean {
  return getZoteroApiKey() !== null;
}

// --- Local API helpers ---

async function localGet(path: string): Promise<unknown> {
  const url = `${ZOTERO_LOCAL_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Zotero-Allowed-Request": "true" },
  });
  if (!res.ok) {
    throw new Error(`Zotero local GET error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function localSaveItems(items: ZoteroItemTemplate[]): Promise<boolean> {
  const url = `${ZOTERO_LOCAL_BASE}/connector/saveItems`;
  const payload = {
    items: items.map((item) => ({
      ...item,
      uri: item.DOI ? `https://doi.org/${item.DOI}` : item.url ?? "",
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return res.status === 200 || res.status === 201;
}

// --- Web API helpers ---

async function webApiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const apiKey = getZoteroApiKey();
  if (!apiKey) throw new Error("ZOTERO_API_KEY not set");

  const userId = getZoteroUserId();
  const url = `${ZOTERO_API_BASE}/users/${userId}${path}`;

  const headers: Record<string, string> = {
    "Zotero-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  // Get current library version for write operations
  if (method !== "GET") {
    try {
      const versionRes = await fetch(`${ZOTERO_API_BASE}/users/${userId}/collections?limit=1`, {
        headers: { "Zotero-API-Key": apiKey },
      });
      const version = versionRes.headers.get("Last-Modified-Version");
      if (version) {
        headers["If-Unmodified-Since-Version"] = version;
      }
    } catch {
      // Version fetch failed, proceed without it
    }
  }

  const opts: RequestInit = {
    method,
    headers,
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  return res;
}

// --- Public API ---

/**
 * List all collections in the user's Zotero library.
 * Uses local API first, falls back to Web API.
 */
export async function listCollections(): Promise<ZoteroCollection[]> {
  // Try local API first (faster, no auth needed)
  try {
    const data = await localGet("/api/users/0/collections");
    return data as ZoteroCollection[];
  } catch {
    // Fall back to Web API
    if (!hasWebApi()) {
      throw new Error("Cannot list collections: local API unavailable and ZOTERO_API_KEY not set");
    }
    const res = await webApiRequest("GET", "/collections");
    if (!res.ok) throw new Error(`Zotero Web API error: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ZoteroCollection[]>;
  }
}

/**
 * Create a new collection in Zotero.
 * Requires ZOTERO_API_KEY (Web API) since the local API is read-only.
 */
export async function createCollection(
  name: string,
  parentCollectionKey?: string,
): Promise<{ key: string; name: string }> {
  if (!hasWebApi()) {
    throw new Error(
      "Creating collections requires the Zotero Web API. " +
        "Please set ZOTERO_API_KEY environment variable.\n" +
        "Get your API key at: https://www.zotero.org/settings/keys\n" +
        "Required permissions: Allow library access + Allow write access",
    );
  }

  const payload: Record<string, unknown>[] = [{ name }];
  if (parentCollectionKey) {
    payload[0]["parentCollection"] = parentCollectionKey;
  }

  const res = await webApiRequest("POST", "/collections", payload);
  const data = (await res.json()) as ZoteroWriteResponse;

  if (Object.keys(data.failed).length > 0) {
    const errors = Object.values(data.failed).map((e) => e.message).join(", ");
    throw new Error(`Failed to create collection: ${errors}`);
  }

  const created = data.successful["0"];
  if (!created) {
    throw new Error("Collection creation returned no result");
  }

  return { key: created.key, name };
}

/**
 * Find or create a collection by name.
 * Returns the collection key.
 */
export async function ensureCollection(name: string): Promise<string> {
  // First, check if it already exists via local API
  try {
    const collections = await listCollections();
    const existing = collections.find((c) => c.data.name === name);
    if (existing) {
      return existing.data.key;
    }
  } catch {
    // Continue to create
  }

  // Create via Web API
  const result = await createCollection(name);
  return result.key;
}

/**
 * Convert an S2 paper to a Zotero item template.
 */
function s2ToZoteroItem(paper: S2Paper, collectionKeys?: string[]): ZoteroItemTemplate {
  const authors = paper.authors.map((a) => {
    const parts = a.name.trim().split(/\s+/);
    if (parts.length === 1) {
      return { creatorType: "author" as const, name: a.name };
    }
    return {
      creatorType: "author" as const,
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts[parts.length - 1],
    };
  });

  const item: ZoteroItemTemplate = {
    itemType: "journalArticle",
    title: paper.title ?? "Untitled",
    creators: authors,
    abstractNote: paper.abstract ?? "",
    date: paper.publicationDate ?? (paper.year ? String(paper.year) : ""),
    DOI: paper.externalIds?.DOI ?? undefined,
    url: paper.openAccessPdf?.url ?? (paper.externalIds?.ArXiv ? `https://arxiv.org/abs/${paper.externalIds.ArXiv}` : paper.url ?? undefined),
    extra: [
      paper.paperId ? `S2ID: ${paper.paperId}` : "",
      paper.citationCount !== null ? `Citations: ${paper.citationCount}` : "",
      paper.externalIds?.ArXiv ? `ArXiv: ${paper.externalIds.ArXiv}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  // Set publication title from venue or journal name
  if (paper.journal?.name) {
    item.publicationTitle = paper.journal.name;
  } else if (paper.venue) {
    item.publicationTitle = paper.venue;
  } else if (paper.externalIds?.ArXiv) {
    item.publicationTitle = "arXiv";
  }

  if (paper.journal?.volume) item.volume = paper.journal.volume;
  if (paper.journal?.pages) item.pages = paper.journal.pages;

  if (collectionKeys?.length) {
    item.collections = collectionKeys;
  }

  return item;
}

/**
 * Import papers into a Zotero collection.
 *
 * Strategy:
 * 1. If ZOTERO_API_KEY is set → use Web API (can target specific collections)
 * 2. Otherwise → use local connector saveItems (items go to currently selected collection)
 */
export async function importPapers(
  papers: S2Paper[],
  collectionName?: string,
): Promise<{
  imported: number;
  collectionKey?: string;
  collectionName?: string;
  method: string;
  errors: string[];
}> {
  const errors: string[] = [];
  let collectionKey: string | undefined;
  let method: string;

  // Resolve or create collection if name provided
  if (collectionName) {
    if (hasWebApi()) {
      try {
        collectionKey = await ensureCollection(collectionName);
        method = "web-api";
      } catch (err) {
        errors.push(`Collection creation failed: ${err instanceof Error ? err.message : String(err)}`);
        method = "local-connector";
      }
    } else {
      // Try to find existing collection locally
      try {
        const collections = await listCollections();
        const existing = collections.find((c) => c.data.name === collectionName);
        if (existing) {
          collectionKey = existing.data.key;
        }
      } catch {
        // Can't list collections
      }
      method = "local-connector";
    }
  } else {
    method = hasWebApi() ? "web-api" : "local-connector";
  }

  // Convert papers to Zotero items
  const items = papers.map((p) => s2ToZoteroItem(p, collectionKey ? [collectionKey] : undefined));

  if (method === "web-api" && hasWebApi()) {
    // Use Web API — batch up to 50 items per request
    const batchSize = 50;
    let imported = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      try {
        const res = await webApiRequest("POST", "/items", batch);
        const data = (await res.json()) as ZoteroWriteResponse;

        imported += Object.keys(data.successful).length;

        for (const [, fail] of Object.entries(data.failed)) {
          errors.push(`Item failed: ${fail.message}`);
        }
      } catch (err) {
        errors.push(`Batch ${i / batchSize + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      imported,
      collectionKey,
      collectionName,
      method: "web-api",
      errors,
    };
  }

  // Fallback: local connector saveItems
  let imported = 0;
  // connector/saveItems accepts one item at a time in practice
  for (const item of items) {
    try {
      const ok = await localSaveItems([item]);
      if (ok) imported++;
      else errors.push(`Failed to save: "${item.title}"`);
    } catch (err) {
      errors.push(`Error saving "${item.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    imported,
    collectionName,
    method: "local-connector",
    errors,
  };
}

/**
 * Delete items from Zotero by key (for cleanup).
 */
export async function deleteItem(itemKey: string): Promise<boolean> {
  if (!hasWebApi()) return false;
  try {
    const res = await webApiRequest("DELETE", `/items/${itemKey}`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Search items in local Zotero via BBT JSON-RPC.
 */
export async function searchLocalItems(query: string): Promise<unknown[]> {
  const url = `${ZOTERO_LOCAL_BASE}/better-bibtex/json-rpc`;
  const payload = {
    jsonrpc: "2.0",
    method: "item.search",
    params: [query],
    id: Date.now(),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as { result: unknown[] };
  return data.result ?? [];
}
