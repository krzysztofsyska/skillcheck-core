import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessmentCenterReport } from '../lib/assessment-center-report.ts';

const ids = {
  companyId:'11111111-1111-4111-8111-111111111111',
  recruitmentId:'22222222-2222-4222-8222-222222222222',
  applicationId:'33333333-3333-4333-8333-333333333333',
  definitionEntryId:'44444444-4444-4444-8444-444444444444',
};
const revision = () => ({ id:ids.definitionEntryId,company_id:ids.companyId,recruitment_id:ids.recruitmentId,version:3,
  definition:{ kind:'assessment_center',title:'Rozmowa z klientem',instructions:'Instrukcja',expectedOutput:'Odpowiedź',durationMinutes:20,
  criteria:[{competency:'Komunikacja',below:'Przerywa',meets:'Słucha',above:'Podsumowuje'},
    {competency:'Analiza',below:'Pomija problem',meets:'Bada problem',above:'Sprawdza przyczyny'}] },
});
const entry=()=>({company_id:ids.companyId,recruitment_id:ids.recruitmentId,application_id:ids.applicationId,
  definition_entry_id:ids.definitionEntryId,version:2,author_id:'55555555-5555-4555-8555-555555555555',
  observations:[{criterionIndex:0,rating:'meets',evidence:' Zadał otwarte pytanie. '},
    {criterionIndex:1,rating:'insufficient_data',evidence:''}],
});

test('AC read model keeps immutable revision, human note and missing evidence distinct',()=>{
  const r=buildAssessmentCenterReport(ids,revision(),entry());
  assert.equal(r.status,'incomplete_evidence');
  assert.equal(r.definitionVersion,3);
  assert.equal(r.reviewVersion,2);
  assert.equal(r.evidencedCriteria,1);
  assert.equal(r.criteria[0].source,'observer_note');
  assert.equal(r.criteria[0].observerNote,'Zadał otwarte pytanie.');
  assert.equal(r.criteria[0].context,null);
  assert.equal(r.criteria[1].source,'missing');
  assert.equal(r.criteria[1].observerNote,'');
  assert.equal('score' in r,false);
  assert.equal('hiringDecision' in r,false);
});
test('without observations no fabricated evidence, status or score',()=>{
  const r=buildAssessmentCenterReport(ids,revision(),null);
  assert.equal(r.status,'not_assessed');
  assert.equal(r.evidencedCriteria,0);
  assert.ok(r.criteria.every(x=>x.rating==='insufficient_data'&&x.source==='missing'));
});
test('fail closed on foreign company, recruitment, application and rubric revision',()=>{
  for(const key of ['companyId','recruitmentId','definitionEntryId']) {
    assert.throws(()=>buildAssessmentCenterReport({...ids,[key]:'other'},revision(),entry()));
  }
  const withApplication={...entry(),application_id:'other'};
  assert.throws(()=>buildAssessmentCenterReport(ids,revision(),withApplication));
  const withDefinition={...entry(),definition_entry_id:'other'};
  assert.throws(()=>buildAssessmentCenterReport(ids,revision(),withDefinition));
  const foreignCompany={...entry(),company_id:'other'};
  assert.throws(()=>buildAssessmentCenterReport(ids,revision(),foreignCompany));
  assert.throws(()=>buildAssessmentCenterReport(ids,{...revision(),definition:{...revision().definition,kind:'competency_test'}},entry()));
});
test('rejects malformed, out-of-order, forged or misleading evidence rows',()=>{
  const invalid=[
    {...entry(),observations:[entry().observations[0]]},
    {...entry(),observations:Object.assign(Array(2), {1:entry().observations[1]})},
    {...entry(),observations:Object.assign(Array(2), {0:entry().observations[0]})},
    {...entry(),observations:[entry().observations[1],entry().observations[0]]},
    {...entry(),observations:[{...entry().observations[0],rating:'hire'},entry().observations[1]]},
    {...entry(),observations:[{...entry().observations[0],evidence:' '},entry().observations[1]]},
    {...entry(),observations:[entry().observations[0],{...entry().observations[1],evidence:'Nie wiem'}]},
    {...entry(),version:0},
    {...entry(),observations:[{...entry().observations[0],evidence:'x'.repeat(10001)},entry().observations[1]]},
  ];
  for(const row of invalid)assert.throws(()=>buildAssessmentCenterReport(ids,revision(),row));
});
