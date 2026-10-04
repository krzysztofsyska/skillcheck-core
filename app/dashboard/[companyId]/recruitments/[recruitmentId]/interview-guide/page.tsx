import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../../../lib/company-access';
import { buildBehaviorGuide } from '../../../../../../lib/behavior-guide';

export default async function InterviewGuide({ params }: { params: Promise<{ companyId: string; recruitmentId: string }> }) {
  const { companyId, recruitmentId } = await params;
  const { client, canEdit } = await companyAccess(companyId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recruitmentId)) notFound();
  const recruitment = await client.from('recruitments').select('id,name,position_id')
    .eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment.data) notFound();
  const position = await client.from('positions').select('id,title,required_behaviors')
    .eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle();
  if (position.error) throw new Error('Nie udało się wczytać wymagań stanowiska.');
  if (!position.data) notFound();

  const guide = buildBehaviorGuide(position.data.required_behaviors);
  const base = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  return <main className="workspace"><section>
    <Link href={base}>← Rekrutacja</Link>
    <h1>Przewodnik rozmowy</h1>
    <p>{recruitment.data.name} · {position.data.title}</p>
    <p>Pytania pomagają zebrać konkretne przykłady zachowań zawodowych. Wybierz pytania odpowiednie do zadań na stanowisku i stosuj ten sam zestaw wobec kandydatów w tej rekrutacji.</p>
    <p className="notice">Pokazany poziom to wymaganie stanowiska. Ocenę kandydata uzasadnia rekruter na podstawie odpowiedzi i obserwacji. Sygnały do dopytania nie przesądzają o wyniku rekrutacji.</p>
    <p><Link href={`/dashboard/${companyId}/positions/${position.data.id}`}>{canEdit ? 'Sprawdź lub uzupełnij wymagania stanowiska' : 'Zobacz wymagania stanowiska'}</Link></p>

    <h2>Jak zebrać dowód</h2>
    <ol>
      <li>Ustal sytuację, cel i ograniczenia zadania.</li>
      <li>Dopytaj o własną rolę kandydata i jego konkretne działania.</li>
      <li>Poproś o rezultat, sposób jego sprawdzenia i wnioski.</li>
      <li>Oddziel opis kandydata od własnej obserwacji. Zapisz, czego nadal nie udało się ustalić.</li>
    </ol>
    <p>Brak przykładu oznacza niewystarczające dane. Nie jest sam w sobie dowodem niskich kompetencji. Nie wnioskuj o zdrowiu, osobowości ani odporności psychicznej.</p>
    <p>Notatki z przeprowadzonej rozmowy zapiszesz w <Link href={`${base}#candidates`}>etapach oceny wybranego zgłoszenia</Link>. Ten przewodnik nie zapisuje odpowiedzi ani nie uruchamia rozmowy z kandydatem.</p>

    {guide.unrecognizedRequirements.length > 0 && <aside className="notice">
      <h2>Dodatkowe wymagania do sprawdzenia</h2>
      <p>Tych zapisów nie udało się powiązać z ośmioma obszarami. Sprawdź je w profilu stanowiska przed rozmową.</p>
      <ul>{guide.unrecognizedRequirements.map((requirement, index) => <li key={index} className="cv-text">{requirement}</li>)}</ul>
    </aside>}

    <h2>Osiem obszarów rozmowy</h2>
    <nav aria-label="Obszary rozmowy"><ul>
      {guide.areas.map(area => <li key={area.id}><a href={`#${area.id}`}>{area.label}</a></li>)}
    </ul></nav>
    {guide.areas.map(area => <article key={area.id} id={area.id}>
      <h2>{area.label}</h2>
      <p><strong>Wymagany poziom: {area.requiredLevel ?? 'Do uzupełnienia'}</strong></p>
      {area.requirementIssue && <p className="notice">{area.requirementIssue}</p>}
      <p>{area.definition}</p>
      <h3>Pytania sytuacyjne</h3>
      <ol>{area.questions.map(question => <li key={question}><p>{question}</p></li>)}</ol>
      <details><summary>Na co zwrócić uwagę i o co dopytać</summary>
        <h3>Przykłady działań, których warto szukać</h3>
        <ul>{area.positiveSignals.map(signal => <li key={signal}>{signal}</li>)}</ul>
        <h3>Sygnały wymagające dopytania</h3>
        <ul>{area.verificationSignals.map(signal => <li key={signal}>{signal}</li>)}</ul>
      </details>
    </article>)}

    <h2>Jak opisać wnioski</h2>
    <p>Odnieś dowody do wymagań stanowiska: niewystarczające dane, poniżej wymagań, zgodne z wymaganiami lub powyżej wymagań. Uzasadnij wniosek konkretnym działaniem i rezultatem; przy brakach wskaż dalsze pytanie albo zadanie.</p>
    <p>Przewodnik pokazuje aktualne wymagania stanowiska. W notatce zapisz także wymagany poziom z dnia rozmowy, aby późniejsza zmiana profilu nie zgubiła kontekstu.</p>
    <Link href={`${base}#candidates`}>Przejdź do zgłoszeń i notatek</Link>
  </section></main>;
}
