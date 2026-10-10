/**
 * SC-012-B B1: strict, offline domain contract for persistable voice-plan snapshots.
 * Does not write to Supabase. No caller-supplied booleans or IDs grant authority.
 * Future RPC must derive tenant/actor/source from authenticated DB session.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildInterviewPlan, type InterviewSource } from "./interview-plan.ts";
import { behaviorGuideDefinitions } from "../behavior-guide.ts";

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
  planSourceFingerprint: string;
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
  expectedReviewVersion: number; decision: PlanReviewDecision; reason: string | null; requestKey: string;
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
  typeof x === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x));
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o,k);
/** Accept only ordinary JSON-shaped data; no accessors/proxies or extra keys. */
function cleanClone<T>(value: T): T {
  try {
    const clone = structuredClone(value);
    if (JSON.stringify(clone).length > 250000) invalid();
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
function sourceDigest(binding: VoicePlanSourceBinding, planSourceFingerprint: string): string {
  return hash({
    companyId:binding.companyId,recruitmentId:binding.recruitmentId,
    applicationId:binding.applicationId,positionId:binding.positionId,
    analysisId:binding.analysisId,reviewId:binding.reviewId,
    shortlistEntryId:binding.shortlistEntryId,
    applicationUpdatedAt:binding.applicationUpdatedAt,
    recruitmentUpdatedAt:binding.recruitmentUpdatedAt,
    positionUpdatedAt:binding.positionUpdatedAt,
    analysisFingerprint:binding.analysisFingerprint,
    screeningContractHash:binding.screeningContractHash,
    planSourceFingerprint,
  });
}
const commonFollowUp="Jakie działania podjął Pan lub podjęła Pani osobiście i jaki był rezultat?";
const clarificationFollowUps=[
  "W dokumentach informacje dotyczące tego kryterium są niespójne. Jaki był rzeczywisty zakres Pani lub Pana pracy?",
  "Jaki był Pani lub Pana rzeczywisty zakres działania i rezultat?",
] as const;
const clarificationTexts={
  task:"Proszę opisać konkretne zadanie, które wykonywał Pan lub wykonywała Pani osobiście, i jego rezultat.",
  kpi:"Proszę podać konkretny przykład mierzenia wyniku swojej pracy i działania na podstawie tego miernika.",
  competency:"Proszę opisać, w jakiej sytuacji zawodowej wykorzystał Pan lub wykorzystała Pani konkretną umiejętność i jaki był efekt.",
} as const;
function controlledQuestion(q: unknown, index: number): boolean {
  if (!exactFields(q,["id","kind","criterionId","criterionKind","text","followUps","maxSeconds"])) return false;
  const v=q as Record<string,unknown>;
  if (typeof v.id!=="string" || typeof v.criterionId!=="string" || typeof v.text!=="string" ||
      !Array.isArray(v.followUps) || v.followUps.length!==1 || typeof v.followUps[0]!=="string") return false;
  if (index<4) {
    const area=behaviorGuideDefinitions.find(x=>x.id===v.criterionId);
    return v.kind==="common" && v.criterionKind==="behavior" && !!area &&
      v.id==="common-"+area.id && v.text===area.questions[0] &&
      v.followUps[0]===commonFollowUp && v.maxSeconds===60;
  }
  if (v.kind!=="clarification" ||
      !["task","kpi","competency"].includes(String(v.criterionKind))) return false;
  const kind=v.criterionKind as keyof typeof clarificationTexts;
  const criterion=/^(task|kpi|competency):([1-9][0-9]?)$/.exec(v.criterionId);
  return !!criterion && criterion[1]===kind && Number(criterion[2])<=30 &&
    v.id==="clarification-"+v.criterionId.replace(":","-") &&
    v.text===clarificationTexts[kind] && v.maxSeconds===45 &&
    clarificationFollowUps.includes(v.followUps[0] as typeof clarificationFollowUps[number]);
}

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
  const sourceHash=sourceDigest(binding,plan.sourceFingerprint);
  return Object.freeze({
    schemaVersion:1,storageContractVersion:SC012B_STORAGE_VERSION,
    sourceBinding:Object.freeze({...binding}),
    sourceHash,planSourceFingerprint:plan.sourceFingerprint,
    planContractHash:hash({plan:plan.templateVersion,questions}),
    templateVersion:"skillcheck-voice-plan-v1",language:"pl-PL",
    targetSeconds:420,maximumSeconds:600,recordingAllowed:false,noticeRequired:true,
    questions:Object.freeze(questions),
  });
}

export function validatePlanReviewCommand(raw: PlanReviewRequest): PlanReviewRequest {
  const x=cleanClone(raw);
  if (!exactFields(x,["planId","expectedPlanVersion","expectedSourceHash",
      "expectedReviewVersion","decision","reason","requestKey"]) ||
      !isId(x.planId) || !isId(x.requestKey) || typeof x.expectedSourceHash !== "string" || !HEX.test(x.expectedSourceHash) ||
      !Number.isSafeInteger(x.expectedPlanVersion) || x.expectedPlanVersion<1 ||
      !Number.isSafeInteger(x.expectedReviewVersion) || x.expectedReviewVersion<0 ||
      !["approved","requires_changes"].includes(x.decision) ||
      !(x.reason===null || (typeof x.reason==="string" && x.reason.length<=1000 && x.reason.trim().length>0)) ||
      (x.decision==="requires_changes" && x.reason===null)) invalid();
  return Object.freeze(x);
}
export function validatePlanReleaseCommand(raw: PlanReleaseRequest): PlanReleaseRequest {
  const x=cleanClone(raw);
  if (!exactFields(x,["planId","expectedPlanVersion","expectedSourceHash",
      "approvedReviewId","expectedReviewVersion","requestKey"]) ||
      !isId(x.planId) || !isId(x.approvedReviewId) || !isId(x.requestKey) ||
      typeof x.expectedSourceHash !== "string" || !HEX.test(x.expectedSourceHash) || !Number.isSafeInteger(x.expectedPlanVersion) ||
      x.expectedPlanVersion<1 || !Number.isSafeInteger(x.expectedReviewVersion) ||
      x.expectedReviewVersion<1) invalid();
  return Object.freeze(x);
}
export function planWriteFingerprint(
  raw: VoicePlanWriteSnapshot,
  trustedSource: InterviewSource,
  trustedBinding: VoicePlanSourceBinding,
): string {
  const p=cleanClone(raw);
  if (!exactFields(p,["schemaVersion","storageContractVersion","sourceBinding","sourceHash",
      "planSourceFingerprint","planContractHash","templateVersion","language","targetSeconds",
      "maximumSeconds","recordingAllowed","noticeRequired","questions"]) ||
      p.schemaVersion!==1 || p.storageContractVersion!==SC012B_STORAGE_VERSION ||
      !bindingValid(p.sourceBinding) ||
      typeof p.sourceHash!=="string" || !HEX.test(p.sourceHash) ||
      typeof p.planSourceFingerprint!=="string" || !HEX.test(p.planSourceFingerprint) ||
      typeof p.planContractHash!=="string" || !HEX.test(p.planContractHash) ||
      p.recordingAllowed!==false || p.noticeRequired!==true ||
      p.templateVersion!=="skillcheck-voice-plan-v1" || p.language!=="pl-PL" ||
      p.targetSeconds!==420 || p.maximumSeconds!==600 ||
      !Array.isArray(p.questions) || p.questions.length<4 || p.questions.length>6 ||
      !p.questions.every((q,i)=>controlledQuestion(q,i))) invalid();
  if (new Set(p.questions.map(q=>q.id)).size!==p.questions.length) invalid();
  if (sourceDigest(p.sourceBinding,p.planSourceFingerprint)!==p.sourceHash) invalid();
  // Content hashes are unkeyed and cannot independently grant source authority.
  // The calling server must re-fetch and authorize these sources from tenant DB,
  // NOT pass browser-supplied trustedSource or trustedBinding.
  if (!trustedSource || !trustedBinding) invalid();
  const expected=createVoicePlanWriteSnapshot(trustedSource,trustedBinding);
  // JSONB and object mappers can reorder keys: compare structure, not insertion order.
  // Use the regenerated trusted canonical envelope for hashing.
  if (!isDeepStrictEqual(p,expected)) invalid();
  const recomputedContractHash=expected.planContractHash;
  if (recomputedContractHash!==p.planContractHash) invalid();
  return hash({
    contract:p.storageContractVersion,source:p.sourceHash,content:recomputedContractHash,
  });
}
