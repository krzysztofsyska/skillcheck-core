import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {readCvInput,MAX_PDF_BYTES} from '../lib/cv-text.ts';
// Deterministic synthetic PDF fixtures; no real candidate data and no network.
function pdf(texts, compressed=false) {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const kids=[];
 for(const text of texts){
  const page=objects.length+1,content=page+1;kids.push(`${page} 0 R`);
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
  const commands=text?`BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g,'\\$&')}) Tj ET`:'';
  const stream=compressed?deflateSync(Buffer.from(commands)):Buffer.from(commands);
  objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} ${compressed?'/Filter /FlateDecode':''} >>\nstream\n`),stream,Buffer.from('\nendstream')]));
 }
 objects[1]=`<< /Type /Pages /Count ${texts.length} /Kids [${kids.join(' ')}] >>`;
 const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let length=chunks[0].length;
 objects.forEach((object,i)=>{offsets.push(length);const b=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),Buffer.isBuffer(object)?object:Buffer.from(object),Buffer.from('\nendobj\n')]);chunks.push(b);length+=b.length;});
 chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
 return Buffer.concat(chunks);
}
async function read(bytes,name='cv.pdf') {const form=new FormData();form.set('cv_file',new File([bytes],name,{type:'application/pdf'}));return readCvInput(form);}
test('real PDF parser extracts all pages in order, including compressed text streams',async()=>{
 const output=await read(pdf(['Anna Kowalska - SQL','Experience: customer support'],true));
 assert.match(output,/Anna Kowalska - SQL/);assert.match(output,/Experience: customer support/);
 assert.ok(output.indexOf('Anna')<output.indexOf('Experience'));
});
test('scans and mixed empty pages are not silently accepted as complete CVs',async()=>{
 await assert.rejects(read(pdf([''])),/warstwą tekstową/);
 await assert.rejects(read(pdf(['Valid text',''])),/warstwą tekstową/);
});
test('PDF intake rejects malformed, oversized, excessive-page and excessive-text documents',async()=>{
 await assert.rejects(read(Buffer.from('not a PDF')),/nagłówka/);
 await assert.rejects(read(Buffer.from('%PDF-1.4 broken')),/uszkodzony/);
 await assert.rejects(read(Buffer.alloc(MAX_PDF_BYTES+1)),/750 KB/);
 await assert.rejects(read(pdf(Array(21).fill('Text'))),/20 stron/);
 await assert.rejects(read(pdf(['x'.repeat(100001)],true)),/100 000/);
});
