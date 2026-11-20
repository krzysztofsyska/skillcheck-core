-- R6-2 (ROADMAP R6, "Podpięcie do limitów pakietów"): the recruiter screen checks
-- the voice interview pool and the monthly voice cost cap when an interview is
-- ordered. Shown only behind the server-side voice preview flag
-- (lib/voice/plan-preview.ts: never on in a Vercel Production deployment).
--
-- Adds ONE function, public.voice_interview_order_check(company, recruitment,
-- application), the only way the authenticated application reaches the
-- owner-only pool and cost-cap functions. It returns two values and nothing else:
--  * available        - interviews left in the company's pool (FREE 1, paid
--                       packages 10 each), after the idempotent package pool sync
--                       (private.sc19_voice_sync_package_pools: it only turns
--                       packages the company really has into pools, never twice);
--  * cost_cap_blocked - true when the SkillCheck-wide monthly voice cost cap
--                       (50 zł, voice_budget) leaves no room for one more call.
--                       Only this boolean leaves voice_budget: no amounts, no
--                       other company's data.
--
-- Access control in the database (same as the voice transcript reader):
--  * signed-in company owner or recruiter (private.has_company_access(..., true));
--    a viewer, another company's member and an unknown application get the same
--    42501;
--  * the application exists under this company and recruitment;
--  * candidate data not frozen or being erased and the application not withdrawn
--    (55000).
--
-- What it does NOT do: it reserves no unit, writes no preparation, dispatch claim
-- or cost charge, calls no provider and sends nothing. Reservation, settlement and
-- refund stay in the trusted-server preparation (lib/voice/offline-preparation.ts)
-- and the R20/R21 dispatch path, which also re-check the pool and the cost cap
-- under their own locks. This is a check for the recruiter's message only.
--
-- Erasure signature: only a function is added in 'public' (no relation, column,
-- constraint or trigger), preflight remembers the signature and postflight
-- requires it unchanged. Execute for authenticated only; voice_budget and the
-- pool stay closed to API roles. Paired rollback:
-- supabase/rollbacks/20261121170000_r6_voice_order_check_down.sql.
begin;

do $preflight$
begin
 if to_regprocedure('public.voice_interview_order_check(uuid,uuid,uuid)') is not null then
  raise exception 'r6_voice_order_check_already_installed' using errcode='55000';end if;
 if to_regprocedure('private.sc19_voice_sync_package_pools(uuid)') is null
  or to_regprocedure('private.sc19_voice_interview_balance(uuid)') is null
  or to_regprocedure('voice_budget.month_status(timestamptz)') is null
  or to_regprocedure('private.has_company_access(uuid,boolean)') is null
  or to_regprocedure('private.candidate_workflow_visible(uuid,uuid)') is null
  or to_regprocedure('private.erasure_schema_signature()') is null then
  raise exception 'r6_voice_order_check_dependency_missing' using errcode='55000';end if;
 perform set_config('r6_voice_order_check.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

create function public.voice_interview_order_check(
 target_company uuid,
 target_recruitment uuid,
 target_application uuid
) returns table(available integer, cost_cap_blocked boolean)
language plpgsql volatile security definer set search_path='' as $$
declare
 actor uuid:=(select auth.uid());
 subject uuid;
 application_status text;
 left_in_pool integer;
 blocked boolean;
begin
 if actor is null or target_company is null or target_recruitment is null or target_application is null
  or not private.has_company_access(target_company,true) then
  raise exception 'voice_order_forbidden' using errcode='42501';end if;
 select a.candidate_id,a.status into subject,application_status
  from public.applications a
  where a.company_id=target_company and a.recruitment_id=target_recruitment and a.id=target_application;
 if not found then raise exception 'voice_order_forbidden' using errcode='42501';end if;
 if not private.candidate_workflow_visible(target_company,subject) or application_status='withdrawn' then
  raise exception 'voice_order_withdrawn' using errcode='55000';end if;

 perform private.sc19_voice_sync_package_pools(target_company);
 select b.available into left_in_pool from private.sc19_voice_interview_balance(target_company) b;
 select s.new_calls_blocked into blocked from voice_budget.month_status(clock_timestamp()) s;
 -- Fail closed: a missing row means no interview and no room under the cap.
 return query select coalesce(left_in_pool,0),coalesce(blocked,true);
end;
$$;

do $grants$
declare fn text:='public.voice_interview_order_check(uuid,uuid,uuid)';g record;
begin
 execute format('revoke all on function %s from public',fn);
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  join pg_roles r on r.oid=a.grantee
  where p.oid=fn::regprocedure and a.grantee<>p.proowner loop
  execute format('revoke all on function %s from %I',fn,g.rolname);
 end loop;
 execute format('grant execute on function %s to authenticated',fn);
end $grants$;

do $postflight$
declare r text;
begin
 if private.erasure_schema_signature() is distinct from current_setting('r6_voice_order_check.signature_before',true) then
  raise exception 'r6_voice_order_check_inventory_changed:%',private.erasure_schema_signature() using errcode='55000';end if;
 if not exists(select 1 from pg_proc p where p.oid='public.voice_interview_order_check(uuid,uuid,uuid)'::regprocedure
  and p.prosecdef and p.proconfig=array['search_path=""']) then
  raise exception 'r6_voice_order_check_unhardened' using errcode='55000';end if;
 foreach r in array array['anon','service_role','screening_worker'] loop
  if to_regrole(r) is not null and has_function_privilege(r,'public.voice_interview_order_check(uuid,uuid,uuid)','execute') then
   raise exception 'r6_voice_order_check_exposed:%',r using errcode='55000';end if;
 end loop;
 -- The pool, its functions and the cost-cap schema stay closed to API roles.
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is null then continue;end if;
  if has_schema_privilege(r,'voice_budget','usage')
   or has_function_privilege(r,'private.sc19_voice_sync_package_pools(uuid)','execute')
   or has_function_privilege(r,'private.sc19_voice_interview_balance(uuid)','execute')
   or has_table_privilege(r,'private.sc19_voice_entitlements','select,insert,update,delete') then
   raise exception 'r6_voice_order_check_pool_exposed:%',r using errcode='55000';end if;
 end loop;
end $postflight$;

commit;
