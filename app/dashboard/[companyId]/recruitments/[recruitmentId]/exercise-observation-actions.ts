'use server';
import { revalidatePath } from 'next/cache';
import { loadBehaviorContext, type BehaviorRoute } from '../../../../../lib/behavior-context';
import { parseExerciseObservations } from '../../../../../lib/exercise-observation';
import { behaviorSchemaMissing } from '../../../../../lib/behavior-assessment';
import { exerciseUuid } from '../../../../../lib/exercise-context';
export async function saveExerciseObservations(route: BehaviorRoute, definitionId: string, version: number,
  _previous: {error?: string; entryId?: string}, form: FormData): Promise<{error?: string; entryId?: string}> {
  const {client,canEdit}=await loadBehaviorContext(route);
  if(!canEdit) return {error:'Masz dostęp tylko do odczytu.'};
  if(!exerciseUuid.test(definitionId)||!Number.isInteger(version)||version<0||version>=2147483647) return {error:'Nieprawidłowa wersja. Odśwież stronę.'};
  const rubric=await client.from('exercise_definition_entries').select('*').eq('company_id',route.companyId)
    .eq('recruitment_id',route.recruitmentId).eq('id',definitionId).maybeSingle();
  if(rubric.error||!rubric.data) return {error:'Nie udało się odczytać wersji zadania w tej rekrutacji.'};
  let value;
  try {value=parseExerciseObservations(rubric.data.definition,form);}
  catch(error){return {error:error instanceof Error?error.message:'Sprawdź obserwacje.'};}
  const result=await client.rpc('save_exercise_observations',{target_application:route.applicationId,target_definition:definitionId,
    expected_version:version,new_work_sample:value.workSample,new_observations:value.observations});
  if(result.error||!result.data){
    const code=result.error?.code;
    return {error:code==='PT409'?'Ocena zmieniła się w innym oknie. Skopiuj zmiany, odśwież i porównaj historię.':
      code==='42501'?'Nie masz uprawnień do tej oceny.':code==='55000'?'Proces jest zamknięty dla nowych ocen.':
      behaviorSchemaMissing(code)?'Zapis obserwacji nie jest jeszcze dostępny w tym środowisku.':
      'Nie udało się potwierdzić zapisu. Dane pozostały w formularzu; sprawdź historię przed ponowieniem.'};
  }
  revalidatePath(`/dashboard/${route.companyId}/recruitments/${route.recruitmentId}/applications/${route.applicationId}/exercises`,'layout');
  return {entryId:result.data};
}
