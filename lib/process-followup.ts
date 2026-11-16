/** Explicit human follow-up; no score, ranking, prediction or personnel decision. */
export const followupPurposes = { post_hire: 'Obserwacja po zatrudnieniu', internal_assessment: 'Ocena wewnętrzna', promotion: 'Ocena przy awansie' } as const;
export const observationFields = { tasks: 'Faktyczne zadania i ich wykonanie', onboarding: 'Jakość wdrożenia', resources: 'Dostępne zasoby', support: 'Wsparcie zespołu i przełożonego', autonomy: 'Zakres autonomii', evidence: 'Dowody lub powód braku pomiaru' } as const;
export const outcomeLabels = { met: 'Kryteria spełnione', not_met: 'Kryteria niespełnione', not_measured: 'Brak pomiaru' } as const;
export const probationLabels = { passed: 'Próba zakończona pozytywnie', failed: 'Próba zakończona negatywnie', not_measured: 'Brak pomiaru' } as const;
export const retainedLabels = { yes: 'Nadal zatrudniony', no: 'Zatrudnienie zakończone', not_measured: 'Brak pomiaru' } as const;
export const checkpoints = [30, 90, 180] as const;
export type Purpose = keyof typeof followupPurposes;
export type Observation = Record<keyof typeof observationFields, string> & { outcome: keyof typeof outcomeLabels; probation: keyof typeof probationLabels; retained: keyof typeof retainedLabels };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Nieprawidłowe dane obserwacji.'); return v as Record<string, unknown>; };
const pick = <T extends Record<string, string>>(v: unknown, labels: T): keyof T => { if (typeof v !== 'string' || !Object.hasOwn(labels, v)) throw new Error('Wybierz prawidłową wartość.'); return v as keyof T; };
const text = (v: unknown, max = 2000) => { if (typeof v !== 'string' || !v.trim() || Array.from(v.trim()).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new Error(`Uzupełnij treść (maksymalnie ${max} znaków).`); return v.trim(); };
export function parseObservation(value: unknown): Observation {
  const v = obj(value);
  return { ...Object.fromEntries(Object.keys(observationFields).map(k => [k, text(v[k])])) as Record<keyof typeof observationFields,string>, outcome: pick(v.outcome, outcomeLabels), probation: pick(v.probation, probationLabels), retained: pick(v.retained, retainedLabels) };
}
export function observationForm(form: FormData) {
  const checkpoint = Number(form.get('checkpoint'));
  if (!checkpoints.includes(checkpoint as 30)) throw new Error('Wybierz okres 30, 90 lub 180 dni.');
  return { checkpoint, observation: parseObservation(Object.fromEntries([...Object.keys(observationFields), 'outcome', 'probation', 'retained'].map(k => [k, form.get(k)]))) };
}
const longText = (v: unknown) => { const s=text(v,4000); if(Array.from(s).length<10) throw new Error('Kryteria i wynik początkowy wymagają co najmniej 10 znaków.'); return s; };
export function followupForm(form: FormData) {
  const start_date = form.get('start_date');
  if (typeof start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !Number.isFinite(Date.parse(start_date)) || new Date(start_date).toISOString().slice(0,10) !== start_date) throw new Error('Podaj prawidłową datę rozpoczęcia.');
  return { purpose: pick(form.get('purpose'), followupPurposes), start_date, criteria: longText(form.get('criteria')), initial_result: longText(form.get('initial_result')) };
}
export type FollowupCase = { id: string; purpose: Purpose; start_date: string; criteria: string; initial_result: string; can_manage: boolean; can_record: boolean; grants: {user_id:string;allowed:boolean}[]; observations: { id: string; checkpoint: number; recorded_at: string; body: Observation }[] };
export function parseFollowupState(value: unknown): { can_create: boolean; cases: FollowupCase[] } {
  const root = obj(value);
  if (typeof root.can_create !== 'boolean' || !Array.isArray(root.cases)) throw new Error('Nieprawidłowe dane obserwacji.');
  return { can_create: root.can_create, cases: root.cases.map(raw => {
    const c = obj(raw);
    if (!validId(c.id) || typeof c.can_manage !== 'boolean' || typeof c.can_record !== 'boolean' || !Array.isArray(c.grants) || !c.grants.every(g => !!g && typeof g === 'object' && validId(g.user_id) && typeof g.allowed === 'boolean') || !Array.isArray(c.observations)) throw new Error('Nieprawidłowe dane obserwacji.');
    return { id: c.id, purpose: pick(c.purpose, followupPurposes), start_date: text(c.start_date, 10), criteria: text(c.criteria, 4000), initial_result: text(c.initial_result, 4000), can_manage: c.can_manage, can_record: c.can_record, grants: c.grants as {user_id:string;allowed:boolean}[], observations: c.observations.map(rawO => {
      const o = obj(rawO);
      if (!validId(o.id) || !checkpoints.includes(o.checkpoint as 30) || typeof o.recorded_at !== 'string' || !Number.isFinite(Date.parse(o.recorded_at))) throw new Error('Nieprawidłowe dane obserwacji.');
      return { id: o.id, checkpoint: o.checkpoint as number, recorded_at: o.recorded_at, body: parseObservation(o.body) };
    }) };
  }) };
}
/** Denominator is measured observations only; an actual negative stays measured. */
export function followupRates(cases: FollowupCase[], checkpoint: number) {
  const observed = cases.filter(c => c.purpose === 'post_hire').flatMap(c => c.observations.filter(o => o.checkpoint === checkpoint));
  const rate = (field: 'probation' | 'retained', positive: string) => {
    const measured = observed.filter(o => o.body[field] !== 'not_measured');
    const positives = measured.filter(o => o.body[field] === positive).length;
    return { value: measured.length ? 100 * positives / measured.length : null, measured: measured.length, positive: positives, missing: cases.filter(c => c.purpose === 'post_hire').length - measured.length };
  };
  return { probation: rate('probation', 'passed'), retention: rate('retained', 'yes') };
}
export function followupError(error: { code?: string; message?: string } | null) {
  if (error?.code === '42501') return 'Brak uprawnienia do tego celu oceny albo dane są niedostępne.';
  if (error?.code === 'PT409' && error.message?.includes('Observation already recorded')) return 'Ten okres ma już zapisaną obserwację. Odśwież stronę.';
  if (error?.code === 'PT409') return 'Dane są właśnie zmieniane. Odśwież stronę i spróbuj ponownie.';
  if (error?.code === '23505') return 'Ten okres ma już zapisaną obserwację. Odśwież stronę.';
  if (error?.code === '22023') return 'Sprawdź treść, datę i okres obserwacji. Nie można zapisać obserwacji przed upływem wybranego okresu.';
  return 'Nie udało się zapisać obserwacji. Odśwież stronę i spróbuj ponownie.';
}

export type RecruitmentFollowupMetrics = { checkpoint: number; population: number; probation: {positive:number;measured:number;missing:number;rate:number|null}; retention: {positive:number;measured:number;missing:number;rate:number|null} };
/** Only the dedicated permission-filtered RPC can supply this scope. Invalid/unavailable is not zero. */
export function parseRecruitmentFollowupMetrics(value: unknown): RecruitmentFollowupMetrics | null {
  try {
    const root=obj(value);
    const whole=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
    if(root.scope!=='latest_authorized_post_hire_case_per_application'||!checkpoints.includes(root.checkpoint as 30)||!whole(root.population))return null;
    const population=root.population;
    const parseRate=(value:unknown)=>{
      const r=obj(value);
      if(!whole(r.positive)||!whole(r.measured)||!whole(r.missing)||r.positive>r.measured||r.measured>population||r.missing!==population-r.measured)throw Error('Invalid count');
      if(r.measured===0 ? r.rate!==null : typeof r.rate!=='number'||!Number.isFinite(r.rate)||Math.abs(r.rate-100*r.positive/r.measured)>0.011)throw Error('Invalid rate');
      return {positive:r.positive,measured:r.measured,missing:r.missing,rate:r.rate as number|null};
    };
    return {checkpoint:root.checkpoint as number,population,probation:parseRate(root.probation),retention:parseRate(root.retention)};
  }catch{return null;}
}
export function recruitmentFollowupRateText(rate: RecruitmentFollowupMetrics['probation'] | null) {
  if(!rate)return 'Brak pomiaru — dane niedostępne dla tego zakresu uprawnień.';
  if(rate.rate===null)return `Brak pomiaru — ${rate.missing} zgłoszeń bez obserwacji wyniku.`;
  return `${rate.rate.toLocaleString('pl-PL',{maximumFractionDigits:1})}% (${rate.positive}/${rate.measured} zmierzonych; ${rate.missing} bez pomiaru)`;
}
