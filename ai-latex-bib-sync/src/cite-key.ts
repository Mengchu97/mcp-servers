const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "and", "to",
  "with", "from", "by", "at",
]);

function stripLatex(text: string): string {
  return text
    // Accent commands: \'{e}, \`{e}, \^{e}, \"{u}, \~{n}, etc.
    .replace(/\\[^a-zA-Z\s{]\{([^}]*)\}/g, "$1")
    // Braced accent forms: {\`e}, {\'e}, etc.
    .replace(/\{\\[^a-zA-Z\s{]([^}]*)\}/g, "$1")
    // \command{arg} → arg  (e.g. \textbf{word})
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1")
    // Remaining \commands
    .replace(/\\[a-zA-Z]+/g, "")
    // Braces
    .replace(/[{}]/g, "")
    // Unicode diacritics → base letter
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function extractFirstAuthorLastName(author: string): string {
  if (!author) return "";

  const firstAuthor = author.split(/\s+and\s+/i)[0].trim();

  let lastName: string;
  if (firstAuthor.includes(",")) {
    // "Last, First" format
    lastName = firstAuthor.split(",")[0].trim();
  } else {
    // "First Last" format — take the last token
    const parts = firstAuthor.split(/\s+/);
    lastName = parts[parts.length - 1];
  }

  return capitalizeFirst(stripLatex(lastName).replace(/[^a-zA-Z]/g, ""));
}

function extractYear(year: string): string {
  if (!year) return "";
  const match = year.match(/\d{4}/);
  return match ? match[0] : "";
}

function extractFirstSignificantWord(title: string): string {
  if (!title) return "";

  const clean = stripLatex(title);
  const words = clean.split(/[\s:;,!?.\-–—/\\()]+/).filter((w) => w.length > 0);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (!STOP_WORDS.has(lower) && /[a-zA-Z]/.test(word)) {
      return capitalizeFirst(word.replace(/[^a-zA-Z]/g, ""));
    }
  }

  // Fallback: first word
  return words.length > 0 ? capitalizeFirst(words[0].replace(/[^a-zA-Z]/g, "")) : "";
}

export function generateCiteKey(entry: {
  author?: string;
  year?: string;
  title?: string;
}): string {
  const lastName = extractFirstAuthorLastName(entry.author ?? "");
  const year = extractYear(entry.year ?? "");
  const word = extractFirstSignificantWord(entry.title ?? "");

  return `${lastName}${year}${word}`;
}

export function normalizeCiteKey(key: string): string {
  return key.toLowerCase();
}
