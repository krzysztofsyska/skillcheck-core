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
// Worker-only requires (tesseract.js/src/worker-script/**) are not followed by nft: assert them explicitly.
for(const required of ['pdf.worker.mjs','@napi-rs/canvas/index.js','tesseract.js/src/index.js','tesseract.js/src/worker-script/node/index.js',
  'tesseract.js/src/worker-script/node/getCore.js','tesseract.js/src/worker-script/index.js',
  // Cores tesseract.js 7.0.0 loads in Node (getCore picks by CPU features; never the "-lstm" files, see next.config.mjs).
  'tesseract.js-core/tesseract-core.js','tesseract.js-core/tesseract-core.wasm',
  'tesseract.js-core/tesseract-core-simd.js','tesseract.js-core/tesseract-core-simd.wasm',
  'tesseract.js-core/tesseract-core-relaxedsimd.js','tesseract.js-core/tesseract-core-relaxedsimd.wasm',
  'wasm-feature-detect/dist/cjs/index.cjs','bmp-js/index.js','bmp-js/lib/decoder.js','is-url/index.js','regenerator-runtime/runtime.js',
  '@tesseract.js-data/pol/4.0.0/pol.traineddata.gz']) {
 assert.ok(bulkFiles.some(file=>file.endsWith('/'+required)),`Missing bulk CV runtime dependency in Next output: ${required}`);
}
// Browser builds (*.wasm.js, ~26 MB) are never loaded by the node worker.
assert.ok(!bulkFiles.some(file=>file.endsWith('.wasm.js')),'Bulk CV route must not carry tesseract browser *.wasm.js builds');
for(const file of bulkFiles.filter(file=>/tesseract|wasm-feature-detect|bmp-js|is-url|regenerator-runtime/.test(file))) await access(resolve(dirname(bulk),file));
// OCR stays out of every other route (it costs ~20 MB per function).
const {readdir}=await import('node:fs/promises');
const traces=(await readdir(resolve('.next/server/app'),{recursive:true})).filter(file=>file.endsWith('.nft.json'));
const leaking=[];
for(const trace of traces) {
 if(resolve('.next/server/app',trace)===bulk) continue;
 const traced=JSON.parse(await readFile(resolve('.next/server/app',trace),'utf8')).files;
 if(traced.some(file=>/tesseract/.test(file))) leaking.push(trace);
}
assert.deepEqual(leaking,[],'Tesseract OCR files are traced into routes other than the bulk CV upload route');
// The OCR model is located from the app root at runtime, never via require.resolve (bundlers rewrite it).
assert.doesNotMatch(await readFile("lib/cv-ocr.ts","utf8"),/require\.resolve\(/);
console.log('Bulk CV OCR runtime dependencies are present in the Next deployment manifest.');
