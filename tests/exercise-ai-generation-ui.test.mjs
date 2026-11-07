import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Module,createRequire} from 'node:module';
import ts from 'typescript';
import * as generation from '../lib/exercise-ai-generation.ts';
import * as contract from '../lib/exercise-ai.ts';
const base='app/dashboard/[companyId]/recruitments/[recruitmentId]/';
const companyId='aaaaaaaa-1111-4222-8333-444444444444',recruitmentId='bbbbbbbb-1111-4222-8333-444444444444',requestKey='cccccccc-1111-4222-8333-444444444444';
const stamp='2026-11-07T00:00:00Z';
function load(file,mocks){const absolute=fileURLToPath(new URL('../'+file,import.meta.url)),m=new Module(absolute),req=createRequire(absolute);
 m.filename=absolute;m.paths=Module._nodeModulePaths(fileURLToPath(new URL('../',import.meta.url)));m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:req(id);
 m._compile(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,absolute);return m.exports;}
async function run(options={}){
 const oldFlag=process.env.EXERCISE_AI_ENABLED,oldKey=process.env.OPENAI_API_KEY;
 process.env.EXERCISE_AI_ENABLED=options.flag??'true';process.env.OPENAI_API_KEY=options.key??'synthetic-only';
 const calls=[],rpc=[];const position={id:'position',updated_at:stamp,title:'Planista',tasks:['Plan'],required_competencies:['Planowanie'],kpis:[],required_behaviors:[]};
 const client={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null,error:null})}),rpc:async(name,args)=>{
  calls.push(name);rpc.push(args);if(options.rpcError)return {data:null,error:{code:options.rpcError,message:'private'}};
  return {error:null,data:name.startsWith('reserve')?{status:'reserved',claimed:options.claimed??true}:{status:'completed',exercise_id:'saved'}};
 }};
 const mod=load(base+'exercise-generation-action.ts',{'next/cache':{revalidatePath:()=>calls.push('revalidate')},
 '../../../../../lib/exercise-context':{exerciseUuid:/^[a-f0-9-]{36}$/i,exerciseContext:async()=>{calls.push('access');return {client,canEdit:options.canEdit??true,editable:true,position,base:'/exercises'};}},
 '../../../../../lib/exercise-ai':contract,'../../../../../lib/exercise-ai-generation':generation,
 '../../../../../lib/exercise-ai-provider':{requestExerciseDraft:async(payload,key)=>{assert.equal(key,'synthetic-only');calls.push('provider');assert.equal(payload.untrusted_company,null);return {definition:{kind:'competency_test',title:'Plan'}};}},
 });
 const form=new FormData();if(options.confirm!==false)form.set('confirm','yes');
 try{return {result:await mod.generateExerciseProposal(companyId,recruitmentId,requestKey,options.stamp??stamp,null,{},form),calls,rpc};}
 finally {if(oldFlag===undefined)delete process.env.EXERCISE_AI_ENABLED;else process.env.EXERCISE_AI_ENABLED=oldFlag;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
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
