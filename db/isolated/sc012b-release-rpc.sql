-- SC-012-B release RPC candidate. TEST DATABASE ONLY.
-- This is not a Supabase migration or production-ready authorization boundary.
-- anon/authenticated have no EXECUTE. The template catalog is empty until a
-- test or operator inserts an enabled row; a missing or withdrawn template
-- fails closed. Direct reads of the pointer are not freshness. Consumers must
-- call private.sc012b_effective_release, which recomputes the canonical source.
-- Lock order follows installed SC-006: screening advisory first, then
-- application -> recruitment -> position -> candidate document -> analysis.
create table if not exists private.voice_plan_template_catalog (
  template_version text primary key check (length(template_version) between 1 and 128),
  envelope_contract_hash text not null check (envelope_contract_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default false,
  withdrawn_at timestamptz,
  check (not enabled or withdrawn_at is null)
);
alter table private.voice_plan_template_catalog enable row level security;
alter table private.voice_plan_template_catalog force row level security;
revoke all on table private.voice_plan_template_catalog from public, anon, authenticated;

-- Live non-PII projection. CV text, names and contact fields are never hashed.
create or replace function private.sc012b_recompute_release_source(
  p_company_id uuid,
  p_application_id uuid,
  p_analysis_id uuid,
  p_screening_review_id uuid,
  p_shortlist_entry_id uuid,
  p_template_version text,
  p_envelope_hash text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_app public.applications%rowtype;
  v_rec public.recruitments%rowtype;
  v_pos public.positions%rowtype;
  v_analysis public.screening_analysis_versions%rowtype;
  v_review public.screening_result_reviews%rowtype;
  v_short public.recruitment_shortlist_entries%rowtype;
  v_doc_id uuid;
  v_doc_version integer;
  v_doc_status text;
  v_latest_doc uuid;
  v_snapshot jsonb;
begin
  select * into v_app from public.applications a
    where a.id=p_application_id and a.company_id=p_company_id for share nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  select * into v_rec from public.recruitments r
    where r.id=v_app.recruitment_id and r.company_id=p_company_id for share nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  select * into v_pos from public.positions p
    where p.id=v_rec.position_id and p.company_id=p_company_id for share nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  perform 1 from public.candidate_documents d
    where d.company_id=p_company_id and d.candidate_id=v_app.candidate_id
    order by d.id for share nowait;
  select * into v_analysis from public.screening_analysis_versions a
    where a.id=p_analysis_id and a.company_id=p_company_id for share nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  select d.id,d.version,d.status into v_doc_id,v_doc_version,v_doc_status
    from public.candidate_documents d
    where d.id=v_analysis.candidate_document_id and d.company_id=p_company_id;
  select d.id into v_latest_doc from public.candidate_documents d
    where d.company_id=p_company_id and d.candidate_id=v_app.candidate_id
    order by d.created_at desc, d.id desc limit 1;
  select * into v_review from public.screening_result_reviews r
    where r.company_id=p_company_id and r.id=p_screening_review_id
      and r.analysis_id=p_analysis_id for share nowait;
  select * into v_short from public.recruitment_shortlist_entries s
    where s.company_id=p_company_id and s.id=p_shortlist_entry_id for share nowait;
  perform 1 from private.voice_plan_template_catalog t
    where t.template_version=p_template_version and t.enabled and t.withdrawn_at is null
      and t.envelope_contract_hash=p_envelope_hash for share nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_TEMPLATE_STALE';
  end if;
  if v_app.status not in ('new','in_progress') or v_rec.status<>'open' or v_pos.status<>'active'
     or v_doc_id is null or v_doc_status<>'reviewed'
     or v_doc_id is distinct from v_latest_doc
     or v_doc_version is distinct from v_analysis.candidate_document_version
     or v_analysis.application_id is distinct from p_application_id
     or v_analysis.recruitment_id is distinct from v_rec.id
     or v_analysis.position_id is distinct from v_pos.id
     or v_analysis.execution_status<>'completed' or v_analysis.stale_at is not null
     or v_review.id is null
     or v_review.disposition not in ('approved','approved_with_changes')
     or v_review.review_version is distinct from v_analysis.latest_review_version
     or v_short.id is null or v_short.removed_at is not null
     or v_short.application_id is distinct from p_application_id
     or v_short.analysis_id is distinct from p_analysis_id
     or v_short.review_id is distinct from p_screening_review_id then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  v_snapshot:=pg_catalog.jsonb_build_object(
    'contract','sc012b-release-source-v1',
    'companyId',p_company_id,
    'recruitmentId',v_rec.id,
    'applicationId',v_app.id,
    'positionId',v_pos.id,
    'analysisId',v_analysis.id,
    'screeningReviewId',v_review.id,
    'shortlistEntryId',v_short.id,
    'applicationStatus',v_app.status,
    'applicationUpdatedAt',v_app.updated_at,
    'recruitmentStatus',v_rec.status,
    'recruitmentUpdatedAt',v_rec.updated_at,
    'positionStatus',v_pos.status,
    'positionUpdatedAt',v_pos.updated_at,
    'positionTitle',v_pos.title,
    'positionTasks',to_jsonb(v_pos.tasks),
    'positionKpis',to_jsonb(v_pos.kpis),
    'positionBehaviors',to_jsonb(v_pos.required_behaviors),
    'positionCompetencies',to_jsonb(v_pos.required_competencies),
    'documentId',v_doc_id,
    'documentVersion',v_doc_version,
    'inputFingerprint',v_analysis.input_fingerprint,
    'analysisContractHash',v_analysis.analysis_contract_hash,
    'templateVersion',p_template_version,
    'envelopeHash',p_envelope_hash);
  return pg_catalog.jsonb_build_object(
    'sourceHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::text,'UTF8')),'hex'),
    'sourceSnapshot',v_snapshot);
end;
$$;
revoke all on function private.sc012b_recompute_release_source(
  uuid,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;

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
  v_plan public.voice_plan_versions%rowtype;
  v_owner uuid;
  v_role text;
  v_latest_review record;
  v_current record;
  v_digest text;
  v_existing record;
  v_live jsonb;
  v_new_release uuid;
  v_release_version bigint;
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
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_plan.company_id::text||':'||actor::text||':release:'||p_request_key::text,0));
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
  select p.* into v_plan from public.voice_plan_versions p
    where p.id=p_plan_id and p.company_id=v_plan.company_id for share nowait;
  if not found then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  if exists(select 1 from public.voice_plan_versions p
     where p.company_id=v_plan.company_id and p.application_id=v_plan.application_id
       and p.plan_version>v_plan.plan_version) then
    raise exception using errcode='PT409',message='VOICE_PLAN_SUPERSEDED';
  end if;
  select r.id,r.review_version,r.decision,r.source_hash,
         r.retention_policy_version,r.retention_deadline
    into v_latest_review
    from private.voice_plan_review_entries r
    where r.company_id=v_plan.company_id and r.plan_id=p_plan_id
    order by r.review_version desc limit 1 for share nowait;
  if not found or v_latest_review.id is distinct from p_expected_review_id
     or v_latest_review.decision<>'approved'
     or v_latest_review.source_hash is distinct from v_plan.source_hash then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_STALE';
  end if;
  if v_plan.retention_deadline<=pg_catalog.now()
     or v_latest_review.retention_deadline<=pg_catalog.now()
     or v_plan.retention_policy_version is distinct from v_latest_review.retention_policy_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_RETENTION_EXPIRED';
  end if;
  v_live:=private.sc012b_recompute_release_source(
    v_plan.company_id,v_plan.application_id,v_plan.analysis_id,v_plan.screening_review_id,
    v_plan.shortlist_entry_id,v_plan.template_version,v_plan.envelope_hash);
  if v_plan.source_hash is distinct from v_live->>'sourceHash'
     or v_plan.source_snapshot is distinct from v_live->'sourceSnapshot'
     or p_expected_source_hash is distinct from v_live->>'sourceHash' then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
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
  v_release_version:=coalesce(p_expected_pointer_version,0)+1;
  insert into private.voice_plan_release_entries
    (company_id,application_id,plan_id,approved_review_id,release_version,
     source_hash,released_by,retention_policy_version,retention_deadline)
  values(v_plan.company_id,v_plan.application_id,p_plan_id,p_expected_review_id,v_release_version,
     v_plan.source_hash,actor,v_plan.retention_policy_version,v_plan.retention_deadline)
  returning id into v_new_release;
  if p_expected_pointer_version is null then
    insert into private.voice_plan_current_releases
      (company_id,application_id,plan_id,release_entry_id,pointer_version)
    values(v_plan.company_id,v_plan.application_id,p_plan_id,v_new_release,1);
  else
    update private.voice_plan_current_releases
      set plan_id=p_plan_id,release_entry_id=v_new_release,
          pointer_version=p_expected_pointer_version+1,updated_at=pg_catalog.now()
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

-- Derived freshness. The pointer row is not deleted; a stale source, withdrawn
-- template, removed shortlist or expired retention makes it unusable.
create or replace function private.sc012b_effective_release(p_application_id uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  v_company uuid;
  v_pointer record;
  v_plan public.voice_plan_versions%rowtype;
  v_release private.voice_plan_release_entries%rowtype;
  v_review record;
  v_live jsonb;
begin
  if actor is null or p_application_id is null then
    raise exception using errcode='22023',message='VOICE_PLAN_INVALID_RELEASE';
  end if;
  select a.company_id into v_company from public.applications a where a.id=p_application_id;
  if not found or not private.has_company_access(v_company,false) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('screening:'||p_application_id::text,0));
  select c.company_id,c.plan_id,c.release_entry_id,c.pointer_version into v_pointer
    from private.voice_plan_current_releases c
    where c.company_id=v_company and c.application_id=p_application_id
    for share nowait;
  if not found then return null; end if;
  select * into v_plan from public.voice_plan_versions p
    where p.id=v_pointer.plan_id and p.company_id=v_company for share nowait;
  select * into v_release from private.voice_plan_release_entries r
    where r.id=v_pointer.release_entry_id and r.company_id=v_company for share nowait;
  select r.id,r.decision,r.retention_policy_version,r.retention_deadline into v_review
    from private.voice_plan_review_entries r
    where r.company_id=v_company and r.plan_id=v_plan.id
    order by r.review_version desc limit 1 for share nowait;
  if not found or v_review.id is distinct from v_release.approved_review_id
     or v_review.decision<>'approved' then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_STALE';
  end if;
  if v_plan.retention_deadline<=pg_catalog.now()
     or v_release.retention_deadline<=pg_catalog.now()
     or v_review.retention_deadline<=pg_catalog.now()
     or v_plan.retention_policy_version is distinct from v_review.retention_policy_version
     or v_release.retention_policy_version is distinct from v_plan.retention_policy_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_RETENTION_EXPIRED';
  end if;
  v_live:=private.sc012b_recompute_release_source(
    v_plan.company_id,v_plan.application_id,v_plan.analysis_id,v_plan.screening_review_id,
    v_plan.shortlist_entry_id,v_plan.template_version,v_plan.envelope_hash);
  if v_plan.source_hash is distinct from v_live->>'sourceHash'
     or v_plan.source_snapshot is distinct from v_live->'sourceSnapshot'
     or v_release.source_hash is distinct from v_live->>'sourceHash' then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  return v_pointer.release_entry_id;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
revoke all on function private.sc012b_effective_release(uuid) from public,anon,authenticated;
