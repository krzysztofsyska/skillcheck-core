-- SC-014-C6 step 3a: recruiter review and approval through the public Data API.
-- No generation, edit, rejection, provider invocation or feature activation.
-- Supabase CLI unavailable during authoring; forward version follows 140000.
begin;
do $preflight$ begin
 if not exists(select 1 from private.erasure_inventory_baseline_r14 where singleton and schema_signature='75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688')
  or private.erasure_schema_signature() is distinct from '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688' then
  raise exception 'c6_api_requires_reviewed_r14' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.competency_authority(uuid,boolean)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b4884b0b80c63f87760da2edfaf8d7d0eaa79b88067065f8ce2a08ad84519894' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'c6_api_dependency_unreviewed:private.competency_authority(uuid,boolean)' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='exercise_ai.approve_proposal(uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='0ff36b910150b80c6911c3accc617e28070da4b7405d0e0147eb77e2cc7f8e58' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'c6_api_dependency_unreviewed:exercise_ai.approve_proposal(uuid)' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.competency_eligible(public.applications,uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='049330d807c11f0d61ea3de962f33784851e0e5942ee488e71a5ffb25ff99dc5' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'c6_api_dependency_unreviewed:private.competency_eligible(public.applications,uuid)' using errcode='55000';end if;
end $preflight$;

-- Read one exact immutable revision, never the latest/current position profile.
-- Authority locks make membership removal serialize with the entire RPC.
create function public.read_exercise_ai_proposal(target_company uuid,target_recruitment uuid,target_definition uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.competency_authority(target_company);
 select jsonb_build_object('definitionEntry',to_jsonb(e),'proposal',jsonb_build_object(
  'id',p.id,'provenance',p.provenance,'createdBy',p.created_by,'createdAt',p.created_at,
  'approvedBy',p.approved_by,'approvedAt',p.approved_at,'approvalMode',p.approval_mode)) into result
 from public.exercise_definition_entries e
 join public.recruitments r on r.company_id=e.company_id and r.id=e.recruitment_id and r.position_id=e.position_id
 join exercise_ai.proposals p on p.company_id=e.company_id and p.recruitment_id=e.recruitment_id and p.definition_entry_id=e.id
 where e.company_id=target_company and e.recruitment_id=target_recruitment and e.id=target_definition;
 if result is null then raise exception 'Resource unavailable' using errcode='PT404';end if;
 return result;
end;$$;

-- The expected timestamp identifies the snapshot the recruiter actually read.
-- A newer current profile does not rewrite that historical snapshot. All status,
-- lifecycle and idempotency checks remain in the existing approval function.
create function public.approve_exercise_ai_proposal(target_company uuid,target_recruitment uuid,target_definition uuid,
 expected_position_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare review jsonb;
begin
 review:=public.read_exercise_ai_proposal(target_company,target_recruitment,target_definition);
 if expected_position_updated_at is null or expected_position_updated_at is distinct from
  (review->'definitionEntry'->>'position_updated_at')::timestamptz then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 return exercise_ai.approve_proposal(target_definition);
end;$$;

-- Remove default grants, including hostile defaults to roles outside the app.
alter function public.read_exercise_ai_proposal(uuid,uuid,uuid) owner to postgres;
alter function public.approve_exercise_ai_proposal(uuid,uuid,uuid,timestamptz) owner to postgres;
do $acl$ declare o record;g record;begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'public.read_exercise_ai_proposal(uuid,uuid,uuid)'::regprocedure,
  'public.approve_exercise_ai_proposal(uuid,uuid,uuid,timestamptz)'::regprocedure]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
   join pg_roles r on r.oid=a.grantee where p.oid=o.oid and a.grantee<>o.proowner loop
   execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);
  end loop;
 end loop;
end $acl$;
grant execute on function public.read_exercise_ai_proposal(uuid,uuid,uuid),
 public.approve_exercise_ai_proposal(uuid,uuid,uuid,timestamptz) to authenticated;
do $postflight$ begin
 if private.erasure_schema_signature() is distinct from '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688' then
  raise exception 'c6_api_inventory_changed' using errcode='55000';end if;
 if (select count(*) from pg_proc where oid=any(array[
  'public.read_exercise_ai_proposal(uuid,uuid,uuid)'::regprocedure,
  'public.approve_exercise_ai_proposal(uuid,uuid,uuid,timestamptz)'::regprocedure])
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
  and proacl::text='{postgres=X/postgres,authenticated=X/postgres}')<>2 then
  raise exception 'c6_api_acl_mismatch' using errcode='55000';end if;
end $postflight$;
commit;
