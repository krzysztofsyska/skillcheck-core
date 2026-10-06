// Validate effective rules, identities and exact branch targets, not ruleset names.
export function protectionFromRulesets(rulesets, policy = {}, environments = {}) {
  const active = (rulesets ?? []).filter(r => r.enforcement === 'active' && r.target === 'branch');
  const covers = (r, branch) => {
    const refs = r.conditions?.ref_name;
    return refs && (refs.include?.includes(`refs/heads/${branch}`) || refs.include?.includes('~ALL'))
      && !(refs.exclude ?? []).some(x => x === '~ALL' || x === `refs/heads/${branch}` || x.includes('*'));
  };
  const noBypass = r => Array.isArray(r.bypass_actors) && r.bypass_actors.length === 0;
  const has = (rules, name) => rules.some(r => r.type === name);
  const appId = policy.controller_app_id;
  const writer = (branch, mode) => Number.isInteger(appId) && active.some(r => covers(r, branch)
    && has(r.rules ?? [], 'update') && r.bypass_actors?.length === 1
    && r.bypass_actors[0].actor_type === 'Integration' && r.bypass_actors[0].actor_id === appId
    && r.bypass_actors[0].bypass_mode === mode);
  const quality = branch => {
    const rules = active.filter(r => covers(r, branch) && noBypass(r)).flatMap(r => r.rules ?? []);
    const checks = rules.find(r => r.type === 'required_status_checks')?.parameters;
    return has(rules, 'pull_request') && has(rules, 'deletion') && has(rules, 'non_fast_forward')
      && checks?.strict_required_status_checks_policy === true
      && (policy.required_checks?.[branch]?.length > 0)
      && policy.required_checks[branch].every(context => checks.required_status_checks?.some(c => c.context === context && c.integration_id === appId));
  };
  const stateRules = active.filter(r => covers(r, 'agent-state') && noBypass(r)).flatMap(r => r.rules ?? []);
  const environmentOk = configured => {
    const e = environments[configured?.name];
    const reviewers = e?.protection_rules?.find(r => r.type === 'required_reviewers');
    return Number.isInteger(configured?.id) && e?.id === configured.id
      && reviewers?.prevent_self_review === true && reviewers.reviewers?.length === 1
      && reviewers.reviewers[0].type === 'User' && reviewers.reviewers[0].reviewer?.id === policy.owner?.id
      && e.can_admins_bypass === false
      && e.deployment_branch_policy?.custom_branch_policies === true
      && e.branch_policies?.length === 1 && e.branch_policies[0].name === 'main' && e.branch_policies[0].type === 'branch';
  };
  return {
    exclusiveWritersConfirmed: writer('main', 'pull_request') && writer('integration', 'pull_request') && writer('agent-state', 'always'),
    scOps001Exception: JSON.stringify(rulesets).includes('SC-OPS-001'),
    mainProtected: quality('main'), integrationProtected: quality('integration'),
    agentStateProtected: has(stateRules, 'deletion') && has(stateRules, 'non_fast_forward'),
    qualityGatesBypass: active.some(r => ['quality-gates', 'agent-state-integrity'].includes(r.name) && !noBypass(r)),
    administrationWriteUsed: false,
    requiredChecksPinnedToApp: quality('main') && quality('integration'),
    environmentsConfirmed: environmentOk(policy.environments?.owner_acceptance) && environmentOk(policy.environments?.production_approval),
  };
}
