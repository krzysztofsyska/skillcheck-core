// SC-015-D3 — historia eksportów raportów kandydatów na poziomie firmy.
// Jedyna droga odczytu: public.list_company_report_exports (baza sama sprawdza,
// że czyta właściciel firmy; domyślnie 100, najwyżej 200 wpisów, najnowsze
// pierwsze; stronicowanie parą before_at + before_id).
// Bez danych kandydata: kiedy, kto (rola, „Ty"), której rekrutacji i którego
// zgłoszenia dotyczył eksport — tylko identyfikatory do odnośników.
// Błąd odczytu nigdy nie psuje strony — pokazujemy neutralny komunikat.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { exportActorRoleLabels, type ExportActorRole } from './candidate-report-export.ts';
import { isUuid } from './screening-ui.ts';

export const COMPANY_EXPORT_HISTORY_PAGE = 100;
export const COMPANY_EXPORT_HISTORY_MAX = 200;

export type CompanyExportCursor = { before: string; id: string };
export type CompanyExportEntry = {
  exportId: string; exportedAt: string; actorId: string; actorRole: ExportActorRole; isMe: boolean;
  recruitmentId: string; applicationId: string;
};
export type CompanyExportHistory =
  | { ok: true; entries: CompanyExportEntry[]; next: CompanyExportCursor | null }
  | { ok: false };

export const companyExportHistoryEmptyMessage = 'W tej firmie nie pobrano jeszcze żadnego raportu kandydata.';
export const companyExportHistoryErrorMessage = 'Nie udało się teraz wczytać historii eksportów. Spróbuj ponownie za chwilę.';
export const companyExportHistoryOwnerOnlyMessage = 'Historię eksportów całej firmy widzi właściciel konta firmy.';

// Czas z bazy wraca jako tekst ISO z mikrosekundami; kursor przekazujemy dalej
// bez przeliczania przez Date, żeby nie zgubić precyzji.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value.replace(' ', 'T')));

/** Kursor z parametrów adresu; cokolwiek innego niż poprawna para = pierwsza strona. */
export function parseCompanyExportCursor(before: unknown, id: unknown): CompanyExportCursor | null {
  return isTimestamp(before) && isUuid(id) ? { before, id: id.toLowerCase() } : null;
}

function parseRow(row: unknown): CompanyExportEntry | null {
  if (!row || typeof row !== 'object') return null;
  const {
    export_id: exportId, exported_at: exportedAt, actor_id: actorId, actor_role: actorRole, is_me: isMe,
    recruitment_id: recruitmentId, application_id: applicationId,
  } = row as Record<string, unknown>;
  if (!isUuid(exportId) || !isTimestamp(exportedAt) || !isUuid(actorId) || typeof actorRole !== 'string'
      || !Object.hasOwn(exportActorRoleLabels, actorRole) || typeof isMe !== 'boolean'
      || !isUuid(recruitmentId) || !isUuid(applicationId)) return null;
  return { exportId, exportedAt, actorId, actorRole: actorRole as ExportActorRole, isMe, recruitmentId, applicationId };
}

/** Odczyt jednej strony. Każdy błąd, wyjątek lub nieoczekiwany kształt = { ok: false }. */
export async function loadCompanyReportExportHistory(
  client: SupabaseClient<Database>, companyId: string, cursor: CompanyExportCursor | null = null,
): Promise<CompanyExportHistory> {
  try {
    if (!isUuid(companyId)) return { ok: false };
    const { data, error } = await client.rpc('list_company_report_exports', {
      target_company: companyId.toLowerCase(), row_limit: COMPANY_EXPORT_HISTORY_PAGE,
      ...(cursor ? { before_at: cursor.before, before_id: cursor.id } : {}),
    });
    if (error || !Array.isArray(data) || data.length > COMPANY_EXPORT_HISTORY_PAGE) return { ok: false };
    const entries = data.map(parseRow);
    if (entries.some(entry => entry === null)) return { ok: false };
    const parsed = entries as CompanyExportEntry[];
    const last = parsed.at(-1);
    return {
      ok: true, entries: parsed,
      next: parsed.length === COMPANY_EXPORT_HISTORY_PAGE && last ? { before: last.exportedAt, id: last.exportId } : null,
    };
  } catch { return { ok: false }; }
}

export type CompanyExportHistoryItem = {
  key: string; when: string; who: string; recruitmentName: string; recruitmentHref: string; reportHref: string;
};
export type CompanyExportHistoryView =
  | { kind: 'error' | 'empty'; message: string }
  | { kind: 'list'; items: CompanyExportHistoryItem[]; nextHref: string | null };

/** Teksty strony „Historia eksportów raportów" (czas w strefie Europe/Warsaw). */
export function companyExportHistoryView(
  companyId: string, history: CompanyExportHistory, recruitmentNames: ReadonlyMap<string, string> = new Map(),
): CompanyExportHistoryView {
  if (!history.ok) return { kind: 'error', message: companyExportHistoryErrorMessage };
  if (!history.entries.length) return { kind: 'empty', message: companyExportHistoryEmptyMessage };
  const base = `/dashboard/${companyId}`;
  return {
    kind: 'list',
    nextHref: history.next
      ? `${base}/eksporty?before=${encodeURIComponent(history.next.before)}&id=${history.next.id}` : null,
    items: history.entries.map(entry => ({
      key: entry.exportId,
      when: new Date(entry.exportedAt.replace(' ', 'T')).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }),
      who: entry.isMe ? `Ty (${exportActorRoleLabels[entry.actorRole].toLowerCase()})` : exportActorRoleLabels[entry.actorRole],
      recruitmentName: recruitmentNames.get(entry.recruitmentId) ?? 'Rekrutacja',
      recruitmentHref: `${base}/recruitments/${entry.recruitmentId}`,
      reportHref: `${base}/recruitments/${entry.recruitmentId}/applications/${entry.applicationId}/report`,
    })),
  };
}
