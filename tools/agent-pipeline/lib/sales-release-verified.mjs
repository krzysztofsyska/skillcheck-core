// Preparation-only verifier; do not treat passing output as Production approval.
// MUST be run from a trusted base checkout after main safeguards are installed.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REVIEWED_SALES_BLOBS = Object.freeze({
  'app/preselekcja/page.tsx': 'eb5628d52ff29558a553437bd287caf9b2a9a350',
  'app/components/marketing/home-page.tsx': '36f79329d4e5b8e8640a2b00793187df0e83800e',
  'app/components/marketing/site-header.tsx': '4d7cda981e14ae4bc9041edd88591c0ba4644f00',
  'app/components/marketing/package-comparison.tsx': 'dfb531cf0f8837b164ea87bc186c657a8f2710d0',
  'tests/marketing-http.test.mjs': 'b7197e7cd1d51bbfc894b4c9d2a7cc7b1f17dae8',
});
const branch = 'release/sales-mvp-intake-20261013';
const sha40 = /^[a-f0-9]{40}$/;
const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:sk-proj-|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{20,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
];
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore','pipe','pipe'],
  });
}
function changes(raw) {
  if (!raw) return [];
  const tokens = raw.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length % 2) throw new Error('Malformed git name-status record');
  const entries = [];
  for(let i=0;i<tokens.length;i+=2) {
    const status=tokens[i], path=tokens[i+1];
    if(!status || !path) throw new Error('Empty git name-status record');
    entries.push({status,path});
  }
  return entries;
}
function blobAt(cwd, sha, path) {
  const row=git(cwd, 'ls-tree','--full-tree',sha,'--',path).trim();
  const match=/^([0-9]{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
  if(!match || match[3]!==path || match[1]!=='100644')
    throw new Error('Unsafe Git mode or missing regular file: '+path);
  return match[2];
}
function checkChanged(entries, expected, errors, label, allowPartial) {
  const seen=new Set();
  for(const {status,path} of entries) {
    if(!Object.hasOwn(expected,path)) errors.push(label+': forbidden path '+path);
    if(status!=='A' && status!=='M') errors.push(label+': forbidden status '+status+' '+path);
    if(seen.has(path)) errors.push(label+': duplicate path '+path);
    seen.add(path);
  }
  if(!allowPartial) {
    for(const path of Object.keys(expected)) {
      if(!seen.has(path)) errors.push(label+': missing reviewed path '+path);
    }
  }
  if(!entries.length) errors.push(label+': empty diff');
}
export function inspectSalesReleaseGit({
  cwd='.', baseSha, headSha, headRef=branch,
}) {
  // The manifest is policy, never caller input (including test-only overrides).
  const expectedBlobs=REVIEWED_SALES_BLOBS;
  const errors=[], inspected=new Set();
  if (!sha40.test(baseSha??'') || !sha40.test(headSha??'') || baseSha===headSha)
    return {ok:false,authorizedForProduction:false,errors:['Invalid base/head SHA']};
  if (headRef!==branch) errors.push('Unexpected source branch');
  try {
    const actualMain=git(cwd,'rev-parse','refs/remotes/origin/main').trim();
    if(actualMain!==baseSha) errors.push('Base does not match current origin/main');
    if(git(cwd,'merge-base',baseSha,headSha).trim()!==baseSha)
      errors.push('Release does not descend from main');
    const graph=git(cwd,'rev-list','--reverse','--parents',baseSha+'..'+headSha).trim().split('\n').filter(Boolean);
    if(!graph.length || graph.length>12) errors.push('Unexpected release history length');
    let previous=baseSha;
    for(const line of graph) {
      const [sha,...parents]=line.trim().split(/\s+/);
      if(parents.length!==1 || parents[0]!==previous) errors.push('Nonlinear/merge commit: '+sha);
      previous=sha;
      if(!sha40.test(sha) || !sha40.test(parents[0]??'')) throw new Error('Malformed commit graph');
      const entries=changes(git(cwd,'diff-tree','-r','--no-commit-id','--name-status','--no-renames','-z',parents[0],sha));
      checkChanged(entries,expectedBlobs,errors,'commit '+sha.slice(0,8),true);
      for(const {status,path} of entries) {
        if (!Object.hasOwn(expectedBlobs,path) || !['A','M'].includes(status)) continue;
        const blob=blobAt(cwd,sha,path);
        const contents=git(cwd,'show',sha+':'+path);
        if(Buffer.byteLength(contents,'utf8')>200000) errors.push('Oversize file '+path);
        if(suspicious.some(pattern=>pattern.test(contents))) errors.push('Potential embedded credential in historical blob: '+path);
        inspected.add(path);
        if(!sha40.test(blob)) errors.push('Invalid blob '+path);
      }
    }
    if(previous!==headSha) errors.push('History does not reach requested HEAD');
    const final=changes(git(cwd,'diff','--name-status','--no-renames','-z',baseSha,headSha));
    checkChanged(final,expectedBlobs,errors,'final',false);
    for(const path of Object.keys(expectedBlobs)) {
      if(!inspected.has(path)) errors.push('No history evidence for '+path);
      const actual=blobAt(cwd,headSha,path);
      if(actual!==expectedBlobs[path]) errors.push('Unreviewed final content: '+path);
    }
  } catch(e) {
    errors.push('Git inspection failed: '+String(e.message).slice(0,240));
  }
  // An exact-file, history and heuristic-secret audit is NOT a GitHub protection
  // or code-review/approval attestation. This module never authorizes Production.
  return {ok:errors.length===0,authorizedForProduction:false,errors};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [baseSha,headSha,headRef]=process.argv.slice(2);
  const result=inspectSalesReleaseGit({baseSha,headSha,headRef});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.ok) process.exitCode=1;
}
