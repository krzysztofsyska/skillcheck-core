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
  // Hormozi offer layout (owner decision 2026-11-02): the result-first headline leads,
  // the old brand line moves into "dlaczego samo CV nie wystarcza".
  assert.match(home, /<h1 id="hero-title">Masz kandydatów\. Sprawdź, komu warto poświęcić czas\.<\/h1>/);
  assert.match(home, /Podobne CV\. Różni ludzie\. Zupełnie inne wyniki w pracy\./);
  assert.match(home, /Dlaczego samo CV nie wystarcza/);
  const heroIndex = home.indexOf('Masz kandydatów. Sprawdź, komu warto poświęcić czas.');
  assert.ok(heroIndex > -1 && heroIndex < home.indexOf('Podobne CV. Różni ludzie.'), 'headline precedes the moved brand line');
  // Slogans kept from the approved copy.
  for (const slogan of [
    'Własne CV. Mniej pracy powtarzalnej.',
    'CV pokazuje deklaracje. Sprawdź więcej.',
    'Nie płać za większy zakres, niż potrzebujesz.',
    'Wiesz, skąd bierze się każda kwota.',
    'Najpierw sprawdź. Potem zdecyduj.',
  ]) assert.ok(home.includes(slogan), `slogan kept: ${slogan}`);
  // Required section order.
  const sectionOrder = ['id="korzysci"', 'id="jak-to-dziala"', 'id="przyklad"', 'id="kalkulator"', 'id="pakiety"', 'id="agencja"', 'id="zalozenia"', 'id="faq"', 'id="zgloszenie"'];
  let cursor = -1;
  for (const section of sectionOrder) {
    const at = home.indexOf(section);
    assert.ok(at > cursor, `section ${section} present and in order`);
    cursor = at;
  }
  assert.match(home, /300 zł brutto/);
  assert.equal(home.includes('Po wycenie'), false);
  assert.equal(home.includes('To koncepcja oferty do oceny'), false);
  assert.equal(home.includes('Cena robocza z wizualizacji'), false);
  // Only FREE and PRESELEKCJA are sold; the later stages carry no price.
  assert.equal((home.match(/>Planowany pakiet<\/p>/g) ?? []).length, 0);
  assert.equal((home.match(/>Kolejny etap<\/p>/g) ?? []).length, 2, 'WERYFIKACJA and ASSESSMENT CENTER shown as later stages');
  for (const price of ['299', '369', '899', '1 799', '1799', '615', '1845']) {
    assert.equal(home.includes(price), false, `stale price ${price} removed from the home page`);
  }
  assert.ok(home.includes('5 analiz CV'), 'approved FREE scope (owner 2026-11-02)');
  assert.ok(home.includes('60 analiz CV'), 'approved PRESELEKCJA scope (owner 2026-10-28)');
  assert.equal(home.includes('5–6'), false);
  // Voicebot is not shown anywhere on the public offer (owner decision 2026-11-02).
  for (const voice of ['voicebot', 'Voicebot', 'rozmów AI', 'rozmowy AI', 'rozmowa weryfikacyjna', 'Rozmowa weryfikacyjna', 'rozmów z botem', 'rozmowy z botem']) {
    assert.equal(home.includes(voice), false, `no voicebot copy on the home page: ${voice}`);
  }
  assert.match(home, /KTIG CONSULTING/);
  const homeHrefs = hrefs(home);
  for (const href of ['/demo', '/register', '/login', '/#korzysci', '/#jak-to-dziala', '/#przyklad', '/#pakiety', '/#faq']) {
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
  assert.match(home, /Sprawdź koszt rekrutacji/);
  assert.match(home, /Wypróbuj FREE — 0 zł/);
  assert.ok(homeHrefs.includes('/preselekcja'), 'marketing points to PRESELEKCJA pilot');
  // Every CTA leads to an existing path: FREE, the offer page or the calculator.
  for (const href of homeHrefs.filter((link) => link.startsWith('/') && !link.startsWith('/_next') && !link.startsWith('/legal/'))) {
    const target = href.split('#')[0] || '/';
    assert.ok(
      ['/', '/demo', '/kalkulator', '/preselekcja', '/rozmowa', '/register', '/login', '/regulamin', '/polityka-prywatnosci', '/ai', '/prywatnosc'].includes(target),
      `home CTA points at an existing path: ${href}`,
    );
  }

  const calculatorRoute = await fetch(`${base}/kalkulator`, { redirect: 'manual' });
  assert.equal(calculatorRoute.status, 307);
  assert.equal(new URL(calculatorRoute.headers.get('location'), base).pathname, '/kalkulator-demo.html');
  const calculatorResponse = await fetch(`${base}/kalkulator-demo.html`);
  assert.equal(calculatorResponse.status, 200);
  assert.ok(calculatorResponse.headers.get('content-type')?.includes('text/html'));
  const calculator = await calculatorResponse.text();
  assert.match(calculator, /data-pack="pre"/);
  assert.match(calculator, /data-pack="free"/);
  assert.match(calculator, /data-package-price="pre">300 zł</);
  assert.match(calculator, /data-package-price="free">0 zł</);
  assert.match(calculator, /pre:30000/);
  assert.match(calculator, /PRE_PACKAGE_CV=60;/);
  assert.match(calculator, /id="volumeSlider"/);
  assert.match(calculator, /nie pobiera płatności/i);
  // The calculator shows the cost of manual CV reading and the agency comparison
  // on editable assumptions, with no AI cost and no margin (owner decision 2026-11-02).
  assert.match(calculator, /id="timePerCv"/);
  assert.match(calculator, /id="hourlyTimeCost"/);
  assert.match(calculator, /id="manualHours"/);
  assert.match(calculator, /id="manualCost"/);
  assert.match(calculator, /id="agencyFixed"/);
  assert.match(calculator, /id="extraCosts"/);
  assert.match(calculator, /nie jest gwarantowana oszczędność|nie gwarantowana oszczędność/);
  assert.match(calculator, /Wiesz, skąd bierze się każda kwota\./);
  assert.match(calculator, /Nie płać za większy zakres, niż potrzebujesz\./);
  assert.match(calculator, /Najpierw sprawdź\. Potem zdecyduj\./);
  assert.match(calculator, /Własne CV\. Mniej pracy powtarzalnej\./);
  assert.match(calculator, /CV pokazuje deklaracje\. Sprawdź więcej\./);
  // No demo purchase, no unapproved prices, no voicebot, no AI cost or margin.
  assert.equal(calculator.includes('Kup teraz'), false);
  assert.equal(calculator.includes('buyDemoButton'), false);
  assert.equal(calculator.includes('data-pack="verify"'), false);
  assert.equal(calculator.includes('data-pack="ac"'), false);
  for (const price of ['299', '369', '899', '1799', '1 799', '615 zł', '1845']) {
    assert.equal(calculator.includes(price), false, `stale price ${price} removed from the calculator`);
  }
  for (const voice of ['voicebot', 'Voicebot', 'rozmów AI', 'rozmowy AI', 'rozmów voicebota', 'Rozmowy voicebota', 'próbna rozmowa']) {
    assert.equal(calculator.includes(voice), false, `no voicebot copy in the calculator: ${voice}`);
  }
  for (const internal of ['marża', 'marży', 'koszt AI', 'koszty AI', 'narzut']) {
    assert.equal(calculator.toLowerCase().includes(internal.toLowerCase()), false, `no internal cost or margin shown: ${internal}`);
  }
  // WERYFIKACJA and ASSESSMENT CENTER appear as later stages without a price.
  assert.match(calculator, /WERYFIKACJA — kolejny etap/);
  assert.match(calculator, /ASSESSMENT CENTER — kolejny etap/);
  for (const href of ['/preselekcja', '/preselekcja#free']) {
    assert.ok(hrefs(calculator).includes(href), `calculator CTA to ${href}`);
  }

  const orderResponse = await fetch(`${base}/preselekcja`, { redirect: 'manual' });
  assert.equal(orderResponse.status, 200);
  assert.match(orderResponse.headers.get('content-type'), /text\/html/);
  const order = await orderResponse.text();
  assert.match(order, /PRESELEKCJA — 60 analiz CV za 300 zł brutto/);
  const orderText = order.replaceAll('<!-- -->', '');
  for (const fact of [/243,90 zł netto/, /ważne przez 3 miesiące/, /faktury proforma/, /2 dni roboczych/, /fakturę VAT/]) assert.match(orderText, fact);
  // Payment methods shown on the offer (owner decision 2026-11-02): Przelewy24 and
  // a bank transfer on a proforma invoice.
  assert.match(orderText, /Przelewy24/);
  assert.ok(hrefs(order).includes('/regulamin') && hrefs(order).includes('/polityka-prywatnosci'));
  assert.doesNotMatch(order, /potwierdzane indywidualnie|pilotaż/);
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
  assert.match(home, /PRESELEKCJA: 60 CV za 300 zł/);
  assert.match(home, /Według oferty/);
  assert.match(home, /Analiza 60 CV, shortlista i raport/, 'approved PRESELEKCJA description');
  assert.match(home, /Analiza 5 CV/, 'approved FREE description');
  assert.match(order, /zawsze weryfikuje osoba prowadząca rekrutację/);
  assert.doesNotMatch(order, /<li>Wyniki, ranking, shortlistę i raport weryfikuje/);
  const comparison = readFileSync(new URL('../app/components/marketing/package-comparison.tsx', import.meta.url), 'utf8');
  const lines = comparison.split('\n');
  const offer = lines.find(line => line.includes('name:"PRESELEKCJA"'));
  assert.ok(offer, 'PRESELEKCJA offer defined');
  assert.match(offer, /scope:`\$\{preselectionCount \?\? sc19PolicyPendingScope\}/);
  assert.match(comparison, /preselekcjaAnalyses\(catalogEnabled, sizes\)/);
  const offerSource = readFileSync(new URL('../app/components/marketing/preselekcja-offer.ts', import.meta.url), 'utf8');
  assert.match(offerSource, /if \(sizes\) return sizes\.PRESELEKCJA;\s*return catalogEnabled \? null : preselekcjaOffer\.analyses;/, 'live catalog wins; enabled failure shows no number');
  // The static calculator cannot read the catalog: keep its package size and net price equal to the approved offer.
  assert.equal(calculator.match(/PRE_PACKAGE_CV=(\d+);/)?.[1], offerSource.match(/analyses: (\d+),/)?.[1]);
  assert.equal(calculator.match(/PRE_NET_CENTS=(\d+);/)?.[1], offerSource.match(/netPln: "(\d+),(\d+)"/)?.slice(1).join(''));
  assert.equal(calculator.match(/FREE_CV=(\d+);/)?.[1], offerSource.match(/freeOffer = \{\s*analyses: (\d+),/)?.[1], 'calculator FREE size equals the approved offer');
  assert.doesNotMatch(comparison, /WERYFIKACJA[^\n]*price:/, 'no price for the later stages');
  assert.doesNotMatch(comparison, /ASSESSMENT CENTER[^\n]*price:/, 'no price for the later stages');
  assert.doesNotMatch(offer, /60 analiz CV|Shortlista 5–10 kandydatów/);
  const cvRow = lines.find(line => line.trimStart().startsWith('["Analizy CV"'));
  const shortlistRow = lines.find(line => line.trimStart().startsWith('["Shortlista \/ raport preselekcji"'));
  assert.ok(cvRow?.includes('analyses === null ? sc19PolicyPendingCell : String(analyses)'));
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
