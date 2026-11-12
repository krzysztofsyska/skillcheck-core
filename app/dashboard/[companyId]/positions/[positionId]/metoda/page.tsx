import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../../../lib/company-access";
import {
  alignMatrix, assessmentMethodLabels, isAssessmentMethod, isResponsibilityLevel, parseMethodProfileState, parseMethodVersion,
  positionCompetencies, proposeMethodProfile, responsibilityLevelLabels, responsibilityLevels,
  type MethodApprovedVersion, type MethodProfileContent,
} from "../../../../../../lib/method-profile";
import { MethodForm } from "./method-form";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (value: string) => value ? new Date(value).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "—";
const levelLabel = (value: string) => isResponsibilityLevel(value) ? responsibilityLevelLabels[value] : "—";

function VersionView({ version }: { version: MethodApprovedVersion }) {
  const content = version.content;
  return <>
    <p>Wersja {version.version_no}, zatwierdzona {when(version.approved_at)}. Poziom odpowiedzialności: <strong>{levelLabel(content.responsibilityLevel)}</strong>.</p>
    <dl>
      <dt>Cel</dt><dd>{content.goal}</dd>
      <dt>Oczekiwany wynik</dt><dd>{content.expectedOutcome}</dd>
      <dt>Ograniczenia</dt><dd>{content.constraints}</dd>
    </dl>
    <table><thead><tr>
      <th scope="col">Kompetencja</th><th scope="col">Oczekiwany dowód</th><th scope="col">Metoda i uzasadnienie</th>
      <th scope="col">Kryteria</th><th scope="col">Granice wniosku</th>
    </tr></thead>
    <tbody>{content.matrix.map(row => <tr key={row.competency}>
      <th scope="row">{row.competency}</th>
      <td>{row.evidence}</td>
      <td><strong>{isAssessmentMethod(row.method) ? assessmentMethodLabels[row.method] : "—"}</strong><br />{row.justification}</td>
      <td><ul>{row.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></td>
      <td>{row.limits}</td>
    </tr>)}</tbody></table>
    <p><small>Odcisk wersji: {version.content_hash.slice(0, 12)}</small></p>
  </>;
}

/**
 * SC-METHOD / #275 — profil metody stanowiska: propozycja dla poziomu
 * odpowiedzialności, korekta rekrutera, zatwierdzenie, aktualna wersja i historia.
 * Kontrakt: docs/sc-method-275.md.
 */
export default async function MethodPage({ params, searchParams }: {
  params: Promise<{ companyId: string; positionId: string }>;
  searchParams: Promise<{ poziom?: string; wersja?: string; zapisano?: string }>;
}) {
  const { companyId, positionId } = await params;
  const { client, canEdit } = await companyAccess(companyId);
  if (!uuid.test(positionId)) notFound();
  const { data: position, error } = await client.from("positions").select("*").eq("company_id", companyId).eq("id", positionId).maybeSingle();
  if (error) throw new Error("Nie udało się wczytać stanowiska.");
  if (!position) notFound();
  const { poziom, wersja, zapisano } = await searchParams;
  const back = `/dashboard/${companyId}/positions/${positionId}`;
  const header = <><Link href={back}>← {position.title}</Link><p className="eyebrow">PROFIL METODY</p><h1>Jak sprawdzamy kompetencje: {position.title}</h1></>;

  const loaded = await client.rpc("method_profile_state", { target_company: companyId, target_position: positionId });
  const state = loaded.error ? null : parseMethodProfileState(loaded.data);
  if (!state) {
    return <main className="workspace"><section>{header}
      <p role="alert" className="notice">{["PGRST202", "42883"].includes(loaded.error?.code ?? "")
        ? "Profil metody nie jest jeszcze dostępny w tym środowisku."
        : "Nie udało się wczytać profilu metody. Odśwież stronę."}</p>
    </section></main>;
  }

  const competencies = positionCompetencies(position);
  const requestedLevel = isResponsibilityLevel(poziom) ? poziom : null;
  const editable = canEdit && state.can_edit && position.status !== "archived";
  // Źródło formularza: wybrana propozycja -> zapisany szkic -> zatwierdzona wersja -> propozycja domyślna.
  const source: MethodProfileContent = requestedLevel ? proposeMethodProfile(position, requestedLevel).content
    : state.draft?.content ?? state.approved?.content ?? proposeMethodProfile(position, "specialist").content;
  const initial = alignMatrix(source, position.required_competencies);
  const known = new Set(competencies.map(item => item.toLowerCase()));
  const staleCompetencies = initial.matrix.map(row => row.competency).filter(item => !known.has(item.trim().toLowerCase()));
  const origin = requestedLevel ? `propozycja dla poziomu „${responsibilityLevelLabels[requestedLevel]}”`
    : state.draft ? `szkic zapisany ${when(state.draft.updated_at)}`
    : state.approved ? `zatwierdzona wersja ${state.approved.version_no}` : "propozycja dla poziomu „Specjalista”";

  let viewed: MethodApprovedVersion | null = null;
  if (wersja && uuid.test(wersja) && wersja !== state.approved?.id) {
    const older = await client.rpc("method_profile_version", { target_company: companyId, target_version: wersja });
    const parsed = older.error ? null : parseMethodVersion(older.data);
    // Wersja innego stanowiska tej samej firmy nie należy do tej strony.
    viewed = parsed && state.history.some(item => item.id === parsed.id) ? parsed : null;
  }

  return <main className="workspace"><section>{header}
    <p>Tu ustalasz, po czym poznasz każdą kompetencję, jaką metodą ją sprawdzisz i czego z wyniku nie wolno wnioskować.
      System podpowiada propozycję dopasowaną do poziomu stanowiska — Ty ją poprawiasz i zatwierdzasz.
      To materiał dla rekrutera; system nie podejmuje decyzji o kandydacie.</p>
    {zapisano === "zatwierdzono" && <p role="status" className="notice">Profil metody został zatwierdzony jako nowa wersja.</p>}

    <h2>Obowiązująca wersja</h2>
    {state.approved ? <VersionView version={state.approved} /> : <p>Nie ma jeszcze zatwierdzonej wersji.</p>}

    {editable ? <>
      <h2>{state.approved ? "Przygotuj nową wersję" : "Przygotuj profil metody"}</h2>
      <p>W formularzu: {origin}. Możesz też zacząć od propozycji dla innego poziomu:{" "}
        {responsibilityLevels.map((level, index) => <span key={level}>{index > 0 && " · "}
          <Link href={`${back}/metoda?poziom=${level}`}>{responsibilityLevelLabels[level]}</Link></span>)}
        {requestedLevel && <> · <Link href={`${back}/metoda`}>wróć do zapisanej treści</Link></>}.
        Propozycja niczego nie zapisuje, dopóki nie klikniesz „Zapisz szkic”.</p>
      {/* Klucz bez numeru szkicu: zapis szkicu nie może przeładować formularza i zgubić potwierdzenia. */}
      <MethodForm key={`${requestedLevel ?? "stan"}:${state.approved?.id ?? ""}:${competencies.join("|")}`}
        companyId={companyId} positionId={positionId} initial={initial}
        revision={state.draft?.revision ?? 0} staleCompetencies={staleCompetencies} />
    </> : <p className="notice">{position.status === "archived"
      ? "Stanowisko jest zarchiwizowane, więc profilu metody nie można już zmieniać."
      : "Masz dostęp tylko do odczytu. Profil metody zmienia właściciel konta lub rekruter."}</p>}

    <h2>Historia wersji</h2>
    {!state.history.length ? <p>Brak zatwierdzonych wersji.</p> :
      <table><thead><tr><th scope="col">Wersja</th><th scope="col">Zatwierdzona</th><th scope="col">Poziom</th><th scope="col">Podgląd</th></tr></thead>
      <tbody>{state.history.map(item => <tr key={item.id}>
        <th scope="row">{item.version_no}</th><td>{when(item.approved_at)}</td><td>{levelLabel(item.responsibility_level)}</td>
        <td>{item.id === state.approved?.id ? "obowiązuje" : <Link href={`${back}/metoda?wersja=${item.id}`}>Pokaż</Link>}</td>
      </tr>)}</tbody></table>}
    {viewed && <section aria-label="Wcześniejsza wersja"><h2>Wcześniejsza wersja {viewed.version_no}</h2>
      <p>Ta wersja nie obowiązuje dla nowych zadań. Zadania utworzone, gdy obowiązywała, pozostają z nią związane.</p>
      <VersionView version={viewed} /></section>}
  </section></main>;
}
