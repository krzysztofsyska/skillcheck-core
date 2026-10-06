import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileFromEnv } from '../../tools/agent-pipeline/lib/reconcile.mjs';
import { createGitHubClient, protectionFromRulesets } from '../../tools/agent-pipeline/lib/github.mjs';
import { evaluatePreflight, decideMerge } from '../../tools/agent-pipeline/lib/merge.mjs';
import { createLiveJournal } from '../../tools/agent-pipeline/lib/live-journal.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { validateReview } from '../../tools/agent-pipeline/lib/review.mjs';
import { httpWorld, MAIN, configuredPolicy, protectionFixtures } from './http-world.mjs';
import { contractBody } from './helpers.mjs';

// No loadWork/ports/journal substitution: only the HTTP boundary is mocked.
test('real CLI adapters: start, one repair, restart, A, lost merge response, separate B', async () => {
  const w=httpWorld(), previous=globalThis.fetch;
  globalThis.fetch=w.fetch; w.loseComment=true;
  const advance=()=>reconcileFromEnv(w.env,{policy:w.policy});
  const task=()=>Object.values(w.projection()).find(r=>r.task_id==='SC-DEMO-001');
  try {
    for(let i=0;i<70 && !(task()?.state==='READY_FOR_OWNER'&&task()?.binding.approval?.run_id);i++) await advance();
    assert.equal(task()?.state,'READY_FOR_OWNER',JSON.stringify(task()));
    assert.equal(task().repair_round,1);
    assert.equal(task().policy_sha,MAIN);
    assert.equal(w.mergeCount,0);
    assert.equal(w.calls.filter(c=>c.url==='https://api.cursor.com/v1/agents'&&c.method==='POST').length,1);
    const create=w.calls.find(c=>c.url==='https://api.cursor.com/v1/agents'&&c.method==='POST');
    assert.ok(create.body.prompt.text.includes(contractBody()));
    assert.ok(!('envVars' in create.body));
    assert.ok(w.checks.some(c=>c.name==='sc-agent/review'&&c.conclusion==='success'));
    w.loseComment=true;
    await advance(); await advance();
    assert.equal(w.comments.length,1);
    assert.match(w.comments[0].body,/actions\/runs\/\d+/);
    w.env.AGENT_PIPELINE_MERGE_ENABLED='true';
    await advance(); assert.equal(w.mergeCount,0,'no approval A');
    w.approveA=true; w.loseMerge=true;
    for(let i=0;i<15 && task()?.state!=='ACCEPTED';i++) await advance();
    assert.equal(task()?.state,'ACCEPTED',JSON.stringify(task()));
    assert.equal(w.mergeCount,1,'recover closed PR, no second PUT');
    const promotion=()=>Object.values(w.projection()).find(r=>r.binding.lane==='promotion');
    for(let i=0;i<70 && !(promotion()?.state==='READY_FOR_PROD'&&promotion()?.binding.approval?.run_id);i++) await advance();
    assert.equal(promotion()?.state,'READY_FOR_PROD',JSON.stringify(promotion()));
    assert.equal(promotion().binding.approval.gate,'B');
    assert.equal(w.pulls[1].head.ref,'integration');assert.equal(w.pulls[1].base.ref,'main');
    await advance();assert.equal(w.mergeCount,1,'A must not fulfill B');
  } finally {globalThis.fetch=previous;}
});

test('preflight validates exact branches, identities, checks and environments',()=>{
 const p=configuredPolicy(),f=protectionFixtures(p);
 assert.equal(evaluatePreflight(protectionFromRulesets(f.rules,p,f.environments)).ok,true);
 for(const mutate of [
  f=>{f.rules[0].bypass_actors[0].actor_id=999;},
  f=>{f.rules[0].conditions.ref_name.include=['refs/heads/unrelated'];},
  f=>{f.rules[2].rules.find(r=>r.type==='required_status_checks').parameters.required_status_checks=[];},
  f=>{f.rules[4].rules=[{type:'deletion'}];},
  f=>{f.environments['owner-acceptance'].can_admins_bypass=true;},
 ]){const copy=structuredClone(f);mutate(copy);assert.equal(evaluatePreflight(protectionFromRulesets(copy.rules,p,copy.environments)).ok,false);}
 const protection=protectionFromRulesets(f.rules,p,f.environments);
 assert.equal(decideMerge({flags:{enabled:true,mergeEnabled:true},protection,lock:null}).reason,'MERGE_LOCKED');
});

test('review schema and required tests cannot be downgraded by model',()=>{
 const expected={workflowId:1,workflowPath:'review',runId:2,runAttempt:1,policySha:MAIN,requestId:'request',repositoryId:1043384454,prNumber:38,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),contractHash:'c'.repeat(64),requiredChecks:['test']};
 const envelope={workflow_id:1,workflow_path:'review',run_id:2,run_attempt:1,policy_sha:MAIN,payload:{schema_version:1,request_id:'request',repository_id:1043384454,pr_number:38,head_sha:expected.headSha,base_sha:expected.baseSha,contract_hash:expected.contractHash,verdict:'PASS',acceptance_checks:[{id:'test',required:true,status:'PASS'}],findings:[],limitations:[]}};
 assert.equal(validateReview(envelope,expected).pass,true);
 for(const change of [p=>{p.acceptance_checks[0]={id:'test',required:false,status:'NOT_RUN'};},p=>{p.extra=true;},p=>{p.findings=[{id:'x',severity:'blocker',path:'x',line:1,description:'bad',required_fix:'fix'}];},p=>{p.acceptance_checks.push(p.acceptance_checks[0]);}]){const e=structuredClone(envelope);change(e.payload);assert.equal(validateReview(e,expected).pass,false);}
 assert.notEqual(parseContract(contractBody()+'\nGoal: A').hash,parseContract(contractBody()+'\nGoal: B').hash);
 assert.equal(parseContract('TASK: SC-TEST\nSTATUS: READY').ready,false);
});

test('live journal rejects stale records and persists hash-linked entries without force',async()=>{
 const w=httpWorld(), github=createGitHubClient({fetch:w.fetch,token:'fixture',repository:w.policy.repository,policy:w.policy});
 const a=createLiveJournal(github,'a',1),b=createLiveJournal(github,'b',1);
 await a.acquire();await assert.rejects(b.acquire(),/LOCKED/);
 const r={task_id:'SC-X',state_revision:0,state:'READY',last_transition_at:'now'};
 await a.save(r,null,null);
 await assert.rejects(a.save({...r,state:'BUILDING'},null,null),/CONFLICT/);
 await a.save({...r,state_revision:1,state:'BUILDING'},null,r);
 const tree=w.trees[w.commits[w.stateHead].tree.sha];
 const entries=Object.entries(tree).filter(([p])=>p.startsWith('journal/')).map(([,b])=>JSON.parse(w.blobs[b]));
 assert.equal(entries.length,2);assert.ok(entries.some(e=>entries.some(p=>e.previous_hash===p.entry_hash)));
 await a.release();await b.acquire();await b.release();
 assert.ok(w.calls.filter(c=>c.method==='PATCH'&&c.url.includes('/git/refs/')).every(c=>c.body.force===false));
});

test('artifact self-assertions cannot replace workflow identity from GitHub',async()=>{
 const {readEvidence}=await import('../../tools/agent-pipeline/lib/evidence.mjs');
 const w=httpWorld(),previous=globalThis.fetch;globalThis.fetch=w.fetch;
 try{
  let record;
  for(let i=0;i<25;i++){await reconcileFromEnv(w.env,{policy:w.policy});record=Object.values(w.projection())[0];if(record?.review_run_id)break;}
  const github=createGitHubClient({fetch:w.fetch,token:'fixture',repository:w.policy.repository,policy:w.policy});
  const good=await readEvidence(github,w.policy,{[record.task_id]:record});assert.ok(good[record.task_id].review);
  const run=w.runs.find(r=>r.id===record.review_run_id),original=structuredClone(run);
  for(const patch of [{actor:{id:999}},{head_sha:'f'.repeat(40)},{run_attempt:2},{workflow_id:999},{conclusion:'cancelled'},{head_branch:'feature'}]){
   Object.assign(run,original,patch);const got=await readEvidence(github,w.policy,{[record.task_id]:record});assert.equal(got[record.task_id].review,undefined,JSON.stringify(patch));
  }
  Object.assign(run,original);w.artifacts[run.id].run_id=999;
  assert.equal((await readEvidence(github,w.policy,{[record.task_id]:record}))[record.task_id].review,undefined);
 }finally{globalThis.fetch=previous;}
});

test('read retry is bounded; mutations are not blindly retried',async()=>{
 let attempts=0;const waits=[];
 const github=createGitHubClient({token:'fixture',repository:'o/r',sleep:async ms=>waits.push(ms),fetch:async()=>{attempts++;return new Response(JSON.stringify({message:'retry'}),{status:attempts===1?429:503,headers:{'retry-after':'1'}});}});
 await assert.rejects(github.readBranch('main'));assert.equal(attempts,3);assert.equal(waits.length,2);assert.ok(waits[0]>=60000&&waits[1]>=300000);
 attempts=0;await assert.rejects(github.comment({issueNumber:1,body:'x'}));assert.equal(attempts,1);
});

test('promotion refuses an unaccounted commit and a missing runbook',async()=>{
 const {preparePromotion}=await import('../../tools/agent-pipeline/lib/promotion.mjs');
 const record={task_id:'SC-X',state:'ACCEPTED',issue_number:7,base_sha:'c'.repeat(40),head_sha:'b'.repeat(40),binding:{approval:{gate:'A',digest:'x',run_id:1},merge:{mergeCommitSha:'e'.repeat(40)}}};
 let extra=false,runbook=null;
 const github={async readComparison(base,head){return {status:'ahead',commits:(head==='e'.repeat(40)?['b'.repeat(40),'e'.repeat(40),...(extra?['f'.repeat(40)]:[])]:['b'.repeat(40)]).map(sha=>({sha})),files:[{filename:'app/demo/page.tsx'}]};},async readReleasePlan(){return runbook;}};
 let result=await preparePromotion(github,configuredPolicy(),{'SC-X':record},'e'.repeat(40),MAIN);assert.equal(result.blockedReason,'MISSING_RUNBOOK');
 runbook={id:'r',operations:['merge'],rollback:'revert',smoke_tests:['health']};extra=true;
 result=await preparePromotion(github,configuredPolicy(),{'SC-X':record},'e'.repeat(40),MAIN);assert.equal(result.blockedReason,'PROMOTION_SCOPE_UNACCOUNTED');
});
