import Link from 'next/link';
import { loadBehaviorContext, type BehaviorRoute } from '../../../../../../../../lib/behavior-context';
import { buildBehaviorGuide } from '../../../../../../../../lib/behavior-guide';
import { behaviorEditingOpen, behaviorModuleUnavailable, behaviorRatings, behaviorSchemaMissing } from '../../../../../../../../lib/behavior-assessment';
import { BehaviorForm } from '../../../behavior-form';

export default async function Behaviors({ params }: { params: Promise<BehaviorRoute> }) {
  const route = await params;
  const { client, canEdit, user, application, recruitment, candidate, position, base } = await loadBehaviorContext(route);
  const current = await client.from('latest_behavior_assessments').select('*').eq('company_id', route.companyId)
    .eq('recruitment_id', route.recruitmentId).eq('application_id', route.applicationId);
  const unavailable = current.error && behaviorSchemaMissing(current.error.code);
  if (current.error && !unavailable) throw new Error('Nie udało się wczytać ocen.');
  const guide = buildBehaviorGuide(position.required_behaviors);
  const open = behaviorEditingOpen(application.status, recruitment.status, position.status);
  const recruitmentPath = `/dashboard/${route.companyId}/recruitments/${route.recruitmentId}`;
  return <main className="workspace"><section>
    <Link href={`${recruitmentPath}/applications/${route.applicationId}/assessments`}>← Etapy oceny</Link>
    <h1>Oceny z dowodami — {candidate.first_name} {candidate.last_name}</h1>
    <p>{recruitment.name} · {position.title}</p>
    <p className="notice">Oceny zapisuje człowiek na podstawie rozmowy lub zadania. Nie są diagnozą osobowości ani automatyczną decyzją rekrutacyjną. Brak dowodów oznacza niewystarczające dane.</p>
    <p><Link href={`${recruitmentPath}/interview-guide`}>Przewodnik rozmowy</Link> · <Link href={`/dashboard/${route.companyId}/positions/${position.id}`}>Wymagania stanowiska</Link></p>
    {unavailable ? <p role="status">{behaviorModuleUnavailable}</p> : <>
      {!canEdit && <p>Masz dostęp tylko do odczytu ocen i ich historii.</p>}
      {!open && <p>Nowe oceny są wyłączone ze względu na status zgłoszenia, rekrutacji lub stanowiska. Historia pozostaje dostępna.</p>}
      {guide.unrecognizedRequirements.length > 0 && <p role="alert">Profil zawiera nierozpoznane wymagania. Sprawdź je w profilu stanowiska.</p>}
      {guide.areas.map(area => {
        const entry = current.data?.find(row => row.area_key === area.id);
        const changed = entry && (entry.position_id !== position.id || entry.position_updated_at !== position.updated_at);
        return <article key={area.id} id={area.id}><h2>{area.label}</h2><p>{area.definition}</p>
          <p>Aktualny wymagany poziom: <strong>{area.requiredLevel ?? 'Do uzupełnienia'}</strong></p>
          {area.requirementIssue && <p role="alert">{area.requirementIssue}</p>}
          {entry ? <>
            <p>Ostatnia ocena: <strong>{behaviorRatings.find(([key]) => key === entry.rating)?.[1]}</strong> · wersja {entry.version}</p>
            <p>Wymagany poziom przy zapisie: {entry.required_level}. Autor: {entry.author_id === user.id ? 'Ty' : entry.author_id}.
              {' '}{new Date(entry.created_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}.</p>
            <p className="cv-text">{entry.evidence || 'Nie zapisano dodatkowej notatki.'}</p>
            {changed && <p className="notice">Profil stanowiska zmienił się od tej oceny. Poprzedni wpis dotyczy dawnych wymagań. Nową ocenę uzasadnij względem aktualnego profilu.</p>}
            <p><Link href={`${base}/${area.id}/history`}>Historia ocen i wymagań — {area.label}</Link></p>
          </> : <p>Brak zapisanej oceny. Nie oznacza to oceny poniżej wymagań.</p>}
          {canEdit && open && area.requiredLevel && <BehaviorForm {...route} areaKey={area.id}
            positionId={position.id} positionUpdatedAt={position.updated_at} assessment={entry}/>}
        </article>;
      })}
    </>}
  </section></main>;
}
