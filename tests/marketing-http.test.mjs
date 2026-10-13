import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

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
  assert.match(home, /KTIG CONSULTING/);
  const homeHrefs = hrefs(home);
  for (const href of ['/demo', '/register', '/login', '/#jak-to-dziala', '/#mozliwosci', '/#pakiety', '/#faq']) {
    assert.ok(homeHrefs.includes(href), `home link ${href}`);
  }
  assert.equal(home.includes('<form'), false);
  assert.equal(home.includes('Zapłać'), false);
  assert.equal(home.includes('Aktywuj pakiet'), false);
  assert.equal(home.includes('Kup teraz'), false);
  assert.equal(home.includes('127.0.0.1:9'), false);


  // Sales pilot intake is available without enabling paid checkout or AI.
  assert.ok(homeHrefs.includes('/preselekcja'), 'marketing points to PRESELEKCJA pilot');

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
  assert.ok(hrefs(order).includes('/preselekcja#free-title') || homeHrefs.includes('/preselekcja'), 'offer route discoverable');
  assert.ok(hrefs(order).includes('/register'));
  assert.doesNotMatch(order, /<form[ >]/);
  assert.doesNotMatch(order, /Zapłać|Kup teraz|Aktywuj pakiet/);
  assert.match(order, /aktualnie te funkcje nie są udostępnione do samodzielnego użycia/);
  assert.match(home, /Zapytaj o pilotaż PRESELEKCJA/);
  assert.match(home, /Według oferty/);

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
