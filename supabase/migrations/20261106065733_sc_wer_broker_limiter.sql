-- SC-WER C2: bounded shared PostgreSQL limiter, no Redis purchase or activation.
-- Separate runtime schema: no candidate identity, token, session or answer.
-- One row holds a 60-second total and up to 300 hourly HMAC source counters.
-- Expired values have no authority and are replaced on the next request.
begin;
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r12') is null then
  raise exception 'sc_wer_limiter_requires_c1' using errcode='55000';end if;
 if to_regnamespace('competency_runtime') is not null then
  raise exception 'sc_wer_runtime_schema_exists' using errcode='55000';end if;
end;$$;
create schema competency_runtime;
revoke all on schema competency_runtime from public,anon,authenticated,competency_test_gateway;
create table competency_runtime.rate_window (
 singleton boolean primary key default true check(singleton),
 window_id bigint not null check(window_id>=0),total integer not null check(total between 0 and 300),
 sources jsonb not null check(jsonb_typeof(sources)='object' and pg_column_size(sources)<=65536)
);
alter table competency_runtime.rate_window enable row level security;
create function private.consume_competency_rate_limit(source_hmac text,requested_window bigint) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare w competency_runtime.rate_window;n integer;current_window bigint;
begin
 if source_hmac is null or source_hmac !~ '^[0-9a-f]{64}$' or requested_window is null then
  raise exception using errcode='22023',message='Invalid rate limit context';end if;
 current_window:=floor(extract(epoch from clock_timestamp())/60)::bigint;
 -- The server owns time; a client cannot evade limits by inventing windows.
 if requested_window<>current_window then return false;end if;
 insert into competency_runtime.rate_window values(true,current_window,0,'{}') on conflict(singleton) do nothing;
 select * into w from competency_runtime.rate_window where singleton for update;
 -- The lock can cross a window boundary. Never reset a newer committed window
 -- backwards using a timestamp captured before waiting for another process.
 current_window:=floor(extract(epoch from clock_timestamp())/60)::bigint;
 if requested_window<>current_window or w.window_id>current_window then return false;end if;
 if w.window_id<>current_window then w.window_id:=current_window;w.total:=0;w.sources:='{}';end if;
 n:=coalesce((w.sources->>source_hmac)::integer,0);
 if w.total>=300 or n>=15 then return false;end if;
 update competency_runtime.rate_window set window_id=current_window,total=w.total+1,
 sources=jsonb_set(w.sources,array[source_hmac],to_jsonb(n+1),true) where singleton;
 return true;
end;$$;
-- Hostile default ACLs must never expose the runtime table or callable helper.
do $$declare g record;begin
 for g in select distinct a.grantee,r.rolname from pg_class c
 cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 left join pg_roles r on r.oid=a.grantee where c.oid='competency_runtime.rate_window'::regclass and a.grantee<>c.relowner loop
 if g.grantee=0 then revoke all on competency_runtime.rate_window from public;
 else execute format('revoke all on competency_runtime.rate_window from %I',g.rolname);end if;
 end loop;
 for g in select distinct a.grantee,r.rolname from pg_proc p
 cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 left join pg_roles r on r.oid=a.grantee where p.oid='private.consume_competency_rate_limit(text,bigint)'::regprocedure and a.grantee<>p.proowner loop
 if g.grantee=0 then revoke all on function private.consume_competency_rate_limit(text,bigint) from public;
 else execute format('revoke all on function private.consume_competency_rate_limit(text,bigint) from %I',g.rolname);end if;
 end loop;
end;$$;
grant execute on function private.consume_competency_rate_limit(text,bigint) to competency_test_gateway;
do $$begin
 if private.erasure_schema_signature() is distinct from
  (select schema_signature from private.erasure_inventory_baseline_r12 where singleton) then
  raise exception 'sc_wer_limiter_changed_candidate_inventory' using errcode='55000';end if;
end;$$;
commit;
