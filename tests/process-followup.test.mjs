import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';
import * as domain from '../lib/process-followup.ts';
const id='11111111-1111-4111-8111-111111111111';
const observation={tasks:'Zrealizowano zadanie.',onboarding:'Szkolenie zakończone.',resources:'Dostęp do narzędzi.',support:'Mentor raz w tygodniu.',autonomy:'Samodzielne rozliczenia.',evidence:'Przegląd wykonanych zadań.',outcome:'met',probation:'passed',retained:'yes'};
const c={id,purpose:'post_hire',start_date:'2026-01-01',criteria:'Rozliczenie miesiąca w terminie.',initial_result:'Zadanie próbne zakończone.',can_manage:true,can_record:true,grants:[],observations:[]};
test('not measured is not a negative observation, zero is a measured rate',()=>{
 const missing=domain.followupRates([c],30);assert.equal(missing.probation.value,null);assert.equal(missing.probation.missing,1);
 const negative={...c,observations:[{id,checkpoint:30,recorded_at:'2026-02-01T00:00:00Z',body:{...observation,probation:'failed',retained:'no',outcome:'not_met'}}]};
 assert.equal(domain.followupRates([negative],30).probation.value,0);
 assert.equal(domain.followupRates([negative,c],30).retention.measured,1);
 assert.equal(domain.followupRates([{...negative,purpose:'promotion'}],30).probation.value,null,'internal assessments never enter post-hire denominators');
});
test('observation and snapshot validate Unicode, fields, purpose and calendar date',()=>{
 assert.equal(domain.parseObservation({...observation,evidence:'🦊'.repeat(2000)}).evidence.length,4000);
 for(const bad of [{...observation,outcome:'hire'},{...observation,evidence:''},{...observation,tasks:'🦊'.repeat(2001)}])assert.throws(()=>domain.parseObservation(bad));
 const f=new FormData();Object.entries({purpose:'promotion',start_date:'2026-01-01',criteria:c.criteria,initial_result:c.initial_result}).forEach(([k,v])=>f.set(k,v));
 assert.equal(domain.followupForm(f).purpose,'promotion');f.set('start_date','2026-02-30');assert.throws(()=>domain.followupForm(f));
 f.set('start_date','2026-01-01');f.set('criteria','short');assert.throws(()=>domain.followupForm(f));
});
test('read projection keeps purpose permissions and every recorded checkpoint',()=>{
 const state=domain.parseFollowupState({can_create:true,cases:[{...c,grants:[{user_id:id,allowed:false}],observations:[{id,checkpoint:30,recorded_at:'2026-02-01T00:00:00Z',body:observation}]}]});
 assert.equal(state.cases[0].observations[0].body.tasks,observation.tasks);assert.equal(state.cases[0].grants[0].allowed,false);
 assert.throws(()=>domain.parseFollowupState({can_create:true,cases:[{...c,can_record:'yes'}]}));
});
function loadAction(access,revalidated){
 const path=fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/followup/actions.ts',import.meta.url));
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m=new Module(path);m.filename=path;const require=createRequire(path);
 m.require=name=>name==='next/cache'?{revalidatePath:p=>revalidated.push(p)}:name.endsWith('company-access')?{companyAccess:async()=>access}:name.endsWith('process-followup')?domain:require(name);
 m._compile(compiled,path);return m.exports.saveFollowup;
}
const form=()=>{const f=new FormData();f.set('operation','record');f.set('case_id',id);f.set('checkpoint','30');Object.entries(observation).forEach(([k,v])=>f.set(k,v));return f;};
test('form-to-RPC observation flow binds route, case, purpose access and revalidation',async()=>{
 const calls=[],paths=[];const query={select(){return this},eq(){return this},async maybeSingle(){return {data:{id},error:null}}};
 const rpc=async(name,args)=>{calls.push({name,args});return name==='process_followup_read'?{data:{cases:[{id}]},error:null}:{data:id,error:null}};
 const save=loadAction({canEdit:true,client:{from:()=>query,rpc}},paths);
 assert.deepEqual(await save(id,id,id,{},form()),{saved:true});
 assert.equal(calls[1].name,'process_followup_record');assert.deepEqual(calls[1].args.observation,observation);assert.match(paths[0],/followup$/);
 const denied=loadAction({canEdit:false,client:{rpc}},[]);assert.ok((await denied(id,id,id,{},form())).error);assert.equal(calls.length,2);
 const unbound=loadAction({canEdit:true,client:{from:()=>query,rpc:async()=>({data:{cases:[]},error:null})}},[]);assert.ok((await unbound(id,id,id,{},form())).error);
});

test('panel renders the original criteria, later evidence and measured negative separately from missing',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {createElement}=await import('react');
 const file=fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/followup/page.tsx',import.meta.url));
 const result={can_create:false,cases:[{...c,can_manage:false,observations:[{id,checkpoint:30,recorded_at:'2026-02-01T00:00:00Z',body:{...observation,outcome:'not_met',probation:'failed',retained:'no'}}]}]};
 const query={select(){return this},eq(){return this},async maybeSingle(){return {data:{id},error:null}}};
 const client={from:()=>query,rpc:async()=>({data:result,error:null})};
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const mod=new Module(file);mod.filename=file;const require=createRequire(file);
 mod.require=name=>name==='next/link'?{default:({children,href})=>createElement('a',{href},children)}:name==='next/navigation'?{notFound(){throw Error('404')}}:name.endsWith('company-access')?{companyAccess:async()=>({client,canEdit:true})}:name.endsWith('process-followup')?domain:name==='./forms'?{FollowupForm:()=>null}:require(name);
 mod._compile(code,file);
 const html=renderToStaticMarkup(await mod.exports.default({params:Promise.resolve({companyId:id,recruitmentId:id,applicationId:id})}));
 assert.match(html,/Rozliczenie miesiąca w terminie/);assert.match(html,/Zadanie próbne zakończone/);assert.match(html,/Kryteria niespełnione/);assert.match(html,/Brak pomiaru — obserwacja nie została zapisana/);assert.match(html,/0% — 0\/1 zmierzonych/);assert.match(html,/Faktyczne zadania i ich wykonanie/);
});

test('recruitment rates validate scope and denominator; missing and unavailable never become zero',()=>{
 const raw={checkpoint:90,scope:'latest_authorized_post_hire_case_per_application',population:3,probation:{positive:1,measured:2,missing:1,rate:50},retention:{positive:0,measured:2,missing:1,rate:0}};
 const parsed=domain.parseRecruitmentFollowupMetrics(raw);assert.equal(parsed.probation.rate,50);assert.equal(parsed.retention.rate,0);assert.match(domain.recruitmentFollowupRateText(parsed.retention),/^0%/);
 assert.equal(domain.parseRecruitmentFollowupMetrics({...raw,scope:'all_employees'}),null);
 assert.equal(domain.parseRecruitmentFollowupMetrics({...raw,probation:{...raw.probation,missing:0}}),null);
 assert.equal(domain.parseRecruitmentFollowupMetrics({...raw,probation:{...raw.probation,rate:100}}),null);
 assert.match(domain.recruitmentFollowupRateText(null),/dane niedostępne/);
 assert.match(domain.recruitmentFollowupRateText({positive:0,measured:0,missing:3,rate:null}),/Brak pomiaru/);
});

test('recruitment diagnostics renders scoped 30/90/180 measurements without legacy placeholders',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');const {createElement}=await import('react');
 const diagnostics=await import('../lib/process-diagnostics.ts');const metrics=await import('../lib/process-metrics.ts');
 const file=fileURLToPath(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/diagnostyka/page.tsx',import.meta.url));
 const inflow={status:'open',days_open:100,started_at:'2026-01-01T00:00:00Z',start_source:'created_at',closed_at:null,total:3,last_7_days:0,last_14_days:0,last_30_days:0,last_application_at:'2026-01-02T00:00:00Z',weekly:[]};
 let activeMetricCalls=0;
 const calls=[];const client={from:table=>({select(){return this},eq(){return this},async maybeSingle(){return {data:table==='recruitments'?{id,name:'Syntetyczna rekrutacja',position_id:id}:{title:'Analityk',description:'Praca',tasks:[]},error:null}}}),rpc:async(name,args)=>{
  calls.push({name,args});if(name==='process_followup_recruitment_metrics'){assert.equal(activeMetricCalls,0,'NOWAIT-locking checkpoint RPCs must not overlap');activeMetricCalls++;await new Promise(resolve=>setTimeout(resolve,1));activeMetricCalls--;return {data:{checkpoint:args.checkpoint,scope:'latest_authorized_post_hire_case_per_application',population:3,probation:{positive:1,measured:2,missing:1,rate:50},retention:{positive:0,measured:2,missing:1,rate:0}},error:null};}
  return {data:null,error:null};
 }};
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const mod=new Module(file);mod.filename=file;const require=createRequire(file);
 mod.require=name=>name==='next/link'?{default:({children,href})=>createElement('a',{href},children)}:name==='next/navigation'?{notFound(){throw Error('404')}}:name.endsWith('company-access')?{companyAccess:async()=>({client,canEdit:true})}:name.endsWith('process-followup')?domain:name.endsWith('process-diagnostics')?{...diagnostics,parseDiagnosticsState:()=>({inflow,history:[],can_edit:true,latest_record_no:0})}:name.endsWith('process-metrics')?metrics:name==='./diagnostic-form'?{DiagnosticForm:()=>null}:require(name);
 mod._compile(code,file);const html=renderToStaticMarkup(await mod.exports.default({params:Promise.resolve({companyId:id,recruitmentId:id})}));
 assert.match(html,/50% \(1\/2 zmierzonych; 1 bez pomiaru\)/);assert.match(html,/0% \(0\/2 zmierzonych; 1 bez pomiaru\)/);assert.doesNotMatch(html,/system jeszcze nie zbiera|sprawdź tabelę dalszych obserwacji/);
 assert.deepEqual(calls.filter(c=>c.name==='process_followup_recruitment_metrics').map(c=>c.args.checkpoint),[30,90,180]);
 assert.ok(calls.filter(c=>c.name==='process_followup_recruitment_metrics').every(c=>c.args.target_company===id&&c.args.target_recruitment===id));
});
