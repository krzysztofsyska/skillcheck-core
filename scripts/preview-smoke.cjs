// Browser smoke test for a running SkillCheck build connected to the
// skillcheck-preview TEST project (never production data). Checks login,
// company dashboard, CV PDF upload, screening report + CSV export, /kalkulator
// and /demo, and fails on any Content-Security-Policy violation.
// Credentials and IDs come from the environment and are never printed.
// The test account smoke-test@skillcheck-preview.invalid lives only in the test
// project; an agent that needs its password sets a new one there (bcrypt hash
// via SQL) instead of asking the owner.
const { chromium } = require('playwright');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const required = ['SMOKE_BASE_URL', 'SMOKE_EMAIL', 'SMOKE_PASSWORD', 'SMOKE_COMPANY_ID', 'SMOKE_RECRUITMENT_ID', 'SMOKE_CANDIDATE_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error('Brak konfiguracji testu Preview: ' + missing.join(', '));
  process.exit(1);
}
const env = Object.fromEntries(required.map((name) => [name, process.env[name]]));
const base = env.SMOKE_BASE_URL.replace(/\/$/, '');

// Minimal one-page text PDF, generated so no fixture with personal data is needed.
function samplePdf() {
  const text = 'Jan Testowy - CV testowe. Doswiadczenie: 5 lat w testowaniu oprogramowania.';
  const content = `BT /F1 11 Tf 50 750 Td (${text}) Tj ET`;
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
  const browser = await chromium.launch();
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
    await page.locator('details summary', { hasText: 'Dodaj tekst CV' }).click();
    await page.setInputFiles('input[name=cv_file]', samplePdf());
    await page.getByText('Wybrany plik:').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Zapisz CV/ }).click();
    await page.locator('textarea[name=redacted_text], main [role=alert]').first().waitFor({ timeout: 60000 });
    if (await page.locator('main [role=alert]').count()) throw new Error('alert: ' + await page.locator('main [role=alert]').first().innerText());
    if (!/testowaniu/.test(await page.locator('textarea[name=redacted_text]').first().inputValue())) throw new Error('tekst z PDF nie trafił do propozycji anonimizacji');
  });
  await step('raport', async () => {
    const r = await page.goto(`${recruitment}/report`);
    if (r.status() >= 400) throw new Error('HTTP ' + r.status());
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
