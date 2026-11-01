import 'server-only';
import { createHash } from 'node:crypto';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { createClient } from './supabase/server';
import { getSupabaseEnv } from './supabase/env';
import { dispatchScreeningWorker, screeningAiUserEnabled } from './screening-dispatch';
import { appOrigin } from './auth-url';
import { pumpAllSigned, pumpBatch, type PumpDeps } from './cv-bulk-runner';

type Client = Awaited<ReturnType<typeof createClient>>;

function deps(rpc: PumpDeps['rpc']): PumpDeps {
  return { rpc, dispatch: attemptId => dispatchScreeningWorker(attemptId), aiEnabled: screeningAiUserEnabled(), origin: () => appOrigin() };
}

/** Pump with the recruiter's session (RLS and access checks in SQL). */
export async function pumpWithSession(client: Client, batchId: string) {
  return pumpBatch(deps((fn, args) => client.rpc(fn as never, args as never) as never), batchId);
}

export function bulkWorkerConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Buffer.byteLength(env.CV_BULK_WORKER_SECRET ?? '') >= 32;
}

/** Scheduler pump: anonymous Data API client + signature verified by the database. */
export async function pumpScheduled() {
  const { url, key } = getSupabaseEnv();
  const anon = createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return pumpAllSigned({ ...deps((fn, args) => anon.rpc(fn, args) as never), secret: process.env.CV_BULK_WORKER_SECRET!,
    digest: text => createHash('sha256').update(text).digest('hex') });
}
