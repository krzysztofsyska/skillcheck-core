import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGrantForm, parsePolicyForm, parseReleaseForm, parseTrialForm, sc19OperatorError, sc19OperatorNotices } from '../lib/sc19-operator.ts';

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

// The release must name the company the operator was looking at, or it releases
// "whoever holds this NIP now" — which, on a page a few minutes old, can be the
// company that rightfully took the NIP over (bot review finding 4458164495,
// 2026-11-03). The form sends it, the parser demands it, and the database
// refuses the release when it no longer matches.
test('release form carries the company the operator verified, and refuses to go without it', async () => {
  assert.deepEqual(parseReleaseForm(form({ companyId: company, nip: '526-025-09-95', reason: 'KRS sprawdzony 2026-11-03' })),
    { supplied_nip: '5260250995', release_reason: 'KRS sprawdzony 2026-11-03', expected_company: company });
  for (const values of [
    { nip: '5260250995', reason: 'KRS sprawdzony 2026-11-03' }, // the company missing is a refusal, not a wildcard
    { companyId: 'nie-uuid', nip: '5260250995', reason: 'KRS sprawdzony 2026-11-03' },
    { companyId: company, nip: '52602509', reason: 'KRS sprawdzony 2026-11-03' },
    { companyId: company, nip: '5260250995', reason: 'krotko' },
    { companyId: company, nip: '5260250995', reason: 'x'.repeat(301) },
  ]) assert.equal(parseReleaseForm(form(values)), null);

  // And the panel actually puts it in the form, next to the NIP of that line.
  const page = await readFile(new URL('../app/operator/billing/page.tsx', import.meta.url), 'utf8');
  const release = page.slice(page.indexOf('action={releaseTrialNip}'));
  const fields = release.slice(0, release.indexOf('</form>'));
  assert.match(fields, /name="nip" value=\{row\.nip\}/);
  assert.match(fields, /name="companyId" value=\{row\.company_id\}/,
    'the release form must send the company the line is about');

  // The occupied-NIP listing is capped at 200 rows and carries the only release
  // form in the panel, so it must take the search box (bot review finding
  // 4460505084, 2026-11-03). Without it an older occupied NIP has no release
  // form anywhere and the real company keeps being refused its FREE.
  assert.match(page, /sc19_operator_taken_trial_nips',\s*\{\s*search: search \|\| null\s*\}/,
    'the occupied-NIP listing must be filtered by the same search box');
});

test('database errors map to known panel notices', () => {
  assert.equal(sc19OperatorError({ code: '22023', message: 'sc19_invalid_nip' }), 'invalid_nip');
  assert.equal(sc19OperatorError({ code: '23505', message: 'sc19_reference_conflict' }), 'reference_conflict');
  assert.equal(sc19OperatorError({ code: '55000', message: 'sc19_missing_paid_policy' }), 'missing_policy');
  assert.equal(sc19OperatorError({ code: '23505', message: 'sc19_trial_nip_taken' }), 'conflict');
  assert.equal(sc19OperatorError({ code: '22023', message: 'sc19_invalid_proof' }), 'invalid');
  assert.equal(sc19OperatorError({ code: 'XX000', message: 'boom' }), 'failed');
  // A stale release gets its own notice, not the generic "Sprawdź dane
  // formularza": the operator did nothing wrong and the page, not the form, is
  // what needs refreshing.
  assert.equal(sc19OperatorError({ code: '22023', message: 'sc19_trial_nip_holder_changed' }), 'nip_holder_changed');
  assert.equal(sc19OperatorError({ code: '22023', message: 'sc19_release_company_required' }), 'nip_holder_changed');
  assert.match(sc19OperatorNotices.nip_holder_changed, /Odśwież stronę/);
  for (const value of ['invalid_nip', 'reference_conflict', 'missing_policy', 'conflict', 'invalid', 'failed',
    'nip_holder_changed']) assert.ok(sc19OperatorNotices[value]);
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
