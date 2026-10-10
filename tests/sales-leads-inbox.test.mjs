import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { salesLeadReplyHref } from '../lib/sales-lead-reply.ts';

test('reply address cannot inject extra recipients, headers or HTML', () => {
  for (const email of ['test@example.test', 'a?bcc=other@example.test', 'a#fragment@example.test', 'a\r\nBcc:other@example.test']) {
    const href = salesLeadReplyHref(email);
    const url = new URL(href);
    assert.equal(decodeURIComponent(url.pathname), email);
    assert.deepEqual([...url.searchParams.keys()], ['subject']);
    assert.equal(url.hash, '');
    assert.ok(!/[\r\n]/.test(href));
  }
});

test('inbox closure authorization, idempotence, immutability and retention', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create schema auth; create schema private;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  for (const name of ['20261007000200_sales_leads.sql','20261009073604_sales_lead_inbox_retention.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/'+name, import.meta.url), 'utf8'));
  }
  const operator = randomUUID(), stranger = randomUUID();
  await db.query('insert into auth.users values($1),($2)', [operator,stranger]);
  await db.query('insert into public.platform_operators(user_id) values($1)', [operator]);
  const ids = [];
  for (let n=0;n<3;n++) {
    const id=randomUUID(); ids.push(id);
    await db.query(`insert into public.sales_leads(id,idempotency_key,first_name,company_name,email,needs,fingerprint_hash)
      values($1,$2,'Test','Fixture','test@example.test','Synthetic needs',$3)`, [id,randomUUID(),'a'.repeat(64)]);
  }
  const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
  const asUser = async (role,uid,fn) => {
    await db.exec('set role '+role);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid||'']);
    try { return await fn(); } finally { await db.exec('reset role'); }
  };
  await asUser('anon',null,async()=>{
    await assert.rejects(db.query('select public.close_sales_lead($1)',[ids[0]]),/permission denied/);
    await assert.rejects(db.query('select * from public.list_sales_leads_inbox()'),/permission denied/);
  });
  await asUser('authenticated',stranger,async()=>{
    assert.equal(await scalar('select public.close_sales_lead($1)',[ids[0]]),'sales_lead_forbidden');
    await assert.rejects(db.query('select * from public.list_sales_leads_inbox()'),/sales_lead_forbidden/);
  });
  await asUser('authenticated',operator,async()=>{
    assert.equal(await scalar('select public.close_sales_lead($1)',[randomUUID()]),'sales_lead_not_found');
    assert.equal(await scalar('select public.close_sales_lead($1)',[ids[0]]),'ok');
    const first=(await db.query('select * from public.list_sales_leads_inbox()')).rows;
    assert.equal(first.length,3);
    assert.ok(first.find(r=>r.id===ids[0]).closed_at);
    assert.ok(!('fingerprint_hash' in first[0]) && !('idempotency_key' in first[0]));
    assert.equal(await scalar('select public.close_sales_lead($1)',[ids[0]]),'ok');
    const again=(await db.query('select * from public.list_sales_leads_inbox()')).rows;
    assert.deepEqual(again.find(r=>r.id===ids[0]).closed_at,first.find(r=>r.id===ids[0]).closed_at);
    await assert.rejects(db.query('update public.sales_leads set needs=\'changed\''),/permission denied/);
    await assert.rejects(db.query('select private.purge_closed_sales_leads()'),/permission denied/);
  });
  // Synthetic lifecycle fixtures for retention boundaries; never change key-rotation timestamps.
  await db.query("insert into private.sales_lead_closures(lead_id,closed_at) values($1,clock_timestamp()-interval '6 months 1 day')",[ids[1]]);
  assert.equal(await scalar('select private.purge_closed_sales_leads()'),1);
  assert.equal(await scalar('select count(*)::int from public.sales_leads'),2);
  assert.equal(await scalar('select count(*)::int from private.sales_lead_closures'),1);
  await db.query('update public.platform_operators set revoked_at=clock_timestamp() where user_id=$1',[operator]);
  await asUser('authenticated',operator,async()=>{
    assert.equal(await scalar('select public.close_sales_lead($1)',[ids[2]]),'sales_lead_forbidden');
  });
  await assert.rejects(db.query("update public.sales_leads set needs='changed'"),/sales_lead_immutable/);
});
