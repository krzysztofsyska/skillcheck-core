import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

test('production app serves forms and rejects unauthenticated tenant routes', async (t) => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-only-public-key', NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i=0;i<60;i++) {
    if(child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(base)).ok; } catch {}
    if(ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Next server started');
  for (const [path,label] of [['/login','Witaj ponownie'],['/register','Utwórz konto'],['/forgot-password','Odzyskaj dostęp']]) {
    const response = await fetch(base+path);
    assert.equal(response.status,200,path);
    assert.match(await response.text(),new RegExp(label));
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
  for (const path of ['/dashboard/00000000-0000-0000-0000-000000000001/recruitments/00000000-0000-0000-0000-000000000002/applications/00000000-0000-0000-0000-000000000003/assessments','/dashboard/00000000-0000-0000-0000-000000000001/recruitments/00000000-0000-0000-0000-000000000002/applications/00000000-0000-0000-0000-000000000003/screening','/dashboard','/onboarding','/dashboard/00000000-0000-0000-0000-000000000001','/dashboard/00000000-0000-0000-0000-000000000001/positions/new','/dashboard/00000000-0000-0000-0000-000000000001/candidates','/dashboard/00000000-0000-0000-0000-000000000001/candidates/00000000-0000-0000-0000-000000000002/cv','/dashboard/00000000-0000-0000-0000-000000000001/candidates/00000000-0000-0000-0000-000000000002','/dashboard/00000000-0000-0000-0000-000000000001/recruitments/00000000-0000-0000-0000-000000000002']) {
    const response=await fetch(base+path,{redirect:'manual'});
    assert.equal(response.status,307,path);
    assert.equal(response.headers.get('location'),'/login');
  }
  const lifecycle=await fetch(base+'/dashboard/00000000-0000-0000-0000-000000000001/retention',{redirect:'manual'});
  assert.equal(lifecycle.status,307);
  assert.equal(lifecycle.headers.get('location'),'/login');
  assert.match(lifecycle.headers.get('cache-control'),/no-store/);
  const retention=await fetch(base+'/dashboard/00000000-0000-0000-0000-000000000001/candidates/00000000-0000-0000-0000-000000000002/retention',{redirect:'manual'});
  assert.equal(retention.status,307);
  assert.equal(retention.headers.get('location'),'/login');
  assert.match(retention.headers.get('cache-control'),/no-store/);
  const guide=await fetch(base+'/dashboard/00000000-0000-0000-0000-000000000001/recruitments/00000000-0000-0000-0000-000000000002/interview-guide',{redirect:'manual'});
  assert.equal(guide.status,307);
  assert.equal(guide.headers.get('location'),'/login');
  assert.match(guide.headers.get('cache-control'),/no-store/);
  for (const suffix of ['/behaviors', '/behaviors/responsibility/history', '/exercises', '/exercises/00000000-0000-0000-0000-000000000004']) {
    const response = await fetch(base+'/dashboard/00000000-0000-0000-0000-000000000001/recruitments/00000000-0000-0000-0000-000000000002/applications/00000000-0000-0000-0000-000000000003'+suffix, {redirect:'manual'});
    assert.equal(response.status,307); assert.equal(response.headers.get('location'),'/login');
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
  for (const suffix of ['/exercises', '/exercises/new', '/exercises/00000000-0000-0000-0000-000000000003']) {
    const response = await fetch(base+'/dashboard/00000000-0000-0000-0000-000000000001/recruitments/00000000-0000-0000-0000-000000000002'+suffix, {redirect:'manual'});
    assert.equal(response.status,307); assert.equal(response.headers.get('location'),'/login');
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
  const reset=await fetch(base+'/reset-password',{redirect:'manual'});
  assert.equal(reset.status,307);
  assert.equal(reset.headers.get('location'),'/forgot-password?message=expired');
  const callback=await fetch(base+'/auth/callback?flow=https://evil.example',{redirect:'manual'});
  assert.equal(callback.status,307);
  assert.equal(new URL(callback.headers.get('location')).pathname,'/login');
});
