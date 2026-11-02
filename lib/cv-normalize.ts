// Pure text normalisation shared by the browser bundle (lib/cv-bulk.ts) and the server redactor
// (lib/cv-text.ts). No imports: lib/cv-text.ts pulls Node-only parsers and must stay out of client code.
/**
 * Text form used for detecting and redacting personal data. Word/PDF exports hide digits and names
 * behind characters the patterns would not match: compatibility forms (full-width digits, ligatures),
 * invisible characters (soft hyphen, zero-width spaces/joiners, BOM) and horizontal Unicode spaces
 * (NBSP, thin, narrow). Line breaks and dashes stay (e.g. "2018–2024"); phone patterns accept Unicode
 * hyphens and dashes (Word's non-breaking hyphen) as separators instead.
 */
export function normalizeForRedaction(text: string) {
  return text.normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}
