import test from "node:test";
import assert from "node:assert/strict";
import { prepareOfflineVoiceDraft, cancelOfflineVoicePreparation } from "../lib/voice/offline-preparation.ts";
import { dispatchRetellCall, RetellDispatchError, RETELL_RESEND_WINDOW_MS } from "../lib/voice/retell-dispatch-worker.ts";
import { recordRetellDispatch } from "../lib/voice/retell-dispatch-ledger.ts";
import {
  boot, SC011B2_DISPATCH_SCHEMA, SC011B4_SETTLEMENT_SCHEMA, SC011B5_DISPATCH_WORKER_SCHEMA,
} from "./helpers/voice-preparation-fixture.mjs";
import { syntheticRetellProof } from "./helpers/voice-preparation-provider-fixture.mjs";

const apiKey = "key_synthetic_never_real_0123456789";
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const transport = (...responses) => {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { http, calls };
};

test("SC-011-B5 once-only Retell dispatch worker on real PostgreSQL", async t => {
  const env = await boot(t, {
    extraSchemas: [SC011B2_DISPATCH_SCHEMA, SC011B4_SETTLEMENT_SCHEMA, SC011B5_DISPATCH_WORKER_SCHEMA],
  }), { db } = env;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("global fetch must never be used"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const prepared = async () => {
    const s = await env.ready();
    await env.actor(db, s.f.owner);
    const proof = await syntheticRetellProof();
    const result = await prepareOfflineVoiceDraft(db, s.context, s.request, s.deps(proof.retell, proof.verifiedAgent));
    await env.asServer(s.f.owner);
    return { s, operationId: result.operationId, draft: result.draft };
  };
  const dispatch = (p, http, now = p.draft.verifiedAtMs + 1) =>
    dispatchRetellCall(db, { companyId: p.s.f.companyId, operationId: p.operationId, draft: p.draft, apiKey }, http, now);
  const claim = async p => (await db.query(
    "select state,attempts,rejection from private.sc011b_voice_dispatches where company_id=$1 and preparation_id=$2",
    [p.s.f.companyId, p.operationId])).rows[0];
  const pool = async p => (await db.query("select used,reserved from private.sc19_voice_entitlements where id=$1",
    [p.s.request.entitlementId])).rows[0];
  const preparationState = async p => (await db.query(
    "select state from private.sc010c_voice_preparations where id=$1", [p.operationId])).rows[0].state;

  await t.test("201 records the call once; a replay sends nothing", async () => {
    const p = await prepared();
    const { http, calls } = transport(reply(201, { call_id: "call_worker_accept_0001", call_status: "registered" }));
    const result = await dispatch(p, http);
    assert.equal(result.state, "accepted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.retellai.com/v2/create-phone-call");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.headers.Authorization, "Bearer " + apiKey);
    assert.deepEqual(JSON.parse(calls[0].init.body), p.draft.payload);
    assert.deepEqual(await claim(p), { state: "accepted", attempts: 1, rejection: null });
    assert.deepEqual(await dispatch(p, transport().http), result);
    const persisted = JSON.stringify((await db.query(
      "select d.*,a.* from private.sc011b_voice_dispatches d join private.sc011b_voice_attempts a using(company_id,preparation_id) where d.preparation_id=$1",
      [p.operationId])).rows);
    assert.ok(!persisted.includes(p.draft.payload.to_number) && !persisted.includes(apiKey));
    assert.deepEqual(await pool(p), { used: 0, reserved: 1 }, "settled later by the call outcome");
  });

  await t.test("transient failures keep the reservation and resend the same idempotency key", async () => {
    const p = await prepared();
    for (const failure of [reply(429), reply(503), reply(401), reply(402), new Error("network"), reply(201, { other: 1 })]) {
      assert.deepEqual(await dispatch(p, transport(failure).http), { state: "retry_later" });
    }
    assert.deepEqual(await claim(p), { state: "sending", attempts: 6, rejection: null });
    assert.deepEqual(await pool(p), { used: 0, reserved: 1 });
    // While a call may have left, the preparation cannot be cancelled offline.
    await env.actor(db, p.s.f.owner);
    await assert.rejects(cancelOfflineVoicePreparation(db, p.s.context, p.operationId),
      e => e.code === "VOICE_PREPARATION_CONFLICT");
    await env.asServer(p.s.f.owner);
    const { http, calls } = transport(reply(201, { call_id: "call_worker_retry_0001" }));
    assert.equal((await dispatch(p, http)).state, "accepted");
    assert.equal(JSON.parse(calls[0].init.body).idempotency_key, p.draft.payload.idempotency_key);
    assert.deepEqual(await claim(p), { state: "accepted", attempts: 7, rejection: null });
  });

  await t.test("a request Retell refuses as invalid releases the interview and cannot be resent", async () => {
    const p = await prepared();
    assert.deepEqual(await dispatch(p, transport(reply(422, { error_message: "x" })).http), { state: "rejected" });
    assert.deepEqual(await claim(p), { state: "rejected", attempts: 1, rejection: "unprocessable" });
    assert.equal(await preparationState(p), "cancelled_offline");
    assert.deepEqual(await pool(p), { used: 0, reserved: 0 });
    const again = transport(reply(201, { call_id: "call_worker_never_0001" }));
    assert.deepEqual(await dispatch(p, again.http), { state: "rejected" });
    assert.equal(again.calls.length, 0);
  });

  await t.test("past Retell's deduplication window the claim becomes unknown: no redial", async () => {
    const p = await prepared();
    assert.deepEqual(await dispatch(p, transport(reply(500)).http), { state: "retry_later" });
    await db.query("set session_replication_role=replica");
    await db.query("update private.sc011b_voice_dispatches set started_at=clock_timestamp()-make_interval(secs=>$2) where preparation_id=$1",
      [p.operationId, RETELL_RESEND_WINDOW_MS / 1000 + 60]);
    await db.query("set session_replication_role=origin");
    const late = transport(reply(201, { call_id: "call_worker_late_00001" }));
    assert.deepEqual(await dispatch(p, late.http), { state: "unknown" });
    assert.equal(late.calls.length, 0);
    assert.deepEqual(await pool(p), { used: 0, reserved: 1 }, "kept until reconciled");
    await assert.rejects(db.query("update private.sc011b_voice_dispatches set state='sending' where preparation_id=$1",
      [p.operationId]), /IMMUTABLE/);
  });

  const dispatchError = code => e => e instanceof RetellDispatchError && e.code === code;
  const blockVoice = p => db.query(
    "update public.candidate_contact_preferences set blocked_channels='{voice}',revision=revision+1 where company_id=$1 and candidate_id=$2",
    [p.s.f.companyId, p.s.f.candidate.id]);

  await t.test("revoked contact authority stops the first send and every resend", async () => {
    const first = await prepared();
    await blockVoice(first);
    const never = transport(reply(201, { call_id: "call_worker_revoked_01" }));
    await assert.rejects(dispatch(first, never.http), dispatchError("VOICE_DISPATCH_UNAVAILABLE"));
    assert.equal(never.calls.length, 0);
    assert.equal(await claim(first), undefined, "the claim rolled back with the failed currentness check");

    const resend = await prepared();
    assert.deepEqual(await dispatch(resend, transport(reply(503)).http), { state: "retry_later" });
    await blockVoice(resend);
    const later = transport(reply(201, { call_id: "call_worker_revoked_02" }));
    await assert.rejects(dispatch(resend, later.http), dispatchError("VOICE_DISPATCH_UNAVAILABLE"));
    assert.equal(later.calls.length, 0);
    assert.deepEqual(await claim(resend), { state: "sending", attempts: 1, rejection: null });
  });

  await t.test("a draft that is not this preparation's own compiled request is refused", async () => {
    const a = await prepared(), b = await prepared();
    const { http, calls } = transport(reply(201, { call_id: "call_worker_swap_00001" }));
    // Another preparation's authentic draft under this operation id.
    await assert.rejects(dispatchRetellCall(db, { companyId: a.s.f.companyId, operationId: a.operationId,
      draft: b.draft, apiKey }, http, b.draft.verifiedAtMs + 1), dispatchError("VOICE_DISPATCH_REJECTED"));
    // A copy, even of the right draft, is not the compiled object.
    await assert.rejects(dispatchRetellCall(db, { companyId: a.s.f.companyId, operationId: a.operationId,
      draft: structuredClone(a.draft), apiKey }, http, a.draft.verifiedAtMs + 1), dispatchError("VOICE_DISPATCH_REJECTED"));
    assert.equal(calls.length, 0);
    assert.equal(await claim(a), undefined);
    // A resend must carry exactly the request pinned by the first claim.
    assert.deepEqual(await dispatch(a, transport(reply(500)).http), { state: "retry_later" });
    await db.query("set session_replication_role=replica");
    await db.query("update private.sc011b_voice_dispatches set payload_sha256=repeat('0',64) where preparation_id=$1", [a.operationId]);
    await db.query("set session_replication_role=origin");
    await assert.rejects(dispatch(a, http), dispatchError("VOICE_DISPATCH_REJECTED"));
    assert.equal(calls.length, 0);
  });

  await t.test("a call id recorded before a crash settles the claim without resending", async () => {
    const p = await prepared();
    assert.deepEqual(await dispatch(p, transport(reply(500)).http), { state: "retry_later" });
    const { attemptId } = await recordRetellDispatch(db, { companyId: p.s.f.companyId, operationId: p.operationId,
      providerCallId: "call_worker_crash_0001", agentId: p.draft.payload.override_agent_id });
    const after = transport(reply(201, { call_id: "call_worker_crash_0002" }));
    assert.deepEqual(await dispatch(p, after.http), { state: "accepted", attemptId });
    assert.equal(after.calls.length, 0);
    assert.equal((await claim(p)).state, "accepted");
  });

  const held = () => {
    let release, started;
    const sent = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const http = async (url, init) => { calls.push({ url, init }); started(); return gate; };
    return { http, calls, sent, release };
  };

  await t.test("an in-flight request blocks overlapping resends without spending attempts", async () => {
    const p = await prepared();
    const first = held();
    const pending = dispatch(p, first.http);
    await first.sent;
    for (let i = 0; i < 12; i++) {
      const overlap = transport(reply(201, { call_id: "call_worker_overlap_01" }));
      assert.deepEqual(await dispatch(p, overlap.http), { state: "retry_later" });
      assert.equal(overlap.calls.length, 0);
    }
    assert.deepEqual(await claim(p), { state: "sending", attempts: 1, rejection: null });
    first.release(reply(201, { call_id: "call_worker_overlap_02" }));
    assert.equal((await pending).state, "accepted");
    assert.deepEqual(await claim(p), { state: "accepted", attempts: 1, rejection: null });
  });

  await t.test("an acceptance that arrives after the claim went unknown is still recorded", async () => {
    const p = await prepared();
    const first = held();
    const pending = dispatch(p, first.http);
    await first.sent;
    await db.query("set session_replication_role=replica");
    await db.query("update private.sc011b_voice_dispatches set state='unknown',lease_until=null where preparation_id=$1", [p.operationId]);
    await db.query("set session_replication_role=origin");
    first.release(reply(201, { call_id: "call_worker_late_ok_01" }));
    const result = await pending;
    assert.equal(result.state, "accepted");
    assert.equal((await claim(p)).state, "accepted");
    const again = transport(reply(201, { call_id: "call_worker_late_ok_02" }));
    assert.deepEqual(await dispatch(p, again.http), result);
    assert.equal(again.calls.length, 0);
  });

  await t.test("a stale or malformed draft never claims or sends", async () => {
    const p = await prepared();
    const { http, calls } = transport(reply(201, { call_id: "call_worker_stale_0001" }));
    await assert.rejects(dispatch(p, http, p.draft.expiresAtMs + 1),
      e => e instanceof RetellDispatchError && e.code === "VOICE_DISPATCH_STALE_DRAFT");
    await assert.rejects(dispatchRetellCall(db, { companyId: p.s.f.companyId, operationId: p.operationId,
      draft: { ...p.draft, endpoint: "https://evil.invalid/x" }, apiKey }, http, p.draft.verifiedAtMs + 1),
    e => e instanceof RetellDispatchError && e.code === "VOICE_DISPATCH_REJECTED");
    assert.equal(calls.length, 0);
    assert.equal(await claim(p), undefined);
  });
});
