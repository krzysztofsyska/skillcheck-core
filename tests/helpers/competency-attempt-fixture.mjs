import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {bootRetention} from './voice-retention-fixture.mjs';
import {users} from './screening-ranking-fixture.mjs';
export {users};
export const hash=value=>createHash('sha256').update(value).digest();
export const definition=(durationMinutes=60)=>({kind:'competency_test',title:'Poufny tytuł zadania',instructions:'Zaproponuj plan fikcyjnego wdrożenia.',expectedOutput:'Plan z uzasadnieniem.',durationMinutes,criteria:[{competency:'Planowanie',below:'Pomija terminy.',meets:'Ustala terminy.',above:'Sprawdza zależności.'},{competency:'Komunikacja',below:'Pomija odbiorcę.',meets:'Podaje odbiorcę.',above:'Sprawdza zrozumienie.'}]});
export const observations=[{criterionIndex:0,rating:'meets',evidence:'Plan'},{criterionIndex:1,rating:'insufficient_data',evidence:''}];
export const b2Tables=['private.competency_test_grants','private.competency_test_grant_events','public.competency_test_attempts','private.competency_test_sessions','private.competency_test_drafts','public.competency_test_review_entries','private.competency_test_cancellations'];
export async function boot(t,{embedded=process.env.COMPETENCY_TEST_ENGINE==='pglite',retention=true,beforeWithdrawal}={}) {
 const env=await bootRetention(t,{embedded});const {db,h}=env;
 await h.asAdmin();
 await db.exec(await readFile(new URL('../../docs/prototypes/sc-019-mvp-credits.sql',import.meta.url),'utf8'));
 for(const name of ['validation','attempts','withdrawal',...(retention?['retention']:[])]) {
  if(name==='withdrawal'&&beforeWithdrawal)await beforeWithdrawal(db,h);
  await db.exec(await readFile(new URL(`../../db/isolated/sc014-b2-${name}.sql`,import.meta.url),'utf8'));
 }
 const call=async(name,args=[],client=db)=>{
  assert.match(name,/^(public|private)\.[a-z_]+$/);
  return (await client.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 };
 const asGateway=async(client=db)=>{await client.exec('reset role;set role competency_test_gateway');await client.query("select set_config('request.jwt.claim.sub','',false)");};
 const seed=async({tenant,owner=users.owner,duration=60}={})=>{
  const f=tenant?await h.candidate(tenant):await h.seed(owner);
  await h.asUser(f.owner);
  const id=await call('public.save_exercise_definition',[f.recruitment.id,randomUUID(),JSON.stringify(definition(duration)),0,f.position.id,f.position.updated_at]);
  return {...f,definitionId:id,definition:definition(duration)};
 };
 const issue=async(f,{key=randomUUID(),startBy=new Date(Date.now()+3600000).toISOString()}={})=>{
  await h.asUser(f.owner);
  return {...await call('public.create_competency_test_grant',[f.application.id,f.definitionId,startBy,key]),key,startBy};
 };
 const exchange=async(g)=>{await asGateway();return call('private.exchange_candidate_competency_test_session',[g.token]);};
 const started=async(options)=>{const f=await seed(options),g=await issue(f),s=await exchange(g);const a=await call('private.start_candidate_competency_test',[hash(s.session),randomUUID()]);return {f,g,s,a};};
 const submitted=async(options)=>{const r=await started(options);const receipt=await call('private.submit_candidate_competency_test',[hash(r.s.session),JSON.stringify({workSample:'Plan wdrożenia obejmuje terminy i komunikację.'}),randomUUID()]);return {...r,receipt};};
 return {...env,call,asGateway,seed,issue,exchange,started,submitted};
}
