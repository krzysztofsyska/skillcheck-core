import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Module, createRequire } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as reviewHelpers from '../lib/exercise-ai-review.ts';
import * as definitionHelpers from '../lib/exercise-definition.ts';
import * as contextIdentity from '../lib/exercise-context-identity.ts';

const ids={company:'aaaaaaaa-1111-4222-8333-444444444444',recruitment:'bbbbbbbb-1111-4222-8333-444444444444',exercise:'cccccccc-1111-4222-8333-444444444444',definition:'dddddddd-1111-4222-8333-444444444444'};
const stamp='2026-11-06T10:00:00+00:00';
const context={recruitmentId:ids.recruitment,exerciseId:ids.exercise,definitionId:ids.definition,positionUpdatedAt:stamp};
const entry={id:ids.definition,company_id:ids.company,recruitment_id:ids.recruitment,exercise_id:ids.exercise,version:2,
 position_id:'eeeeeeee-1111-4222-8333-444444444444',position_updated_at:stamp,created_at:stamp,author_id:'owner',
 definition:{title:'Zapisana propozycja',kind:'competency_test',instructions:'<script>unsafe</script>',expectedOutput:'Plan działania',durationMinutes:20,
 criteria:[{competency:'Planowanie',below:'Pomija cel',meets:'Podaje plan',above:'Uwzględnia ryzyka'}]},
 position_snapshot:{title:'Historyczny profil',description:'Zapisane wymagania',tasks:['Plan'],kpis:[],required_competencies:['Planowanie'],required_behaviors:[],autonomy_level:2}};
const proposal=()=>({definitionEntry:structuredClone(entry),proposal:{id:'ffffffff-1111-4222-8333-444444444444',provenance:{model:'model-fixture',input_fingerprint:'a'.repeat(64)},createdBy:'owner',createdAt:stamp,approvedBy:null,approvedAt:null,approvalMode:null}});
const basePath='app/dashboard/[companyId]/recruitments/[recruitmentId]/';
function load(file,mocks) {
 const absolute=fileURLToPath(new URL('../'+file,import.meta.url)),mod=new Module(absolute),req=createRequire(absolute);
 mod.filename=absolute;mod.paths=Module._nodeModulePaths(fileURLToPath(new URL('../',import.meta.url)));
 mod.require=id=>Object.hasOwn(mocks,id)?mocks[id]:req(id);
 mod._compile(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,absolute);
 return mod.exports;
}
async function withFlag(flag,fn) {const previous=process.env.EXERCISE_AI_ENABLED;process.env.EXERCISE_AI_ENABLED=flag;
 try{return await fn();}finally{if(previous===undefined)delete process.env.EXERCISE_AI_ENABLED;else process.env.EXERCISE_AI_ENABLED=previous;}}
function access(options={}) {
 const calls=[];const result=options.result??{data:proposal(),error:null};
 const client={rpc:async(name,args)=>{calls.push({name,args});return name==='read_exercise_ai_proposal'?result:(options.approveResult??{data:'ffffffff-1111-4222-8333-444444444444',error:null});},
 from(table){const query={select(){return query;},eq(){return query;},order(){return query;},limit(){return query;},lt(){return query;},maybeSingle:async()=>({data:entry,error:null}),
 then(resolve,reject){return Promise.resolve({data:[entry],error:null}).then(resolve,reject);}};return query;}};
 return {calls,value:{client,canEdit:options.canEdit??true,editable:options.editable??true,base:'/dashboard/'+ids.company+'/recruitments/'+ids.recruitment+'/exercises',
 position:{id:entry.position_id,updated_at:'2026-11-07T11:00:00Z',title:'New current profile'},user:{id:'owner'}}};
}
async function render(options={}) {
 const a=access(options),forms=[];
 const mod=load(basePath+'exercises/[exerciseId]/page.tsx',{
 'next/link':{default:({children,...props})=>createElement('a',props,children)},
 'next/navigation':{notFound:()=>{throw Error('not found');}},
 '../../../../../../../lib/exercise-context':{exerciseContext:async()=>a.value,exerciseUuid:/^[a-f0-9-]{36}$/i},
 '../../../../../../../lib/behavior-assessment':{parseHistoryBefore:()=>null,behaviorSchemaMissing:()=>false},
 '../../../../../../../lib/exercise-ai-review':reviewHelpers,
 '../../exercise-form':{ExerciseForm:props=>createElement('div',{[props.aiContext?'data-ai-editor':'data-manual']:'yes'},'Editor')},
 '../../exercise-ai-approval':{ExerciseAiRejection:()=>createElement('div',{'data-rejection':'yes'},'Reject'),ExerciseAiApproval:props=>{forms.push(props);return createElement('div',{'data-approval':'yes'},'Approval');}},
 });
 const html=await withFlag(options.flag??'true',async()=>renderToStaticMarkup(await mod.default({params:Promise.resolve({companyId:ids.company,recruitmentId:ids.recruitment,exerciseId:ids.exercise}),searchParams:Promise.resolve({})})));
 return {html,forms,calls:a.calls};
}
test('C6 UI shows exact historical task/profile and approval context, escapes text and suppresses manual editing',async()=>{
 const r=await render();
 assert.match(r.html,/Historyczny profil/);assert.match(r.html,/Zapisana propozycja/);
 assert.match(r.html,/&lt;script&gt;unsafe/);assert.doesNotMatch(r.html,/<script>/);
 assert.doesNotMatch(r.html,/New current profile|data-manual/);assert.match(r.html,/model-fixture/);
 assert.match(r.html,/Propozycja przygotowana przez AI/);assert.match(r.html,/Zapisany profil stanowiska: Historyczny profil/);
 assert.match(r.html,/Wersja profilu z dnia/);assert.match(r.html,/Narzędzie użyte do przygotowania propozycji/);
 assert.doesNotMatch(r.html,/input_fingerprint|prompt_version|payload_schema_version/);
 assert.equal(r.forms.length,1);assert.deepEqual(r.forms[0].context,context);
 assert.deepEqual(r.calls,[{name:'read_exercise_ai_proposal',args:{target_company:ids.company,target_recruitment:ids.recruitment,target_definition:ids.definition}}]);
});
test('C6 flag off and viewer preserve existing manual/read-only views without new RPC',async()=>{
 for(const flag of ['false','TRUE','']) {const r=await render({flag});assert.equal(r.calls.length,0);assert.match(r.html,/data-manual/);assert.equal(r.forms.length,0);}
 const r=await render({canEdit:false,editable:false});assert.equal(r.calls.length,0);assert.doesNotMatch(r.html,/data-manual|data-approval/);
});
test('C6 absent proposal permits manual editor; RPC errors and mismatched review fail closed',async()=>{
 const missing=await render({result:{data:null,error:{code:'PT404'}}});assert.match(missing.html,/data-manual/);
 for(const result of [{data:null,error:{code:'PGRST202',message:'private detail'}},{data:null,error:null},
 {data:{...proposal(),definitionEntry:{...entry,id:ids.exercise}},error:null}]) {
 const r=await render({result});assert.match(r.html,/Nie udało się sprawdzić/);assert.doesNotMatch(r.html,/private detail|data-manual|data-approval/);
 }
});
test('C6 closed workflow and approval modes never offer another approval',async()=>{
 const closed=await render({editable:false});assert.match(closed.html,/Zatwierdzanie jest zamknięte/);assert.equal(closed.forms.length,0);
 for(const mode of ['manual','auto']) {const p=proposal();Object.assign(p.proposal,{approvalMode:mode,approvedBy:'owner',approvedAt:stamp});
 const r=await render({result:{data:p,error:null}});assert.equal(r.forms.length,0);assert.match(r.html,mode==='auto'?/bez potwierdzenia przeczytania/:/zatwierdzona przez rekrutera/);}
});
async function action(options={},form=new FormData(),ctx=context) {
 const a=access(options),revalidated=[];
 const mod=load(basePath+'exercise-ai-actions.ts',{
 'next/cache':{revalidatePath:(...args)=>revalidated.push(args)},
 '../../../../../lib/exercise-context':{exerciseContext:async()=>a.value},
 '../../../../../lib/exercise-ai-review':reviewHelpers,
 '../../../../../lib/exercise-definition':definitionHelpers,
 // SC-METHOD binding after approval/correction is tested in tests/method-profile.test.mjs.
 '../../../../../lib/method-binding':{bindMethodToDefinitions:async()=>{}},
 });
 const result=await withFlag(options.flag??'true',()=>mod.approveExerciseAiProposal(ids.company,ctx,{},form));
 return {result,calls:a.calls,revalidated};
}
const confirmed=()=>{const f=new FormData();f.set('confirm','yes');return f;};
test('C6 approval requires explicit single confirmation, valid context, flag and editable membership',async()=>{
 for(const form of [new FormData(),(()=>{const f=confirmed();f.append('confirm','yes');return f;})()]) {const r=await action({},form);assert.ok(r.result.error);assert.equal(r.calls.length,0);}
 for(const options of [{flag:'false'},{canEdit:false},{editable:false}]) {const r=await action(options,confirmed());assert.ok(r.result.error);assert.equal(r.calls.length,0);}
 const r=await action({},confirmed(),{...context,definitionId:'../other'});assert.ok(r.result.error);assert.equal(r.calls.length,0);
});
test('C6 approval sends exact scoped IDs and snapshot timestamp then revalidates',async()=>{
 const r=await action({},confirmed());assert.deepEqual(r.result,{approved:true});
 assert.deepEqual(r.calls[1],{name:'approve_exercise_ai_proposal',args:{target_company:ids.company,target_recruitment:ids.recruitment,target_definition:ids.definition,expected_position_updated_at:stamp}});
 assert.deepEqual(r.revalidated,[[access().value.base,'layout']]);
});
test('C6 approval rejects wrong scope/exercise/revision and stale snapshot before write',async()=>{
 for(const field of ['id','company_id','recruitment_id','exercise_id','position_updated_at']) {
 const p=proposal();p.definitionEntry[field]=field==='position_updated_at'?'2020-01-01T00:00:00Z':'00000000-1111-4222-8333-444444444444';
 const r=await action({result:{data:p,error:null}},confirmed());assert.ok(r.result.error);assert.equal(r.calls.length,1);assert.equal(r.revalidated.length,0);
 }
});
test('C6 action sanitizes read/approve errors and preserves retry instead of claiming approval',async()=>{
 for(const code of ['PT409','42501','55000','unexpected']) {
 const r=await action({approveResult:{data:null,error:{code,message:'secret detail'}}},confirmed());
 assert.ok(r.result.error);assert.doesNotMatch(r.result.error,/secret detail/);assert.equal(r.revalidated.length,0);
 }
 const r=await action({result:{data:null,error:{code:'PGRST202',message:'secret detail'}}},confirmed());assert.equal(r.calls.length,1);assert.doesNotMatch(r.result.error,/secret detail/);
});

test('C6 rejected proposal shows reason and history, offers a new correction but never approval/rejection again',async()=>{
 const p=proposal();p.proposal.provenance.workflow={state:'rejected',reason:'Brak szczegółów'};
 const r=await render({result:{data:p,error:null}});assert.match(r.html,/Brak szczegółów/);assert.match(r.html,/data-ai-editor/);
 assert.doesNotMatch(r.html,/data-approval|data-rejection/);assert.match(r.html,/Odrzucona:/);
});

async function mutation(name,options={},form=new FormData(),ctx=context) {
 const a=access(options),revalidated=[];
 const mod=load(basePath+'exercise-ai-actions.ts',{'next/cache':{revalidatePath:(...args)=>revalidated.push(args)},
 '../../../../../lib/exercise-context':{exerciseContext:async()=>a.value},'../../../../../lib/exercise-ai-review':reviewHelpers,
 '../../../../../lib/exercise-definition':definitionHelpers,
 '../../../../../lib/method-binding':{bindMethodToDefinitions:async()=>{}},});
 const args=[ids.company,ctx,...(name==='editExerciseAiProposal'?[stamp]:[]),{},form];
 const result=await withFlag(options.flag??'true',()=>mod[name](...args));return {result,calls:a.calls,revalidated};
}
const definitionForm=()=>{const f=new FormData();for(const [key,value] of Object.entries(entry.definition)){
 if(key==='criteria')for(const criterion of value)for(const [k,v] of Object.entries(criterion))f.append(k,v);else f.set(key,String(value));}return f;};
const rejectionForm=()=>{const f=new FormData();f.set('reason','Niepełne kryteria');return f;};
test('C6 edits/rejections validate inputs, flag and role before scoped RPC and sanitize failures',async()=>{
 for(const [name,form] of [['editExerciseAiProposal',definitionForm],['rejectExerciseAiProposal',rejectionForm]]){
  for(const options of [{flag:'false'},{canEdit:false},{editable:false}]){const r=await mutation(name,options,form());assert.ok(r.result.error);assert.equal(r.calls.length,0);}
  const invalid=await mutation(name,{},new FormData());assert.ok(invalid.result.error);assert.equal(invalid.calls.length,0);
  const invalidContext=await mutation(name,{},form(),{...context,definitionId:'../other'});assert.ok(invalidContext.result.error);assert.equal(invalidContext.calls.length,0);
  const good=await mutation(name,{},form());assert.equal(good.calls.length,1);assert.equal(good.calls[0].args.target_company,ids.company);
  assert.equal(good.calls[0].args.target_definition,ids.definition);assert.equal(good.calls[0].args.expected_position_updated_at,stamp);
  assert.equal(good.revalidated.length,1);assert.ok(name.startsWith('edit')?good.result.entryId:good.result.rejected);
  for(const code of ['PT409','55000','42501']){const r=await mutation(name,{approveResult:{data:null,error:{code,message:'secret detail'}}},form());assert.ok(r.result.error);assert.doesNotMatch(r.result.error,/secret detail/);assert.equal(r.revalidated.length,0);}
 }
});


// R1-SWITCH: przełącznik „Zatwierdzam zadania sam" / „Automatycznie".
function switchClient(result) {
 const calls=[];return {calls,client:{rpc:async(name,args)=>{calls.push({name,args});return result;}}};
}
async function autoReleaseAction(options={},mode='auto') {
 const {calls,client}=switchClient(options.result??{data:mode==='auto',error:null}),revalidated=[];
 const mod=load(basePath+'exercise-ai-auto-release-action.ts',{
 'next/cache':{revalidatePath:(...args)=>revalidated.push(args)},
 '../../../../../lib/exercise-context':{exerciseContext:async()=>({client,canEdit:options.canEdit??true,editable:options.editable??true})},
 '../../../../../lib/exercise-ai-review':reviewHelpers,
 });
 const form=new FormData();for(const value of [].concat(mode??[])) form.append('mode',value);
 const result=await withFlag(options.flag??'true',()=>mod.setExerciseAiAutoRelease(ids.company,ids.recruitment,{},form));
 return {result,calls,revalidated};
}
test('R1-SWITCH action requires the flag, one valid mode and editable owner/recruiter before any RPC',async()=>{
 for(const mode of [null,'yes',['auto','manual']]) {const r=await autoReleaseAction({},mode);assert.ok(r.result.error);assert.equal(r.calls.length,0);}
 for(const options of [{flag:'false'},{flag:'TRUE'},{canEdit:false},{editable:false}]) {const r=await autoReleaseAction(options);assert.ok(r.result.error);assert.equal(r.calls.length,0);assert.equal(r.revalidated.length,0);}
});
test('R1-SWITCH action sends exact scoped IDs to the public RPC and revalidates the recruitment',async()=>{
 for(const [mode,enabled] of [['auto',true],['manual',false]]) {
 const r=await autoReleaseAction({},mode);assert.deepEqual(r.result,{autoRelease:enabled});
 assert.deepEqual(r.calls,[{name:'set_exercise_ai_auto_release',args:{target_company:ids.company,target_recruitment:ids.recruitment,enabled}}]);
 assert.deepEqual(r.revalidated,[['/dashboard/'+ids.company+'/recruitments/'+ids.recruitment,'layout']]);
 }
});
test('R1-SWITCH action maps database errors to plain Polish without details and never claims success',async()=>{
 const cases=[[{code:'42501',message:'private detail'},/uprawnień/],[{code:'55000'},/zamknięta/],[{code:'XX000',message:'private detail'},/Nie udało się/]];
 for(const [error,text] of cases) {const r=await autoReleaseAction({result:{data:null,error}});assert.match(r.result.error,text);
 assert.doesNotMatch(r.result.error,/private detail/);assert.equal(r.result.autoRelease,undefined);assert.equal(r.revalidated.length,0);}
 const mismatch=await autoReleaseAction({result:{data:false,error:null}},'auto');assert.ok(mismatch.result.error);
});
async function renderSwitch(options={}) {
 const {calls,client}=switchClient(options.result??{data:true,error:null}),rendered=[];
 const mod=load(basePath+'exercise-ai-auto-release-section.tsx',{
 './exercise-ai-auto-release':{ExerciseAiAutoReleaseSwitch:props=>{rendered.push(props);return createElement('div',{'data-switch':'yes'},'Switch');}},
 });
 const element=await withFlag(options.flag??'true',()=>mod.ExerciseAiAutoReleaseSection({client,companyId:ids.company,recruitmentId:ids.recruitment,canEdit:options.canEdit??true,editable:true}));
 return {element,calls,rendered};
}
test('R1-SWITCH section is hidden behind the flag and for viewers, reads the mode through the public RPC',async()=>{
 for(const options of [{flag:'false'},{flag:''},{canEdit:false}]) {const r=await renderSwitch(options);assert.equal(r.element,null);assert.equal(r.calls.length,0);}
 const r=await renderSwitch();assert.deepEqual(r.calls,[{name:'read_exercise_ai_settings',args:{target_company:ids.company,target_recruitment:ids.recruitment}}]);
 renderToStaticMarkup(r.element);assert.equal(r.rendered[0].current,true);
 for(const result of [{data:null,error:{code:'42501'}},{data:'true',error:null}]) {const failed=await renderSwitch({result});renderToStaticMarkup(failed.element);assert.equal(failed.rendered[0].current,null);}
});
test('R1-SWITCH form shows both modes, current state, R1 note and promises no candidate send',async()=>{
 const mod=load(basePath+'exercise-ai-auto-release.tsx',{'./exercise-ai-auto-release-action':{setExerciseAiAutoRelease:async()=>({})}});
 const html=renderToStaticMarkup(createElement(mod.ExerciseAiAutoReleaseSwitch,{companyId:ids.company,recruitmentId:ids.recruitment,current:false,editable:true}));
 assert.match(html,/Zatwierdzam zadania sam/);assert.match(html,/Automatycznie/);assert.match(html,/Obecny tryb: <strong>Zatwierdzam zadania sam/);
 assert.match(html,/<input[^>]*checked=""[^>]*value="manual"/);assert.doesNotMatch(html,/<input[^>]*checked=""[^>]*value="auto"/);
 assert.match(html,/tylko kandydat z krótkiej listy/);assert.match(html,/niczego nie wysyła kandydatom/);
 assert.doesNotMatch(html,/wyśl[ea]my|zostanie wysłan|wysyłamy/i);
 const closed=renderToStaticMarkup(createElement(mod.ExerciseAiAutoReleaseSwitch,{companyId:ids.company,recruitmentId:ids.recruitment,current:null,editable:false}));
 assert.match(closed,/Nie udało się odczytać obecnego trybu/);assert.match(closed,/<fieldset disabled/);
});
test('R1-SWITCH code uses the user RLS client only and imports no mail, send or service-role code',()=>{
 for(const file of ['exercise-ai-auto-release-action.ts','exercise-ai-auto-release.tsx','exercise-ai-auto-release-section.tsx']) {
 const source=readFileSync(fileURLToPath(new URL('../'+basePath+file,import.meta.url)),'utf8');
 assert.doesNotMatch(source,/service_role|SERVICE_ROLE|createAdminClient|supabase\/admin|resend|nodemailer|sendMail|send-?mail|outbound|\bfetch\(/i,file);
 }
 const page=readFileSync(fileURLToPath(new URL('../'+basePath+'exercises/page.tsx',import.meta.url)),'utf8');
 assert.match(page,/<ExerciseAiAutoReleaseSection client=\{client\}[^>]*canEdit=\{canEdit\} editable=\{editable\}\/>/);
});
async function renderExercisesPage(contextValue) {
 const sections=[];
 const mod=load(basePath+'exercises/page.tsx',{
 'next/link':{default:props=>createElement('a',{href:props.href},props.children)},
 'next/navigation':{notFound(){throw new Error('notFound');}},
 '../../../../../../lib/exercise-context':{exerciseContext:async()=>contextValue,exerciseUuid:/^[a-f0-9-]{36}$/i},
 '../../../../../../lib/behavior-assessment':{behaviorSchemaMissing:()=>false},
 '../exercise-generation-form':{ExerciseGenerationForm:()=>null},
 '../exercise-ai-auto-release-section':{ExerciseAiAutoReleaseSection:props=>{sections.push(props);return null;}},
 });
 const html=await withFlag('true',async()=>renderToStaticMarkup(await mod.default({params:Promise.resolve({companyId:ids.company,recruitmentId:ids.recruitment}),searchParams:Promise.resolve({})})));
 return {sections,html};
}
test('R1-SWITCH page passes the full editable from exerciseContext (archived position closes the switch even for an open recruitment)',async()=>{
 const base={client:{from:()=>listQuery()},canEdit:true,base:'/exercises',recruitment:{name:'Rekrutacja',status:'open'},position:{updated_at:stamp,status:'archived'}};
 function listQuery(){const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},gt(){return q;},maybeSingle:async()=>({data:null,error:null}),
 then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);}};return q;}
 const archived=await renderExercisesPage({...base,editable:false});
 assert.equal(archived.sections.length,1);assert.equal(archived.sections[0].editable,false);assert.equal(archived.sections[0].canEdit,true);
 assert.doesNotMatch(archived.html,/Utwórz zadanie/);
 const active=await renderExercisesPage({...base,editable:true,position:{updated_at:stamp,status:'active'}});
 assert.equal(active.sections[0].editable,true);
});
test('R1-SWITCH exerciseContext marks an archived position as not editable for an open recruitment',async()=>{
 const position=status=>({id:'eeeeeeee-1111-4222-8333-444444444444',company_id:ids.company,status,updated_at:stamp});
 async function context(positionStatus,recruitmentStatus='open'){
  const rows={recruitments:{id:ids.recruitment,company_id:ids.company,position_id:'eeeeeeee-1111-4222-8333-444444444444',status:recruitmentStatus},positions:position(positionStatus)};
  const client={from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:rows[table],error:null})};return q;}};
  const mod=load('lib/exercise-context.ts',{
  'next/navigation':{notFound(){throw new Error('notFound');}},
  './company-access':{companyAccess:async()=>({client,canEdit:true})},
  './exercise-context-identity':contextIdentity,
  });
  return mod.exerciseContext(ids.company,ids.recruitment);
 }
 assert.equal((await context('archived')).editable,false);
 assert.equal((await context('active')).editable,true);
 assert.equal((await context('active','closed')).editable,false);
});
test('R1-SWITCH is not rendered on the recruitment page (the payment-named test renders it with a fixed mock map)',()=>{
 const page=readFileSync(fileURLToPath(new URL('../'+basePath+'page.tsx',import.meta.url)),'utf8');
 assert.doesNotMatch(page,/ExerciseAiAutoRelease/);
});
