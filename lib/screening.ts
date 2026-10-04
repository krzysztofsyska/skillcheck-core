import { createHash } from 'node:crypto';
import type { Application, CandidateDocument, Position, Recruitment } from './supabase/database.types';

// Data loaded through the signed-in user's RLS client, never a service-role client.
export type ScreeningDocument = Pick<CandidateDocument, 'id' | 'company_id' | 'candidate_id' | 'version' | 'status' | 'reviewed_by' | 'reviewed_at' | 'redacted_text'>;
export type ScreeningContext = {
  companyId: string;
  application: Application;
  recruitment: Recruitment;
  position: Position;
  document: ScreeningDocument | null;
};
export type ScreeningCriterion = { id: string; kind: 'task' | 'kpi' | 'competency'; text: string };

export function prepareScreening(context: ScreeningContext) {
  const { companyId, application, recruitment, position, document } = context;
  if ([application, recruitment, position].some(row => row.company_id !== companyId)
    || application.recruitment_id !== recruitment.id || recruitment.position_id !== position.id
    || (document && (document.company_id !== companyId || document.candidate_id !== application.candidate_id))) {
    throw new Error('Nie można połączyć danych tej rekrutacji i CV.');
  }
  if (!['new', 'in_progress'].includes(application.status)) throw new Error('Zgłoszenie jest zakończone lub wycofane.');
  if (!['draft', 'open'].includes(recruitment.status)) throw new Error('Rekrutacja jest wstrzymana lub zamknięta.');
  if (position.status === 'archived') throw new Error('Stanowisko jest zarchiwizowane.');
  if (!document) throw new Error('Dodaj CV i zatwierdź jego anonimizację.');
  if (document.status !== 'reviewed' || !document.reviewed_by || !document.reviewed_at) {
    throw new Error('Najnowsze CV wymaga sprawdzenia i zatwierdzenia anonimizacji.');
  }
  if (!Number.isSafeInteger(document.version) || document.version < 1 || !document.redacted_text.trim()
    || document.redacted_text.length > 100000) throw new Error('Sprawdź tekst i wersję CV.');
  const groups = [
    ['task', position.tasks], ['kpi', position.kpis], ['competency', position.required_competencies],
  ] as const;
  if (!position.tasks.length || !position.kpis.length || groups.some(([, items]) => items.length > 30 || items.some(item => !item.trim() || item.length > 500))) {
    throw new Error('Uzupełnij zadania i mierniki sukcesu w profilu stanowiska. Listy mogą zawierać do 30 pozycji po 500 znaków.');
  }
  const criteria: ScreeningCriterion[] = groups.flatMap(([kind, items]) => items.map((text, index) => ({ id: `${kind}:${index + 1}`, kind, text })));
  // Explicit allowlist: no original CV, names, contact details, tenant IDs or reviewer IDs.
  // Descriptions and behavior requirements are excluded; behavior needs separate evidence.
  const payload = { schema_version: 1 as const, cv_text: document.redacted_text, criteria };
  const binding = {
    company_id: companyId, application_id: application.id, application_updated_at: application.updated_at,
    recruitment_id: recruitment.id, recruitment_updated_at: recruitment.updated_at,
    position_id: position.id, position_updated_at: position.updated_at,
    document_id: document.id, document_version: document.version,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify({ binding, payload })).digest('hex');
  return { payload, binding, fingerprint };
}

export type PreparedScreening = ReturnType<typeof prepareScreening>;

// Future provider integration must reload the context before dispatch AND before saving a result.
export function assertScreeningCurrent(prepared: PreparedScreening, current: ScreeningContext) {
  if (prepareScreening(current).fingerprint !== prepared.fingerprint) {
    throw new Error('CV lub wymagania zmieniły się. Przygotuj analizę ponownie.');
  }
}

export const screeningLevels = ['insufficient_data', 'below', 'meets', 'above'] as const;
type Level = typeof screeningLevels[number];
export type ScreeningFinding = {
  criterion_id: string; level: Level;
  evidence: { start: number; end: number; quote: string }[];
};

// Only technical consistency is verified here. Exact quotes are not proof that a model's
// interpretation is correct; a recruiter must review every finding. No hiring decision field.
export function validateScreeningFindings(input: unknown, prepared: PreparedScreening): ScreeningFinding[] {
  if (!Array.isArray(input) || input.length !== prepared.payload.criteria.length) throw new Error('Niepełny wynik analizy.');
  const allowed = new Set(prepared.payload.criteria.map(item => item.id));
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Nieprawidłowy wynik analizy.');
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !['criterion_id', 'level', 'evidence'].includes(key))
      || typeof row.criterion_id !== 'string' || !allowed.has(row.criterion_id) || seen.has(row.criterion_id)
      || !screeningLevels.includes(row.level as Level) || !Array.isArray(row.evidence) || row.evidence.length > 5) throw new Error('Nieprawidłowy wynik analizy.');
    seen.add(row.criterion_id);
    if (row.level !== 'insufficient_data' && row.evidence.length === 0) throw new Error('Ocena wymaga cytatu z CV. Brak informacji nie oznacza niespełnienia wymagania.');
    const evidence = row.evidence.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Nieprawidłowy cytat.');
      const e = value as Record<string, unknown>;
      if (Object.keys(e).some(key => !['start', 'end', 'quote'].includes(key))
        || typeof e.start !== 'number' || !Number.isSafeInteger(e.start) || typeof e.end !== 'number' || !Number.isSafeInteger(e.end)
        || e.start < 0 || e.end <= e.start || e.end > prepared.payload.cv_text.length
        || typeof e.quote !== 'string' || !e.quote.trim() || e.quote.length > 2000
        || prepared.payload.cv_text.slice(e.start, e.end) !== e.quote) throw new Error('Cytat nie odpowiada sprawdzonej wersji CV.');
      return { start: e.start, end: e.end, quote: e.quote };
    });
    return { criterion_id: row.criterion_id, level: row.level as Level, evidence };
  });
}
