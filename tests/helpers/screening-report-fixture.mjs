export const uuid = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const company = uuid(1), recruitment = uuid(2), application = uuid(3), analysis = uuid(4), review = uuid(5), result = uuid(6);
export const timestamp = '2026-10-09T08:00:00.000Z';
export function fixture() {
  return {
    companies: [{ id: company, name: 'Firma testowa', updated_at: timestamp }],
    recruitments: [{ id: recruitment, company_id: company, position_id: uuid(9), name: 'Analityk', updated_at: timestamp }],
    positions: [{ id: uuid(9), company_id: company, title: 'Analityk', tasks: ['Raportowanie'], kpis: [], required_competencies: [], updated_at: timestamp }],
    applications: [{ id: application, company_id: company, recruitment_id: recruitment, updated_at: timestamp }],
    get_screening_ranking: [{ application_id: application, analysis_id: analysis, review_id: review, rank: 1, rankable: true,
      eligibility_reason: 'eligible', raw_score: '50.000', coverage: '1.000', total_criteria: 1, known_criteria: 1, below_count: 0,
      meets_count: 1, above_count: 0, insufficient_data_count: 0, suggested_shortlist: true, ranking_policy_version: 'screening-ranking-v1',
      shortlist_entry_id: null, shortlist_snapshot_current: null }],
    get_recruitment_shortlist: [],
    screening_analysis_versions: [{ id: analysis, company_id: company, recruitment_id: recruitment, application_id: application,
      execution_status: 'completed', stale_at: null, latest_review_version: 2,
      criteria_snapshot: [{ id: 'task:1', kind: 'task', text: 'Raportowanie' }], input_cv_text_snapshot: 'DO_NOT_EXPORT_RAW_CV' }],
    screening_result_reviews: [{ id: review, company_id: company, analysis_id: analysis, review_version: 2,
      disposition: 'approved', review_note: 'DO_NOT_EXPORT_NOTE', reviewer_id: 'DO_NOT_EXPORT_REVIEWER' }],
    screening_criterion_results: [{ id: result, company_id: company, analysis_id: analysis, criterion_id: 'task:1', criterion_kind: 'task',
      criterion_order: 1, criterion_text_snapshot: 'Raportowanie', rating: 'meets', evidence: [{ start: 0, end: 6, quote: 'Raport' }], explanation: 'Tworzy raporty' }],
    screening_criterion_review_overrides: [],
  };
}
