-- R6-1c (part 8): the last pieces of SC-010-R4-VOICE (voice erasure and
-- retention) as a real migration. Generated offline by
-- scripts/r6-voice-retention-compose.mjs from the reviewed isolated source
-- db/isolated/sc010-r4-voice-retention.sql on top of R23.
-- R18 and R19 already installed the module's voice adapters, guards, purge
-- order, refund and quota lock. This step adds the two remaining differences,
-- byte for byte from the isolated source:
--  - the purge manifest and the retention authorization refuse a tenant with a
--    voice plan request key whose result cannot be resolved in that company
--    (PT409 'Unknown voice request dependency'), as the erasure preview already
--    does;
--  - an UPDATE that changes nothing no longer restarts a candidate's retention
--    clock (an idempotent replay keeps data no longer than before).
-- No table, column, constraint, trigger, row or grant changes: the erasure
-- schema signature and inventory stay R23. Nothing is deleted by this migration,
-- nothing is used by the application, nothing is granted to anon,
-- authenticated or service_role, and no package, price or order state is touched.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r23') is null or to_regclass('private.sc011b_voice_transcripts') is null
  or to_regclass('private.voice_plan_request_keys') is null then
  raise exception 'voice_retention_requires_r23' using errcode='55000';end if;
 -- A second run finds the reviewed bodies already installed and stops.
 if exists(select 1 from pg_proc where oid in ('private.erasure_check_purge_scope(uuid)'::regprocedure,'private.retention_observe_candidate()'::regprocedure)
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex') in ('61ca047789d5c25d2520f740530fd776dae561245ac2f120033d5b204863fec9','ba5b24f9ff4d18a3c1137d47de4139cd1fa77e223e3a06e5ecb80c6487315dcd')) then
  raise exception 'voice_retention_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r23 where singleton and schema_signature='4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7')
  or private.erasure_schema_signature() is distinct from '4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7' then
  raise exception 'voice_retention_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r23 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_retention_source_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_check_purge_scope(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4a1d8bfdf36e3764b6804fe79913b9dbca3e24632f9bf3d0fd02c25c172f9270'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and provolatile='v' and proconfig=array['search_path=""']
  and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_retention_source_function_unreviewed:private.erasure_check_purge_scope' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.retention_observe_candidate()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='bbaf5f82859736867425161dee7f4f95e826d9c288606a006ed7aaf4d7e5aee7'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and provolatile='v' and proconfig=array['search_path=""']
  and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_retention_source_function_unreviewed:private.retention_observe_candidate' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_voice_request_candidate(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='485aa357990424dd628b10977a018711dd91d3831a7e4ee47dd46ac3d4608ae7'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
  and not has_function_privilege('public','private.erasure_voice_request_candidate(uuid,text,uuid)'::regprocedure,'execute')) then
  raise exception 'voice_retention_source_function_unreviewed:private.erasure_voice_request_candidate' using errcode='55000';end if;
 -- Remember how many triggers observe retention; the postflight requires the same.
 perform set_config('r6_voice_retention.observers',(select count(*)::text from pg_trigger
  where tgfoid='private.retention_observe_candidate()'::regprocedure and not tgisinternal),true);
end $preflight$;

-- SC-010-R4-VOICE purge scope (source: db/isolated/sc010-r4-voice-retention.sql).
create or replace function private.erasure_check_purge_scope(target_request uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare e private.erasure_executions;r record;refs uuid[];
begin
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.candidates where company_id=e.company_id and id=any(e.candidate_ids) order by id for update nowait;
 if exists(select 1 from private.erasure_subject_resolutions where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids)
 or exists(select 1 from private.erasure_preview_tickets where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids)
 or exists(select 1 from private.erasure_requests where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids)
 or exists(select 1 from private.erasure_executions x where x.company_id=e.company_id and x.candidate_ids && e.candidate_ids and not x.candidate_ids <@ e.candidate_ids and exists(select 1 from private.erasure_holds h where h.request_id=x.request_id)) then
  raise exception using errcode='PT409',message='Shared administrative scope requires separate adapter';end if;
 if exists(select 1 from private.retention_suggestions where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids) then
  raise exception using errcode='PT409',message='Shared retention scope requires separate adapter';end if;
 if exists(select 1 from private.contact_requests where company_id=e.company_id and private.erasure_contact_request_candidate(company_id,operation,payload,result_id) is null) then
  raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 if exists(select 1 from private.voice_plan_request_keys t where t.company_id=e.company_id and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null) then raise exception using errcode='PT409',message='Unknown voice request dependency';end if;
 for r in select * from private.erasure_purge_rows(e.company_id,e.candidate_ids) loop
  if r.adapter not like 'private.erasure_%' then
   if r.adapter='private.retention_candidate_clocks' then refs:=array[(r.row_data->>'candidate_id')::uuid];
   elsif r.adapter='private.retention_suggestions' then select array_agg(value::uuid) into refs from jsonb_array_elements_text(r.row_data->'candidate_ids');
   else refs:=private.erasure_row_candidates(r.adapter,r.row_data);end if;
   if not refs <@ e.candidate_ids then raise exception using errcode='PT409',message='Shared candidate scope requires separate adapter';end if;
  end if;
 end loop;
 -- Self-FK SET NULL must never mutate another candidate when deleting an analysis.
 if exists(select 1 from public.screening_analysis_versions a join public.applications app on app.id=a.application_id
 where a.company_id=e.company_id and not app.candidate_id=any(e.candidate_ids)
 and a.superseded_by_analysis_id in(select (row_data->>'id')::uuid from private.erasure_purge_rows(e.company_id,e.candidate_ids) where adapter='public.screening_analysis_versions')) then
 raise exception using errcode='PT409',message='Shared analysis scope requires separate adapter';end if;
 -- Actual external provider resources require a real delete/reconcile adapter.
 if exists(select 1 from private.erasure_purge_rows(e.company_id,e.candidate_ids) external_row where
 external_row.adapter in ('public.screening_analysis_versions','public.screening_analysis_attempts') and (nullif(external_row.row_data->>'provider_request_id','') is not null or nullif(external_row.row_data->>'provider_response_id','') is not null)) then
 raise exception using errcode='PT409',message='External resource adapter required';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Erasure source busy';end;$$;

-- SC-010-R4-VOICE retention observer (source: db/isolated/sc010-r4-voice-retention.sql).
create or replace function private.retention_observe_candidate() returns trigger language plpgsql security definer set search_path='' as $$
declare ids uuid[];subject uuid;tenant uuid;begin
 if tg_op='UPDATE' and to_jsonb(new)=to_jsonb(old) then return new;end if;
 if exists(select 1 from private.erasure_purge_context where txid=txid_current()) then return coalesce(new,old);end if;
 if tg_table_name='positions' then
  select array_agg(distinct a.candidate_id order by a.candidate_id) into ids from public.applications a join public.recruitments r on r.id=a.recruitment_id where r.position_id=coalesce(new.id,old.id);
 elsif tg_table_name in ('assessment_stages','exercise_definition_entries') then
  select array_agg(distinct candidate_id order by candidate_id) into ids from public.applications where recruitment_id=coalesce(new.recruitment_id,old.recruitment_id);
 elsif tg_table_name='recruitments' then
  if tg_op='UPDATE' and new.status is not distinct from old.status then return new;end if;
  select array_agg(distinct candidate_id order by candidate_id) into ids from public.applications where recruitment_id=coalesce(new.id,old.id);
 else ids:=private.erasure_row_candidates(tg_table_schema||'.'||tg_table_name,case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end);end if;
 foreach subject in array coalesce(ids,'{}'::uuid[]) loop
  select company_id into tenant from public.candidates where id=subject;
  if tenant is not null then
   insert into private.retention_candidate_clocks(candidate_id,company_id) values(subject,tenant)
   on conflict(candidate_id) do update set observed_at=clock_timestamp(),closed_at=null,consent_at=null,generation=retention_candidate_clocks.generation+1;
  end if;
 end loop;return coalesce(new,old);
end;$$;

-- create or replace keeps the owner and the owner-only ACL; re-assert that no
-- other role can execute either function.
do $acl$
declare o record;g record;
begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.erasure_check_purge_scope(uuid)','private.retention_observe_candidate()']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7' then
  raise exception 'voice_retention_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r23 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_retention_final_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_check_purge_scope(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='61ca047789d5c25d2520f740530fd776dae561245ac2f120033d5b204863fec9'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and provolatile='v' and proconfig=array['search_path=""']
  and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_retention_final_function_mismatch:private.erasure_check_purge_scope' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.retention_observe_candidate()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='ba5b24f9ff4d18a3c1137d47de4139cd1fa77e223e3a06e5ecb80c6487315dcd'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and provolatile='v' and proconfig=array['search_path=""']
  and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_retention_final_function_mismatch:private.retention_observe_candidate' using errcode='55000';end if;
 if (select count(*)::text from pg_trigger where tgfoid='private.retention_observe_candidate()'::regprocedure and not tgisinternal)
  is distinct from current_setting('r6_voice_retention.observers',true) then
  raise exception 'voice_retention_observers_changed' using errcode='55000';end if;
 -- Deny by default: no API role can execute either function.
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array['private.erasure_check_purge_scope(uuid)','private.retention_observe_candidate()']::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_retention_function_exposed' using errcode='55000';end if;
end $postflight$;
commit;
