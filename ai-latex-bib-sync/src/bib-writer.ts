import { writeFileSync } from "node:fs";
import type { BibEntry, BibFile } from "./types.js";

function buildReverseStrings(strings: Record<string, string>): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [key, value] of Object.entries(strings)) {
    reverse.set(value, key);
  }
  return reverse;
}

function formatFieldValue(value: string, reverseStrings: Map<string, string>): string {
  const macroKey = reverseStrings.get(value);
  if (macroKey !== undefined) return macroKey;
  return `{${value}}`;
}

export function serializeEntry(entry: BibEntry, strings?: Record<string, string>): string {
  const reverseStrings = buildReverseStrings(strings ?? {});
  const fieldNames = Object.keys(entry.fields);

  if (fieldNames.length === 0) {
    return `@${entry.type}{${entry.key},\n}`;
  }

  const maxLen = Math.max(...fieldNames.map((n) => n.length));
  const padWidth = maxLen + 1;

  const lines: string[] = [`@${entry.type}{${entry.key},`];
  for (let i = 0; i < fieldNames.length; i++) {
    const name = fieldNames[i];
    const value = formatFieldValue(entry.fields[name], reverseStrings);
    lines.push(`  ${name.padEnd(padWidth)}= ${value},`);
  }
  lines.push("}");

  return lines.join("\n");
}

export function serializeEntries(entries: BibEntry[], strings?: Record<string, string>): string {
  return entries.map((e) => serializeEntry(e, strings)).join("\n\n");
}

export function writeBibFile(filePath: string, bibFile: BibFile): void {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(bibFile.strings)) {
    parts.push(`@string{${key} = "${value}"}`);
  }

  for (const preamble of bibFile.preamble) {
    parts.push(`@preamble{${preamble}}`);
  }

  for (const comment of bibFile.comments) {
    parts.push(`@comment{${comment}}`);
  }

  const entriesStr = serializeEntries(bibFile.entries, bibFile.strings);
  if (entriesStr.length > 0) {
    parts.push(entriesStr);
  }

  writeFileSync(filePath, parts.join("\n\n") + "\n", "utf-8");
}
