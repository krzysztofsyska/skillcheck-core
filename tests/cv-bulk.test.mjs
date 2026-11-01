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
    env: {}, secret: 's'.repeat(32), md5: t => createHash('md5').update(t).digest('hex') });
  assert.equal(count, 1);
  assert.deepEqual(dispatched, ['44444444-4444-4444-8444-444444444444'], 'only UUID attempt ids are dispatched');
  const args = calls[0][1];
  const extra = createHash('md5').update(`${canonicalJsonb(contract)}|`).digest('hex');
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
