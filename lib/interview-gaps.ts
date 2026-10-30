import type { ScreeningCriterionResult } from './supabase/database.types';

// Step 4: interview topics come only from the Step 3 evidence matrix (v2 rows).
// The output is a list of questions for a human interviewer. It carries no
// score, ranking or hire/reject signal. Only rows a human confirmed are counted
// as supported; an AI "supported" verdict nobody reviewed stays an open topic.
export type InterviewGapRow = Pick<ScreeningCriterionResult,
  'id' | 'criterion_id' | 'criterion_kind' | 'criterion_text_snapshot' | 'criterion_order'
  | 'verdict' | 'missing_info' | 'suggested_question' | 'human_status'
  | 'human_verdict' | 'human_missing_info' | 'human_suggested_question'>;

export type InterviewGap = {
  id: string;
  kind: InterviewGapRow['criterion_kind'];
  requirement: string;
  verdict: 'partial' | 'missing' | 'contradicted' | null;
  missingInfo: string | null;
  question: string | null;
  source: 'matrix' | 'edited' | 'rejected' | 'unverified';
};

const gapVerdicts = new Set(['partial', 'missing', 'contradicted']);
const text = (value: string | null | undefined) => value?.trim() || null;

export function buildInterviewGaps(rows: readonly InterviewGapRow[]) {
  const gaps: InterviewGap[] = [];
  let supported = 0;
  for (const row of [...rows].sort((a, b) => a.criterion_order - b.criterion_order)) {
    if (row.verdict == null) continue;
    // A row rejected by a human is not evidence either way: the requirement
    // stays open and the interviewer writes their own question.
    if (row.human_status === 'rejected') {
      gaps.push({ id: row.id, kind: row.criterion_kind, requirement: row.criterion_text_snapshot,
        verdict: null, missingInfo: null, question: null, source: 'rejected' });
      continue;
    }
    const edited = row.human_status === 'edited';
    const verdict = edited ? row.human_verdict ?? row.verdict : row.verdict;
    if (!gapVerdicts.has(verdict)) {
      if (row.human_status !== 'unreviewed') { supported++; continue; }
      gaps.push({ id: row.id, kind: row.criterion_kind, requirement: row.criterion_text_snapshot,
        verdict: null, missingInfo: null, question: null, source: 'unverified' });
      continue;
    }
    gaps.push({
      id: row.id,
      kind: row.criterion_kind,
      requirement: row.criterion_text_snapshot,
      verdict: verdict as InterviewGap['verdict'],
      missingInfo: text(edited ? row.human_missing_info ?? row.missing_info : row.missing_info),
      question: text(edited ? row.human_suggested_question ?? row.suggested_question : row.suggested_question),
      source: edited ? 'edited' : 'matrix',
    });
  }
  return { gaps, supported, total: rows.filter(row => row.verdict != null).length };
}
