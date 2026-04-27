import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiteKeyCheckResult } from "./types.js";

const CITE_PATTERN =
  /\\(?:cite(?:author|alt|alp|p|t)?|textcite|autocite|parencite)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g;

function extractKeysFromContent(content: string): string[] {
  const keys: string[] = [];
  const pattern = new RegExp(CITE_PATTERN.source, CITE_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const keyList = match[1];
    for (const key of keyList.split(",")) {
      const trimmed = key.trim();
      if (trimmed) keys.push(trimmed);
    }
  }

  return keys;
}

export function scanCiteKeys(texFilePaths: string[]): {
  keys: string[];
  byFile: Map<string, string[]>;
} {
  const byFile = new Map<string, string[]>();
  const allKeys = new Set<string>();

  for (const filePath of texFilePaths) {
    const content = readFileSync(filePath, "utf-8");
    const fileKeys = extractKeysFromContent(content);
    const unique = [...new Set(fileKeys)].sort();
    byFile.set(filePath, unique);
    for (const key of unique) {
      allKeys.add(key);
    }
  }

  return {
    keys: [...allKeys].sort(),
    byFile,
  };
}

export function checkCiteKeys(
  texFilePaths: string[],
  bibKeys: string[],
): CiteKeyCheckResult {
  const { keys: citeKeys } = scanCiteKeys(texFilePaths);
  const bibKeySet = new Set(bibKeys);
  const citeKeySet = new Set(citeKeys);

  const valid = citeKeys.filter((k) => bibKeySet.has(k));
  const missing = citeKeys.filter((k) => !bibKeySet.has(k));
  const unused = bibKeys.filter((k) => !citeKeySet.has(k));

  return {
    valid: [...new Set(valid)].sort(),
    missing: [...new Set(missing)].sort(),
    unused: [...new Set(unused)].sort(),
    filesScanned: texFilePaths,
  };
}

export function findTexFiles(dirPath: string): string[] {
  const result: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".tex")) {
        result.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return result.sort();
}
