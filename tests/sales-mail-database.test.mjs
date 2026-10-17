import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {mailSignature} from '../lib/sales-mail.ts';

test('outbox: atomic enqueue, disable, authorization, lease, retry window, retention',async t=>{
 let db, databaseUrl;
 if(process.env.SALES_MAIL_TEST_DATABASE_URL) {
  const root=new pg.Client({connectionString:process.env.SALES_MAIL_TEST_DATABASE_URL});await root.connect();
  const name='sales_mail_'+randomUUID().replaceAll('-','');await root.query('create database '+name);
  const url=new URL(process.env.SALES_MAIL_TEST_DATABASE_URL);url.pathname='/'+name;databaseUrl=url.toString();
  const client=new pg.Client({connectionString:databaseUrl});await client.connect();
  db={query:(...args)=>client.query(...args),exec:q=>client.query(q)};
  t.after(async()=>{await client.end();await root.query('drop database '+name);await root.end();});
 } else {db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());}

 await db.exec(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;create schema auth;create schema private;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 for(const name of ['20261007000200_sales_leads.sql','20261009073604_sales_lead_inbox_retention.sql','20261009104142_sales_lead_auto_reply.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 const secret='s'.repeat(32);
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const insert=async(email='a@example.test')=>{const id=randomUUID();await db.query(`insert into public.sales_leads(id,idempotency_key,first_name,company_name,email,needs,fingerprint_hash) values($1,$2,'Test','Fixture',$3,'Synthetic needs',$4)`,[id,randomUUID(),email,'a'.repeat(64)]);return id;};
 await insert();assert.equal(await scalar('select count(*)::int from private.sales_mail_outbox'),0);
 await db.query('update private.sales_mail_settings set enabled=true,worker_secret=$1',[secret]);
 if(databaseUrl) {
  const workers=await Promise.all(Array.from({length:5},async()=>{const c=new pg.Client({connectionString:databaseUrl});await c.connect();return c;}));
  try {
   await Promise.all(workers.map(c=>c.query(`insert into public.sales_leads(id,idempotency_key,first_name,company_name,email,needs,fingerprint_hash) values($1,$2,'Test','Fixture','race@example.test','Synthetic needs',$3)`,[randomUUID(),randomUUID(),'b'.repeat(64)])));
   assert.equal(await scalar("select count(*)::int from private.sales_mail_outbox o join public.sales_leads l on l.id=o.lead_id where l.email='race@example.test'"),1);
   const target=await scalar("select o.lead_id from private.sales_mail_outbox o join public.sales_leads l on l.id=o.lead_id where l.email='race@example.test'");
   const results=await Promise.all(workers.map(async c=>{const lease=randomUUID(),stamp=Date.now();await c.query('set role anon');return c.query('select * from public.claim_sales_mail($1,$2,$3,$4)',[target,lease,stamp,mailSignature('claim',target,lease,stamp,null,null,secret)]);}));
   assert.equal(results.reduce((n,r)=>n+r.rows.length,0),1);
   console.log('PASS real PostgreSQL: concurrent email cap and exclusive claim');
   await db.query("select private.purge_sales_leads(array(select id from public.sales_leads where email='race@example.test'))");
  } finally {await Promise.all(workers.map(c=>c.end()));}
 }
 const id=await insert();await insert();assert.equal(await scalar('select count(*)::int from private.sales_mail_outbox'),1);
 const claim=async(target=id,lease=randomUUID(),stamp=Date.now(),sig)=>{
  await db.exec('set role anon');try{return (await db.query('select * from public.claim_sales_mail($1,$2,$3,$4)',[target,lease,stamp,sig??mailSignature('claim',target,lease,stamp,null,null,secret)])).rows;}finally{await db.exec('reset role');}
 };
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from private.sales_mail_outbox'),/permission denied/);await db.exec('reset role');
 await assert.rejects(claim(id,randomUUID(),Date.now(),'bad'),/sales_mail_forbidden/);
 await assert.rejects(claim(id,randomUUID(),Date.now()-120000),/sales_mail_forbidden/);
 const lease=randomUUID();const row=(await claim(id,lease))[0];assert.equal(row.email,'a@example.test');assert.equal(row.lease_id,lease);
 assert.deepEqual(await claim(),[]);
 const other=await insert('nonce@example.test');
 assert.deepEqual(await claim(null,lease),[]); // same nonce cannot drain a different job
 await db.query('select private.purge_sales_leads($1::uuid[])',[[other]]);
 const finish=async(leaseId,outcome='accepted',provider=randomUUID())=>{
  const stamp=Date.now();await db.exec('set role anon');try{return await scalar('select public.finish_sales_mail($1,$2,$3,$4,$5,$6)',[id,leaseId,stamp,outcome,provider,mailSignature('finish',id,leaseId,stamp,outcome,provider,secret)]);}finally{await db.exec('reset role');}
 };
 assert.equal(await finish(randomUUID()),false);
 assert.equal(await finish(lease,'retry',null),true);assert.deepEqual(await claim(),[]);
 await db.query("update private.sales_mail_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where lead_id=$1",[id]);
 const second=(await claim())[0];assert.equal(await finish(lease),false);assert.equal(await finish(second.lease_id),true);assert.deepEqual(await claim(),[]);
 // Isolated synthetic delivery timestamps; no secret rotation timestamps are changed.
 const expired=await insert('expired@example.test');await claim(expired);
 await db.query("update private.sales_mail_outbox set first_attempt_at=clock_timestamp()-interval '13 hours',lease_until=clock_timestamp()-interval '1 second' where lead_id=$1",[expired]);
 assert.deepEqual(await claim(expired),[]);assert.equal(await scalar('select state from private.sales_mail_outbox where lead_id=$1',[expired]),'uncertain');
 const closed=await insert('closed@example.test');await db.query('insert into private.sales_lead_closures(lead_id) values($1)',[closed]);assert.deepEqual(await claim(closed),[]);
 assert.equal(await scalar('select state from private.sales_mail_outbox where lead_id=$1',[closed]),'suppressed');
 const recovering=await insert('crash@example.test');const stale=(await claim(recovering))[0];
 await db.query("update private.sales_mail_outbox set lease_until=clock_timestamp()-interval '1 second' where lead_id=$1",[recovering]);
 const recovered=(await claim(recovering))[0];assert.notEqual(stale.lease_id,recovered.lease_id);
 await db.query('update private.sales_mail_settings set enabled=false');await assert.rejects(claim(),/sales_mail_forbidden/);
 await db.query('select private.purge_sales_leads($1::uuid[])',[[id]]);assert.equal(await scalar('select count(*)::int from private.sales_mail_outbox where lead_id=$1',[id]),0);
});
