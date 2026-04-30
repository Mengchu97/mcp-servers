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
  skipDuplicates?: boolean,
): Promise<{
  imported: number;
  duplicatesSkipped: number;
  duplicateTitles: string[];
  collectionKey?: string;
  collectionName?: string;
  method: string;
  errors: string[];
}> {
  const errors: string[] = [];
  let collectionKey: string | undefined;
  let method: string;
  let duplicatesSkipped = 0;
  let duplicateTitles: string[] = [];
  let papersToImport = papers;

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

  // Duplicate detection: check existing DOIs in the target collection
  if (skipDuplicates && collectionKey) {
    try {
      const existingDois = await getCollectionDois(collectionKey);
      const filtered: S2Paper[] = [];
      for (const paper of papersToImport) {
        const doi = paper.externalIds?.DOI?.toLowerCase();
        if (doi && existingDois.has(doi)) {
          duplicatesSkipped++;
          duplicateTitles.push(paper.title);
        } else {
          filtered.push(paper);
        }
      }
      papersToImport = filtered;
    } catch {
      // Duplicate check failed, proceed with all papers
    }
  }

  if (papersToImport.length === 0) {
    return {
      imported: 0,
      duplicatesSkipped,
      duplicateTitles,
      collectionKey,
      collectionName,
      method,
      errors,
    };
  }

  // Convert papers to Zotero items
  const items = papersToImport.map((p) => s2ToZoteroItem(p, collectionKey ? [collectionKey] : undefined));

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
      duplicatesSkipped,
      duplicateTitles,
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
    duplicatesSkipped,
    duplicateTitles,
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

// --- NEW API ENDPOINTS FOR MCP ---

/**
 * Get items from a specific collection (paginated).
 */
export async function getCollectionItems(collectionKey: string, start: number = 0, limit: number = 50): Promise<any[]> {
  if (!hasWebApi()) {
    throw new Error("getCollectionItems requires ZOTERO_API_KEY");
  }
  const res = await webApiRequest("GET", `/collections/${collectionKey}/items?start=${start}&limit=${limit}`);
  if (!res.ok) throw new Error(`Zotero Web API error: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Get a specific item by key.
 */
export async function getItem(itemKey: string): Promise<any> {
  if (!hasWebApi()) {
    throw new Error("getItem requires ZOTERO_API_KEY");
  }
  const res = await webApiRequest("GET", `/items/${itemKey}`);
  if (!res.ok) throw new Error(`Zotero Web API error: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Update an item.
 */
export async function updateItem(itemKey: string, data: any, currentVersion: number): Promise<any> {
  if (!hasWebApi()) {
    throw new Error("updateItem requires ZOTERO_API_KEY");
  }
  
  const apiKey = getZoteroApiKey()!;
  const userId = getZoteroUserId();
  const url = `${ZOTERO_API_BASE}/users/${userId}/items/${itemKey}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Zotero-API-Key": apiKey,
      "Content-Type": "application/json",
      "If-Unmodified-Since-Version": currentVersion.toString()
    },
    body: JSON.stringify(data)
  });
  
  if (!res.ok) {
    throw new Error(`Zotero Web API error: ${res.status} ${await res.text()}`);
  }
  
  // Return nothing on success (204 No Content usually)
  return res.status === 204 ? { success: true } : res.json().catch(() => ({ success: true }));
}

/**
 * Get ALL items from a collection (auto-paginates).
 * Filters out attachments and notes, returns only real items.
 */
export async function getAllCollectionItems(collectionKey: string): Promise<any[]> {
  if (!hasWebApi()) {
    throw new Error("getAllCollectionItems requires ZOTERO_API_KEY");
  }
  
  const allItems: any[] = [];
  let start = 0;
  const limit = 100;
  
  while (true) {
    const res = await webApiRequest("GET", `/collections/${collectionKey}/items?start=${start}&limit=${limit}`);
    if (!res.ok) throw new Error(`Zotero Web API error: ${res.status} ${await res.text()}`);
    const items = await res.json();
    if (!items || items.length === 0) break;
    allItems.push(...items);
    if (items.length < limit) break;
    start += limit;
  }
  
  // Filter to real items only (not attachments/notes)
  return allItems.filter(item =>
    item.data?.itemType &&
    item.data.itemType !== "attachment" &&
    item.data.itemType !== "note"
  );
}

/**
 * Remove items from a specific collection (without deleting them from the library).
 * Patches each item to remove the collectionKey from its `collections` array.
 */
export async function removeItemsFromCollection(
  itemKeys: string[],
  collectionKey: string,
): Promise<{ removed: string[]; failed: Array<{ key: string; error: string }> }> {
  if (!hasWebApi()) {
    throw new Error("removeItemsFromCollection requires ZOTERO_API_KEY");
  }

  const removed: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const key of itemKeys) {
    try {
      const item = await getItem(key);
      const collections: string[] = item.data?.collections ?? [];
      const updatedCollections = collections.filter((c: string) => c !== collectionKey);

      if (updatedCollections.length === collections.length) {
        // Item was not in this collection
        failed.push({ key, error: "Item not in this collection" });
        continue;
      }

      await updateItem(key, { collections: updatedCollections }, item.version);
      removed.push(key);
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { removed, failed };
}

/**
 * Add existing library items to a collection.
 * Patches each item to add the collectionKey to its `collections` array.
 */
export async function addItemsToCollection(
  itemKeys: string[],
  collectionKey: string,
): Promise<{ added: string[]; already: string[]; failed: Array<{ key: string; error: string }> }> {
  if (!hasWebApi()) {
    throw new Error("addItemsToCollection requires ZOTERO_API_KEY");
  }

  const added: string[] = [];
  const already: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const key of itemKeys) {
    try {
      const item = await getItem(key);
      const collections: string[] = item.data?.collections ?? [];

      if (collections.includes(collectionKey)) {
        already.push(key);
        continue;
      }

      collections.push(collectionKey);
      await updateItem(key, { collections }, item.version);
      added.push(key);
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { added, already, failed };
}

/**
 * Search within a specific collection by matching query against title, DOI, and authors.
 * Returns matching items with key metadata.
 */
export async function searchCollection(
  collectionKey: string,
  query: string,
): Promise<Array<{
  key: string;
  title: string;
  creators: string;
  DOI: string;
  date: string;
  itemType: string;
}>> {
  const items = await getAllCollectionItems(collectionKey);
  const q = query.toLowerCase();

  const results: Array<{
    key: string;
    title: string;
    creators: string;
    DOI: string;
    date: string;
    itemType: string;
  }> = [];

  for (const item of items) {
    const d = item.data;
    if (!d) continue;

    const title = (d.title ?? "").toLowerCase();
    const doi = (d.DOI ?? "").toLowerCase();
    const creators = Array.isArray(d.creators)
      ? d.creators.map((c: any) => `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()).join(" ").toLowerCase()
      : "";
    const extra = (d.extra ?? "").toLowerCase();

    if (
      title.includes(q) ||
      doi.includes(q) ||
      creators.includes(q) ||
      extra.includes(q)
    ) {
      results.push({
        key: d.key,
        title: d.title ?? "",
        creators: Array.isArray(d.creators)
          ? d.creators.map((c: any) => `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()).join(", ")
          : "",
        DOI: d.DOI ?? "",
        date: d.date ?? "",
        itemType: d.itemType ?? "",
      });
    }
  }

  return results;
}

/**
 * Get existing DOIs in a collection for duplicate detection.
 */
export async function getCollectionDois(collectionKey: string): Promise<Set<string>> {
  const items = await getAllCollectionItems(collectionKey);
  const dois = new Set<string>();
  for (const item of items) {
    const doi = item.data?.DOI;
    if (doi && typeof doi === "string") {
      dois.add(doi.toLowerCase());
    }
  }
  return dois;
}

/**
 * Get collection stats (item count, collection name).
 */
export async function getCollectionStats(collectionKey: string): Promise<{
  key: string;
  name: string;
  itemCount: number;
}> {
  const collections = await listCollections();
  const col = collections.find(c => c.data.key === collectionKey);
  if (!col) {
    throw new Error(`Collection ${collectionKey} not found`);
  }
  return {
    key: col.data.key,
    name: col.data.name,
    itemCount: col.meta.numItems,
  };
}
