# MCP Servers

A collection of [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers for AI-assisted workflows.

## Available Servers

| Server | Description |
|--------|-------------|
| [ai-zotero-workflow](./ai-zotero-workflow/) | Automated academic literature search (Semantic Scholar) and import to Zotero |
| [ai-latex-bib-sync](./ai-latex-bib-sync/) | Bidirectional sync between BibTeX files and Zotero collections |

## Quick Start

```bash
# 1. Clone to home directory
git clone https://github.com/Mengchu97/mcp-servers.git ~/mcp-servers

# 2. Build all servers
cd ~/mcp-servers/ai-zotero-workflow && npm install && npm run build
cd ~/mcp-servers/ai-latex-bib-sync && npm install && npm run build
```

Then configure your MCP client (Claude Desktop, Cursor, OpenCode, etc.) to launch the servers. All config examples below assume the repo is cloned to `~/mcp-servers/`.

---

## ai-zotero-workflow

Search academic papers via Semantic Scholar and import them (with DOI validation) into your Zotero library.

### Features

- **Paper search** — query Semantic Scholar with keyword, year range, field-of-study filters
- **DOI dual-validation** — field completeness check + network verification via doi.org Handle API
- **Zotero import** — dual strategy: Web API (full CRUD) or local connector (fallback, add-only)
- **Collection management** — create and list Zotero collections

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Zotero](https://www.zotero.org/) desktop app (for local connector) or a Zotero Web API key
- A Semantic Scholar API key (optional, for higher rate limits)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOTERO_API_KEY` | Yes (for Web API) | Zotero Web API key. Get one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). Required permissions: Allow library access + Allow write access. |
| `ZOTERO_USER_ID` | Yes (for Web API) | Your Zotero user ID (numeric). Found at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). |
| `ZOTERO_LOCAL_PORT` | No | Local Zotero connector port (default: `23119`) |
| `SEMANTIC_SCHOLAR_API_KEY` | No | S2 API key for higher rate limits. Request at [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) |

### MCP Client Configuration

Add to your MCP client config (e.g. `claude_desktop_config.json`, `.cursor/mcp.json`, or OpenCode config):

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

### Tools Provided

| Tool | Description |
|------|-------------|
| `search_papers` | Search Semantic Scholar for papers by keywords, with year/field/citation filters |
| `create_zotero_collection` | Create a new collection in Zotero |
| `import_papers_to_zotero` | Import papers into a Zotero collection (with DOI validation) |
| `list_zotero_collections` | List all collections in your Zotero library |

---

## ai-latex-bib-sync

Bidirectional sync between BibTeX .bib files and Zotero collections.

### Features

- **Bib → Zotero** — Import .bib entries to Zotero (DOI/title matching skips duplicates)
- **Zotero → Bib** — Export Zotero collections to .bib files (append or overwrite)
- **Diff** — Compare .bib vs Zotero collection to see gaps on each side
- **Cite key check** — Scan .tex for `\cite{}` references missing from .bib
- **Cite key generator** — `AuthorYearWord` format (e.g., `Zou2006Sparse`)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOTERO_API_KEY` | Yes | Zotero Web API key. Get one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). |
| `ZOTERO_USER_ID` | Yes | Your Zotero user ID (numeric). |

### MCP Client Configuration

```json
{
  "mcpServers": {
    "ai-latex-bib-sync": {
      "command": "node",
      "args": ["~/mcp-servers/ai-latex-bib-sync/dist/index.js"],
      "env": {
        "ZOTERO_API_KEY": "your-zotero-api-key",
        "ZOTERO_USER_ID": "your-zotero-user-id"
      }
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `sync_bib_to_zotero` | Import .bib entries into a Zotero collection |
| `sync_zotero_to_bib` | Export Zotero collection to a .bib file |
| `diff_bib_zotero` | Compare .bib file with Zotero collection |
| `check_cite_keys` | Scan .tex files for missing/unused citation keys |
| `generate_cite_key` | Generate an `AuthorYearWord` citation key |

---

## Adding a New Server

To add a new MCP server to this monorepo:

```bash
# Create a new directory at the repo root
mkdir my-new-server && cd my-new-server

# Initialize with the MCP SDK
npm init -y
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node

# Add your server code under src/, then build
npm run build
```

Follow the same structure: `src/index.ts` as entry point, `package.json` with `"main": "dist/index.js"`.

## License

MIT
