import {retentionClasses,revision,requestKey} from './erasure-preview';
export type RetentionMode='suggest_only'|'automatic';
export type SchedulerActionState={error?:string;saved?:string};
export const schedulerClasses=Object.keys(retentionClasses) as (keyof typeof retentionClasses)[];
export function delegationInput(form:FormData){
 const mode=String(form.get('execution_mode'));
 if(mode!=='suggest_only'&&mode!=='automatic')throw Error('Wybierz sposób obsługi retencji.');
 const policy_revision=revision(form.get('policy_revision')),expected_revision=revision(form.get('expected_revision'));
 const max_batch=revision(form.get('max_batch'));
 if(policy_revision<1)throw Error('Najpierw zatwierdź kompletną politykę retencji.');
 if(max_batch<1||max_batch>100)throw Error('Podaj limit od 1 do 100 osób na przebieg.');
 if(form.get('confirmed')!=='on')throw Error('Potwierdź zasady działania harmonogramu.');
 const classes=form.getAll('data_classes').map(String);
 if(mode==='automatic'&&(form.get('automatic_confirmed')!=='on'||classes.length!==schedulerClasses.length||new Set(classes).size!==schedulerClasses.length||schedulerClasses.some(c=>!classes.includes(c))))throw Error('Automatyczne zatwierdzanie wymaga osobnej zgody i wskazania wszystkich ośmiu kategorii danych.');
 return {execution_mode:mode as RetentionMode,policy_revision,expected_revision,max_batch,data_classes:schedulerClasses,request_key:requestKey(form)};
}
export function schedulerFailure(code?:string){return code==='PT409'?'Konfiguracja lub dane zmieniły się albo warunki uruchomienia nie są spełnione. Odśwież monitor przed ponowieniem.':code==='PGRST202'||code==='42883'?'Harmonogram retencji nie jest jeszcze dostępny w tym środowisku.':'Nie udało się potwierdzić zmiany. Odśwież monitor i spróbuj ponownie.';}
export const schedulerBlockerLabels:Record<string,string>={
 active_purpose:'Dane są nadal potrzebne do aktywnego procesu.',delegation_changed:'Delegacja zmieniła się. Odśwież ocenę.',canonical_event_missing:'Brakuje potwierdzonego zdarzenia rozpoczynającego retencję.',retention_not_due:'Okres przechowywania jeszcze nie upłynął.',shared_subject:'Zakres osoby wymaga uzgodnienia z innymi rekordami.',execution_not_provisioned_or_busy:'Wykonawca nie jest gotowy albo zakres jest zajęty.',hold_requires_review:'Wstrzymanie wymaga przeglądu właściciela.',active_screening:'Analiza jest nadal w toku.',retention_policy_incomplete:'Polityka nie obejmuje wszystkich ośmiu kategorii.',subject_resolution_changed:'Potwierdzenie rekordów osoby zmieniło się.',retention_scope_busy:'Zakres jest obecnie zajęty.',
 scheduler_disabled:'Harmonogram nie jest uruchomiony w tym środowisku.',execution_disabled:'Wykonawca usuwania nie jest uruchomiony.',execution_not_configured:'Wykonanie usunięcia wymaga konfiguracji.',execution_not_provisioned:'Wykonawca usuwania nie został przygotowany.',
 policy_required:'Brak zatwierdzonej polityki retencji.',policy_changed:'Polityka zmieniła się. Zatwierdź delegację ponownie.',policy_incomplete:'Polityka nie obejmuje wszystkich ośmiu kategorii.',owner_changed:'Właściciel zmienił się. Wymagane nowe zatwierdzenie.',delegation_revoked:'Delegacja została wycofana.',delegation_required:'Nie zapisano delegacji właściciela.',
 restore_isolated:'Trwa izolowane odtwarzanie danych.',external_inventory_unverified:'Nie potwierdzono kompletności danych u dostawców.',backup_policy_unverified:'Nie potwierdzono okresów kopii i pozostałych zasobów.',active_hold:'Usunięcie jest wstrzymane.',active_process:'Proces rekrutacyjny nadal trwa.',subject_resolution_required:'Rekordy osoby wymagają potwierdzenia.',scheduler_lag:'Przebieg harmonogramu jest opóźniony.'
};
export function schedulerBlocker(code:string){return schedulerBlockerLabels[code]??'Wymagane dodatkowe sprawdzenie warunków retencji.';}
export type RetentionSchedule={revision:number;delegation_id:string|null;policy_revision:number|null;execution_mode:RetentionMode;max_batch:number;revoked:boolean;owner_current:boolean;authorization_enabled:boolean;production_ready:false;blockers:string[];last_tick_at:string|null;suggestions:number;authorized:number;holds:number|null;blocked:number|null;lag_seconds:number|null;oldest_pending_at:string|null;expired_leases:number|null};
const natural=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
export function parseSchedule(value:unknown):RetentionSchedule{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid schedule');const p=value as Record<string,unknown>;
 if(!natural(p.revision)||!(natural(p.policy_revision)||p.revision===0&&p.policy_revision===null)||!natural(p.max_batch)||p.max_batch<1||p.max_batch>100||!['suggest_only','automatic'].includes(String(p.execution_mode))||typeof p.revoked!=='boolean'||typeof p.owner_current!=='boolean'||typeof p.authorization_enabled!=='boolean'||p.production_ready!==false||!Array.isArray(p.blockers)||p.blockers.some(x=>typeof x!=='string')||!natural(p.suggestions)||!natural(p.authorized)||!(p.delegation_id===null||typeof p.delegation_id==='string'&&/^[0-9a-f-]{36}$/i.test(p.delegation_id))||!(p.last_tick_at===null||typeof p.last_tick_at==='string'&&Number.isFinite(Date.parse(p.last_tick_at))))throw Error('Invalid schedule');
 for(const field of ['holds','blocked','lag_seconds','expired_leases'])if(p[field]!==undefined&&p[field]!==null&&!natural(p[field]))throw Error('Invalid monitor');
 if(p.oldest_pending_at!==undefined&&p.oldest_pending_at!==null&&(typeof p.oldest_pending_at!=='string'||!Number.isFinite(Date.parse(p.oldest_pending_at))))throw Error('Invalid monitor');
 return {revision:p.revision,delegation_id:p.delegation_id as string|null,policy_revision:p.policy_revision as number|null,execution_mode:p.execution_mode as RetentionMode,max_batch:p.max_batch,revoked:p.revoked,owner_current:p.owner_current,authorization_enabled:p.authorization_enabled,production_ready:false,blockers:p.blockers as string[],last_tick_at:p.last_tick_at as string|null,suggestions:p.suggestions,authorized:p.authorized,holds:p.holds as number??null,blocked:p.blocked as number??null,lag_seconds:p.lag_seconds as number??null,expired_leases:p.expired_leases as number??null,oldest_pending_at:p.oldest_pending_at as string??null};
}
export function currentPolicy(value:unknown):{revision:number;complete:boolean}{
 if(!value||typeof value!=='object'||Array.isArray(value))return {revision:0,complete:false};const p=value as Record<string,unknown>;
 if(!natural(p.revision)||!Array.isArray(p.rules))return {revision:0,complete:false};
 const classes=p.rules.map(r=>r&&typeof r==='object'?(r as Record<string,unknown>).data_class:null);
 if(p.oldest_pending_at!==undefined&&p.oldest_pending_at!==null&&(typeof p.oldest_pending_at!=='string'||!Number.isFinite(Date.parse(p.oldest_pending_at))))throw Error('Invalid monitor');
 return {revision:p.revision,complete:p.configured===true&&p.owner_current===true&&p.revision>0&&classes.length===8&&new Set(classes).size===8&&schedulerClasses.every(c=>classes.includes(c))};
}

export type RetentionSuggestion={id:string;anchor_candidate_id:string;status:'suggested'|'blocked'|'authorized';due_at:string|null;blockers:string[];created_at:string;request_id:string|null};
const validUuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export function parseSuggestions(value:unknown):RetentionSuggestion[]{
 if(!Array.isArray(value)||value.length>25)throw Error('Invalid suggestions');
 return value.map(row=>{if(!row||typeof row!=='object'||!validUuid(row.id)||!validUuid(row.anchor_candidate_id)||!['suggested','blocked','authorized'].includes(row.status)||!Array.isArray(row.blockers)||row.blockers.some((b:unknown)=>typeof b!=='string')||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at))||!(row.due_at===null||typeof row.due_at==='string'&&Number.isFinite(Date.parse(row.due_at)))||!(row.request_id===null||validUuid(row.request_id)))throw Error('Invalid suggestion');return {id:row.id,anchor_candidate_id:row.anchor_candidate_id,status:row.status,due_at:row.due_at,blockers:row.blockers,created_at:row.created_at,request_id:row.request_id};});
}
