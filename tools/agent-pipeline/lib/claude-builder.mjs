import { controlPlane } from './control-plane.mjs';
import { sha256 } from './canonical.mjs';
import { parseContract } from './contract.mjs';
import { filesOutside } from './scope.mjs';
import { artifactFromRun } from './evidence.mjs';

const SHA = /^[a-f0-9]{40}$/;
const deny = reason => { const error = new Error(reason); error.code = reason; throw error; };
export function builderConfiguration(policy) {
  const c = policy.claude_builder;
  if (policy.builder_provider !== 'claude-code' || c?.enabled !== true) deny('CLAUDE_DISABLED');
  if (!Number.isSafeInteger(c.workflow_id) || c.workflow_id <= 0 || c.workflow_path !== '.github/workflows/claude-code-dispatch.yml') deny('CLAUDE_WORKFLOW_UNCONFIGURED');
  if (c.cost_approved !== true || !(c.max_run_usd > 0 && c.max_run_usd <= 20)
      || !(c.max_total_usd >= c.max_run_usd && c.max_total_usd <= 100)
      || !Number.isInteger(c.max_turns) || c.max_turns < 1 || c.max_turns > 30) deny('CLAUDE_BUDGET_UNAPPROVED');
  return c;
}

export function reservedBuilderBudget(records) {
  let sum=0; const seen=new Set();
  for(const record of records) for(const reservation of record.binding?.builder_reservations??[]) {
    if(!/^[a-f0-9]{64}$/.test(reservation.request_id??'')||!(reservation.limit_usd>0)||seen.has(reservation.request_id)) return Infinity;
    seen.add(reservation.request_id);sum+=reservation.limit_usd;
  }
  return sum;
}
export function requireBudgetReservation(record,packet,policy,records) {
  const config=builderConfiguration(policy);
  const reservation=record.binding?.builder_reservations?.find(r=>r.request_id===packet.request_id);
  if(!reservation || reservation.limit_usd!==config.max_run_usd || reservedBuilderBudget(records)>config.max_total_usd)deny('CLAUDE_BUDGET_EXHAUSTED');
}

export function packetFor(record, policy, prompt) {
  const dispatch = record.binding?.dispatch;
  if (!record.cursor_agent_id || !dispatch?.operationKey || !['awaiting_confirmation','armed'].includes(dispatch.phase)) deny('BUILDER_INTENT_MISSING');
  return { schema_version:1, task_id:record.task_id, task_revision:record.task_revision,
    repository_id:record.repository_id, issue_number:record.issue_number,
    agent_id:record.cursor_agent_id, operation_key:dispatch.operationKey,
    request_id:sha256(dispatch.operationKey), contract_hash:record.contract_hash,
    policy_sha:record.policy_sha, base_sha:record.base_sha, head_sha:record.head_sha ?? record.base_sha,
    branch:record.binding.branch, allowed_files:record.binding.allowed_files, prompt };
}
export function validatePacket(packet, record, policy) {
  if (!packet || !record || packet.schema_version !== 1 || packet.repository_id !== policy.repository_id
      || packet.task_id !== record.task_id || packet.task_revision !== record.task_revision
      || packet.agent_id !== record.cursor_agent_id || packet.issue_number !== record.issue_number
      || ![21,81].includes(packet.issue_number) || packet.contract_hash !== record.contract_hash
      || packet.policy_sha !== record.policy_sha || packet.base_sha !== record.base_sha
      || packet.head_sha !== (record.head_sha ?? record.base_sha)
      || packet.operation_key !== (record.binding.dispatch?.operationKey ?? record.binding.builder_operation)
      || packet.branch !== record.binding.branch || !/^feat\/sc-[a-z0-9-]+$/.test(packet.branch ?? '')
      || !SHA.test(packet.head_sha) || !SHA.test(packet.base_sha) || !SHA.test(packet.policy_sha)
      || packet.request_id !== sha256(packet.operation_key ?? '')
      || JSON.stringify(packet.allowed_files) !== JSON.stringify(record.binding.allowed_files)
      || typeof packet.prompt !== 'string' || !packet.prompt || packet.prompt.length > 40000) deny('BUILDER_PACKET_MISMATCH');
  return true;
}
export function validateBuilderFiles(files, allowed, baseTree = []) {
  if (!Array.isArray(files) || !files.length || files.length > 100) deny('BUILDER_FILES_INVALID');
  const seen=new Set();let size=0;
  const unsafe=baseTree.filter(e=>['120000','160000'].includes(e.mode)).map(e=>e.path);
  for(const file of files) {
    const path=file?.path;
    if(typeof path!=='string' || !/^[A-Za-z0-9_@().\[\] /-]+$/.test(path)
      || path.startsWith('/') || path.includes('//') || path.split('/').some(p=>!p||p==='.'||p==='..')
      || seen.has(path) || /(^|\/)(\.github|\.git|\.claude|\.cursor|AGENTS\.md|CLAUDE\.md|\.env(?:\..*)?)($|\/)/i.test(path)
      || path.startsWith('tools/agent-pipeline/') || unsafe.some(p=>path===p||path.startsWith(p+'/'))
      || filesOutside([path],allowed).length) deny('BUILDER_SCOPE_VIOLATION');
    seen.add(path);
    if(file.content!==null && (typeof file.content!=='string'||file.content.includes('\0'))) deny('BUILDER_CONTENT_INVALID');
    if(typeof file.content==='string' && /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{15,})/.test(file.content)) deny('BUILDER_SECRET_DETECTED');
    size+=Buffer.byteLength(file.content??'');
    if(size>1024*1024 || Buffer.byteLength(file.content??'')>256*1024) deny('BUILDER_ARTIFACT_TOO_LARGE');
  }
  return true;
}

export function createClaudeBuilderClient({ github, policy, policySha }) {
  const root=`/repos/${policy.repository}`;
  const trusted=run=>run.workflow_id===policy.claude_builder?.workflow_id && run.path===policy.claude_builder?.workflow_path
    && run.event==='workflow_dispatch' && run.head_branch===controlPlane(policy).branch && run.head_sha===policySha
    && run.actor?.id===policy.controller_actor_id && run.run_attempt===1;
  async function recordFor(agentId) {
    const records=Object.values((await github.readProjection()).tasks);
    const matches=records.filter(r=>r.cursor_agent_id===agentId);
    if(matches.length!==1)deny('BUILDER_RECORD_AMBIGUOUS');return matches[0];
  }
  async function runsFor(agentId) {
    const runs=await github.listWorkflowRuns('claude-code-dispatch.yml');
    return runs.filter(r=>trusted(r)&&r.display_title?.startsWith(`sc-builder:${agentId}:`));
  }
  async function start(agentId,prompt) {
    const config=builderConfiguration(policy),record=await recordFor(agentId),packet=packetFor(record,policy,prompt);
    validatePacket(packet,record,policy);
    if(record.policy_sha!==policySha)deny('BUILDER_POLICY_STALE');
    const listed=await github.listWorkflowRuns('claude-code-dispatch.yml');
    const all=listed.filter(trusted);
    requireBudgetReservation(record,packet,policy,Object.values((await github.readProjection()).tasks));
    const title=`sc-builder:${agentId}:${packet.request_id}`;
    const existing=all.filter(r=>r.display_title===title);
    if(existing.length>1)deny('BUILDER_DISPATCH_AMBIGUOUS');
    if(existing.length===1)return {agent:{id:agentId,latestRunId:String(existing[0].id)},run:{id:String(existing[0].id)}};
    if(all.some(r=>r.display_title?.startsWith(`sc-builder:${agentId}:`)&&r.status!=='completed'))deny('BUILDER_BUSY');
    if(all.filter(r=>r.display_title?.startsWith(`sc-builder:${agentId}:`)).length>=policy.limits.repair_rounds+1)deny('CLAUDE_RUN_LIMIT');
    await github.dispatch({workflow:'claude-code-dispatch.yml',ref:controlPlane(policy).branch,inputs:{request_id:packet.request_id,agent_id:agentId,builder_packet:JSON.stringify(packet)}});
    return {agent:{id:agentId},run:null};
  }
  async function publish(run,record) {
    const artifact=await artifactFromRun(github,run,'sc-agent-build');
    if(!artifact||artifact.run_id!==run.id||artifact.run_attempt!==1||artifact.policy_sha!==policySha)deny('BUILDER_ARTIFACT_UNTRUSTED');
    const packet=artifact.packet;
    validatePacket(packet,record,policy);
    if(run.display_title!==`sc-builder:${record.cursor_agent_id}:${packet.request_id}`)deny('BUILDER_REQUEST_MISMATCH');
    const issue=await github.readIssue(record.issue_number);
    if(parseContract(issue.body).hash!==record.contract_hash)deny('CONTRACT_EDITED');
    const head=(await github.readBranch(packet.branch)).commit.sha;
    const marker=`sc-builder:${packet.request_id}`;
    if(head!==packet.head_sha) {
      const previous=await github.request(`${root}/git/commits/${head}`);
      if(previous.message!==marker || previous.parents?.length!==1 || previous.parents[0].sha!==packet.head_sha)deny('BUILDER_BRANCH_MOVED');
      // A lost response may have published this exact operation. Verify tree,
      // not marker text alone, before adopting it as a successful commit.
      const expected=await buildTree(packet,artifact.files);
      if(previous.tree?.sha!==expected)deny('BUILDER_RECOVERY_MISMATCH');
      return head;
    }
    const tree=await buildTree(packet,artifact.files);
    const current=await recordFor(record.cursor_agent_id);
    validatePacket(packet,current,policy);
    if((await github.readBranch(packet.branch)).commit.sha!==packet.head_sha)deny('BUILDER_BRANCH_MOVED');
    const commit=await github.request(`${root}/git/commits`,{method:'POST',body:{message:marker,tree,parents:[packet.head_sha]}});
    await github.request(`${root}/git/refs/heads/${packet.branch}`,{method:'PATCH',body:{sha:commit.sha,force:false}});
    return commit.sha;
  }
  async function buildTree(packet,files) {
    const base=await github.request(`${root}/git/commits/${packet.head_sha}`);
    const tree=await github.request(`${root}/git/trees/${base.tree.sha}?recursive=1`);
    if(tree.truncated!==false||!Array.isArray(tree.tree))deny('BUILDER_TREE_INCOMPLETE');
    validateBuilderFiles(files,packet.allowed_files,tree.tree);
    const items=[];
    for(const file of files) {
      if(file.content===null)items.push({path:file.path,mode:'100644',type:'blob',sha:null});
      else {const blob=await github.request(`${root}/git/blobs`,{method:'POST',body:{encoding:'utf-8',content:file.content}});items.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}
    }
    return (await github.request(`${root}/git/trees`,{method:'POST',body:{base_tree:base.tree.sha,tree:items}})).sha;
  }
  async function inspect(agentId,runId) {
    const run=await github.readRun(Number(runId));
    if(!trusted(run)||!run.display_title?.startsWith(`sc-builder:${agentId}:`))deny('BUILDER_RUN_UNTRUSTED');
    let status=run.status==='completed'?(run.conclusion==='success'?'FINISHED':'ERROR'):'RUNNING';
    const record=await recordFor(agentId);
    const operation=record.binding.dispatch?.operationKey ?? record.binding.builder_operation;
    const operationVerified=run.display_title===`sc-builder:${agentId}:${sha256(operation??'')}`;
    return {id:String(run.id),status,createdAt:run.created_at,operationVerified,git:status==='FINISHED'?{pendingPublication:true}:null};
  }
  return {
    async publishRun(agentId,runId){const run=await github.readRun(Number(runId));if(!trusted(run)||run.status!=='completed'||run.conclusion!=='success')deny('BUILDER_RUN_UNTRUSTED');return {commit:await publish(run,await recordFor(agentId)),runId:String(runId)};},
    async createAgent(payload){return start(payload.agentId,payload.prompt.text);},
    async createRun(agentId,payload){const result=await start(agentId,payload.prompt.text);return result.run??{pending:true};},
    async getAgent(agentId){const record=await recordFor(agentId),runs=await runsFor(agentId);runs.sort((a,b)=>b.id-a.id);return {id:agentId,latestRunId:runs[0]?String(runs[0].id):null,repos:[{url:policy.repository_url,startingRef:record.binding.branch}],workOnCurrentBranch:true,autoCreatePR:false};},
    async listRuns(agentId){return {items:await Promise.all((await runsFor(agentId)).map(r=>inspect(agentId,r.id)))};},
    async getRun(agentId,runId){return inspect(agentId,runId);},
  };
}
