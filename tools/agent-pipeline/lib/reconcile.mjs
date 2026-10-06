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
  verify: ['head_sha', 'base_sha', 'policy_sha', 'task_id'],
  review: ['head_sha', 'base_sha', 'policy_sha', 'request_id', 'repository_id', 'pr_number'],
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
  for (const item of work.items ?? []) {
    const observation = {
      ...item.observation,
      now: item.observation.now ?? now,
      simulation: false,
      flags: effectiveFlags,
      github: { ...item.observation.github, protection: protection ?? item.observation.github?.protection ?? null },
    };
    results.push(await tickImpl({ record: item.record ?? null, observation, journal, ports }));
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
  const ports = overrides.ports ?? await defaultPorts(env, policy, configuration, flags);
  const journal = overrides.journal ?? (flags.enabled && configuration.ok ? null : createMemoryJournal());
  const loadWork = overrides.loadWork ?? (async () => loadWorkFromEnv(env, policy, flags, configuration));
  const liveJournal = journal ?? await githubJournal(env, policy, flags);
  return reconcile({ flags, configuration, policy, journal: liveJournal, loadWork, ports, tickImpl: overrides.tickImpl, now: overrides.now });
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

export async function loadWorkFromClients({ github, cursor = null, policy, now, secrets, prompts = null }) {
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
  const records = projection.tasks ?? {};
  const branches = {};
  const cursorState = {};
  for (const record of Object.values(records)) {
    const name = record.binding?.branch;
    if (name && !branches[name]) branches[name] = await readTaskBranch(github, name, record.base_sha || integration?.commit?.sha);
    if (cursor && record.cursor_agent_id && !cursorState[record.cursor_agent_id]) {
      cursorState[record.cursor_agent_id] = await readCursor(cursor, record.cursor_agent_id);
    }
  }
  const evidence = await readEvidence(github, policy);
  const approvals = await readApprovals(github, policy, records);
  const policySha = sha256(policy);
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
      promotions: {},
      read: 'github',
    },
  });
}

async function loadWorkFromEnv(env, policy, flags, configuration) {
  const token = env.GITHUB_TOKEN || env.AGENT_PIPELINE_GITHUB_TOKEN;
  if (!token) return { items: [], read: flags.enabled ? 'missing-token' : 'skipped-no-token' };
  const repository = env.GITHUB_REPOSITORY || env.AGENT_PIPELINE_REPOSITORY || policy.repository;
  const github = createGitHubClient({ fetch: globalThis.fetch, token, repository });
  const cursor = env.CURSOR_API_KEY ? createCursorClient({ fetch: globalThis.fetch, apiKey: env.CURSOR_API_KEY, baseUrl: policy.cursor_api_base }) : null;
  const work = await loadWorkFromClients({
    github,
    cursor,
    policy,
    now: new Date().toISOString(),
    secrets: secretsFromEnv(env),
    prompts: readPrompts(),
  });
  if (flags.enabled && !configuration.ok) return work;
  return work;
}

async function defaultPorts(env, policy, configuration, flags) {
  const repository = env.GITHUB_REPOSITORY || env.AGENT_PIPELINE_REPOSITORY || policy.repository;
  const readToken = env.GITHUB_TOKEN || env.AGENT_PIPELINE_GITHUB_TOKEN;
  const readClient = readToken ? createGitHubClient({ fetch: globalThis.fetch, token: readToken, repository }) : null;
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
  const github = createGitHubClient({ fetch: globalThis.fetch, token, repository });
  const cursor = createCursorClient({ fetch: globalThis.fetch, apiKey: env.CURSOR_API_KEY, baseUrl: policy.cursor_api_base });
  return {
    async readProtection() {
      try {
        return await github.readProtection();
      } catch (error) {
        if (error.status === 401 || error.status === 403 || error.status === 404) return null;
        throw error;
      }
    },
    async execute(effect) {
      if (effect.type === 'cursor.create') return normalizeCursorCreate(await cursor.createAgent(effect.payload));
      if (effect.type === 'cursor.get') return normalizeCursorCreate(await cursor.getAgent(effect.agentId));
      if (effect.type === 'cursor.followup') return normalizeCursorRun(await cursor.createRun(effect.agentId, effect.payload));
      if (effect.type === 'cursor.listRuns') return cursor.listRuns(effect.agentId);
      if (effect.type === 'github.createPr') return github.createPull({ head: effect.head, base: effect.base, title: effect.taskId, body: effect.marker });
      if (effect.type === 'github.dispatch') {
        return github.dispatch({ workflow: basename(policy.workflows[effect.workflow]), inputs: dispatchInputs(effect) });
      }
      if (effect.type === 'github.merge') return github.merge({ prNumber: effect.request?.path?.split('/').at(-2), sha: effect.request?.body?.sha });
      if (effect.type === 'notify') return github.comment({ issueNumber: effect.issueNumber, body: effect.notification.body });
      throw new Error(`unsupported effect ${effect.type}`);
    },
  };
}

async function githubJournal(env, policy, flags) {
  if (!flags.enabled) return createMemoryJournal();
  const repository = env.GITHUB_REPOSITORY || env.AGENT_PIPELINE_REPOSITORY || policy.repository;
  const token = env.AGENT_PIPELINE_APP_ID
    ? await createInstallationToken({
      fetch: globalThis.fetch,
      appId: env.AGENT_PIPELINE_APP_ID,
      privateKey: env.AGENT_PIPELINE_APP_PRIVATE_KEY,
      installationId: env.AGENT_PIPELINE_APP_INSTALLATION_ID,
      repository,
    })
    : (env.AGENT_PIPELINE_GITHUB_TOKEN || env.GITHUB_TOKEN);
  const github = createGitHubClient({ fetch: globalThis.fetch, token, repository });
  let cache = null;
  return {
    async save(record) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        cache = await github.readProjection();
        cache.tasks[record.task_id] = record;
        const result = await github.commitProjection({
          tasks: cache.tasks,
          mergeLock: cache.mergeLock,
          expectedHead: cache.head,
          message: `agent-state ${record.task_id} ${record.state}`,
        });
        if (result.ok) return result;
      }
      const error = new Error('AGENT_STATE_CONFLICT');
      error.code = 'AGENT_STATE_CONFLICT';
      throw error;
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
    return cursorSnapshot(agent, runs);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function readEvidence(github, policy) {
  const evidence = {};
  const verifyFile = basename(policy.workflows.verify);
  const reviewFile = basename(policy.workflows.review);
  const verifyRuns = await github.listWorkflowRuns(verifyFile).catch(ignoreMissing);
  const reviewRuns = await github.listWorkflowRuns(reviewFile).catch(ignoreMissing);
  for (const run of verifyRuns ?? []) {
    const envelope = await artifactFor(github, run, policy.workflows.verify);
    if (envelope?.head_sha && envelope.workflow_path === policy.workflows.verify) evidence[envelope.head_sha] = { ...(evidence[envelope.head_sha] ?? {}), ci: envelope };
  }
  for (const run of reviewRuns ?? []) {
    const envelope = await artifactFor(github, run, policy.workflows.review);
    if (envelope?.payload?.head_sha && envelope.workflow_path === policy.workflows.review) {
      const head = envelope.payload.head_sha;
      evidence[head] = { ...(evidence[head] ?? {}), review: envelope };
    }
  }
  return evidence;
}

async function readApprovals(github, policy, records) {
  const approvals = {};
  const files = [
    [policy.workflows.accept, 'A'],
    [policy.workflows.promote, 'B'],
  ];
  for (const [workflow, gate] of files) {
    const runs = await github.listWorkflowRuns(basename(workflow)).catch(ignoreMissing);
    for (const run of runs ?? []) {
      if (run.run_attempt !== 1) continue;
      const marker = await artifactFor(github, run, workflow);
      if (!marker?.request_id) continue;
      const jobs = await github.readJobs(run.id);
      const environment = environmentFromJobs(jobs);
      const payload = await github.readApprovals(run.id);
      approvals[marker.request_id] = {
        request_id: marker.request_id,
        run_id: run.id,
        run_attempt: run.run_attempt,
        workflow_id: gate === 'A' ? policy.workflow_ids.accept : policy.workflow_ids.promote,
        workflow_path: workflow,
        ref: run.head_branch ? `refs/heads/${run.head_branch}` : null,
        environment,
        payload: Array.isArray(payload) ? payload : [],
        html_url: run.html_url ?? null,
        gate,
      };
    }
  }
  void records;
  return approvals;
}

async function artifactFor(github, run, workflowPath) {
  if (run.path && run.path !== workflowPath) return null;
  const artifacts = await github.listArtifacts(run.id);
  const artifact = artifacts.find(item => item.name?.startsWith('sc-agent-'));
  if (!artifact) return null;
  return github.downloadArtifactJson(artifact.id);
}

function environmentFromJobs(jobs) {
  const raw = (jobs ?? []).map(job => job.environment).find(item => item);
  if (!raw) return null;
  if (typeof raw === 'string') return { name: raw, id: null };
  return { name: raw.name ?? null, id: raw.id ?? null };
}

function ignoreMissing(error) {
  if (error.status === 404) return [];
  throw error;
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
