import test from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../../tools/agent-pipeline/classify-pr.mjs';

const body=(scope='BACKEND',level='L3',promotion='NO')=>[
  'TASK: SC-OPS-DB-SCOPE',`SCOPE: ${scope}`,`LEVEL: ${level}`,
  'OWNER_APPROVAL: POLICY-AUTHORIZED','PRODUCTION_APPROVAL: NO',
  'REVIEW_VERDICT: PENDING',`PROMOTION: ${promotion}`,
].join('\n');
const gate=(files,scope='BACKEND',level='L3',extra={})=>classify({
  files,body:body(scope,level),base:'integration',headRef:'feat/isolated-adapter',...extra,
});

test('isolated and prototype SQL alone or with its handoff is backend database work',()=>{
  for(const file of ['db/isolated/voice-erasure.sql','db/isolated/nested/adapter.sql',
    'db/prototypes/voice-plan-schema.sql']) {
    for(const files of [[file],[file,'tests/voice-erasure.test.mjs','docs/voice-handoff.md']]) {
      const result=gate(files);
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(result.detected,'BACKEND');
      assert.equal(result.database,true);
      assert.equal(result.security,true);
    }
  }
});

test('isolated SQL cannot bypass automatic L3 or claim operations-only scope',()=>{
  for(const file of ['db/isolated/adapter.sql','db/prototypes/schema.sql']) {
    for(const level of ['L1','L2']) {
      const result=gate([file],'BACKEND',level);
      assert.equal(result.ok,false);
      assert.ok(result.errors.some(error=>error.includes('require LEVEL: L3')));
    }
    const wrongScope=gate([file],'OPERATIONS');
    assert.equal(wrongScope.ok,false);
    assert.ok(wrongScope.errors.some(error=>error.includes('changed files classify as BACKEND')));
  }
});

test('isolated SQL and a product page require fullstack scope',()=>{
  const files=['db/isolated/adapter.sql','app/voice/page.tsx'];
  const result=gate(files,'FULLSTACK');
  assert.equal(result.ok,true);
  assert.equal(result.detected,'FULLSTACK');
  assert.equal(result.database,true);
  assert.equal(result.security,true);
  for(const scope of ['FRONTEND','BACKEND','OPERATIONS']) assert.equal(gate(files,scope).ok,false);
});

test('documentation and test names do not pretend to be executable database SQL',()=>{
  const result=gate(['db/isolated/README.md','db/prototypes/design.md',
    'tests/isolated-schema.test.mjs'],'OPERATIONS','L1');
  assert.equal(result.ok,true);
  assert.equal(result.detected,'OPERATIONS');
  assert.equal(result.database,false);
  assert.equal(result.security,false);
});

test('existing migration and controller classifications retain their L3 requirement',()=>{
  const migration=gate(['supabase/migrations/20261017000000_example.sql']);
  assert.equal(migration.ok,true);
  assert.equal(migration.database,true);
  assert.equal(migration.security,true);
  assert.equal(gate(['supabase/migrations/20261017000000_example.sql'],'BACKEND','L2').ok,false);
  const controller=gate(['tools/agent-pipeline/classify-pr.mjs'],'OPERATIONS');
  assert.equal(controller.ok,true);
  assert.equal(controller.operations,true);
  assert.equal(gate(['tools/agent-pipeline/classify-pr.mjs'],'OPERATIONS','L2').ok,false);
});

test('database classification grants no direct-main or promotion exception',()=>{
  const files=['db/isolated/adapter.sql'];
  for(const promotion of ['NO','YES']) {
    const result=gate(files,'BACKEND','L3',{base:'main',body:body('BACKEND','L3',promotion)});
    assert.equal(result.ok,false);
    assert.ok(result.errors.some(error=>error.includes('Only an integration -> main promotion')));
  }
  assert.equal(gate(files,'BACKEND','L3',{
    base:'main',headRef:'integration',body:body('BACKEND','L3','NO'),
  }).ok,false);
});
