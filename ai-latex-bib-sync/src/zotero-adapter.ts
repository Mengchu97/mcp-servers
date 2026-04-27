/**
 * Zotero Web API client for reading/writing items and collections.
 *
 * Dual-strategy approach:
 * 1. Zotero Web API (primary) — full CRUD, needs ZOTERO_API_KEY + ZOTERO_USER_ID
 * 2. Local connector API (fallback) — read-only for listing, limited write
 */

import type {
  BibEntry,
  ZoteroCollection,
  ZoteroCreator,
  ZoteroItem,
} from "./types.js";
import { generateCiteKey } from "./cite-key.js";

// --- Local Types ---

export interface ZoteroItemData {
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  abstractNote?: string;
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
const ZOTERO_LOCAL_PORT = parseInt(
  process.env.ZOTERO_LOCAL_PORT ?? "23119",
  10,
);
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

// --- Local API Helpers ---

async function localGet(path: string): Promise<unknown> {
  const url = `${ZOTERO_LOCAL_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Zotero-Allowed-Request": "true" },
  });
  if (!res.ok) {
    throw new Error(
      `Zotero local GET error: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

// --- Web API Helpers ---

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
      const versionRes = await fetch(
        `${ZOTERO_API_BASE}/users/${userId}/collections?limit=1`,
        { headers: { "Zotero-API-Key": apiKey } },
      );
      const version = versionRes.headers.get("Last-Modified-Version");
      if (version) {
        headers["If-Unmodified-Since-Version"] = version;
      }
    } catch {
      // Version fetch failed, proceed without it
    }
  }

  const opts: RequestInit = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  return fetch(url, opts);
}

// --- Collection Operations ---

/**
 * List all collections in the user's Zotero library.
 * Uses local API first, falls back to Web API.
 */
export async function listCollections(): Promise<ZoteroCollection[]> {
  try {
    const data = await localGet("/api/users/0/collections");
    return data as ZoteroCollection[];
  } catch {
    if (!hasWebApi()) {
      throw new Error(
        "Cannot list collections: local API unavailable and ZOTERO_API_KEY not set",
      );
    }
    // Paginate — Zotero returns max 100 items per request
    const allCollections: ZoteroCollection[] = [];
    let start = 0;
    const limit = 100;
    while (true) {
      const res = await webApiRequest("GET", `/collections?limit=${limit}&start=${start}`);
      if (!res.ok) {
        throw new Error(
          `Zotero Web API error: ${res.status} ${await res.text()}`,
        );
      }
      const batch = await res.json() as ZoteroCollection[];
      allCollections.push(...batch);
      if (batch.length < limit) break;
      start += limit;
    }
    return allCollections;
  }
}

/**
 * Create a new collection in Zotero.
 * Requires ZOTERO_API_KEY (Web API).
 */
export async function createCollection(
  name: string,
  parentKey?: string,
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
  if (parentKey) {
    payload[0]["parentCollection"] = parentKey;
  }

  const res = await webApiRequest("POST", "/collections", payload);
  const data = (await res.json()) as ZoteroWriteResponse;

  if (Object.keys(data.failed).length > 0) {
    const errors = Object.values(data.failed)
      .map((e) => e.message)
      .join(", ");
    throw new Error(`Failed to create collection: ${errors}`);
  }

  const created = data.successful["0"];
  if (!created) {
    throw new Error("Collection creation returned no result");
  }

  return { key: created.key, name };
}

/**
 * Find or create a collection by name. Returns the collection key.
 */
export async function ensureCollection(name: string): Promise<string> {
  const collections = await listCollections();
  const existing = collections.find((c) => c.data.name === name);
  if (existing) {
    return existing.data.key;
  }

  const result = await createCollection(name);
  return result.key;
}

// --- Item Operations ---

/**
 * List items in the user's Zotero library, optionally filtered by collection.
 */
export async function listItems(
  collectionKey?: string,
): Promise<ZoteroItem[]> {
  if (hasWebApi()) {
    // Paginate — Zotero returns max 100 items per request
    const allItems: ZoteroItem[] = [];
    let start = 0;
    const limit = 100;
    while (true) {
      const path = collectionKey
        ? `/collections/${collectionKey}/items/top?limit=${limit}&start=${start}`
        : `/items/top?limit=${limit}&start=${start}`;
      const res = await webApiRequest("GET", path);
      if (!res.ok) {
        throw new Error(
          `Zotero Web API error: ${res.status} ${await res.text()}`,
        );
      }
      const batch = await res.json() as ZoteroItem[];
      allItems.push(...batch);
      if (batch.length < limit) break;
      start += limit;
    }
    return allItems;
  }

  // Fallback: local API
  const localPath = collectionKey
    ? `/api/users/0/collections/${collectionKey}/items/top`
    : "/api/users/0/items/top";
  const data = await localGet(localPath);
  return data as ZoteroItem[];
}

/**
 * Get a single item by key.
 */
export async function getItem(itemKey: string): Promise<ZoteroItem> {
  if (hasWebApi()) {
    const res = await webApiRequest("GET", `/items/${itemKey}`);
    if (!res.ok) {
      throw new Error(
        `Zotero Web API error: ${res.status} ${await res.text()}`,
      );
    }
    return res.json() as Promise<ZoteroItem>;
  }

  const data = await localGet(`/api/users/0/items/${itemKey}`);
  return data as ZoteroItem;
}

/**
 * Create items in Zotero (max 50 per batch).
 * Returns count of created items and any errors.
 */
export async function createItems(
  items: ZoteroItemData[],
  collectionKeys?: string[],
): Promise<{ created: number; errors: string[] }> {
  const errors: string[] = [];
  let created = 0;

  if (!hasWebApi()) {
    throw new Error(
      "Creating items requires the Zotero Web API. " +
        "Please set ZOTERO_API_KEY environment variable.",
    );
  }

  const batchSize = 50;
  const itemObjects = items.map((item) => {
    const obj: Record<string, unknown> = { ...item };
    if (collectionKeys?.length) {
      obj.collections = [
        ...(item.collections ?? []),
        ...collectionKeys,
      ];
    }
    return obj;
  });

  for (let i = 0; i < itemObjects.length; i += batchSize) {
    const batch = itemObjects.slice(i, i + batchSize);
    try {
      const res = await webApiRequest("POST", "/items", batch);
      const data = (await res.json()) as ZoteroWriteResponse;

      created += Object.keys(data.successful).length;

      for (const [, fail] of Object.entries(data.failed)) {
        errors.push(`Item failed: ${fail.message}`);
      }
    } catch (err) {
      errors.push(
        `Batch ${Math.floor(i / batchSize) + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { created, errors };
}

/**
 * Update an existing item's data.
 */
export async function updateItem(
  itemKey: string,
  data: Partial<ZoteroItemData>,
): Promise<boolean> {
  if (!hasWebApi()) {
    throw new Error(
      "Updating items requires the Zotero Web API. " +
        "Please set ZOTERO_API_KEY environment variable.",
    );
  }

  const res = await webApiRequest("PATCH", `/items/${itemKey}`, data);
  return res.ok;
}

/**
 * Delete an item by key.
 */
export async function deleteItem(itemKey: string): Promise<boolean> {
  if (!hasWebApi()) {
    throw new Error(
      "Deleting items requires the Zotero Web API. " +
        "Please set ZOTERO_API_KEY environment variable.",
    );
  }

  try {
    const res = await webApiRequest("DELETE", `/items/${itemKey}`);
    return res.ok;
  } catch {
    return false;
  }
}

// --- Format Conversion ---

const BIBTEX_TYPE_MAP: Record<string, string> = {
  journalArticle: "article",
  conferencePaper: "inproceedings",
  book: "book",
  bookSection: "incollection",
  thesis: "phdthesis",
  preprint: "misc",
};

/**
 * Convert a ZoteroItem to a BibEntry.
 */
export function zoteroItemToBibEntry(item: ZoteroItem): BibEntry {
  const d = item.data;
  const bibtexType = BIBTEX_TYPE_MAP[d.itemType] ?? "misc";

  const authors = (d.creators ?? [])
    .filter((c) => c.creatorType === "author")
    .map((c) => {
      if (c.lastName && c.firstName) {
        return `${c.lastName}, ${c.firstName}`;
      }
      return c.name ?? c.lastName ?? "";
    })
    .join(" and ");

  const year = d.date ? extractYear(d.date) : undefined;

  const fields: Record<string, string> = {};
  if (authors) fields.author = authors;
  if (year) fields.year = year;
  if (d.DOI) fields.doi = d.DOI;
  if (d.url) fields.url = d.url;
  if (d.publicationTitle) fields.journal = d.publicationTitle;
  if (d.volume) fields.volume = d.volume;
  if (d.issue) fields.issue = d.issue;
  if (d.pages) fields.pages = d.pages;
  if (d.abstractNote) {
    fields.abstract =
      d.abstractNote.length > 300
        ? d.abstractNote.slice(0, 300)
        : d.abstractNote;
  }
  if (d.extra) fields.extra = d.extra;

  // Generate a citation key using the unified AuthorYearWord generator
  const firstAuthor = d.creators?.find((c) => c.creatorType === "author");
  const authorStr = d.creators
    ?.filter((c: ZoteroCreator) => c.creatorType === "author")
    .map((c: ZoteroCreator) => `${c.lastName}, ${c.firstName ?? ""}`)
    .join(" and ");
  const key = generateCiteKey({
    author: authorStr ?? "Unknown",
    year: year ?? "",
    title: d.title ?? "",
  });

  return {
    key,
    type: bibtexType,
    fields,
    doi: d.DOI,
    firstAuthorLastName: firstAuthor?.lastName ?? undefined,
    year,
    title: d.title,
  };
}

/**
 * Convert a BibEntry to ZoteroItemData for creating items.
 */
export function bibEntryToZoteroItemData(entry: BibEntry): ZoteroItemData {
  const itemType = bibtexTypeToZotero(entry.type, entry.fields);
  const creators = parseAuthors(entry.fields.author ?? "");

  const item: ZoteroItemData = {
    itemType,
    title: entry.fields.title ?? entry.title ?? "",
    creators,
  };

  if (entry.fields.abstract) item.abstractNote = entry.fields.abstract;
  if (entry.fields.journal) item.publicationTitle = entry.fields.journal;
  if (entry.fields.booktitle) item.publicationTitle = entry.fields.booktitle;
  if (entry.fields.year ?? entry.year) {
    item.date = entry.fields.year ?? entry.year;
  }
  if (entry.fields.doi ?? entry.doi) {
    item.DOI = entry.fields.doi ?? entry.doi;
  }
  if (entry.fields.url) item.url = entry.fields.url;
  if (entry.fields.volume) item.volume = entry.fields.volume;
  if (entry.fields.issue ?? entry.fields.number) {
    item.issue = entry.fields.issue ?? entry.fields.number;
  }
  if (entry.fields.pages) item.pages = entry.fields.pages;
  if (entry.fields.extra) item.extra = entry.fields.extra;

  // Handle thesis type
  if (itemType === "thesis") {
    if (entry.type === "mastersthesis") {
      item.extra = (item.extra ? item.extra + "\n" : "") + "Degree: Master";
    }
  }

  return item;
}

/**
 * Export all items in a Zotero collection as BibEntry objects.
 */
export async function exportCollectionToBibEntries(
  collectionKey: string,
): Promise<BibEntry[]> {
  const items = await listItems(collectionKey);
  return items.map((item) => zoteroItemToBibEntry(item));
}

// --- Internal Helpers ---

function extractYear(date: string): string | undefined {
  const match = date.match(/\b(\d{4})\b/);
  return match?.[1];
}

function bibtexTypeToZotero(
  bibtexType: string,
  fields: Record<string, string>,
): string {
  switch (bibtexType) {
    case "article":
      return "journalArticle";
    case "inproceedings":
      return "conferencePaper";
    case "book":
      return "book";
    case "incollection":
    case "inbook":
      return "bookSection";
    case "phdthesis":
    case "mastersthesis":
      return "thesis";
    case "misc":
    case "techreport":
    default:
      // If it has a journal field, treat as journal article
      if (fields.journal) return "journalArticle";
      return "preprint";
  }
}

function parseAuthors(authorStr: string): ZoteroCreator[] {
  if (!authorStr.trim()) return [];

  const parts = authorStr.split(/\s+and\s+/i);
  const creators: ZoteroCreator[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // "Last, First" format
    if (trimmed.includes(",")) {
      const commaIdx = trimmed.indexOf(",");
      const lastName = trimmed.slice(0, commaIdx).trim();
      const firstName = trimmed.slice(commaIdx + 1).trim();
      const creator: ZoteroCreator = {
        creatorType: "author",
        lastName,
      };
      if (firstName) creator.firstName = firstName;
      creators.push(creator);
      continue;
    }

    // "First Last" format
    const words = trimmed.split(/\s+/);
    if (words.length === 1) {
      creators.push({ creatorType: "author", name: words[0] });
    } else {
      creators.push({
        creatorType: "author",
        firstName: words.slice(0, -1).join(" "),
        lastName: words[words.length - 1],
      });
    }
  }

  return creators;
}
