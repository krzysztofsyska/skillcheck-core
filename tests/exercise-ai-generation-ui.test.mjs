import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Module,createRequire} from 'node:module';
import ts from 'typescript';
import {createElement} from 'react';
import * as generation from '../lib/exercise-ai-generation.ts';
import * as contract from '../lib/exercise-ai.ts';
import * as budgetGate from '../lib/exercise-ai-budget.ts';
const base='app/dashboard/[companyId]/recruitments/[recruitmentId]/';
const companyId='aaaaaaaa-1111-4222-8333-444444444444',recruitmentId='bbbbbbbb-1111-4222-8333-444444444444',requestKey='cccccccc-1111-4222-8333-444444444444';
const stamp='2026-11-07T00:00:00Z';
function load(file,mocks){const absolute=fileURLToPath(new URL('../'+file,import.meta.url)),m=new Module(absolute),req=createRequire(absolute);
 m.filename=absolute;m.paths=Module._nodeModulePaths(fileURLToPath(new URL('../',import.meta.url)));m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:req(id);
 m._compile(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,absolute);return m.exports;}
async function run(options={}){
 const oldFlag=process.env.EXERCISE_AI_ENABLED,oldKey=process.env.OPENAI_API_KEY,oldGateway=process.env.AI_GATEWAY_ENABLED;
 let writerArgs=null,budgetArgs=null;
 if(options.gateway)process.env.AI_GATEWAY_ENABLED='true';else delete process.env.AI_GATEWAY_ENABLED;
 process.env.EXERCISE_AI_ENABLED=options.flag??'true';process.env.OPENAI_API_KEY=options.key??'synthetic-only';
 const calls=[],rpc=[];const position={id:'position',updated_at:stamp,title:'Planista',tasks:['Plan'],required_competencies:['Planowanie'],kpis:[],required_behaviors:[]};
 const client={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null,error:null})}),rpc:async(name,args)=>{
  calls.push(name);rpc.push(args);if(options.rpcError)return {data:null,error:{code:options.rpcError,message:'private'}};
  return {error:null,data:name.startsWith('reserve')?{status:'reserved',claimed:options.claimed??true}:{status:'completed',exercise_id:'saved'}};
 }};
 const mod=load(base+'exercise-generation-action.ts',{'next/cache':{revalidatePath:()=>calls.push('revalidate')},
 '../../../../../lib/exercise-context':{exerciseUuid:/^[a-f0-9-]{36}$/i,exerciseContext:async()=>{calls.push('access');return {client,canEdit:options.canEdit??true,editable:true,position,base:'/exercises'};}},
 '../../../../../lib/exercise-ai':contract,
 // SC-METHOD binding after a completed generation is tested in tests/method-profile.test.mjs.
 '../../../../../lib/method-binding':{bindMethodToDefinitions:async()=>{}},
 '../../../../../lib/ai-gateway/contract':{isAiGatewayEnabled:value=>value==='true'},
 '../../../../../lib/ai-ledger-writer':{exerciseLedgerWriterFromEnv:(...args)=>{writerArgs=args;return options.writer??null;},
  exerciseBudgetFromEnv:(...args)=>{budgetArgs=args;return options.budget??null;}},
 '../../../../../lib/exercise-ai-budget':budgetGate,'../../../../../lib/exercise-ai-generation':generation,
 '../../../../../lib/exercise-ai-provider':{requestExerciseDraft:async(payload,key,fetcher,trust)=>{assert.equal(key,'synthetic-only');calls.push('provider');
  const {recordAttempt,reserveBudget,...trusted}=trust;
  if(options.gateway){assert.equal(recordAttempt,options.writer);assert.deepEqual(writerArgs,[companyId,recruitmentId]);
   assert.equal(reserveBudget,options.budget.reserve);assert.deepEqual(budgetArgs,[companyId,recruitmentId]);}
  else {assert.equal(recordAttempt,null);assert.equal(reserveBudget,null);}
  assert.equal(fetcher,fetch);assert.deepEqual(trusted,{companyId,operationId:requestKey,recruitmentId,mayGenerate:true});assert.equal(payload.untrusted_company,null);
  return {definition:{kind:'competency_test',title:'Plan'}};}},
 });
 const form=new FormData();if(options.confirm!==false)form.set('confirm','yes');
 try{return {result:await mod.generateExerciseProposal(companyId,recruitmentId,requestKey,options.stamp??stamp,null,{},form),calls,rpc};}
 finally {if(oldFlag===undefined)delete process.env.EXERCISE_AI_ENABLED;else process.env.EXERCISE_AI_ENABLED=oldFlag;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;
  if(oldGateway===undefined)delete process.env.AI_GATEWAY_ENABLED;else process.env.AI_GATEWAY_ENABLED=oldGateway;}
}
test('generation action gates disabled/viewer/consent/configuration/stale profile before reservation and provider',async()=>{
 for(const o of [{flag:'false'},{canEdit:false},{confirm:false},{key:''},{stamp:'stale'}]){const r=await run(o);assert.ok(r.result.error);assert.ok(!r.calls.includes('provider'));assert.equal(r.rpc.length,0);}
});
test('generation action binds scoped reservation and completion, consumes once and sanitizes quota/errors',async()=>{
 const r=await run();assert.deepEqual(r.calls,['access','reserve_exercise_ai_generation','provider','finish_exercise_ai_generation','revalidate']);assert.equal(r.result.exerciseId,'saved');
 for(const args of r.rpc){assert.equal(args.target_company,companyId);assert.equal(args.target_recruitment,recruitmentId);assert.equal(args.request_key,requestKey);assert.match(args.input_fingerprint,/^[a-f0-9]{64}$/);}
 assert.equal(r.rpc[1].new_provenance.position_updated_at,stamp);
 const replay=await run({claimed:false});assert.ok(replay.result.error);assert.ok(!replay.calls.includes('provider'));
 for(const code of ['PT429','PT409','42501']){const failed=await run({rpcError:code});assert.ok(failed.result.error);assert.doesNotMatch(failed.result.error,/private/);assert.ok(!failed.calls.includes('provider'));}
});
test('form preserves recovery key and rotates/reset only on an explicit confirmed-failure new-attempt click',()=>{
 let activeKey=requestKey,state={},pending=false;const bindings=[];
 const mod=load(base+'exercise-generation-form.tsx',{
  react:{createElement,useState:initial=>[activeKey,value=>{activeKey=value;}],useActionState:(action,initial)=>{bindings.push({action,initial});return [state,action,pending];}},
  'next/link':{default:()=>null},'./exercise-generation-action':{generateExerciseProposal:()=>assert.fail('render/click must not call provider action')},
 });
 const props={companyId,recruitmentId,requestKey,positionStamp:stamp,companyStamp:null};
 const children=node=>Array.isArray(node)?node.flatMap(children):node&&typeof node==='object'?[node,...children(node.props?.children)]:[];
 const render=()=>{const wrapper=mod.ExerciseGenerationForm(props);return {wrapper,nodes:children(wrapper.type(wrapper.props))};};
 for(const current of [{},{error:'uncertain'},{error:'already reserved'}]){state=current;const r=render();assert.equal(r.wrapper.key,requestKey);assert.equal(r.nodes.some(n=>n.type==='button'&&n.props.type==='button'),false);}
 state={error:'failed',terminalFailure:true};let r=render();assert.equal(activeKey,requestKey);
 const next=r.nodes.find(n=>n.type==='button'&&n.props.type==='button');assert.ok(next);assert.equal(next.props.disabled,false);
 assert.equal(r.nodes.find(n=>n.type==='fieldset').props.disabled,true);
 pending=true;r=render();assert.equal(r.nodes.find(n=>n.type==='button'&&n.props.type==='button').props.disabled,true);pending=false;
 next.props.onClick();assert.notEqual(activeKey,requestKey);assert.match(activeKey,/^[0-9a-f-]{36}$/);
 state={};r=render();assert.equal(r.wrapper.key,activeKey);assert.equal(r.nodes.find(n=>n.type==='fieldset').props.disabled,undefined);
 const consent=r.nodes.find(n=>n.type==='input');assert.equal(consent.props.defaultChecked,undefined);assert.equal(consent.props.checked,undefined);
 assert.deepEqual(bindings.at(-1).initial,{});assert.equal(r.nodes.some(n=>n.type==='button'&&n.props.type==='button'),false);
});
test('SC-021-B: with the gateway on, generation needs the server-only ledger writer and refuses before reserving without it',async()=>{
 const missing=await run({gateway:true});
 assert.match(missing.result.error,/Rejestr kosztów AI/);assert.deepEqual(missing.calls,['access']);assert.equal(missing.rpc.length,0);
 const writer=async()=>{};
 const noBudget=await run({gateway:true,writer});
 assert.match(noBudget.result.error,/Rejestr kosztów AI/);assert.deepEqual(noBudget.calls,['access']);
 const budgetLog=[];
 const budget={reserve:async key=>{budgetLog.push(['reserve',key]);return {allowed:true,created:true};},release:async key=>{budgetLog.push(['release',key]);}};
 const ok=await run({gateway:true,writer,budget});
 assert.deepEqual(ok.calls,['access','reserve_exercise_ai_generation','provider','finish_exercise_ai_generation','revalidate']);
 assert.ok(!ok.calls.includes('record_exercise_ai_attempt'),'the recruiter session never writes the ledger');
 assert.deepEqual(budgetLog,[['reserve',requestKey],['release',requestKey]]);
});
test('SC-021-C: over budget, generation is refused with a Polish message before the draft slot is reserved',async()=>{
 const writer=async()=>{};
 for(const [answer,pattern] of [[{allowed:false,code:'budget_exceeded'},/limit kosztów AI Twojej firmy został wyczerpany/],
  [{allowed:false,code:'budget_unconfigured'},/nie jest ustawiony/]]){
  const log=[];
  const r=await run({gateway:true,writer,budget:{reserve:async()=>{log.push('reserve');return answer;},release:async()=>{log.push('release');}}});
  assert.match(r.result.error,pattern);assert.match(r.result.error,/Nie zużyto próby AI/);
  assert.deepEqual(r.calls,['access']);assert.equal(r.rpc.length,0);assert.deepEqual(log,['reserve']);
 }
});
