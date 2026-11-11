import { readFile } from 'node:fs/promises';
import { activeBoot, hash } from './competency-active-fixture.mjs';
export { hash };
export const migration='20261106140000_exercise_ai_grant_guard.sql';
export const sql=()=>readFile(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8');
export const denied=(...codes)=>error=>codes.includes(error.code);
export async function guardBoot(t) {
 const e=await activeBoot(t,{fullChain:true,throughMigration:'20261106130000_exercise_ai_proposals.sql'});
 const record=async(f,client=e.db)=>client.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,20)',
  [f.recruitment.id,f.definitionId,JSON.stringify({provider:'synthetic',model:'fixture',prompt_version:'v1',
   payload_schema_version:1,result_schema_version:1,input_fingerprint:'a'.repeat(64),position_id:f.position.id,
   position_updated_at:f.position.updated_at})]);
 const install=async()=>{await e.h.asAdmin();await e.db.exec(await sql());};
 const approve=async f=>{await e.h.asUser(f.owner);await e.db.query('select exercise_ai.approve_proposal($1)',[f.definitionId]);};
 return {...e,record,install,approve};
}
