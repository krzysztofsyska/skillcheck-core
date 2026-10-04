import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { exerciseContext } from '../../../../../../../lib/exercise-context';
import { behaviorSchemaMissing } from '../../../../../../../lib/behavior-assessment';
import { ExerciseForm } from '../../exercise-form';
export default async function NewExercise({params}: {params: Promise<{companyId: string; recruitmentId: string}>}) {
  const {companyId,recruitmentId} = await params;
  const {client,base,position,editable} = await exerciseContext(companyId,recruitmentId);
  const probe = await client.from('latest_exercise_definitions').select('id').eq('company_id',companyId).eq('recruitment_id',recruitmentId).limit(1);
  if (probe.error && !behaviorSchemaMissing(probe.error.code)) throw new Error('Nie udało się sprawdzić dostępności zadań.');
  return <main className="workspace"><section><Link href={base}>← Zadania</Link><h1>Utwórz zadanie</h1>
    {probe.error ? <p>Moduł zadań nie jest jeszcze dostępny w tym środowisku.</p> : !editable ? <p>Masz dostęp tylko do odczytu lub proces jest zamknięty.</p> :
      <ExerciseForm companyId={companyId} context={{recruitmentId,exerciseId:randomUUID(),expectedVersion:0,positionId:position.id,positionUpdatedAt:position.updated_at}}/>}
  </section></main>;
}
