import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { reportDatabaseClient } from './helpers/screening-report-database-client.mjs';
import { readScreeningReview } from '../lib/screening-ui.ts';
import { loadScreeningReport } from '../lib/screening-report-source.ts';
import { exportScreeningReport } from '../lib/screening-report-export.ts';
import { screeningReportCsv } from '../lib/screening-report.ts';

test('SC-006 → SC-008 → SC-009: actual review, ranking and shortlist SQL feeds the report and CSV', async t => {
  const db = new PGlite({extensions:{pgcrypto}}); t.after(()=>db.close());
  const h = await setupRankingDatabase(db);
  const f = await h.completedApplication(await h.seed(users.owner,'joint-flow',5),['above','meets','below','insufficient_data','insufficient_data'],null);
  await h.asUser(users.owner);
  let signedIn = {id:users.owner};
  const client = reportDatabaseClient(db,()=>signedIn);
  const load = () => loadScreeningReport(client,f.companyId,f.recruitment.id,'5');
  const criteria = (await db.query('select * from public.screening_criterion_results where analysis_id=$1 order by criterion_order',[f.analysis_id])).rows;
  const originals = JSON.stringify(criteria);
  let selectionId;

  await t.test('unreviewed completed result remains visible but cannot export unreviewed evidence', async()=>{
    const report = await load();
    assert.equal(report.applications[0].ranking.eligibility_reason,'no_human_review');
    assert.deepEqual(report.applications[0].criteria,[]);
    assert.equal(report.applications[0].ranking.raw_score,null);
  });
  await t.test('real SC006 form correction changes effective SQL rating without overwriting AI; report agrees',async()=>{
    const form = new FormData();
    form.set('disposition','approved_with_changes'); form.set('confirmed','on');
    form.set('note','PRIVATE recruiter note'); form.set(`change:${criteria[3].id}`,'on');
    form.set(`rating:${criteria[3].id}`,'above'); form.set(`quote:${criteria[3].id}:0`,'SQL');
    form.set(`explanation:${criteria[3].id}`,'Zweryfikowano dokładny cytat.');
    const parsed = readScreeningReview(form,criteria,f.document.redacted_text);
    await db.query('select public.review_screening_result($1,0,$2,$3,$4::jsonb)',[f.analysis_id,parsed.disposition,parsed.note,JSON.stringify(parsed.overrides)]);
    const report = await load(), item=report.applications[0];
    assert.equal(item.ranking.eligibility_reason,'eligible');
    assert.equal(item.ranking.raw_score,62.5); assert.equal(item.ranking.coverage,0.8);
    assert.equal(item.ranking.known_criteria,4); assert.equal(item.ranking.insufficient_data_count,1);
    assert.equal(item.criteria[3].aiRating,'insufficient_data'); assert.equal(item.criteria[3].rating,'above');
    assert.deepEqual(item.criteria[3].evidence,[{start:0,end:3,quote:'SQL'}]);
    const csv=screeningReportCsv(report); assert.match(csv,/62.5/); assert.match(csv,/Zweryfikowano dokładny cytat/);
    assert.doesNotMatch(csv,/PRIVATE|original CV|expertise in reports/);
    assert.equal(JSON.stringify((await db.query('select * from public.screening_criterion_results where analysis_id=$1 order by criterion_order',[f.analysis_id])).rows),originals);
    assert.equal((await db.query('select overall_score from public.screening_analysis_versions where id=$1',[f.analysis_id])).rows[0].overall_score,null);
  });
  await t.test('human shortlist persists server-computed snapshot and export reflects the real entry',async()=>{
    selectionId=await h.add(f,'suggested',undefined,'PRIVATE shortlist note',5);
    const report=await load(), item=report.applications[0];
    assert.equal(item.shortlist.entry_id,selectionId); assert.equal(item.shortlist.snapshot_current,true);
    assert.equal(item.shortlist.raw_score_snapshot,62.5);
    const response=await exportScreeningReport(client,f.companyId,f.recruitment.id,'5');
    assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/);
    assert.match(await response.text(),/Wybrano przez człowieka/);
  });
  await t.test('new evidence-only review replaces prior overrides and makes saved shortlist historical',async()=>{
    await h.review(f,f.analysis_id,'approved_with_changes',[{criterion_result_id:criteria[0].id,explanation_override:'Nowy przegląd dowodów.'}]);
    const report=await load(), item=report.applications[0];
    assert.equal(item.ranking.raw_score,50); assert.equal(item.ranking.coverage,0.6);
    assert.equal(item.criteria[3].rating,'insufficient_data'); assert.equal(item.criteria[0].rating,'above');
    assert.equal(item.shortlist.snapshot_current,false); assert.equal(item.shortlist.raw_score_snapshot,62.5);
    assert.match(screeningReportCsv(report),/wymaga ponownego sprawdzenia/);
  });
  await t.test('review changed during report loading blocks mixed-version export',async()=>{
    let changed=false;
    const changing=reportDatabaseClient(db,()=>signedIn,async table=>{
      if(table==='screening_criterion_results'&&!changed){changed=true;await h.review(f,f.analysis_id,'approved');}
    });
    const response=await exportScreeningReport(changing,f.companyId,f.recruitment.id,'5');
    assert.equal(changed,true); assert.equal(response.status,409);
  });
  await t.test('all-unknown review may be manually shortlisted with NULL score and survives paginated reads',async()=>{
    const unknown=await h.completedApplication(await h.candidate(f,'unknown'),Array(5).fill('insufficient_data'));
    await h.add(unknown,'manual');
    const third=await h.completedApplication(await h.candidate(f,'third'),Array(5).fill('meets'));
    const report=await load(); assert.equal(report.applications.length,3);
    const item=report.applications.find(a=>a.ranking.application_id===unknown.application.id);
    assert.equal(item.ranking.raw_score,null); assert.equal(item.ranking.coverage,0);
    assert.equal(item.ranking.eligibility_reason,'insufficient_evidence');
    assert.equal(item.shortlist.raw_score_snapshot,null); assert.equal(item.shortlist.snapshot_current,true);
    assert.equal(report.applications.find(a=>a.ranking.application_id===third.application.id).ranking.rank,1);
    assert.ok(client.reads.some(r=>r.table==='get_screening_ranking'&&r.offset===2));
  });
  await t.test('CV edit hides stale evidence but preserves historical selection and candidate status',async()=>{
    await db.query('update public.candidate_documents set redacted_text=$2 where id=$1',[f.document.id,'Changed SQL material.']);
    const report=await load(), item=report.applications.find(a=>a.ranking.application_id===f.application.id);
    assert.equal(item.ranking.eligibility_reason,'stale'); assert.equal(item.ranking.analysis_id,null);
    assert.deepEqual(item.criteria,[]); assert.equal(item.shortlist.snapshot_current,false);
    assert.equal((await db.query('select status from public.applications where id=$1',[f.application.id])).rows[0].status,'new');
  });
  await t.test('actual RLS blocks other tenant, viewer can read and anonymous export is rejected',async()=>{
    await h.insert('company_members',{company_id:f.companyId,user_id:users.viewer,role:'viewer'});
    await h.asUser(users.viewer); signedIn={id:users.viewer};
    assert.equal((await load()).applications.length,3);
    await assert.rejects(h.remove(selectionId),e=>e.code==='42501');
    await h.asUser(users.otherOwner); signedIn={id:users.otherOwner};
    assert.equal((await exportScreeningReport(client,f.companyId,f.recruitment.id,'5')).status,404);
    signedIn=null; assert.equal((await exportScreeningReport(client,f.companyId,f.recruitment.id,'5')).status,401);
    assert.ok(client.reads.every(r=>!r.fields.includes('input_cv_text_snapshot')&&!r.fields.includes('source_text')));
  });
});
