import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  BULK_MAX_FILE_BYTES, BulkIntakeError, buildExtraction, bulkEmail, bulkFileKind, bulkMailEnabled, bulkPricing, detectEmail,
  detectName, detectPhone, displayFileName, isIgnoredZipEntry, sendBulkEmail, validateBatchFiles, verifyBulkRegistration,
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
  // A number never takes digits from the next line.
  assert.equal(detectPhone('Telefon: +48 500 123 456\n12 lat doświadczenia w sprzedaży'), '+48500123456');
  assert.equal(detectPhone('Telefon: 500 123 456\n12 lat doświadczenia'), '+48500123456');
  assert.equal(detectPhone('tel. 601-222-333\n2019 - 2024 Kierownik'), '+48601222333');
  assert.deepEqual(detectName('CURRICULUM VITAE\nANNA MARIA NOWAK\nul. Polna 5'), { first: 'Anna', last: 'Maria Nowak' });
  assert.deepEqual(detectName('Jan Kowalski-Nowak\nDoświadczenie'), { first: 'Jan', last: 'Kowalski-Nowak' });
  assert.equal(detectName('Doświadczenie zawodowe\nSpecjalista ds. sprzedaży 2010'), null);
  // A job-title headline before the name is never taken as the name (it would leave the real name
  // unredacted and strip the title words from the whole CV).
  assert.deepEqual(detectName('Java Developer\nAnna Nowak\nul. Polna 5'), { first: 'Anna', last: 'Nowak' });
  assert.deepEqual(detectName('KIEROWNIK SPRZEDAŻY\nJan Kowalski'), { first: 'Jan', last: 'Kowalski' });
  assert.deepEqual(detectName('Senior Data Scientist\nPiotr Zieliński'), { first: 'Piotr', last: 'Zieliński' });
  // Job words that are also surnames or first names: still detected when nothing else looks like a name,
  // and a real name line wins over a headline in either order.
  assert.deepEqual(detectName('Jan Ślusarz\nul. Polna 5'), { first: 'Jan', last: 'Ślusarz' });
  assert.deepEqual(detectName('John Head\njohn@example.com'), { first: 'John', last: 'Head' });
  assert.deepEqual(detectName('Jan Ślusarz\nJava Developer'), { first: 'Jan', last: 'Ślusarz' });
  assert.deepEqual(detectName('Grafik Komputerowy\nAnna Kowal'), { first: 'Anna', last: 'Kowal' });
  assert.deepEqual(detectName('Doradca Finansowy\nPiotr Nowak'), { first: 'Piotr', last: 'Nowak' });
  // A surname that is a job word wins over later name-like lines (cities, upper-case headings).
  assert.deepEqual(detectName('Jan Ślusarz\nul. Polna 5\nZielona Góra'), { first: 'Jan', last: 'Ślusarz' });
  assert.deepEqual(detectName('Jan Technik\ntel. 600 100 200\nJĘZYKI OBCE'), { first: 'Jan', last: 'Technik' });
  assert.deepEqual(detectName('Mark Head\nLondon United Kingdom'), { first: 'Mark', last: 'Head' });
  assert.deepEqual(detectName('Java Developer\nJan Ślusarz'), { first: 'Jan', last: 'Ślusarz' });
  assert.deepEqual(detectName('Jan Ślusarz\nWykształcenie\nPolitechnika Warszawska'), { first: 'Jan', last: 'Ślusarz' });
  // A seniority word that is also a first name: a name, unless the whole line is job words.
  assert.deepEqual(detectName('Junior Silva\nPolitechnika Warszawska'), { first: 'Junior', last: 'Silva' });
  assert.deepEqual(detectName('Senior Java Developer\nJan Kowalski'), { first: 'Jan', last: 'Kowalski' });
  assert.deepEqual(detectName('Office Manager\nAnna Nowak'), { first: 'Anna', last: 'Nowak' });
  // Surname-first order with a job-word surname is still a name.
  assert.deepEqual(detectName('Ślusarz Jan\nZielona Góra'), { first: 'Ślusarz', last: 'Jan' });
  assert.deepEqual(detectName('LEKARZ ANNA\nNowy Sącz'), { first: 'Lekarz', last: 'Anna' });
  assert.deepEqual(detectName('Kierownik Budowy\nJan Kowalski'), { first: 'Jan', last: 'Kowalski' });
  assert.deepEqual(detectName('Software Developer\nAnna Nowak'), { first: 'Anna', last: 'Nowak' });
  assert.deepEqual(detectName('Główna Księgowa\nAnna Nowak'), { first: 'Anna', last: 'Nowak' });
  // Accepted trade-off (documented in PR #250): a whole name made of two job words looks like a
  // headline, so a later name-like line wins. Much rarer than a headline above the name.
  assert.deepEqual(detectName('Junior Lekarz\nZielona Góra'), { first: 'Zielona', last: 'Góra' });
  // Non-breaking and other horizontal Unicode spaces (Word/PDF exports) never hide a phone or a name.
  const nbsp = buildExtraction('Anna\u00A0Nowak\nTelefon: +48\u00A0500\u00A0123\u00A0456\ne-mail: anna@example.com', 5, false, suggestRedaction);
  assert.equal(nbsp.phone, '+48500123456');
  assert.deepEqual([nbsp.first_name, nbsp.last_name], ['Anna', 'Nowak']);
  assert.doesNotMatch(nbsp.redacted_text, /500|Nowak|example/);
  const thin = buildExtraction('Jan Kowalski\ntel. 500\u202F123\u2009456', 6, false, suggestRedaction);
  assert.equal(thin.phone, '+48500123456');
  assert.doesNotMatch(thin.redacted_text, /500/);
  assert.doesNotMatch(suggestRedaction('tel. 600\u00A0700\u00A0800', []), /600/, 'single-CV redaction too');
  // Word's non-breaking hyphen / en dash, tabs, soft hyphens and zero-width characters never hide data.
  for (const [input, digits] of [['tel. +48 500\u2011123\u2011456', '+48500123456'], ['tel. 500\u2013123\u2013456', '+48500123456'],
    ['tel. 500\t123\t456', '+48500123456'], ['tel. 500\u00AD123\u00AD456', '+48500123456'], ['tel. 500\u200B123\u200B456', '+48500123456'],
    ['tel. \uFF15\uFF10\uFF10 123 456', '+48500123456']]) {
    const e = buildExtraction('Anna Nowak\n' + input, 7, false, suggestRedaction);
    assert.equal(e.phone, digits, JSON.stringify(input));
    assert.doesNotMatch(e.redacted_text.replace(/\D/g, ''), /500123456/, JSON.stringify(input));
  }
  assert.doesNotMatch(buildExtraction('Anna No\u00ADwak\nDoświadczenie', 8, false, suggestRedaction).redacted_text, /Nowak|No\u00ADwak/);
  // Two phones side by side in columns are both redacted; a long single number (IBAN) too.
  const cols = suggestRedaction('tel. 500 123 456\t600 700 800', []);
  assert.doesNotMatch(cols, /500|600/);
  assert.doesNotMatch(suggestRedaction('tel. 500 123 456   600 700 800', []), /500|600/);
  assert.doesNotMatch(suggestRedaction('IBAN 61 1090 1014 0000 0712 1981 2874', []), /1981/);
  // A multi-part name stored with a non-breaking space still matches the text.
  assert.doesNotMatch(suggestRedaction('Anna\u00A0Maria Nowak, analityk', ['Anna\u00A0Maria', 'Nowak']), /Anna|Maria|Nowak/);
  // Employment periods stay visible for the analysis (Word turns ' - ' into an en dash).
  for (const dates of ['01.2019 \u2013 12.2022', '1.01.2019\u201331.12.2022', '2019.01.01 - 2022.12.31', '2015\u20132018 2019\u20132022',
    '2012 2013 2014 2015 2016', '01.2015 - 12.2017 01.2018 - 12.2020']) assert.equal(suggestRedaction(dates, []), dates, dates);
  // ...but a phone next to a period is still redacted.
  assert.doesNotMatch(suggestRedaction('600 700 800\t2019\u20132022', []), /600/);
  assert.match(suggestRedaction('600 700 800\t2019\u20132022', []), /2019\u20132022/);
  // Wide spacing inside phones never splits them into short visible groups.
  assert.doesNotMatch(suggestRedaction('tel. 500  123  456\t600  700  800', []), /500|600|123|700/);
  assert.doesNotMatch(suggestRedaction('tel. 500  123  456', []), /500|123|456/);
  // Crafted input cannot make the date check slow.
  const started = Date.now();
  suggestRedaction('2019' + ' '.repeat(99_000) + '12345', []);
  assert.ok(Date.now() - started < 2000, 'linear time');
  // Crafted text cannot make e-mail detection slow; normal addresses are still found.
  const t0 = Date.now();
  suggestRedaction('1.'.repeat(47_500), []);
  buildExtraction('Anna Nowak\n' + '1.'.repeat(47_500), 10, false, suggestRedaction);
  assert.ok(Date.now() - t0 < 2000, 'e-mail patterns stay linear');
  assert.equal(detectEmail('kontakt: anna.nowak+cv@poczta.example.pl'), 'anna.nowak+cv@poczta.example.pl');
  // Over-long (invalid) local parts are still redacted in full.
  assert.doesNotMatch(suggestRedaction('a'.repeat(65) + '@x.pl', []), /aaaa/);
  assert.doesNotMatch(suggestRedaction('a.'.repeat(40) + 'b@x.pl', []), /a\.a/);
  // Repeated spacing inside a phone number is still read as the candidate's phone.
  assert.equal(detectPhone('tel.  +48  500  123  456'), '+48500123456');
  assert.equal(detectPhone('500  123  456'), '+48500123456');
  // Dashes in ordinary text stay as written.
  assert.match(suggestRedaction('JavaScript 2018\u20132024', []), /2018\u20132024/);
  // If detection and redaction ever disagree, the file stops instead of reaching the AI provider.
  assert.throws(() => buildExtraction('Anna Nowak\ntel. 500 123 456', 9, false, t => t), /bad_format/);
  const surname = buildExtraction('Jan Ślusarz\nDoświadczenie: spawanie', 4, false, suggestRedaction);
  assert.doesNotMatch(surname.redacted_text, /Ślusarz/, 'a job-word surname is still redacted');
  const titled = buildExtraction('Java Developer\nAnna Nowak\nDoświadczenie: Java, Spring', 3, false, suggestRedaction);
  assert.match(titled.redacted_text, /Java Developer/, 'title words stay as evidence');
  assert.doesNotMatch(titled.redacted_text, /Nowak/, 'the real name is redacted');
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

test('PDF OCR: digitally printed header cannot hide a scanned CV body', async () => {
  const header = 'Katarzyna Wisniewska, tel. +48 500 123 456, e-mail: anna@example.com';
  const matchingLines = cvLines.map(line => line.replace('Wiśniewska', 'Wisniewska'));
  matchingLines.splice(1, 0, 'Java Developer'); // a job heading must not be counted as another person
  const mixed = scannedPdf(matchingLines, { textOverlay: [header] });
  let calls = 0;
  const scanOcr = async () => {
    calls++;
    return { text: [header, ...matchingLines].join('\n'), confidence: 94 };
  };
  const result = await extractBulkCv(mixed, 'pdf', scanOcr);
  assert.equal(calls, 1, 'OCR runs even when a sparse digital text layer is present');
  assert.equal(result.ocrUsed, true);
  assert.match(result.text, /Excel, SQL/, 'the scanned work history is included');
  assert.match(result.text, /Katarzyna Wisniewska/, 'consistent digital name is preserved');
  assert.match(result.text, /Java Developer/, 'an ordinary job headline is kept, not treated as a conflicting identity');
  assert.match(result.text, /500 123 456/, 'the original digital phone survives imperfect OCR');
  assert.match(result.text, /anna@example.com/, 'the digital e-mail remains in the complete OCR result');
  await assert.rejects(extractBulkCv(mixed, 'pdf', async () => ({ text: cvLines.join('\n'), confidence: 94 })),
    reason('unreadable_scan'), 'OCR omitting the reliable contact header is rejected, never merged');
  const crossedHeader = 'Anna Testowa, tel. +48 500 123 456';
  const crossed = scannedPdf(cvLines, { textOverlay: [crossedHeader] });
  await assert.rejects(extractBulkCv(crossed, 'pdf', async () => ({
    text: [crossedHeader, ...cvLines].join('\n'), confidence: 94,
  })), reason('unreadable_scan'), 'an additional name in the OCR body must be rejected even when the digital header matches');
  const accentedHeader = 'Anna Wisniewska, tel. +48 500 123 456';
  const accented = scannedPdf(cvLines, { textOverlay: [accentedHeader] });
  await assert.rejects(extractBulkCv(accented, 'pdf', async () => ({
    text: [accentedHeader, 'Anna Wiśniewska', ...cvLines].join('\n'), confidence: 94,
  })), reason('unreadable_scan'), 'the same surname with different diacritics is not safe to redact automatically');
  await assert.rejects(extractBulkCv(mixed, 'pdf', async () => ({ text: header, confidence: 90 })),
    reason('unreadable_scan'), 'header-only OCR is never accepted as a complete CV');
  await assert.rejects(extractBulkCv(mixed, 'pdf', async () => ({ text: '', confidence: 0 })),
    reason('unreadable_scan'), 'blank OCR cannot quietly discard the scan');

  // An ordinary short PDF without any large embedded scan must avoid OCR.
  const shortText = await extractBulkCv(textPdf(['Anna Nowak', 'Doswiadczenie zawodowe od 2017 roku w obsludze klienta']), 'pdf',
    async () => assert.fail('text-only PDF must not trigger OCR'));
  assert.equal(shortText.ocrUsed, false);
});

test('PDF OCR: tiny inline images cannot indefinitely block sparse-text extraction', { timeout: 10000 }, async () => {
  const headerLines = ['Anna Nowak', 'E-mail: anna@example.com', 'Doświadczenie zawodowe od 2017 roku w analizie SQL'];
  const pdf = textPdf(headerLines, { inlineImage: true });
  const start = Date.now();
  // pdf-parse may hang on the inline operand. A bounded attempt must complete,
  // and OCR with a nonidentical digital layer must be rejected rather than merged.
  await assert.rejects(extractBulkCv(pdf, 'pdf', async () => ({
    text: 'Dodatkowa treść zeskanowana. Analiza wymagań, planowanie raportów i dokumentowanie wyników. ' +
      'Weryfikowanie kompletności danych przez analityka w kolejnych latach pracy z dokumentami.',
    confidence: 94,
  }), { deadline: Date.now() + 7000 }), reason('unreadable_scan'));
  assert.ok(Date.now() - start < 7000, 'inline-image inspection finishes within the extraction budget');
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

test('session bulk pump fails closed on a malformed successful RPC response', async () => {
  const batchId = '55555555-5555-4555-8555-555555555555';
  for (const malformed of [null, [], {}, { dispatch: [] }, { dispatch: 'not an array', notify: null },
    { dispatch: [], notify: { batch_id: 'invalid' } }, { dispatch: [], notify: [] },
    { dispatch: [], notify: null, error: '23505' }]) {
    let dispatches = 0;
    const calls = [];
    const rpc = async (fn, args) => {
      calls.push([fn, args]);
      return { data: malformed, error: null };
    };
    await assert.rejects(
      pumpBatch({ rpc, dispatch: async () => { dispatches++; return { accepted: true }; },
        aiEnabled: false, origin: () => 'https://example.test', env: {} }, batchId),
      /cv_bulk_pump_invalid_response/,
      'invalid payload must not be mistaken for an empty batch',
    );
    assert.equal(dispatches, 0);
    assert.deepEqual(calls.map(([fn]) => fn), ['cv_bulk_pump'], 'no dispatch or notification acknowledgement on failure');
  }
  const rpc = async () => ({ data: { dispatch: [], notify: null }, error: null });
  assert.deepEqual(await pumpBatch({ rpc, dispatch: async () => ({ accepted: true }),
    aiEnabled: false, origin: () => 'https://example.test', env: {} }, batchId),
  { dispatch: [], notify: null }, 'a legitimately empty RPC response still succeeds');
});

test('bulk pump dispatches a repeated attempt only once per response (session and signed scheduler)', async () => {
  const first = '44444444-4444-4444-8444-444444444444';
  const second = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const response = { dispatch: [first, first.toUpperCase(), 'invalid', second, first, second], notify: null };
  assert.deepEqual(parsePump(response).dispatch, [first, second], 'valid UUIDs are unique regardless of case');

  const dispatched = [];
  const rpc = async fn => ({ data: fn === 'cv_bulk_worker_pump' ? [response] : response, error: null });
  const deps = { rpc, dispatch: async id => { dispatched.push(id); return { accepted: true }; },
    aiEnabled: true, origin: () => 'https://example.test', env: {} };

  await pumpBatch(deps, '55555555-5555-4555-8555-555555555555');
  assert.deepEqual(dispatched, [first, second], 'signed-in pump invokes each attempt once');
  dispatched.length = 0;

  const count = await pumpAllSigned({ ...deps, secret: 's'.repeat(32), digest: text => createHash('sha256').update(text).digest('hex') });
  assert.equal(count, 1);
  assert.deepEqual(dispatched, [first, second], 'cron pump invokes each attempt once');
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
  assert.match(create, /!status\\.error && verifyBulkRegistration\\(created\\.data, status\\.data, recruitmentId, checked\\)/,
    'file metadata and both RPC envelopes are checked before handing upload IDs to the browser');
  const page = readFileSync(new URL('page.tsx', dir), 'utf8');
  assert.match(page, /blocked \? <p role="alert">\{blocked\}<\/p>\s*: <BulkUploader/, 'uploader hidden when AI is off');
});

test('bulk registration validates complete RPC output before uploading or closing held slots', async () => {
  const recruitmentId = '11111111-1111-4111-8111-111111111111';
  const batchId = '22222222-2222-4222-8222-222222222222';
  const files = [{ name: 'a.pdf', kind: 'pdf', size: 50 }, { name: 'b.docx', kind: 'docx', size: 70 }];
  const created = { batch_id: batchId, reserved_slots: 1, over_limit: 1 };
  const status = { batch: { id: batchId, recruitment_id: recruitmentId, declared_files: 2, reserved_slots: 1 },
    items: [
      { id: '33333333-3333-4333-8333-333333333333', position: 1, file_name: 'a.pdf', file_kind: 'pdf' },
      { id: '44444444-4444-4444-8444-444444444444', position: 2, file_name: 'b.docx', file_kind: 'docx' },
    ] };
  assert.deepEqual(verifyBulkRegistration(created, status, recruitmentId, files), {
    batchId, reserved: 1, overLimit: 1, items: status.items.map(({ id, position }) => ({ id, position })),
  });
  const cases = [
    [null, status], [{}, status], [{ ...created, batch_id: 'bad' }, status],
    [{ ...created, reserved_slots: 3 }, status], [{ ...created, over_limit: 0 }, status],
    [created, null], [created, { ...status, batch: { ...status.batch, id: 'bad' } }],
    [created, { ...status, batch: { ...status.batch, recruitment_id: batchId } }],
    [created, { ...status, batch: { ...status.batch, declared_files: 1 } }],
    [created, { ...status, batch: { ...status.batch, reserved_slots: 2 } }],
    [created, { ...status, items: status.items.slice(0, 1) }],
    [created, { ...status, items: [status.items[0], status.items[0]] }],
    [created, { ...status, items: [{ ...status.items[0], id: 'bad' }, status.items[1]] }],
    [created, { ...status, items: [{ ...status.items[0], position: 3 }, status.items[1]] }],
    [created, { ...status, items: [{ ...status.items[0], file_name: 'other.pdf' }, status.items[1]] }],
    [created, { ...status, items: [{ ...status.items[0], file_kind: 'txt' }, status.items[1]] }],
  ];
  for (const [badCreated, badStatus] of cases) {
    assert.equal(verifyBulkRegistration(badCreated, badStatus, recruitmentId, files), null);
  }
  const { readFileSync } = await import('node:fs');
  const actions = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/actions.ts', import.meta.url), 'utf8');
  const close = actions.slice(actions.indexOf('export async function closeBulkUpload'), actions.indexOf('export async function bulkProgress'));
  assert.match(close, /!Number\\.isInteger\\(result\\.data\\)/, 'close rejects a missing or malformed released-slot count');
  assert.match(close, /\\(result\\.data as number\\) < 0/, 'close refuses negative slot counts');
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
  // Real text that OCR reads only with low confidence fails the file instead of being dropped.
  const poorOcr = async () => ({ text: 'Doswiadczenie zawodowe 2019-2024 kierownik magazynu', confidence: 40 });
  await assert.rejects(extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', poorOcr), reason('unreadable_scan'));
  // A few characters read with low confidence are an unreadable page, not a blank one.
  const shortPoor = async () => ({ text: 'SQL', confidence: 5 });
  await assert.rejects(extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', shortPoor), reason('unreadable_scan'));
  // Scanner noise on a blank page (no word-like run) is still blank, even with low confidence.
  const noise = async () => ({ text: '| \u2014 ~ .', confidence: 20 });
  assert.match((await extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', noise)).text, /Katarzyna Wisniewska/);
  // A confident short read (page number, footer) is still skipped.
  const footer = async () => ({ text: '2', confidence: 95 });
  assert.match((await extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', footer)).text, /Katarzyna Wisniewska/);
  // A scan where OCR finds nothing on any page is still unreadable.
  await assert.rejects(extractBulkCv(scannedPdf(cvLines), 'pdf', blankOcr), reason('unreadable_scan'));
});

test('PDF OCR: pages left after the OCR run cap fail the file instead of being dropped', async () => {
  // A text page followed by 11 empty pages: the 11th empty page has no OCR run left.
  const extraPages = 11;
  const ids = Array.from({ length: extraPages }, (_, i) => 6 + i);
  const base = textPdf(cvLines).toString('latin1')
    .replace('/Count 1 /Kids [4 0 R]', `/Count ${1 + extraPages} /Kids [4 0 R ${ids.map(id => `${id} 0 R`).join(' ')}]`);
  const body = base.slice(0, base.indexOf('xref')) + ids.map(id => `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`).join('');
  const all = [1, 2, 3, 4, 5, ...ids];
  const offsets = all.map(i => body.indexOf(`\n${i} 0 obj`) + 1);
  const pdf = `${body}xref\n0 ${all.length + 1}\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF`;
  let calls = 0;
  const blankOcr = async () => { calls++; return { text: '', confidence: 0 }; };
  await assert.rejects(extractBulkCv(Buffer.from(pdf, 'latin1'), 'pdf', blankOcr), reason('unreadable_scan'));
  assert.equal(calls, 10, 'OCR stops at its cap');
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
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workers[0].terminated, true, 'stuck worker terminated');
    assert.deepEqual(await ocrImage(Buffer.from('b'), { timeoutMs: 1000 }), { text: 'ok', confidence: 91 });
    assert.equal(workers.length, 2, 'a fresh worker served the next job');
    // A crashed worker is replaced as well.
    workers[1].recognize = () => Promise.reject(new Error('worker died'));
    await assert.rejects(ocrImage(Buffer.from('c')), /worker died/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workers[1].terminated, true);
    assert.equal((await ocrImage(Buffer.from('d'))).text, 'ok');
    assert.equal(workers.length, 3);
  } finally { await setOcrWorkerFactoryForTests(null); }
});

test('OCR worker: a worker that never starts times out and does not block later jobs', async () => {
  const { ocrImage, setOcrWorkerFactoryForTests } = await import('../lib/cv-ocr.ts');
  const { OcrTimeoutError } = await import('../lib/cv-bulk.ts');
  let starts = 0;
  await setOcrWorkerFactoryForTests(() => ++starts === 1 ? new Promise(() => {})
    : Promise.resolve({ recognize: async () => ({ data: { text: 'ok', confidence: 90 } }), terminate: async () => {} }));
  try {
    await assert.rejects(ocrImage(Buffer.from('a'), { timeoutMs: 50 }), error => error instanceof OcrTimeoutError);
    assert.equal((await ocrImage(Buffer.from('b'), { timeoutMs: 1000 })).text, 'ok', 'the queue is not blocked');
    assert.equal(starts, 2);
  } finally { await setOcrWorkerFactoryForTests(null); }
});

test('OCR queue: time spent waiting behind another job counts towards the deadline', async () => {
  const { ocrImage, setOcrWorkerFactoryForTests } = await import('../lib/cv-ocr.ts');
  const { OcrTimeoutError } = await import('../lib/cv-bulk.ts');
  let release;
  const recognized = [];
  await setOcrWorkerFactoryForTests(async () => ({
    recognize: image => { recognized.push(String(image)); return image.toString() === 'slow' ? new Promise(r => { release = () => r({ data: { text: 'x', confidence: 90 } }); }) : Promise.resolve({ data: { text: 'ok', confidence: 90 } }); },
    terminate: async () => {} }));
  try {
    const slow = ocrImage(Buffer.from('slow'), { timeoutMs: 1000 });
    const started = Date.now();
    await assert.rejects(ocrImage(Buffer.from('queued'), { timeoutMs: 50 }), error => error instanceof OcrTimeoutError);
    assert.ok(Date.now() - started < 500, 'the queued job gives up on its own deadline');
    release();
    await slow;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(recognized, ['slow'], 'an expired queued job is never recognised');
  } finally { await setOcrWorkerFactoryForTests(null); }
});

test('scheduler pump delivers every returned batch, in parallel', async () => {
  const rpc = async fn => fn === 'cv_bulk_worker_pump'
    ? { data: [1, 2, 3].map(n => ({ batch_id: `b${n}`, dispatch: [`${n}${n}${n}${n}${n}${n}${n}${n}-4444-4444-8444-444444444444`], notify: null })), error: null }
    : { data: true, error: null };
  let inFlight = 0, peak = 0;
  const dispatched = [];
  const count = await pumpAllSigned({ rpc, dispatch: async id => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight--; dispatched.push(id);
    if (id.startsWith('2')) throw new Error('one dispatch fails');
    return { accepted: true };
  }, aiEnabled: true, origin: () => 'https://x', env: {}, secret: 's'.repeat(32), digest: t => createHash('sha256').update(t).digest('hex') });
  assert.equal(count, 3);
  assert.equal(dispatched.length, 3, 'no counted re-send is left undelivered');
  assert.equal(peak, 3, 'batches are delivered in parallel, bounded by the per-request timeouts');
});


test('failed notification acknowledgement is reported, never mistaken for success', async () => {
  const batchId = '55555555-5555-4555-8555-555555555555';
  const notify = { batch_id: batchId, recruitment_id: '22222222-2222-4222-8222-222222222222',
    company_id: '33333333-3333-4333-8333-333333333333', email: null,
    recruitment_name: 'Rekrutacja', files: 1, done: 1, errors: 0, passed: 1, review: 0, rejected: 0 };
  const rpc = async fn => fn === 'cv_bulk_pump'
    ? { data: { dispatch: [], notify }, error: null }
    : { data: null, error: { message: 'private content from DB' } };
  const deps = { rpc, dispatch: async () => ({ accepted: true }), aiEnabled: false,
    origin: () => 'https://example.test', env: {} };
  await assert.rejects(pumpBatch(deps, batchId), error => error.message === 'cv_bulk_notification_finish_failed',
    'session failures are visible without forwarding DB content');
  await assert.rejects(pumpAllSigned({ ...deps,
    rpc: async fn => fn === 'cv_bulk_worker_pump'
      ? { data: [{ dispatch: [], notify }, { dispatch: [], notify: { ...notify, batch_id: '66666666-6666-4666-8666-666666666666' } }], error: null }
      : { data: null, error: { message: 'private content from DB' } },
    secret: 's'.repeat(32), digest: value => createHash('sha256').update(value).digest('hex'),
  }), error => error.message === 'cv_bulk_worker_delivery_failed',
  'scheduler failures remain visible without leaking provider/DB messages');

  await assert.rejects(pumpAllSigned({ ...deps,
    rpc: async () => ({ data: { dispatch: [] }, error: null }),
    secret: 's'.repeat(32), digest: value => createHash('sha256').update(value).digest('hex'),
  }), /cv_bulk_worker_pump_invalid_response/, 'an invalid worker response is not an empty successful run');
});

test('notification RPC must acknowledge a real lease update for both session and signed pumps', async () => {
  const batchId = '55555555-5555-4555-8555-555555555555';
  const notify = { batch_id: batchId, recruitment_id: '22222222-2222-4222-8222-222222222222',
    company_id: '33333333-3333-4333-8333-333333333333', email: null,
    recruitment_name: 'Synthetic', files: 1, done: 1, errors: 0, passed: 1, review: 0, rejected: 0 };
  for (const acknowledgement of [false, null, 'true', { updated: true }]) {
    const confirmed = [];
    const rpc = async (fn, args) => {
      if (fn === 'cv_bulk_pump') return { data: { dispatch: [], notify }, error: null };
      if (fn === 'cv_bulk_worker_pump') return { data: [{ dispatch: [], notify }], error: null };
      assert.equal(fn, 'cv_bulk_finish_notification');
      confirmed.push(args.target_batch);
      return { data: acknowledgement, error: null };
    };
    const deps = { rpc, dispatch: async () => ({ accepted: true }),
      aiEnabled: false, origin: () => 'https://example.test', env: {} };
    await assert.rejects(pumpBatch(deps, batchId),
      error => error.message === 'cv_bulk_notification_finish_failed',
      'a false/non-boolean session acknowledgement cannot be reported as success');
    await assert.rejects(pumpAllSigned({ ...deps, secret: 's'.repeat(32),
      digest: value => createHash('sha256').update(value).digest('hex') }),
    error => error.message === 'cv_bulk_worker_delivery_failed',
    'a false/non-boolean signed acknowledgement cannot be reported as success');
    assert.deepEqual(confirmed, [batchId, batchId], 'both paths attempt finalization once');
  }
});

test('signed scheduler rejects each malformed claimed batch while delivering the valid ones', async () => {
  const attemptId = '44444444-4444-4444-8444-444444444444';
  const batchId = '55555555-5555-4555-8555-555555555555';
  const notify = { batch_id: batchId, recruitment_id: '22222222-2222-4222-8222-222222222222',
    company_id: '33333333-3333-4333-8333-333333333333', email: null,
    recruitment_name: 'Syntetyczna', files: 1, done: 1, errors: 0, passed: 1, review: 0, rejected: 0 };
  const good = { dispatch: [attemptId], notify };
  const malformed = [null, [], {}, { dispatch: [] }, { dispatch: 'not an array', notify: null },
    { dispatch: [], notify: { batch_id: 'invalid' } }, { dispatch: [], notify: [] },
    { dispatch: [], notify: null, error: '23505' }];
  for (const bad of malformed) {
    const dispatched = [], acknowledged = [];
    const rpc = async (fn, args) => {
      if (fn === 'cv_bulk_worker_pump') return { data: [bad, good], error: null };
      assert.equal(fn, 'cv_bulk_finish_notification');
      acknowledged.push(args.target_batch);
      return { data: true, error: null };
    };
    await assert.rejects(pumpAllSigned({
      rpc, dispatch: async id => { dispatched.push(id); return { accepted: true }; },
      aiEnabled: false, origin: () => 'https://example.test', env: {},
      secret: 's'.repeat(32), digest: value => createHash('sha256').update(value).digest('hex'),
    }), error => error.message === 'cv_bulk_worker_pump_invalid_response',
    'malformed scheduler item must fail instead of reporting a successful count');
    assert.deepEqual(dispatched, [attemptId], 'valid claim is dispatched despite another malformed claim');
    assert.deepEqual(acknowledged, [batchId], 'valid notification is finalized despite malformed sibling');
  }
});

test('scheduler still processes every claimed batch when one notification acknowledgement fails', async () => {
  const ids = ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
  const finished = [];
  const notify = id => ({ batch_id: id, recruitment_id: '22222222-2222-4222-8222-222222222222',
    company_id: '33333333-3333-4333-8333-333333333333', email: null,
    recruitment_name: 'Rekrutacja', files: 1, done: 1, errors: 0, passed: 1, review: 0, rejected: 0 });
  const rpc = async (fn, args) => {
    if (fn === 'cv_bulk_worker_pump') return { data: ids.map(id => ({ dispatch: [], notify: notify(id) })), error: null };
    finished.push(args.target_batch);
    return { data: args.target_batch !== ids[0], error: args.target_batch === ids[0] ? { message: 'sensitive database error' } : null };
  };
  await assert.rejects(pumpAllSigned({
    rpc, dispatch: async () => ({ accepted: true }), aiEnabled: false,
    origin: () => 'https://example.test', env: {},
    secret: 's'.repeat(32), digest: value => createHash('sha256').update(value).digest('hex'),
  }), error => error.message === 'cv_bulk_worker_delivery_failed');
  assert.deepEqual(finished.sort(), ids, 'a failed acknowledgement never skips remaining claimed batches');
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


test('bulk upload failures never log untrusted CV parser or OCR exception text', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/[batchId]/items/[itemId]/route.ts', import.meta.url), 'utf8');
  const start = source.indexOf('} catch (error) {');
  const end = source.indexOf("const result = await client.rpc('cv_bulk_register_item'", start);
  assert.ok(start >= 0 && end > start, 'extract failure handler must remain present');
  const failure = source.slice(start, end);
  // OCR/format parsers may include unredacted names, contact details or file paths in Error.name/message.
  // A fixed operational marker is enough; no exception object or its properties reach the log.
  const logging = [...failure.matchAll(/console\.(?:error|warn|log|info|debug)\s*\(([^;]*)\);/g)];
  assert.deepEqual(logging.map(match => match[1].trim()), ["'cv_bulk_extract_failed'"]);
  assert.doesNotMatch(failure, /error\.(?:name|message|stack)|String\s*\(\s*error\s*\)|JSON\.stringify\s*\(\s*error\s*\)/);
  assert.match(failure, /error: 'extract_failed'/, 'retries remain possible on infrastructure errors');
});
