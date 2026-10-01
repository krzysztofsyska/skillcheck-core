import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { readCvInput, readDocxText, MAX_DOCX_BYTES, MAX_DOCX_ENTRY_BYTES, MAX_DOCX_ENTRIES } from '../lib/cv-text.ts';

// Synthetic ZIP/DOCX files; never use real candidate data in fixtures.
function zip(entries) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [path, content, declaredSize] of entries) {
    const name = Buffer.from(path), data = Buffer.from(content), packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declaredSize ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); directory.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
function entries(body = paragraph('Zażółć gęślą jaźń')) {
  return [['[Content_Types].xml', types], ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`]];
}
const file = items => new File([zip(items)], 'cv.DOCX');

test('DOCX reads compressed paragraphs and table cells as plain Unicode text', async () => {
  const input = file(entries(paragraph('Zażółć gęślą jaźń') + '<w:tbl><w:tr><w:tc>' + paragraph('SQL &amp; Excel') + '</w:tc></w:tr></w:tbl>'));
  const form = new FormData(); form.set('cv_file', input);
  assert.equal(await readCvInput(form), 'Zażółć gęślą jaźń\n\nSQL & Excel');
});

test('DOCX rejects broken, missing, empty and oversized documents', async () => {
  await assert.rejects(readDocxText(new File(['broken'], 'cv.docx')), /Nie udało/);
  await assert.rejects(readDocxText(file([['hello.txt', 'text']])), /nie zawiera dokumentu/);
  await assert.rejects(readDocxText(file(entries(''))), /nie zawiera odczytywalnego/);
  await assert.rejects(readDocxText(new File([Buffer.alloc(MAX_DOCX_BYTES + 1)], 'cv.docx')), /750 KB/);
  await assert.rejects(readDocxText(file(entries(paragraph('x'.repeat(100001))))), /100 000/);
});

test('DOCX bounds entries, declared sizes and actual decompression', async () => {
  await assert.rejects(readDocxText(file([...entries(), ['large.bin', 'x'.repeat(MAX_DOCX_ENTRY_BYTES + 1)]])), /rozpakowaniu/);
  await assert.rejects(readDocxText(file([...entries(), ...Array.from({length:6}, (_,i) => [`part${i}.bin`, 'x'.repeat(1900000)])])), /rozpakowaniu/);
  await assert.rejects(readDocxText(file([...entries(), ...Array.from({length:MAX_DOCX_ENTRIES}, (_,i) => [`p${i}`, ''])])), /zbyt złożony/);
  await assert.rejects(readDocxText(file([...entries(), ['false-size.bin', 'x'.repeat(MAX_DOCX_ENTRY_BYTES + 1), 1]])), /Nie udało|limit/);
});

test('DOCX rejects ambiguous paths, DTD, embedded programs and omitted sections', async () => {
  for (const name of ['word/document.xml', '../escape.xml', './word/a.xml', 'word/vbaProject.bin', 'word/embeddings/ole.bin']) {
    await assert.rejects(readDocxText(file([...entries(), [name, 'x']])));
  }
  await assert.rejects(readDocxText(file([...entries(), ['custom.xml', '<!DOCTYPE a [<!ENTITY b "x">]><a/>']])), /XML/);
  await assert.rejects(readDocxText(file([...entries(), ['word/header1.xml', '<a/>']])), /nagłówki/);
  await assert.rejects(readDocxText(file(entries('<w:unknown/>'))), /wszystkich elementów/);
});

test('DOCX external hyperlink remains text and is never fetched', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network call'); };
  try {
    const body = '<w:p><w:hyperlink r:id="r1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink></w:p>';
    const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>';
    assert.equal(await readDocxText(file([...entries(body), ['word/_rels/document.xml.rels', rels]])), 'Portfolio');
  } finally { globalThis.fetch = original; }
});
