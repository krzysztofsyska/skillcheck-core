import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import {
  MAX_REPORT_APPLICATIONS, REPORT_VERSION, ScreeningReportError, parseRanking, parseShortlist,
  requireReport, reportEvidence, reportParameters, reportRating, reportText,
  type ReportCriterion, type ScreeningReport,
} from './screening-report.ts';

type DbResult<T> = { data: T | null; error: { code?: string } | null };
function checked<T>(result: { data: T; error: { code?: string } | null }, rpc = false): NonNullable<T> {
  if (result.error) {
    if (rpc && ['PGRST202', '42883'].includes(result.error.code ?? '')) throw new ScreeningReportError('unavailable');
    if (result.error.code === '42501') throw new ScreeningReportError('not_found');
    throw new ScreeningReportError('failed');
  }
  if (result.data === null || result.data === undefined) throw new ScreeningReportError('not_found');
  return result.data as NonNullable<T>;
}
// Never rely on PostgREST's implicit row cap. Continue even if it is below 200.
async function allRows<T>(query: (from: number, to: number) => PromiseLike<DbResult<T[]>>, max: number, rpc = false): Promise<T[]> {
  const rows: T[] = [];
  while (true) {
    const page = checked(await query(rows.length, rows.length + 199), rpc);
    if (!page.length) return rows;
    rows.push(...page);
    if (rows.length > max) throw new ScreeningReportError('too_large');
  }
}
async function batches<T>(ids: string[], query: (ids: string[], from: number, to: number) => PromiseLike<DbResult<T[]>>) {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    rows.push(...await allRows((from, to) => query(ids.slice(offset, offset + 50), from, to), 20000));
    if (rows.length > 20000) throw new ScreeningReportError('too_large');
  }
  return rows;
}
function uniqueIds(rows: { id: string }[]) { requireReport(new Set(rows.map(r => r.id)).size === rows.length); }

export async function loadScreeningReport(
  client: SupabaseClient<Database>, companyId: string, recruitmentId: string, size?: unknown,
): Promise<ScreeningReport> {
  const p = reportParameters(companyId, recruitmentId, size);
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) throw new ScreeningReportError('unauthenticated');
  const readSource = async () => {
    const company = checked(await client.from('companies').select('id,name,updated_at').eq('id', p.companyId).maybeSingle());
    const recruitment = checked(await client.from('recruitments').select('id,company_id,position_id,name,updated_at')
      .eq('company_id', p.companyId).eq('id', p.recruitmentId).maybeSingle());
    const position = checked(await client.from('positions').select('id,company_id,title,tasks,kpis,required_competencies,updated_at')
      .eq('company_id', p.companyId).eq('id', recruitment.position_id).maybeSingle());
    const applications = await allRows((from, to) => client.from('applications').select('id,updated_at')
      .eq('company_id', p.companyId).eq('recruitment_id', p.recruitmentId).order('id').range(from, to), MAX_REPORT_APPLICATIONS);
    const rankings = (await allRows((from, to) => client.rpc('get_screening_ranking', {
      target_recruitment: p.recruitmentId, target_size: p.targetSize,
    }).order('application_id').range(from, to), MAX_REPORT_APPLICATIONS, true)).map(parseRanking);
    const shortlist = (await allRows((from, to) => client.rpc('get_recruitment_shortlist', {
      target_recruitment: p.recruitmentId, include_removed: false,
    }).order('entry_id').range(from, to), MAX_REPORT_APPLICATIONS, true)).map(parseShortlist);
    uniqueIds(applications);
    const ids = new Set(applications.map(a => a.id));
    requireReport(rankings.length === applications.length && new Set(rankings.map(r => r.application_id)).size === ids.size);
    requireReport(rankings.every(r => ids.has(r.application_id)) && shortlist.every(s => ids.has(s.application_id)));
    requireReport(new Set(shortlist.map(s => s.application_id)).size === shortlist.length);
    requireReport(new Set(shortlist.map(s => s.entry_id)).size === shortlist.length);
    const ranks = rankings.filter(r => r.rankable).map(r => r.rank!).sort((a, b) => a - b);
    requireReport(ranks.every((rank, i) => rank === i + 1));
    requireReport(rankings.every(r => r.suggested_shortlist === (r.rank !== null && r.rank <= p.targetSize)));
    requireReport(new Set(rankings.map(r => r.ranking_policy_version)).size <= 1);
    for (const row of rankings) {
      const entry = shortlist.find(s => s.application_id === row.application_id);
      requireReport(row.shortlist_entry_id === (entry?.entry_id ?? null));
      requireReport(entry ? row.shortlist_snapshot_current === entry.snapshot_current : row.shortlist_snapshot_current !== true);
      if (entry?.snapshot_current) requireReport(entry.analysis_id === row.analysis_id && entry.review_id === row.review_id);
    }
    return { company, recruitment, position, applications, rankings, shortlist };
  };
  const source = await readSource();
  const reviewed = source.rankings.filter(r => r.eligibility_reason === 'eligible' || r.eligibility_reason === 'insufficient_evidence');
  const analysisIds = reviewed.map(r => r.analysis_id!);
  const reviewIds = reviewed.map(r => r.review_id!);
  requireReport(new Set(analysisIds).size === analysisIds.length && new Set(reviewIds).size === reviewIds.length);
  const analyses = await batches(analysisIds, (ids, from, to) => client.from('screening_analysis_versions')
    .select('id,application_id,recruitment_id,execution_status,stale_at,latest_review_version,criteria_snapshot')
    .eq('company_id', p.companyId).eq('recruitment_id', p.recruitmentId).in('id', ids).order('id').range(from, to));
  const reviews = await batches(reviewIds, (ids, from, to) => client.from('screening_result_reviews')
    .select('id,analysis_id,review_version,disposition').eq('company_id', p.companyId).in('id', ids).order('id').range(from, to));
  const results = await batches(analysisIds, (ids, from, to) => client.from('screening_criterion_results')
    .select('id,analysis_id,criterion_id,criterion_kind,criterion_order,criterion_text_snapshot,rating,evidence,explanation')
    .eq('company_id', p.companyId).in('analysis_id', ids).order('id').range(from, to));
  const overrides = await batches(reviewIds, (ids, from, to) => client.from('screening_criterion_review_overrides')
    .select('id,review_id,criterion_result_id,rating_override,evidence_override,explanation_override')
    .eq('company_id', p.companyId).in('review_id', ids).order('id').range(from, to));
  [analyses, reviews, results, overrides].forEach(uniqueIds);
  requireReport(analyses.length === reviewed.length && reviews.length === reviewed.length);
  // Detect relationships outside the requested result set even if the backend contract regresses.
  requireReport(analyses.every(a => analysisIds.includes(a.id)) && reviews.every(r => reviewIds.includes(r.id)));
  requireReport(results.every(r => analysisIds.includes(r.analysis_id)));
  requireReport(overrides.every(o => reviewIds.includes(o.review_id)));
  const details = new Map<string, ReportCriterion[]>();
  for (const row of reviewed) {
    const analysis = analyses.find(a => a.id === row.analysis_id);
    const review = reviews.find(r => r.id === row.review_id);
    requireReport(analysis && review && analysis.application_id === row.application_id && analysis.recruitment_id === p.recruitmentId);
    requireReport(analysis.execution_status === 'completed' && analysis.stale_at === null);
    requireReport(review.analysis_id === analysis.id && review.review_version === analysis.latest_review_version);
    requireReport(review.disposition === 'approved' || review.disposition === 'approved_with_changes');
    const criteria = results.filter(r => r.analysis_id === analysis.id).sort((a, b) => a.criterion_order - b.criterion_order);
    requireReport(Array.isArray(analysis.criteria_snapshot) && criteria.length === row.total_criteria && criteria.length === analysis.criteria_snapshot.length);
    requireReport(new Set(criteria.map(c => c.criterion_id)).size === criteria.length);
    const changes = overrides.filter(o => o.review_id === review.id);
    requireReport(new Set(changes.map(c => c.criterion_result_id)).size === changes.length);
    requireReport(changes.every(c => criteria.some(r => r.id === c.criterion_result_id)));
    requireReport(review.disposition === 'approved_with_changes' ? changes.length > 0 : changes.length === 0);
    const rendered = criteria.map(c => {
      const snapshot = analysis.criteria_snapshot.find(s => s.id === c.criterion_id);
      requireReport(snapshot && snapshot.text === c.criterion_text_snapshot && snapshot.kind === c.criterion_kind);
      const override = changes.find(o => o.criterion_result_id === c.id);
      return {
        id: c.criterion_id, kind: c.criterion_kind, text: reportText(c.criterion_text_snapshot)!,
        aiRating: reportRating(c.rating), rating: reportRating(override?.rating_override ?? c.rating),
        reviewedChange: !!override, explanation: reportText(override?.explanation_override ?? c.explanation),
        evidence: reportEvidence(override?.evidence_override ?? c.evidence),
      };
    });
    // Counts verify which review was applied; no scoring or coverage policy is duplicated here.
    for (const [rating, expected] of [['below', row.below_count], ['meets', row.meets_count], ['above', row.above_count], ['insufficient_data', row.insufficient_data_count]] as const) {
      requireReport(rendered.filter(c => c.rating === rating).length === expected);
    }
    details.set(row.application_id, rendered);
  }
  const rechecked = await readSource();
  requireReport(JSON.stringify(source) === JSON.stringify(rechecked));
  const report: ScreeningReport = {
    version: REPORT_VERSION, generatedAt: new Date().toISOString(), companyId: p.companyId, companyName: source.company.name,
    recruitmentId: p.recruitmentId, recruitmentName: source.recruitment.name, positionTitle: source.position.title, targetSize: p.targetSize,
    requirements: [
      ...source.position.tasks.map(text => ({ kind: 'task' as const, text })),
      ...source.position.kpis.map(text => ({ kind: 'kpi' as const, text })),
      ...source.position.required_competencies.map(text => ({ kind: 'competency' as const, text })),
    ],
    applications: [...source.rankings].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.application_id.localeCompare(b.application_id))
      .map(ranking => ({ ranking, shortlist: source.shortlist.find(s => s.application_id === ranking.application_id) ?? null,
        criteria: details.get(ranking.application_id) ?? [] })),
  };
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 10 * 1024 * 1024) throw new ScreeningReportError('too_large');
  return report;
}
