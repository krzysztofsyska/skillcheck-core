import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  BULK_MAX_FILE_BYTES, BulkIntakeError, buildExtraction, bulkEmail, bulkFileKind, bulkMailEnabled, bulkPricing, detectEmail,
  detectName, detectPhone, displayFileName, isIgnoredZipEntry, sendBulkEmail, validateBatchFiles,
} from '../lib/cv-bulk.ts';
import { extractBulkCv } from '../lib/cv-bulk-extract.ts';
import { closeOcr, ocrImage } from '../lib/cv-ocr.ts';
import { suggestRedaction } from '../lib/cv-text.ts';
import { bulkContract, bulkWorkerSignature, canonicalJsonb, parsePump, pumpAllSigned, pumpBatch } from '../lib/cv-bulk-runner.ts';
import { docx, protectedPdf, renderCv, scannedPdf, textPdf } from './helpers/cv-bulk-fixtures.mjs';

test.after(() => closeOcr());

const cvLines = ['Katarzyna Wiśniewska', 'tel. +48 512 345 678', 'k.wisniewska@example.com', 'Doświadczenie: obsługa klienta, Excel, SQL',
  'Specjalista ds. raportowania, 2019-2024', 'Wykształcenie: Uniwersytet Ekonomiczny'];
const reason = r => error => error instanceof BulkIntakeError && error.reason === r;

test('file kinds, archive entries and display names', () => {
  assert.deepEqual(['a.PDF', 'b.docx', 'c.txt', 'd.JPG', 'e.jpeg', 'f.png', 'g.doc', 'h.zip'].map(bulkFileKind), ['pdf', 'docx', 'txt', 'image', 'image', 'image', 'other', 'other']);
  assert.equal(isIgnoredZipEntry('__MACOSX/x.pdf'), true);
  assert.equal(isIgnoredZipEntry('folder/'), true);
  assert.equal(isIgnoredZipEntry('folder/.DS_Store'), true);
  assert.equal(isIgnoredZipEntry('folder/cv.pdf'), false);
  assert.equal(displayFileName('a/b\\c/cv\u0000.pdf'), 'cv.pdf');
  assert.throws(() => validateBatchFiles([]), /co najmniej jeden/);
  assert.throws(() => validateBatchFiles(Array.from({ length: 101 }, () => ({ name: 'a.pdf', kind: 'pdf', size: 1 }))), /100/);
  assert.deepEqual(validateBatchFiles([{ name: 'x/CV.Pdf', kind: 'other', size: 12.7 }]), [{ name: 'CV.Pdf', kind: 'pdf', size: 12 }]);
});

test('contact and name detection', () => {
  assert.equal(detectEmail('Kontakt: Jan.Kowal@Example.PL, tel'), 'jan.kowal@example.pl');
  assert.equal(detectPhone('tel. 601 222 333'), '+48601222333');
  assert.equal(detectPhone('Telefon: +48 (22) 555-12-34'), '+48225551234');
  assert.equal(detectPhone('0048 601222333'), '+48601222333');
  assert.equal(detectPhone('PESEL 90010112345, data 2020-01-15, kod 00-950'), null);
  assert.equal(detectPhone('rok 2019-2024'), null);
  assert.deepEqual(detectName('CURRICULUM VITAE\nANNA MARIA NOWAK\nul. Polna 5'), { first: 'Anna', last: 'Maria Nowak' });
  assert.deepEqual(detectName('Jan Kowalski-Nowak\nDoświadczenie'), { first: 'Jan', last: 'Kowalski-Nowak' });
  assert.equal(detectName('Doświadczenie zawodowe\nSpecjalista ds. sprzedaży 2010'), null);
  const extraction = buildExtraction(cvLines.join('\n'), 7, false, suggestRedaction);
  assert.equal(extraction.first_name, 'Katarzyna'); assert.equal(extraction.last_name, 'Wiśniewska');
  assert.equal(extraction.phone, '+48512345678'); assert.equal(extraction.email, 'k.wisniewska@example.com');
  assert.doesNotMatch(extraction.redacted_text, /Wiśniewska|512 345|example\.com/);
  const unnamed = buildExtraction('Doświadczenie: księgowość i kadry, Excel, 10 lat pracy w biurze rachunkowym', 7, true, suggestRedaction);
  assert.deepEqual([unnamed.first_name, unnamed.last_name, unnamed.name_detected, unnamed.phone], ['Kandydat', 'nr 7', false, null]);
});

test('extraction: text PDF, DOCX with header, TXT, wrong formats', async () => {
  const fakeOcr = async () => { throw new Error('OCR must not run for text documents'); };
  const pdf = await extractBulkCv(textPdf(cvLines), 'pdf', fakeOcr);
  assert.match(pdf.text, /Katarzyna Wisniewska/); assert.equal(pdf.ocrUsed, false);
  const d = await extractBulkCv(await docx(cvLines.slice(3), cvLines.slice(0, 3)), 'docx', fakeOcr);
  assert.match(d.text, /^Katarzyna Wiśniewska\ntel\. \+48 512 345 678/, 'header text (contact data) is kept');
  assert.match(d.text, /Excel, SQL/);
  const txt = await extractBulkCv(Buffer.from(cvLines.join('\r\n')), 'txt', fakeOcr);
  assert.match(txt.text, /Wykształcenie/);
  await assert.rejects(extractBulkCv(Buffer.from('not a pdf at all, just text'), 'pdf', fakeOcr), reason('bad_format'));
  await assert.rejects(extractBulkCv(Buffer.from('PK broken'), 'docx', fakeOcr), reason('bad_format'));
  await assert.rejects(extractBulkCv(Buffer.from([0xff, 0xfe, 0x00, 0xd8]), 'txt', fakeOcr), reason('bad_format'));
  await assert.rejects(extractBulkCv(Buffer.from('GIF89a....'), 'image', fakeOcr), reason('bad_format'));
  await assert.rejects(extractBulkCv(Buffer.from('x'), 'other', fakeOcr), reason('bad_format'));
  await assert.rejects(extractBulkCv(Buffer.alloc(BULK_MAX_FILE_BYTES + 1, 1), 'pdf', fakeOcr), reason('too_large'));
  await assert.rejects(extractBulkCv(Buffer.from('za krótko'), 'txt', fakeOcr), reason('no_text'));
  await assert.rejects(extractBulkCv(protectedPdf(), 'pdf', fakeOcr), reason('protected_pdf'));
});

test('extraction: local OCR reads scans and photos, rejects unreadable ones', { timeout: 120000 }, async () => {
  const photo = await extractBulkCv(renderCv(cvLines, { type: 'image/jpeg' }), 'image', ocrImage);
  assert.equal(photo.ocrUsed, true);
  assert.match(photo.text, /Katarzyna Wi[sś]niewska/);
  assert.equal(detectPhone(photo.text), '+48512345678');
  const scan = await extractBulkCv(scannedPdf(cvLines), 'pdf', ocrImage);
  assert.equal(scan.ocrUsed, true);
  assert.match(scan.text, /Excel, SQL/);
  await assert.rejects(extractBulkCv(renderCv(cvLines, { noise: true }), 'image', ocrImage), reason('unreadable_scan'));
  await assert.rejects(extractBulkCv(renderCv([], { blank: true }), 'image', ocrImage), reason('unreadable_scan'));
});

test('batch e-mail carries counts and a link only', async () => {
  const n = { batch_id: '11111111-1111-4111-8111-111111111111', recruitment_id: '22222222-2222-4222-8222-222222222222', company_id: '33333333-3333-4333-8333-333333333333',
    email: 'rekruter@example.com', recruitment_name: 'Księgowa <b>', files: 60, done: 52, errors: 8, passed: 12, review: 25, rejected: 15 };
  const mail = bulkEmail(n, 'https://app.example');
  assert.match(mail.text, /Przeanalizowane CV: 52/); assert.match(mail.text, /Przeszli sito: 12/); assert.match(mail.text, /Błędy i pliki poza limitem: 8/);
  assert.equal(mail.link, 'https://app.example/dashboard/33333333-3333-4333-8333-333333333333/recruitments/22222222-2222-4222-8222-222222222222/bulk/11111111-1111-4111-8111-111111111111');
  assert.doesNotMatch(mail.html, /<b>/);
  assert.equal(bulkMailEnabled({ CV_BULK_MAIL_ENABLED: 'true' }), false);
  assert.equal(bulkMailEnabled({ CV_BULK_MAIL_ENABLED: 'true', RESEND_API_KEY: 'k' }), true);
  let request;
  const outcome = await sendBulkEmail(n, 'https://app.example', 'key', async (url, init) => { request = { url, init }; return new Response('{}', { status: 200 }); });
  assert.equal(outcome, 'sent');
  assert.equal(request.init.headers['idempotency-key'], `cv-bulk-${n.batch_id}`);
  assert.deepEqual(JSON.parse(request.init.body).to, ['rekruter@example.com']);
  assert.equal(await sendBulkEmail({ ...n, email: null }, 'x', 'key', async () => assert.fail('no send')), 'skipped');
});

test('pricing comes only from configuration', () => {
  assert.equal(bulkPricing({}), null);
  assert.equal(bulkPricing({ CV_AI_PRICE_INPUT_PER_MTOK: 'abc', CV_AI_PRICE_OUTPUT_PER_MTOK: '1' }), null);
  assert.deepEqual(bulkPricing({ CV_AI_PRICE_INPUT_PER_MTOK: '0.75', CV_AI_PRICE_OUTPUT_PER_MTOK: '4.5', CV_AI_PRICE_VERSION: 'openai-2026-10' }),
    { input_per_mtok: '0.75', output_per_mtok: '4.5', cached_input_per_mtok: '0.75', currency: 'USD', version: 'openai-2026-10' });
});

test('signed scheduler pump binds the exact jsonb contract text', async () => {
  const db = new PGlite();
  const contract = bulkContract(true), pricing = bulkPricing({ CV_AI_PRICE_INPUT_PER_MTOK: '0.75', CV_AI_PRICE_OUTPUT_PER_MTOK: '4.5' });
  for (const [c, p] of [[contract, pricing], [contract, null], [null, null]]) {
    const sql = (await db.query("select md5(coalesce($1::jsonb::text,'') || '|' || coalesce($2::jsonb::text,'')) m", [c === null ? null : JSON.stringify(c), p === null ? null : JSON.stringify(p)])).rows[0].m;
    assert.equal(createHash('md5').update(`${canonicalJsonb(c)}|${canonicalJsonb(p)}`).digest('hex'), sql);
  }
  await db.close();
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push([fn, args]);
    if (fn === 'cv_bulk_worker_pump') return { data: [{ batch_id: 'b', dispatch: ['44444444-4444-4444-8444-444444444444', 'bad'], notify: null }], error: null };
    return { data: true, error: null };
  };
  const dispatched = [];
  const count = await pumpAllSigned({ rpc, dispatch: async id => { dispatched.push(id); return { accepted: true }; }, aiEnabled: true, origin: () => 'https://x',
    env: {}, secret: 's'.repeat(32), digest: t => createHash('sha256').update(t).digest('hex') });
  assert.equal(count, 1);
  assert.deepEqual(dispatched, ['44444444-4444-4444-8444-444444444444'], 'only UUID attempt ids are dispatched');
  const args = calls[0][1];
  const extra = createHash('sha256').update(`${canonicalJsonb(contract)}|`).digest('hex');
  assert.equal(args.request_signature, createHmac('sha256', 's'.repeat(32)).update(['cv-bulk-v1', 'pump', args.request_id, String(args.issued_at_ms), '-', extra].join('\n')).digest('hex'));
  assert.equal(args.request_signature, bulkWorkerSignature('s'.repeat(32), 'pump', args.request_id, args.issued_at_ms, null, extra));
});

test('session pump: AI disabled sends no contract; notification outcome is reported once', async () => {
  const calls = [];
  const notify = { batch_id: '55555555-5555-4555-8555-555555555555', recruitment_id: 'r', company_id: 'c', email: 'a@b.pl', recruitment_name: 'R', files: 1, done: 1, errors: 0, passed: 1, review: 0, rejected: 0 };
  const rpc = async (fn, args) => { calls.push([fn, args]); return fn === 'cv_bulk_pump' ? { data: { dispatch: [], notify }, error: null } : { data: true, error: null }; };
  const result = await pumpBatch({ rpc, dispatch: async () => ({ accepted: true }), aiEnabled: false, origin: () => 'https://x', env: {} }, notify.batch_id);
  assert.equal(calls[0][1].contract, null);
  assert.deepEqual(calls[1], ['cv_bulk_finish_notification', { target_batch: notify.batch_id, outcome: 'skipped' }], 'mail disabled -> skipped');
  assert.equal(result.notify.batch_id, notify.batch_id);
  assert.deepEqual(parsePump({ dispatch: 'x', notify: { batch_id: 'nope' } }), { dispatch: [], notify: null });
});

test('detectPhone: international prefixes and no gluing across lines', () => {
  assert.equal(detectPhone('Telefon: +44 7700 900123'), '+447700900123');
  assert.equal(detectPhone('tel. +49 151 12345678'), '+4915112345678');
  assert.equal(detectPhone('Telefon: +48 512 345 678\n2024'), '+48512345678');
  assert.equal(detectPhone('Telefon: +44 7700 900123\n2019 BA'), '+447700900123');
});

// ---- Review fixes (PR #228) ----

test('AI disabled: bulk intake is refused before any slot is reserved', async () => {
  const { bulkIntakeBlocked } = await import('../lib/cv-bulk.ts');
  assert.equal(bulkIntakeBlocked(true), null);
  assert.match(bulkIntakeBlocked(false), /Analiza AI jest teraz wyłączona/);
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/', import.meta.url);
  const actions = readFileSync(new URL('actions.ts', dir), 'utf8');
  const create = actions.slice(actions.indexOf('export async function createBulkBatch'), actions.indexOf('export async function closeBulkUpload'));
  assert.ok(create.indexOf('bulkIntakeBlocked(screeningAiUserEnabled())') > 0 && create.indexOf('bulkIntakeBlocked') < create.indexOf("rpc('cv_bulk_create_batch'"),
    'createBulkBatch checks the AI flag before reserving');
  const page = readFileSync(new URL('page.tsx', dir), 'utf8');
  assert.match(page, /blocked \? <p role="alert">\{blocked\}<\/p>\s*: <BulkUploader/, 'uploader hidden when AI is off');
});

test('finish(): long runs of spaces are linear, over-length text is rejected, never truncated', async () => {
  const fakeOcr = async () => assert.fail('no OCR');
  const started = Date.now();
  await assert.rejects(extractBulkCv(Buffer.from(cvLines.join('\n') + ' '.repeat(200_000) + 'x'), 'txt', fakeOcr), reason('too_large'));
  await assert.rejects(extractBulkCv(Buffer.from(cvLines.join('\n') + ' '.repeat(1_000_000) + 'x'), 'txt', fakeOcr), reason('too_large'));
  await assert.rejects(extractBulkCv(Buffer.from(('a' + ' '.repeat(5000) + '\n').repeat(700)), 'txt', fakeOcr), reason('too_large'));
  // Trailing spaces are trimmed per line, so a CV padded with spaces still fits.
  const padded = await extractBulkCv(Buffer.from(cvLines.map(l => l + ' \t'.repeat(3000)).join('\n')), 'txt', fakeOcr);
  assert.equal(padded.text, cvLines.join('\n'));
  await assert.rejects(extractBulkCv(Buffer.from('x'.repeat(100_001) + ' '.repeat(100)), 'txt', fakeOcr), reason('too_large'));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('DOCX header text: linear tokenizer, same output as before', async () => {
  const { docxSectionText } = await import('../lib/cv-text.ts');
  assert.equal(docxSectionText('<w:hdr><w:p><w:r><w:t xml:space="preserve">Jan &amp; </w:t></w:r><w:r><w:t>Kowalski</w:t></w:r></w:p><w:p><w:tab/><w:t>tel &lt;1&gt;</w:t></w:p></w:hdr>'),
    'Jan & Kowalski\ntel <1>');
  assert.equal(docxSectionText('<w:p><w:t/><w:tbl><w:t>a</w:t></w:p>'), 'a');
  const started = Date.now();
  docxSectionText('<w:t '.repeat(100_000));
  docxSectionText('<w:t>' + 'a'.repeat(480_000));
  docxSectionText('<w:t x>'.repeat(60_000) + '</w:t'.repeat(20_000));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('image size: dimensions read from headers, oversized images rejected before OCR', async () => {
  const { imageDimensions, ocrRenderScale } = await import('../lib/cv-bulk-extract.ts');
  assert.deepEqual(imageDimensions(renderCv(cvLines, { width: 1300 })), { width: 1300, height: 432 });
  assert.deepEqual(imageDimensions(renderCv(cvLines, { type: 'image/jpeg', width: 900 })), { width: 900, height: 432 });
  assert.equal(imageDimensions(Buffer.from('not an image at all, really')), null);
  const fakeOcr = async () => assert.fail('OCR must not run for an oversized image');
  // PNG claiming 6000 x 5000 px (30 MP): only the header is read, nothing is decoded.
  const png = renderCv(cvLines); png.writeUInt32BE(6000, 16); png.writeUInt32BE(5000, 20);
  await assert.rejects(extractBulkCv(png, 'image', fakeOcr), reason('too_large'));
  const jpeg = renderCv(cvLines, { type: 'image/jpeg' });
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  jpeg.writeUInt16BE(6000, sof + 5); jpeg.writeUInt16BE(6000, sof + 7);
  await assert.rejects(extractBulkCv(jpeg, 'image', fakeOcr), reason('too_large'));
  // Allowed but large: downscaled to at most 2500 px before OCR.
  let seen;
  const capture = async image => { seen = imageDimensions(image); return { text: cvLines.join('\n'), confidence: 90 }; };
  await extractBulkCv(renderCv(cvLines, { width: 4000 }), 'image', capture);
  assert.ok(Math.max(seen.width, seen.height) <= 2500, JSON.stringify(seen));
  assert.equal(ocrRenderScale(612, 792), 2);
  assert.ok(ocrRenderScale(14400, 14400) * 14400 <= 2500);
  assert.equal(ocrRenderScale(0, 0), null);
});

test('PDF OCR: page render is capped; huge page is downscaled', async () => {
  const { imageDimensions } = await import('../lib/cv-bulk-extract.ts');
  // 200 x 200 inch page (14400 pt): scale 2 would be 28800 px square (3.3 GB of pixels).
  const pdf = scannedPdf(cvLines).toString('latin1').replace('/MediaBox [0 0 612 792]', '/MediaBox [0 0 14400 14400]');
  let seen;
  const capture = async image => { seen = imageDimensions(image); return { text: cvLines.join('\n'), confidence: 90 }; };
  const out = await extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', capture);
  assert.equal(out.ocrUsed, true);
  assert.ok(Math.max(seen.width, seen.height) <= 2500, JSON.stringify(seen));
});

test('PDF OCR: a blank page in a text PDF is skipped, not fatal', async () => {
  // Two pages: a text page and an empty page (no content stream).
  const base = textPdf(cvLines).toString('latin1')
    .replace('/Count 1 /Kids [4 0 R]', '/Count 2 /Kids [4 0 R 6 0 R]');
  const objects = base.slice(0, base.indexOf('xref'));
  const extra = '6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n';
  const body = objects + extra;
  const offsets = [1, 2, 3, 4, 5, 6].map(i => body.indexOf(`\n${i} 0 obj`) + 1);
  const pdf = `${body}xref\n0 7\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF`;
  let calls = 0;
  const blankOcr = async () => { calls++; return { text: '', confidence: 0 }; };
  const out = await extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', blankOcr);
  assert.equal(calls, 1, 'the blank page was tried once');
  assert.equal(out.ocrUsed, false);
  assert.match(out.text, /Katarzyna Wisniewska/);
  // A scan where OCR finds nothing on any page is still unreadable.
  await assert.rejects(extractBulkCv(scannedPdf(cvLines), 'pdf', blankOcr), reason('unreadable_scan'));
});

test('OCR time budget: expired deadline and OCR timeout give ocr_timeout', async () => {
  const { OcrTimeoutError } = await import('../lib/cv-bulk.ts');
  const never = async () => assert.fail('no OCR after the deadline');
  await assert.rejects(extractBulkCv(scannedPdf(cvLines), 'pdf', never, { deadline: Date.now() - 1 }), reason('ocr_timeout'));
  const slow = async (_image, options) => { assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000); throw new OcrTimeoutError(); };
  await assert.rejects(extractBulkCv(renderCv(cvLines), 'image', slow, { deadline: Date.now() + 5000 }), reason('ocr_timeout'));
  const { errorLabel } = await import('../lib/cv-bulk.ts');
  assert.match(errorLabel.ocr_timeout, /trwał za długo/);
});

test('OCR worker: a stuck recognition times out and the worker is replaced', async () => {
  const { ocrImage, setOcrWorkerFactoryForTests } = await import('../lib/cv-ocr.ts');
  const { OcrTimeoutError } = await import('../lib/cv-bulk.ts');
  const workers = [];
  await setOcrWorkerFactoryForTests(async () => {
    const w = { id: workers.length, terminated: false,
      recognize: () => w.id === 0 ? new Promise(() => {}) : Promise.resolve({ data: { text: 'ok', confidence: 91 } }),
      terminate: async () => { w.terminated = true; } };
    workers.push(w);
    return w;
  });
  try {
    await assert.rejects(ocrImage(Buffer.from('a'), { timeoutMs: 50 }), error => error instanceof OcrTimeoutError);
    assert.equal(workers[0].terminated, true, 'stuck worker terminated');
    assert.deepEqual(await ocrImage(Buffer.from('b'), { timeoutMs: 1000 }), { text: 'ok', confidence: 91 });
    assert.equal(workers.length, 2, 'a fresh worker served the next job');
    // A crashed worker is replaced as well.
    workers[1].recognize = () => Promise.reject(new Error('worker died'));
    await assert.rejects(ocrImage(Buffer.from('c')), /worker died/);
    assert.equal(workers[1].terminated, true);
    assert.equal((await ocrImage(Buffer.from('d'))).text, 'ok');
    assert.equal(workers.length, 3);
  } finally { await setOcrWorkerFactoryForTests(null); }
});

test('scheduler pump stops delivering when its time budget is used', async () => {
  let clock = 0;
  const rpc = async fn => fn === 'cv_bulk_worker_pump'
    ? { data: [1, 2, 3].map(n => ({ batch_id: `b${n}`, dispatch: [`${n}${n}${n}${n}${n}${n}${n}${n}-4444-4444-8444-444444444444`], notify: null })), error: null }
    : { data: true, error: null };
  const dispatched = [];
  const count = await pumpAllSigned({ rpc, dispatch: async id => { dispatched.push(id); clock += 20_000; return { accepted: true }; },
    aiEnabled: true, origin: () => 'https://x', env: {}, secret: 's'.repeat(32), digest: t => createHash('sha256').update(t).digest('hex'), now: () => clock });
  assert.equal(count, 3);
  assert.equal(dispatched.length, 2, 'third batch left for the next run');
});

test('uploader: one request key per file set, synchronous double-click guard, OCR files one at a time', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/uploader.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /createBulkBatch\([^)]*crypto\.randomUUID\(\)/, 'no fresh key per click');
  assert.match(src, /requestKey\.current \?\?= crypto\.randomUUID\(\)/);
  assert.match(src, /requestKey\.current = null;/, 'new pick resets the key');
  const start = src.slice(src.indexOf('async function start()'));
  assert.ok(start.indexOf('if (startLock.current) return;') < start.indexOf('await createBulkBatch'), 'guard before the first await');
  assert.match(src, /disabled=\{!confirmed \|\| accepted === 0 \|\| starting\}/);
  assert.match(src, /drain\(ocrLane, BULK_OCR_UPLOAD_CONCURRENCY\)/);
  const { BULK_OCR_UPLOAD_CONCURRENCY, bulkMayNeedOcr } = await import('../lib/cv-bulk.ts');
  assert.equal(BULK_OCR_UPLOAD_CONCURRENCY, 1);
  assert.deepEqual(['pdf', 'image', 'docx', 'txt', 'other'].map(bulkMayNeedOcr), [true, true, false, false, false]);
});

test('upload route checks write access before reading the file', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/[batchId]/items/[itemId]/route.ts', import.meta.url), 'utf8');
  const forbidden = src.indexOf("{ error: 'forbidden' }");
  assert.ok(forbidden > 0 && forbidden < src.indexOf('request.formData()'), 'forbidden before formData');
  assert.match(src, /ocrImage, \{ deadline \}\)/);
});
