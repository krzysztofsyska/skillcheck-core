// R6-2: the recruiter's voice interview order check (Preview only): flag guard,
// result parsing, Polish messages and the page/action wiring.
// Offline: no database, no network, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadVoiceOrderCheck, parseVoiceOrderCheck, voiceOrderAllowed, voiceOrderMessages, voicePoolLabel,
  VOICE_POOL_EMPTY_MESSAGE,
} from '../lib/voice/order-check.ts';
import { VOICE_COST_CAP_RECRUITER_MESSAGE } from '../lib/voice/cost-cap.ts';

const route = {
  companyId: '00000000-0000-4000-8000-000000000001',
  recruitmentId: '00000000-0000-4000-8000-000000000002',
  applicationId: '00000000-0000-4000-8000-000000000003',
};
const preview = { VOICE_PLAN_PREVIEW: 'true', VERCEL_ENV: 'preview' };
const dir = '../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/interview/';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('guard: off unless the preview flag is on, never in Production, never for a viewer', () => {
  assert.equal(voiceOrderAllowed({ route, env: preview }), true);
  assert.equal(voiceOrderAllowed({ route, canEdit: true, env: preview }), true);
  assert.equal(voiceOrderAllowed({ route, canEdit: false, env: preview }), false);
  for (const env of [{}, { VERCEL_ENV: 'preview' }, { VOICE_PLAN_PREVIEW: 'true', VERCEL_ENV: 'production' },
    { VOICE_PLAN_PREVIEW: 'true', NODE_ENV: 'production' }, { VOICE_PLAN_PREVIEW: 'true' }])
    assert.equal(voiceOrderAllowed({ route, canEdit: true, env }), false, JSON.stringify(env));
  for (const bad of [{ ...route, applicationId: 'x' }, { ...route, companyId: null }, { companyId: route.companyId }])
    assert.equal(voiceOrderAllowed({ route: bad, canEdit: true, env: preview }), false, JSON.stringify(bad));
});

test('parse: pool first, then the cost cap; bad shapes and errors fail closed', () => {
  assert.deepEqual(parseVoiceOrderCheck([{ available: 3, cost_cap_blocked: false }], null), { state: 'ready', available: 3 });
  assert.deepEqual(parseVoiceOrderCheck([{ available: 0, cost_cap_blocked: false }], null), { state: 'pool_empty', available: 0 });
  assert.deepEqual(parseVoiceOrderCheck([{ available: 0, cost_cap_blocked: true }], null), { state: 'pool_empty', available: 0 });
  assert.deepEqual(parseVoiceOrderCheck([{ available: 2, cost_cap_blocked: true }], null), { state: 'cost_cap', available: 2 });
  assert.deepEqual(parseVoiceOrderCheck(null, { code: '42501' }), { state: 'forbidden' });
  assert.deepEqual(parseVoiceOrderCheck(null, { code: '55000' }), { state: 'withdrawn' });
  assert.deepEqual(parseVoiceOrderCheck(null, { code: 'PGRST202' }), { state: 'unavailable' }, 'function not migrated yet');
  for (const data of [null, [], [{}], [{ available: -1, cost_cap_blocked: false }], [{ available: 1.5, cost_cap_blocked: false }],
    [{ available: '1', cost_cap_blocked: false }], [{ available: 1, cost_cap_blocked: 'no' }],
    [{ available: 1, cost_cap_blocked: false }, { available: 1, cost_cap_blocked: false }]])
    assert.deepEqual(parseVoiceOrderCheck(data, null), { state: 'unavailable' }, JSON.stringify(data));
});

test('messages: plain Polish, nothing claims a call was ordered or sent', () => {
  assert.equal(voiceOrderMessages.pool_empty, VOICE_POOL_EMPTY_MESSAGE);
  assert.equal(voiceOrderMessages.cost_cap, VOICE_COST_CAP_RECRUITER_MESSAGE);
  assert.match(voiceOrderMessages.pool_empty, /Rozmowa nie została zlecona/);
  assert.match(voiceOrderMessages.cost_cap, /Rozmowa nie została zlecona/);
  assert.match(voiceOrderMessages.ready, /nic nie zostało zarezerwowane ani wysłane do kandydata/);
  assert.equal(voicePoolLabel({ state: 'ready', available: 7 }), 'Pozostałe rozmowy głosowe w puli firmy: 7.');
  assert.equal(voicePoolLabel({ state: 'pool_empty', available: 0 }), 'Pozostałe rozmowy głosowe w puli firmy: 0.');
  assert.equal(voicePoolLabel({ state: 'unavailable' }), null);
  for (const text of Object.values(voiceOrderMessages)) assert.doesNotMatch(text, /voicebot|zł|PLN|cena|cennik/i, text);
});

test('load: calls only voice_interview_order_check with the route ids; a thrown client fails closed', async () => {
  const calls = [];
  const client = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: [{ available: 1, cost_cap_blocked: false }], error: null }; } };
  assert.deepEqual(await loadVoiceOrderCheck(client, route), { state: 'ready', available: 1 });
  assert.deepEqual(calls, [['voice_interview_order_check',
    { target_company: route.companyId, target_recruitment: route.recruitmentId, target_application: route.applicationId }]]);
  assert.deepEqual(await loadVoiceOrderCheck({ rpc: async () => { throw new Error('down'); } }, route), { state: 'unavailable' });
});

test('wiring: page and action check the flag and canEdit before the database; no provider, no send', () => {
  const page = read(dir + 'page.tsx');
  const access = page.indexOf('companyAccess(companyId)');
  const guard = page.indexOf('voiceOrderAllowed({ route, canEdit })');
  const load = page.indexOf('loadVoiceOrderCheck(client, route)');
  assert.ok(access > 0 && access < guard && guard < load, 'flag + canEdit before the check');
  assert.match(page, /\{voiceOrder && <VoiceOrderPanel/, 'panel only when the guard passed');
  const action = read(dir + 'voice-order-actions.ts');
  assert.match(action, /^'use server';/);
  const first = action.indexOf('voiceOrderAllowed({ route })');
  const member = action.indexOf('companyAccess(companyId)');
  const second = action.indexOf('voiceOrderAllowed({ route, canEdit })');
  const call = action.indexOf('loadVoiceOrderCheck(client, route)');
  assert.ok(first > 0 && first < member && member < second && second < call, 'action re-checks flag and canEdit');
  const lib = read('../lib/voice/order-check.ts');
  const panel = read(dir + 'voice-order-panel.tsx');
  for (const [name, source] of [['action', action], ['lib', lib], ['panel', panel]]) {
    assert.doesNotMatch(source, /retell|offline-preparation|retell-dispatch|fetch\(|console\.|sendMail|sms/i, name);
    assert.doesNotMatch(source, /\.from\(/, `${name}: no direct table access`);
  }
});
