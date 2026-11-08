import {
  BULK_EXTRACT_BUDGET_MS, BULK_MAX_FILE_BYTES, BULK_MAX_IMAGE_PIXELS, BULK_MAX_OCR_ATTEMPTS, BULK_MAX_OCR_PAGES, BULK_MAX_PDF_PAGES,
  BULK_OCR_MAX_SIDE, BulkIntakeError, OcrTimeoutError, detectName, type BulkFileKind,
} from './cv-bulk.ts';
import { MAX_CV_LENGTH, readDocxBufferForBulk, validateCvText } from './cv-text.ts';

/** OCR of one image. `timeoutMs` bounds waiting + recognition; on expiry it rejects with OcrTimeoutError. */
export type OcrFn = (image: Buffer, options?: { timeoutMs?: number }) => Promise<{ text: string; confidence: number }>;
export type ExtractOptions = { deadline?: number };

/** Minimum OCR quality: below this the scan is reported instead of analysed. */
const MIN_OCR_CONFIDENCE = 55;
const MIN_TEXT_CHARS = 40;
/** A PDF page with less text than this in its text layer is treated as a scan. */
const MIN_PAGE_TEXT_CHARS = 20;
/** A sparse text layer can be just a header over a scanned CV: inspect large embedded images. */
const SPARSE_PAGE_TEXT_MAX_CHARS = 240;
const MIN_SCAN_IMAGE_PIXELS = 350_000;
/** pdf-parse 2.4.5 can indefinitely await inline-image operands in getImage(). */
const PDF_IMAGE_INSPECTION_MAX_MS = 1_500;
/** Raw text this long cannot become a valid CV even after whitespace clean-up: rejected without any regex work. */
const MAX_RAW_TEXT = MAX_CV_LENGTH * 8;

const visibleLength = (text: string) => { let n = 0; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 32) n++; return n; };

/** A mixed PDF containing more than one plausible identity is unsafe for automatic redaction.
 * Only the opening lines are considered; long work-history sections can contain unrelated names.
 * False positives fail closed and require the candidate to provide a complete text PDF/DOCX. */
function hasConflictingHeaderNames(ocrText: string): boolean {
  const names = new Set<string>();
  // detectName treats professional headlines (e.g. "Java Developer") as fallback only.
  // Give each line the same real-name context as the complete CV, so a job title
  // does not become a second identity while another genuine name is still rejected.
  const reference = detectName(ocrText);
  const referenceLine = reference ? `${reference.first} ${reference.last}` : null;
  for (const line of ocrText.split('\n').slice(0, 15)) {
    for (const section of line.split(/[,;|]+/)) {
      const prefix = section.split(/\b(?:tel\.?|telefon|e-?mail)\b/i)[0]?.trim() ?? '';
      const identity = detectName(referenceLine ? `${prefix}\n${referenceLine}` : prefix);
      if (identity) {
        names.add(`${identity.first} ${identity.last}`.toLocaleLowerCase('pl'));
        if (names.size > 1) return true;
      }
    }
  }
  return false;
}

// Linear clean-up only: every step is a single pass (no backtracking regex on candidate-controlled runs of spaces).
function finish(text: string, ocrTried = false) {
  // Never truncate silently: a shortened CV would be analysed and grouped as if complete.
  if (text.length > MAX_RAW_TEXT) throw new BulkIntakeError('too_large');
  const lines = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').split('\n');
  const normalized = lines.map(line => line.trimEnd()).join('\n').trim();
  if (visibleLength(normalized) < MIN_TEXT_CHARS) throw new BulkIntakeError(ocrTried ? 'unreadable_scan' : 'no_text');
  if (normalized.length > MAX_CV_LENGTH) throw new BulkIntakeError('too_large');
  try { return validateCvText(normalized); }
  catch { throw new BulkIntakeError('no_text'); }
}

function remaining(deadline: number) {
  const left = deadline - Date.now();
  if (left <= 0) throw new BulkIntakeError('ocr_timeout');
  return left;
}

/**
 * OCR with the per-file time budget. Null only for a blank page (nothing found) or a confident short read;
 * real text read with low confidence fails the file as an unreadable scan instead of being dropped,
 * so a CV is never analysed with a silently missing page.
 */
async function ocrRead(ocr: OcrFn, image: Buffer, deadline: number) {
  let result;
  try { result = await ocr(image, { timeoutMs: remaining(deadline) }); }
  catch (error) {
    if (error instanceof OcrTimeoutError) throw new BulkIntakeError('ocr_timeout');
    throw error; // runtime failure: transient, the browser may retry
  }
  const text = result.text.trim();
  const visible = visibleLength(text);
  // A page is blank when OCR found nothing, or only noise without any word-like run. Words read with
  // low confidence mean an unreadable scan: the file fails instead of losing that page silently.
  if (visible === 0) return null;
  // Scanner specks, borders or a decorative band read as '|', '—', '~': no word-like run, still blank.
  const wordLike = new RegExp('[\\p{L}\\p{N}]{3,}', 'u').test(text);
  if (visible < MIN_PAGE_TEXT_CHARS && !wordLike) return null;
  if (result.confidence < MIN_OCR_CONFIDENCE) throw new BulkIntakeError('unreadable_scan');
  // A confident short word may be the entire qualification on a page (e.g. "SQL"
  // or "Prawo jazdy B"). Discarding it would silently feed an incomplete CV to AI.
  // Bare page numbers/punctuation were already classified as blank above.
  return text;
}

const isPng = (b: Buffer) => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Pixel size from the PNG IHDR or the JPEG SOFn header, without decoding. Null when absent or malformed. */
export function imageDimensions(b: Buffer): { width: number; height: number } | null {
  if (isPng(b)) {
    if (b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (!isJpeg(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame header
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** Rejects images above the pixel cap; downscales the rest so the long side is at most BULK_OCR_MAX_SIDE. */
async function imageForOcr(bytes: Buffer) {
  const size = imageDimensions(bytes);
  if (!size || !size.width || !size.height) throw new BulkIntakeError('bad_format');
  if (size.width * size.height > BULK_MAX_IMAGE_PIXELS) throw new BulkIntakeError('too_large');
  const scale = BULK_OCR_MAX_SIDE / Math.max(size.width, size.height);
  if (scale >= 1) return bytes;
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  let image;
  try { image = await loadImage(bytes); } catch { throw new BulkIntakeError('bad_format'); }
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return canvas.toBuffer('image/png');
}

/** Render scale for OCR: about 144 dpi, never more than BULK_OCR_MAX_SIDE px on the long side. */
export function ocrRenderScale(width: number, height: number) {
  const long = Math.max(width, height);
  if (!Number.isFinite(long) || long <= 0) return null;
  return Math.min(2, BULK_OCR_MAX_SIDE / long);
}

async function readPdf(bytes: Buffer, ocr: OcrFn, deadline: number) {
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BulkIntakeError('bad_format');
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false,
    disableFontFace: true, stopAtErrors: true, verbosity: 0, maxImageSize: BULK_MAX_IMAGE_PIXELS });
  let ocrUsed = false;
  let ocrTried = false;
  try {
    let total: number;
    try { total = (await parser.getInfo()).total; }
    catch { throw new BulkIntakeError('protected_pdf'); } // password-protected or damaged
    if (total < 1 || total > BULK_MAX_PDF_PAGES) throw new BulkIntakeError('too_large');
    const pages: string[] = [];
    let attempts = 0, ocrPages = 0;
    for (let page = 1; page <= total; page++) {
      let text: string;
      try { text = (await parser.getText({ partial: [page], pageJoiner: '', parseHyperlinks: false })).pages[0]?.text.trim() ?? ''; }
      catch { throw new BulkIntakeError('protected_pdf'); } // damaged content stream
      // A short text layer can be only a digitally printed header over a rasterized CV.
      // Check for a substantial image without extracting its bytes; decorative small images
      // do not turn a normal text PDF into an OCR job.
      const pageTextLength = visibleLength(text);
      let mixedScan = false;
      if (pageTextLength >= MIN_PAGE_TEXT_CHARS && pageTextLength < SPARSE_PAGE_TEXT_MAX_CHARS) {
        // pdf-parse 2.4.5 resolves inline-image objects as names; for inline images
        // the lookup can remain pending forever. Time-bound inspection and, on timeout,
        // force OCR of the full page instead of accepting a potentially incomplete header.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const imageCheck = parser.getImage({
            partial: [page], imageThreshold: 300, imageBuffer: false, imageDataUrl: false,
          });
          const timeout = new Promise<null>(resolve => {
            timer = setTimeout(() => resolve(null), Math.min(remaining(deadline), PDF_IMAGE_INSPECTION_MAX_MS));
          });
          const embedded = await Promise.race([imageCheck, timeout]);
          mixedScan = embedded === null || (embedded.pages[0]?.images ?? []).some(image =>
            image.width >= 800 && image.height >= 300 &&
            image.width * image.height >= MIN_SCAN_IMAGE_PIXELS);
        } catch { throw new BulkIntakeError('protected_pdf'); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
      // Near-empty pages also need OCR. Never silently accept a header when the
      // image containing the rest of the CV could not be read.
      if (pageTextLength < MIN_PAGE_TEXT_CHARS || mixedScan) {
        // Out of OCR runs: the page cannot be read, so the file fails rather than losing a page silently.
        if (attempts >= BULK_MAX_OCR_ATTEMPTS) throw new BulkIntakeError('unreadable_scan');
        attempts++;
        ocrTried = true;
        remaining(deadline);
        let scale: number | null;
        try {
          const info = await parser.getInfo({ parsePageInfo: true, partial: [page] });
          scale = ocrRenderScale(info.pages[0]?.width ?? 0, info.pages[0]?.height ?? 0);
        } catch { throw new BulkIntakeError('protected_pdf'); }
        if (scale === null) continue;
        // Rendering/OCR runtime failures are not the file's fault: they propagate as transient errors.
        const shot = await parser.getScreenshot({ partial: [page], scale, imageBuffer: true, imageDataUrl: false });
        const data = shot.pages[0]?.data;
        const read = data?.length ? await ocrRead(ocr, Buffer.from(data), deadline) : null;
        // Require exact preservation of the digital layer in a full-page OCR result.
        // Joining two readings can leave an alternative spelling of a candidate's name
        // unredacted, so an inconsistent result is rejected rather than sent to AI.
        if (mixedScan && (read === null || visibleLength(read) <= pageTextLength ||
          !read.includes(text) || hasConflictingHeaderNames(read))) {
          throw new BulkIntakeError('unreadable_scan');
        }
        if (read !== null) {
          if (++ocrPages > BULK_MAX_OCR_PAGES) throw new BulkIntakeError('unreadable_scan');
          text = read;
          ocrUsed = true;
        }
      }
      pages.push(text);
    }
    return { text: finish(pages.join('\n\n'), ocrTried && !ocrUsed), ocrUsed };
  } finally {
    await parser.destroy();
  }
}

/** Text of one bulk CV file. Errors carry a reason code shown to the operator. */
export async function extractBulkCv(bytes: Buffer, kind: BulkFileKind, ocr: OcrFn, options: ExtractOptions = {}): Promise<{ text: string; ocrUsed: boolean }> {
  const deadline = options.deadline ?? Date.now() + BULK_EXTRACT_BUDGET_MS;
  if (!bytes.length) throw new BulkIntakeError('no_text');
  if (bytes.length > BULK_MAX_FILE_BYTES) throw new BulkIntakeError('too_large');
  switch (kind) {
    case 'pdf': return readPdf(bytes, ocr, deadline);
    case 'docx': {
      if (bytes.subarray(0, 2).toString('latin1') !== 'PK') throw new BulkIntakeError('bad_format');
      let text: string;
      try { text = await readDocxBufferForBulk(bytes, BULK_MAX_FILE_BYTES); }
      catch { throw new BulkIntakeError('bad_format'); }
      return { text: finish(text), ocrUsed: false };
    }
    case 'txt': {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new BulkIntakeError('bad_format'); }
      return { text: finish(text), ocrUsed: false };
    }
    case 'image': {
      if (!isPng(bytes) && !isJpeg(bytes)) throw new BulkIntakeError('bad_format');
      const text = await ocrRead(ocr, await imageForOcr(bytes), deadline);
      if (text === null) throw new BulkIntakeError('unreadable_scan');
      return { text: finish(text, true), ocrUsed: true };
    }
    default: throw new BulkIntakeError('bad_format');
  }
}
