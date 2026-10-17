import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { signSalesLead, salesLeadCanonical, normalizeSalesLead } from '../lib/sales-lead-signature.ts';
const secret = 'test-only-secret-A-'.repeat(3), secretB = 'test-only-secret-B-'.repeat(3);
const migration = await readFile(new URL('../supabase/migrations/20261007000200_sales_leads.sql', import.meta.url),'utf8');
const bootstrap = `create role anon; create role authenticated; create schema auth;
create table auth.users(id uuid primary key); create schema private;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth, public to anon,authenticated; grant usage on schema private to authenticated;
grant execute on function auth.uid() to anon,authenticated;`;
let db;
const query = async (sql,args=[]) => (await db.query(sql,args)).rows;
async function value(sql,args=[]) { return Object.values((await query(sql,args))[0])[0]; }
async function reset() {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);
    select private.purge_sales_leads(array(select id from public.sales_leads));
    delete from private.sales_lead_attempts; delete from public.platform_operators; delete from auth.users;
    delete from private.sales_lead_settings; insert into private.sales_lead_settings(id) values(true);`);
  await db.query('select private.rotate_sales_lead_request_secret($1)',[secret]);
  await db.exec('update private.sales_lead_settings set leads_enabled=true');
}
function input(overrides={}) { return {idempotency_key:randomUUID(),first_name:'  Jaś   Kowalski ',company_name:' Firma  Sp. ',email:`${randomUUID()}@example.test`,phone:'',needs:'Potrzebujemy rekrutacji\r\nNa jutro.',source_ip:'203.0.113.10',issued_at_us:Date.now()*1000,...overrides}; }
async function submit(i=input(), signingSecret=secret, signature=signSalesLead(i,signingSecret)) {
  return (await query('select * from public.submit_sales_lead($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [i.idempotency_key,i.first_name,i.company_name,i.email,i.phone,i.needs,i.source_ip,i.issued_at_us,signature]))[0];
}
async function as(role,uid,fn) {
  await db.exec(`set role ${role}`); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid||'']);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); }
}
const count = table => value(`select count(*)::int from ${table}`);
before(async()=>{db=new PGlite({extensions:{pgcrypto}});await db.exec(bootstrap);await db.exec(migration);});
beforeEach(reset);
after(async()=>db?.close());

test('pgcrypto: absent, correct schema, wrong schema and missing overload',async()=>{
  for (const mode of ['absent','correct','wrong','missing']) {
    const d=new PGlite({extensions:{pgcrypto}});
    try {
      await d.exec(bootstrap);
      if(mode!=='absent') await d.exec(`create schema extensions; create extension pgcrypto with schema ${mode==='wrong'?'public':'extensions'}`);
      if(mode==='missing') await d.exec('alter function extensions.hmac(text,text,text) rename to hmac_missing');
      if(mode==='wrong'||mode==='missing') {
        await assert.rejects(d.exec(migration),new RegExp(mode==='wrong'?'sales_lead_pgcrypto_schema':'sales_lead_pgcrypto_hmac'));
        await d.exec('rollback');
        assert.equal((await d.query("select count(*)::int n from pg_extension where extname='pgcrypto'")).rows[0].n,1);
        assert.equal((await d.query("select to_regclass('public.sales_leads') x")).rows[0].x,null);
      } else {
        await d.exec(migration);
        assert.ok((await d.query("select to_regprocedure('extensions.hmac(text,text,text)') x")).rows[0].x);
      }
    } finally {await d.close();}
  }
});

test('canonical UTF-8 fixture and accepted anonymous request',async()=>{
  const i=input();
  const h=await value("select encode(extensions.hmac($1,$2,'sha256'),'hex')",[salesLeadCanonical(i),secret]);
  assert.equal(h,signSalesLead(i,secret));
  assert.equal(signSalesLead({...i,userAgent:'changed'},secret),h);
  const r=await as('anon',null,()=>submit(i)); assert.equal(r.result_code,'accepted');assert.ok(r.lead_id);
  const row=(await query('select * from public.sales_leads'))[0];
  assert.equal(row.first_name,'Jaś Kowalski');assert.equal(row.phone,null);assert.equal(row.submitted_by,null);
  assert.equal(row.fingerprint_hash,createHmac('sha256',secret).update(i.source_ip).digest('hex'));
  assert.equal(await count('private.sales_lead_attempts'),1);
});

test('unauthorized requests never write attempts; missing secret is unavailable',async()=>{
  const i=input();
  const bad=[{...i,issued_at_us:Date.now()*1000-121000000},{...i,issued_at_us:Date.now()*1000+31000000},
    {...i,source_ip:'127.0.0.1, 203.0.113.1'},{...i,source_ip:'999.1.1.1'},{...i,source_ip:':::'},{...i,source_ip:'fe80::1%eth0'}];
  for(const j of bad) assert.equal((await submit(j)).result_code,'sales_lead_unauthorized');
  assert.equal((await submit(i,secret,'bad')).result_code,'sales_lead_unauthorized');
  assert.equal((await submit({...i,needs:'modified content'},secret,signSalesLead(i,secret))).result_code,'sales_lead_unauthorized');
  const uid=randomUUID();await db.query('insert into auth.users values($1)',[uid]);
  assert.equal((await as('authenticated',uid,()=>submit(i))).result_code,'sales_lead_unauthorized');
  assert.equal(await count('private.sales_lead_attempts'),0);assert.equal(await count('public.sales_leads'),0);
  await db.exec('update private.sales_lead_settings set request_secret_current=null');
  assert.equal((await submit(i)).result_code,'sales_lead_unavailable');
});

test('validation persists business refusal, flags suppress all new attempts',async()=>{
  let invalidIndex=0;
  for(const bad of [{email:'invalid'},{first_name:'a'.repeat(81)},{company_name:'a'.repeat(161)},{needs:'x'.repeat(1001)},
    {needs:'short'},{phone:'1234'},{phone:'letters'},{phone:'1'.repeat(33)},{needs:'invalid\u007fcontent'},{email:'a\u0001@example.test'}]) {
    const r=await submit(input({...bad,source_ip:`203.0.113.${++invalidIndex}`}));
    assert.equal(r.result_code,'sales_lead_invalid');assert.equal(r.lead_id,null);
  }
  assert.equal(await count('public.sales_leads'),0);
  const cols=await query("select column_name from information_schema.columns where table_schema='private' and table_name='sales_lead_attempts' order by ordinal_position");
  assert.deepEqual(cols.map(x=>x.column_name),['id','fingerprint_hash','attempted_at','result']);
  await db.exec('update private.sales_lead_settings set leads_enabled=false');
  const n=await count('private.sales_lead_attempts');
  for(const j of [input(),input({email:'bad'})]) assert.equal((await submit(j)).result_code,'sales_lead_unavailable');
  assert.equal(await count('private.sales_lead_attempts'),n);
});

test('idempotency, capped replay, disabled conflict and author deletion',async()=>{
  const uid=randomUUID(),uid2=randomUUID();await db.query('insert into auth.users values($1),($2)',[uid,uid2]);
  const i=input({submitted_by:uid});const accepted=await as('authenticated',uid,()=>submit(i));
  assert.equal(accepted.result_code,'accepted');
  const original=(await query('select * from public.sales_leads'))[0];
  assert.equal(original.submitted_by,uid);
  for(let n=0;n<25;n++) assert.deepEqual(await as('authenticated',uid2,()=>submit({...i,submitted_by:uid2})),{lead_id:accepted.lead_id,result_code:'replay'});
  assert.equal(await value('select replay_count from private.sales_lead_replay_state'),20);
  assert.equal(await count('private.sales_lead_attempts'),1);
  assert.equal((await submit({...i,submitted_by:null,needs:'different description'})).result_code,'sales_lead_idempotency_conflict');
  await db.exec('update private.sales_lead_settings set leads_enabled=false');
  const n=await count('private.sales_lead_attempts');
  assert.equal((await submit({...i,submitted_by:null,needs:'different description'})).result_code,'sales_lead_unavailable');
  assert.equal((await submit({...i,submitted_by:null})).result_code,'replay');
  assert.equal(await count('private.sales_lead_attempts'),n);
  assert.equal((await query('select * from public.sales_leads'))[0].submitted_by,uid);
  await assert.rejects(db.exec("update public.sales_leads set needs='not allowed description'"),/sales_lead_immutable/);
  await assert.rejects(db.exec('delete from public.sales_leads'),/sales_lead_immutable/);
  await db.query('delete from auth.users where id=$1',[uid]);
  assert.deepEqual((await query('select * from public.sales_leads'))[0],{...original,submitted_by:null});
  await db.query('select private.purge_sales_leads($1::uuid[])',[[accepted.lead_id]]);assert.equal(await count('public.sales_leads'),0);
});

test('attempt, source, normalized-email and global limits',async()=>{
  for(let n=0;n<9;n++) assert.equal((await submit(input({email:'bad'}))).result_code,n<8?'sales_lead_invalid':'sales_lead_rate_limited');
  assert.equal(await count('private.sales_lead_attempts'),8);
  await reset();
  for(let n=0;n<6;n++) assert.equal((await submit()).result_code,n<5?'accepted':'sales_lead_rate_limited');
  assert.equal(await count('public.sales_leads'),5);
  await reset();
  for(let n=0;n<4;n++) assert.equal((await submit(input({email:n%2?' A@EXAMPLE.TEST ':'a@example.test',source_ip:`203.0.113.${n+1}`}))).result_code,n<3?'accepted':'sales_lead_rate_limited');
  await reset();
  for(let n=0;n<31;n++) assert.equal((await submit(input({source_ip:`203.0.113.${n+1}`}))).result_code,n<30?'accepted':'sales_lead_rate_limited');
  assert.equal(await count('public.sales_leads'),30);
});

test('rotation retains source history 59 minutes, not 61; early retirement blocked',async()=>{
  const fp=createHmac('sha256',secret).update('203.0.113.10').digest('hex');
  for(let n=0;n<5;n++) await db.query("insert into public.sales_leads(idempotency_key,first_name,company_name,email,needs,fingerprint_hash,created_at) values($1,'Test','Company',$2,'test content',$3,clock_timestamp()-interval '59 minutes')",[randomUUID(),`${n}@example.test`,fp]);
  await db.query('select private.rotate_sales_lead_request_secret($1)',[secretB]);
  assert.equal((await submit(input(),secretB)).result_code,'sales_lead_rate_limited');
  assert.equal((await submit(input({issued_at_us:Date.now()*1000-121000000}))).result_code,'sales_lead_unauthorized');
  await assert.rejects(db.exec('select private.retire_sales_lead_previous_secret()'),/sales_lead_secret_history_open/);
  await assert.rejects(db.exec('update private.sales_lead_settings set request_secret_previous=null'),/sales_lead_secret_history_open/);
  await assert.rejects(db.exec("update private.sales_lead_settings set request_secret_rotated_at=clock_timestamp()-interval '61 minutes'"),/sales_lead_secret_history_open/);
  await assert.rejects(db.query('select private.rotate_sales_lead_request_secret($1)',[secret]),/sales_lead_secret_rotation_busy/);
  await db.exec('select private.purge_sales_leads(array(select id from public.sales_leads))');
  for(let n=0;n<5;n++) await db.query("insert into public.sales_leads(idempotency_key,first_name,company_name,email,needs,fingerprint_hash,created_at) values($1,'Test','Company',$2,'test content',$3,clock_timestamp()-interval '61 minutes')",[randomUUID(),`${n}@example.test`,fp]);
  assert.equal((await submit(input(),secretB)).result_code,'accepted');
});

test('API privileges and operator lifecycle',async()=>{
  const users=Array.from({length:4},randomUUID);for(const u of users) await db.query('insert into auth.users values($1)',[u]);
  await submit();
  for(const role of ['anon','authenticated']) {
    for(const table of ['sales_leads','platform_operators']) for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])
      assert.equal(await value('select has_table_privilege($1,$2,$3)',[role,`public.${table}`,privilege]),false);
    for(const u of [null,...users.slice(0,3)]) await as(role,u,async()=>{
      await assert.rejects(db.exec('select * from public.sales_leads'),/permission denied/);
      await assert.rejects(db.exec("insert into public.sales_leads default values"),/permission denied/);
      await assert.rejects(db.exec('select * from public.list_sales_leads()'),role==='anon'?/permission denied/:/sales_lead_forbidden/);
    });
    assert.equal(await value('select has_function_privilege($1,$2,\'EXECUTE\')',[role,'private.purge_sales_leads(uuid[])']),false);
    for(const fn of ['private.rotate_sales_lead_request_secret(text)','private.retire_sales_lead_previous_secret()','private.detach_sales_lead_author(uuid)'])
      assert.equal(await value('select has_function_privilege($1,$2,\'EXECUTE\')',[role,fn]),false);
  }
  assert.equal(await as('authenticated',null,()=>value('select public.platform_operator_status()')),false);
  await db.query('insert into public.platform_operators(user_id) values($1)',[users[0]]);
  await as('authenticated',users[0],async()=>{
    assert.equal(await value('select public.platform_operator_status()'),true);
    assert.equal((await query('select * from public.list_sales_leads(0)')).length,1);
    assert.equal(await value('select public.revoke_platform_operator($1)',[users[0]]),'sales_lead_last_operator');
    assert.equal(await value('select public.grant_platform_operator($1)',[randomUUID()]),'sales_lead_invalid');
    assert.equal(await value('select public.grant_platform_operator($1)',[users[1]]),'ok');
    assert.equal(await value('select public.revoke_platform_operator($1)',[users[1]]),'ok');
  });
  await as('authenticated',users[1],async()=>{
    assert.equal(await value('select public.platform_operator_status()'),false);
    assert.equal(await value('select public.grant_platform_operator($1)',[users[2]]),'sales_lead_forbidden');
    await assert.rejects(db.exec('select * from public.list_sales_leads()'),/sales_lead_forbidden/);
  });
});

test('full migration chain: company roles are not operators and submissions create no tenant',async()=>{
  const originalDb=db;
  db=new PGlite({extensions:{pgcrypto}});
  try {
    await db.exec(bootstrap.replace('create schema private;','').replace('grant usage on schema private to authenticated;',''));
    const dir=new URL('../supabase/migrations/',import.meta.url);
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name,dir),'utf8'));
    await db.query('select private.rotate_sales_lead_request_secret($1)',[secret]);await db.exec('update private.sales_lead_settings set leads_enabled=true');
    const [owner,recruiter,viewer]=[randomUUID(),randomUUID(),randomUUID()];
    await db.query('insert into auth.users values($1),($2),($3)',[owner,recruiter,viewer]);
    const company=await as('authenticated',owner,()=>value("select public.create_company('Tenant')"));
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",[company,recruiter,viewer]);
    const before=[await count('public.companies'),await count('public.company_members')];
    for(const user of [owner,recruiter,viewer]) await as('authenticated',user,async()=>{
      assert.equal(await value('select public.platform_operator_status()'),false);
      await assert.rejects(db.exec('select * from public.list_sales_leads()'),/sales_lead_forbidden/);
      for(const table of ['sales_leads','platform_operators']) {
        await assert.rejects(db.exec(`select * from public.${table}`),/permission denied/);
        await assert.rejects(db.exec(`insert into public.${table} default values`),/permission denied/);
      }
      assert.equal((await submit(input({submitted_by:user}))).result_code,'accepted');
    });
    assert.deepEqual([await count('public.companies'),await count('public.company_members')],before);
  } finally {await db.close();db=originalDb;}
});

test('operator list clamps 1–100, defaults 50 and orders by timestamp then UUID',async()=>{
  const u=randomUUID();await db.query('insert into auth.users values($1)',[u]);await db.query('insert into public.platform_operators(user_id) values($1)',[u]);
  await db.exec(`insert into public.sales_leads(idempotency_key,first_name,company_name,email,needs,fingerprint_hash)
    select gen_random_uuid(),'Test','Company','test@example.test','test description',repeat('a',64) from generate_series(1,101)`);
  await as('authenticated',u,async()=>{
    assert.equal((await query('select * from public.list_sales_leads()')).length,50);
    assert.equal((await query('select * from public.list_sales_leads(null)')).length,50);
    assert.equal((await query('select * from public.list_sales_leads(-100)')).length,1);
    const rows=await query('select * from public.list_sales_leads(999)');assert.equal(rows.length,100);
    assert.deepEqual(rows.map(r=>r.id),rows.map(r=>r.id).sort().reverse());
  });
});


test('normalization agrees with Node for Unicode whitespace and multiline UTF-8',async()=>{
  const i=input({first_name:'\u00a0Jaś\u2003Kowalski\ufeff',company_name:'\u3000Firma\u202fTest\u00a0',email:'\ufeffA@EXAMPLE.TEST\u00a0',needs:'\u00a0Nowa rekrutacja\r\nDruga linia\u3000'});
  assert.equal((await submit(i)).result_code,'accepted');
});


test('R1: Unicode email signatures, stored normalization and normalized replay', async () => {
  const cases = [
    [' TEST@EXAMPLE.TEST ', 'test@example.test'],
    ['İ@example.test', 'i\u0307@example.test'],
    ['ΟΣ@example.test', 'οσ@example.test'],
    ['ΟΣΑ@example.test', 'οσα@example.test'],
    ['ŁÓDŹ@EXAMPLE.TEST', 'łódź@example.test'],
    ['ẞ@example.test', 'ß@example.test'],
    ['𐐀@example.test', '𐐨@example.test'],
    ['ı@example.test', 'ı@example.test'],
    ['😀+中@example.test', '😀+中@example.test'],
  ];
  for (const [index, [email, expected]] of cases.entries()) {
    const i = input({email, source_ip: `203.0.113.${index + 20}`});
    assert.equal(normalizeSalesLead(i).email, expected);
    const r = await as('anon', null, () => submit(i));
    assert.equal(r.result_code, 'accepted', email); assert.ok(r.lead_id);
    assert.equal(await value('select email from public.sales_leads where id=$1', [r.lead_id]), expected);
    const replay = await as('anon', null, () => submit({...i, email: expected}));
    assert.equal(replay.result_code, 'replay'); assert.equal(replay.lead_id, r.lead_id);
  }
  assert.equal(await count('public.sales_leads'), cases.length);
  assert.equal(await count('private.sales_lead_attempts'), cases.length);
});

test('R1: entire Unicode lowercase mapping agrees with SQL and is idempotent', async () => {
  // Independent oracle: single-code-point Unicode lowercasing, not whole-string contextual lowercasing.
  const chars = [];
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    if (c !== c.toLowerCase()) chars.push(c);
  }
  const source = chars.join('') + 'ςıß中😀';
  const expected = Array.from(source, c => c.toLowerCase()).join('');
  const normalized = normalizeSalesLead(input({email: source})).email;
  assert.equal(normalized, expected);
  assert.equal(await value('select private.sales_lead_lower_email($1)', [source]), expected);
  assert.equal(await value('select private.sales_lead_lower_email($1)', [expected]), expected);
  assert.equal(normalizeSalesLead(input({email: expected})).email, expected);
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await value("select has_function_privilege($1,'private.sales_lead_lower_email(text)','execute')", [role]), false);
  }
});
