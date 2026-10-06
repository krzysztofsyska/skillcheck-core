import { generateKeyPairSync, createHash } from 'node:crypto';
import { loadPolicy } from '../../tools/agent-pipeline/lib/policy.mjs';
import { contractBody } from './helpers.mjs';
export const MAIN = 'd'.repeat(40), BASE = 'c'.repeat(40), H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), MERGED = 'e'.repeat(40);
export function configuredPolicy() {
  const p = loadPolicy(); p.controller_app_id = 123; p.controller_actor_id = 456;
  Object.keys(p.workflow_ids).forEach((key, i) => { p.workflow_ids[key] = 1000 + i; });
  p.environments.owner_acceptance.id = 800; p.environments.production_approval.id = 801;
  return p;
}
export function protectionFixtures(policy) {
  const rules = [];
  const make = (name, refs, entries, bypass = []) => { rules.push({ id: rules.length + 1, name, target: 'branch', enforcement: 'active', conditions: { ref_name: { include: refs.map(r => `refs/heads/${r}`), exclude: [] } }, rules: entries, bypass_actors: bypass }); };
  make('writers-only', ['main','integration'], [{type:'update'}], [{actor_type:'Integration', actor_id:policy.controller_app_id, bypass_mode:'pull_request'}]);
  make('state-writers', ['agent-state'], [{type:'update'}], [{actor_type:'Integration', actor_id:policy.controller_app_id, bypass_mode:'always'}]);
  for(const branch of ['main','integration']) make('quality-gates', [branch], [{type:'pull_request'},{type:'deletion'},{type:'non_fast_forward'},{type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,required_status_checks:policy.required_checks[branch].map(context=>({context,integration_id:policy.controller_app_id}))}}]);
  make('agent-state-integrity',['agent-state'],[{type:'deletion'},{type:'non_fast_forward'}]);
  const environments = {};
  for(const e of [policy.environments.owner_acceptance,policy.environments.production_approval]) environments[e.name] = {...e,can_admins_bypass:false,deployment_branch_policy:{custom_branch_policies:true},branch_policies:[{name:'main',type:'branch'}],protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{type:'User',reviewer:{id:policy.owner.id}}]}]};
  return {rules,environments};
}
const hash = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');
export const zipped = object => {
 const name=Buffer.from('result.json'), data=Buffer.from(JSON.stringify(object)), h=Buffer.alloc(30), central=Buffer.alloc(46), end=Buffer.alloc(22);
 h.writeUInt32LE(0x04034b50); h.writeUInt16LE(8,6); h.writeUInt16LE(name.length,26); // descriptor-style zero local sizes
 central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8,8); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28);
 const local=Buffer.concat([h,name,data]);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length,16);
 return Buffer.concat([local,central,name,end]);
};
export function httpWorld() {
  const policy=configuredPolicy(), protection=protectionFixtures(policy);
  const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const env={AGENT_PIPELINE_ENABLED:'true',AGENT_PIPELINE_MERGE_ENABLED:'false',GITHUB_REPOSITORY:policy.repository,AGENT_POLICY_COMMIT:MAIN,GITHUB_RUN_ID:'1',CURSOR_API_KEY:'test-cursor',AGENT_PIPELINE_APP_ID:'123',AGENT_PIPELINE_APP_INSTALLATION_ID:'9',AGENT_PIPELINE_APP_PRIVATE_KEY:privateKey};
  const w={policy,env,protection,calls:[],branches:{main:MAIN,integration:BASE},stateHead:null,blobs:{},trees:{},commits:{},pulls:[],runs:[],artifacts:{},comments:[],checks:[],cursor:null,repair:0,approveA:false,approveB:false,mergeCount:0,loseComment:false,loseMerge:false,corruptRun:false};
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const missing=()=>json({message:'not found'},404);
  function createRun(kind,inputs) {
    const id=100+w.runs.length, approved=kind==='accept'?w.approveA:kind==='promote'?w.approveB:true;
    const run={id,workflow_id:policy.workflow_ids[kind],path:policy.workflows[kind],event:'workflow_dispatch',head_branch:'main',head_sha:MAIN,actor:{id:policy.controller_actor_id},display_title:`sc-agent:${inputs.request_id}`,run_attempt:1,status:approved?'completed':'waiting',conclusion:approved?'success':null,html_url:`https://github.com/${policy.repository}/actions/runs/${id}`};
    w.runs.push(run);
    if(kind==='verify') w.artifacts[id]={workflow_id:run.workflow_id,workflow_path:run.path,run_id:id,run_attempt:1,policy_sha:MAIN,head_sha:inputs.head_sha,base_sha:inputs.base_sha,conclusion:'success',jobs:[{conclusion:'success'}],commands_executed:policy.required_ci_commands};
    else if(kind==='review') {
      const packet=JSON.parse(inputs.review_packet); const pass=w.repair>0;
      w.artifacts[id]={workflow_id:run.workflow_id,workflow_path:run.path,run_id:id,run_attempt:1,policy_sha:MAIN,payload:{schema_version:1,request_id:packet.request_id,repository_id:policy.repository_id,pr_number:packet.pr_number,head_sha:packet.head_sha,base_sha:packet.base_sha,contract_hash:packet.contract_hash,verdict:pass?'PASS':'PASS_WITH_FIXES',acceptance_checks:packet.required_checks.map(id=>({id,status:'PASS',required:true})),findings:pass?[]:[{id:'fix',severity:'minor',path:'app/demo/page.tsx',line:1,description:'fix copy',required_fix:'fix copy'}],limitations:[]}};
    } else w.artifacts[id]={request_id:inputs.request_id,digest:inputs.digest,gate:kind==='accept'?'A':'B'};
    return run;
  }
  w.fetch=async (url,options={})=>{
    const u=new URL(url), method=options.method||'GET', body=options.body?JSON.parse(options.body):null;
    w.calls.push({url:String(url),method,body});
    if(u.hostname==='api.cursor.com') {
      if(u.pathname==='/v1/agents'&&method==='POST') { if(w.cursor) return json({code:'exists'},409); const repo=body.repos[0]; if(!w.branches[repo.startingRef]) throw Error('branch missing before Cursor'); w.cursor={id:body.agentId,latestRunId:'run-1',repos:body.repos,workOnCurrentBranch:true,autoCreatePR:false};w.branch=repo.startingRef;w.branches[w.branch]=H1;return json(w.cursor); }
      if(!w.cursor)return missing();
      if(u.pathname.endsWith('/runs')&&method==='POST'){w.repair++;w.cursor.latestRunId='run-2';w.branches[w.branch]=H2;for(const p of w.pulls)if(p.head.ref===w.branch)p.head.sha=H2;return json({id:'run-2',status:'CREATING'});}
      const run={id:w.cursor.latestRunId,agentId:w.cursor.id,status:'FINISHED',createdAt:'2026-10-06T12:00:00Z',result:'done'};
      if(u.pathname.endsWith('/runs'))return json({items:[run]});
      if(u.pathname.includes('/runs/'))return json(run);
      return json(w.cursor);
    }
    if(u.hostname!=='api.github.com')throw Error(`unexpected network ${url}`);
    if(u.pathname==='/app/installations/9/access_tokens')return json({token:'synthetic-installation-token'});
    if(u.pathname==='/graphql') {w.pulls.forEach(p=>{if(p.node_id===body.variables.id)p.draft=false;});return json({data:{}});}
    const path=u.pathname.replace(`/repos/${policy.repository}`,'');
    if(path===''&&method==='GET')return json({id:policy.repository_id});
    if(path==='/rulesets')return json(protection.rules);
    if(path.startsWith('/rulesets/'))return json(protection.rules.find(r=>r.id===Number(path.split('/').at(-1))));
    if(path.startsWith('/environments/')) {const name=decodeURIComponent(path.split('/')[2]), e=protection.environments[name];return json(path.endsWith('deployment-branch-policies')?{branch_policies:e.branch_policies}:e);}
    if(path.startsWith('/branches/')){const name=decodeURIComponent(path.slice(10));return w.branches[name]?json({commit:{sha:w.branches[name]}}):missing();}
    if(path==='/issues'||path==='/issues/7') {const issue={number:7,body:contractBody(),user:{id:policy.owner.id,login:policy.owner.login}};return json(path==='/issues'?[issue]:issue);}
    if(path.startsWith('/git/ref/heads/')) {const name=path.slice(15), sha=name==='agent-state'?w.stateHead:w.branches[name];return sha?json({object:{sha}}):missing();}
    if(path.startsWith('/contents/')) {
      if(path.endsWith('production-runbook.json'))return json({content:Buffer.from(JSON.stringify({id:'release',operations:['merge main (Vercel production branch)'],rollback:'revert',smoke_tests:['health']})).toString('base64')});
      const commit=w.commits[u.searchParams.get('ref')], tree=w.trees[commit?.tree.sha], blob=tree?.[path.slice(10)];
      return blob?json({content:Buffer.from(w.blobs[blob]).toString('base64')}):missing();
    }
    if(path==='/git/blobs'&&method==='POST'){const sha=hash(body);w.blobs[sha]=body.content;return json({sha});}
    if(path==='/git/trees'&&method==='POST'){const tree={...(w.trees[body.base_tree]??{})};for(const entry of body.tree)tree[entry.path]=entry.sha;const sha=hash(tree);w.trees[sha]=tree;return json({sha});}
    if(path==='/git/commits'&&method==='POST'){const sha=hash(body);w.commits[sha]={...body,tree:{sha:body.tree}};return json({sha});}
    if(path.startsWith('/git/commits/'))return json(w.commits[path.split('/').at(-1)]);
    if(path==='/git/refs'&&method==='POST'){const name=body.ref.slice(11);if(name==='agent-state'){if(w.stateHead)return json({},422);w.stateHead=body.sha;}else {if(w.branches[name])return json({},422);w.branches[name]=body.sha;}return json({object:{sha:body.sha}});}
    if(path==='/git/refs/heads/agent-state'&&method==='PATCH'){if(body.force)throw Error('force forbidden');if(w.commits[body.sha].parents[0]!==w.stateHead)return json({},422);w.stateHead=body.sha;return json({object:{sha:body.sha}});}
    if(path.startsWith('/compare/')){const [base,head]=path.slice(9).split('...');const commits=head===MERGED?[H2,MERGED]:head===base?[]:[head];return json({status:head===base?'identical':'ahead',files:[{filename:'app/demo/page.tsx'}],commits:commits.map(sha=>({sha})),total_commits:commits.length});}
    if(path==='/pulls'&&method==='GET')return json(w.pulls.filter(p=>p.state==='open'));
    if(path==='/pulls'&&method==='POST'){const p={number:50+w.pulls.length,node_id:`node-${w.pulls.length}`,user:{id:policy.controller_actor_id},state:'open',draft:true,body:body.body,head:{ref:body.head,sha:w.branches[body.head],repo:{id:policy.repository_id}},base:{ref:body.base,sha:w.branches[body.base],repo:{id:policy.repository_id}},merged:false};w.pulls.push(p);return json(p);}
    if(/^\/pulls\/\d+$/.test(path))return json(w.pulls.find(p=>p.number===Number(path.split('/')[2])));
    if(path.endsWith('/merge')&&method==='PUT'){const p=w.pulls.find(p=>p.number===Number(path.split('/')[2]));w.mergeCount++;p.merged=true;p.state='closed';p.merge_commit_sha=MERGED;w.branches[p.base.ref]=MERGED;if(w.loseMerge){w.loseMerge=false;throw Error('lost after accepted merge');}return json({merged:true,sha:MERGED,message:'merged'});}
    if(path.includes('/actions/workflows/')){const file=decodeURIComponent(path.split('/')[3]),kind=Object.keys(policy.workflows).find(k=>policy.workflows[k].endsWith('/'+file));if(method==='POST'){createRun(kind,body.inputs);return new Response(null,{status:204});}return json({workflow_runs:w.runs.filter(r=>r.workflow_id===policy.workflow_ids[kind])});}
    if(path.startsWith('/actions/runs/')) {const id=Number(path.split('/')[3]);const run=w.runs.find(r=>r.id===id);if(!run)return json({id,status:'completed'});
      if(path.endsWith('/cancel')&&method==='POST'){run.status='completed';run.conclusion='cancelled';return new Response(null,{status:202});}
      const gate=w.artifacts[id]?.gate;if(gate==='A'&&w.approveA||gate==='B'&&w.approveB){run.status='completed';run.conclusion='success';}
      if(path.endsWith('/artifacts'))return json({artifacts:[{id,name:gate==='A'?'sc-agent-accept':gate==='B'?'sc-agent-promote':run.path.includes('verify')?'sc-agent-ci':'sc-agent-review',expired:false,workflow_run:{id}}]});
      if(path.endsWith('/jobs'))return json({jobs:[{name:'verify',conclusion:run.conclusion}]});
      if(path.endsWith('/approvals'))return json(run.status==='completed'?[{state:'approved',user:{id:policy.owner.id,type:'User'},environments:[gate==='A'?policy.environments.owner_acceptance:policy.environments.production_approval]}]:[]);
      return json(run);
    }
    if(path.startsWith('/actions/artifacts/'))return new Response(zipped(w.artifacts[Number(path.split('/')[3])]),{status:200});
    if(path.endsWith('/comments')&&method==='GET')return json(w.comments);
    if(path.endsWith('/comments')&&method==='POST'){const c={id:w.comments.length+1,body:body.body,user:{id:policy.controller_actor_id}};w.comments.push(c);if(w.loseComment){w.loseComment=false;throw Error('lost comment response');}return json(c);}
    if(path.startsWith('/issues/comments/')&&method==='PATCH'){const c=w.comments.find(c=>c.id===Number(path.split('/').at(-1)));c.body=body.body;return json(c);}
    if(path.endsWith('/check-runs')&&method==='GET')return json({check_runs:w.checks});
    if(path.startsWith('/check-runs')){let c=w.checks.find(c=>c.id===Number(path.split('/').at(-1)));if(!c){c={id:w.checks.length+1,app:{id:policy.controller_app_id}};w.checks.push(c);}Object.assign(c,body);return json(c);}
    throw Error(`Unhandled mock ${method} ${path}`);
  };
  w.projection=()=>{const tree=w.trees[w.commits[w.stateHead]?.tree.sha]??{};return Object.fromEntries(Object.entries(tree).filter(([p])=>p.startsWith('state/tasks/')).map(([p,b])=>[p,JSON.parse(w.blobs[b])]));};
  return w;
}
