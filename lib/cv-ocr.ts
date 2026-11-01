import path from 'node:path';
import os from 'node:os';

// Local OCR only: Tesseract (WASM) with the Polish model bundled from npm.
// The image never leaves the server process; no external OCR service is called.

type OcrWorker = { recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };
let workerPromise: Promise<OcrWorker> | null = null;

// Bundlers rewrite require.resolve to module ids, so the model is located from
// the app root (Vercel: /var/task, with the file traced by next.config.mjs).
function langPath() {
  return process.env.CV_OCR_LANG_PATH || path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'pol', '4.0.0');
}

async function worker(): Promise<OcrWorker> {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    // cacheMethod 'none': the bundled model is read from node_modules, nothing is written or downloaded.
    return createWorker('pol', 1, { langPath: langPath(), cachePath: os.tmpdir(), gzip: true, cacheMethod: 'none' }) as Promise<OcrWorker>;
  })().catch(error => { workerPromise = null; throw error; });
  return workerPromise;
}

export type OcrResult = { text: string; confidence: number };

/** Serialised per process: one Tesseract worker, one image at a time. */
let queue: Promise<unknown> = Promise.resolve();
export function ocrImage(image: Buffer): Promise<OcrResult> {
  const job = queue.then(async () => {
    const result = await (await worker()).recognize(image);
    return { text: result.data.text ?? '', confidence: Number(result.data.confidence) || 0 };
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Ends the Tesseract worker (tests and graceful shutdown). */
export async function closeOcr() {
  const current = workerPromise;
  workerPromise = null;
  if (current) await (await current).terminate();
}
