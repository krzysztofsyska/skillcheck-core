/** B2 server-only SQL transport. No HTTP route, cookies, credentials or pool is
 * created here. A later broker supplies an independently authenticated dedicated
 * gateway connection, enforces request limits and never streams before COMMIT. */
import { createHash } from 'node:crypto';
export interface CompetencyConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export type CompetencyOperation =
  | { kind: 'exchange'; token: string }
  | { kind: 'inspect' | 'status'; session: string }
  | { kind: 'start'; session: string; requestKey: string }
  | { kind: 'save'; session: string; draft: string; expectedVersion: number; requestKey: string }
  | { kind: 'submit'; session: string; answer: unknown; requestKey: string };

/** The caller owns this dedicated connection exclusively for the entire call.
 * The login may inherit ONLY competency_test_gateway; never authenticated,
 * service_role, a table owner, superuser, or a role with database DML rights. */
export async function executeCompetencyOperation(client: CompetencyConnection, operation: CompetencyOperation) {
  let began = false;
  try {
    await client.query('begin isolation level read committed'); began = true;
    await client.query('set local role competency_test_gateway');
    let sql: string; let values: unknown[];
    if (operation.kind === 'exchange') {
      if (!/^[0-9a-f]{64}$/.test(operation.token)) throw new Error('Invalid capability');
      sql = 'select private.exchange_candidate_competency_test_session($1) as result'; values = [operation.token];
    } else {
      if (!/^[0-9a-f]{64}$/.test(operation.session)) throw new Error('Invalid capability');
      const hash = createHash('sha256').update(operation.session).digest();
      switch (operation.kind) {
        case 'inspect': sql = 'select private.inspect_candidate_competency_test($1) as result'; values = [hash]; break;
        case 'status': sql = 'select private.status_candidate_competency_test($1) as result'; values = [hash]; break;
        case 'start': sql = 'select private.start_candidate_competency_test($1,$2) as result'; values = [hash, operation.requestKey]; break;
        case 'save': sql = 'select private.save_candidate_competency_test_draft($1,$2,$3,$4) as result'; values = [hash, operation.draft, operation.expectedVersion, operation.requestKey]; break;
        case 'submit': sql = 'select private.submit_candidate_competency_test($1,$2::jsonb,$3) as result'; values = [hash, JSON.stringify(operation.answer), operation.requestKey]; break;
      }
    }
    const response = (await client.query(sql, values)).rows[0]?.result;
    await client.query('commit'); began = false;
    return response;
  } catch (error) {
    if (began) await client.query('rollback').catch(() => undefined);
    // No logging of SQL arguments, errors with provider detail, or capabilities.
    throw error;
  }
}
