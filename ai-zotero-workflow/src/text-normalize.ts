/**
 * Text normalization utilities for Zotero metadata cleanup.
 * 
 * Two main operations:
 * 1. LaTeX brace cleaning — remove {} wrappers and convert accent commands to Unicode
 * 2. Sentence case conversion — with protection for acronyms, proper nouns, brands, etc.
 */

// === LATEX ACCENT MAP ===

const LATEX_ACCENT_MAP: Record<string, Record<string, string>> = {
  "\\`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
  "\\'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý" },
  "\\^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
  '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü", Y: "Ÿ" },
  "\\~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
  "\\c": { c: "ç", C: "Ç", s: "ş", S: "Ş", t: "ţ", T: "Ţ", e: "ę", E: "Ę", a: "ą", A: "Ą" },
  "\\r": { a: "å", A: "Å", u: "ů", U: "Ů" },
  "\\=": { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", A: "Ā", E: "Ē", I: "Ī", O: "Ō", U: "Ū" },
  "\\u": { a: "ă", e: "ĕ", g: "ğ", i: "ĭ", o: "ŏ", u: "ŭ", A: "Ă", E: "Ĕ", G: "Ğ", I: "Ĭ", O: "Ŏ", U: "Ŭ" },
  "\\v": { c: "č", s: "š", z: "ž", r: "ř", d: "ď", e: "ě", n: "ň", t: "ť", C: "Č", S: "Š", Z: "Ž", R: "Ř", D: "Ď", E: "Ě", N: "Ň", T: "Ť" },
  "\\H": { o: "ő", u: "ű", O: "Ő", U: "Ű" },
  "\\.": { z: "ż", Z: "Ż", c: "ċ", C: "Ċ", e: "ė", E: "Ė", g: "ġ", G: "Ġ", i: "ı", I: "İ" },
};

const LATEX_SPECIAL_COMMANDS: Record<string, string> = {
  "\\o": "ø", "\\O": "Ø", "\\ss": "ß", "\\ae": "æ", "\\AE": "Æ",
  "\\oe": "œ", "\\OE": "Œ", "\\aa": "å", "\\AA": "Å",
  "\\l": "ł", "\\L": "Ł", "\\i": "ı", "\\j": "ȷ",
};

/**
 * Resolve LaTeX accent commands to Unicode characters.
 * Handles: {\`e} → è, {\'{e}} → é, \`{e} → è, \'e → é, {\ss} → ß, etc.
 */
export function resolveLatexAccent(text: string): string {
  let result = text;
  const allAccentCmds = ["`", "'", "^", "~", '"', "=", ".", "c", "u", "v", "H", "d", "k", "b"];

  for (const cmdChar of allAccentCmds) {
    const cmd = `\\${cmdChar}`;
    const accentMap = LATEX_ACCENT_MAP[cmd];
    if (!accentMap) continue;

    const escapedCmd = cmdChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pattern 1: {\\cmd{X}} — double-braced
    const p1 = new RegExp(`\\{\\\\${escapedCmd}\\{([a-zA-Z])\\}\\}`, "g");
    result = result.replace(p1, (_match: string, letter: string) => accentMap[letter] || _match);

    // Pattern 2: \\cmd{X} — accent with braced letter
    const p2 = new RegExp(`\\\\${escapedCmd}\\{([a-zA-Z])\\}`, "g");
    result = result.replace(p2, (_match: string, letter: string) => accentMap[letter] || _match);

    // Pattern 3: {\\cmd X} — accent+letter inside braces
    const p3 = new RegExp(`\\{\\\\${escapedCmd}\\s*([a-zA-Z])\\}`, "g");
    result = result.replace(p3, (_match: string, letter: string) => accentMap[letter] || _match);

    // Pattern 4: \\cmd X — bare accent+letter
    const p4 = new RegExp(`\\\\${escapedCmd}([a-zA-Z])(?![a-zA-Z])`, "g");
    result = result.replace(p4, (_match: string, letter: string) => accentMap[letter] || _match);
  }

  // Standalone commands
  for (const [cmd, replacement] of Object.entries(LATEX_SPECIAL_COMMANDS)) {
    const escaped = cmd.replace(/\\/g, "\\\\");
    result = result.replace(new RegExp(`\\{${escaped}\\}`, "g"), replacement);
    result = result.replace(new RegExp(`${escaped}(?![a-zA-Z])`, "g"), replacement);
  }

  // {\AA} → Å
  result = result.replace(/\{\\AA\}/g, "Å");
  result = result.replace(/\{\\aa\}/g, "å");
  result = result.replace(/\\AA(?![a-zA-Z])/g, "Å");
  result = result.replace(/\\aa(?![a-zA-Z])/g, "å");

  return result;
}

/**
 * Clean LaTeX braces from a string.
 * 1. Resolve LaTeX accent commands to Unicode
 * 2. Remove remaining unnecessary braces
 */
export function cleanBraces(text: string): string {
  if (!text || typeof text !== "string") return text;
  if (!text.includes("{")) return text;

  let result = resolveLatexAccent(text);

  // Remove single-letter braces: {W} → W
  result = result.replace(/\{([a-zA-Z])\}/g, "$1");

  // Remove multi-char braces: {word} → word
  result = result.replace(/\{([a-zA-Z0-9][a-zA-Z0-9 \-']*)\}/g, "$1");

  // Multiple passes for nested braces
  let prev = "";
  let passes = 0;
  while (prev !== result && passes < 5) {
    prev = result;
    result = result.replace(/\{([a-zA-Z0-9][a-zA-Z0-9 \-']*)\}/g, "$1");
    passes++;
  }

  // One more accent pass after brace removal
  result = resolveLatexAccent(result);
  result = result.replace(/\{([a-zA-Z])\}/g, "$1");

  return result;
}

/**
 * Remove ALL curly braces from a string, keeping only inner content.
 * Used for abstractNote and similar fields.
 */
export function removeBraces(text: string): string {
  if (!text || typeof text !== "string") return text;
  if (!text.includes("{")) return text;

  let result = text;
  let prev = "";
  let passes = 0;
  while (prev !== result && passes < 20) {
    prev = result;
    result = result.replace(/\{([^{}]*)\}/g, "$1");
    passes++;
  }
  return result;
}

/**
 * Check if a string would be modified by cleanBraces.
 */
export function needsBraceCleaning(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  if (!text.includes("{")) return false;
  return cleanBraces(text) !== text;
}

// === SENTENCE CASE ===

// Default protection lists
const DEFAULT_ACRONYMS = new Set([
  "PCA", "SPCA", "PLS", "CCA", "mCCA", "fMRI", "FMRI", "CT",
  "ADMM", "BM3D", "GESPAR", "PDMM", "PGPAL", "SIMO", "NIST",
  "LASSO", "RED", "CNN", "PPG", "EM", "UPR", "FASTA", "LSUN",
  "AI", "III", "II", "IV", "PRGAMP", "MNIST", "IT",
]);

const DEFAULT_PROPER_NOUNS = new Set([
  "Fourier", "Wirtinger", "Shannon", "Bayes", "Gauss", "Newton",
  "Peaceman", "Rachford", "Fienup", "Dirichlet", "Lamb",
  "Hadamard", "Poisson", "Laplace", "Markov", "Erdős",
  "Gerchberg", "Saxton", "McDonald", "Adam", "Rényi",
]);

const DEFAULT_CAPITALIZED_TERMS = new Set([
  "Gaussian", "Fourier", "Wirtinger", "Shannon", "Bayesian",
  "Poisson", "Laplacian", "Markovian", "Erdős-Rényi",
  "Peaceman-Rachford", "Gauss-Newton", "Gerchberg-Saxton",
]);

const DEFAULT_INSTITUTIONS = new Set(["IT'IS"]);

export interface SentenceCaseOptions {
  extraAcronyms?: string[];
  extraProperNouns?: string[];
  extraCapitalizedTerms?: string[];
  extraInstitutions?: string[];
}

function isProtected(
  word: string,
  acronyms: Set<string>,
  institutions: Set<string>,
): boolean {
  if (!word) return false;
  const clean = word.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, "");
  if (!clean) return false;

  if (institutions.has(clean) || institutions.has(word)) return true;
  if (acronyms.has(clean)) return true;

  // All-caps alphanum acronyms (2+ chars)
  if (/^[A-Z0-9]{2,}$/.test(clean) && /[A-Z]/.test(clean)) return true;
  if (/^[A-Z]$/.test(clean)) return true;

  // CamelCase
  if (clean.length > 1 && /[a-z]/.test(clean) && /[A-Z]/.test(clean) && /^.[a-z]*[A-Z]/.test(clean)) return true;

  // Hyphenated with protected parts
  if (clean.includes("-")) {
    for (const p of clean.split("-")) {
      if (/^[A-Z0-9]{2,}$/.test(p) && /[A-Z]/.test(p)) return true;
      if (/^[A-Z]$/.test(p)) return true;
      if (p.length > 1 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /^.[a-z]*[A-Z]/.test(p)) return true;
    }
  }

  return false;
}

function isProperNoun(
  word: string,
  properNouns: Set<string>,
  capitalizedTerms: Set<string>,
): boolean {
  const clean = word.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, "");
  if (!clean) return false;

  if (properNouns.has(clean)) return true;
  if (capitalizedTerms.has(clean)) return true;

  if (clean.includes("-")) {
    for (const p of clean.split("-")) {
      if (properNouns.has(p)) return true;
    }
  }

  return false;
}

function processWord(
  word: string,
  isFirst: boolean,
  afterColon: boolean,
  acronyms: Set<string>,
  properNouns: Set<string>,
  capitalizedTerms: Set<string>,
  institutions: Set<string>,
): string {
  const clean = word.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, "");
  if (!clean) return word;

  if (isProtected(word, acronyms, institutions)) return word;

  const leading = word.match(/^[^a-zA-Z']*/)?.[0] ?? "";
  const trailing = word.match(/[^a-zA-Z']*$/)?.[0] ?? "";
  const core = word.slice(leading.length, word.length - trailing.length);
  if (!core) return word;

  // Proper nouns — capitalize first letter, lowercase rest
  if (isProperNoun(clean, properNouns, capitalizedTerms)) {
    if (core.includes("-")) {
      const parts = core.split("-");
      const processedParts = parts.map(p =>
        isProtected(p, acronyms, institutions) || isProperNoun(p, properNouns, capitalizedTerms)
          ? p : p.toLowerCase()
      );
      return leading + processedParts.join("-") + trailing;
    }
    return leading + core[0].toUpperCase() + core.slice(1).toLowerCase() + trailing;
  }

  // First word or after colon
  if (isFirst || afterColon) {
    if (core.includes("-")) {
      const parts = core.split("-");
      parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase();
      for (let i = 1; i < parts.length; i++) {
        if (!isProtected(parts[i], acronyms, institutions) && !isProperNoun(parts[i], properNouns, capitalizedTerms)) {
          parts[i] = parts[i].toLowerCase();
        }
      }
      return leading + parts.join("-") + trailing;
    }
    return leading + core[0].toUpperCase() + core.slice(1).toLowerCase() + trailing;
  }

  // Regular word — lowercase
  if (core.includes("-")) {
    const parts = core.split("-");
    for (let i = 0; i < parts.length; i++) {
      if (!isProtected(parts[i], acronyms, institutions) && !isProperNoun(parts[i], properNouns, capitalizedTerms)) {
        parts[i] = parts[i].toLowerCase();
      }
    }
    return leading + parts.join("-") + trailing;
  }

  return leading + core.toLowerCase() + trailing;
}

/**
 * Convert a title to Sentence Case.
 * First word capitalized, rest lowercase, with protection for:
 * - Acronyms (PCA, BM3D, etc.)
 * - Proper nouns (Fourier, Wirtinger, etc.)
 * - CamelCase brands (PhasePack, ISTA-Net, etc.)
 * - Institutions (IT'IS)
 * - After colon: capitalize (subtitle rule)
 */
export function toSentenceCase(title: string, options?: SentenceCaseOptions): string {
  if (!title) return title;

  const acronyms = new Set([...DEFAULT_ACRONYMS, ...(options?.extraAcronyms ?? [])]);
  const properNouns = new Set([...DEFAULT_PROPER_NOUNS, ...(options?.extraProperNouns ?? [])]);
  const capitalizedTerms = new Set([...DEFAULT_CAPITALIZED_TERMS, ...(options?.extraCapitalizedTerms ?? [])]);
  const institutions = new Set([...DEFAULT_INSTITUTIONS, ...(options?.extraInstitutions ?? [])]);

  const tokens = title.split(/(\s+)/);
  const result: string[] = [];
  let isFirst = true;
  let afterColon = false;

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      result.push(token);
      continue;
    }

    const processed = processWord(token, isFirst, afterColon, acronyms, properNouns, capitalizedTerms, institutions);

    if (/:/.test(token) && !/:\/\//.test(token)) {
      afterColon = true;
    } else {
      afterColon = false;
    }

    result.push(processed);
    isFirst = false;
  }

  return result.join("");
}
