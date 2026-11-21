'use server';

import { companyAccess } from '../../../../../../../../lib/company-access';
import { loadVoiceOrderCheck, voiceOrderAllowed, voiceOrderMessages, voicePoolLabel } from '../../../../../../../../lib/voice/order-check';

export type VoiceOrderState = { status: 'idle' | 'ready' | 'refused'; message: string; pool: string | null };

// ROADMAP R6: the recruiter's "order a voice interview" button (Preview only,
// behind VOICE_PLAN_PREVIEW). It runs the database pool and cost-cap check and
// answers in Polish. It never reserves a unit, calls a provider or contacts the
// candidate: real ordering stays off until the owner opens it.
export async function checkVoiceInterviewOrder(companyId: string, recruitmentId: string, applicationId: string,
  _state: VoiceOrderState, _form: FormData): Promise<VoiceOrderState> {
  const route = { companyId, recruitmentId, applicationId };
  if (!voiceOrderAllowed({ route })) return { status: 'refused', message: voiceOrderMessages.forbidden, pool: null };
  const { client, canEdit } = await companyAccess(companyId);
  if (!voiceOrderAllowed({ route, canEdit })) return { status: 'refused', message: voiceOrderMessages.forbidden, pool: null };
  const check = await loadVoiceOrderCheck(client, route);
  return { status: check.state === 'ready' ? 'ready' : 'refused', message: voiceOrderMessages[check.state], pool: voicePoolLabel(check) };
}
