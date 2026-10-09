import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readScreeningReview, screeningStatus, ratingLabels } from '../lib/screening-ui.ts';
import { runScreeningCommand, loadScreeningContext, ScreeningNotFoundError } from '../lib/screening-flow.ts';
import { prepareScreening } from '../lib/screening.ts';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route = { companyId: uuid(1), recruitmentId: uuid(2), applicationId: uuid(3) };
const criterion = { id: uuid(8), criterion_id: 'task:1', criterion_kind: 'task', criterion_text_snapshot: 'Raporty', rating: 'insufficient_data', evidence: [], explanation: 'Brak dowodów', criterion_order: 0 };
function context() {
  const common = { company_id: route.companyId, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' };
  return { companyId: route.companyId,
    application: { ...common, id: route.applicationId, candidate_id: uuid(4), recruitment_id: route.recruitmentId, status: 'new' },
    recruitment: { ...common, id: route.recruitmentId, position_id: uuid(5), status: 'open', name: 'Test' },
    position: { ...common, id: uuid(5), title: 'Analityk', tasks: ['Raporty'], kpis: ['Terminowość'], required_competencies: [], required_behaviors: [], status: 'active' },
    document: { ...common, id: uuid(6), candidate_id: uuid(4), version: 1, status: 'reviewed', reviewed_by: uuid(7), reviewed_at: common.created_at, redacted_text: '📊 Tworzę raporty.' },
  };
}
function clientFor(ctx, extra = {}, rpcResult = {}) {
  const tables = { applications: ctx.application, recruitments: ctx.recruitment, positions: ctx.position, candidate_documents: ctx.document, ...extra };
  const calls = [];
  return { calls, from(table) {
    const filters = [];
    const data = () => {
      const rows = Array.isArray(tables[table]) ? tables[table] : tables[table] ? [tables[table]] : [];
      return rows.filter(row => filters.every(([k,v]) => row[k] === v));
    };
    const query = { select() {return this;}, eq(k,v) {filters.push([k,v]);return this;}, order(){return this;}, limit(){return this;},
      maybeSingle: async () => ({data:data()[0] ?? null,error:null}), then(resolve) {return Promise.resolve({data:data(),error:null}).then(resolve);} };
    return query;
  }, async rpc(name,args) { calls.push({name,args}); return {data:[{attempt_id:uuid(9),execution_status:'pending',...rpcResult}],error:null}; } };
}
const command = (client, options = {}) => runScreeningCommand({client,route,canEdit:true,enabled:true,command:'start',idempotencyKey:uuid(10),dispatch:async () => ({accepted:true}),...options});

test('authenticated start dispatches only the RPC attempt and binds current reviewed input', async () => {
  const ctx = context(), client = clientFor(ctx), sent = [];
  await command(client, {attemptId:uuid(999),dispatch:async id => {sent.push(id);return {accepted:true};}});
  assert.deepEqual(sent,[uuid(9)]);
  assert.equal(client.calls[0].args.expected_input_fingerprint,prepareScreening(ctx).fingerprint);
  assert.equal(client.calls[0].args.target_application,route.applicationId);
});
test('viewer, disabled AI, foreign tenant and draft CV cannot dispatch', async () => {
  for (const options of [{canEdit:false},{enabled:false},{route:{...route,companyId:uuid(99)}}]) {
    let sent = false; const client = clientFor(context());
    await assert.rejects(command(client,{...options,dispatch:async()=>{sent=true;return {accepted:true};}}));
    assert.equal(sent,false); assert.equal(client.calls.length,0);
  }
  const ctx = context();ctx.document.status='draft';
  await assert.rejects(command(clientFor(ctx)));
});
test('completed reuse does not dispatch; dispatch failures preserve saved job without exposing network detail', async () => {
  let sent = false;
  await command(clientFor(context(),{}, {execution_status:'completed',attempt_id:null}),{dispatch:async()=>{sent=true;}});
  assert.equal(sent,false);
  const result = await command(clientFor(context()),{dispatch:async()=>{throw Error('SECRET_INTERNAL_URL');}});
  assert.equal(result.saved,true);assert.match(result.message,/Ponów wysłanie/);assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('retry checks analysis scope and freshness before RPC, dispatching only returned attempt', async () => {
  const ctx=context(); const analysis={id:uuid(11),company_id:route.companyId,application_id:route.applicationId,recruitment_id:route.recruitmentId,execution_status:'failed',stale_at:null,input_fingerprint:prepareScreening(ctx).fingerprint};
  for (const change of [{company_id:uuid(99)},{stale_at:'now'},{input_fingerprint:'different'}]) {
    const client=clientFor(ctx,{screening_analysis_versions:{...analysis,...change}});
    await assert.rejects(command(client,{command:'retry',analysisId:analysis.id}));assert.equal(client.calls.length,0);
  }
  const client=clientFor(ctx,{screening_analysis_versions:analysis});
  await command(client,{command:'retry',analysisId:analysis.id});assert.equal(client.calls[0].name,'retry_screening_analysis');
});
function form(disposition='approved_with_changes') {
  const f=new FormData();f.set('disposition',disposition);f.set('confirmed','on');return f;
}
test('review requires human confirmation, exact UTF16 quotes and evidence for positive/negative assessments',()=>{
  const f=form();f.set(`change:${criterion.id}`,'on');f.set(`rating:${criterion.id}`,'meets');
  assert.throws(()=>readScreeningReview(f,[criterion],'📊 Tworzę raporty.'),/cytatu/);
  f.set(`quote:${criterion.id}:0`,'Tworzę raporty.');
  const result=readScreeningReview(f,[criterion],'📊 Tworzę raporty.');
  assert.deepEqual(result.overrides[0].evidence_override,[{start:3,end:18,quote:'Tworzę raporty.'}]);
  f.set(`quote:${criterion.id}:0`,'Wymyślony dowód');assert.throws(()=>readScreeningReview(f,[criterion],'📊 Tworzę raporty.'),/dokładnym/);
  f.delete('confirmed');assert.throws(()=>readScreeningReview(f,[criterion],''),/Potwierdź/);
});
test('unknown remains insufficient_data, corrections are separate and unscoped IDs are ignored',()=>{
  const f=form();f.set(`change:${criterion.id}`,'on');f.set(`rating:${criterion.id}`,'insufficient_data');f.set(`change:${uuid(99)}`,'on');
  const original=structuredClone(criterion);const result=readScreeningReview(f,[criterion],'');
  assert.equal(result.overrides.length,1);assert.equal(result.overrides[0].rating_override,'insufficient_data');assert.deepEqual(criterion,original);
  assert.equal(ratingLabels.insufficient_data,'Brak wystarczających danych');
  f.set('disposition','approved');assert.throws(()=>readScreeningReview(f,[criterion],''),/korekt/);
  assert.equal(readScreeningReview(form('needs_reanalysis'),[criterion],'').overrides.length,0);
});
test('changed or unavailable material makes existing result stale',()=>{
  const a={execution_status:'completed',input_fingerprint:'current',stale_at:null};
  assert.equal(screeningStatus(null),'ready');assert.equal(screeningStatus(a,'current'),'completed');
  for(const fingerprint of ['changed',undefined]) assert.equal(screeningStatus(a,fingerprint),'stale');
  assert.equal(screeningStatus({...a,stale_at:'now'},'current'),'stale');
});

// Render the real async Server Component with a scoped in-memory Supabase adapter.
// Replace framework-only navigation/auth and action controls, not page rendering logic.
async function renderPage({canEdit=true,stale=false,rating='insufficient_data',missing=false}={}) {
  const ctx=context();const id=uuid(11),reviewId=uuid(12);
  const analysis={id,company_id:route.companyId,application_id:route.applicationId,recruitment_id:route.recruitmentId,analysis_version:1,execution_status:'completed',input_fingerprint:prepareScreening(ctx).fingerprint,stale_at:stale?'now':null,input_cv_text_snapshot:ctx.document.redacted_text,latest_review_version:1,candidate_document_version:1};
  const client=clientFor(ctx,{screening_analysis_versions:[analysis],screening_criterion_results:[{...criterion,company_id:route.companyId,analysis_id:id,rating,evidence:rating==='meets'?[{start:3,end:18,quote:'Tworzę raporty.'}]:[]}],screening_result_reviews:[{id:reviewId,company_id:route.companyId,analysis_id:id,review_version:1,disposition:'approved_with_changes',review_note:'Sprawdzono'}],screening_criterion_review_overrides:[{company_id:route.companyId,review_id:reviewId,criterion_result_id:criterion.id,rating_override:'meets',evidence_override:[{quote:'Tworzę raporty.'}]}]});
  if (missing) ctx.application.id=uuid(999);
  const path='app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/screening/page.tsx';
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const require=createRequire(import.meta.url);const mod={exports:{}};
  const replacements={'next/link':({children,...props})=>React.createElement('a',props,children),'next/navigation':{notFound(){throw Error('404');}},'./screening.module.css':{},'./controls':{RefreshStatus:()=>null,AnalysisControl:({disabled})=>React.createElement('button',{disabled},'START'),ReviewControl:({stale})=>React.createElement('p',null,stale?'REANALYSIS_ONLY':'REVIEW_ALLOWED')}};
  const customRequire=name=> {
    if(Object.hasOwn(replacements,name)) return replacements[name];
    if(name.endsWith('/lib/company-access')) return {companyAccess:async()=>({client,canEdit})};
    if(name.endsWith('/lib/screening-dispatch')) return {screeningAiUserEnabled:()=>false};
    if(name.includes('/lib/')) return require(`../lib/${name.split('/lib/')[1]}.ts`);
    return require(name);
  };
  new Function('require','module','exports',code)(customRequire,mod,mod.exports);
  return renderToStaticMarkup(await mod.exports.default({params:Promise.resolve(route),searchParams:Promise.resolve({})}));
}
test('result UI renders unknown and original AI separately from human correction without numeric score',async()=>{
  const html=await renderPage();assert.match(html,/Brak wystarczających danych/);assert.match(html,/Korekta rekrutera/);assert.match(html,/Tworzę raporty/);assert.match(html,/REVIEW_ALLOWED/);assert.ok(!html.includes('0/'));assert.match(html,/disabled/);
});
test('viewer has no mutation controls and stale results cannot be approved in UI',async()=>{
  const viewer=await renderPage({canEdit:false});assert.ok(!viewer.includes('REVIEW_ALLOWED'));assert.ok(!viewer.includes('START'));
  const stale=await renderPage({stale:true,rating:'meets'});assert.match(stale,/Wynik nieaktualny/);assert.match(stale,/REANALYSIS_ONLY/);assert.ok(!stale.includes('REVIEW_ALLOWED'));
});

test('approved review requires no overrides; failed RPC never dispatches', async()=>{
  assert.deepEqual(readScreeningReview(form('approved'),[criterion],''),{disposition:'approved',note:null,overrides:[]});
  const client=clientFor(context());client.rpc=async()=>({data:null,error:{message:'internal error'}});
  let sent=false;await assert.rejects(command(client,{dispatch:async()=>{sent=true;return {accepted:true};}}),/Nie udało/);assert.equal(sent,false);
});


test('missing or RLS-hidden application renders 404 while query errors stay server failures', async()=>{
  await assert.rejects(renderPage({missing:true}), /404/);
  const ctx=context();ctx.application=null;
  await assert.rejects(loadScreeningContext(clientFor(ctx),route), ScreeningNotFoundError);
  const broken={from(){return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null,error:{message:'db failure'}})};}};
  await assert.rejects(loadScreeningContext(broken,route), error=>!(error instanceof ScreeningNotFoundError));
});

function loadUiModule(file, replacements) {
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const require=createRequire(import.meta.url), mod={exports:{}};
  const customRequire=name=>{
    if(Object.hasOwn(replacements,name)) return replacements[name];
    if(name.includes('/lib/')) return require(`../lib/${name.split('/lib/')[1]}.ts`);
    return require(name);
  };
  new Function('require','module','exports',code)(customRequire,mod,mod.exports);
  return mod.exports;
}
const screenDir='app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/screening/';

test('stale-tab review of superseded unchanged-input analysis never calls review RPC', async()=>{
  const ctx=context(), oldId=uuid(11);
  const common={company_id:route.companyId,application_id:route.applicationId,recruitment_id:route.recruitmentId,execution_status:'completed',stale_at:null,input_cv_text_snapshot:ctx.document.redacted_text};
  const client=clientFor(ctx,{screening_analysis_versions:[{...common,id:uuid(12),analysis_version:2},{...common,id:oldId,analysis_version:1}]});
  const actions=loadUiModule(screenDir+'actions.ts', {
    'next/cache':{revalidatePath(){}},
    '../../../../../../../../lib/company-access':{companyAccess:async()=>({client,canEdit:true})},
    '../../../../../../../../lib/screening-dispatch':{},
  });
  const f=form('approved');f.set('reviewVersion','1');
  const result=await actions.reviewAnalysis(route,oldId,{},f);
  assert.match(result.error,/zastąpiona/);assert.equal(client.calls.length,0);
});

test('review form retains latest disposition, note, rating, evidence and explanation corrections',()=>{
  const controls=loadUiModule(screenDir+'controls.tsx',{
    './actions':{reviewAnalysis:async()=>({}),startAnalysis:async()=>({}),retryAnalysis:async()=>({})},
    'next/navigation':{useRouter:()=>({refresh(){}})},
    'next/link':({children,...props})=>React.createElement('a',props,children),
  });
  const review={disposition:'approved_with_changes',review_note:'Zachowaj notatkę'};
  const override={criterion_result_id:criterion.id,rating_override:'meets',evidence_override:[{quote:'Tworzę raporty.'}],explanation_override:'Zweryfikowana korekta'};
  const html=renderToStaticMarkup(React.createElement(controls.ReviewControl,{route,analysisId:uuid(11),version:1,criteria:[criterion],stale:false,review,overrides:[override]}));
  assert.match(html,/value="approved_with_changes" selected/);
  assert.match(html,/checked=""/);
  const unselected=renderToStaticMarkup(React.createElement(controls.ReviewControl,{route,analysisId:uuid(11),version:1,criteria:[criterion],stale:false,review,overrides:[]}));
  assert.match(unselected, /<fieldset disabled=""><legend>Treść korekty/);assert.match(html,/value="meets" selected/);
  assert.match(html,/Tworzę raporty/);assert.match(html,/Zweryfikowana korekta/);assert.match(html,/Zachowaj notatkę/);
});
