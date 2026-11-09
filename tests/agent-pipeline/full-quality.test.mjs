import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { freezeHistory, historyCoverage } from '../../tools/agent-pipeline/lib/history.mjs';
import { evaluateChecks, evaluateDiscussion } from '../../tools/agent-pipeline/lib/quality.mjs';
import { plan, fold } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { assembleWork } from '../../tools/agent-pipeline/lib/snapshot.mjs';
import { observation, taskRecord, HEAD, BASE } from './helpers.mjs';

const check = () => ({ id: 1, name: 'verify', head_sha: HEAD, app: { id: 15368 }, status: 'completed', conclusion: 'success' });
const quality = changes => ({ head: HEAD, checks: [check()], statuses: [], required: [{context:'verify',integration_id:15368}], controllerAppId: 900, ...changes });

test('required check absence, pending, failure, wrong source, stale SHA and later retry fail closed', () => {
  assert.equal(evaluateChecks(quality()).ok, true);
  for (const checks of [[], [{...check(),status:'in_progress'}], [{...check(),conclusion:'failure'}], [{...check(),app:{id:900}}], [{...check(),head_sha:BASE}], [check(),{...check(),id:2,status:'queued',conclusion:null}]]) assert.equal(evaluateChecks(quality({checks})).ok,false);
  assert.equal(evaluateChecks(quality({required:[]})).ok,false);
  assert.equal(evaluateChecks(quality({required:[{context:'verify',integration_id:null}]})).ok,false);
  assert.equal(evaluateChecks(quality({statuses:[{id:1,context:'external',state:'pending'}]})).ok,false);
  assert.equal(evaluateChecks(quality({checks:[{...check(),conclusion:'failure'}, {...check(),id:2}]})).ok,true);
});

test('all unresolved threads and current change requests block merge', () => {
  assert.equal(evaluateDiscussion([],[]).ok,true);
  assert.equal(evaluateDiscussion([{isResolved:false}],[]).ok,false);
  const review={id:1,user:{id:22},state:'CHANGES_REQUESTED'};
  assert.equal(evaluateDiscussion([{isResolved:true}],[review]).ok,false);
  assert.equal(evaluateDiscussion([],[review,{...review,id:2,state:'APPROVED'}]).ok,true);
});

test('full history retains a transient change that the final diff hides', () => {
  const dir=mkdtempSync(join(tmpdir(),'sc-history-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
    writeFileSync(join(dir,'file'),'safe\n');git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');
    writeFileSync(join(dir,'file'),'transient-unsafe-code\n');git('commit','-am','temporary');const transient=git('rev-parse','HEAD');
    writeFileSync(join(dir,'file'),'safe\n');git('commit','-am','revert');const head=git('rev-parse','HEAD');
    const frozen=freezeHistory(dir,base,head);
    assert.equal(frozen.diff,'');assert.match(frozen.history,/transient-unsafe-code/);
    assert.deepEqual(frozen.commits,[transient,head]);
    assert.equal(historyCoverage({full_diff_reviewed:true,reviewed_commits:[head]},frozen.commits),false);
    assert.equal(historyCoverage({full_diff_reviewed:true,reviewed_commits:frozen.commits},frozen.commits),true);
    assert.throws(()=>freezeHistory(dir,base,head,10),/HISTORY_/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('post-merge CI blocks next task, records exact evidence and recovers after successful rerun', () => {
  const obs=observation(); const merged='e'.repeat(40);
  const record=fold(taskRecord({state:'READY_FOR_OWNER'}),{type:'github.merge',gate:'A'},{merged:true,mergeCommitSha:merged},obs);
  assert.equal(record.technical_state,'WAITING_POST_MERGE_CI');
  const snapshot={records:{[record.task_id]:record},issues:[],pulls:[]};
  assert.equal(assembleWork({policy:obs.policy,policySha:obs.policySha,now:obs.now,snapshot}).items[0].record.task_id,record.task_id);
  assert.equal(plan(record,obs).record.technical_state,'WAITING_POST_MERGE_CI');
  obs.github.postMergeCi={ok:false,reason:'POST_MERGE_CI_FAILED',runId:9};
  const blocked=plan(record,obs).record;assert.equal(blocked.state,'BLOCKED');assert.equal(blocked.binding.post_merge_ci.blocked,true);
  const work=assembleWork({policy:obs.policy,policySha:obs.policySha,now:obs.now,snapshot:{...snapshot,records:{[blocked.task_id]:blocked}}});
  assert.equal(work.items[0].record.task_id,blocked.task_id);
  obs.github.postMergeCi={ok:true,headSha:HEAD,runId:10};
  assert.notEqual(plan(blocked,obs).record.technical_state,null);
  obs.github.postMergeCi={ok:true,headSha:merged,runId:10,runAttempt:2};
  const ready=plan(blocked,obs).record;assert.equal(ready.state,'ACCEPTED');assert.equal(ready.technical_state,null);assert.equal(ready.binding.post_merge_ci.runId,10);
});
