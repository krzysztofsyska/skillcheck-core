import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../lib/company-access';
import { bulkBatchRouteMatches } from '../../../../../../../lib/cv-bulk';
import { loadCurrentRanking, withGroupCurrency } from '../../../../../../../lib/preselection-currency';
import { BatchProgress, type BatchStatus } from './progress';

export const dynamic = 'force-dynamic';

export default async function BulkBatchPage({ params }: { params: Promise<{ companyId: string; recruitmentId: string; batchId: string }> }) {
  const { companyId, recruitmentId, batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) notFound();
  const { client } = await companyAccess(companyId);
  // Both the recruitment and the batch must belong to the URL company, including
  // when the signed-in user has access to multiple companies.
  const recruitment = await client.from('recruitments').select('id')
    .eq('id', recruitmentId).eq('company_id', companyId).maybeSingle();
  if (recruitment.error || !recruitment.data) notFound();
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: batchId });
  const raw = status.data as BatchStatus | null;
  if (status.error || !raw || !bulkBatchRouteMatches(raw, batchId, recruitmentId)) notFound();
  // A saved group is shown as current only for the analysis the ranking uses now (same rule as the report).
  const ranking = raw.items.some(i => i.group_key) ? await loadCurrentRanking(client, recruitmentId) : null;
  const data: BatchStatus = { ...raw, items: withGroupCurrency(raw.items, ranking) };
  const back = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <main className="workspace"><section>
    <Link href={back}>← Rekrutacja</Link> · <Link href={`${back}/bulk`}>Wgraj kolejną paczkę</Link>
    <h1>Paczka CV</h1>
    <BatchProgress companyId={companyId} recruitmentId={recruitmentId} batchId={batchId} initial={data} billingHref={`/dashboard/${companyId}/billing`} />
  </section></main>;
}
