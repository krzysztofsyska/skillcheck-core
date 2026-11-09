// SC-021-B: server-only writer of exercise-generation attempts to the AI ledger.
//
// Writes go through a dedicated server connection (AI_LEDGER_DATABASE_URL) whose login may
// inherit only the NOLOGIN role `ai_ledger_writer` — never through the recruiter's session.
// The function it calls (ai_ledger.record_exercise_attempt) binds the row to the live generation
// reservation; the company and recruitment passed here come from the server's verified context.
// Importing this module creates no pool. Nothing here logs SQL arguments or connection details.
import { Pool } from 'pg';
import { previewPoolTls } from './sc19-payment-preview-tls.ts';
import type { LedgerAttemptPayload, LedgerWriter } from './ai-gateway/ledger.ts';
import type { BudgetReserver } from './ai-gateway/budget.ts';

export interface AiLedgerConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export type AiLedgerConnect = () => Promise<AiLedgerConnection>;

/**
 * Validates the server-only DSN. Login names are `ai_ledger_<suffix>` (created by the operator,
 * member of ai_ledger_writer only); a password is required; loopback hosts are refused.
 * Returns null when the variable is missing or unsafe (callers fail closed).
 */
export function aiLedgerDatabaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname
    || !/^ai_ledger_[a-z0-9_]{1,40}$/.test(decodeURIComponent(parsed.username))
    || !parsed.password || parsed.search || parsed.hash
    || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) return null;
  return parsed.toString();
}

/** One write = one transaction as ai_ledger_writer; resolves only after COMMIT. */
export function createExerciseLedgerWriter(connect: AiLedgerConnect, companyId: string, recruitmentId: string): LedgerWriter {
  return async (payload: LedgerAttemptPayload) => {
    const client = await connect();
    let began = false, broken = false;
    try {
      await client.query('begin isolation level read committed'); began = true;
      await client.query('set local role ai_ledger_writer');
      await client.query('select ai_ledger.record_exercise_attempt($1::uuid,$2::uuid,$3::jsonb) as result',
        [companyId, recruitmentId, JSON.stringify(payload)]);
      await client.query('commit'); began = false;
    } catch {
      if (began) await client.query('rollback').catch(() => { broken = true; });
      // Database text may describe the row; only a fixed message leaves this function.
      throw new Error('SC021_LEDGER_WRITE_FAILED');
    } finally {
      client.release(broken);
    }
  };
}

/** One budget call = one transaction as ai_ledger_writer; resolves with the database answer after COMMIT. */
async function asWriter(connect: AiLedgerConnect, sql: string, values: unknown[]): Promise<unknown> {
  const client = await connect();
  let began = false, broken = false;
  try {
    await client.query('begin isolation level read committed'); began = true;
    await client.query('set local role ai_ledger_writer');
    const { rows } = await client.query(sql, values);
    await client.query('commit'); began = false;
    return rows[0]?.result ?? null;
  } catch {
    if (began) await client.query('rollback').catch(() => { broken = true; });
    throw new Error('SC021_BUDGET_CALL_FAILED');
  } finally {
    client.release(broken);
  }
}

/** SC-021-C: budget of one exercise generation (company + recruitment + request key). */
export type ExerciseBudgetClient = {
  /** ai_ledger.reserve_exercise_budget; idempotent per request key. */
  reserve: BudgetReserver;
  /** ai_ledger.release_exercise_budget: frees what the generation did not use. */
  release: (operationId: string) => Promise<void>;
};

export function createExerciseBudgetClient(connect: AiLedgerConnect, companyId: string, recruitmentId: string): ExerciseBudgetClient {
  return {
    reserve: operationId => asWriter(connect, 'select ai_ledger.reserve_exercise_budget($1::uuid,$2::uuid,$3::uuid) as result',
      [companyId, recruitmentId, operationId]),
    release: async operationId => {
      await asWriter(connect, 'select ai_ledger.release_exercise_budget($1::uuid,$2::uuid,$3::uuid) as result',
        [companyId, recruitmentId, operationId]);
    },
  };
}

// Timeouts: connect ≤ 3 s, each statement ≤ 4 s. The gateway stops waiting for the hook after 10 s,
// but a write already in flight may still COMMIT afterwards. The outcome is then a recorded attempt
// with a failed draft (ledger_error) — never an unrecorded paid call.
let pool: Pool | undefined;

/**
 * Writer for the exercise-generation gateway path, or null when AI_LEDGER_DATABASE_URL is missing
 * or unsafe. With AI_GATEWAY_ENABLED=true a null here must stop generation before any provider call.
 */
function ledgerPool(): Pool | null {
  const url = aiLedgerDatabaseUrl(process.env.AI_LEDGER_DATABASE_URL);
  if (!url) return null;
  return pool ??= new Pool({ connectionString: url, ssl: previewPoolTls, max: 2, maxUses: 100,
    connectionTimeoutMillis: 3000, query_timeout: 4000, idleTimeoutMillis: 15000, allowExitOnIdle: true, options: '' })
    .on('error', () => { /* pg discards a broken idle client; never log credentials */ });
}

export function exerciseLedgerWriterFromEnv(companyId: string, recruitmentId: string): LedgerWriter | null {
  const database = ledgerPool();
  return database ? createExerciseLedgerWriter(() => database.connect(), companyId, recruitmentId) : null;
}

/** SC-021-C: budget client on the same server-only connection, or null (callers fail closed). */
export function exerciseBudgetFromEnv(companyId: string, recruitmentId: string): ExerciseBudgetClient | null {
  const database = ledgerPool();
  return database ? createExerciseBudgetClient(() => database.connect(), companyId, recruitmentId) : null;
}
