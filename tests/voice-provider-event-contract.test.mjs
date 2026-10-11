import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as contract from "../lib/voice/provider-event-contract.ts";
import {
  normalizeVoiceProviderEvent, parseVoiceProviderEvent, voiceProviderReceiptHash,
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
test("SC-011-B rejects calendar-impossible timestamps instead of Date.parse rollover",()=>{
  const x=receipt();
  for (const occurredAt of [
    "2026-02-30T18:00:00Z","2026-04-31T18:00:00.123456Z","2026-02-29T18:00:00+00:00",
    "1900-02-29T00:00:00Z","2100-02-29T12:00:00-05:30","2026-06-31T00:00:00Z",
    "2026-11-31T23:59:59Z","2026-00-10T18:00:00Z","2026-13-01T18:00:00Z",
    "2026-10-00T18:00:00Z","2026-10-10T24:00:00Z","2026-10-10T18:60:00Z",
    "2026-10-10T18:00:60Z","2026-10-10T18:00:00+24:00","2026-10-10T18:00:00+00:60",
    "2026-10-10","2026-10-10T18:00:00","2026-10-10 18:00:00Z","tomorrow","",
  ]) assert.throws(()=>parseVoiceProviderEvent({...x,occurredAt}),VoiceEventContractError);
  for (const occurredAt of [
    "2024-02-29T18:00:00Z","2000-02-29T00:00:00.5Z","2026-02-28T23:59:59+00:00",
    "2026-04-30T18:00:00.123456-05:30","2026-01-31T00:00:00+14:00",
  ]) {
    const parsed=parseVoiceProviderEvent({...x,occurredAt});
    assert.equal(parsed.occurredAt,occurredAt);
    assert.equal(normalizeVoiceProviderEvent(parsed).occurredAt,occurredAt);
  }
});
test("SC-011-B treats signature and source fields as untrusted input, not an authorized webhook",()=>{
  const x=receipt();
  for (const forged of [
    {...x,signature:"v0=not-a-verified-webhook"},
    {...x,providerSignature:"synthetic-untrusted"},
    {...x,source:"webhook"},
    {...x,eventSource:"provider-callback"},
    {...x,rawBody:'{"status":"completed"}'},
    {...x,authorization:"Bearer not-a-secret"},
    {...x,headers:{"x-signature":"untrusted"}},
    {...x,webhookTimestamp:"2026-10-10T18:00:00Z"},
    {...x,signingSecret:"untrusted-material"},
  ]) {
    assert.throws(()=>parseVoiceProviderEvent(forged),VoiceEventContractError);
    assert.throws(()=>projectVoiceProviderEvent(state(),forged),VoiceEventContractError);
  }
  const parsed=parseVoiceProviderEvent({...x,eventId:"sig-not-auth-01"});
  assert.equal(parsed.status,"accepted");
  assert.equal(Object.hasOwn(parsed,"signature"),false);
  assert.equal(Object.hasOwn(parsed,"source"),false);
  assert.deepEqual(Object.keys(contract).sort(),[
    "VoiceEventContractError","normalizeVoiceProviderEvent","parseVoiceProviderEvent",
    "projectVoiceProviderEvent","voiceProviderReceiptHash",
  ]);
  const source=readFileSync(new URL("../lib/voice/provider-event-contract.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/\b(fetch|undici|createHmac|https?:)\b/);
});
test("SC-011-B rejects unknown event statuses and unknown persisted states",()=>{
  for (const status of ["unknown","pending","queued","delivered","ACCEPTED",""])
    assert.throws(()=>parseVoiceProviderEvent(receipt(status)),VoiceEventContractError);
  for (const status of ["pending","hired","delivered","","UNKNOWN"])
    assert.throws(()=>projectVoiceProviderEvent(state(status),receipt("ringing")),VoiceEventContractError);
  const forward=projectVoiceProviderEvent(state("unknown"),receipt("accepted"));
  assert.equal(forward.outcome,"applied");
  assert.equal(forward.state.status,"accepted");
  assert.throws(()=>projectVoiceProviderEvent(forward.state,receipt("unknown")),VoiceEventContractError);
});
test("SC-011-B orders by status rank and ignores a newer timestamp that would move backward",()=>{
  const steps=["unknown","accepted","ringing","connected"];
  for (let later=1; later<steps.length; later++) {
    for (let earlier=0; earlier<later; earlier++) {
      const backward={...receipt(steps[earlier]),occurredAt:"2026-12-01T00:00:00Z"};
      if (steps[earlier]==="unknown") {
        assert.throws(()=>projectVoiceProviderEvent(state(steps[later]),backward),VoiceEventContractError);
      } else {
        const moved=projectVoiceProviderEvent(state(steps[later]),backward);
        assert.equal(moved.outcome,"out_of_order");
        assert.equal(moved.state.status,steps[later]);
      }
    }
  }
  const olderForward={...receipt("connected"),occurredAt:"2020-01-01T00:00:00Z",eventId:"synthetic-event-009"};
  assert.equal(projectVoiceProviderEvent(state("ringing"),olderForward).outcome,"applied");
  for (const terminal of ["completed","failed","cancelled"]) {
    for (const later of ["accepted","ringing","connected","completed","failed","cancelled"]) {
      const outcome=later===terminal?"duplicate_status":"ignored_terminal";
      const seen=projectVoiceProviderEvent(state(terminal),receipt(later));
      assert.equal(seen.outcome,outcome);
      assert.equal(seen.state.status,terminal);
    }
  }
  assert.equal(projectVoiceProviderEvent(state("connected"),receipt("failed")).outcome,"applied");
  assert.equal(projectVoiceProviderEvent(state("ringing"),receipt("cancelled")).outcome,"applied");
});
test("SC-011-B duplicate status is idempotent and this parser stores no event-id dedupe",()=>{
  const event=receipt("accepted");
  const first=projectVoiceProviderEvent(state("unknown"),event);
  assert.equal(first.outcome,"applied");
  const again=projectVoiceProviderEvent(first.state,event);
  assert.equal(again.outcome,"duplicate_status");
  assert.deepEqual(again.state,first.state);
  const otherId={...event,eventId:"synthetic-event-002"};
  assert.equal(projectVoiceProviderEvent(first.state,otherId).outcome,"duplicate_status");
  assert.equal(projectVoiceProviderEvent(state("unknown"),event).outcome,"applied");
  assert.equal(voiceProviderReceiptHash(event),voiceProviderReceiptHash({...event}));
  assert.notEqual(voiceProviderReceiptHash(event),voiceProviderReceiptHash(receipt("ringing")));
});
