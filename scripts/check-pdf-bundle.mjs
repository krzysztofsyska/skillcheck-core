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
