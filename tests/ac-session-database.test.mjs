import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { sessionBoot, sessionMigration, sessionRollback, sessionSignature, sessionTables, candidateTables, sessionRpcs,
 sheetFor, work, hrbpCaseTemplate, users } from './helpers/ac-session-fixture.mjs';
import { lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import { parseAssessmentCenterSession, buildAssessmentCenterSessionReport, AC_NO_DATA } from '../lib/assessment-center-session.ts';

// SC-AC-SESSION (#276) on the full current migration chain, native PostgreSQL. Synthetic data only.
const denied = (...codes) => error => codes.includes(error.code);
const forbidden = denied('42501','PT404');
const count = async (db,sql,args=[]) => (await db.query(`select count(*)::int n from ${sql}`,args)).rows[0].n;
const agreed = (criterionIndex,rating) => ({criterionIndex,outcome:'agreed',rating,justification:'Po rozmowie asesorzy przyjęli tę ocenę na podstawie obu obserwacji.'});
const discrepancy = criterionIndex => ({criterionIndex,outcome:'discrepancy',note:'Asesorzy pozostali przy odmiennych ocenach tego kryterium.'});

test('AC session R16: plan → finalists → two assessors → reconciliation → second attempt → report → erasure', async t => {
 const e = await sessionBoot(t), {db,h,x,call} = e;
 const third = users.viewer, watcher = users.outsider;

 await t.test('reviewed R16 signature, exact allowlist, four readers, R15 delegation, deny-by-default tables and definer RPCs', async () => {
  await h.asAdmin();
  const baseline = (await db.query('select *,private.erasure_schema_signature() actual from private.erasure_inventory_baseline_r16')).rows[0];
  assert.equal(baseline.actual,sessionSignature);assert.equal(baseline.schema_signature,sessionSignature);
  const actual = (await db.query("select n.nspname||'.'||c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')")).rows.map(r=>r.name);
  assert.deepEqual(actual.sort(),[...baseline.known_tables].sort());
  for (const table of sessionTables) assert.ok(baseline.known_tables.includes(table),table);
  for (const name of ['preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule']) {
   assert.equal(await count(db,"pg_proc where proname=$1 and prosrc like '%erasure_inventory_baseline_r16%'",[name]),1,name);
  }
  assert.equal(await count(db,"pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-5])([^0-9]|$)'"),0);
  for (const name of ['erasure_inventory_rows_r15','erasure_row_candidates_r15','erasure_inventory_rows_r12','erasure_row_candidates_r12']) {
   assert.equal(await count(db,'pg_proc where proname=$1',[name]),1,name);
  }
  for (const table of sessionTables) {
   assert.deepEqual((await db.query("select relrowsecurity rls,has_table_privilege('authenticated',oid,'select,insert,update,delete') staff,has_table_privilege('anon',oid,'select,insert,update,delete') anon from pg_class where oid=$1::regclass",[table])).rows[0],
    {rls:true,staff:false,anon:false},table);
  }
  for (const table of candidateTables) {
   assert.deepEqual((await db.query("select has_table_privilege('erasure_purge_owner',$1::regclass,'select') s,has_table_privilege('erasure_purge_owner',$1::regclass,'delete') d,has_table_privilege('erasure_purge_owner',$1::regclass,'insert,update') w",[table])).rows[0],{s:true,d:true,w:false},table);
   assert.equal(await count(db,"pg_trigger where tgrelid=$1::regclass and tgname in ('ac_session_row_guard','zz_retention_observed')",[table]),2,table);
  }
  for (const name of sessionRpcs) {
   assert.deepEqual((await db.query("select prosecdef definer,proconfig config,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') staff from pg_proc where proname=$1",[name])).rows[0],
    {definer:true,config:['search_path=""'],anon:false,staff:true},name);
  }
  for (const name of ['ac_session_lock','ac_session_lock_finalist','ac_session_uncovered','ac_competency_key']) {
   assert.deepEqual((await db.query("select has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') staff from pg_proc where proname=$1",[name])).rows[0],{anon:false,staff:false},name);
  }
  execFileSync(process.execPath,['scripts/sc-ac-session-compose.mjs','--check']);
 });

 const f1 = await e.finalist(), f2 = await e.finalist(), outsiderCandidate = await e.seed();
 const other = await e.finalist(users.otherOwner);
 await h.asUser(f1.owner);
 await h.insert('company_members',{company_id:f1.companyId,user_id:third,role:'recruiter'});
 await h.insert('company_members',{company_id:f1.companyId,user_id:watcher,role:'viewer'});
 let sessionId, stages;

 await t.test('only the owner plans; invalid plans, foreign or non-AC revisions and a second session are refused', async () => {
  for (const user of [users.recruiter,third,watcher,other.owner]) {
   await h.asUser(user);
   await assert.rejects(call('public.ac_session_create',[f1.recruitment.id,'Sesja',['Analiza']]),forbidden);
  }
  await h.asUser(f1.owner);
  for (const [title,competencies] of [['',['Analiza']],['  ',['Analiza']],['x'.repeat(201),['Analiza']],['Sesja',[]],['Sesja',['Analiza',' Analiza ']],
   ['Sesja',['   ']],['Sesja',Array.from({length:25},(_,i)=>`Kompetencja ${i}`)],['Sesja',['x'.repeat(201)]]]) {
   await assert.rejects(call('public.ac_session_create',[f1.recruitment.id,title,competencies]),denied('22023'),JSON.stringify([title.slice(0,10),competencies.length]));
  }
  ({sessionId,stages} = await e.plan(f1,{stages:hrbpCaseTemplate.stages.slice(0,3)}));
  assert.equal(await e.find(f1),sessionId);
  await assert.rejects(call('public.ac_session_create',[f1.recruitment.id,'Druga sesja',['Analiza']]),denied('PT409'));
  const draft = await e.read(sessionId);
  assert.equal(draft.session.status,'draft');assert.deepEqual(draft.stages.map(s=>s.ordinal),[1,2,3]);
  assert.deepEqual(draft.session.uncoveredCompetencies,['Komunikacja z biznesem']);
  assert.equal(draft.session.finalistLimit,10);assert.deepEqual(draft.session.recommendedFinalists,[5,6]);
  // Stage validation: type, brief only for a human simulation, exact AC revision of THIS recruitment.
  const simulation = hrbpCaseTemplate.stages[3];
  const revision = await e.saveDefinition(f1,simulation.definition);
  for (const args of [['unknown',simulation.title,revision,null],['human_simulation',simulation.title,revision,null],['human_simulation',simulation.title,revision,'krótko'],
   ['case_study',simulation.title,revision,simulation.counterpartBrief],['case_study','',revision,null]]) {
   await assert.rejects(call('public.ac_session_add_stage',[sessionId,...args]),denied('22023'),args[0]);
  }
  await assert.rejects(call('public.ac_session_add_stage',[sessionId,'case_study','Test kompetencyjny',f1.competencyDefinitionId,null]),denied('42501'));
  await assert.rejects(call('public.ac_session_add_stage',[sessionId,'case_study','Obca rewizja',other.definitionId,null]),denied('42501'));
  await assert.rejects(call('public.ac_session_add_stage',[sessionId,'case_study','Powtórzona rewizja',stages[0].definitionId,null]),denied('PT409'));
  await h.asUser(users.recruiter);
  await assert.rejects(call('public.ac_session_add_stage',[sessionId,'human_simulation',simulation.title,revision,simulation.counterpartBrief]),forbidden);
  await assert.rejects(call('public.ac_session_remove_last_stage',[sessionId]),forbidden);
  // A mistaken stage in a draft is taken back (last one only); nothing is edited in place.
  await h.asUser(f1.owner);
  const mistaken = await call('public.ac_session_add_stage',[sessionId,'human_simulation','Etap dodany przez pomyłkę',revision,simulation.counterpartBrief]);
  assert.deepEqual((await e.read(sessionId)).stages.map(s=>s.ordinal),[1,2,3,4]);
  await call('public.ac_session_remove_last_stage',[sessionId]);
  const kept = (await e.read(sessionId)).stages;
  assert.deepEqual(kept.map(s=>s.id),stages.map(s=>s.id));assert.ok(!kept.some(s=>s.id===mistaken));
 });

 await t.test('finalists come only from the active shortlist of this recruitment (rule R1), also below the RPC', async () => {
  await h.asUser(f1.owner);
  await assert.rejects(e.addFinalist(sessionId,outsiderCandidate),denied('42501'));
  await assert.rejects(e.addFinalist(sessionId,other),forbidden);
  await h.asUser(users.recruiter);await assert.rejects(e.addFinalist(sessionId,f1),forbidden);
  await h.asUser(f1.owner);
  await e.addFinalist(sessionId,f1);
  await assert.rejects(e.addFinalist(sessionId,f1),denied('PT409'));
  // A removed shortlist entry is no longer a source of finalists.
  await h.remove(f2.shortlistId);await assert.rejects(e.addFinalist(sessionId,f2),denied('42501'));
  f2.shortlistId = await h.add(f2);await e.addFinalist(sessionId,f2);
  await h.asAdmin();await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f1.owner]);
  await assert.rejects(db.query('insert into private.ac_session_finalists(session_id,company_id,recruitment_id,application_id,slot,added_by) values($1,$2,$3,$4,9,$5)',
   [sessionId,f1.companyId,f1.recruitment.id,outsiderCandidate.application.id,f1.owner]),denied('42501'));
  assert.equal(await count(db,'private.ac_session_finalists where session_id=$1',[sessionId]),2);
 });

 await t.test('a competency without a covering stage blocks opening; the complete plan opens and then freezes', async () => {
  await h.asUser(f1.owner);
  await assert.rejects(e.setStatus(sessionId,'open'),error => error.code==='PT422' && /Coverage plan incomplete/.test(error.message));
  // The rule is in the table: not even a direct privileged UPDATE opens an uncovered plan.
  await h.asAdmin();
  await assert.rejects(db.query("update private.ac_sessions set status='open',opened_by=$2,opened_at=now() where id=$1",[sessionId,f1.owner]),denied('PT422'));
  await h.asUser(f1.owner);
  stages.push(await e.addStage(f1,sessionId,hrbpCaseTemplate.stages[3]));
  assert.deepEqual((await e.read(sessionId)).session.uncoveredCompetencies,[]);
  await h.asUser(users.recruiter);await assert.rejects(e.setStatus(sessionId,'open'),forbidden);
  await h.asUser(f1.owner);await e.setStatus(sessionId,'open');
  await assert.rejects(e.setStatus(sessionId,'open'),denied('PT409'));
  await assert.rejects(e.addStage(f1,sessionId,hrbpCaseTemplate.stages[0]),denied('PT409'));
  await assert.rejects(call('public.ac_session_remove_last_stage',[sessionId]),denied('PT409'));
  await h.asAdmin();
  await assert.rejects(db.query("update private.ac_session_stages set title='Zmieniony' where session_id=$1",[sessionId]),denied('42501'));
  await assert.rejects(db.query('delete from private.ac_session_stages where session_id=$1',[sessionId]),denied('42501'));
  await assert.rejects(db.query("update private.ac_sessions set planned_competencies='{Inna}' where id=$1",[sessionId]),denied('42501'));
  await assert.rejects(db.query("update private.ac_sessions set status='draft',opened_by=null,opened_at=null where id=$1",[sessionId]),denied('42501'));
 });

 const pairs = {};
 await t.test('one pair per finalist and stage through the R13 engine; only the owner assigns, only for finalists and own stages', async () => {
  await h.asUser(users.recruiter);await assert.rejects(e.assign(sessionId,stages[0],f1),forbidden);
  await h.asUser(f1.owner);
  await assert.rejects(call('public.ac_session_assign_pair',[sessionId,stages[0].id,outsiderCandidate.application.id,f1.owner,users.recruiter]),denied('42501'));
  await assert.rejects(call('public.ac_session_assign_pair',[sessionId,f1.application.id,f1.application.id,f1.owner,users.recruiter]),denied('42501'));
  await assert.rejects(e.assign(sessionId,stages[0],f1,f1.owner,f1.owner),denied('42501'));
  await assert.rejects(e.assign(sessionId,stages[0],f1,f1.owner,watcher),denied('42501'));
  for (const stage of stages) pairs[stage.id] = await e.assign(sessionId,stage,f1);
  await assert.rejects(e.assign(sessionId,stages[0],f1),denied('PT409'));
  assert.equal(await call('public.ac_find_pair',[f1.application.id,stages[0].definitionId]),pairs[stages[0].id]);
  assert.equal(new Set(Object.values(pairs)).size,stages.length);
 });

 await t.test('an assessor never sees the other sheet before both are submitted; no reconciliation or feedback before that', async () => {
  const stage = stages[0], pairId = pairs[stage.id];
  await h.asUser(f1.owner);await e.submit(pairId,sheetFor(stage.definition,{0:'above'}));
  for (const [user,ownSubmitted] of [[f1.owner,true],[users.recruiter,false]]) {
   await h.asUser(user);
   const seen = (await e.read(sessionId)).finalists.find(f=>f.applicationId===f1.application.id).stages[0];
   assert.deepEqual(seen.pair,{state:'pending',pairId,ownSubmitted});
   assert.doesNotMatch(JSON.stringify(seen),/Syntetyczna obserwacja|above/);
   await assert.rejects(e.reconcile(pairId,[agreed(0,'above')]),denied('PT409'));
  }
  await h.asUser(f1.owner);
  await e.record(sessionId,f1,stage,'first_attempt',{work:work('pierwsza próba, etap 1')});
  await assert.rejects(e.record(sessionId,f1,stage,'feedback',{feedback:'Informacja zwrotna przed oddaniem drugiego arkusza.'}),denied('PT409'));
  await h.asUser(third);
  assert.deepEqual((await e.read(sessionId)).finalists[0].stages[0].pair,{state:'restricted'});
  await assert.rejects(e.submit(pairId,sheetFor(stage.definition)),denied('42501'));
  await assert.rejects(db.query('select * from private.ac_reconciliations'),denied('42501'));
  await assert.rejects(db.query('select * from private.ac_session_entries'),denied('42501'));
  await h.asUser(users.recruiter);await e.submit(pairId,sheetFor(stage.definition,{0:'meets'}));
 });

 await t.test('reconciliation: agreed rating is one of the two given, a difference may stay explicit, the record is named and immutable', async () => {
  const stage = stages[0], pairId = pairs[stage.id];
  await h.asUser(f1.owner);
  for (const items of [[],{},[agreed(0,'below')],[agreed(0,'insufficient_data')],[{...agreed(0,'above'),justification:'krótko'}],
   [{...agreed(0,'above'),extra:true}],[{...agreed(0,'above'),criterionIndex:1}],[agreed(0,'above'),agreed(1,'above')],
   [{...discrepancy(0),note:'krótko'}],[{...discrepancy(0),rating:'meets'}],[{criterionIndex:0,outcome:'average'}]]) {
   await assert.rejects(e.reconcile(pairId,items),denied('22023'),JSON.stringify(items).slice(0,80));
  }
  for (const user of [third,watcher,other.owner]) {await h.asUser(user);await assert.rejects(e.reconcile(pairId,[agreed(0,'above')]),forbidden);}
  await h.asUser(users.recruiter);
  await e.reconcile(pairId,[agreed(0,'meets')]);
  await assert.rejects(e.reconcile(pairId,[agreed(0,'above')]),denied('PT409'));
  // The author of the record cannot confirm it; the other assessor answers exactly once.
  await assert.rejects(e.confirm(pairId),denied('42501'));
  await h.asUser(third);await assert.rejects(e.confirm(pairId),denied('42501'));
  await h.asUser(f1.owner);
  await assert.rejects(e.confirm(pairId,'maybe'),denied('22023'));
  await assert.rejects(e.confirm(pairId,'disputed',null),denied('22023'));
  await assert.rejects(e.confirm(pairId,'confirmed','niepotrzebna notatka do potwierdzenia'),denied('22023'));
  await e.confirm(pairId);
  await assert.rejects(e.confirm(pairId),denied('PT409'));
  await h.asAdmin();
  const saved = (await db.query('select * from private.ac_reconciliations where pair_id=$1',[pairId])).rows[0];
  assert.equal(saved.recorded_by,users.recruiter);assert.equal(saved.confirmed_by,f1.owner);assert.equal(saved.confirmation,'confirmed');
  assert.deepEqual(saved.items,[{criterionIndex:0,outcome:'agreed',rating:'meets',justification:agreed(0,'meets').justification,firstRating:'above',secondRating:'meets'}]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f1.owner]);
  await assert.rejects(db.query("update private.ac_reconciliations set items='[]' where pair_id=$1",[pairId]),denied('42501'));
  await assert.rejects(db.query("update private.ac_reconciliations set confirmation='disputed',dispute_note='zmiana po fakcie' where pair_id=$1",[pairId]),denied('42501'));
  await assert.rejects(db.query('delete from private.ac_reconciliations where pair_id=$1',[pairId]),denied('42501'));
  // Stage 3 (two criteria): one agreed, one explicit discrepancy with BOTH ratings kept; then disputed.
  const two = stages[2], twoPair = pairs[two.id];
  await h.asUser(f1.owner);await e.submit(twoPair,sheetFor(two.definition,{0:'below',1:'meets'}));
  await h.asUser(users.recruiter);await e.submit(twoPair,sheetFor(two.definition,{0:'above',1:'meets'}));
  await assert.rejects(e.reconcile(twoPair,[agreed(0,'meets'),agreed(1,'meets')]),denied('22023'),'a mean of below and above is not an agreement');
  await assert.rejects(e.reconcile(twoPair,[discrepancy(0),discrepancy(1)]),denied('22023'),'equal ratings are not a discrepancy');
  await h.asUser(f1.owner);await e.reconcile(twoPair,[discrepancy(0),agreed(1,'meets')]);
  await h.asAdmin();
  assert.deepEqual((await db.query('select items->0 item from private.ac_reconciliations where pair_id=$1',[twoPair])).rows[0].item,
   {criterionIndex:0,outcome:'discrepancy',note:discrepancy(0).note,firstRating:'below',secondRating:'above'});
 });

 await t.test('second attempt: first work, feedback, revised work and a separate proof of change are append-only and ordered', async () => {
  const stage = stages[0];
  await h.asUser(f1.owner);
  for (const [kind,body] of [['first_attempt',{work:'za krótko'}],['first_attempt',{work:work('x'),extra:'pole'}],['first_attempt',{}],['unknown',{work:work('x')}],
   ['expert_consultation',{note:'krótko'}]]) {
   await assert.rejects(e.record(sessionId,f1,kind==='expert_consultation'?null:stages[1],kind,body),denied('22023'),kind);
  }
  await assert.rejects(e.record(sessionId,f1,stage,'first_attempt',{work:work('druga wersja pierwszej próby')}),denied('PT409'));
  await assert.rejects(e.record(sessionId,f1,stage,'revised_attempt',{work:work('poprawka bez informacji zwrotnej')}),denied('PT409'));
  await assert.rejects(e.record(sessionId,f1,stage,'change_proof',{changes:'Opis zmian bez poprawionej pracy.',evidence:'Dowód zmiany.',assessment:'change_confirmed'}),denied('PT409'));
  await h.asUser(third);
  await assert.rejects(e.record(sessionId,f1,stage,'feedback',{feedback:'Informacja zwrotna od osoby spoza pary asesorów.'}),denied('42501'));
  await h.asUser(users.recruiter);
  await e.record(sessionId,f1,stage,'feedback',{feedback:'  Diagnoza myli objawy z przyczynami; sprawdź dane o absencji.  '});
  await h.asUser(third);
  await e.record(sessionId,f1,stage,'revised_attempt',{work:work('poprawiona praca, etap 1')});
  await assert.rejects(e.record(sessionId,f1,stage,'change_proof',{changes:'Kandydat oddzielił przyczyny od objawów.',evidence:'Nowa tabela przyczyn.',assessment:'change_confirmed'}),denied('42501'));
  await h.asUser(f1.owner);
  for (const body of [{changes:'Kandydat oddzielił przyczyny od objawów.',evidence:'Nowa tabela przyczyn.',assessment:'hire'},
   {changes:'Kandydat oddzielił przyczyny od objawów.',evidence:'',assessment:'change_confirmed'},
   {changes:'Kandydat oddzielił przyczyny od objawów.',evidence:'Jest dowód.',assessment:'insufficient_data'}]) {
   await assert.rejects(e.record(sessionId,f1,stage,'change_proof',body),denied('22023'));
  }
  await e.record(sessionId,f1,stage,'change_proof',{changes:'Kandydat oddzielił przyczyny od objawów.',evidence:'Nowa tabela przyczyn z danymi o absencji.',assessment:'change_confirmed'});
  await e.record(sessionId,f1,null,'expert_consultation',{note:'Konsultacja eksperta: omówiono rozbieżność w etapie 3.'});
  await e.record(sessionId,f1,null,'expert_consultation',{note:'Druga notatka eksperta po rozmowie z asesorami.'});
  await assert.rejects(e.record(sessionId,f1,stage,'expert_consultation',{note:'Notatka eksperta przypisana do etapu.'}),denied('22023'));
  await assert.rejects(e.record(sessionId,outsiderCandidate,stage,'first_attempt',{work:work('osoba spoza sesji')}),denied('42501'));
  await h.asAdmin();
  const rows = (await db.query('select kind,body,author_id from private.ac_session_entries where session_id=$1 and application_id=$2 and session_stage_id=$3 order by created_at',[sessionId,f1.application.id,stage.id])).rows;
  assert.deepEqual(rows.map(r=>r.kind),['first_attempt','feedback','revised_attempt','change_proof']);
  // The first attempt is still exactly what was recorded before the revision.
  assert.deepEqual(rows[0].body,{work:work('pierwsza próba, etap 1')});assert.equal(rows[0].author_id,f1.owner);
  assert.equal(rows[1].body.feedback,'Diagnoza myli objawy z przyczynami; sprawdź dane o absencji.');
  assert.notEqual(rows[2].body.work,rows[0].body.work);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f1.owner]);
  await assert.rejects(db.query("update private.ac_session_entries set body='{\"work\":\"nadpisane\"}' where session_id=$1 and kind='first_attempt'",[sessionId]),denied('42501'));
  await assert.rejects(db.query('delete from private.ac_session_entries where session_id=$1',[sessionId]),denied('42501'));
  await assert.rejects(db.query('delete from private.ac_session_finalists where session_id=$1',[sessionId]),denied('42501'));
 });

 await t.test('report: both assessors per competency, agreed versus discrepant, first versus revised, "brak danych", no ranking or decision', async () => {
  await h.asUser(f1.owner);
  const raw = await e.read(sessionId);
  const report = buildAssessmentCenterSessionReport(parseAssessmentCenterSession(raw));
  assert.deepEqual(report.uncovered,[]);assert.equal(report.finalists.length,2);assert.equal(report.finalistAdvice.level,'below');
  const [one,two] = report.finalists;
  assert.equal(one.applicationId,f1.application.id);assert.equal(two.applicationId,f2.application.id);
  const diagnosis = one.competencies.find(c=>c.competency==='Diagnoza przyczyn');
  assert.equal(diagnosis.hasEvidence,true);
  assert.deepEqual(diagnosis.evidence[0].assessors.map(a=>[a.authorId,a.rating]),[[f1.owner,'above'],[users.recruiter,'meets']]);
  assert.ok(diagnosis.evidence[0].assessors.every(a=>a.evidence && a.context));
  assert.deepEqual(diagnosis.evidence[0].agreement,{status:'agreed',rating:'meets',justification:agreed(0,'meets').justification,recordedBy:users.recruiter});
  const change = one.competencies.find(c=>c.competency==='Planowanie zmiany');
  assert.deepEqual(change.evidence.map(row=>row.agreement.status),['discrepancy','awaiting_second_sheet']);
  assert.equal(change.evidence[0].agreement.awaitingConfirmation,true);
  assert.deepEqual(change.evidence[0].assessors.map(a=>a.rating),['below','above']);
  const finance = one.competencies.find(c=>c.competency==='Myślenie finansowe');
  assert.deepEqual(finance.evidence.map(row=>row.agreement.status),['awaiting_second_sheet','awaiting_confirmation']);
  assert.equal(one.attempts[0].firstAttempt.work,work('pierwsza próba, etap 1'));
  assert.equal(one.attempts[0].revisedAttempt.work,work('poprawiona praca, etap 1'));
  assert.equal(one.attempts[0].changeProof.assessment,'change_confirmed');assert.equal(one.attempts[0].feedback.authorId,users.recruiter);
  assert.deepEqual(one.attempts[1],{stageId:stages[1].id,stageTitle:stages[1].title,firstAttempt:null,feedback:null,revisedAttempt:null,changeProof:null});
  assert.equal(one.expertNotes.length,2);
  // The second finalist has no evidence at all: explicit gaps, never a zero or a default rating.
  assert.ok(two.competencies.every(c=>!c.hasEvidence && c.evidence.every(row=>row.assessors.length===0 && row.agreement.status==='not_assessed')));
  assert.ok(two.attempts.every(a=>a.firstAttempt===null && a.changeProof===null));assert.deepEqual(two.expertNotes,[]);
  assert.equal(AC_NO_DATA,'brak danych');
  assert.doesNotMatch(JSON.stringify([raw,report]),/"(score|rank|ranking|position|recommendation|hiringDecision|decision|total|average)"/i);
  // Disputing a record never leaves an "agreed" label behind: both ratings stay visible.
  await h.asUser(users.recruiter);await e.confirm(pairs[stages[2].id],'disputed','Nie zgadzam się z zapisem rozbieżności w kryterium 1.');
  const disputed = buildAssessmentCenterSessionReport(parseAssessmentCenterSession(await e.read(sessionId))).finalists[0].competencies.find(c=>c.competency==='Planowanie zmiany').evidence[0];
  assert.equal(disputed.agreement.status,'disputed');assert.equal(disputed.agreement.disputedBy,users.recruiter);
  assert.deepEqual(disputed.assessors.map(a=>a.rating),['below','above']);
  // A recruiter outside the pair sees the plan and the work, never the sheets or their reconciliation.
  await h.asUser(third);
  const limited = await e.read(sessionId);
  assert.ok(limited.finalists[0].stages.every(s=>s.pair.state==='restricted'));
  assert.doesNotMatch(JSON.stringify(limited),/Syntetyczna obserwacja|justification|firstRating/);
  assert.equal(limited.finalists[0].stages[0].entries.length,4);
 });

 await t.test('foreign company, viewer and unknown ids cannot find, read or write anything in the session', async () => {
  const stage = stages[1];
  for (const user of [other.owner,watcher]) {
   await h.asUser(user);
   assert.equal(await e.find(f1),null);
   await assert.rejects(e.read(sessionId),denied('42501'));
   await assert.rejects(e.addFinalist(sessionId,f2),forbidden);
   await assert.rejects(e.setStatus(sessionId,'closed'),forbidden);
   await assert.rejects(e.assign(sessionId,stage,f2),forbidden);
   await assert.rejects(e.record(sessionId,f2,stage,'first_attempt',{work:work('obca firma')}),forbidden);
   await assert.rejects(e.record(sessionId,f2,null,'expert_consultation',{note:'Notatka z obcej firmy lub od obserwatora.'}),forbidden);
   await assert.rejects(e.reconcile(pairs[stage.id],[agreed(0,'meets')]),forbidden);
   await assert.rejects(e.confirm(pairs[stages[0].id]),forbidden);
  }
  // The other owner cannot attach his own finalist or revision to this session either.
  await h.asUser(other.owner);
  await assert.rejects(e.addFinalist(sessionId,other),forbidden);
  await assert.rejects(call('public.ac_session_add_stage',[sessionId,'case_study','Obcy etap',other.definitionId,null]),forbidden);
  await h.asUser(f1.owner);
  await assert.rejects(e.read('00000000-0000-4000-8000-000000000000'),denied('42501'));
  assert.equal(await call('public.ac_session_find',['00000000-0000-4000-8000-000000000000']),null);
 });

 await t.test('writes advance the retention clock; a frozen finalist disappears from the read model and accepts no writes', async () => {
  await h.asAdmin();
  const generation = async () => Number((await db.query('select generation from private.retention_candidate_clocks where candidate_id=$1',[f2.candidate.id])).rows[0].generation);
  const before = await generation();
  await h.asUser(f1.owner);await e.record(sessionId,f2,stages[0],'first_attempt',{work:work('drugi finalista, etap 1')});
  await h.asAdmin();assert.ok(await generation()>before);
  await h.asUser(f1.owner);await x.policy(f2,0,lifecycleRules);f2.resolutionId = await x.resolve(f2);const state = await x.freeze(f2);
  assert.deepEqual((await e.read(sessionId)).finalists.map(f=>f.applicationId),[f1.application.id]);
  await assert.rejects(e.record(sessionId,f2,null,'expert_consultation',{note:'Notatka dla zamrożonego finalisty.'}),denied('PT409','42501'));
  await assert.rejects(e.assign(sessionId,stages[0],f2),denied('PT409','42501'));
  await x.cancel(f2,state.request_id,state.generation);
  assert.equal((await e.read(sessionId)).finalists.length,2);
 });

 await t.test('controlled erasure removes exactly the confirmed finalist: entries, reconciliations, finalist row and pairs; the plan stays', async () => {
  await h.asUser(f1.owner);
  const preview = await x.preview(f1);
  assert.equal(preview.counts['private.ac_session_finalists'],1);assert.equal(preview.counts['private.ac_reconciliations'],2);
  assert.equal(preview.counts['private.ac_session_entries'],6);assert.equal(preview.counts['private.ac_paired_sheets'],4);
  assert.ok(!preview.blockers.includes('schema_dependency_unknown'));
  await h.asAdmin();await db.exec('begin');
  try {
   await db.exec('create table private.ac_session_unknown_copy(candidate_id uuid)');await h.asUser(f1.owner);
   assert.ok((await x.preview(f1)).blockers.includes('schema_dependency_unknown'));
  } finally { await db.exec('rollback'); }
  await h.asUser(f1.owner);
  f1.resolutionId = await x.resolve(f1);await x.configure();const state = await x.freeze(f1);
  await x.transition(state.request_id,0,'authorized');await x.transition(state.request_id,1,'erasing');
  const receipt = await x.purge(state.request_id,2);
  await h.asAdmin();
  for (const table of [...candidateTables,'private.ac_paired_sheets']) {
   assert.equal(await count(db,`${table} where application_id=$1`,[f1.application.id]),0,table);
  }
  assert.equal(await count(db,'public.applications where id=$1',[f1.application.id]),0);
  assert.equal(await count(db,'private.ac_session_finalists where application_id=$1',[f2.application.id]),1);
  assert.equal(await count(db,'private.ac_session_entries where application_id=$1',[f2.application.id]),1);
  assert.equal(await count(db,'private.ac_sessions where id=$1',[sessionId]),1);
  assert.equal(await count(db,'private.ac_session_stages where session_id=$1',[sessionId]),4);
  assert.equal(await count(db,'public.candidates where id=$1',[other.candidate.id]),1);
  if (receipt?.counts) for (const table of candidateTables) assert.ok(table in receipt.counts,table);
  await h.asUser(f1.owner);
  assert.deepEqual((await e.read(sessionId)).finalists.map(f=>f.applicationId),[f2.application.id]);
 });

 await t.test('a closed session keeps its report and refuses new session writes', async () => {
  await h.asUser(users.recruiter);await assert.rejects(e.setStatus(sessionId,'closed'),forbidden);
  await h.asUser(f1.owner);await e.setStatus(sessionId,'closed');
  await assert.rejects(e.setStatus(sessionId,'open'),denied('PT409'));
  await assert.rejects(e.record(sessionId,f2,null,'expert_consultation',{note:'Notatka po zamknięciu sesji.'}),denied('42501'));
  await assert.rejects(e.assign(sessionId,stages[1],f2),denied('42501'));
  const closed = await e.read(sessionId);assert.equal(closed.session.status,'closed');assert.ok(closed.session.closedAt);
 });

 await t.test('reapplying the migration is refused without modifying existing data', async () => {
  await h.asAdmin();
  await assert.rejects(db.exec(await readFile(new URL('../supabase/migrations/'+sessionMigration,import.meta.url),'utf8')),denied('55000'));await db.exec('rollback');
  assert.equal((await db.query('select private.erasure_schema_signature() signature')).rows[0].signature,sessionSignature);
 });

 await t.test('operational rollback closes the session RPCs but keeps evidence, R16 and erasure support; R13 pair RPCs stay open', async () => {
  await h.asAdmin();
  const before = await Promise.all(sessionTables.map(table=>count(db,table)));
  await db.exec(await readFile(new URL('../supabase/rollbacks/'+sessionRollback,import.meta.url),'utf8'));
  assert.deepEqual(await Promise.all(sessionTables.map(table=>count(db,table))),before);
  assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value,sessionSignature);
  await h.asUser(f1.owner);
  await assert.rejects(e.read(sessionId),denied('42501'));await assert.rejects(e.find(f1),denied('42501'));
  await assert.rejects(e.record(sessionId,f2,null,'expert_consultation',{note:'Notatka po wycofaniu funkcji.'}),denied('42501'));
  assert.ok(!(await x.preview(f2)).blockers.includes('schema_dependency_unknown'));
  assert.equal((await x.preview(f2)).counts['private.ac_session_finalists'],1);
  assert.equal(await call('public.ac_find_pair',[f2.application.id,stages[0].definitionId]),null);
 });
});

test('AC session: hard cap of ten finalists in the table, five to six only recommended', async t => {
 const e = await sessionBoot(t), {db,h} = e;
 const people = [];
 for (let i = 0; i < 11; i++) people.push(await e.finalist());
 const {sessionId} = await e.plan(people[0]);
 const levels = [];
 for (const [index,person] of people.slice(0,10).entries()) {
  await h.asUser(person.owner);await e.addFinalist(sessionId,person);
  levels.push(buildAssessmentCenterSessionReport(parseAssessmentCenterSession(await e.read(sessionId))).finalistAdvice.level);
  assert.equal(levels.length,index+1);
 }
 // 1-4 below, 5-6 recommended, 7-9 above: advice only, none of them blocked. Ten is the limit.
 assert.deepEqual(levels,['below','below','below','below','recommended','recommended','above','above','above','limit']);
 await assert.rejects(e.addFinalist(sessionId,people[10]),error => error.code==='PT422' && /Finalist limit reached/.test(error.message));
 await h.asAdmin();await db.query("select set_config('request.jwt.claim.sub',$1,false)",[people[0].owner]);
 for (const slot of [11,0]) {
  await assert.rejects(db.query('insert into private.ac_session_finalists(session_id,company_id,recruitment_id,application_id,slot,added_by) values($1,$2,$3,$4,$5,$6)',
   [sessionId,people[0].companyId,people[0].recruitment.id,people[10].application.id,slot,people[0].owner]),denied('23514'));
 }
 await assert.rejects(db.query('insert into private.ac_session_finalists(session_id,company_id,recruitment_id,application_id,slot,added_by) values($1,$2,$3,$4,10,$5)',
  [sessionId,people[0].companyId,people[0].recruitment.id,people[10].application.id,people[0].owner]),denied('23505'));
 assert.equal(await count(db,'private.ac_session_finalists where session_id=$1',[sessionId]),10);
 await h.asUser(people[0].owner);await e.setStatus(sessionId,'open');
 await assert.rejects(e.addFinalist(sessionId,people[10]),denied('PT422'));
});

test('AC session migration refuses source drift atomically and strips hostile default grants', async t => {
 const e = await sessionBoot(t,{throughMigration:'20261111140000_sc19_p24_checkout_role.sql'}), {db,h} = e;
 await h.asAdmin();
 const migration = await readFile(new URL('../supabase/migrations/'+sessionMigration,import.meta.url),'utf8');
 const reject = async () => {
  await assert.rejects(db.exec(migration),denied('55000'));await db.exec('rollback');
  assert.equal((await db.query("select to_regclass('private.ac_sessions') value")).rows[0].value,null);
  assert.equal((await db.query("select to_regclass('private.erasure_inventory_baseline_r16') value")).rows[0].value,null);
 };
 await db.exec('create table public.ac_session_unknown_source(candidate_id uuid)');await reject();await db.exec('drop table public.ac_session_unknown_source');
 for (const name of ['private.erasure_row_candidates(text,jsonb)','private.ac_lock_application(uuid)','public.preview_candidate_erasure(uuid,text,uuid)']) {
  const original = (await db.query('select pg_get_functiondef($1::regprocedure) source',[name])).rows[0].source;
  await db.exec(original.replace(/\bbegin\b/,'begin\n -- synthetic source drift'));await reject();await db.exec(original);
 }
 await db.exec('alter default privileges in schema private grant all on tables to authenticated; alter default privileges in schema private grant execute on functions to authenticated; alter default privileges in schema public grant execute on functions to anon');
 await db.exec(migration);
 for (const table of sessionTables) assert.equal((await db.query("select has_table_privilege('authenticated',$1::regclass,'select,insert,update,delete') value",[table])).rows[0].value,false,table);
 assert.equal((await db.query("select has_function_privilege('authenticated','private.ac_session_lock_finalist(uuid,uuid)','execute') value")).rows[0].value,false);
 assert.equal((await db.query("select has_function_privilege('anon','public.ac_session_read(uuid)','execute') value")).rows[0].value,false);
 assert.equal((await db.query('select private.erasure_schema_signature() value')).rows[0].value,sessionSignature);
});
