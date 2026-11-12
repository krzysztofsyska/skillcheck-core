import { randomUUID } from 'node:crypto';
import { acBoot, users } from './assessment-center-active-fixture.mjs';
import { hrbpCaseTemplate } from '../../lib/assessment-center-session-template.ts';
export { users, hrbpCaseTemplate };
export const sessionMigration = '20261112120000_sc_ac_session_inventory_r16.sql';
export const sessionRollback = '20261112120000_sc_ac_session_inventory_r16_down.sql';
export const sessionSignature = 'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8';
export const sessionTables = ['private.ac_sessions','private.ac_session_stages','private.ac_session_finalists','private.ac_reconciliations','private.ac_session_entries'];
export const candidateTables = ['private.ac_session_finalists','private.ac_reconciliations','private.ac_session_entries'];
export const sessionRpcs = ['ac_session_create','ac_session_add_stage','ac_session_remove_last_stage','ac_session_add_finalist','ac_session_remove_finalist','ac_session_set_status','ac_session_assign_pair',
 'ac_record_reconciliation','ac_confirm_reconciliation','ac_session_record_entry','ac_session_find','ac_session_read'];
// Synthetic observations only. `ratings` overrides single criteria by index.
export const sheetFor = (definition,ratings={}) => definition.criteria.map((_,criterionIndex) => {
 const rating = ratings[criterionIndex] ?? 'meets';
 return rating==='insufficient_data' ? {criterionIndex,rating,evidence:'',context:''}
  : {criterionIndex,rating,evidence:`Syntetyczna obserwacja kryterium ${criterionIndex+1}.`,context:'Etap sesji AC.'};
});
export const work = label => `Syntetyczna praca finalisty: ${label}. Opis przyczyn, kosztu i planu działań.`;

export async function sessionBoot(t, options = {}) {
 const e = await acBoot(t,{throughMigration:sessionMigration,...options});
 const {h,call} = e;
 // Another shortlisted candidate in the SAME recruitment of the owner's company.
 const finalist = (owner=users.owner) => e.seed({owner,shortlist:true});
 const saveDefinition = (f,definition) => call('public.save_exercise_definition',
  [f.recruitment.id,randomUUID(),JSON.stringify(definition),0,f.position.id,f.position.updated_at]);
 const plan = async (f,{template=hrbpCaseTemplate,stages=template.stages,competencies=template.plannedCompetencies}={}) => {
  await h.asUser(f.owner);
  const sessionId = await call('public.ac_session_create',[f.recruitment.id,template.title,competencies]);
  const saved = [];
  for (const stage of stages) saved.push(await addStage(f,sessionId,stage));
  return {sessionId,stages:saved};
 };
 const addStage = async (f,sessionId,stage) => {
  const definitionId = await saveDefinition(f,stage.definition);
  return {...stage,definitionId,id:await call('public.ac_session_add_stage',[sessionId,stage.type,stage.title,definitionId,stage.counterpartBrief])};
 };
 const addFinalist = (sessionId,f) => call('public.ac_session_add_finalist',[sessionId,f.application.id]);
 const setStatus = (sessionId,status) => call('public.ac_session_set_status',[sessionId,status]);
 const assign = (sessionId,stage,f,first=f.owner,second=users.recruiter) =>
  call('public.ac_session_assign_pair',[sessionId,stage.id,f.application.id,first,second]);
 const submit = (pairId,sheet,client) => call('public.ac_submit_sheet',[pairId,JSON.stringify(sheet)],client);
 const reconcile = (pairId,items,client) => call('public.ac_record_reconciliation',[pairId,JSON.stringify(items)],client);
 const confirm = (pairId,verdict='confirmed',note=null,client) => call('public.ac_confirm_reconciliation',[pairId,verdict,note],client);
 const record = (sessionId,f,stage,kind,body,client) =>
  call('public.ac_session_record_entry',[sessionId,f.application.id,stage?.id??null,kind,JSON.stringify(body)],client);
 const read = sessionId => call('public.ac_session_read',[sessionId]);
 const find = f => call('public.ac_session_find',[f.recruitment.id]);
 return {...e,finalist,saveDefinition,plan,addStage,addFinalist,setStatus,assign,submit,reconcile,confirm,record,read,find};
}
