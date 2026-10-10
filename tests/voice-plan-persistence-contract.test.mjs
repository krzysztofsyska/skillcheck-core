import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { behaviorAreas } from "../lib/position-fields.ts";
import { createVoicePlanWriteSnapshot, planWriteFingerprint, validatePlanReviewCommand, validatePlanReleaseCommand, VoicePlanStorageError } from "../lib/voice/plan-persistence-contract.ts";
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const moment="2026-10-10T13:00:00.000Z";
const sha="a".repeat(64);
function source() { return {
  companyId:id(1), applicationId:id(4), positionRevision:"position-v1",
  analysisRevision:"analysis-v1", reviewRevision:"review-v1",
  screeningReviewed:true,screeningCurrent:true,position:{
    title:"Handlowiec B2B",tasks:["Obsługa sprzedaży"],kpis:["Przychody"],
    requiredCompetencies:["Negocjacje"],requiredBehaviors:behaviorAreas.map(([,name])=>name+": Standardowy")
  },gaps:[{criterionId:"kpi:1",kind:"kpi",reason:"missing_evidence"}]
};}
function binding(){return {
  companyId:id(1),recruitmentId:id(2),applicationId:id(4),positionId:id(3),
  analysisId:id(5),reviewId:id(6),shortlistEntryId:id(7),
  applicationUpdatedAt:moment,recruitmentUpdatedAt:moment,positionUpdatedAt:moment,
  analysisFingerprint:sha,screeningContractHash:sha
};}
test("SC-012-B B1 canonical role source produces immutable questions without PII",()=>{
 const s=createVoicePlanWriteSnapshot(source(),binding());
 assert.equal(s.questions.length,5);
 assert.equal(s.recordingAllowed,false);
 assert.equal(s.targetSeconds,420);
 assert.equal(s.maximumSeconds,600);
 assert.ok(Object.isFrozen(s.questions));
 assert.ok(Object.isFrozen(s));
 assert.match(planWriteFingerprint(s),/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(s.questions).includes("Przychody"));
});
test("SC-012-B B1 detects inconsistent tenant or application binding",()=>{
 for(const b of [{...binding(),companyId:id(100)},{...binding(),applicationId:id(9)},
   {...binding(),analysisFingerprint:"bad"},{...binding(),positionUpdatedAt:"not-a-time"}]){
   assert.throws(()=>createVoicePlanWriteSnapshot(source(),b),VoicePlanStorageError);
 }
});
test("SC-012-B B1 source versions cannot reuse a previous fingerprint",()=>{
 const original=createVoicePlanWriteSnapshot(source(),binding());
 const changed=createVoicePlanWriteSnapshot(source(),{...binding(),reviewId:id(90)});
 assert.notEqual(original.sourceHash,changed.sourceHash);
 assert.notEqual(planWriteFingerprint(original),planWriteFingerprint(changed));
});
test("SC-012-B B1 exact review and release commands cannot smuggle extra fields",()=>{
 const review={planId:id(21),expectedPlanVersion:1,expectedSourceHash:sha,
   expectedReviewVersion:0,decision:"approved",reason:null,requestKey:id(50)};
 const release={planId:id(21),expectedPlanVersion:1,expectedSourceHash:sha,
   approvedReviewId:id(22),expectedReviewVersion:1,requestKey:id(51)};
 assert.equal(validatePlanReviewCommand(review).decision,"approved");
 assert.equal(validatePlanReleaseCommand(release).expectedReviewVersion,1);
 for(const b of [{...review,candidateEmail:"private@example.com"},
    {...review,expectedReviewVersion:-1},{...review,decision:"hire"},
    {...review,requestKey:["fake"]},
    {...review,decision:"requires_changes",reason:null},
    {...review,decision:"requires_changes",reason:"  "}]) assert.throws(()=>validatePlanReviewCommand(b),VoicePlanStorageError);
 for(const b of [{...release,recordingAllowed:true},{...release,expectedReviewVersion:0},
    {...release,approvedReviewId:id(22).replace("4000","A000")}]) assert.throws(()=>validatePlanReleaseCommand(b),VoicePlanStorageError);
});
test("SC-012-B B1 sparse/malformed or unreviewed source is rejected",()=>{
 const x=source();
 const missing={...x,position:{...x.position,requiredBehaviors:[...x.position.requiredBehaviors.slice(0,7)]}};
 assert.throws(()=>createVoicePlanWriteSnapshot(missing,binding()));
 assert.throws(()=>createVoicePlanWriteSnapshot({...x,screeningReviewed:false},binding()));
 assert.throws(()=>createVoicePlanWriteSnapshot({...x,screeningCurrent:false},binding()));
});


test("SC-012-B B1 rejects array-wrapped hashes and mutated or copied plan envelopes",()=>{
 const command={planId:id(21),expectedPlanVersion:1,expectedSourceHash:[sha],
   expectedReviewVersion:0,decision:"approved",requestKey:id(50)};
 assert.throws(()=>validatePlanReviewCommand(command),VoicePlanStorageError);
 assert.throws(()=>validatePlanReleaseCommand({
   planId:id(21),expectedPlanVersion:1,expectedSourceHash:[sha],
   approvedReviewId:id(22),expectedReviewVersion:1,requestKey:id(50)
 }),VoicePlanStorageError);
 const valid=createVoicePlanWriteSnapshot(source(),binding());
 const modified=structuredClone(valid);
 modified.questions[0].text="Injected private text";
 assert.throws(()=>planWriteFingerprint(modified),VoicePlanStorageError);
 const modifiedTime=structuredClone(valid);
 modifiedTime.targetSeconds=60;
 assert.throws(()=>planWriteFingerprint(modifiedTime),VoicePlanStorageError);
});

test("SC-012-B B1 accepts position input near existing 30-by-500 source limits",()=>{
 const largeSource=source();
 largeSource.position.tasks=Array.from({length:30},(_,i)=>"Zadanie "+i+" "+("X".repeat(480)));
 largeSource.position.kpis=Array.from({length:30},(_,i)=>"Wynik "+i+" "+("Y".repeat(480)));
 largeSource.position.requiredCompetencies=Array.from({length:30},(_,i)=>"Kompetencja "+i+" "+("Z".repeat(480)));
 const result=createVoicePlanWriteSnapshot(largeSource,binding());
 assert.equal(result.questions.length,5);
});

test("SC-012-B rejects mutated source binding, source fingerprint, and array hash",()=>{
 const s=createVoicePlanWriteSnapshot(source(),binding());
 assert.throws(()=>planWriteFingerprint({...s,sourceHash:[s.sourceHash]}),VoicePlanStorageError);
 assert.throws(()=>planWriteFingerprint({...s,sourceBinding:{...s.sourceBinding,reviewId:id(83)}}),VoicePlanStorageError);
 assert.throws(()=>planWriteFingerprint({...s,planSourceFingerprint:"f".repeat(64)}),VoicePlanStorageError);
 const altered=structuredClone(s);
 altered.questions[0].text="Wstrzyknięte dane osobowe";
 altered.planContractHash=createHash("sha256").update(JSON.stringify({
   plan:altered.templateVersion,questions:altered.questions
 })).digest("hex");
 assert.throws(()=>planWriteFingerprint(altered),VoicePlanStorageError);
});
test("SC-012-B accepts PostgreSQL microsecond timestamps and timezone offsets",()=>{
 const pgBinding={...binding(),applicationUpdatedAt:"2026-10-10T13:00:00.123456+00:00",
   recruitmentUpdatedAt:"2026-10-10T15:00:00.000001+02:00"};
 const s=createVoicePlanWriteSnapshot(source(),pgBinding);
 assert.match(planWriteFingerprint(s),/^[a-f0-9]{64}$/);
});
