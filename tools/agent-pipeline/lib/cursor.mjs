import { withTransportRetry } from './transport.mjs';
import { agentIdFor } from './canonical.mjs';
import { assertCursorTarget } from './scope.mjs';

export const CURSOR_API_BASE = 'https://api.cursor.com';

export function buildCreatePayload({ repoUrl, startingRef, prompt, agentId, repositoryId, expectedRepositoryId, fork, allowedRepoUrls }) {
  const target = assertCursorTarget({ startingRef, repositoryId, fork, expectedRepositoryId, repoUrl, allowedRepoUrls });
  if (!target.ok) {
    const error = new Error(target.reason);
    error.code = target.reason;
    throw error;
  }
  return {
    prompt: { text: prompt },
    repos: [{ url: repoUrl, startingRef }],
    workOnCurrentBranch: true,
    autoCreatePR: false,
    agentId,
  };
}

export function buildFollowupPayload({ prompt, marker, reviewRequestId, headSha, baseSha, allowedFiles, findings, ci }) {
  const text = [
    prompt,
    '',
    '---',
    `operation_marker: ${marker}`,
    `review_request_id: ${reviewRequestId ?? ''}`,
    `head_sha: ${headSha ?? ''}`,
    `base_sha: ${baseSha ?? ''}`,
    'allowed_files:',
    ...(allowedFiles ?? []).map(file => `- ${file}`),
    'findings:',
    JSON.stringify(findings ?? []),
    'ci:',
    JSON.stringify(ci ?? null),
  ].join('\n');
  return { prompt: { text } };
}

export function createAgentId(operationKey) {
  return agentIdFor(operationKey);
}

export function reconcileListedRuns({ knownRunIds, runs }) {
  const known = new Set(knownRunIds ?? []);
  const fresh = (runs ?? []).filter(run => run?.id && !known.has(run.id));
  if (fresh.length !== 1 || !fresh[0]?.operationVerified) return { ok: false, reason: 'DISPATCH_UNKNOWN', fresh };
  return { ok: true, run: fresh[0] };
}

export function createCursorClient({ fetch: fetchImpl, apiKey, baseUrl = CURSOR_API_BASE }) {
  if (!apiKey) {
    const error = new Error('BLOCKED_CONFIGURATION');
    error.code = 'BLOCKED_CONFIGURATION';
    throw error;
  }
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  async function once(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) {
      const error = new Error(payload?.code || `http_${response.status}`);
      error.status = response.status;
      error.code = payload?.code || null;
      error.payload = payload;
      error.retryAfter = response.headers?.get?.('retry-after') ?? null;
      throw error;
    }
    return payload;
  }
  async function request(path, options = {}) {
    if (!options.method || options.method === 'GET') return withTransportRetry(() => once(path, options));
    try { return await once(path, options); } catch (error) { if (!error.status) error.code = 'LOST_RESPONSE'; throw error; }
  }
  return {
    async createAgent(payload) {
      if (Object.prototype.hasOwnProperty.call(payload, 'envVars')) {
        const error = new Error('ENV_VARS_FORBIDDEN');
        error.code = 'ENV_VARS_FORBIDDEN';
        throw error;
      }
      return request('/v1/agents', { method: 'POST', body: payload });
    },
    async getAgent(agentId) {
      return request(`/v1/agents/${encodeURIComponent(agentId)}`);
    },
    async createRun(agentId, payload) {
      return request(`/v1/agents/${encodeURIComponent(agentId)}/runs`, { method: 'POST', body: payload });
    },
    async listRuns(agentId) {
      const items = []; let cursor = null;
      for (let page = 0; page < 100; page++) {
        const result = await request(`/v1/agents/${encodeURIComponent(agentId)}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        items.push(...(result.items ?? result.runs ?? [])); cursor = result.nextCursor;
        if (!cursor) return { items };
      }
      throw new Error('CURSOR_PAGINATION_LIMIT');
    },
    async getRun(agentId, runId) { return request(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`); },
  };
}
