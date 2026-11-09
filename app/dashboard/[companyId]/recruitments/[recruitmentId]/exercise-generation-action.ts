'use server';
import { revalidatePath } from 'next/cache';
import { exerciseContext, exerciseUuid } from '../../../../../lib/exercise-context';
import { ExerciseAiError } from '../../../../../lib/exercise-ai';
import { generateExerciseDraft, type ExerciseGenerationResult, type GenerationReservation } from '../../../../../lib/exercise-ai-generation';
import { requestExerciseDraft } from '../../../../../lib/exercise-ai-provider';
import { isAiGatewayEnabled } from '../../../../../lib/ai-gateway/contract';
import { exerciseLedgerWriterFromEnv } from '../../../../../lib/ai-ledger-writer';
import type { Json } from '../../../../../lib/supabase/database.types';

export async function generateExerciseProposal(companyId:string,recruitmentId:string,requestKey:string,
  expectedPositionStamp:string,expectedCompanyStamp:string|null,_previous:ExerciseGenerationResult,form:FormData):Promise<ExerciseGenerationResult> {
  if(process.env.EXERCISE_AI_ENABLED!=='true') return {error:'Propozycje AI są wyłączone.'};
  if(!exerciseUuid.test(requestKey) || form.getAll('confirm').length!==1 || form.get('confirm')!=='yes')
    return {error:'Potwierdź przekazanie profilu firmy i stanowiska do przygotowania propozycji.'};
  const {client,canEdit,editable,position,base}=await exerciseContext(companyId,recruitmentId);
  if(!canEdit || !editable) return {error:'Nie można teraz przygotować zadania w tej rekrutacji.'};
  const company=await client.from('company_profiles').select('*').eq('company_id',companyId).maybeSingle();
  if(company.error) return {error:'Nie udało się wczytać profilu firmy.'};
  if(position.updated_at!==expectedPositionStamp || (company.data?.updated_at??null)!==expectedCompanyStamp)
    return {error:'Profil zmienił się. Odśwież stronę i sprawdź aktualną treść.'};
  // Configuration is checked before spending a reservation; never expose the key.
  const key=process.env.OPENAI_API_KEY;
  if(!key) return {error:'Konfiguracja modelu jest niedostępna.'};
  // SC-021-B: on the gateway path every attempt must reach the AI ledger through the server-only
  // writer connection. Without it, refuse before reserving or calling the provider (fail closed).
  const recordAttempt=isAiGatewayEnabled(process.env.AI_GATEWAY_ENABLED)?exerciseLedgerWriterFromEnv(companyId,recruitmentId):null;
  if(isAiGatewayEnabled(process.env.AI_GATEWAY_ENABLED) && !recordAttempt) return {error:'Rejestr kosztów AI jest niedostępny. Propozycje AI są chwilowo wyłączone.'};
  const readResult=(data:Json|null,error:{code?:string}|null):GenerationReservation=>{
    if(error?.code==='PT429') throw new ExerciseAiError('exercise_ai_quota_exhausted','Quota exhausted');
    if(error || !data || typeof data!=='object' || Array.isArray(data) || !['reserved','completed','failed'].includes(String(data.status))) throw Error('Generation state unavailable');
    return data as GenerationReservation;
  };
  const result=await generateExerciseDraft({position,company:company.data},position,{
    reserve:async fingerprint=>{
      const r=await client.rpc('reserve_exercise_ai_generation',{target_company:companyId,target_recruitment:recruitmentId,request_key:requestKey,
        expected_position_updated_at:expectedPositionStamp,expected_company_updated_at:expectedCompanyStamp,input_fingerprint:fingerprint});
      return readResult(r.data,r.error);
    },
    finish:async(fingerprint,definition,provenance,error)=>{
      const r=await client.rpc('finish_exercise_ai_generation',{target_company:companyId,target_recruitment:recruitmentId,request_key:requestKey,
        input_fingerprint:fingerprint,new_definition:definition as unknown as Json,new_provenance:provenance as unknown as Json,error_code:error});
      return readResult(r.data,r.error);
    },
    // Trusted context for the AI gateway path (used only when AI_GATEWAY_ENABLED=true): the company
    // whose membership exerciseContext verified, the validated request key and the recruitment.
    // SC-021-B: each physical attempt is written to the AI ledger by the server-only writer; the
    // database binds the row to this request key's live reservation.
    provide:payload=>requestExerciseDraft(payload,key,fetch,{companyId,operationId:requestKey,recruitmentId,mayGenerate:canEdit&&editable,recordAttempt}),
  });
  if(result.exerciseId) revalidatePath(base,'layout');
  return result;
}
