# ai-latex-bib-sync

MCP server for **bidirectional sync** between BibTeX (.bib) files and Zotero.

## Core Mechanism

Your academic writing workflow involves two sources of truth:

- **BibTeX .bib files** — version-controlled (git submodule), used by LaTeX for compilation. Each project has its own .bib file (e.g., `spca.bib`, `deflection.bib`).
- **Zotero library** — the complete bibliography database, organized into collections. Zotero holds more entries than any single .bib file.

This server keeps them in sync. It matches entries by **DOI (exact)** first, then by **title (fuzzy, Jaccard ≥ 0.85)** to detect duplicates. Only unmatched entries are imported/exported, so nothing is duplicated.

### How Matching Works

1. **DOI match** — If both the .bib entry and a Zotero item have the same DOI (after normalization), they are considered the same paper.
2. **Title match** — If no DOI match is found, titles are lowercased, split into word sets, and compared via Jaccard similarity. A threshold of 0.85 handles minor formatting differences (e.g., `{Phase retrieval}` vs `Phase Retrieval`).

### Citation Key Format

Keys follow `AuthorYearWord` — first author's last name + year + first significant title word:

| Paper | Generated Key |
|-------|--------------|
| Avolio, A. P. (2010) "Arterial blood pressure..." | `Avolio2010Arterial` |
| Zou, Hui (2006) "Sparse principal component analysis" | `Zou2006Sparse` |
| Xu, Mengchu (2024) "Exponential Spectral Pursuit..." | `Xu2024Exponential` |

Articles and prepositions (a, an, the, of, in, on, etc.) are skipped when selecting the first significant word.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOTERO_API_KEY` | Yes | Zotero Web API key. Get one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). |
| `ZOTERO_USER_ID` | Yes | Your Zotero user ID (numeric). |
| `ZOTERO_LOCAL_PORT` | No | Local Zotero connector port (default: `23119`) |

## MCP Client Configuration

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

## Tools

| Tool | Description |
|------|-------------|
| `sync_bib_to_zotero` | Import .bib entries into a Zotero collection (skips duplicates) |
| `sync_zotero_to_bib` | Export Zotero collection to a .bib file (append or overwrite) |
| `diff_bib_zotero` | Compare a .bib file with a Zotero collection |
| `check_cite_keys` | Scan .tex files for missing/unused citation keys |
| `generate_cite_key` | Generate an `AuthorYearWord` citation key |

## AI Prompt Templates

When you want AI to manage your bibliography, **send a prompt like the following** — the AI will use the MCP tools to execute:

### Check your LaTeX project for broken citations

> *"Check my .tex files in [project directory] against [bib file path] for missing citation keys. Report any \cite{} references that don't exist in the .bib file, and any .bib entries that are never cited."*

### Sync a .bib file to Zotero (dry run first)

> *"Compare [bib file path] with my Zotero collection '[collection name]'. Show me what would be imported (dry run), then import the new entries."*

### Pull new papers from Zotero into your .bib

> *"Export any papers in my Zotero collection '[collection name]' that are not already in [bib file path]. Append them to the .bib file."*

### Diff your .bib against Zotero

> *"Compare [bib file path] with Zotero collection '[collection name]'. Show me: which entries are matched by DOI, which by title, which only exist in the .bib, and which only exist in Zotero."*

### Generate a citation key for a new paper

> *"Generate a citation key for: author='[author names]', year='[year]', title='[paper title]'."*

### Full workflow: write a paper, then sync

> *"I just added 3 new references to my .bib file at [path]. Sync them into my Zotero collection '[name]'. Also check my .tex files in [directory] for any missing citation keys."*
