import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { parsePipelineForm, validContactDate } from '../lib/sales-pipeline.ts';

test('server form rejects malformed values and requires deliberate terminal confirmation', () => {
  const form = new FormData();
  for (const [k,v] of Object.entries({lead_id:randomUUID(),stage:'conversation',note:'  ustalenia  ',version:'0',next_contact:'2026-10-10',company_id:''})) form.set(k,v);
  assert.equal(parsePipelineForm(form).new_note,'ustalenia');
  assert.equal(validContactDate('2026-02-30'),false); assert.equal(validContactDate('2028-02-29'),true);
  for (const [key,value] of [['stage','__proto__'],['version','-1'],['version','2e1'],['company_id','bad'],['next_contact','2026-02-30'],['note','a'.repeat(2001)]]) {
    const old=form.get(key);form.set(key,value);assert.equal(parsePipelineForm(form),null);form.set(key,old);
  }
  form.set('stage','lost');assert.equal(parsePipelineForm(form),null);
  form.set('confirm_close','yes');assert.equal(parsePipelineForm(form).next_contact,null);
});

test('pipeline authorization, filters, concurrency versions, history and retention cascade', async t => {
 let db, databaseUrl;
 if(process.env.SALES_PIPELINE_TEST_DATABASE_URL) {
  const root=new pg.Client({connectionString:process.env.SALES_PIPELINE_TEST_DATABASE_URL});await root.connect();
  const name='sales_pipeline_'+randomUUID().replaceAll('-','');await root.query('create database '+name);
  const url=new URL(process.env.SALES_PIPELINE_TEST_DATABASE_URL);url.pathname='/'+name;databaseUrl=url.toString();
  const client=new pg.Client({connectionString:databaseUrl});await client.connect();
  db={query:(...args)=>client.query(...args),exec:q=>client.query(q)};
  t.after(async()=>{await client.end();await root.query('drop database '+name);await root.end();});
 }else{db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());}
 await db.exec(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;create schema auth;create schema private;
 create table auth.users(id uuid primary key);create table public.companies(id uuid primary key,name text not null);
 alter table public.companies enable row level security;
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 for(const name of ['20261007000200_sales_leads.sql','20261009073604_sales_lead_inbox_retention.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 const operator=randomUUID(),stranger=randomUUID(),company=randomUUID();
 await db.query('insert into auth.users values($1),($2)',[operator,stranger]);
 await db.query('insert into public.platform_operators(user_id) values($1)',[operator]);
 await db.query("insert into public.companies values($1,'Firma testowa')",[company]);
 const insert=async()=>{const id=randomUUID();await db.query(`insert into public.sales_leads(id,idempotency_key,first_name,company_name,email,needs,fingerprint_hash) values($1,$2,'Test','Firma','test@example.invalid','Synthetic needs',$3)`,[id,randomUUID(),'a'.repeat(64)]);return id;};
 const old=await insert();await db.query('insert into private.sales_lead_closures(lead_id) values($1)',[old]);
 await db.exec(await readFile(new URL('../supabase/migrations/20261009141832_sales_pipeline.sql',import.meta.url),'utf8'));
 const id=await insert(),lost=await insert(),won=await insert(),legacy=await insert();
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const as=async(role,uid,fn)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid||'']);try{return await fn();}finally{await db.exec('reset role');}};
 const save=(lead,version,stage,note='',date=null,co=null)=>scalar('select public.save_sales_pipeline($1,$2,$3,$4,$5,$6)',[lead,version,stage,note,date,co]);
 await as('anon',null,async()=>{
  for(const sql of ['select * from public.list_sales_pipeline()','select * from public.find_sales_companies(\'Fi\')',`select * from public.sales_pipeline_history('${id}')`,`select public.save_sales_pipeline('${id}',0,'new','',null,null)`]) await assert.rejects(db.query(sql),/permission denied/);
 });
 await as('authenticated',stranger,async()=>{
  assert.equal(await save(id,0,'conversation'),'sales_lead_forbidden');
  for(const sql of ['select * from public.list_sales_pipeline()','select * from public.find_sales_companies(\'Fi\')',`select * from public.sales_pipeline_history('${id}')`]) await assert.rejects(db.query(sql),/sales_lead_forbidden/);
  await assert.rejects(db.query('select * from private.sales_pipeline'),/permission denied/);
  await assert.rejects(db.query('select * from public.companies'),/permission denied/);
 });
 const today=await scalar("select (now() at time zone 'Europe/Warsaw')::date::text"), yesterday=await scalar("select ((now() at time zone 'Europe/Warsaw')::date-1)::text");
 await as('authenticated',operator,async()=>{
  assert.equal((await db.query('select * from public.list_sales_pipeline($1,$2,0,$3)',['all','all',old])).rows[0].stage,'lost');
  assert.equal(await save(id,0,'no'),'invalid');assert.equal(await save(id,0,'new','a'.repeat(2001)),'invalid');
  assert.equal(await save(id,0,'new','', 'infinity'),'invalid');
  assert.equal(await save(id,0,'new','',null,randomUUID()),'company_not_found');
  assert.equal(await save(randomUUID(),0,'new'),'not_found');
  assert.equal(await save(id,0,'conversation','Pierwszy kontakt',today,company),'ok');
  assert.equal(await save(id,0,'offer','Nadpisanie',today),'conflict');
  const h=(await db.query('select * from public.sales_pipeline_history($1)',[id])).rows;
  assert.equal(h.length,1);assert.equal(h[0].note,'Pierwszy kontakt');
  assert.equal(await save(id,1,'conversation','Pierwszy kontakt',today,company),'ok');
  assert.equal((await db.query('select * from public.sales_pipeline_history($1)',[id])).rows.length,1);
  assert.equal(await save(lost,0,'offer','Wysłano ofertę',yesterday),'ok');
  const due=(await db.query("select * from public.list_sales_pipeline('all','today')")).rows;
  assert.deepEqual(due.map(x=>x.id),[id]);assert.equal(due[0].linked_company_name,'Firma testowa');
  assert.ok(!('fingerprint_hash' in due[0]));
  assert.deepEqual((await db.query("select * from public.list_sales_pipeline('all','overdue')")).rows.map(x=>x.id),[lost]);
  assert.equal(await save(lost,1,'lost','Brak budżetu',today),'invalid');
  assert.equal(await save(lost,1,'lost','Brak budżetu'),'ok');
  assert.equal(await save(lost,2,'new'),'closed');
  assert.equal((await db.query("select * from public.list_sales_pipeline('all','overdue')")).rows.length,0);
  assert.equal(await save(won,0,'won'),'company_required');
  assert.equal(await save(won,0,'won','Wygrana',null,company),'ok');
  await assert.rejects(db.query('select public.close_sales_lead($1)',[won]),/sales_pipeline_won/);
  assert.equal(await scalar('select public.close_sales_lead($1)',[legacy]),'ok');
  assert.equal((await db.query('select * from public.list_sales_pipeline($1,$2,0,$3)',['all','all',legacy])).rows[0].stage,'lost');
  assert.equal((await db.query('select * from public.find_sales_companies($1)',['Fi'])).rows.length,1);
  assert.equal((await db.query('select * from public.find_sales_companies($1)',['%_'])).rows.length,0);
  await assert.rejects(db.query('update private.sales_pipeline set stage=\'won\''),/permission denied/);
  await assert.rejects(db.query("select * from public.list_sales_pipeline('invalid')"),/invalid/);
 });
 for(let n=0;n<22;n++) await insert();
 await as('authenticated',operator,async()=>{
  const first=(await db.query('select * from public.list_sales_pipeline()')).rows;
  const second=(await db.query("select * from public.list_sales_pipeline('all','all',20)")).rows;
  assert.equal(first.length,20);assert.equal(second.length,7);assert.equal(Number(first[0].total_count),27);
  assert.equal(new Set([...first,...second].map(x=>x.id)).size,27);
  for(let v=1;v<=22;v++) assert.equal(await save(id,v,'conversation','Notatka '+v),'ok');
  const history=(await db.query('select * from public.sales_pipeline_history($1)',[id])).rows;
  assert.equal(history.length,20);assert.equal(history[0].version,23);
  assert.equal((await db.query('select * from public.sales_pipeline_history($1,$2)',[id,history.at(-1).version])).rows.length,3);
 });
 await db.query("update private.sales_lead_closures set closed_at=clock_timestamp()-interval '6 months 1 day' where lead_id=$1",[lost]);
 assert.equal(await scalar('select private.purge_closed_sales_leads()'),1);
 for(const table of ['sales_pipeline','sales_pipeline_events']) assert.equal(await scalar('select count(*)::int from private.'+table+' where lead_id=$1',[lost]),0);
 assert.equal(await scalar('select count(*)::int from public.companies'),1);
 assert.equal(await scalar('select count(*)::int from public.sales_leads where id=$1',[won]),1);
 if(databaseUrl){
  const race=await insert();
  const workers=await Promise.all(Array.from({length:5},async()=>{const c=new pg.Client({connectionString:databaseUrl});await c.connect();await c.query('set role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[operator]);return c;}));
  try{
   const results=await Promise.all(workers.map((c,n)=>c.query("select public.save_sales_pipeline($1,0,'conversation',$2,null,null) as result",[race,'Concurrent '+n])));
   assert.equal(results.filter(r=>r.rows[0].result==='ok').length,1);
   assert.equal(results.filter(r=>r.rows[0].result==='conflict').length,4);
   assert.equal(await scalar('select count(*)::int from private.sales_pipeline_events where lead_id=$1',[race]),1);
   console.log('PASS real PostgreSQL: five concurrent saves, exactly one write and history event');
  }finally{await Promise.all(workers.map(c=>c.end()));}
 }
 await db.query('update public.platform_operators set revoked_at=clock_timestamp() where user_id=$1',[operator]);
 await as('authenticated',operator,async()=>{assert.equal(await save(id,23,'offer'),'sales_lead_forbidden');await assert.rejects(db.query('select * from public.list_sales_pipeline()'),/sales_lead_forbidden/);});
});
