/**
 * SC-012-B B1: strict, offline domain contract for persistable voice-plan snapshots.
 * Does not write to Supabase. No caller-supplied booleans or IDs grant authority.
 * Future RPC must derive tenant/actor/source from authenticated DB session.
 */
import { createHash } from "node:crypto";
import { buildInterviewPlan, type InterviewSource, type InterviewPlan } from "./interview-plan.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const TEXT = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
export const SC012B_STORAGE_VERSION = "voice-plan-storage-v1" as const;

export type VoicePlanSourceBinding = Readonly<{
  companyId: string; recruitmentId: string; applicationId: string; positionId: string;
  analysisId: string; reviewId: string; shortlistEntryId: string;
  /** Binding revisions MUST originate from the DB at a single transaction snapshot. */
  applicationUpdatedAt: string; recruitmentUpdatedAt: string; positionUpdatedAt: string;
  analysisFingerprint: string; screeningContractHash: string;
}>;
export type VoicePlanWriteSnapshot = Readonly<{
  schemaVersion: 1;
  storageContractVersion: typeof SC012B_STORAGE_VERSION;
  sourceBinding: VoicePlanSourceBinding;
  sourceHash: string;
  planContractHash: string;
  templateVersion: "skillcheck-voice-plan-v1";
  language: "pl-PL";
  targetSeconds: 420;
  maximumSeconds: 600;
  recordingAllowed: false;
  noticeRequired: true;
  questions: readonly Readonly<{
    id: string; criterionId: string; criterionKind: "behavior" | "task" | "kpi" | "competency";
    kind: "common" | "clarification"; text: string; followUps: readonly string[];
    maxSeconds: number;
  }>[];
}>;
export type PlanReviewDecision = "approved" | "requires_changes";
export type PlanReviewRequest = Readonly<{
  planId: string; expectedPlanVersion: number; expectedSourceHash: string;
  expectedReviewVersion: number; decision: PlanReviewDecision; requestKey: string;
}>;
export type PlanReleaseRequest = Readonly<{
  planId: string; expectedPlanVersion: number; expectedSourceHash: string;
  approvedReviewId: string; expectedReviewVersion: number; requestKey: string;
}>;
export class VoicePlanStorageError extends Error {
  readonly code: "INVALID" | "SOURCE_CHANGED" | "CONFLICT";
  constructor(code: "INVALID" | "SOURCE_CHANGED" | "CONFLICT") { super("VOICE_PLAN_"+code); this.code = code; }
}
const invalid = (): never => { throw new VoicePlanStorageError("INVALID"); };
const isId = (x: unknown): x is string => typeof x === "string" && UUID.test(x);
const isIso = (x: unknown): x is string =>
  typeof x === "string" && Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString() === x;
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o,k);
/** Accept only ordinary JSON-shaped data; no accessors/proxies or extra keys. */
function cleanClone<T>(value: T): T {
  try {
    const clone = structuredClone(value);
    if (JSON.stringify(clone).length > 35000) invalid();
    return clone;
  } catch { return invalid(); }
}
function exactFields(v: unknown, keys: readonly string[]): v is Record<string,unknown> {
  return !!v && typeof v==="object" && !Array.isArray(v) &&
    Object.getPrototypeOf(v)===Object.prototype &&
    Reflect.ownKeys(v).length===keys.length &&
    keys.every(k=>hasOwn(v,k));
}
function bindingValid(b: unknown): b is VoicePlanSourceBinding {
  const keys=["companyId","recruitmentId","applicationId","positionId","analysisId",
    "reviewId","shortlistEntryId","applicationUpdatedAt","recruitmentUpdatedAt",
    "positionUpdatedAt","analysisFingerprint","screeningContractHash"];
  if (!exactFields(b,keys)) return false;
  const v=b as unknown as Record<string,unknown>;
  return keys.slice(0,7).every(k=>isId(v[k])) &&
    keys.slice(7,10).every(k=>isIso(v[k])) &&
    keys.slice(10).every(k=>typeof v[k]==="string" && HEX.test(v[k] as string));
}
const hash = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/**
 * PRECONDITION: a privileged caller must load input and sourceBinding together
 * under DB authorization, verify current approved screening + human shortlist,
 * and never accept either from a browser. This function DOES NOT authorize a
 * DB write; it creates a canonical proposal to be revalidated by the future RPC.
 */
export function createVoicePlanWriteSnapshot(
  rawInput: InterviewSource, rawBinding: VoicePlanSourceBinding,
): VoicePlanWriteSnapshot {
  const input=cleanClone(rawInput);
  const binding=cleanClone(rawBinding);
  if (!bindingValid(binding) || !isId(input?.companyId) || !isId(input?.applicationId) ||
      input.companyId!==binding.companyId || input.applicationId!==binding.applicationId) invalid();
  // Generator is the only trusted source of question text in this offline phase.
  // Values from CV, provider, and arbitrary user instructions never become prompts.
  const plan=buildInterviewPlan(input);
  if (plan.status!=="generated" || plan.recordingDefault!==false || plan.noticeRequired!==true) invalid();
  const questions=plan.questions.map(q=>Object.freeze({
    id:q.id,kind:q.kind,criterionId:q.criterionId,criterionKind:q.criterionKind,
    text:q.text,followUps:Object.freeze([...q.followUps]),maxSeconds:q.maxSeconds,
  }));
  const sourceHash=hash({
    companyId:binding.companyId,recruitmentId:binding.recruitmentId,
    applicationId:binding.applicationId,positionId:binding.positionId,
    analysisId:binding.analysisId,reviewId:binding.reviewId,
    shortlistEntryId:binding.shortlistEntryId,
    applicationUpdatedAt:binding.applicationUpdatedAt,
    recruitmentUpdatedAt:binding.recruitmentUpdatedAt,
    positionUpdatedAt:binding.positionUpdatedAt,
    analysisFingerprint:binding.analysisFingerprint,
    screeningContractHash:binding.screeningContractHash,
    planSourceFingerprint:plan.sourceFingerprint,
  });
  return Object.freeze({
    schemaVersion:1,storageContractVersion:SC012B_STORAGE_VERSION,
    sourceBinding:Object.freeze({...binding}),
    sourceHash,planContractHash:hash({plan:plan.templateVersion,questions}),
    templateVersion:"skillcheck-voice-plan-v1",language:"pl-PL",
    targetSeconds:420,maximumSeconds:600,recordingAllowed:false,noticeRequired:true,
    questions:Object.freeze(questions),
  });
}

export function validatePlanReviewCommand(raw: PlanReviewRequest): PlanReviewRequest {
  const x=cleanClone(raw);
  if (!exactFields(x,["planId","expectedPlanVersion","expectedSourceHash",
      "expectedReviewVersion","decision","requestKey"]) ||
      !isId(x.planId) || !isId(x.requestKey) || !HEX.test(x.expectedSourceHash) ||
      !Number.isSafeInteger(x.expectedPlanVersion) || x.expectedPlanVersion<1 ||
      !Number.isSafeInteger(x.expectedReviewVersion) || x.expectedReviewVersion<0 ||
      !["approved","requires_changes"].includes(x.decision)) invalid();
  return Object.freeze(x);
}
export function validatePlanReleaseCommand(raw: PlanReleaseRequest): PlanReleaseRequest {
  const x=cleanClone(raw);
  if (!exactFields(x,["planId","expectedPlanVersion","expectedSourceHash",
      "approvedReviewId","expectedReviewVersion","requestKey"]) ||
      !isId(x.planId) || !isId(x.approvedReviewId) || !isId(x.requestKey) ||
      !HEX.test(x.expectedSourceHash) || !Number.isSafeInteger(x.expectedPlanVersion) ||
      x.expectedPlanVersion<1 || !Number.isSafeInteger(x.expectedReviewVersion) ||
      x.expectedReviewVersion<1) invalid();
  return Object.freeze(x);
}
export function planWriteFingerprint(p: VoicePlanWriteSnapshot): string {
  if (p.schemaVersion!==1 || p.storageContractVersion!==SC012B_STORAGE_VERSION ||
      !bindingValid(p.sourceBinding) || !HEX.test(p.sourceHash) ||
      !HEX.test(p.planContractHash) || p.recordingAllowed!==false ||
      p.noticeRequired!==true || p.questions.length<4 || p.questions.length>6) invalid();
  return hash({
    contract:p.storageContractVersion,source:p.sourceHash,content:p.planContractHash,
  });
}
