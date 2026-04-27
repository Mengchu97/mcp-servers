# MCP Servers

A collection of [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers for AI-assisted workflows.

## Available Servers

| Server | Description |
|--------|-------------|
| [ai-zotero-workflow](./ai-zotero-workflow/) | Automated academic literature search (Semantic Scholar) and import to Zotero |

## Quick Start

Each server is a standalone TypeScript project in its own directory. General setup:

```bash
# 1. Clone the repo
git clone https://github.com/Mengchu97/mcp-servers.git
cd mcp-servers

# 2. Build a server
cd ai-zotero-workflow
npm install
npm run build
```

Then configure your MCP client (e.g. Claude Desktop, Cursor, OpenCode) to launch the server.

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
      "args": ["/absolute/path/to/mcp-servers/ai-zotero-workflow/dist/index.js"],
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

### Documentation

- [Zotero Workflow Guide](./ai-zotero-workflow/docs/ZOTERO_WORKFLOW_GUIDE.md) — detailed workflow explanation and AI prompt templates

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
