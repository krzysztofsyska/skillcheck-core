import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { uuid } from './helpers/screening-report-fixture.mjs';
import { ids, sessionPayload } from './helpers/ac-session-payload.mjs';

// SC-AC-SESSION (#276): the real Next session page over HTTP, from the panel to the
// rendered result, with a synthetic Auth + PostgREST boundary. This is NOT a test of
// real RLS or of the RPC authorization (tests/ac-session-database.test.mjs is): the
// stub answers what the page asks, and the signed-in user belongs to BOTH companies,
// so the URL scoping in the page is what is tested here. Synthetic data only.
const userId = ids.owner;
const companyA = uuid(1), companyB = uuid(2);
const recA = ids.recruitment, recBroken = uuid(13), recB = uuid(12);
const posA = uuid(31), posB = uuid(32);
const appC = uuid(43), appForeign = uuid(44);
const ts = '2026-11-12T08:00:00.000Z';
const FOREIGN = /Kandydat Obcy|Rekrutacja Obca/;
const data = {
  companies: [{ id: companyA, name: 'Firma A', owner_id: userId }, { id: companyB, name: 'Firma B', owner_id: uuid(51) }],
  company_members: [{ company_id: companyA, user_id: ids.recruiter, role: 'recruiter' }, { company_id: companyB, user_id: userId, role: 'recruiter' }],
  recruitments: [{ id: recA, company_id: companyA, position_id: posA, status: 'open', name: 'Rekrutacja HRBP' },
    { id: recBroken, company_id: companyA, position_id: posA, status: 'open', name: 'Rekrutacja Uszkodzona' },
    { id: recB, company_id: companyB, position_id: posB, status: 'open', name: 'Rekrutacja Obca' }],
  positions: [{ id: posA, company_id: companyA, status: 'active', updated_at: ts }, { id: posB, company_id: companyB, status: 'active', updated_at: ts }],
  candidates: [
    { id: uuid(71), company_id: companyA, first_name: 'Anna', last_name: 'Finalistka' },
    { id: uuid(72), company_id: companyA, first_name: 'Beata', last_name: 'Bezdowodu' },
    { id: uuid(73), company_id: companyA, first_name: 'Celina', last_name: 'Dostepna' },
    { id: uuid(74), company_id: companyB, first_name: 'Kandydat', last_name: 'Obcy' },
  ],
  applications: [
    { id: ids.applicationA, company_id: companyA, recruitment_id: recA, candidate_id: uuid(71), status: 'in_progress' },
    { id: ids.applicationB, company_id: companyA, recruitment_id: recA, candidate_id: uuid(72), status: 'in_progress' },
    { id: appC, company_id: companyA, recruitment_id: recA, candidate_id: uuid(73), status: 'in_progress' },
    { id: appForeign, company_id: companyB, recruitment_id: recB, candidate_id: uuid(74), status: 'in_progress' },
  ],
  recruitment_shortlist_entries: [ids.applicationA, ids.applicationB, appC].map(application_id => ({ company_id: companyA, recruitment_id: recA, application_id, removed_at: null })),
  latest_exercise_definitions: [],
};
const sessions = { [recA]: ids.session, [recBroken]: uuid(91) };
const broken = () => { const payload = sessionPayload(); payload.finalists[0].stages[0].pair.sheets[1].authorId = ids.owner; return payload; };

async function startStub(t, requests) {
  const stub = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/auth/v1/user') return res.end(JSON.stringify({ id: userId, aud: 'authenticated', email: 'test@example.invalid' }));
    if (!url.pathname.startsWith('/rest/v1/')) { res.statusCode = 404; return res.end('{}'); }
    const name = url.pathname.split('/').at(-1);
    requests.push({ name, method: req.method });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const args = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (name === 'ac_session_find') return res.end(JSON.stringify(sessions[args.recruitment] ?? null));
      if (name === 'ac_session_read') return res.end(JSON.stringify(args.session === ids.session ? sessionPayload() : broken()));
      res.statusCode = 404; return res.end(JSON.stringify({ code: 'PGRST202', message: 'unknown rpc' }));
    }
    let rows = [...(data[name] ?? [])];
    for (const [key, value] of url.searchParams) if (value.startsWith('eq.')) rows = rows.filter(row => String(row[key]) === value.slice(3));
    res.end(JSON.stringify(req.headers.accept?.includes('application/vnd.pgrst.object+json') ? rows[0] ?? null : rows));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  return stub.address().port;
}

async function startNext(t, stubPort, env) {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', AC_PAIRED_SHEETS_PREVIEW: '', ...env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', NEXT_PUBLIC_SITE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(base)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, 'Next started');
  return base;
}

test('SC-AC-SESSION HTTP: session page renders the evidence report, isolates context and fails closed', async t => {
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'synthetic'].join('.');
  const cookie = 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'synthetic', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id: userId } })).toString('base64url');
  const requests = [];
  const stubPort = await startStub(t, requests);
  const base = await startNext(t, stubPort, { VERCEL_ENV: 'preview', AC_PAIRED_SHEETS_PREVIEW: 'true' });
  const get = async (origin, company, recruitment) => {
    requests.length = 0;
    const res = await fetch(`${origin}/dashboard/${company}/recruitments/${recruitment}/assessment-center`, { redirect: 'manual', headers: { Cookie: cookie } });
    return { res, html: (await res.text()).replaceAll('<!-- -->', ''), seen: requests.slice() };
  };

  await t.test('panel to result: plan, both assessors, agreed and discrepant items, first and revised attempt, expert note', async () => {
    const { res, html, seen } = await get(base, companyA, recA);
    assert.equal(res.status, 200);
    assert.match(html, /Sesja Assessment Center — Rekrutacja HRBP/);
    assert.match(html, /Plan pokrycia kompetencji/); assert.match(html, /Sesja otwarta/);
    assert.match(html, /Etap 1 — diagnoza przyczyn rotacji/); assert.match(html, /Symulacja z człowiekiem/);
    assert.match(html, /Anna Finalistka/); assert.match(html, /Beata Bezdowodu/);
    assert.match(html, /AsesorPierwszy — syntetyczna obserwacja kryterium 1\./); assert.match(html, /AsesorDrugi — syntetyczna obserwacja kryterium 1\./);
    assert.match(html, /Uzgodniono: Zgodne z wymaganiami — UzasadnienieUzgodnienia/);
    assert.match(html, /Jawna rozbieżność — obie oceny pozostają: OpisRozbieznosci/);
    assert.match(html, /Propozycja uzgodnienia \(Ty\): Zgodne z wymaganiami — UzasadnienieDrugie/);
    for (const marker of ['PierwszaProba', 'InformacjaZwrotna', 'PoprawionaPraca', 'OpisZmiany', 'DowodZmiany', 'NotatkaEksperta', 'Zmiana potwierdzona dowodem']) assert.match(html, new RegExp(marker), marker);
    assert.match(html, /Oddaj swój niezależny arkusz/);
    assert.doesNotMatch(html, FOREIGN);
    // Reading the page changes nothing: its two read RPCs (plus the layout's read-only brand lookup), every other request is a GET.
    assert.deepEqual(Array.from(new Set(seen.filter(request => request.method !== 'GET' && request.name !== 'brand_published').map(request => `${request.method} ${request.name}`))).sort(), ['POST ac_session_find', 'POST ac_session_read']);
  });

  await t.test('missing data stays "brak danych"; no points, ranking position or hiring suggestion anywhere', async () => {
    const { html } = await get(base, companyA, recA);
    const start = html.indexOf('Beata Bezdowodu</h3>');
    assert.ok(start > 0);
    const second = html.slice(start, html.indexOf('</article>', start));
    assert.match(second, /brak danych<\/strong> — żaden asesor nie zapisał jeszcze dowodu/);
    assert.match(second, /Pierwsza próba<\/dt><dd>brak danych<\/dd>/); assert.match(second, /Dowód zmiany<\/dt><dd>brak danych<\/dd>/);
    assert.doesNotMatch(second, /Zgodne z wymaganiami|Powyżej wymagań|Poniżej wymagań/, 'no invented rating for a finalist without evidence');
    assert.match(html, /Kolejność finalistów to kolejność dodania do sesji — nie jest rankingiem/);
    assert.doesNotMatch(html, /\bpunkt(y|ów)?\b|\bwynik łączny|rekomendacj|rekomend|odrzuc|zatrudnij|miejsce \d|\d+\s*\/\s*\d+ pkt/i);
    // Finalist advice is shown, the limit is stated, and the owner can add the third shortlisted person.
    assert.match(html, /Zalecane jest 5–6 finalistów\. Obecnie: 2\./); assert.match(html, /Twardy limit: 10/);
    assert.match(html, /Celina Dostepna/);
  });

  await t.test('a foreign company, a foreign recruitment in the URL and a malformed payload never leak or half-render', async () => {
    const crossed = await get(base, companyB, recA);
    assert.equal(crossed.res.status, 404); assert.doesNotMatch(crossed.html, /Anna Finalistka|AsesorPierwszy/);
    assert.ok(crossed.seen.every(request => !request.name.startsWith('ac_session')), 'no session RPC for a recruitment outside the company in the URL');
    const other = await get(base, companyB, recB);
    assert.equal(other.res.status, 200); assert.match(other.html, /nie zaplanowano jeszcze sesji/);
    assert.doesNotMatch(other.html, /Anna Finalistka|AsesorPierwszy|Rekrutacja HRBP/);
    const bad = await get(base, companyA, recBroken);
    assert.equal(bad.res.status, 200); assert.match(bad.html, /Nie udało się zweryfikować danych sesji\. Raport nie jest wyświetlany\./);
    assert.doesNotMatch(bad.html, /AsesorPierwszy|PierwszaProba|Raport sesji/);
  });

  await t.test('without the Preview flag the page does not exist', async () => {
    const plain = await startNext(t, stubPort, { VERCEL_ENV: 'preview', AC_PAIRED_SHEETS_PREVIEW: '' });
    const off = await get(plain, companyA, recA);
    assert.equal(off.res.status, 404); assert.doesNotMatch(off.html, /Anna Finalistka|Plan pokrycia/);
    assert.deepEqual(off.seen.filter(request => request.name.startsWith('ac_session')), []);
    const production = await startNext(t, stubPort, { VERCEL_ENV: 'production', AC_PAIRED_SHEETS_PREVIEW: 'true' });
    assert.equal((await get(production, companyA, recA)).res.status, 404);
  });
});
