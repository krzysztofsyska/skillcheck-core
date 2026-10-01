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
async function validateDocxArchive(bytes: Buffer) {
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
        if (count > MAX_DOCX_ENTRIES || entry.uncompressedSize > MAX_DOCX_ENTRY_BYTES || total + entry.uncompressedSize > MAX_DOCX_EXPANDED_BYTES) {
          fail(new DocxIntakeError('DOCX jest zbyt złożony lub zbyt duży po rozpakowaniu. Wklej tekst CV.')); return;
        }
        if (names.has(name) || name.split('/').some(part => part === '.' || part === '..') || /[\x00-\x1f]/.test(name) || entry.isEncrypted() || /(?:vbaProject\.bin|\/embeddings\/)/i.test(name)) {
          fail(new DocxIntakeError('DOCX zawiera niedozwoloną strukturę, szyfrowanie lub osadzony program. Wklej tekst CV.')); return;
        }
        names.add(name);
        // Raw-text conversion does not include these document sections.
        if (/^word\/(?:header|footer|footnotes|endnotes).*\.xml$/i.test(name)) {
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
            if (size > MAX_DOCX_ENTRY_BYTES || total > MAX_DOCX_EXPANDED_BYTES) {
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
export function suggestRedaction(text: string, names: string[]) {
  let output = validateCvText(text);
  output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[E-MAIL]");
  output = output.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, "[LINK]");
  output = output.replace(/(?<!\d)\+?\d[\d ().-]{7,}\d(?!\d)/g, match => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 9 && digits.length <= 15 ? "[TELEFON / IDENTYFIKATOR]" : match;
  });
  for (const name of Array.from(new Set(names.map(n => n.trim()).filter(Boolean))).sort((a,b)=>b.length-a.length)) {
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
