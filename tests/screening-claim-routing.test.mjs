import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { screeningClaimRpcName } from '../lib/screening-claim-route.ts';

test('v1 always selects legacy claim RPC; v2 selects only new RPC', () => {
  assert.equal(screeningClaimRpcName(1), 'claim_screening_attempt');
  assert.equal(screeningClaimRpcName(2), 'claim_screening_attempt_v2');
  for (const unsupported of [0,3,NaN,undefined]) assert.throws(() => screeningClaimRpcName(unsupported));
});

test('legacy claim DDL stays unchanged and worker chooses one claim, never fallback', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261026220200_sc_step3_evidence_worker.sql', import.meta.url), 'utf8');
  const down = readFileSync(new URL('../supabase/rollbacks/20261026220200_sc_step3_evidence_worker_down.sql', import.meta.url), 'utf8');
  const original = readFileSync(new URL('../supabase/migrations/20261005000100_screening_worker_claim_payload.sql', import.meta.url), 'utf8');
  assert.match(original, /create function public\.claim_screening_attempt\(/);
  assert.doesNotMatch(sql, /drop\s+function\s+(?:if\s+exists\s+)?public\.claim_screening_attempt\(/i);
  assert.doesNotMatch(sql, /create\s+(?:or\s+replace\s+)?function\s+public\.claim_screening_attempt\(/i);
  assert.doesNotMatch(sql, /create\s+or\s+replace/i);
  assert.doesNotMatch(down, /drop\s+function\s+(?:if\s+exists\s+)?public\.claim_screening_attempt\(/i);
  const worker = readFileSync(new URL('../supabase/functions/screening-worker/index.ts', import.meta.url), 'utf8');
  assert.match(worker, /screeningClaimRpcName\(Number\(contract\[0\]\?\.version\)\)/);
  assert.match(worker, /if \(name === "claim_screening_attempt_v2"\)/);
  assert.match(worker, /return rows\[0\] \?\? null;\s*}\s*const rows = await tx`select \* from public\.claim_screening_attempt\(/);
  const defV2 = sql.slice(sql.indexOf('create function public.claim_screening_attempt_v2'),sql.indexOf('revoke all on function public.claim_screening_attempt_v2'));
  assert.doesNotMatch(defV2, /public\.claim_screening_attempt\(/);
  assert.match(defV2, /analysis\.result_schema_version <> 2/);
  assert.match(sql, /grant execute on function public.claim_screening_attempt_v2\(uuid\) to screening_worker/);
  assert.match(sql, /revoke all on function public.claim_screening_attempt_v2\(uuid\)/);
});
