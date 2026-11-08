import test from 'node:test';
import assert from 'node:assert/strict';
import {generateExerciseDraft} from '../lib/exercise-ai-generation.ts';
import {requestExerciseDraft} from '../lib/exercise-ai-provider.ts';
import {ExerciseAiError,exerciseDraftPayload} from '../lib/exercise-ai.ts';
const position={id:'position',updated_at:'2026-11-07T00:00:00Z',title:'Planista',tasks:['Planowanie'],required_competencies:['Planowanie'],kpis:[],required_behaviors:[],autonomy_level:2};
const input={position,company:null};
const output={title:'Plan',instructions:'Przygotuj plan działania.',expectedOutput:'Plan.',durationMinutes:20,criteria:[{competency:'Planowanie',below:'Pomija terminy.',meets:'Podaje terminy.',above:'Uwzględnia ryzyka.'}]};
const definition={kind:'competency_test',...output};
test('oversized ASCII, multibyte, per-field and aggregate input consume no reservation or provider call',async()=>{
 const cases=[
  {...input,position:{...position,description:'a'.repeat(2_000_000)}},
  {...input,position:{...position,description:'😀'.repeat(2501)}},
  {...input,position:{...position,tasks:['a'.repeat(2001)]}},
  {...input,position:{...position,tasks:Array(21).fill('Task')}},
  {...input,position:{...position,tasks:Array(20).fill('a'.repeat(1700))}},
  {...input,position:{...position,tasks:Array(20).fill('😀'.repeat(425))}},
  {...input,company:{description:'ą'.repeat(5001)}},
  // All raw fields fit; JSON and then the Responses user-content escaping expand.
  {...input,position:{...position,tasks:Array(15).fill('"'.repeat(1000))}},
 ];
 for(const candidate of cases){let reservations=0,calls=0;
  const result=await generateExerciseDraft(candidate,position,{reserve:async()=>{reservations++;return {status:'reserved',claimed:true};},provide:async()=>{calls++;return {definition};},finish:async()=>({status:'completed',exercise_id:'unexpected'})});
  assert.match(result.error,/Profil jest zbyt obszerny/);assert.equal(reservations,0);assert.equal(calls,0);
 }
});
test('provider boundary refuses an oversized complete request even when caller bypasses payload validation',async()=>{
 for(const value of ['a'.repeat(50_000),'😀'.repeat(13_000)]) {
  const payload=exerciseDraftPayload(input);payload.untrusted_position.description=value;
  let calls=0;await assert.rejects(requestExerciseDraft(payload,'synthetic-key',async()=>{calls++;return Response.json({});}),e=>e.code==='exercise_ai_input_too_large');assert.equal(calls,0);
 }
});
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
  assert.equal(calls,1);assert.ok(r.error);assert.equal(r.terminalFailure,true);assert.doesNotMatch(r.error,/secret/);
 }
 let calls=0;const r=await generateExerciseDraft(input,position,{reserve:async()=>({status:'reserved',claimed:true}),provide:async()=>{calls++;return {definition};},finish:async()=>{throw Error('response lost');}});
 assert.equal(calls,1);assert.match(r.error,/tym samym/);assert.equal(r.terminalFailure,undefined);
});
test('only confirmed failed state permits a new attempt; lost failure response recovers using the same key',async()=>{
 let calls=0,stored={status:'reserved',claimed:true};
 const deps={reserve:async()=>stored,provide:async()=>{calls++;throw new ExerciseAiError('exercise_ai_timeout','timeout');},
  finish:async()=>{stored={status:'failed',error:'exercise_ai_timeout',claimed:false};throw Error('lost response');}};
 const uncertain=await generateExerciseDraft(input,position,deps);assert.equal(uncertain.terminalFailure,undefined);
 const recovered=await generateExerciseDraft(input,position,deps);assert.equal(recovered.terminalFailure,true);assert.equal(calls,1);
 const concurrent=await generateExerciseDraft(input,position,{...deps,reserve:async()=>({status:'reserved',claimed:true}),finish:async()=>({status:'completed',exercise_id:'saved'})});
 assert.deepEqual(concurrent,{exerciseId:'saved'});
 const pending=await generateExerciseDraft(input,position,{reserve:async()=>({status:'reserved',claimed:false}),provide:()=>assert.fail('duplicate call')});
 assert.equal(pending.terminalFailure,undefined);
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
