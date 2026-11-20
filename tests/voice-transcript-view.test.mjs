// R6 #542: page guard and result parsing of the Preview-only voice transcript page.
// Offline: no database, no network, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseVoiceTranscriptRows, voiceTranscriptErrorState, voiceTranscriptPageAllowed, voiceTranscriptStateLabels,
} from '../lib/voice/transcript-view.ts';

const route = {
  companyId: '00000000-0000-4000-8000-000000000001',
  recruitmentId: '00000000-0000-4000-8000-000000000002',
  applicationId: '00000000-0000-4000-8000-000000000003',
};
const preview = { VOICE_PLAN_PREVIEW: 'true', VERCEL_ENV: 'preview' };

test('page guard: 404 unless the preview flag is on, never in Production', () => {
  assert.equal(voiceTranscriptPageAllowed({ route, env: preview }), true);
  assert.equal(voiceTranscriptPageAllowed({ route, env: { VOICE_PLAN_PREVIEW: 'true', NODE_ENV: 'development' } }), true);
  for (const env of [
    {}, { VERCEL_ENV: 'preview' }, { VOICE_PLAN_PREVIEW: 'false', VERCEL_ENV: 'preview' },
    { VOICE_PLAN_PREVIEW: 'true', VERCEL_ENV: 'production' }, { VOICE_PLAN_PREVIEW: 'true', NODE_ENV: 'production' },
    { VOICE_PLAN_PREVIEW: 'true' },
  ]) assert.equal(voiceTranscriptPageAllowed({ route, env }), false, JSON.stringify(env));
  // The flag also closes the page for an owner or recruiter.
  assert.equal(voiceTranscriptPageAllowed({ route, canEdit: true, env: { VOICE_PLAN_PREVIEW: 'true', VERCEL_ENV: 'production' } }), false);
});

test('page guard: 404 for a viewer (not canEdit) and for a malformed route', () => {
  assert.equal(voiceTranscriptPageAllowed({ route, canEdit: true, env: preview }), true);
  assert.equal(voiceTranscriptPageAllowed({ route, canEdit: false, env: preview }), false);
  for (const bad of [
    { ...route, applicationId: 'not-a-uuid' }, { ...route, companyId: '' }, { companyId: route.companyId, recruitmentId: route.recruitmentId },
    { ...route, extra: route.companyId }, { ...route, recruitmentId: null },
  ]) assert.equal(voiceTranscriptPageAllowed({ route: bad, canEdit: true, env: preview }), false, JSON.stringify(bad));
});

test('page source: guard runs before company access and again with canEdit; no logging of the transcript', () => {
  const page = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/interview-transcript/page.tsx', import.meta.url), 'utf8');
  const first = page.indexOf('voiceTranscriptPageAllowed({ route })');
  const access = page.indexOf('companyAccess(companyId)');
  const second = page.indexOf('voiceTranscriptPageAllowed({ route, canEdit })');
  const rpc = page.indexOf("rpc('read_voice_interview_transcripts'");
  assert.ok(first > 0 && first < access && access < second && second < rpc, 'flag before DB access, canEdit before the read');
  assert.doesNotMatch(page, /console\.|\.from\(/, 'no logging and no direct table read');
});

test('RPC errors: forbidden or foreign record is a 404; withdrawn and other errors are states', () => {
  assert.equal(voiceTranscriptErrorState({ code: '42501' }), 'not_found');
  assert.equal(voiceTranscriptErrorState({ code: '55000' }), 'withdrawn');
  assert.equal(voiceTranscriptErrorState({ code: 'PGRST202' }), 'unavailable', 'function not yet migrated');
  assert.equal(voiceTranscriptErrorState(null), 'unavailable');
});

test('rows: only {speaker,text} survive; erased and pending calls carry no text; bad shapes fail closed', () => {
  const rows = [
    { call_no: 1, call_at: '2026-11-19T10:00:00+00:00', transcript_state: 'available',
      utterances: [{ speaker: 'agent', text: 'Pytanie.', extra: 'x' }, { speaker: 'candidate', text: 'Odpowiedź.' }], leaked: 'y' },
    { call_no: 2, call_at: '2026-11-19T11:00:00+00:00', transcript_state: 'erased_retention', utterances: null },
    { call_no: 3, call_at: '2026-11-19T12:00:00+00:00', transcript_state: 'not_received', utterances: null },
  ];
  assert.deepEqual(parseVoiceTranscriptRows(rows), [
    { callNo: 1, callAt: rows[0].call_at, state: 'available', lines: [{ speaker: 'agent', text: 'Pytanie.' }, { speaker: 'candidate', text: 'Odpowiedź.' }] },
    { callNo: 2, callAt: rows[1].call_at, state: 'erased_retention', lines: [] },
    { callNo: 3, callAt: rows[2].call_at, state: 'not_received', lines: [] },
  ]);
  assert.deepEqual(parseVoiceTranscriptRows([]), []);
  assert.match(voiceTranscriptStateLabels.erased_retention, /usunięte zgodnie z retencją/);
  for (const bad of [
    null, {}, [null],
    [{ ...rows[0], call_no: 0 }], [{ ...rows[0], call_at: 'x' }], [{ ...rows[0], transcript_state: 'deleted' }],
    [{ ...rows[0], utterances: [] }], [{ ...rows[0], utterances: [{ speaker: 'operator', text: 'x' }] }],
    [{ ...rows[0], utterances: [{ speaker: 'agent', text: 1 }] }],
    [{ ...rows[1], utterances: [{ speaker: 'agent', text: 'should be gone' }] }],
  ]) assert.equal(parseVoiceTranscriptRows(bad), null, JSON.stringify(bad));
});
