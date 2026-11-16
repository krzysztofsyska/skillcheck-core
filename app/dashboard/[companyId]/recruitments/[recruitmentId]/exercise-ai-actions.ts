'use server';
import { revalidatePath } from 'next/cache';
import { exerciseContext } from '../../../../../lib/exercise-context';
import { exerciseAiApprovalError, validExerciseAiApprovalContext } from '../../../../../lib/exercise-ai-review';
import type { ExerciseAiApprovalContext } from '../../../../../lib/exercise-ai-review';
import { parseExerciseFormData } from '../../../../../lib/exercise-definition';
import type { Json } from '../../../../../lib/supabase/database.types';
import { bindMethodToDefinitions } from '../../../../../lib/method-binding';

export async function approveExerciseAiProposal(companyId: string, context: ExerciseAiApprovalContext,
  _previous: {error?:string; approved?:boolean}, form: FormData): Promise<{error?:string; approved?:boolean}> {
  if (process.env.EXERCISE_AI_ENABLED!=='true') return {error:'Propozycje AI są wyłączone.'};
  if(!validExerciseAiApprovalContext(context)) return {error:'Odśwież stronę, aby wczytać propozycję.'};
  const confirmed=form.getAll('confirm');
  if(confirmed.length!==1 || confirmed[0]!=='yes') return {error:'Potwierdź przeczytanie zadania i kryteriów.'};
  const {client,canEdit,editable,base}=await exerciseContext(companyId,context.recruitmentId);
  if(!canEdit) return {error:'Masz dostęp tylko do odczytu.'};
  if(!editable) return {error:exerciseAiApprovalError('55000')};
  // Check the exercise as well as the identifiers enforced independently by the RPC.
  const read=await client.rpc('read_exercise_ai_proposal',{
    target_company:companyId,target_recruitment:context.recruitmentId,target_definition:context.definitionId,
  });
  if(read.error) return {error:exerciseAiApprovalError(read.error.code)};
  const row=read.data?.definitionEntry;
  if(!row || row.company_id!==companyId || row.recruitment_id!==context.recruitmentId ||
    row.exercise_id!==context.exerciseId || row.id!==context.definitionId) return {error:exerciseAiApprovalError('PT404')};
  if(row.position_updated_at!==context.positionUpdatedAt) return {error:exerciseAiApprovalError('PT409')};
  const result=await client.rpc('approve_exercise_ai_proposal',{
    target_company:companyId,target_recruitment:context.recruitmentId,target_definition:context.definitionId,
    expected_position_updated_at:context.positionUpdatedAt,
  });
  if(result.error || !result.data) return {error:exerciseAiApprovalError(result.error?.code)};
  // SC-METHOD / #275: zatwierdzana definicja ma mieć zapisaną wersję profilu metody, z którą powstała
  // (także gdy wcześniejsze powiązanie się nie udało). Błąd powiązania nie zmienia wyniku zatwierdzenia.
  await bindMethodToDefinitions(client,companyId,context.recruitmentId);
  revalidatePath(base,'layout');
  return {approved:true};
}

export async function editExerciseAiProposal(companyId:string,context:ExerciseAiApprovalContext,
  currentPositionUpdatedAt:string,_previous:{error?:string;entryId?:string},form:FormData):Promise<{error?:string;entryId?:string}> {
  if(process.env.EXERCISE_AI_ENABLED!=='true') return {error:'Propozycje AI są wyłączone.'};
  if(!validExerciseAiApprovalContext(context)) return {error:'Odśwież stronę, aby wczytać propozycję.'};
  let definition;
  try {definition=parseExerciseFormData(form);} catch(error) {return {error:error instanceof Error ? error.message : 'Nieprawidłowa definicja zadania.'};}
  const {client,canEdit,editable,base}=await exerciseContext(companyId,context.recruitmentId);
  if(!canEdit || !editable) return {error:'Nie można teraz edytować zadania w tej rekrutacji.'};
  const result=await client.rpc('edit_exercise_ai_proposal',{
    target_company:companyId,target_recruitment:context.recruitmentId,target_definition:context.definitionId,
    expected_position_updated_at:context.positionUpdatedAt,new_definition:definition as unknown as Json,
    expected_current_position_updated_at:currentPositionUpdatedAt,
  });
  if(result.error || !result.data) return {error:result.error?.code==='PT409' ? exerciseAiApprovalError('PT409') : 'Nie udało się zapisać korekty. Odśwież stronę i spróbuj ponownie.'};
  // SC-METHOD / #275: korekta tworzy nową wersję definicji wewnątrz bazy — powiąż ją z wersją profilu metody.
  await bindMethodToDefinitions(client,companyId,context.recruitmentId);
  revalidatePath(base,'layout');return {entryId:result.data};
}

export async function rejectExerciseAiProposal(companyId:string,context:ExerciseAiApprovalContext,
  _previous:{error?:string;rejected?:boolean},form:FormData):Promise<{error?:string;rejected?:boolean}> {
  if(process.env.EXERCISE_AI_ENABLED!=='true') return {error:'Propozycje AI są wyłączone.'};
  if(!validExerciseAiApprovalContext(context)) return {error:'Odśwież stronę, aby wczytać propozycję.'};
  const reasons=form.getAll('reason');
  if(reasons.length!==1 || typeof reasons[0]!=='string' || !reasons[0].trim() || reasons[0].length>1000) return {error:'Podaj powód odrzucenia do 1000 znaków.'};
  const {client,canEdit,editable,base}=await exerciseContext(companyId,context.recruitmentId);
  if(!canEdit || !editable) return {error:'Nie można teraz odrzucić propozycji w tej rekrutacji.'};
  const result=await client.rpc('reject_exercise_ai_proposal',{
    target_company:companyId,target_recruitment:context.recruitmentId,target_definition:context.definitionId,
    expected_position_updated_at:context.positionUpdatedAt,rejection_reason:reasons[0].trim(),
  });
  if(result.error || !result.data) return {error:result.error?.code==='PT409' ? exerciseAiApprovalError('PT409') : 'Nie można odrzucić tej wersji. Odśwież stronę — mogła już zostać zatwierdzona.'};
  revalidatePath(base,'layout');return {rejected:true};
}

