/** Disposable PostgreSQL ONLY, already migrated. Never run against a project DB.
 * Default: write/operator/rotation races. Retire requires a real aged rotation:
 *   --prepare-retire (rotates normally, exits immediately)
 *   after >=60 min: --retire-current | --retire-previous | --retire-after
 * Each retire scenario needs its own preparation; no timestamps are backdated.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { signSalesLead } from '../lib/sales-lead-signature.ts';
const url=process.env.SALES_LEADS_TEST_DATABASE_URL;
if(!url){console.log('SKIP: SALES_LEADS_TEST_DATABASE_URL absent; concurrency NOT RUN, not PASS.');process.exit(0);}
if(process.env.SALES_LEADS_TEST_DISPOSABLE!=='YES') throw new Error('Refusing: set SALES_LEADS_TEST_DISPOSABLE=YES for a disposable database only');
const parsed=new URL(url);
if(/supabase\.(co|com)$/i.test(parsed.hostname)) throw new Error('Refusing a hosted Supabase project');
const secret='concurrency-fixture-secret-A-'.repeat(2), nextSecret='concurrency-fixture-secret-B-'.repeat(2);
const clients=[];
async function connect(){const c=new pg.Client({connectionString:url});await c.connect();clients.push(c);await c.query("set statement_timeout='15s'; set lock_timeout='12s'");return c;}
const T=await connect(), A=await connect(), B=await connect();
const pid=async c=>(await c.query('select pg_backend_pid() pid')).rows[0].pid;
const apid=await pid(A),bpid=await pid(B);
const scalar=async(c,sql,args=[])=>(Object.values((await c.query(sql,args)).rows[0])[0]);
function input(extra={}) {return {idempotency_key:randomUUID(),first_name:'Test',company_name:'Test',email:`${randomUUID()}@example.test`,phone:null,needs:'Concurrency fixture',source_ip:'203.0.113.10',issued_at_us:Date.now()*1000,...extra};}
function submit(c,i=input(),key=secret){return c.query('select * from public.submit_sales_lead($1,$2,$3,$4,$5,$6,$7,$8,$9)',[i.idempotency_key,i.first_name,i.company_name,i.email,i.phone,i.needs,i.source_ip,i.issued_at_us,signSalesLead(i,key)]).then(r=>r.rows[0]);}
async function cleanLeads(){await T.query('select private.purge_sales_leads(array(select id from public.sales_leads))');await T.query('delete from private.sales_lead_attempts');}
async function reset(){
  await cleanLeads();await T.query('delete from public.platform_operators');
  await T.query('delete from private.sales_lead_settings');await T.query('insert into private.sales_lead_settings(id,leads_enabled) values(true,true)');
  await T.query('select private.rotate_sales_lead_request_secret($1)',[secret]);
}
async function waitFor(check,label){const end=Date.now()+8000;while(Date.now()<end){if(await check())return;await delay(25);}throw new Error(`Timeout: ${label}`);}
async function barrierSeen(key){
  await waitFor(()=>scalar(T,"select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and classid=$2::oid and objid=1 and not granted)",[apid,key]),'A barrier');
  assert.equal(await scalar(T,"select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and classid=6101 and granted)",[apid]),true);
  if(key===6190) assert.equal(await scalar(T,"select exists(select 1 from pg_locks where pid=$1 and relation='private.sales_lead_settings'::regclass and mode='RowShareLock')",[apid]),false);
}
async function mark(c,which){await c.query("select set_config('skillcheck.sales_lead_submit_barrier',$1,false)",[which]);}
async function queued(fn){const c=await connect();try{return await fn(c);}finally{await c.end();clients.splice(clients.indexOf(c),1);}}
async function writes(){
  await reset();const i=input();let r=await Promise.all([submit(A,i),submit(B,i)]);
  assert.deepEqual(r.map(x=>x.result_code).sort(),['accepted','replay']);assert.equal(r[0].lead_id,r[1].lead_id);
  await reset();
  const authors=[randomUUID(),randomUUID()];
  await T.query('insert into auth.users(id) values($1),($2)',authors);
  await A.query("select set_config('request.jwt.claim.sub',$1,false)",[authors[0]]);
  await B.query("select set_config('request.jwt.claim.sub',$1,false)",[authors[1]]);
  r=await Promise.all([submit(A,{...i,submitted_by:authors[0]}),submit(B,{...i,submitted_by:authors[1],needs:'A different description'})]);
  assert.deepEqual(r.map(x=>x.result_code).sort(),['accepted','sales_lead_idempotency_conflict']);assert.equal(await scalar(T,'select count(*)::int from public.sales_leads'),1);
  assert.equal(await scalar(T,'select submitted_by from public.sales_leads'),authors[r.findIndex(x=>x.result_code==='accepted')]);
  await A.query("select set_config('request.jwt.claim.sub','',false)");await B.query("select set_config('request.jwt.claim.sub','',false)");
  await T.query('delete from auth.users where id=any($1::uuid[])',[authors]);
  await reset();await Promise.all(Array.from({length:9},()=>queued(c=>submit(c))));
  assert.equal(await scalar(T,'select count(*)::int from public.sales_leads'),5);assert.equal(await scalar(T,'select count(*)::int from private.sales_lead_attempts'),8);
  await reset();await Promise.all(Array.from({length:4},(_,n)=>queued(c=>submit(c,input({email:'same@example.test',source_ip:`203.0.113.${n+1}`})))));
  assert.equal(await scalar(T,'select count(*)::int from public.sales_leads'),3);
  await reset();await Promise.all(Array.from({length:31},(_,n)=>queued(c=>submit(c,input({source_ip:`203.0.113.${n+1}`})))));
  assert.equal(await scalar(T,'select count(*)::int from public.sales_leads'),30);
  console.log('PASS: concurrent idempotency/source/email/global limits');
}
async function operators(){
  await reset();const u=randomUUID(),v=randomUUID(),w=randomUUID();
  await T.query('insert into auth.users(id) values($1),($2),($3)',[u,v,w]);await T.query('insert into public.platform_operators(user_id) values($1),($2)',[u,v]);
  await A.query("select set_config('request.jwt.claim.sub',$1,false)",[u]);await B.query("select set_config('request.jwt.claim.sub',$1,false)",[v]);
  const r=await Promise.all([scalar(A,'select public.revoke_platform_operator($1)',[v]),scalar(B,'select public.revoke_platform_operator($1)',[u])]);
  assert.equal(r.filter(x=>x==='ok').length,1);assert.equal(await scalar(T,'select count(*)::int from public.platform_operators where revoked_at is null'),1);
  // Restore two operators as fixture owner; force revocation before grant authorization.
  await T.query('update public.platform_operators set revoked_at=null');
  await A.query('begin');await A.query('select public.revoke_platform_operator($1)',[v]);
  const grant=scalar(B,'select public.grant_platform_operator($1)',[w]);
  await waitFor(()=>scalar(T,"select exists(select 1 from pg_locks where pid=$1 and classid=6105 and not granted)",[bpid]),'operator lock');
  await A.query('commit');assert.equal(await grant,'sales_lead_forbidden');
  assert.equal(await scalar(T,'select count(*)::int from public.platform_operators where user_id=$1',[w]),0);
  await A.query("select set_config('request.jwt.claim.sub','',false)");await B.query("select set_config('request.jwt.claim.sub','',false)");
  await T.query('delete from auth.users where id=any($1::uuid[])',[[u,v,w]]);
  console.log('PASS: reciprocal revoke and revoked grant');
}
async function beforeSettings(retire=false,oldSignature=false){
  if(!retire) await reset();else await cleanLeads();
  if(retire) for(let n=0;n<5;n++) assert.equal((await submit(B,input(),nextSecret)).result_code,'accepted');
  await T.query('select pg_advisory_lock(6190,1)');await mark(A,'before_settings');
  const i=input();const pending=submit(A,i,retire&&!oldSignature?nextSecret:secret);
  try {
    await barrierSeen(6190);
    if(retire) await B.query('select private.retire_sales_lead_previous_secret()');
    else {await B.query('select private.rotate_sales_lead_request_secret($1)',[nextSecret]);for(let n=0;n<5;n++) assert.equal((await submit(B,input(),nextSecret)).result_code,'accepted');}
    const attempts=await scalar(T,'select count(*)::int from private.sales_lead_attempts');
    await T.query('select pg_advisory_unlock(6190,1)');const r=await pending;
    assert.ok(Date.now()*1000-i.issued_at_us<120000000);
    assert.equal(r.result_code,oldSignature?'sales_lead_unauthorized':'sales_lead_rate_limited');assert.equal(r.lead_id,null);
    assert.equal(await scalar(T,'select count(*)::int from public.sales_leads'),5);
    assert.equal(await scalar(T,'select count(*)::int from private.sales_lead_attempts'),attempts+(oldSignature?0:1));
    assert.equal(await scalar(T,'select count(*)::int from public.sales_leads where fingerprint_hash<>$1',[createHmac('sha256',nextSecret).update(i.source_ip).digest('hex')]),0);
  } finally {await T.query('select pg_advisory_unlock(6190,1)');await pending.catch(()=>{});await mark(A,'');}
}
async function afterSettings(retire=false){
  if(!retire)await reset();else await cleanLeads();
  await T.query('select pg_advisory_lock(6191,1)');await mark(A,'after_settings');
  const i=input(), signing=retire?nextSecret:secret;const pending=submit(A,i,signing);let change;
  try {
    await barrierSeen(6191);
    change=retire?B.query('select private.retire_sales_lead_previous_secret()'):B.query('select private.rotate_sales_lead_request_secret($1)',[nextSecret]);
    await waitFor(()=>scalar(T,'select $1::int=any(pg_blocking_pids($2))',[apid,bpid]),'B waits for A settings');
    assert.equal(await scalar(T,"select exists(select 1 from pg_locks where pid=$1 and locktype in ('transactionid','tuple') and not granted)",[bpid]),true);
    await T.query('select pg_advisory_unlock(6191,1)');assert.equal((await pending).result_code,'accepted');await change;
    assert.equal(await scalar(T,'select fingerprint_hash from public.sales_leads'),createHmac('sha256',signing).update(i.source_ip).digest('hex'));
  } finally {await T.query('select pg_advisory_unlock(6191,1)');await pending.catch(()=>{});if(change)await change.catch(()=>{});await mark(A,'');}
}
try {
  const mode=process.argv[2];
  if(mode==='--prepare-retire'){
    await reset();await T.query('select private.rotate_sales_lead_request_secret($1)',[nextSecret]);
    console.log('PREPARED: ordinary rotation committed. Run one --retire-* case after >=60 minutes. No test PASS yet.');
  } else if(['--retire-current','--retire-previous','--retire-after'].includes(mode)) {
    assert.equal(await scalar(T,"select request_secret_previous=$1 and request_secret_current=$2 and request_secret_rotated_at<=clock_timestamp()-interval '60 minutes' from private.sales_lead_settings",[secret,nextSecret]),true,'Prepare rotation normally >=60 min beforehand; never backdate');
    if(mode==='--retire-after')await afterSettings(true);else await beforeSettings(true,mode==='--retire-previous');
    console.log(`PASS: ${mode} only`);
  } else {
    if(mode)throw new Error('Unknown scenario');
    await writes();await operators();await beforeSettings();await afterSettings();
    console.log('PASS: rotation before/after settings. RETIRE NOT RUN: prepare and execute all three --retire-* cases. Full concurrency acceptance NOT PASS.');
  }
} finally {
  await Promise.allSettled(clients.map(async c=>{await c.query('rollback');await c.query('select pg_advisory_unlock_all()');await c.end();}));
}
