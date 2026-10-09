import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const codes = (code) => error => error.code === code;
const highId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const lowId = '00000000-0000-0000-0000-000000000001';
const rankingColumns = ['application_id','analysis_id','review_id','rank','rankable','eligibility_reason','raw_score','coverage','total_criteria','known_criteria','below_count','meets_count','above_count','insufficient_data_count','suggested_shortlist','ranking_policy_version','shortlist_entry_id','shortlist_snapshot_current'];
const shortlistColumns = ['entry_id','application_id','selected_by','selected_at','source','analysis_id','review_id','ranking_policy_version','raw_score_snapshot','coverage_snapshot','note','snapshot_current','policy_current','removed_at','removed_by'];

test('SC-008 actual ranking and shortlist RPC contracts on complete migration chain', async t => {
  const db = new PGlite({extensions:{pgcrypto}}); t.after(() => db.close());
  const h = await setupRankingDatabase(db);
  const approved = async (ratings = ['above','meets','below','insufficient_data','insufficient_data'], count = ratings.length) => h.completedApplication(await h.seed(users.owner, randomUUID(), count), ratings);
  const expectedFailure = async (promise, code) => assert.rejects(promise, codes(code));

  await t.test('policy seed is immutable before any shortlist; grants and exact contract protect tenant data', async () => {
    await h.asUser();
    const policy = (await db.query("select * from private.screening_ranking_policy('screening-ranking-v1')")).rows[0];
    assert.equal(Number(policy.min_coverage), .6);
    assert.deepEqual([policy.below_points,policy.meets_points,policy.above_points,policy.min_target_size,policy.max_target_size,policy.default_target_size], [0,50,100,5,10,10]);
    await h.asAdmin();
    await assert.rejects(db.query("update private.screening_ranking_policies set default_target_size=7 where version='screening-ranking-v1'"));
    await assert.rejects(db.query("delete from private.screening_ranking_policies where version='screening-ranking-v1'"));
    const f = await approved();
    const before = (await db.query('select rating from public.screening_criterion_results where analysis_id=$1 order by criterion_order', [f.analysis_id])).rows;
    const ranking = await h.row(f);
    assert.deepEqual(Object.keys(ranking), rankingColumns);
    assert.equal(ranking.rankable,true); assert.equal(Number(ranking.coverage),.6);
    const id = await h.add(f,'suggested',ranking,'  Human choice  ');
    const entry = (await h.shortlist(f))[0];
    assert.deepEqual(Object.keys(entry),shortlistColumns);
    assert.equal(entry.entry_id,id); assert.equal(entry.note,'Human choice');
    assert.equal(entry.snapshot_current,true); assert.equal(entry.policy_current,true);
    assert.equal((await h.row(f)).shortlist_entry_id,id);
    assert.deepEqual((await db.query('select rating from public.screening_criterion_results where analysis_id=$1 order by criterion_order', [f.analysis_id])).rows,before);
    assert.deepEqual((await db.query('select overall_score,latest_review_version from public.screening_analysis_versions where id=$1',[f.analysis_id])).rows,[{overall_score:null,latest_review_version:1}]);
    assert.equal((await db.query('select status from public.applications where id=$1',[f.application.id])).rows[0].status,'new');
    await expectedFailure(db.query('select private.screening_stale_reason($1)',[f.analysis_id]),'42501');
    for(const sql of ['insert into public.recruitment_shortlist_entries default values','update public.recruitment_shortlist_entries set note=null','delete from public.recruitment_shortlist_entries']) await expectedFailure(db.query(sql),'42501');
    await h.asAdmin();
    const definitions = (await db.query(`select p.proname,p.prosecdef,p.provolatile,pg_get_functiondef(p.oid) as definition,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('screening_worker',p.oid,'EXECUTE') as worker
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
      (n.nspname='public' and p.proname in ('get_screening_ranking','get_recruitment_shortlist','add_recruitment_shortlist_entry','remove_recruitment_shortlist_entry'))
      or (n.nspname='private' and p.proname in ('screening_ranking_freshness_reason','screening_ranking_policy','screening_ranking_order_key'))`)).rows;
    assert.equal(definitions.length,7);
    for(const fn of definitions) { assert.equal(fn.anon,false,fn.proname); assert.equal(fn.worker,false,fn.proname); }
    for(const name of ['get_screening_ranking','get_recruitment_shortlist','screening_ranking_freshness_reason']) {
      const fn=definitions.find(item=>item.proname===name); assert.equal(fn.prosecdef,false,name); assert.equal(fn.provolatile,'s');
      const body=fn.definition.replace(/--[^\n]*/g,'');
      assert.doesNotMatch(body,/\b(input_cv_text_snapshot|source_text|redacted_text|evidence|explanation|result_summary|screening_stale_reason)\b/i,name);
      assert.doesNotMatch(body,/%rowtype|select\s+\*\s+into|\b\w+\.\*/i,name);
      for(const match of body.matchAll(/binding_snapshot\b([^\n]*)/gi)) assert.match(match[1],/^\s*->>/,name);
    }
    assert.match(definitions.find(fn=>fn.proname==='get_screening_ranking').definition,/order\s+by\s+private\.screening_ranking_order_key/i);
    const freshness=definitions.find(fn=>fn.proname==='screening_ranking_freshness_reason').definition;
    assert.ok(freshness.indexOf('has_company_access')<freshness.indexOf('public.screening_analysis_versions'));
    const rls=(await db.query("select relrowsecurity from pg_class where oid='public.recruitment_shortlist_entries'::regclass")).rows[0]; assert.equal(rls.relrowsecurity,true);
  });

  await t.test('coverage boundary, unknown evidence and numeric division retain the approved meaning', async () => {
    for(const [ratings,reason,score,coverage] of [
      [['above','meets','below','insufficient_data','insufficient_data'],'eligible',50,.6],
      [['above','meets','insufficient_data','insufficient_data','insufficient_data'],'insufficient_evidence',75,.4],
      [Array(5).fill('insufficient_data'),'insufficient_evidence',null,0],
      [['above','below','below'],'eligible',33.333,1],
    ]) {
      const f=await approved(ratings), r=await h.row(f);
      assert.equal(r.eligibility_reason,reason); assert.equal(r.raw_score===null?null:Number(r.raw_score),score); assert.equal(Number(r.coverage),coverage);
      assert.equal(r.known_criteria,r.below_count+r.meets_count+r.above_count);
      assert.equal(r.total_criteria,r.known_criteria+r.insufficient_data_count);
      if(reason==='insufficient_evidence') {assert.equal(r.rank,null);assert.equal(r.suggested_shortlist,false);await expectedFailure(h.add(f,'suggested',r),'22023');await h.add(f,'manual',r);}
    }
  });

  await t.test('latest human rating overrides only; evidence-only overrides preserve AI points', async()=>{
    const f=await approved(Array(5).fill('meets'));
    const results=(await db.query('select id,rating from public.screening_criterion_results where analysis_id=$1 order by criterion_order',[f.analysis_id])).rows;
    await h.review(f,f.analysis_id,'approved_with_changes',[{criterion_result_id:results[0].id,rating_override:'above',evidence_override:[{start:0,end:3,quote:'SQL'}]}]);
    assert.equal(Number((await h.row(f)).raw_score),60);
    await h.review(f,f.analysis_id,'approved_with_changes',[{criterion_result_id:results[1].id,evidence_override:[{start:0,end:3,quote:'SQL'}],explanation_override:'Rechecked'}]);
    assert.equal(Number((await h.row(f)).raw_score),50);
    await h.review(f,f.analysis_id,'approved');assert.equal(Number((await h.row(f)).raw_score),50);
    await h.review(f,f.analysis_id,'needs_reanalysis');
    assert.equal((await h.row(f)).eligibility_reason,'needs_reanalysis');
    await expectedFailure(h.add(f),'55000');
    assert.deepEqual((await db.query('select id,rating from public.screening_criterion_results where analysis_id=$1 order by criterion_order',[f.analysis_id])).rows,results);
  });

  await t.test('current completed remains source during pending/processing; superseding completion clears evidence identifiers until review',async()=>{
    const f=await approved(Array(5).fill('meets'));
    const old=await h.row(f),entry=await h.add(f);
    const newer=await h.start(f,{promptVersion:'screening-v2'});
    await h.asUser();assert.equal((await h.row(f)).analysis_id,f.analysis_id);
    const claimed=await h.claim(newer);await h.asUser();assert.equal((await h.row(f)).analysis_id,f.analysis_id);
    await h.finishClaim(newer,claimed,Array(5).fill('above'));await h.asUser();
    const current=await h.row(f);assert.equal(current.eligibility_reason,'no_human_review');assert.equal(current.analysis_id,newer.analysis_id);assert.equal(current.review_id,null);
    assert.equal((await h.shortlist(f))[0].snapshot_current,false);
    await expectedFailure(h.add(f,'manual',old),'PT409');
    await h.remove(entry);await h.review(f,newer.analysis_id);await expectedFailure(h.add(f,'manual',old),'PT409');
    await h.add(f); assert.equal(Number((await h.shortlist(f))[0].raw_score_snapshot),100);
  });

  await t.test('every no-result status has closed reason codes and no stale analysis/review ids',async()=>{
    for(const status of ['none','pending','processing','failed','cancelled']) {
      const f=await h.seed();
      if(status!=='none') {
        const started=await h.start(f);
        if(status==='processing') await h.claim(started);
        if(status==='failed') {const claim=await h.claim(started);await db.query("select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','Fixture')",[started.attempt_id,claim.lease_token,claim.input_fingerprint,claim.analysis_contract_hash]);}
        if(status==='cancelled') {await h.asAdmin();await db.query("update public.screening_analysis_versions set execution_status='cancelled' where id=$1",[started.analysis_id]);}
      }
      await h.asUser();const r=await h.row(f);
      assert.equal(r.eligibility_reason,status==='none'?'no_completed_result':status);assert.equal(r.analysis_id,null);assert.equal(r.review_id,null);assert.equal(r.rank,null);assert.equal(r.suggested_shortlist,false);
    }
  });

  await t.test('persisted and logical freshness changes are read-only and preserve shortlist audit',async()=>{
    for(const [table,change,reason] of [
      ['applications',"status='rejected'",'application_changed'],
      ['recruitments',"name=name||' changed'",'recruitment_changed'],
      ['positions',"title=title||' changed'",'position_changed'],
      ['candidate_documents',"redacted_text=redacted_text||' changed'",'candidate_document_changed'],
    ]) {
      const f=await approved(),entryId=await h.add(f);
      const id=table==='applications'?f.application.id:table==='recruitments'?f.recruitment.id:table==='positions'?f.position.id:f.document.id;
      await db.query(`update public.${table} set ${change} where id=$1`,[id]);
      assert.equal((await h.row(f)).eligibility_reason,'stale');assert.equal((await h.shortlist(f))[0].snapshot_current,false);
      await h.asAdmin();await db.query('update public.screening_analysis_versions set stale_at=null,stale_reason=null where id=$1',[f.analysis_id]);
      const oldReason=(await db.query('select private.screening_stale_reason($1) as reason',[f.analysis_id])).rows[0].reason;
      await h.asUser();const logical=(await db.query('select private.screening_ranking_freshness_reason($1,$2) as reason',[f.companyId,f.analysis_id])).rows[0].reason;
      assert.equal(logical,oldReason);assert.equal(logical,reason);
      const r=await h.row(f);assert.equal(r.eligibility_reason,'stale');assert.equal(r.analysis_id,null);assert.equal(r.review_id,null);
      assert.equal((await db.query('select stale_at from public.screening_analysis_versions where id=$1',[f.analysis_id])).rows[0].stale_at,null);
      assert.equal(await h.remove(entryId),entryId);assert.equal(await h.remove(entryId),entryId);assert.equal((await h.shortlist(f)).length,0);
      assert.equal((await h.shortlist(f,true))[0].snapshot_current,false);
    }
  });

  await t.test('latest review invalidates persisted snapshot; expected versions cannot silently change',async()=>{
    const f=await approved(), original=await h.row(f), id=await h.add(f,'manual',original);
    await expectedFailure(h.add(f,'manual',original),'PT409');
    await h.review(f,f.analysis_id);assert.equal((await h.shortlist(f))[0].snapshot_current,false);
    await h.remove(id);await expectedFailure(h.add(f,'manual',original),'PT409');
    const current=await h.row(f);
    for(const changed of [{...current,analysis_id:randomUUID()},{...current,review_id:randomUUID()},{...current,ranking_policy_version:'screening-ranking-v0'}]) await expectedFailure(h.add(f,'manual',changed),'PT409');
    const next=await h.add(f);assert.notEqual(next,id);assert.equal((await h.shortlist(f,true)).length,2);
    await h.asAdmin();
    await assert.rejects(db.query('update public.recruitment_shortlist_entries set note=$1 where id=$2',['tamper',next]));
    await assert.rejects(db.query('update public.recruitment_shortlist_entries set removed_at=null,removed_by=null where id=$1',[id]));
  });

  await t.test('tenant isolation, recruiter writes, viewer reads and inaccessible IDs share errors',async()=>{
    const f=await approved(),other=await h.seed(users.otherOwner);
    await h.asUser();
    for(const [user,role]of[[users.recruiter,'recruiter'],[users.viewer,'viewer']])await h.insert('company_members',{company_id:f.companyId,user_id:user,role});
    const expected=await h.row(f);
    await h.asUser(users.recruiter);const id=await h.add(f);
    await h.asUser(users.viewer);assert.equal((await h.ranking(f)).length,1);assert.equal((await h.shortlist(f)).length,1);
    await expectedFailure(h.add(f,'manual',expected),'42501');await expectedFailure(h.remove(id),'42501');
    for(const user of[users.otherOwner,users.outsider]) {
      await h.asUser(user);
      for(const recruitmentId of[f.recruitment.id,randomUUID()])for(const name of['get_screening_ranking','get_recruitment_shortlist'])await expectedFailure(db.query(`select * from public.${name}($1)`,[recruitmentId]),'42501');
      assert.equal((await db.query('select * from public.recruitment_shortlist_entries where id=$1',[id])).rows.length,0);
      await expectedFailure(h.add(f,'manual',expected),'42501');await expectedFailure(h.remove(id),'42501');
      assert.equal((await db.query('select private.screening_ranking_freshness_reason($1,$2) as reason',[f.companyId,f.analysis_id])).rows[0].reason,'unavailable');
    }
    await h.asUser(null);await expectedFailure(h.ranking(f),'42501');
    assert.equal((await db.query('select private.screening_ranking_freshness_reason($1,$2) as reason',[f.companyId,f.analysis_id])).rows[0].reason,'unavailable');
    await h.asUser();assert.equal((await db.query('select private.screening_ranking_freshness_reason($1,$2) as reason',[other.companyId,f.analysis_id])).rows[0].reason,'unavailable');
    await h.asUser(users.recruiter);await h.remove(id);await h.asUser();await h.add(f);
  });

  await t.test('zero, missing, corrupt snapshot and review-cache inconsistency fail closed',async()=>{
    for(const scenario of['no-review','cache-missing','cache-mismatch','empty','missing-result','non-array']) {
      const f=await approved();await h.asAdmin();await db.exec('begin');
      try {
        if(scenario==='no-review'||scenario==='cache-missing') {await db.query('delete from public.screening_result_reviews where analysis_id=$1',[f.analysis_id]);await db.query('update public.screening_analysis_versions set latest_review_version=$2 where id=$1',[f.analysis_id,scenario==='no-review'?0:1]);}
        if(scenario==='cache-mismatch')await db.query('update public.screening_analysis_versions set latest_review_version=9 where id=$1',[f.analysis_id]);
        if(scenario==='missing-result')await db.query('delete from public.screening_criterion_results where analysis_id=$1 and criterion_order=1',[f.analysis_id]);
        if(scenario==='empty')await db.query("update public.screening_analysis_versions set criteria_snapshot='[]' where id=$1",[f.analysis_id]);
        if(scenario==='non-array') {
          const constraints=(await db.query("select conname from pg_constraint where conrelid='public.screening_analysis_versions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%criteria_snapshot%'")).rows;
          for(const {conname}of constraints){assert.match(conname,/^[a-z_]+$/);await db.exec(`alter table public.screening_analysis_versions drop constraint ${conname}`);}
          await db.query("update public.screening_analysis_versions set criteria_snapshot='{}' where id=$1",[f.analysis_id]);
        }
        await h.asUser();const r=await h.row(f);
        assert.equal(r.eligibility_reason,scenario==='no-review'?'no_human_review':scenario.startsWith('cache')?'review_inconsistent':'result_incomplete');
        assert.equal(r.raw_score,null);assert.equal(r.rank,null);
        await expectedFailure(h.add(f,'manual',r),'55000');
      } finally {await db.exec('rollback');}
    }
  });

  await t.test('isolated production order helper verifies each precedence with adversarial later keys',async keys=>{
    await h.asUser();
    const cases=[
      ['score',[66.667,.75,1,2,highId],[62.5,1,0,3,lowId]],
      ['coverage',[75,1,1,4,highId],[75,10/14,0,5,lowId]],
      ['below',[50,1,0,0,highId],[50,1,1,1,lowId]],
      ['above',[75,1,0,2,highId],[75,1,0,1,lowId]],
      ['uuid',[50,1,0,0,lowId],[50,1,0,0,highId]],
    ];
    for(const [label,a,b]of cases) {
      await keys.test(label,async()=>{
      const values=[...a,...b];
      const rows=(await db.query(`select label from (values ('A',private.screening_ranking_order_key($1,$2,$3,$4,$5)),('B',private.screening_ranking_order_key($6,$7,$8,$9,$10))) v(label,key) order by key`,values)).rows;
      assert.deepEqual(rows.map(r=>r.label),['A','B'],label);
      });
    }
    const vectors=[[100,.6,2,3,highId],[75,1,0,2,highId],[75,1,0,1,lowId],[75,1,1,4,highId],[75,.8,0,3,lowId],[50,1,0,0,lowId]];
    const values=vectors.flat(), tuples=vectors.map((_,i)=>`(${i},private.screening_ranking_order_key(${Array.from({length:5},(_,j)=>`$${i*5+j+1}`).join(',')}))`).join(',');
    assert.deepEqual((await db.query(`select label from(values ${tuples}) v(label,key) order by key`,values)).rows.map(r=>r.label),[0,1,2,3,4,5]);
  });

  await t.test('real RPC orders reachable scores and coverage for one shared position snapshot',async()=>{
    const tenant=await h.seed(),fixtures=[tenant];for(let i=1;i<4;i++)fixtures.push(await h.candidate(tenant));
    const vectors=[['above','meets','meets','meets','meets'],Array(5).fill('meets'),['above','below','meets','meets','meets'],['meets','meets','meets','insufficient_data','insufficient_data']];
    for(let i=0;i<fixtures.length;i++)await h.completedApplication(fixtures[i],vectors[i]);
    await h.asUser();const ranked=await h.ranking(tenant);
    assert.deepEqual(ranked.map(r=>r.application_id),fixtures.map(f=>f.application.id));
    assert.deepEqual(ranked.map(r=>Number(r.raw_score)),[60,50,50,50]);
    assert.deepEqual(ranked.map(r=>r.rank),[1,2,3,4]);
  });

  await t.test('real RPC stable UUID ties, valid target sizes and suggested membership',async()=>{
    const tenant=await h.seed();const fixtures=[tenant];for(let i=1;i<11;i++)fixtures.push(await h.candidate(tenant));
    for(const f of fixtures)await h.completedApplication(f,Array(5).fill('meets'));
    await h.asUser();const expected=fixtures.map(f=>f.application.id).sort();
    for(const size of[null,5,10]) {
      const rows=await h.ranking(tenant,size);assert.deepEqual(rows.map(r=>r.application_id),expected);assert.deepEqual(rows.map(r=>r.rank),Array.from({length:11},(_,i)=>i+1));assert.equal(rows.filter(r=>r.suggested_shortlist).length,size??10);
    }
    for(const size of[4,11])await expectedFailure(h.ranking(tenant,size),'22023');
    const outside=fixtures.find(f=>f.application.id===expected[10]);
    await expectedFailure(h.add(outside,'suggested',undefined,null,10),'22023');await h.add(outside,'manual');
    const inside=fixtures.find(f=>f.application.id===expected[0]);await h.add(inside,'suggested',undefined,null,5);
  });
});

test('isolated alternative initial policy default 7 is honored by reads and writes',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());const h=await setupRankingDatabase(db,{defaultTargetSize:7});
  const tenant=await h.seed(),fixtures=[tenant];for(let i=1;i<10;i++)fixtures.push(await h.candidate(tenant));
  for(const f of fixtures)await h.completedApplication(f,Array(5).fill('meets'));
  await h.asUser();
  const omitted=(await db.query('select * from public.get_screening_ranking($1)',[tenant.recruitment.id])).rows;
  assert.equal(omitted.filter(r=>r.suggested_shortlist).length,7);assert.equal((await h.ranking(tenant,null)).filter(r=>r.suggested_shortlist).length,7);assert.equal((await h.ranking(tenant,10)).filter(r=>r.suggested_shortlist).length,10);
  const eighth=fixtures.find(f=>f.application.id===omitted.find(r=>r.rank===8).application_id),r=await h.row(eighth);
  await assert.rejects(db.query('select public.add_recruitment_shortlist_entry($1,$2,$3,$4,$5)',[eighth.application.id,'suggested',r.analysis_id,r.review_id,r.ranking_policy_version]),codes('22023'));
  await assert.rejects(h.add(eighth,'suggested',r,null,null),codes('22023'));await h.add(eighth,'suggested',r,null,10);
});

test('a future immutable policy migration rejects a selection displayed under the earlier policy',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());const h=await setupRankingDatabase(db);
  const f=await h.completedApplication(await h.seed(),Array(5).fill('meets'));
  const g=await h.completedApplication(await h.candidate(f),Array(5).fill('meets'));
  const displayed=await h.row(g),oldEntry=await h.add(f);
  await h.asAdmin();
  // Simulate a future migration: INSERT another version and replace active RPC
  // definitions. The installed v1 row and every persisted snapshot stay immutable.
  await db.query(`insert into private.screening_ranking_policies
    (version,min_coverage,below_points,meets_points,above_points,min_target_size,max_target_size,default_target_size)
    values ('screening-ranking-v2',0.60,0,60,100,5,10,10)`);
  const definitions=(await db.query(`select pg_get_functiondef(p.oid) as definition from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('get_screening_ranking','get_recruitment_shortlist','add_recruitment_shortlist_entry')`)).rows;
  assert.equal(definitions.length,3);
  for(const {definition} of definitions){assert.match(definition,/screening-ranking-v1/);await db.exec(definition.replaceAll('screening-ranking-v1','screening-ranking-v2'));}
  await h.asUser();
  await assert.rejects(h.add(g,'manual',displayed),codes('PT409'));
  const historical=(await h.shortlist(f)).find(entry=>entry.entry_id===oldEntry);
  assert.equal(historical.policy_current,false);assert.equal(historical.snapshot_current,true);
  assert.equal(historical.ranking_policy_version,'screening-ranking-v1');assert.equal(Number(historical.raw_score_snapshot),50);
  const current=await h.row(g);assert.equal(current.ranking_policy_version,'screening-ranking-v2');assert.equal(Number(current.raw_score),60);
  await h.add(g,'manual',current);
  assert.equal((await h.shortlist(g)).find(entry=>entry.application_id===g.application.id).policy_current,true);
});
