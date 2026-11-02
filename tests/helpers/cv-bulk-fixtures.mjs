// Synthetic bulk CV fixtures (no real candidate data, no network).
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { createCanvas } from '@napi-rs/canvas';

function assemble(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  objects.forEach((object, i) => {
    offsets.push(length);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(b); length += b.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(chunks);
}
const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
// Helvetica WinAnsi: Polish letters outside Latin-1 are transliterated in text PDFs only.
const ascii = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');

/** PDF with a real text layer, one line per entry. */
export function textPdf(lines) {
  const ops = ['BT /F1 12 Tf 72 760 Td 16 TL'];
  for (const line of lines) ops.push(`(${ascii(line).replace(/[()\\]/g, '\\$&')}) Tj T*`);
  ops.push('ET');
  return assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    stream('/Filter /FlateDecode', deflateSync(Buffer.from(ops.join('\n'))))]);
}

/** Rendered page image (what a scanner or phone camera produces). */
export function renderCv(lines, { type = 'image/png', noise = false, width = 1240, blank = false } = {}) {
  const height = Math.max(400, 120 + lines.length * 52);
  const canvas = createCanvas(width, height); const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
  if (!blank) {
    g.fillStyle = '#111'; g.font = '34px sans-serif';
    lines.forEach((line, i) => g.fillText(line, 60, 90 + i * 52));
  }
  if (noise) { // unreadable scan: heavy random noise over faint text
    for (let i = 0; i < width * height / 6; i++) { g.fillStyle = Math.random() < .5 ? '#000' : '#fff'; g.fillRect(Math.random() * width, Math.random() * height, 3, 3); }
  }
  return type === 'image/jpeg' ? canvas.toBuffer('image/jpeg', 85) : canvas.toBuffer('image/png');
}

/** Image-only PDF (scan without a text layer). */
export function scannedPdf(lines, options = {}) {
  const jpeg = renderCv(lines, { ...options, type: 'image/jpeg' });
  const width = options.width ?? 1240, height = Math.max(400, 120 + lines.length * 52);
  const content = Buffer.from(`q 612 0 0 ${Math.round(612 * height / width)} 0 0 cm /Im0 Do Q`);
  return assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg),
    stream('', content)]);
}

const xmlEscape = s => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
const para = text => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
/** Minimal DOCX; contact data may sit in the page header like in many real CVs. */
export async function docx(paragraphs, header = []) {
  const zip = new JSZip();
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' + (header.length ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const sect = header.length ? '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>' : '';
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${w}><w:body>${paragraphs.map(para).join('')}${sect}</w:body></w:document>`);
  if (header.length) {
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>');
    zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${w}>${header.map(para).join('')}</w:hdr>`);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Password-protected PDF (RC4-128, user password "tajne"); synthetic text only. */
export const protectedPdf = () => Buffer.from('JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGM2NjQ5MGIwNGM+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9Db250ZW50cyA1IDAgUgovTWVkaWFCb3ggWyAwIDAgNTk1LjI3NTYgODQxLjg4OTggXQovUmVzb3VyY2VzIDw8Ci9Gb250IDYgMCBSCi9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdlSSBdCj4+Ci9Sb3RhdGUgMAovVHJhbnMgPDwKPj4KL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0KL0xlbmd0aCAxMzAKPj4Kc3RyZWFtCl4UBRlWO5JKjPdmaXyrOfw7T8EOgPj6ODXmgsv4GA2A8fPu+DfdK0wgpwR6K3bMu9J2kLk2ybAVQal/sD5v9OnkHZiAOYgM7FhYFMksf+7osHpD8+43YY/e4T9vmWtjm8NuW1m8iLJM2JA/WG4c/hezAo6QuZgsvwV8cBB8WvmGYWMKZW5kc3RyZWFtCmVuZG9iago2IDAgb2JqCjw8Ci9GMSA3IDAgUgo+PgplbmRvYmoKNyAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYQovRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZwovTmFtZSAvRjEKL1N1YnR5cGUgL1R5cGUxCi9UeXBlIC9Gb250Cj4+CmVuZG9iago4IDAgb2JqCjw8Ci9WIDIKL1IgMwovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDwzOWZjYWY0YmQ3OGE0ZGUzNWE3MDkzNDIxNzQzOWE5YzY3MDQ1NmE1ZmNiYWUyMzFmMDllYWZlZTlmNmJkMDNiPgovVSA8NjBkYzY5YjRlZWRiNDgyZDAyYTU0NzQ0NTcxZjAxNmMyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KPj4KZW5kb2JqCnhyZWYKMCA5CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMzY2IDAwMDAwIG4gCjAwMDAwMDA1ODcgMDAwMDAgbiAKMDAwMDAwMDYxOCAwMDAwMCBuIAowMDAwMDAwNzI1IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgOQovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzE2NTMzMzgzNzY1MzkzODYyMzQ2MjMyMzAzNDYxMzQzMzMxNjI2MjMyMzEzNjM5NjMzMjM2MzYzMDY2MzA2MT4gPDMxNjUzMzM4Mzc2NTM5Mzg2MjM0NjIzMjMwMzQ2MTM0MzMzMTYyNjIzMjMxMzYzOTYzMzIzNjM2MzA2NjMwNjE+IF0KL0VuY3J5cHQgOCAwIFIKPj4Kc3RhcnR4cmVmCjk0MAolJUVPRgo=', 'base64');
