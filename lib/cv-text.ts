export const MAX_CV_LENGTH = 100000;
export const MAX_CV_BYTES = 200000;
export const MAX_PDF_BYTES = 750000;
export const MAX_PDF_PAGES = 20;

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
    if (!file.name.toLowerCase().endsWith(".txt") || file.size > MAX_CV_BYTES) throw new Error("Dodaj TXT UTF-8 do 200 KB albo PDF do 750 KB. DOCX nie jest jeszcze obsługiwany.");
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error("Zapisz plik TXT w kodowaniu UTF-8 i spróbuj ponownie."); }
    return validateCvText(decoded);
  }
  return validateCvText(pasted);
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
