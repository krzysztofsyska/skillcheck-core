import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExerciseDefinition } from '../lib/exercise-definition.ts';
const valid = () => ({kind: 'competency_test', title: ' Zadanie testowe ', instructions: 'Uporządkuj fikcyjne zgłoszenia.', expectedOutput: 'Lista z uzasadnieniem.', durationMinutes: 20, criteria: [{competency: 'Priorytetyzacja', below: 'Pomija pilne zgłoszenie.', meets: 'Uwzględnia termin i wpływ.', above: 'Dodatkowo wskazuje zależności.'}]});

test('exercise requires a concrete task and distinct observable anchors', () => {
  for (const kind of ['competency_test', 'assessment_center']) {
    const source = {...valid(), kind, company_id: 'untrusted', score: 100};
    const parsed = parseExerciseDefinition(source);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.title, 'Zadanie testowe');
    assert.equal(parsed.criteria.length, 1);
    assert.equal('company_id' in parsed, false);
    assert.equal('score' in parsed, false);
    assert.equal(source.title, ' Zadanie testowe ');
  }
});

test('malformed input and unbounded tasks are rejected before persistence', () => {
  for (const value of [null, [], 'text', true, 1]) assert.throws(() => parseExerciseDefinition(value));
  for (const kind of ['voicebot', 'hired', '', null]) assert.throws(() => parseExerciseDefinition({...valid(), kind}));
  for (const durationMinutes of [0, -1, 181, 1.5, '20', NaN, Infinity]) assert.throws(() => parseExerciseDefinition({...valid(), durationMinutes}));
  for (const [field, max] of [['title', 200], ['instructions', 10000], ['expectedOutput', 4000]]) {
    for (const value of ['', ' \t\n\u00a0', null, {}, 'x'.repeat(max + 1)]) assert.throws(() => parseExerciseDefinition({...valid(), [field]: value}));
    assert.equal(parseExerciseDefinition({...valid(), [field]: 'x'.repeat(max)})[field].length, max);
  }
  for (const criteria of [null, {}, [], Array(13).fill(valid().criteria[0]), [null]]) assert.throws(() => parseExerciseDefinition({...valid(), criteria}));
});

test('duplicate competencies and indistinguishable anchors cannot form a rubric', () => {
  for (const competency of [' PRIORYTETYZACJA ', 'Ｐｒｉｏｒｙｔｅｔｙｚａｃｊａ']) {
    const source = valid(); source.criteria.push({...source.criteria[0], competency});
    assert.throws(() => parseExerciseDefinition(source));
  }
  const spaced = valid(); spaced.criteria = [{...spaced.criteria[0], competency: 'Planowanie pracy'}, {...spaced.criteria[0], competency: 'PLANOWANIE\t pracy'}];
  assert.throws(() => parseExerciseDefinition(spaced));
  for (const field of ['below', 'meets', 'above']) {
    for (const value of ['', ' \u2009 ', 'x'.repeat(2001), null]) {
      const source = valid(); source.criteria[0][field] = value;
      assert.throws(() => parseExerciseDefinition(source));
    }
  }
  const same = valid(); same.criteria[0].above = same.criteria[0].meets.toUpperCase();
  assert.throws(() => parseExerciseDefinition(same));
});
