-- SC-008: read-only, human-reviewed ranking and explicit shortlist snapshots.
-- No screening rating, application decision or production configuration is changed.
begin;
create table private.screening_ranking_policies (
  version text primary key check (version ~ '^screening-ranking-v[0-9]+$'),
  min_coverage numeric not null check (min_coverage > 0 and min_coverage <= 1),
  below_points integer not null check (below_points >= 0),
  meets_points integer not null check (meets_points >= 0),
  above_points integer not null check (above_points >= 0),
  min_target_size integer not null check (min_target_size >= 1),
  max_target_size integer not null check (max_target_size >= min_target_size),
  default_target_size integer not null check (default_target_size between min_target_size and max_target_size),
  created_at timestamptz not null default now()
);
alter table private.screening_ranking_policies enable row level security;
revoke all on private.screening_ranking_policies from public, anon, authenticated, screening_worker;
insert into private.screening_ranking_policies
  (version, min_coverage, below_points, meets_points, above_points, min_target_size, max_target_size, default_target_size)
values ('screening-ranking-v1', 0.60, 0, 50, 100, 5, 10, 10);

create function private.guard_screening_ranking_policy()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'Ranking policies are immutable';
end;
$$;
create trigger screening_ranking_policy_immutable before update or delete
on private.screening_ranking_policies for each row execute function private.guard_screening_ranking_policy();

create function private.screening_ranking_policy(requested_version text)
returns private.screening_ranking_policies language sql stable security definer set search_path = '' as $$
  select p.version, p.min_coverage, p.below_points, p.meets_points, p.above_points,
    p.min_target_size, p.max_target_size, p.default_target_size, p.created_at
  from private.screening_ranking_policies p where p.version = requested_version
$$;

create type private.screening_ranking_order_key as (
  negative_score numeric, negative_coverage numeric, below_count integer,
  negative_above_count integer, application_id uuid
);
create function private.screening_ranking_order_key(numeric, numeric, integer, integer, uuid)
returns private.screening_ranking_order_key language sql immutable strict security invoker set search_path = '' as $$
  select row(-$1, -$2, $3, -$4, $5)::private.screening_ranking_order_key
$$;
revoke all on type private.screening_ranking_order_key from public, anon, authenticated, screening_worker;
grant usage on type private.screening_ranking_order_key to authenticated;

create function private.screening_ranking_freshness_reason(target_company uuid, target_analysis uuid)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare
  a record;
  app record;
  rec record;
  pos record;
  doc record;
begin
  -- PL/pgSQL deliberately checks access before any tenant row is read.
  if (select auth.uid()) is null or not private.has_company_access(target_company) then
    return 'unavailable';
  end if;
  select s.company_id, s.recruitment_id, s.application_id, s.position_id,
    s.candidate_document_id, s.candidate_document_version, s.stale_at,
    s.binding_snapshot->>'application_updated_at' as application_updated_at,
    s.binding_snapshot->>'recruitment_updated_at' as recruitment_updated_at,
    s.binding_snapshot->>'position_updated_at' as position_updated_at
  into a from public.screening_analysis_versions s
  where s.id = target_analysis and s.company_id = target_company;
  if not found then return 'unavailable'; end if;
  select t.id, t.company_id, t.candidate_id, t.status, t.updated_at into app
  from public.applications t where t.id = a.application_id and t.company_id = target_company;
  if not found or app.status not in ('new', 'in_progress')
    or a.application_updated_at is distinct from to_jsonb(app.updated_at)#>>'{}'
    then return 'application_changed'; end if;
  select t.id, t.company_id, t.status, t.updated_at into rec
  from public.recruitments t where t.id = a.recruitment_id and t.company_id = target_company;
  if not found or rec.status not in ('draft', 'open')
    or a.recruitment_updated_at is distinct from to_jsonb(rec.updated_at)#>>'{}'
    then return 'recruitment_changed'; end if;
  select t.id, t.company_id, t.status, t.updated_at into pos
  from public.positions t where t.id = a.position_id and t.company_id = target_company;
  if not found or pos.status = 'archived'
    or a.position_updated_at is distinct from to_jsonb(pos.updated_at)#>>'{}'
    then return 'position_changed'; end if;
  select t.id, t.company_id, t.candidate_id, t.version, t.status, t.reviewed_by, t.reviewed_at, t.created_at
  into doc from public.candidate_documents t
  where t.company_id = target_company and t.candidate_id = app.candidate_id
  order by t.created_at desc, t.id desc limit 1;
  if not found or doc.id <> a.candidate_document_id or doc.version <> a.candidate_document_version
    then return 'candidate_document_changed'; end if;
  if doc.status <> 'reviewed' or doc.reviewed_by is null or doc.reviewed_at is null
    then return 'candidate_document_unreviewed'; end if;
  return null;
end;
$$;

create table public.recruitment_shortlist_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  selected_by uuid not null references auth.users(id) on delete restrict,
  selected_at timestamptz not null default now(),
  source text not null check (source in ('manual', 'suggested')),
  analysis_id uuid not null,
  review_id uuid not null,
  ranking_policy_version text not null references private.screening_ranking_policies(version),
  raw_score_snapshot numeric,
  coverage_snapshot numeric not null check (coverage_snapshot between 0 and 1),
  note text check (char_length(note) <= 2000 and note = btrim(note)),
  removed_at timestamptz,
  removed_by uuid references auth.users(id) on delete restrict,
  check ((removed_at is null) = (removed_by is null)),
  unique (company_id, id),
  constraint recruitment_shortlist_application_fkey foreign key (company_id, recruitment_id, application_id)
    references public.applications(company_id, recruitment_id, id) on delete cascade,
  constraint recruitment_shortlist_recruitment_fkey foreign key (company_id, recruitment_id)
    references public.recruitments(company_id, id) on delete cascade,
  constraint recruitment_shortlist_analysis_fkey foreign key (company_id, analysis_id)
    references public.screening_analysis_versions(company_id, id) on delete cascade,
  constraint recruitment_shortlist_review_fkey foreign key (company_id, review_id)
    references public.screening_result_reviews(company_id, id) on delete cascade
);
create unique index recruitment_shortlist_active_application_idx
  on public.recruitment_shortlist_entries(company_id, recruitment_id, application_id) where removed_at is null;
create index recruitment_shortlist_active_idx
  on public.recruitment_shortlist_entries(company_id, recruitment_id, selected_at desc) where removed_at is null;
create index recruitment_shortlist_history_idx
  on public.recruitment_shortlist_entries(company_id, recruitment_id, selected_at desc, id);
create index recruitment_shortlist_application_idx
  on public.recruitment_shortlist_entries(company_id, application_id, selected_at desc);
create index recruitment_shortlist_analysis_idx on public.recruitment_shortlist_entries(company_id, analysis_id);
create index recruitment_shortlist_review_idx on public.recruitment_shortlist_entries(company_id, review_id);
alter table public.recruitment_shortlist_entries enable row level security;
revoke all on public.recruitment_shortlist_entries from public, anon, authenticated, screening_worker;
grant select on public.recruitment_shortlist_entries to authenticated;
create policy recruitment_shortlist_read on public.recruitment_shortlist_entries for select to authenticated
  using (private.has_company_access(company_id));

create function private.guard_recruitment_shortlist_entry()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.selected_by is null or new.selected_at is null
      or not exists (select 1 from public.screening_analysis_versions a where a.id = new.analysis_id
        and a.company_id = new.company_id and a.recruitment_id = new.recruitment_id and a.application_id = new.application_id)
      or not exists (select 1 from public.screening_result_reviews r where r.id = new.review_id
        and r.company_id = new.company_id and r.analysis_id = new.analysis_id) then
      raise exception using errcode = '23514', message = 'Invalid shortlist source binding';
    end if;
  elsif (to_jsonb(new) - 'removed_at' - 'removed_by') is distinct from (to_jsonb(old) - 'removed_at' - 'removed_by')
    or old.removed_at is not null or old.removed_by is not null
    or new.removed_at is null or new.removed_by is null then
    raise exception using errcode = '55000', message = 'Shortlist snapshots are immutable';
  end if;
  return new;
end;
$$;
create trigger recruitment_shortlist_guard before insert or update on public.recruitment_shortlist_entries
  for each row execute function private.guard_recruitment_shortlist_entry();

create function public.get_screening_ranking(target_recruitment uuid, target_size integer default null)
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
        select coalesce(case when rv.disposition = 'approved_with_changes' then o.rating_override end, cr.rating) as rating
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

create function public.get_recruitment_shortlist(target_recruitment uuid, include_removed boolean default false)
returns table (
  entry_id uuid, application_id uuid, selected_by uuid, selected_at timestamptz, source text,
  analysis_id uuid, review_id uuid, ranking_policy_version text, raw_score_snapshot numeric,
  coverage_snapshot numeric, note text, snapshot_current boolean, policy_current boolean,
  removed_at timestamptz, removed_by uuid
) language plpgsql stable security invoker set search_path = '' as $$
declare
  tenant uuid;
  policy private.screening_ranking_policies;
begin
  if (select auth.uid()) is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select r.company_id into tenant from public.recruitments r where r.id = target_recruitment;
  if not found or not private.has_company_access(tenant) then
    raise exception using errcode = '42501', message = 'No access';
  end if;
  policy := private.screening_ranking_policy('screening-ranking-v1');
  return query
  select e.id, e.application_id, e.selected_by, e.selected_at, e.source,
    e.analysis_id, e.review_id, e.ranking_policy_version, e.raw_score_snapshot,
    e.coverage_snapshot, e.note,
    coalesce(e.removed_at is null and a.execution_status = 'completed' and a.stale_at is null
      and private.screening_ranking_freshness_reason(tenant, a.id) is null
      and r.id = e.review_id and r.review_version = a.latest_review_version, false),
    e.ranking_policy_version = policy.version, e.removed_at, e.removed_by
  from public.recruitment_shortlist_entries e
  left join public.screening_analysis_versions a on a.company_id = tenant and a.id = e.analysis_id
    and a.application_id = e.application_id and a.recruitment_id = target_recruitment
  left join lateral (
    select rv.id, rv.review_version from public.screening_result_reviews rv
    where rv.company_id = tenant and rv.analysis_id = a.id order by rv.review_version desc limit 1
  ) r on true
  where e.company_id = tenant and e.recruitment_id = target_recruitment
    and (coalesce(include_removed, false) or e.removed_at is null)
  order by e.selected_at desc, e.id;
end;
$$;

create function public.add_recruitment_shortlist_entry(
  target_application uuid, entry_source text, expected_analysis_id uuid,
  expected_review_id uuid, expected_policy_version text,
  entry_note text default null, target_size integer default null
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  tenant uuid;
  recruitment uuid;
  analysis record;
  app record;
  rec record;
  pos record;
  doc record;
  ranked record;
  policy private.screening_ranking_policies;
  result_id uuid;
  actor uuid := (select auth.uid());
  clean_note text := btrim(entry_note);
begin
  if actor is null then raise exception using errcode = '42501', message = 'No write access'; end if;
  select a.company_id, a.recruitment_id into tenant, recruitment from public.applications a where a.id = target_application;
  if not found or not private.has_company_access(tenant, true) then
    raise exception using errcode = '42501', message = 'No write access';
  end if;
  if entry_source is null or entry_source not in ('manual', 'suggested') or char_length(clean_note) > 2000 then
    raise exception using errcode = '22023', message = 'Invalid shortlist input';
  end if;
  policy := private.screening_ranking_policy('screening-ranking-v1');
  if coalesce(target_size, policy.default_target_size) not between policy.min_target_size and policy.max_target_size then
    raise exception using errcode = '22023', message = 'Invalid ranking target size';
  end if;
  if expected_policy_version is distinct from policy.version then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed';
  end if;

  -- Lock analysis first. NOWAIT prevents an inverted material->analysis lock
  -- order in existing stale triggers from turning a user selection into a deadlock.
  select s.id, s.company_id, s.application_id, s.recruitment_id, s.position_id,
    s.candidate_document_id, s.candidate_document_version into analysis
  from public.screening_analysis_versions s
  where s.company_id = tenant and s.recruitment_id = recruitment and s.application_id = target_application
    and s.execution_status = 'completed' and s.stale_at is null
  for share nowait;
  if not found then raise exception using errcode = '55000', message = 'Not shortlist eligible'; end if;
  if analysis.id is distinct from expected_analysis_id then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed';
  end if;
  select a.id, a.company_id, a.recruitment_id, a.candidate_id into app
  from public.applications a where a.id = target_application and a.company_id = tenant for share nowait;
  if not found or app.recruitment_id <> recruitment then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed';
  end if;
  select r.id, r.company_id, r.position_id into rec
  from public.recruitments r where r.id = recruitment and r.company_id = tenant for share nowait;
  if not found or rec.position_id <> analysis.position_id then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed';
  end if;
  select p.id, p.company_id into pos from public.positions p
  where p.id = analysis.position_id and p.company_id = tenant for share nowait;
  if not found then raise exception using errcode = 'PT409', message = 'Shortlist source changed'; end if;
  select d.id, d.company_id, d.candidate_id, d.version into doc
  from public.candidate_documents d where d.company_id = tenant and d.candidate_id = app.candidate_id
  order by d.created_at desc, d.id desc limit 1 for share nowait;
  if not found or doc.id <> analysis.candidate_document_id or doc.version <> analysis.candidate_document_version then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed';
  end if;

  -- One ranking statement supplies both suggestion and immutable score snapshot.
  -- The locked analysis/materials prevent review/completion/stale changes until commit.
  select r.application_id, r.analysis_id, r.review_id, r.eligibility_reason,
    r.raw_score, r.coverage, r.suggested_shortlist, r.ranking_policy_version into ranked
  from public.get_screening_ranking(recruitment, target_size) r where r.application_id = target_application;
  if not found then raise exception using errcode = 'PT409', message = 'Shortlist source changed'; end if;
  if ranked.analysis_id is distinct from expected_analysis_id or ranked.review_id is distinct from expected_review_id then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed';
  end if;
  if ranked.eligibility_reason not in ('eligible', 'insufficient_evidence') then
    raise exception using errcode = '55000', message = 'Not shortlist eligible';
  end if;
  if entry_source = 'suggested' and not ranked.suggested_shortlist then
    raise exception using errcode = '22023', message = 'Application is outside the suggested shortlist';
  end if;
  insert into public.recruitment_shortlist_entries (
    company_id, recruitment_id, application_id, selected_by, source, analysis_id,
    review_id, ranking_policy_version, raw_score_snapshot, coverage_snapshot, note
  ) values (
    tenant, recruitment, target_application, actor, entry_source, ranked.analysis_id,
    ranked.review_id, ranked.ranking_policy_version, ranked.raw_score, ranked.coverage, clean_note
  ) returning id into result_id;
  return result_id;
exception
  when unique_violation then
    raise exception using errcode = 'PT409', message = 'Shortlist entry already exists';
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode = 'PT409', message = 'Shortlist source changed; refresh and confirm again';
end;
$$;

create function public.remove_recruitment_shortlist_entry(target_entry uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  tenant uuid;
  removed timestamptz;
  actor uuid := (select auth.uid());
begin
  if actor is null then raise exception using errcode = '42501', message = 'No write access'; end if;
  select e.company_id into tenant from public.recruitment_shortlist_entries e where e.id = target_entry;
  if not found or not private.has_company_access(tenant, true) then
    raise exception using errcode = '42501', message = 'No write access';
  end if;
  select e.removed_at into removed from public.recruitment_shortlist_entries e
  where e.id = target_entry and e.company_id = tenant for update;
  if not found then raise exception using errcode = '42501', message = 'No write access'; end if;
  if removed is null then
    update public.recruitment_shortlist_entries set removed_at = clock_timestamp(), removed_by = actor
    where id = target_entry and company_id = tenant;
  end if;
  return target_entry;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode = 'PT409', message = 'Shortlist entry changed; refresh and confirm again';
end;
$$;

revoke all on function private.guard_screening_ranking_policy() from public, anon, authenticated, screening_worker;
revoke all on function private.guard_recruitment_shortlist_entry() from public, anon, authenticated, screening_worker;
revoke all on function private.screening_ranking_policy(text) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_ranking_order_key(numeric, numeric, integer, integer, uuid) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_ranking_freshness_reason(uuid, uuid) from public, anon, authenticated, screening_worker;
revoke all on function public.get_screening_ranking(uuid, integer) from public, anon, authenticated, screening_worker;
revoke all on function public.get_recruitment_shortlist(uuid, boolean) from public, anon, authenticated, screening_worker;
revoke all on function public.add_recruitment_shortlist_entry(uuid, text, uuid, uuid, text, text, integer) from public, anon, authenticated, screening_worker;
revoke all on function public.remove_recruitment_shortlist_entry(uuid) from public, anon, authenticated, screening_worker;
grant execute on function private.screening_ranking_policy(text) to authenticated;
grant execute on function private.screening_ranking_order_key(numeric, numeric, integer, integer, uuid) to authenticated;
grant execute on function private.screening_ranking_freshness_reason(uuid, uuid) to authenticated;
grant execute on function public.get_screening_ranking(uuid, integer) to authenticated;
grant execute on function public.get_recruitment_shortlist(uuid, boolean) to authenticated;
grant execute on function public.add_recruitment_shortlist_entry(uuid, text, uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.remove_recruitment_shortlist_entry(uuid) to authenticated;

commit;
