// R6-1e: the Retell webhook runtime gate. Off by default (404), refused on any
// partial or production configuration, composed only on a fully configured
// Preview build of `integration`. Offline: a fake pool stands in for the
// database; no Retell call, no real key, nothing sent.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { retellWebhookGate, RETELL_WEBHOOK_DATABASE_ROLE } from "../lib/voice/retell-webhook-config.ts";
import { createRetellWebhookHttp, resolveRetellWebhookRuntime } from "../lib/voice/retell-webhook-http.ts";
import { composeRetellWebhookRuntime } from "../lib/voice/retell-webhook-runtime.ts";

const ref = "orbyscrupgnupifzlqxp";
const key = "key_synthetic_webhook_SECRETVALUE_0123456789";
const password = "SyntheticDbPasswordValue0123456789";
const agentId = "agent_1234567890abcdef";
const full = Object.freeze({
  RETELL_WEBHOOK_ENABLED: "true",
  VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "integration",
  NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  RETELL_WEBHOOK_KEY: key, RETELL_AGENT_ID: agentId, RETELL_AGENT_VERSION: "2",
  RETELL_WEBHOOK_DATABASE_URL:
    `postgresql://${RETELL_WEBHOOK_DATABASE_ROLE}.${ref}:${password}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
});
const now = 1_793_000_000_000;
const sign = (body, at = now) => "v=" + at + ",d=" +
  createHmac("sha256", key).update(Buffer.concat([Buffer.from(body), Buffer.from(String(at))])).digest("hex");
const body = new TextEncoder().encode(JSON.stringify({ event: "transcript_updated",
  call: { call_id: "call_synthetic_0001", agent_id: agentId, agent_version: 2 } }));
const post = (handler, headers = { "x-retell-signature": sign(body) }) => handler(new Request(
  "https://skillcheck.invalid/api/voice/retell/webhook",
  { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
const without = name => { const env = { ...full }; delete env[name]; return env; };
const leaks = text => [key, password].some(secret => text.includes(secret));

function fakePool() {
  const log = { connects: 0, released: [], queries: [] };
  return { log, pool: { async connect() {
    log.connects++;
    return {
      async query(sql) {
        log.queries.push(sql);
        return { rows: /^insert into private\.sc011b_voice_webhook_receipts/.test(sql) ? [{ receipt_id: "x" }] : [] };
      },
      release(destroy) { log.released.push(destroy); },
    };
  } } };
}

test("default: no configuration gives no runtime and the route answers 404", async () => {
  assert.equal(await resolveRetellWebhookRuntime({}), null);
  assert.equal(retellWebhookGate({}).ok, false);
  assert.equal(retellWebhookGate({}).reason, "disabled");
  const response = await post(createRetellWebhookHttp(await resolveRetellWebhookRuntime({})));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "");
});

test("partial or wrong configuration is refused, without echoing a secret", async () => {
  const cases = [
    [without("RETELL_WEBHOOK_ENABLED"), "disabled"],
    [{ ...full, RETELL_WEBHOOK_ENABLED: "1" }, "disabled"],
    [without("VERCEL"), "not_vercel"],
    [{ ...full, VERCEL_ENV: "production" }, "vercel_env"],
    [{ ...full, VERCEL_ENV: "development" }, "vercel_env"],
    [{ ...full, VERCEL_GIT_COMMIT_REF: "main" }, "git_ref"],
    [{ ...full, VERCEL_GIT_COMMIT_REF: "claude/some-branch" }, "git_ref"],
    [{ ...full, NEXT_PUBLIC_SUPABASE_URL: "https://wsvjawuikxfzjyivxgsu.supabase.co" }, "supabase_url"],
    [without("RETELL_WEBHOOK_KEY"), "webhook_key"],
    [{ ...full, RETELL_WEBHOOK_KEY: "short" }, "webhook_key"],
    [{ ...full, RETELL_WEBHOOK_KEY: key + "\n" }, "webhook_key"],
    [without("RETELL_AGENT_ID"), "agent_id"],
    [{ ...full, RETELL_AGENT_ID: "agent_x" }, "agent_id"],
    [without("RETELL_AGENT_VERSION"), "agent_version"],
    [{ ...full, RETELL_AGENT_VERSION: "-1" }, "agent_version"],
    [{ ...full, RETELL_AGENT_VERSION: "2.5" }, "agent_version"],
    [without("RETELL_WEBHOOK_DATABASE_URL"), "database_url"],
    // Another role (the payment adapter's, or postgres) is never accepted.
    [{ ...full, RETELL_WEBHOOK_DATABASE_URL: full.RETELL_WEBHOOK_DATABASE_URL.replace(RETELL_WEBHOOK_DATABASE_ROLE, "postgres") }, "database_url"],
    [{ ...full, RETELL_WEBHOOK_DATABASE_URL: full.RETELL_WEBHOOK_DATABASE_URL.replace(RETELL_WEBHOOK_DATABASE_ROLE, "sc19_p24_preview") }, "database_url"],
    // Another project (production) or weakened TLS is refused.
    [{ ...full, RETELL_WEBHOOK_DATABASE_URL: full.RETELL_WEBHOOK_DATABASE_URL.replace(ref, "wsvjawuikxfzjyivxgsu") }, "database_url"],
    [{ ...full, RETELL_WEBHOOK_DATABASE_URL: full.RETELL_WEBHOOK_DATABASE_URL + "?sslmode=disable" }, "database_url"],
    [{ ...full, RETELL_WEBHOOK_DATABASE_URL: full.RETELL_WEBHOOK_DATABASE_URL.replace(":6543", ":5432") }, "database_url"],
  ];
  for (const [env, reason] of cases) {
    const gate = retellWebhookGate(env);
    assert.equal(gate.ok, false, reason);
    assert.equal(gate.reason, reason);
    assert.equal(leaks(JSON.stringify(gate)), false, `${reason} refusal echoes no secret`);
    assert.equal(await resolveRetellWebhookRuntime(env), null, reason);
    assert.equal((await post(createRetellWebhookHttp(await resolveRetellWebhookRuntime(env)))).status, 404, reason);
  }
  // A secret pasted into a public variable is reported by length only.
  const misplaced = retellWebhookGate({ ...full, RETELL_AGENT_ID: key });
  assert.equal(misplaced.reason, "agent_id");
  assert.equal(leaks(JSON.stringify(misplaced)), false);
});

test("production is never composed, even fully configured", async () => {
  const production = { ...full, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
    NEXT_PUBLIC_SUPABASE_URL: "https://wsvjawuikxfzjyivxgsu.supabase.co" };
  assert.equal(retellWebhookGate(production).ok, false);
  assert.equal(await resolveRetellWebhookRuntime(production), null);
});

test("full Preview configuration composes the runtime with the pinned agent", async () => {
  const gate = retellWebhookGate(full);
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.config.webhook, { webhookKey: key, agentId, agentVersion: 2 });
  assert.equal(gate.config.deployment, "preview");
  const resolved = await resolveRetellWebhookRuntime(full);
  assert.ok(resolved, "runtime is composed");
  assert.deepEqual(resolved.config, gate.config.webhook);
  assert.equal(typeof resolved.withClient, "function");
});

test("composed runtime is used: authenticated delivery reaches the ledger, forged one never borrows a connection", async () => {
  const gate = retellWebhookGate(full);
  const { log, pool } = fakePool();
  const runtime = composeRetellWebhookRuntime(gate.config, { pool, now: () => now });
  const handler = createRetellWebhookHttp(runtime);
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    const ok = await post(handler);
    assert.equal(ok.status, 204, "an ignored event is acknowledged");
    assert.equal(await ok.text(), "");
    assert.equal(log.connects, 1);
    assert.ok(log.queries.some(sql => sql.startsWith("insert into private.sc011b_voice_webhook_receipts")));
    assert.deepEqual(log.released, [false], "a committed delivery returns its connection to the pool");

    const forged = await post(handler, { "x-retell-signature": sign(body, now - 400_000) });
    assert.equal(forged.status, 401);
    assert.equal(await forged.text(), "");
    const unsigned = await post(handler, {});
    assert.equal(unsigned.status, 401);
    assert.equal(log.connects, 1, "unauthenticated deliveries never touch the database");

    const failing = composeRetellWebhookRuntime(gate.config, { now: () => now, pool: { async connect() {
      log.connects++;
      return { async query() { throw Object.assign(new Error("password " + password), { code: "08006" }); },
        release(destroy) { log.released.push(destroy); } };
    } } });
    const down = await post(createRetellWebhookHttp(failing));
    assert.equal(down.status, 503);
    assert.equal(await down.text(), "");
    assert.equal(log.released.at(-1), true, "a connection that failed mid-work is destroyed");
  } finally { console.error = original; }
  assert.equal(errors.some(leaks), false, "no secret is logged");
});
