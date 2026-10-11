-- SC-012-B first executable DB operation: isolated review RPC candidate.
-- NOT a Supabase migration, NOT exposed to public Data API, NOT production-ready.
-- Must be installed after db/prototypes/sc012b-plan-schema.sql in a disposable PG DB.
-- Future work: complete actor-membership row lock order, trusted template source
-- and retention erasure before promotion to production migration.
create or replace function private.sc012b_review_plan(
  p_plan_id uuid,
  p_expected_review_version bigint,
  p_expected_source_hash text,
  p_decision text,
  p_reason text,
  p_request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  plan record;
  last_review record;
  last_version bigint;
  auth_owner uuid;
  auth_role text;
  bound_review_version integer;
  analysis_latest_version integer;
  current_plan uuid;
  prior_key record;
  result_id uuid;
  request_digest text;
  clean_reason text := nullif(pg_catalog.btrim(p_reason, E' \t\n\r\f\v'),'');
begin
  if actor is null or p_plan_id is null or p_request_key is null
     or p_expected_review_version is null or p_expected_review_version<0
     or p_expected_source_hash is null
     or p_expected_source_hash !~ '^[0-9a-f]{64}$'
     or p_decision is null or p_decision not in ('approved','requires_changes')
     or (p_decision='requires_changes' and
         (clean_reason is null or pg_catalog.char_length(clean_reason)>1000))
     or (p_reason is not null and pg_catalog.char_length(p_reason)>1000)
  then raise exception using errcode='22023',message='VOICE_PLAN_INVALID_REVIEW'; end if;

  -- No tenant ID or actor ID comes from the browser.
  select company_id,application_id,source_hash,analysis_id,screening_review_id,
         shortlist_entry_id into plan
  from public.voice_plan_versions where id=p_plan_id;
  if not found or not private.has_company_access(plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;

  -- Same lock domain as the test-only release CAS. This does not yet prove
  -- compatibility with all SC-006/008/010 writers.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(plan.company_id::text||':'||plan.application_id::text,0));
  -- Pin the current owner/member row until commit; a concurrent revocation
  -- cannot commit while this review transaction holds its membership lock.
  select c.owner_id into auth_owner from public.companies c
    where c.id=plan.company_id for share nowait;
  if not found then raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN'; end if;
  if actor is distinct from auth_owner then
    select m.role into auth_role from public.company_members m
      where m.company_id=plan.company_id and m.user_id=actor
      for share nowait;
    if not found or auth_role<>'recruiter' then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  end if;
  if not private.has_company_access(plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- Serialize a reused request key across different applications before
  -- looking up the global (company,actor,operation,key) uniqueness scope.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(plan.company_id::text||':'||actor::text||':review:'||p_request_key::text,0));
  perform 1 from public.voice_plan_versions p
    where p.id=p_plan_id and p.company_id=plan.company_id
      and p.application_id=plan.application_id for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  if plan.source_hash is distinct from p_expected_source_hash then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  select p.id into current_plan from public.voice_plan_versions p
    where p.company_id=plan.company_id and p.application_id=plan.application_id
    order by p.plan_version desc limit 1;
  if current_plan is distinct from p_plan_id then
    raise exception using errcode='PT409',message='VOICE_PLAN_SUPERSEDED';
  end if;
  -- Refuse stale analysis/shortlist/approval, including removal.
  -- Lock the analysis and the shortlist in the writer's established order.
  -- NOWAIT makes contention a conflict rather than waiting across lock-order
  -- inversions. Re-check all predicates *after* the locks are acquired.
  select a.latest_review_version into analysis_latest_version
    from public.screening_analysis_versions a
    where a.id=plan.analysis_id and a.company_id=plan.company_id
      and a.application_id=plan.application_id
      and a.execution_status='completed' and a.stale_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  perform 1 from public.recruitment_shortlist_entries s
    where s.id=plan.shortlist_entry_id and s.company_id=plan.company_id
      and s.application_id=plan.application_id and s.analysis_id=plan.analysis_id
      and s.review_id=plan.screening_review_id and s.removed_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  select r.review_version into bound_review_version
    from public.screening_result_reviews r
    where r.id=plan.screening_review_id and r.company_id=plan.company_id
      and r.analysis_id=plan.analysis_id
      and r.disposition in ('approved','approved_with_changes')
    for share nowait;
  if not found or bound_review_version is distinct from analysis_latest_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  if exists(select 1 from private.voice_plan_release_entries
     where company_id=plan.company_id and plan_id=p_plan_id) then
    raise exception using errcode='PT409',message='VOICE_PLAN_ALREADY_RELEASED';
  end if;

  request_digest:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'plan',p_plan_id,'expectedVersion',p_expected_review_version,
      'source',p_expected_source_hash,'decision',p_decision,
      'reason',clean_reason)::text,'UTF8')),'hex');

  select k.payload_hash,k.result_id into prior_key
  from private.voice_plan_request_keys k
  where k.company_id=plan.company_id and k.actor_id=actor
    and k.operation='review' and k.request_key=p_request_key for update;
  if found then
    if prior_key.payload_hash is distinct from request_digest or
       prior_key.result_id is null then
      raise exception using errcode='PT409',message='VOICE_PLAN_REQUEST_CONFLICT';
    end if;
    return prior_key.result_id;
  end if;
  select id,review_version,decision into last_review
    from private.voice_plan_review_entries
    where company_id=plan.company_id and plan_id=p_plan_id
    order by review_version desc limit 1;
  last_version:=coalesce(last_review.review_version,0);
  if last_review.decision='requires_changes' then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_TERMINAL';
  end if;
  if last_version<>p_expected_review_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_CONFLICT';
  end if;
  insert into private.voice_plan_review_entries
    (company_id,application_id,plan_id,review_version,reviewer_id,decision,
     reason,source_hash,retention_policy_version,retention_deadline)
  select p.company_id,p.application_id,p.id,last_version+1,actor,p_decision,
    clean_reason,p.source_hash,p.retention_policy_version,p.retention_deadline
  from public.voice_plan_versions p where p.id=p_plan_id
  returning id into result_id;
  insert into private.voice_plan_request_keys
    (company_id,actor_id,operation,request_key,payload_hash,result_id,
     retention_policy_version,retention_deadline)
  select p.company_id,actor,'review',p_request_key,request_digest,result_id,
    p.retention_policy_version,p.retention_deadline
  from public.voice_plan_versions p where p.id=p_plan_id;
  return result_id;
end;
$$;
-- No browser/anonymous grant: this is a candidate for a future trusted
-- server capability after independent security review, not a public endpoint.
revoke all on function private.sc012b_review_plan(
  uuid,bigint,text,text,text,uuid) from public,anon,authenticated;
