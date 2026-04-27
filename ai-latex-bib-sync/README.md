# ai-latex-bib-sync

MCP server for **bidirectional sync** between BibTeX (.bib) files and Zotero.

## Features

- **Bib → Zotero**: Import new .bib entries into Zotero collections (DOI/title matching to skip duplicates)
- **Zotero → Bib**: Export Zotero collections to .bib files (append or overwrite mode)
- **Diff**: Compare a .bib file with a Zotero collection to see what's missing from each side
- **Citation key check**: Scan .tex files for `\cite{}` keys and verify they exist in your .bib
- **Cite key generator**: Generate keys in `AuthorYearWord` format (e.g., `Zou2006Sparse`)

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Zotero](https://www.zotero.org/) desktop app or Zotero Web API credentials
- A BibTeX (.bib) file library (managed as git submodule recommended)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOTERO_API_KEY` | Yes (for writes) | Zotero Web API key. Get one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). |
| `ZOTERO_USER_ID` | Yes (for writes) | Your Zotero user ID (numeric). |
| `ZOTERO_LOCAL_PORT` | No | Local Zotero connector port (default: `23119`) |

## Setup

```bash
cd ai-latex-bib-sync
npm install
npm run build
```

## MCP Client Configuration

```json
{
  "mcpServers": {
    "ai-latex-bib-sync": {
      "command": "node",
      "args": ["/path/to/mcp-servers/ai-latex-bib-sync/dist/index.js"],
      "env": {
        "ZOTERO_API_KEY": "your-zotero-api-key",
        "ZOTERO_USER_ID": "your-zotero-user-id"
      }
    }
  }
}
```

## Tools

### `sync_bib_to_zotero`
Import entries from a .bib file into a Zotero collection. Matches existing items by DOI (exact) then title (fuzzy), importing only new entries.

**Parameters**: `bib_file_path`, `collection_name`, `dry_run` (optional)

### `sync_zotero_to_bib`
Export entries from a Zotero collection to a .bib file. Supports `append` (add new only) and `overwrite` (replace entire file) modes.

**Parameters**: `collection_name`, `bib_file_path`, `merge_mode` (append/overwrite)

### `diff_bib_zotero`
Compare a .bib file with a Zotero collection and report: matched by DOI, matched by title, only in .bib, only in Zotero.

**Parameters**: `bib_file_path`, `collection_name`

### `check_cite_keys`
Scan .tex files for `\cite{}`, `\citep{}`, `\citet{}`, `\parencite{}` and all variants. Cross-references with a .bib file to report missing and unused keys.

**Parameters**: `bib_file_path`, `tex_paths` or `tex_dir`

### `generate_cite_key`
Generate a citation key in `AuthorYearWord` format (e.g., `Avolio2010Arterial`, `Zou2006Sparse`).

**Parameters**: `author`, `year`, `title`

## Citation Key Format

Keys follow the pattern `LastName + Year + FirstSignificantWord`:

| Author | Year | Title | Key |
|--------|------|-------|-----|
| Avolio, A. P. | 2010 | Arterial blood pressure... | `Avolio2010Arterial` |
| Zou, Hui | 2006 | Sparse principal component analysis | `Zou2006Sparse` |
| Xu, Mengchu | 2024 | Exponential Spectral Pursuit... | `Xu2024Exponential` |

Articles and prepositions (a, an, the, of, in, on, etc.) are skipped when selecting the first significant word.

## Architecture

```
src/
├── index.ts           # MCP server entry point, 5 tool definitions
├── bib-parser.ts      # Parse .bib files via @retorquere/bibtex-parser
├── bib-writer.ts      # Serialize entries to .bib with aligned formatting
├── cite-key.ts        # AuthorYearWord citation key generator
├── zotero-adapter.ts  # Zotero Web API client (read/write items & collections)
├── matcher.ts         # Match bib entries to Zotero items (DOI + title)
├── tex-scanner.ts     # Scan .tex files for \cite{} keys
└── types.ts           # Shared TypeScript interfaces
```
