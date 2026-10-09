import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { loadScreeningReport } from './screening-report-source.ts';
import { ScreeningReportError, screeningReportCsv } from './screening-report.ts';

export const reportHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
export async function exportScreeningReport(client: SupabaseClient<Database>, companyId: string, recruitmentId: string, size?: unknown) {
  try {
    const report = await loadScreeningReport(client, companyId, recruitmentId, size);
    return new Response(screeningReportCsv(report), { headers: {
      ...reportHeaders, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="skillcheck-preselekcja-${report.recruitmentId}.csv"`,
    } });
  } catch (error) {
    const safe = error instanceof ScreeningReportError ? error : new ScreeningReportError('failed');
    return Response.json({ error: safe.code, message: safe.message }, { status: safe.status, headers: reportHeaders });
  }
}
