import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedGaps, parseHumanDecision } from '../lib/interview-workflow.ts';

const requirements=[
  {id:'task:1',kind:'task',text:'Praca z CRM'},
  {id:'kpi:1',kind:'kpi',text:'Raportowanie wyników'},
];
const item=(key,verdict,status,extra={})=>({
  id:key+'-'+status,requirement_key:key,verdict,human_status:status,
  human_verdict:null,human_question:null,suggested_question:'Podaj przykład.',
  ...extra,
});
test('interview questions: only explicit human-approved partial/missing/contradicted',()=>{
  const rows=[
    item('task:1','missing','unreviewed'),
    item('task:1','partial','rejected'),
    item('task:1','supported','accepted'),
    item('task:1','partial','accepted'),
    item('kpi:1','supported','edited',{human_verdict:'contradicted',human_question:'Co wynikało z raportu?'}),
    item('kpi:1','missing','edited',{human_verdict:'supported'}),
    item('stranger:9','missing','accepted'),
  ];
  const selected=reviewedGaps(rows,requirements);
  assert.deepEqual(selected.map(x=>x.itemId),['task:1-accepted','kpi:1-edited']);
  assert.equal(selected[1].questionText,'Co wynikało z raportu?');
  assert.equal(selected[0].requirementText,'Praca z CRM');
});
test('generated questions never entail or contain a hiring decision',()=>{
  assert.deepEqual(reviewedGaps([],requirements),[]);
  const selected=reviewedGaps([item('task:1','missing','accepted',{suggested_question:''})],requirements);
  assert.match(selected[0].questionText,/Podaj przykład zawodowy/);
  assert.equal('decision' in selected[0],false);
});
test('human decision must be explicit, justified and never defaulted',()=>{
  for(const value of [undefined,null,'','hire','reject','auto']) {
    assert.throws(()=>parseHumanDecision(value,'Treść'),/Wybierz decyzję/);
  }
  for(const justification of [undefined,null,'','   ','x'.repeat(10001)]) {
    assert.throws(()=>parseHumanDecision('completed',justification),/Uzasadnienie/);
  }
  assert.deepEqual(parseHumanDecision('on_hold',' Powód '),{decision:'on_hold',justification:'Powód'});
});
