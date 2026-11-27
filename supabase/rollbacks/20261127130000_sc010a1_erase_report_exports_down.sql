-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R0 SC-010a-1 (20261127130000_sc010a1_erase_report_exports.sql).
-- Restores the two erasure wrappers from 20261010205030 (plain calls of the purge
-- engine, same owner, grants and signatures) and drops the report export helper.
-- Export log rows already deleted by an erasure are not brought back (they belong
-- to erased candidates). After this rollback a new erasure again leaves its export
-- log rows behind (the gap of issue #619).
-- Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if to_regprocedure('private.sc010a1_erase_report_exports(uuid,uuid[])') is null then
  raise exception 'sc010a1_rollback_not_installed' using errcode='55000';end if;
 perform set_config('sc010a1.purge_acl',(select proacl::text from pg_proc where oid='private.purge_candidate_erasure(uuid,bigint)'::regprocedure),true);
 perform set_config('sc010a1.restore_acl',(select proacl::text from pg_proc where oid='private.restore_purge_candidate_erasure(uuid,bigint)'::regprocedure),true);
 perform set_config('sc010a1.signature_before',private.erasure_schema_signature(),true);
end $guard$;

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
   if current_user<>'postgres' then raise exception 'Unsafe purge owner migration membership';end if;
   grant erasure_purge_owner to postgres with admin false, inherit false, set true;
 end if;
 grant create on schema private to erasure_purge_owner;
end;$$;

set local role erasure_purge_owner;
create or replace function private.purge_candidate_erasure(target_request uuid,expected_sequence bigint) returns jsonb
language sql volatile security definer set search_path='' as $$
 select private.erasure_purge_engine(target_request,expected_sequence,false)
$$;
create or replace function private.restore_purge_candidate_erasure(target_request uuid,expected_sequence bigint) returns jsonb
language sql volatile security definer set search_path='' as $$
 select private.erasure_purge_engine(target_request,expected_sequence,true)
$$;
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

drop function private.sc010a1_erase_report_exports(uuid,uuid[]);

do $postflight$
begin
 if (select proacl::text from pg_proc where oid='private.purge_candidate_erasure(uuid,bigint)'::regprocedure) is distinct from current_setting('sc010a1.purge_acl',true)
  or (select proacl::text from pg_proc where oid='private.restore_purge_candidate_erasure(uuid,bigint)'::regprocedure) is distinct from current_setting('sc010a1.restore_acl',true)
  or private.erasure_schema_signature() is distinct from current_setting('sc010a1.signature_before',true) then
  raise exception 'sc010a1_rollback_state_changed' using errcode='55000';end if;
end $postflight$;

commit;
