'use server';

import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../../lib/company-access';
import { bulkIntakeBlocked, validateBatchFiles, type BulkFileMeta, type BulkGroup } from '../../../../../../lib/cv-bulk';
import { pumpWithSession } from '../../../../../../lib/cv-bulk-server';
import { screeningAiUserEnabled } from '../../../../../../lib/screening-dispatch';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreatedBatch = { error?: string; batchId?: string; reserved?: number; overLimit?: number; items?: { id: string; position: number }[] };

/** Reserves package slots and registers the file list; uploads follow file by file. */
export async function createBulkBatch(companyId: string, recruitmentId: string, requestKey: string, files: BulkFileMeta[]): Promise<CreatedBatch> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  // Without AI analysis queued files never start and their package slots would stay held.
  const blocked = bulkIntakeBlocked(screeningAiUserEnabled());
  if (blocked) return { error: blocked };
  if (!uuid.test(recruitmentId) || !uuid.test(requestKey)) return { error: 'Odśwież stronę i spróbuj ponownie.' };
  let checked;
  try { checked = validateBatchFiles(files); } catch (error) { return { error: (error as Error).message }; }
  const created = await client.rpc('cv_bulk_create_batch', { target_recruitment: recruitmentId, request_key: requestKey, files: checked });
  if (created.error) {
    return { error: created.error.message === 'cv_bulk_recruitment_closed'
      ? 'Rekrutacja jest wstrzymana lub zamknięta albo stanowisko jest w archiwum.'
      : 'Nie udało się utworzyć paczki. Odśwież stronę i spróbuj ponownie.' };
  }
  const result = created.data as { batch_id: string; reserved_slots: number; over_limit: number };
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: result.batch_id });
  const items = ((status.data as { items?: { id: string; position: number }[] } | null)?.items ?? []).map(i => ({ id: i.id, position: i.position }));
  return { batchId: result.batch_id, reserved: result.reserved_slots, overLimit: result.over_limit, items };
}

/** Ends uploading; unsent files give their package slots back. */
export async function closeBulkUpload(companyId: string, batchId: string) {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit || !uuid.test(batchId)) return { error: 'Brak dostępu.' };
  const result = await client.rpc('cv_bulk_close_upload', { target_batch: batchId });
  if (result.error) return { error: 'Nie udało się zamknąć wysyłania.' };
  try { await pumpWithSession(client, batchId); } catch { /* the progress page pumps again */ }
  return { released: result.data ?? 0 };
}

/** Progress page heartbeat: advances the queue (recruiters only) and returns the status. */
export async function bulkProgress(companyId: string, batchId: string) {
  const { client, canEdit } = await companyAccess(companyId);
  if (!uuid.test(batchId)) return null;
  if (canEdit) { try { await pumpWithSession(client, batchId); } catch { /* status below still shows the state */ } }
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: batchId });
  return status.error ? null : status.data;
}

export type MoveState = { error?: string; saved?: boolean };
export async function movePreselectionGroup(companyId: string, recruitmentId: string, applicationId: string, expectedUpdatedAt: string,
  _state: MoveState, form: FormData): Promise<MoveState> {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit) return { error: 'Masz dostęp tylko do odczytu.' };
  const group = String(form.get('group') ?? '') as BulkGroup;
  if (!['passed', 'review', 'rejected'].includes(group) || !uuid.test(applicationId)) return { error: 'Wybierz grupę.' };
  const note = String(form.get('note') ?? '').trim();
  if (note.length > 500) return { error: 'Uzasadnienie może mieć do 500 znaków.' };
  const result = await client.rpc('move_preselection_group', { target_application: applicationId, new_group: group,
    expected_updated_at: expectedUpdatedAt, move_note: note || null });
  if (result.error) return { error: result.error.code === 'PT409' ? 'Grupa zmieniła się w międzyczasie. Odśwież stronę.' : 'Nie udało się przenieść kandydata.' };
  revalidatePath(`/dashboard/${companyId}/recruitments/${recruitmentId}`);
  return { saved: true };
}
