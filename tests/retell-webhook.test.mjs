import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  readRetellWebhook, retellProviderEvent, verifyRetellWebhookSignature,
  RetellWebhookError, RETELL_WEBHOOK_MAX_BYTES,
} from "../lib/voice/retell-webhook.ts";
import { projectVoiceProviderEvent } from "../lib/voice/provider-event-contract.ts";

const key = "key_synthetic_webhook_0123456789";
const config = { webhookKey: key, agentId: "agent_1234567890abcdef", agentVersion: 2 };
const now = 1_793_000_000_000;
const attemptId = "00000000-0000-4000-8000-000000000011";
const callId = "call_9f3b2c1d4e5f6a7b8c9d0e1f";
const enc = text => new TextEncoder().encode(text);
const sign = (body, at = now, secret = key) =>
  "v=" + at + ",d=" + createHmac("sha256", secret).update(Buffer.concat([Buffer.from(body), Buffer.from(String(at))])).digest("hex");
const call = (change = {}) => ({
  call_type: "phone_call", direction: "outbound", call_id: callId,
  agent_id: config.agentId, agent_version: 2, call_status: "ended",
  from_number: "+48581234567", to_number: "+48123456789",
  start_timestamp: now - 400_000, end_timestamp: now - 10_000,
  disconnection_reason: "user_hangup",
  retell_llm_dynamic_variables: { skillcheck_company_name: "Firma Testowa" },
  metadata: {}, recording_url: "https://example.invalid/rec.wav",
  transcript: "Agent: Dzień dobry\nUser: Dzień dobry, Jan Kowalski",
  transcript_object: [
    { role: "agent", content: "Dzień dobry, czy rozmawiam z osobą, która wysłała zgłoszenie?",
      words: [{ word: "Dzień", start: 0.1, end: 0.4 }] },
    { role: "user", content: "Tak,\nto ja.   Jan Kowalski", words: [] },
    { role: "agent", content: "   " },
  ],
  call_analysis: { call_summary: "Kandydat Jan Kowalski ..." },
  call_cost: { combined_cost: 12 },
  ...change,
});
const deliver = (payload, { at = now, secret = key, header } = {}) => {
  const body = enc(typeof payload === "string" ? payload : JSON.stringify(payload));
  return readRetellWebhook(body, header ?? sign(body, at, secret), config, now);
};
const unauth = fn => assert.throws(fn, e => e instanceof RetellWebhookError && e.code === "RETELL_WEBHOOK_UNAUTHENTICATED");
const rejected = fn => assert.throws(fn, e => e instanceof RetellWebhookError && e.code === "RETELL_WEBHOOK_REJECTED");

test("call_ended keeps only speaker and text; numbers, recording, analysis and variables are dropped", () => {
  const result = deliver({ event: "call_ended", call: call() });
  assert.equal(result.kind, "call");
  assert.equal(result.status, "completed");
  assert.equal(result.outcome, "completed");
  assert.equal(result.providerCallId, callId);
  assert.equal(result.occurredAt, new Date(now - 10_000).toISOString());
  assert.deepEqual(result.transcript, [
    { speaker: "agent", text: "Dzień dobry, czy rozmawiam z osobą, która wysłała zgłoszenie?" },
    { speaker: "candidate", text: "Tak, to ja. Jan Kowalski" },
  ]);
  const kept = JSON.stringify(result);
  for (const dropped of ["+48123456789", "+48581234567", "rec.wav", "Firma Testowa", "call_summary",
    "combined_cost", "words", "start"]) assert.ok(!kept.includes(dropped), dropped);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.transcript));
});

test("signature is checked on the exact raw bytes with key, window and constant format", () => {
  const body = enc(JSON.stringify({ event: "call_started", call: call() }));
  assert.equal(readRetellWebhook(body, sign(body), config, now).status, "connected");
  const reserialized = enc(JSON.stringify({ event: "call_started", call: call() }, null, 1));
  unauth(() => readRetellWebhook(reserialized, sign(body), config, now));
  unauth(() => readRetellWebhook(body, sign(body, now, "key_other_webhook_0123456789"), config, now));
  for (const at of [now - 300_001, now + 300_001]) unauth(() => readRetellWebhook(body, sign(body, at), config, now));
  for (const at of [now - 300_000, now + 300_000]) assert.equal(readRetellWebhook(body, sign(body, at), config, now).kind, "call");
  const good = sign(body);
  for (const header of [null, "", good.toUpperCase(), good + " ", " " + good, good.replace(",d=", ", d="),
    good.slice(0, -2), good + "00", "d=" + good.split(",d=")[1] + ",v=" + now, good.replace(/^v=\d+/, "v=-1")])
    unauth(() => readRetellWebhook(body, header, config, now));
  unauth(() => verifyRetellWebhookSignature(body, good, "short", now));
  unauth(() => verifyRetellWebhookSignature(new Uint8Array(RETELL_WEBHOOK_MAX_BYTES + 1), good, key, now));
  unauth(() => verifyRetellWebhookSignature("not bytes", good, key, now));
});

test("only the configured outbound agent version is accepted after authentication", () => {
  for (const change of [{ agent_id: "agent_abcdef1234567890" }, { agent_version: 3 }, { agent_version: "2" },
    { call_type: "web_call" }, { direction: "inbound" }, { call_id: "../etc" }, { call_id: "_leading" },
    { end_timestamp: undefined }])
    rejected(() => deliver({ event: "call_ended", call: call(change) }));
  rejected(() => deliver("not json"));
  rejected(() => deliver({ event: "call_ended" }));
  const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
  rejected(() => readRetellWebhook(invalidUtf8, sign(invalidUtf8), config, now));
  rejected(() => readRetellWebhook(enc("{}"), sign(enc("{}")), { ...config, agentId: "x" }, now));
});

test("unknown authentic events are acknowledged as ignored with a stable receipt", () => {
  const first = deliver({ event: "transcript_updated", call: call() });
  assert.equal(first.kind, "ignored");
  assert.deepEqual(Object.keys(first).sort(), ["kind", "receiptId"]);
  unauth(() => deliver({ event: "transcript_updated", call: call() }, { secret: "key_other_webhook_0123456789" }));
});

test("retried deliveries share one receipt; different events do not", () => {
  const a = deliver({ event: "call_ended", call: call() }, { at: now - 1000 });
  const b = deliver({ event: "call_ended", call: call() }, { at: now });
  const c = deliver({ event: "call_analyzed", call: call() });
  assert.equal(a.receiptId, b.receiptId);
  assert.notEqual(a.receiptId, c.receiptId);
  assert.equal(c.status, null);
  assert.equal(c.transcript, null);
  assert.ok(!JSON.stringify(c).includes("Kowalski"));
});

test("disconnection reasons map to a closed outcome set; DNC is surfaced", () => {
  const cases = {
    user_hangup: ["completed", "completed"], agent_hangup: ["completed", "completed"],
    max_duration_reached: ["completed", "completed"], inactivity: ["completed", "completed"],
    user_requested_dnc: ["completed", "dnc_requested"],
    dial_no_answer: ["failed", "no_answer"], dial_busy: ["failed", "busy"],
    voicemail_reached: ["failed", "voicemail"], dial_failed: ["failed", "provider_error"],
    error_llm_websocket_open: ["failed", "provider_error"], something_new: ["failed", "other"],
  };
  for (const [reason, [status, outcome]] of Object.entries(cases)) {
    const r = deliver({ event: "call_ended", call: call({ disconnection_reason: reason, transcript_object: undefined }) });
    assert.deepEqual([r.status, r.outcome, r.transcript], [status, outcome, null], reason);
  }
  rejected(() => deliver({ event: "call_ended", call: call({ disconnection_reason: 7 }) }));
});

test("transcript is bounded and malformed transcripts are refused, not partially kept", () => {
  for (const transcript_object of [
    "text", [{ role: "system", content: "x" }], [{ role: "user" }], [{ role: "user", content: 1 }],
    Array.from({ length: 401 }, () => ({ role: "user", content: "a" })),
    [{ role: "user", content: "a".repeat(4001) }],
    Array.from({ length: 16 }, () => ({ role: "user", content: "a".repeat(3999) })),
  ]) rejected(() => deliver({ event: "call_ended", call: call({ transcript_object }) }));
});

test("status events feed the existing SC-011 projection with Retell identifiers", () => {
  const started = deliver({ event: "call_started", call: call() });
  const ended = deliver({ event: "call_ended", call: call() });
  let state = { providerAccountId: config.agentId, providerCallId: callId, attemptId, status: "accepted" };
  const a = projectVoiceProviderEvent(state, retellProviderEvent(started, config, attemptId));
  assert.equal(a.outcome, "applied"); state = a.state;
  const b = projectVoiceProviderEvent(state, retellProviderEvent(ended, config, attemptId));
  assert.deepEqual([b.outcome, b.state.status], ["applied", "completed"]);
  assert.equal(projectVoiceProviderEvent(b.state, retellProviderEvent(started, config, attemptId)).outcome, "ignored_terminal");
  rejected(() => retellProviderEvent(deliver({ event: "call_analyzed", call: call() }), config, attemptId));
  rejected(() => retellProviderEvent(deliver({ event: "transcript_updated", call: call() }), config, attemptId));
});
