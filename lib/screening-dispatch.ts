import {
  SCREENING_DISPATCH_SIGNATURE_HEADER,
  SCREENING_DISPATCH_TIMESTAMP_HEADER,
  screeningDispatchBody,
  signScreeningDispatch,
} from './screening-hmac.ts';
import { isScreeningAiEnabled } from './screening-ai.ts';

export type ScreeningDispatchResult = {
  accepted: boolean;
  attempt_id?: string;
  reason?: 'disabled' | 'misconfigured' | 'rejected';
};

function readEnv(name: string) {
  return process.env[name]?.trim() || '';
}

// Server-only internal utility. Do not re-export from a "use server" file
// until SC-006 binds it to an authenticated start_screening_analysis flow.
export async function dispatchScreeningWorker(
  attemptId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ScreeningDispatchResult> {
  if (!isScreeningAiEnabled(env.SCREENING_AI_ENABLED)) {
    return { accepted: false, reason: 'disabled' };
  }
  const secret = env.SCREENING_WORKER_DISPATCH_SECRET || '';
  const url = env.SCREENING_WORKER_URL || (
    env.NEXT_PUBLIC_SUPABASE_URL
      ? `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/screening-worker`
      : ''
  );
  if (!secret || !url) return { accepted: false, reason: 'misconfigured' };

  const body = screeningDispatchBody(attemptId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signScreeningDispatch(secret, timestamp, body);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SCREENING_DISPATCH_TIMESTAMP_HEADER]: timestamp,
      [SCREENING_DISPATCH_SIGNATURE_HEADER]: signature,
    },
    body,
  });
  if (response.status !== 202) return { accepted: false, attempt_id: attemptId, reason: 'rejected' };
  return { accepted: true, attempt_id: attemptId };
}

export function screeningAiUserEnabled() {
  return isScreeningAiEnabled(readEnv('SCREENING_AI_ENABLED'));
}
