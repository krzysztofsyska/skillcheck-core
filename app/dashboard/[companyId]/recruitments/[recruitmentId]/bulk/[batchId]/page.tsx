import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../lib/company-access';
import { BatchProgress, type BatchStatus } from './progress';

export const dynamic = 'force-dynamic';

export default async function BulkBatchPage({ params }: { params: Promise<{ companyId: string; recruitmentId: string; batchId: string }> }) {
  const { companyId, recruitmentId, batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) notFound();
  const { client } = await companyAccess(companyId);
  const status = await client.rpc('cv_bulk_batch_status', { target_batch: batchId });
  const data = status.data as BatchStatus | null;
  if (status.error || !data || data.batch.recruitment_id !== recruitmentId) notFound();
  const back = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <main className="workspace"><section>
    <Link href={back}>← Rekrutacja</Link> · <Link href={`${back}/bulk`}>Wgraj kolejną paczkę</Link>
    <h1>Paczka CV</h1>
    <BatchProgress companyId={companyId} recruitmentId={recruitmentId} batchId={batchId} initial={data} billingHref={`/dashboard/${companyId}/billing`} />
  </section></main>;
}
