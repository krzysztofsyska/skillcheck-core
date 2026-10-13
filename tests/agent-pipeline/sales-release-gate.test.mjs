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
const commits=files.map((path,index)=>({
  parentCount:1,
  changes:[{path,status:index===0?'A':'M',mode:'100644'}],
}));
const good={
  files,statuses:['A','M','M','M','M'],modes:files.map(()=>'100644'),
  commits,base:'main',headRef:'release/sales-mvp-intake-20261013',
};
const check=patch=>validateSalesRelease({...good,...patch});

test('offline intake validator checks final diff and every commit but NEVER authorizes Production',()=>{
  const r=check({});
  assert.equal(r.ok,true);
  assert.equal(r.authorizedForProduction,false);
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
    assert.equal(check({commits:[...commits,{parentCount:1,changes:[{path,status:'A',mode:'100644'}]}]}).ok,false,path);
  }
  for(const status of ['D','T','R100','C100']){
    assert.equal(check({commits:[...commits,{parentCount:1,changes:[{path:files[0],status,mode:'100644'}]}]}).ok,false,status);
  }
  for(const mode of ['120000','160000','100755',null]){
    assert.equal(check({commits:[...commits,{parentCount:1,changes:[{path:files[0],status:'M',mode}]}]}).ok,false,String(mode));
  }
});

test('history must contain individual verified commits, not merge commits or missing data',()=>{
  for(const history of [null,[],[{parentCount:2,changes:commits[0].changes}],[{parentCount:1,changes:[]}]]){
    assert.equal(check({commits:history}).ok,false);
  }
  assert.equal(check({commits:Array.from({length:31},()=>commits[0])}).ok,false);
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
