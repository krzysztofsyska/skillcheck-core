import {parsePreview,type Preview} from './erasure-preview';
export type Ticket = Preview & {preview_ticket_id:string};
export type ErasureStatus = {request_id:string;status:'authorized'|'cancelled'|'erasing'|'active_data_erased';generation:number;scope_kind:string;candidate_count:number;created_at:string;cancelled_at:string|null;execution_enabled:false;phase:'local_frozen'|'authorized'|'cancelled'|'erasing'|'active_data_erased'|'cancellation_pending'|'ledger_pending';blockers:string[];can_cancel:boolean;ledger_sequence?:number;pending_phase?:string|null;local_purged?:boolean};
export type LifecycleState = {error?:string;ticket?:Ticket;requestId?:string;saved?:string};
export function uuid(value:unknown):string {if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw Error('Odśwież stronę i spróbuj ponownie.');return value;}
export function parseTicket(value:unknown):Ticket {const p=parsePreview(value);return {...p,preview_ticket_id:uuid((value as Record<string,unknown>).preview_ticket_id)};}
export function parseStatus(value:unknown):ErasureStatus {
 if(!value||typeof value!=='object')throw Error('Status jest niedostępny.');const s=value as Record<string,unknown>;
 uuid(s.request_id);
 const phases:Record<string,string[]>={authorized:['local_frozen','authorized','cancellation_pending','ledger_pending'],cancelled:['cancelled'],erasing:['erasing','ledger_pending'],active_data_erased:['active_data_erased']};
 if(!phases[String(s.status)]?.includes(String(s.phase))||!['candidate_record','confirmed_subject'].includes(String(s.scope_kind))||!Number.isSafeInteger(s.generation)||Number(s.generation)<1||!Number.isSafeInteger(s.candidate_count)||Number(s.candidate_count)<1||!Number.isFinite(Date.parse(String(s.created_at)))||!(s.cancelled_at===null||Number.isFinite(Date.parse(String(s.cancelled_at))))||s.execution_enabled!==false||!Array.isArray(s.blockers)||s.blockers.some(b=>typeof b!=='string')||typeof s.can_cancel!=='boolean'||(s.can_cancel&&(s.status!=='authorized'||!['authorized','local_frozen'].includes(String(s.phase))))||(s.ledger_sequence!==undefined&&(!Number.isSafeInteger(s.ledger_sequence)||Number(s.ledger_sequence)<0))||(s.local_purged!==undefined&&typeof s.local_purged!=='boolean')||(s.pending_phase!==undefined&&s.pending_phase!==null&&!['authorized','cancelled','erasing','active_data_erased'].includes(String(s.pending_phase))))throw Error('Status jest niedostępny.');
 if(s.status==='active_data_erased'&&s.local_purged!==true)throw Error('Status jest niedostępny.');
 return s as ErasureStatus;
}
export function lifecycleFailure(code?:string){return code==='PGRST202'||code==='42883'?'Obsługa żądań nie jest jeszcze dostępna w tym środowisku.':code==='PT409'?'Dane lub uprawnienia zmieniły się albo podgląd wygasł. Odśwież status i przygotuj nowy podgląd.':'Nie udało się wykonać czynności. Sprawdź status przed ponowieniem.';}

export function canAuthorizeTicket(ticket:Ticket):boolean {
 const executionOnly=new Set(['execution_not_provisioned','execution_not_implemented','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution']);
 return ticket.blockers.every(blocker=>executionOnly.has(blocker)||(blocker==='subject_resolution_required'&&ticket.scope_kind==='candidate_record'));
}

export function erasureStatusLabel(s:ErasureStatus):string {
 if(s.phase==='cancellation_pending')return 'Anulowanie oczekuje na potwierdzenie — dane wstrzymane';
 if(s.phase==='ledger_pending')return 'Oczekiwanie na potwierdzenie operacji — dane wstrzymane';
 if(s.status==='cancelled')return 'Anulowane';
 if(s.status==='active_data_erased')return 'Usunięto dane aktywne';
 if(s.status==='erasing')return s.local_purged?'Dane lokalne usunięte — trwa potwierdzanie operacji':'Usuwanie rozpoczęte — anulowanie niedostępne';
 return 'Zatwierdzone — zmiany wstrzymane';
}
export function cancellationMessage(s:ErasureStatus):string {
 if(s.status==='cancelled')return 'Potwierdzono anulowanie żądania. Nie przywrócono niezależnie cofniętych zgód ani anulowanych zaproszeń.';
 if(s.phase==='cancellation_pending')return 'Przyjęto wniosek o anulowanie. Oczekuje na potwierdzenie; dane pozostają wstrzymane.';
 return 'Sprawdzono stan żądania. Anulowanie nie zostało potwierdzone. Odśwież listę, aby sprawdzić dalszy postęp.';
}
