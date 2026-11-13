import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExerciseDefinition } from '../lib/exercise-definition.ts';
import { hrbpCaseTemplate } from '../lib/assessment-center-session-template.ts';
import {
  AC_FINALIST_LIMIT, AC_RECOMMENDED_FINALISTS, buildAssessmentCenterSessionReport, competencyKey, finalistAdvice,
  parseAssessmentCenterSession, parseReconciliationForm, planCoverage,
} from '../lib/assessment-center-session.ts';
import { ids, sessionPayload } from './helpers/ac-session-payload.mjs';

// SC-AC-SESSION (#276): pure contract of the session report. Synthetic data only.
const report = payload => buildAssessmentCenterSessionReport(parseAssessmentCenterSession(payload));
const forbiddenKeys = /"(score|rank|ranking|recommendation|hiringDecision|decision|total|average|verdict)"/i;

test('synthetic HRBP template: valid rubrics, three case-study stages + a human simulation, complete coverage', () => {
  assert.deepEqual(hrbpCaseTemplate.stages.map(stage => stage.type), ['case_study', 'case_study', 'case_study', 'human_simulation']);
  for (const stage of hrbpCaseTemplate.stages) {
    assert.deepEqual(parseExerciseDefinition(stage.definition), stage.definition, stage.title);
    assert.equal(stage.definition.kind, 'assessment_center');
    assert.equal(stage.type === 'human_simulation', stage.counterpartBrief !== null);
    assert.match(`${stage.definition.instructions} ${stage.counterpartBrief ?? ''}`, /syntetyczn|scenariusz/i);
  }
  // Causes → financial consequences → change, as the issue asks.
  assert.match(hrbpCaseTemplate.stages[0].title, /diagnoza przyczyn/);
  assert.match(hrbpCaseTemplate.stages[1].title, /konsekwencje finansowe/);
  assert.match(hrbpCaseTemplate.stages[2].title, /plan zmiany/);
  const coverage = planCoverage(hrbpCaseTemplate.plannedCompetencies, hrbpCaseTemplate.stages);
  assert.deepEqual(coverage.uncovered, []);
  assert.deepEqual(coverage.rows.find(row => row.competency === 'Myślenie finansowe').coveredBy.length, 2);
});

test('coverage plan: an uncovered competency is named; keys are exact after NFKC and whitespace normalization', () => {
  const stages = hrbpCaseTemplate.stages.slice(0, 2);
  const coverage = planCoverage([...hrbpCaseTemplate.plannedCompetencies, '  Odporność   na stres '], stages);
  assert.deepEqual(coverage.uncovered, ['Planowanie zmiany', 'Komunikacja z biznesem', 'Odporność na stres']);
  assert.equal(competencyKey(' Diagnoza  przyczyn\n'), 'Diagnoza przyczyn');
  assert.notEqual(competencyKey('diagnoza przyczyn'), competencyKey('Diagnoza przyczyn'), 'no silent case folding');
});

test('finalists: five to six is advice, ten is the limit', () => {
  assert.deepEqual(AC_RECOMMENDED_FINALISTS, [5, 6]); assert.equal(AC_FINALIST_LIMIT, 10);
  assert.deepEqual([0, 4, 5, 6, 7, 9, 10].map(count => finalistAdvice(count).level), ['below', 'below', 'recommended', 'recommended', 'above', 'above', 'limit']);
  for (const count of [-1, 1.5, NaN]) assert.throws(() => finalistAdvice(count));
});

test('report: both assessors per competency, agreed versus discrepant, first versus revised, explicit gaps, no ranking', () => {
  const result = report(sessionPayload());
  assert.equal(result.finalists.length, 2); assert.deepEqual(result.uncovered, []);
  const [one, two] = result.finalists;
  const diagnosis = one.competencies.find(item => item.competency === 'Diagnoza przyczyn');
  assert.deepEqual(diagnosis.evidence[0].assessors.map(item => [item.authorId, item.rating]), [[ids.owner, 'above'], [ids.recruiter, 'meets']]);
  assert.deepEqual(diagnosis.evidence[0].agreement, { status: 'agreed', rating: 'meets', justification: 'UzasadnienieUzgodnienia po rozmowie asesorów.', recordedBy: ids.recruiter });
  const change = one.competencies.find(item => item.competency === 'Planowanie zmiany');
  assert.deepEqual(change.evidence.map(row => row.agreement.status), ['discrepancy', 'not_assessed']);
  assert.deepEqual(change.evidence[0].assessors.map(item => item.rating), ['below', 'above'], 'both ratings kept, nothing averaged');
  assert.equal(change.evidence[0].agreement.awaitingConfirmation, true);
  const finance = one.competencies.find(item => item.competency === 'Myślenie finansowe');
  assert.deepEqual(finance.evidence.map(row => row.agreement.status), ['awaiting_second_sheet', 'awaiting_confirmation']);
  assert.deepEqual(finance.evidence[1].assessors.map(item => item.hasEvidence), [true, false], 'insufficient_data is a gap, not a rating');
  const talk = one.competencies.find(item => item.competency === 'Komunikacja z biznesem');
  assert.equal(talk.hasEvidence, false); assert.deepEqual(talk.evidence[0].assessors, []);
  assert.match(one.attempts[0].firstAttempt.work, /^PierwszaProba/); assert.match(one.attempts[0].revisedAttempt.work, /^PoprawionaPraca/);
  assert.equal(one.attempts[0].changeProof.assessment, 'change_confirmed'); assert.equal(one.attempts[1].firstAttempt, null);
  assert.ok(two.competencies.every(item => !item.hasEvidence)); assert.deepEqual(two.expertNotes, []);
  assert.doesNotMatch(JSON.stringify(result), forbiddenKeys);
  // Order is the order of adding, whatever the evidence says.
  assert.deepEqual(result.finalists.map(finalist => finalist.slot), [1, 2]);
});

test('all append-only expert notes remain readable after the 200th note', () => {
  const payload = sessionPayload();
  const example = payload.finalists[0].expertNotes[0];
  payload.finalists[0].expertNotes = Array.from({ length: 201 }, (_, index) =>
    ({ ...example, note: `Konsultacja nr ${index + 1}` }));
  const parsed = parseAssessmentCenterSession(payload);
  assert.equal(parsed.finalists[0].expertNotes.length, 201);
  const result = buildAssessmentCenterSessionReport(parsed);
  assert.equal(result.finalists[0].expertNotes.length, 201);
  assert.equal(result.finalists[0].expertNotes[200].note, 'Konsultacja nr 201');
});

test('a disputed reconciliation is never shown as an agreement', () => {
  const payload = sessionPayload();
  Object.assign(payload.finalists[0].stages[0].pair.reconciliation, { confirmation: 'disputed', disputeNote: 'Nie zgadzam się z zapisem uzgodnienia.' });
  const evidence = report(payload).finalists[0].competencies[0].evidence[0];
  assert.deepEqual(evidence.agreement, { status: 'disputed', disputeNote: 'Nie zgadzam się z zapisem uzgodnienia.', recordedBy: ids.recruiter, disputedBy: ids.owner });
  assert.deepEqual(evidence.assessors.map(item => item.rating), ['above', 'meets']);
});

test('malformed payloads fail closed instead of rendering a partial report', () => {
  const broken = [
    payload => { payload.session.status = 'archived'; },
    payload => { payload.stages[1].ordinal = 5; },
    payload => { payload.stages[0].definition = { ...payload.stages[0].definition, kind: 'competency_test' }; },
    payload => { payload.stages[3].counterpartBrief = null; },
    payload => { payload.finalists[0].stages.pop(); },
    payload => { payload.finalists[0].stages[0].stageId = ids.stage(1); },
    payload => { payload.finalists[1].applicationId = ids.applicationA; },
    payload => { payload.finalists[0].slot = 11; },
    payload => { payload.finalists[0].stages[0].pair.definitionId = ids.definition(1); },
    payload => { payload.finalists[0].stages[0].pair.sheets[1].authorId = ids.owner; },
    payload => { payload.finalists[0].stages[0].pair.sheets[0].observations[0].evidence = ''; },
    // An "agreed" rating that neither assessor gave (a mean of below and above) is rejected.
    payload => { payload.finalists[0].stages[2].pair.reconciliation.items[0] = { criterionIndex: 0, outcome: 'agreed', rating: 'meets', justification: 'Średnia z dwóch ocen.', firstRating: 'below', secondRating: 'above' }; },
    payload => { payload.finalists[0].stages[0].pair.reconciliation.items[0].firstRating = 'meets'; },
    payload => { payload.finalists[0].stages[0].pair.reconciliation.recordedBy = ids.applicationA; },
    payload => { payload.finalists[0].stages[0].pair.reconciliation.confirmedBy = ids.recruiter; },
    payload => { payload.finalists[0].stages[0].entries.push({ ...payload.finalists[0].stages[0].entries[0] }); },
    payload => { payload.finalists[0].stages[0].entries[3].body.assessment = 'hire'; },
    payload => { payload.finalists[0].stages[0].entries[0].body.extra = 'pole'; },
    payload => { payload.finalists[0].stages[1].pair = { state: 'ready' }; },
    payload => { payload.finalists[0].expertNotes[0].createdAt = 'kiedyś'; },
    // "Text withheld" together with text is a contradiction, never rendered.
    payload => { payload.finalists[0].textHidden = true; },
    payload => { delete payload.finalists[1].textHidden; },
  ];
  for (const [index, mutate] of broken.entries()) {
    const payload = sessionPayload(); mutate(payload);
    assert.throws(() => parseAssessmentCenterSession(payload), `case ${index}`);
  }
  for (const value of [null, [], {}, { session: {} }]) assert.throws(() => parseAssessmentCenterSession(value));
  assert.doesNotThrow(() => parseAssessmentCenterSession(sessionPayload({ status: 'draft' })));
  const withheld = sessionPayload(); withheld.finalists[1].textHidden = true;
  assert.equal(report(withheld).finalists[1].textHidden, true);
  // Withheld text never includes the candidate's own work; assessor text with the flag is a contradiction.
  const entry = (kind, body) => ({ kind, body, authorId: ids.recruiter, createdAt: '2026-11-12T09:05:00+00:00' });
  withheld.finalists[1].stages[0].entries = [entry('first_attempt', { work: 'PracaKandydata: pierwsza próba widoczna dla asesora.' })];
  assert.match(report(withheld).finalists[1].attempts[0].firstAttempt.work, /^PracaKandydata/);
  withheld.finalists[1].stages[0].entries.push(entry('feedback', { feedback: 'Informacja zwrotna innego asesora.' }));
  assert.throws(() => parseAssessmentCenterSession(withheld));
});

test('reconciliation form: one decision per criterion, justified; no free rating outside the form contract', () => {
  const form = new FormData();
  for (const [outcome, rating, note] of [['discrepancy', 'below', 'Pozostajemy przy różnych ocenach.'], ['agreed', 'meets', '  Uzgodniono po rozmowie.  ']]) {
    form.append('outcome', outcome); form.append('rating', rating); form.append('note', note);
  }
  assert.deepEqual(parseReconciliationForm(2, form), [
    { criterionIndex: 0, outcome: 'discrepancy', note: 'Pozostajemy przy różnych ocenach.' },
    { criterionIndex: 1, outcome: 'agreed', rating: 'meets', justification: 'Uzgodniono po rozmowie.' }]);
  assert.throws(() => parseReconciliationForm(3, form));
  form.set('note', 'krótko'); assert.throws(() => parseReconciliationForm(2, form));
  const bad = new FormData(); bad.append('outcome', 'average'); bad.append('rating', 'meets'); bad.append('note', 'Wystarczająco długie uzasadnienie.');
  assert.throws(() => parseReconciliationForm(1, bad));
  bad.set('outcome', 'agreed'); bad.set('rating', 'excellent'); assert.throws(() => parseReconciliationForm(1, bad));
});
