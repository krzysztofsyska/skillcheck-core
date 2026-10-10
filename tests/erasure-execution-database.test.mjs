import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {setupRankingDatabase,users} from './helpers/screening-ranking-fixture.mjs';
import {executionHarness,setupExecutionLedger} from './helpers/erasure-execution-fixture.mjs';
import {digest} from '../tools/erasure/ledger.mjs';
import {assertAcceptedErasureSchema} from './helpers/erasure-preview-fixture.mjs';
const conflict=error=>error.code==='PT409';

// Runs the installed SQL chain and the real durable synthetic ledger adapter.
// No product database, credentials, external candidate API or production activation.
test('SC-010 R3 acknowledged erasure execution and restore capability boundaries',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
 const h=await setupRankingDatabase(db),ledgerDb=new PGlite();t.after(()=>ledgerDb.close());const x=await setupExecutionLedger(executionHarness(h),ledgerDb);
 await assertAcceptedErasureSchema(h,t);
 await t.test('execution is disabled by default and ordinary roles cannot invoke worker or ACK capabilities',async()=>{
  const f=await x.ready(),state=await x.freeze(f);
  await assert.rejects(x.reserve(state.request_id,0,'authorized'),conflict);
  for(const role of ['authenticated','anon','screening_worker','contact_verifier']){
   await h.asAdmin();await db.exec(`set role ${role}`);
   if(role==='authenticated')await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f.owner]);
   await assert.rejects(db.query('select private.reserve_erasure_transition($1,0,$2,$3)',[state.request_id,'authorized',randomUUID()]));
   await assert.rejects(db.query('select private.purge_candidate_erasure($1,0)',[state.request_id]));
  }
  await h.asAdmin();
  for(const role of ['erasure_worker','erasure_ledger_attestor','erasure_restore_attestor']){
   const attrs=(await db.query('select rolcanlogin,rolsuper,rolbypassrls,rolcreaterole from pg_roles where rolname=$1',[role])).rows[0];
   assert.deepEqual(attrs,{rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolcreaterole:false});
   assert.equal((await db.query("select pg_has_role($1,'erasure_purge_owner','MEMBER') allowed",[role])).rows[0].allowed,false);
   for(const table of ['public.candidates','private.erasure_candidate_lifecycle','private.erasure_purge_context','private.erasure_purge_context_rows','private.retired_candidate_ids'])for(const privilege of ['INSERT','UPDATE','DELETE'])assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,table,privilege])).rows[0].allowed,false);
  }
  await x.role('erasure_worker');
  await assert.rejects(db.query('select private.confirm_erasure_ledger_event($1,$2,1,$3,$4,$5)',[state.request_id,randomUUID(),'0'.repeat(64),'1'.repeat(64),'2'.repeat(64)]));
  await db.query("select set_config('skillcheck.erasure_purge','true',false)");
  await assert.rejects(db.query('delete from public.candidates where id=$1',[f.candidate.id]));
  await h.asUser(f.owner);await x.cancel(f,state.request_id,state.generation);
 });
 await t.test('real signed durable ACK binds the reservation; lost ACK freezes cancellation until ledger reconciliation',async()=>{
  await x.configure();const f=await x.ready(),state=await x.freeze(f),reservation=await x.reserve(state.request_id,0,'authorized');
  const receipt=await x.ledger.append({eventId:reservation.reservation_id,envelopeText:reservation.envelope_text,envelopeHash:reservation.envelope_hash});
  await assert.rejects(x.attest(reservation,{...receipt,signature:'AAAA'}));
  await assert.rejects(x.attest({...reservation,envelope_hash:'0'.repeat(64)},receipt));
  await x.purge(state.request_id,0).then(()=>assert.fail('No purge without erasing ACK'),error=>assert.ok(error));
  await h.asUser(f.owner);await assert.rejects(x.cancel(f,state.request_id,state.generation),conflict);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0,'ambiguous external ACK cannot unfreeze');
  await x.attest(reservation,receipt); // Actual durable event is authoritative after lost response.
  await h.asUser(f.owner);const cancelKey=randomUUID();await x.cancel(f,state.request_id,state.generation,cancelKey);const cancelled=await x.work(state.request_id);await x.ack(cancelled);
  await h.asUser(f.owner);assert.equal(await x.cancel(f,state.request_id,state.generation,cancelKey),state.request_id);await assert.rejects(x.cancel(f,state.request_id,state.generation),conflict);
  await h.asUser(f.owner);assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,1);
  await assert.rejects(x.reserve(state.request_id,2,'erasing'),conflict);
 });
 await t.test('purge removes the complete confirmed graph, keeps shared configuration and cannot resurrect retired IDs',async()=>{
  await x.configure();const f=await x.ready({rich:true}),duplicate=await h.candidate(f),unrelated=await h.candidate(f),other=await x.ready({owner:users.otherOwner});
  await h.asUser(f.owner);f.resolutionId=await x.resolve(f,[f.candidate.id,duplicate.candidate.id],1);
  const before=await x.snapshot(),state=await x.freeze(f);
  await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  await h.asUser(f.owner);await assert.rejects(x.cancel(f,state.request_id,state.generation),conflict);
  await x.purge(state.request_id,2);
  await h.asAdmin();
  for(const candidate of [f.candidate,duplicate.candidate])assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[candidate.id])).rows[0].n,0);
  for(const candidate of [unrelated.candidate,other.candidate])assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[candidate.id])).rows[0].n,1);
  const after=await x.snapshot();
  for(const table of ['public.positions','public.recruitments','public.assessment_stages','public.exercise_definition_entries','private.candidate_retention_policies','private.contact_trusted_issuers','private.contact_policy_templates'])assert.deepEqual(after[table],before[table],table);
  const ids=[f.candidate.id,duplicate.candidate.id,f.application.id,duplicate.application.id,f.documentId,duplicate.documentId,f.analysis_id,f.communicationId,f.receiptId];
  for(const [table,rows]of Object.entries(after))if(table.startsWith('public.')||['private.contact_requests','private.contact_audit','private.candidate_verified_contact_points','private.candidate_verified_contact_receipts','private.erasure_subject_resolutions','private.erasure_preview_tickets'].includes(table))for(const id of ids)assert.ok(!JSON.stringify(rows).includes(id),`${table} retained erased graph reference`);
  await h.asUser(f.owner);await assert.rejects(h.insert('candidates',{id:f.candidate.id,company_id:f.companyId,first_name:'Resurrected',last_name:'UUID'}),conflict);
  await x.transition(state.request_id,2,'active_data_erased');
  const status=await x.requestStatus(f,state.request_id);assert.notEqual(status.status,'completed');assert.ok(JSON.stringify(status).includes('active_data_erased'));
 });
 await t.test('changed policy, missing inventory confirmation and unknown schema stop execution before deletion',async()=>{
  await x.configure();const f=await x.ready(),state=await x.freeze(f);
  await x.configure({external_inventory_verified:false});await assert.rejects(x.reserve(state.request_id,0,'authorized'),conflict);
  await x.configure();await h.asUser(f.owner);await x.policy(f,1,(await x.getPolicy(f)).rules.map(rule=>({...rule,duration_days:31})));
  await assert.rejects(x.reserve(state.request_id,0,'authorized'),conflict);
  const fresh=await x.ready(),request=await x.freeze(fresh);await h.asAdmin();await db.exec('begin');
  try{await db.exec('create table public.unknown_r3_candidate_copy(candidate_id uuid)');await assert.rejects(x.reserve(request.request_id,0,'authorized'),conflict);}finally{await db.exec('rollback');}
 });

 await t.test('verified ledger restores a purge authority from a backup preceding policy and authorization',async()=>{
  await x.configure();const f=await h.seed(),restoreLedger=new PGlite();t.after(()=>restoreLedger.close());
  const restored=await setupExecutionLedger(executionHarness(h),restoreLedger);let request;
  await h.asAdmin();await db.exec('begin');
  try{
   await h.asUser(f.owner);await restored.policy(f,0,(await import('./helpers/erasure-lifecycle-fixture.mjs')).lifecycleRules);f.resolutionId=await restored.resolve(f);
   request=(await restored.freeze(f)).request_id;
   await restored.transition(request,0,'authorized');await restored.transition(request,1,'erasing');await restored.purge(request,2);await restored.transition(request,2,'active_data_erased');
  }finally{await db.exec('rollback');}
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from private.candidate_retention_policies where company_id=$1',[f.companyId])).rows[0].n,0);
  await assert.rejects(restored.replay(),conflict); // Normal product access is never restore authority.
  await restored.configure({restore_isolated:true});await h.asUser(f.owner);
  await assert.rejects(restored.preview(f),conflict);await assert.rejects(restored.getResolution(f),conflict);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0);
  const replay=await restored.replay();assert.equal(replay.replayed,1);assert.equal(replay.verifiedEvents,3);
  const replayAgain=await restored.replay();assert.equal(replayAgain.checkpoint,replay.checkpoint);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0);
  await restored.configure();await h.asUser(f.owner);await assert.rejects(h.insert('candidates',{id:f.candidate.id,company_id:f.companyId,first_name:'Old',last_name:'Restore UUID'}),conflict);
 });

 await t.test('finite owner holds block erasing until explicit release and cannot race after erasing reservation',async()=>{
  await x.configure();const f=await x.ready(),state=await x.freeze(f);await x.transition(state.request_id,0,'authorized');
  const setHold=async()=>{await h.asUser(f.owner);return(await db.query("select public.set_candidate_erasure_hold($1,'owner_review',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',$2) id",[state.request_id,randomUUID()])).rows[0].id;};
  const hold=await setHold();await assert.rejects(x.reserve(state.request_id,1,'erasing'),conflict);
  await h.asAdmin();await db.query("update private.erasure_holds set review_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",[hold]);
  await assert.rejects(x.reserve(state.request_id,1,'erasing'),conflict);
  await h.asUser(users.otherOwner);await assert.rejects(db.query('select public.release_candidate_erasure_hold($1)',[hold]));
  await h.asUser(f.owner);await db.query('select public.release_candidate_erasure_hold($1)',[hold]);
  const erasing=await x.reserve(state.request_id,1,'erasing');await assert.rejects(setHold(),conflict);
  await x.ack(erasing);await x.purge(state.request_id,2);
 });

 await t.test('expired execution lease cannot purge until a fresh erasing event is durably acknowledged',async()=>{
  await x.configure();const f=await x.ready(),state=await x.freeze(f);await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  await h.asAdmin();await db.query("update private.erasure_executions set lease_until=clock_timestamp()-interval '1 second' where request_id=$1",[state.request_id]);
  await assert.rejects(x.purge(state.request_id,2),conflict);
  await x.transition(state.request_id,2,'erasing');await x.purge(state.request_id,3);
 });

 await t.test('unmapped provider response and shared administrative subject references block purge scope',async()=>{
  await x.configure();const f=await x.ready({rich:true});await h.asAdmin();
  await db.query('update public.screening_analysis_attempts set provider_response_id=$1 where id=$2',['external-response-only',f.attempt_id]);
  const externalState=await x.freeze(f);await assert.rejects(x.reserve(externalState.request_id,0,'authorized'),conflict);
  const shared=await x.ready(),other=await h.candidate(shared);await x.resolve(shared,[shared.candidate.id,other.candidate.id],1);
  const ticket=await x.ticket(shared,'candidate_record',null);assert.ok(ticket.blockers.includes('shared_resolution_requires_adapter'));await assert.rejects(x.authorize(shared,ticket),conflict);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidates where id=any($1::uuid[])',[[shared.candidate.id,other.candidate.id]])).rows[0].n,2);
 });
 await t.test('independent denial after erasing ACK invalidates manifest and requires another signed erasing event',async()=>{
  await x.configure();const f=await x.ready({rich:true}),state=await x.freeze(f);await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  await h.asUser(f.owner);await x.v.permission(f,'revoked',1);await assert.rejects(x.purge(state.request_id,2),conflict);
  await x.transition(state.request_id,2,'erasing');await x.purge(state.request_id,3);
 });

 await t.test('policy cannot change after erasing reservation and before its authoritative ledger ACK',async()=>{
  await x.configure();const f=await x.ready(),state=await x.freeze(f);await x.transition(state.request_id,0,'authorized');
  const erasing=await x.reserve(state.request_id,1,'erasing');
  await h.asUser(f.owner);const current=await x.getPolicy(f);
  await assert.rejects(x.policy(f,current.revision,current.rules.map(rule=>({...rule,duration_days:rule.duration_days+1}))),conflict);
  assert.equal((await x.getPolicy(f)).revision,current.revision);
  await x.ack(erasing);await x.purge(state.request_id,2);
  await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[f.candidate.id])).rows[0].n,0);
 });
 await t.test('a confirmed subject cannot shrink while frozen and first erasing rejects a newer resolution',async()=>{
  await x.configure();const f=await x.ready(),duplicate=await h.candidate(f);
  f.resolutionId=await x.resolve(f,[f.candidate.id,duplicate.candidate.id],1);
  const state=await x.freeze(f);await h.asUser(f.owner);
  await assert.rejects(x.resolve(f,[f.candidate.id],2),conflict);
  await x.transition(state.request_id,0,'authorized');
  await h.asAdmin();await db.exec('begin');
  try{
   // Simulate privileged stale/restore metadata; application roles cannot write this table.
   await db.query('insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by) values($1,$2,$3::uuid[],3,$4)',[f.companyId,f.candidate.id,[f.candidate.id],f.owner]);
   await assert.rejects(x.reserve(state.request_id,1,'erasing'),conflict);
  }finally{await db.exec('rollback');}
  await x.transition(state.request_id,1,'erasing');await x.purge(state.request_id,2);
  const frozen=await x.ready(),active=await h.candidate(frozen);await x.freeze(frozen);
  await h.asAdmin();
  // Legacy/restore metadata can refer from an active anchor to a frozen member.
  await db.query('insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by) values($1,$2,$3::uuid[],1,$4)',[frozen.companyId,active.candidate.id,[active.candidate.id,frozen.candidate.id].sort(),frozen.owner]);
  await h.asUser(frozen.owner);await assert.rejects(x.resolve(active,[active.candidate.id],1),conflict);
 });
 await t.test('configuration cannot use an old transaction snapshot to bypass pending execution guards',async()=>{
  await x.configure();const f=await x.ready(),policy=await x.getPolicy(f);
  for(const operation of [()=>x.policy(f,policy.revision,policy.rules),()=>x.resolve(f,[f.candidate.id],1)]){
   await h.asUser(f.owner);await db.exec('begin isolation level repeatable read');
   try{await assert.rejects(operation(),error=>error.code==='PT409'&&error.message==='Fresh transaction required');}finally{await db.exec('rollback');}
  }
 });

 await t.test('expired signed recovery streams distinguish cancelled, still-present and already-absent graphs',async()=>{
  const history=async(phases,{absent=false}={})=>{
   await x.configure();await h.asAdmin();
   // Each synthetic historical deployment starts from a backup without a checkpoint.
   await db.query('delete from private.erasure_restore_checkpoint');
   const base=await x.ready();let f=base,reservation;
   if(absent){await h.asAdmin();await db.exec('begin');f=await h.candidate(base);f.resolutionId=await x.resolve(f);}
   try{const state=await x.freeze(f);reservation=await x.reserve(state.request_id,0,'authorized');}finally{if(absent)await db.exec('rollback');}
   const ledgerDb=new PGlite();t.after(()=>ledgerDb.close());const historical=await setupExecutionLedger(executionHarness(h),ledgerDb);
   // Historical fixture: the actual SQL-created envelope is backdated while its
   // exact reviewed subject/policy/schema boundary remains unchanged. The real
   // independent ledger encrypts/signs every event; restore verifies the full chain.
   const original={...JSON.parse(reservation.envelope_text),authorized_at:new Date(Date.now()-3*86400000).toISOString(),retention_until:new Date(Date.now()-86400000).toISOString()};let previous=null;
   for(const [i,phase]of phases.entries()){
    const envelope={...original,phase,sequence:i+1,previous_phase:i?phases[i-1]:null,previous_event_hash:previous?.event_hash??null};
    const envelopeText=JSON.stringify(envelope);previous=await historical.ledger.append({eventId:randomUUID(),envelopeText,envelopeHash:digest(envelopeText)});
   }
   return {f,historical};
  };
  const cancelled=await history(['authorized','cancelled']);await cancelled.historical.configure({restore_isolated:true});
  await cancelled.historical.replay();await cancelled.historical.configure();await h.asUser(cancelled.f.owner);
  assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[cancelled.f.candidate.id])).rows[0].n,1);
  for(const phases of [['authorized'],['authorized','erasing','active_data_erased']]){
   const present=await history(phases);await present.historical.configure({restore_isolated:true});
   try{await assert.rejects(present.historical.replay(),conflict);}finally{await present.historical.configure();}
   await h.asAdmin();assert.equal((await db.query('select count(*)::int n from public.candidates where id=$1',[present.f.candidate.id])).rows[0].n,1);
   const absent=await history(phases,{absent:true});await absent.historical.configure({restore_isolated:true});
   try{const result=await absent.historical.replay();assert.equal(result.replayed,1);assert.equal(result.results[0].expired_noop,true);assert.equal(result.results[0].scope_absent,true);}finally{await absent.historical.configure();}
   await h.asUser(absent.f.owner);if(phases.at(-1)!=='authorized')await assert.rejects(h.insert('candidates',{id:absent.f.candidate.id,company_id:absent.f.companyId,first_name:'Expired','last_name':'Old UUID'}),conflict);
  }
 });

});
