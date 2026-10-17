/** Trusted-main-only, strictly read-only GitHub and Git-object scope check.
 * A PASS means scope verification, NOT Production or owner approval.
 * NEVER check out or execute the candidate release's files. */
import { readFileSync } from 'node:fs';
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
function hasRequiredContext(types,context) {
  return types.some(r=>r.type==='required_status_checks'&&
    r.parameters?.strict_required_status_checks_policy===true&&
    Array.isArray(r.parameters.required_status_checks)&&
    r.parameters.required_status_checks.some(x=>x?.context===context&&
      x.integration_id===GITHUB_ACTIONS_APP_ID));
}
async function verifyProtection() {
  const branch=await github('branches/main');
  if(branch.protected!==true)deny('main is not protected');
  const summaries=await github('rulesets?includes_parents=true');
  if(!Array.isArray(summaries))deny('ruleset list missing');
  const effective=[];
  for(const item of summaries.slice(0,40)) {
    if(item.enforcement!=='active'||!Number.isInteger(item.id))continue;
    const rule=await github('rulesets/'+item.id);
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
  if(!hasRequiredContext(effective,'Sales selective scope verified'))
    deny('main does not require trusted sales scope check');
  if(!effective.some(x=>x.type==='pull_request' &&
      Number.isInteger(x.parameters?.required_approving_review_count) &&
      x.parameters.required_approving_review_count>=1 &&
      x.parameters.dismiss_stale_reviews_on_push===true&&
      x.parameters.require_last_push_approval===true))
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

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  Promise.resolve().then(()=>{
    if(process.argv[2]==='--fetch-release-ref')return fetchTrustedRelease();
    if(process.argv.length>2)deny('Unexpected command argument');
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    return checkTrustedSalesRelease({event});
  }).then(result=>{
    if(result!==undefined)process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
}
