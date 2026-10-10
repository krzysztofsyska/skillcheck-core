import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVoiceProviderEvent, voiceProviderReceiptHash,
  projectVoiceProviderEvent, VoiceEventContractError,
} from "../lib/voice/provider-event-contract.ts";
const attemptId="00000000-0000-4000-8000-000000000011";
const receipt=(status="accepted")=>({
  schemaVersion:1,providerAccountId:"account-synthetic-001",
  providerCallId:"synthetic-call-001",attemptId,eventId:"synthetic-event-001",
  occurredAt:"2026-10-10T18:00:00.123456+00:00",status,
});
const state=(status="unknown")=>({
  providerAccountId:receipt().providerAccountId,
  providerCallId:receipt().providerCallId,attemptId,status,
});
test("SC-011-B offline event normalization preserves only allowlisted safe metadata",()=>{
  const x=normalizeVoiceProviderEvent(receipt());
  assert.ok(Object.isFrozen(x));
  assert.match(voiceProviderReceiptHash(x),/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(x).includes("candidate"));
});
test("SC-011-B rejects forged metadata, invalid account, IDs, time and status",()=>{
  const x=receipt();
  for(const invalid of [
    {...x,destinationE164:"+48123456789"},
    {...x,transcript:"private"}, {...x,providerCallId:""},
    {...x,eventId:["synthetic-event-001"]},
    {...x,attemptId:"not-uuid"}, {...x,status:"hired"},
    {...x,occurredAt:"tomorrow"}, {...x,schemaVersion:2},
    {...x,providerAccountId:"other"},
  ]) assert.throws(()=>normalizeVoiceProviderEvent(invalid),VoiceEventContractError);
});
test("SC-011-B projects accepted/ringing/connected/completed without regressions",()=>{
  let s=state();
  for(const status of ["accepted","ringing","connected","completed"]){
    const applied=projectVoiceProviderEvent(s,receipt(status));
    assert.equal(applied.outcome,"applied");
    s=applied.state;
  }
  assert.equal(projectVoiceProviderEvent(s,receipt("connected")).outcome,"ignored_terminal");
  assert.equal(projectVoiceProviderEvent(s,receipt("completed")).outcome,"duplicate_status");
  assert.equal(projectVoiceProviderEvent(state("connected"),receipt("ringing")).outcome,"out_of_order");
});
test("SC-011-B cancelled and failed are terminal even for late success",()=>{
  for(const status of ["cancelled","failed"]){
    const s=projectVoiceProviderEvent(state("accepted"),receipt(status)).state;
    assert.equal(s.status,status);
    for(const later of ["accepted","ringing","connected","completed"])
      assert.equal(projectVoiceProviderEvent(s,receipt(later)).outcome,"ignored_terminal");
  }
});
test("SC-011-B reconciliation from unknown cannot cross attempt or account",()=>{
  assert.equal(projectVoiceProviderEvent(state("unknown"),receipt("completed")).state.status,"completed");
  for(const s of [
    {...state(),providerAccountId:"account-synthetic-002"},
    {...state(),providerCallId:"synthetic-call-999"},
    {...state(),attemptId:"00000000-0000-4000-8000-000000000099"},
  ]) assert.throws(()=>projectVoiceProviderEvent(s,receipt()),VoiceEventContractError);
});
test("SC-011-B distinct same-ID payload hashes cannot be treated as identical receipts",()=>{
  assert.notEqual(voiceProviderReceiptHash(receipt("ringing")),voiceProviderReceiptHash(receipt("failed")));
  // Persistent uniqueness of (account,eventId) and signature/replay checks are SC-010-C/adapter gates.
});
