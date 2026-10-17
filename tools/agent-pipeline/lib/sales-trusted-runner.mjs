/** Trusted-main release gates: candidate-bound checks and native approvals.
 * No merge or deployment. Candidate Git objects are never executed.
 * The optional evidence broker runs outside Actions with a separate identity. */
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as signBytes, verify as verifySignature } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSalesReleaseGit } from './sales-release-verified.mjs';

const owner='krzysztofsyska', repo='skillcheck-core', full=owner+'/'+repo;
const releaseRef='release/sales-mvp-intake-20261013';
const sha40=/^[0-9a-f]{40}$/;
// Observed on this repository's Checks and Agent Gates check runs. This is a
// GitHub App identity, not a caller-supplied permission to publish a result.
const GITHUB_ACTIONS_APP_ID=15368;
function deny(message){throw new Error('SALES_RELEASE_SCOPE_DENIED: '+message);}
async function github(path) {
  const token=process.env.GITHUB_TOKEN;
  if(typeof token!=='string'||token.length<12)deny('read-only GitHub token missing');
  const response=await fetch('https://api.github.com/repos/'+full+'/'+path,{
    method:'GET',redirect:'error',headers:{'Authorization':'Bearer '+token,
      'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(8000),
  });
  if(!response.ok)deny('GitHub rules/PR evidence inaccessible: HTTP '+response.status);
  return response.json();
}
function mainRuleMatches(rule) {
  const refs=rule?.conditions?.ref_name;
  if(!refs||!Array.isArray(refs.include)||!Array.isArray(refs.exclude))return false;
  // The repository default can change. Only an explicit main selector is
  // evidence for main; ~DEFAULT_BRANCH alone may describe another branch.
  const include=refs.include.includes('refs/heads/main');
  // This narrow policy accepts no exclusions. Literal checks miss wildcard
  // exclusions such as refs/heads/* and can mistake an inapplicable rule for
  // protection of main. Unknown patterns must not supply security evidence.
  return include && refs.exclude.length===0;
}
function hasRequiredContext(types,context,appId=GITHUB_ACTIONS_APP_ID) {
  return types.some(r=>r.type==='required_status_checks'&&
    r.parameters?.strict_required_status_checks_policy===true&&
    Array.isArray(r.parameters.required_status_checks)&&
    r.parameters.required_status_checks.some(x=>x?.context===context&&
      x.integration_id===appId));
}
async function verifyProtection(provided) {
  const branch=provided?.branch ?? await github('branches/main');
  if(branch.protected!==true)deny('main is not protected');
  const summaries=provided?.rules ?? await github('rulesets?includes_parents=true');
  if(!Array.isArray(summaries)||summaries.length>40)deny('ruleset list missing or excessive');
  const effective=[];
  for(const item of summaries) {
    if(item.enforcement!=='active'||!Number.isInteger(item.id))continue;
    const rule=provided ? item : await github('rulesets/'+item.id);
    if(rule.enforcement==='active'&&rule.target==='branch'&&mainRuleMatches(rule)) {
      // A read-scoped response may omit this sensitive field. Missing is
      // unknown, never proof of an empty list; do not elevate the token here.
      if(!Array.isArray(rule.bypass_actors))deny('main ruleset bypass evidence missing');
      if(rule.bypass_actors.length)deny('main ruleset has bypass actors');
      effective.push(...(Array.isArray(rule.rules)?rule.rules:[]));
    }
  }
  for(const kind of ['deletion','non_fast_forward','pull_request','required_status_checks'])
    if(!effective.some(x=>x.type===kind))deny('main ruleset missing '+kind);
  if(!['verify','Checks / verify','Checks'].some(x=>hasRequiredContext(effective,x)))
    deny('main does not require Checks CI');
  if(!hasRequiredContext(effective,'Agent contract / scope gate'))
    deny('main does not require Agent Gates');
  const publisher=provided?.publisherAppId ?? Number(process.env.SALES_RELEASE_PUBLISHER_APP_ID);
  if(!Number.isSafeInteger(publisher)||publisher<=0||publisher===GITHUB_ACTIONS_APP_ID)deny('Dedicated release publisher unconfigured');
  if(!hasRequiredContext(effective,'Sales selective scope verified',publisher))
    deny('main does not require trusted sales scope check');
  for(const context of ['Sales owner acceptance','Sales production approval'])
    if(!hasRequiredContext(effective,context,publisher))deny('main does not require '+context);
  if(!effective.some(x=>x.type==='pull_request' &&
      Number.isInteger(x.parameters?.required_approving_review_count) &&
      x.parameters.required_approving_review_count>=1 &&
      x.parameters.dismiss_stale_reviews_on_push===true&&
      x.parameters.require_last_push_approval===true&&
      x.parameters.required_review_thread_resolution===true))
    deny('main lacks independent approval/stale review dismissal');
  return true;
}
export async function checkTrustedSalesRelease({event,cwd='.'}) {
  const pr=event?.pull_request;
  if(event?.repository?.full_name!==full||!pr||pr.number!==120||
      pr.base?.ref!=='main'||pr.head?.ref!==releaseRef||
      pr.head?.repo?.full_name!==full||!sha40.test(pr.head?.sha||'')||
      !sha40.test(pr.base?.sha||''))deny('Unexpected PR/repo/branch identity');
  await verifyProtection();
  const live=await github('pulls/120');
  if(live.state!=='open'||live.draft!==false||live.base?.ref!=='main'||
      live.head?.ref!==releaseRef||live.head?.sha!==pr.head.sha||
      live.head?.repo?.full_name!==full||live.base?.sha!==pr.base.sha)
    deny('PR moved, is draft, or GitHub identity changed');
  const inspected=inspectSalesReleaseGit({cwd,baseSha:pr.base.sha,headSha:pr.head.sha,headRef:releaseRef});
  if(!inspected.ok)deny('Git history/blobs rejected: '+inspected.errors.join('; ').slice(0,500));
  if(inspected.authorizedForProduction!==false)deny('Inspector improperly grants Production');
  return {scopeVerified:true,authorizedForProduction:false};
}

// Fetch Git data from the fixed repository using the existing read-only token.
// Command-scoped environment config is not written to .git/config or disk.
export function fetchTrustedRelease({cwd='.',env=process.env}={}) {
  const token=env.GITHUB_TOKEN;
  if(typeof token!=='string'||token.length<12)deny('read-only GitHub token missing');
  const gitEnv={...env};
  for(const key of Object.keys(gitEnv)) {
    if(key==='GITHUB_TOKEN'||key==='GIT_CURL_VERBOSE'||key==='GIT_CONFIG_PARAMETERS'||
       key.startsWith('GIT_TRACE')||/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key))
      delete gitEnv[key];
  }
  Object.assign(gitEnv,{
    GIT_TERMINAL_PROMPT:'0',
    GIT_CONFIG_COUNT:'3',
    GIT_CONFIG_KEY_0:'http.https://github.com/'+full+'.git.extraheader',
    GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64'),
    GIT_CONFIG_KEY_1:'credential.helper',GIT_CONFIG_VALUE_1:'',
    GIT_CONFIG_KEY_2:'http.followRedirects',GIT_CONFIG_VALUE_2:'false',
  });
  try {
    execFileSync('git',['fetch','--no-tags','--no-recurse-submodules','--',
      'https://github.com/'+full+'.git',
      '+refs/heads/'+releaseRef+':refs/heads/'+releaseRef],
      {cwd,env:gitEnv,timeout:60000,stdio:['ignore','ignore','pipe']});
  } catch {
    // Provider output can contain URLs/credentials; never forward it.
    deny('authenticated release fetch failed');
  }
}


// The only repository writes in this runner are candidate-bound check runs.
// No token for merging, approving deployments or changing rules is required.
export const SALES_CHECKS = Object.freeze({
  scope: 'Sales selective scope verified',
  owner: 'Sales owner acceptance',
  production: 'Sales production approval',
});
const REPOSITORY_ID = 1043384454;
const OWNER_ID = 222297538;
const WORKFLOW = '.github/workflows/sales-selective-scope.yml';
const workflowRef = `${full}/${WORKFLOW}@refs/heads/main`;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createSalesGitHub({token, fetchImpl=fetch}) {
  if(typeof token!=='string'||token.length<12)deny('GitHub token missing');
  return async (path, options={}) => {
    const method=options.method??'GET';
    // Callers cannot turn this adapter into a generic mutation/URL proxy.
    if(typeof path!=='string'||path.startsWith('/')||path.includes('..')||path.includes('#')||path.includes('://'))deny('Invalid API path');
    if(method!=='GET' && !(method==='POST'&&path==='check-runs') &&
       !(method==='PATCH'&&/^check-runs\/[1-9][0-9]*$/.test(path)))deny('Forbidden API mutation');
    let response;
    try {
      response=await fetchImpl(`https://api.github.com/repos/${full}/${path}`,{
        method, redirect:'error', signal:AbortSignal.timeout(8000),
        headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json',
          'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
        ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),
      });
    } catch { deny('GitHub transport unavailable'); }
    if(!response.ok)deny(`GitHub evidence/publication HTTP ${response.status}`);
    return boundedJson(response, 1024*1024);
  };
}

async function boundedJson(response, limit) {
  if(!response.body?.getReader)deny('Response body missing');
  const reader=response.body.getReader();
  const chunks=[];let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit)deny('Response too large');chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { await reader.cancel().catch(()=>{});deny('Invalid or oversized JSON response'); }
  finally { reader.releaseLock(); }
}

export function validateSalesBinding(binding) {
  if(!binding||Object.keys(binding).length!==9||binding.version!==1||binding.repositoryId!==REPOSITORY_ID||binding.pr!==120||
      !sha40.test(binding.head??'')||!sha40.test(binding.base??'')||binding.head===binding.base||
      !positiveId(binding.runId)||!positiveId(binding.attempt)||
      !positiveId(binding.publisherAppId)||binding.publisherAppId===GITHUB_ACTIONS_APP_ID||
      !['pull_request_target','push','workflow_dispatch'].includes(binding.event))deny('Invalid release binding');
  return binding;
}

export async function captureSalesBinding({event,env,api}) {
  if(env.GITHUB_REPOSITORY!==full||env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_WORKFLOW_REF!==workflowRef||env.GITHUB_WORKFLOW_SHA!==env.GITHUB_SHA||
      !sha40.test(env.GITHUB_SHA??'')||event?.repository?.id!==REPOSITORY_ID||
      event.repository.full_name!==full)deny('Untrusted workflow execution');
  const kind=env.GITHUB_EVENT_NAME;
  if(!['pull_request_target','push','workflow_dispatch'].includes(kind))deny('Untrusted workflow event');
  const pull=kind==='pull_request_target'?event.pull_request:await api('pulls/120');
  if(pull?.number!==120||pull.base?.ref!=='main'||pull.base.sha!==env.GITHUB_SHA||
      pull.head?.ref!==releaseRef||pull.head?.repo?.id!==REPOSITORY_ID||pull.head.repo.fork!==false||
      pull.base?.repo?.id!==REPOSITORY_ID)deny('Unexpected candidate identity');
  if(kind==='workflow_dispatch'&&(event.inputs?.expected_head!==pull.head.sha||
      event.inputs?.expected_base!==pull.base.sha))deny('Dispatch target moved');
  const binding=validateSalesBinding({version:1,repositoryId:REPOSITORY_ID,pr:120,
    head:pull.head.sha,base:pull.base.sha,runId:Number(env.GITHUB_RUN_ID),
    attempt:Number(env.GITHUB_RUN_ATTEMPT),event:kind,publisherAppId:Number(env.SALES_RELEASE_PUBLISHER_APP_ID)});
  await assertLiveSalesBinding(binding,api);
  return binding;
}

export async function assertLiveSalesBinding(binding,api) {
  validateSalesBinding(binding);
  const [pull,branch,run]=await Promise.all([
    api('pulls/120'),api('branches/main'),api(`actions/runs/${binding.runId}`),
  ]);
  if(pull.number!==120||pull.state!=='open'||pull.draft!==false||pull.merged===true||
      pull.base?.ref!=='main'||pull.base?.sha!==binding.base||pull.base?.repo?.id!==REPOSITORY_ID||
      pull.head?.ref!==releaseRef||pull.head?.sha!==binding.head||pull.head?.repo?.id!==REPOSITORY_ID||
      pull.head.repo.fork!==false||branch.commit?.sha!==binding.base||branch.protected!==true)
    deny('Candidate head/base/protection changed');
  if(run.id!==binding.runId||run.run_attempt!==binding.attempt||run.event!==binding.event||
      run.head_sha!==binding.base||run.repository?.id!==REPOSITORY_ID||
      run.status!=='in_progress')deny('Workflow run binding changed');
  await assertSalesWorkflow(run,api);
}

async function assertSalesWorkflow(run,api) {
  // GitHub documents @main and the repository also returns bare paths. Both
  // require an independent fixed-workflow metadata/ID match, never a suffix wildcard.
  if(![WORKFLOW,`${WORKFLOW}@main`].includes(run.path)||!positiveId(run.workflow_id))deny('Workflow identity unverified');
  const workflow=await api('actions/workflows/sales-selective-scope.yml');
  if(workflow.id!==run.workflow_id||workflow.path!==WORKFLOW||workflow.state!=='active')deny('Workflow identity mismatch');
}

function checkExternalId(binding,stage) { return `sc-sales-v1:${digest(binding)}:${stage}`; }
function assertBoundCheck(check,binding,stage,id) {
  if(!Object.hasOwn(SALES_CHECKS,stage)||!positiveId(check?.id)||(id!==undefined&&check.id!==id)||
      check.head_sha!==binding.head||check.name!==SALES_CHECKS[stage]||
      check.external_id!==checkExternalId(binding,stage)||check.app?.id!==binding.publisherAppId)
    deny('Check provenance mismatch');
}
function checkIds(value) {
  if(!value||Object.keys(value).length!==3||new Set(Object.values(value)).size!==3||
      Object.keys(SALES_CHECKS).some(stage=>!positiveId(value[stage])))deny('Invalid check identifiers');
  return value;
}
export async function initializeSalesChecks(binding,api) {
  await assertLiveSalesBinding(binding,api);
  const ids={};
  for(const [stage,name] of Object.entries(SALES_CHECKS)) {
    // Never retry a POST whose response was lost. The newly-created pending
    // result itself blocks merge; a fresh run is the reconciliation path.
    const check=await api('check-runs',{method:'POST',body:{name,head_sha:binding.head,
      external_id:checkExternalId(binding,stage),status:'in_progress',
      details_url:`https://github.com/${full}/actions/runs/${binding.runId}`,
      output:{title:name,summary:`Pending; HEAD ${binding.head}; BASE ${binding.base}; run ${binding.runId}/${binding.attempt}`}}});
    assertBoundCheck(check,binding,stage);ids[stage]=check.id;
  }
  return checkIds(ids);
}
export async function publishSalesCheck({binding,ids,stage,conclusion,api}) {
  validateSalesBinding(binding);checkIds(ids);
  if(!Object.hasOwn(SALES_CHECKS,stage)||!['success','failure'].includes(conclusion))deny('Invalid check outcome');
  if(conclusion==='success')await assertLiveSalesBinding(binding,api);
  const check=await api(`check-runs/${ids[stage]}`);
  assertBoundCheck(check,binding,stage,ids[stage]);
  const result=await api(`check-runs/${ids[stage]}`,{method:'PATCH',body:{status:'completed',conclusion,
    output:{title:SALES_CHECKS[stage],summary:`${conclusion}; HEAD ${binding.head}; BASE ${binding.base}; run ${binding.runId}/${binding.attempt}`}}});
  assertBoundCheck(result,binding,stage,ids[stage]);
  if(result.status!=='completed'||result.conclusion!==conclusion)deny('Check publication not confirmed');
}

export async function verifySalesEnvironments(api) {
  const environments={};
  for(const name of ['owner-acceptance','production-approval']) {
    const [environment,branches]=await Promise.all([
      api(`environments/${name}`),api(`environments/${name}/deployment-branch-policies?per_page=100`),
    ]);
    const required=environment.protection_rules?.filter(rule=>rule.type==='required_reviewers');
    const reviewer=required?.[0]?.reviewers;
    if(!positiveId(environment.id)||environment.name!==name||required?.length!==1||reviewer?.length!==1||
        reviewer[0].type!=='User'||reviewer[0].reviewer?.id!==OWNER_ID||reviewer[0].reviewer?.login!==owner||
        environment.deployment_branch_policy?.custom_branch_policies!==true||
        environment.deployment_branch_policy?.protected_branches!==false||branches.total_count!==1||
        branches.branch_policies?.length!==1||branches.branch_policies[0].name!=='main'||
        branches.branch_policies[0].type!=='branch')deny('Owner environment protection unverified');
    environments[name]=environment.id;
  }
  if(new Set(Object.values(environments)).size!==2)deny('Approval environments are not distinct');
  return environments;
}
export async function verifySalesApprovals({binding,stage,api}) {
  validateSalesBinding(binding);
  if(!['owner','production'].includes(stage))deny('Invalid approval stage');
  // GitHub /approvals has no attempt field. Refuse reruns, rather than
  // pretending old run-level history is proof of a new approval attempt.
  if(binding.attempt!==1)deny('Fresh workflow run required for approvals');
  const environments=await verifySalesEnvironments(api);
  const history=await api(`actions/runs/${binding.runId}/approvals`);
  if(!Array.isArray(history))deny('Approval history missing');
  const names=stage==='production'?Object.keys(environments):['owner-acceptance'];
  const accepted=[];
  for(const name of names) {
    const rows=history.filter(row=>row.environments?.some(item=>item.id===environments[name]||item.name===name));
    if(rows.length!==1)deny('Missing or ambiguous owner approval');
    const row=rows[0];
    if(row.state!=='approved'||row.user?.id!==OWNER_ID||row.user?.login!==owner||row.user?.type!=='User'||
        row.environments.length!==1||row.environments[0].id!==environments[name]||
        row.environments[0].name!==name)deny('Invalid owner approval evidence');
    accepted.push(row);
  }
  if(stage==='production'&&accepted[0]===accepted[1])deny('Owner decisions must be separate');
}

export async function runSalesStage({binding,ids,stage,api,scopeCheck,protectionCheck}) {
  validateSalesBinding(binding);checkIds(ids);
  if(!Object.hasOwn(SALES_CHECKS,stage))deny('Invalid release stage');
  try {
    await assertLiveSalesBinding(binding,api);
    if(binding.attempt!==1)deny('Fresh workflow run required for approvals');
    // This function is wired to authenticated live evidence in the CLI. Tests
    // may inject adapters, but an absent runtime source is never a PASS.
    await protectionCheck(binding);
    await verifySalesEnvironments(api);
    if(stage==='scope') {
      const result=await scopeCheck(binding);
      if(result?.scopeVerified!==true||result.authorizedForProduction!==false)deny('Scope audit failed');
    } else {
      for(const required of stage==='owner'?['scope']:['scope','owner']) {
        const check=await api(`check-runs/${ids[required]}`);
        assertBoundCheck(check,binding,required,ids[required]);
        if(check.status!=='completed'||check.conclusion!=='success')deny('Previous release gate not successful');
      }
      await verifySalesApprovals({binding,stage,api});
    }
    await protectionCheck(binding);
    await publishSalesCheck({binding,ids,stage,conclusion:'success',api});
  } catch(error) {
    // A failure is never neutral/skipped. A lost PATCH response is not retried
    // as success; publish failure where possible, then preserve failing exit.
    await publishSalesCheck({binding,ids,stage,conclusion:'failure',api}).catch(()=>{});
    throw error;
  }
}

// Separate evidence boundary: this HTTP handler runs OUTSIDE GitHub Actions.
// Only it holds the dedicated evidence App key. Release jobs receive a signed
// response, never a ruleset-write token. Configuration/deployment is a distinct
// owner-approved operation; there is no fallback to a PAT or static snapshot.
const EVIDENCE_RULESET_ID=25301984;
const OIDC_ISSUER='https://token.actions.githubusercontent.com';
const PROOF_TTL_MS=60000;
function evidenceRequest(binding,nonce) {
  validateSalesBinding(binding);
  if(!/^[a-f0-9]{64}$/.test(nonce??''))deny('Invalid evidence nonce');
  return {version:1,binding,nonce};
}
function evidenceAudience(request) { return `skillcheck-sales-protection:${digest(request)}`; }

export async function verifyEvidenceOidc({jwt,request,fetchImpl=fetch,now=Date.now}) {
  evidenceRequest(request?.binding,request?.nonce);
  if(typeof jwt!=='string'||jwt.length>16384)deny('Invalid OIDC token');
  const parts=jwt.split('.');
  if(parts.length!==3||parts.some(part=>!/^[A-Za-z0-9_-]+$/.test(part)))deny('Invalid OIDC token');
  let header,claims;
  try { header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url')); }
  catch { deny('Invalid OIDC JSON'); }
  if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>200)deny('Invalid OIDC algorithm');
  const response=await fetchImpl(`${OIDC_ISSUER}/.well-known/jwks`,{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)deny('OIDC keys unavailable');
  const jwks=await boundedJson(response,65536);
  const matches=jwks.keys?.filter(key=>key.kid===header.kid&&key.kty==='RSA'&&key.alg==='RS256'&&key.use==='sig');
  if(matches?.length!==1)deny('OIDC key not uniquely identified');
  const key=createPublicKey({key:matches[0],format:'jwk'});
  if(!verifySignature('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),key,Buffer.from(parts[2],'base64url')))
    deny('OIDC signature invalid');
  const b=request.binding,seconds=Math.floor(now()/1000);
  if(claims.iss!==OIDC_ISSUER||claims.aud!==evidenceAudience(request)||
      claims.repository_id!==String(REPOSITORY_ID)||claims.repository_owner_id!==String(OWNER_ID)||
      claims.repository!==full||claims.workflow_ref!==workflowRef||claims.workflow_sha!==b.base||
      claims.ref!=='refs/heads/main'||claims.sha!==b.base||claims.event_name!==b.event||
      claims.run_id!==String(b.runId)||claims.run_attempt!==String(b.attempt)||
      !Number.isInteger(claims.exp)||!Number.isInteger(claims.nbf)||!Number.isInteger(claims.iat)||
      claims.exp<=seconds||claims.exp<=claims.iat||claims.nbf>seconds+5||claims.iat>seconds+5||claims.exp-claims.iat>600||
      (claims.job_workflow_ref!==undefined&&claims.job_workflow_ref!==workflowRef))deny('OIDC identity/binding invalid');
  return claims;
}

export function verifyProtectionEnvelope({envelope,request,publicKey,startedAt,now=Date.now}) {
  if(typeof envelope?.payload!=='string'||typeof envelope?.signature!=='string'||
      envelope.payload.length>100000||!/^[A-Za-z0-9_-]+$/.test(envelope.payload)||
      !/^[A-Za-z0-9_-]+$/.test(envelope.signature))deny('Malformed protection envelope');
  let key;
  try { key=createPublicKey(publicKey); } catch { deny('Evidence public key unconfigured'); }
  if(key.asymmetricKeyType!=='ed25519')deny('Unexpected evidence signing key');
  const bytes=Buffer.from(envelope.payload,'base64url');
  if(!verifySignature(null,bytes,key,Buffer.from(envelope.signature,'base64url')))deny('Protection evidence signature invalid');
  let proof;try { proof=JSON.parse(bytes); } catch { deny('Protection evidence JSON invalid'); }
  const current=now();
  if(proof.version!==1||proof.requestDigest!==digest(request)||proof.publisherAppId!==request.binding.publisherAppId||
      !Number.isSafeInteger(proof.observedAt)||!Number.isSafeInteger(proof.expiresAt)||
      proof.observedAt<startedAt-5000||proof.observedAt>current+5000||proof.expiresAt<=current||
      proof.expiresAt-proof.observedAt!==PROOF_TTL_MS||proof.branch?.commit?.sha!==request.binding.base||
      proof.rules?.length!==1||proof.rules[0].id!==EVIDENCE_RULESET_ID||
      proof.rules[0].source!==full||proof.rules[0].source_type!=='Repository')deny('Protection proof stale/replayed/misbound');
  return proof;
}

async function callSalesBroker({request,env,fetchImpl=fetch}) {
  let endpoint,oidcUrl;
  try {
    endpoint=new URL(env.SALES_EVIDENCE_URL);
    oidcUrl=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch { deny('Live evidence provider/OIDC unconfigured'); }
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
      endpoint.pathname!=='/evidence'||oidcUrl.protocol!=='https:'||
      !oidcUrl.hostname.endsWith('.actions.githubusercontent.com')||oidcUrl.port||oidcUrl.username||oidcUrl.password||oidcUrl.hash||
      !env.SALES_EVIDENCE_PUBLIC_KEY||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)deny('Invalid evidence provider configuration');
  oidcUrl.searchParams.set('audience',evidenceAudience(request));
  const oidc=await fetchImpl(oidcUrl,{headers:{Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},
    redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!oidc.ok)deny('OIDC request failed');
  const token=await boundedJson(oidc,32768);
  if(typeof token.value!=='string'||token.value.length>16384)deny('OIDC token missing');
  const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:`Bearer ${token.value}`,'Content-Type':'application/json'},body:JSON.stringify(request)});
  if(!response.ok)deny('Live evidence provider rejected request');
  return boundedJson(response,131072);
}

export async function requestProtectionEvidence({binding,env,fetchImpl=fetch,now=Date.now}) {
  const request=evidenceRequest(binding,randomBytes(32).toString('hex'));
  const startedAt=now();
  const envelope=await callSalesBroker({request,env,fetchImpl});
  const proof=verifyProtectionEnvelope({envelope,request,
    publicKey:env.SALES_EVIDENCE_PUBLIC_KEY,startedAt,now});
  await verifyProtection(proof);
  return proof;
}

async function mintEvidenceInstallation({config,fetchImpl,now,publish=false}) {
  if(!positiveId(config.appId)||!positiveId(config.installationId))deny('Evidence App unconfigured');
  const seconds=Math.floor(now()/1000);
  const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const claims=Buffer.from(JSON.stringify({iat:seconds-30,exp:seconds+300,iss:String(config.appId)})).toString('base64url');
  const jwt=`${header}.${claims}.${signBytes('RSA-SHA256',Buffer.from(`${header}.${claims}`),config.appPrivateKey).toString('base64url')}`;
  const headers={Authorization:`Bearer ${jwt}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const identity=await fetchImpl('https://api.github.com/app',{headers,redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!identity.ok)deny('Evidence App identity unavailable');
  const app=await boundedJson(identity,65536);
  if(app.id!==config.appId||app.owner?.id!==OWNER_ID)deny('Evidence App identity mismatch');
  // GitHub withholds bypass_actors without ruleset write access. This grant is
  // confined to the external broker, never the release workflow. Provisioning
  // this dedicated App and key requires explicit administrator approval.
  const permissions={administration:'write',contents:'read',pull_requests:'read',actions:'read',...(publish?{checks:'write'}:{})};
  const response=await fetchImpl(`https://api.github.com/app/installations/${config.installationId}/access_tokens`,{
    method:'POST',headers:{...headers,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),
    body:JSON.stringify({repository_ids:[REPOSITORY_ID],permissions}),
  });
  if(!response.ok)deny('Evidence installation token unavailable');
  const minted=await boundedJson(response,65536);
  const token=minted.token;
  if(typeof token!=='string'||token.length<12)deny('Evidence installation token invalid');
  const revoke=async()=>{await fetchImpl('https://api.github.com/installation/token',{
    method:'DELETE',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},
    redirect:'error',signal:AbortSignal.timeout(8000),
  }).catch(()=>{});};
  try {
    if(minted.repository_selection!=='selected'||Object.entries(permissions).some(([name,value])=>minted.permissions?.[name]!==value)||
        Object.entries(minted.permissions??{}).some(([name,value])=>permissions[name]!==value&&!(name==='metadata'&&value==='read')))
      deny('Evidence installation grant mismatch');
    const listing=await fetchImpl('https://api.github.com/installation/repositories?per_page=100',{
      headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(8000),
    });
    if(!listing.ok)deny('Evidence repository scope unreadable');
    const scope=await boundedJson(listing,65536);
    if(scope.total_count!==1||scope.repositories?.length!==1||scope.repositories[0].id!==REPOSITORY_ID)
      deny('Evidence repository scope mismatch');
    return {api:createSalesGitHub({token,fetchImpl}),revoke};
  } catch(error) { await revoke();throw error; }
}

export async function handleProtectionEvidence({request,authorization,config,fetchImpl=fetch,now=Date.now}) {
  const canonical=canonicalBrokerRequest(request);
  if(config?.appId!==request.binding.publisherAppId||config.appId===GITHUB_ACTIONS_APP_ID)deny('Dedicated publisher identity mismatch');
  if(JSON.stringify(canonical)!==JSON.stringify(request))deny('Unexpected evidence request shape');
  const claims=await verifyEvidenceOidc({jwt:authorization,request,fetchImpl,now});
  const installation=await mintEvidenceInstallation({config,fetchImpl,now,publish:!!request.publication});
  try {
    if(request.publication)return await executeBrokerPublication({request,claims,api:installation.api});
    const observedAt=now();
    await assertLiveSalesBinding(request.binding,installation.api);
    const [branch,rule]=await Promise.all([
      installation.api('branches/main'),installation.api(`rulesets/${EVIDENCE_RULESET_ID}`),
    ]);
    if(rule.id!==EVIDENCE_RULESET_ID||rule.source!==full||rule.source_type!=='Repository')deny('Evidence ruleset identity changed');
    const proof={version:1,publisherAppId:config.appId,requestDigest:digest(request),observedAt,expiresAt:observedAt+PROOF_TTL_MS,branch,rules:[rule]};
    await verifyProtection(proof);
    await assertLiveSalesBinding(request.binding,installation.api);
    if(now()>=proof.expiresAt)deny('Evidence collection timed out');
    const key=createPrivateKey(config.signingPrivateKey);
    if(key.asymmetricKeyType!=='ed25519')deny('Evidence signing key invalid');
    const bytes=Buffer.from(JSON.stringify(proof));
    return {payload:bytes.toString('base64url'),signature:signBytes(null,bytes,key).toString('base64url')};
  } finally { await installation.revoke(); }
}


// All three release contexts are owned by the dedicated external App, not by
// the repository-wide Actions App that candidate workflows can impersonate.
function canonicalBrokerRequest(request) {
  const base=evidenceRequest(request?.binding,request?.nonce);
  if(!Object.hasOwn(request,'publication'))return base;
  const p=request.publication;
  if(!p||Object.keys(p).length!==4||!Object.hasOwn(SALES_CHECKS,p.stage)||
      !['in_progress','success','failure'].includes(p.conclusion)||
      (p.conclusion==='in_progress'?p.checkId!==null:!positiveId(p.checkId))||
      !Array.isArray(p.priorIds))deny('Invalid broker publication');
  const prior=p.conclusion!=='success'||p.stage==='scope'?[]:p.stage==='owner'?['scope']:['scope','owner'];
  if(p.priorIds.length!==prior.length||p.priorIds.some((item,i)=>!item||
      Object.keys(item).length!==2||item.stage!==prior[i]||!positiveId(item.id)))deny('Invalid prior gate references');
  return {...base,publication:{stage:p.stage,conclusion:p.conclusion,checkId:p.checkId,
    priorIds:p.priorIds.map(item=>({stage:item.stage,id:item.id}))}};
}

export function createBrokeredSalesApi({binding,ids,env,readApi,fetchImpl=fetch}) {
  validateSalesBinding(binding);
  if(Number(env.SALES_RELEASE_PUBLISHER_APP_ID)!==binding.publisherAppId)deny('Publisher configuration mismatch');
  return async(path,options={})=>{
    if(!options.method||options.method==='GET')return readApi(path,options);
    const stage=Object.keys(SALES_CHECKS).find(key=>SALES_CHECKS[key]===
      (options.method==='POST'?options.body?.name:options.body?.output?.title));
    const initial=options.method==='POST'&&path==='check-runs';
    const idMatch=/^check-runs\/([1-9][0-9]*)$/.exec(path);
    if(!stage||(!initial&&!(options.method==='PATCH'&&idMatch))||
        (initial&&(options.body.head_sha!==binding.head||options.body.status!=='in_progress'||
          options.body.external_id!==checkExternalId(binding,stage)))||
        (!initial&&(options.body.status!=='completed'||!['success','failure'].includes(options.body.conclusion))))
      deny('Invalid brokered check operation');
    const conclusion=initial?'in_progress':options.body.conclusion;
    const prior=conclusion!=='success'||stage==='scope'?[]:stage==='owner'?['scope']:['scope','owner'];
    const request=canonicalBrokerRequest({...evidenceRequest(binding,randomBytes(32).toString('hex')),
      publication:{stage,conclusion,checkId:initial?null:Number(idMatch[1]),
        priorIds:prior.map(key=>({stage:key,id:ids?.[key]}))}});
    const response=await callSalesBroker({request,env,fetchImpl});
    const check=response.check;
    assertBoundCheck(check,binding,stage,initial?undefined:Number(idMatch[1]));
    // Verify the producer's result independently through the read-only GitHub
    // token. The remote endpoint cannot fabricate a successful API response.
    const actual=await readApi(`check-runs/${check.id}`);
    assertBoundCheck(actual,binding,stage,check.id);
    if(actual.status!==check.status||actual.conclusion!==check.conclusion)deny('Publisher response not confirmed');
    return actual;
  };
}

async function executeBrokerPublication({request,claims,api}) {
  const binding=request.binding,p=request.publication;
  if(p.conclusion==='failure') {
    // Cleanup may outlive a moved HEAD or cancelled attempt, but it can only
    // invalidate this exact run's dedicated-App checks, never a newer run.
    const run=await api(`actions/runs/${binding.runId}`);
    if(run.id!==binding.runId||run.run_attempt!==binding.attempt||
        run.head_sha!==binding.base||run.event!==binding.event||run.repository?.id!==REPOSITORY_ID)
      deny('Cleanup run binding changed');
    await assertSalesWorkflow(run,api);
  } else {
    await assertLiveSalesBinding(binding,api);
    if(binding.attempt!==1)deny('Fresh workflow run required for approvals');
  }
  if(p.conclusion==='success') {
    const [branch,rule]=await Promise.all([api('branches/main'),api(`rulesets/${EVIDENCE_RULESET_ID}`)]);
    if(rule.id!==EVIDENCE_RULESET_ID||rule.source!==full||rule.source_type!=='Repository')deny('Publisher ruleset identity changed');
    await verifyProtection({branch,rules:[rule],publisherAppId:binding.publisherAppId});
    await verifySalesEnvironments(api);
    if(p.stage!=='scope') {
      const environment=p.stage==='owner'?'owner-acceptance':'production-approval';
      // Default GitHub OIDC encodes the environment in sub. The top-level
      // environment claim is optional; it cannot replace or contradict sub.
      // Support both documented default formats, with exact immutable IDs.
      const subjects=[`repo:${full}:environment:${environment}`,
        `repo:${owner}@${OWNER_ID}/${repo}@${REPOSITORY_ID}:environment:${environment}`];
      if(!subjects.includes(claims.sub)||
          (claims.environment!==undefined&&claims.environment!==environment))
        deny('Approval publication lacks protected environment identity');
      for(const prior of p.priorIds) {
        const check=await api(`check-runs/${prior.id}`);
        assertBoundCheck(check,binding,prior.stage,prior.id);
        if(check.status!=='completed'||check.conclusion!=='success')deny('Prior broker gate not successful');
      }
      await verifySalesApprovals({binding,stage:p.stage,api});
    }
  }
  if(p.conclusion==='in_progress') {
    const check=await api('check-runs',{method:'POST',body:{name:SALES_CHECKS[p.stage],head_sha:binding.head,
      external_id:checkExternalId(binding,p.stage),status:'in_progress',
      details_url:`https://github.com/${full}/actions/runs/${binding.runId}`,
      output:{title:SALES_CHECKS[p.stage],summary:`Pending; HEAD ${binding.head}; BASE ${binding.base}; run ${binding.runId}/${binding.attempt}`}}});
    assertBoundCheck(check,binding,p.stage);return {check};
  }
  const existing=await api(`check-runs/${p.checkId}`);
  assertBoundCheck(existing,binding,p.stage,p.checkId);
  if(p.conclusion==='success')await assertLiveSalesBinding(binding,api);
  const check=await api(`check-runs/${p.checkId}`,{method:'PATCH',body:{status:'completed',conclusion:p.conclusion,
    output:{title:SALES_CHECKS[p.stage],summary:`${p.conclusion}; HEAD ${binding.head}; BASE ${binding.base}; run ${binding.runId}/${binding.attempt}`}}});
  assertBoundCheck(check,binding,p.stage,p.checkId);
  return {check};
}

export async function invalidateSalesChecks({binding,ids,api}) {
  const failed=[];
  for(const stage of Object.keys(SALES_CHECKS)) {
    try { await publishSalesCheck({binding,ids,stage,conclusion:'failure',api}); }
    catch { failed.push(stage); }
  }
  // Do not reveal provider text. Every check was attempted before failure.
  if(failed.length)deny('Check invalidation incomplete: '+failed.join(','));
}

export function serveProtectionEvidence(env=process.env) {
  if(env.GITHUB_ACTIONS==='true')deny('Evidence broker must run outside Actions');
  const config={appId:Number(env.SALES_EVIDENCE_APP_ID),installationId:Number(env.SALES_EVIDENCE_INSTALLATION_ID),
    appPrivateKey:env.SALES_EVIDENCE_APP_PRIVATE_KEY,signingPrivateKey:env.SALES_EVIDENCE_SIGNING_PRIVATE_KEY};
  if(!positiveId(config.appId)||!positiveId(config.installationId)||!config.appPrivateKey||!config.signingPrivateKey)
    deny('Evidence broker credentials unconfigured');
  const port=Number(env.PORT??8788);
  if(!Number.isInteger(port)||port<1024||port>65535)deny('Invalid evidence port');
  // Bind only to loopback. An operator-managed HTTPS reverse proxy is required;
  // this command neither provisions a host nor changes any GitHub setting.
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    try {
      if(req.method!=='POST'||req.url!=='/evidence'||!req.headers.authorization?.startsWith('Bearer '))deny('Invalid evidence request');
      const chunks=[];let size=0;
      for await(const chunk of req) { size+=chunk.length;if(size>16384)deny('Evidence request too large');chunks.push(chunk); }
      const envelope=await handleProtectionEvidence({request:JSON.parse(Buffer.concat(chunks)),
        authorization:req.headers.authorization.slice(7),config});
      res.writeHead(200);res.end(JSON.stringify(envelope));
    } catch { res.writeHead(403);res.end('{"error":"EVIDENCE_DENIED"}'); }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return server.listen(port,'127.0.0.1');
}

export async function salesGateCli({event,env=process.env,cwd='.'}) {
  if(env.SALES_RELEASE_GATES_ENABLED!=='true')deny('Sales release gates not activated');
  const readApi=createSalesGitHub({token:env.GITHUB_TOKEN});
  if(env.SALES_GATE_STAGE==='invalidate') {
    const prior=validateSalesBinding(JSON.parse(env.SALES_GATE_BINDING??'null'));
    if(env.GITHUB_REPOSITORY!==full||env.GITHUB_REF!=='refs/heads/main'||
        env.GITHUB_WORKFLOW_REF!==workflowRef||env.GITHUB_WORKFLOW_SHA!==prior.base||
        env.GITHUB_SHA!==prior.base||Number(env.GITHUB_RUN_ID)!==prior.runId||
        Number(env.GITHUB_RUN_ATTEMPT)!==prior.attempt)deny('Invalid cleanup execution');
    const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    if(checkout!==prior.base)deny('Cleanup checkout is not trusted base');
    const ids=checkIds(JSON.parse(env.SALES_GATE_CHECKS??'null'));
    const api=createBrokeredSalesApi({binding:prior,ids,env,readApi});
    await invalidateSalesChecks({binding:prior,ids,api});
    return {invalidated:true,authorizedForProduction:false};
  }
  const binding=await captureSalesBinding({event,env,api:readApi});
  const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(checkout!==binding.base)deny('Checkout is not trusted base');
  const mode=env.SALES_GATE_STAGE;
  if(mode==='initialize') {
    const ids=await initializeSalesChecks(binding,createBrokeredSalesApi({binding,env,readApi}));
    if(!env.GITHUB_OUTPUT)deny('Workflow output missing');
    appendFileSync(env.GITHUB_OUTPUT,`binding=${JSON.stringify(binding)}\nchecks=${JSON.stringify(ids)}\n`);
    return {initialized:true,authorizedForProduction:false};
  }
  const saved=JSON.parse(env.SALES_GATE_BINDING??'null');
  if(JSON.stringify(saved)!==JSON.stringify(binding))deny('Workflow output binding changed');
  const ids=checkIds(JSON.parse(env.SALES_GATE_CHECKS??'null'));
  const api=createBrokeredSalesApi({binding,ids,env,readApi});
  await runSalesStage({binding,ids,stage:mode,api,
    protectionCheck:()=>requestProtectionEvidence({binding,env}),
    scopeCheck:async()=>{
      const result=inspectSalesReleaseGit({cwd,baseSha:binding.base,headSha:binding.head,headRef:releaseRef});
      if(!result.ok||result.authorizedForProduction!==false)deny('Reviewed Git history rejected');
      return {scopeVerified:true,authorizedForProduction:false};
    }});
  return {stage:mode,published:true,authorizedForProduction:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  Promise.resolve().then(()=>{
    if(process.argv[2]==='--serve-evidence')return serveProtectionEvidence();
    if(process.argv[2]==='--fetch-release-ref')return fetchTrustedRelease();
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    if(process.argv[2]==='--gate')return salesGateCli({event});
    if(process.argv.length>2)deny('Unexpected command argument');
    return checkTrustedSalesRelease({event});
  }).then(result=>{
    if(result!==undefined&&process.argv[2]!=='--serve-evidence')process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(()=>{process.stderr.write('SALES_RELEASE_DENIED: inspect the failed gate; raw provider errors suppressed.\n');process.exitCode=1;});
}
