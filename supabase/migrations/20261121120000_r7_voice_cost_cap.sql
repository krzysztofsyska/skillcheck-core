-- R7: monthly cost cap for voice interviews (owner decision 19.11.2026, confirmed
-- 20.11.2026 in docs/DECYZJE.md: paid voice provider allowed up to 50 zł a month,
-- the limit is enforced in the application, new conversations stop and the owner
-- is notified).
--
-- What this migration does:
--  * a new closed schema `voice_budget` (outside 'public'/'private', so the SC-010
--    erasure signature and inventory stay R23; it holds no candidate data: only a
--    company id, the opaque id of the prepared call, a month and amounts in grosze);
--  * `voice_budget.settings`: one row, monthly cap 5000 grosze (50 zł) and a
--    conservative estimate of 500 grosze (5 zł) per call whose real cost is not yet
--    known (the voicebot plan caps a call at 600 s). Changeable only by the database
--    owner (a migration), never by an API role;
--  * `voice_budget.charges`: one row per dispatched call, attributed to the calendar
--    month (Europe/Warsaw) in which the call was ordered. It counts its recorded
--    provider cost once known, otherwise the estimate, and 0 when the provider
--    refused the request (dispatch claim 'rejected') or an operator confirmed it
--    never left ('abandoned');
--  * before a NEW dispatch claim is written, the R20 claim guard calls
--    `voice_budget.reserve_dispatch`: under one row lock on the settings (so
--    parallel dispatches are serialized) it refuses with PT429
--    'VOICE_COST_CAP_REACHED' when month-to-date + one estimate would exceed the cap,
--    otherwise it reserves the estimate. A resend or replay of an existing claim
--    reserves nothing again;
--  * `voice_budget.owner_alerts`: at most ONE alert per month, recorded in the
--    transaction that leaves no room for another call (a reservation, or a recorded
--    provider cost that crosses the cap). It is only a database record the operator
--    can read; nothing is sent (no e-mail, SMS or any other outbound channel);
--  * owner-only functions for the trusted server: `record_call_cost` (provider
--    cost of a call, once, idempotent), `month_status` and `list_owner_alerts`.
--
-- The only change to an existing object is ONE added statement in
-- private.sc011b_dispatch_guard() (the R20 body otherwise byte for byte, see
-- supabase/rollbacks/20261121120000_r7_voice_cost_cap_down.sql for the restore).
-- Function bodies are not part of the erasure signature; triggers, tables, columns
-- and constraints in 'public'/'private' are unchanged.
-- Nothing is granted to anon, authenticated or service_role; nothing is used by
-- the customer-facing application; no provider is called; no package, price, order
-- or payment state is touched.
begin;
do $preflight$
begin
 if to_regclass('private.sc011b_voice_dispatches') is null or to_regclass('private.erasure_inventory_baseline_r23') is null then
  raise exception 'voice_cost_cap_requires_r23' using errcode='55000';end if;
 if to_regnamespace('voice_budget') is not null then
  raise exception 'voice_cost_cap_already_installed' using errcode='55000';end if;
 if not exists(select 1 from pg_catalog.pg_proc where oid='private.sc011b_dispatch_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e5404e835bbead0b47dbc9a686d8d8f6302e9f3ddc3498f4e6b7d57009b62a7f'
  and pg_get_userbyid(proowner)='postgres' and not prosecdef and proconfig=array['search_path=""']) then
  raise exception 'voice_cost_cap_source_function_unreviewed:private.sc011b_dispatch_guard' using errcode='55000';end if;
 perform set_config('r7_voice_cost_cap.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

create schema voice_budget;
revoke all on schema voice_budget from public;

create table voice_budget.settings (
 singleton boolean primary key default true check(singleton),
 monthly_cap_grosze integer not null default 5000 check(monthly_cap_grosze between 0 and 1000000),
 call_reserve_grosze integer not null default 500 check(call_reserve_grosze between 1 and 1000000),
 updated_at timestamptz not null default clock_timestamp()
);
insert into voice_budget.settings default values;

create table voice_budget.charges (
 preparation_id uuid primary key,
 company_id uuid not null,
 month date not null check(extract(day from month)=1),
 reserved_grosze integer not null check(reserved_grosze between 1 and 1000000),
 cost_grosze integer check(cost_grosze between 0 and 1000000),
 reserved_at timestamptz not null default clock_timestamp(),
 cost_recorded_at timestamptz,
 check((cost_grosze is null)=(cost_recorded_at is null))
);
create index charges_month_idx on voice_budget.charges(month);
create index charges_company_month_idx on voice_budget.charges(company_id,month);

create table voice_budget.owner_alerts (
 month date primary key check(extract(day from month)=1),
 cause text not null check(cause in ('dispatch','call_cost')),
 cap_grosze integer not null,
 month_to_date_grosze bigint not null,
 recorded_at timestamptz not null default clock_timestamp()
);

-- The settings row cannot disappear (a missing row would fail closed anyway);
-- the cap changes only through a reviewed migration run by the owner.
create function voice_budget.settings_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_COST_SETTINGS_IMMUTABLE';
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end;$$;
create trigger settings_guard before update or delete on voice_budget.settings
 for each row execute function voice_budget.settings_guard();
create trigger settings_no_truncate before truncate on voice_budget.settings
 for each statement execute function voice_budget.settings_guard();

-- A charge is written once; the only later change is its provider cost, once.
create function voice_budget.charge_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_COST_CHARGE_IMMUTABLE';
 end if;
 if tg_op='INSERT' then
  if new.cost_grosze is not null or new.cost_recorded_at is not null then
   raise exception using errcode='42501',message='VOICE_COST_CHARGE_IMMUTABLE';
  end if;
  new.reserved_at:=clock_timestamp();
  return new;
 end if;
 if old.cost_grosze is not null or new.cost_grosze is null
  or (to_jsonb(new)-array['cost_grosze','cost_recorded_at']) is distinct from (to_jsonb(old)-array['cost_grosze','cost_recorded_at']) then
  raise exception using errcode='42501',message='VOICE_COST_CHARGE_IMMUTABLE';
 end if;
 new.cost_recorded_at:=clock_timestamp();
 return new;
end;$$;
create trigger charge_guard before insert or update or delete on voice_budget.charges
 for each row execute function voice_budget.charge_guard();
create trigger charge_no_truncate before truncate on voice_budget.charges
 for each statement execute function voice_budget.charge_guard();

create function voice_budget.alert_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 raise exception using errcode='42501',message='VOICE_COST_ALERT_IMMUTABLE';
end;$$;
create trigger alert_guard before update or delete on voice_budget.owner_alerts
 for each row execute function voice_budget.alert_guard();
create trigger alert_no_truncate before truncate on voice_budget.owner_alerts
 for each statement execute function voice_budget.alert_guard();

-- Calendar month in Polish time: 2026-11-30 23:30 UTC is already December.
create function voice_budget.month_of(at timestamptz) returns date
language sql stable security definer set search_path='' as $$
 select date_trunc('month',at at time zone 'Europe/Warsaw')::date
$$;

-- Month-to-date cost: recorded provider cost, else the reserved estimate, else 0
-- for a request the provider refused or an operator confirmed never left. A charge
-- whose claim is gone (candidate erasure) keeps counting: money spent stays spent.
create function voice_budget.month_to_date(target_month date) returns bigint
language sql stable security definer set search_path='' as $$
 select coalesce(sum(case
   when c.cost_grosze is not null then c.cost_grosze
   when d.state in ('rejected','abandoned') then 0
   else c.reserved_grosze end),0)::bigint
 from voice_budget.charges c
 left join private.sc011b_voice_dispatches d on d.company_id=c.company_id and d.preparation_id=c.preparation_id
 where c.month=target_month
$$;

-- Called with the settings row locked. Records the month's single owner alert once
-- no further call fits under the cap.
create function voice_budget.note_cap(target_month date,cause text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare s voice_budget.settings;total bigint;
begin
 select * into s from voice_budget.settings where singleton;
 total:=voice_budget.month_to_date(target_month);
 if total+s.call_reserve_grosze>s.monthly_cap_grosze then
  insert into voice_budget.owner_alerts(month,cause,cap_grosze,month_to_date_grosze)
  values(target_month,cause,s.monthly_cap_grosze,total) on conflict (month) do nothing;
 end if;
end;$$;

-- Reserve one call's estimate in the month of `at`, or refuse. Serialized on the
-- settings row so two parallel dispatches cannot both take the last room.
create function voice_budget.reserve_at(target_company uuid,target_preparation uuid,at timestamptz) returns text
language plpgsql volatile security definer set search_path='' as $$
declare s voice_budget.settings;existing voice_budget.charges;target_month date;total bigint;
begin
 if target_company is null or target_preparation is null or at is null then
  raise exception using errcode='PT422',message='VOICE_COST_CAP_INVALID';
 end if;
 select * into s from voice_budget.settings where singleton for update;
 if not found then raise exception using errcode='PT429',message='VOICE_COST_CAP_REACHED';end if;
 select * into existing from voice_budget.charges where preparation_id=target_preparation;
 if found then
  if existing.company_id<>target_company then
   raise exception using errcode='PT409',message='VOICE_COST_CAP_CONFLICT';
  end if;
  return 'replayed';
 end if;
 target_month:=voice_budget.month_of(at);
 total:=voice_budget.month_to_date(target_month);
 if total+s.call_reserve_grosze>s.monthly_cap_grosze then
  raise exception using errcode='PT429',message='VOICE_COST_CAP_REACHED';
 end if;
 insert into voice_budget.charges(preparation_id,company_id,month,reserved_grosze)
 values(target_preparation,target_company,target_month,s.call_reserve_grosze);
 perform voice_budget.note_cap(target_month,'dispatch');
 return 'reserved';
end;$$;

create function voice_budget.reserve_dispatch(target_company uuid,target_preparation uuid) returns text
language sql volatile security definer set search_path='' as $$
 select voice_budget.reserve_at(target_company,target_preparation,clock_timestamp())
$$;

-- Trusted server: the provider's cost of one dispatched call, in grosze, once.
-- Another company's or an unknown call gives the same PT404.
create function voice_budget.record_call_cost(target_company uuid,target_preparation uuid,cost integer) returns text
language plpgsql volatile security definer set search_path='' as $$
declare c voice_budget.charges;
begin
 if target_company is null or target_preparation is null or cost is null or cost<0 or cost>1000000 then
  raise exception using errcode='PT422',message='VOICE_COST_CAP_INVALID';
 end if;
 perform 1 from voice_budget.settings where singleton for update;
 select * into c from voice_budget.charges where preparation_id=target_preparation and company_id=target_company for update;
 if not found then raise exception using errcode='PT404',message='VOICE_COST_CHARGE_UNKNOWN';end if;
 if c.cost_grosze is not null then
  if c.cost_grosze=cost then return 'replayed';end if;
  raise exception using errcode='PT409',message='VOICE_COST_ALREADY_RECORDED';
 end if;
 update voice_budget.charges set cost_grosze=cost where preparation_id=target_preparation;
 perform voice_budget.note_cap(c.month,'call_cost');
 return 'recorded';
end;$$;

-- Operator view (trusted server only): the month's numbers and whether new calls stop.
create function voice_budget.month_status(at timestamptz default clock_timestamp())
returns table(month date,cap_grosze integer,call_reserve_grosze integer,recorded_cost_grosze bigint,
 in_flight_grosze bigint,month_to_date_grosze bigint,remaining_grosze bigint,new_calls_blocked boolean,alert_recorded_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare s voice_budget.settings;m date;recorded bigint;total bigint;
begin
 select * into s from voice_budget.settings where singleton;
 m:=voice_budget.month_of(coalesce(at,clock_timestamp()));
 select coalesce(sum(c.cost_grosze),0) into recorded from voice_budget.charges c where c.month=m and c.cost_grosze is not null;
 total:=voice_budget.month_to_date(m);
 return query select m,s.monthly_cap_grosze,s.call_reserve_grosze,recorded,total-recorded,total,
  greatest(s.monthly_cap_grosze-total,0),
  s.monthly_cap_grosze is null or total+s.call_reserve_grosze>s.monthly_cap_grosze,
  (select a.recorded_at from voice_budget.owner_alerts a where a.month=m);
end;$$;

create function voice_budget.list_owner_alerts(result_limit integer)
returns table(month date,cause text,cap_grosze integer,month_to_date_grosze bigint,recorded_at timestamptz)
language sql stable security definer set search_path='' as $$
 select a.month,a.cause,a.cap_grosze,a.month_to_date_grosze,a.recorded_at from voice_budget.owner_alerts a
 order by a.month desc limit least(greatest(coalesce(result_limit,12),1),120)
$$;

-- R20 claim guard with one added statement (marked R7) before a new claim is accepted.
create or replace function private.sc011b_dispatch_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_DISPATCH_IMMUTABLE';
 end if;
 if tg_op='INSERT' then
  -- BEFORE INSERT runs ahead of ON CONFLICT: an existing claim is left as is.
  if exists(select 1 from private.sc011b_voice_dispatches
    where company_id=new.company_id and preparation_id=new.preparation_id) then
   return null;
  end if;
  select * into prep from private.sc010c_voice_preparations
   where company_id=new.company_id and id=new.preparation_id for share;
  if not found or prep.state<>'prepared_offline' then
   raise exception using errcode='PT409',message='VOICE_DISPATCH_UNAVAILABLE';
  end if;
  perform private.erasure_lock_candidate(prep.candidate_id);
  if new.provider_key_digest<>prep.provider_key_digest then
   raise exception using errcode='42501',message='VOICE_DISPATCH_DRAFT_MISMATCH';
  end if;
  -- Queue the SC-010-C deferred currentness check (contact, permission,
  -- release, entitlement) for this transaction's COMMIT: no claim without it.
  update private.sc010c_voice_preparations set state=state
   where company_id=new.company_id and id=new.preparation_id;
  if new.state<>'sending' or new.attempts<>1 or new.rejection is not null then
   raise exception using errcode='42501',message='VOICE_DISPATCH_INVALID_STATE';
  end if;
  -- R7 (20261121120000): the monthly voice cost cap reserves this call's estimate
  -- or refuses the new claim (PT429 VOICE_COST_CAP_REACHED) before it exists.
  perform voice_budget.reserve_dispatch(new.company_id,new.preparation_id);
  new.started_at:=clock_timestamp(); new.last_attempt_at:=new.started_at;
  new.lease_until:=new.started_at+interval '15 seconds';
  return new;
 end if;
 -- A sending claim moves by one resend, a lease release, or one terminal
 -- outcome. An unknown claim may still learn that its call was accepted.
 if new.company_id<>old.company_id or new.preparation_id<>old.preparation_id
  or new.started_at<>old.started_at or new.provider_key_digest<>old.provider_key_digest
  or new.payload_sha256<>old.payload_sha256 or new.attempts<old.attempts
  or not ((old.state='sending' and new.state='sending' and new.attempts=old.attempts+1)
       or (old.state='sending' and new.state='sending' and new.attempts=old.attempts
           and new.lease_until is null)
       or (old.state='sending' and new.state in ('accepted','rejected','unknown') and new.attempts=old.attempts)
       or (old.state='unknown' and new.state='accepted' and new.attempts=old.attempts)
       -- Only the SC-011-B6 operator resolution may abandon an unknown claim.
       or (old.state='unknown' and new.state='abandoned' and new.attempts=old.attempts
           -- An unset setting is NULL: coalesce so absence is a refusal, never unknown.
           and coalesce(pg_catalog.current_setting('skillcheck.sc011b_resolution',true),'')='on')) then
  raise exception using errcode='42501',message='VOICE_DISPATCH_IMMUTABLE';
 end if;
 if new.state='sending' and new.attempts=old.attempts+1 then
  if old.lease_until>clock_timestamp() then
   raise exception using errcode='PT409',message='VOICE_DISPATCH_IN_FLIGHT';
  end if;
  -- Every resend re-proves current contact authority at COMMIT as well.
  update private.sc010c_voice_preparations set state=state
   where company_id=new.company_id and id=new.preparation_id;
  new.last_attempt_at:=clock_timestamp();
  new.lease_until:=new.last_attempt_at+interval '15 seconds';
 else
  new.last_attempt_at:=old.last_attempt_at;
  if new.state<>'sending' then new.lease_until:=null; end if;
 end if;
 return new;
end;$$;

alter table voice_budget.settings enable row level security;
alter table voice_budget.charges enable row level security;
alter table voice_budget.owner_alerts enable row level security;
alter table voice_budget.settings force row level security;
alter table voice_budget.charges force row level security;
alter table voice_budget.owner_alerts force row level security;

-- Owner only: remove every non-owner recipient from the new tables and functions,
-- whatever default privileges the hosting platform applies.
do $acl$
declare o record;g record;
begin
 for o in select c.oid,c.relname,c.relowner from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='voice_budget' and c.relkind in ('r','S') loop
  execute pg_catalog.format('revoke all on table voice_budget.%I from public cascade',o.relname);
  for g in select distinct a.grantee from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   where c.oid=o.oid and a.grantee<>0 and a.grantee<>o.relowner loop
   execute pg_catalog.format('revoke all on table voice_budget.%I from %I cascade',o.relname,pg_catalog.pg_get_userbyid(g.grantee));
  end loop;
 end loop;
 for o in select p.oid,p.proowner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='voice_budget' or p.oid='private.sc011b_dispatch_guard()'::regprocedure loop
  execute pg_catalog.format('revoke all on function %s from public cascade',o.oid::regprocedure);
  for g in select distinct a.grantee from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   where p.oid=o.oid and a.grantee<>0 and a.grantee<>o.proowner loop
   execute pg_catalog.format('revoke all on function %s from %I cascade',o.oid::regprocedure,pg_catalog.pg_get_userbyid(g.grantee));
  end loop;
 end loop;
end $acl$;

do $postflight$
declare r text;
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_voice_cost_cap.signature_before',true) then
  raise exception 'voice_cost_cap_erasure_signature_changed' using errcode='55000';end if;
 if not exists(select 1 from pg_catalog.pg_proc where oid='private.sc011b_dispatch_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='2850610e17132511139b5fefbba79710fe5e0cbc46e8af11627b30698d5d5be5'
  and pg_get_userbyid(proowner)='postgres' and not prosecdef and proconfig=array['search_path=""']) then
  raise exception 'voice_cost_cap_final_function_mismatch:private.sc011b_dispatch_guard' using errcode='55000';end if;
 if (select count(*) from voice_budget.settings where singleton and monthly_cap_grosze=5000 and call_reserve_grosze=500)<>1 then
  raise exception 'voice_cost_cap_settings_missing' using errcode='55000';end if;
 if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='voice_budget' and (not p.prosecdef and p.prorettype<>'trigger'::regtype or p.proconfig is distinct from array['search_path=""'])) then
  raise exception 'voice_cost_cap_function_unhardened' using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role'] loop
  if to_regrole(r) is null then continue;end if;
  if has_schema_privilege(r,'voice_budget','usage')
   or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='voice_budget' and c.relkind='r' and has_table_privilege(r,c.oid,'select,insert,update,delete,truncate,references,trigger'))
   or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='voice_budget' or p.oid='private.sc011b_dispatch_guard()'::regprocedure) and has_function_privilege(r,p.oid,'execute')) then
   raise exception 'voice_cost_cap_exposed:%',r using errcode='55000';end if;
 end loop;
end $postflight$;
commit;
