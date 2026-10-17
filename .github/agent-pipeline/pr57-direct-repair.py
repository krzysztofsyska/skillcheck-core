from pathlib import Path
root=Path.cwd()
p=root/'tools/agent-pipeline/feedback.mjs'
s=p.read_text()
def replace_once(s,old,new):
    assert s.count(old)==1,(old[:100],s.count(old))
    return s.replace(old,new)
s=s.replace('Owner acceptance and production approval remain pending.', 'Routine integration requires current CI, independent review and branch protections. Production approval remains separate.')
s=replace_once(s,"    if (!verifyRepair(binding, current, snapshot)) return { state: { ...current, phase: 'BLOCKED_PROVENANCE' } };\n    return { state: { ...current, phase: 'REVIEW_PENDING', head, base }, effect: { type: 'review', head } };", """    if (!verifyRepair(binding, current, snapshot)) return { state: { ...current, phase: 'BLOCKED_PROVENANCE' } };
    // An independently reviewed repaired head may already need the next fix.
    // Reuse the ordinary finding/round/idle checks rather than requesting a
    // duplicate review. Provenance of the completed repair was verified above.
    if (findings(snapshot).length) {
      return planFeedback(binding, { ...current, phase: 'WAITING_REVIEW', head, base,
        reviewCommentId: null, reviewRequestedAt: null, reviewBaseline: [] }, snapshot, now);
    }
    return { state: { ...current, phase: 'REVIEW_PENDING', head, base }, effect: { type: 'review', head } };""")
s=replace_once(s,"const wholeTokens = value => Number.isInteger(value) && value >= 0 ? value : null;", "const wholeTokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;")
s=replace_once(s,"export function costMeasurement(payload) {\n  return {", """export function costMeasurement(payload, runId) {
  // totalUsage can include earlier work by this durable agent. Even when the
  // API accepts a run filter, only one exact run entry is attribution evidence.
  const matches = typeof runId === 'string' && runId.length > 0 && Array.isArray(payload?.runs)
    ? payload.runs.filter(run => run?.id === runId) : [];
  const tokens = matches.length === 1 ? wholeTokens(matches[0]?.usage?.totalTokens) : null;
  return {""")
s=replace_once(s,"    cursorTotalTokens: wholeTokens(payload?.totalUsage?.totalTokens),", "    cursorTotalTokens: tokens,\n    cursorUsageStatus: tokens === null ? 'UNAVAILABLE' : 'AVAILABLE',")
s=replace_once(s,"  let measurement = costMeasurement(null);\n  try { measurement = costMeasurement(await cursor.getUsage(binding.agentId, current.runId)); }\n  catch { measurement = costMeasurement(null); }", "  let measurement = costMeasurement(null, current.runId);\n  try { measurement = costMeasurement(await cursor.getUsage(binding.agentId, current.runId), current.runId); }\n  catch { measurement = costMeasurement(null, current.runId); }")
s=replace_once(s,"    if (!verifyRepair(binding, plan.state, fresh)) fail('CURSOR_PROVENANCE_CHANGED');\n    completed = applyHold(await completeReviewRequest(), 1);", """    if (!verifyRepair(binding, plan.state, fresh)) fail('CURSOR_PROVENANCE_CHANGED');
    if (findings(fresh).length) {
      // The reviewer can finish between planning and this final read. Spend
      // the reserved completion write, retain the terminal slot and let the
      // next poll reserve a fix. Do not strand the task in REVIEW_PENDING or
      // post a redundant request; the same CAS/lost-response rules still apply.
      completed = applyHold({ ...plan.state, phase: 'WAITING_REVIEW',
        reviewCommentId: null, reviewRequestedAt: null, reviewBaseline: [] }, 1);
    } else {
      completed = applyHold(await completeReviewRequest(), 1);
    }""")
p.write_text(s)
p=root/'tools/agent-pipeline/feedback-cli.mjs'
s=p.read_text()
start=s.index('  const rules = await github.request(`${root}/rules/branches/agent-feedback-state`);')
end=s.index('  const environment = await github.request',start)
s=s[:start]+"""  const details = new Map();
  async function applicable(branch) {
    const rules = [];
    // Ask GitHub which rules actually apply; do not approximate fnmatch/~ALL
    // for source branches or silently stop at the default first page.
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error('STATE_PROTECTION_INCOMPLETE');
      const batch = await github.request(`${root}/rules/branches/${branch}?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length > 100
          || batch.some(rule => !Number.isSafeInteger(rule?.ruleset_id) || rule.ruleset_id < 1)) {
        throw new Error('STATE_PROTECTION_MISSING');
      }
      rules.push(...batch);
      if (batch.length < 100) break;
    }
    const sets = [];
    for (const id of new Set(rules.map(rule => rule.ruleset_id))) {
      if (!details.has(id)) {
        const rule = withRulesetEvidence(await github.request(`${root}/rulesets/${id}`), policy);
        if (rule.id !== id) throw new Error('STATE_PROTECTION_MISSING');
        details.set(id, rule);
      }
      const rule = details.get(id);
      if (rule.enforcement === 'active' && rule.target === 'branch') sets.push(rule);
    }
    return sets;
  }
  if (!Number.isSafeInteger(appId) || appId < 1) throw new Error('STATE_PROTECTION_MISSING');
  const active = await applicable('agent-feedback-state');
  const alwaysWriter = rule => rule.rules?.some(r => r.type === 'update')
    && rule.bypass_actors.some(actor => actor.actor_type === 'Integration'
      && actor.actor_id === appId && actor.bypass_mode === 'always');
  const exactStateTarget = rule => {
    const refs = rule.conditions?.ref_name;
    return Array.isArray(refs?.include) && refs.include.length === 1
      && refs.include[0] === 'refs/heads/agent-feedback-state'
      && Array.isArray(refs.exclude) && refs.exclude.length === 0;
  };
  // A valid narrow writer must not mask a second, broad always-bypass writer.
  if (active.some(rule => alwaysWriter(rule) && !exactStateTarget(rule))) throw new Error('STATE_WRITER_SCOPE');
  const integrity = active.filter(rule => rule.bypass_actors.length === 0).flatMap(rule => rule.rules ?? []);
  const writers = active.some(rule => exactStateTarget(rule)
    && ['update', 'creation'].every(type => rule.rules?.some(r => r.type === type))
    && rule.bypass_actors.length === 1 && alwaysWriter(rule));
  if (!writers || !['deletion', 'non_fast_forward'].every(type => integrity.some(r => r.type === type))) throw new Error('STATE_PROTECTION_MISSING');
  // A different ruleset may target only main/integration and never appear in
  // the state endpoint. Read both before certifying the App's write boundary.
  for (const branch of ['main', 'integration']) {
    if ((await applicable(branch)).some(alwaysWriter)) throw new Error('SOURCE_WRITER_BYPASS');
  }
"""+s[end:]
p.write_text(s)
p=root/'tests/agent-pipeline/feedback.test.mjs';s=p.read_text()
s=replace_once(s,"return { totalUsage: { totalTokens: 12 }, cost: { chargedCents: 0, rawCostCents: 4.5 } };", "return { totalUsage: { totalTokens: 9012 }, runs: [{ id: 'earlier', usage: { totalTokens: 9000 } }, { id: runId, usage: { totalTokens: 12 } }], cost: { chargedCents: 0, rawCostCents: 4.5 } };")
s=replace_once(s,"async getUsage() { return { totalUsage: { totalTokens: 1 } }; },", "async getUsage() { return { totalUsage: { totalTokens: 1 }, runs: [{ id: 'run-drop', usage: { totalTokens: 1 } }] }; },")
s=replace_once(s,"return { totalUsage: { totalTokens: 3 }, cost: { chargedCents: -1, rawCostCents: '4' } };", "return { totalUsage: { totalTokens: 3 }, runs: [{ id: 'run-plain', usage: { totalTokens: 3 } }], cost: { chargedCents: -1, rawCostCents: '4' } };")
s=replace_once(s,"    { enforcement: 'active', target: 'branch', rules: [{ type: 'update' }, { type: 'creation' }],", "    { id: 1, conditions: { ref_name: { include: ['refs/heads/agent-feedback-state'], exclude: [] } }, enforcement: 'active', target: 'branch', rules: [{ type: 'update' }, { type: 'creation' }],")
s=replace_once(s,"    { enforcement: 'active', target: 'branch', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],", "    { id: 2, conditions: { ref_name: { include: ['refs/heads/agent-feedback-state'], exclude: [] } }, enforcement: 'active', target: 'branch', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],")
s=replace_once(s,"    if (path.includes('/rules/branches/')) return [{ ruleset_id: 0 }, { ruleset_id: 1 }];\n    if (path.includes('/rulesets/')) return sets[Number(path.split('/').at(-1))];", "    if (path.includes('/rules/branches/agent-feedback-state')) return [{ ruleset_id: 1 }, { ruleset_id: 2 }];\n    if (path.includes('/rules/branches/')) return [];\n    if (path.includes('/rulesets/')) return sets.find(rule => rule.id === Number(path.split('/').at(-1)));")
p.write_text(s)
p=root/'tests/agent-pipeline/diagnose.test.mjs';s=p.read_text()
s=replace_once(s,"    [root + '/rulesets/1']: { enforcement:","    [root + '/rules/branches/main']: [],\n    [root + '/rules/branches/integration']: [],\n    [root + '/rulesets/1']: { id: 1, enforcement:")
s=replace_once(s,"    [root + '/rulesets/2']: { enforcement:","    [root + '/rulesets/2']: { id: 2, conditions: { ref_name: { include: ['refs/heads/agent-feedback-state'], exclude: [] } }, enforcement:")
p.write_text(s)
(root/'.github/workflows/pr57-offline-snapshot.yml').unlink()
p=root/'docs/sc-ops-002d-feedback.md';s=p.read_text()
s=s.replace('Existing product/controller/approval code remains unchanged.', 'Product and approval workflows remain unchanged. Shared controller API adapters are hardened for exact token grants and read-only protection evidence; the accepted PR #41 isolation and preflight safeguards are preserved.')
s+='''

## Direct repair after PR #41 integration — 2026-10-17

The requested Cursor follow-up failed to arrive (PR comment 6234323780). The
coordinator repaired the existing branch directly; this is not a successful
Cursor pilot. Input implementation: `9c926623568426e0ab8a3c3e24ab8fc5f99c2525`.
Accepted integration: `dc4d20240568669a514480e387687c49194d5267`. The integration
was combined into this task branch with all accepted product files preserved.
No force push, live provider call or production deployment belongs to this repair.

- Token usage is selected from exactly one `runs[].id` equal to the reserved
  run ID, never the durable agent's aggregate `totalUsage`. Missing, ambiguous
  or invalid token evidence stays null with `cursorUsageStatus=UNAVAILABLE`.
  `cursorCostStatus` and Codex monetary cost remain UNAVAILABLE until independent
  billing evidence exists; token counts are not an invoice. The request may use
  the API run filter, but the response must still identify the correct run.
- A signed, verified finished repair with current-head review findings returns
  to the existing repair path, respecting the three-round and lifecycle ledger
  limits, without requesting a redundant review. Findings arriving in the final
  pre-review read preserve a repairable WAITING_REVIEW state and terminal hold.
- Routine prompts require current CI, independent review and effective branch
  protection. They do not invent an extra owner-acceptance gate for integration.
  The builder still cannot merge/deploy; Production approval remains separate.
- The state-writer always bypass must target exactly
  `refs/heads/agent-feedback-state`, without wildcards, extra refs or exclusions.
  All applicable source-branch rule pages for main and integration are checked
  independently. Any additional controller-App always-update bypass on either
  source branch rejects the preflight, even alongside a valid state-only writer.
  Missing/failed evidence is not an empty bypass list or permission to proceed.

Temporary read-only branch-only snapshot instrumentation packaged tracked public
Git objects for offline merge/regression tests. It was removed from the final
file tree; it is not a second controller or a deployment mechanism.

Twenty new offline regressions cover the four current review findings, including
response attribution, absent/duplicate run evidence, redundant-review races,
ledger reservation, signer/round limits, exact bypass scope and pagination.
Local baseline after combining integration: 234/234 tests passed on Node22.16.
The first 17 focused regressions reproduced the defects (0/17 passed) before
repair and passed afterward. Final commands/results and exact reviewed commit
are recorded in the PR handoff. Full Node24 application CI and independent
review must separately complete for the final HEAD before integration acceptance.

Activation remains disarmed: enabled=false, costProbe.armed=false, bindings=[].
The one-shot pilot and its later recurring budget are separate from this code
repair. No runtime configuration is asserted to be ready by offline tests.
'''
p.write_text(s)
