// SC-BULK-001: shared bulk CV intake rules (browser + server, no secrets).

/** Max files per batch (ZIP contents count individually). */
export const BULK_MAX_FILES = 100;
/** Max size of one CV file. Below the 4.5 MB Vercel request body limit. */
export const BULK_MAX_FILE_BYTES = 4_000_000;
/** Max ZIP archive opened in the browser. */
export const BULK_MAX_ZIP_BYTES = 100_000_000;
/** Pages read from a PDF; scanned pages beyond the OCR cap are an error. */
export const BULK_MAX_PDF_PAGES = 20;
export const BULK_MAX_OCR_PAGES = 6;
/** Hard cap on OCR runs per PDF (near-blank pages that yield nothing still cost an attempt). */
export const BULK_MAX_OCR_ATTEMPTS = 10;
/** Largest image accepted for OCR (pixels); bigger photos/scans are reported as too large. */
export const BULK_MAX_IMAGE_PIXELS = 25_000_000;
/** Long side (px) of the image handed to OCR; larger inputs are downscaled first. */
export const BULK_OCR_MAX_SIDE = 2500;
/** Server time for reading one file (upload route maxDuration is 60 s). */
export const BULK_EXTRACT_BUDGET_MS = 45_000;
/** Parallel uploads from one browser tab: text files (DOCX/TXT) and files that may need OCR (PDF/images). */
export const BULK_UPLOAD_CONCURRENCY = 2;
export const BULK_OCR_UPLOAD_CONCURRENCY = 1;

/** Files that may need OCR on the server (slow): uploaded one at a time. */
export const bulkMayNeedOcr = (kind: BulkFileKind) => kind === 'pdf' || kind === 'image';

/**
 * Bulk intake reserves package slots and queues AI analyses. When the AI analysis is switched off
 * (SCREENING_AI_ENABLED != 'true') queued files would never start and the slots would stay held,
 * so no batch may be created. Returns the message shown to the recruiter, or null when allowed.
 */
export function bulkIntakeBlocked(aiEnabled: boolean) {
  return aiEnabled ? null : 'Analiza AI jest teraz wyłączona, więc nie można wgrać paczki CV. Pakiet nie został naruszony. Spróbuj ponownie później.';
}

export type BulkFileKind = 'pdf' | 'docx' | 'txt' | 'image' | 'other';
export type BulkPhase = 'awaiting_upload' | 'queued' | 'analyzing' | 'done' | 'error';
export type BulkErrorReason = 'over_limit' | 'unreadable_scan' | 'protected_pdf' | 'bad_format' | 'too_large'
  | 'no_text' | 'ocr_timeout' | 'duplicate' | 'not_uploaded' | 'analysis_failed' | 'not_eligible';
export type BulkGroup = 'passed' | 'review' | 'rejected';

export function bulkFileKind(name: string): BulkFileKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.txt')) return 'txt';
  if (/\.(?:jpe?g|png)$/.test(lower)) return 'image';
  return 'other';
}

/** Archive entries that are not CVs (folders, OS metadata) are skipped, not counted. */
export function isIgnoredZipEntry(name: string) {
  const base = name.split('/').pop() ?? '';
  return !base || name.endsWith('/') || name.startsWith('__MACOSX/') || base.startsWith('.') || base === 'Thumbs.db';
}

export function displayFileName(name: string) {
  const base = (name.split(/[\\/]/).pop() ?? name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'plik').slice(0, 255);
}

export const statusLabel: Record<BulkPhase, string> = {
  awaiting_upload: 'oczekuje', queued: 'oczekuje', analyzing: 'przetwarzanie', done: 'gotowe', error: 'błąd',
};

export const errorLabel: Record<BulkErrorReason, string> = {
  over_limit: 'poza limitem pakietu — nie przetworzono',
  unreadable_scan: 'nieczytelny skan',
  protected_pdf: 'zabezpieczony lub uszkodzony PDF',
  bad_format: 'zły format pliku',
  too_large: 'plik, obraz lub tekst CV za duży (max 4 MB, 25 mln pikseli, 100 000 znaków)',
  ocr_timeout: 'odczyt skanu trwał za długo — wgraj CV jako tekstowy PDF lub DOCX',
  no_text: 'brak tekstu w pliku',
  duplicate: 'duplikat kandydata w tej rekrutacji',
  not_uploaded: 'plik nie został wysłany',
  analysis_failed: 'analiza AI nie powiodła się (miejsce wróciło do pakietu)',
  not_eligible: 'nie można uruchomić analizy (rekrutacja lub stanowisko zmienione)',
};

export const groupLabel: Record<BulkGroup, string> = {
  passed: 'Przeszli sito', review: 'Do decyzji rekrutera', rejected: 'Nie spełniają kryteriów',
};

export type BulkFileErrorReason = Exclude<BulkErrorReason, 'over_limit' | 'duplicate' | 'not_uploaded' | 'analysis_failed' | 'not_eligible'>;

/** OCR could not finish within the time left for this file. */
export class OcrTimeoutError extends Error {
  constructor() { super('ocr_timeout'); this.name = 'OcrTimeoutError'; }
}
export class BulkIntakeError extends Error {
  readonly reason: BulkFileErrorReason;
  constructor(reason: BulkFileErrorReason) {
    super(reason);
    this.reason = reason;
  }
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const INTL_PHONE = /(?<![\d+])(?:\+|00)(?!48)[1-9]\d{0,3}(?:[ \t.-]?\(?\d{1,4}\)?){2,6}(?!\d)/g;
const PHONE = /(?<![\d+])(?:\+|00)?(?:48[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?)?\d{3}[\s.-]?\d{2,3}[\s.-]?\d{2,3}(?!\d)/g;
const HEADING = /\b(?:cv|curriculum|vitae|życiorys|zyciorys|resume|résumé|dane|kontakt|osobowe|profil|o mnie|doświadczenie|wykształcenie|umiejętności|telefon|e-?mail|adres|stanowisko|kandydat)\b/i;
const NAME_WORD = /^[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+(?:-[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+)?$/;
const UPPER_WORD = /^[A-ZĄĆĘŁŃÓŚŹŻ]{2,}(?:-[A-ZĄĆĘŁŃÓŚŹŻ]{2,})?$/;
const titleCase = (w: string) => w.split('-').map(p => p.charAt(0) + p.slice(1).toLowerCase()).join('-');

export function detectEmail(text: string) {
  const match = text.match(EMAIL)?.[0]?.toLowerCase();
  return match && match.length <= 254 ? match : null;
}

/** Polish-first phone detection; returns +48XXXXXXXXX or an international +digits number. */
export function detectPhone(text: string) {
  // Non-Polish international numbers first (+44 7700 900123, +49 151 12345678): the Polish-shaped pattern below would cut
  // them. Separators never cross a line break, so a year on the next line is not glued to the number.
  for (const match of Array.from(text.matchAll(INTL_PHONE))) {
    const intl = match[0].replace(/\D/g, '').replace(/^00/, '');
    if (intl.length >= 10 && intl.length <= 15) return '+' + intl;
  }
  for (const match of Array.from(text.matchAll(PHONE))) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    // Skip dates, postal codes and identifiers (e.g. PESEL has 11 digits without a prefix).
    if (/^\d{4}[.-]\d{2}[.-]\d{2}$/.test(raw.trim())) continue;
    if (/^(?:\+|00)/.test(raw)) {
      const intl = digits.replace(/^00/, '');
      if (intl.length >= 10 && intl.length <= 15) return '+' + intl;
      continue;
    }
    if (digits.length === 11 && digits.startsWith('48')) return '+' + digits;
    if (digits.length === 9 && /^[4-9]/.test(digits)) return '+48' + digits;
  }
  return null;
}

/** First line that looks like "Imię Nazwisko" (2-3 capitalised words) in the top of the CV. */
export function detectName(text: string): { first: string; last: string } | null {
  const lines = text.split('\n').map(l => l.replace(/[|•·,;:]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15);
  for (const line of lines) {
    if (HEADING.test(line) || /\d|@/.test(line)) continue;
    const words = line.split(' ');
    if (words.length < 2 || words.length > 3) continue;
    const normalized = words.every(w => UPPER_WORD.test(w)) ? words.map(titleCase) : words;
    if (!normalized.every(w => NAME_WORD.test(w))) continue;
    return { first: normalized[0], last: normalized.slice(1).join(' ') };
  }
  return null;
}

export type BulkExtraction = {
  first_name: string; last_name: string; email: string | null; phone: string | null;
  source_text: string; redacted_text: string; name_detected: boolean; ocr_used: boolean;
};

/** Candidate identity for the database; no name -> neutral placeholder with the file position. */
export function buildExtraction(text: string, position: number, ocrUsed: boolean,
  redact: (text: string, names: string[]) => string): BulkExtraction {
  const name = detectName(text);
  const email = detectEmail(text);
  const phone = detectPhone(text);
  const first = name?.first ?? 'Kandydat';
  const last = name?.last ?? `nr ${position}`;
  const names = name ? [name.first, ...name.last.split(' ')] : [];
  return {
    first_name: first.slice(0, 100), last_name: last.slice(0, 100), email, phone,
    source_text: text, redacted_text: redact(text, names), name_detected: !!name, ocr_used: ocrUsed,
  };
}

export type BulkFileMeta = { name: string; kind: BulkFileKind; size: number };

export function validateBatchFiles(files: BulkFileMeta[]) {
  if (!Array.isArray(files) || files.length < 1) throw new Error('Wybierz co najmniej jeden plik CV.');
  if (files.length > BULK_MAX_FILES) throw new Error(`Jedna paczka może mieć maksymalnie ${BULK_MAX_FILES} plików.`);
  return files.map(f => ({ name: displayFileName(String(f.name ?? '')), kind: bulkFileKind(String(f.name ?? '')),
    size: Math.max(0, Math.min(Number.isFinite(f.size) ? Math.floor(f.size) : 0, 2_147_483_647)) }));
}

export type BulkPricing = { input_per_mtok: string; cached_input_per_mtok: string; output_per_mtok: string; currency: string; version: string };

const decimal = (value: string | undefined) => value && /^\d{1,6}(?:\.\d{1,6})?$/.test(value.trim()) ? value.trim() : null;
/** Provider list prices per 1M tokens, from configuration (never hard-coded guesses). */
export function bulkPricing(env: Record<string, string | undefined> = process.env): BulkPricing | null {
  const input = decimal(env.CV_AI_PRICE_INPUT_PER_MTOK), output = decimal(env.CV_AI_PRICE_OUTPUT_PER_MTOK);
  if (!input || !output) return null;
  const currency = /^[A-Z]{3}$/.test(env.CV_AI_PRICE_CURRENCY ?? '') ? env.CV_AI_PRICE_CURRENCY! : 'USD';
  return { input_per_mtok: input, output_per_mtok: output, cached_input_per_mtok: decimal(env.CV_AI_PRICE_CACHED_INPUT_PER_MTOK) ?? input,
    currency, version: (env.CV_AI_PRICE_VERSION ?? 'env').slice(0, 80) };
}

export type BulkNotify = {
  batch_id: string; recruitment_id: string; company_id: string; email: string | null; recruitment_name: string | null;
  files: number; done: number; errors: number; passed: number; review: number; rejected: number;
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Batch summary e-mail. Counts only: no candidate names or CV content leave the app. */
export function bulkEmail(n: BulkNotify, origin: string) {
  const link = `${origin}/dashboard/${n.company_id}/recruitments/${n.recruitment_id}/bulk/${n.batch_id}`;
  const subject = `SkillCheck: paczka CV gotowa (${n.done} z ${n.files})`;
  const lines = [
    `Zakończyliśmy przetwarzanie paczki CV w rekrutacji „${n.recruitment_name ?? ''}”.`, '',
    `Pliki w paczce: ${n.files}`, `Przeanalizowane CV: ${n.done}`, `Przeszli sito: ${n.passed}`,
    `Do decyzji rekrutera: ${n.review}`, `Nie spełniają kryteriów: ${n.rejected}`, `Błędy i pliki poza limitem: ${n.errors}`, '',
    `Wyniki: ${link}`, '',
    'Podział na grupy to propozycja systemu. Ostateczną decyzję o każdym kandydacie podejmuje rekruter.',
  ];
  const html = `<p>${lines.filter(l => l && !l.startsWith('Wyniki:')).map(esc).join('<br>')}</p><p><a href="${esc(link)}">Otwórz wyniki paczki</a></p>`;
  return { subject, text: lines.join('\n'), html, link };
}

export function bulkMailEnabled(env: Record<string, string | undefined> = process.env) {
  return env.CV_BULK_MAIL_ENABLED === 'true' && Boolean(env.RESEND_API_KEY);
}

export async function sendBulkEmail(n: BulkNotify, origin: string, apiKey: string, fetcher: typeof fetch = fetch) {
  if (!n.email) return 'skipped' as const;
  const mail = bulkEmail(n, origin);
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': `cv-bulk-${n.batch_id}` },
    body: JSON.stringify({ from: 'SkillCheck <pomoc@skillcheck.pl>', to: [n.email], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  return response.ok ? 'sent' as const : 'failed' as const;
}
