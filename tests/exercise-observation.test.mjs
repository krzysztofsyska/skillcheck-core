import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExerciseObservations } from '../lib/exercise-observation.ts';
const rubric = {kind:'competency_test',title:'TEST',instructions:'Zadanie fikcyjne',expectedOutput:'Rezultat',durationMinutes:20,
  criteria:[{competency:'Planowanie',below:'Pomija termin',meets:'Uwzględnia termin',above:'Dodatkowo analizuje zależności'},
    {competency:'Komunikacja',below:'Pomija informację',meets:'Podaje informację',above:'Dodatkowo potwierdza zrozumienie'}]};
const input = () => { const form = new FormData(); form.set('workSample',' Praca testowa ');
  form.append('rating','meets'); form.append('evidence',' Uwzględniono termin w zadaniu. ');
  form.append('rating','insufficient_data'); form.append('evidence',''); return form; };

test('each observation retains its rubric index; missing evidence is not a negative score',()=>{
  const form=input(); form.set('company_id','other'); form.set('author_id','other'); form.set('decision','hired');
  const result=parseExerciseObservations(rubric,form);
  assert.deepEqual(result,{workSample:'Praca testowa',observations:[{criterionIndex:0,rating:'meets',evidence:'Uwzględniono termin w zadaniu.'},{criterionIndex:1,rating:'insufficient_data',evidence:''}]});
});
test('missing or extra criterion controls and ungrounded ratings are rejected',()=>{
  for(const field of ['rating','evidence']) {
    const missing=input(); missing.delete(field); assert.throws(()=>parseExerciseObservations(rubric,missing));
    const extra=input(); extra.append(field,'extra'); assert.throws(()=>parseExerciseObservations(rubric,extra));
  }
  for(const rating of ['below','meets','above','hired','10/10']) {
    const form=input(); form.delete('rating'); form.append('rating',rating); form.append('rating',rating);
    assert.throws(()=>parseExerciseObservations(rubric,form));
  }
  const file=input(); file.delete('evidence'); file.append('evidence',new File(['x'],'x.txt')); file.append('evidence','');
  assert.throws(()=>parseExerciseObservations(rubric,file));
});
test('work sample has one bounded text value and the supplied rubric must be valid',()=>{
  for(const value of [new File(['x'],'x.txt'),'x'.repeat(20001)]) { const form=input(); form.set('workSample',value); assert.throws(()=>parseExerciseObservations(rubric,form)); }
  const missing=input(); missing.delete('workSample'); assert.throws(()=>parseExerciseObservations(rubric,missing));
  const duplicate=input(); duplicate.append('workSample','another'); assert.throws(()=>parseExerciseObservations(rubric,duplicate));
  const limit=input(); limit.set('workSample','x'.repeat(20000)); assert.equal(parseExerciseObservations(rubric,limit).workSample.length,20000);
  assert.throws(()=>parseExerciseObservations({...rubric,criteria:[]},input()));
});
