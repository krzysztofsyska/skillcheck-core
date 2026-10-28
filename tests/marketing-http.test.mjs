import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';

function hrefs(html) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

test('public offer and demo pages respond without an account', async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: {
      ...process.env,
      // General marketing contract with packages disabled. The separate SC-019
      // runtime suite proves ON requests actually hit the local catalog RPC.
      SC19_PACKAGES_ENABLED: 'false',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-only-public-key',
      NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(base)).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Next server started');

  const homeResponse = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(homeResponse.status, 200);
  assert.match(homeResponse.headers.get('content-type'), /text\/html/);
  const home = await homeResponse.text();
  assert.match(home, /Podobne CV\. Różni ludzie\. Zupełnie inne wyniki w pracy\./);
  assert.match(home, /Cztery poziomy\. Jedna platforma\./);
  assert.match(home, /Cena robocza z wizualizacji/);
  assert.match(home, /300 zł brutto/);
  assert.equal(home.includes('Po wycenie'), false);
  assert.equal(home.includes('To koncepcja oferty do oceny'), false);
  assert.equal((home.match(/>Planowany pakiet<\/p>/g) ?? []).length, 3);
  assert.match(home, /Liczba analiz CV według zatwierdzonej polityki/);
  assert.equal(home.includes('5 analiz CV'), false);
  assert.equal(home.includes('60 analiz CV'), false);
  assert.equal(home.includes('5–6'), false);
  assert.match(home, /KTIG CONSULTING/);
  const homeHrefs = hrefs(home);
  for (const href of ['/demo', '/register', '/login', '/#jak-to-dziala', '/#mozliwosci', '/#pakiety', '/#faq']) {
    assert.ok(homeHrefs.includes(href), `home link ${href}`);
  }
  assert.equal(home.includes('<form'), false);
  assert.equal(home.includes('Zapłać'), false);
  assert.equal(home.includes('Aktywuj pakiet'), false);

  // SC-LEGAL-001: company data and legal documents required for Przelewy24 shop verification.
  for (const text of ['NIP 7394002294', 'KRS 0001110252', 'REGON 528903093', '+48 730 266 909']) assert.ok(home.includes(text), `footer ${text}`);
  for (const href of ['/regulamin', '/polityka-prywatnosci', '/ai']) assert.ok(homeHrefs.includes(href), `footer link ${href}`);
  for (const [path, heading, marker, docx] of [
    ['/regulamin', 'Regulamin świadczenia usług SkillCheck', 'PayPro S.A. Agent Rozliczeniowy', '/legal/01_Regulamin_SkillCheck_v1.0.docx'],
    ['/polityka-prywatnosci', 'Polityka prywatności SkillCheck', 'Wykazu podatników VAT', '/legal/02_Polityka_prywatnosci_v1.0.docx'],
    ['/regulamin/umowa-powierzenia', 'Umowa powierzenia przetwarzania danych osobowych (DPA)', 'art. 28 ust. 3 RODO', '/legal/03_Umowa_powierzenia_DPA_v1.0.docx'],
    ['/regulamin/formularz-odstapienia', 'Wzór formularza odstąpienia od umowy', 'informuję o moim odstąpieniu', '/legal/04_Formularz_odstapienia_v1.0.docx'],
    ['/ai', 'AI i nadzór człowieka w SkillCheck', 'Decyzję podejmuje człowiek', '/legal/05_AI_i_nadzor_czlowieka_v1.0.docx'],
  ]) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(html.includes(`<h1>${heading}</h1>`), `${path} heading`);
    assert.ok(html.includes(marker), `${path} content`);
    assert.ok(html.includes('NIP 7394002294'), `${path} footer`);
    assert.equal(html.includes('PROJEKT'), false, `${path} has no draft marker`);
    assert.equal(html.includes('NIE PUBLIKOWAĆ'), false, `${path} has no draft marker`);
    assert.ok(hrefs(html).includes(docx), `${path} docx link`);
    const file = await fetch(`${base}${docx}`);
    assert.equal(file.status, 200, docx);
  }
  assert.equal(home.includes('Kup teraz'), false);
  assert.equal(home.includes('127.0.0.1:9'), false);


  // Sales pilot intake is available without enabling paid checkout or AI.
  assert.ok(homeHrefs.includes('/kalkulator'), 'marketing links to clickable calculator');
  assert.match(home, /Sprawdź kalkulator pakietów/);
  assert.ok(homeHrefs.includes('/preselekcja'), 'marketing points to PRESELEKCJA pilot');

  const calculatorRoute = await fetch(`${base}/kalkulator`, { redirect: 'manual' });
  assert.equal(calculatorRoute.status, 307);
  assert.equal(new URL(calculatorRoute.headers.get('location'), base).pathname, '/kalkulator-demo.html');
  const calculatorResponse = await fetch(`${base}/kalkulator-demo.html`);
  assert.equal(calculatorResponse.status, 200);
  assert.ok(calculatorResponse.headers.get('content-type')?.includes('text/html'));
  const calculator = await calculatorResponse.text();
  assert.match(calculator, /Interaktywny podgląd koncepcji/);
  assert.match(calculator, /data-pack="pre"/);
  assert.match(calculator, /data-package-price="pre">300 zł</);
  assert.match(calculator, /pre:30000,/);
  assert.equal(calculator.includes('369'), false);
  assert.match(calculator, /data-pack="verify"/);
  assert.match(calculator, /id="volumeSlider"/);
  assert.match(calculator, /Kup teraz · podgląd/);
  assert.match(calculator, /nie pobieramy płatności/i);

  const orderResponse = await fetch(`${base}/preselekcja`, { redirect: 'manual' });
  assert.equal(orderResponse.status, 200);
  assert.match(orderResponse.headers.get('content-type'), /text\/html/);
  const order = await orderResponse.text();
  assert.match(order, /Zapytaj o preselekcję kandydatów/);
  assert.match(order, /Cena|cenę|cena/);
  assert.match(order, /Nie przesyłaj CV zwykłym e-mailem/);
  assert.match(order, /samo utworzenie konta nie przyznaje analiz/);
  const inquiries = hrefs(order).filter(href => href.startsWith('mailto:pomoc@skillcheck.pl?subject='));
  assert.equal(inquiries.length, 2, 'paid inquiry and FREE inquiry are separate');
  for (const href of inquiries) {
    const url = new URL(href.replaceAll('&amp;', '&'));
    const subject = url.searchParams.get('subject');
    const body = url.searchParams.get('body');
    assert.ok(subject && !/zamówienie|zakup|zapłać/i.test(subject), 'email is not a placed order');
    assert.ok(body && body.includes('\r\n'), 'RFC6068 CRLF mail body');
    assert.doesNotMatch(body, /osoba kontaktowa|numer telefonu|służbowy e-mail|imię i nazwisko/i);
    assert.doesNotMatch(body, /PESEL|@example/i);
  }
  assert.ok(homeHrefs.includes('/preselekcja#free'), 'FREE CTA anchors to the FREE section');
  assert.match(order, /id="free"/, 'FREE anchor is on section, below sticky header');
  assert.ok(hrefs(order).includes('/register'));
  assert.doesNotMatch(order, /<form[ >]/);
  assert.doesNotMatch(order, /Zapłać|Kup teraz|Aktywuj pakiet/);
  assert.match(order, /aktualnie te funkcje nie są udostępnione do samodzielnego użycia/);
  assert.match(home, /Zapytaj o pilotaż PRESELEKCJA/);
  assert.match(home, /Według oferty/);
  assert.match(order, /Jeżeli potwierdzimy dostępność tych funkcji/);
  assert.doesNotMatch(order, /<li>Wyniki, ranking, shortlistę i raport weryfikuje/);
  const comparison = readFileSync(new URL('../app/components/marketing/package-comparison.tsx', import.meta.url), 'utf8');
  const lines = comparison.split('\n');
  const offer = lines.find(line => line.includes('name:"PRESELEKCJA"'));
  assert.ok(offer, 'PRESELEKCJA offer defined');
  assert.match(offer, /scope:offer.preselectionScope/);
  assert.doesNotMatch(offer, /60 analiz CV|Shortlista 5–10 kandydatów/);
  const cvRow = lines.find(line => line.trimStart().startsWith('["Analizy CV"'));
  const shortlistRow = lines.find(line => line.trimStart().startsWith('["Shortlista \/ raport preselekcji"'));
  assert.ok(cvRow?.includes('offer.preselectionAnalyses'));
  assert.ok(shortlistRow?.includes('"Według oferty"'));

  const demoResponse = await fetch(`${base}/demo`, { redirect: 'manual' });
  assert.equal(demoResponse.status, 200);
  assert.match(demoResponse.headers.get('content-type'), /text\/html/);
  const demo = await demoResponse.text();
  assert.match(demo, /Dane demonstracyjne — fikcyjny przykład prezentacji informacji o kandydatach/);
  assert.match(demo, /nie jest wynikiem analizy wykonanej dla użytkownika/);
  const demoHrefs = hrefs(demo);
  assert.ok(demoHrefs.includes('/'), 'demo link back to the offer');
  assert.ok(demoHrefs.includes('/register'), 'demo link to register');
  for (const label of ['Przedstawiciel handlowy', 'Piotr Adamski', 'Helena Nowak', 'Marta Zielińska', 'Doświadczenie w sprzedaży B2B', 'Pozyskiwanie klientów', 'Praca z CRM', 'Prowadzenie negocjacji', 'Brak danych', 'Do wyjaśnienia']) {
    assert.match(demo, new RegExp(label));
  }
  assert.doesNotMatch(demo, /\d+\s*%/);
  assert.equal(demo.includes('<form'), false);
  assert.equal(demo.includes('Zapłać'), false);
  assert.equal(demo.includes('Aktywuj pakiet'), false);
  assert.equal(demo.includes('127.0.0.1:9'), false);
  assert.equal(logs.includes('127.0.0.1:9'), false);
});
