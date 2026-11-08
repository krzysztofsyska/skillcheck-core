import Link from 'next/link';
import { notFound } from 'next/navigation';
import { exerciseContext, exerciseUuid } from '../../../../../../lib/exercise-context';
import { behaviorSchemaMissing } from '../../../../../../lib/behavior-assessment';
import { randomUUID } from 'node:crypto';
import { ExerciseGenerationForm } from '../exercise-generation-form';
export default async function Exercises({ params, searchParams }: {
  params: Promise<{companyId: string; recruitmentId: string}>; searchParams: Promise<{after?: string}>;
}) {
  const { companyId, recruitmentId } = await params;
  const { client, base, editable, recruitment, position } = await exerciseContext(companyId, recruitmentId);
  const generationEnabled=editable && process.env.EXERCISE_AI_ENABLED==='true';
  const company=generationEnabled?await client.from('company_profiles').select('updated_at').eq('company_id',companyId).maybeSingle():null;
  const { after } = await searchParams;
  if (after !== undefined && (typeof after !== 'string' || !exerciseUuid.test(after))) notFound();
  let query = client.from('latest_exercise_definitions').select('exercise_id,version,definition').eq('company_id', companyId)
    .eq('recruitment_id', recruitmentId).order('exercise_id').limit(26);
  if (after) query = query.gt('exercise_id', after);
  const result = await query;
  if (result.error && !behaviorSchemaMissing(result.error.code)) throw new Error('Nie udało się wczytać zadań.');
  const rows = result.data?.slice(0,25) ?? [];
  return <main className="workspace"><section>
    <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}`}>← Rekrutacja</Link>
    <h1>Zadania — {recruitment.name}</h1>
    <p>Testy kompetencji i ćwiczenia Assessment Center. Definicja opisuje zadanie i kryteria; nie jest oceną kandydata.</p>
    {result.error ? <p role="status">Moduł zadań nie jest jeszcze dostępny w tym środowisku.</p> : <>
      {editable && <Link href={`${base}/new`}>Utwórz zadanie</Link>}
      {generationEnabled && !company?.error && <details><summary>Przygotuj zadanie z pomocą AI</summary>
        <ExerciseGenerationForm companyId={companyId} recruitmentId={recruitmentId} requestKey={randomUUID()}
          positionStamp={position.updated_at} companyStamp={company?.data?.updated_at??null}/>
      </details>}
      {!rows.length && <p>Brak zadań na tej stronie.</p>}
      <ul>{rows.map(row => <li key={row.exercise_id}><Link href={`${base}/${row.exercise_id}`}>{row.definition.title}</Link> — wersja {row.version}, {row.definition.durationMinutes} min</li>)}</ul>
      {after && <Link href={base}>Początek listy</Link>}
      {(result.data?.length ?? 0) > 25 && <p><Link href={`${base}?after=${rows[24].exercise_id}`}>Następne zadania</Link></p>}
    </>}
  </section></main>;
}
