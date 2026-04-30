
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

// Load env vars from ~/.bash_env.local (cross-platform, no bash dependency)
try {
  const envFile = resolve(homedir(), ".bash_env.local");
  const content = readFileSync(envFile, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^export\s+([^=]+)="(.*)"/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // File doesn't exist or unreadable, continue without it
}

/**
 * MCP Server for automated literature research and Zotero import.
 *
 * Tools:
 *   1. search_papers     — Search Semantic Scholar for academic papers
 *   2. create_collection — Create a new Zotero collection
 *   3. import_papers     — Import papers into a Zotero collection
 *   4. list_collections  — List existing Zotero collections
 *
 * Environment variables:
 *   ZOTERO_API_KEY           — Zotero Web API key (for creating collections)
 *   ZOTERO_USER_ID           — Zotero user ID (required)
 *   ZOTERO_LOCAL_PORT        — Local Zotero port (default: 23119)
 *   SEMANTIC_SCHOLAR_API_KEY — S2 API key (optional, for higher rate limits)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchPapers,
  getPaperById,
  formatPaper,
  type S2Paper,
} from "./semantic-scholar.js";
import {
  listCollections,
  createCollection,
  importPapers,
  searchLocalItems,
  deleteItem,
  getCollectionItems,
  getItem,
  updateItem,
  getAllCollectionItems,
  removeItemsFromCollection,
  addItemsToCollection,
  searchCollection,
  getCollectionDois,
  getCollectionStats,
} from "./zotero.js";
import { validatePapers, filterPapersWithDoi } from "./doi-validator.js";
import { cleanBraces, removeBraces, needsBraceCleaning, toSentenceCase } from "./text-normalize.js";

const server = new McpServer({
  name: "ai-zotero-workflow",
  version: "1.0.0",
});

// --- Tool 1: search_papers ---

server.tool(
  "search_papers",
  "Search Semantic Scholar for academic papers by keywords. Returns metadata including title, authors, year, DOI, abstract, venue, and citation count.",
  {
    query: z.string().describe("Search query keywords (e.g. 'Sparse Phase Retrieval')"),
    limit: z.number().min(1).max(100).optional().default(10).describe("Number of papers to return (1-100, default 10)"),
    year_from: z.number().optional().describe("Start year filter (e.g. 2020)"),
    year_to: z.number().optional().describe("End year filter (e.g. 2024)"),
    sort_by_citations: z.boolean().optional().default(false).describe("Sort results by citation count (descending) instead of relevance"),
    fields_of_study: z.array(z.string()).optional().describe("Filter by fields of study (e.g. ['Computer Science', 'Mathematics'])"),
  },
  async (params) => {
    try {
      const result = await searchPapers({
        query: params.query,
        limit: params.limit,
        yearFrom: params.year_from,
        yearTo: params.year_to,
        sortByCitations: params.sort_by_citations,
        fieldsOfStudy: params.fields_of_study,
      });

      if (!result.data || result.data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No papers found for query: "${params.query}"` }],
        };
      }

      const summary = [
        `Found ${result.total} papers (showing ${result.data.length}):`,
        "=".repeat(60),
        ...result.data.map((p, i) => `[${i + 1}] ${formatPaper(p)}`),
      ].join("\n");

      // Return both formatted text and structured data
      return {
        content: [
          { type: "text" as const, text: summary },
          {
            type: "text" as const,
            text: `\n--- RAW DATA (for import) ---\n${JSON.stringify(result.data, null, 2)}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching papers: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Tool 2: create_collection ---

server.tool(
  "create_zotero_collection",
  "Create a new collection in Zotero. Requires ZOTERO_API_KEY environment variable. If the collection already exists, returns the existing key.",
  {
    name: z.string().describe("Name for the new Zotero collection"),
    parent_collection: z.string().optional().describe("Parent collection key (optional, for nested collections)"),
  },
  async (params) => {
    try {
      // Check if collection already exists
      const collections = await listCollections();
      const existing = collections.find((c) => c.data.name === params.name);

      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Collection "${params.name}" already exists with key: ${existing.data.key} (${existing.meta.numItems} items)`,
            },
          ],
        };
      }

      const result = await createCollection(params.name, params.parent_collection);
      return {
        content: [
          {
            type: "text" as const,
            text: `Created collection "${result.name}" with key: ${result.key}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating collection: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Tool 3: import_papers ---

server.tool(
  "import_papers_to_zotero",
  "Import papers into Zotero. Accepts either S2 paper data (JSON array) or a search query to fetch and import. Creates the target collection if it doesn't exist. Supports duplicate detection to skip papers already in the collection.",
  {
    papers_json: z.string().optional().describe("JSON string of S2 paper objects (from search_papers output). If not provided, must supply 'query'."),
    query: z.string().optional().describe("If papers_json not provided, search S2 with this query and import results"),
    limit: z.number().min(1).max(50).optional().default(5).describe("Number of papers to import when using query mode (1-50, default 5)"),
    collection_name: z.string().describe("Name of the Zotero collection to import into (created if it doesn't exist)"),
    sort_by_citations: z.boolean().optional().default(true).describe("Sort by citation count before importing (default true)"),
    year_from: z.number().optional().describe("Start year filter"),
    year_to: z.number().optional().describe("End year filter"),
    skip_duplicates: z.boolean().optional().default(true).describe("Skip papers already in the collection (detected by DOI matching, default true)"),
  },
  async (params) => {
    try {
      let papers: S2Paper[];

      // Get papers from JSON or search
      if (params.papers_json) {
        papers = JSON.parse(params.papers_json) as S2Paper[];
      } else if (params.query) {
        const result = await searchPapers({
          query: params.query,
          limit: params.limit,
          yearFrom: params.year_from,
          yearTo: params.year_to,
          sortByCitations: params.sort_by_citations,
        });
        papers = result.data;
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Must provide either 'papers_json' or 'query' parameter",
            },
          ],
          isError: true,
        };
      }

      if (papers.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No papers to import" },
          ],
        };
      }

      // --- Dual DOI validation gate ---
      // Gate 1: Field completeness (quick, synchronous)
      const gate1 = filterPapersWithDoi(papers);

      // Gate 2: Network verification via doi.org Handle API (async, batched)
      const validation = await validatePapers(papers);
      const validatedPapers = validation.accepted.map((v) => v.paper);

      // Build validation report
      const report: string[] = [];
      report.push(`DOI Validation: ${validatedPapers.length}/${papers.length} papers passed dual-check`);

      if (validation.rejected.length > 0) {
        report.push("", "Rejected papers:");
        for (const r of validation.rejected) {
          report.push(`  ✗ "${r.paper.title}" — ${r.detail}`);
        }
      }

      if (validatedPapers.length === 0) {
        report.push("", "All papers failed validation. Nothing to import.");
        return {
          content: [{ type: "text" as const, text: report.join("\n") }],
        };
      }

      // Import ONLY validated papers to Zotero (with duplicate detection)
      const result = await importPapers(validatedPapers, params.collection_name, params.skip_duplicates);

      const lines = [
        ...report,
        "",
        `Import complete via ${result.method}`,
        `Collection: ${result.collectionName ?? "current selection"}`,
        `Imported: ${result.imported}/${validatedPapers.length} validated papers`,
      ];

      if (result.duplicatesSkipped > 0) {
        lines.push(`Duplicates skipped: ${result.duplicatesSkipped} (already in collection)`);
        for (const title of result.duplicateTitles) {
          lines.push(`  ⏭ "${title}"`);
        }
      }

      if (result.collectionKey) {
        lines.push(`Collection key: ${result.collectionKey}`);

        // Include collection stats
        try {
          const stats = await getCollectionStats(result.collectionKey);
          lines.push(`Collection now has ${stats.itemCount} items total`);
        } catch {
          // Stats fetch failed, skip
        }
      }

      if (result.errors.length > 0) {
        lines.push(`Errors: ${result.errors.join("; ")}`);
      }

      // List what was imported
      if (result.imported > 0) {
        lines.push("", "Papers imported:");
        validatedPapers.forEach((p, i) => {
          // Skip if this was a duplicate
          if (result.duplicateTitles.includes(p.title)) return;
          lines.push(`  ${i + 1}. ${p.title} (${p.year ?? "n/a"}) - ${p.citationCount ?? 0} citations [DOI: ${p.externalIds?.DOI}]`);
        });
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error importing papers: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Tool 4: list_collections ---

server.tool(
  "list_zotero_collections",
  "List all collections in the user's Zotero library. Uses local API when available.",
  {},
  async () => {
    try {
      const collections = await listCollections();

      if (collections.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No collections found in Zotero library" }],
        };
      }

      const lines = [
        `Found ${collections.length} collections:`,
        ...collections.map(
          (c) => `  - "${c.data.name}" (key: ${c.data.key}, items: ${c.meta.numItems})`,
        ),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing collections: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);


// --- Tool 5: get_collection_items ---

server.tool(
  "zotero_get_collection_items",
  "Get all items from a specific Zotero collection (paginated).",
  {
    collection_key: z.string().describe("The key of the Zotero collection"),
    start: z.number().optional().default(0).describe("Pagination start index"),
    limit: z.number().optional().default(50).describe("Number of items to return")
  },
  async (params) => {
    try {
      const items = await getCollectionItems(params.collection_key, params.start, params.limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// --- Tool 6: get_item ---

server.tool(
  "zotero_get_item",
  "Get full metadata for a specific Zotero item.",
  {
    item_key: z.string().describe("The key of the Zotero item")
  },
  async (params) => {
    try {
      const item = await getItem(params.item_key);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(item, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// --- Tool 7: update_item ---

server.tool(
  "zotero_update_item",
  "Update specific fields of a Zotero item via PATCH request.",
  {
    item_key: z.string().describe("The key of the Zotero item to update"),
    current_version: z.number().describe("The current version number of the item (required for concurrency control)"),
    data_json: z.string().describe("JSON string representing the fields to update (e.g. \'{\"DOI\": \"10.1234/567\"}\')"),
  },
  async (params) => {
    try {
      let data;
      try {
        data = JSON.parse(params.data_json);
      } catch (e) {
        throw new Error("Invalid data_json. Must be a valid JSON string.");
      }
      
      const result = await updateItem(params.item_key, data, params.current_version);
      return {
        content: [{ type: "text" as const, text: `Successfully updated item ${params.item_key}\n` + JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// --- Tool 8: search_library ---

server.tool(
  "zotero_search_library",
  "Search the local Zotero library (via Better BibTeX RPC). Requires Zotero to be running locally.",
  {
    query: z.string().describe("Search query string")
  },
  async (params) => {
    try {
      const items = await searchLocalItems(params.query);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// --- Tool 9: delete_items ---

server.tool(
  "zotero_delete_items",
  "Delete one or more items from Zotero by key. WARNING: This permanently deletes items from the library. Use zotero_remove_from_collection to only remove from a collection.",
  {
    item_keys: z.array(z.string()).describe("Array of Zotero item keys to delete")
  },
  async (params) => {
    try {
      const results = [];
      for (const key of params.item_keys) {
        const ok = await deleteItem(key);
        results.push(`${key}: ${ok ? "Deleted" : "Failed"}`);
      }
      return {
        content: [{ type: "text" as const, text: results.join("\n") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

// --- Tool 9b: remove_from_collection ---

server.tool(
  "zotero_remove_from_collection",
  "Remove items from a specific collection WITHOUT deleting them from the library. The items remain in other collections and in the library root.",
  {
    item_keys: z.array(z.string()).describe("Array of Zotero item keys to remove from the collection"),
    collection_key: z.string().describe("The key of the collection to remove items from"),
  },
  async (params) => {
    try {
      const result = await removeItemsFromCollection(params.item_keys, params.collection_key);

      const lines: string[] = [];
      if (result.removed.length > 0) {
        lines.push(`Removed ${result.removed.length} item(s) from collection:`);
        for (const key of result.removed) {
          lines.push(`  ✓ ${key}`);
        }
      }
      if (result.failed.length > 0) {
        lines.push(`Failed: ${result.failed.length}`);
        for (const f of result.failed) {
          lines.push(`  ✗ ${f.key}: ${f.error}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No changes made" }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 9c: add_to_collection ---

server.tool(
  "zotero_add_to_collection",
  "Add existing library items to a collection. Items can belong to multiple collections.",
  {
    item_keys: z.array(z.string()).describe("Array of Zotero item keys to add to the collection"),
    collection_key: z.string().describe("The key of the collection to add items to"),
  },
  async (params) => {
    try {
      const result = await addItemsToCollection(params.item_keys, params.collection_key);

      const lines: string[] = [];
      if (result.added.length > 0) {
        lines.push(`Added ${result.added.length} item(s) to collection:`);
        for (const key of result.added) {
          lines.push(`  ✓ ${key}`);
        }
      }
      if (result.already.length > 0) {
        lines.push(`Already in collection: ${result.already.length}`);
        for (const key of result.already) {
          lines.push(`  = ${key}`);
        }
      }
      if (result.failed.length > 0) {
        lines.push(`Failed: ${result.failed.length}`);
        for (const f of result.failed) {
          lines.push(`  ✗ ${f.key}: ${f.error}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No changes made" }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 9d: search_collection ---

server.tool(
  "zotero_search_collection",
  "Search within a specific Zotero collection by matching query against title, DOI, authors, and extra fields. Returns matching items with key metadata.",
  {
    collection_key: z.string().describe("The key of the Zotero collection to search within"),
    query: z.string().describe("Search query (matches against title, DOI, authors)"),
  },
  async (params) => {
    try {
      const results = await searchCollection(params.collection_key, params.query);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No items matching "${params.query}" found in collection` }],
        };
      }

      const lines = [
        `Found ${results.length} item(s) matching "${params.query}":`,
        "─".repeat(50),
        ...results.map((r, i) =>
          `[${i + 1}] ${r.key}\n  Title: ${r.title}\n  Authors: ${r.creators}\n  DOI: ${r.DOI || "N/A"}\n  Date: ${r.date || "N/A"}\n  Type: ${r.itemType}`
        ),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 9e: import_by_dois ---

server.tool(
  "zotero_import_by_dois",
  "Import papers into Zotero by DOI directly. Fetches metadata from Semantic Scholar for each DOI. More precise than keyword-based import. Supports duplicate detection.",
  {
    dois: z.array(z.string()).describe("Array of DOI strings to import (e.g. ['10.1234/567', '10.5678/910'])"),
    collection_name: z.string().describe("Name of the Zotero collection to import into (created if it doesn't exist)"),
    skip_duplicates: z.boolean().optional().default(true).describe("Skip papers already in the collection (detected by DOI matching, default true)"),
  },
  async (params) => {
    try {
      const papers: S2Paper[] = [];
      const fetchErrors: string[] = [];

      // Fetch each paper from S2 by DOI
      for (const doi of params.dois) {
        try {
          const paper = await getPaperById(`DOI:${doi}`);
          papers.push(paper);
        } catch (err) {
          fetchErrors.push(`DOI ${doi}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (papers.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No papers could be fetched.\n${fetchErrors.join("\n")}` }],
          isError: true,
        };
      }

      // DOI validation (already have DOIs, just verify they resolve)
      const validation = await validatePapers(papers);
      const validatedPapers = validation.accepted.map((v) => v.paper);

      const report: string[] = [];
      report.push(`Fetched ${papers.length}/${params.dois.length} papers from S2`);
      if (fetchErrors.length > 0) {
        report.push("Fetch errors:");
        fetchErrors.forEach(e => report.push(`  ✗ ${e}`));
      }
      report.push(`DOI Validation: ${validatedPapers.length}/${papers.length} passed`);

      if (validatedPapers.length === 0) {
        report.push("No valid papers to import.");
        return { content: [{ type: "text" as const, text: report.join("\n") }] };
      }

      // Import with duplicate detection
      const result = await importPapers(validatedPapers, params.collection_name, params.skip_duplicates);

      report.push("", `Import complete via ${result.method}`);
      report.push(`Collection: ${result.collectionName}`);
      report.push(`Imported: ${result.imported}/${validatedPapers.length}`);

      if (result.duplicatesSkipped > 0) {
        report.push(`Duplicates skipped: ${result.duplicatesSkipped}`);
        result.duplicateTitles.forEach(t => report.push(`  ⏭ "${t}"`));
      }

      if (result.collectionKey) {
        report.push(`Collection key: ${result.collectionKey}`);
        try {
          const stats = await getCollectionStats(result.collectionKey);
          report.push(`Collection now has ${stats.itemCount} items total`);
        } catch { /* skip */ }
      }

      if (result.errors.length > 0) {
        report.push(`Errors: ${result.errors.join("; ")}`);
      }

      return {
        content: [{ type: "text" as const, text: report.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error importing by DOIs: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Tool 10: clean_braces ---

server.tool(
  "zotero_clean_braces",
  "Clean LaTeX curly braces from Zotero collection items. Removes case-protecting braces ({W} → W), converts LaTeX accent commands to Unicode ({\\`e} → è), and strips structural braces from fields like abstractNote. Supports dry-run mode to preview changes before applying.",
  {
    collection_key: z.string().describe("The key of the Zotero collection to process"),
    dry_run: z.boolean().optional().default(true).describe("Preview only — don't actually update items (default true)"),
  },
  async (params) => {
    try {
      const items = await getAllCollectionItems(params.collection_key);
      if (items.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No items found in collection" }],
        };
      }

      const itemsToUpdate: Array<{
        key: string;
        version: number;
        changes: Record<string, unknown>;
        details: string[];
      }> = [];

      for (const item of items) {
        const d = item.data;
        const changes: Record<string, unknown> = {};
        const details: string[] = [];

        // Clean title with full LaTeX processing
        if (d.title && needsBraceCleaning(d.title)) {
          const cleaned = cleanBraces(d.title);
          if (cleaned !== d.title) {
            changes.title = cleaned;
            details.push(`title: "${d.title}" → "${cleaned}"`);
          }
        }

        // Clean creators
        if (d.creators && Array.isArray(d.creators)) {
          let creatorsChanged = false;
          const cleanedCreators = d.creators.map((creator: any) => {
            const c = { ...creator };
            if (creator.firstName && needsBraceCleaning(creator.firstName)) {
              c.firstName = cleanBraces(creator.firstName);
              creatorsChanged = true;
            }
            if (creator.lastName && needsBraceCleaning(creator.lastName)) {
              c.lastName = cleanBraces(creator.lastName);
              creatorsChanged = true;
            }
            if (creator.name && needsBraceCleaning(creator.name)) {
              c.name = cleanBraces(creator.name);
              creatorsChanged = true;
            }
            return c;
          });
          if (creatorsChanged) {
            changes.creators = cleanedCreators;
            details.push(`creators updated`);
          }
        }

        // Clean other string fields (just strip braces)
        for (const [field, value] of Object.entries(d)) {
          if (["key", "version", "itemType", "creators", "tags", "collections",
               "relations", "dateAdded", "dateModified", "title"].includes(field)) continue;
          if (typeof value !== "string" || !value.includes("{")) continue;
          const cleaned = removeBraces(value);
          if (cleaned !== value) {
            changes[field] = cleaned;
            details.push(`${field}: braces removed`);
          }
        }

        if (Object.keys(changes).length > 0) {
          itemsToUpdate.push({ key: d.key, version: item.version, changes, details });
        }
      }

      if (itemsToUpdate.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No items need cleaning. Checked ${items.length} items.` }],
        };
      }

      const preview = [
        `Found ${itemsToUpdate.length} items needing cleanup (out of ${items.length}):`,
        "─".repeat(50),
        ...itemsToUpdate.map((item, i) =>
          `[${i + 1}] ${item.key}\n  ${item.details.join("\n  ")}`
        ),
      ];

      if (params.dry_run) {
        preview.push("", "─".repeat(50), "DRY RUN — no changes applied. Set dry_run=false to apply.");
        return { content: [{ type: "text" as const, text: preview.join("\n") }] };
      }

      // Apply changes
      let ok = 0, fail = 0;
      for (let i = 0; i < itemsToUpdate.length; i++) {
        const item = itemsToUpdate[i];
        try {
          await updateItem(item.key, item.changes, item.version);
          ok++;
        } catch {
          fail++;
        }
        if (i < itemsToUpdate.length - 1) await new Promise(r => setTimeout(r, 200));
      }

      preview.push("", "─".repeat(50), `Applied: ${ok} updated, ${fail} failed, ${itemsToUpdate.length} total`);
      return { content: [{ type: "text" as const, text: preview.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 11: apply_sentence_case ---

server.tool(
  "zotero_apply_sentence_case",
  "Convert titles in a Zotero collection to Sentence Case. First word capitalized, rest lowercase, with automatic protection for acronyms (PCA, BM3D), proper nouns (Fourier, Wirtinger), CamelCase brands (PhasePack, ISTA-Net), and institution names (IT'IS). Supports dry-run mode and custom protection terms.",
  {
    collection_key: z.string().describe("The key of the Zotero collection to process"),
    dry_run: z.boolean().optional().default(true).describe("Preview only — don't actually update items (default true)"),
    extra_acronyms: z.array(z.string()).optional().describe("Additional acronyms to protect (added to built-in list)"),
    extra_proper_nouns: z.array(z.string()).optional().describe("Additional proper nouns to capitalize (added to built-in list)"),
  },
  async (params) => {
    try {
      const items = await getAllCollectionItems(params.collection_key);
      if (items.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No items found in collection" }],
        };
      }

      const changes: Array<{
        key: string;
        version: number;
        original: string;
        converted: string;
      }> = [];

      for (const item of items) {
        const title = item.data?.title;
        if (!title) continue;
        const converted = toSentenceCase(title, {
          extraAcronyms: params.extra_acronyms,
          extraProperNouns: params.extra_proper_nouns,
        });
        if (converted !== title) {
          changes.push({ key: item.data.key, version: item.version, original: title, converted });
        }
      }

      if (changes.length === 0) {
        return {
          content: [{ type: "text" as const, text: `All ${items.length} titles already in sentence case. Nothing to do.` }],
        };
      }

      const preview = [
        `Found ${changes.length} titles to convert (out of ${items.length}):`,
        "─".repeat(50),
        ...changes.map((c, i) =>
          `[${i + 1}] ${c.key}\n  FROM: ${c.original}\n  TO:   ${c.converted}`
        ),
      ];

      if (params.dry_run) {
        preview.push("", "─".repeat(50), "DRY RUN — no changes applied. Set dry_run=false to apply.");
        return { content: [{ type: "text" as const, text: preview.join("\n") }] };
      }

      // Apply changes
      let ok = 0, fail = 0;
      for (let i = 0; i < changes.length; i++) {
        const c = changes[i];
        try {
          await updateItem(c.key, { title: c.converted }, c.version);
          ok++;
        } catch {
          fail++;
        }
        if (i < changes.length - 1) await new Promise(r => setTimeout(r, 150));
      }

      preview.push("", "─".repeat(50), `Applied: ${ok} updated, ${fail} failed, ${changes.length} total`);
      return { content: [{ type: "text" as const, text: preview.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);


// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ai-zotero-workflow MCP server running on stdio");
  console.error(`  Zotero Web API: ${process.env.ZOTERO_API_KEY ? "configured" : "not configured"}`);
  console.error(`  Zotero User ID: ${process.env.ZOTERO_USER_ID ?? "(not set — required for web API)"}`);
  console.error(`  Local Zotero: http://localhost:${process.env.ZOTERO_LOCAL_PORT ?? "23119"}`);
  console.error(`  S2 API Key: ${process.env.SEMANTIC_SCHOLAR_API_KEY ? "configured (1 RPS rate limit)" : "not configured (unauthenticated mode)"}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
