-- R7: the voice cost cap owner alert, visible to the platform operator in the app
-- (owner decision 19.11.2026, docs/DECYZJE.md: voicebot up to 50 zł a month, new
-- calls stop and the owner is notified).
--
-- 20261121120000_r7_voice_cost_cap.sql records the alert only as a row in the
-- closed schema `voice_budget`; no API role can read it. This migration adds the
-- only read path for the operator panel (/operator/ai-costs), read-only:
--  * public.r7_operator_voice_cost_cap() — this month's numbers from
--    voice_budget.month_status(): cap, month-to-date cost, room left, whether new
--    calls are blocked, when the month's alert was recorded;
--  * public.r7_operator_voice_owner_alerts(result_limit) — the recorded owner
--    alerts from voice_budget.list_owner_alerts() (month, cause, cap, month-to-date
--    amount, time), at most 120 rows.
-- Both re-check the platform operator allowlist in the database
-- (private.sc19_require_operator(): 42501 'sc19_operator_forbidden' for anyone
-- else, including company owners and recruiters). They return amounts and months
-- only: no company, candidate, call or provider identifiers.
-- Execute is granted to `authenticated` only (the operator panel's logged-in
-- client); never to anon or service_role. Nothing is sent (no e-mail, SMS or any
-- outbound channel), nothing is written, the cap and the `voice_budget` schema are
-- unchanged and stay closed to API roles. Only two functions are added in
-- 'public', so the SC-010 erasure signature stays the same (checked at the end).
begin;

do $preflight$
begin
 if to_regprocedure('public.r7_operator_voice_cost_cap()') is not null
  or to_regprocedure('public.r7_operator_voice_owner_alerts(integer)') is not null then
  raise exception 'r7_voice_cost_cap_operator_view_already_installed' using errcode='55000';end if;
 if to_regprocedure('voice_budget.month_status(timestamp with time zone)') is null
  or to_regprocedure('voice_budget.list_owner_alerts(integer)') is null
  or to_regprocedure('private.sc19_require_operator()') is null
  or to_regprocedure('private.erasure_schema_signature()') is null then
  raise exception 'r7_voice_cost_cap_operator_view_dependency_missing' using errcode='55000';end if;
 perform set_config('r7_voice_cost_cap_operator_view.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

create function public.r7_operator_voice_cost_cap()
returns table(month date,cap_grosze integer,call_reserve_grosze integer,recorded_cost_grosze bigint,
 in_flight_grosze bigint,month_to_date_grosze bigint,remaining_grosze bigint,new_calls_blocked boolean,
 reserve_exceeded boolean,alert_recorded_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.sc19_require_operator();
 return query select s.month,s.cap_grosze,s.call_reserve_grosze,s.recorded_cost_grosze,s.in_flight_grosze,
  s.month_to_date_grosze,s.remaining_grosze,s.new_calls_blocked,s.reserve_exceeded,s.alert_recorded_at
  from voice_budget.month_status(pg_catalog.clock_timestamp()) s;
end;$$;

create function public.r7_operator_voice_owner_alerts(result_limit integer default 12)
returns table(month date,cause text,cap_grosze integer,month_to_date_grosze bigint,recorded_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.sc19_require_operator();
 return query select a.month,a.cause,a.cap_grosze,a.month_to_date_grosze,a.recorded_at
  from voice_budget.list_owner_alerts(result_limit) a;
end;$$;

-- Only the logged-in operator client; whatever default privileges the platform applies.
revoke all on function public.r7_operator_voice_cost_cap(),public.r7_operator_voice_owner_alerts(integer) from public;
do $acl$
declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null then
   execute pg_catalog.format('revoke all on function public.r7_operator_voice_cost_cap(),public.r7_operator_voice_owner_alerts(integer) from %I',r);
  end if;
 end loop;
 if to_regrole('authenticated') is not null then
  grant execute on function public.r7_operator_voice_cost_cap(),public.r7_operator_voice_owner_alerts(integer) to authenticated;
 end if;
end $acl$;

do $postflight$
declare r text;f regprocedure;
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_voice_cost_cap_operator_view.signature_before',true) then
  raise exception 'r7_voice_cost_cap_operator_view_erasure_signature_changed' using errcode='55000';end if;
 foreach f in array array['public.r7_operator_voice_cost_cap()'::regprocedure,'public.r7_operator_voice_owner_alerts(integer)'::regprocedure] loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=f and p.prosecdef and p.proconfig=array['search_path=""']
   and pg_catalog.pg_get_userbyid(p.proowner)='postgres') then
   raise exception 'r7_voice_cost_cap_operator_view_unhardened:%',f using errcode='55000';end if;
  foreach r in array array['anon','service_role'] loop
   if to_regrole(r) is not null and has_function_privilege(r,f,'execute') then
    raise exception 'r7_voice_cost_cap_operator_view_exposed:%',r using errcode='55000';end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a
   where p.oid=f and a.grantee=0) then
   raise exception 'r7_voice_cost_cap_operator_view_exposed:public' using errcode='55000';end if;
 end loop;
 -- The closed schema stays closed: API roles reach the numbers only through the two functions above.
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is not null and has_schema_privilege(r,'voice_budget','usage') then
   raise exception 'r7_voice_cost_cap_operator_view_schema_exposed:%',r using errcode='55000';end if;
 end loop;
end $postflight$;
commit;
