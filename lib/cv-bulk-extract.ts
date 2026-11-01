import {
  BULK_EXTRACT_BUDGET_MS, BULK_MAX_FILE_BYTES, BULK_MAX_IMAGE_PIXELS, BULK_MAX_OCR_ATTEMPTS, BULK_MAX_OCR_PAGES, BULK_MAX_PDF_PAGES,
  BULK_OCR_MAX_SIDE, BulkIntakeError, OcrTimeoutError, type BulkFileKind,
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
/** Raw text this long cannot become a valid CV even after whitespace clean-up: rejected without any regex work. */
const MAX_RAW_TEXT = MAX_CV_LENGTH * 8;

const visibleLength = (text: string) => { let n = 0; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 32) n++; return n; };

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
 * OCR with the per-file time budget. Null only for a blank page (almost no characters found);
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
  if (visibleLength(text) < MIN_PAGE_TEXT_CHARS) return null;
  if (result.confidence < MIN_OCR_CONFIDENCE) throw new BulkIntakeError('unreadable_scan');
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
      // Near-empty page: OCR it, within a hard cap on OCR runs. A page where OCR finds almost no
      // characters (a blank or decorative page) is kept as it is; a page with text OCR cannot read
      // reliably fails the file (ocrRead). Only the whole document must reach the minimum length.
      if (visibleLength(text) < MIN_PAGE_TEXT_CHARS && attempts < BULK_MAX_OCR_ATTEMPTS) {
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
