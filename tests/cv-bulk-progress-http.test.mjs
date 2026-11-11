import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { uuid } from './helpers/screening-report-fixture.mjs';

// SC-BULK-HTTP (#363): the real Next bulk/[batchId] page over HTTP with a
// synthetic Auth + PostgREST boundary. This is NOT a test of real RLS: the stub
// deliberately does not scope the batch RPC by company, so the route guard in
// the page is the only thing that can keep a foreign batch out of the response.
const userId = uuid(50);
const companyA = uuid(1), companyB = uuid(2);
const recA = uuid(11), recB = uuid(12), recMissing = uuid(13);
const batchA = uuid(21), batchB = uuid(22), batchMissing = uuid(23);

const item = (n, name, file) => ({
  id: uuid(300 + n), position: n, file_name: file, phase: 'done', error_reason: null, ocr_used: false,
  application_id: uuid(400 + n), candidate_name: name, has_phone: true, group_key: 'strong', raw_score: 80,
  duplicate_of_application: null, group_analysis_id: uuid(500 + n),
});
const status = (id, rec, name, file) => ({
  batch: { id, recruitment_id: rec, status: 'completed', declared_files: 1, reserved_slots: 1, completed_at: '2026-11-09T08:00:00.000Z' },
  items: [item(Number(id.slice(-2)), name, file)],
});
const data = {
  companies: [{ id: companyA, name: 'Firma A', owner_id: userId }, { id: companyB, name: 'Firma B', owner_id: userId }],
  company_members: [
    { company_id: companyA, user_id: userId, role: 'recruiter' },
    { company_id: companyB, user_id: userId, role: 'recruiter' },
  ],
  recruitments: [{ id: recA, company_id: companyA }, { id: recB, company_id: companyB }],
};
const batches = {
  [batchA]: status(batchA, recA, 'Kandydat Alfa Widoczny', 'alfa.pdf'),
  [batchB]: status(batchB, recB, 'Kandydat Beta Obcy', 'beta-sekret.pdf'),
};
const FOREIGN = /Kandydat Beta Obcy|beta-sekret/;

test('SC-BULK-HTTP: batch progress page isolates company, recruitment and batch', async t => {
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
    const body = Buffer.concat(chunks).toString();
    requests.push({ name, method: req.method, query: url.searchParams.toString(), body });
    if (name === 'cv_bulk_batch_status') return res.end(JSON.stringify(batches[JSON.parse(body).target_batch] ?? null));
    if (name === 'get_screening_ranking') return res.end('[]');
    let rows = [...(data[name] ?? [])];
    for (const [key, value] of url.searchParams) if (value.startsWith('eq.')) rows = rows.filter(r => String(r[key]) === value.slice(3));
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

  const get = async (company, rec, batch) => {
    requests.length = 0;
    const res = await fetch(`${base}/dashboard/${company}/recruitments/${rec}/bulk/${batch}`, { redirect: 'manual', headers: { Cookie: cookie } });
    return { res, html: await res.text(), seen: requests.map(r => r.name) };
  };
  // Only reads: the progress page must never call a mutating or pump RPC.
  const onlyReads = seen => seen.every(n => ['companies', 'company_members', 'recruitments', 'cv_bulk_batch_status', 'get_screening_ranking'].includes(n));

  await t.test('matching company/recruitment/batch renders the progress screen', async () => {
    const { res, html, seen } = await get(companyA, recA, batchA);
    assert.equal(res.status, 200);
    assert.match(html, /Paczka CV/);
    assert.match(html, /Kandydat Alfa Widoczny/);
    assert.doesNotMatch(html, FOREIGN);
    assert.ok(onlyReads(seen), seen.join());
  });

  const rejected = [
    ['recruitment of another company under URL company', companyA, recB, batchB],
    ['batch of another company under own recruitment', companyA, recA, batchB],
    ['batch of another recruitment, same company', companyB, recB, batchA],
    ['unknown batch', companyA, recA, batchMissing],
    ['unknown recruitment', companyA, recMissing, batchA],
    ['malformed batch id', companyA, recA, 'not-a-uuid'],
  ];
  for (const [label, company, rec, batch] of rejected) {
    await t.test(`404 without foreign data: ${label}`, async () => {
      const { res, html, seen } = await get(company, rec, batch);
      assert.equal(res.status, 404);
      assert.doesNotMatch(html, FOREIGN);
      assert.doesNotMatch(html, /Kandydat Alfa Widoczny/);
      assert.ok(onlyReads(seen), seen.join());
      // A rejected route must not go on to read candidate/ranking data.
      assert.ok(!seen.includes('get_screening_ranking'), seen.join());
    });
  }

  await t.test('rendering never starts the pump or a mutation', async () => {
    await get(companyA, recA, batchA);
    assert.ok(requests.every(r => r.method === 'GET' || r.name === 'cv_bulk_batch_status' || r.name === 'get_screening_ranking'));
  });
  assert.doesNotMatch(logs, FOREIGN);
});
