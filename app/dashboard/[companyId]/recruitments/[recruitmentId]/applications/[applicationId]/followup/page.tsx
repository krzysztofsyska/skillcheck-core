import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../../../lib/company-access';
import { checkpoints, followupPurposes, parseFollowupState, followupRates, observationFields, outcomeLabels, probationLabels, retainedLabels, validId } from '../../../../../../../../lib/process-followup';
import { FollowupForm } from './forms';
export default async function FollowupPage({ params }: { params: Promise<{ companyId: string; recruitmentId: string; applicationId: string }> }) {
  const { companyId, recruitmentId, applicationId } = await params;
  const { client, canEdit } = await companyAccess(companyId);
  if (![recruitmentId, applicationId].every(validId)) notFound();
  const application = await client.from('applications').select('id').eq('company_id',companyId).eq('recruitment_id',recruitmentId).eq('id',applicationId).maybeSingle();
  if (application.error || !application.data) notFound();
  const back = `/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applicationId}/assessments`;
  const header = <><Link href={back}>← Etapy oceny i dowody</Link><h1>Dalsza obserwacja i ocena wewnętrzna</h1></>;
  if (!canEdit) return <main className="workspace"><section>{header}<p>Brak uprawnienia do dalszych ocen.</p></section></main>;
  const loaded = await client.rpc('process_followup_read',{target_application:applicationId});
  let state;
  try { if (loaded.error) throw new Error(); state = parseFollowupState(loaded.data); }
  catch { return <main className="workspace"><section>{header}<p role="alert">Nie udało się wczytać obserwacji. Sprawdź dostęp lub dostępność funkcji w tym środowisku.</p></section></main>; }
  const shared = { companyId, recruitmentId, applicationId };
  const members = state.can_create ? await client.from('company_members').select('user_id,role').eq('company_id',companyId).eq('role','recruiter') : null;
  const people = members?.data?.map(m => ({user_id:m.user_id,label:`Rekruter ${m.user_id}`})) ?? [];
  const rateText = (r: {value:number|null; positive:number; measured:number;missing:number}) => r.value === null ? `Brak pomiaru (${r.missing} bez pomiaru)` : `${r.value.toFixed(0)}% — ${r.positive}/${r.measured} zmierzonych; ${r.missing} bez pomiaru`;
  return <main className="workspace"><section>{header}
    <p>Oddzielne cele: obserwacja po zatrudnieniu, ocena wewnętrzna lub ocena przy awansie. O dostępie do każdego celu decyduje właściciel firmy. Oceny i fakty zapisuje człowiek; system nie podejmuje decyzji o zatrudnieniu ani awansie.</p>
    {state.can_create && <details><summary>Rozpocznij nowy cel oceny</summary><FollowupForm {...shared} operation="create"/></details>}
    {!state.cases.length && <p>Nie masz udostępnionych celów oceny.</p>}
    {state.cases.map(c => <article key={c.id}>
      <h2>{followupPurposes[c.purpose]} — od {c.start_date}</h2>
      <h3>Kryteria i punkt odniesienia</h3><p className="cv-text">{c.criteria}</p><p className="cv-text">{c.initial_result}</p>
      {checkpoints.map(n => { const o=c.observations.find(v=>v.checkpoint===n); return <section key={n}><h3>Po {n} dniach</h3>{!o ? <p>Brak pomiaru — obserwacja nie została zapisana.</p> : <>
        <p>{outcomeLabels[o.body.outcome]} · {probationLabels[o.body.probation]} · {retainedLabels[o.body.retained]}</p>
        <dl>{Object.entries(observationFields).map(([k,v]) => <div key={k}><dt>{v}</dt><dd className="cv-text">{o.body[k as keyof typeof observationFields]}</dd></div>)}</dl>
        <p>Zapis: {new Date(o.recorded_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})}</p>
      </>}</section>; })}
      {c.can_record && c.observations.length<3 && <details><summary>Zapisz obserwację</summary><FollowupForm {...shared} caseId={c.id} operation="record" completed={c.observations.map(o=>o.checkpoint)}/></details>}
      {c.can_manage && <details><summary>Uprawnienia tego celu</summary><p>Udostępniono: {c.grants.some(g=>g.allowed) ? c.grants.filter(g=>g.allowed).map(g=>g.user_id).join(', ') : 'tylko właściciel firmy'}.</p><FollowupForm {...shared} caseId={c.id} operation="grant" members={[...people,...c.grants.filter(g=>g.allowed && !people.some(p=>p.user_id===g.user_id)).map(g=>({user_id:g.user_id,label:`Dawny dostęp ${g.user_id}`}))]}/></details>}
    </article>)}
    {state.cases.some(c=>c.purpose==='post_hire') && <><h2>Pomiar po zatrudnieniu w dostępnych celach tej osoby</h2>
      <p>Przejście próby: pozytywne wyniki / wszystkie zmierzone wyniki. Retencja: trwające zatrudnienie / wszystkie znane stany zatrudnienia. Brak pomiaru jest pomijany w mianowniku i pokazany osobno. Zakres obejmuje wyłącznie udostępnione cele tej osoby; nie jest wskaźnikiem całej firmy ani oceną osoby.</p>
      <table><thead><tr><th>Okres</th><th>Przejście próby</th><th>Retencja</th></tr></thead><tbody>{checkpoints.map(n=>{const rates=followupRates(state.cases,n);return <tr key={n}><th>{n} dni</th><td>{rateText(rates.probation)}</td><td>{rateText(rates.retention)}</td></tr>;})}</tbody></table></>}
  </section></main>;
}
