import { preparePromotion } from './promotion.mjs';
import { guardedMerge, publishEvidence, drainOutbox, cancelStaleApprovals } from './live-effects.mjs';
import { readEvidence, readApprovals } from './evidence.mjs';
import { randomUUID } from 'node:crypto';
import { createLiveJournal } from './live-journal.mjs';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sha256 } from './canonical.mjs';
import { createMemoryJournal, tick } from './controller.mjs';
import { assessConfiguration } from './configuration.mjs';
import { flagsFromEnv, loadPolicy } from './policy.mjs';
import { evaluatePreflight } from './merge.mjs';
import { createCursorClient } from './cursor.mjs';
import { createGitHubClient, createInstallationToken } from './github.mjs';
import { assembleWork, cursorSnapshot } from './snapshot.mjs';

const DISPATCH_INPUTS = {
  verify: ['request_id', 'head_sha', 'base_sha', 'policy_sha', 'task_id'],
  review: ['head_sha', 'base_sha', 'policy_sha', 'request_id', 'repository_id', 'pr_number', 'review_packet'],
  accept: ['request_id', 'digest', 'task_id', 'head_sha', 'base_sha'],
  promote: ['request_id', 'digest', 'task_id', 'integration_sha', 'main_sha', 'manifest_hash'],
};

export async function reconcile({
  flags,
  configuration,
  policy,
  journal,
  loadWork,
  ports,
  tickImpl = tick,
  now = new Date().toISOString(),
}) {
  const reads = { work: false, protection: false };
  if (flags.enabled && !configuration.ok) {
    return {
      status: 'NOT_CONFIGURED',
      mode: 'live',
      effects: [],
      controllerInvoked: false,
      reads,
      missing: configuration.missing,
      flags,
    };
  }
  const work = await loadWork({ flags, configuration, policy, now });
  reads.work = true;
  let protection = null;
  if (ports.readProtection) {
    protection = await ports.readProtection();
    reads.protection = protection != null;
  }
  const preflight = protection ? evaluatePreflight(protection) : { ok: false, reason: 'PROTECTION_UNCONFIRMED' };
  const effectiveFlags = {
    enabled: flags.enabled,
    mergeEnabled: Boolean(flags.enabled && flags.mergeEnabled && preflight.ok),
  };
  const results = [];
  for (const item of (work.items ?? []).slice(0, 1)) {
    const observation = {
      ...item.observation,
      now: item.observation.now ?? now,
      simulation: false,
      flags: effectiveFlags,
      preflight,
      lockHolder: journal?.holder,
      github: { ...item.observation.github, protection: protection ?? item.observation.github?.protection ?? null },
    };
    const result = await tickImpl({ record: item.record ?? null, observation, journal, ports });
    if (flags.enabled && ports.github && result.record) {
      result.record = await cancelStaleApprovals({ github: ports.github, journal, policy, record: result.record, now });
      await publishEvidence(ports.github, policy, result.record, { ci: observation.github.ci, review: observation.github.review });
      result.record = await drainOutbox({ github: ports.github, journal, policy, record: result.record, now });
    }
    results.push(result);
  }
  const effects = results.flatMap(result => result.executed ?? []);
  return {
    status: flags.enabled ? 'RECONCILED' : 'READ_ONLY',
    mode: flags.enabled ? 'live' : 'read-only',
    effects: effects.map(item => item.effect?.type).filter(Boolean),
    controllerInvoked: (work.items ?? []).length > 0,
    reads,
    preflight,
    flags: effectiveFlags,
    results,
    work,
  };
}

export async function reconcileFromEnv(env = process.env, overrides = {}) {
  const flags = overrides.flags ?? flagsFromEnv(env);
  const configuration = overrides.configuration ?? assessConfiguration(env, flags);
  const policy = overrides.policy ?? loadPolicy();
  if (flags.enabled && configuration.ok) {
    const missing = [];
    if (!Number.isInteger(policy.controller_app_id) || Number(env.AGENT_PIPELINE_APP_ID) !== policy.controller_app_id) missing.push('controller_app_id');
    if (!Number.isInteger(policy.controller_actor_id)) missing.push('controller_actor_id');
    for (const key of ['verify','review','accept','promote']) if (!Number.isInteger(policy.workflow_ids[key])) missing.push(`workflow_ids.${key}`);
    for (const key of ['owner_acceptance','production_approval']) if (!Number.isInteger(policy.environments[key].id)) missing.push(`environments.${key}.id`);
    if (!/^[a-f0-9]{40}$/.test(env.AGENT_POLICY_COMMIT ?? '')) missing.push('AGENT_POLICY_COMMIT');
    if (missing.length) return { status: 'NOT_CONFIGURED', controllerInvoked: false, effects: [], flags, missing };
  }
  const ports = overrides.ports ?? await defaultPorts(env, policy, configuration, flags);
  const journal = overrides.journal ?? (flags.enabled && configuration.ok ? null : createMemoryJournal());
  const loadWork = overrides.loadWork ?? (async () => loadWorkFromEnv(env, policy, flags, configuration, ports.github));
  const liveJournal = journal ?? createLiveJournal(ports.github, `${env.GITHUB_RUN_ID || 'local'}:${randomUUID()}`, Number(env.GITHUB_RUN_ID) || null);
  if (liveJournal.acquire) await liveJournal.acquire();
  ports.journal = liveJournal;
  try { return await reconcile({ flags, configuration, policy, journal: liveJournal, loadWork, ports, tickImpl: overrides.tickImpl, now: overrides.now }); }
  finally { if (liveJournal.release) await liveJournal.release(); }
}

export function dispatchInputs(effect) {
  const keys = DISPATCH_INPUTS[effect.workflow];
  if (!keys) {
    const error = new Error(`unsupported workflow ${effect.workflow}`);
    error.code = 'BLOCKED_CONFIGURATION';
    throw error;
  }
  const source = {
    head_sha: effect.headSha,
    base_sha: effect.baseSha,
    policy_sha: effect.policySha,
    task_id: effect.taskId,
    request_id: effect.requestId,
    repository_id: effect.repositoryId,
    pr_number: effect.prNumber,
    digest: effect.digest,
    integration_sha: effect.integrationSha,
    main_sha: effect.mainSha,
    manifest_hash: effect.manifestHash,
    review_packet: effect.packet ? JSON.stringify(effect.packet) : null,
  };
  const inputs = {};
  for (const key of keys) {
    if (source[key] == null || source[key] === '') {
      const error = new Error(`missing dispatch input ${key}`);
      error.code = 'BLOCKED_CONFIGURATION';
      throw error;
    }
    inputs[key] = source[key];
  }
  return inputs;
}

export async function loadWorkFromClients({ github, cursor = null, policy, now, secrets, prompts = null, policyCommit = null }) {
  const [integration, main, issues, pulls, projection] = await Promise.all([
    github.readBranch('integration'),
    github.readBranch('main'),
    github.readIssues(),
    github.readPulls(),
    github.readProjection(),
  ]);
  let protection = null;
  try {
    protection = await github.readProtection();
  } catch (error) {
    if (error.status !== 401 && error.status !== 403 && error.status !== 404) throw error;
  }
  if (policyCommit && policyCommit !== main?.commit?.sha) throw new Error('POLICY_STALE');
  if (github.readRepository && (await github.readRepository()).id !== policy.repository_id) throw new Error('REPOSITORY_MISMATCH');
  const records = projection.tasks ?? {};
  for (const record of Object.values(records)) {
    if (record.binding?.lane !== 'promotion' && record.issue_number && github.readIssue) {
      const issue = await github.readIssue(record.issue_number);
      const index = issues.findIndex(item => item.number === issue.number);
      if (index < 0) issues.push(issue); else issues[index] = issue;
    }
    if (record.pr_number && github.readPull) { const pull = await github.readPull(record.pr_number); const old = pulls.findIndex(p => p.number === pull.number); if (old < 0) pulls.push(pull); else pulls[old] = pull; }
  }
  const branches = {};
  const cursorState = {};
  for (const record of Object.values(records)) {
    const name = record.binding?.branch;
    if (name && !branches[name]) branches[name] = await readTaskBranch(github, name, record.base_sha || integration?.commit?.sha);
    if (cursor && record.cursor_agent_id && !cursorState[record.cursor_agent_id]) {
      cursorState[record.cursor_agent_id] = await readCursor(cursor, record.cursor_agent_id);
    }
  }
  const promotion = github.readComparison ? await preparePromotion(github, policy, records, integration?.commit?.sha, main?.commit?.sha) : null;
  const evidence = await readEvidence(github, policy, records);
  const approvals = await readApprovals(github, policy, records);
  const policySha = main?.commit?.sha;
  if (!/^[a-f0-9]{40}$/.test(policySha ?? '')) throw new Error('POLICY_COMMIT_MISSING');
  return assembleWork({
    policy,
    policySha,
    now,
    secrets,
    prompts,
    snapshot: {
      integrationSha: integration?.commit?.sha ?? null,
      mainSha: main?.commit?.sha ?? null,
      issues: Array.isArray(issues) ? issues : [],
      pulls: Array.isArray(pulls) ? pulls : [],
      records,
      branches,
      cursor: cursorState,
      evidence,
      approvals,
      protection,
      mergeLock: projection.mergeLock ?? null,
      promotion,
      promotions: promotion ? { [promotion.taskId]: promotion } : {},
      read: 'github',
    },
  });
}

async function loadWorkFromEnv(env, policy, flags, configuration, sharedGithub) {
  const token = env.GITHUB_TOKEN || env.AGENT_PIPELINE_GITHUB_TOKEN;
  if (!token && !sharedGithub) { if (flags.enabled) throw new Error('BLOCKED_CONFIGURATION'); return { items: [], read: 'skipped-no-token' }; }
  const repository = env.GITHUB_REPOSITORY || env.AGENT_PIPELINE_REPOSITORY || policy.repository;
  const github = sharedGithub ?? createGitHubClient({ fetch: globalThis.fetch, token, repository, policy });
  const cursor = env.CURSOR_API_KEY ? createCursorClient({ fetch: globalThis.fetch, apiKey: env.CURSOR_API_KEY, baseUrl: policy.cursor_api_base }) : null;
  const work = await loadWorkFromClients({
    github,
    cursor,
    policy,
    now: new Date().toISOString(),
    secrets: secretsFromEnv(env),
    prompts: readPrompts(),
    policyCommit: env.AGENT_POLICY_COMMIT,
  });
  if (flags.enabled && !configuration.ok) return work;
  return work;
}

export async function defaultPorts(env, policy, configuration, flags) {
  const repository = env.GITHUB_REPOSITORY || env.AGENT_PIPELINE_REPOSITORY || policy.repository;
  const readToken = env.GITHUB_TOKEN || env.AGENT_PIPELINE_GITHUB_TOKEN;
  const readClient = readToken ? createGitHubClient({ fetch: globalThis.fetch, token: readToken, repository, policy }) : null;
  if (!flags.enabled || !configuration.ok) {
    return {
      async readProtection() {
        if (!readClient) return null;
        try {
          return await readClient.readProtection();
        } catch (error) {
          if (error.status === 401 || error.status === 403 || error.status === 404) return null;
          throw error;
        }
      },
      async execute() {
        const error = new Error('effects are blocked');
        error.code = 'EFFECTS_BLOCKED';
        throw error;
      },
    };
  }
  const token = env.AGENT_PIPELINE_APP_ID
    ? await createInstallationToken({
      fetch: globalThis.fetch,
      appId: env.AGENT_PIPELINE_APP_ID,
      privateKey: env.AGENT_PIPELINE_APP_PRIVATE_KEY,
      installationId: env.AGENT_PIPELINE_APP_INSTALLATION_ID,
      repository,
    })
    : (env.AGENT_PIPELINE_GITHUB_TOKEN || env.GITHUB_TOKEN);
  const github = createGitHubClient({ fetch: globalThis.fetch, token, repository, policy });
  const cursor = createCursorClient({ fetch: globalThis.fetch, apiKey: env.CURSOR_API_KEY, baseUrl: policy.cursor_api_base });
  return {
    github,
    async readProtection() {
      try {
        return await github.readProtection();
      } catch (error) {
        if (error.status === 401 || error.status === 403 || error.status === 404) return null;
        throw error;
      }
    },
    async execute(effect) {
      if (effect.type === 'cursor.create') {
        await github.createBranch(effect.branch, effect.baseSha);
        return normalizeCursorCreate(await cursor.createAgent(effect.payload));
      }
      if (effect.type === 'cursor.get') {
        const raw = await cursor.getAgent(effect.agentId);
        const agent = raw?.agent ?? raw;
        if (agent?.id !== effect.agentId || agent.workOnCurrentBranch !== true || agent.autoCreatePR !== false
            || agent.repos?.length !== 1 || agent.repos[0].url !== policy.repository_url
            || agent.repos[0].startingRef !== effect.branch || agent.repos[0].prUrl) throw new Error('CURSOR_IDENTITY_MISMATCH');
        return normalizeCursorCreate(raw);
      }
      if (effect.type === 'cursor.followup') return normalizeCursorRun(await cursor.createRun(effect.agentId, effect.payload));
      if (effect.type === 'cursor.listRuns') return cursor.listRuns(effect.agentId);
      if (effect.type === 'github.createPr') return github.createPull({ head: effect.head, base: effect.base, title: effect.taskId, body: `${effect.marker}\nTASK: ${effect.taskId}\nSCOPE: ${effect.scope || 'OPERATIONS'}\nLEVEL: ${effect.level || 'L3'}\nOWNER_APPROVAL: PENDING\nPRODUCTION_APPROVAL: PENDING\nREVIEW_VERDICT: PENDING\nPROMOTION: ${effect.base === 'main' ? 'YES' : 'NO'}` });
      if (effect.type === 'github.dispatch') {
        return github.dispatch({ workflow: basename(policy.workflows[effect.workflow]), inputs: dispatchInputs(effect) });
      }
      if (effect.type === 'github.merge') return guardedMerge({ github, journal: this.journal, policy, flags, effect });
      if (effect.type === 'notify') return { deferred: true }; // durable outbox after transition
      throw new Error(`unsupported effect ${effect.type}`);
    },
  };
}

async function readTaskBranch(github, name, base) {
  try {
    const branch = await github.readBranch(name);
    const sha = branch?.commit?.sha ?? null;
    if (!sha) return null;
    const files = base ? await github.readChangedFiles(base, sha) : [];
    return { sha, files };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function readCursor(cursor, agentId) {
  try {
    const agent = await cursor.getAgent(agentId);
    const runs = await cursor.listRuns(agentId);
    const latest = agent.latestRunId;
    if (latest && cursor.getRun) {
      const detail = await cursor.getRun(agentId, latest);
      runs.items = (runs.items ?? []).map(run => run.id === latest ? detail : run);
    }
    return cursorSnapshot(agent, runs);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function normalizeCursorCreate(payload) {
  const agent = payload?.agent ?? payload ?? {};
  const run = payload?.run ?? null;
  const runId = run?.id ?? agent.latestRunId ?? payload?.latestRunId ?? null;
  return {
    agent: { id: agent.id ?? null, latestRunId: agent.latestRunId ?? payload?.latestRunId ?? null },
    run: runId ? { id: runId, status: run?.status ?? payload?.status ?? null } : null,
    status: payload?.status ?? null,
  };
}

function normalizeCursorRun(payload) {
  const run = payload?.run ?? payload ?? {};
  return { run: run.id ? { id: run.id, status: run.status ?? null } : null, status: payload?.status ?? null };
}

function secretsFromEnv(env) {
  return {
    cursor: Boolean(env.CURSOR_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
    githubApp: Boolean(env.AGENT_PIPELINE_APP_ID && env.AGENT_PIPELINE_APP_PRIVATE_KEY),
  };
}

function readPrompts() {
  try {
    return {
      build: readFileSync('.github/agent-pipeline/prompts/cursor-build.md', 'utf8'),
      fix: readFileSync('.github/agent-pipeline/prompts/cursor-fix.md', 'utf8'),
    };
  } catch {
    return null;
  }
}
