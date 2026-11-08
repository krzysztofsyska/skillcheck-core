import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkProgressCore, closeBulkUploadCore, createBulkBatchCore } from '../lib/cv-bulk-actions.ts';

// Synthetic fixture only: a fake client records every call. This proves the action's own
// ordering and refusals; it is NOT evidence of real RLS (that lives in the database tests).
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RA = '11111111-1111-4111-8111-111111111111';   // recruitment of company A
const RB = '22222222-2222-4222-8222-222222222222';   // recruitment of company B
const BATCH_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', BATCH_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KEY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const files = [{ name: 'a.pdf', kind: 'pdf', size: 10 }];
const recruitments = [{ id: RA, company_id: A }, { id: RB, company_id: B }];
const batches = { [BATCH_A]: RA, [BATCH_B]: RB };
const ITEM = '99999999-9999-4999-8999-999999999999';
const statusOf = id => ({ batch: { id, recruitment_id: batches[id], declared_files: 1, reserved_slots: 1 },
  items: [{ id: ITEM, position: 1, file_name: 'a.pdf', file_kind: 'pdf', application_id: null, group_key: null }] });

function harness({ canEdit = true, aiEnabled = true, rpcErrors = {}, selectError = false, rpcData = {} } = {}) {
  const calls = { rpc: [], mutations: 0, pumps: 0, selects: [] };
  const client = {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(k, v) { filters[k] = v; return q; },
        async maybeSingle() {
          calls.selects.push({ table, ...filters });
          if (selectError) return { data: null, error: { message: 'boom' } };
          return { data: recruitments.find(r => r.id === filters.id && r.company_id === filters.company_id) ?? null, error: null };
        },
      };
      return q;
    },
    async rpc(fn, args) {
      calls.rpc.push(fn);
      if (fn === 'cv_bulk_create_batch' || fn === 'cv_bulk_close_upload') calls.mutations++;
      if (rpcErrors[fn]) return { data: null, error: { message: rpcErrors[fn] } };
      if (fn in rpcData) return { data: typeof rpcData[fn] === 'function' ? rpcData[fn](args) : rpcData[fn], error: null };
      if (fn === 'cv_bulk_create_batch') return { data: { batch_id: BATCH_A, reserved_slots: 1, over_limit: 0 }, error: null };
      if (fn === 'cv_bulk_batch_status') return { data: batches[args.target_batch] ? statusOf(args.target_batch) : null, error: null };
      if (fn === 'cv_bulk_close_upload') return { data: 0, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  const deps = {
    access: async companyId => { calls.access = (calls.access ?? 0) + 1; calls.company = companyId; return { client, canEdit }; },
    pump: async () => { calls.pumps++; },
    aiEnabled: () => aiEnabled,
  };
  return { deps, calls };
}
const noEffects = c => { assert.equal(c.mutations, 0, 'no create/close RPC'); assert.equal(c.pumps, 0, 'no pump'); };

test('create: company A URL with company B recruitment is refused before reserve', async () => {
  const { deps, calls } = harness();
  const r = await createBulkBatchCore(deps, A, RB, KEY, files);
  assert.ok(r.error); assert.equal(r.batchId, undefined);
  noEffects(calls); assert.deepEqual(calls.rpc, []);
});

test('create: read-only, AI off, bad UUIDs, query error all refuse with zero mutations', async () => {
  for (const [name, h, args] of [
    ['read-only', { canEdit: false }, [A, RA, KEY]],
    ['ai off', { aiEnabled: false }, [A, RA, KEY]],
    ['bad recruitment uuid', {}, [A, 'nope', KEY]],
    ['bad request key', {}, [A, RA, 'nope']],
    ['recruitment query error', { selectError: true }, [A, RA, KEY]],
  ]) {
    const { deps, calls } = harness(h);
    const r = await createBulkBatchCore(deps, ...args, files);
    assert.ok(r.error, name); noEffects(calls); assert.deepEqual(calls.rpc, [], name);
  }
});

test('create: invalid file list is refused before the reserve RPC', async () => {
  const { deps, calls } = harness();
  const r = await createBulkBatchCore(deps, A, RA, KEY, []);
  assert.ok(r.error); noEffects(calls);
});

test('create: RPC failure, malformed id and mismatched status never report success', async () => {
  for (const h of [
    { rpcErrors: { cv_bulk_create_batch: 'cv_bulk_recruitment_closed' } },
    { rpcErrors: { cv_bulk_create_batch: 'other' } },
    { rpcData: { cv_bulk_create_batch: { batch_id: 'not-a-uuid', reserved_slots: 1, over_limit: 0 } } },
    { rpcData: { cv_bulk_create_batch: [] } },
    { rpcErrors: { cv_bulk_batch_status: 'down' } },
    { rpcData: { cv_bulk_batch_status: statusOf(BATCH_B) } },   // status of another company's batch
  ]) {
    const { deps, calls } = harness(h);
    const r = await createBulkBatchCore(deps, A, RA, KEY, files);
    assert.ok(r.error); assert.equal(r.batchId, undefined); assert.equal(calls.pumps, 0);
  }
});

test('create: valid A/A path reserves exactly once and returns the verified batch', async () => {
  const { deps, calls } = harness();
  const r = await createBulkBatchCore(deps, A, RA, KEY, files);
  assert.equal(r.error, undefined); assert.equal(r.batchId, BATCH_A); assert.equal(r.reserved, 1);
  assert.equal(calls.mutations, 1);
  assert.deepEqual(calls.rpc, ['cv_bulk_create_batch', 'cv_bulk_batch_status']);
  assert.equal(calls.pumps, 0, 'creating a batch does not pump');
});

test('close: foreign batch, foreign recruitment, bad ids, read-only, errors → refused before close/pump', async () => {
  for (const [name, h, args] of [
    ['batch of B via A/RA', {}, [A, RA, BATCH_B]],
    ['recruitment of B via company A', {}, [A, RB, BATCH_B]],
    ['A batch under B recruitment', {}, [A, RB, BATCH_A]],
    ['unknown batch', {}, [A, RA, 'ffffffff-ffff-4fff-8fff-ffffffffffff']],
    ['bad batch uuid', {}, [A, RA, 'x']],
    ['bad recruitment uuid', {}, [A, 'x', BATCH_A]],
    ['read-only', { canEdit: false }, [A, RA, BATCH_A]],
    ['status rpc error', { rpcErrors: { cv_bulk_batch_status: 'down' } }, [A, RA, BATCH_A]],
    ['company query error', { selectError: true }, [A, RA, BATCH_A]],
  ]) {
    const { deps, calls } = harness(h);
    const r = await closeBulkUploadCore(deps, ...args);
    assert.deepEqual(r, { error: 'Brak dostępu.' }, name); noEffects(calls);
  }
});

test('close: bad RPC result is an error and does not pump; valid path closes and pumps once', async () => {
  for (const bad of [null, -1, 1.5, 'x']) {
    const { deps, calls } = harness({ rpcData: { cv_bulk_close_upload: bad } });
    const r = await closeBulkUploadCore(deps, A, RA, BATCH_A);
    assert.ok(r.error); assert.equal(calls.pumps, 0);
  }
  const bad = harness({ rpcErrors: { cv_bulk_close_upload: 'x' } });
  assert.ok((await closeBulkUploadCore(bad.deps, A, RA, BATCH_A)).error); assert.equal(bad.calls.pumps, 0);
  const ok = harness({ rpcData: { cv_bulk_close_upload: 3 } });
  assert.deepEqual(await closeBulkUploadCore(ok.deps, A, RA, BATCH_A), { released: 3 });
  assert.equal(ok.calls.mutations, 1); assert.equal(ok.calls.pumps, 1);
});

test('poll: foreign/invalid/failed lookups return null with zero pumps', async () => {
  for (const [name, h, args] of [
    ['batch of B via A/RA', {}, [A, RA, BATCH_B]],
    ['recruitment of B via company A', {}, [A, RB, BATCH_B]],
    ['unknown batch', {}, [A, RA, 'ffffffff-ffff-4fff-8fff-ffffffffffff']],
    ['bad uuid', {}, [A, RA, 'x']],
    ['status error', { rpcErrors: { cv_bulk_batch_status: 'down' } }, [A, RA, BATCH_A]],
    ['company query error', { selectError: true }, [A, RA, BATCH_A]],
  ]) {
    const { deps, calls } = harness(h);
    assert.equal(await bulkProgressCore(deps, ...args), null, name); noEffects(calls);
  }
});

test('poll: recruiter A/A pumps exactly once; read-only viewer reads without pumping', async () => {
  const rec = harness();
  const r = await bulkProgressCore(rec.deps, A, RA, BATCH_A);
  assert.equal(r.batch.id, BATCH_A); assert.equal(rec.calls.pumps, 1); assert.equal(rec.calls.mutations, 0);
  const view = harness({ canEdit: false });
  const v = await bulkProgressCore(view.deps, A, RA, BATCH_A);
  assert.equal(v.batch.id, BATCH_A); assert.equal(view.calls.pumps, 0);
});

test('poll: a pump that throws does not break the status; a post-pump status of another batch is refused', async () => {
  const { deps } = harness();
  deps.pump = async () => { throw new Error('pump down'); };
  assert.equal((await bulkProgressCore(deps, A, RA, BATCH_A)).batch.id, BATCH_A);
  let n = 0;
  const swapped = harness({ rpcData: { cv_bulk_batch_status: () => (++n === 1 ? statusOf(BATCH_A) : statusOf(BATCH_B)) } });
  assert.equal(await bulkProgressCore(swapped.deps, A, RA, BATCH_A), null);
});
