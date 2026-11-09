import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { probeRulesetVisibility, RULESET_VISIBILITY_QUERY } from '../../tools/agent-pipeline/probe-ruleset-visibility.mjs';

const WRITER = 26864086;
const QUALITY = 25299230;
const TOKEN = 'test-token-never-return-this';
const app = (id = 'expected-app', databaseId = 5216184) => ({ id, bypassMode: 'ALWAYS', actor: { __typename: 'App', databaseId } });
const connection = (nodes = [app()], options = {}) => ({
  nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, ...options,
});
const body = (rulesetId, bypassActors = connection(rulesetId === WRITER ? [app()] : [])) => ({
  data: { repository: { nameWithOwner: 'krzysztofsyska/skillcheck-core', ruleset: { databaseId: rulesetId, bypassActors } } },
});
const response = (value, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(value) });
async function run(writerResponse, options = {}) {
  const requests = [];
  const fetchImpl = async (url, request) => {
    const payload = JSON.parse(request.body);
    requests.push({ url, request, payload });
    return payload.variables.rulesetId === WRITER
      ? typeof writerResponse === 'function' ? writerResponse(payload.variables, requests.length) : writerResponse ?? response(body(WRITER))
      : response(body(QUALITY));
  };
  const result = await probeRulesetVisibility({ token: TOKEN, tokenSource: 'github-actions-token', fetchImpl, ...options });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(result.protection_authorized, false);
  assert.equal(result.controller_activation_authorized, false);
  assert.equal(result.token_identity_and_permissions_verified, false);
  return { result, requests, writer: result.observations[0] };
}

test('known nonempty and empty controls establish visibility only for the supplied token', async () => {
  const { result, requests } = await run();
  assert.equal(result.capability, true);
  assert.equal(result.scope, 'two-control-rulesets-only');
  assert.equal(result.token_source_declared, 'github-actions-token');
  assert.deepEqual(result.observations.map(item => item.observed_count), [1, 0]);
  assert.match(result.limitations.join(' '), /does not establish access for the controller App token/);
  assert.deepEqual(requests.map(item => item.payload.variables.rulesetId), [WRITER, QUALITY]);
  for (const { url, request, payload } of requests) {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(payload.query, RULESET_VISIBILITY_QUERY);
    assert.match(payload.query, /^query /);
    assert.doesNotMatch(payload.query, /\bmutation\b/);
    assert.equal(payload.variables.owner, 'krzysztofsyska');
    assert.equal(payload.variables.repository, 'skillcheck-core');
    assert.equal(payload.variables.cursor, null);
  }
});

test('complete cursor pagination detects an extra actor despite the known App on the final page', async () => {
  const { result, writer, requests } = await run(({ cursor }) => response(body(WRITER,
    cursor === null
      ? connection([app('different-app', 12)], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'page-two' } })
      : connection([app()], { totalCount: 2 }))));
  assert.equal(result.capability, null);
  assert.equal(writer.reason, 'CONTROL_CHANGED_OR_REDACTED');
  assert.equal(writer.pages, 2);
  assert.equal(writer.observed_count, 2);
  assert.deepEqual(requests.map(item => item.payload.variables.cursor), [null, 'page-two', null]);
});

test('denied HTTP responses expose only status, never the response body', async () => {
  for (const status of [401, 403]) {
    const { result, writer } = await run({ ok: false, status, text: async () => { throw new Error(TOKEN); } });
    assert.equal(result.capability, false);
    assert.equal(writer.http_status, status);
  }
});

test('rate limiting and upstream failures leave capability unknown', async () => {
  for (const status of [429, 500, 503]) {
    const { result } = await run(response({ message: TOKEN }, status));
    assert.equal(result.capability, null);
  }
});

test('GraphQL errors invalidate otherwise complete partial data', async () => {
  for (const errors of [
    [{ type: 'FORBIDDEN', message: TOKEN }],
    [{ extensions: { code: 'UNAUTHORIZED' }, message: TOKEN }],
  ]) {
    const { writer } = await run(response({ ...body(WRITER), errors }));
    assert.equal(writer.capability, false);
    assert.equal(writer.reason, 'GRAPHQL_ERRORS');
  }
  for (const errors of [[{ type: 'GRAPHQL_VALIDATION_FAILED', message: TOKEN }], [null], {}, null]) {
    const { writer } = await run(response({ ...body(WRITER), errors }));
    assert.equal(writer.capability, null);
    assert.equal(writer.reason, 'GRAPHQL_ERRORS');
  }
});

test('null bypass connection is unavailable, never an empty list', async () => {
  const { result, writer } = await run(response(body(WRITER, null)));
  assert.equal(result.capability, false);
  assert.equal(writer.reason, 'BYPASS_ACTORS_NULL');
});

test('missing repositories, rulesets and connection fields are unknown', async () => {
  for (const value of [
    {}, { data: null }, { data: { repository: null } },
    { data: { repository: { nameWithOwner: 'krzysztofsyska/skillcheck-core', ruleset: null } } },
    body(WRITER, {}), body(WRITER, { nodes: [] }),
  ]) {
    const { result } = await run(response(value));
    assert.equal(result.capability, null);
  }
});

test('malformed JSON and non-object envelopes cannot throw or claim visibility', async () => {
  for (const raw of ['{', 'null', '[]', '42', '"text"']) {
    const { writer } = await run({ ok: true, status: 200, text: async () => raw });
    assert.equal(writer.capability, null);
    assert.equal(writer.reason, 'RESPONSE_INVALID');
  }
});

test('transport, body-read and response-size failures remain unknown without raw errors', async () => {
  const failing = [
    () => { throw new Error(TOKEN); },
    { ok: true, status: 200, text: async () => { throw new Error(TOKEN); } },
    { ok: true, status: 200, text: async () => ' '.repeat(1024 * 1024 + 1) },
  ];
  for (const item of failing) assert.equal((await run(item)).result.capability, null);
});

test('unexpectedly empty writer or nonempty quality is changed or redacted, not proven visibility', async () => {
  const { writer } = await run(response(body(WRITER, connection([]))));
  assert.equal(writer.capability, null);
  assert.equal(writer.reason, 'CONTROL_CHANGED_OR_REDACTED');
  const { result } = await run(undefined, {
    fetchImpl: async (_url, request) => response(body(JSON.parse(request.body).variables.rulesetId, connection([app()]))),
  });
  assert.equal(result.capability, null);
  assert.equal(result.observations[1].reason, 'CONTROL_CHANGED_OR_REDACTED');
});

test('writer control requires exactly one known App with ALWAYS bypass', async () => {
  for (const nodes of [
    [app(), app('extra-app', 12)],
    [app(), { id: 'extra-role', bypassMode: 'ALWAYS', actor: null }],
    [app(), app('second-entry-for-known-app')],
    [{ ...app(), bypassMode: 'PULL_REQUEST' }],
    [{ ...app(), bypassMode: 'EXEMPT' }],
  ]) {
    const { result, writer } = await run(response(body(WRITER, connection(nodes))));
    assert.equal(result.capability, null);
    assert.equal(writer.reason, 'CONTROL_CHANGED_OR_REDACTED');
    assert.equal(writer.control_matched, false);
  }
});

test('repository and ruleset identities must match the requested controls', async () => {
  const wrongRepository = body(WRITER);
  wrongRepository.data.repository.nameWithOwner = 'other/repository';
  for (const value of [wrongRepository, body(123)]) assert.equal((await run(response(value))).result.capability, null);
});

test('malformed actors and incomplete counts cannot establish visibility', async () => {
  for (const actors of [[null], [{ ...app(), id: '' }], [{ ...app(), bypassMode: 'UNKNOWN' }], [{ ...app(), actor: {} }], [app(), app()]]) {
    assert.equal((await run(response(body(WRITER, connection(actors))))).writer.reason, 'ACTOR_DATA_INCOMPLETE');
  }
  for (const totalCount of [0, 2]) {
    assert.equal((await run(response(body(WRITER, connection([app()], { totalCount }))))).writer.reason, 'COUNT_MISMATCH');
  }
});

test('final pages require the requested endCursor field with its nullable String type', async () => {
  for (const pageInfo of [{ hasNextPage: false }, { hasNextPage: false, endCursor: 7 }, { hasNextPage: false, endCursor: {} }]) {
    const { result, writer } = await run(response(body(WRITER, connection([app()], { pageInfo }))));
    assert.equal(result.capability, null);
    assert.equal(writer.reason, 'CONNECTION_INCOMPLETE');
  }
  const validNull = await run(response(body(WRITER, connection([app()], { pageInfo: { hasNextPage: false, endCursor: null } }))));
  assert.equal(validNull.result.capability, true);
});

test('App databaseId must be present and a nullable GraphQL Int; null cannot match the control', async () => {
  for (const actor of [
    { __typename: 'App' },
    { __typename: 'App', databaseId: '5216184' },
    { __typename: 'App', databaseId: 1.5 },
    { __typename: 'App', databaseId: 2147483648 },
    { __typename: 'App', databaseId: -2147483649 },
    { __typename: 'App', databaseId: {} },
  ]) {
    const { result, writer } = await run(response(body(WRITER, connection([{ ...app(), actor }]))));
    assert.equal(result.capability, null);
    assert.equal(writer.reason, 'ACTOR_DATA_INCOMPLETE');
  }
  const { writer } = await run(response(body(WRITER, connection([{ ...app(), actor: { __typename: 'App', databaseId: null } }]))));
  assert.equal(writer.capability, null);
  assert.equal(writer.reason, 'CONTROL_CHANGED_OR_REDACTED');
});

test('count changes between pages invalidate the observation', async () => {
  const { writer } = await run(({ cursor }) => response(body(WRITER, cursor === null
    ? connection([app()], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'next' } })
    : connection([app('second')], { totalCount: 3 }))));
  assert.equal(writer.reason, 'COUNT_CHANGED');
});

test('missing and repeated cursors, empty pages and duplicate IDs stop pagination', async () => {
  for (const endCursor of [null, '']) {
    const { writer } = await run(response(body(WRITER, connection([app()], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor } }))));
    assert.equal(writer.reason, 'PAGINATION_INCOMPLETE');
  }
  const empty = await run(response(body(WRITER, connection([], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'next' } }))));
  assert.equal(empty.writer.reason, 'PAGINATION_INCOMPLETE');
  const repeated = await run((_variables, page) => response(body(WRITER, connection([app(`actor-${page}`)], {
    totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
  }))));
  assert.equal(repeated.writer.reason, 'PAGINATION_INCOMPLETE');
  const duplicate = await run(() => response(body(WRITER, connection([app()], {
    totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'next' },
  }))));
  assert.equal(duplicate.writer.reason, 'ACTOR_DATA_INCOMPLETE');
});

test('page limit bounds API requests without claiming complete visibility', async () => {
  const { writer, requests } = await run((_variables, page) => response(body(WRITER, connection([app(`actor-${page}`)], {
    totalCount: 21, pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` },
  }))));
  assert.equal(writer.reason, 'PAGINATION_LIMIT');
  assert.equal(requests.filter(item => item.payload.variables.rulesetId === WRITER).length, 20);
});

test('missing token sends no request and source labels do not verify identity', async () => {
  const { result, requests } = await run(undefined, { token: undefined, tokenSource: TOKEN });
  assert.equal(result.capability, null);
  assert.equal(result.token_source_declared, 'provided-token');
  assert.equal(requests.length, 0);
  assert.ok(result.observations.every(item => item.reason === 'TOKEN_MISSING'));
  const appResult = await run(undefined, { tokenSource: 'existing-app-token' });
  assert.equal(appResult.result.token_source_declared, 'existing-app-token');
});

test('PR workflow cannot access App credentials, environments or write permissions', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/agent-ruleset-visibility.yml', import.meta.url), 'utf8');
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /pull_request:\n    branches: \[integration\]/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /\benvironment:|secrets\.|pull_request_target|: write\b|workflow_dispatch:/);
  const script = await readFile(new URL('../../tools/agent-pipeline/probe-ruleset-visibility.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /from ['"].*lib\//);
});
