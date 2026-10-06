import { createSign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { protectionFromRulesets } from './protection.mjs';
export { protectionFromRulesets } from './protection.mjs';
import { withTransportRetry } from './transport.mjs';
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

export function createGitHubClient({ fetch: fetchImpl, token, repository, apiBase = 'https://api.github.com', policy = {}, sleep }) {
  const [owner, repo] = String(repository).split('/');
  async function once(path, { method = 'GET', body } = {}) {
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
      error.retryAfter = response.headers?.get?.('retry-after');
      throw error;
    }
    return payload;
  }
  async function request(path, options = {}) {
    // Only reads are blindly retried. An uncertain mutation is reconciled by its
    // durable operation marker; it must never be repeated by transport retry.
    if (!options.method || options.method === 'GET') return withTransportRetry(() => once(path, options), { sleep });
    try { return await once(path, options); }
    catch (error) { if (!error.status) error.code = 'LOST_RESPONSE'; throw error; }
  }
  async function pages(path, key = null) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const body = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? body[key] : body;
      if (!Array.isArray(batch)) throw new Error('INVALID_API_COLLECTION');
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error('API_PAGINATION_LIMIT');
  }
  return {
    request,
    async readProtection() {
      const listed = await pages(`/repos/${owner}/${repo}/rulesets`);
      const detailed = [];
      for (const item of listed ?? []) {
        detailed.push(await request(`/repos/${owner}/${repo}/rulesets/${item.id}`));
      }
      const environments = {};
      for (const e of [policy.environments?.owner_acceptance, policy.environments?.production_approval]) {
        if (!e?.name) continue;
        const path = `/repos/${owner}/${repo}/environments/${encodeURIComponent(e.name)}`;
        const env = await request(path);
        env.branch_policies = await pages(`${path}/deployment-branch-policies`, 'branch_policies');
        environments[e.name] = env;
      }
      return protectionFromRulesets(detailed, policy, environments);
    },
    async readBranch(name) {
      return request(`/repos/${owner}/${repo}/branches/${encodeURIComponent(name)}`);
    },
    async readIssues() {
      return pages(`/repos/${owner}/${repo}/issues?state=open`);
    },
    async readPulls() {
      return pages(`/repos/${owner}/${repo}/pulls?state=open`);
    },
    async readChangedFiles(base, head) {
      const compared = await request(`/repos/${owner}/${repo}/compare/${base}...${head}`);
      if (!Array.isArray(compared.files) || compared.files.length >= 300) throw new Error('DIFF_INCOMPLETE');
      return [...new Set(compared.files.flatMap(file => [file.filename, file.previous_filename]).filter(Boolean))];
    },
    async readProjection() {
      let foundHead = false;
      try {
        const ref = await request(`/repos/${owner}/${repo}/git/ref/heads/agent-state`);
        const head = ref.object.sha; foundHead = true;
        const indexPayload = await request(`/repos/${owner}/${repo}/contents/state/index.json?ref=${head}`);
        const index = JSON.parse(decodeGithubContent(indexPayload));
        const tasks = {};
        for (const taskId of Object.keys(index.tasks ?? {})) {
          const file = await request(`/repos/${owner}/${repo}/contents/state/tasks/${safeTaskId(taskId)}.json?ref=${head}`);
          tasks[taskId] = JSON.parse(decodeGithubContent(file));
        }
        let mergeLock = null;
        try {
          const lock = await request(`/repos/${owner}/${repo}/contents/locks/merge.json?ref=${head}`);
          mergeLock = JSON.parse(decodeGithubContent(lock));
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        return { tasks, mergeLock, head, index };
      } catch (error) {
        if (error.status !== 404 || foundHead) throw error;
        return { tasks: {}, mergeLock: null, head: null, index: { schema_version: 1, tasks: {} } };
      }
    },
    async commitProjection({ tasks, mergeLock = null, expectedHead, message, journalEntries = [], previousHash = null }) {
      const index = { schema_version: 1, tasks: {}, journal_hash: previousHash };
      const files = {};
      for (const [taskId, record] of Object.entries(tasks ?? {})) {
        index.tasks[taskId] = { revision: record.state_revision };
        files[`state/tasks/${safeTaskId(taskId)}.json`] = `${canonicalJson(record)}\n`;
      }
      files['state/index.json'] = `${canonicalJson(index)}\n`;
      files['locks/merge.json'] = `${canonicalJson(mergeLock)}\n`;
      for (const entry of journalEntries) { files[`journal/${entry.entry_hash}.json`] = `${canonicalJson(entry)}\n`; index.journal_hash = entry.entry_hash; }
      files['state/index.json'] = `${canonicalJson(index)}\n`;
      const treeItems = [];
      for (const [path, content] of Object.entries(files)) {
        const blob = await request(`/repos/${owner}/${repo}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
        treeItems.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const parent = expectedHead ? await request(`/repos/${owner}/${repo}/git/commits/${expectedHead}`) : null;
      const tree = await request(`/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        body: expectedHead ? { base_tree: parent.tree.sha, tree: treeItems } : { tree: treeItems },
      });
      const commit = await request(`/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        body: { message, tree: tree.sha, parents: expectedHead ? [expectedHead] : [] },
      });
      if (!expectedHead) {
        try { await request(`/repos/${owner}/${repo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/agent-state', sha: commit.sha } }); } catch (error) { if (error.status === 422) return { ok: false, conflict: true }; throw error; }
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
      return pages(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs`, 'workflow_runs');
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
      const json = entries.filter(entry => entry.name.endsWith('.json'));
      if (json.length !== 1) throw new Error('AMBIGUOUS_ARTIFACT');
      return JSON.parse(json[0].content.toString('utf8'));
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
    async readComparison(base, head) {
      const result = await request(`/repos/${owner}/${repo}/compare/${base}...${head}?per_page=100`);
      if (!Array.isArray(result.commits) || !Array.isArray(result.files) || result.files.length >= 300 || result.total_commits > 100) throw new Error('PROMOTION_DIFF_INCOMPLETE');
      return result;
    },
    async readReleasePlan(ref) {
      try { const file = await request(`/repos/${owner}/${repo}/contents/.github/agent-pipeline/production-runbook.json?ref=${ref}`); return JSON.parse(decodeGithubContent(file)); }
      catch (error) { if (error.status === 404) return null; throw error; }
    },
    async readyPull(nodeId) {
      const result = await request('/graphql', { method: 'POST', body: { query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}', variables: { id: nodeId } } });
      if (result.errors?.length) throw new Error('PR_READY_FAILED');
    },
    async readIssue(number) { return request(`/repos/${owner}/${repo}/issues/${number}`); },
    async readPull(number) { return request(`/repos/${owner}/${repo}/pulls/${number}`); },
    async cancelRun(id) { return request(`/repos/${owner}/${repo}/actions/runs/${id}/cancel`, { method: 'POST' }); },
    async readRun(id) { return request(`/repos/${owner}/${repo}/actions/runs/${id}`); },
    async readRepository() { return request(`/repos/${owner}/${repo}`); },
    async readComments(number) { return pages(`/repos/${owner}/${repo}/issues/${number}/comments`); },
    async updateComment(id, body) { return request(`/repos/${owner}/${repo}/issues/comments/${id}`, { method: 'PATCH', body: { body } }); },
    async createBranch(name, sha) {
      if (!/^feat\/sc-[a-z0-9-]+$/.test(name) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('REF_FORBIDDEN');
      try { const existing = await request(`/repos/${owner}/${repo}/git/ref/heads/${name}`); if (existing.object.sha !== sha) throw new Error('BRANCH_CONFLICT'); return existing; }
      catch (error) { if (error.status !== 404) throw error; }
      return request(`/repos/${owner}/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha } });
    },
    async publishCheck({ head, name, externalId, conclusion, summary }) {
      const existing = await pages(`/repos/${owner}/${repo}/commits/${head}/check-runs`, 'check_runs');
      const matches = existing.filter(c => c.app?.id === policy.controller_app_id && c.external_id === externalId && c.name === name);
      if (matches.length > 1) throw new Error('AMBIGUOUS_CHECK');
      const body = { name, head_sha: head, external_id: externalId, status: 'completed', conclusion, output: { title: name, summary } };
      return request(`/repos/${owner}/${repo}/check-runs${matches.length ? `/${matches[0].id}` : ''}`, { method: matches.length ? 'PATCH' : 'POST', body });
    },
    async createPull({ head, base, title, body }) {
      return request(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body: { head, base, title, body, draft: true } });
    },
    async dispatch({ workflow, inputs, ref = 'main' }) {
      const file = workflow.split('/').at(-1);
      await request(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { method: 'POST', body: { ref, inputs: stringifyInputs(inputs) } });
      // Resolve on the next tick by exact request ID, actor, workflow and policy
      // commit. Never adopt an arbitrary recently created run.
      return { run_id: null, dispatched: true };
    },
    async merge({ prNumber, sha }) {
      const result = await request(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, { method: 'PUT', body: { sha, merge_method: 'merge' } });
      return { merged: result.merged === true, mergeCommitSha: result.sha ?? null };
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
  // GitHub ZIPs can use data descriptors: sizes in local headers are then zero.
  // Use the central directory; bounded output and no extraction to filesystem.
  const fail = () => { throw new Error('INVALID_ARTIFACT_ZIP'); };
  if (buffer.length > 8 * 1024 * 1024 || buffer.length < 22) return fail();
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) return fail();
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16), total = 0;
  if (count > 20 || offset >= end) return fail();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) return fail();
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20), length = buffer.readUInt32LE(offset + 24);
    const names = buffer.readUInt16LE(offset + 28), extras = buffer.readUInt16LE(offset + 30), comments = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    total += length;
    if (flags & 1 || total > 2 * 1024 * 1024 || local + 30 > buffer.length || offset + 46 + names + extras + comments > end) return fail();
    if (buffer.readUInt32LE(local) !== 0x04034b50) return fail();
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + size > buffer.length) return fail();
    const compressed = buffer.subarray(start, start + size);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: 2 * 1024 * 1024 }) : null;
    if (!content || content.length !== length) return fail();
    entries.push({ name: buffer.subarray(offset + 46, offset + 46 + names).toString('utf8'), content });
    offset += 46 + names + extras + comments;
  }
  return entries;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}
