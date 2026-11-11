import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { uuid } from './helpers/screening-report-fixture.mjs';

// SC-AC-REPORT-HTTP (#366): the real Next AC exercise/report page over HTTP with
// a synthetic Auth + PostgREST boundary. This is NOT a test of real RLS: the stub
// filters only on the eq. parameters the page sends, and the signed-in user is a
// recruiter of BOTH companies, so the URL scoping in the page is what is tested.
const userId = uuid(50);
const companyA = uuid(1), companyB = uuid(2);
const recA = uuid(11), recB = uuid(12);
const posA = uuid(31), posB = uuid(32);
const appA = uuid(41), appA2 = uuid(42), appB = uuid(43);
const defA = uuid(61), defA2 = uuid(62), defB = uuid(63), defTest = uuid(64);
const ts = '2026-11-09T08:00:00.000Z';

const criteria = [
  { competency: 'Komunikacja', below: 'Przerywa rozmówcy', meets: 'Slucha i odpowiada', above: 'Prowadzi rozmowe do wniosku' },
  { competency: 'Priorytety', below: 'Gubi cele', meets: 'Ustala kolejnosc', above: 'Negocjuje kolejnosc z zespolem' },
];
const definition = (title, kind = 'assessment_center') => ({ kind, title, instructions: 'Instrukcja zadania', expectedOutput: 'Oczekiwany wynik', durationMinutes: 30, criteria });
const entry = (id, company, rec, pos, title, kind) => ({ id, company_id: company, recruitment_id: rec, version: 2, position_id: pos, position_updated_at: ts, position_snapshot: { title: 'Stanowisko' }, definition: definition(title, kind) });
const observation = (id, company, rec, app, def, note) => ({
  id, company_id: company, recruitment_id: rec, application_id: app, definition_entry_id: def, version: 3, author_id: userId, created_at: ts,
  work_sample: '', observations: [{ criterionIndex: 0, rating: 'meets', evidence: note }, { criterionIndex: 1, rating: 'insufficient_data', evidence: '' }],
});
const FOREIGN = /Cwiczenie Obce|NotatkaObca|Kandydat Obcy/;
const data = {
  companies: [{ id: companyA, name: 'Firma A', owner_id: userId }, { id: companyB, name: 'Firma B', owner_id: userId }],
  company_members: [{ company_id: companyA, user_id: userId, role: 'recruiter' }, { company_id: companyB, user_id: userId, role: 'recruiter' }],
  recruitments: [{ id: recA, company_id: companyA, position_id: posA, status: 'open' }, { id: recB, company_id: companyB, position_id: posB, status: 'open' }],
  positions: [{ id: posA, company_id: companyA, status: 'active', updated_at: ts }, { id: posB, company_id: companyB, status: 'active', updated_at: ts }],
  candidates: [
    { id: uuid(71), company_id: companyA, first_name: 'Anna', last_name: 'Widoczna' },
    { id: uuid(72), company_id: companyA, first_name: 'Beata', last_name: 'BezObserwacji' },
    { id: uuid(73), company_id: companyB, first_name: 'Kandydat', last_name: 'Obcy' },
  ],
  applications: [
    { id: appA, company_id: companyA, recruitment_id: recA, candidate_id: uuid(71), status: 'in_progress' },
    { id: appA2, company_id: companyA, recruitment_id: recA, candidate_id: uuid(72), status: 'in_progress' },
    { id: appB, company_id: companyB, recruitment_id: recB, candidate_id: uuid(73), status: 'in_progress' },
  ],
  exercise_definition_entries: [
    entry(defA, companyA, recA, posA, 'Cwiczenie Widoczne'),
    entry(defA2, companyA, recA, posA, 'Cwiczenie Druga Wersja'),
    entry(defB, companyB, recB, posB, 'Cwiczenie Obce'),
    entry(defTest, companyA, recA, posA, 'Test Kompetencji', 'competency_test'),
  ],
  exercise_observation_entries: [
    observation(uuid(81), companyA, recA, appA, defA, 'NotatkaWidoczna'),
    observation(uuid(82), companyB, recB, appB, defB, 'NotatkaObca'),
  ],
};

test('SC-AC-REPORT-HTTP: AC exercise report page isolates context and keeps missing evidence missing', async t => {
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'synthetic'].join('.');
  const cookie = 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'synthetic', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id: userId } })).toString('base64url');
  const requests = [];
  const stub = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/auth/v1/user') return res.end(JSON.stringify({ id: userId, aud: 'authenticated', email: 'test@example.invalid' }));
    if (!url.pathname.startsWith('/rest/v1/')) { res.statusCode = 404; return res.end('{}'); }
    const name = url.pathname.split('/').at(-1);
    requests.push({ name, method: req.method });
    let rows = [...(data[name] ?? [])];
    for (const [key, value] of url.searchParams) if (value.startsWith('eq.')) rows = rows.filter(r => String(r[key]) === value.slice(3));
    rows.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    res.end(JSON.stringify(req.headers.accept?.includes('application/vnd.pgrst.object+json') ? rows[0] ?? null : rows));
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VERCEL_ENV: '', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', NEXT_PUBLIC_SITE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(base)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(ready, 'Next started');

  const get = async (company, rec, app, def) => {
    requests.length = 0;
    const res = await fetch(`${base}/dashboard/${company}/recruitments/${rec}/applications/${app}/exercises/${def}`, { redirect: 'manual', headers: { Cookie: cookie } });
    return { res, html: (await res.text()).replaceAll('<!-- -->', ''), seen: requests.slice() };
  };
  const readsOnly = seen => seen.every(r => r.method === 'GET');

  await t.test('matching context shows exercise version and the real observer note', async () => {
    const { res, html, seen } = await get(companyA, recA, appA, defA);
    assert.equal(res.status, 200);
    assert.match(html, /Cwiczenie Widoczne — wersja zadania 2/);
    assert.match(html, /Raport Assessment Center/);
    assert.match(html, /Wersja oceny 3 · udokumentowane kryteria: 1 z 2/);
    assert.match(html, /NotatkaWidoczna/);
    assert.doesNotMatch(html, FOREIGN);
    assert.ok(readsOnly(seen), 'GET renders without mutation');
  });

  await t.test('insufficient_data stays "not enough data", never a score, a positive rating or a decision', async () => {
    const { html } = await get(companyA, recA, appA, defA);
    const report = html.slice(html.indexOf('Raport Assessment Center'), html.indexOf('Historia obserwacji'));
    assert.match(report, /Priorytety<\/dt><dd>Niewystarczające dane<\/dd>/);
    assert.match(report, /Komunikacja<\/dt><dd>Zgodne z wymaganiami<\/dd>/);
    assert.doesNotMatch(report, /Poniżej wymagań<\/dd>|Powyżej wymagań<\/dd>/);
    assert.doesNotMatch(report, /\b0\s*\/|punkt|zatrudni|odrzu/i);
  });

  await t.test('no observation yet is "awaiting", with no invented rating', async () => {
    const { res, html } = await get(companyA, recA, appA2, defA);
    assert.equal(res.status, 200);
    assert.match(html, /Ćwiczenie oczekuje na pierwszą obserwację/);
    assert.doesNotMatch(html, /udokumentowane kryteria|Zgodne z wymaganiami<\/dd>|NotatkaWidoczna/);
  });

  await t.test('another application or another definition version does not borrow the note', async () => {
    const { html } = await get(companyA, recA, appA, defA2);
    assert.match(html, /Cwiczenie Druga Wersja/);
    assert.doesNotMatch(html, /NotatkaWidoczna|udokumentowane kryteria/);
    assert.match(html, /Ćwiczenie oczekuje na pierwszą obserwację/);
  });

  await t.test('a competency test gets no AC report', async () => {
    const { res, html } = await get(companyA, recA, appA, defTest);
    assert.equal(res.status, 200);
    assert.doesNotMatch(html, /Raport Assessment Center/);
  });

  const rejected = [
    ['definition of another company under own URL', companyA, recA, appA, defB],
    ['application of another company', companyA, recA, appB, defA],
    ['recruitment of another company', companyA, recB, appA, defA],
    ['foreign company with own application and definition', companyB, recA, appA, defA],
    ['all ids of the other company under own company URL', companyA, recB, appB, defB],
    ['unknown definition', companyA, recA, appA, uuid(999)],
    ['malformed definition id', companyA, recA, appA, 'not-a-uuid'],
  ];
  for (const [label, company, rec, app, def] of rejected) {
    await t.test(`404 before any note is shown: ${label}`, async () => {
      const { res, html, seen } = await get(company, rec, app, def);
      assert.equal(res.status, 404);
      assert.doesNotMatch(html, FOREIGN);
      assert.doesNotMatch(html, /NotatkaWidoczna/);
      assert.ok(!seen.some(r => r.name === 'exercise_observation_entries'), 'notes are not even queried: ' + seen.map(r => r.name).join());
      assert.ok(readsOnly(seen));
    });
  }
  assert.doesNotMatch(logs, FOREIGN);
});
