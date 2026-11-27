import test from 'node:test';
import assert from 'node:assert/strict';
import { assessmentCenterPairAssignError, parseAssessmentCenterPair, parseAssessmentCenterSheetForm } from '../lib/assessment-center-pair.ts';
import { AC_PAIR_PACKAGE_MISSING_TEXT } from '../lib/assessment-center-session.ts';
const definition = {kind:'assessment_center',title:'Rozmowa',instructions:'Pomóż klientowi',expectedOutput:'Rozwiązanie',durationMinutes:20,
  criteria:[{competency:'Komunikacja',below:'Przerywa',meets:'Słucha',above:'Podsumowuje'}]};
const observation = {criterionIndex:0,rating:'meets',evidence:'Zadał pytanie otwarte.',context:'Rozmowa z klientem.'};
const report = () => ({state:'ready',definitionId:'revision',sheets:[
  {authorId:'one',submittedAt:'2026-11-06T11:00:00Z',observations:[observation]},
  {authorId:'two',submittedAt:'2026-11-06T12:00:00Z',observations:[{...observation,rating:'insufficient_data',evidence:'',context:''}]},
]});
test('paired report binds the exact revision and two attributable evidence sets, without a score', () => {
  const parsed = parseAssessmentCenterPair('revision', definition, report());
  assert.equal(parsed.state,'ready');
  assert.equal(parsed.sheets[0].evaluation.criteria[0].context,observation.context);
  assert.equal(parsed.sheets[1].evaluation.status,'incomplete_evidence');
  assert.equal('score' in parsed,false);
  for(const ownSubmitted of [true,false,null])assert.deepEqual(parseAssessmentCenterPair('revision', definition, {state:'pending',ownSubmitted}), {state:'pending',ownSubmitted});
});
test('malformed response, revision mismatch, duplicate authors and unsubstantiated evidence fail closed', () => {
  const wrongAuthor=report();wrongAuthor.sheets[1].authorId='one';
  const wrongTime=report();delete wrongTime.sheets[0].submittedAt;
  const wrongEvidence=report();wrongEvidence.sheets[0].observations=[{...observation,evidence:''}];
  for(const value of [null,{}, {state:'pending'}, {...report(),definitionId:'other'}, {...report(),sheets:[report().sheets[0]]},
    {...report(),sheets:Array(2)},wrongAuthor,wrongTime,wrongEvidence])assert.throws(()=>parseAssessmentCenterPair('revision', definition,value));
});
test('form parser keeps criterion order, trims evidence and rejects missing, duplicate or file fields', () => {
  const form = new FormData();
  form.append('rating','meets');form.append('evidence','  '+observation.evidence+'  ');form.append('context',observation.context);
  assert.deepEqual(parseAssessmentCenterSheetForm(definition,form),[observation]);
  form.append('rating','above');assert.throws(()=>parseAssessmentCenterSheetForm(definition,form));
  form.delete('rating');form.append('rating','meets');form.set('context',new Blob(['hidden']),'hidden.txt');
  assert.throws(()=>parseAssessmentCenterSheetForm(definition,form));
  form.delete('context');assert.throws(()=>parseAssessmentCenterSheetForm(definition,form));
});
test('pair assignment maps PT402 to the package text, PT409 to the conflict text and everything else to the generic text', () => {
  assert.equal(assessmentCenterPairAssignError('PT402'), AC_PAIR_PACKAGE_MISSING_TEXT);
  assert.match(AC_PAIR_PACKAGE_MISSING_TEXT, /^Przypisanie asesorów/);
  assert.equal(assessmentCenterPairAssignError('PT409'), 'Asesorzy zostali już przypisani. Odśwież stronę.');
  assert.equal(assessmentCenterPairAssignError('42501'), 'Nie przypisano asesorów. Sprawdź skład zespołu i stan rekrutacji.');
  assert.equal(assessmentCenterPairAssignError(undefined), 'Nie przypisano asesorów. Sprawdź skład zespołu i stan rekrutacji.');
});
