/**
 * MCP Server for bidirectional BibTeX ↔ Zotero sync.
 *
 * Tools:
 *   1. sync_bib_to_zotero  — Import new .bib entries into Zotero
 *   2. sync_zotero_to_bib  — Export Zotero collection entries to a .bib file
 *   3. diff_bib_zotero     — Compare a .bib file with a Zotero collection
 *   4. check_cite_keys     — Scan .tex files for missing/unused citation keys
 *   5. generate_cite_key   — Generate an AuthorYearWord citation key
 *
 * Environment variables:
 *   ZOTERO_API_KEY           — Zotero Web API key (required for write operations)
 *   ZOTERO_USER_ID           — Zotero user ID (required for write operations)
 *   ZOTERO_LOCAL_PORT        — Local Zotero port (default: 23119)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseBibFile, parseBibContent } from "./bib-parser.js";
import { serializeEntries, writeBibFile } from "./bib-writer.js";
import { generateCiteKey, normalizeCiteKey } from "./cite-key.js";
import {
  listCollections,
  ensureCollection,
  listItems,
  createItems,
  exportCollectionToBibEntries,
  bibEntryToZoteroItemData,
  zoteroItemToBibEntry,
} from "./zotero-adapter.js";
import { matchEntries, normalizeDoi } from "./matcher.js";
import { scanCiteKeys, checkCiteKeys, findTexFiles } from "./tex-scanner.js";
import type { BibEntry, BibFile } from "./types.js";

const server = new McpServer({
  name: "ai-latex-bib-sync",
  version: "1.0.0",
});

// --- Tool 1: sync_bib_to_zotero ---

server.tool(
  "sync_bib_to_zotero",
  "Import entries from a .bib file into a Zotero collection. Only entries NOT already in Zotero (by DOI/title match) are imported.",
  {
    bib_file_path: z.string().describe("Absolute path to the .bib file"),
    collection_name: z.string().describe("Target Zotero collection name (created if missing)"),
    dry_run: z.boolean().optional().default(false).describe("Preview what would be imported without making changes"),
  },
  async (params) => {
    try {
      const bib = parseBibFile(params.bib_file_path);
      if (bib.entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No entries found in .bib file." }] };
      }

      const collectionKey = await ensureCollection(params.collection_name);
      const existingItems = await listItems(collectionKey);

      const matchResult = matchEntries(bib.entries, existingItems);

      const newEntries = matchResult.onlyInBib;
      const report: string[] = [
        `Bib file: ${params.bib_file_path} (${bib.entries.length} entries)`,
        `Zotero collection: "${params.collection_name}" (${existingItems.length} items)`,
        `Matched by DOI: ${matchResult.byDoi.length}`,
        `Matched by title: ${matchResult.byTitle.length}`,
        `New entries to import: ${newEntries.length}`,
      ];

      if (newEntries.length === 0) {
        report.push("\nAll .bib entries already exist in Zotero. Nothing to import.");
        return { content: [{ type: "text" as const, text: report.join("\n") }] };
      }

      if (params.dry_run) {
        report.push("\n[DRY RUN] Would import:");
        for (const entry of newEntries) {
          report.push(`  - ${entry.key}: ${entry.title?.substring(0, 80) ?? "(untitled)"}`);
        }
        return { content: [{ type: "text" as const, text: report.join("\n") }] };
      }

      const itemDataList = newEntries.map((entry) => {
        const data = bibEntryToZoteroItemData(entry);
        data.collections = [collectionKey];
        return data;
      });

      const createResult = await createItems(itemDataList);

      report.push(`\nImport result: ${createResult.created}/${newEntries.length} created`);
      if (createResult.errors.length > 0) {
        report.push("Errors:");
        for (const err of createResult.errors) {
          report.push(`  - ${err}`);
        }
      }

      return { content: [{ type: "text" as const, text: report.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 2: sync_zotero_to_bib ---

server.tool(
  "sync_zotero_to_bib",
  "Export entries from a Zotero collection to a .bib file. Adds new entries while preserving existing ones.",
  {
    collection_name: z.string().describe("Source Zotero collection name"),
    bib_file_path: z.string().describe("Absolute path to the target .bib file"),
    merge_mode: z.enum(["append", "overwrite"]).optional().default("append").describe("'append' adds new entries only; 'overwrite' replaces the entire file"),
  },
  async (params) => {
    try {
      const collections = await listCollections();
      const collection = collections.find((c) => c.data.name === params.collection_name);

      if (!collection) {
        return {
          content: [{ type: "text" as const, text: `Collection "${params.collection_name}" not found in Zotero.` }],
        };
      }

      const zoteroEntries = await exportCollectionToBibEntries(collection.data.key);

      if (zoteroEntries.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Collection "${params.collection_name}" has no items.` }],
        };
      }

      if (params.merge_mode === "overwrite") {
        const bibFile: BibFile = {
          path: params.bib_file_path,
          entries: zoteroEntries,
          strings: {},
          preamble: [],
          comments: [],
          errors: [],
        };
        writeBibFile(params.bib_file_path, bibFile);
        return {
          content: [{
            type: "text" as const,
            text: `Wrote ${zoteroEntries.length} entries to ${params.bib_file_path} (overwrite mode)`,
          }],
        };
      }

      // Append mode: read existing .bib, add only new entries
      let existingBib: BibFile;
      try {
        existingBib = parseBibFile(params.bib_file_path);
      } catch {
        // File doesn't exist — create fresh
        const bibFile: BibFile = {
          path: params.bib_file_path,
          entries: zoteroEntries,
          strings: {},
          preamble: [],
          comments: [],
          errors: [],
        };
        writeBibFile(params.bib_file_path, bibFile);
        return {
          content: [{
            type: "text" as const,
            text: `Created ${params.bib_file_path} with ${zoteroEntries.length} entries`,
          }],
        };
      }

      // Match and find new entries
      const matchResult = matchEntries(zoteroEntries, existingBib.entries as any[]);
      const newEntries = matchResult.onlyInBib;

      if (newEntries.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `All ${zoteroEntries.length} Zotero entries already exist in ${params.bib_file_path}. Nothing to add.`,
          }],
        };
      }

      const mergedEntries = [...existingBib.entries, ...newEntries];
      const bibFile: BibFile = {
        ...existingBib,
        entries: mergedEntries,
      };
      writeBibFile(params.bib_file_path, bibFile);

      const report = [
        `Existing .bib entries: ${existingBib.entries.length}`,
        `Zotero collection entries: ${zoteroEntries.length}`,
        `New entries appended: ${newEntries.length}`,
        `Total entries now: ${mergedEntries.length}`,
        "",
        "New entries added:",
        ...newEntries.map((e) => `  + ${e.key}: ${e.title?.substring(0, 70) ?? "(untitled)"}`),
      ];

      return { content: [{ type: "text" as const, text: report.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 3: diff_bib_zotero ---

server.tool(
  "diff_bib_zotero",
  "Compare a .bib file with a Zotero collection and show differences (missing, extra, matched).",
  {
    bib_file_path: z.string().describe("Absolute path to the .bib file"),
    collection_name: z.string().describe("Zotero collection name to compare against"),
  },
  async (params) => {
    try {
      const bib = parseBibFile(params.bib_file_path);
      const collections = await listCollections();
      const collection = collections.find((c) => c.data.name === params.collection_name);

      if (!collection) {
        return {
          content: [{
            type: "text" as const,
            text: `Collection "${params.collection_name}" not found. Available: ${collections.map((c) => `"${c.data.name}"`).join(", ") || "(none)"}`,
          }],
        };
      }

      const zoteroItems = await listItems(collection.data.key);
      const matchResult = matchEntries(bib.entries, zoteroItems);

      const report: string[] = [
        `Diff: ${params.bib_file_path} ↔ Zotero "${params.collection_name}"`,
        "=".repeat(60),
        "",
        `Bib file: ${bib.entries.length} entries`,
        `Zotero: ${zoteroItems.length} items`,
        "",
        `Matched by DOI: ${matchResult.byDoi.length}`,
        `Matched by title: ${matchResult.byTitle.length}`,
        `Only in .bib (not in Zotero): ${matchResult.onlyInBib.length}`,
        `Only in Zotero (not in .bib): ${matchResult.onlyInZotero.length}`,
      ];

      if (matchResult.onlyInBib.length > 0) {
        report.push("", "Entries only in .bib (→ import to Zotero with sync_bib_to_zotero):");
        for (const entry of matchResult.onlyInBib) {
          report.push(`  + ${entry.key}: ${entry.title?.substring(0, 70) ?? "(untitled)"}${entry.doi ? ` [DOI: ${entry.doi}]` : ""}`);
        }
      }

      if (matchResult.onlyInZotero.length > 0) {
        report.push("", "Items only in Zotero (→ export to .bib with sync_zotero_to_bib):");
        for (const item of matchResult.onlyInZotero) {
          report.push(`  + ${item.data.key}: ${item.data.title?.substring(0, 70) ?? "(untitled)"}${item.data.DOI ? ` [DOI: ${item.data.DOI}]` : ""}`);
        }
      }

      if (matchResult.byTitle.length > 0) {
        report.push("", "Fuzzy-matched by title (review for correctness):");
        for (const m of matchResult.byTitle) {
          report.push(`  ~ ${m.bib.key} ↔ ${m.zotero.data.key} (similarity: ${(m.similarity * 100).toFixed(0)}%)`);
        }
      }

      return { content: [{ type: "text" as const, text: report.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 4: check_cite_keys ---

server.tool(
  "check_cite_keys",
  "Scan .tex files for \\cite{} keys and cross-reference with a .bib file. Reports missing and unused keys.",
  {
    tex_paths: z.array(z.string()).optional().describe("Array of .tex file paths to scan"),
    tex_dir: z.string().optional().describe("Directory path to recursively scan for .tex files"),
    bib_file_path: z.string().describe("Absolute path to the .bib file to check against"),
  },
  async (params) => {
    try {
      if (!params.tex_paths && !params.tex_dir) {
        return {
          content: [{ type: "text" as const, text: "Error: Provide either tex_paths or tex_dir." }],
          isError: true,
        };
      }

      const texFiles = params.tex_paths ?? findTexFiles(params.tex_dir!);

      if (texFiles.length === 0) {
        return { content: [{ type: "text" as const, text: "No .tex files found." }] };
      }

      const bib = parseBibFile(params.bib_file_path);
      const bibKeys = bib.entries.map((e) => e.key);

      const result = checkCiteKeys(texFiles, bibKeys);

      const report: string[] = [
        `Citation key check: ${texFiles.length} .tex files ↔ ${params.bib_file_path} (${bibKeys.length} keys)`,
        "=".repeat(60),
        "",
        `Valid keys (used in .tex AND in .bib): ${result.valid.length}`,
        `Missing keys (used in .tex but NOT in .bib): ${result.missing.length}`,
        `Unused keys (in .bib but not used in .tex): ${result.unused.length}`,
      ];

      if (result.missing.length > 0) {
        report.push("", "⚠ Missing citation keys:");
        for (const key of result.missing) {
          report.push(`  ✗ ${key}`);
        }
      }

      if (result.unused.length > 0) {
        report.push("", "Unused bibliography entries:");
        for (const key of result.unused.slice(0, 20)) {
          report.push(`  - ${key}`);
        }
        if (result.unused.length > 20) {
          report.push(`  ... and ${result.unused.length - 20} more`);
        }
      }

      if (result.missing.length === 0 && result.unused.length === 0) {
        report.push("\n✓ All citation keys are valid. No missing or unused entries.");
      }

      return { content: [{ type: "text" as const, text: report.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool 5: generate_cite_key ---

server.tool(
  "generate_cite_key",
  "Generate a citation key in AuthorYearWord format (e.g., 'Avolio2010Arterial').",
  {
    author: z.string().optional().describe("Author string (e.g., 'Smith, John and Doe, Jane')"),
    year: z.string().optional().describe("Publication year"),
    title: z.string().optional().describe("Paper title"),
  },
  async (params) => {
    try {
      const key = generateCiteKey({
        author: params.author,
        year: params.year,
        title: params.title,
      });

      return {
        content: [{
          type: "text" as const,
          text: `Generated citation key: ${key}\nNormalized (for comparison): ${normalizeCiteKey(key)}`,
        }],
      };
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
  console.error("ai-latex-bib-sync MCP server running on stdio");
  console.error(`  Zotero Web API: ${process.env.ZOTERO_API_KEY ? "configured" : "not configured"}`);
  console.error(`  Zotero User ID: ${process.env.ZOTERO_USER_ID ?? "(not set)"}`);
  console.error(`  Local Zotero: http://localhost:${process.env.ZOTERO_LOCAL_PORT ?? "23119"}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
