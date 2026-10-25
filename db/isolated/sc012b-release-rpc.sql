-- SC-012-B release RPC candidate. TEST DATABASE ONLY.
-- This is not a Supabase migration or production-ready authorization boundary.
-- It cannot be executed by anon/authenticated. Full trusted source/template
-- reconstruction and lock-graph review remain blockers before promotion.
create or replace function private.sc012b_release_plan(
  p_plan_id uuid,
  p_expected_review_id uuid,
  p_expected_source_hash text,
  p_expected_pointer_version bigint,
  p_expected_release_id uuid,
  p_request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  v_plan record;
  v_owner uuid;
  v_role text;
  v_latest_review record;
  v_current record;
  v_latest_analysis_review integer;
  v_bound_analysis_review integer;
  v_digest text;
  v_existing record;
  v_new_release uuid;
begin
  if actor is null or p_plan_id is null or p_expected_review_id is null or
     p_request_key is null or p_expected_source_hash is null or
     p_expected_source_hash !~ '^[0-9a-f]{64}$' or
     (p_expected_pointer_version is null) <> (p_expected_release_id is null) or
     p_expected_pointer_version < 1 then
    raise exception using errcode='22023',message='VOICE_PLAN_INVALID_RELEASE';
  end if;
  select p.* into v_plan from public.voice_plan_versions p where p.id=p_plan_id;
  if not found or not private.has_company_access(v_plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- Screening advisory before the application advisory. The Node verifier
  -- takes the same order; the opposite order deadlocks two sessions.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('screening:'||v_plan.application_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_plan.company_id::text||':'||v_plan.application_id::text,0));
  select c.owner_id into v_owner from public.companies c
    where c.id=v_plan.company_id for share nowait;
  if not found then raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN'; end if;
  if actor is distinct from v_owner then
    select m.role into v_role from public.company_members m
      where m.company_id=v_plan.company_id and m.user_id=actor for share nowait;
    if not found or v_role<>'recruiter' then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  end if;
  if not private.has_company_access(v_plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- Same candidate lock and freeze check as SC-010. A frozen candidate must
  -- not recover a replay id and must not append a new release row.
  perform private.erasure_lock_candidate(ap.candidate_id)
    from public.applications ap
    where ap.company_id=v_plan.company_id and ap.id=v_plan.application_id;
  if not found then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- A request key is unique across applications of this actor.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_plan.company_id::text||':'||actor::text||':release:'||p_request_key::text,0));
  -- Resolve an authorized, committed request replay BEFORE current-state
  -- checks, so superseded plans can recover their original result.
  v_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('plan',p_plan_id,'review',p_expected_review_id,
      'source',p_expected_source_hash,'expectedPointer',p_expected_pointer_version,
      'expectedRelease',p_expected_release_id)::text,'UTF8')),'hex');
  select k.payload_hash,k.result_id into v_existing from private.voice_plan_request_keys k
    where k.company_id=v_plan.company_id and k.actor_id=actor
      and k.operation='release' and k.request_key=p_request_key for update;
  if found then
    if v_existing.payload_hash is distinct from v_digest or v_existing.result_id is null then
      raise exception using errcode='PT409',message='VOICE_PLAN_REQUEST_CONFLICT';
    end if;
    return v_existing.result_id;
  end if;
  perform 1 from public.voice_plan_versions p
    where p.id=p_plan_id and p.company_id=v_plan.company_id for share nowait;
  if not found or v_plan.source_hash is distinct from p_expected_source_hash then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  if exists(select 1 from public.voice_plan_versions p
     where p.company_id=v_plan.company_id and p.application_id=v_plan.application_id
       and p.plan_version>v_plan.plan_version) then
    raise exception using errcode='PT409',message='VOICE_PLAN_SUPERSEDED';
  end if;
  -- Match the exact latest human approval; requires_changes is terminal.
  select r.id,r.review_version,r.decision,r.source_hash into v_latest_review
    from private.voice_plan_review_entries r
    where r.company_id=v_plan.company_id and r.plan_id=p_plan_id
    order by r.review_version desc limit 1 for share nowait;
  if not found or v_latest_review.id is distinct from p_expected_review_id
     or v_latest_review.decision<>'approved'
     or v_latest_review.source_hash is distinct from v_plan.source_hash then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_STALE';
  end if;
  select a.latest_review_version into v_latest_analysis_review
    from public.screening_analysis_versions a
    where a.company_id=v_plan.company_id and a.id=v_plan.analysis_id
      and a.application_id=v_plan.application_id
      and a.execution_status='completed' and a.stale_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE'; end if;
  perform 1 from public.recruitment_shortlist_entries s
    where s.company_id=v_plan.company_id and s.id=v_plan.shortlist_entry_id
      and s.application_id=v_plan.application_id and s.analysis_id=v_plan.analysis_id
      and s.review_id=v_plan.screening_review_id and s.removed_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE'; end if;
  select r.review_version into v_bound_analysis_review
    from public.screening_result_reviews r
    where r.company_id=v_plan.company_id and r.id=v_plan.screening_review_id
      and r.analysis_id=v_plan.analysis_id
      and r.disposition in ('approved','approved_with_changes') for share nowait;
  if not found or v_bound_analysis_review is distinct from v_latest_analysis_review then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  select c.pointer_version,c.release_entry_id into v_current
    from private.voice_plan_current_releases c
    where c.company_id=v_plan.company_id and c.application_id=v_plan.application_id
    for update nowait;
  if found then
    if v_current.pointer_version is distinct from p_expected_pointer_version or
       v_current.release_entry_id is distinct from p_expected_release_id then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
  elsif p_expected_pointer_version is not null or p_expected_release_id is not null then
    raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
  end if;
  if exists(select 1 from private.voice_plan_release_entries r
    where r.company_id=v_plan.company_id and r.plan_id=p_plan_id) then
    raise exception using errcode='PT409',message='VOICE_PLAN_ALREADY_RELEASED';
  end if;
  insert into private.voice_plan_release_entries
    (company_id,application_id,plan_id,approved_review_id,release_version,
     source_hash,released_by,retention_policy_version,retention_deadline)
  values(v_plan.company_id,v_plan.application_id,p_plan_id,p_expected_review_id,1,
     v_plan.source_hash,actor,v_plan.retention_policy_version,v_plan.retention_deadline)
  returning id into v_new_release;
  if p_expected_pointer_version is null then
    insert into private.voice_plan_current_releases
      (company_id,application_id,plan_id,release_entry_id,pointer_version)
    values(v_plan.company_id,v_plan.application_id,p_plan_id,v_new_release,1);
  else
    update private.voice_plan_current_releases
      set plan_id=p_plan_id,release_entry_id=v_new_release,
          pointer_version=p_expected_pointer_version+1,updated_at=now()
    where company_id=v_plan.company_id and application_id=v_plan.application_id
      and pointer_version=p_expected_pointer_version
      and release_entry_id=p_expected_release_id;
    if not found then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
  end if;
  insert into private.voice_plan_request_keys
    (company_id,actor_id,operation,request_key,payload_hash,result_id,
     retention_policy_version,retention_deadline)
  values(v_plan.company_id,actor,'release',p_request_key,v_digest,v_new_release,
     v_plan.retention_policy_version,v_plan.retention_deadline);
  return v_new_release;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
revoke all on function private.sc012b_release_plan(
  uuid,uuid,text,bigint,uuid,uuid) from public,anon,authenticated;

-- Read the current release only after revalidating the live source.
-- A stale pointer is removed in this same statement. Release history stays.
-- Returning NULL without raising is required: an exception would roll the
-- delete back. This is isolated SQL, not a Supabase migration.
create or replace function private.sc012b_current_release(p_application_id uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  v_row record;
  v_locked_pointer record;
  v_owner uuid;
  v_role text;
  v_plan record;
  v_plan_found boolean := false;
  v_latest_analysis uuid;
  v_material jsonb;
  v_position_updated timestamptz;
  v_position_found boolean := false;
  v_analysis record;
  v_analysis_found boolean := false;
  v_shortlist_removed timestamptz;
  v_shortlist_policy_version text;
  v_shortlist_found boolean := false;
  v_policy_current boolean := false;
  v_policy_version text;
  v_policy_found boolean := false;
  v_review_version integer;
  v_review_disposition text;
  v_review_found boolean := false;
  v_retention_found boolean := false;
  v_approval_retention_deadline timestamptz;
  v_release_retention_deadline timestamptz;
  v_frozen boolean := false;
  v_stale boolean;
begin
  if actor is null or p_application_id is null then
    raise exception using errcode='22023',message='VOICE_PLAN_INVALID_RELEASE';
  end if;
  -- Take a non-locking pointer snapshot first. Locking this row before the
  -- screening/application advisory locks reverses the release writer's order
  -- and can deadlock or block a legitimate concurrent release.
  select c.company_id,c.application_id,c.plan_id,c.release_entry_id,c.pointer_version
    into v_row
  from private.voice_plan_current_releases c
  where c.application_id=p_application_id;
  if not found then return null; end if;
  if not private.has_company_access(v_row.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  select c.owner_id into v_owner from public.companies c
    where c.id=v_row.company_id for share nowait;
  if not found then raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN'; end if;
  if actor is distinct from v_owner then
    select m.role into v_role from public.company_members m
      where m.company_id=v_row.company_id and m.user_id=actor for share nowait;
    if not found or v_role<>'recruiter' then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  end if;
  if not private.has_company_access(v_row.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('screening:'||v_row.application_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_row.company_id::text||':'||v_row.application_id::text,0));
  select p.recruitment_id,p.analysis_id,p.screening_review_id,p.shortlist_entry_id,
         p.plan_envelope,p.retention_deadline
    into v_plan
  from public.voice_plan_versions p
  where p.id=v_row.plan_id and p.company_id=v_row.company_id
    and p.application_id=v_row.application_id
  for share nowait;
  v_plan_found:=found;
  if v_plan_found then
    -- Advisory locks cover this lookup: a forced reanalysis can change the
    -- latest analysis even when the input fingerprint remains unchanged.
    select a.id into v_latest_analysis
    from public.screening_analysis_versions a
    where a.company_id=v_row.company_id
      and a.application_id=v_row.application_id
    order by a.analysis_version desc limit 1
    for share nowait;
    begin
      -- Position FOR SHARE inside screening_material happens before the
      -- candidate FOR UPDATE below.
      v_material:=private.screening_material(v_row.application_id,true);
    exception
      when insufficient_privilege or object_not_in_prerequisite_state
           or invalid_parameter_value then
        v_material:=null;
    end;
    select pos.updated_at into v_position_updated
    from public.applications ap
    join public.recruitments rec
      on rec.company_id=ap.company_id and rec.id=ap.recruitment_id
    join public.positions pos
      on pos.company_id=rec.company_id and pos.id=rec.position_id
    where ap.company_id=v_row.company_id and ap.id=v_row.application_id;
    v_position_found:=found;
    select a.latest_review_version,a.execution_status,a.stale_at into v_analysis
    from public.screening_analysis_versions a
    where a.company_id=v_row.company_id and a.id=v_plan.analysis_id
      and a.application_id=v_row.application_id
    for share nowait;
    v_analysis_found:=found;
    select s.removed_at,s.ranking_policy_version
      into v_shortlist_removed,v_shortlist_policy_version
    from public.recruitment_shortlist_entries s
    where s.company_id=v_row.company_id and s.id=v_plan.shortlist_entry_id
      and s.application_id=v_row.application_id
    for share nowait;
    v_shortlist_found:=found;
    -- A retained shortlist row is not current after a ranking-policy change.
    -- Mirror the same policy_current contract as the trusted source verifier.
    select x.policy_current,x.ranking_policy_version
      into v_policy_current,v_policy_version
    from public.get_recruitment_shortlist(v_plan.recruitment_id,false) x
    where x.entry_id=v_plan.shortlist_entry_id;
    v_policy_found:=found;
    select r.review_version,r.disposition
      into v_review_version,v_review_disposition
    from public.screening_result_reviews r
    where r.company_id=v_row.company_id and r.id=v_plan.screening_review_id
      and r.analysis_id=v_plan.analysis_id
    for share nowait;
    v_review_found:=found;
  end if;
  begin
    perform private.erasure_lock_candidate(ap.candidate_id)
      from public.applications ap
      where ap.company_id=v_row.company_id and ap.id=v_row.application_id;
    if not found then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  exception
    when sqlstate 'PT409' then
      if sqlerrm is distinct from 'Candidate workflow frozen' then raise; end if;
      v_frozen:=true;
  end;
  -- A retained current pointer is not authority after any immutable source,
  -- approval or release retention deadline. Check under the same transaction
  -- before locking and returning the pointer; never expose expired releases.
  if v_plan_found and not v_frozen then
    select a.retention_deadline,r.retention_deadline
      into v_approval_retention_deadline,v_release_retention_deadline
    from private.voice_plan_release_entries r
    join private.voice_plan_review_entries a
      on a.company_id=r.company_id and a.application_id=r.application_id
      and a.plan_id=r.plan_id and a.id=r.approved_review_id
    where r.company_id=v_row.company_id and r.application_id=v_row.application_id
      and r.plan_id=v_row.plan_id and r.id=v_row.release_entry_id
    for share of r,a nowait;
    v_retention_found:=found;
  end if;
  v_stale:=not v_plan_found
    or not v_retention_found
    or v_plan.retention_deadline is null or v_plan.retention_deadline<=now()
    or v_approval_retention_deadline is null or v_approval_retention_deadline<=now()
    or v_release_retention_deadline is null or v_release_retention_deadline<=now()
    or v_latest_analysis is distinct from v_plan.analysis_id
    or v_material is null or not v_position_found
    or not v_analysis_found or not v_shortlist_found or not v_review_found
    or not v_policy_found or v_policy_current is distinct from true
    or v_policy_version is distinct from v_shortlist_policy_version
    or (v_material->>'input_fingerprint') is distinct from
       (v_plan.plan_envelope #>> '{sourceBinding,analysisFingerprint}')
    or pg_catalog.date_trunc('milliseconds', v_position_updated) is distinct from
       pg_catalog.date_trunc('milliseconds',
         (v_plan.plan_envelope #>> '{sourceBinding,positionUpdatedAt}')::timestamptz)
    or v_analysis.execution_status is distinct from 'completed'
    or v_analysis.stale_at is not null
    or v_shortlist_removed is not null
    or v_review_disposition not in ('approved','approved_with_changes')
    or v_review_version is distinct from v_analysis.latest_review_version;
  -- Both advisory locks, authorization/source locks and candidate erasure
  -- checks are now held. Only now take the current pointer row lock.
  -- Its full identity must equal the initial MVCC snapshot: while we waited
  -- for the advisory locks a writer could have replaced or removed it.
  select c.company_id,c.application_id,c.plan_id,c.release_entry_id,c.pointer_version
    into v_locked_pointer
  from private.voice_plan_current_releases c
  where c.application_id=p_application_id
  for update nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
  end if;
  if v_locked_pointer.company_id is distinct from v_row.company_id or
     v_locked_pointer.application_id is distinct from v_row.application_id or
     v_locked_pointer.plan_id is distinct from v_row.plan_id or
     v_locked_pointer.release_entry_id is distinct from v_row.release_entry_id or
     v_locked_pointer.pointer_version is distinct from v_row.pointer_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
  end if;
  if v_frozen then return null; end if;
  if v_stale then
    delete from private.voice_plan_current_releases
    where company_id=v_row.company_id and application_id=v_row.application_id
      and plan_id=v_row.plan_id and release_entry_id=v_row.release_entry_id
      and pointer_version=v_row.pointer_version;
    if not found then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
    return null;
  end if;
  return v_locked_pointer.release_entry_id;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
revoke all on function private.sc012b_current_release(uuid)
  from public,anon,authenticated;
