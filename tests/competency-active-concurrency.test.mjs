import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activeBoot, hash } from './helpers/competency-active-fixture.mjs';
const busy=e=>['PT409','55P03'].includes(e.code);
const denied=e=>['PT404','42501'].includes(e.code);
const auth=async(c,id)=>{await c.exec('reset role;set role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};

test('C1 native PostgreSQL: shortlist removal serializes against grant/use in both orders',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Native independent connections required');
 const e=await activeBoot(t),{db,h,call}=e,rival=await e.connect();
 for(const operation of ['grant','session']) for(const removalFirst of [false,true]) {
  const r=operation==='grant'?{f:await e.seed()}:await e.started();
  const work=async client=>operation==='grant'
   ?call('public.create_competency_test_grant',[r.f.application.id,r.f.definitionId,new Date(Date.now()+3600000).toISOString(),randomUUID()],client)
   :call('private.inspect_candidate_competency_test',[hash(r.s.session)],client);
  await auth(db,r.f.owner);if(operation==='grant')await auth(rival,r.f.owner);else await e.asGateway(rival);
  if(removalFirst) {
   await db.exec('begin');try {
    await h.remove(r.f.shortlistId);await assert.rejects(work(rival),busy);await db.exec('commit');
   }finally{await db.exec('rollback');}
   await assert.rejects(work(rival),denied);
  }else{
   await rival.exec('begin');try {
    await work(rival);await assert.rejects(h.remove(r.f.shortlistId),busy);await rival.exec('commit');
   }finally{await rival.exec('rollback');}
   await h.remove(r.f.shortlistId);await assert.rejects(work(rival),denied);
  }
 }
});

test('C1 native PostgreSQL: duplicate starts/submits commit once and revoke wins after commit',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Native independent connections required');
 const e=await activeBoot(t),{db,h,call}=e;
 const f=await e.seed(),g=await e.issue(f),s=await e.exchange(g),rival=await e.connect();
 await e.asGateway(rival);await db.exec('begin');
 const args=[hash(s.session),randomUUID()];
 const first=await call('private.start_candidate_competency_test',args);
 await assert.rejects(call('private.start_candidate_competency_test',args,rival),busy);
 await db.exec('commit');assert.equal((await call('private.start_candidate_competency_test',args,rival)).attemptId,first.attemptId);
 await db.exec('begin');const answer=[hash(s.session),JSON.stringify({workSample:'Plan wdrożenia z terminami.'}),randomUUID()];
 await call('private.submit_candidate_competency_test',answer);
 await assert.rejects(call('private.submit_candidate_competency_test',answer,rival),busy);
 await db.exec('commit');assert.equal((await call('private.submit_candidate_competency_test',answer,rival)).attemptId,first.attemptId);
 await h.asUser(f.owner);await db.exec('begin');await call('public.revoke_competency_test_grant',[g.grantId,randomUUID()]);
 await assert.rejects(call('private.status_candidate_competency_test',[hash(s.session)],rival),busy);
 await db.exec('commit');await assert.rejects(call('private.status_candidate_competency_test',[hash(s.session)],rival),denied);
});

test('C2 native PostgreSQL: independent clients share one atomic source budget',async t=>{
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Native independent connections required');
 const e=await activeBoot(t,{fullChain:true}),{db,h,call}=e;
 const clients=await Promise.all(Array.from({length:8},()=>e.connect()));
 await Promise.all(clients.map(c=>e.asGateway(c)));
 const window=(await db.query('select floor(extract(epoch from clock_timestamp())/60)::bigint w')).rows[0].w;
 let accepted=0;
 for(let batch=0;batch<4;batch++) {
  const results=await Promise.all(clients.map(c=>call('private.consume_competency_rate_limit',['a'.repeat(64),window],c)));
  accepted+=results.filter(Boolean).length;
 }
 assert.equal(accepted,15);
 await h.asAdmin();assert.equal((await db.query('select total from competency_runtime.rate_window')).rows[0].total,15);
});
