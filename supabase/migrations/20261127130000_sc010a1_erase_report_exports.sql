-- R0 SC-010a-1 (issue #619): a candidate erasure also removes that candidate's
-- report export log rows in `report_audit.candidate_report_exports`.
--
-- Gap (found by tests/sc010a-consent-erasure-database.test.mjs, PR #618): the
-- export log (SC-015-D, 20261116120000) lives in schema `report_audit`, outside
-- the SC-010 erasure inventory (public/private only), and its only delete path
-- is company-wide (`report_audit.purge_company`). After the real purge path ran,
-- the erased application's log rows survived. They hold ids only (company,
-- recruitment, application, actor, kind, analysis version), no name or text,
-- but the application id is a link to an erased person, so they go too.
--
-- Choice (safer data minimisation): DELETE the rows, not de-identify them.
-- Nulling `application_id` would need a schema change on an append-only log
-- whose readers (SC-015-D2/D3) join on it, and the row would still say "someone
-- in this recruitment was exported by this actor at this time".
--
-- How, without touching the SC-010 inventory or the purge engine:
--  * `private.sc010a1_erase_report_exports(company, application ids)` — owned by
--    the migration role (owner of the log), security definer, executable only by
--    `erasure_purge_owner`. Deletes only rows of that company AND of those
--    applications, through the existing narrow guard exception
--    (`report_audit.purge_company`, set locally and restored right after). Refuses
--    while any of those applications still exists (fail closed).
--  * the two erasure entry points `private.purge_candidate_erasure` and
--    `private.restore_purge_candidate_erasure` (thin wrappers of
--    `private.erasure_purge_engine`, unchanged since 20261010205030) now: lock the
--    execution row (same first lock the engine takes, so no new lock order), read
--    the application ids from the validated purge manifest, run the engine
--    unchanged, check the engine really deleted exactly those applications, then
--    call the helper. Same transaction: if anything fails, nothing is erased.
--    Signatures, owner (`erasure_purge_owner`), security definer, search_path and
--    grants stay as they were. The returned jsonb is unchanged.
--  * `private.erasure_schema_signature()` is unchanged (no relation, column,
--    constraint or trigger in public/private changes), so the SC-010 inventory
--    baselines and any later inventory migration (R24) are unaffected; the engine
--    is not replaced.
--
-- `report_audit.assessment_center_session_exports` was checked the same way: it
-- holds company, recruitment, session and actor ids only (an AC session is a
-- group event, not one candidate), so it has no candidate link to erase.
--
-- Not done here: rows of candidates erased BEFORE this migration (deleting real
-- data in production is the owner's decision); the erasure preview does not list
-- the export log count. Nothing for anon/authenticated/service_role, no schema
-- usage on `report_audit` for any API role, nothing sent.
begin;

do $preflight$
begin
 if to_regclass('report_audit.candidate_report_exports') is null
  or to_regprocedure('report_audit.purge_allowed(uuid)') is null
  or to_regprocedure('private.erasure_purge_engine(uuid,bigint,boolean)') is null
  or to_regprocedure('private.purge_candidate_erasure(uuid,bigint)') is null
  or to_regprocedure('private.restore_purge_candidate_erasure(uuid,bigint)') is null
  or to_regclass('private.erasure_purge_manifest') is null or to_regclass('private.erasure_executions') is null
  or to_regrole('erasure_purge_owner') is null or to_regprocedure('private.erasure_schema_signature()') is null then
  raise exception 'sc010a1_dependency_missing' using errcode='55000';end if;
 if to_regprocedure('private.sc010a1_erase_report_exports(uuid,uuid[])') is not null then
  raise exception 'sc010a1_already_installed' using errcode='55000';end if;
 -- Replace only the reviewed wrapper bodies from 20261010205030.
 if not exists(select 1 from pg_proc where oid='private.purge_candidate_erasure(uuid,bigint)'::regprocedure
   and prolang=(select oid from pg_language where lanname='sql') and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef
   and regexp_replace(prosrc,'\s+',' ','g')=' select private.erasure_purge_engine(target_request,expected_sequence,false) ')
  or not exists(select 1 from pg_proc where oid='private.restore_purge_candidate_erasure(uuid,bigint)'::regprocedure
   and prolang=(select oid from pg_language where lanname='sql') and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef
   and regexp_replace(prosrc,'\s+',' ','g')=' select private.erasure_purge_engine(target_request,expected_sequence,true) ') then
  raise exception 'sc010a1_wrapper_unreviewed' using errcode='55000';end if;
 -- The log is read by its owner; the helper relies on that, never on FORCE RLS.
 if (select relforcerowsecurity from pg_class where oid='report_audit.candidate_report_exports'::regclass)
  or (select pg_get_userbyid(relowner) from pg_class where oid='report_audit.candidate_report_exports'::regclass) is distinct from current_user then
  raise exception 'sc010a1_log_owner_unexpected' using errcode='55000';end if;
 perform set_config('sc010a1.signature_before',private.erasure_schema_signature(),true);
 perform set_config('sc010a1.purge_acl',(select proacl::text from pg_proc where oid='private.purge_candidate_erasure(uuid,bigint)'::regprocedure),true);
 perform set_config('sc010a1.restore_acl',(select proacl::text from pg_proc where oid='private.restore_purge_candidate_erasure(uuid,bigint)'::regprocedure),true);
end
$preflight$;

-- Deletes the export log rows of erased applications of one company. Called only
-- by the two erasure wrappers below (as erasure_purge_owner), after the engine has
-- deleted those applications in the same transaction.
create function private.sc010a1_erase_report_exports(target_company uuid,target_applications uuid[]) returns bigint
language plpgsql volatile security definer set search_path='' as $$
declare removed bigint;previous text;
begin
 if coalesce(cardinality(target_applications),0)=0 then return 0;end if;
 if target_company is null or array_position(target_applications,null) is not null then
  raise exception using errcode='PT409',message='Invalid report export erasure scope';end if;
 if exists(select 1 from public.applications a where a.id=any(target_applications)) then
  raise exception using errcode='PT409',message='Erased application still present';end if;
 previous:=pg_catalog.current_setting('report_audit.purge_company',true);
 perform pg_catalog.set_config('report_audit.purge_company',target_company::text,true);
 delete from report_audit.candidate_report_exports e
  where e.company_id=target_company and e.application_id=any(target_applications);
 get diagnostics removed=row_count;
 perform pg_catalog.set_config('report_audit.purge_company',coalesce(previous,''),true);
 return removed;
end;$$;

do $acl$
declare recipient record;
begin
 execute 'revoke all on function private.sc010a1_erase_report_exports(uuid,uuid[]) from public cascade';
 for recipient in
  select distinct a.grantee from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid='private.sc010a1_erase_report_exports(uuid,uuid[])'::regprocedure and a.grantee<>0 and a.grantee<>p.proowner
 loop
  execute format('revoke all on function private.sc010a1_erase_report_exports(uuid,uuid[]) from %I cascade',pg_get_userbyid(recipient.grantee));
 end loop;
 grant execute on function private.sc010a1_erase_report_exports(uuid,uuid[]) to erasure_purge_owner;
end
$acl$;

-- The wrappers are owned by erasure_purge_owner. Same confined ownership step as
-- 20261120120000 (R23): PG16+ non-superuser creators retain ADMIN only, so the
-- migration takes SET plus schema CREATE for this transaction and restores both.
create temporary table sc010_purge_migration_access on commit drop as
 select (select rolsuper from pg_roles where rolname=current_user) superuser,
   (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    from pg_auth_members m where m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole) memberships,
   (select nspacl from pg_namespace where nspname='private') schema_acl;
do $$begin
 if current_user<>session_user then raise exception 'Migration identity must be direct';end if;
 if has_schema_privilege('erasure_purge_owner','private','CREATE') then
   raise exception 'Unsafe purge owner schema privileges';
 end if;
 if not (select superuser from pg_temp.sc010_purge_migration_access) then
   if current_user<>'postgres' or exists(select 1 from pg_auth_members m
     where (m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole)
       and not (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid='erasure_purge_owner'::regrole and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option)) or not exists(select 1 from pg_auth_members m where (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid='erasure_purge_owner'::regrole and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option)) then
     raise exception 'Unsafe purge owner migration membership';
   end if;
   grant erasure_purge_owner to postgres with admin false, inherit false, set true;
 end if;
 grant create on schema private to erasure_purge_owner;
end;$$;

set local role erasure_purge_owner;

create or replace function private.purge_candidate_erasure(target_request uuid,expected_sequence bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;manifest text;purged boolean;apps uuid[];result jsonb;
begin
 -- The engine's first lock, taken here first so the manifest read is stable.
 select e.company_id,e.manifest_hash,e.local_purged into tenant,manifest,purged from private.erasure_executions e
  where e.request_id=target_request for update nowait;
 select array_agg(m.row_key::uuid order by m.row_key) into apps from private.erasure_purge_manifest m
  where m.request_id=target_request and m.manifest_hash=manifest and m.adapter='public.applications';
 result:=private.erasure_purge_engine(target_request,expected_sequence,false);
 -- Already purged: the engine returned the stored receipt and deleted nothing.
 if purged then return result;end if;
 -- Fail closed: the engine must have deleted exactly the manifest applications.
 if coalesce((result->'counts'->>'public.applications')::bigint,0) is distinct from coalesce(cardinality(apps),0)::bigint then
  raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 perform private.sc010a1_erase_report_exports(tenant,apps);
 return result;
exception when lock_not_available then
 raise exception using errcode='PT409',message='Erasure source busy';
end;$$;

create or replace function private.restore_purge_candidate_erasure(target_request uuid,expected_sequence bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;manifest text;purged boolean;apps uuid[];result jsonb;
begin
 select e.company_id,e.manifest_hash,e.local_purged into tenant,manifest,purged from private.erasure_executions e
  where e.request_id=target_request for update nowait;
 select array_agg(m.row_key::uuid order by m.row_key) into apps from private.erasure_purge_manifest m
  where m.request_id=target_request and m.manifest_hash=manifest and m.adapter='public.applications';
 result:=private.erasure_purge_engine(target_request,expected_sequence,true);
 -- Already purged: the engine returned the stored receipt and deleted nothing.
 if purged then return result;end if;
 -- Fail closed: the engine must have deleted exactly the manifest applications.
 if coalesce((result->'counts'->>'public.applications')::bigint,0) is distinct from coalesce(cardinality(apps),0)::bigint then
  raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 perform private.sc010a1_erase_report_exports(tenant,apps);
 return result;
exception when lock_not_available then
 raise exception using errcode='PT409',message='Erasure source busy';
end;$$;

reset role;
do $$begin
 revoke create on schema private from erasure_purge_owner;
 if not (select superuser from pg_temp.sc010_purge_migration_access) then
   revoke erasure_purge_owner from postgres granted by postgres;
 end if;
 if (select nspacl from pg_namespace where nspname='private') is distinct from
      (select schema_acl from pg_temp.sc010_purge_migration_access) or
   has_schema_privilege('erasure_purge_owner','private','CREATE') or
   (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    from pg_auth_members m where m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole)
      is distinct from (select memberships from pg_temp.sc010_purge_migration_access) then
   raise exception 'Purge migration privileges not restored';
 end if;
end;$$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('sc010a1.signature_before',true) then
  raise exception 'sc010a1_inventory_changed:%',private.erasure_schema_signature() using errcode='55000';end if;
 if (select proacl::text from pg_proc where oid='private.purge_candidate_erasure(uuid,bigint)'::regprocedure) is distinct from current_setting('sc010a1.purge_acl',true)
  or (select proacl::text from pg_proc where oid='private.restore_purge_candidate_erasure(uuid,bigint)'::regprocedure) is distinct from current_setting('sc010a1.restore_acl',true) then
  raise exception 'sc010a1_wrapper_acl_changed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid in ('private.purge_candidate_erasure(uuid,bigint)'::regprocedure,'private.restore_purge_candidate_erasure(uuid,bigint)'::regprocedure)
   and (pg_get_userbyid(proowner)<>'erasure_purge_owner' or not prosecdef or proconfig is distinct from array['search_path=""'])) then
  raise exception 'sc010a1_wrapper_unsafe' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.sc010a1_erase_report_exports(uuid,uuid[])'::regprocedure
   and prosecdef and proconfig=array['search_path=""'])
  or exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
   where p.oid='private.sc010a1_erase_report_exports(uuid,uuid[])'::regprocedure and a.grantee<>p.proowner
    and a.grantee<>'erasure_purge_owner'::regrole) then
  raise exception 'sc010a1_helper_unsafe' using errcode='55000';end if;
 if exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role','screening_worker','erasure_worker','erasure_purge_owner')
   and has_schema_privilege(r.oid,'report_audit','USAGE')) then
  raise exception 'sc010a1_report_audit_exposed' using errcode='55000';end if;
end
$postflight$;

commit;
