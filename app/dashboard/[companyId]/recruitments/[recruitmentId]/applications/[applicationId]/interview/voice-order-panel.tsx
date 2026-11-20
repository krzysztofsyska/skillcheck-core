'use client';

import { useActionState } from 'react';
import { checkVoiceInterviewOrder, type VoiceOrderState } from './voice-order-actions';

// Preview-only panel (rendered by the page only when voiceOrderAllowed). The
// button runs the pool and cost-cap check; nothing is reserved or sent.
export function VoiceOrderPanel({ companyId, recruitmentId, applicationId, pool, notice }: {
  companyId: string; recruitmentId: string; applicationId: string; pool: string | null; notice: string | null;
}) {
  const initial: VoiceOrderState = { status: 'idle', message: '', pool };
  const [state, action, pending] = useActionState(
    checkVoiceInterviewOrder.bind(null, companyId, recruitmentId, applicationId), initial);
  return <section aria-labelledby="voice-order-heading">
    <h2 id="voice-order-heading">Rozmowa głosowa — podgląd</h2>
    {state.pool && <p role="status">{state.pool}</p>}
    {notice && state.status === 'idle' && <p className="notice">{notice}</p>}
    <form action={action} aria-busy={pending}>
      <button type="submit" disabled={pending}>Zleć rozmowę głosową</button>
    </form>
    {state.message && <p role={state.status === 'ready' ? 'status' : 'alert'}>{state.message}</p>}
  </section>;
}
