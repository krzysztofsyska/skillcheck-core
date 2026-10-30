import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prepareOfflineVoiceDraft, cancelOfflineVoicePreparation } from "../lib/voice/offline-preparation.ts";
import { recordRetellDispatch, ingestRetellWebhook, RetellLedgerError } from "../lib/voice/retell-dispatch-ledger.ts";
import { createRetellWebhookHttp, resolveRetellWebhookRuntime } from "../lib/voice/retell-webhook-http.ts";
import { RetellWebhookError } from "../lib/voice/retell-webhook.ts";
import { boot } from "./helpers/voice-preparation-fixture.mjs";
import { syntheticRetellProof } from "./helpers/voice-preparation-provider-fixture.mjs";

const key = "key_synthetic_webhook_0123456789";
const agentId = "agent_1234567890abcdef";
const config = { webhookKey: key, agentId, agentVersion: 2 };
const now = 1_793_000_000_000;
const sign = (body, at = now) =>
  "v=" + at + ",d=" + createHmac("sha256", key).update(Buffer.concat([Buffer.from(body), Buffer.from(String(at))])).digest("hex");
const delivery = (event, callId, change = {}) => {
  const body = new TextEncoder().encode(JSON.stringify({ event, call: {
    call_type: "phone_call", direction: "outbound", call_id: callId, agent_id: agentId, agent_version: 2,
    to_number: "+48123456789", start_timestamp: now - 400_000, end_timestamp: now - 10_000,
    disconnection_reason: "user_hangup",
    transcript_object: [{ role: "user", content: "Prywatna odpowiedź kandydata" }], ...change,
  } }));
  return { body, signature: sign(body) };
};
const ledgerError = code => e => e instanceof RetellLedgerError && e.code === code;

test("SC-011-B2 dispatch ledger and Retell webhook ingestion on real PostgreSQL", async t => {
  const env = await boot(t), { db } = env;
  await db.exec(await readFile(new URL("../db/isolated/sc011b2-voice-dispatch.sql", import.meta.url), "utf8"));
  const prepared = async () => {
    const s = await env.ready();
    await env.actor(db, s.f.owner);
    const proof = await syntheticRetellProof();
    const result = await prepareOfflineVoiceDraft(db, s.context, s.request, s.deps(proof.retell, proof.verifiedAgent));
    await env.asServer(s.f.owner);
    return { s, operationId: result.operationId };
  };
  const ingest = (event, callId, change) => {
    const d = delivery(event, callId, change);
    return ingestRetellWebhook(db, d.body, d.signature, config, now);
  };
  const attemptRow = async callId => (await db.query(
    "select status,outcome,dnc_requested from private.sc011b_voice_attempts where provider_call_id=$1", [callId])).rows[0];
  const receipts = async () => Number((await db.query("select count(*) from private.sc011b_voice_webhook_receipts")).rows[0].count);

  await t.test("records one provider call per preparation; replays are stable, redials conflict", async () => {
    const { s, operationId } = await prepared();
    const input = { companyId: s.f.companyId, operationId, providerCallId: "call_aaaaaaaaaaaaaaaa01", agentId };
    const first = await recordRetellDispatch(db, input);
    assert.deepEqual(await recordRetellDispatch(db, input), { attemptId: first.attemptId, replayed: true });
    await assert.rejects(recordRetellDispatch(db, { ...input, providerCallId: "call_aaaaaaaaaaaaaaaa02" }),
      ledgerError("VOICE_ATTEMPT_CONFLICT"));
    await assert.rejects(recordRetellDispatch(db, { ...input, operationId: "00000000-0000-4000-8000-000000000999" }),
      ledgerError("VOICE_ATTEMPT_REJECTED"));
    await assert.rejects(recordRetellDispatch(db, { ...input, providerCallId: "../x" }), ledgerError("VOICE_ATTEMPT_REJECTED"));
    // A call that already left cannot be cancelled and refunded offline.
    await env.actor(db, s.f.owner);
    await assert.rejects(cancelOfflineVoicePreparation(db, s.context, operationId), e => e.code === "VOICE_PREPARATION_CONFLICT");
    await env.asServer(s.f.owner);
    await assert.rejects(db.query("delete from private.sc011b_voice_attempts where id=$1", [first.attemptId]), /IMMUTABLE/);
    await assert.rejects(db.query("update private.sc011b_voice_attempts set provider_call_id='call_other_000000' where id=$1",
      [first.attemptId]), /IMMUTABLE/);
  });

  await t.test("webhooks advance the recorded attempt once, keep DNC and drop the transcript", async () => {
    const { s, operationId } = await prepared();
    const callId = "call_bbbbbbbbbbbbbbbb01";
    await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
    assert.deepEqual(await ingest("call_started", callId), { outcome: "applied" });
    assert.equal((await attemptRow(callId)).status, "connected");
    assert.deepEqual(await ingest("call_started", callId), { outcome: "duplicate_delivery" });
    assert.deepEqual(await ingest("call_ended", callId, { disconnection_reason: "user_requested_dnc" }), { outcome: "applied" });
    assert.deepEqual(await attemptRow(callId), { status: "completed", outcome: "dnc_requested", dnc_requested: true });
    assert.deepEqual(await ingest("call_analyzed", callId), { outcome: "recorded" });
    const stored = JSON.stringify((await db.query(
      "select r.*,a.* from private.sc011b_voice_webhook_receipts r left join private.sc011b_voice_attempts a on a.id=r.attempt_id")).rows);
    assert.ok(!stored.includes("Prywatna") && !stored.includes("+48123456789"));
    await assert.rejects(db.query("delete from private.sc011b_voice_webhook_receipts"), /IMMUTABLE/);
  });

  await t.test("concurrent retries of one delivery apply exactly once", async () => {
    const { s, operationId } = await prepared();
    const callId = "call_cccccccccccccccc01";
    await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
    const [a, b] = [await env.connect(s.f.owner), await env.connect(s.f.owner)];
    for (const client of [a, b]) await env.asServer(s.f.owner, client);
    const d = delivery("call_ended", callId);
    const outcomes = (await Promise.all([a, b].map(client =>
      ingestRetellWebhook(client, d.body, d.signature, config, now)))).map(r => r.outcome).sort();
    assert.deepEqual(outcomes, ["applied", "duplicate_delivery"]);
    assert.deepEqual(await attemptRow(callId), { status: "completed", outcome: "completed", dnc_requested: false });
  });

  await t.test("uncorrelated, ignored and unauthenticated deliveries never touch an attempt", async () => {
    assert.deepEqual(await ingest("call_ended", "call_unknown_00000000"), { outcome: "uncorrelated" });
    assert.deepEqual(await ingest("transcript_updated", "call_unknown_00000000"), { outcome: "ignored" });
    const before = await receipts();
    const d = delivery("call_ended", "call_unknown_00000001");
    await assert.rejects(ingestRetellWebhook(db, d.body, sign(d.body, now - 400_000), config, now),
      e => e instanceof RetellWebhookError && e.code === "RETELL_WEBHOOK_UNAUTHENTICATED");
    await assert.rejects(ingestRetellWebhook(db, d.body, d.signature, { ...config, agentVersion: 3 }, now),
      e => e instanceof RetellWebhookError && e.code === "RETELL_WEBHOOK_REJECTED");
    assert.equal(await receipts(), before);
  });

  await t.test("HTTP boundary: gated by default, 204/401/413/503 without a body", async () => {
    assert.equal(await resolveRetellWebhookRuntime(), null);
    const d = delivery("call_ended", "call_unknown_00000002");
    const post = (handler, body, headers = {}) => handler(new Request("https://skillcheck.invalid/api/voice/retell/webhook",
      { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
    assert.equal((await post(createRetellWebhookHttp(null), d.body, { "x-retell-signature": d.signature })).status, 404);
    const runtime = { config, now: () => now, withClient: work => work(db) };
    const live = createRetellWebhookHttp(runtime);
    const ok = await post(live, d.body, { "x-retell-signature": d.signature });
    assert.equal(ok.status, 204); assert.equal(await ok.text(), "");
    assert.equal((await post(live, d.body, { "x-retell-signature": sign(d.body, now - 400_000) })).status, 401);
    assert.equal((await post(live, new TextEncoder().encode("{}"), { "x-retell-signature": sign(new TextEncoder().encode("{}")) })).status, 400);
    assert.equal((await post(live, d.body, { "x-retell-signature": d.signature, "content-length": "99999999" })).status, 413);
    const broken = createRetellWebhookHttp({ ...runtime, withClient: async () => { throw new Error("db down"); } });
    assert.equal((await post(broken, d.body, { "x-retell-signature": d.signature })).status, 503);
  });
});
