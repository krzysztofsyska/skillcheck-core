/**
 * Verification against the immutable, human-reviewed CV snapshot only.
 * Normalization is limited to whitespace and typographic quotation marks.
 * The returned offsets are UTF-16 indices into the ORIGINAL source and the
 * returned quote is the original substring (required by the existing DB guard).
 */
const quoteCharacters: Record<string, string> = {
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '«': '"', '»': '"', '‘': "'", '’': "'", '‚': "'", '‛': "'",
};

function normalizeWithOffsets(source: string) {
  let normalized = '';
  const offsets: { start: number; end: number }[] = [];
  for (let index = 0; index < source.length;) {
    const symbol = source[index];
    if (/\s/.test(symbol)) {
      const start = index;
      while (index < source.length && /\s/.test(source[index])) index++;
      if (normalized.length && normalized[normalized.length - 1] !== ' ') {
        normalized += ' ';
        offsets.push({ start, end: index });
      }
    } else {
      normalized += quoteCharacters[symbol] ?? symbol;
      offsets.push({ start: index, end: index + 1 });
      index++;
    }
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    offsets.pop();
  }
  return { normalized, offsets };
}

export type VerifiedSnapshotQuote = {
  start: number;
  end: number;
  quote: string;
  document_id: string;
};

export function verifySnapshotQuotes(source: string, documentId: string, quotes: readonly string[]): VerifiedSnapshotQuote[] {
  if (!source.trim()) return [];
  const haystack = normalizeWithOffsets(source);
  const verified: VerifiedSnapshotQuote[] = [];
  for (const proposal of quotes.slice(0, 5)) {
    if (typeof proposal !== 'string' || !proposal.trim() || proposal.length > 2000) continue;
    const needle = normalizeWithOffsets(proposal).normalized;
    if (!needle) continue;
    const position = haystack.normalized.indexOf(needle);
    if (position < 0) continue;
    const start = haystack.offsets[position].start;
    const end = haystack.offsets[position + needle.length - 1].end;
    verified.push({ start, end, quote: source.slice(start, end), document_id: documentId });
  }
  return verified;
}
