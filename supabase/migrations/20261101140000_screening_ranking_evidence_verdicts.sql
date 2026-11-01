-- SC-MVP: the report ranking works for evidence-matrix (v2) analyses.
--
-- v2 analyses store a neutral legacy rating (insufficient_data) on purpose, so
-- get_screening_ranking found 0% coverage and never ranked any new analysis,
-- even after the recruiter approved it ("Za mało ocenionych kryteriów"). The
-- MVP promise is a ranked report, and the bulk preselection groups already
-- score v2 evidence (preselection-groups-v1, owner decision 2026-11-01).
--
-- Only the rating source changes. For a criterion with an evidence verdict the
-- ranking reads the recruiter-reviewed verdict and normalises it to the
-- existing screening-ranking-v1 points, the same mapping as the groups:
--   supported -> above (100), partial -> meets (50),
--   missing / contradicted -> below (0) (the CV gives no or contrary evidence),
--   a row the recruiter rejected -> insufficient_data (unknown, lowers coverage),
--   a row the recruiter edited -> its human_verdict.
-- Legacy (v1) results keep their own rating and override exactly as before.
-- Everything else (human-review requirement, freshness, coverage threshold,
-- ordering, shortlist snapshot) is unchanged; the policy row is unchanged.
-- Function body only: no table, constraint or trigger change, so the R9
-- erasure inventory signature is unaffected.
begin;

create or replace function public.get_screening_ranking(target_recruitment uuid, target_size integer default null)
returns table (
  application_id uuid, analysis_id uuid, review_id uuid, rank integer, rankable boolean,
  eligibility_reason text, raw_score numeric, coverage numeric, total_criteria integer,
  known_criteria integer, below_count integer, meets_count integer, above_count integer,
  insufficient_data_count integer, suggested_shortlist boolean, ranking_policy_version text,
  shortlist_entry_id uuid, shortlist_snapshot_current boolean
) language plpgsql stable security invoker set search_path = '' as $$
declare
  tenant uuid;
  policy private.screening_ranking_policies;
  requested_size integer;
begin
  if (select auth.uid()) is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select r.company_id into tenant from public.recruitments r where r.id = target_recruitment;
  if not found or not private.has_company_access(tenant) then
    raise exception using errcode = '42501', message = 'No access';
  end if;
  policy := private.screening_ranking_policy('screening-ranking-v1');
  requested_size := coalesce(target_size, policy.default_target_size);
  if requested_size not between policy.min_target_size and policy.max_target_size then
    raise exception using errcode = '22023', message = 'Invalid ranking target size';
  end if;
  return query
  with sources as materialized (
    select app.id as app_id, a.id as aid, a.latest_review_version, a.snapshot_size,
      rv.id as rid, rv.review_version, rv.disposition,
      coalesce(c.total, 0)::integer as total, coalesce(c.known, 0)::integer as known,
      coalesce(c.below, 0)::integer as below, coalesce(c.meets, 0)::integer as meets,
      coalesce(c.above, 0)::integer as above, coalesce(c.insufficient, 0)::integer as insufficient,
      c.points, missing.reason as missing_reason, entry.id as entry_id,
      entry.analysis_id as entry_analysis, entry.review_id as entry_review
    from public.applications app
    left join lateral (
      select s.id, s.latest_review_version,
        case when jsonb_typeof(s.criteria_snapshot) = 'array' then jsonb_array_length(s.criteria_snapshot) end as snapshot_size
      from public.screening_analysis_versions s
      where s.company_id = tenant and s.recruitment_id = target_recruitment and s.application_id = app.id
        and s.execution_status = 'completed' and s.stale_at is null
        and private.screening_ranking_freshness_reason(tenant, s.id) is null
    ) a on true
    left join lateral (
      select r.id, r.review_version, r.disposition from public.screening_result_reviews r
      where r.company_id = tenant and r.analysis_id = a.id order by r.review_version desc limit 1
    ) rv on true
    left join lateral (
      select count(*) as total, count(*) filter (where e.rating <> 'insufficient_data') as known,
        count(*) filter (where e.rating = 'below') as below,
        count(*) filter (where e.rating = 'meets') as meets,
        count(*) filter (where e.rating = 'above') as above,
        count(*) filter (where e.rating = 'insufficient_data') as insufficient,
        sum(case e.rating when 'below' then policy.below_points when 'meets' then policy.meets_points
          when 'above' then policy.above_points end) as points
      from (
        select coalesce(case when rv.disposition = 'approved_with_changes' then o.rating_override end,
          case when cr.verdict is null then cr.rating
            else case (case cr.human_status when 'edited' then cr.human_verdict when 'rejected' then null else cr.verdict end)
              when 'supported' then 'above' when 'partial' then 'meets'
              when 'missing' then 'below' when 'contradicted' then 'below'
              else 'insufficient_data' end end) as rating
        from public.screening_criterion_results cr
        left join public.screening_criterion_review_overrides o
          on o.company_id = tenant and o.review_id = rv.id and o.criterion_result_id = cr.id
        where cr.company_id = tenant and cr.analysis_id = a.id
      ) e
    ) c on true
    left join lateral (
      select case
        when bool_or(s.execution_status = 'processing' and s.stale_at is null) then 'processing'
        when bool_or(s.execution_status = 'pending' and s.stale_at is null) then 'pending'
        when (array_agg(s.execution_status order by s.analysis_version desc))[1] = 'failed' then 'failed'
        when (array_agg(s.execution_status order by s.analysis_version desc))[1] = 'cancelled' then 'cancelled'
        when bool_or(s.execution_status = 'completed') then 'stale'
        else 'no_completed_result' end as reason
      from public.screening_analysis_versions s
      where s.company_id = tenant and s.recruitment_id = target_recruitment and s.application_id = app.id
    ) missing on a.id is null
    left join public.recruitment_shortlist_entries entry on entry.company_id = tenant
      and entry.recruitment_id = target_recruitment and entry.application_id = app.id and entry.removed_at is null
    where app.company_id = tenant and app.recruitment_id = target_recruitment
  ), classified as (
    select s.app_id, s.aid, s.rid, s.total, s.known, s.below, s.meets, s.above, s.insufficient,
      s.entry_id, s.entry_analysis, s.entry_review, s.latest_review_version, s.review_version,
      case when s.aid is null then s.missing_reason
        when s.total = 0 or s.snapshot_size is distinct from s.total then 'result_incomplete'
        when coalesce(s.review_version, 0) <> s.latest_review_version then 'review_inconsistent'
        when s.rid is null then 'no_human_review'
        when s.disposition = 'needs_reanalysis' then 'needs_reanalysis'
        when s.known::numeric / nullif(s.total, 0)::numeric < policy.min_coverage then 'insufficient_evidence'
        else 'eligible' end as reason,
      case when s.total > 0 then s.known::numeric / s.total::numeric end as cov,
      case when s.total > 0 and s.snapshot_size = s.total and s.review_version = s.latest_review_version
        and s.disposition in ('approved', 'approved_with_changes') and s.known > 0
        then round(s.points::numeric / s.known::numeric, 3) end as score
    from sources s
  ), ordered as (
    select c.app_id, row_number() over (order by private.screening_ranking_order_key(
      c.score, c.cov, c.below, c.above, c.app_id) asc)::integer as place
    from classified c where c.reason = 'eligible'
  )
  select c.app_id, c.aid, c.rid, o.place, c.reason = 'eligible', c.reason,
    c.score, c.cov, c.total, c.known, c.below, c.meets, c.above, c.insufficient,
    coalesce(o.place <= requested_size, false), policy.version, c.entry_id,
    coalesce(c.entry_id is not null and c.entry_analysis = c.aid and c.entry_review = c.rid
      and c.review_version = c.latest_review_version, false)
  from classified c left join ordered o on o.app_id = c.app_id
  order by o.place asc nulls last, c.app_id asc;
end;
$$;

commit;
