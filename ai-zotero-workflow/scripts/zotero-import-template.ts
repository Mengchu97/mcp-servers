// scripts/zotero-import-template.ts
import fs from "fs";
import path from "path";

// === Configuration ===
// Can be overridden via command-line arguments
const SEARCH_QUERY = process.argv[2] || "Diffusion Models";
const MAX_RESULTS = parseInt(process.argv[3] || "10", 10);
const TARGET_COLLECTION = process.argv[4] || "AI_Auto_Imports";
const ARXIV_ONLY = process.argv.includes("--arxiv-only");
// =============================

const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY;
const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID;
const API_BASE = `https://api.zotero.org/users/${ZOTERO_USER_ID}`;

// Local PDF storage directory (recommend using an absolute path)
const PDF_DIR = path.join(process.cwd(), "zotero_pdfs");
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

async function apiRequest(method: string, endpoint: string, body: any = null) {
  const url = `${API_BASE}${endpoint}`;
  const opts: any = { method, headers: { "Zotero-API-Key": ZOTERO_API_KEY, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`API Error ${method} ${endpoint}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ensureCollection(name: string) {
    const res = await apiRequest("GET", "/collections");
    const existing = res.find((c: any) => c.data.name === name);
    if (existing) return existing.data.key;
    const createRes = await apiRequest("POST", "/collections", [{ name }]);
    return createRes.successful["0"].key;
}

async function downloadPdf(url: string, filename: string) {
    url = url.replace(/^http:/, "https:"); 
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const filepath = path.join(PDF_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(buffer));
    return filepath;
}

// Core logic: Fetch full metadata and multi-source PDFs from Semantic Scholar (official first, arXiv fallback)
async function searchPapers(query: string, limit: number, arxivOnly: boolean) {
    // Request all advanced fields we need (including external IDs, venue names, and OA PDF links)
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit * 2}&fields=paperId,title,externalIds,url,abstract,year,publicationDate,citationCount,authors,openAccessPdf,venue,journal,publicationTypes`;
    
    let rawData;
    for (let i = 0; i < 5; i++) {
        const res = await fetch(url);
        if (res.ok) { rawData = await res.json(); break; }
        if (res.status === 429) {
            console.log("  S2 Rate limited, waiting 5s...");
            await new Promise(r => setTimeout(r, 5000));
        } else {
            throw new Error(`S2 Error: ${res.status}`);
        }
    }
    if (!rawData) throw new Error("Failed to fetch from S2");

    const papers = [];
    for (const p of rawData.data) {
        // Filter logic
        const isArxiv = p.venue === "arXiv" || p.externalIds?.ArXiv;
        if (arxivOnly && !isArxiv) continue; // Skip non-arXiv papers when arXiv-only mode is on

        // PDF source extraction (important)
        let pdfUrl = null;
        let pdfSourceType = "None";

        // 1. Prefer official Open Access (OA)
        if (!arxivOnly && p.openAccessPdf?.url) {
            pdfUrl = p.openAccessPdf.url;
            pdfSourceType = "Official OA";
        } 
        // 2. Fallback: if no official free PDF but has arXiv ID, construct arXiv PDF link
        else if (p.externalIds?.ArXiv) {
            pdfUrl = `https://arxiv.org/pdf/${p.externalIds.ArXiv}.pdf`;
            pdfSourceType = "arXiv Fallback";
        }
        
        // If no downloadable PDF and we strictly require it, could skip or save metadata only
        // (Here we tolerate missing PDFs — they are skipped during the download step)

        papers.push({
            ...p,
            pdfUrl,
            pdfSourceType,
            // Determine if this is an officially published paper (Journal / Conference)
            isOfficial: !!(p.journal?.name && p.venue !== "arXiv")
        });

        if (papers.length >= limit) break; // Reached the requested number of results
    }
    return papers;
}

async function main() {
  if (!ZOTERO_API_KEY || !ZOTERO_USER_ID) {
      throw new Error("Missing ZOTERO_API_KEY or ZOTERO_USER_ID environment variables.");
  }

  console.log(`Searching S2 for '${SEARCH_QUERY}' (Max: ${MAX_RESULTS}, ArXiv Only: ${ARXIV_ONLY})...`);
  const papers = await searchPapers(SEARCH_QUERY, MAX_RESULTS, ARXIV_ONLY);
  if (papers.length === 0) return console.log("No papers found.");

  const collectionKey = await ensureCollection(TARGET_COLLECTION);
  console.log(`Target Collection: '${TARGET_COLLECTION}' (Key: ${collectionKey})`);

  let successCount = 0;
  for (const paper of papers) {
      console.log(`\nProcessing: "${paper.title}"`);
      console.log(`  Source: ${paper.isOfficial ? "Official Journal/Venue" : "Preprint/ArXiv"}`);
      console.log(`  PDF Link: ${paper.pdfSourceType}`);

      const safeTitle = paper.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
      const pdfFilename = `${paper.isOfficial ? "Official" : "ArXiv"}_${paper.paperId.substring(0,6)}_${safeTitle}.pdf`;
      
      let localPath = null;
      if (paper.pdfUrl) {
          try {
              console.log(`  Downloading PDF from ${paper.pdfUrl}...`);
              localPath = await downloadPdf(paper.pdfUrl, pdfFilename);
          } catch (err: any) {
              console.log(`  [Skip] Failed to download PDF: ${err.message}`);
          }
      } else {
          console.log(`  [Skip] No valid OpenAccess or arXiv PDF found.`);
      }

      // 1. Build parent item metadata based on priority
      const parentItem: any = {
          itemType: paper.isOfficial ? "journalArticle" : "preprint",
          title: paper.title,
          abstractNote: paper.abstract || "",
          date: paper.publicationDate || paper.year?.toString() || "",
          url: paper.url,
          extra: paper.externalIds?.ArXiv ? `ArXiv: ${paper.externalIds.ArXiv}\n` : "",
          collections: [collectionKey],
          creators: (paper.authors || []).map((a: any) => {
              const parts = a.name.trim().split(/\s+/);
              if (parts.length <= 1) return { creatorType: "author", name: a.name };
              return { creatorType: "author", firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
          })
      };

      // Extra fields for officially published papers
      if (paper.isOfficial) {
          parentItem.publicationTitle = paper.journal?.name || paper.venue;
          if (paper.journal?.volume) parentItem.volume = paper.journal.volume;
          if (paper.externalIds?.DOI) parentItem.DOI = paper.externalIds.DOI;
      } else if (paper.externalIds?.ArXiv) {
          parentItem.repository = "arXiv";
      }

      try {
          // 2. Submit the parent item
          const parentRes = await apiRequest("POST", "/items", [parentItem]);
          const parentKey = parentRes.successful["0"]?.key;
          if (!parentKey) throw new Error("Parent item creation failed.");

          // 3. Attach local file link
          if (localPath) {
              const attachItem = {
                  itemType: "attachment",
                  linkMode: "linked_file",
                  title: `Full Text PDF (${paper.pdfSourceType})`,
                  parentItem: parentKey,
                  path: localPath,
                  contentType: "application/pdf"
              };
              const attachRes = await apiRequest("POST", "/items", [attachItem]);
              if (attachRes.successful["0"]) console.log(`  Success! Parent ID: ${parentKey}, PDF Linked.`);
          } else {
              console.log(`  Success! Parent ID: ${parentKey} (Metadata only)`);
          }
          successCount++;
      } catch (err: any) {
          console.log(`  [Error] Sync to Zotero failed: ${err.message}`);
      }
  }
  console.log(`\nImport Complete: ${successCount}/${papers.length} papers successfully imported.`);
}

main().catch(console.error);
