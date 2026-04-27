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
} from "./zotero.js";
import { validatePapers, filterPapersWithDoi } from "./doi-validator.js";

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
  "Import papers into Zotero. Accepts either S2 paper data (JSON array) or a search query to fetch and import. Creates the target collection if it doesn't exist.",
  {
    papers_json: z.string().optional().describe("JSON string of S2 paper objects (from search_papers output). If not provided, must supply 'query'."),
    query: z.string().optional().describe("If papers_json not provided, search S2 with this query and import results"),
    limit: z.number().min(1).max(50).optional().default(5).describe("Number of papers to import when using query mode (1-50, default 5)"),
    collection_name: z.string().describe("Name of the Zotero collection to import into (created if it doesn't exist)"),
    sort_by_citations: z.boolean().optional().default(true).describe("Sort by citation count before importing (default true)"),
    year_from: z.number().optional().describe("Start year filter"),
    year_to: z.number().optional().describe("End year filter"),
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

      // Import ONLY validated papers to Zotero
      const result = await importPapers(validatedPapers, params.collection_name);

      const lines = [
        ...report,
        "",
        `Import complete via ${result.method}`,
        `Collection: ${result.collectionName ?? "current selection"}`,
        `Imported: ${result.imported}/${validatedPapers.length} validated papers`,
      ];

      if (result.collectionKey) {
        lines.push(`Collection key: ${result.collectionKey}`);
      }

      if (result.errors.length > 0) {
        lines.push(`Errors: ${result.errors.join("; ")}`);
      }

      // List what was imported
      lines.push("", "Papers imported:");
      validatedPapers.forEach((p, i) => {
        lines.push(`  ${i + 1}. ${p.title} (${p.year ?? "n/a"}) - ${p.citationCount ?? 0} citations [DOI: ${p.externalIds?.DOI}]`);
      });

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

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ai-zotero-workflow MCP server running on stdio");
  console.error(`  Zotero Web API: ${process.env.ZOTERO_API_KEY ? "configured" : "not configured"}`);
  console.error(`  Zotero User ID: ${process.env.ZOTERO_USER_ID ?? "(not set — required for web API)"}`);
  console.error(`  Local Zotero: http://localhost:${process.env.ZOTERO_LOCAL_PORT ?? "23119"}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
