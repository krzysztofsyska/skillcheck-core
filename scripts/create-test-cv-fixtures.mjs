// Synthetic documents for an explicitly authorized upload test; no real person.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';

const destination = resolve(process.argv[2] ?? '../artifacts/skillcheck-fixtures');
await mkdir(destination, { recursive: true });
const content = 'BT /F1 12 Tf 50 750 Td (SYNTHETIC CV - TEST ONLY) Tj 0 -24 Td (Experience: customer support and written communication.) Tj 0 -24 Td (Result: replies within one working day.) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
await writeFile(resolve(destination, 'synthetic-cv.pdf'), pdf);

const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>FIKCYJNE CV — TEST TECHNICZNY</w:t></w:r></w:p><w:p><w:r><w:t>Obsługa zgłoszeń klientów i komunikacja pisemna. Zażółć gęślą jaźń.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Rezultat: odpowiedź w jeden dzień roboczy.</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
await writeFile(resolve(destination, 'synthetic-cv.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('Created synthetic-cv.pdf and synthetic-cv.docx in ' + destination);
