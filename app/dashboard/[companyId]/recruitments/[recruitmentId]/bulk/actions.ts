'use server';

import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../../lib/company-access';
import { bulkIntakeBlocked, bulkBatchRouteMatches, bulkMoveTargetMatches, groupMoveConfirmed, validateBatchFiles, verifyBulkRegistration, type BulkFileMeta, type BulkGroup } from '../../../../../../lib/cv-bulk';
import { pumpWithSession } from '../../../../../../lib/cv-bulk-server';
import { loadCurrentRanking, withGroupCurrency } from '../../../../../../lib/preselection-currency';
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
  // Bind the URL company to the recruitment before the RPC reserves package credits.
  // A recruiter can edit more than one company, so membership alone is insufficient.
  const recruitment = await client.from('recruitments').select('id')
    .eq('id', recruitmentId).eq('company_id', companyId).maybeSingle();
  if (recruitment.error || !recruitment.data) return { error: 'Nie znaleziono rekrutacji w tej firmie.' };
  let checked;
  try { checked = validateBatchFiles(files); } catch (error) { return { error: (error as Error).message }; }
  const created = await client.rpc('cv_bulk_create_batch', { target_recruitment: recruitmentId, request_key: requestKey, files: checked });
  if (created.error) {
    return { error: created.error.message === 'cv_bulk_recruitment_closed'
      ? 'Rekrutacja jest wstrzymana lub zamknięta albo stanowisko jest w archiwum.'
      : 'Nie udało się utworzyć paczki. Odśwież stronę i spróbuj ponownie.' };
  }
  // Never use an unverified RPC identifier to read another record or begin uploads.
  const createdId = (created.data && typeof created.data === 'object' && !Array.isArray(created.data))
    ? (created.data as { batch_id?: unknown }).batch_id : null;
  if (typeof createdId !== 'string' || !uuid.test(createdId)) {
    return { error: 'Nie udało się przygotować wysyłania. Spróbuj ponownie — paczka zostanie wznowiona.' };
  }
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: createdId });
  // A partial/mismatched read must not cause the uploader to skip items and close held slots.
  // The same request key lets a retry safely resume the registered batch.
  const verified = !status.error && verifyBulkRegistration(created.data, status.data, recruitmentId, checked);
  if (!verified) return { error: 'Nie udało się przygotować wysyłania. Spróbuj ponownie — paczka zostanie wznowiona.' };
  return verified;
}

/** Ends uploading; unsent files give their package slots back. */
export async function closeBulkUpload(companyId: string, batchId: string) {
  const { client, canEdit } = await companyAccess(companyId);
  if (!canEdit || !uuid.test(batchId)) return { error: 'Brak dostępu.' };
  // A batch from another company must not be closed through this company's URL.
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: batchId });
  const batch = status.data && typeof status.data === 'object' && !Array.isArray(status.data)
    ? (status.data as { batch?: { recruitment_id?: string } }).batch : null;
  const recruitmentId = batch?.recruitment_id;
  if (status.error || typeof recruitmentId !== 'string' ||
    !bulkBatchRouteMatches(status.data, batchId, recruitmentId)) return { error: 'Brak dostępu.' };
  const recruitment = await client.from('recruitments').select('id')
    .eq('id', recruitmentId).eq('company_id', companyId).maybeSingle();
  if (recruitment.error || !recruitment.data) return { error: 'Brak dostępu.' };
  const result = await client.rpc('cv_bulk_close_upload', { target_batch: batchId });
  // SQL returns the non-negative count of released slots. A null or malformed
  // successful RPC response is not proof that uploading was closed.
  if (result.error || !Number.isInteger(result.data) || (result.data as number) < 0) {
    return { error: 'Nie udało się zamknąć wysyłania.' };
  }
  try { await pumpWithSession(client, batchId); } catch { /* the progress page pumps again */ }
  return { released: result.data as number };
}

/** Progress page heartbeat: advances the queue (recruiters only) and returns the status. */
export async function bulkProgress(companyId: string, recruitmentId: string, batchId: string) {
  const { client, canEdit } = await companyAccess(companyId);
  if (!uuid.test(recruitmentId) || !uuid.test(batchId)) return null;
  const recruitment = await client.from('recruitments').select('id')
    .eq('id', recruitmentId).eq('company_id', companyId).maybeSingle();
  if (recruitment.error || !recruitment.data) return null;
  // Verify batch ownership before the pump, not only when rendering its result.
  const before = await client.rpc('cv_bulk_batch_status', { target_batch: batchId });
  if (before.error || !bulkBatchRouteMatches(before.data, batchId, recruitmentId)) return null;
  if (canEdit) { try { await pumpWithSession(client, batchId); } catch { /* status below still shows the state */ } }
  const status = canEdit ? await client.rpc('cv_bulk_batch_status', { target_batch: batchId }) : before;
  if (status.error || !bulkBatchRouteMatches(status.data, batchId, recruitmentId)) return null;
  const data = status.data as { batch: { recruitment_id: string }; items: { application_id: string | null; group_key: unknown; group_analysis_id?: unknown }[] };
  const ranking = data.items.some(i => i.group_key) ? await loadCurrentRanking(client, data.batch.recruitment_id) : null;
  return { ...data, items: withGroupCurrency(data.items, ranking) };
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
