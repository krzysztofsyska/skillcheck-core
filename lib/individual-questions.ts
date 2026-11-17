// ROADMAP R1 / SC-014-C6, step "pytania indywidualne z luk w CV kandydata".
//
// Read-only: for each candidate on the recruitment shortlist, list a few
// individual follow-up questions taken from the gaps of that candidate's CV
// analysis (lib/interview-gaps.ts). Nothing here is sent to a candidate, no
// model is called and nothing is written. The questions are never folded into
// the shared, comparable competency test result: they carry no score and are
// shown in their own section, per candidate.
//
// Every read goes through the signed-in user's RLS client, never service_role.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import {
  buildIndividualQuestions, individualQuestionsAllowed, isExerciseAiEnabled, type IndividualQuestion,
} from './exercise-ai.ts';
import { buildInterviewGaps, type InterviewGapRow } from './interview-gaps.ts';
import { prepareScreening } from './screening.ts';
import { loadScreeningContext } from './screening-flow.ts';
import { screeningStatus } from './screening-ui.ts';

/** Upper bound on shortlisted candidates read on one page view. */
export const INDIVIDUAL_QUESTIONS_MAX_CANDIDATES = 30;

export type IndividualQuestionsStatus =
  /** Questions are ready to show. */
  | 'ready'
  /** The analysis is approved but has no gap with a question. */
  | 'no_questions'
  /** Not (or no longer) on the shortlist: nothing is built. */
  | 'not_shortlisted'
  /** No completed CV analysis. */
  | 'no_analysis'
  /** A human has not approved the current revision of the analysis. */
  | 'awaiting_review'
  /** CV or requirements changed, re-analysis requested, or the shortlist points to an older analysis/review. */
  | 'outdated'
  /** The data read was inconsistent; fail closed. */
  | 'unavailable';

export type ShortlistEntrySnapshot = {
  application_id: string; analysis_id: string; review_id: string; removed_at: string | null;
};
export type AnalysisSnapshot = {
  id: string; application_id: string; execution_status: string;
  input_fingerprint: string; stale_at: string | null; latest_review_version: number;
};
export type ReviewSnapshot = { id: string; analysis_id: string; review_version: number; disposition: string };
export type CriterionSnapshot = InterviewGapRow & { analysis_id: string };

export type CandidateQuestionsInput = {
  entry: ShortlistEntrySnapshot | null;
  analysis: AnalysisSnapshot | null;
  latestReview: ReviewSnapshot | null;
  rows: readonly CriterionSnapshot[];
  /** Fingerprint of the current CV + requirements; undefined when it cannot be computed. */
  fingerprint: string | undefined;
  limit?: number;
};

export type CandidateQuestions = { status: IndividualQuestionsStatus; questions: IndividualQuestion[] };

const none = (status: IndividualQuestionsStatus): CandidateQuestions => ({ status, questions: [] });

/**
 * Pure gate + builder. `individualQuestionsAllowed` (whole-analysis human
 * approval of the current revision) is always checked together with
 * `buildIndividualQuestions`, and staleness is added here as the comment on
 * `individualQuestionsAllowed` requires. The shortlist entry must point at the
 * very analysis and review being shown (same join as rule R1 / voice verifier).
 */
export function individualQuestionsForCandidate(input: CandidateQuestionsInput): CandidateQuestions {
  const { entry, analysis, latestReview, rows, fingerprint } = input;
  if (!entry || entry.removed_at !== null) return none('not_shortlisted');
  if (!analysis || analysis.execution_status !== 'completed') return none('no_analysis');
  if (analysis.application_id !== entry.application_id) return none('unavailable');
  if (screeningStatus({ ...analysis, execution_status: 'completed' }, fingerprint) === 'stale') return none('outdated');
  if (latestReview?.disposition === 'needs_reanalysis') return none('outdated');
  if (latestReview && latestReview.analysis_id !== analysis.id) return none('unavailable');
  if (!individualQuestionsAllowed({
    analysisReviewVersion: analysis.latest_review_version,
    latestReview: latestReview ? { review_version: latestReview.review_version, disposition: latestReview.disposition } : null,
  })) return none('awaiting_review');
  // The shortlist was made on this exact analysis and this exact approval;
  // a newer analysis or review means the shortlist decision predates it.
  if (entry.analysis_id !== analysis.id || entry.review_id !== latestReview!.id) return none('outdated');
  if (rows.some(row => row.analysis_id !== analysis.id)) return none('unavailable');
  const questions = buildIndividualQuestions(buildInterviewGaps(rows).gaps, input.limit);
  return questions.length ? { status: 'ready', questions } : none('no_questions');
}

export type ShortlistCandidateQuestions = CandidateQuestions & {
  applicationId: string;
  label: string;
};

type Client = SupabaseClient<Database>;
export type IndividualQuestionsDeps = {
  /** Current input fingerprint for one application; undefined on any failure. */
  fingerprint: (client: Client, route: { companyId: string; recruitmentId: string; applicationId: string }) => Promise<string | undefined>;
};

async function defaultFingerprint(client: Client, route: { companyId: string; recruitmentId: string; applicationId: string }) {
  try { return prepareScreening(await loadScreeningContext(client, route)).fingerprint; } catch { return undefined; }
}

export class IndividualQuestionsError extends Error {}

const criterionColumns = 'id,analysis_id,criterion_id,criterion_kind,criterion_text_snapshot,criterion_order,verdict,missing_info,suggested_question,human_status,human_verdict,human_missing_info,human_suggested_question';
const analysisColumns = 'id,application_id,execution_status,input_fingerprint,stale_at,latest_review_version';

/**
 * Per shortlisted candidate of one recruitment. Returns null (and reads
 * nothing) unless the feature flag is on and the user is the company owner or
 * a recruiter — the same gate as the AI task screens.
 */
export async function loadShortlistIndividualQuestions(
  client: Client,
  { companyId, recruitmentId, canEdit, flag }: { companyId: string; recruitmentId: string; canEdit: boolean; flag: string | undefined },
  deps: IndividualQuestionsDeps = { fingerprint: defaultFingerprint },
): Promise<{ candidates: ShortlistCandidateQuestions[]; truncated: boolean } | null> {
  if (!isExerciseAiEnabled(flag) || !canEdit) return null;
  const shortlist = await client.from('recruitment_shortlist_entries')
    .select('application_id,analysis_id,review_id,removed_at')
    .eq('company_id', companyId).eq('recruitment_id', recruitmentId).is('removed_at', null)
    .order('selected_at', { ascending: true }).limit(INDIVIDUAL_QUESTIONS_MAX_CANDIDATES + 1);
  if (shortlist.error || !Array.isArray(shortlist.data)) throw new IndividualQuestionsError('Nie udało się wczytać shortlisty.');
  const entries = (shortlist.data as ShortlistEntrySnapshot[]).filter(entry => entry && entry.removed_at === null);
  const truncated = entries.length > INDIVIDUAL_QUESTIONS_MAX_CANDIDATES;
  const shown = entries.slice(0, INDIVIDUAL_QUESTIONS_MAX_CANDIDATES);
  if (!shown.length) return { candidates: [], truncated: false };

  const applicationIds = shown.map(entry => entry.application_id);
  const applications = await client.from('applications').select('id,candidate_id')
    .eq('company_id', companyId).eq('recruitment_id', recruitmentId).in('id', applicationIds);
  if (applications.error || !Array.isArray(applications.data)) throw new IndividualQuestionsError('Nie udało się wczytać zgłoszeń.');
  const candidateOf = new Map(applications.data.map(row => [row.id, row.candidate_id]));
  const candidateIds = Array.from(new Set(candidateOf.values()));
  const people = candidateIds.length
    ? await client.from('candidates').select('id,first_name,last_name').eq('company_id', companyId).in('id', candidateIds)
    : { data: [], error: null };
  if (people.error || !Array.isArray(people.data)) throw new IndividualQuestionsError('Nie udało się wczytać kandydatów.');
  const nameOf = new Map(people.data.map(row => [row.id, `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()]));

  const candidates = await Promise.all(shown.map(async (entry, index): Promise<ShortlistCandidateQuestions> => {
    const candidateId = candidateOf.get(entry.application_id);
    const label = (candidateId && nameOf.get(candidateId)) || `Kandydat ${index + 1}`;
    const base = { applicationId: entry.application_id, label };
    if (!candidateId) return { ...base, ...none('unavailable') };
    const route = { companyId, recruitmentId, applicationId: entry.application_id };
    const readAnalysis = () => client.from('screening_analysis_versions').select(analysisColumns)
      .eq('company_id', companyId).eq('application_id', entry.application_id).eq('recruitment_id', recruitmentId)
      .order('analysis_version', { ascending: false }).limit(1).maybeSingle();
    const analysis = await readAnalysis();
    if (analysis.error) return { ...base, ...none('unavailable') };
    const current = analysis.data as AnalysisSnapshot | null;
    if (!current || current.execution_status !== 'completed') return { ...base, ...none('no_analysis') };
    const readReview = () => client.from('screening_result_reviews').select('id,analysis_id,review_version,disposition')
      .eq('company_id', companyId).eq('analysis_id', current.id).order('review_version', { ascending: false }).limit(1);
    const [review, rows, fingerprint] = await Promise.all([
      readReview(),
      client.from('screening_criterion_results').select(criterionColumns)
        .eq('company_id', companyId).eq('analysis_id', current.id).order('criterion_order'),
      deps.fingerprint(client, route),
    ]);
    if (review.error || rows.error || !Array.isArray(review.data) || review.data.length > 1 || !Array.isArray(rows.data)) {
      return { ...base, ...none('unavailable') };
    }
    // Data API reads are not one transaction: an analysis or review that changed
    // in between must not produce a mixed snapshot. Fail closed instead.
    const [againAnalysis, againReview] = await Promise.all([readAnalysis(), readReview()]);
    if (againAnalysis.error || againReview.error
      || JSON.stringify(againAnalysis.data) !== JSON.stringify(analysis.data)
      || JSON.stringify(againReview.data) !== JSON.stringify(review.data)) {
      return { ...base, ...none('unavailable') };
    }
    return { ...base, ...individualQuestionsForCandidate({
      entry, analysis: current, latestReview: (review.data[0] as ReviewSnapshot | undefined) ?? null,
      rows: rows.data as unknown as CriterionSnapshot[], fingerprint,
    }) };
  }));
  return { candidates, truncated };
}

export const individualQuestionsStatusLabels: Record<Exclude<IndividualQuestionsStatus, 'ready'>, string> = {
  no_questions: 'Analiza CV nie wskazała luk z gotowym pytaniem. Ustal pytania samodzielnie, jeśli są potrzebne.',
  not_shortlisted: 'Kandydat nie jest na shortliście.',
  no_analysis: 'Brak ukończonej analizy CV. Pytania pojawią się po analizie i jej zatwierdzeniu.',
  awaiting_review: 'Analiza CV czeka na sprawdzenie i zatwierdzenie przez rekrutera. Do tego czasu pytania nie są pokazywane.',
  outdated: 'Analiza CV jest nieaktualna albo nowsza niż wpis na shortliście. Sprawdź analizę ponownie i zaktualizuj shortlistę.',
  unavailable: 'Nie udało się wczytać spójnych danych. Odśwież stronę.',
};
