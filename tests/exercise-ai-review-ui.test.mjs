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

