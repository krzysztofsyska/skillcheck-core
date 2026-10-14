import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectSalesReleaseGit,REVIEWED_SALES_BLOBS } from '../../tools/agent-pipeline/lib/sales-release-verified.mjs';

const filenames=Object.keys(REVIEWED_SALES_BLOBS);
const releaseBranch='release/sales-mvp-intake-20261013';
const releaseRef='refs/heads/'+releaseBranch;
const inspector=fileURLToPath(new URL('../../tools/agent-pipeline/lib/sales-release-verified.mjs',import.meta.url));
function git(cwd,...args) {
  return execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
}
// Fixture substitution stays in test Git repositories, never in the verifier API.
function reviewedContent(path) {
  return readFileSync(new URL('../../'+path,import.meta.url));
}
function setup(paths=filenames, content=reviewedContent) {
  const cwd=mkdtempSync(join(tmpdir(),'skillcheck-sales-gate-'));
  git(cwd,'init','-q');
  git(cwd,'config','user.name','Fixture');
  git(cwd,'config','user.email','fixture@example.test');
  for(const path of paths.slice(1)) {
    const full=join(cwd,path);
    mkdirSync(dirname(full),{recursive:true});
    writeFileSync(full,'original '+path+'\n');
  }
  git(cwd,'add','.');
  git(cwd,'commit','-q','-m','baseline');
  const baseSha=git(cwd,'rev-parse','HEAD');
  git(cwd,'update-ref','refs/remotes/origin/main',baseSha);
  const expected={};
  for (const path of paths) {
    const full=join(cwd,path);
    mkdirSync(dirname(full),{recursive:true});
    writeFileSync(full,content(path));
    git(cwd,'add',path);
    git(cwd,'commit','-q','-m','reviewed '+path);
    expected[path]=git(cwd,'rev-parse','HEAD:'+path);
  }
  const headSha=git(cwd,'rev-parse','HEAD');
  git(cwd,'update-ref',releaseRef,headSha);
  return {cwd,baseSha,headSha,expected};
}
test('actual five-file Git history and pinned blobs are checked; no production permission',()=>{
  const f=setup();
  try {
    const r=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha});
    assert.equal(r.ok,true,JSON.stringify(r.errors));
    assert.equal(r.authorizedForProduction,false);
    assert.deepEqual(f.expected,REVIEWED_SALES_BLOBS,'fixture bytes must match reviewed content');
    assert.notEqual(git(f.cwd,'branch','--show-current'),releaseBranch);
    assert.equal(git(f.cwd,'rev-parse',releaseRef+'^{commit}'),f.headSha);
    assert.equal(inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,headRef:'anything'}).ok,false);
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});
test('branch name cannot replace a trusted release ref that matches HEAD',()=>{
  const f=setup();
  try {
    git(f.cwd,'update-ref','-d',releaseRef);
    for(const headRef of [undefined,releaseBranch]) {
      const missing=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,headRef});
      assert.equal(missing.authorizedForProduction,false);
      assert.deepEqual(missing.errors,['Trusted release ref is missing or not a commit']);
    }
    git(f.cwd,'update-ref',releaseRef,f.baseSha);
    const pointedElsewhere=inspectSalesReleaseGit({
      cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,headRef:releaseBranch,
    });
    assert.deepEqual(pointedElsewhere.errors,['Trusted release ref does not point at inspected HEAD']);
    git(f.cwd,'update-ref','-d',releaseRef);
    git(f.cwd,'branch','decoy',f.headSha);
    const decoy=inspectSalesReleaseGit({
      cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,headRef:releaseBranch,
    });
    assert.deepEqual(decoy.errors,['Trusted release ref is missing or not a commit']);
    assert.notEqual(git(f.cwd,'branch','--show-current'),releaseBranch);
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});
test('CLI with only base and head SHAs requires the local release ref',()=>{
  const f=setup();
  try {
    const run=(args)=>spawnSync(process.execPath,[inspector,...args],{cwd:f.cwd,encoding:'utf8'});
    const ok=run([f.baseSha,f.headSha]);
    assert.equal(ok.status,0,ok.stderr);
    const passed=JSON.parse(ok.stdout);
    assert.equal(passed.ok,true);
    assert.equal(passed.authorizedForProduction,false);
    git(f.cwd,'update-ref','-d',releaseRef);
    const bad=run([f.baseSha,f.headSha]);
    assert.equal(bad.status,1);
    const denied=JSON.parse(bad.stdout);
    assert.equal(denied.authorizedForProduction,false);
    assert.deepEqual(denied.errors,['Trusted release ref is missing or not a commit']);
    const literal=run([f.baseSha,f.headSha,releaseBranch]);
    assert.equal(literal.status,1);
    assert.deepEqual(JSON.parse(literal.stdout).errors,['Trusted release ref is missing or not a commit']);
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});
test('disallows foreign intermediate path even when final diff is clean',()=>{
  const f=setup();
  try {
    // Build an alternate history from the same base, introducing + reverting a forbidden path.
    git(f.cwd,'checkout','-q','-b','malicious',f.baseSha);
    writeFileSync(join(f.cwd,'SECRET.txt'),'secret');
    git(f.cwd,'add','SECRET.txt');git(f.cwd,'commit','-q','-m','temporary');
    git(f.cwd,'rm','-q','SECRET.txt');git(f.cwd,'commit','-q','-m','remove');
    const r=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:git(f.cwd,'rev-parse','HEAD')});
    assert.equal(r.ok,false);assert.ok(r.errors.some(x=>x.includes('forbidden path')));
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});
test('rejects stale main and historical key',()=>{
  const f=setup();
  try {
    git(f.cwd,'update-ref','refs/remotes/origin/main',f.headSha);
    const stale=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha});
    assert.equal(stale.ok,false);
    assert.ok(stale.errors.includes('Base does not match current origin/main'));
    git(f.cwd,'update-ref','refs/remotes/origin/main',f.baseSha);
    git(f.cwd,'checkout','-q','-b','key-test',f.baseSha);
    const path=filenames[0];
    mkdirSync(dirname(join(f.cwd,path)),{recursive:true});
    writeFileSync(join(f.cwd,path),'-----BEGIN PRIVATE KEY-----\nFAKE\n');
    git(f.cwd,'add',path);git(f.cwd,'commit','-q','-m','temporary key');
    writeFileSync(join(f.cwd,path),reviewedContent(path));
    git(f.cwd,'add',path);git(f.cwd,'commit','-q','-m','erase key');
    const result=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:git(f.cwd,'rev-parse','HEAD')});
    assert.equal(result.ok,false);
    assert.ok(result.errors.some(x=>x.includes('historical blob')));
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});

for(const [label,paths,expectedError] of [
  ['reviewed paths with substituted hashes',filenames,'Unreviewed final content'],
  ['five arbitrary paths',Array.from({length:5},(_,i)=>'unapproved/file-'+i+'.txt'),'forbidden path'],
]) {
  test('caller manifest cannot authorize '+label,()=>{
    const f=setup(paths,path=>'unreviewed '+path+'\n');
    try {
      const args={cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha};
      const baseline=inspectSalesReleaseGit(args);
      assert.equal(baseline.ok,false);
      for(const options of [
        {...args,expectedBlobs:f.expected},
        Object.assign(Object.create({expectedBlobs:f.expected}),args),
      ]) {
        const result=inspectSalesReleaseGit(options);
        assert.deepEqual(result,baseline,'caller manifest must have no effect');
        assert.equal(result.authorizedForProduction,false);
        assert.ok(result.errors.some(error=>error.includes(expectedError)));
      }
    }finally{rmSync(f.cwd,{recursive:true,force:true});}
  });
}
test('reviewed manifest is immutable',()=>{
  assert.ok(Object.isFrozen(REVIEWED_SALES_BLOBS));
  assert.throws(()=>{REVIEWED_SALES_BLOBS[filenames[0]]='a'.repeat(40);},TypeError);
  assert.throws(()=>{REVIEWED_SALES_BLOBS['unapproved.txt']='a'.repeat(40);},TypeError);
});
