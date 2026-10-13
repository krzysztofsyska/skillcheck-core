import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../tools/agent-pipeline/classify-pr.mjs';
import { SALES_INTAKE_FILES, validateSalesRelease } from '../../tools/agent-pipeline/lib/sales-release.mjs';

const body = [
  'TASK: SC-SALES-MVP-INTAKE-RELEASE',
  'SCOPE: FRONTEND',
  'LEVEL: L3',
  'OWNER_APPROVAL: APPROVED',
  'PRODUCTION_APPROVAL: APPROVED',
  'REVIEW_VERDICT: PASS',
  'PROMOTION: YES',
  'RELEASE_KIND: SALES_MVP_INTAKE',
].join('\n');

const files=[...SALES_INTAKE_FILES];
const baseSha='a'.repeat(40);
const commitIds=['b','c','d','e','f'].map(char=>char.repeat(40));
const commits=files.map((path,index)=>({
  sha:commitIds[index],
  parentSha:index===0?baseSha:commitIds[index-1],
  parentCount:1,
  changes:[{path,status:index===0?'A':'M',mode:'100644'}],
}));
const good={
  files,statuses:['A','M','M','M','M'],modes:files.map(()=>'100644'),
  commits,baseSha,headSha:commitIds.at(-1),
  base:'main',headRef:'release/sales-mvp-intake-20261013',
};
// Supply a correctly linked extension to isolate tests of forbidden changes.
const extended=(path,status='A',mode='100644')=>{
  const sha='1'.repeat(40);
  return {commits:[...commits,{
    sha,parentSha:good.headSha,parentCount:1,changes:[{path,status,mode}],
  }],headSha:sha};
};
const check=patch=>validateSalesRelease({...good,...patch});

test('offline intake validator checks final diff and every commit but NEVER authorizes Production',()=>{
  const r=check({});
  assert.equal(r.ok,true);
  assert.equal(r.authorizedForProduction,false);
  assert.equal(r.historyAuthenticated,false);
  assert.equal(r.secretsScanned,false);
  assert.equal(classify({files,base:'main',headRef:good.headRef,body}).ok,false);
});

test('unchanged standard promotion from integration is still valid',()=>{
  const standard=classify({files:['app/rozmowa/page.tsx'],body,base:'main',headRef:'integration'});
  assert.equal(standard.ok,true);
  const out=classify({files,body,base:'main',headRef:good.headRef});
  assert.equal(out.ok,false);
  const bypass=classify({files,body:body.replace('PROMOTION: YES','PROMOTION: NO'),base:'main',headRef:good.headRef});
  assert.equal(bypass.ok,false);
});

test('final release diff denies changes outside exact marketing files',()=>{
  for (const path of [
    'supabase/migrations/0001.sql','app/api/payments/route.ts','app/dashboard/[companyId]/billing/page.tsx',
    'lib/screening-worker.ts','app/rozmowa/actions.ts','tools/agent-pipeline/classify-pr.mjs',
    '.github/workflows/sales-release-scope.yml','vercel.json','.env','package.json','../secret',
  ]){
    assert.equal(check({files:[good.files[0],path],statuses:['A','M'],modes:['100644','100644']}).ok,false,path);
  }
  assert.equal(check({files:[],statuses:[],modes:[]}).ok,false);
  assert.equal(check({files:['tests/marketing-http.test.mjs'],statuses:['M'],modes:['100644']}).ok,false);
  assert.equal(check({statuses:[]}).ok,false);
});

test('each intermediate commit denies prohibited paths even if final diff clean',()=>{
  const forbidden=[
    'supabase/migrations/20261013.sql','.env','app/api/checkout/route.ts',
    'app/rozmowa/actions.ts','tools/agent-pipeline/classify-pr.mjs',
  ];
  for(const path of forbidden){
    const r=check(extended(path));
    assert.equal(r.ok,false,path);
    assert.ok(r.errors.some(error=>error.includes('forbidden file')),path);
  }
  for(const status of ['D','T','R100','C100']){
    const r=check(extended(files[0],status));
    assert.equal(r.ok,false,status);
    assert.ok(r.errors.some(error=>error.includes('forbidden status')),status);
  }
  for(const mode of ['120000','160000','100755',null]){
    const r=check(extended(files[0],'M',mode));
    assert.equal(r.ok,false,String(mode));
    assert.ok(r.errors.some(error=>error.includes('forbidden mode')),String(mode));
  }
});

test('history must contain individual verified commits, not merge commits or missing data',()=>{
  for(const history of [null,[],[{parentCount:2,changes:commits[0].changes}],[{parentCount:1,changes:[]}]]){
    assert.equal(check({commits:history}).ok,false);
  }
  assert.equal(check({commits:Array.from({length:31},()=>commits[0])}).ok,false);
});

test('caller-supplied history must link base to head, without missing or duplicate records',()=>{
  assert.equal(check({}).ok,true);
  assert.equal(check({baseSha:'0'.repeat(40)}).ok,false);
  assert.equal(check({headSha:'9'.repeat(40)}).ok,false);
  assert.equal(check({baseSha:'not-a-sha'}).ok,false);
  assert.equal(check({commits:[...commits.slice(0,2),...commits.slice(3)]}).ok,false);
  assert.equal(check({commits:[commits[0],commits[0],...commits.slice(2)]}).ok,false);
  assert.equal(check({commits:commits.slice(0,1)}).ok,false);
  assert.equal(check({commits:commits.map((c,i)=>i===2?{...c,changes:[{path:files[0],status:'M',mode:'100644'}]}:c)}).ok,false);
  // These attest only internal structure, NOT genuine Git history or secret-free blobs.
  assert.equal(check({}).historyAuthenticated,false);
  assert.equal(check({}).secretsScanned,false);
  assert.equal(check({}).authorizedForProduction,false);
});

test('branch mismatch, deletion, symlink and executable final files fail',()=>{
  for(const b of ['release/sales-only-20261011','release/sales-mvp-intake-abc','release/sales-mvp-intake-20261013/other']){
    assert.equal(check({headRef:b}).ok,false,b);
  }
  assert.equal(check({base:'integration'}).ok,false);
  for(const status of ['D','T','R100'])assert.equal(check({statuses:[status,...good.statuses.slice(1)]}).ok,false);
  for(const mode of ['120000','160000','100755'])assert.equal(check({modes:[mode,...good.modes.slice(1)]}).ok,false);
  assert.equal(check({files:[files[0],files[0]],statuses:['A','M'],modes:['100644','100644']}).ok,false);
});

test('PR-provided owner metadata is never accepted as independent approval',()=>{
  const fakeApprovals=body.replace('OWNER_APPROVAL: APPROVED','OWNER_APPROVAL: APPROVED\nREVIEW_VERDICT: PASS');
  assert.equal(classify({files,base:'main',headRef:good.headRef,body:fakeApprovals}).ok,false);
  assert.equal(check({}).authorizedForProduction,false);
  assert.equal(classify({files:['app/preselekcja/page.tsx'],body:body.replace('PROMOTION: YES','PROMOTION: NO'),base:'integration',headRef:'feat/landing'}).ok,true);
});
