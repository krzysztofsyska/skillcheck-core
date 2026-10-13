import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { SALES_INTAKE_FILES, validateSalesRelease } from '../../tools/agent-pipeline/lib/sales-release.mjs';

const body = "TASK: SC-SALES-RELEASE\nSCOPE: FRONTEND\nLEVEL: L3\nOWNER_APPROVAL: APPROVED\nPRODUCTION_APPROVAL: APPROVED\nREVIEW_VERDICT: PASS\nPROMOTION: YES\nRELEASE_KIND: SALES_MVP_INTAKE";
const data = {
  files: ['app/preselekcja/page.tsx', 'app/components/marketing/home-page.tsx',
    'app/components/marketing/site-header.tsx', 'app/components/marketing/package-comparison.tsx',
    'tests/marketing-http.test.mjs'],
  statuses: ['A', 'M', 'M', 'M', 'M'],
  modes: ['100644','100644','100644','100644','100644'],
  base: 'main',
  headRef: 'release/sales-mvp-intake-20261013',
  metadata: Object.fromEntries(body.split('\n').map(l => l.split(': '))),
};
const check = change => validateSalesRelease({ ...data, ...change });

test('sales intake release: offline scope passes but existing main gate still rejects it', () => {
  assert.deepEqual(SALES_INTAKE_FILES, data.files);
  assert.equal(check({}).ok, true);
  // The candidate-only scope can be validated for review, but main stays closed.
  assert.equal(classify({ ...data, body }).ok, false);
});

test('legacy promotion to main still requires integration head and cannot claim a sales exception', () => {
  const normal = classify({files:['app/rozmowa/page.tsx'],body:body.replace('RELEASE_KIND: SALES_MVP_INTAKE','RELEASE_KIND: GENERAL'),base:'main',headRef:'release/other'});
  assert.equal(normal.ok,false);
  const standard = classify({files:['app/rozmowa/page.tsx'],body:'TASK: PROD\nSCOPE: FRONTEND\nLEVEL: L3\nOWNER_APPROVAL: APPROVED\nPRODUCTION_APPROVAL: APPROVED\nREVIEW_VERDICT: PASS\nPROMOTION: YES',base:'main',headRef:'integration'});
  assert.equal(standard.ok,true);
});

test('gate rejects forbidden billing, payment, CV, worker, SQL and deployment paths', () => {
  for (const path of [
    'supabase/migrations/20261013_sc19.sql','app/api/payments/route.ts','app/dashboard/[companyId]/billing/page.tsx',
    'lib/screening-worker.ts','app/rozmowa/actions.ts','.github/workflows/agent-gates.yml',
    'tools/agent-pipeline/classify-pr.mjs','vercel.json','.env','package.json','../private.txt',
  ]) {
    const files = [data.files[0],path];
    assert.equal(check({files,statuses:['A','M'],modes:['100644','100644']}).ok,false,path);
  }
});

test('gate rejects deletions, symlinks, executable files and unverifiable git statuses', () => {
  for (const status of ['D','T','R100','C100']) {
    assert.equal(check({statuses:[status,...data.statuses.slice(1)]}).ok,false,status);
  }
  for (const mode of ['120000','160000','100755',null]) {
    assert.equal(check({modes:[mode,...data.modes.slice(1)]}).ok,false,String(mode));
  }
  assert.equal(check({statuses:null}).ok,false);
  assert.equal(check({modes:null}).ok,false);
});

test('gate rejects wrong branches, wrong bases, missing intake page and duplicate paths', () => {
  for (const headRef of ['integration','release/sales-only-20261011','release/sales-mvp-billing-20261013','release/sales-mvp-intake-abc','release/sales-mvp-intake-20261013/other']) {
    assert.equal(check({headRef}).ok,false,headRef);
  }
  assert.equal(check({base:'integration'}).ok,false);
  assert.equal(check({files:['tests/marketing-http.test.mjs'],statuses:['M'],modes:['100644']}).ok,false);
  assert.equal(check({files:[data.files[0],data.files[0]],statuses:['M','M'],modes:['100644','100644']}).ok,false);
});

test('release requires a specifically approved promotion, not a generic or pending description', () => {
  const fields = ['PROMOTION','RELEASE_KIND','LEVEL','OWNER_APPROVAL','REVIEW_VERDICT','PRODUCTION_APPROVAL'];
  for (const field of fields) {
    const metadata={...data.metadata,[field]:'PENDING'};
    assert.equal(check({metadata}).ok,false,field);
  }
  assert.equal(classify({...data,body:body.replace('PRODUCTION_APPROVAL: APPROVED','PRODUCTION_APPROVAL: PENDING')}).ok,false);
  // Even forged positive approval labels cannot bypass the trusted main rule.
  assert.equal(classify({...data,body}).ok,false);
});

test('normal task PRs to integration remain unaffected by release-only controls', () => {
  const result=classify({files:['app/preselekcja/page.tsx'],body:body.replace('PROMOTION: YES','PROMOTION: NO'),base:'integration',headRef:'feat/sales-mvp-landing'});
  assert.equal(result.ok,true);
});
