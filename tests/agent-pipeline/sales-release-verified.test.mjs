import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectSalesReleaseGit,REVIEWED_SALES_BLOBS } from '../../tools/agent-pipeline/lib/sales-release-verified.mjs';

const filenames=Object.keys(REVIEWED_SALES_BLOBS);
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
  return {cwd,baseSha,headSha:git(cwd,'rev-parse','HEAD'),expected};
}
test('actual five-file Git history and pinned blobs are checked; no production permission',()=>{
  const f=setup();
  try {
    const r=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha});
    assert.equal(r.ok,true,JSON.stringify(r.errors));
    assert.equal(r.authorizedForProduction,false);
    assert.deepEqual(f.expected,REVIEWED_SALES_BLOBS,'fixture bytes must match reviewed content');
    assert.equal(inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,headRef:'anything'}).ok,false);
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
