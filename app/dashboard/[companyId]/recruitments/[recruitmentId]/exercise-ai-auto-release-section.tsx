import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../../lib/supabase/database.types';
import { ExerciseAiAutoReleaseSwitch } from './exercise-ai-auto-release';
import { exerciseAiAutoAccessEnabled, parseExerciseAiAutoAccess } from '../../../../../lib/exercise-ai-auto-access';
import type { ExerciseAiAutoAccess as AutoAccess } from '../../../../../lib/exercise-ai-auto-access';

type Props = { client: SupabaseClient<Database>; companyId: string; recruitmentId: string; canEdit: boolean; editable: boolean };

/** R1-SWITCH: tylko właściciel/rekruter i tylko przy włączonych propozycjach AI (EXERCISE_AI_ENABLED). */
export async function ExerciseAiAutoReleaseSection({ client, companyId, recruitmentId, canEdit, editable }: Props) {
  if (process.env.EXERCISE_AI_ENABLED !== 'true' || !canEdit) return null;
  const read = await client.rpc('read_exercise_ai_settings', { target_company: companyId, target_recruitment: recruitmentId });
  const current = read.error || typeof read.data !== 'boolean' ? null : read.data;
  // R1-AUTO-ACCESS: w trybie automatycznym baza wydaje dostęp do zwolnionego testu AI kandydatom
  // z krótkiej listy (bez kliknięcia, idempotentnie) i zwraca listę. Niczego nie wysyła kandydatom.
  let access: AutoAccess | null | undefined;
  if (current === true && exerciseAiAutoAccessEnabled()) {
    const result = await client.rpc('issue_exercise_ai_auto_access', { target_company: companyId, target_recruitment: recruitmentId });
    access = result.error ? null : parseExerciseAiAutoAccess(result.data);
  }
  return <>
    <ExerciseAiAutoReleaseSwitch companyId={companyId} recruitmentId={recruitmentId} current={current} editable={editable}/>
    {access !== undefined && <ExerciseAiAutoAccessList value={access} companyId={companyId} recruitmentId={recruitmentId}/>}
  </>;
}

export function ExerciseAiAutoAccessList({ value, companyId, recruitmentId }: { value: AutoAccess | null; companyId: string; recruitmentId: string }) {
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}/applications`;
  return <section>
    <h2>Dostęp do testu kompetencji wydany automatycznie</h2>
    {!value ? <p role="alert">Nie udało się sprawdzić ani wydać dostępu automatycznie. Odśwież stronę za chwilę.</p> : <>
      <p>W trybie „Automatycznie” kandydaci z krótkiej listy dostają dostęp do zatwierdzonego testu bez Twojego kliknięcia.
        Nic nie jest wysyłane kandydatom: link przekazujesz sam. Na stronie zadań kandydata wybierz „Rotuj link”, aby otrzymać link do przekazania.</p>
      {value.issued > 0 && <p role="status">Wydano teraz: {value.issued}.</p>}
      {value.truncated && <p>Pokazano {value.access.length} najnowszych z {value.total} dostępów wydanych automatycznie.</p>}
      {value.access.length === 0 ? <p>Brak dostępów wydanych automatycznie.</p> : <ul>{value.access.map(row => <li key={row.grantId}>
        {row.candidateName || 'Kandydat'} — {row.title} (wersja {row.version}) · {row.revoked ? 'dostęp odwołany' : `rozpoczęcie do ${row.startBy}`}
        {' '}<Link href={`${base}/${row.applicationId}/exercises`}>Strona zadań kandydata (link do przekazania)</Link>
      </li>)}</ul>}
    </>}
  </section>;
}
