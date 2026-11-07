'use server';
import { revalidatePath } from 'next/cache';
import { exerciseContext } from '../../../../../lib/exercise-context';
import { exerciseAiApprovalError, validExerciseAiApprovalContext } from '../../../../../lib/exercise-ai-review';
import type { ExerciseAiApprovalContext } from '../../../../../lib/exercise-ai-review';

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
  revalidatePath(base,'layout');
  return {approved:true};
}

