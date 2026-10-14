-- SC-012-B synthetic TEST-ONLY CAS helper.
-- Not installed by migrations, not exposed through PostgREST, not an authorized RPC.
-- This models one atomic history+pointer transaction to validate competing writers.
create or replace function private.sc012b_test_release_cas(
  p_company uuid,p_application uuid,p_plan uuid,p_review uuid,
  p_expected_pointer bigint,p_expected_release uuid,p_actor uuid
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  current_version bigint;
  current_release uuid;
  plan_hash text;
  new_release uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || ':' || p_application::text,0));
  select pointer_version,release_entry_id into current_version,current_release
    from private.voice_plan_current_releases
    where company_id=p_company and application_id=p_application for update;
  if found then
    if p_expected_pointer is distinct from current_version or
       p_expected_release is distinct from current_release then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
  elsif p_expected_pointer is not null or p_expected_release is not null then
    raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
  end if;
  select p.source_hash into plan_hash
    from public.voice_plan_versions p
    join private.voice_plan_review_entries r
      on r.company_id=p.company_id and r.application_id=p.application_id
      and r.plan_id=p.id and r.id=p_review
    where p.company_id=p_company and p.application_id=p_application
      and p.id=p_plan and r.decision='approved' and r.source_hash=p.source_hash;
  if plan_hash is null then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_CONFLICT';
  end if;
  insert into private.voice_plan_release_entries
    (company_id,application_id,plan_id,approved_review_id,release_version,
     source_hash,released_by,retention_policy_version,retention_deadline)
  values(p_company,p_application,p_plan,p_review,1,plan_hash,p_actor,
         'synthetic-v1','2030-01-01')
  returning id into new_release;
  if current_version is null then
    insert into private.voice_plan_current_releases
      (company_id,application_id,plan_id,release_entry_id,pointer_version)
    values(p_company,p_application,p_plan,new_release,1);
  else
    update private.voice_plan_current_releases
      set plan_id=p_plan,release_entry_id=new_release,
          pointer_version=current_version+1,updated_at=now()
      where company_id=p_company and application_id=p_application
        and pointer_version=current_version and release_entry_id=current_release;
    if not found then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
  end if;
  return new_release;
end;
$$;
revoke all on function private.sc012b_test_release_cas(
  uuid,uuid,uuid,uuid,bigint,uuid,uuid) from public,anon,authenticated;
