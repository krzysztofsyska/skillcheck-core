import {readFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
const path=resolve('.next/server/app/dashboard/[companyId]/candidates/[candidateId]/cv/page.js.nft.json');
const {files}=JSON.parse(await readFile(path,'utf8'));
for(const required of ['pdf-parse','pdf.worker.mjs','@napi-rs/canvas']) {
 assert.ok(files.some(file=>file.includes(required)),`Missing PDF runtime dependency in Next output: ${required}`);
}
assert.ok(files.some(file=>file.includes('@napi-rs/canvas-') && file.endsWith('.node')),'Missing native canvas binary for this build platform');
for(const file of files.filter(file=>file.includes('pdf.worker.mjs') || file.includes('@napi-rs/canvas'))) await access(resolve(dirname(path),file));
console.log('PDF runtime dependencies are present in the Next deployment manifest.');

// SC-BULK-001: bulk CV upload route needs PDF rendering + local Polish OCR at runtime
// (the preview E2E found OCR missing at runtime once; keep this traced).
const bulk=resolve('.next/server/app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/[batchId]/items/[itemId]/route.js.nft.json');
const bulkFiles=JSON.parse(await readFile(bulk,'utf8')).files;
for(const required of ['pdf.worker.mjs','@napi-rs/canvas','tesseract.js/src/worker-script/node/index.js','tesseract.js-core/tesseract-core-lstm.wasm','@tesseract.js-data/pol/4.0.0/pol.traineddata.gz']) {
 assert.ok(bulkFiles.some(file=>file.includes(required)),`Missing bulk CV runtime dependency in Next output: ${required}`);
}
for(const file of bulkFiles.filter(file=>file.includes('tesseract'))) await access(resolve(dirname(bulk),file));
// The OCR model is located from the app root at runtime, never via require.resolve (bundlers rewrite it).
assert.doesNotMatch(await readFile("lib/cv-ocr.ts","utf8"),/require\.resolve\(/);
console.log('Bulk CV OCR runtime dependencies are present in the Next deployment manifest.');
