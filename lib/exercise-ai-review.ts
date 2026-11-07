import type { ExerciseAiProposalReview, ExerciseDefinitionEntry } from './supabase/database.types';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export type ExerciseAiApprovalContext = {
  recruitmentId: string; exerciseId: string; definitionId: string; positionUpdatedAt: string;
};
export function validExerciseAiApprovalContext(context: ExerciseAiApprovalContext) {
  return context && [context.recruitmentId, context.exerciseId, context.definitionId].every(
    value => typeof value === 'string' && uuid.test(value)) &&
    typeof context.positionUpdatedAt === 'string' && context.positionUpdatedAt.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(context.positionUpdatedAt) && Number.isFinite(Date.parse(context.positionUpdatedAt));
}
/** Bind the review to the exact row already read under the company's RLS. */
export function exerciseAiReviewMatches(value: ExerciseAiProposalReview | null, entry: ExerciseDefinitionEntry) {
  if (!value || !value.definitionEntry || !value.proposal) return false;
  const row=value.definitionEntry, proposal=value.proposal;
  return row.id===entry.id && row.company_id===entry.company_id && row.recruitment_id===entry.recruitment_id &&
    row.exercise_id===entry.exercise_id && row.position_updated_at===entry.position_updated_at &&
    row.version===entry.version && typeof proposal.id==='string' && uuid.test(proposal.id) &&
    (proposal.approvalMode===null || proposal.approvalMode==='manual' || proposal.approvalMode==='auto') &&
    (proposal.approvalMode===null
      ? proposal.approvedAt===null && proposal.approvedBy===null
      : typeof proposal.approvedAt==='string' && typeof proposal.approvedBy==='string') &&
    proposal.provenance!==null && typeof proposal.provenance==='object' && !Array.isArray(proposal.provenance);
}
export function exerciseAiApprovalError(code?: string) {
  if(code==='PT409') return 'Wersja propozycji zmieniła się. Odśwież stronę i przeczytaj ją ponownie.';
  if(code==='55000') return 'Zatwierdzanie jest zamknięte dla tej rekrutacji lub stanowiska.';
  if(code==='PT404' || code==='42501') return 'Nie można zatwierdzić tej propozycji w tej firmie.';
  return 'Nie udało się zatwierdzić propozycji. Spróbuj ponownie.';
}

/** Lifecycle fields are written exclusively by the database revision workflow. */
export function exerciseAiLifecycle(provenance: ExerciseAiProposalReview['proposal']['provenance']) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return {state:'pending',reason:null,edited:false};
  const workflow=provenance.workflow;
  const value=workflow && typeof workflow==='object' && !Array.isArray(workflow) ? workflow : null;
  const state=value?.state==='rejected' || value?.state==='superseded' ? value.state : 'pending';
  return {state,reason:typeof value?.reason==='string' ? value.reason : null,edited:!!provenance.human_edit};
}

