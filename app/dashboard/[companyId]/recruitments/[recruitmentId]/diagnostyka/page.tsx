import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../../lib/company-access";
import {
  diagnosticAreaLabels, diagnosticAreas, diagnosticStatusLabels, emptyDiagnosticContent, parseDiagnosticsState, proposeDiagnosticAreas,
  recommendationKindLabels, recruitmentChannelLabels,
} from "../../../../../../lib/process-diagnostics";
import { describeMetrics, describeScope } from "../../../../../../lib/process-metrics";
import { checkpoints, parseRecruitmentFollowupMetrics, recruitmentFollowupRateText } from "../../../../../../lib/process-followup";
import { DiagnosticForm } from "./diagnostic-form";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (value: string | null) => value ? new Date(value).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "—";
const day = (value: string | null) => value ? new Date(value).toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" }) : "—";
const weekLabel = (weeksAgo: number) => weeksAgo === 0 ? "ostatnie 7 dni" : `${weeksAgo * 7 + 1}–${(weeksAgo + 1) * 7} dni temu`;

/**
 * SC-PROCESS / #277 część A — diagnostyka rekrutacji: napływ CV, lista pięciu
 * obszarów do sprawdzenia przed zmianą budżetu, historia diagnoz i wskaźniki
 * czasu z definicją i zakresem danych. Kontrakt: docs/sc-process-277.md.
 * Strona nie ocenia kandydatów i nie podejmuje żadnej decyzji.
 */
export default async function DiagnosticsPage({ params }: { params: Promise<{ companyId: string; recruitmentId: string }> }) {
  const { companyId, recruitmentId } = await params;
  const { client, canEdit } = await companyAccess(companyId);
  if (!uuid.test(recruitmentId)) notFound();
  const { data: recruitment, error } = await client.from("recruitments").select("id,name,position_id")
    .eq("company_id", companyId).eq("id", recruitmentId).maybeSingle();
  if (error) throw new Error("Nie udało się wczytać rekrutacji.");
  if (!recruitment) notFound();
  const back = `/dashboard/${companyId}/recruitments/${recruitmentId}`;
  const header = <><Link href={back}>← {recruitment.name}</Link><p className="eyebrow">DIAGNOSTYKA REKRUTACJI</p><h1>Napływ CV i czas rekrutacji: {recruitment.name}</h1></>;

  const loaded = await client.rpc("process_diagnostics_state", { target_company: companyId, target_recruitment: recruitmentId });
  const state = loaded.error ? null : parseDiagnosticsState(loaded.data);
  if (!state) {
    return <main className="workspace"><section>{header}
      <p role="alert" className="notice">{["PGRST202", "42883"].includes(loaded.error?.code ?? "")
        ? "Diagnostyka rekrutacji nie jest jeszcze dostępna w tym środowisku."
        : "Nie udało się wczytać diagnostyki. Odśwież stronę."}</p>
    </section></main>;
  }
  const position = await client.from("positions").select("title,description,tasks")
    .eq("company_id", companyId).eq("id", recruitment.position_id).maybeSingle();
  if (position.error) throw new Error("Nie udało się wczytać stanowiska.");
  const measured = await client.rpc("process_recruitment_metrics", { target_company: companyId, target_recruitment: recruitmentId });
  // Błąd odczytu wskaźników nie zamienia się w zera: każdy wskaźnik pokaże wtedy „brak pomiaru".
  const metrics = describeMetrics(measured.error ? null : measured.data).filter(m => !['probation_pass_rate','retention_rate'].includes(m.key));
  // This separate RPC scopes candidate-linked observations to each caller's explicit grants.
  // RPCs take NOWAIT locks on the same visible cases: serialize checkpoints to avoid self-conflicts.
  const followupMetrics: {checkpoint: number; data: ReturnType<typeof parseRecruitmentFollowupMetrics>}[] = [];
  for (const checkpoint of checkpoints) {
    const result = await client.rpc("process_followup_recruitment_metrics", { target_company: companyId, target_recruitment: recruitmentId, checkpoint });
    followupMetrics.push({ checkpoint, data: result.error ? null : parseRecruitmentFollowupMetrics(result.data) });
  }

  const { inflow, history } = state;
  const proposal = proposeDiagnosticAreas({
    status: inflow.status, daysOpen: inflow.days_open, applicationsTotal: inflow.total, applicationsLast14Days: inflow.last_14_days,
    title: position.data?.title ?? "", description: position.data?.description ?? null, tasks: position.data?.tasks ?? [],
  });
  const editable = canEdit && state.can_edit;
  // Formularz zaczyna od ostatniej diagnozy (żeby nie przepisywać), ale zawsze zapisuje nowy wpis.
  const initial = history[0]?.content ?? emptyDiagnosticContent();

  return <main className="workspace"><section>{header}
    <p>Gdy zgłoszeń jest mało, najpierw sprawdź, czy kandydaci w ogóle widzą ogłoszenie i czy je rozumieją — dopiero potem
      rozważ większy budżet. Ta strona pokazuje liczby, podpowiada, od czego zacząć, i zapisuje, co zostało sprawdzone.
      Niczego nie zmienia sama i nie ocenia kandydatów.</p>

    <h2>Napływ CV</h2>
    <p><strong>{proposal.levelText}</strong></p>
    <dl>
      <dt>Rekrutacja trwa</dt><dd>{inflow.days_open} dni (od {day(inflow.started_at)}{inflow.start_source === "created_at" ? ", liczone od utworzenia rekrutacji" : ""}{inflow.closed_at ? `, zamknięta ${day(inflow.closed_at)}` : ""})</dd>
      <dt>Wszystkie CV</dt><dd>{inflow.total}</dd>
      <dt>Ostatnie 7 / 14 / 30 dni</dt><dd>{inflow.last_7_days} / {inflow.last_14_days} / {inflow.last_30_days}</dd>
      <dt>Ostatnie zgłoszenie</dt><dd>{inflow.total ? when(inflow.last_application_at) : "brak zgłoszeń"}</dd>
    </dl>
    <table><caption>Zgłoszenia w kolejnych tygodniach</caption>
      <thead><tr><th scope="col">Okres</th><th scope="col">Liczba CV</th></tr></thead>
      <tbody>{inflow.weekly.map(week => <tr key={week.weeks_ago}><th scope="row">{weekLabel(week.weeks_ago)}</th><td>{week.count}</td></tr>)}</tbody>
    </table>
    <p><small>Liczby są liczone na bieżąco z istniejących zgłoszeń. Zgłoszenia usunięte na żądanie kandydata nie są liczone.</small></p>

    <h2>Od czego zacząć</h2>
    {proposal.hints.length ? <ol>{proposal.hints.map(hint => <li key={hint.area}><strong>{diagnosticAreaLabels[hint.area]}:</strong> {hint.reason}</li>)}</ol>
      : <p>Proste sprawdzenie profilu stanowiska nie wskazało nic oczywistego. Przejdź listę poniżej po kolei.</p>}
    <p><small>To podpowiedź z prostych faktów (liczba zgłoszeń, długość nazwy, liczba zadań, treść opisu), a nie diagnoza. Decyduje rekruter.</small></p>

    <h2>Lista do sprawdzenia przed zmianą budżetu</h2>
    {editable ? <DiagnosticForm companyId={companyId} recruitmentId={recruitmentId}
        initial={initial} latestRecordNo={state.latest_record_no} hints={proposal.hints} />
      : <p className="notice">Masz dostęp tylko do odczytu. Diagnozę zapisuje właściciel konta lub rekruter.</p>}

    <h2>Historia diagnoz</h2>
    {!history.length ? <p>Nie zapisano jeszcze żadnej diagnozy.</p> : history.map(record => <article key={record.id}>
      <h3>Wpis nr {record.record_no} — {when(record.created_at)}</h3>
      <p><strong>Zalecenie: {recommendationKindLabels[record.recommendation_kind]}.</strong> {record.recommendation}</p>
      <p>W chwili zapisu: {record.inflow_snapshot.total ?? "—"} CV łącznie, {record.inflow_snapshot.last_14_days ?? "—"} w ostatnich 14 dniach,
        rekrutacja trwała {record.inflow_snapshot.days_open ?? "—"} dni.</p>
      <ul>{diagnosticAreas.map(area => <li key={area}><strong>{diagnosticAreaLabels[area]}:</strong> {diagnosticStatusLabels[record.content.areas[area].status]}
        {record.content.areas[area].note && <> — {record.content.areas[area].note}</>}</li>)}</ul>
      <p>Kanały: {record.content.channelsUsed.length ? record.content.channelsUsed.map(channel => recruitmentChannelLabels[channel]).join(", ") : "nie podano"}.</p>
    </article>)}

    <h2>Wskaźniki czasu rekrutacji</h2>
    <p>Każdy wskaźnik ma definicję i zakres danych. „Brak pomiaru” znaczy, że nie ma z czego policzyć wyniku — to nie jest zero ani zły wynik.</p>
    <table><thead><tr><th scope="col">Wskaźnik</th><th scope="col">Wynik</th><th scope="col">Definicja</th><th scope="col">Zakres danych</th></tr></thead>
      <tbody>{metrics.map(metric => <tr key={metric.key}>
        <th scope="row">{metric.label}</th>
        <td>{metric.state === "measured" ? <strong>{metric.display}</strong> : metric.display}</td>
        <td>{metric.definition}</td>
        <td>{metric.dataScope} {metric.availableToday && <small>{describeScope(metric)}</small>}</td>
      </tr>)}</tbody>
    </table>
    <h2>Przejście próby i retencja po zatrudnieniu</h2>
    <p>Zakres: tylko udostępnione Ci obserwacje po zatrudnieniu w tej rekrutacji. Każde zgłoszenie liczymy raz, z jego najnowszego dostępnego celu po zatrudnieniu. Oceny wewnętrzne i awansowe oraz zamrożone dane nie są liczone.</p>
    <p>Przejście próby to pozytywne wyniki / wszystkie zmierzone wyniki próby. Retencja to trwające zatrudnienie / wszystkie znane stany zatrudnienia. Brak obserwacji lub brak pomiaru nie jest wynikiem negatywnym i nie wchodzi do mianownika.</p>
    <table><thead><tr><th scope="col">Okres</th><th scope="col">Dostępne zgłoszenia</th><th scope="col">Przejście próby</th><th scope="col">Retencja</th></tr></thead>
      <tbody>{followupMetrics.map(({checkpoint,data})=><tr key={checkpoint}><th scope="row">{checkpoint} dni</th><td>{data?.population ?? "dane niedostępne"}</td><td>{recruitmentFollowupRateText(data?.probation ?? null)}</td><td>{recruitmentFollowupRateText(data?.retention ?? null)}</td></tr>)}</tbody>
    </table>
    <p><small>Wskaźniki mierzą czas i przebieg rekrutacji, nie ludzi. Obserwacje 30/90/180 dni zapisuje uprawniona osoba na stronie etapów oceny konkretnego zgłoszenia. Wyniki nie podejmują decyzji kadrowych.</small></p>
  </section></main>;
}
