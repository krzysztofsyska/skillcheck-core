import { normalizeForRedaction } from "./cv-normalize.ts";
export { normalizeForRedaction };
export const MAX_CV_LENGTH = 100000;
export const MAX_CV_BYTES = 200000;
export const MAX_PDF_BYTES = 750000;
export const MAX_PDF_PAGES = 20;
export const MAX_DOCX_BYTES = 750000;
export const MAX_DOCX_ENTRY_BYTES = 2000000;
export const MAX_DOCX_EXPANDED_BYTES = 10000000;
export const MAX_DOCX_ENTRIES = 500;

export function validateCvText(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.length > MAX_CV_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized)) {
    throw new Error("Wpisz tekst CV (do 100 000 znaków, bez danych binarnych).");
  }
  return normalized;
}

export async function readCvInput(form: FormData) {
  const value = form.get("source_text");
  const pasted = typeof value === "string" ? value : "";
  const file = form.get("cv_file");
  if (file instanceof File && file.size > 0) {
    if (pasted.trim()) throw new Error("Wybierz jedną metodę: wklej tekst albo dodaj plik.");
    if (file.name.toLowerCase().endsWith(".pdf")) return readPdfText(file);
    if (file.name.toLowerCase().endsWith(".docx")) return readDocxText(file);
    if (!file.name.toLowerCase().endsWith(".txt") || file.size > MAX_CV_BYTES) throw new Error("Dodaj TXT UTF-8 do 200 KB albo PDF lub DOCX do 750 KB.");
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error("Zapisz plik TXT w kodowaniu UTF-8 i spróbuj ponownie."); }
    return validateCvText(decoded);
  }
  return validateCvText(pasted);
}

class DocxIntakeError extends Error {}

// Inspect actual decompressed bytes before the document parser opens the ZIP.
// Nothing is extracted onto disk, and no candidate-controlled URL is fetched.
async function validateDocxArchive(bytes: Buffer, options: { headerFooterText?: string[]; maxEntryBytes?: number } = {}) {
  const maxEntry = options.maxEntryBytes ?? MAX_DOCX_ENTRY_BYTES;
  const { fromBuffer } = await import('yauzl');
  const { default: JSZip } = await import('jszip');
  const clean = new JSZip();
  await new Promise<void>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      let finished = false;
      let total = 0;
      let count = 0;
      const names = new Set<string>();
      const fail = (reason: Error) => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(reason);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (finished) return;
        if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
          fail(new DocxIntakeError('Plik nie zawiera dokumentu DOCX.')); return;
        }
        finished = true;
        zip.close();
        resolve();
      });
      zip.on('entry', (entry: import('yauzl').Entry) => {
        if (finished) return;
        count++;
        const name = entry.fileName;
        if (count > MAX_DOCX_ENTRIES || entry.uncompressedSize > maxEntry || total + entry.uncompressedSize > MAX_DOCX_EXPANDED_BYTES) {
          fail(new DocxIntakeError('DOCX jest zbyt złożony lub zbyt duży po rozpakowaniu. Wklej tekst CV.')); return;
        }
        if (names.has(name) || name.split('/').some(part => part === '.' || part === '..') || /[\x00-\x1f]/.test(name) || entry.isEncrypted() || /(?:vbaProject\.bin|\/embeddings\/)/i.test(name)) {
          fail(new DocxIntakeError('DOCX zawiera niedozwoloną strukturę, szyfrowanie lub osadzony program. Wklej tekst CV.')); return;
        }
        names.add(name);
        // Raw-text conversion does not include these document sections. Bulk intake
        // reads their plain text itself (contact data often sits in a CV header).
        const sideSection = /^word\/(?:header|footer|footnotes|endnotes).*\.xml$/i.test(name);
        if (sideSection && !options.headerFooterText) {
          fail(new DocxIntakeError('DOCX zawiera nagłówki, stopki lub przypisy, których nie odczytujemy. Wklej pełny tekst CV albo dodaj tekstowy PDF.')); return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError ?? new Error('Missing ZIP stream')); return; }
          let size = 0;
          const xml = /\.(?:xml|rels)$/i.test(name);
          const chunks: Buffer[] = [];
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            total += chunk.length;
            if (size > maxEntry || total > MAX_DOCX_EXPANDED_BYTES) {
              stream.destroy();
              fail(new DocxIntakeError('DOCX przekracza limit rozpakowanych danych. Wklej tekst CV.'));
            } else chunks.push(chunk);
          });
          stream.on('end', () => {
            if (finished) return;
            const content = Buffer.concat(chunks);
            if (xml) {
              try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
                if (/\u0000|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('Unsupported XML');
                if (sideSection && options.headerFooterText) options.headerFooterText.push(docxSectionText(text));
              } catch {
                fail(new DocxIntakeError('DOCX zawiera nieobsługiwany zapis XML. Wklej tekst CV.')); return;
              }
            }
            clean.file(name, content);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
  // The parser receives a rebuilt archive, preventing discrepancies between ZIP readers.
  return clean.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

// Plain text of a header/footer part: paragraph breaks, <w:t> runs, XML entities.
// Single forward scan over the tags (indexOf only), so crafted input cannot cause regex backtracking.
export function docxSectionText(xml: string) {
  const decode = (value: string) => value.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf('<', i);
    if (open < 0) break;
    const close = xml.indexOf('>', open + 1);
    if (close < 0) break;
    const tag = xml.slice(open + 1, close);
    i = close + 1;
    if (tag === '/w:p') { lines.push(line); line = ''; continue; }
    // <w:t> or <w:t attr="..."> (not <w:tab/>, <w:tbl>, self-closing <w:t/>): text runs up to the next tag.
    if ((tag === 'w:t' || /^w:t\s/.test(tag)) && !tag.endsWith('/')) {
      const next = xml.indexOf('<', i);
      if (next < 0) break;
      if (xml.startsWith('</w:t>', next)) { line += decode(xml.slice(i, next)); i = next + 6; }
    }
  }
  lines.push(line);
  return lines.map(l => l.trim()).filter(Boolean).join('\n');
}

/** Bulk intake: larger files, header/footer text kept. Same archive checks otherwise. */
export async function readDocxBufferForBulk(bytes: Buffer, maxBytes: number) {
  if (!bytes.length || bytes.length > maxBytes) throw new DocxIntakeError('too_large');
  const sections: string[] = [];
  const checked = await validateDocxArchive(bytes, { headerFooterText: sections });
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: checked });
  const text = [...sections.filter(Boolean), result.value.trim()].filter(Boolean).join('\n\n');
  return text;
}
export { DocxIntakeError, PdfIntakeError };

export async function readDocxText(file: File) {
  if (!file.size || file.size > MAX_DOCX_BYTES) throw new DocxIntakeError('Dodaj DOCX o rozmiarze do 750 KB.');
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const checked = await validateDocxArchive(bytes);
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: checked });
    if (result.messages.length) throw new DocxIntakeError('Nie udało się odczytać wszystkich elementów DOCX. Wklej pełny tekst CV albo dodaj tekstowy PDF.');
    if (!result.value.trim()) throw new DocxIntakeError('DOCX nie zawiera odczytywalnego tekstu. Wklej tekst CV; obrazów i skanów nie odczytujemy.');
    if (result.value.trim().length > MAX_CV_LENGTH) throw new DocxIntakeError('Tekst CV przekracza 100 000 znaków. Skróć dokument.');
    return validateCvText(result.value);
  } catch (error) {
    if (error instanceof DocxIntakeError) throw error;
    throw new DocxIntakeError('Nie udało się odczytać DOCX. Plik może być uszkodzony lub chroniony hasłem. Wklej tekst CV.');
  }
}

// Suggestions only: addresses, dates, inflections and indirect identifiers need human review.

const NUMBER_TAG = "[TELEFON / IDENTYFIKATOR]";
/**
 * A run of digits and separators: 9–15 digits is a phone or identifier. A longer run can be several
 * numbers side by side (columns separated by a tab or wide spacing): each part is judged on its own,
 * and a part that is still longer than 15 digits (IBAN, card number) is redacted as a whole.
 */
// A date, year or month.year (optionally day.month.year) — "2019", "01.2019", "1.01.2019", "2019.01.31".
const DATE_TOKEN = String.raw`(?:\d{1,2}[./]){0,2}\d{4}(?:[./]\d{1,2}){0,2}`;
// Runs made only of dates joined by dashes, spaces or tabs are employment periods, not identifiers:
// "01.2019 – 12.2022", "2015–2018 2019–2022", "2012 2013 2014". They stay visible for the analysis.
// The separator is unambiguous (either a dash with optional spaces, or spaces/tabs only) and runs longer
// than 120 characters are never dates, so the check stays linear on crafted input.
const DATE_RUN = new RegExp(String.raw`^${DATE_TOKEN}(?:(?:[ \t]*[-\u2010-\u2015\u2212][ \t]*|[ \t]+)${DATE_TOKEN})*$`);
const isDateRun = (run: string) => run.length <= 120 && DATE_RUN.test(run.trim())
  && (run.match(/\d{4}/g) ?? []).every(y => +y >= 1940 && +y <= 2099);

function redactNumberRun(match: string): string {
  const digits = match.replace(/\D/g, "").length;
  if (digits < 9) return match;
  if (isDateRun(match)) return match;
  if (digits <= 15) return NUMBER_TAG;
  const parts = match.split(/(\t| {2,})/);
  if (parts.length === 1) return NUMBER_TAG;
  // Split only into whole numbers (9+ digits) or employment periods; a phone written with wide spacing
  // ("500  123  456") would otherwise fall apart into short visible groups, so it is redacted whole.
  const pieces = parts.filter(part => !/^(\t| {2,})$/.test(part) && /\d/.test(part));
  if (!pieces.every(part => part.replace(/\D/g, "").length >= 9 || isDateRun(part))) return NUMBER_TAG;
  return parts.map(part => /^(\t| {2,})$/.test(part) ? part : redactNumberRun(part)).join("");
}

export function suggestRedaction(text: string, names: string[]) {
  // Word/PDF exports often separate phone digits with non-breaking spaces; without this the number
  // would not match and would stay unredacted.
  // Normalise first, then validate: compatibility forms can make the text longer than the limit.
  let output = validateCvText(normalizeForRedaction(text));
  output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[E-MAIL]");
  output = output.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, "[LINK]");
  output = output.replace(/(?<!\d)\+?\d[\d \t().\-\u2010-\u2015\u2212]{7,}\d(?!\d)/g, redactNumberRun);
  // Names are normalised the same way as the text, or "Anna\u00A0Maria" from the record would not match.
  for (const name of Array.from(new Set(names.map(n => normalizeForRedaction(n).trim()).filter(Boolean))).sort((a,b)=>b.length-a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp("(?<![\\p{L}\\p{N}])" + escaped + "(?![\\p{L}\\p{N}])", "giu"), "[DANE OSOBOWE]");
  }
  return output;
}

class PdfIntakeError extends Error {}

// Server-side text extraction only. Never load a candidate-supplied URL or render PDF scripts.
export async function readPdfText(file: File) {
  if (!file.size || file.size > MAX_PDF_BYTES) throw new PdfIntakeError("Dodaj PDF o rozmiarze do 750 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0,5)) !== "%PDF-") throw new PdfIntakeError("Plik nie ma prawidłowego nagłówka PDF.");
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({data:bytes,isEvalSupported:false,useWorkerFetch:false,useSystemFonts:false,disableFontFace:true,stopAtErrors:true,verbosity:0});
  try {
    const info = await parser.getInfo();
    if (info.total < 1 || info.total > MAX_PDF_PAGES) throw new PdfIntakeError("CV może zawierać od 1 do 20 stron. Dodaj krótszy PDF lub wklej tekst.");
    const pages: string[] = [];
    let length = 0;
    for (let page=1; page<=info.total; page++) {
      const result = await parser.getText({partial:[page],pageJoiner:'',parseHyperlinks:false});
      const text = result.pages[0]?.text.trim() ?? '';
      if (!text) throw new PdfIntakeError("Co najmniej jedna strona PDF nie zawiera odczytywalnego tekstu. Skanów nie odczytujemy — wklej pełny tekst CV lub dodaj PDF z warstwą tekstową.");
      length += text.length + (pages.length ? 2 : 0);
      if (length > MAX_CV_LENGTH) throw new PdfIntakeError("Tekst CV przekracza 100 000 znaków. Skróć dokument.");
      pages.push(text);
    }
    return validateCvText(pages.join('\n\n'));
  } catch (error) {
    if (error instanceof PdfIntakeError) throw error;
    throw new PdfIntakeError("Nie udało się odczytać PDF. Plik może być uszkodzony lub chroniony hasłem. Dodaj dostępny tekst CV.");
  } finally {
    await parser.destroy();
  }
}
