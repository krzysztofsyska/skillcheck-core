import {parsePreview,type Preview} from './erasure-preview';
export type Ticket = Preview & {preview_ticket_id:string};
export type ErasureStatus = {request_id:string;status:'authorized'|'cancelled';generation:number;scope_kind:string;candidate_count:number;created_at:string;cancelled_at:string|null;execution_enabled:false;phase:'local_frozen'|'cancelled';blockers:string[];can_cancel:boolean};
export type LifecycleState = {error?:string;ticket?:Ticket;requestId?:string;saved?:string};
export function uuid(value:unknown):string {if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw Error('Odśwież stronę i spróbuj ponownie.');return value;}
export function parseTicket(value:unknown):Ticket {const p=parsePreview(value);return {...p,preview_ticket_id:uuid((value as Record<string,unknown>).preview_ticket_id)};}
export function parseStatus(value:unknown):ErasureStatus {
 if(!value||typeof value!=='object')throw Error('Status jest niedostępny.');const s=value as Record<string,unknown>;
 uuid(s.request_id);
 if(!['authorized','cancelled'].includes(String(s.status))||!['candidate_record','confirmed_subject'].includes(String(s.scope_kind))||!Number.isSafeInteger(s.generation)||Number(s.generation)<1||!Number.isSafeInteger(s.candidate_count)||Number(s.candidate_count)<1||!Number.isFinite(Date.parse(String(s.created_at)))||!(s.cancelled_at===null||Number.isFinite(Date.parse(String(s.cancelled_at))))||s.execution_enabled!==false||!Array.isArray(s.blockers)||s.blockers.some(b=>typeof b!=='string')||typeof s.can_cancel!=='boolean'||s.phase!==(s.status==='authorized'?'local_frozen':'cancelled')||(s.status==='cancelled'&&s.can_cancel))throw Error('Status jest niedostępny.');
 return s as ErasureStatus;
}
export function lifecycleFailure(code?:string){return code==='PGRST202'||code==='42883'?'Obsługa żądań nie jest jeszcze dostępna w tym środowisku.':code==='PT409'?'Dane lub uprawnienia zmieniły się albo podgląd wygasł. Odśwież status i przygotuj nowy podgląd.':'Nie udało się wykonać czynności. Sprawdź status przed ponowieniem.';}

export function canAuthorizeTicket(ticket:Ticket):boolean {
 const executionOnly=new Set(['execution_not_implemented','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution']);
 return ticket.blockers.every(blocker=>executionOnly.has(blocker)||(blocker==='subject_resolution_required'&&ticket.scope_kind==='candidate_record'));
}
