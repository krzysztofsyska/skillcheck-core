import { after } from 'next/server';
import { createClient } from '../../../../../../../../../lib/supabase/server';
import { buildExtraction, BulkIntakeError, BULK_EXTRACT_BUDGET_MS, BULK_MAX_FILE_BYTES, type BulkFileKind } from '../../../../../../../../../lib/cv-bulk';
import { extractBulkCv } from '../../../../../../../../../lib/cv-bulk-extract';
import { ocrImage } from '../../../../../../../../../lib/cv-ocr';
import { suggestRedaction } from '../../../../../../../../../lib/cv-text';
import { pumpWithSession } from '../../../../../../../../../lib/cv-bulk-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { 'Cache-Control': 'no-store' };
type Item = { id: string; position: number; file_kind: BulkFileKind; phase: string; error_reason: string | null };

/** One CV file of a confirmed batch. The original file is read in memory only and never stored. */
export async function POST(request: Request, { params }: { params: Promise<{ companyId: string; recruitmentId: string; batchId: string; itemId: string }> }) {
  // Time budget for this request (maxDuration 60 s): reading/OCR stops early enough to save the outcome.
  const deadline = Date.now() + BULK_EXTRACT_BUDGET_MS;
  const { companyId, recruitmentId, batchId, itemId } = await params;
  if (![companyId, recruitmentId, batchId, itemId].every(id => uuid.test(id))) return Response.json({ error: 'not_found' }, { status: 404, headers });
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  // Write access first, so read-only members never trigger file reading or OCR (the SQL write check stays authoritative).
  const [company, membership] = await Promise.all([
    client.from('companies').select('owner_id').eq('id', companyId).maybeSingle(),
    client.from('company_members').select('role').eq('company_id', companyId).eq('user_id', user.id).maybeSingle(),
  ]);
  if (company.error || membership.error) return Response.json({ error: 'unavailable' }, { status: 503, headers });
  if (!company.data) return Response.json({ error: 'not_found' }, { status: 404, headers });
  if (company.data.owner_id !== user.id && membership.data?.role !== 'recruiter') return Response.json({ error: 'forbidden' }, { status: 403, headers });
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: batchId });
  const batchRecruitment = (status.data as { batch?: { recruitment_id?: string } } | null)?.batch?.recruitment_id;
  const items = ((status.data as { items?: Item[] } | null)?.items ?? []);
  const item = items.find(i => i.id === itemId);
  if (status.error || !item || batchRecruitment !== recruitmentId) return Response.json({ error: 'not_found' }, { status: 404, headers });
  const recruitment = await client.from('recruitments').select('id').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) return Response.json({ error: 'unavailable' }, { status: 503, headers });
  if (!recruitment.data) return Response.json({ error: 'not_found' }, { status: 404, headers });
  if (item.phase !== 'awaiting_upload') return Response.json({ phase: item.phase, error_reason: item.error_reason }, { headers });

  let form: FormData;
  try { form = await request.formData(); } catch { return Response.json({ error: 'bad_request' }, { status: 400, headers }); }
  const fail = async (reason: string) => {
    let result = await client.rpc('cv_bulk_fail_item', { target_item: itemId, reason });
    // A database without the 'ocr_timeout' reason yet refuses it as invalid (22023): record the scan as unreadable instead.
    if (result.error?.code === '22023' && reason === 'ocr_timeout') {
      reason = 'unreadable_scan';
      result = await client.rpc('cv_bulk_fail_item', { target_item: itemId, reason });
    }
    if (result.error) return Response.json({ error: 'save_failed' }, { status: 503, headers });
    after(() => pumpWithSession(client, batchId).catch(() => undefined));
    return Response.json({ phase: 'error', error_reason: reason }, { headers });
  };
  // Unsupported or oversized files are reported without sending their content.
  if (item.file_kind === 'other') return fail('bad_format');
  if (form.get('too_large') === '1') return fail('too_large');
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'bad_request' }, { status: 400, headers });
  if (file.size > BULK_MAX_FILE_BYTES) return fail('too_large');

  let extracted;
  try {
    const { text, ocrUsed } = await extractBulkCv(Buffer.from(await file.arrayBuffer()), item.file_kind, ocrImage, { deadline });
    extracted = buildExtraction(text, item.position, ocrUsed, suggestRedaction);
  } catch (error) {
    if (error instanceof BulkIntakeError) return fail(error.reason);
    // Library/infrastructure error only (name and first line), never file content.
    console.error('cv_bulk_extract_failed', error instanceof Error ? `${error.name}: ${String(error.message).split('\n')[0].slice(0, 160)}` : typeof error);
    // Transient server problem: the slot stays held and the browser may retry.
    return Response.json({ error: 'extract_failed' }, { status: 503, headers });
  }
  const result = await client.rpc('cv_bulk_register_item', { target_item: itemId, extracted });
  if (result.error) return Response.json({ error: 'save_failed' }, { status: 503, headers });
  after(() => pumpWithSession(client, batchId).catch(() => undefined));
  const saved = result.data as { status?: string; error_reason?: string | null };
  return Response.json({ phase: saved.status ?? 'queued', error_reason: saved.error_reason ?? null }, { headers });
}
