import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTenantReads, tenantTables } from '../scripts/live-tenant-check.mjs';

const firms = [['firm-a'], ['firm-b']];
function clientsFor(respond) {
  return [0, 1].map(index => ({
    from(table) {
      assert.ok(tenantTables.includes(table));
      return { select(column) {
        assert.equal(column, table === 'companies' ? 'id' : 'company_id');
        return { in(filter, ids) {
          assert.equal(filter, column);
          return { async limit(max) {
            assert.equal(max, 1);
            return respond({ table, own: ids === firms[index], column, index });
          } };
        } };
      } };
    },
  }));
}
const isolated = ({ own, column, index }) => ({ data: own ? [{ [column]: firms[index][0] }] : [], error: null });

test('live checker requires positive controls in both firms for eleven tables and the assessment view', async () => {
  const checked = new Set();
  await checkTenantReads(clientsFor(args => {
    checked.add(`${args.table}:${args.index}:${args.own}`);
    return isolated(args);
  }), firms);
  assert.ok(tenantTables.includes('behavior_assessment_entries') && tenantTables.includes('latest_behavior_assessments'));
  assert.equal(checked.size, 48);
});

test('empty or invisible CV fixtures cannot produce a successful RLS test', async () => {
  await assert.rejects(checkTenantReads(clientsFor(args => args.table === 'candidate_documents' && args.index === 1
    ? { data: [], error: null } : isolated(args)), firms), /Niepełny test: tabela candidate_documents.*konta B/);
});

test('live checker detects a foreign row and does not treat API errors as isolation', async () => {
  await assert.rejects(checkTenantReads(clientsFor(args => !args.own && args.table === 'candidates'
    ? { data: [{ company_id: 'foreign' }], error: null } : isolated(args)), firms), /Izolacja firm nie działa: candidates/);
  await assert.rejects(checkTenantReads(clientsFor(args => !args.own
    ? { data: null, error: { code: '42501' } } : isolated(args)), firms), /Błąd odczytu obcej tabeli/);
  await assert.rejects(checkTenantReads(clientsFor(() => ({ data: null, error: { code: 'PGRST205' } })), firms), /Błąd odczytu własnej tabeli/);
});

test('overlapping memberships stop the live check before data queries', async () => {
  await assert.rejects(checkTenantReads(clientsFor(() => { throw Error('must not query'); }), [['firm-a'], ['firm-a']]), /różnych firm/);
});
