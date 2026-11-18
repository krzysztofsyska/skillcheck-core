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
 * - Gaps come from the Step 3 evidence matrix (v2 rows) with the recruiter's
 *   row corrections, via lib/interview-gaps.ts. The legacy `rating` column is
 *   always `insufficient_data` on v2 rows and is never read here.
 */
import type { Position, ScreeningRating } from "../supabase/database.types";
import { buildInterviewGaps, type InterviewGapRow } from "../interview-gaps.ts";
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
  /** Evidence-matrix rows: verdict columns only, no CV-derived text. */
  results: readonly VoicePlanCriterionRow[];
  /** Legacy (v1) rating corrections. A v2 review never has any; present means fail closed. */
  overrides: readonly Readonly<{ review_id: string; criterion_result_id: string; rating_override: ScreeningRating | null }>[];
  /** Fingerprint of the current CV + requirements; undefined when it cannot be computed. */
  fingerprint: string | undefined;
}>;

export type VoicePlanCriterionRow = Readonly<Pick<InterviewGapRow,
  "id" | "criterion_id" | "criterion_kind" | "criterion_order" | "verdict" | "human_status" | "human_verdict">
  & { analysis_id: string }>;

/** Columns the page reads for the preview; text columns are deliberately left out. */
export const voicePlanCriterionColumns =
  "id,analysis_id,criterion_id,criterion_kind,criterion_order,verdict,human_status,human_verdict";

const verdicts = ["supported", "partial", "missing", "contradicted"];
const humanStatuses = ["unreviewed", "accepted", "rejected", "edited"];

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
  if (src.results.some(row => row?.analysis_id !== analysis.id) ||
      src.overrides.some(row => row?.review_id !== review.id)) return state("unavailable");
  // v2 evidence matrix only: legacy rows without a verdict cannot say what is
  // missing (their rating is not reviewed evidence), so ask for a re-analysis.
  if (src.results.length === 0 || src.results.some(row => row?.verdict == null)) return state("outdated");
  // A v2 approval is a plain "approved" with every row reviewed and no
  // legacy override rows (enforced by the review RPC); anything else fails closed.
  if (review.disposition !== "approved" || src.overrides.length !== 0) return state("unavailable");
  if (src.results.some(row => row.human_status === "unreviewed")) return state("awaiting_review");
  if (src.results.some(row => !verdicts.includes(row.verdict as string) ||
      !humanStatuses.includes(row.human_status) ||
      !(row.human_verdict == null || verdicts.includes(row.human_verdict)) ||
      (row.human_status === "edited" && row.human_verdict == null) ||
      typeof row.criterion_id !== "string" || row.criterion_id.split(":")[0] !== row.criterion_kind)) return state("unavailable");
  try {
    const snapshot = analysis.criteria_snapshot;
    if (!Array.isArray(snapshot)) return state("unavailable");
    const criteria = snapshot.map((c: { id?: unknown; kind?: unknown }) => ({ id: c?.id, kind: c?.kind })) as
      { id: string; kind: "task" | "kpi" | "competency" }[];
    // Same verdict logic as the interview page: recruiter corrections win,
    // a rejected row stays open, only partial/missing/contradicted are gaps.
    const matrix = buildInterviewGaps(src.results.map(row => ({
      id: row.id, criterion_id: row.criterion_id, criterion_kind: row.criterion_kind,
      criterion_order: row.criterion_order, verdict: row.verdict, human_status: row.human_status,
      human_verdict: row.human_verdict, criterion_text_snapshot: "", missing_info: null,
      suggested_question: null, human_missing_info: null, human_suggested_question: null,
    })));
    if (matrix.total !== src.results.length) return state("unavailable");
    const criterionOf = new Map(src.results.map(row => [row.id, row]));
    if (criterionOf.size !== src.results.length) return state("unavailable");
    const gapOf = new Map(matrix.gaps.map(gap => {
      const row = criterionOf.get(gap.id);
      if (!row || row.criterion_kind !== gap.kind) throw new Error("gap without row");
      return [row.criterion_id, gap] as const;
    }));
    // selectReviewedScreeningGaps validates the rows against the approved
    // criteria snapshot and picks at most two; it only sees gap / no gap.
    const selected = selectReviewedScreeningGaps({
      latestHumanDecision: "approved",
      analysisCompleted: true, analysisCurrent: true, shortlistCurrent: true,
      criteria,
      results: src.results.map(row => ({
        criterionId: row.criterion_id, rating: gapOf.has(row.criterion_id) ? "insufficient_data" : "meets",
      })),
      overrides: [],
    }, criteria);
    const gaps = selected.map(gap => Object.freeze({
      ...gap, reason: gapOf.get(gap.criterionId)?.verdict === "contradicted" ? "contradiction" as const : "missing_evidence" as const,
    }));
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
