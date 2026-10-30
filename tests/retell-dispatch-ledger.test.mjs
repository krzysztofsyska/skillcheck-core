import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { prepareOfflineVoiceDraft, cancelOfflineVoicePreparation } from "../lib/voice/offline-preparation.ts";
import { recordRetellDispatch, ingestRetellWebhook, RetellLedgerError } from "../lib/voice/retell-dispatch-ledger.ts";
import { createRetellWebhookHttp, resolveRetellWebhookRuntime } from "../lib/voice/retell-webhook-http.ts";
import { RetellWebhookError } from "../lib/voice/retell-webhook.ts";
import {
  boot, SC011B2_DISPATCH_SCHEMA, SC011B3_TRANSCRIPT_SCHEMA, SC011B4_SETTLEMENT_SCHEMA,
} from "./helpers/voice-preparation-fixture.mjs";
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

test("SC-011-B2/B3/B4 dispatch ledger, Retell webhooks, transcripts and settlement on real PostgreSQL", async t => {
  const env = await boot(t, {
    extraSchemas: [SC011B2_DISPATCH_SCHEMA, SC011B3_TRANSCRIPT_SCHEMA, SC011B4_SETTLEMENT_SCHEMA],
  }), { db } = env;
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
  const transcript = async callId => (await db.query([
    "select t.* from private.sc011b_voice_transcripts t join private.sc011b_voice_attempts a",
    "on a.company_id=t.company_id and a.id=t.attempt_id where a.provider_call_id=$1",
  ].join(" "), [callId])).rows[0];
  const pool = async s => (await db.query(
    "select used,reserved from private.sc19_voice_entitlements where company_id=$1 and id=$2",
    [s.f.companyId, s.request.entitlementId])).rows[0];
  const preferences = async s => (await db.query(
    "select blocked_channels,revision from public.candidate_contact_preferences where company_id=$1 and candidate_id=$2",
    [s.f.companyId, s.f.candidate.id])).rows[0];
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

  await t.test("webhooks advance the recorded attempt once, keep DNC and store only the minimized transcript", async () => {
    const { s, operationId } = await prepared();
    const callId = "call_bbbbbbbbbbbbbbbb01";
    await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
    assert.deepEqual(await ingest("call_started", callId), { outcome: "applied" });
    assert.equal((await attemptRow(callId)).status, "connected");
    assert.deepEqual(await ingest("call_started", callId), { outcome: "duplicate_delivery" });
    assert.deepEqual(await ingest("call_ended", callId, { disconnection_reason: "user_requested_dnc" }), { outcome: "applied" });
    assert.deepEqual(await attemptRow(callId), { status: "completed", outcome: "dnc_requested", dnc_requested: true });
    assert.deepEqual(await ingest("call_analyzed", callId), { outcome: "recorded" });
    const ledger = JSON.stringify((await db.query(
      "select r.*,a.* from private.sc011b_voice_webhook_receipts r left join private.sc011b_voice_attempts a on a.id=r.attempt_id")).rows);
    assert.ok(!ledger.includes("Prywatna") && !ledger.includes("+48123456789"), "answers live only in the transcript table");
    const kept = await transcript(callId);
    assert.deepEqual(kept.utterances, [{ speaker: "candidate", text: "Prywatna odpowiedź kandydata" }]);
    assert.equal(kept.recruitment_id, s.f.recruitment.id);
    assert.equal(kept.candidate_id, s.f.candidate.id);
    assert.ok(!JSON.stringify(kept).includes("+48123456789"));
    await assert.rejects(db.query("delete from private.sc011b_voice_webhook_receipts"), /IMMUTABLE/);
    await assert.rejects(db.query("update private.sc011b_voice_transcripts set utterances='[]' where attempt_id=$1",
      [kept.attempt_id]), /IMMUTABLE/);
    await assert.rejects(db.query("delete from private.sc011b_voice_transcripts where attempt_id=$1", [kept.attempt_id]), /IMMUTABLE/);
  });

  await t.test("calls that did not happen keep no transcript; the table refuses one for an unfinished call", async () => {
    for (const [n, reason] of [["01", "dial_no_answer"], ["02", "voicemail_reached"], ["03", "dial_busy"]]) {
      const { s, operationId } = await prepared();
      const callId = "call_eeeeeeeeeeeeeee" + n + "x";
      await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
      assert.deepEqual(await ingest("call_ended", callId, { disconnection_reason: reason }), { outcome: "applied" });
      assert.equal((await attemptRow(callId)).status, "failed");
      assert.equal(await transcript(callId), undefined, reason);
    }
    const { s, operationId } = await prepared();
    const { attemptId } = await recordRetellDispatch(db,
      { companyId: s.f.companyId, operationId, providerCallId: "call_eeeeeeeeeeeeeee04x", agentId });
    await assert.rejects(db.query(`insert into private.sc011b_voice_transcripts(attempt_id,company_id,recruitment_id,candidate_id,utterances)
      values($1,$2,$3,$4,'[{"speaker":"candidate","text":"x"}]')`,
    [attemptId, s.f.companyId, s.f.recruitment.id, s.f.candidate.id]), /VOICE_TRANSCRIPT_UNAVAILABLE/);
  });

  await t.test("retention: kept while the recruitment is open, purged 90 days after it closes", async () => {
    const { s, operationId } = await prepared();
    const callId = "call_ffffffffffffffff01";
    await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
    await ingest("call_ended", callId);
    const purge = async () => (await db.query("select private.sc011b_purge_voice_transcripts() as n")).rows[0].n;
    const close = (status, daysAgo) => db.query(
      "update public.recruitments set opened_at=clock_timestamp()-interval '400 days',status=$2,closed_at=clock_timestamp()-make_interval(days=>$3) where id=$1",
      [s.f.recruitment.id, status, daysAgo]);
    assert.equal(await purge(), 0);
    await close("closed", 89);
    assert.equal(await purge(), 0);
    assert.ok(await transcript(callId), "still inside the 90-day window");
    await close("open", 120);
    assert.equal(await purge(), 0, "a reopened recruitment pauses retention");
    await close("closed", 91);
    assert.equal(await purge(), 1);
    assert.equal(await transcript(callId), undefined);
  });

  await t.test("closing a recruitment by status alone starts the retention clock", async () => {
    const { s, operationId } = await prepared();
    const callId = "call_ffffffffffffffff02";
    await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
    await ingest("call_ended", callId);
    const closedAt = async () => (await db.query("select closed_at from public.recruitments where id=$1",
      [s.f.recruitment.id])).rows[0].closed_at;
    await db.query("update public.recruitments set status='open',closed_at=null where id=$1", [s.f.recruitment.id]);
    await db.query("update public.recruitments set status='closed' where id=$1", [s.f.recruitment.id]);
    const first = await closedAt();
    assert.ok(first instanceof Date, "closing by status stamps closed_at");
    assert.equal((await db.query("select private.sc011b_purge_voice_transcripts() as n")).rows[0].n, 0);
    // Reopen, then close again without a timestamp: the clock restarts.
    await db.query("update public.recruitments set closed_at=clock_timestamp()-interval '200 days' where id=$1", [s.f.recruitment.id]);
    await db.query("update public.recruitments set status='open' where id=$1", [s.f.recruitment.id]);
    await db.query("update public.recruitments set status='closed' where id=$1", [s.f.recruitment.id]);
    assert.ok((await closedAt()).getTime() >= first.getTime(), "a re-close restarts the 90 days");
    assert.equal((await db.query("select private.sc011b_purge_voice_transcripts() as n")).rows[0].n, 0);
    assert.ok(await transcript(callId));
    assert.equal((await attemptRow(callId)).status, "completed", "the attempt and its outcome remain");
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

  await t.test("an event that beats the dispatch commit stays retryable and applies afterwards", async () => {
    const { s, operationId } = await prepared();
    const callId = "call_dddddddddddddddd01";
    const before = await receipts();
    const early = { disconnection_reason: "user_requested_dnc" };
    assert.deepEqual(await ingest("call_ended", callId, early), { outcome: "uncorrelated" });
    assert.equal(await receipts(), before, "an uncorrelated event is not consumed");
    await recordRetellDispatch(db, { companyId: s.f.companyId, operationId, providerCallId: callId, agentId });
    assert.deepEqual(await ingest("call_ended", callId, early), { outcome: "applied" });
    assert.deepEqual(await attemptRow(callId), { status: "completed", outcome: "dnc_requested", dnc_requested: true });
  });

  await t.test("owner decisions: only a held call uses the pool; DNC blocks every channel", async () => {
    const completed = await prepared();
    assert.deepEqual(await pool(completed.s), { used: 0, reserved: 1 });
    await recordRetellDispatch(db, { companyId: completed.s.f.companyId, operationId: completed.operationId,
      providerCallId: "call_gggggggggggggggg01", agentId });
    await ingest("call_started", "call_gggggggggggggggg01");
    assert.deepEqual(await pool(completed.s), { used: 0, reserved: 1 }, "progress alone settles nothing");
    await ingest("call_ended", "call_gggggggggggggggg01");
    assert.deepEqual(await pool(completed.s), { used: 1, reserved: 0 });
    assert.deepEqual(await ingest("call_analyzed", "call_gggggggggggggggg01"), { outcome: "recorded" });
    assert.deepEqual(await pool(completed.s), { used: 1, reserved: 0 }, "no double settlement");

    for (const [n, reason] of [["02", "dial_no_answer"], ["03", "dial_busy"], ["04", "voicemail_reached"], ["05", "dial_failed"]]) {
      const missed = await prepared();
      await recordRetellDispatch(db, { companyId: missed.s.f.companyId, operationId: missed.operationId,
        providerCallId: "call_gggggggggggggggg" + n, agentId });
      await ingest("call_ended", "call_gggggggggggggggg" + n, { disconnection_reason: reason });
      assert.deepEqual(await pool(missed.s), { used: 0, reserved: 0 }, reason + " returns the interview to the pool");
    }

    const dnc = await prepared();
    const before = await preferences(dnc.s);
    assert.ok(!before.blocked_channels.includes("voice"));
    await recordRetellDispatch(db, { companyId: dnc.s.f.companyId, operationId: dnc.operationId,
      providerCallId: "call_gggggggggggggggg06", agentId });
    await ingest("call_ended", "call_gggggggggggggggg06", { disconnection_reason: "user_requested_dnc" });
    const after = await preferences(dnc.s);
    assert.deepEqual([...after.blocked_channels].sort(), ["email", "sms", "voice"]);
    assert.equal(Number(after.revision), Number(before.revision) + 1);
    assert.deepEqual(await pool(dnc.s), { used: 1, reserved: 0 }, "the call took place before the request");
  });

  await t.test("a production webhook runs without a session actor and still settles DNC", async () => {
    const p = await prepared();
    await recordRetellDispatch(db, { companyId: p.s.f.companyId, operationId: p.operationId,
      providerCallId: "call_hhhhhhhhhhhhhhhh01", agentId });
    await env.asServer(null);
    try {
      assert.deepEqual(await ingest("call_ended", "call_hhhhhhhhhhhhhhhh01", { disconnection_reason: "user_requested_dnc" }),
        { outcome: "applied" });
    } finally { await env.asServer(p.s.f.owner); }
    assert.deepEqual([...(await preferences(p.s)).blocked_channels].sort(), ["email", "sms", "voice"]);
    assert.deepEqual(await pool(p.s), { used: 1, reserved: 0 });
  });

  await t.test("ignored and unauthenticated deliveries never touch an attempt", async () => {
    assert.deepEqual(await ingest("transcript_updated", "call_unknown_00000000"), { outcome: "ignored" });
    const before = await receipts();
    const d = delivery("call_ended", "call_unknown_00000001");
    await assert.rejects(ingestRetellWebhook(db, d.body, sign(d.body, now - 400_000), config, now),
      e => e instanceof RetellWebhookError && e.code === "RETELL_WEBHOOK_UNAUTHENTICATED");
    await assert.rejects(ingestRetellWebhook(db, d.body, d.signature, { ...config, agentVersion: 3 }, now),
      e => e instanceof RetellWebhookError && e.code === "RETELL_WEBHOOK_REJECTED");
    assert.equal(await receipts(), before);
  });

  await t.test("HTTP boundary: gated by default, 204/401/400/413/503 without a body", async () => {
    assert.equal(await resolveRetellWebhookRuntime(), null);
    const d = delivery("transcript_updated", "call_unknown_00000002");
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
    const unknown = delivery("call_ended", "call_unknown_00000003");
    assert.equal((await post(live, unknown.body, { "x-retell-signature": unknown.signature })).status, 503,
      "an uncorrelated call event is not acknowledged, so Retell retries it");
    const broken = createRetellWebhookHttp({ ...runtime, withClient: async () => { throw new Error("db down"); } });
    assert.equal((await post(broken, d.body, { "x-retell-signature": d.signature })).status, 503);
  });
});
