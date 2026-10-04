import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadBehaviorContext, type BehaviorRoute } from '../../../../../../../../../../lib/behavior-context';
import { behaviorGuideDefinitions } from '../../../../../../../../../../lib/behavior-guide';
import { behaviorModuleUnavailable, behaviorRatings, behaviorSchemaMissing, parseHistoryBefore } from '../../../../../../../../../../lib/behavior-assessment';

export default async function BehaviorHistory({ params, searchParams }: {
  params: Promise<BehaviorRoute & { areaKey: string }>; searchParams: Promise<{ before?: string }>;
}) {
  const route = await params;
  const { client, user, candidate, base } = await loadBehaviorContext(route);
  const area = behaviorGuideDefinitions.find(area => area.id === route.areaKey);
  if (!area) notFound();
  let before;
  try { before = parseHistoryBefore((await searchParams).before); } catch { notFound(); }
  let query = client.from('behavior_assessment_entries').select('*').eq('company_id', route.companyId)
    .eq('recruitment_id', route.recruitmentId).eq('application_id', route.applicationId).eq('area_key', area.id)
    .order('version', { ascending: false }).limit(21);
  if (before !== null) query = query.lt('version', before);
  const result = await query;
  const unavailable = result.error && behaviorSchemaMissing(result.error.code);
  if (result.error && !unavailable) throw new Error('Nie udało się wczytać historii ocen.');
  const entries = result.data?.slice(0, 20) ?? [];
  return <main className="workspace"><section><Link href={`${base}#${area.id}`}>← Oceny z dowodami</Link>
    <h1>Historia — {area.label}</h1><p>{candidate.first_name} {candidate.last_name}</p>
    <p>Każdy wpis zachowuje autora, uzasadnienie i profil stanowiska z chwili zapisu. Poprawki tworzą kolejne wersje.</p>
    {unavailable ? <p role="status">{behaviorModuleUnavailable}</p> : <>
      {before !== null && <p><Link href={`${base}/${area.id}/history`}>Najnowsze wpisy</Link></p>}
      {!entries.length && <p>Brak wpisów na tej stronie historii.</p>}
      {entries.map(entry => <article key={entry.id}>
        <h2>Wersja {entry.version} — {behaviorRatings.find(([key]) => key === entry.rating)?.[1]}</h2>
        <p>{new Date(entry.created_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })} · Autor: {entry.author_id === user.id ? 'Ty' : entry.author_id}</p>
        <p>Wymagany poziom przy ocenie: <strong>{entry.required_level}</strong></p>
        <p className="cv-text">{entry.evidence || 'Nie zapisano dodatkowej notatki.'}</p>
        <details><summary>Profil stanowiska z chwili oceny</summary>
          <h3>{entry.position_snapshot.title}</h3><p className="cv-text">{entry.position_snapshot.description}</p>
          <p>Samodzielność: {entry.position_snapshot.autonomy_level ?? 'Nie określono'}</p>
          {([['Zadania', entry.position_snapshot.tasks], ['KPI', entry.position_snapshot.kpis],
            ['Kompetencje', entry.position_snapshot.required_competencies], ['Wymagania zachowań', entry.position_snapshot.required_behaviors]] as const)
            .map(([label, values]) => <div key={label}><h4>{label}</h4><ul>{values.map((value, i) => <li key={i}>{value}</li>)}</ul></div>)}
        </details>
      </article>)}
      {(result.data?.length ?? 0) > 20 && <Link href={`${base}/${area.id}/history?before=${entries.at(-1)!.version}`}>Starsze wpisy</Link>}
    </>}
  </section></main>;
}
