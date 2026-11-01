import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../lib/company-access';
import { BULK_MAX_FILES, BULK_MAX_FILE_BYTES } from '../../../../../../lib/cv-bulk';
import { BulkUploader } from './uploader';

export const dynamic = 'force-dynamic';

export default async function BulkUploadPage({ params }: { params: Promise<{ companyId: string; recruitmentId: string }> }) {
  const { companyId, recruitmentId } = await params;
  const { client, canEdit } = await companyAccess(companyId);
  const { data: recruitment, error } = await client.from('recruitments').select('id,name,status').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment) notFound();
  const balance = await client.rpc('sc19_get_balance', { target_company: companyId });
  const available = balance.error ? 0 : (balance.data?.[0]?.available ?? 0);
  const batches = await client.rpc('cv_bulk_recruitment_batches', { target_recruitment: recruitmentId });
  const list = (batches.data ?? []) as { id: string; status: string; declared_files: number; done: number; errors: number; pending: number; created_at: string }[];
  const back = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <main className="workspace"><section>
    <Link href={back}>← {recruitment.name}</Link>
    <h1>Wgraj wiele CV</h1>
    {!canEdit ? <p>Masz dostęp tylko do odczytu.</p> : !['draft', 'open'].includes(recruitment.status)
      ? <p role="alert">Rekrutacja jest wstrzymana lub zamknięta — nie można dodawać CV.</p>
      : <BulkUploader companyId={companyId} recruitmentId={recruitmentId} recruitmentName={recruitment.name} available={available}
          maxFiles={BULK_MAX_FILES} maxFileBytes={BULK_MAX_FILE_BYTES} billingHref={`/dashboard/${companyId}/billing`} />}
    <h2>Wcześniejsze paczki</h2>
    {list.length ? <ul>{list.map(b => <li key={b.id}><Link href={`${back}/bulk/${b.id}`}>
      Paczka z {new Date(b.created_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}</Link> — plików: {b.declared_files}, gotowe: {b.done}, błędy: {b.errors}, w toku: {b.pending}
      {b.status === 'completed' ? ' · zakończona' : ''}</li>)}</ul> : <p>Brak paczek w tej rekrutacji.</p>}
  </section></main>;
}
