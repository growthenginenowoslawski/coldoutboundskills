/**
 * Pure normalization helpers used for deduplication and clean storage.
 * No I/O, no dependencies — trivially testable.
 */

/** Common legal suffixes stripped from company names before comparison. */
const COMPANY_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "sa",
  "srl",
  "bv",
  "pty",
  "ag",
  "group",
  "holdings",
]);

/**
 * Reduce a URL or host to a bare, comparable domain:
 * "https://WWW.Acme.com/pricing?x=1" -> "acme.com".
 * Returns undefined for empty/garbage input.
 */
export function normalizeDomain(input?: string): string | undefined {
  if (!input) return undefined;
  let s = input.trim().toLowerCase();
  if (!s) return undefined;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  s = s.replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0]; // host only
  s = s.replace(/\.+$/, ""); // trailing dots
  return s.length ? s : undefined;
}

/**
 * Reduce a company name to a comparison key:
 * "Acme, Inc." and "ACME Incorporated" -> "acme".
 * Lowercases, strips accents, expands "&", drops punctuation and a single
 * trailing legal suffix.
 */
export function normalizeCompanyName(name: string): string {
  let s = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  const tokens = s.split(/\s+/).filter(Boolean);
  // Drop trailing legal suffixes (e.g. "acme inc" -> "acme"), keep at least one.
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ").trim();
}
