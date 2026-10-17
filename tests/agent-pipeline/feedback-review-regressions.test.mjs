import test from 'node:test';
import assert from 'node:assert/strict';
import { costMeasurement, runCostProbe, runFeedback, fixPrompt, CODEX, REPOSITORY, REPOSITORY_ID } from '../../tools/agent-pipeline/feedback.mjs';
import { verifyFeedbackProtection } from '../../tools/agent-pipeline/feedback-cli.mjs';

// Offline regressions for PR57's four current review findings. No provider API.
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const reviewer = { ...CODEX, type: 'Bot' };
function feedbackFixture() {
  const binding = { pr: 49, agentId: 'bc-regression', branch: 'cursor/regression',
    initialHead: A, originIntegration: B, level: 'L3', scope: 'OPERATIONS',
    cursorCommitter: { id: 123, login: 'cursor-test[bot]' }, allowedFiles: ['docs/test.md'] };
  const snapshot = { pull: { number: 49, state: 'open', draft: false, merged: false,
    head: { ref: binding.branch, sha: A, repo: { id: REPOSITORY_ID, fork: false } },
    base: { ref: 'integration', sha: B, repo: { id: REPOSITORY_ID } } },
    originVerified: true, initialHeadVerified: true, files: ['docs/test.md'],
    agent: { id: binding.agentId, status: 'IDLE', autoCreatePR: false, workOnCurrentBranch: true,
      repos: [{ url: `https://github.com/${REPOSITORY}`, startingRef: binding.branch }] },
    reviews: [], comments: [], reactions: [] };
  let value = null, revision = 0;
  const calls = { runs: [], reviews: [], saves: 0, reservations: [] };
  const store = { async read() { return { value: structuredClone(value), revision }; },
    async save(next, expected) { assert.equal(expected, revision); value = structuredClone(next); calls.saves++; return ++revision; } };
  const args = { binding, store, now: 1000, readSnapshot: async () => structuredClone(snapshot),
    reserveLedger: (writes, held) => calls.reservations.push([writes, held]),
    cursor: { async createRun(_id, body) { const id = `run-${calls.runs.length + 1}`; calls.runs.push(body.prompt.text); return { run: { id, agentId: binding.agentId } }; } },
    postReview: async body => { calls.reviews.push(body); return { id: 200 + calls.reviews.length }; } };
  function finding(head, id = 101) {
    snapshot.reviews.push({ id: id - 1, user: reviewer, state: 'COMMENTED', commit_id: head });
    snapshot.comments.push({ id, user: reviewer, commit_id: head, original_commit_id: head, line: 1, pull_request_review_id: id - 1 });
  }
  function finish() {
    snapshot.pull.head.sha = C;
    snapshot.agent.latestRunId = value.runId;
    snapshot.run = { id: value.runId, agentId: binding.agentId, status: 'FINISHED',
      git: { branches: [{ repoUrl: `github.com/${REPOSITORY}`, branch: binding.branch }] } };
    snapshot.repair = { base: A, head: C, status: 'ahead', complete: true, commits: [{
      sha: C, parents: [{ sha: A }], committer: { ...binding.cursorCommitter, type: 'Bot' }, files: [{ filename: 'docs/test.md' }],
      commit: { message: `fix\nSkillCheck-Repair: ${value.operationMarker}`, verification: { verified: true, reason: 'valid' } },
    }] };
  }
  return { binding, snapshot, calls, args, finding, finish, state: () => structuredClone(value) };
}

function protectionFixture() {
  const root = `/repos/${REPOSITORY}`;
  const exact = { ref_name: { include: ['refs/heads/agent-feedback-state'], exclude: [] } };
  const sets = [
    { id: 1, enforcement: 'active', target: 'branch', conditions: structuredClone(exact),
      rules: [{ type: 'creation' }, { type: 'update' }], bypass_actors: [{ actor_type: 'Integration', actor_id: 12, bypass_mode: 'always' }] },
    { id: 2, enforcement: 'active', target: 'branch', conditions: structuredClone(exact),
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }], bypass_actors: [] },
  ];
  const applies = { 'agent-feedback-state': [1, 2], main: [], integration: [] };
  const calls = [];
  const github = { async request(path) {
    calls.push(path);
    const url = new URL(path, 'https://api.github.com');
    if (url.pathname.startsWith(`${root}/rules/branches/`)) {
      const name = url.pathname.split('/').at(-1);
      if (applies[name] instanceof Error) throw applies[name];
      const ids = applies[name];
      assert.ok(ids, name);
      const page = Number(url.searchParams.get('page') || 1);
      return ids.slice((page - 1) * 100, page * 100).map(ruleset_id => ({ ruleset_id }));
    }
    if (url.pathname.startsWith(`${root}/rulesets/`)) {
      const result = sets.find(s => s.id === Number(url.pathname.split('/').at(-1)));
      assert.ok(result, path); return structuredClone(result);
    }
    if (path.endsWith('/deployment-branch-policies')) return { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
    if (path.endsWith('/environments/agent-control')) return { deployment_branch_policy: { custom_branch_policies: true } };
    throw new Error(`Unexpected test read ${path}`);
  } };
  return { sets, applies, calls, run: () => verifyFeedbackProtection(github, 12) };
}

test('pilot usage is attributed only to its unique reserved run, never agent-wide total', () => {
  const report = costMeasurement({ totalUsage: { totalTokens: 9012 }, runs: [
    { id: 'previous', usage: { totalTokens: 9000 } }, { id: 'reserved', usage: { totalTokens: 12 } },
  ] }, 'reserved');
  assert.equal(report.cursorTotalTokens, 12);
  assert.equal(report.cursorChargedCents, null);
  assert.equal(report.cursorCostStatus, 'UNAVAILABLE');
});

test('missing, ambiguous or invalid run usage cannot be substituted with an aggregate', () => {
  for (const runs of [undefined, null, {}, [], [{ id: 'other', usage: { totalTokens: 10 } }],
    [{ id: 'reserved', usage: { totalTokens: 1 } }, { id: 'reserved', usage: { totalTokens: 2 } }],
    ...[-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1].map(totalTokens => [{ id: 'reserved', usage: { totalTokens } }]),
    [{ id: 'reserved' }], [null]]) {
    assert.equal(costMeasurement({ totalUsage: { totalTokens: 999 }, runs }, 'reserved').cursorTotalTokens, null);
  }
  assert.equal(costMeasurement({ runs: [{ id: '', usage: { totalTokens: 10 } }] }, '').cursorTotalTokens, null);
  assert.equal(costMeasurement({ runs: [{ id: 'reserved', usage: { totalTokens: 0 } }] }, 'reserved').cursorTotalTokens, null);
});

test('terminal pilot passes its durable run ID to the measurement, once per normal completion', async () => {
  const f = feedbackFixture(); let usageReads = 0;
  f.args.readHead = async () => A;
  f.args.cursor.getRun = async (_agent, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => { usageReads++; return { totalUsage: { totalTokens: 4012 }, runs: [
    { id: 'old', usage: { totalTokens: 4000 } }, { id: 'run-1', usage: { totalTokens: 12 } },
  ] }; };
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_RUNNING');
  assert.equal(usageReads, 0);
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_CURSOR_DONE');
  assert.equal(f.state().cursorTotalTokens, 12);
  assert.equal(f.calls.runs.length, 1); assert.equal(usageReads, 1);
});

test('already-reviewed repaired head enters the next repair without a redundant Codex request', async () => {
  const f = feedbackFixture(); f.finding(A);
  assert.equal(await runFeedback(f.args), 'FIXING');
  f.finish(); f.finding(C, 301);
  assert.equal(await runFeedback(f.args), 'FIXING');
  assert.equal(f.calls.reviews.length, 0);
  assert.equal(f.calls.runs.length, 2);
  assert.equal(f.state().repairHead, C); assert.equal(f.state().rounds, 2);
  assert.match(f.calls.runs[1], /discussion_r301/);
  assert.deepEqual(f.calls.reservations.at(-1), [5, 3]);
  assert.equal(f.state().ledgerHold, 3);
});

test('findings do not bypass signed repair evidence or the three-round limit', async () => {
  const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish(); f.finding(C, 301);
  f.snapshot.repair.commits[0].commit.verification.verified = false;
  assert.equal(await runFeedback(f.args), 'BLOCKED_PROVENANCE');
  assert.equal(f.calls.reviews.length, 0); assert.equal(f.calls.runs.length, 1);
  const g = feedbackFixture(); g.finding(A); await runFeedback(g.args); g.finish(); g.finding(C, 301);
  const saved = await g.args.store.read(); await g.args.store.save({ ...saved.value, rounds: 3 }, saved.revision);
  assert.equal(await runFeedback(g.args), 'BLOCKED_ROUND_LIMIT');
  assert.equal(g.calls.reviews.length, 0); assert.equal(g.calls.runs.length, 1);
});

test('findings arriving in the final pre-review read preserve a repairable state instead of posting review', async () => {
  const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish();
  let reads = 0;
  f.args.readSnapshot = async () => { if (++reads === 2) f.finding(C, 301); return structuredClone(f.snapshot); };
  assert.equal(await runFeedback(f.args), 'FIXING');
  assert.equal(f.calls.reviews.length, 0); assert.equal(f.calls.runs.length, 1);
  assert.equal(f.state().ledgerHold, 1);
  assert.equal(await runFeedback(f.args), 'FIXING');
  assert.equal(f.calls.reviews.length, 0); assert.equal(f.calls.runs.length, 2);
});

test('routine prompts do not invent an owner acceptance gate but retain production restrictions', async () => {
  const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish(); await runFeedback(f.args);
  for (const prompt of [...f.calls.runs, ...f.calls.reviews]) {
    assert.doesNotMatch(prompt, /Owner acceptance and production approval remain pending/i);
    assert.match(prompt, /Production approval remains separate/);
  }
  assert.match(fixPrompt(f.binding, { head: A, marker: 'x', findings: [] }), /No merge/);
});

test('exact state-only bypass is accepted, but source-branch rules are independently read', async () => {
  const f = protectionFixture(); await f.run();
  assert.ok(f.calls.some(p => p.includes('/rules/branches/main')));
  assert.ok(f.calls.some(p => p.includes('/rules/branches/integration')));
});

for (const include of [['~ALL'], ['refs/heads/*'], ['refs/heads/agent-feedback-state', 'refs/heads/main'], ['refs/heads/agent-*'], ['~DEFAULT_BRANCH']]) {
  test(`state writer cannot use broad or additional target ${JSON.stringify(include)}`, async () => {
    const f = protectionFixture(); f.sets[0].conditions.ref_name.include = include;
    await assert.rejects(f.run(), /STATE_WRITER_SCOPE/);
  });
}

test('an additional unsafe bypass cannot be hidden by an otherwise-valid state writer', async () => {
  const f = protectionFixture();
  f.sets.push({ ...structuredClone(f.sets[0]), id: 3, conditions: { ref_name: { include: ['~ALL'], exclude: [] } } });
  f.applies['agent-feedback-state'].push(3);
  await assert.rejects(f.run(), /STATE_WRITER_SCOPE/);
});

for (const branch of ['main', 'integration']) {
  test(`source-only always bypass is rejected on ${branch} even when absent from the state endpoint`, async () => {
    const f = protectionFixture();
    f.sets.push({ ...structuredClone(f.sets[0]), id: 3, rules: [{ type: 'update' }],
      conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } } });
    f.applies[branch].push(3);
    await assert.rejects(f.run(), /SOURCE_WRITER_BYPASS/);
  });
}

test('failed or incomplete source-branch evidence is never accepted as no bypass', async () => {
  const f = protectionFixture(); f.applies.main = new Error('fixture read denied');
  await assert.rejects(f.run());
  const g = protectionFixture(); delete g.sets[0].conditions;
  await assert.rejects(g.run(), /STATE_WRITER_SCOPE|STATE_PROTECTION_MISSING/);
});

test('all source-branch pages are examined before certifying a safe writer', async () => {
  const f = protectionFixture();
  f.sets.push({ ...structuredClone(f.sets[0]), id: 3, conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } });
  f.applies.main = [...Array(100).fill(2), 3];
  await assert.rejects(f.run(), /SOURCE_WRITER_BYPASS/);
  assert.ok(f.calls.some(p => p.includes('/rules/branches/main?') && p.endsWith('page=2')));
});

test('PR-only writer on source branches is not confused with an always bypass', async () => {
  const f = protectionFixture();
  f.sets.push({ ...structuredClone(f.sets[0]), id: 3,
    conditions: { ref_name: { include: ['refs/heads/main', 'refs/heads/integration'], exclude: [] } },
    bypass_actors: [{ actor_type: 'Integration', actor_id: 12, bypass_mode: 'pull_request' }] });
  f.applies.main = [3]; f.applies.integration = [3];
  await f.run();
});

test('unavailable per-run usage is persisted explicitly, not as zero-cost evidence', async () => {
  const f = feedbackFixture(); f.args.readHead = async () => A;
  f.args.cursor.getRun = async (_agent, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => ({ totalUsage: { totalTokens: 9000 }, runs: [{ id: 'other', usage: { totalTokens: 9000 } }] });
  await runCostProbe(f.args); await runCostProbe(f.args);
  assert.equal(f.state().cursorTotalTokens, null);
  assert.equal(f.state().cursorUsageStatus, 'UNAVAILABLE');
  assert.equal(f.state().cursorCostStatus, 'UNAVAILABLE');
  assert.equal(f.state().cursorChargedCents, null);
});

for (const branch of ['main', 'integration']) {
  for (const mode of ['always', 'exempt', 'unknown', undefined]) {
    test(`source ${branch} rejects ${mode} App bypass even without update rules`, async () => {
      const f = protectionFixture();
      f.sets.push({ id: 3, enforcement: 'active', target: 'branch',
        conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
        rules: [{ type: 'pull_request' }, { type: 'required_status_checks' }],
        bypass_actors: [{ actor_type: 'Integration', actor_id: 12, bypass_mode: mode }] });
      f.applies[branch] = [3];
      await assert.rejects(f.run(), /SOURCE_WRITER_BYPASS/);
    });
  }
}

test('zero run usage is not proof that an executed repair consumed no tokens', async () => {
  const f = feedbackFixture(); f.args.readHead = async () => A;
  f.args.cursor.getRun = async (_id, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => ({ runs: [{ id: 'run-1', usage: { totalTokens: 0 } }] });
  await runCostProbe(f.args); await runCostProbe(f.args);
  assert.equal(f.state().cursorTotalTokens, null);
  assert.equal(f.state().cursorUsageStatus, 'UNAVAILABLE');
  assert.equal(f.state().cursorCostStatus, 'UNAVAILABLE');
});

test('review time precedes a slow post-request snapshot so a genuine response remains eligible', async () => {
  const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish();
  delete f.args.now;
  const realNow = Date.now; let clock = 10_000; let reads = 0;
  Date.now = () => clock;
  f.args.readSnapshot = async () => {
    const result = structuredClone(f.snapshot);
    if (++reads === 3) {
      // The review page has already been read. New response appears while the
      // other API reads for this post-request snapshot are still finishing.
      f.snapshot.reviews.push({ id: 401, user: reviewer, state: 'APPROVED', commit_id: C,
        submitted_at: new Date(11_000).toISOString() });
      clock = 14_000;
    }
    return result;
  };
  try {
    await runFeedback(f.args);
    assert.equal(f.state().reviewRequestedAt, 10_000);
    assert.equal(await runFeedback(f.args), 'READY_FOR_OWNER');
    assert.equal(f.calls.reviews.length, 1);
  } finally { Date.now = realNow; }
});

test('review timestamp uses the trusted comment creation time when returned', async () => {
  const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish();
  f.args.now = 20_000;
  f.args.postReview = async () => ({ id: 201, created_at: new Date(21_000).toISOString() });
  await runFeedback(f.args);
  assert.equal(f.state().reviewRequestedAt, 21_000);
});

test('a finished probe with no artifact expires, releases its hold once, and cannot redispatch', async () => {
  const f = feedbackFixture(); f.args.readHead = async () => A;
  let usageReads = 0;
  f.args.cursor.getRun = async (_id, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => { usageReads++; return { runs: [{ id: 'run-1', usage: { totalTokens: 7 } }] }; };
  await runCostProbe(f.args); await runCostProbe(f.args);
  const writes = f.calls.saves;
  f.args.now += 14 * 60 * 1000;
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_CURSOR_DONE');
  assert.equal(f.calls.saves, writes);
  f.args.now += 60 * 1000;
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_FAILED');
  assert.equal(f.state().failure, 'NO_ARTIFACT');
  assert.equal(f.state().ledgerHold, undefined);
  assert.deepEqual(f.calls.reservations.at(-1), [1, 2]);
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_FAILED');
  assert.equal(f.calls.runs.length, 1); assert.equal(f.calls.reviews.length, 0);
  assert.equal(usageReads, 1); assert.equal(f.calls.saves, writes + 1);
});

test('a failed no-artifact CAS cannot release the durable probe hold', async () => {
  const f = feedbackFixture(); f.args.readHead = async () => A;
  f.args.cursor.getRun = async (_id, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => ({ runs: [] });
  await runCostProbe(f.args); await runCostProbe(f.args);
  f.args.now += 16 * 60 * 1000;
  const reservations = f.calls.reservations.length;
  const store = f.args.store;
  f.args.store = { read: store.read, async save() { throw new Error('CAS failure'); } };
  await assert.rejects(runCostProbe(f.args), /CAS failure/);
  assert.equal(f.calls.reservations.length, reservations);
  assert.equal(f.state().ledgerHold, 2);
  f.args.store = store;
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_FAILED');
});

test('late findings withdrawn before the next poll cannot strand a requestless WAITING state', async () => {
  const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish();
  let reads = 0;
  f.args.readSnapshot = async () => { if (++reads === 2) f.finding(C, 301); return structuredClone(f.snapshot); };
  await runFeedback(f.args);
  assert.equal(f.calls.reviews.length, 0);
  // Recreate a coordinator restart from the stored JSON, then withdraw the finding.
  const saved = await f.args.store.read(); await f.args.store.save(JSON.parse(JSON.stringify(saved.value)), saved.revision);
  f.snapshot.reviews = []; f.snapshot.comments = [];
  assert.equal(await runFeedback(f.args), 'WAITING_REVIEW');
  assert.equal(f.calls.reviews.length, 1);
  assert.ok(f.state().reviewCommentId);
  assert.equal(f.calls.runs.length, 1);
});

test('late-finding recovery still validates the repair signature and can reach its original timeout', async () => {
  for (const failure of ['signature', 'timeout']) {
    const f = feedbackFixture(); f.finding(A); await runFeedback(f.args); f.finish();
    let reads = 0;
    f.args.readSnapshot = async () => { if (++reads === 2) f.finding(C, 301); return structuredClone(f.snapshot); };
    await runFeedback(f.args);
    f.snapshot.comments = []; f.snapshot.reviews = [];
    if (failure === 'signature') f.snapshot.repair.commits[0].commit.verification.verified = false;
    else f.args.now += 2 * 60 * 60 * 1000 + 1;
    assert.equal(await runFeedback(f.args), failure === 'signature' ? 'BLOCKED_PROVENANCE' : 'BLOCKED_TIMEOUT');
    assert.equal(f.calls.runs.length, 1); assert.equal(f.calls.reviews.length, 0);
    assert.equal(f.state().ledgerHold, undefined);
  }
});

test('artifact arriving inside propagation grace is verified and reviewed only once', async () => {
  const f = feedbackFixture(); f.args.readHead = async () => A;
  f.args.cursor.getRun = async (_id, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => ({ runs: [] });
  await runCostProbe(f.args); await runCostProbe(f.args);
  f.args.now += 14 * 60 * 1000;
  f.finish();
  f.snapshot.repair.commits[0].commit.message = `probe\nSkillCheck-Cost-Probe: ${f.state().operationMarker}`;
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_DONE');
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_DONE');
  assert.equal(f.calls.reviews.length, 1); assert.equal(f.calls.runs.length, 1);
});

test('legacy no-artifact states without a reliable terminal timestamp fail closed once', async () => {
  const f = feedbackFixture(); f.args.readHead = async () => A;
  f.args.cursor.getRun = async (_id, id) => ({ id, agentId: f.binding.agentId, status: 'FINISHED' });
  f.args.cursor.getUsage = async () => ({ runs: [] });
  await runCostProbe(f.args); await runCostProbe(f.args);
  const saved = await f.args.store.read(); delete saved.value.cursorFinishedAt;
  await f.args.store.save(saved.value, saved.revision);
  assert.equal(await runCostProbe(f.args), 'COST_PROBE_FAILED');
  assert.equal(f.state().ledgerHold, undefined);
  assert.equal(f.calls.reviews.length, 0);
});

test('late-finding recovery at full ledger cannot spend another lifecycle, but can still record timeout', async () => {
  const { accountLedger } = await import('../../tools/agent-pipeline/feedback.mjs');
  const f = feedbackFixture(); let used = 95;
  f.args.reserveLedger = (writes, held) => { used = accountLedger(used, writes, held); };
  f.finding(A); await runFeedback(f.args); f.finish();
  let reads = 0;
  f.args.readSnapshot = async () => { if (++reads === 2) f.finding(C, 301); return structuredClone(f.snapshot); };
  assert.equal(await runFeedback(f.args), 'FIXING');
  f.snapshot.comments = []; f.snapshot.reviews = [];
  const writes = f.calls.saves;
  await assert.rejects(runFeedback(f.args), /LEDGER_CAPACITY/);
  assert.equal(f.calls.saves, writes); assert.equal(used, 100);
  assert.equal(f.state().ledgerHold, 1);
  f.args.now += 2 * 60 * 60 * 1000 + 1;
  assert.equal(await runFeedback(f.args), 'BLOCKED_TIMEOUT');
  assert.equal(f.state().ledgerHold, undefined); assert.equal(used, 100);
  assert.equal(f.calls.runs.length, 1); assert.equal(f.calls.reviews.length, 0);
});
