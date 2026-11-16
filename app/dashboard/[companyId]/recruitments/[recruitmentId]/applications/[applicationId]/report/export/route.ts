import { createClient } from '../../../../../../../../../lib/supabase/server';
import { exportCandidateReport } from '../../../../../../../../../lib/candidate-report-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// SC-015-D: uprawnienia sprawdzane od nowa (klient RLS użytkownika + funkcja audytu w bazie).
export async function GET(_request: Request, context: { params: Promise<{ companyId: string; recruitmentId: string; applicationId: string }> }) {
  const { companyId, recruitmentId, applicationId } = await context.params;
  return exportCandidateReport(await createClient(), { companyId, recruitmentId, applicationId });
}
