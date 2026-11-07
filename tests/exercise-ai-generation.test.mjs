import test from 'node:test';
import assert from 'node:assert/strict';
import {generateExerciseDraft} from '../lib/exercise-ai-generation.ts';
import {requestExerciseDraft} from '../lib/exercise-ai-provider.ts';
import {ExerciseAiError,exerciseDraftPayload} from '../lib/exercise-ai.ts';
const position={id:'position',updated_at:'2026-11-07T00:00:00Z',title:'Planista',tasks:['Planowanie'],required_competencies:['Planowanie'],kpis:[],required_behaviors:[],autonomy_level:2};
const input={position,company:null};
const output={title:'Plan',instructions:'Przygotuj plan działania.',expectedOutput:'Plan.',durationMinutes:20,criteria:[{competency:'Planowanie',below:'Pomija terminy.',meets:'Podaje terminy.',above:'Uwzględnia ryzyka.'}]};
const definition={kind:'competency_test',...output};
test('generation commits reservation before one call, stores provenance and replays without provider I/O',async()=>{
 let stored=null,calls=0;const order=[];
 const deps={reserve:async()=>{order.push('reserve');return stored??{status:'reserved',claimed:true};},provide:async()=>{order.push('provide');calls++;return {definition};},
 finish:async(f,d,p,error)=>{order.push('finish');assert.equal(error,null);assert.equal(p.input_fingerprint,f);assert.equal(p.position_id,position.id);assert.deepEqual(d,definition);stored={status:'completed',exercise_id:'saved'};return stored;}};
 assert.deepEqual(await generateExerciseDraft(input,position,deps),{exerciseId:'saved'});assert.deepEqual(order,['reserve','provide','finish']);
 assert.deepEqual(await generateExerciseDraft(input,position,deps),{exerciseId:'saved'});assert.equal(calls,1);
});
test('incomplete input, refused reservation, in-progress and failure replay never call provider',async()=>{
 for(const reserve of [async()=>{throw Error('private SQL');},async()=>({status:'reserved',claimed:false}),async()=>({status:'failed',error:'exercise_ai_timeout',claimed:false})]) {
  const r=await generateExerciseDraft(input,position,{reserve,provide:()=>assert.fail('provider'),finish:()=>assert.fail('finish')});assert.ok(r.error);assert.doesNotMatch(r.error,/private SQL/);
 }
 await generateExerciseDraft({position:{...position,tasks:[]},company:null},position,{reserve:()=>assert.fail('reserve')});
});
test('timeout/refusal is persisted and completion uncertainty never retries a billed call',async()=>{
 for(const code of ['exercise_ai_timeout','exercise_ai_refusal','exercise_ai_network_error']) {
  let calls=0;const r=await generateExerciseDraft(input,position,{reserve:async()=>({status:'reserved',claimed:true}),
   provide:async()=>{calls++;throw new ExerciseAiError(code,'secret provider details');},finish:async(f,d,p,e)=>{assert.equal(e,code);assert.equal(d,null);assert.equal(p,null);return {status:'failed',error:e};}});
  assert.equal(calls,1);assert.ok(r.error);assert.doesNotMatch(r.error,/secret/);
 }
 let calls=0;const r=await generateExerciseDraft(input,position,{reserve:async()=>({status:'reserved',claimed:true}),provide:async()=>{calls++;return {definition};},finish:async()=>{throw Error('response lost');}});
 assert.equal(calls,1);assert.match(r.error,/tym samym/);
});
test('provider uses existing structured Responses contract, no storage, no retry and bounded output',async()=>{
 let calls=0;
 const result=await requestExerciseDraft(exerciseDraftPayload(input),'synthetic-key',async(url,options)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');assert.equal(body.model,'gpt-5.4-mini-2026-03-17');
  assert.doesNotMatch(options.body,/candidate|application_id/);
  return Response.json({status:'completed',output_text:JSON.stringify(output)});
 });assert.equal(result.definition.kind,'competency_test');assert.equal(calls,1);
 for(const status of [401,429,500]) {calls=0;await assert.rejects(requestExerciseDraft(exerciseDraftPayload(input),'synthetic-key',async()=>{calls++;return new Response('secret',{status});}),ExerciseAiError);assert.equal(calls,1);}
 await assert.rejects(requestExerciseDraft(exerciseDraftPayload(input),'synthetic-key',async()=>new Response('x'.repeat(800001))),e=>e.code==='exercise_ai_invalid_output');
 await assert.rejects(requestExerciseDraft(exerciseDraftPayload(input),'synthetic-key',async()=>Response.json({status:'completed',output:[{type:'refusal'}]})),e=>e.code==='exercise_ai_refusal');
});
