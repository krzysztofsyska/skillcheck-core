// Eksport CSV raportu preselekcji (całej rekrutacji) z wpisem w rejestrze pobrań.
// R0 SC-009a (migracja 20261127140000_sc009a_screening_report_export_audit.sql):
//  * plik powstaje z tego samego loadScreeningReport co ekran (odczyt przez klienta RLS
//    zalogowanego użytkownika, nigdy service_role);
//  * tuż przed wydaniem pliku baza jeszcze raz sprawdza członkostwo i przynależność
//    rekrutacji do firmy i zapisuje wpis (public.record_screening_report_export);
//  * bez udanego wpisu nie ma pliku (fail closed); wpis zawiera tylko identyfikatory
//    firmy, rekrutacji i osoby pobierającej, rolę, rodzaj i rozmiar shortlisty.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { loadScreeningReport } from './screening-report-source.ts';
import { ScreeningReportError, isUuid, screeningReportCsv, type ScreeningReport } from './screening-report.ts';

export const reportHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

/** Zapis w rejestrze pobrań. Każdy błąd lub niepoprawna odpowiedź = brak pliku. */
async function recordExport(client: SupabaseClient<Database>, report: ScreeningReport) {
  let result: { data: unknown; error: { code?: string } | null };
  try {
    result = await client.rpc('record_screening_report_export', {
      target_company: report.companyId, target_recruitment: report.recruitmentId,
      export_kind: 'screening_report_csv', target_size: report.targetSize,
    });
  } catch { throw new ScreeningReportError('audit_failed'); }
  if (result.error) {
    // Dostęp cofnięty między odczytem a zapisem: ta sama odpowiedź co przy obcej rekrutacji.
    if (result.error.code === '42501') throw new ScreeningReportError('not_found');
    throw new ScreeningReportError('audit_failed');
  }
  if (!isUuid(result.data)) throw new ScreeningReportError('audit_failed');
}

export async function exportScreeningReport(client: SupabaseClient<Database>, companyId: string, recruitmentId: string, size?: unknown) {
  try {
    const report = await loadScreeningReport(client, companyId, recruitmentId, size);
    const csv = screeningReportCsv(report);
    await recordExport(client, report);
    return new Response(csv, { headers: {
      ...reportHeaders, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="skillcheck-preselekcja-${report.recruitmentId}.csv"`,
    } });
  } catch (error) {
    const safe = error instanceof ScreeningReportError ? error : new ScreeningReportError('failed');
    return Response.json({ error: safe.code, message: safe.message }, { status: safe.status, headers: reportHeaders });
  }
}
