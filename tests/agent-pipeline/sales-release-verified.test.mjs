import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectSalesReleaseGit,REVIEWED_SALES_BLOBS } from '../../tools/agent-pipeline/lib/sales-release-verified.mjs';

const filenames=Object.keys(REVIEWED_SALES_BLOBS);
function git(cwd,...args) {
  return execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
}
function setup() {
  const cwd=mkdtempSync(join(tmpdir(),'skillcheck-sales-gate-'));
  git(cwd,'init','-q');
  git(cwd,'config','user.name','Fixture');
  git(cwd,'config','user.email','fixture@example.test');
  const files=new Map();
  for(const path of filenames.slice(1)) {
    const full=join(cwd,path);
    mkdirSync(dirname(full),{recursive:true});
    writeFileSync(full,'original '+path+'\n');
  }
  git(cwd,'add','.');
  git(cwd,'commit','-q','-m','baseline');
  const baseSha=git(cwd,'rev-parse','HEAD');
  git(cwd,'update-ref','refs/remotes/origin/main',baseSha);
  const expected={};
  for (const path of filenames) {
    const full=join(cwd,path);
    mkdirSync(dirname(full),{recursive:true});
    writeFileSync(full,'reviewed '+path+'\n');
    git(cwd,'add',path);
    git(cwd,'commit','-q','-m','reviewed '+path);
    expected[path]=git(cwd,'rev-parse','HEAD:'+path);
  }
  return {cwd,baseSha,headSha:git(cwd,'rev-parse','HEAD'),expected};
}
test('actual five-file Git history and pinned blobs are checked; no production permission',()=>{
  const f=setup();
  try {
    const r=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,expectedBlobs:f.expected});
    assert.equal(r.ok,true,JSON.stringify(r.errors));
    assert.equal(r.authorizedForProduction,false);
    assert.equal(inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha}).ok,false);
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
    const r=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:git(f.cwd,'rev-parse','HEAD'),expectedBlobs:f.expected});
    assert.equal(r.ok,false);assert.ok(r.errors.some(x=>x.includes('forbidden path')));
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});
test('rejects merge history, stale main, historical key and mismatched blob',()=>{
  const f=setup();
  try {
    const wrong={...f.expected,[filenames[0]]:'a'.repeat(40)};
    assert.equal(inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,expectedBlobs:wrong}).ok,false);
    git(f.cwd,'update-ref','refs/remotes/origin/main',f.headSha);
    assert.equal(inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:f.headSha,expectedBlobs:f.expected}).ok,false);
    git(f.cwd,'update-ref','refs/remotes/origin/main',f.baseSha);
    git(f.cwd,'checkout','-q','-b','key-test',f.baseSha);
    const path=filenames[0];
    mkdirSync(dirname(join(f.cwd,path)),{recursive:true});
    writeFileSync(join(f.cwd,path),'-----BEGIN PRIVATE KEY-----\nFAKE\n');
    git(f.cwd,'add',path);git(f.cwd,'commit','-q','-m','temporary key');
    writeFileSync(join(f.cwd,path),'reviewed '+path+'\n');
    git(f.cwd,'add',path);git(f.cwd,'commit','-q','-m','erase key');
    const result=inspectSalesReleaseGit({cwd:f.cwd,baseSha:f.baseSha,headSha:git(f.cwd,'rev-parse','HEAD'),expectedBlobs:f.expected});
    assert.equal(result.ok,false);
    assert.ok(result.errors.some(x=>x.includes('historical blob')));
  }finally{rmSync(f.cwd,{recursive:true,force:true});}
});
