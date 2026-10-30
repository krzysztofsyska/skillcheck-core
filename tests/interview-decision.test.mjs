import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { humanDecisions, parseHumanDecision, parseInterviewNote, parseStageDirection } from '../lib/interview-decision.ts';

test('human decision requires deliberate choice and substantial reason', () => {
  assert.deepEqual(humanDecisions.map(([value]) => value), ['next_stage', 'on_hold', 'closed']);
  for (const decision of [null, undefined, '', 'hired', 'rejected', 'ai_recommended', 'next']) {
    assert.throws(() => parseHumanDecision(decision, 'Konkretne uzasadnienie'));
  }
  for (const reason of [null, '', ' ', 'za krótko', 'x'.repeat(5001)]) {
    assert.throws(() => parseHumanDecision('next_stage', reason), /Uzasadnienie|Wpisz/);
  }
  assert.deepEqual(parseHumanDecision('on_hold', '  Czekamy na wyniki rozmowy.  '),
    { decision: 'on_hold', reason: 'Czekamy na wyniki rozmowy.' });
});

test('note and stage ordering validation', () => {
  assert.equal(parseInterviewNote('  Przykład z rozmowy  '), 'Przykład z rozmowy');
  assert.equal(parseInterviewNote('   '), null);
  for (const note of [null, new File(['x'], 'file.txt'), 'x'.repeat(10001)])
    assert.throws(() => parseInterviewNote(note));
  for (const direction of [0, 2, -2, null, '1']) assert.throws(() => parseStageDirection(direction));
  assert.equal(parseStageDirection(-1), -1);
  assert.equal(parseStageDirection(1), 1);
});

test('no automatic decision setter or default in schema and app routing', async () => {
  const schema = await readFile(new URL('../supabase/migrations/20261030160000_sc_step4_interview_decision.sql', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/interview-actions.ts', import.meta.url), 'utf8');
  const forms = await readFile(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/assessment-forms.tsx', import.meta.url), 'utf8');
  assert.match(schema, /add column human_decision text check/);
  assert.doesNotMatch(schema, /human_decision[^\n]*default/i);
  assert.match(actions, /parseHumanDecision\(form\.get\('decision'\), form\.get\('reason'\)\)/);
  assert.match(forms, /<select name="decision" required defaultValue="">/);
  assert.match(forms, /<option value="" disabled>Wybierz decyzję<\/option>/);
  assert.doesNotMatch(actions, /\bmodel\.generate\(/i);
});
