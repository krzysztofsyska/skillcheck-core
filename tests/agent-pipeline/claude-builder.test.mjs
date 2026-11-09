import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, truncateSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { builderConfiguration, packetFor, validatePacket, validateBuilderFiles, createClaudeBuilderClient } from '../../tools/agent-pipeline/lib/claude-builder.mjs';
import { parseBuilderOutput, parseBuilderExecution, readBuilderExecution } from '../../tools/agent-pipeline/lib/builder-output.mjs';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { sha256 } from '../../tools/agent-pipeline/lib/canonical.mjs';
import { parseContract } from '../../tools/agent-pipeline/lib/contract.mjs';
import { taskRecord, contractBody, HEAD, BASE } from './helpers.mjs';
import { plan, fold } from '../../tools/agent-pipeline/lib/transitions.mjs';
import { observation } from './helpers.mjs';

function fixture() {
 const policy=loadPolicy();policy.builder_provider='claude-code';policy.claude_builder={enabled:true,cost_approved:true,workflow_id:999,workflow_path:'.github/workflows/claude-code-dispatch.yml',max_run_usd:1,max_total_usd:3,max_turns:12};
 const record=taskRecord({state:'BUILDING',issue_number:21,cursor_agent_id:'bc-test'});
 const body=contractBody().replace('OWNER: Cursor','OWNER: Claude Code');record.contract_hash=parseContract(body).hash;
 record.binding.dispatch={phase:'awaiting_confirmation',operationKey:'reserved-operation',started_at:'2026-11-09T00:00:00Z'};
 const packet=packetFor(record,policy,'Implement the demo');
 record.binding.builder_reservations=[{request_id:packet.request_id,limit_usd:1}];
 const runs=[],calls=[];let head=HEAD,artifact,failRef=false;
 const baseCommit={tree:{sha:BASE},parents:[]};
 const objects={[HEAD]:baseCommit};
 const github={
  readProjection:async()=>({tasks:{[record.task_id]:record}}),
  listWorkflowRuns:async()=>runs,
  readRun:async id=>runs.find(r=>r.id===id),
  readBranch:async()=>({commit:{sha:head}}),
  readIssue:async()=>({body}),
  dispatch:async input=>{calls.push({dispatch:input});const p=JSON.parse(input.inputs.builder_packet);runs.push({id:runs.length+10,workflow_id:999,path:policy.claude_builder.workflow_path,event:'workflow_dispatch',head_branch:'main',head_sha:record.policy_sha,actor:{id:policy.controller_actor_id},run_attempt:1,status:'in_progress',conclusion:null,display_title:`sc-builder:${p.agent_id}:${p.request_id}`});},
  listArtifacts:async id=>[{id:1,name:'sc-agent-build',expired:false,workflow_run:{id}}],
  downloadArtifactJson:async()=>artifact,
  request:async(path,options={})=>{
   calls.push({path,...options});
   if(path.includes('/git/commits/')&&!options.method)return objects[path.split('/').at(-1)];
   if(path.includes('/git/trees/')&&!options.method)return {truncated:false,tree:[{path:'app/demo/page.tsx',mode:'100644',sha:BASE}]};
   if(path.endsWith('/git/blobs'))return {sha:sha256(options.body).slice(0,40)};
   if(path.endsWith('/git/trees'))return {sha:sha256(options.body).slice(0,40)};
   if(path.endsWith('/git/commits')){const sha=sha256(options.body).slice(0,40);objects[sha]={...options.body,parents:options.body.parents.map(sha=>({sha})),tree:{sha:options.body.tree}};return {sha};}
   if(path.includes('/git/refs/heads/')){head=options.body.sha;if(failRef){failRef=false;throw Error('lost-ref-response');}return {};}
   throw Error('unhandled '+path);
  },
 };
 const client=createClaudeBuilderClient({github,policy,policySha:record.policy_sha});
 return {policy,record,packet,runs,calls,github,client,
  finish(){runs[0].status='completed';runs[0].conclusion='success';artifact={run_id:runs[0].id,run_attempt:1,policy_sha:record.policy_sha,packet,files:[{path:'app/demo/page.tsx',content:'export default function Demo(){return null;}'}]};},
  artifact:()=>artifact,head:()=>head,loseRef(){failRef=true;}};
}

test('disabled/unapproved budget never starts a paid operation', async()=>{
 assert.throws(()=>builderConfiguration(loadPolicy()),/CLAUDE_DISABLED/);
 for(const c of [{max_run_usd:0},{cost_approved:false},{workflow_id:null},{max_total_usd:0},{max_turns:100}]){const f=fixture();Object.assign(f.policy.claude_builder,c);await assert.rejects(f.client.createAgent({agentId:'bc-test',prompt:{text:'task'}}));assert.equal(f.calls.length,0);}
});

test('packet binds issue, revision, immutable head, policy, contract and reserved operation',()=>{
 const f=fixture();assert.equal(validatePacket(f.packet,f.record,f.policy),true);
 for(const patch of [{head_sha:BASE},{policy_sha:HEAD},{issue_number:99},{contract_hash:'forged'},{operation_key:'another'},{branch:'main'},{allowed_files:['**']}])assert.throws(()=>validatePacket({...f.packet,...patch},f.record,f.policy));
});

test('publisher rejects traversal, symlink descendants, workflows and secrets even under broad allowlist',()=>{
 for(const path of ['../x','app/../x','/etc/x','app//x','.github/workflows/x.yml','tools/agent-pipeline/x.mjs','app/AGENTS.md','app/.env','app/link/file'])assert.throws(()=>validateBuilderFiles([{path,content:'x'}],['**'],[{path:'app/link',mode:'120000'}]));
 assert.throws(()=>validateBuilderFiles([{path:'app/demo/x',content:'-----BEGIN RSA PRIVATE KEY-----'}],['app/**']));
 assert.throws(()=>validateBuilderFiles([{path:'app/demo/x',content:'\0'}],['app/**']));
 assert.equal(validateBuilderFiles([{path:'app/demo/page.tsx',content:'safe'}],['app/demo/**']),true);
});

test('deterministic dispatch adopts its existing run and does not charge twice',async()=>{
 const f=fixture(),payload={agentId:'bc-test',prompt:{text:'Implement the demo'}};
 await f.client.createAgent(payload);await f.client.createAgent(payload);
 assert.equal(f.calls.filter(c=>c.dispatch).length,1);
 const agent=await f.client.getAgent('bc-test');assert.equal(agent.latestRunId,'10');
 const listed=await f.client.listRuns('bc-test');assert.equal(listed.items[0].status,'RUNNING');
 f.runs[0].actor.id=12;await assert.rejects(f.client.getRun('bc-test',10),/BUILDER_RUN_UNTRUSTED/);
});

test('budget includes reservations under earlier policy SHAs',async()=>{
 const f=fixture();for(let i=0;i<3;i++)f.record.binding.builder_reservations.push({request_id:sha256('old-policy-'+i),limit_usd:1});
 // Workflow history may have been deleted; durable reservations still block.
 assert.equal(f.runs.length,0);
 await assert.rejects(f.client.createAgent({agentId:'bc-test',prompt:{text:'task'}}),/CLAUDE_BUDGET_EXHAUSTED/);
 assert.equal(f.calls.length,0);
});

test('read-only polling does not publish; isolated publisher recovers lost commit response exactly once',async()=>{
 const f=fixture();await f.client.createAgent({agentId:'bc-test',prompt:{text:'Implement the demo'}});f.finish();
 const polled=await f.client.getRun('bc-test',10);assert.equal(polled.git.pendingPublication,true);assert.equal(f.head(),HEAD);
 f.loseRef();await assert.rejects(f.client.publishRun('bc-test',10),/lost-ref-response/);
 const published=f.head();assert.notEqual(published,HEAD);
 const retry=await f.client.publishRun('bc-test',10);assert.equal(retry.commit,published);
 assert.equal(f.calls.filter(c=>c.path?.endsWith('/git/commits')&&c.method==='POST').length,1);
 assert.ok(f.calls.filter(c=>c.method==='PATCH').every(c=>c.body.force===false));
});

test('forged artifact identity is rejected before any Git write',async()=>{
 const f=fixture();await f.client.createAgent({agentId:'bc-test',prompt:{text:'Implement the demo'}});f.finish();f.artifact().run_id=9999;
 await assert.rejects(f.client.publishRun('bc-test',10),/BUILDER_ARTIFACT_UNTRUSTED/);
 assert.equal(f.calls.filter(c=>c.method).length,0);
});

test('existing state machine makes publication an external guarded effect before PR creation',()=>{
 const f=fixture();f.record.cursor_run_id='10';f.record.binding.dispatch={phase:'settled',action:'create'};
 const obs=observation();obs.issue={number:21,body:contractBody().replace('OWNER: Cursor','OWNER: Claude Code')};
 obs.cursor={agent:{latestRunId:'10'},runs:[{id:'10',status:'FINISHED',git:{pendingPublication:true}}]};
 const result=plan(f.record,obs);assert.equal(result.effects[0].type,'cursor.publish');assert.equal(result.effects[0].external,true);
 const next=fold(f.record,result.effects[0],{commit:BASE,runId:'10'},obs);assert.equal(next.binding.builder_published_run_id,'10');
});

test('model workflow has no GitHub write token and no direct label scheduler',()=>{
 const file='.github/workflows/claude-code-dispatch.yml';const r=spawnSync('python3',['-c','import json,yaml,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const w=JSON.parse(r.stdout);assert.deepEqual(w.jobs.model.permissions,{contents:'read',issues:'read',actions:'read'});
 const source=readFileSync(file,'utf8');assert.equal(source.includes('id-token: write'),false);assert.equal(source.includes('APP_PRIVATE_KEY'),false);assert.equal(source.includes('issues:\n    types'),false);
 assert.match(source,/base-action@61a9c274fa7110a66dfafc1bbbced03833eb25fe/);assert.match(source,/max-budget-usd/);assert.match(source,/--tools Read,Glob,Grep/);assert.match(source,/steps.builder.outputs.execution_file/);assert.match(source,/--setting-sources user/);assert.match(source,/prepare-builder-source/);assert.equal(source.includes('--tools Read,Edit'),false);
 assert.equal(parseContract('TASK: SC-020\nOWNER: Claude Code\nSTATUS: READY').ready,false);
 const model=w.jobs.model.steps.find(step=>step.id==='builder');
 assert.match(model.with.claude_args,/--restricted(?:\s|$)/);
 assert.match(model.with.claude_args,/--strict-mcp-config/);
 assert.match(model.with.claude_args,/--mcp-config '\{"mcpServers":\{\}\}'/);
 assert.equal(/--add-dir|--settings\s|bypassPermissions|skip-permissions|--plugin/.test(model.with.claude_args),false);
});

test('full Claude controller repairs, merges, blocks on post-merge CI and automatically starts next approved task', async()=>{
 const {httpWorld}=await import('./http-world.mjs');
 const {reconcileFromEnv}=await import('../../tools/agent-pipeline/lib/reconcile.mjs');
 const w=httpWorld({claude:true}),previous=globalThis.fetch;globalThis.fetch=w.fetch;
 w.loseBuilderDispatch=true;w.loseBuilderRef=true;
 const task=()=>Object.values(w.projection()).find(r=>r.task_id==='SC-DEMO-001');
 try {
  for(let i=0;i<90&&task()?.state!=='READY_FOR_OWNER';i++)await reconcileFromEnv(w.env,{policy:w.policy});
  assert.equal(task()?.state,'READY_FOR_OWNER',JSON.stringify(task()));
  assert.equal(task().repair_round,1);
  assert.equal(w.pulls.length,1);assert.equal(w.pulls[0].draft,true);assert.equal(w.pulls[0].base.ref,'integration');
  assert.equal(w.calls.some(c=>c.url.includes('api.cursor.com')),false);
  const builds=w.runs.filter(r=>r.workflow_id===w.policy.claude_builder.workflow_id);
  assert.equal(builds.length,2);assert.equal(task().binding.known_run_ids.length,2);
  assert.equal(task().binding.builder_reservations.length,2);
  assert.equal(w.calls.filter(c=>c.method==='PATCH'&&c.url.includes('/git/refs/heads/feat/')).length,2, 'lost responses recovered without duplicate commit publication');
  assert.ok(w.runs.some(r=>r.workflow_id===w.policy.workflow_ids.verify));
  assert.ok(w.runs.some(r=>r.workflow_id===w.policy.workflow_ids.review));
  assert.equal(w.mergeCount,0);
  w.extraIssues.push({number:81,user:{id:w.policy.owner.id,login:w.policy.owner.login},body:contractBody().replace('SC-DEMO-001','SC-DEMO-002').replace('OWNER: Cursor','OWNER: Claude Code').replace('DEPENDS_ON: NONE','DEPENDS_ON: SC-DEMO-001')});
  const second=()=>Object.values(w.projection()).find(r=>r.task_id==='SC-DEMO-002');
  w.env.AGENT_PIPELINE_MERGE_ENABLED='true';
  for(let i=0;i<20&&w.mergeCount===0;i++)await reconcileFromEnv(w.env,{policy:w.policy});
  assert.equal(w.mergeCount,1,JSON.stringify(task()));
  assert.equal(w.pulls[0].merged,true);assert.equal(w.pulls[0].draft,false);
  const merged=task().binding.merge.mergeCommitSha;
  const post=w.runs.find(r=>r.workflow_id===w.policy.post_merge_ci.workflow_id&&r.head_sha===merged);
  assert.ok(post);post.status='in_progress';post.conclusion=null;
  for(let i=0;i<4;i++)await reconcileFromEnv(w.env,{policy:w.policy});
  assert.equal(task().technical_state,'WAITING_POST_MERGE_CI');assert.equal(second(),undefined);
  assert.equal(w.runs.filter(r=>r.workflow_id===w.policy.claude_builder.workflow_id).length,2);
  post.status='completed';post.conclusion='failure';
  for(let i=0;i<4;i++)await reconcileFromEnv(w.env,{policy:w.policy});
  assert.equal(task().state,'BLOCKED');assert.equal(task().binding.post_merge_ci.blocked,true);assert.equal(second(),undefined);
  assert.equal(w.runs.filter(r=>r.workflow_id===w.policy.claude_builder.workflow_id).length,2);
  post.conclusion='success';post.run_attempt=2;
  for(let i=0;i<20&&w.runs.filter(r=>r.workflow_id===w.policy.claude_builder.workflow_id).length<3;i++)await reconcileFromEnv(w.env,{policy:w.policy});
  assert.equal(task().state,'ACCEPTED');assert.equal(task().technical_state,null);
  assert.equal(task().binding.post_merge_ci.headSha,merged);assert.equal(task().binding.post_merge_ci.runAttempt,2);
  assert.equal(second()?.state,'BUILDING',JSON.stringify(second()));assert.equal(second().base_sha,merged);
  assert.equal(w.runs.filter(r=>r.workflow_id===w.policy.claude_builder.workflow_id).length,3);
  assert.equal(w.mergeCount,1);assert.equal(w.branches.main,'d'.repeat(40));
 } finally {globalThis.fetch=previous;}
});


test('structured model output is parsed as file data and rejects malformed/oversized output',()=>{
 for(const value of [undefined,'','not-json','null','[]','{}',JSON.stringify({files:[],extra:'x'}),'x'.repeat(1600*1024)])assert.throws(()=>parseBuilderOutput(value,['app/**']));
 const output={files:[{path:'app/demo/page.tsx',content:'export default function Demo(){return null;}'}]};
 assert.deepEqual(parseBuilderOutput(JSON.stringify(output),['app/**']),output.files);
 const collector=readFileSync('tools/agent-pipeline/collect-builder.mjs','utf8');
 assert.equal(/child_process|\bspawn\(|\bexec\(|\beval\(|import\(/.test(collector),false);
 const prep=readFileSync('tools/agent-pipeline/prepare-builder-source.mjs','utf8');
 assert.match(prep,/cat-file/);assert.match(prep,/\\.claude/);assert.match(prep,/\\.mcp/);
});

test('execution log parser accepts only the pinned action successful final result',()=>{
 const result={type:'result',subtype:'success',is_error:false,structured_output:{files:[{path:'app/demo/a.ts',content:'safe'}]}};
 assert.deepEqual(parseBuilderExecution(JSON.stringify([{type:'system',subtype:'init'},result]),['app/**']),result.structured_output.files);
 for(const value of [undefined,'','not-json','{}','[]',JSON.stringify([null]),JSON.stringify([result,result]),JSON.stringify([result,{type:'assistant'}]),JSON.stringify([{...result,is_error:true}]),JSON.stringify([{...result,subtype:'error_max_turns'}]),JSON.stringify([{type:'result',subtype:'success',is_error:false}])])assert.throws(()=>parseBuilderExecution(value,['app/**']));
});

test('collector transports more than 128 KiB through a bounded file and never publishes execution logs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sc-builder-output-')),execution=join(dir,'claude-execution-output.json');
 const files=[{path:'app/demo/large.ts',content:'x'.repeat(180*1024)}];
 try {
  writeFileSync(join(dir,'builder-packet.json'),JSON.stringify({policy_sha:HEAD,allowed_files:['app/**']}));
  writeFileSync(execution,JSON.stringify([{type:'assistant',message:'private-log-sentinel'},{type:'result',subtype:'success',is_error:false,structured_output:{files}}]));
  const result=spawnSync(process.execPath,[resolve('tools/agent-pipeline/collect-builder.mjs')],{cwd:dir,encoding:'utf8',env:{...process.env,BUILDER_EXECUTION_FILE:execution,RUNNER_TEMP:dir,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
  const artifact=readFileSync(join(dir,'build-result.json'),'utf8');
  assert.deepEqual(JSON.parse(artifact).files,files);assert.equal(artifact.includes('private-log-sentinel'),false);
  assert.throws(()=>readBuilderExecution(join(dir,'other.json'),dir,['app/**']),/PATH_INVALID/);
  truncateSync(execution,33*1024*1024);assert.throws(()=>readBuilderExecution(execution,dir,['app/**']),/TOO_LARGE/);
  rmSync(execution);assert.throws(()=>readBuilderExecution(execution,dir,['app/**']));
  symlinkSync(join(dir,'builder-packet.json'),execution);assert.throws(()=>readBuilderExecution(execution,dir,['app/**']));
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('actual source exporter excludes model startup config and Git metadata',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sc-builder-source-')),task=join(dir,'task');mkdirSync(task);
 const run=(command,args,cwd=task)=>{const result=spawnSync(command,args,{cwd,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result;};
 try{
  run('git',['init']);run('git',['config','user.name','Test']);run('git',['config','user.email','test@example.invalid']);
  mkdirSync(join(task,'.claude'));writeFileSync(join(task,'.claude/settings.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'touch executed'}]}]}}));
  writeFileSync(join(task,'.mcp.json'),'untrusted');writeFileSync(join(task,'CLAUDE.md'),'project guidance');writeFileSync(join(task,'code.ts'),'export const answer=42;');
  run('git',['add','.']);run('git',['commit','-m','fixture']);
  run(process.execPath,[resolve('tools/agent-pipeline/prepare-builder-source.mjs')],dir);
  assert.equal(readFileSync(join(dir,'builder-source/code.ts'),'utf8'),'export const answer=42;');
  assert.equal(existsSync(join(dir,'builder-source/.git')),false);assert.equal(existsSync(join(dir,'builder-source/.claude')),false);
  assert.equal(existsSync(join(dir,'builder-source/.mcp.json')),false);assert.equal(existsSync(join(dir,'builder-source/CLAUDE.md')),false);
  assert.equal(existsSync(join(dir,'builder-source/CLAUDE.md.txt')),true);assert.equal(existsSync(join(task,'executed')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
