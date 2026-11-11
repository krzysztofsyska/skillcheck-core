'use server';

import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../../lib/company-access';
import { bulkMoveTargetMatches, groupMoveConfirmed, type BulkFileMeta, type BulkGroup } from '../../../../../../lib/cv-bulk';
import { bulkProgressCore, closeBulkUploadCore, createBulkBatchCore, type BulkActionDeps, type CreatedBatch } from '../../../../../../lib/cv-bulk-actions';
import { pumpWithSession } from '../../../../../../lib/cv-bulk-server';
import { screeningAiUserEnabled } from '../../../../../../lib/screening-dispatch';

const deps: BulkActionDeps = { access: companyAccess, pump: pumpWithSession, aiEnabled: screeningAiUserEnabled };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reserves package slots and registers the file list; uploads follow file by file. */
export async function createBulkBatch(companyId: string, recruitmentId: string, requestKey: string, files: BulkFileMeta[]): Promise<CreatedBatch> {
  return createBulkBatchCore(deps, companyId, recruitmentId, requestKey, files);
}

/** Ends uploading; unsent files give their package slots back. */
export async function closeBulkUpload(companyId: string, recruitmentId: string, batchId: string) {
  return closeBulkUploadCore(deps, companyId, recruitmentId, batchId);
}

/** Progress page heartbeat: advances the queue (recruiters only) and returns the status. */
export async function bulkProgress(companyId: string, recruitmentId: string, batchId: string) {
  return bulkProgressCore(deps, companyId, recruitmentId, batchId);
}

export type MoveState = { error?: string; saved?: boolean };
export async function movePreselectionGroup(companyId: string, recruitmentId: string, applicationId: string, expectedUpdatedAt: string,
  _state: MoveState, form: FormData): Promise<MoveState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  const group = String(form.get('group') ?? '') as BulkGroup;
  if (!['passed', 'review', 'rejected'].includes(group) || !uuid.test(applicationId) || !uuid.test(recruitmentId)) {
    return { error: 'Wybierz grupę.' };
  }
  // The RPC verifies permissions for its target company, but it does not receive
  // the company/recruitment IDs from the page. Bind the route to the exact target
  // before changing a group, including users with membership in several firms.
  const target = await client.from('applications').select('id,company_id,recruitment_id')
    .eq('id', applicationId).eq('company_id', companyId).eq('recruitment_id', recruitmentId).maybeSingle();
  if (target.error || !bulkMoveTargetMatches(target.data, companyId, recruitmentId, applicationId)) {
    return { error: 'Nie znaleziono kandydata w tej rekrutacji.' };
  }
  const note = String(form.get('note') ?? '').trim();
  if (note.length > 500) return { error: 'Uzasadnienie może mieć do 500 znaków.' };
  const result = await client.rpc('move_preselection_group', { target_application: applicationId, new_group: group,
    expected_updated_at: expectedUpdatedAt, move_note: note || null });
  if (result.error) return { error: result.error.code === 'PT409' ? 'Grupa zmieniła się w międzyczasie. Odśwież stronę.' : 'Nie udało się przenieść kandydata.' };
  if (!groupMoveConfirmed(result.data)) return { error: 'Nie udało się potwierdzić zapisu grupy. Odśwież stronę i sprawdź wynik.' };
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}`);
  return { saved: true };
}
