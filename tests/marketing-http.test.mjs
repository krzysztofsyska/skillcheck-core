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
  assert.match(home, /Uporządkuj ocenę kandydatów przed rozmową rekrutacyjną/);
  const homeHrefs = hrefs(home);
  for (const href of ['/demo', '/register', '/login', '/#jak-to-dziala', '/#mozliwosci', '/#pakiety', '/#faq']) {
    assert.ok(homeHrefs.includes(href), `home link ${href}`);
  }
  assert.equal(home.includes('<form'), false);
  assert.equal(home.includes('Zapłać'), false);
  assert.equal(home.includes('Aktywuj pakiet'), false);
  assert.equal(home.includes('Kup teraz'), false);
  assert.equal(home.includes('127.0.0.1:9'), false);

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
