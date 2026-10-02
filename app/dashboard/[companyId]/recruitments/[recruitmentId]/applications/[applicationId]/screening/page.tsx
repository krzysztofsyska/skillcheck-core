import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { prepareScreening, type PreparedScreening } from '../../../../../../../../lib/screening';

export default async function Screening({ params }: { params: Promise<{ companyId: string; recruitmentId: string; applicationId: string }> }) {
  const { companyId, recruitmentId, applicationId } = await params;
  const { client } = await companyAccess(companyId);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(recruitmentId) || !uuid.test(applicationId)) notFound();
  const application = await client.from('applications').select('*').eq('company_id', companyId).eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle();
  if (application.error) throw new Error('Nie udało się wczytać zgłoszenia.');
  if (!application.data) notFound();
  const recruitment = await client.from('recruitments').select('*').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment.data) notFound();
  const [position, document] = await Promise.all([
    client.from('positions').select('*').eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle(),
    // Deliberately select the latest document, including drafts; never silently fall back to an older reviewed CV.
    client.from('candidate_documents').select('id,company_id,candidate_id,version,status,reviewed_by,reviewed_at,redacted_text')
      .eq('company_id', companyId).eq('candidate_id', application.data.candidate_id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (position.error) throw new Error('Nie udało się wczytać stanowiska.');
  if (!position.data) notFound();
  const unavailable = document.error && ['42P01', 'PGRST205'].includes(document.error.code);
  if (document.error && !unavailable) throw new Error('Nie udało się wczytać CV.');
  let prepared: PreparedScreening | undefined;
  let reason = unavailable ? 'Moduł CV oczekuje na uruchomienie.' : '';
  if (!unavailable) {
    try {
      prepared = prepareScreening({ companyId, application: application.data, recruitment: recruitment.data, position: position.data, document: document.data });
    } catch (error) { reason = error instanceof Error ? error.message : 'Sprawdź dane przed analizą.'; }
  }
  const base = `/dashboard/${companyId}`;
  const labels = { task: 'Zadanie', kpi: 'Miernik sukcesu', competency: 'Kompetencja' };
  return <main className="workspace"><section>
    <Link href={`${base}/recruitments/${recruitmentId}`}>← Rekrutacja</Link>
    <h1>Przygotowanie preselekcji</h1><p>{recruitment.data.name} · {position.data.title}</p>
    <p className="notice">Analiza AI nie jest uruchomiona. Integracja i budżet usługi oczekują na konfigurację. Nie wysłano CV do zewnętrznej usługi ani nie wygenerowano oceny.</p>
    <p>Decyzję o dalszym udziale w rekrutacji podejmuje człowiek. Brak informacji w CV oznacza brak danych do oceny.</p>
    <p><Link href={`${base}/candidates/${application.data.candidate_id}/cv`}>Sprawdź CV i anonimizację</Link> · <Link href={`${base}/positions/${position.data.id}`}>Sprawdź wymagania stanowiska</Link></p>
    {reason ? <p role="status" className="notice">{reason}</p> : prepared && <>
      <h2>Materiał przygotowany do analizy</h2>
      <p>Najnowsze CV: wersja {prepared.binding.document_version}, anonimizacja zatwierdzona przez rekrutera. Przed uruchomieniem analizy sprawdź również, czy wymagania stanowiska nie zawierają danych osobowych.</p>
      <h3>Wymagania do porównania z CV</h3>
      <ul>{prepared.payload.criteria.map(criterion => <li key={criterion.id}><strong>{labels[criterion.kind]}:</strong> {criterion.text}</li>)}</ul>
      <details><summary>Sprawdzony tekst CV</summary><pre className="cv-text">{prepared.payload.cv_text}</pre></details>
    </>}
    <h2>Do sprawdzenia w dalszych etapach</h2>
    <p><Link href={`${base}/recruitments/${recruitmentId}/interview-guide`}>Otwórz przewodnik rozmowy dla ośmiu obszarów zachowania</Link></p>
    <p>Samodzielność i sposób działania wymagają rozmowy, przykładów zachowań lub zadań. Nie wyciągamy wniosków o osobowości wyłącznie z CV.</p>
    {position.data.autonomy_level !== null && <p>Wymagany poziom samodzielności: {position.data.autonomy_level}/5.</p>}
    <ul>{position.data.required_behaviors.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul>
  </section></main>;
}
