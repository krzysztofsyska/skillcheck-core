import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssessmentStage, parseAssessmentProgress } from '../lib/assessment-fields.ts';

function form(values) { const f = new FormData(); for (const [k,v] of Object.entries(values)) f.set(k,v); return f; }

test('stage accepts a bounded name, description and explicit positive ordering', () => {
  assert.deepEqual(parseAssessmentStage(form({name:' Rozmowa ', description:' Dowody zachowań ', sequence:'10'})), {name:'Rozmowa',description:'Dowody zachowań',sequence:10});
  assert.equal(parseAssessmentStage(form({name:'Test',sequence:'1'})).description,null);
  for (const sequence of ['0','-1','1.5','1e3','01','1000000','Infinity','']) assert.throws(()=>parseAssessmentStage(form({name:'Test',sequence})));
  for (const values of [{name:' ',sequence:'1'},{name:'x'.repeat(201),sequence:'1'},{name:'Test',sequence:'1',description:'x'.repeat(10001)}]) assert.throws(()=>parseAssessmentStage(form(values)));
});

test('manual progress requires evidence or reason before completing or skipping', () => {
  for (const status of ['pending','in_progress']) assert.deepEqual(parseAssessmentProgress(form({status})),{status,notes:null});
  for (const status of ['completed','skipped']) {
    assert.throws(()=>parseAssessmentProgress(form({status,notes:' '})),/Opisz/);
    assert.deepEqual(parseAssessmentProgress(form({status,notes:' Obserwacja '})),{status,notes:'Obserwacja'});
  }
  assert.throws(()=>parseAssessmentProgress(form({status:'hired',notes:'x'})),/status/);
  assert.throws(()=>parseAssessmentProgress(form({status:'pending',notes:'x'.repeat(10001)})),/10 000/);
  const f = form({status:'pending'}); f.set('notes', new File(['data'],'cv.txt')); assert.throws(()=>parseAssessmentProgress(f));
});
