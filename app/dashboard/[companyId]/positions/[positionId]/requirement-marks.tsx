"use client";
import { useActionState } from "react";
import { setRequirementFlag } from "../../actions";
import type { EditorState } from "../../../../../lib/position-fields";
import {
  criterionKindLabels, requirementMarkLabels,
  type PositionRequirement, type RequirementMark,
} from "../../../../../lib/requirement-flags";

const choices: RequirementMark[] = ["required", "additional", "unmarked"];

function RequirementRow({ companyId, positionId, requirement, mark, canEdit }: {
  companyId: string; positionId: string; requirement: PositionRequirement;
  mark: RequirementMark; canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<EditorState, FormData>(
    setRequirementFlag.bind(null, companyId, positionId), {},
  );
  return <tr>
    <th scope="row"><small>{criterionKindLabels[requirement.kind]}</small><br />{requirement.text}</th>
    <td><strong>{requirementMarkLabels[mark]}</strong></td>
    <td>{canEdit ? <form action={action}>
      <input type="hidden" name="criterionId" value={requirement.id} />
      <input type="hidden" name="expectedText" value={requirement.text} />
      <label>Oznaczenie
        <select name="flag" defaultValue={mark}>
          {choices.map(choice => <option key={choice} value={choice}>{requirementMarkLabels[choice]}</option>)}
        </select>
      </label>
      <button disabled={pending}>Zapisz</button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.saved && <p role="status">Zapisano.</p>}
    </form> : "—"}</td>
  </tr>;
}

/**
 * SC-015 / #268. Oznaczenia żyją obok profilu stanowiska, nie w nim: zapis nie
 * zmienia wymagań, więc nie unieważnia analiz CV ani korekt rekrutera.
 */
export function RequirementMarks({ companyId, positionId, requirements, marks, canEdit }: {
  companyId: string; positionId: string; requirements: PositionRequirement[];
  marks: Record<string, RequirementMark>; canEdit: boolean;
}) {
  return <section aria-label="Oznaczenie wymagań">
    <h2>Które wymagania są konieczne</h2>
    <p>Konieczne wymagania pokazują się w raporcie kandydata i w porównaniu jako pierwsze.
      Wymagania bez oznaczenia zostają w grupie „nieoznaczone" — nic nie znika z widoku.
      Oznaczenie nie zmienia profilu stanowiska i nie uruchamia ponownej analizy CV.</p>
    {!requirements.length ? <p>Najpierw uzupełnij zadania, mierniki sukcesu i kompetencje.</p> :
      <table><thead><tr>
        <th scope="col">Wymaganie</th><th scope="col">Teraz</th><th scope="col">Zmień</th>
      </tr></thead>
      <tbody>{requirements.map(requirement => <RequirementRow key={requirement.id}
        companyId={companyId} positionId={positionId} requirement={requirement}
        mark={marks[requirement.id] ?? "unmarked"} canEdit={canEdit} />)}</tbody></table>}
  </section>;
}
