import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { guardBoot, denied, hash } from './helpers/exercise-ai-grant-guard-fixture.mjs';
import { users } from './helpers/competency-active-fixture.mjs';
const migration='20261106150000_exercise_ai_recruiter_api.sql';
const sql=()=>readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8');
const names=['public.read_exercise_ai_proposal(uuid,uuid,uuid)','public.approve_exercise_ai_proposal(uuid,uuid,uuid,timestamptz)'];

test('C6 recruiter API: exact historical revision, tenant/role/context isolation, approval status and candidate barrier',async t=>{
 const e=await guardBoot(t),{db,h}=e;await e.install();
 const signature=(await db.query('select private.erasure_schema_signature() s')).rows[0].s;
 await db.exec('alter default privileges for role postgres grant execute on functions to anon,competency_test_gateway');
 try{await db.exec(await sql());}finally{await db.exec('alter default privileges for role postgres revoke execute on functions from anon,competency_test_gateway');}
 assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
 for(const name of names){
  const row=(await db.query('select pg_get_userbyid(proowner) owner,proacl::text acl,prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[name])).rows[0];
  assert.deepEqual(row,{owner:'postgres',acl:'{postgres=X/postgres,authenticated=X/postgres}',prosecdef:true,proconfig:['search_path=""']});
 }
 const f=await e.seed();await e.record(f);
 const read=(company=f.companyId,recruitment=f.recruitment.id,definition=f.definitionId)=>e.call('public.read_exercise_ai_proposal',[company,recruitment,definition]);
 const approve=(stamp=f.position.updated_at,company=f.companyId,recruitment=f.recruitment.id,definition=f.definitionId)=>e.call('public.approve_exercise_ai_proposal',[company,recruitment,definition,stamp]);
 const stored=(await db.query('select to_jsonb(e) value from public.exercise_definition_entries e where id=$1',[f.definitionId])).rows[0].value;
 const review=await read();assert.deepEqual(review.definitionEntry,stored);
 assert.equal(review.proposal.approvalMode,null);assert.equal(review.proposal.approvedAt,null);
 assert.equal(review.proposal.createdBy,f.owner);assert.equal(review.proposal.provenance.position_id,f.position.id);
 await assert.rejects(e.issue(f),denied('PT404'));
 for(const [company,recruitment,definition] of [[randomUUID(),f.recruitment.id,f.definitionId],[f.companyId,randomUUID(),f.definitionId],[f.companyId,f.recruitment.id,randomUUID()]]){
  await assert.rejects(read(company,recruitment,definition),denied('PT404'));
  await assert.rejects(approve(f.position.updated_at,company,recruitment,definition),denied('PT404'));
 }
 for(const stamp of [null,'1999-01-01T00:00:00Z'])await assert.rejects(approve(stamp),denied('PT409'));
 // Correct company but another recruitment's definition must not cross context.
 const other=await e.seed({owner:users.otherOwner});await e.record(other);
 await h.asUser(f.owner);await assert.rejects(read(other.companyId,other.recruitment.id,other.definitionId),denied('PT404'));
 await assert.rejects(read(f.companyId,f.recruitment.id,other.definitionId),denied('PT404'));
 await assert.rejects(approve(other.position.updated_at,other.companyId,other.recruitment.id,other.definitionId),denied('PT404'));
 for(const [actor,role] of [[users.viewer,'viewer'],[users.recruiter,'recruiter']])await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3) on conflict(company_id,user_id) do update set role=excluded.role',[f.companyId,actor,role]);
 await h.asUser(users.viewer);await assert.rejects(read(),denied('PT404'));await assert.rejects(approve(),denied('PT404'));
 await h.asUser(users.outsider);await assert.rejects(read(),denied('PT404'));await assert.rejects(approve(),denied('PT404'));
 await h.asUser(null);await assert.rejects(read(),denied('PT404'));await assert.rejects(approve(),denied('PT404'));
 await h.asUser(null,'anon');await assert.rejects(read(),denied('42501'));await assert.rejects(approve(),denied('42501'));
 await e.asGateway();await assert.rejects(read(),denied('42501'));await assert.rejects(approve(),denied('42501'));
 await h.asUser(f.owner);
 await db.query("update public.recruitments set status='closed' where id=$1",[f.recruitment.id]);
 assert.deepEqual((await read()).definitionEntry,stored);await assert.rejects(approve(),denied('55000'));
 await db.query("update public.recruitments set status='open' where id=$1",[f.recruitment.id]);
 await db.query("update public.positions set status='archived' where id=$1",[f.position.id]);
 assert.deepEqual((await read()).definitionEntry,stored);await assert.rejects(approve(),denied('55000'));
 await db.query("update public.positions set status='draft',title='New current profile' where id=$1",[f.position.id]);
 // The recruiter approves the stored snapshot, even after current profile edits.
 assert.deepEqual((await read()).definitionEntry,stored);
 await h.asUser(users.recruiter);const id=await approve();assert.equal(await approve(),id);
 const approved=await read();assert.equal(approved.proposal.id,id);assert.equal(approved.proposal.approvedBy,users.recruiter);assert.equal(approved.proposal.approvalMode,'manual');
 await h.asUser(f.owner);await db.query("update public.positions set title='Another current profile' where id=$1",[f.position.id]);
 assert.equal(await approve(),id);assert.deepEqual((await read()).proposal,approved.proposal);
 const g=await e.issue(f),session=await e.exchange(g);
 assert.equal((await e.call('private.start_candidate_competency_test',[hash(session.session),randomUUID()])).state,'in_progress');
 // Auto approval is reported exactly, and an idempotent manual call does not rewrite it.
 const auto=await e.seed();await db.query('select exercise_ai.set_auto_release($1,true)',[auto.recruitment.id]);await e.record(auto);
 const autoReview=await read(auto.companyId,auto.recruitment.id,auto.definitionId);assert.equal(autoReview.proposal.approvalMode,'auto');
 assert.equal(await approve(auto.position.updated_at,auto.companyId,auto.recruitment.id,auto.definitionId),autoReview.proposal.id);
 assert.deepEqual((await read(auto.companyId,auto.recruitment.id,auto.definitionId)).proposal,autoReview.proposal);
 // Manual definitions are unaffected; these RPCs address AI proposals only.
 const manual=await e.seed();await assert.rejects(read(manual.companyId,manual.recruitment.id,manual.definitionId),denied('PT404'));assert.ok((await e.issue(manual)).token);
 const pending=await e.seed();await db.query('select exercise_ai.set_auto_release($1,false)',[pending.recruitment.id]);await e.record(pending);await h.asAdmin();
 await db.exec(await readFile(new URL('../supabase/rollbacks/20261106150000_exercise_ai_recruiter_api_down.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s,signature);
 await h.asUser(f.owner);await assert.rejects(read(),denied('42501'));await assert.rejects(approve(),denied('42501'));
 await assert.rejects(e.issue(pending),denied('PT404'));
 assert.ok((await db.query('select id from exercise_ai.proposals where id=$1',[id])).rows[0]);
});

test('C6 recruiter API: an unreviewed approval dependency aborts migration atomically',async t=>{
 const e=await guardBoot(t),{db,h}=e;await e.install();await h.asAdmin();
 const original=(await db.query("select pg_get_functiondef('exercise_ai.approve_proposal(uuid)'::regprocedure) sql")).rows[0].sql;
 await db.exec(original.replace('return proposal.id;','return proposal.id; -- drift\n'));
 await assert.rejects(db.exec(await sql()),denied('55000'));await db.exec('rollback');
 for(const name of names)assert.equal((await db.query('select to_regprocedure($1)::text name',[name])).rows[0].name,null);
});
