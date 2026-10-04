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

// Native form fields must preserve each criterion's row and reject ambiguous payloads.
const nativeForm = () => {
  const input = valid(); const form = new FormData();
  for (const field of ['kind', 'title', 'instructions', 'expectedOutput', 'durationMinutes']) form.set(field, String(input[field]));
  for (const criterion of input.criteria) for (const [key, value] of Object.entries(criterion)) form.append(key, value);
  return form;
};
test('native exercise form preserves criterion rows and excludes untrusted metadata', async () => {
  const { parseExerciseFormData } = await import('../lib/exercise-definition.ts');
  const form = nativeForm();
  for (const [key, value] of Object.entries({competency:'Komunikacja', below:'Pomija informacje.', meets:'Przekazuje informacje.', above:'Dodatkowo sprawdza zrozumienie.'})) form.append(key,value);
  form.set('company_id','other'); form.set('author_id','other'); form.set('version','999');
  const parsed = parseExerciseFormData(form);
  assert.equal(parsed.criteria.length,2); assert.equal(parsed.criteria[1].competency,'Komunikacja');
  assert.equal(parsed.criteria[1].meets,'Przekazuje informacje.');
  assert.equal('company_id' in parsed,false); assert.equal('author_id' in parsed,false); assert.equal('version' in parsed,false);
});
test('native exercise form rejects duplicate scalars, files, missing rows and coercion tricks', async () => {
  const { parseExerciseFormData } = await import('../lib/exercise-definition.ts');
  for (const field of ['kind','title','instructions','expectedOutput','durationMinutes']) {
    const duplicate=nativeForm(); duplicate.append(field,'second'); assert.throws(()=>parseExerciseFormData(duplicate));
    const missing=nativeForm(); missing.delete(field); assert.throws(()=>parseExerciseFormData(missing));
    const file=nativeForm(); file.set(field,new File(['x'],'x.txt')); assert.throws(()=>parseExerciseFormData(file));
  }
  for(const value of ['20.0','2e1','0x14','+20','020',' 20','20 ','181','0','-1']) {
    const form=nativeForm(); form.set('durationMinutes',value); assert.throws(()=>parseExerciseFormData(form));
  }
  for(const field of ['competency','below','meets','above']) {
    const missing=nativeForm(); missing.delete(field); assert.throws(()=>parseExerciseFormData(missing));
    const extra=nativeForm(); extra.append(field,'extra'); assert.throws(()=>parseExerciseFormData(extra));
    const file=nativeForm(); file.set(field,new File(['x'],'x.txt')); assert.throws(()=>parseExerciseFormData(file));
  }
});
import { validExerciseEditorContext, exerciseSaveError } from '../lib/exercise-editor.ts';

test('exercise editor accepts only bounded versions, UUIDs and a parseable position timestamp', () => {
  const context = { recruitmentId:'10000000-0000-0000-0000-000000000001', exerciseId:'20000000-0000-0000-0000-000000000001', positionId:'30000000-0000-0000-0000-000000000001', expectedVersion:0, positionUpdatedAt:'2026-10-02T18:00:00.123456Z' };
  assert.equal(validExerciseEditorContext(context), true);
  for(const field of ['recruitmentId','exerciseId','positionId']) for(const value of [null, {}, '', '../other', 'x'.repeat(36)]) assert.equal(validExerciseEditorContext({...context,[field]:value}),false);
  for(const expectedVersion of [-1, 1.5, '0', NaN, Infinity, 2147483647]) assert.equal(validExerciseEditorContext({...context,expectedVersion}),false);
  for(const positionUpdatedAt of [null,{},'', 'not-a-date']) assert.equal(validExerciseEditorContext({...context,positionUpdatedAt}),false);
});
test('exercise errors distinguish conflict, permissions, missing schema and ambiguous save outcome', () => {
  assert.match(exerciseSaveError('PT409'),/Skopiuj/);
  assert.match(exerciseSaveError('42501'),/uprawnień/);
  assert.match(exerciseSaveError('55000'),/nie pozwalają/);
  assert.match(exerciseSaveError('22023'),/kryteriów/);
  for(const code of ['42P01','42883','PGRST202','PGRST205']) assert.match(exerciseSaveError(code),/jeszcze dostępne/);
  for(const code of [undefined,'08006','PGRST301']) assert.match(exerciseSaveError(code),/zapis mógł się zakończyć/);
});
