/**
 * ROADMAP R6-1d: read-only preview of the interview plan for ONE shortlisted
 * candidate, shown to the recruiter behind a server-side flag.
 *
 * - The flag is OFF unless VOICE_PLAN_PREVIEW=true, and never on in a Vercel
 *   Production deployment (VERCEL_ENV=production) or a plain `next start`.
 * - Nothing is written, released or sent: the plan tables do not exist in
 *   supabase/migrations yet (R6-1c), so the panel is rendered with
 *   backendReady=false and every approval control stays disabled.
 * - Only fixed template questions and criterion IDs reach the browser: no CV
 *   text, candidate name, contact data, tenant or reviewer IDs.
 */
import type { Position, ScreeningRating } from "../supabase/database.types";
import type { VoicePlanApprovalView } from "../../components/voice/VoicePlanApprovalPanel";
import { buildInterviewPlan } from "./interview-plan.ts";
import { selectReviewedScreeningGaps } from "./screening-gap-selection.ts";
import { screeningStatus } from "../screening-ui.ts";

type Env = Readonly<Record<string, string | undefined>>;

export function voicePlanPreviewEnabled(env: Env = process.env): boolean {
  if (env.VOICE_PLAN_PREVIEW !== "true") return false;
  if (env.VERCEL_ENV === "production") return false;
  return env.VERCEL_ENV === "preview" || (!env.VERCEL_ENV && env.NODE_ENV === "development");
}

export type VoicePlanPreviewSource = Readonly<{
  companyId: string;
  applicationId: string;
  position: Pick<Position, "title" | "tasks" | "kpis" | "required_behaviors" | "required_competencies" | "updated_at">;
  entry: Readonly<{ application_id: string; analysis_id: string; review_id: string; removed_at: string | null }> | null;
  analysis: Readonly<{
    id: string; application_id: string; execution_status: string; input_fingerprint: string;
    stale_at: string | null; latest_review_version: number; criteria_snapshot: unknown;
  }> | null;
  review: Readonly<{ id: string; analysis_id: string; review_version: number; disposition: string }> | null;
  results: readonly Readonly<{ id: string; analysis_id: string; criterion_id: string; rating: ScreeningRating }>[];
  overrides: readonly Readonly<{ review_id: string; criterion_result_id: string; rating_override: ScreeningRating | null }>[];
  /** Fingerprint of the current CV + requirements; undefined when it cannot be computed. */
  fingerprint: string | undefined;
}>;

export type VoicePlanPreviewState =
  | "not_shortlisted" | "no_analysis" | "awaiting_review" | "outdated" | "unavailable";
export type VoicePlanPreview =
  | Readonly<{ state: "ready"; plan: VoicePlanApprovalView }>
  | Readonly<{ state: VoicePlanPreviewState }>;

export const voicePlanPreviewStateLabels: Record<VoicePlanPreviewState, string> = {
  not_shortlisted: "Scenariusz przygotowujemy tylko dla osoby z krótkiej listy tej rekrutacji.",
  no_analysis: "Brak ukończonej analizy CV. Scenariusz pojawi się po analizie i jej zatwierdzeniu.",
  awaiting_review: "Analiza CV czeka na sprawdzenie i zatwierdzenie przez rekrutera.",
  outdated: "Analiza CV jest nieaktualna albo nowsza niż wpis na krótkiej liście. Sprawdź analizę i krótką listę ponownie.",
  unavailable: "Nie udało się przygotować spójnego scenariusza z tych danych. Odśwież stronę.",
};

const state = (value: VoicePlanPreviewState): VoicePlanPreview => ({ state: value });

/** Pure gate + builder. Same gate as the individual questions (rule R1). */
export function buildVoicePlanPreview(src: VoicePlanPreviewSource): VoicePlanPreview {
  const { entry, analysis, review } = src;
  if (!entry || entry.removed_at !== null || entry.application_id !== src.applicationId) return state("not_shortlisted");
  if (!analysis || analysis.execution_status !== "completed") return state("no_analysis");
  if (analysis.application_id !== src.applicationId) return state("unavailable");
  if (screeningStatus({ ...analysis, execution_status: "completed" }, src.fingerprint) === "stale") return state("outdated");
  if (review?.disposition === "needs_reanalysis") return state("outdated");
  if (!review || review.review_version !== analysis.latest_review_version ||
      !["approved", "approved_with_changes"].includes(review.disposition)) return state("awaiting_review");
  if (review.analysis_id !== analysis.id) return state("unavailable");
  if (entry.analysis_id !== analysis.id || entry.review_id !== review.id) return state("outdated");
  if (src.results.some(row => row.analysis_id !== analysis.id) ||
      src.overrides.some(row => row.review_id !== review.id)) return state("unavailable");
  try {
    const snapshot = analysis.criteria_snapshot;
    if (!Array.isArray(snapshot)) return state("unavailable");
    const criteria = snapshot.map((c: { id?: unknown; kind?: unknown }) => ({ id: c?.id, kind: c?.kind })) as
      { id: string; kind: "task" | "kpi" | "competency" }[];
    const criterionOf = new Map(src.results.map(row => [row.id, row.criterion_id]));
    const overrides = src.overrides.map(row => {
      const criterionId = criterionOf.get(row.criterion_result_id);
      if (!criterionId) throw new Error("override without result");
      return { criterionId, rating: row.rating_override };
    });
    const gaps = selectReviewedScreeningGaps({
      latestHumanDecision: review.disposition as "approved" | "approved_with_changes",
      analysisCompleted: true, analysisCurrent: true, shortlistCurrent: true,
      criteria, results: src.results.map(row => ({ criterionId: row.criterion_id, rating: row.rating })), overrides,
    }, criteria);
    const p = src.position;
    const plan = buildInterviewPlan({
      companyId: src.companyId, applicationId: src.applicationId,
      positionRevision: p.updated_at, analysisRevision: analysis.id,
      reviewRevision: review.id + ":" + review.review_version,
      screeningReviewed: true, screeningCurrent: true,
      position: {
        title: p.title, tasks: p.tasks, kpis: p.kpis,
        requiredBehaviors: p.required_behaviors, requiredCompetencies: p.required_competencies,
      },
      gaps,
    });
    return {
      state: "ready",
      plan: {
        // Display key only; not a stored plan ID.
        id: "preview-" + plan.sourceFingerprint.slice(0, 32),
        status: "generated", planVersion: plan.revision, sourceHash: plan.sourceFingerprint,
        sourceCurrent: true, reviewIsApproved: false, reviewerLabel: null, reviewedAt: null,
        questions: plan.questions.map(q => ({
          id: q.id, kind: q.kind, criterionId: q.criterionId, criterionKind: q.criterionKind,
          text: q.text, followUps: [...q.followUps],
        })),
      },
    };
  } catch {
    return state("unavailable");
  }
}
