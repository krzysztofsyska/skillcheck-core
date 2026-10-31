// Browser E2E for SC Step 4 on a running SkillCheck build connected to the
// skillcheck-preview TEST project (never production data): recruitment stages,
// a manual candidate move with its history, interview note autosave with
// revisions, an explicit human decision with its history, and the link to the
// Step 3 interview topics. Fails on any Content-Security-Policy violation.
// Uses the same test account and configuration as scripts/preview-smoke.cjs;
// credentials and IDs come from the environment and are never printed.
// Playwright is not an app dependency: an external runtime can be given with
// PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and BROWSER_ARGS.
const { randomInt } = require('node:crypto');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
catch {
  console.error('Brak Playwright: zainstaluj go poza projektem i wskaż PLAYWRIGHT_MODULE (ścieżka do modułu playwright).');
  process.exit(1);
}

const required = ['SMOKE_BASE_URL', 'SMOKE_EMAIL', 'SMOKE_PASSWORD', 'SMOKE_COMPANY_ID', 'SMOKE_RECRUITMENT_ID', 'SMOKE_APPLICATION_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error('Brak konfiguracji testu Preview: ' + missing.join(', '));
  process.exit(1);
}
const env = Object.fromEntries(required.map((name) => [name, process.env[name]]));
const base = env.SMOKE_BASE_URL.replace(/\/$/, '');
const marker = 'e2e' + Array.from({ length: 10 }, () => String.fromCharCode(97 + randomInt(26))).join('');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: JSON.parse(process.env.BROWSER_ARGS || '[]') });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
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
  const recruitment = `${base}/dashboard/${env.SMOKE_COMPANY_ID}/recruitments/${env.SMOKE_RECRUITMENT_ID}`;
  const assessments = `${recruitment}/applications/${env.SMOKE_APPLICATION_ID}/assessments`;
  const stageA = `Etap ${marker} A`;
  const stageB = `Etap ${marker} B`;
  const summaryCount = async (label) => {
    const text = await page.locator('summary', { hasText: label }).first().innerText();
    return Number(/\((\d+)\)/.exec(text)?.[1] ?? NaN);
  };

  await step('logowanie', async () => {
    await page.goto(base + '/login');
    await page.fill('input[name=email]', env.SMOKE_EMAIL);
    await page.fill('input[name=password]', env.SMOKE_PASSWORD);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('button[type=submit]')]);
    if (!new URL(page.url()).pathname.startsWith('/dashboard')) throw new Error('po logowaniu: ' + page.url());
  });

  await step('dodanie dwóch etapów', async () => {
    for (const name of [stageA, stageB]) {
      const r = await page.goto(recruitment);
      if (r.status() >= 400) throw new Error('HTTP ' + r.status());
      await page.locator('summary', { hasText: 'Dodaj etap oceny' }).click();
      const form = page.locator('form', { has: page.getByRole('button', { name: 'Dodaj etap' }) });
      await form.locator('input[name=name]').fill(name);
      await form.getByRole('button', { name: 'Dodaj etap' }).click();
      await form.getByRole('status').waitFor({ timeout: 20000 });
    }
    await page.goto(recruitment);
    for (const name of [stageA, stageB]) await page.getByText(name).first().waitFor({ timeout: 10000 });
  });

  await step('zmiana kolejności etapu', async () => {
    await page.goto(recruitment);
    const controls = page.locator('details', { has: page.locator(`input[name=name][value="${stageB}"]`) });
    await controls.locator('summary').click();
    await controls.getByRole('button', { name: 'Przesuń wyżej' }).click();
    await page.waitForTimeout(1500);
    await page.goto(recruitment);
    const text = await page.locator('main').innerText();
    if (text.indexOf(stageB) > text.indexOf(stageA)) throw new Error('etap B nie jest przed etapem A');
  });

  await step('ręczne przesunięcie kandydata z historią', async () => {
    await page.goto(assessments);
    const before = await summaryCount('Historia zmian etapu');
    const form = page.locator('form', { has: page.getByRole('button', { name: 'Przesuń kandydata ręcznie' }) });
    await form.locator('select[name=stageId]').selectOption({ label: stageA });
    await form.getByRole('button', { name: 'Przesuń kandydata ręcznie' }).click();
    await form.getByRole('status').waitFor({ timeout: 20000 });
    await page.goto(assessments);
    const current = await page.locator('h2', { hasText: 'Aktualny etap' }).locator('xpath=following-sibling::p[1]').innerText();
    if (current.trim() !== stageA) throw new Error('aktualny etap: ' + current);
    const after = await summaryCount('Historia zmian etapu');
    if (after !== before + 1) throw new Error(`historia etapu ${before} → ${after}`);
  });

  await step('autozapis notatki i historia wersji', async () => {
    await page.goto(assessments);
    const article = page.locator('article', { has: page.locator('h3', { hasText: stageA }) });
    const before = await article.locator('summary', { hasText: 'Historia edycji notatki' }).innerText().then((t) => Number(/\((\d+)\)/.exec(t)[1]));
    const notes = article.locator('textarea[name=notes]');
    await notes.fill(`Pierwsza obserwacja ${marker}`);
    await article.getByText('Notatka zapisana.').waitFor({ timeout: 20000 });
    await notes.fill(`Druga obserwacja ${marker}`);
    await article.getByText('Notatka zapisana.').waitFor({ timeout: 20000 });
    await page.goto(assessments);
    const reloaded = page.locator('article', { has: page.locator('h3', { hasText: stageA }) });
    if (await reloaded.locator('textarea[name=notes]').inputValue() !== `Druga obserwacja ${marker}`) throw new Error('notatka nie przetrwała odświeżenia');
    const after = await reloaded.locator('summary', { hasText: 'Historia edycji notatki' }).innerText().then((t) => Number(/\((\d+)\)/.exec(t)[1]));
    if (after !== before + 2) throw new Error(`historia notatki ${before} → ${after}`);
  });

  await step('decyzja człowieka wymaga wyboru i uzasadnienia', async () => {
    await page.goto(assessments);
    const form = page.locator('form', { has: page.getByRole('button', { name: 'Zapisz decyzję człowieka' }) });
    if (await form.locator('select[name=decision]').inputValue() !== '') throw new Error('decyzja ma wartość domyślną');
    if (!await form.locator('select[name=decision]').evaluate((el) => !el.checkValidity())) throw new Error('pusta decyzja przechodzi walidację');
    await form.locator('select[name=decision]').selectOption('on_hold');
    await form.locator('textarea[name=reason]').fill('za mało');
    if (!await form.locator('textarea[name=reason]').evaluate((el) => !el.checkValidity())) throw new Error('za krótkie uzasadnienie przechodzi walidację');
  });

  await step('zapis decyzji z uzasadnieniem i historią', async () => {
    await page.goto(assessments);
    const before = await summaryCount('Historia decyzji');
    const form = page.locator('form', { has: page.getByRole('button', { name: 'Zapisz decyzję człowieka' }) });
    await form.locator('select[name=decision]').selectOption('on_hold');
    await form.locator('textarea[name=reason]').fill(`Czekamy na referencje (${marker}).`);
    await form.getByRole('button', { name: 'Zapisz decyzję człowieka' }).click();
    await form.getByRole('status').waitFor({ timeout: 20000 });
    await page.goto(assessments);
    await page.getByText(`Czekamy na referencje (${marker}).`).first().waitFor({ timeout: 10000 });
    const after = await summaryCount('Historia decyzji');
    if (after !== before + 1) throw new Error(`historia decyzji ${before} → ${after}`);
  });

  await step('link do pytań na rozmowę i z powrotem', async () => {
    await page.goto(assessments);
    await page.getByRole('link', { name: 'Pytania na rozmowę z analizy CV' }).first().click();
    await page.waitForURL(/\/interview$/, { timeout: 20000 });
    await page.getByRole('heading', { name: 'Przygotowanie do rozmowy' }).waitFor({ timeout: 10000 });
    await page.getByRole('link', { name: 'Notatki z rozmowy, etap i decyzja' }).click();
    await page.waitForURL(/\/assessments$/, { timeout: 20000 });
  });

  await browser.close();
  console.log(failed ? `Wynik: ${failed} problem(ów)` : 'Wynik: krok 4 działa w przeglądarce, brak naruszeń CSP');
  process.exit(failed ? 1 : 0);
})();
