import Link from 'next/link';
import { notFound } from 'next/navigation';
import { exerciseContext } from '../../../../../../../lib/exercise-context';
import { isExerciseAiEnabled } from '../../../../../../../lib/exercise-ai';
import { loadShortlistIndividualQuestions } from '../../../../../../../lib/individual-questions';
import { IndividualQuestionsSection } from '../../individual-questions-section';

// ROADMAP R1 / C6: pytania indywidualne z luk w CV, tylko do odczytu.
// Nic nie trafia do kandydata, nie ma wywołania modelu ani zapisu.
export default async function IndividualQuestions({ params }: {
  params: Promise<{ companyId: string; recruitmentId: string }>;
}) {
  const { companyId, recruitmentId } = await params;
  // Ta sama flaga co ekrany zadań z pomocą AI; bez niej strony nie ma.
  if (!isExerciseAiEnabled(process.env.EXERCISE_AI_ENABLED)) notFound();
  const { client, canEdit, recruitment } = await exerciseContext(companyId, recruitmentId);
  if (!canEdit) notFound();
  const result = await loadShortlistIndividualQuestions(client,
    { companyId, recruitmentId, canEdit, flag: process.env.EXERCISE_AI_ENABLED });
  if (!result) notFound();
  return <main className="workspace"><section>
    <Link href={`/dashboard/${companyId}/recruitments/${recruitmentId}/exercises`}>← Zadania</Link>
    <h1>Pytania indywidualne — {recruitment.name}</h1>
    <IndividualQuestionsSection companyId={companyId} recruitmentId={recruitmentId}
      candidates={result.candidates} truncated={result.truncated}/>
  </section></main>;
}
