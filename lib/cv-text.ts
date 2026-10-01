export const MAX_CV_LENGTH = 100000;
export const MAX_CV_BYTES = 200000;

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
    if (pasted.trim()) throw new Error("Wybierz jedną metodę: wklej tekst albo dodaj plik TXT.");
    if (!file.name.toLowerCase().endsWith(".txt") || file.size > MAX_CV_BYTES) throw new Error("Dodaj plik TXT UTF-8 o rozmiarze do 200 KB. PDF i DOCX nie są jeszcze obsługiwane.");
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
