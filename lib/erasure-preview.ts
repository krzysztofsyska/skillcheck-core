export const retentionClasses = {candidate:'Dane kandydata',assessment:'Oceny kompetencji',screening:'Analizy CV',communication:'Kontakt i zgody',audit:'Historia operacji',external:'Dostawcy zewnętrzni',backup:'Kopie zapasowe',exports:'Eksporty'} as const;
export const retentionTriggers = {record_created:'Utworzenie rekordu',process_closed:'Zamknięcie procesu',consent_revoked:'Wycofanie zgody'} as const;
export type RetentionRule = {data_class:keyof typeof retentionClasses;trigger_event:keyof typeof retentionTriggers;duration_days:number;hold_review_days:number};
export type Preview = {scope_kind:string;candidate_count:number;counts:Record<string,number>;blockers:string[];policy_revision:number;resolution_revision:number|null;manifest_hash:string;schema_signature:string;generated_at:string;expires_at:string};
export type RetentionState = {error?:string;saved?:string;preview?:Preview;revision?:number};
export function revision(value:FormDataEntryValue|null):number {const s=String(value??'');if(!/^\d{1,15}$/.test(s))throw Error('Odśwież stronę i spróbuj ponownie.');const n=Number(s);if(!Number.isSafeInteger(n))throw Error('Nieprawidłowa wersja.');return n;}
export function parseRules(form:FormData):RetentionRule[]{
 const rules:RetentionRule[]=[];
 for(const data_class of Object.keys(retentionClasses) as (keyof typeof retentionClasses)[]){
  if(form.get(`enabled_${data_class}`)!=='on')continue;
  const trigger=String(form.get(`trigger_${data_class}`));
  if(!(trigger in retentionTriggers))throw Error('Wybierz zdarzenie rozpoczynające okres.');
  const duration_days=revision(form.get(`duration_${data_class}`)),hold_review_days=revision(form.get(`hold_${data_class}`));
  if(duration_days<1||duration_days>999999||hold_review_days<1||hold_review_days>999999)throw Error('Podaj okresy od 1 do 999999 dni.');
  rules.push({data_class,trigger_event:trigger as RetentionRule['trigger_event'],duration_days,hold_review_days});
 }
 if(!rules.length)throw Error('Uzupełnij co najmniej jedną kategorię danych.');return rules;
}
export function parseSubject(form:FormData,anchor:string):string[]{
 if(form.get('confirmed')!=='on')throw Error('Potwierdź, że wybrane rekordy dotyczą tej samej osoby.');
 const ids=[anchor,...form.getAll('candidate_ids').map(String)];
 const unique=Array.from(new Set(ids));if(unique.length>100||unique.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw Error('Wybierz od 1 do 100 rekordów.');return unique;
}
export function parsePreview(value:unknown):Preview {
 if(!value||typeof value!=='object')throw Error('Podgląd jest niedostępny.');
 const p=value as Record<string,unknown>;
 if(!['candidate_record','confirmed_subject'].includes(String(p.scope_kind))||!Number.isInteger(p.candidate_count)||Number(p.candidate_count)<1||!p.counts||typeof p.counts!=='object'||Array.isArray(p.counts)||!Array.isArray(p.blockers)||p.blockers.some(x=>typeof x!=='string')||Object.values(p.counts).some(x=>typeof x!=='number'||!Number.isSafeInteger(x)||x<0)||typeof p.manifest_hash!=='string'||typeof p.schema_signature!=='string'||!Number.isInteger(p.policy_revision)||!(p.resolution_revision===null||Number.isInteger(p.resolution_revision))||!Number.isFinite(Date.parse(String(p.generated_at)))||!Number.isFinite(Date.parse(String(p.expires_at))))throw Error('Podgląd jest niedostępny.');
 return {scope_kind:String(p.scope_kind),candidate_count:Number(p.candidate_count),counts:p.counts as Record<string,number>,blockers:p.blockers as string[],policy_revision:Number(p.policy_revision),resolution_revision:p.resolution_revision as number|null,manifest_hash:p.manifest_hash,schema_signature:p.schema_signature,generated_at:String(p.generated_at),expires_at:String(p.expires_at)};
}
export const blockerLabels:Record<string,string>={external_inventory_unverified:'Nie potwierdzono kompletności danych u dostawców.',backup_policy_unverified:'Nie potwierdzono zasad dotyczących kopii zapasowych.',subject_resolution_required:'Najpierw potwierdź rekordy tej samej osoby.',subject_resolution_changed:'Zakres osoby zmienił się. Potwierdź go ponownie.',retention_policy_required:'Najpierw określ zasady przechowywania.',policy_owner_changed:'Właściciel firmy zmienił się. Zatwierdź zasady ponownie.',schema_dependency_unknown:'Wykryto zależność danych wymagającą dodatkowej obsługi.',contact_request_adapter_unknown:'Dane zgłoszeń kontaktowych wymagają dodatkowej obsługi.',active_screening:'Analiza CV nadal trwa.',shared_resolution_requires_adapter:'Powiązania wielu rekordów wymagają dodatkowej obsługi.',execution_not_implemented:'Wykonanie usunięcia nie jest jeszcze dostępne.',retention_policy_missing:'Nie skonfigurowano zasad przechowywania.',retention_policy_incomplete:'Zasady nie obejmują wszystkich kategorii danych.',subject_resolution_missing:'Najpierw potwierdź rekordy tej samej osoby.',active_legal_hold:'Dane są objęte wstrzymaniem usunięcia.',external_reconciliation_required:'Wymagane uzgodnienie danych u dostawców.',backup_retention_required:'Wymagane uwzględnienie kopii zapasowych.',exports_untracked:'Eksporty wymagają odrębnego sprawdzenia.'};
export function blockerLabel(code:string){return blockerLabels[code]??'Wymagane dodatkowe sprawdzenie przed usunięciem danych.';}
export function safeFailure(code?:string):string {return code==='PGRST202'||code==='42883'?'Podgląd retencji nie jest jeszcze dostępny w tym środowisku.':code==='PT409'?'Dane zmieniły się. Odśwież stronę i ponów czynność.':'Nie udało się wykonać czynności. Odśwież stronę i spróbuj ponownie.';}
export const previewCountLabels:Record<string,string>={
 'public.candidates':'Rekordy kandydata','public.candidate_documents':'Dokumenty CV','public.applications':'Zgłoszenia do rekrutacji','public.candidate_assessments':'Oceny kompetencji','public.behavior_assessment_entries':'Oceny zachowań','public.exercise_observation_entries':'Obserwacje ćwiczeń','public.screening_analysis_versions':'Wersje analizy CV','public.screening_analysis_attempts':'Próby analizy CV','public.screening_criterion_results':'Wyniki kryteriów','public.screening_result_reviews':'Weryfikacje wyników','public.screening_criterion_review_overrides':'Korekty kryteriów','public.recruitment_shortlist_entries':'Wpisy shortlisty','public.candidate_contact_permissions':'Zgody kontaktowe','public.candidate_contact_preferences':'Preferencje kontaktu','public.candidate_communications':'Zaproszenia','public.candidate_communication_events':'Historia zaproszeń','public.candidate_communication_approvals':'Zatwierdzenia zaproszeń','private.contact_audit':'Audyt kontaktu','private.contact_requests':'Operacje kontaktowe','private.candidate_verified_contact_receipts':'Dowody weryfikacji kontaktu','private.candidate_verified_contact_points':'Zaszyfrowane punkty kontaktowe','private.erasure_subject_resolutions':'Potwierdzenia zakresu osoby','private.erasure_configuration_requests':'Historia konfiguracji zakresu'
};
