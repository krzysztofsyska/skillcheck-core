import test from "node:test";
import assert from "node:assert/strict";
import { FakeVoiceProvider } from "../lib/voice/fake-provider.ts";
import {
  validateVoiceCallRequest, VoiceProviderUncertainError, VoiceProviderValidationError,
} from "../lib/voice/provider.ts";

const request = () => ({
  externalCorrelationId: "random-correlation-001",
  destinationE164: "+48123456789",
  publishedAssistantVersion: "assistant-v001",
  providerIdempotencyKey: "random-idempotency-001",
  recordingAllowed: false,
  callTimeoutSeconds: 600,
  scenario: {
    schemaVersion: 1, language: "pl-PL", introductionVersion: "notice-v001",
    questions: [{ id: "common-responsibility", prompt: "Proszę opisać sytuację zawodową.", followUps: [] }],
    constraints: { maxSeconds: 600, prohibitedTopics: ["zdrowie"] },
  },
});

test("SC-011-A fake returns synthetic accepted once and safely cancels", async () => {
  const provider = new FakeVoiceProvider();
  const accepted = await provider.initiateOutbound(request());
  assert.deepEqual(accepted, await provider.initiateOutbound(request()));
  assert.equal(provider.syntheticCallCount, 1);
  assert.deepEqual(await provider.getCallByIdempotencyKey(request().providerIdempotencyKey),
    { state: "found", providerCallId: accepted.providerCallId, status: "accepted" });
  await provider.cancelCall(accepted.providerCallId);
  await provider.cancelCall(accepted.providerCallId);
  assert.equal((await provider.getCallByIdempotencyKey(request().providerIdempotencyKey)).status, "cancelled");
  await assert.rejects(provider.initiateOutbound(request()), VoiceProviderValidationError);
});

test("SC-011-A refuses invalid requests and changed payload on same idempotency key", async () => {
  const r = request();
  for (const mutation of [
    { destinationE164: "123" },
    { recordingAllowed: "true" },
    { callTimeoutSeconds: 601 },
    { scenario: { ...r.scenario, language: "en-US" } },
    { scenario: { ...r.scenario, questions: [{ ...r.scenario.questions[0], prompt: "" }] } },
  ]) assert.throws(() => validateVoiceCallRequest({ ...r, ...mutation }), VoiceProviderValidationError);
  const provider = new FakeVoiceProvider();
  await provider.initiateOutbound(r);
  await assert.rejects(provider.initiateOutbound({ ...r, destinationE164: "+48222333444" }), e => {
    assert.equal(e.code, "VOICE_PROVIDER_INVALID_REQUEST");
    assert.ok(!e.message.includes("+48"));
    return true;
  });
});

test("SC-011-A timeout after acceptance is unknown and requires reconciliation", async () => {
  const after = new FakeVoiceProvider("timeout_after_acceptance");
  await assert.rejects(after.initiateOutbound(request()), VoiceProviderUncertainError);
  assert.equal(after.syntheticCallCount, 1);
  assert.equal((await after.getCallByIdempotencyKey(request().providerIdempotencyKey)).state, "found");
  const unsupported = new FakeVoiceProvider("timeout_after_acceptance", false);
  await assert.rejects(unsupported.initiateOutbound(request()), VoiceProviderUncertainError);
  assert.deepEqual(await unsupported.getCallByIdempotencyKey(request().providerIdempotencyKey), { state: "unsupported" });
  const before = new FakeVoiceProvider("timeout_before_acceptance");
  await assert.rejects(before.initiateOutbound(request()), VoiceProviderUncertainError);
  assert.equal(before.syntheticCallCount, 0);
  assert.deepEqual(await before.getCallByIdempotencyKey(request().providerIdempotencyKey), { state: "not_found" });
});
