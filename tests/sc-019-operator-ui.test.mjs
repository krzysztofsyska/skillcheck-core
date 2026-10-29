import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGrantForm, parsePolicyForm, parseTrialForm, sc19OperatorError, sc19OperatorNotices } from '../lib/sc19-operator.ts';

const form = values => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const company = '20000000-0000-4000-8000-000000000001';

test('policy form accepts only FREE/PRESELEKCJA and 1..100000 credits', () => {
  assert.deepEqual(parsePolicyForm(form({ plan: 'FREE', credits: '5' })), { target_plan: 'FREE', target_credits: 5 });
  assert.deepEqual(parsePolicyForm(form({ plan: 'PRESELEKCJA', credits: ' 60 ' })), { target_plan: 'PRESELEKCJA', target_credits: 60 });
  for (const values of [{ plan: 'GOLD', credits: '5' }, { plan: 'FREE', credits: '0' }, { plan: 'FREE', credits: '1.5' },
    { plan: 'FREE', credits: '100001' }, { plan: 'FREE' }, {}]) assert.equal(parsePolicyForm(form(values)), null);
});

test('trial form normalizes NIP separators and bounds the proof', () => {
  assert.deepEqual(parseTrialForm(form({ companyId: company, nip: '526-025-09-95', proof: 'KRS 0000123456 2026-10-29' })),
    { target_company: company, supplied_nip: '5260250995', proof: 'KRS 0000123456 2026-10-29' });
  for (const values of [
    { companyId: 'x', nip: '5260250995', proof: 'KRS 0000123456' },
    { companyId: company, nip: '52602509', proof: 'KRS 0000123456' },
    { companyId: company, nip: '5260250995', proof: 'short' },
    { companyId: company, nip: '5260250995', proof: 'x'.repeat(101) },
  ]) assert.equal(parseTrialForm(form(values)), null);
});

test('grant form requires a company and an 8..160 character settlement reference', () => {
  assert.deepEqual(parseGrantForm(form({ companyId: company, settlement: ' FV/1/2026 ' })), { target_company: company, settlement_reference: 'FV/1/2026' });
  assert.equal(parseGrantForm(form({ companyId: company, settlement: 'FV/1' })), null);
  assert.equal(parseGrantForm(form({ companyId: company, settlement: 'x'.repeat(161) })), null);
  assert.equal(parseGrantForm(form({ settlement: 'FV/1/2026' })), null);
});

test('database errors map to known panel notices', () => {
  assert.equal(sc19OperatorError({ code: '22023', message: 'sc19_invalid_nip' }), 'invalid_nip');
  assert.equal(sc19OperatorError({ code: '23505', message: 'sc19_reference_conflict' }), 'reference_conflict');
  assert.equal(sc19OperatorError({ code: '55000', message: 'sc19_missing_paid_policy' }), 'missing_policy');
  assert.equal(sc19OperatorError({ code: '23505', message: 'sc19_trial_nip_taken' }), 'conflict');
  assert.equal(sc19OperatorError({ code: '22023', message: 'sc19_invalid_proof' }), 'invalid');
  assert.equal(sc19OperatorError({ code: 'XX000', message: 'boom' }), 'failed');
  for (const value of ['invalid_nip', 'reference_conflict', 'missing_policy', 'conflict', 'invalid', 'failed']) assert.ok(sc19OperatorNotices[value]);
});

test('operator panel is gated by the operator check and never reads balances directly', async () => {
  const page = await readFile(new URL('../app/operator/billing/page.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../app/operator/billing/actions.ts', import.meta.url), 'utf8');
  assert.match(page, /await salesOperator\(\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.doesNotMatch(page + actions, /service_role|SUPABASE_SERVICE|\.from\(/);
  assert.match(actions, /auth\.getUser\(\)/);
  for (const name of ['savePolicy', 'approveTrial', 'grantPaid']) assert.match(actions, new RegExp(`export async function ${name}[\\s\\S]*?confirm'\\) !== 'yes'`));
});
