import { parse, type Creator } from "@retorquere/bibtex-parser";
import { readFileSync } from "node:fs";
import type { BibEntry, BibFile } from "./types.js";

const CREATOR_FIELDS = new Set([
  "author",
  "bookauthor",
  "collaborator",
  "commentator",
  "director",
  "editor",
  "editora",
  "editorb",
  "editors",
  "holder",
  "scriptwriter",
  "translator",
]);

function creatorToString(creator: Creator): string {
  if (creator.name) return creator.name;
  const parts: string[] = [];
  if (creator.prefix && creator.useprefix) parts.push(creator.prefix);
  if (creator.firstName) parts.push(creator.firstName);
  if (creator.lastName) parts.push(creator.lastName);
  return parts.join(" ");
}

function fieldValueToString(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (CREATOR_FIELDS.has(key)) {
      return (value as Creator[]).map(creatorToString).join(" and ");
    }
    return (value as string[]).map(String).join(", ");
  }
  return String(value);
}

function convertFields(rawFields: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    const str = fieldValueToString(key, value);
    if (str !== undefined) result[key] = str;
  }
  return result;
}

function extractFirstAuthorLastName(rawFields: Record<string, unknown>): string | undefined {
  const author = rawFields.author;
  if (Array.isArray(author) && author.length > 0) {
    const first = author[0] as Creator;
    return first.lastName ?? first.name;
  }
  return undefined;
}

export function parseBibContent(content: string): BibFile {
  const library = parse(content, { raw: true });

  const entries: BibEntry[] = library.entries.map((entry) => {
    const raw = entry.fields as unknown as Record<string, unknown>;
    return {
      key: entry.key,
      type: entry.type,
      fields: convertFields(raw),
      doi: typeof raw.doi === "string" ? raw.doi : undefined,
      firstAuthorLastName: extractFirstAuthorLastName(raw),
      year: typeof raw.year === "string" ? raw.year : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
    };
  });

  return {
    path: "",
    entries,
    strings: library.strings,
    preamble: library.preamble,
    comments: library.comments,
    errors: library.errors.map((e) => e.error),
  };
}

export function parseBibFile(filePath: string): BibFile {
  const content = readFileSync(filePath, "utf-8");
  const result = parseBibContent(content);
  result.path = filePath;
  return result;
}
