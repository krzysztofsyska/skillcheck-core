import test from "node:test";
import assert from "node:assert/strict";
import { readRetellAgent, RetellAgentError } from "../lib/voice/retell-agent.ts";

const env = {
  RETELL_API_KEY: "synthetic-test-token-123456",
  RETELL_AGENT_ID: "agent_1234567890abcdef",
};
const agent = {
  agent_id: env.RETELL_AGENT_ID,
  agent_name: "SkillCheck demo",
  is_published: false,
  version: 0,
  voice_id: "retell-Cimo",
  language: "pl-PL",
  response_engine: { type: "conversation-flow", secret_node: "private" },
  custom_private_provider_data: "NEVER EXPOSE",
};
const reply = (status, payload = agent) => ({
  status,
  async json() { return payload; },
});
const failsWith = (promise, code) => assert.rejects(promise, error =>
  error instanceof RetellAgentError && error.code === code
  && !error.message.includes(env.RETELL_API_KEY)
);

test("SC-011 Retell uses only the configured GET endpoint and projects safe fields", async () => {
  let calls = 0;
  const result = await readRetellAgent(env, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.retellai.com/get-agent/agent_1234567890abcdef");
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer " + env.RETELL_API_KEY);
    assert.ok(init.signal);
    assert.equal(init.body, undefined);
    return reply(200);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    agentId: env.RETELL_AGENT_ID,
    name: "SkillCheck demo",
    published: false,
    version: 0,
    language: "pl-PL",
    voiceId: "retell-Cimo",
    responseEngineType: "conversation-flow",
  });
  assert.ok(!JSON.stringify(result).includes("NEVER EXPOSE"));
  assert.ok(!JSON.stringify(result).includes(env.RETELL_API_KEY));
});

test("SC-011 Retell refuses missing or malformed config before network access", async () => {
  let sent = 0;
  const forbiddenNetwork = async () => { sent++; throw Error("Must not be called"); };
  for (const e of [
    {},
    { ...env, RETELL_API_KEY: "" },
    { ...env, RETELL_API_KEY: "short" },
    { ...env, RETELL_API_KEY: "test-token-123456\nInjection" },
    { ...env, RETELL_AGENT_ID: "../create-phone-call" },
    { ...env, RETELL_AGENT_ID: "agent_!@#$" },
  ]) await failsWith(readRetellAgent(e, forbiddenNetwork), "RETELL_NOT_CONFIGURED");
  assert.equal(sent, 0);
});

test("SC-011 Retell does not forward vendor error bodies or network errors", async () => {
  for (const [status, code] of [
    [401, "RETELL_AUTH_FAILED"],
    [403, "RETELL_AUTH_FAILED"],
    [404, "RETELL_AGENT_NOT_FOUND"],
    [422, "RETELL_AGENT_NOT_FOUND"],
    [429, "RETELL_UNAVAILABLE"],
    [500, "RETELL_UNAVAILABLE"],
  ]) await failsWith(
    readRetellAgent(env, async () => reply(status, {secret: "LEAK"})), code,
  );
  await failsWith(
    readRetellAgent(env, async () => { throw Error("Authorization: Bearer private-key"); }),
    "RETELL_UNAVAILABLE",
  );
  await failsWith(
    readRetellAgent(env, async () => ({ status: 200, async json() { throw Error("private"); } })),
    "RETELL_INVALID_RESPONSE",
  );
});

test("SC-011 Retell rejects cross-agent and malformed successful responses", async () => {
  for (const response of [
    null, [],
    {...agent, agent_id: "agent_aaaaaaaaaaaaaaaa"},
    {...agent, is_published: "false"},
    {...agent, version: "0"},
    {...agent, agent_name: "X".repeat(250)},
  ]) await failsWith(
    readRetellAgent(env, async () => reply(200, response)),
    "RETELL_INVALID_RESPONSE",
  );
});

test("SC-011 Retell permits documented unprefixed 32-character agent IDs only", async () => {
  const id = "16b980523634a6dc504898cda492e939";
  const result = await readRetellAgent({ ...env, RETELL_AGENT_ID: id }, async (url, init) => {
    assert.equal(url, "https://api.retellai.com/get-agent/" + id);
    assert.equal(init.redirect, "error");
    return reply(200, { ...agent, agent_id: id });
  });
  assert.equal(result.agentId, id);
});

test("SC-011 Retell accepts unnamed agents and preserves safe multilingual locale arrays", async () => {
  const response = {
    ...agent, agent_name: null,
    language: ["pl-PL", "en-US"],
  };
  const result = await readRetellAgent(env, async () => reply(200, response));
  assert.equal(result.name, null);
  assert.deepEqual(result.language, ["pl-PL", "en-US"]);
  assert.ok(Object.isFrozen(result.language));
  assert.ok(Object.isFrozen(result));
  assert.ok(!JSON.stringify(result).includes("NEVER EXPOSE"));
});

test("SC-011 Retell discards malformed multilingual data without leaking values", async () => {
  for (const language of [
    ["pl-PL", 1],
    ["pl-PL", "X".repeat(31)],
    [],
    { bogus: "pl-PL" },
  ]) {
    const result = await readRetellAgent(env, async () => reply(200, {...agent, language}));
    assert.equal(result.language, null);
  }
});

test("SC-011 Retell preserves more than 20 valid languages including pl-PL", async () => {
  const locales = Array.from({length: 25}, (_,i) => "lang-" + String(i));
  locales.push("pl-PL");
  const result = await readRetellAgent(env, async () =>
    reply(200, {...agent, language: locales}));
  assert.deepEqual(result.language, locales);
});

test("SC-011 Retell rejects missing or malformed required voice engine configuration", async () => {
  for (const change of [
    {voice_id: undefined}, {voice_id: null}, {voice_id: ""},
    {voice_id: 123}, {response_engine: undefined},
    {response_engine: null}, {response_engine: {}},
    {response_engine: {type: 123}},
  ]) await failsWith(readRetellAgent(env, async () =>
    reply(200, {...agent, ...change})), "RETELL_INVALID_RESPONSE");
});
