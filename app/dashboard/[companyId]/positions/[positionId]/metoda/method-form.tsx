"use client";
import { useActionState, useState } from "react";
import { saveMethodProfile, type MethodFormState } from "./actions";
import {
  METHOD_LIMITS, assessmentMethodLabels, assessmentMethods, responsibilityLevelHints, responsibilityLevelLabels,
  responsibilityLevels, type EvidenceRow, type MethodProfileContent,
} from "../../../../../../lib/method-profile";

type RowText = Omit<EvidenceRow, "criteria"> & { criteria: string };

/**
 * SC-METHOD / #275. Formularz profilu metody: rekruter poprawia propozycję,
 * zapisuje szkic i zatwierdza. Pola są kontrolowane, więc po błędzie wpisane
 * odpowiedzi zostają w formularzu.
 */
export function MethodForm({ companyId, positionId, initial, revision, staleCompetencies }: {
  companyId: string; positionId: string; initial: MethodProfileContent; revision: number; staleCompetencies: string[];
}) {
  const [state, action, pending] = useActionState<MethodFormState, FormData>(
    saveMethodProfile.bind(null, companyId, positionId), {},
  );
  const [profile, setProfile] = useState({
    goal: initial.goal, expectedOutcome: initial.expectedOutcome, constraints: initial.constraints,
    responsibilityLevel: initial.responsibilityLevel as string,
  });
  const [rows, setRows] = useState<RowText[]>(initial.matrix.map(row => ({ ...row, criteria: row.criteria.join("\n") })));
  const setField = (name: keyof typeof profile, value: string) => setProfile(current => ({ ...current, [name]: value }));
  const setRow = (index: number, name: keyof RowText, value: string) =>
    setRows(current => current.map((row, i) => i === index ? { ...row, [name]: value } : row));
  const removeRow = (index: number) => setRows(current => current.filter((_, i) => i !== index));
  const stale = new Set(staleCompetencies.map(item => item.trim().toLowerCase()));

  return <form action={action}>
    {state.error && <p role="alert" className="notice">{state.error}</p>}
    {state.saved && <p role="status" className="notice">Szkic zapisany. Nic nie obowiązuje, dopóki go nie zatwierdzisz.</p>}
    <input type="hidden" name="expectedRevision" value={Math.max(state.revision ?? 0, revision)} />
    <input type="hidden" name="rows" value={rows.length} />

    <label>Po co jest to stanowisko? (cel)
      <textarea name="goal" rows={3} maxLength={METHOD_LIMITS.profileText} value={profile.goal} onChange={event => setField("goal", event.target.value)} />
    </label>
    <label>Co ma być efektem pracy? (oczekiwany wynik)
      <textarea name="expectedOutcome" rows={3} maxLength={METHOD_LIMITS.profileText} value={profile.expectedOutcome} onChange={event => setField("expectedOutcome", event.target.value)} />
    </label>
    <label>Co ogranicza tę osobę? (ograniczenia)
      <small>Na przykład: budżet, procedury, decyzje wymagające zgody przełożonego.</small>
      <textarea name="constraints" rows={3} maxLength={METHOD_LIMITS.profileText} value={profile.constraints} onChange={event => setField("constraints", event.target.value)} />
    </label>
    <label>Poziom odpowiedzialności
      <select name="responsibilityLevel" value={profile.responsibilityLevel} onChange={event => setField("responsibilityLevel", event.target.value)}>
        <option value="">Wybierz poziom</option>
        {responsibilityLevels.map(level => <option key={level} value={level}>{responsibilityLevelLabels[level]} — {responsibilityLevelHints[level]}</option>)}
      </select>
    </label>

    <h2>Macierz dowodów</h2>
    <p>Dla każdej kompetencji z profilu stanowiska: po czym ją poznasz, jak ją sprawdzisz i czego z wyniku nie wolno wnioskować.</p>
    {!rows.length && <p className="notice">Profil stanowiska nie ma jeszcze kompetencji. Dopisz je w profilu stanowiska, a potem wróć tutaj.</p>}
    {rows.map((row, index) => <fieldset key={row.competency}>
      <legend>{row.competency}</legend>
      <input type="hidden" name={`matrix.${index}.competency`} value={row.competency} />
      {stale.has(row.competency.trim().toLowerCase()) && <p className="notice">Tej kompetencji nie ma już w profilu stanowiska.{" "}
        <button type="button" onClick={() => removeRow(index)}>Usuń ten wiersz</button></p>}
      <label>Oczekiwany dowód
        <textarea name={`matrix.${index}.evidence`} rows={2} maxLength={METHOD_LIMITS.rowText} value={row.evidence} onChange={event => setRow(index, "evidence", event.target.value)} />
      </label>
      <label>Metoda oceny
        <select name={`matrix.${index}.method`} value={row.method} onChange={event => setRow(index, "method", event.target.value)}>
          <option value="">Wybierz metodę</option>
          {assessmentMethods.map(method => <option key={method} value={method}>{assessmentMethodLabels[method]}</option>)}
        </select>
      </label>
      <label>Dlaczego ta metoda? (uzasadnienie)
        <textarea name={`matrix.${index}.justification`} rows={2} maxLength={METHOD_LIMITS.rowText} value={row.justification} onChange={event => setRow(index, "justification", event.target.value)} />
      </label>
      <label>Kryteria
        <small>Jedno kryterium w każdym wierszu, najwyżej {METHOD_LIMITS.criteriaPerRow}.</small>
        <textarea name={`matrix.${index}.criteria`} rows={4} value={row.criteria} onChange={event => setRow(index, "criteria", event.target.value)} />
      </label>
      <label>Granice wniosku
        <small>Czego ten wynik nie pokazuje.</small>
        <textarea name={`matrix.${index}.limits`} rows={2} maxLength={METHOD_LIMITS.rowText} value={row.limits} onChange={event => setRow(index, "limits", event.target.value)} />
      </label>
    </fieldset>)}

    <p>Zatwierdzona wersja jest trwała: późniejsza zmiana tworzy nową wersję, a zadania i próby, które już powstały, zostają przy swojej.</p>
    <button type="submit" name="intent" value="save" disabled={pending}>Zapisz szkic</button>{" "}
    <button type="submit" name="intent" value="approve" disabled={pending}>Zapisz i zatwierdź</button>
  </form>;
}
