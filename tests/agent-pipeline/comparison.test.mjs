import test from 'node:test';
import assert from 'node:assert/strict';
import { completeComparison } from '../../tools/agent-pipeline/lib/comparison.mjs';
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const commits = Array.from({length: 538}, (_, i) => ({sha: i.toString(16).padStart(40, '0')}));
function fixture({ duplicate = false, truncated = false, total = 538 } = {}) {
  return async path => {
    if (path.includes('/compare/')) {
      const page = Number(new URL('https://example.test' + path).searchParams.get('page'));
      return {status: 'ahead', total_commits: total, commits: duplicate && page === 2 ? commits.slice(0,100) : commits.slice((page-1)*100, page*100), files: Array.from({length:300}, (_,i)=>({filename:String(i)}))};
    }
    const before = path.includes(base);
    return {truncated, tree: before ? [{path:'deleted',type:'blob',mode:'100644',sha:base}] : Array.from({length:359},(_,i)=>({path:`file-${i}`,type:'blob',mode:'100644',sha:head}))};
  };
}
test('538 commits and 360 changed paths retain complete immutable evidence', async () => {
  const result = await completeComparison(fixture(), '/repos/o/r', base, head);
  assert.equal(result.commits.length, 538);
  assert.equal(result.files.length, 360);
  assert.ok(result.files.some(f=>f.filename==='deleted'));
});
test('duplicate commit pages fail closed', async () => {
  await assert.rejects(completeComparison(fixture({duplicate:true}), '/repos/o/r', base, head), /PROMOTION_DIFF_INCOMPLETE/);
});
test('truncated tree evidence fails closed', async () => {
  await assert.rejects(completeComparison(fixture({truncated:true}), '/repos/o/r', base, head), /PROMOTION_DIFF_INCOMPLETE/);
});
test('moving refs are forbidden', async () => {
  await assert.rejects(completeComparison(fixture(), '/repos/o/r', 'main', head), /PROMOTION_DIFF_INCOMPLETE/);
});
