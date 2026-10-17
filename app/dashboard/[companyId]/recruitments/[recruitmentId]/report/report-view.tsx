import { kindLabels, ratingLabels, reasonLabels, shortlistLabel, type ScreeningReport } from '../../../../../../lib/screening-report';
import styles from './report.module.css';

const number = (n: number | null) => n === null ? '—' : n.toLocaleString('pl-PL', { maximumFractionDigits: 3 });
export function ScreeningReportView({ report, basePath }: { report: ScreeningReport; basePath: string }) {
  const selected = report.applications.filter(a => a.shortlist);
  return <>
    <p className="eyebrow">SKILLCHECK · PRESELEKCJA</p><h1>Raport preselekcji</h1>
    <h2>{report.recruitmentName}</h2><p>{report.companyName} · {report.positionTitle}</p>
    <p className={styles.meta}>Wygenerowano: {new Date(report.generatedAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })} (Warszawa) · {report.version}</p>
    <p className="notice">Raport wspiera ocenę człowieka. Nie jest decyzją o zatrudnieniu. Brak danych nie oznacza niespełnienia wymagań.</p>
    <p>Zgłoszenia: <strong>{report.applications.length}</strong> · W rankingu: <strong>{report.applications.filter(a => a.ranking.rankable).length}</strong>
      {' '}· Wybrane przez człowieka: <strong>{selected.length}</strong></p>
    <h2>Wymagania aktualnego stanowiska</h2>
    {report.requirements.length ? <ul>{report.requirements.map((r, i) => <li key={i}><strong>{kindLabels[r.kind]}:</strong> {r.text}</li>)}</ul> : <p>Brak zdefiniowanych kryteriów.</p>}
    <h2>Porównanie zgłoszeń</h2>
    <p>Wynik i pokrycie pochodzą z rankingu. Pokrycie to udział kryteriów, dla których są wystarczające dane. Sugestia obejmuje maksymalnie {report.targetSize} osób.</p>
    {!report.applications.length ? <p>W tej rekrutacji nie ma jeszcze zgłoszeń.</p> : <div className={styles.tableWrap}><table className={styles.table}>
      <caption>Ranking oraz shortlista zapisana przez człowieka</caption>
      <thead><tr><th scope="col">Miejsce</th><th scope="col">Zgłoszenie</th><th scope="col">Status</th><th scope="col">Wynik</th><th scope="col">Pokrycie</th><th scope="col">Sugestia</th><th scope="col">Shortlista</th></tr></thead>
      <tbody>{report.applications.map(({ ranking: r, shortlist }) => <tr key={r.application_id}>
        <td>{number(r.rank)}</td><td><a href={`#application-${r.application_id}`}>{r.application_id.slice(0, 8)}</a></td>
        <td>{reasonLabels[r.eligibility_reason]}</td><td>{number(r.raw_score)}</td><td>{r.coverage === null ? '—' : `${number(r.coverage * 100)}%`}</td>
        <td>{r.suggested_shortlist ? 'Tak' : 'Nie'}</td><td>{shortlistLabel(shortlist)}</td>
      </tr>)}</tbody></table></div>}
    <h2>Shortlista człowieka</h2>
    {!selected.length ? <p>Nikt nie został jeszcze wybrany. Sugestia systemu nie jest zapisaną shortlistą.</p> : <ul>{selected.map(({ ranking: r, shortlist: s }) => <li key={r.application_id}>
      <strong>{r.application_id.slice(0, 8)}</strong> — {shortlistLabel(s)}. Wybór {s!.source === 'manual' ? 'ręczny' : 'z sugestii'}, {new Date(s!.selected_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })} (Warszawa).
    </li>)}</ul>}
    <h2>Oceny i dowody po sprawdzeniu przez człowieka</h2>
    {report.applications.map(({ ranking: r, criteria }) => <article className={styles.application} id={`application-${r.application_id}`} key={r.application_id}>
      <h3>Zgłoszenie {r.application_id.slice(0, 8)}</h3><p className={styles.meta}>{r.application_id}</p>
      <p>{reasonLabels[r.eligibility_reason]} · Polityka: {r.ranking_policy_version}</p>
      <p className={styles.controls}><a href={`${basePath}/applications/${r.application_id}/screening`}>Otwórz preselekcję zgłoszenia</a></p>
      {!criteria.length ? <p>Brak aktualnych, zatwierdzonych dowodów do raportu. Sprawdź status zgłoszenia.</p> : criteria.map(c => <section className={styles.criterion} key={c.id}>
        <h4>{kindLabels[c.kind]}: {c.text}</h4><p><strong>{ratingLabels[c.rating]}</strong>{c.reviewedChange && <> · Korekta człowieka (ocena AI: {ratingLabels[c.aiRating]})</>}</p>
        {c.explanation && <p className={styles.text}>{c.explanation}</p>}
        {c.evidence.length ? c.evidence.map((e, i) => <blockquote className={styles.text} key={i}>{e.quote}<footer>Pozycja w zatwierdzonym tekście CV: {e.start}–{e.end}</footer></blockquote>) : <p>Brak cytatów.</p>}
      </section>)}
    </article>)}
  </>;
}
