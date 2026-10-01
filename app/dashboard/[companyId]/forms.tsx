"use client";
import { useActionState, useState, type ChangeEvent } from "react";
import { savePosition, saveProfile, createRecruitment } from "./actions";
import { behaviorAreas, requirementLevels, type EditorState } from "../../../lib/position-fields";
import type { Position, CompanyProfile } from "../../../lib/supabase/database.types";
import { SubmitButton } from "../../components/submit-button";
function Feedback({state}: {state: EditorState}) {
  return <>{state.error && <p role="alert" className="notice">{state.error}</p>}{state.saved && <p role="status" className="notice">Zapisano.</p>}</>;
}
function useFields() {
  const [values, setValues] = useState<Record<string,string>>({});
  return (name: string, initial = "") => ({
    name, value: values[name] ?? initial,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = event.target.value;
      setValues(current => ({...current, [name]: value}));
    },
  });
}
export function PositionForm({companyId, position}: {companyId:string;position?:Position}) {
  const field = useFields();
  const [state, action] = useActionState(savePosition.bind(null, companyId, position?.id ?? null), {});
  return <form action={action}><Feedback state={state}/>
    <label>Jak nazywa się stanowisko?<input {...field("title",position?.title)} required maxLength={200}/></label>
    <label>Po co tworzysz to stanowisko? Jaki problem ma rozwiązać?<textarea {...field("description",position?.description ?? "")} rows={3} maxLength={10000}/></label>
    <label>Jakie zadania będzie wykonywać ta osoba?<small>Jedno zadanie w każdym wierszu.</small><textarea {...field("tasks",position?.tasks.join("\n"))} rows={5} required/></label>
    <label>Po czym poznasz, że dobrze wykonuje pracę?<small>Wpisz mierzalne rezultaty (KPI), każdy w osobnym wierszu.</small><textarea {...field("kpis",position?.kpis.join("\n"))} rows={4} required/></label>
    <label>Jak samodzielnie ma pracować?<select {...field("autonomy_level",String(position?.autonomy_level ?? ""))} required>
      <option value="" disabled>Wybierz poziom</option>
      <option value="1">1 — Szczegółowe instrukcje i częste wsparcie</option><option value="2">2 — Własna praca według ustalonych zasad</option>
      <option value="3">3 — Samodzielne decyzje w swoim zakresie</option><option value="4">4 — Samodzielne rozwiązywanie złożonych problemów</option><option value="5">5 — Wyznaczanie kierunku i odpowiedzialność za obszar</option>
    </select></label>
    <label>Jakie umiejętności i wiedza są potrzebne?<small>Jedna kompetencja w każdym wierszu.</small><textarea {...field("required_competencies",position?.required_competencies.join("\n"))} rows={4}/></label>
    <fieldset><legend>Sposób działania — wymagania stanowiska</legend><p>Oceń wymagany poziom zachowań zawodowych dla tego stanowiska.</p>
      <div className="field-grid">{behaviorAreas.map(([key,label]) => <label key={key}>{label}<select {...field(key,position?.required_behaviors.find(s=>s.startsWith(label+": "))?.slice(label.length+2) ?? "Standardowy")} required>{requirementLevels.map(level=><option key={level}>{level}</option>)}</select></label>)}</div>
    </fieldset>
    <SubmitButton>{position ? "Zapisz zmiany" : "Zapisz profil stanowiska"}</SubmitButton>
  </form>;
}
export function ProfileForm({companyId, profile}: {companyId:string;profile:CompanyProfile|null}) {
  const [state,action] = useActionState(saveProfile.bind(null,companyId),{});
  return <form action={action}><Feedback state={state}/>
    <label>Branża<input name="industry" maxLength={200} defaultValue={profile?.industry ?? ""}/></label>
    <label>Czym zajmuje się firma?<textarea name="description" rows={3} maxLength={10000} defaultValue={profile?.description ?? ""}/></label>
    <label>Środowisko pracy<textarea name="work_environment" rows={3} maxLength={5000} defaultValue={profile?.work_environment ?? ""}/></label>
    <label>Wartości firmy<small>Jedna wartość w każdym wierszu.</small><textarea name="company_values" rows={3} defaultValue={profile?.company_values.join("\n")}/></label>
    <SubmitButton>Zapisz profil firmy</SubmitButton>
  </form>;
}
export function RecruitmentForm({companyId,positions}: {companyId:string;positions:Pick<Position,"id"|"title">[]}) {
  const [state,action]=useActionState(createRecruitment.bind(null,companyId),{});
  return <form action={action}><Feedback state={state}/><label>Nazwa rekrutacji<input name="name" maxLength={200} required/></label>
    <label>Stanowisko<select name="position_id" required defaultValue=""><option value="" disabled>Wybierz stanowisko</option>{positions.map(p=><option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
    <SubmitButton>Utwórz rekrutację</SubmitButton>
  </form>;
}
