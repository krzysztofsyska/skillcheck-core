// SC-015-D — eksport CSV raportu jednego kandydata z wpisem audytowym.
// Kontrakt: docs/plan-budowy-2026-11-02.md, „SC-015-D — Eksport i audyt dostępu".
//
// Zasady:
//  * uprawnienia sprawdzane od nowa przy każdym eksporcie: odczyt idzie przez
//    klienta RLS zalogowanego użytkownika (nigdy service_role), a tuż przed
//    wydaniem pliku baza jeszcze raz sprawdza członkostwo, przynależność
//    zgłoszenia i wycofanie zgody (public.record_candidate_report_export);
//  * bez udanego wpisu audytowego nie ma pliku (fail closed);
//  * plik zawiera te same oceny i dowody co ekran, bo powstaje z tego samego
//    loadCandidateReport; bez nazwiska kandydata, także w nazwie pliku;
//  * każda komórka przechodzi przez csvCell (ochrona przed formułami =, +, -, @
//    także po tabulatorze, CR i znakach niewidocznych);
//  * komunikaty błędów nie zawierają danych kandydata ani nie zdradzają, czy
//    rekord innej firmy istnieje; nic nie trafia do logów.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { CandidateReportError, loadCandidateReport, noMissingDataDisclaimer, requirementStatusLabels, type CandidateReport } from './candidate-report.ts';
import { criterionKindLabels, requirementMarkLabels, requirementMarkOrder } from './requirement-flags.ts';
import { ScreeningNotFoundError } from './screening-flow.ts';
import { csvCell } from './screening-report.ts';
import { isUuid, type ScreeningRoute } from './screening-ui.ts';

export const CANDIDATE_REPORT_EXPORT_VERSION = 'candidate-report-csv-v1';
export const candidateReportExportHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const MAX_CSV_BYTES = 10 * 1024 * 1024;

export type CandidateExportErrorCode =
  'invalid' | 'unauthenticated' | 'not_found' | 'withdrawn' | 'changed' | 'too_large' | 'audit_failed' | 'failed';
const errors: Record<CandidateExportErrorCode, [number, string]> = {
  invalid: [400, 'Nieprawidłowy adres raportu.'],
  unauthenticated: [401, 'Zaloguj się, aby pobrać raport.'],
  not_found: [404, 'Nie znaleziono zgłoszenia lub nie masz do niego dostępu.'],
  withdrawn: [403, 'Eksport jest niedostępny: kandydat wycofał zgłoszenie lub zgodę albo jego dane są usuwane.'],
  changed: [409, 'Dane raportu zmieniły się lub są niespójne. Odśwież raport i spróbuj ponownie.'],
  too_large: [413, 'Raport przekracza dopuszczalny rozmiar pliku.'],
  audit_failed: [503, 'Nie udało się zapisać wpisu o pobraniu raportu, więc plik nie został wydany. Spróbuj ponownie.'],
  failed: [500, 'Nie udało się przygotować raportu. Spróbuj ponownie.'],
};
export class CandidateExportError extends Error {
  code: CandidateExportErrorCode;
  status: number;
  constructor(code: CandidateExportErrorCode) { super(errors[code][1]); this.code = code; this.status = errors[code][0]; }
}

export const candidateReportFilename = (applicationId: string) =>
  `skillcheck-raport-kandydata-${applicationId.toLowerCase()}.csv`;

/** Te same informacje o stanie analizy, które ekran pokazuje nad wymaganiami. */
function analysisNotes(report: CandidateReport): string[] {
  const notes: string[] = [];
  if (!report.analysisStatus) notes.push('Dla tego zgłoszenia nie ma jeszcze analizy CV.');
  if (report.analysisStatus === 'pending' || report.analysisStatus === 'processing') {
    notes.push('Analiza CV jeszcze trwa. Wymagania czekają na wynik — to nie to samo co brak informacji w CV.');
  }
  if (report.analysisStatus === 'failed' || report.analysisStatus === 'cancelled') notes.push('Ostatnia analiza nie zakończyła się wynikiem.');
  if (report.legacyAnalysis) notes.push('Zakończona analiza nie zawiera pełnej macierzy dowodów (starszy format lub brak wyników).');
  if (report.reanalysisRequested) notes.push('Rekruter odesłał tę analizę do powtórzenia, więc jej wyniki nie są pokazywane jako aktualne.');
  if (report.stale) notes.push('CV albo wymagania zmieniły się po tej analizie, więc wynik może być nieaktualny.');
  return notes;
}

export function candidateReportCsv(report: CandidateReport): string {
  const { summary } = report;
  const rows: (string | number | null)[][] = [
    ['Wersja eksportu', CANDIDATE_REPORT_EXPORT_VERSION], ['Wygenerowano (UTC)', report.generatedAt],
    ['Rekrutacja', report.recruitmentName], ['Stanowisko', report.positionTitle], ['Zgłoszenie', report.applicationId],
    ['Wersja analizy', report.analysisVersion], ['Wersja CV', report.documentVersion],
    ['Informacja', `Raport zestawia wymagania stanowiska z informacjami z CV i wspiera ocenę człowieka. Nie jest decyzją o zatrudnieniu i nie zawiera wyniku ogólnego. ${noMissingDataDisclaimer}`],
    ...analysisNotes(report).map(note => ['Stan analizy', note]),
    ['Wymagania konieczne', summary.requiredTotal], ['Konieczne potwierdzone w CV', summary.requiredSupported],
    ['Konieczne do wyjaśnienia na rozmowie', summary.requiredGaps], ['Konieczne czekające na wynik lub sprawdzenie', summary.requiredPending],
    ['Wymagania nieoznaczone', summary.unmarkedTotal], ['Wymagania dodatkowe', summary.additionalTotal],
    [],
    ['Grupa', 'Rodzaj', 'Wymaganie', 'Status', 'Korekta rekrutera', 'Cytaty z CV', 'Czego brakuje', 'Pytanie na rozmowę'],
  ];
  for (const mark of requirementMarkOrder) {
    const group = report.requirements.filter(requirement => requirement.mark === mark);
    // Zasada pustych sekcji: grupa bez wymagań zostaje w pliku, tak jak na ekranie.
    if (!group.length) rows.push([requirementMarkLabels[mark], '', 'Brak wymagań w tej grupie.', '', '', '', '', '']);
    for (const requirement of group) {
      rows.push([
        requirementMarkLabels[mark], criterionKindLabels[requirement.kind], requirement.text,
        requirementStatusLabels[requirement.status], requirement.corrected ? 'Tak' : 'Nie',
        requirement.quotes.map(quote => `[${quote.start}–${quote.end}] ${quote.quote}`).join('\n'),
        requirement.missingInfo, requirement.question,
      ]);
    }
  }
  const csv = '﻿' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) throw new CandidateExportError('too_large');
  return csv;
}

type ExportDeps = { load?: typeof loadCandidateReport };

/** Zapis audytowy. Każdy błąd lub niepoprawna odpowiedź = brak pliku. */
async function recordExport(client: SupabaseClient<Database>, route: ScreeningRoute, report: CandidateReport) {
  let result: { data: unknown; error: { code?: string } | null };
  try {
    result = await client.rpc('record_candidate_report_export', {
      target_company: route.companyId, target_recruitment: route.recruitmentId, target_application: route.applicationId,
      export_kind: 'candidate_report_csv', analysis_version: report.analysisVersion,
    });
  } catch { throw new CandidateExportError('audit_failed'); }
  if (result.error) {
    if (result.error.code === '42501') throw new CandidateExportError('not_found');
    if (result.error.code === '55000') throw new CandidateExportError('withdrawn');
    throw new CandidateExportError('audit_failed');
  }
  if (!isUuid(result.data)) throw new CandidateExportError('audit_failed');
}

export async function exportCandidateReport(
  client: SupabaseClient<Database>, route: ScreeningRoute, { load = loadCandidateReport }: ExportDeps = {},
): Promise<Response> {
  try {
    if (!route || !Object.values(route).every(isUuid) || Object.keys(route).length !== 3) throw new CandidateExportError('invalid');
    const normalized: ScreeningRoute = {
      companyId: route.companyId.toLowerCase(), recruitmentId: route.recruitmentId.toLowerCase(),
      applicationId: route.applicationId.toLowerCase(),
    };
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth?.user) throw new CandidateExportError('unauthenticated');
    let report: CandidateReport;
    try { report = await load(client, normalized); }
    catch (error) {
      if (error instanceof ScreeningNotFoundError) throw new CandidateExportError('not_found');
      if (error instanceof CandidateReportError) throw new CandidateExportError('changed');
      throw new CandidateExportError('failed');
    }
    // Raport musi dotyczyć dokładnie tego zgłoszenia, o które poproszono.
    if (!report || report.applicationId.toLowerCase() !== normalized.applicationId) throw new CandidateExportError('changed');
    const csv = candidateReportCsv(report);
    await recordExport(client, normalized, report);
    return new Response(csv, { headers: {
      ...candidateReportExportHeaders, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${candidateReportFilename(normalized.applicationId)}"`,
    } });
  } catch (error) {
    const safe = error instanceof CandidateExportError ? error : new CandidateExportError('failed');
    return Response.json({ error: safe.code, message: safe.message }, { status: safe.status, headers: candidateReportExportHeaders });
  }
}
