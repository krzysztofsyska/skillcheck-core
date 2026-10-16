import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { inspectSalesReleaseGit, REVIEWED_SALES_BLOBS } from '../../tools/agent-pipeline/lib/sales-release-verified.mjs';

const meta=(scope,kind)=>['TASK: SC-SALES-RELEASE','SCOPE: '+scope,'LEVEL: L3',
  'OWNER_APPROVAL: PENDING','PRODUCTION_APPROVAL: NO','REVIEW_VERDICT: PENDING',
  'PROMOTION: YES','RELEASE_KIND: '+kind].join('\\n');
const sourceFiles=["app/preselekcja/page.tsx","app/components/marketing/home-page.tsx","app/components/marketing/site-header.tsx","app/components/marketing/package-comparison.tsx","tests/marketing-http.test.mjs"];
const seedFiles=[".github/workflows/sales-selective-scope.yml","AGENTS.md","docs/sales-selective-governance-install.md","tests/agent-pipeline/sales-selective-governance.test.mjs","tools/agent-pipeline/classify-pr.mjs","tools/agent-pipeline/lib/sales-release-verified.mjs","tools/agent-pipeline/lib/sales-trusted-runner.mjs"];
const source='release/sales-mvp-intake-20261013';
const seed='governance/sales-selective-main-gate-20261016';
const main='76760b7ffb7e95231fc7af313cc67bc8d36fefe1';
test('one-time governance installation is pinned to old main and exact seven files',()=>{
  const input={files:seedFiles,body:meta('OPERATIONS','GOVERNANCE_SEED'),
    base:'main',headRef:seed,baseSha:main};
  assert.equal(classify(input).ok,true);
  for(const patch of [{baseSha:'a'.repeat(40)},{headRef:'feat/other'},
    {files:[...seedFiles,'app/api/payments/route.ts']},
    {files:seedFiles.slice(1)},{body:meta('OPERATIONS','NO')},
    {files:[...seedFiles.slice(1),seedFiles[1]]}])
    assert.equal(classify({...input,...patch}).ok,false,JSON.stringify(patch));
});
test('only the five reviewed intake paths classify as special promotion',()=>{
  const input={files:sourceFiles,body:meta('FRONTEND','SALES_MVP_INTAKE'),
    base:'main',headRef:source,baseSha:main};
  assert.equal(classify(input).ok,true);
  for(const patch of [{headRef:'release/other'},{files:['app/preselekcja/page.tsx']},
    {files:[...sourceFiles,'supabase/migrations/0001.sql']},
    {files:[...sourceFiles.slice(1),sourceFiles[1]]},
    {body:meta('FRONTEND','NO')},{body:meta('OPERATIONS','SALES_MVP_INTAKE')},
    {base:'integration',files:['app/api/payment.ts']}])
    assert.equal(classify({...input,...patch}).ok,false,JSON.stringify(patch));
});
test('standard integration promotion stays unchanged, and untrusted metadata never authorizes production',()=>{
  assert.equal(classify({files:['app/page.tsx'],body:meta('FRONTEND','STANDARD'),
    base:'main',headRef:'integration'}).ok,true);
  assert.equal(inspectSalesReleaseGit({baseSha:main,headSha:'a'.repeat(40)}).authorizedForProduction,false);
  assert.equal(Object.keys(REVIEWED_SALES_BLOBS).length,5);
});
test('trusted workflow never checks out, imports or executes candidate code',()=>{
  const y=readFileSync('.github/workflows/sales-selective-scope.yml','utf8');
  assert.match(y,/pull_request_target:/);
  assert.match(y,/persist-credentials: false/);
  assert.match(y,/ref: .*github.event.pull_request.base.sha/);
  assert.doesNotMatch(y,/ref: .*github.event.pull_request.head.sha/);
  assert.match(y,/node tools\\/agent-pipeline\\/lib\\/sales-trusted-runner.mjs/);
  assert.doesNotMatch(y,/secrets\\./);
  assert.doesNotMatch(y,/git checkout .*release/);
});
