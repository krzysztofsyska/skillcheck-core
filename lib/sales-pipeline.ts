export const salesStages = { new: 'Nowe', conversation: 'Rozmowa', offer: 'Oferta wysłana', won: 'Wygrane', lost: 'Przegrane' } as const;
export type SalesStage = keyof typeof salesStages;
export const dueFilters = { all: 'Wszystkie terminy', today: 'Na dziś', overdue: 'Zaległe' } as const;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSalesStage(value: string): value is SalesStage { return Object.hasOwn(salesStages, value); }
export function validContactDate(value: string) {
  if (!/^20\d{2}-\d{2}-\d{2}$|^2100-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export function parsePipelineForm(form: FormData) {
  const id = form.get('lead_id'), stage = form.get('stage'), note = form.get('note');
  const version = form.get('version'), date = form.get('next_contact'), company = form.get('company_id');
  if (typeof id !== 'string' || !uuidPattern.test(id) || typeof stage !== 'string' || !isSalesStage(stage)
    || typeof note !== 'string' || Array.from(note).length > 2000 || typeof version !== 'string' || !/^\d{1,9}$/.test(version)
    || typeof date !== 'string' || (date !== '' && !validContactDate(date))
    || typeof company !== 'string' || (company !== '' && !uuidPattern.test(company))) return null;
  if ((stage === 'won' || stage === 'lost') && form.get('confirm_close') !== 'yes') return null;
  return { target_lead: id, expected_version: Number(version), new_stage: stage, new_note: note.trim(),
    next_contact: stage === 'won' || stage === 'lost' ? null : date || null, linked_company: company || null };
}
