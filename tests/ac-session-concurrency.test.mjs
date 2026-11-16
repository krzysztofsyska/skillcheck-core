import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionBoot, sheetFor, hrbpCaseTemplate, users } from './helpers/ac-session-fixture.mjs';

// SC-AC-SESSION (#276): independent native PostgreSQL connections. Synthetic data only.
const busy = error => ['PT409','55P03'].includes(error.code);
const code = value => error => error.code===value;
const auth = async (client,id) => {await client.exec('reset role;set role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
const count = async (db,sql,args=[]) => (await db.query(`select count(*)::int n from ${sql}`,args)).rows[0].n;
const agreed = rating => [{criterionIndex:0,outcome:'agreed',rating,justification:'Uzgodniono po omówieniu obu obserwacji.'}];

test('AC session native PostgreSQL: reconciliation is recorded once and answered once under concurrency', async t => {
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Independent native connections required');
 const e = await sessionBoot(t), {db,h} = e, rival = await e.connect(), second = await e.connect();
 const f = await e.finalist();
 const {sessionId,stages} = await e.plan(f);
 await h.asUser(f.owner);await e.addFinalist(sessionId,f);await e.setStatus(sessionId,'open');
 const stage = stages[0], pairId = await e.assign(sessionId,stage,f);
 await e.submit(pairId,sheetFor(stage.definition,{0:'above'}));
 await auth(rival,users.recruiter);await auth(second,users.recruiter);
 // A reconciliation racing the second sheet waits for nothing and records nothing.
 await rival.exec('begin');
 try {
  await e.submit(pairId,sheetFor(stage.definition,{0:'meets'}),rival);
  await assert.rejects(e.reconcile(pairId,agreed('above')),busy);
  await rival.exec('commit');
 } finally { await rival.exec('rollback'); }
 // Both assessors record at once: exactly one record exists, the loser is told so.
 await db.exec('begin');
 try {
  await e.reconcile(pairId,agreed('above'));
  await assert.rejects(e.reconcile(pairId,agreed('meets'),rival),busy);
  await db.exec('commit');
 } finally { await db.exec('rollback'); }
 await assert.rejects(e.reconcile(pairId,agreed('meets'),rival),code('PT409'));
 // The same assessor answering from two sessions: one answer, never overwritten.
 await rival.exec('begin');
 try {
  await e.confirm(pairId,'confirmed',null,rival);
  await assert.rejects(e.confirm(pairId,'disputed','Druga karta przeglądarki próbuje zmienić odpowiedź.',second),busy);
  await rival.exec('commit');
 } finally { await rival.exec('rollback'); }
 await assert.rejects(e.confirm(pairId,'disputed','Druga karta przeglądarki próbuje zmienić odpowiedź.',second),code('PT409'));
 // Closing the session against a late sheet: whichever commits first wins, the other is refused.
 const late = stages[1], latePair = await (async () => {await h.asUser(f.owner);return e.assign(sessionId,late,f);})();
 await db.exec('begin');
 try {
  await e.setStatus(sessionId,'closed');
  await assert.rejects(e.submit(latePair,sheetFor(late.definition),rival),busy);
  await db.exec('commit');
 } finally { await db.exec('rollback'); }
 await assert.rejects(e.submit(latePair,sheetFor(late.definition),rival),code('42501'));
 await h.asAdmin();
 assert.equal(await count(db,'private.ac_paired_sheets where id=$1 and first_sheet is null and second_sheet is null',[latePair]),1);
 const rows = (await db.query('select recorded_by,confirmation,confirmed_by,items->0->>\'rating\' rating from private.ac_reconciliations where pair_id=$1',[pairId])).rows;
 assert.deepEqual(rows,[{recorded_by:f.owner,confirmation:'confirmed',confirmed_by:users.recruiter,rating:'above'}]);
});

test('AC session native PostgreSQL: the tenth slot, the shortlist rule and the plan freeze serialize', async t => {
 assert.equal(process.env.SC_WER_PGLITE_PATH,undefined,'Independent native connections required');
 const e = await sessionBoot(t), {db,h} = e, rival = await e.connect();
 const people = [];
 for (let i = 0; i < 11; i++) people.push(await e.finalist());
 const owner = people[0].owner;
 const {sessionId} = await e.plan(people[0],{stages:hrbpCaseTemplate.stages.slice(0,3),competencies:hrbpCaseTemplate.plannedCompetencies.slice(0,3)});
 await h.asUser(owner);
 for (const person of people.slice(0,8)) await e.addFinalist(sessionId,person);
 await auth(rival,owner);
 const add = (person,client) => e.call('public.ac_session_add_finalist',[sessionId,person.application.id],client);
 // Rule R1 against removal from the shortlist, in both orders.
 await db.exec('begin');
 try {
  await h.remove(people[8].shortlistId);
  await assert.rejects(add(people[8],rival),busy);
  await db.exec('rollback');
 } finally { await db.exec('rollback'); }
 await rival.exec('begin');
 try {
  await add(people[8],rival);
  await assert.rejects(h.remove(people[8].shortlistId),busy);
  await rival.exec('commit');
 } finally { await rival.exec('rollback'); }
 // A revision is adopted as a stage or gets a plain R13 pair, never both, in either order.
 const pairOn = (revision,client) => e.call('public.ac_assign_pair',[people[0].application.id,revision,owner,users.recruiter],client);
 const stageOn = (revision,client) => e.call('public.ac_session_add_stage',[sessionId,'case_study','Etap w wyścigu',revision,null],client);
 const racedFirst = await e.saveDefinition(people[0],hrbpCaseTemplate.stages[0].definition);
 const racedSecond = await e.saveDefinition(people[0],hrbpCaseTemplate.stages[0].definition);
 await db.exec('begin');
 try {
  await stageOn(racedFirst,db);
  await assert.rejects(pairOn(racedFirst,rival),busy);
  await db.exec('rollback');
 } finally { await db.exec('rollback'); }
 await rival.exec('begin');
 try {
  await pairOn(racedSecond,rival);
  await assert.rejects(stageOn(racedSecond,db),busy);
  await rival.exec('commit');
 } finally { await rival.exec('rollback'); }
 await assert.rejects(stageOn(racedSecond,db),error => error.code==='PT409' && /already has assessments/.test(error.message));
 // Two owners' tabs race for the last slot: one finalist is added, the other is refused.
 await db.exec('begin');
 try {
  await add(people[9],db);
  await assert.rejects(add(people[10],rival),busy);
  await db.exec('commit');
 } finally { await db.exec('rollback'); }
 await assert.rejects(add(people[10],rival),error => error.code==='PT422');
 await h.asAdmin();assert.equal(await count(db,'private.ac_session_finalists where session_id=$1',[sessionId]),10);
 assert.deepEqual((await db.query('select array_agg(slot order by slot) slots from private.ac_session_finalists where session_id=$1',[sessionId])).rows[0].slots,[1,2,3,4,5,6,7,8,9,10]);
 // Opening against a late stage: the plan that is checked is the plan that is committed.
 await h.asUser(owner);
 const extra = hrbpCaseTemplate.stages[3], revision = await e.saveDefinition(people[0],extra.definition);
 const addStage = client => e.call('public.ac_session_add_stage',[sessionId,extra.type,extra.title,revision,extra.counterpartBrief],client);
 await db.exec('begin');
 try {
  await e.setStatus(sessionId,'open');
  await assert.rejects(addStage(rival),busy);
  await db.exec('commit');
 } finally { await db.exec('rollback'); }
 await assert.rejects(addStage(rival),code('PT409'));
 await h.asAdmin();assert.equal(await count(db,'private.ac_session_stages where session_id=$1',[sessionId]),3);
});
