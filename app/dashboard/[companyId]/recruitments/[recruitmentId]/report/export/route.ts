import { createClient } from '../../../../../../../lib/supabase/server';
import { exportScreeningReport } from '../../../../../../../lib/screening-report-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ companyId: string; recruitmentId: string }> }) {
  const { companyId, recruitmentId } = await context.params;
  const sizes = new URL(request.url).searchParams.getAll('size');
  return exportScreeningReport(await createClient(), companyId, recruitmentId, sizes.length > 1 ? sizes : sizes[0]);
}
