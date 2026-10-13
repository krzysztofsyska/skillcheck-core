/**
 * SC-011/012 / MVP FREE + PRESELEKCJA — OFFLINE-only handoff.
 *
 * Values entering this module must be reconstructed from trusted, tenant-scoped
 * locked DB sources, NEVER from client-supplied JSON, NIP or a payment callback.
 * A positive preflight is NOT a right to start a call. The eventual SC-010
 * worker must recheck consent, source freshness, payment, quota and contact
 * validity, then reserve exactly once in PostgreSQL before Retell dispatch.
 * No Retell / Zadarma calls or credential access in this module.
 */
import type { InterviewPlan } from "./interview-plan.ts";
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

/** Pure mapping for SC-011's already-existing VoiceScenario contract.
 * Never take an InterviewPlan directly from a web request. Only the locked,
 * reviewed SC-012 SQL source and immutable versioned template are authoritative.
 * No candidate name, CV text, phone, transcript or PII is interpolated here.
 */
export function voiceScenarioFromApprovedPlan(plan: InterviewPlan): VoiceScenario {
  if (!plan || plan.schemaVersion !== 1 || plan.language !== "pl-PL" ||
      plan.status !== "released" || plan.revision !== 3 ||
      plan.templateVersion !== "skillcheck-voice-plan-v1" ||
      !/^[0-9a-f]{64}$/i.test(plan.sourceFingerprint) ||
      plan.durationMaxSeconds !== 600 || plan.noticeRequired !== true ||
      plan.recordingDefault !== false ||
      typeof plan.releasedAt !== "string" ||
      typeof plan.releasedBy !== "string" ||
      !Array.isArray(plan.questions) ||
      plan.questions.length < 4 || plan.questions.length > 6)
    throw new Error("VOICE_MVP_PLAN_NOT_RELEASED");
  const questions = plan.questions.map(q => {
    if (!q || typeof q.id !== "string" ||
        !/^[a-z0-9][a-z0-9:-]{7,127}$/i.test(q.id) ||
        typeof q.text !== "string" || q.text.trim().length < 1 ||
        q.text.length > 1000 || /[\u0000-\u001f\u007f]/.test(q.text) ||
        !Array.isArray(q.followUps) || q.followUps.length > 2 ||
        !q.followUps.every(s=>typeof s === "string" && s.length > 0 &&
          s.length <= 500 && !/[\u0000-\u001f\u007f]/.test(s)))
      throw new Error("VOICE_MVP_INVALID_QUESTION");
    return Object.freeze({ id:q.id, prompt:q.text, followUps:Object.freeze([...q.followUps]) });
  });
  if (new Set(questions.map(q=>q.id)).size !== questions.length)
    throw new Error("VOICE_MVP_INVALID_QUESTION");
  return Object.freeze({
    schemaVersion:1, language:"pl-PL",
    introductionVersion:"notice-pl-202610",
    questions:Object.freeze(questions),
    constraints:Object.freeze({
      maxSeconds:600,
      prohibitedTopics:Object.freeze([
        "stan zdrowia", "religia", "poglądy polityczne", "życie prywatne",
      ]),
    }),
  });
}
