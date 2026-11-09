// SC-021-D: operator AI cost panel helpers (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aiCostError, describeCostMicros, describeReasons, formatMicros, formatPln, formatRate, parseDecimal, parseFxForm,
  parseGrouping, parseMonth, parseOtherCostForm, parsePeriod, warsawMonth, COST_GROUPINGS, MARGIN_GROUPINGS } from '../lib/ai-cost-dashboard.ts';

const form = values => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const key = '20000000-0000-4000-8000-000000000009';
const company = '20000000-0000-4000-8000-000000000001';

test('periods: inclusive months, Warsaw current month, at most 24 months', () => {
  assert.equal(parseMonth('2026-11'), '2026-11-01');
  for (const bad of ['2026-13', '2026-1', '26-11', '2026-11-01', null, 202611, '1999-01']) assert.equal(parseMonth(bad), null);
  // 23:30 UTC on 31 Oct is already November in Warsaw.
  assert.equal(warsawMonth(new Date('2026-10-31T23:30:00Z')), '2026-11');
  const now = new Date('2026-11-09T10:00:00Z');
  assert.deepEqual(parsePeriod(undefined, undefined, now), { from: '2026-11-01', to: '2026-11-01', adjusted: false });
  assert.deepEqual(parsePeriod('2025-12', '2026-11', now), { from: '2025-12-01', to: '2026-11-01', adjusted: false });
  assert.deepEqual(parsePeriod('2024-11', '2026-11', now), { from: '2026-11-01', to: '2026-11-01', adjusted: true });
  assert.deepEqual(parsePeriod('2026-11', '2026-10', now), { from: '2026-11-01', to: '2026-11-01', adjusted: true });
  assert.equal(parseGrouping('candidate', COST_GROUPINGS, 'company'), 'candidate');
  assert.equal(parseGrouping('candidate', MARGIN_GROUPINGS, 'company'), 'company');
  assert.equal(parseGrouping('__proto__', COST_GROUPINGS, 'company'), 'company');
});

test('money is integer: decimals parse exactly, PLN and micro-units format without floats', () => {
  assert.equal(parseDecimal('4,1234', 6), 4123400);
  assert.equal(parseDecimal('4.000001', 6), 4000001);
  assert.equal(parseDecimal('12', 2), 1200);
  assert.equal(parseDecimal('0,1', 2), 10);
  for (const bad of ['4,1234567', '-1', '1e3', '', 'abc', '1,2,3']) assert.equal(parseDecimal(bad, 6), null, bad);
  assert.equal(formatPln(24390), '243,90 zł');
  assert.equal(formatPln('-1250'), '−12,50 zł');
  assert.equal(formatPln(5), '0,05 zł');
  assert.equal(formatPln(null), 'niedostępne');
  assert.match(formatPln(123456789), /^1\s?234\s?567,89 zł$/);
  assert.equal(formatMicros(1500000, 'USD'), '1,500000 USD');
  assert.equal(formatMicros(5, 'EUR'), '0,000005 EUR');
  assert.equal(formatRate(4123456), '4,123456');
  assert.deepEqual(describeCostMicros({ USD: { confirmed: 1000000, placeholder: 500000, reserved: 0 }, '?': { confirmed: 0, placeholder: 0, reserved: 300 } }), [
    '0,000300 (waluta nieznana) zarezerwowane, niewliczone',
    '1,000000 USD (stawki zatwierdzone)',
    '0,500000 USD — szacunek (stawki testowe)',
  ]);
  assert.equal(describeReasons(['fx_placeholder', 'new_code']), 'kurs waluty testowy; new_code');
});

test('forms: FX rate and other cost lines are validated before any RPC', () => {
  assert.deepEqual(parseFxForm(form({ base: 'USD', rate: '4,05', validFrom: '2026-11-01', note: 'NBP tabela A', requestKey: key })), {
    request_key: key, base_currency: 'USD', rate_micros: 4050000, valid_from: '2026-11-01T00:00:00Z', source_note: 'NBP tabela A', placeholder: false });
  assert.equal(parseFxForm(form({ base: 'EUR', rate: '4', validFrom: '2026-11-01', note: 'test', requestKey: key, placeholder: 'yes' })).placeholder, true);
  for (const bad of [{ base: 'GBP' }, { rate: '0' }, { rate: '1001' }, { validFrom: '2026-11' }, { note: 'ab' }, { requestKey: 'x' }]) {
    assert.equal(parseFxForm(form({ base: 'USD', rate: '4', validFrom: '2026-11-01', note: 'note', requestKey: key, ...bad })), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseOtherCostForm(form({ month: '2026-11', companyId: company, package: '', category: 'sms', amount: '12,5', note: '', supersedes: '', requestKey: key })), {
    request_key: key, period_month: '2026-11-01', target_company: company, package_code: null, category: 'sms', amount_minor: 1250, note: null, supersedes: null });
  for (const bad of [{ month: '2026-11-05' }, { companyId: 'x' }, { package: 'GOLD' }, { category: 'salary' }, { amount: '-1' }, { amount: '1,001' },
    { note: 'x'.repeat(301) }, { supersedes: 'nope' }, { requestKey: '' }]) {
    assert.equal(parseOtherCostForm(form({ month: '2026-11', companyId: company, category: 'sms', amount: '1', requestKey: key, ...bad })), null, JSON.stringify(bad));
  }
  assert.equal(aiCostError({ code: '22023' }), 'invalid');
  assert.equal(aiCostError({ code: 'PT409' }), 'conflict');
  assert.equal(aiCostError({ code: 'PT404' }), 'company');
  assert.equal(aiCostError({ code: 'XX000' }), 'failed');
});

test('the panel is operator-only, read-only apart from the two audited forms, and marks estimates', async () => {
  const page = await readFile(new URL('../app/operator/ai-costs/page.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../app/operator/ai-costs/actions.ts', import.meta.url), 'utf8');
  assert.match(page, /await salesOperator\(\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /szacunek \(stawki testowe\)/);
  assert.match(page, /kurs testowy/);
  assert.deepEqual([...new Set([...actions.matchAll(/'(sc021_operator_[a-z_]+)'/g)].map(m => m[1]))].sort(), ['sc021_operator_add_fx_rate', 'sc021_operator_add_other_cost']);
  for (const source of [page, actions]) {
    assert.doesNotMatch(source, /service_role|SUPABASE_SERVICE|createAdminClient/);
    assert.doesNotMatch(source, /\.from\(['"]/, 'no direct table access');
  }
});
