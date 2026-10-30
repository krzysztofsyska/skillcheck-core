import test from "node:test";
import assert from "node:assert/strict";
import { prepareOfflineVoiceDraft } from "../lib/voice/offline-preparation.ts";
import { dispatchRetellCall, RETELL_RESEND_WINDOW_MS } from "../lib/voice/retell-dispatch-worker.ts";
import {
  listUnknownVoiceDispatches, resolveUnknownVoiceDispatch, VoiceDispatchResolutionError,
} from "../lib/voice/retell-dispatch-resolution.ts";
import {
  boot, SC011B2_DISPATCH_SCHEMA, SC011B4_SETTLEMENT_SCHEMA, SC011B5_DISPATCH_WORKER_SCHEMA,
  SC011B6_DISPATCH_RESOLUTION_SCHEMA,
} from "./helpers/voice-preparation-fixture.mjs";
import { syntheticRetellProof } from "./helpers/voice-preparation-provider-fixture.mjs";
import { users } from "./helpers/screening-ranking-fixture.mjs";

const apiKey = "key_synthetic_never_real_0123456789";
const agentId = "agent_1234567890abcdef";
const reply = status => new Response(null, { status });

test("SC-011-B6 operator resolution of unknown dispatches on real PostgreSQL", async t => {
  const env = await boot(t, { extraSchemas: [SC011B2_DISPATCH_SCHEMA, SC011B4_SETTLEMENT_SCHEMA,
    SC011B5_DISPATCH_WORKER_SCHEMA, SC011B6_DISPATCH_RESOLUTION_SCHEMA] }), { db } = env;
  const operator = users.outsider;
  await db.query("insert into public.platform_operators(user_id) values($1) on conflict do nothing", [operator]);
  const unknown = async () => {
    const s = await env.ready();
    await env.actor(db, s.f.owner);
    const proof = await syntheticRetellProof();
    const { operationId, draft } = await prepareOfflineVoiceDraft(db, s.context, s.request,
      s.deps(proof.retell, proof.verifiedAgent));
    await env.asServer(s.f.owner);
    const input = { companyId: s.f.companyId, operationId, draft, apiKey };
    assert.deepEqual(await dispatchRetellCall(db, input, async () => reply(503), draft.verifiedAtMs + 1),
      { state: "retry_later" });
    await db.query("set session_replication_role=replica");
    await db.query("update private.sc011b_voice_dispatches set started_at=clock_timestamp()-make_interval(secs=>$2) where preparation_id=$1",
      [operationId, RETELL_RESEND_WINDOW_MS / 1000 + 60]);
    await db.query("set session_replication_role=origin");
    assert.deepEqual(await dispatchRetellCall(db, input, async () => { throw new Error("must not send"); },
      draft.verifiedAtMs + 1), { state: "unknown" });
    return { s, operationId, draft, target: { companyId: s.f.companyId, preparationId: operationId } };
  };
  const pool = async u => (await db.query("select used,reserved from private.sc19_voice_entitlements where id=$1",
    [u.s.request.entitlementId])).rows[0];
  const state = async u => (await db.query([
    "select d.state as dispatch,p.state as preparation from private.sc011b_voice_dispatches d",
    "join private.sc010c_voice_preparations p on p.company_id=d.company_id and p.id=d.preparation_id",
    "where d.preparation_id=$1",
  ].join(" "), [u.operationId])).rows[0];
  const denied = code => e => e instanceof VoiceDispatchResolutionError && e.code === code;

  await t.test("only a platform operator lists and resolves", async () => {
    const u = await unknown();
    await env.actor(db, u.s.f.owner);
    await assert.rejects(listUnknownVoiceDispatches(db), denied("VOICE_RESOLUTION_FORBIDDEN"));
    await assert.rejects(resolveUnknownVoiceDispatch(db, u.target, { resolution: "not_placed" }),
      denied("VOICE_RESOLUTION_FORBIDDEN"));
    await env.actor(db, operator);
    const listed = await listUnknownVoiceDispatches(db);
    assert.ok(listed.some(row => row.preparationId === u.operationId));
    assert.ok(!JSON.stringify(listed).includes(u.draft.payload.to_number));
    await env.asServer(u.s.f.owner);
  });

  await t.test("not placed: the preparation is cancelled and the interview returns to the pool", async () => {
    const u = await unknown();
    assert.deepEqual(await pool(u), { used: 0, reserved: 1 });
    await env.actor(db, operator);
    await resolveUnknownVoiceDispatch(db, u.target, { resolution: "not_placed" });
    await assert.rejects(resolveUnknownVoiceDispatch(db, u.target, { resolution: "not_placed" }),
      denied("VOICE_RESOLUTION_CONFLICT"));
    await env.asServer(u.s.f.owner);
    assert.deepEqual(await state(u), { dispatch: "abandoned", preparation: "cancelled_offline" });
    assert.deepEqual(await pool(u), { used: 0, reserved: 0 });
    const audit = (await db.query("select resolution,resolved_by from private.sc011b_dispatch_resolutions where preparation_id=$1",
      [u.operationId])).rows;
    assert.deepEqual(audit, [{ resolution: "not_placed", resolved_by: operator }]);
    const never = await dispatchRetellCall(db, { companyId: u.s.f.companyId, operationId: u.operationId,
      draft: u.draft, apiKey }, async () => { throw new Error("must not send"); }, u.draft.verifiedAtMs + 1);
    assert.equal(never.state, "rejected");
  });

  await t.test("placed: the found call is recorded and settled like a webhook", async () => {
    const completed = await unknown();
    await env.actor(db, operator);
    await resolveUnknownVoiceDispatch(db, completed.target,
      { resolution: "placed", providerCallId: "call_resolved_done_0001", outcome: "completed", agentId });
    await env.asServer(completed.s.f.owner);
    assert.deepEqual(await state(completed), { dispatch: "accepted", preparation: "prepared_offline" });
    assert.deepEqual(await pool(completed), { used: 1, reserved: 0 });

    const missed = await unknown();
    await env.actor(db, operator);
    await resolveUnknownVoiceDispatch(db, missed.target,
      { resolution: "placed", providerCallId: "call_resolved_miss_0001", outcome: "no_answer", agentId });
    await env.asServer(missed.s.f.owner);
    assert.deepEqual(await pool(missed), { used: 0, reserved: 0 });

    const dnc = await unknown();
    await env.actor(db, operator);
    await resolveUnknownVoiceDispatch(db, dnc.target,
      { resolution: "placed", providerCallId: "call_resolved_dnc_00001", outcome: "dnc_requested", agentId });
    await env.asServer(dnc.s.f.owner);
    const prefs = (await db.query("select blocked_channels from public.candidate_contact_preferences where company_id=$1 and candidate_id=$2",
      [dnc.s.f.companyId, dnc.s.f.candidate.id])).rows[0];
    assert.deepEqual([...prefs.blocked_channels].sort(), ["email", "sms", "voice"]);
  });

  await t.test("invalid decisions change nothing", async () => {
    const u = await unknown();
    await env.actor(db, operator);
    for (const decision of [{ resolution: "placed", providerCallId: "call_x_00000001", outcome: "hired", agentId },
      { resolution: "maybe" }, { resolution: "placed", providerCallId: "../x", outcome: "completed", agentId }])
      await assert.rejects(resolveUnknownVoiceDispatch(db, u.target, decision), e => e instanceof VoiceDispatchResolutionError);
    await env.asServer(u.s.f.owner);
    assert.deepEqual(await state(u), { dispatch: "unknown", preparation: "prepared_offline" });
    assert.deepEqual(await pool(u), { used: 0, reserved: 1 });
  });
});
