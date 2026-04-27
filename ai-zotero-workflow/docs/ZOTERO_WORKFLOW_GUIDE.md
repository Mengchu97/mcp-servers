# Zotero Import Workflow Guide

## Core Mechanism

This guide describes a battle-tested workflow for automated literature retrieval with full-text PDF support and seamless import into your Zotero library. It addresses two key pain points:

1. **Bypassing Zotero cloud storage limits**: Uploading items with PDFs directly can easily trigger the 300MB free-tier quota (`413 File would exceed quota`). Our workflow uses a `linked_file` strategy: metadata syncs to the Zotero cloud, while PDFs are downloaded to your local disk (never uploaded to Zotero Cloud) and attached as local file links in the Zotero client.
2. **Guaranteed metadata quality**: Instead of the unreliable browser Connector, everything goes through the Zotero Web API. We use a "Two-Step" approach: first create a clean parent item (the literature entry), then attach a child item (the PDF file link).

## Search Logic: Official Venue/Journal First, arXiv Fallback

Our default code template (see `scripts/zotero-import-template.ts`) is built on the **Semantic Scholar (S2) API**, because S2 aggregates multiple sources for a single paper. The code enforces a strict priority order:

1. **Default Mode (Official First)**:
   - Check if the paper has an official publication venue (Journal / Conference). If so, the item type is set to a standard Journal Article or Conference Paper.
   - Extract full metadata including the official DOI.
   - Attempt to fetch the official Open Access PDF via `openAccessPdf`.
   - **Fallback strategy**: If the paper hasn't been officially published yet, or the official OA PDF is unavailable, but S2 has an associated arXiv ID, it automatically falls back to the arXiv version — stored as a preprint with the arXiv PDF downloaded.

2. **arXiv-Only Mode**:
   - If you explicitly request "arXiv only" in your prompt, the script filters to only arXiv preprints and downloads arXiv PDFs exclusively.

## AI Prompt Templates

When you want AI to perform a literature import task, **send a prompt like the following** — the AI will understand and execute using the template code:

> *"Using the workflow in `ai-zotero-workflow/docs/ZOTERO_WORKFLOW_GUIDE.md` and its companion template, search for [count, e.g. 10] recent high-quality papers on [topic, e.g. Large Language Models Alignment]. Prioritize papers published in top venues (e.g. NeurIPS, ICLR). Download open-access PDFs and import them into my Zotero collection '[collection name, e.g. LLM_Align]'. If no official OA PDF is available, use the arXiv version instead."*

For arXiv-only mode:

> *"Using the logic in `ai-zotero-workflow/scripts/zotero-import-template.ts`, fetch 10 arXiv-only preprints on [topic], including locally-linked PDFs, and save them to Zotero collection '[collection name]'."*
