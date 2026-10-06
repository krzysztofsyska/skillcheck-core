import { createSign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { canonicalJson } from './canonical.mjs';

export function githubAppJwt({ appId, privateKey, now = Date.now() }) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 9 * 60,
    iss: String(appId),
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

export function protectionFromRulesets(rulesets) {
  const list = Array.isArray(rulesets) ? rulesets : [];
  const writers = list.find(rule => rule.name === 'writers-only' && rule.enforcement === 'active');
  const quality = list.find(rule => rule.name === 'quality-gates' && rule.enforcement === 'active');
  const agentState = list.find(rule => rule.name === 'agent-state-integrity' && rule.enforcement === 'active');
  const serialized = JSON.stringify(list);
  return {
    exclusiveWritersConfirmed: Boolean(writers && Array.isArray(writers.bypass_actors) && writers.bypass_actors.length === 1),
    scOps001Exception: serialized.includes('SC-OPS-001'),
    mainProtected: Boolean(quality && quality.rules?.some(rule => rule.type === 'pull_request')),
    integrationProtected: Boolean(quality && quality.rules?.some(rule => rule.type === 'pull_request')),
    agentStateProtected: Boolean(agentState && agentState.rules?.some(rule => rule.type === 'deletion' || rule.type === 'non_fast_forward')),
    qualityGatesBypass: Boolean(quality?.bypass_actors?.length),
    administrationWriteUsed: false,
    requiredChecksPinnedToApp: Boolean(quality?.rules?.some(rule => rule.type === 'required_status_checks' && rule.parameters?.strict_required_status_checks_policy === true)),
  };
}

export function createGitHubClient({ fetch: fetchImpl, token, repository, apiBase = 'https://api.github.com' }) {
  const [owner, repo] = String(repository).split('/');
  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) {
      const error = new Error(payload?.message || `http_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
  return {
    request,
    async readProtection() {
      const listed = await request(`/repos/${owner}/${repo}/rulesets`);
      const detailed = [];
      for (const item of listed ?? []) {
        detailed.push(await request(`/repos/${owner}/${repo}/rulesets/${item.id}`));
      }
      return protectionFromRulesets(detailed);
    },
    async readBranch(name) {
      return request(`/repos/${owner}/${repo}/branches/${encodeURIComponent(name)}`);
    },
    async readIssues() {
      return request(`/repos/${owner}/${repo}/issues?state=open&per_page=50`);
    },
    async readPulls() {
      return request(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`);
    },
    async readChangedFiles(base, head) {
      const compared = await request(`/repos/${owner}/${repo}/compare/${base}...${head}`);
      return (compared.files ?? []).map(file => file.filename).filter(Boolean);
    },
    async readProjection() {
      try {
        const indexPayload = await request(`/repos/${owner}/${repo}/contents/state/index.json?ref=agent-state`);
        const index = JSON.parse(decodeGithubContent(indexPayload));
        const tasks = {};
        for (const taskId of Object.keys(index.tasks ?? {})) {
          const file = await request(`/repos/${owner}/${repo}/contents/state/tasks/${safeTaskId(taskId)}.json?ref=agent-state`);
          tasks[taskId] = JSON.parse(decodeGithubContent(file));
        }
        let mergeLock = null;
        try {
          const lock = await request(`/repos/${owner}/${repo}/contents/locks/merge.json?ref=agent-state`);
          mergeLock = JSON.parse(decodeGithubContent(lock));
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        const ref = await request(`/repos/${owner}/${repo}/git/ref/heads/agent-state`);
        return { tasks, mergeLock, head: ref.object.sha, index };
      } catch (error) {
        if (error.status !== 404) throw error;
        return { tasks: {}, mergeLock: null, head: null, index: { schema_version: 1, tasks: {} } };
      }
    },
    async commitProjection({ tasks, mergeLock = null, expectedHead, message }) {
      const index = { schema_version: 1, tasks: {} };
      const files = {};
      for (const [taskId, record] of Object.entries(tasks ?? {})) {
        index.tasks[taskId] = { revision: record.state_revision };
        files[`state/tasks/${safeTaskId(taskId)}.json`] = `${canonicalJson(record)}\n`;
      }
      files['state/index.json'] = `${canonicalJson(index)}\n`;
      if (mergeLock) files['locks/merge.json'] = `${canonicalJson(mergeLock)}\n`;
      const treeItems = [];
      for (const [path, content] of Object.entries(files)) {
        const blob = await request(`/repos/${owner}/${repo}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
        treeItems.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const tree = await request(`/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        body: expectedHead ? { base_tree: expectedHead, tree: treeItems } : { tree: treeItems },
      });
      const commit = await request(`/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        body: { message, tree: tree.sha, parents: expectedHead ? [expectedHead] : [] },
      });
      if (!expectedHead) {
        await request(`/repos/${owner}/${repo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/agent-state', sha: commit.sha } });
        return { ok: true, sha: commit.sha, created: true };
      }
      try {
        await request(`/repos/${owner}/${repo}/git/refs/heads/agent-state`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return { ok: true, sha: commit.sha, previous: expectedHead };
      } catch (error) {
        if (error.status === 422) return { ok: false, conflict: true, expected: expectedHead };
        throw error;
      }
    },
    async listWorkflowRuns(workflowFile) {
      const payload = await request(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=20`);
      return payload.workflow_runs ?? [];
    },
    async listArtifacts(runId) {
      const payload = await request(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=20`);
      return payload.artifacts ?? [];
    },
    async downloadArtifactJson(artifactId) {
      const response = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      const zipped = response.status >= 300 && response.status < 400 && location
        ? await fetchImpl(location)
        : response;
      if (!zipped.ok) {
        const error = new Error(`artifact_http_${zipped.status}`);
        error.status = zipped.status;
        throw error;
      }
      const entries = unzipEntries(Buffer.from(await zipped.arrayBuffer()));
      const json = entries.find(entry => entry.name.endsWith('.json'));
      if (!json) return null;
      return JSON.parse(json.content.toString('utf8'));
    },
    async readApprovals(runId) {
      return request(`/repos/${owner}/${repo}/actions/runs/${runId}/approvals`);
    },
    async readJobs(runId) {
      const payload = await request(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
      return payload.jobs ?? [];
    },
    async readStateFile(path) {
      return request(`/repos/${owner}/${repo}/contents/${path}?ref=agent-state`);
    },
    async createPull({ head, base, title, body }) {
      return request(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body: { head, base, title, body, draft: true } });
    },
    async dispatch({ workflow, inputs, ref = 'main' }) {
      const file = workflow.split('/').at(-1);
      const listed = await request(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=5`);
      const known = new Set((listed.workflow_runs ?? []).map(run => run.id));
      await request(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { method: 'POST', body: { ref, inputs: stringifyInputs(inputs) } });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const after = await request(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=5`);
        const fresh = (after.workflow_runs ?? []).filter(run => !known.has(run.id));
        if (fresh.length === 1) return { run_id: fresh[0].id, run_attempt: fresh[0].run_attempt, dispatched: true };
        if (fresh.length > 1) {
          const error = new Error('DISPATCH_UNKNOWN');
          error.code = 'DISPATCH_UNKNOWN';
          throw error;
        }
      }
      return { run_id: null, dispatched: true };
    },
    async merge({ prNumber, sha }) {
      return request(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, { method: 'PUT', body: { sha, merge_method: 'merge' } });
    },
    async comment({ issueNumber, body }) {
      return request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { method: 'POST', body: { body } });
    },
  };
}

export async function createInstallationToken({ fetch: fetchImpl, appId, privateKey, installationId, repository, apiBase = 'https://api.github.com' }) {
  const jwt = githubAppJwt({ appId, privateKey: privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey });
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${jwt}` };
  let installation = installationId;
  if (!installation) {
    const response = await fetchImpl(`${apiBase}/app/installations`, { headers });
    const installations = await response.json();
    if (!response.ok) {
      const error = new Error('installation lookup failed');
      error.status = response.status;
      throw error;
    }
    const [owner, repo] = String(repository).split('/');
    installation = installations.find(item => item.account?.login === owner)?.id;
    if (!installation) throw new Error('BLOCKED_CONFIGURATION');
    void repo;
  }
  const response = await fetchImpl(`${apiBase}/app/installations/${installation}/access_tokens`, { method: 'POST', headers });
  const payload = await response.json();
  if (!response.ok || !payload.token) {
    const error = new Error('installation token failed');
    error.status = response.status;
    throw error;
  }
  return payload.token;
}

function stringifyInputs(inputs = {}) {
  return Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value == null ? '' : String(value)]));
}

export function decodeGithubContent(payload) {
  if (!payload?.content) return '';
  return Buffer.from(payload.content, 'base64').toString('utf8');
}

export function safeTaskId(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function unzipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!content) {
      const error = new Error(`unsupported zip method ${method}`);
      error.code = 'ZIP';
      throw error;
    }
    entries.push({ name, content });
    offset = dataStart + compressedSize;
  }
  return entries;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}
