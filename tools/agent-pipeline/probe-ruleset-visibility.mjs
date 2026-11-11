import { pathToFileURL } from 'node:url';

const REPOSITORY = 'krzysztofsyska/skillcheck-core';
const CONTROLS = [
  { rulesetId: 26864086, kind: 'known_nonempty_writer', appId: 5216184 },
  { rulesetId: 25299230, kind: 'known_empty_quality' },
];
const TOKEN_SOURCES = new Set(['github-actions-token', 'existing-app-token', 'provided-token']);

// Fixed read-only query. No caller-provided URL, query, repository or ruleset.
// Schema: https://docs.github.com/en/graphql/reference/repos#repositoryruleset
// App.databaseId: https://docs.github.com/en/graphql/reference/apps#app
export const RULESET_VISIBILITY_QUERY = `query RulesetBypassVisibility(
  $owner: String!, $repository: String!, $rulesetId: Int!, $cursor: String
) {
  repository(owner: $owner, name: $repository) {
    nameWithOwner
    ruleset(databaseId: $rulesetId, includeParents: true) {
      databaseId
      bypassActors(first: 100, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id bypassMode actor { __typename ... on App { databaseId } } }
      }
    }
  }
}`;

function observation(control, capability, reason, extra = {}) {
  return { ruleset_id: control.rulesetId, control: control.kind, capability, reason, ...extra };
}

function fieldProblem(object, key) {
  return !Object.hasOwn(object, key) ? 'missing' : object[key] === null ? 'null' : 'invalid';
}

async function readControl(control, { token, fetchImpl }) {
  let cursor = null;
  let expectedCount;
  const cursors = new Set();
  const actors = new Map();
  for (let page = 1; page <= 20; page++) {
    let response;
    try {
      response = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST', // GraphQL query transport, never a mutation.
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: RULESET_VISIBILITY_QUERY,
          variables: { owner: 'krzysztofsyska', repository: 'skillcheck-core', rulesetId: control.rulesetId, cursor } }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return observation(control, null, 'TRANSPORT_UNCONFIRMED');
    }
    if (!response.ok) {
      return observation(control, [401, 403].includes(response.status) ? false : null,
        'HTTP_REQUEST_DENIED', { http_status: response.status });
    }
    let body;
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) return observation(control, null, 'RESPONSE_TOO_LARGE');
      body = JSON.parse(raw);
    } catch {
      return observation(control, null, 'RESPONSE_INVALID');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return observation(control, null, 'RESPONSE_INVALID');
    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) {
      const denied = Array.isArray(body.errors) && body.errors.length > 0
        && body.errors.every(error => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error?.type ?? error?.extensions?.code));
      return observation(control, denied ? false : null, 'GRAPHQL_ERRORS');
    }
    const repository = body?.data?.repository;
    if (repository?.nameWithOwner !== REPOSITORY) return observation(control, null, 'REPOSITORY_UNCONFIRMED');
    const ruleset = repository.ruleset;
    if (!ruleset || ruleset.databaseId !== control.rulesetId) return observation(control, null, 'RULESET_UNCONFIRMED');
    const connection = ruleset.bypassActors;
    if (connection === null) return observation(control, false, 'BYPASS_ACTORS_NULL');
    if (!connection || !Array.isArray(connection.nodes)
        || !Number.isSafeInteger(connection.totalCount) || connection.totalCount < 0
        || typeof connection.pageInfo?.hasNextPage !== 'boolean'
        || !Object.hasOwn(connection.pageInfo, 'endCursor')
        || (connection.pageInfo.endCursor !== null && typeof connection.pageInfo.endCursor !== 'string')) {
      return observation(control, null, 'CONNECTION_INCOMPLETE');
    }
    if (expectedCount !== undefined && expectedCount !== connection.totalCount) return observation(control, null, 'COUNT_CHANGED');
    expectedCount = connection.totalCount;
    for (const actor of connection.nodes) {
      // Emit only fixed field names and categories, never response values.
      const incomplete = detail_code => observation(control, null, 'ACTOR_DATA_INCOMPLETE', { detail_code });
      if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
        return incomplete(actor === null ? 'node:null' : 'node:invalid');
      }
      if (typeof actor.id !== 'string' || !actor.id) return incomplete(`id:${fieldProblem(actor, 'id')}`);
      if (!['ALWAYS', 'PULL_REQUEST', 'EXEMPT'].includes(actor.bypassMode)) {
        return incomplete(`bypassMode:${fieldProblem(actor, 'bypassMode')}`);
      }
      if (actors.has(actor.id)) return incomplete('id:duplicate');
      // Role/deploy-key bypasses may have a null actor; this probe never uses
      // the list to authorize protection. The positive control needs an App.
      if (actor.actor !== null) {
        if (!actor.actor || typeof actor.actor !== 'object' || Array.isArray(actor.actor)) {
          return incomplete(`actor:${fieldProblem(actor, 'actor')}`);
        }
        if (typeof actor.actor.__typename !== 'string') {
          return incomplete(`actor.__typename:${fieldProblem(actor.actor, '__typename')}`);
        }
      }
      if (actor.actor?.__typename === 'App' && (!Object.hasOwn(actor.actor, 'databaseId')
          || (actor.actor.databaseId !== null && (!Number.isInteger(actor.actor.databaseId)
            || actor.actor.databaseId < -2147483648 || actor.actor.databaseId > 2147483647)))) {
        return incomplete(`actor.databaseId:${fieldProblem(actor.actor, 'databaseId')}`);
      }
      actors.set(actor.id, actor);
    }
    if (actors.size > expectedCount) return observation(control, null, 'COUNT_MISMATCH');
    const info = connection.pageInfo;
    if (!info.hasNextPage) {
      if (actors.size !== expectedCount) return observation(control, null, 'COUNT_MISMATCH');
      const matched = control.appId
        ? actors.size === 1 && [...actors.values()].every(entry => entry.actor?.__typename === 'App'
          && entry.actor.databaseId === control.appId && entry.bypassMode === 'ALWAYS')
        : actors.size === 0;
      return observation(control, matched ? true : null,
        matched ? 'CONTROL_OBSERVED' : 'CONTROL_CHANGED_OR_REDACTED',
        { pages: page, observed_count: actors.size, control_matched: matched });
    }
    if (connection.nodes.length === 0 || typeof info.endCursor !== 'string' || !info.endCursor
        || cursors.has(info.endCursor) || actors.size >= expectedCount) {
      return observation(control, null, 'PAGINATION_INCOMPLETE');
    }
    cursors.add(info.endCursor);
    cursor = info.endCursor;
  }
  return observation(control, null, 'PAGINATION_LIMIT');
}

export async function probeRulesetVisibility({ token, tokenSource = 'provided-token', fetchImpl = globalThis.fetch } = {}) {
  const observations = [];
  if (!TOKEN_SOURCES.has(tokenSource)) tokenSource = 'provided-token';
  for (const control of CONTROLS) {
    observations.push(token ? await readControl(control, { token, fetchImpl }) : observation(control, null, 'TOKEN_MISSING'));
  }
  const capability = observations.every(result => result.capability === true) ? true
    : observations.some(result => result.capability === false) ? false : null;
  return {
    schema_version: 1,
    repository: REPOSITORY,
    token_source_declared: tokenSource,
    token_identity_and_permissions_verified: false,
    capability,
    scope: 'two-control-rulesets-only',
    observations,
    protection_authorized: false,
    controller_activation_authorized: false,
    limitations: [
      'This observes only the supplied token and these two controls, not all effective protections.',
      'A GitHub Actions token result does not establish access for the controller App token.',
      'App Administration:read access requires a separate run with that actual scoped token.',
      'Changed controls, partial data and transport errors remain unknown, never an empty bypass list.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // No raw response/error text or token is logged. Missing/denied capability is
  // a completed observation, not authorization or a production incident.
  console.log(JSON.stringify(await probeRulesetVisibility({
    token: process.env.GITHUB_TOKEN,
    tokenSource: process.env.PROBE_TOKEN_SOURCE,
  }), null, 2));
}
