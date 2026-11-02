import path from 'node:path';
import os from 'node:os';
import { OcrTimeoutError } from './cv-bulk.ts';

// Local OCR only: Tesseract (WASM) with the Polish model bundled from npm.
// The image never leaves the server process; no external OCR service is called.

export type OcrWorker = { recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };
type WorkerFactory = () => Promise<OcrWorker>;

// Bundlers rewrite require.resolve to module ids, so the model is located from
// the app root (Vercel: /var/task, with the file traced by next.config.mjs).
function langPath() {
  return process.env.CV_OCR_LANG_PATH || path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'pol', '4.0.0');
}

const tesseractWorker: WorkerFactory = async () => {
  const { createWorker } = await import('tesseract.js');
  // cacheMethod 'none': the bundled model is read from node_modules, nothing is written or downloaded.
  return createWorker('pol', 1, { langPath: langPath(), cachePath: os.tmpdir(), gzip: true, cacheMethod: 'none' }) as Promise<OcrWorker>;
};

/** Longest single recognition; a stuck worker is killed and replaced after this. */
export const OCR_JOB_TIMEOUT_MS = 40_000;

let factory: WorkerFactory = tesseractWorker;
let workerPromise: Promise<OcrWorker> | null = null;

function worker(): Promise<OcrWorker> {
  if (!workerPromise) {
    const started: Promise<OcrWorker> = factory().catch(error => { if (workerPromise === started) workerPromise = null; throw error; });
    workerPromise = started;
  }
  return workerPromise;
}

/**
 * Drops the current worker (dead, stuck or failed) so the next job starts a fresh one. Termination
 * runs in the background: a worker that never finished starting must not block the OCR queue.
 */
function discard(current: Promise<OcrWorker> | null) {
  if (workerPromise === current) workerPromise = null;
  if (current) void current.then(w => w.terminate()).catch(() => undefined);
}

export type OcrResult = { text: string; confidence: number };

/**
 * Serialised per process: one Tesseract worker, one image at a time. `timeoutMs` covers the wait in
 * the queue and the recognition; on expiry the job rejects with OcrTimeoutError, and a recognition
 * that was running is aborted by terminating its worker (a new one is created for the next job).
 */
let queue: Promise<unknown> = Promise.resolve();
export function ocrImage(image: Buffer, options: { timeoutMs?: number } = {}): Promise<OcrResult> {
  // The deadline starts when the job is queued: waiting behind another request's image counts too.
  const deadline = Date.now() + Math.min(options.timeoutMs ?? OCR_JOB_TIMEOUT_MS, OCR_JOB_TIMEOUT_MS);
  let queuedTimer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  const queuedExpiry = new Promise<never>((_, reject) => {
    queuedTimer = setTimeout(() => { abandoned = true; reject(new OcrTimeoutError()); }, deadline - Date.now());
  });
  const job = queue.then(async () => {
    // The outer timer covers only the wait in the queue; once started, the inner timer applies and
    // discards a stuck worker before the caller sees the timeout.
    clearTimeout(queuedTimer);
    const left = deadline - Date.now();
    // Expired while queued (the caller already got the timeout; timers may fire a millisecond before
    // Date.now() reaches the deadline, so the flag decides, not the clock alone): never started.
    if (abandoned || left <= 0) throw new OcrTimeoutError();
    const current = worker();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OcrTimeoutError()), left); });
    try {
      const result = await Promise.race([current.then(w => w.recognize(image)), expired]);
      return { text: result.data.text ?? '', confidence: Number(result.data.confidence) || 0 };
    } catch (error) {
      // Timeout or worker failure: never reuse a worker that may be stuck or dead.
      discard(current);
      throw error;
    } finally { clearTimeout(timer); }
  });
  queue = job.catch(() => undefined);
  queuedExpiry.catch(() => undefined);
  return Promise.race([job, queuedExpiry]).finally(() => clearTimeout(queuedTimer));
}

/** Ends the Tesseract worker (tests and graceful shutdown). */
export async function closeOcr() {
  const current = workerPromise;
  workerPromise = null;
  // Bounded wait: a worker that never started is abandoned rather than awaited forever.
  if (current) await Promise.race([current.then(w => w.terminate()).catch(() => undefined), new Promise(r => setTimeout(r, 1000).unref?.())]);
}

/** Tests only: replace the worker factory (null restores Tesseract). */
export async function setOcrWorkerFactoryForTests(next: WorkerFactory | null) {
  await closeOcr();
  factory = next ?? tesseractWorker;
}
