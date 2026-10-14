/**
 * SC-011/012 / MVP FREE + PRESELEKCJA — OFFLINE-only handoff.
 *
 * Values entering this module must be reconstructed from trusted, tenant-scoped
 * locked DB sources, NEVER from client-supplied JSON, NIP or a payment callback.
 * A positive preflight is NOT a right to start a call. The eventual SC-010
 * worker must recheck consent, source freshness, payment, quota and contact
 * validity, then reserve exactly once in PostgreSQL before Retell dispatch.
 * No Retell / VoIPstudio-GoTrunk calls or credential access in this module.
 */
import {
  isProcessReleasedPlan, releasedPlanQuestionsAreControlled,
  SC012_INTRODUCTION_VERSION, SC012_PROHIBITED_TOPICS, type InterviewPlan,
} from "./interview-plan.ts";
import type { VoiceScenario } from "./provider.ts";

export type VoiceMvpPackage = "FREE" | "PRESELEKCJA";
export type VoiceMvpSnapshot = Readonly<{
  plan: VoiceMvpPackage;
  companyVerified: boolean;
  freeTrialApproved: boolean;
  paidSettlementVerified: boolean;
  planActive: boolean;
  screeningReviewedAndCurrent: boolean;
  planReleasedAndCurrent: boolean;
  candidateContactApproved: boolean;
  candidateNoticeDelivered: boolean;
  providerEnabled: boolean;
  limit: Readonly<{ total: number; used: number; reserved: number }>;
}>;
export type VoiceMvpPreflight =
  | Readonly<{ state: "prepared_for_trusted_dispatch"; package: VoiceMvpPackage; maxSeconds: 600 }>
  | Readonly<{ state: "blocked"; reason:
    "invalid_snapshot" | "company_unverified" | "package_not_active" |
    "trial_not_approved" | "payment_not_verified" | "screening_or_plan_not_ready" |
    "contact_not_authorized" | "provider_not_enabled" | "quota_exhausted"
  }>;

const flags = Object.freeze([
  "companyVerified", "freeTrialApproved", "paidSettlementVerified", "planActive",
  "screeningReviewedAndCurrent", "planReleasedAndCurrent",
  "candidateContactApproved", "candidateNoticeDelivered", "providerEnabled",
]);
const obj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;
const keys = (x: Record<string, unknown>, expected: readonly string[]) =>
  Reflect.ownKeys(x).length === expected.length &&
  Reflect.ownKeys(x).every(k => typeof k === "string" && expected.includes(k));
const nonnegative = (x: unknown): x is number =>
  Number.isSafeInteger(x) && Number(x) >= 0;
const blocked = (reason: Extract<VoiceMvpPreflight, {state:"blocked"}>["reason"]): VoiceMvpPreflight =>
  Object.freeze({ state:"blocked", reason });

/** Computes *only* product/readiness policy, never authorizes paid telephony. */
export function evaluateVoiceMvpPreflight(input: unknown): VoiceMvpPreflight {
  // structuredClone detaches getters and blocks Proxy/custom iterators. Reject
  // unknown keys (including phone, CV, price and untrusted candidate data).
  let snapshot: unknown;
  try { snapshot = structuredClone(input); } catch { return blocked("invalid_snapshot"); }
  if (!obj(snapshot) || !keys(snapshot, ["plan", "limit", ...flags]) ||
      (snapshot.plan !== "FREE" && snapshot.plan !== "PRESELEKCJA") ||
      !flags.every(name => typeof snapshot[name] === "boolean") ||
      !obj(snapshot.limit) || !keys(snapshot.limit, ["total", "used", "reserved"]) ||
      !nonnegative(snapshot.limit.total) || !nonnegative(snapshot.limit.used) ||
      !nonnegative(snapshot.limit.reserved) ||
      snapshot.limit.total < 1 ||
      snapshot.limit.used > snapshot.limit.total ||
      snapshot.limit.reserved > snapshot.limit.total) return blocked("invalid_snapshot");

  const p = snapshot as unknown as VoiceMvpSnapshot;
  // FREE is one approved trial interview. A larger configured total is a
  // misconfiguration, not extra quota that can be dispatched.
  if (p.plan === "FREE" && p.limit.total !== 1) return blocked("invalid_snapshot");
  if (!p.companyVerified) return blocked("company_unverified");
  if (!p.planActive) return blocked("package_not_active");
  if (p.plan === "FREE" && !p.freeTrialApproved) return blocked("trial_not_approved");
  if (p.plan === "PRESELEKCJA" && !p.paidSettlementVerified) return blocked("payment_not_verified");
  if (!p.screeningReviewedAndCurrent || !p.planReleasedAndCurrent)
    return blocked("screening_or_plan_not_ready");
  if (!p.candidateContactApproved || !p.candidateNoticeDelivered)
    return blocked("contact_not_authorized");
  if (!p.providerEnabled) return blocked("provider_not_enabled");
  if (p.limit.used + p.limit.reserved >= p.limit.total)
    return blocked("quota_exhausted");
  // This state cannot be passed to the provider: caller-side preflight is
  // informational. The eventual worker must atomically reserve a DB credit.
  return Object.freeze({ state:"prepared_for_trusted_dispatch", package:p.plan, maxSeconds:600 });
}

const planKeys = Object.freeze([
  "schemaVersion", "language", "templateVersion", "sourceFingerprint", "status", "revision",
  "durationTargetSeconds", "durationMaxSeconds", "recordingDefault", "noticeRequired",
  "questions", "reviewerId", "reviewedAt", "releasedBy", "releasedAt",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Pure mapping for SC-011's already-existing VoiceScenario contract.
 * Accepts only the object returned by releaseInterviewPlan in this process.
 * A persisted or hand-built DTO that merely claims status "released" is rejected.
 * Question text must still match the canonical SC-012 templates; supplied wording
 * is never interpolated. No candidate name, CV, phone or transcript is copied.
 */
export function voiceScenarioFromApprovedPlan(plan: InterviewPlan): VoiceScenario {
  if (!isProcessReleasedPlan(plan)) throw new Error("VOICE_MVP_PLAN_NOT_RELEASED");
  let snapshot: InterviewPlan;
  try { snapshot = structuredClone(plan); } catch { throw new Error("VOICE_MVP_PLAN_NOT_RELEASED"); }
  const own = Reflect.ownKeys(snapshot);
  if (own.length !== planKeys.length || !planKeys.every(key => own.includes(key)) ||
      snapshot.schemaVersion !== 1 || snapshot.language !== "pl-PL" ||
      snapshot.status !== "released" || snapshot.revision !== 3 ||
      snapshot.templateVersion !== "skillcheck-voice-plan-v1" ||
      snapshot.durationTargetSeconds !== 420 || snapshot.durationMaxSeconds !== 600 ||
      snapshot.noticeRequired !== true || snapshot.recordingDefault !== false ||
      !/^[0-9a-f]{64}$/i.test(snapshot.sourceFingerprint) ||
      !uuid.test(snapshot.reviewerId ?? "") || !isoInstant(snapshot.reviewedAt) ||
      !uuid.test(snapshot.releasedBy ?? "") || !isoInstant(snapshot.releasedAt) ||
      Date.parse(snapshot.releasedAt) < Date.parse(snapshot.reviewedAt))
    throw new Error("VOICE_MVP_PLAN_NOT_RELEASED");
  if (!releasedPlanQuestionsAreControlled(snapshot.questions))
    throw new Error("VOICE_MVP_INVALID_QUESTION");
  const questions = snapshot.questions.map(q => Object.freeze({
    id: q.id, prompt: q.text, followUps: Object.freeze([...q.followUps]),
  }));
  return Object.freeze({
    schemaVersion: 1, language: "pl-PL",
    introductionVersion: SC012_INTRODUCTION_VERSION,
    questions: Object.freeze(questions),
    constraints: Object.freeze({
      maxSeconds: 600,
      prohibitedTopics: Object.freeze([...SC012_PROHIBITED_TOPICS]),
    }),
  });
}
