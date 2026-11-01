import { BULK_MAX_FILE_BYTES, BULK_MAX_OCR_PAGES, BULK_MAX_PDF_PAGES, BulkIntakeError, type BulkFileKind } from './cv-bulk.ts';
import { MAX_CV_LENGTH, readDocxBufferForBulk, validateCvText } from './cv-text.ts';

export type OcrFn = (image: Buffer) => Promise<{ text: string; confidence: number }>;

/** Minimum OCR quality: below this the scan is reported instead of analysed. */
const MIN_OCR_CONFIDENCE = 55;
const MIN_TEXT_CHARS = 40;

function finish(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  if (normalized.replace(/\s/g, '').length < MIN_TEXT_CHARS) throw new BulkIntakeError('no_text');
  try { return validateCvText(normalized.slice(0, MAX_CV_LENGTH)); }
  catch { throw new BulkIntakeError('no_text'); }
}

async function ocrChecked(ocr: OcrFn, image: Buffer) {
  const result = await ocr(image);
  if (result.confidence < MIN_OCR_CONFIDENCE || result.text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    throw new BulkIntakeError('unreadable_scan');
  }
  return result.text.trim();
}

const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

async function readPdf(bytes: Buffer, ocr: OcrFn) {
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BulkIntakeError('bad_format');
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false,
    disableFontFace: true, stopAtErrors: true, verbosity: 0 });
  let ocrUsed = false;
  try {
    let total: number;
    try { total = (await parser.getInfo()).total; }
    catch { throw new BulkIntakeError('protected_pdf'); } // password-protected or damaged
    if (total < 1 || total > BULK_MAX_PDF_PAGES) throw new BulkIntakeError('too_large');
    const pages: string[] = [];
    let scanned = 0;
    for (let page = 1; page <= total; page++) {
      const result = await parser.getText({ partial: [page], pageJoiner: '', parseHyperlinks: false });
      let text = result.pages[0]?.text.trim() ?? '';
      if (text.replace(/\s/g, '').length < 20) {
        // Scanned page: render it locally and OCR it.
        if (++scanned > BULK_MAX_OCR_PAGES) throw new BulkIntakeError('unreadable_scan');
        const shot = await parser.getScreenshot({ partial: [page], scale: 2, imageBuffer: true, imageDataUrl: false });
        const data = shot.pages[0]?.data;
        if (!data) throw new BulkIntakeError('unreadable_scan');
        text = await ocrChecked(ocr, Buffer.from(data));
        ocrUsed = true;
      }
      pages.push(text);
    }
    return { text: finish(pages.join('\n\n')), ocrUsed };
  } catch (error) {
    if (error instanceof BulkIntakeError) throw error;
    throw new BulkIntakeError('protected_pdf');
  } finally {
    await parser.destroy();
  }
}

/** Text of one bulk CV file. Errors carry a reason code shown to the operator. */
export async function extractBulkCv(bytes: Buffer, kind: BulkFileKind, ocr: OcrFn): Promise<{ text: string; ocrUsed: boolean }> {
  if (!bytes.length) throw new BulkIntakeError('no_text');
  if (bytes.length > BULK_MAX_FILE_BYTES) throw new BulkIntakeError('too_large');
  switch (kind) {
    case 'pdf': return readPdf(bytes, ocr);
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
      return { text: finish(await ocrChecked(ocr, bytes)), ocrUsed: true };
    }
    default: throw new BulkIntakeError('bad_format');
  }
}
