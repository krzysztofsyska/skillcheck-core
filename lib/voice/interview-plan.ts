/**
 * SC-012-A: deterministic offline interview plan builder.
 * No CV text, phone, PII, provider call, persistence, AI model or authorization.
 * The server caller must authenticate the tenant, approve sources, and verify
 * all source revisions under lock when storing/releasing/dispatching the plan.
 */
import { createHash } from "node:crypto";
import { buildBehaviorGuide } from "../behavior-guide.ts";
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
/** OFFLINE-only capability: cloned objects may never assert human review. */
const reviewedInProcess = new WeakSet<object>();
const gapQuestionText = Object.freeze({
  task: "Proszę opisać konkretne zadanie, które wykonywał Pan lub wykonywała Pani osobiście, i jego rezultat.",
  kpi: "Proszę podać konkretny przykład mierzenia wyniku swojej pracy i działania na podstawie tego miernika.",
  competency: "Proszę opisać, w jakiej sytuacji zawodowej wykorzystał Pan lub wykorzystała Pani konkretną umiejętność i jaki był efekt.",
} as const);
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
    followUps: ["Jakie działania podjął Pan lub podjęła Pani osobiście i jaki był rezultat?"],
    maxSeconds: 60,
  }));
  // Do not quote arbitrary CV, user notes, model responses or candidate data
  // in a provider prompt; only controlled criterion IDs can select a template.
  const clarifications: InterviewQuestion[] = input.gaps.map(gap => ({
    id: "clarification-" + gap.criterionId.replace(":", "-"),
    kind: "clarification", criterionId: gap.criterionId, criterionKind: gap.kind,
    text: gapQuestionText[gap.kind],
    followUps: [
      gap.reason === "contradiction"
        ? "W dokumentach informacje dotyczące tego kryterium są niespójne. Jaki był rzeczywisty zakres Pani lub Pana pracy?"
        : "Jaki był Pani lub Pana rzeczywisty zakres działania i rezultat?",
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
  return immutable({
    schemaVersion: 1, language: "pl-PL", templateVersion: "skillcheck-voice-plan-v1",
    sourceFingerprint, status: "generated", revision: 1,
    durationTargetSeconds: 420, durationMaxSeconds: 600,
    recordingDefault: false, noticeRequired: true,
    questions: [...common, ...clarifications],
    reviewerId: null, reviewedAt: null, releasedBy: null, releasedAt: null,
  });
}

/** Domain transition only: NOT a DB authorization or approval of contact. */
export function reviewInterviewPlan(
  plan: InterviewPlan,
  input: Readonly<{ expectedRevision: 1; expectedSourceFingerprint: string; reviewerId: string; reviewedAt: string }>,
): InterviewPlan {
  if (plan.status !== "generated" || plan.revision !== input.expectedRevision ||
      plan.sourceFingerprint !== input.expectedSourceFingerprint || !uuid.test(input.reviewerId) ||
      !Number.isFinite(Date.parse(input.reviewedAt)) || new Date(input.reviewedAt).toISOString() !== input.reviewedAt)
    throw new InterviewPlanError("VOICE_PLAN_STALE_OR_CONFLICT");
  const reviewed = immutable({ ...plan, status: "reviewed", revision: 2,
    reviewerId: input.reviewerId, reviewedAt: input.reviewedAt });
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
  return immutable({ ...plan, status: "released", revision: 3,
    releasedBy: input.releasedBy, releasedAt: input.releasedAt });
}
