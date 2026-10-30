/**
 * SC-012-A: deterministic offline interview plan builder.
 * No CV text, phone, PII, provider call, persistence, AI model or authorization.
 * The server caller must authenticate the tenant, approve sources, and verify
 * all source revisions under lock when storing/releasing/dispatching the plan.
 */
import { createHash } from "node:crypto";
import { behaviorGuideDefinitions, buildBehaviorGuide } from "../behavior-guide.ts";
import type { BehaviorAreaKey } from "../position-fields";

export type VoiceEvidenceGap = Readonly<{
  /** Actual approved screening criterion ID, e.g. task:1 / kpi:2 / competency:1. */
  criterionId: string;
  kind: "task" | "kpi" | "competency";
  reason: "missing_evidence" | "contradiction" | "scope_unverified";
}>;
export type InterviewSource = Readonly<{
  companyId: string; applicationId: string;
  positionRevision: string; analysisRevision: string; reviewRevision: string;
  screeningReviewed: true; screeningCurrent: true;
  position: Readonly<{
    title: string; tasks: readonly string[]; kpis: readonly string[];
    requiredBehaviors: readonly string[]; requiredCompetencies: readonly string[];
  }>;
  gaps: readonly VoiceEvidenceGap[];
}>;
export type InterviewQuestion = Readonly<{
  id: string; kind: "common" | "clarification"; criterionId: string;
  criterionKind: "behavior" | "task" | "kpi" | "competency";
  text: string; followUps: readonly string[]; maxSeconds: number;
}>;
export type InterviewPlan = Readonly<{
  schemaVersion: 1; language: "pl-PL"; templateVersion: "skillcheck-voice-plan-v1";
  sourceFingerprint: string; status: "generated" | "reviewed" | "released";
  revision: number; durationTargetSeconds: 420; durationMaxSeconds: 600;
  recordingDefault: false; noticeRequired: true;
  questions: readonly InterviewQuestion[];
  reviewerId: string | null; reviewedAt: string | null;
  releasedBy: string | null; releasedAt: string | null;
}>;

export class InterviewPlanError extends Error {
  readonly code: "VOICE_PLAN_INVALID_SOURCE" | "VOICE_PLAN_STALE_OR_CONFLICT";
  constructor(code: "VOICE_PLAN_INVALID_SOURCE" | "VOICE_PLAN_STALE_OR_CONFLICT") {
    super(code); this.code = code;
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safe = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(x);
const bad = (): never => { throw new InterviewPlanError("VOICE_PLAN_INVALID_SOURCE"); };
const levels: Readonly<Record<string, number>> = Object.freeze({
  Krytyczny: 4, Wysoki: 3, Standardowy: 2, Niski: 1,
});
/** OFFLINE-only capability: cloned objects may never assert human review or release. */
const generatedInProcess = new WeakSet<object>();
const reviewedInProcess = new WeakSet<object>();
const releasedInProcess = new WeakSet<object>();
const commonFollowUp =
  "Jakie działania podjął Pan lub podjęła Pani osobiście i jaki był rezultat?";
const clarificationFollowUps = Object.freeze([
  "W dokumentach informacje dotyczące tego kryterium są niespójne. Jaki był rzeczywisty zakres Pani lub Pana pracy?",
  "Jaki był Pani lub Pana rzeczywisty zakres działania i rezultat?",
] as const);
const gapQuestionText = Object.freeze({
  task: "Proszę opisać konkretne zadanie, które wykonywał Pan lub wykonywała Pani osobiście, i jego rezultat.",
  kpi: "Proszę podać konkretny przykład mierzenia wyniku swojej pracy i działania na podstawie tego miernika.",
  competency: "Proszę opisać, w jakiej sytuacji zawodowej wykorzystał Pan lub wykorzystała Pani konkretną umiejętność i jaki był efekt.",
} as const);
/** Closed SC-012 policy. Callers may not substitute health/religion/politics/private-life wording. */
export const SC012_PROHIBITED_TOPICS = Object.freeze([
  "stan zdrowia", "religia", "poglądy polityczne", "życie prywatne",
] as const);
/** Required static global instruction; keep provider policy tied to the same closed set. */
export const SC012_PROHIBITED_TOPICS_INSTRUCTION =
  "Nie zadawaj pytań ani dopytań dotyczących następujących tematów: " +
  SC012_PROHIBITED_TOPICS.join("; ") + ".";
export const SC012_INTRODUCTION_VERSION = "notice-pl-202610" as const;
const planQuestionKeys = Object.freeze([
  "id", "kind", "criterionId", "criterionKind", "text", "followUps", "maxSeconds",
]);

function exactOwnKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length &&
    actual.every(k => typeof k === "string" && keys.includes(k));
}
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function isClarificationKind(value: InterviewQuestion["criterionKind"]): value is "task" | "kpi" | "competency" {
  return value === "task" || value === "kpi" || value === "competency";
}
/** Server-side brand only. Never copied onto a provider payload. */
export type ReleasedApplicationBinding = Readonly<{
  companyId: string;
  applicationId: string;
  sourceFingerprint: string;
}>;
const applicationBinding = new WeakMap<object, ReleasedApplicationBinding>();
/** Position title from the fingerprinted source; spoken by the provider, never part of the plan DTO. */
const positionTitles = new WeakMap<object, string>();
function bindApplication(plan: object, binding: ReleasedApplicationBinding): void {
  applicationBinding.set(plan, Object.freeze({
    companyId: binding.companyId,
    applicationId: binding.applicationId,
    sourceFingerprint: binding.sourceFingerprint,
  }));
}
function carryApplication(from: object, to: InterviewPlan): void {
  const binding = applicationBinding.get(from);
  if (!binding || binding.sourceFingerprint !== to.sourceFingerprint)
    throw new InterviewPlanError("VOICE_PLAN_STALE_OR_CONFLICT");
  applicationBinding.set(to, binding);
  const title = positionTitles.get(from);
  if (title !== undefined) positionTitles.set(to, title);
}
/** True only for the object returned by releaseInterviewPlan in this process. */
export function isProcessReleasedPlan(plan: unknown): plan is InterviewPlan {
  return typeof plan === "object" && plan !== null && releasedInProcess.has(plan);
}
/** Provenance proof for the OFFLINE compiler only. This is NOT database
 * authorization or permission to contact a person. It cannot survive a
 * server restart; the production worker must re-check source/revision in DB. */
export function isAuthenticallyReleasedInterviewPlan(value: unknown): value is InterviewPlan {
  return !!value && typeof value === "object" &&
    releasedInProcess.has(value) &&
    (value as InterviewPlan).status === "released" &&
    (value as InterviewPlan).revision === 3;
}

/** Application brand for a plan released in this process. Absent on copies. */
export function releasedApplicationBinding(plan: unknown): ReleasedApplicationBinding | undefined {
  if (!isProcessReleasedPlan(plan)) return undefined;
  const binding = applicationBinding.get(plan);
  if (!binding || binding.sourceFingerprint !== plan.sourceFingerprint) return undefined;
  return binding;
}
/** Position title of a plan released in this process (covered by its fingerprint). Absent on copies. */
export function releasedPlanPositionTitle(plan: unknown): string | undefined {
  if (!releasedApplicationBinding(plan)) return undefined;
  return positionTitles.get(plan as object);
}
export function prohibitedTopicsAreCanonical(topics: readonly string[]): boolean {
  return Array.isArray(topics) &&
    topics.length === SC012_PROHIBITED_TOPICS.length &&
    Object.keys(topics).length === topics.length &&
    SC012_PROHIBITED_TOPICS.every((topic, index) => topics[index] === topic);
}
/**
 * Regenerates the expected SC-012 wording from question identity and compares it.
 * Arbitrary CV text, phone numbers or instructions never match this closed set.
 */
export function releasedPlanQuestionsAreControlled(questions: readonly InterviewQuestion[]): boolean {
  if (!Array.isArray(questions) || questions.length < 4 || questions.length > 6 ||
      Object.keys(questions).length !== questions.length) return false;
  const seen = new Set<string>();
  for (let index = 0; index < questions.length; index++) {
    const q = questions[index];
    if (!q || !isPlainObject(q) || !exactOwnKeys(q, planQuestionKeys)) return false;
    if (typeof q.id !== "string" || seen.has(q.id)) return false;
    seen.add(q.id);
    if (!Array.isArray(q.followUps) || q.followUps.length !== 1 ||
        typeof q.followUps[0] !== "string" || Object.keys(q.followUps).length !== 1) return false;
    if (index < 4) {
      const area = behaviorGuideDefinitions.find(item => item.id === q.criterionId);
      if (q.kind !== "common" || q.criterionKind !== "behavior" || !area ||
          q.id !== "common-" + area.id || q.text !== area.questions[0] ||
          q.followUps[0] !== commonFollowUp || q.maxSeconds !== 60) return false;
      continue;
    }
    if (q.kind !== "clarification" || !isClarificationKind(q.criterionKind)) return false;
    const kind: "task" | "kpi" | "competency" = q.criterionKind;
    const criterion = /^(task|kpi|competency):([1-9][0-9]?)$/.exec(q.criterionId);
    if (!criterion || criterion[1] !== kind || Number(criterion[2]) > 30 ||
        q.id !== "clarification-" + q.criterionId.replace(":", "-") ||
        q.text !== gapQuestionText[kind] || q.maxSeconds !== 45 ||
        !clarificationFollowUps.includes(q.followUps[0] as typeof clarificationFollowUps[number]))
      return false;
  }
  return true;
}
/** Same closed templates, checked from the SC-011 projection (id, prompt, followUps). */
export function scenarioQuestionsAreControlled(
  questions: readonly { readonly id: string; readonly prompt: string; readonly followUps: readonly string[] }[],
): boolean {
  if (!Array.isArray(questions) || questions.length < 4 || questions.length > 6 ||
      Object.keys(questions).length !== questions.length) return false;
  const seen = new Set<string>();
  for (let index = 0; index < questions.length; index++) {
    const q = questions[index];
    if (!q || typeof q.id !== "string" || seen.has(q.id)) return false;
    seen.add(q.id);
    if (!Array.isArray(q.followUps) || q.followUps.length !== 1 || typeof q.followUps[0] !== "string")
      return false;
    if (index < 4) {
      const area = behaviorGuideDefinitions.find(item => q.id === "common-" + item.id);
      if (!area || q.prompt !== area.questions[0] || q.followUps[0] !== commonFollowUp) return false;
      continue;
    }
    const matched = /^clarification-(task|kpi|competency)-([1-9][0-9]?)$/.exec(q.id);
    if (!matched || Number(matched[2]) > 30) return false;
    const kind = matched[1] as keyof typeof gapQuestionText;
    if (q.prompt !== gapQuestionText[kind] ||
        !clarificationFollowUps.includes(q.followUps[0] as typeof clarificationFollowUps[number]))
      return false;
  }
  return true;
}
function immutable(plan: InterviewPlan): InterviewPlan {
  const questions = Object.freeze(plan.questions.map(q =>
    Object.freeze({ ...q, followUps: Object.freeze([...q.followUps]) })));
  return Object.freeze({ ...plan, questions });
}

export function buildInterviewPlan(input: InterviewSource): InterviewPlan {
  if (!input || !uuid.test(input.companyId) || !uuid.test(input.applicationId) ||
      !safe(input.positionRevision, 128) || !safe(input.analysisRevision, 128) ||
      !safe(input.reviewRevision, 128) ||
      input.screeningReviewed !== true || input.screeningCurrent !== true) bad();
  const p = input.position;
  if (!p || !safe(p.title, 200) ||
      !Array.isArray(p.tasks) || p.tasks.length < 1 || p.tasks.length > 30 ||
      !p.tasks.every(t => safe(t, 500)) ||
      !Array.isArray(p.kpis) || p.kpis.length < 1 || p.kpis.length > 30 ||
      !p.kpis.every(t => safe(t, 500)) ||
      !Array.isArray(p.requiredCompetencies) || p.requiredCompetencies.length > 30 ||
      !p.requiredCompetencies.every(t => safe(t, 500)) ||
      !Array.isArray(p.requiredBehaviors) || p.requiredBehaviors.length !== 8 ||
      !p.requiredBehaviors.every(t => safe(t, 200)) ||
      !Array.isArray(input.gaps) || input.gaps.length > 2) bad();

  const guide = buildBehaviorGuide(p.requiredBehaviors);
  if (guide.unrecognizedRequirements.length ||
      guide.areas.some(area => area.requirementIssue || !area.requiredLevel)) bad();
  // Preserve the exact criterion namespaces produced by prepareScreening:
  // task:1, kpi:1, competency:1. No raw text is interpolated into questions.
  const gapIds = new Set<string>();
  for (const gap of input.gaps) {
    if (!gap || typeof gap.criterionId !== "string" ||
        !["task", "kpi", "competency"].includes(gap.kind) ||
        !["missing_evidence", "contradiction", "scope_unverified"].includes(gap.reason)) bad();
    const matched = /^(task|kpi|competency):([1-9][0-9]?)$/.exec(gap.criterionId);
    const length = gap.kind === "task" ? p.tasks.length :
      gap.kind === "kpi" ? p.kpis.length : p.requiredCompetencies.length;
    if (!matched || matched[1] !== gap.kind || Number(matched[2]) > length ||
        gapIds.has(gap.criterionId)) bad();
    gapIds.add(gap.criterionId);
  }
  const priority = [...guide.areas].sort((a, b) =>
    levels[b.requiredLevel!] - levels[a.requiredLevel!] ||
    guide.areas.indexOf(a) - guide.areas.indexOf(b));
  const common: InterviewQuestion[] = priority.slice(0, 4).map(area => ({
    id: "common-" + area.id, kind: "common", criterionId: area.id,
    criterionKind: "behavior",
    text: area.questions[0],
    followUps: [commonFollowUp],
    maxSeconds: 60,
  }));
  // Do not quote arbitrary CV, user notes, model responses or candidate data
  // in a provider prompt; only controlled criterion IDs can select a template.
  const clarifications: InterviewQuestion[] = input.gaps.map(gap => ({
    id: "clarification-" + gap.criterionId.replace(":", "-"),
    kind: "clarification", criterionId: gap.criterionId, criterionKind: gap.kind,
    text: gapQuestionText[gap.kind],
    followUps: [
      gap.reason === "contradiction" ? clarificationFollowUps[0] : clarificationFollowUps[1],
    ],
    maxSeconds: 45,
  }));
  // Fixed-order projection prevents false stale results when mappers reorder keys.
  const sourceFingerprint = createHash("sha256").update(JSON.stringify({
    companyId: input.companyId, applicationId: input.applicationId,
    positionRevision: input.positionRevision, analysisRevision: input.analysisRevision,
    reviewRevision: input.reviewRevision,
    position: {
      title: p.title, tasks: [...p.tasks], kpis: [...p.kpis],
      requiredBehaviors: [...p.requiredBehaviors],
      requiredCompetencies: [...p.requiredCompetencies],
    },
    gaps: input.gaps.map(g => ({ criterionId: g.criterionId, kind: g.kind, reason: g.reason })),
  })).digest("hex");
  const generated = immutable({
    schemaVersion: 1, language: "pl-PL", templateVersion: "skillcheck-voice-plan-v1",
    sourceFingerprint, status: "generated", revision: 1,
    durationTargetSeconds: 420, durationMaxSeconds: 600,
    recordingDefault: false, noticeRequired: true,
    questions: [...common, ...clarifications],
    reviewerId: null, reviewedAt: null, releasedBy: null, releasedAt: null,
  });
  generatedInProcess.add(generated);
  bindApplication(generated, {
    companyId: input.companyId,
    applicationId: input.applicationId,
    sourceFingerprint,
  });
  positionTitles.set(generated, p.title);
  return generated;
}

/** Domain transition only: NOT a DB authorization or approval of contact. */
export function reviewInterviewPlan(
  plan: InterviewPlan,
  input: Readonly<{ expectedRevision: 1; expectedSourceFingerprint: string; reviewerId: string; reviewedAt: string }>,
): InterviewPlan {
  if (!generatedInProcess.has(plan) || plan.status !== "generated" ||
      plan.revision !== input.expectedRevision ||
      plan.sourceFingerprint !== input.expectedSourceFingerprint || !uuid.test(input.reviewerId) ||
      !Number.isFinite(Date.parse(input.reviewedAt)) || new Date(input.reviewedAt).toISOString() !== input.reviewedAt)
    throw new InterviewPlanError("VOICE_PLAN_STALE_OR_CONFLICT");
  const reviewed = immutable({ ...plan, status: "reviewed", revision: 2,
    reviewerId: input.reviewerId, reviewedAt: input.reviewedAt });
  carryApplication(plan, reviewed);
  generatedInProcess.delete(plan);
  reviewedInProcess.add(reviewed);
  return reviewed;
}

/** Release remains OFFLINE; SC-010-C and authorized worker still required to dial. */
export function releaseInterviewPlan(
  plan: InterviewPlan,
  input: Readonly<{ expectedRevision: 2; expectedSourceFingerprint: string; releasedBy: string; releasedAt: string }>,
): InterviewPlan {
  if (plan.status !== "reviewed" || plan.revision !== input.expectedRevision ||
      !reviewedInProcess.has(plan) ||
      plan.sourceFingerprint !== input.expectedSourceFingerprint ||
      !uuid.test(plan.reviewerId ?? "") || typeof plan.reviewedAt !== "string" ||
      !Number.isFinite(Date.parse(plan.reviewedAt)) ||
      new Date(plan.reviewedAt).toISOString() !== plan.reviewedAt ||
      !uuid.test(input.releasedBy) || typeof input.releasedAt !== "string" ||
      !Number.isFinite(Date.parse(input.releasedAt)) ||
      new Date(input.releasedAt).toISOString() !== input.releasedAt ||
      Date.parse(input.releasedAt) < Date.parse(plan.reviewedAt))
    throw new InterviewPlanError("VOICE_PLAN_STALE_OR_CONFLICT");
  const released = immutable({ ...plan, status: "released", revision: 3,
    releasedBy: input.releasedBy, releasedAt: input.releasedAt });
  carryApplication(plan, released);
  reviewedInProcess.delete(plan);
  releasedInProcess.add(released);
  return released;
}
