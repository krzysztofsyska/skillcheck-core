"use client";
import { useActionState, useState } from "react";
import { recordDiagnostic, type DiagnosticFormState } from "./actions";
import {
  DIAGNOSTIC_LIMITS, diagnosticAreaLabels, diagnosticAreaQuestions, diagnosticAreas, diagnosticStatusLabels, diagnosticStatuses,
  recommendationKindLabels, recommendationKinds, recruitmentChannelLabels, recruitmentChannels,
  type DiagnosticArea, type DiagnosticContent, type DiagnosticHint,
} from "../../../../../../lib/process-diagnostics";

/**
 * SC-PROCESS / #277 część A. Formularz diagnozy: pięć stałych obszarów, kanały
 * i zalecenie. Pola są kontrolowane, więc po błędzie wpisane odpowiedzi zostają.
 * Zapis jest zawsze NOWYM wpisem w historii — wcześniejszych nie zmienia.
 */
export function DiagnosticForm({ companyId, recruitmentId, initial, latestRecordNo, hints }: {
  companyId: string; recruitmentId: string; initial: DiagnosticContent;
  /** Numer ostatniego zapisu, który widział ten formularz; czytany tylko przy montowaniu. */
  latestRecordNo: number; hints: DiagnosticHint[];
}) {
  const [state, action, pending] = useActionState<DiagnosticFormState, FormData>(
    recordDiagnostic.bind(null, companyId, recruitmentId), {},
  );
  const [areas, setAreas] = useState<Record<DiagnosticArea, { status: string; note: string }>>(initial.areas);
  const [channels, setChannels] = useState<string[]>(initial.channelsUsed);
  const [kind, setKind] = useState("");
  const [recommendation, setRecommendation] = useState("");
  // Numer rośnie tylko po własnym udanym zapisie; błąd bez numeru niczego nie cofa
  // (ten sam wzorzec co w formularzu profilu metody).
  const [knownRecordNo, setKnownRecordNo] = useState(latestRecordNo);
  const expectedRecordNo = Math.max(knownRecordNo, state.recordNo ?? 0);
  if (expectedRecordNo !== knownRecordNo) setKnownRecordNo(expectedRecordNo);
  const setArea = (area: DiagnosticArea, field: "status" | "note", value: string) =>
    setAreas(current => ({ ...current, [area]: { ...current[area], [field]: value } }));
  const toggleChannel = (channel: string) =>
    setChannels(current => current.includes(channel) ? current.filter(item => item !== channel) : [...current, channel]);
  const unchecked = diagnosticAreas.filter(area => areas[area].status === "not_checked");
  const hintFor = (area: DiagnosticArea) => hints.find(item => item.area === area)?.reason;

  return <form action={action}>
    {state.error && <p role="alert" className="notice">{state.error}</p>}
    {state.saved && <p role="status" className="notice">Diagnoza zapisana jako wpis nr {state.recordNo}. Znajdziesz ją w historii poniżej.</p>}
    <input type="hidden" name="expectedRecordNo" value={expectedRecordNo} />

    {diagnosticAreas.map(area => <fieldset key={area}>
      <legend>{diagnosticAreaLabels[area]}</legend>
      <p>{diagnosticAreaQuestions[area]}</p>
      {hintFor(area) && <p><small>Podpowiedź: {hintFor(area)}</small></p>}
      {area === "channels" && <div role="group" aria-label="Użyte kanały">
        <p>Gdzie ogłoszenie jest teraz opublikowane?</p>
        {recruitmentChannels.map(channel => <label key={channel}>
          <input type="checkbox" name="channel" value={channel} checked={channels.includes(channel)} onChange={() => toggleChannel(channel)} />{" "}
          {recruitmentChannelLabels[channel]}
        </label>)}
      </div>}
      <label>Status
        <select name={`area.${area}.status`} value={areas[area].status} onChange={event => setArea(area, "status", event.target.value)}>
          {diagnosticStatuses.map(status => <option key={status} value={status}>{diagnosticStatusLabels[status]}</option>)}
        </select>
      </label>
      <label>Krótka notatka
        <small>Co sprawdzono i co z tego wynika. Bez danych kandydatów.</small>
        <textarea name={`area.${area}.note`} rows={2} maxLength={DIAGNOSTIC_LIMITS.note} value={areas[area].note}
          onChange={event => setArea(area, "note", event.target.value)} />
      </label>
    </fieldset>)}

    <fieldset>
      <legend>Zalecenie</legend>
      <label>Co zalecasz?
        <select name="recommendationKind" value={kind} onChange={event => setKind(event.target.value)}>
          <option value="">Wybierz zalecenie</option>
          {recommendationKinds.map(item => <option key={item} value={item}>{recommendationKindLabels[item]}</option>)}
        </select>
      </label>
      {kind === "change_budget" && unchecked.length > 0 && <p className="notice">Zmianę budżetu można zalecić dopiero po sprawdzeniu
        wszystkich obszarów. Jeszcze nie sprawdzone: {unchecked.map(area => diagnosticAreaLabels[area]).join(", ")}.</p>}
      <label>Uzasadnienie zalecenia
        <textarea name="recommendation" rows={3} maxLength={DIAGNOSTIC_LIMITS.recommendation} value={recommendation}
          onChange={event => setRecommendation(event.target.value)} />
      </label>
    </fieldset>

    <p>Zapis jest notatką dla zespołu: niczego nie zmienia w rekrutacji ani w budżecie i nie dotyczy żadnego kandydata.
      Wpisu nie da się później poprawić — kolejna diagnoza to kolejny wpis w historii.</p>
    <button type="submit" disabled={pending}>Zapisz diagnozę</button>
  </form>;
}
