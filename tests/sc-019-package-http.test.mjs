import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { setupRankingDatabase } from './helpers/screening-ranking-fixture.mjs';

const pending = 'Liczba analiz CV według zatwierdzonej polityki';
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function startApp(t, enabled, rpcPort) {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, SC19_PACKAGES_ENABLED: String(enabled),
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${rpcPort}`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-test-key',
      NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  // A static route proves server readiness without consuming a catalog lookup.
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/demo`, { signal: AbortSignal.timeout(2000) })).ok) return base; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Next server did not start: ${logs}`);
}

test('built public route looks up the actual DB policy on each enabled request and survives catalog failures', { timeout: 90000 }, async t => {
  const manifest = JSON.parse(await readFile(new URL('../.next/prerender-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.routes['/'], undefined, 'the landing must not be a static build result');
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  const h = await setupRankingDatabase(db);
  await h.asAdmin();
  await db.exec(await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8'));
  await db.exec("update private.sc19_package_policy set credits=case plan when 'FREE' then 3 else 12 end");
  let reads = 0;
  let mode = 'database';
  const unexpected = [];
  const rpc = createServer(async (req, res) => {
    if (req.url !== '/rest/v1/rpc/sc19_package_sizes' || req.method !== 'POST') {
      unexpected.push(`${req.method} ${req.url}`);res.writeHead(404);res.end();return;
    }
    reads++;
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'rpc-error') {res.writeHead(503);res.end(JSON.stringify({message:'synthetic outage'}));return;}
    if (mode === 'missing-rpc') {res.writeHead(404);res.end(JSON.stringify({code:'PGRST202',message:'missing RPC'}));return;}
    let rows;
    try {
      rows = (await db.query('select * from public.sc19_package_sizes() order by plan')).rows;
      if (mode === 'empty') rows = [];
      if (mode === 'null') rows = null;
      if (mode === 'missing-plan') rows = rows.slice(0,1);
      if (mode === 'invalid-zero') rows[0].credits = 0;
      if (mode === 'invalid-fraction') rows[0].credits = 1.5;
      if (mode === 'invalid-range') rows[0].credits = 100001;
      if (mode === 'invalid-string') rows[0].credits = '3';
      if (mode === 'duplicate') rows.push(rows[0]);
      res.end(JSON.stringify(rows));
    } catch {res.writeHead(500);res.end('{}');}
  });
  const rpcPort = await listen(rpc);
  t.after(() => new Promise(resolve => rpc.close(resolve)));
  const enabled = await startApp(t,true,rpcPort);
  async function landing(base) {
    const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status,200);
    return response.text();
  }
  let before = reads;
  let html = await landing(enabled);
  assert.ok(reads > before, 'ON must perform runtime RPC, not serve the build fallback');
  assert.match(html,/3 analiz CV/);assert.match(html,/12 analiz CV/);
  assert.doesNotMatch(html,/5 analiz CV|60 analiz CV/);
  await db.exec("update private.sc19_package_policy set credits=case plan when 'FREE' then 7 else 24 end");
  before = reads;html = await landing(enabled);
  assert.ok(reads > before,'next request must reread changed policy');
  assert.match(html,/7 analiz CV/);assert.match(html,/24 analiz CV/);
  for (mode of ['rpc-error','missing-rpc','empty','null','missing-plan','invalid-zero','invalid-fraction','invalid-range','invalid-string','duplicate']) {
    before = reads;html = await landing(enabled);
    assert.ok(reads > before,`${mode} exercised the RPC`);
    assert.ok(html.includes(pending),`${mode} renders nonnumeric fallback`);
    assert.doesNotMatch(html,/7 analiz CV|24 analiz CV|5 analiz CV|60 analiz CV/);
  }
  mode = 'database';
  const disabled = await startApp(t,false,rpcPort);
  before = reads;html = await landing(disabled);
  assert.equal(reads,before,'OFF does not request the catalog');
  assert.ok(html.includes(pending));
  assert.doesNotMatch(html,/7 analiz CV|24 analiz CV/);
  assert.deepEqual(unexpected,[],'only the safe catalog RPC is requested');
});
