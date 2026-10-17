import type { ScreeningRating } from './supabase/database.types';

export const REPORT_VERSION = 'screening-report-v1';
export const MAX_REPORT_APPLICATIONS = 500;
export const reasonLabels = {
  eligible: 'W rankingu', insufficient_evidence: 'Za mało ocenionych kryteriów',
  no_human_review: 'Oczekuje na sprawdzenie przez człowieka', needs_reanalysis: 'Wymaga ponownej analizy',
  stale: 'Wynik nieaktualny', pending: 'Analiza oczekuje', processing: 'Analiza trwa',
  failed: 'Analiza nie powiodła się', cancelled: 'Analiza anulowana',
  no_completed_result: 'Brak ukończonego wyniku', result_incomplete: 'Wynik niekompletny',
  review_inconsistent: 'Historia oceny wymaga sprawdzenia',
} as const;
export const ratingLabels: Record<ScreeningRating, string> = {
  below: 'Poniżej wymagań', meets: 'Spełnia wymagania', above: 'Powyżej wymagań',
  insufficient_data: 'Brak wystarczających danych',
};
export const kindLabels = { task: 'Zadanie', kpi: 'KPI', competency: 'Kompetencja' };
export type ReportErrorCode = 'invalid' | 'unauthenticated' | 'not_found' | 'changed' | 'too_large' | 'unavailable' | 'failed';
const errors: Record<ReportErrorCode, [number, string]> = {
  invalid: [400, 'Nieprawidłowe parametry raportu.'], unauthenticated: [401, 'Zaloguj się, aby otworzyć raport.'],
  not_found: [404, 'Nie znaleziono rekrutacji lub nie masz do niej dostępu.'],
  changed: [409, 'Dane raportu zmieniły się lub są niespójne. Odśwież raport i spróbuj ponownie.'],
  too_large: [413, 'Raport przekracza limit 500 zgłoszeń lub dopuszczalny rozmiar danych.'],
  unavailable: [503, 'Raport będzie dostępny po uruchomieniu rankingu i shortlisty dla tej rekrutacji.'],
  failed: [500, 'Nie udało się przygotować raportu. Spróbuj ponownie.'],
};
export class ScreeningReportError extends Error {
  code: ReportErrorCode;
  status: number;
  constructor(code: ReportErrorCode) { super(errors[code][1]); this.code = code; this.status = errors[code][0]; }
}
export function requireReport(condition: unknown): asserts condition {
  if (!condition) throw new ScreeningReportError('changed');
}
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function reportParameters(companyId: string, recruitmentId: string, size: unknown = undefined) {
  const targetSize = size === undefined ? 10 : typeof size === 'string' && /^(?:[5-9]|10)$/.test(size) ? Number(size) : NaN;
  if (!isUuid(companyId) || !isUuid(recruitmentId) || !Number.isInteger(targetSize)) throw new ScreeningReportError('invalid');
  return { companyId: companyId.toLowerCase(), recruitmentId: recruitmentId.toLowerCase(), targetSize };
}

export type RankingRow = {
  application_id: string; analysis_id: string | null; review_id: string | null;
  rank: number | null; rankable: boolean; eligibility_reason: keyof typeof reasonLabels;
  raw_score: number | null; coverage: number | null; total_criteria: number; known_criteria: number;
  below_count: number; meets_count: number; above_count: number; insufficient_data_count: number;
  suggested_shortlist: boolean; ranking_policy_version: string; shortlist_entry_id: string | null;
  shortlist_snapshot_current: boolean | null;
};
export type ShortlistRow = {
  entry_id: string; application_id: string; analysis_id: string; review_id: string;
  source: 'manual' | 'suggested'; selected_at: string; ranking_policy_version: string;
  raw_score_snapshot: number | null; coverage_snapshot: number | null;
  snapshot_current: boolean; policy_current: boolean;
};
function object(value: unknown): Record<string, unknown> {
  requireReport(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function id(value: unknown, nullable: true): string | null;
function id(value: unknown, nullable?: false): string;
function id(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  requireReport(isUuid(value)); return value;
}
function text(value: unknown, max = 1000): string { requireReport(typeof value === 'string' && value.length <= max); return value; }
function bool(value: unknown): boolean { requireReport(typeof value === 'boolean'); return value; }
function numeric(value: unknown, max: number, nullable = false): number | null {
  if (value === null && nullable) return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  requireReport(Number.isFinite(number) && number >= 0 && number <= max); return number;
}
function count(value: unknown): number { const n = numeric(value, 10000); requireReport(n !== null && Number.isInteger(n)); return n; }
export function parseRanking(value: unknown): RankingRow {
  const row = object(value);
  requireReport(typeof row.eligibility_reason === 'string' && Object.hasOwn(reasonLabels, row.eligibility_reason));
  const reason = row.eligibility_reason as RankingRow['eligibility_reason'];
  const result: RankingRow = {
    application_id: id(row.application_id), analysis_id: id(row.analysis_id, true), review_id: id(row.review_id, true),
    rank: row.rank === null ? null : count(row.rank), rankable: bool(row.rankable), eligibility_reason: reason,
    raw_score: numeric(row.raw_score, 100, true), coverage: numeric(row.coverage, 1, true),
    total_criteria: count(row.total_criteria), known_criteria: count(row.known_criteria),
    below_count: count(row.below_count), meets_count: count(row.meets_count), above_count: count(row.above_count),
    insufficient_data_count: count(row.insufficient_data_count), suggested_shortlist: bool(row.suggested_shortlist),
    ranking_policy_version: text(row.ranking_policy_version, 100), shortlist_entry_id: id(row.shortlist_entry_id, true),
    shortlist_snapshot_current: row.shortlist_snapshot_current === null ? null : bool(row.shortlist_snapshot_current),
  };
  requireReport(result.ranking_policy_version.length > 0);
  requireReport(result.rankable === (reason === 'eligible'));
  requireReport(result.rankable ? result.rank !== null && result.rank > 0 && result.raw_score !== null : result.rank === null && !result.suggested_shortlist);
  if (reason === 'eligible' || reason === 'insufficient_evidence') {
    requireReport(result.analysis_id && result.review_id);
    requireReport(result.known_criteria === result.below_count + result.meets_count + result.above_count);
    requireReport(result.total_criteria === result.known_criteria + result.insufficient_data_count);
  }
  return result;
}
export function parseShortlist(value: unknown): ShortlistRow {
  const row = object(value);
  requireReport(row.removed_at === null && (row.source === 'manual' || row.source === 'suggested'));
  const selected = text(row.selected_at, 100); requireReport(Number.isFinite(Date.parse(selected)));
  return {
    entry_id: id(row.entry_id), application_id: id(row.application_id), analysis_id: id(row.analysis_id), review_id: id(row.review_id),
    source: row.source, selected_at: selected, ranking_policy_version: text(row.ranking_policy_version, 100),
    raw_score_snapshot: numeric(row.raw_score_snapshot, 100, true), coverage_snapshot: numeric(row.coverage_snapshot, 1, true),
    snapshot_current: bool(row.snapshot_current), policy_current: bool(row.policy_current),
  };
}
export type ReportCriterion = {
  id: string; kind: keyof typeof kindLabels; text: string;
  aiRating: ScreeningRating; rating: ScreeningRating; reviewedChange: boolean;
  explanation: string | null; evidence: { start: number; end: number; quote: string }[];
};
export type ReportApplication = { ranking: RankingRow; shortlist: ShortlistRow | null; criteria: ReportCriterion[] };
export type ScreeningReport = {
  version: typeof REPORT_VERSION; generatedAt: string; companyId: string; companyName: string;
  recruitmentId: string; recruitmentName: string; positionTitle: string; targetSize: number;
  requirements: { kind: keyof typeof kindLabels; text: string }[]; applications: ReportApplication[];
};
export function reportEvidence(value: unknown): ReportCriterion['evidence'] {
  requireReport(Array.isArray(value) && value.length <= 100);
  return value.map(item => {
    const e = object(item); const start = numeric(e.start, 1000000); const end = numeric(e.end, 1000000);
    requireReport(start !== null && end !== null && Number.isInteger(start) && Number.isInteger(end) && end >= start);
    return { start, end, quote: text(e.quote, 100000) };
  });
}
export function reportRating(value: unknown): ScreeningRating {
  requireReport(typeof value === 'string' && Object.hasOwn(ratingLabels, value)); return value as ScreeningRating;
}
export function reportText(value: unknown): string | null { return value === null ? null : text(value, 100000); }
export function shortlistLabel(entry: ShortlistRow | null) {
  return !entry ? 'Nie wybrano' : !entry.snapshot_current || !entry.policy_current ? 'Wybrano — wymaga ponownego sprawdzenia' : 'Wybrano przez człowieka';
}

// Quote every cell and neutralize spreadsheet formulas even after control/space prefixes.
export function csvCell(value: string | number | null): string {
  let input = value === null ? '' : String(value);
  if (typeof value === 'string' && /^[\s\u0000-\u001f\u007f-\u009f\ufeff]*[=+@-]/.test(input)) input = "'" + input;
  input = input.replace(/\u0000/g, '');
  return '"' + input.replace(/"/g, '""') + '"';
}
export function screeningReportCsv(report: ScreeningReport): string {
  const rows: (string | number | null)[][] = [
    ['Wersja raportu', report.version], ['Wygenerowano (UTC)', report.generatedAt], ['Firma', report.companyName],
    ['Rekrutacja', report.recruitmentName], ['Stanowisko', report.positionTitle], ['Wielkość sugestii', report.targetSize],
    ['Informacja', 'Raport wspiera ocenę człowieka. Nie jest decyzją o zatrudnieniu. Brak danych nie oznacza niespełnienia wymagań.'],
    ['Wymagania aktualnego stanowiska'], ['Rodzaj', 'Treść'], ...report.requirements.map(r => [kindLabels[r.kind], r.text]), [],
    ['Zgłoszenie', 'Pozycja', 'Status', 'Wynik', 'Pokrycie', 'Ocenione kryteria', 'Wszystkie kryteria', 'Sugestia systemu', 'Shortlista człowieka',
      'Źródło wyboru', 'Wybrano (UTC)', 'Polityka', 'Analiza', 'Review', 'Kryterium', 'Rodzaj', 'Ocena AI', 'Ocena po review', 'Korekta człowieka', 'Uzasadnienie', 'Dowody'],
  ];
  for (const application of report.applications) {
    const { ranking: r, shortlist: s } = application;
    for (const criterion of application.criteria.length ? application.criteria : [null]) {
      rows.push([r.application_id, r.rank, reasonLabels[r.eligibility_reason], r.raw_score, r.coverage,
        r.known_criteria, r.total_criteria, r.suggested_shortlist ? 'Tak' : 'Nie', shortlistLabel(s),
        s?.source === 'manual' ? 'Ręczny' : s ? 'Z sugestii' : '', s?.selected_at ?? '', r.ranking_policy_version,
        r.analysis_id, r.review_id, criterion?.text ?? '', criterion ? kindLabels[criterion.kind] : '',
        criterion ? ratingLabels[criterion.aiRating] : '', criterion ? ratingLabels[criterion.rating] : '',
        criterion?.reviewedChange ? 'Tak' : 'Nie', criterion?.explanation ?? '',
        criterion?.evidence.map(e => `[${e.start}–${e.end}] ${e.quote}`).join('\n') ?? '']);
    }
  }
  const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  if (Buffer.byteLength(csv, 'utf8') > 10 * 1024 * 1024) throw new ScreeningReportError('too_large');
  return csv;
}
