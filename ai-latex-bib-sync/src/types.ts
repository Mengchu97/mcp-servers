/**
 * Shared types for the LaTeX-BibTeX-Zotero sync MCP server.
 */

// --- BibTeX Entry Types ---

export interface BibEntry {
  /** Citation key (e.g., "Avolio2010Arterial") */
  key: string;
  /** Entry type (e.g., "article", "inproceedings", "book") */
  type: string;
  /** All fields as key-value pairs. Values are raw BibTeX strings. */
  fields: Record<string, string>;
  /** DOI if present (extracted from fields.doi) */
  doi?: string;
  /** Parsed first author last name (for citation key generation) */
  firstAuthorLastName?: string;
  /** Year */
  year?: string;
  /** Title (raw, with LaTeX commands preserved) */
  title?: string;
}

export interface BibFile {
  /** Absolute path to the .bib file */
  path: string;
  /** Parsed entries */
  entries: BibEntry[];
  /** @string macro definitions (e.g., { AOS: "Ann. Statist." }) */
  strings: Record<string, string>;
  /** @preamble content */
  preamble: string[];
  /** @comment content */
  comments: string[];
  /** Parse errors */
  errors: string[];
}

// --- Zotero Item Types ---

export interface ZoteroItem {
  key: string;
  version: number;
  data: {
    key: string;
    itemType: string;
    title: string;
    creators: ZoteroCreator[];
    date?: string;
    DOI?: string;
    url?: string;
    abstractNote?: string;
    publicationTitle?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    extra?: string;
    collections?: string[];
    tags?: { tag: string }[];
  };
  meta?: {
    numItems?: number;
  };
}

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroCollection {
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

// --- Sync Result Types ---

export interface MatchResult {
  /** Matched by DOI (exact) */
  byDoi: Array<{ bib: BibEntry; zotero: ZoteroItem }>;
  /** Matched by title (fuzzy) */
  byTitle: Array<{ bib: BibEntry; zotero: ZoteroItem; similarity: number }>;
  /** In .bib but NOT in Zotero */
  onlyInBib: BibEntry[];
  /** In Zotero but NOT in .bib */
  onlyInZotero: ZoteroItem[];
}

export interface SyncResult {
  /** Number of entries synced */
  synced: number;
  /** Number of new entries created */
  created: number;
  /** Number of entries updated */
  updated: number;
  /** Number of entries skipped (unchanged) */
  skipped: number;
  /** Errors encountered */
  errors: string[];
  /** Details of what was done */
  details: string[];
}

export interface CiteKeyCheckResult {
  /** Citation keys used in .tex that exist in .bib */
  valid: string[];
  /** Citation keys used in .tex but MISSING from .bib */
  missing: string[];
  /** Citation keys defined in .bib but not used in any .tex */
  unused: string[];
  /** .tex files scanned */
  filesScanned: string[];
}
