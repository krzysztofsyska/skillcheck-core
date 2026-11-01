// Preview-only smoke test of the REAL screening worker code (lib/screening-worker.ts)
// and OpenAI, against pending analyses of synthetic test companies on
// skillcheck-preview. Same store contract as supabase/functions/screening-worker.
// Logs attempt ids, statuses and token counts only — never CV text.
//
// Env: PREVIEW_DATABASE_URL, OPENAI_API_KEY, optional MAX_ATTEMPTS (default 10).
import pg from 'pg';
import { callOpenAiResponses, runScreeningAttempt } from '../lib/screening-worker.ts';
import { screeningClaimRpcName } from '../lib/screening-claim-route.ts';

const PREVIEW_REF = 'orbyscrupgnupifzlqxp', PRODUCTION_REF = 'wsvjawuikxfzjyivxgsu';
const url = process.env.PREVIEW_DATABASE_URL ?? '';
if (!url.includes(PREVIEW_REF) || url.includes(PRODUCTION_REF)) throw new Error('Refusing: not the skillcheck-preview database');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
const max = Math.min(Math.max(Number(process.env.MAX_ATTEMPTS ?? 10) || 10, 1), 20);

// TLS: Supabase Postgres certificates are signed by Supabase's own root CA (not in the system store), so
// full verification needs that CA. With PREVIEW_DATABASE_CA_CERT (PEM of "Supabase Root 2021 CA", from the
// project's Database settings) the server certificate is verified; without it the connection is encrypted
// but unverified. Preview holds synthetic data only.
const ca = process.env.PREVIEW_DATABASE_CA_CERT?.trim();
if (!ca) console.warn('PREVIEW_DATABASE_CA_CERT not set: TLS certificate of the preview database is not verified');
const pool = new pg.Pool({ connectionString: url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''), max: 2,
  ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } });
async function asWorker(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role screening_worker');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback').catch(() => {}); throw error; } finally { client.release(); }
}
const store = {
  claim: attemptId => asWorker(async c => {
    const version = (await c.query('select public.screening_attempt_result_schema_version($1::uuid) v', [attemptId])).rows[0]?.v;
    const fn = screeningClaimRpcName(Number(version));
    return (await c.query(`select * from public.${fn}($1::uuid)`, [attemptId])).rows[0] ?? null;
  }),
  complete: input => asWorker(async c => {
    const v2 = Array.isArray(input.findings) && input.findings.some(i => i && typeof i === 'object' && 'verdict' in i);
    const fn = v2 ? 'complete_screening_evidence' : 'complete_screening_analysis';
    const row = (await c.query(`select public.${fn}($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,null,null) id`, [input.attemptId, input.leaseToken,
      input.inputFingerprint, input.analysisContractHash, JSON.stringify(input.findings), input.providerRequestId, input.providerResponseId,
      input.inputTokens, input.outputTokens, input.cachedInputTokens])).rows[0];
    return String(row.id);
  }),
  fail: input => asWorker(async c => {
    const row = (await c.query('select public.fail_screening_attempt($1::uuid,$2,$3,$4,$5,$6,null,null,null,null,null,null) id', [input.attemptId,
      input.leaseToken, input.inputFingerprint, input.analysisContractHash, input.errorCode, input.errorMessage])).rows[0];
    return row ? String(row.id) : null;
  }),
};

// Only synthetic companies created for the bulk E2E.
const attempts = (await pool.query(`select t.id from public.screening_analysis_attempts t
  join public.screening_analysis_versions s on s.id = t.analysis_id
  join public.companies c on c.id = s.company_id
  where t.status = 'pending' and c.name like 'Firma Testowa%'
  order by t.created_at desc limit $1`, [max])).rows.map(r => r.id); // newest first: the batch just uploaded
console.log(JSON.stringify({ pending_selected: attempts.length, max }));
const runtime = {
  enabled: true, store,
  callOpenAi: request => callOpenAiResponses(process.env.OPENAI_API_KEY, request),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  log: entry => console.log(JSON.stringify(entry)),
};
let failed = 0;
for (const id of attempts) {
  try { await runScreeningAttempt(id, runtime); }
  catch { failed++; console.log(JSON.stringify({ attempt_id: id, status: 'runner_error' })); }
}
const summary = (await pool.query(`select count(*) filter (where t.status='completed')::int completed, count(*) filter (where t.status='failed')::int failed,
  coalesce(sum(t.input_tokens),0)::int input_tokens, coalesce(sum(t.output_tokens),0)::int output_tokens, coalesce(sum(t.cached_input_tokens),0)::int cached_input_tokens
  from public.screening_analysis_attempts t where t.id = any($1::uuid[])`, [attempts])).rows[0];
console.log(JSON.stringify({ summary, runner_errors: failed }));
await pool.end();
if (attempts.length && summary.completed === 0) process.exit(1);
