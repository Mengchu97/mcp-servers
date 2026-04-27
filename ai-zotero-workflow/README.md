# ai-zotero-workflow

MCP server for automated academic literature search and Zotero import.

## Core Mechanism

This server provides a battle-tested workflow for automated literature retrieval with full-text PDF support and seamless import into your Zotero library. It addresses two key pain points:

1. **Bypassing Zotero cloud storage limits**: Uploading items with PDFs directly can easily trigger the 300MB free-tier quota (`413 File would exceed quota`). Our workflow uses a `linked_file` strategy: metadata syncs to the Zotero cloud, while PDFs are downloaded to your local disk (never uploaded to Zotero Cloud) and attached as local file links in the Zotero client.

2. **Guaranteed metadata quality**: Instead of the unreliable browser Connector, everything goes through the Zotero Web API. We use a "Two-Step" approach: first create a clean parent item (the literature entry), then attach a child item (the PDF file link).

## Search Logic: Official Venue/Journal First, arXiv Fallback

The server is built on the **Semantic Scholar (S2) API**, because S2 aggregates multiple sources for a single paper. The search enforces a strict priority order:

1. **Default Mode (Official First)**:
   - Check if the paper has an official publication venue (Journal / Conference). If so, the item type is set to a standard Journal Article or Conference Paper.
   - Extract full metadata including the official DOI.
   - Attempt to fetch the official Open Access PDF via `openAccessPdf`.
   - **Fallback strategy**: If the paper hasn't been officially published yet, or the official OA PDF is unavailable, but S2 has an associated arXiv ID, it automatically falls back to the arXiv version — stored as a preprint with the arXiv PDF downloaded.

2. **arXiv-Only Mode**:
   - If you explicitly request "arXiv only" in your prompt, the search filters to only arXiv preprints and downloads arXiv PDFs exclusively.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOTERO_API_KEY` | Yes | Zotero Web API key. Get one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). Required permissions: Allow library access + Allow write access. |
| `ZOTERO_USER_ID` | Yes | Your Zotero user ID (numeric). Found at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). |
| `ZOTERO_LOCAL_PORT` | No | Local Zotero connector port (default: `23119`) |
| `SEMANTIC_SCHOLAR_API_KEY` | No | S2 API key for higher rate limits. Request at [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) |

## MCP Client Configuration

```json
{
  "mcpServers": {
    "ai-zotero-workflow": {
      "command": "node",
      "args": ["~/mcp-servers/ai-zotero-workflow/dist/index.js"],
      "env": {
        "ZOTERO_API_KEY": "your-zotero-api-key",
        "ZOTERO_USER_ID": "your-zotero-user-id"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `search_papers` | Search Semantic Scholar for papers by keywords, with year/field/citation filters |
| `create_zotero_collection` | Create a new collection in Zotero |
| `import_papers_to_zotero` | Import papers into a Zotero collection (with DOI validation) |
| `list_zotero_collections` | List all collections in your Zotero library |

## AI Prompt Templates

When you want AI to perform a literature import task, **send a prompt like the following** — the AI will understand and execute using the MCP tools:

### Search and import (official venue first)

> *"Search for [count, e.g. 10] recent high-quality papers on [topic, e.g. Large Language Models Alignment]. Prioritize papers published in top venues (e.g. NeurIPS, ICLR). Download open-access PDFs and import them into my Zotero collection '[collection name, e.g. LLM_Align]'. If no official OA PDF is available, use the arXiv version instead."*

### arXiv-only mode

> *"Fetch 10 arXiv-only preprints on [topic], including locally-linked PDFs, and save them to Zotero collection '[collection name]'."*

### Browse existing library

> *"List all my Zotero collections and show me the items in '[collection name]'."*
