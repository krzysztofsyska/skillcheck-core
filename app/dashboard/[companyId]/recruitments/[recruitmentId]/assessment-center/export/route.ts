import { createClient } from '../../../../../../../lib/supabase/server';
import { assessmentCenterPreviewEnabled } from '../../../../../../../lib/assessment-center-preview';
import { exportAcSession } from '../../../../../../../lib/assessment-center-session-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// SC-AC-SESSION-EXPORT: uprawnienia sprawdzane od nowa przez klienta RLS użytkownika
// i to samo RPC sesji co strona; zasada ślepej oceny obowiązuje także w pliku.
export async function GET(_request: Request, context: { params: Promise<{ companyId: string; recruitmentId: string }> }) {
  const { companyId, recruitmentId } = await context.params;
  return exportAcSession(await createClient(), { companyId, recruitmentId }, { enabled: assessmentCenterPreviewEnabled() });
}
