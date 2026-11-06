import { randomUUID } from 'node:crypto';
import { activeBoot, users } from './competency-active-fixture.mjs';
export { users };
export const acMigration = '20261106120000_sc_ac_inventory_r13.sql';
export const acSignature = 'de6b8172a272c6933ea39da4374a1206cb857ecabae218714c1d90d50d7d2889';
export const acDefinition = () => ({kind:'assessment_center',title:'Symulacja rozmowy',instructions:'Wyjaśnij zgłoszenie klienta',expectedOutput:'Rozwiązanie problemu',durationMinutes:20,
 criteria:[{competency:'Komunikacja',below:'Przerywa',meets:'Słucha',above:'Podsumowuje'},
 {competency:'Analiza',below:'Pomija problem',meets:'Bada problem',above:'Sprawdza przyczyny'}]});
export const acSheet = () => [{criterionIndex:0,rating:'meets',evidence:'Zadał otwarte pytanie.',context:'Rozmowa z klientem.'},
 {criterionIndex:1,rating:'insufficient_data',evidence:'',context:''}];
export async function acBoot(t, options = {}) {
 const e = await activeBoot(t,{...options,fullChain:true});
 const {h,db,call}=e;
 const seed = async options => {
  const f=await e.seed({shortlist:false,...options});
  await h.asUser(f.owner);
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter') on conflict(company_id,user_id) do nothing",[f.companyId,users.recruiter]);
  f.competencyDefinitionId=f.definitionId;
  f.definition=acDefinition();
  f.definitionId=await call('public.save_exercise_definition',[f.recruitment.id,randomUUID(),JSON.stringify(f.definition),0,f.position.id,f.position.updated_at]);
  return f;
 };
 const assign = async (f,first=f.owner,second=users.recruiter) => call('public.ac_assign_pair',[f.application.id,f.definitionId,first,second]);
 const submit = async (id,sheet=acSheet()) => call('public.ac_submit_sheet',[id,JSON.stringify(sheet)]);
 const read = async id => call('public.ac_read_pair',[id]);
 const find = async f => call('public.ac_find_pair',[f.application.id,f.definitionId]);
 return {...e,seed,assign,submit,read,find};
}
