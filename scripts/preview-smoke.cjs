// Browser smoke test for a running SkillCheck build connected to the
// skillcheck-preview TEST project (never production data). Checks login,
// company dashboard, CV PDF upload, screening report + CSV export, /kalkulator
// and /demo, and fails on any Content-Security-Policy violation.
// Credentials and IDs come from the environment and are never printed.
// The test account smoke-test@skillcheck-preview.invalid lives only in the test
// project; an agent that needs its password sets a new one there (bcrypt hash
// via SQL) instead of asking the owner.
// Playwright is not an app dependency: like the other browser tests, an external
// runtime can be given with PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and BROWSER_ARGS.
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomInt } = require('node:crypto');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
catch {
  console.error('Brak Playwright: zainstaluj go poza projektem i wskaż PLAYWRIGHT_MODULE (ścieżka do modułu playwright).');
  process.exit(1);
}

const required = ['SMOKE_BASE_URL', 'SMOKE_EMAIL', 'SMOKE_PASSWORD', 'SMOKE_COMPANY_ID', 'SMOKE_RECRUITMENT_ID', 'SMOKE_CANDIDATE_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error('Brak konfiguracji testu Preview: ' + missing.join(', '));
  process.exit(1);
}
const env = Object.fromEntries(required.map((name) => [name, process.env[name]]));
const base = env.SMOKE_BASE_URL.replace(/\/$/, '');

// Letters only, so the redaction suggestions (phone/ID numbers) leave it intact.
const marker = 'smoke' + Array.from({ length: 12 }, () => String.fromCharCode(97 + randomInt(26))).join('');

// Minimal one-page text PDF, generated so no fixture with personal data is needed.
// The per-run marker identifies the document created by this run.
function samplePdf() {
  const text = 'Jan Testowy - CV testowe. Doswiadczenie: 5 lat w testowaniu oprogramowania.';
  const content = `BT /F1 11 Tf 50 750 Td (${text}) Tj 0 -16 Td (Znacznik: ${marker}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const at = out.length; out += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(mkdtempSync(join(tmpdir(), 'sc-smoke-')), 'cv-test.pdf');
  writeFileSync(path, out, 'latin1');
  return path;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: JSON.parse(process.env.BROWSER_ARGS || '[]') });
  const page = await browser.newPage();
  const csp = [];
  const errors = [];
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t); else if (m.type() === 'error') errors.push(t); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  let failed = 0;
  const step = async (name, fn) => {
    const c0 = csp.length;
    const e0 = errors.length;
    try { console.log('OK  ', name, (await fn()) ?? ''); } catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); }
    if (csp.length > c0) { failed++; console.log('     CSP:', csp.slice(c0)); }
    if (errors.length > e0) console.log('     console:', errors.slice(e0));
  };
  const company = `${base}/dashboard/${env.SMOKE_COMPANY_ID}`;
  const recruitment = `${company}/recruitments/${env.SMOKE_RECRUITMENT_ID}`;

  await step('logowanie', async () => {
    await page.goto(base + '/login');
    await page.fill('input[name=email]', env.SMOKE_EMAIL);
    await page.fill('input[name=password]', env.SMOKE_PASSWORD);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('button[type=submit]')]);
    if (!new URL(page.url()).pathname.startsWith('/dashboard')) throw new Error('po logowaniu: ' + page.url());
  });
  await step('panel firmy', async () => {
    const r = await page.goto(company);
    if (r.status() >= 400) throw new Error('HTTP ' + r.status());
  });
  await step('wgranie PDF (CV)', async () => {
    await page.goto(`${company}/candidates/${env.SMOKE_CANDIDATE_ID}/cv`);
    const intake = page.locator('details', { has: page.locator('summary', { hasText: 'Dodaj tekst CV' }) });
    await intake.locator('summary').click();
    await intake.locator('input[name=cv_file]').setInputFiles(samplePdf());
    await intake.getByText('Wybrany plik:').waitFor({ timeout: 10000 });
    await intake.getByRole('button', { name: /Zapisz CV/ }).click();
    // Result of this submission only; earlier documents on the page do not count.
    const feedback = intake.locator('[role=status], [role=alert]').first();
    await feedback.waitFor({ state: 'attached', timeout: 60000 });
    if (await feedback.getAttribute('role') === 'alert') throw new Error('alert: ' + await feedback.innerText());
    const created = page.locator('article', { has: page.locator('pre.cv-text', { hasText: marker }) });
    await created.waitFor({ state: 'attached', timeout: 20000 });
    const redacted = await created.locator('textarea[name=redacted_text]').inputValue();
    if (!redacted.includes(marker) || !/testowaniu/.test(redacted)) throw new Error('tekst z PDF nie trafił do propozycji anonimizacji');
  });
  await step('raport', async () => {
    const r = await page.goto(`${recruitment}/report`);
    if (r.status() >= 400) throw new Error('HTTP ' + r.status());
    // The error view is also HTTP 200; only a loaded report renders its controls.
    if (!await page.locator('nav[aria-label="Działania raportu"]').count()) {
      const notice = await page.locator('main [role=status]').first().innerText().catch(() => '');
      throw new Error('raport się nie wczytał' + (notice ? ': ' + notice : ''));
    }
  });
  await step('eksport raportu (CSV)', async () => {
    const r = await page.request.get(`${recruitment}/report/export?size=10`);
    if (r.status() !== 200 || !/text\/csv/.test(r.headers()['content-type'] ?? '')) throw new Error(`HTTP ${r.status()} ${r.headers()['content-type']}`);
  });
  for (const path of ['/kalkulator', '/demo']) {
    await step(path, async () => {
      const r = await page.goto(base + path);
      await page.waitForTimeout(1500);
      if (r.status() >= 400) throw new Error('HTTP ' + r.status());
    });
  }
  await browser.close();
  console.log(failed ? `Wynik: ${failed} problem(ów)` : 'Wynik: wszystko działa, brak naruszeń CSP');
  process.exit(failed ? 1 : 0);
})();
