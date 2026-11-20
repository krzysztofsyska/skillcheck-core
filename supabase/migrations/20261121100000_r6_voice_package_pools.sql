-- R6-2 (packages): a company that has a package gets its voice interview pool
-- automatically. FREE gives 1 interview, every paid package gives 10
-- (owner decision, docs/DECYZJE.md; docs/ROADMAP.md R6).
--
-- Functions only, on top of the R19 pool and the R6-2 operator grant
-- (20261119150000). No table, column, constraint or trigger is added or
-- changed, so the SC-010 erasure schema signature stays as it is. The package
-- data is only READ; no package, order, price, catalog, balance or journal
-- function or row is changed:
--   FREE        = a 'trial' row of private.sc19_credit_journal (FREE activation);
--   paid package = a 'paid_grant' row of private.sc19_credit_journal (operator
--                 grant of a pack) or a paid package order in
--                 sc19_commerce.orders. A catalog settlement writes both under
--                 the same 'settlement:'||reference, so it counts once.
--
-- Idempotent: every package has one derived, domain-separated grant reference,
-- and the existing unique(grant_reference) of the pool is the final guard. FREE
-- uses the trial reference of the operator grant, so FREE and an operator trial
-- never add up to two interviews. Retries and parallel calls never grant twice.
--
-- Window: a package pool is valid for 365 days from the package (the pool
-- design requires an end date, at most 366 days ahead). A package older than
-- that gives no pool; an operator can still grant one by hand.
--
-- Nothing is granted to anon, authenticated, service_role or any other role:
-- only the function owner (the trusted server connection) can execute them.
-- Not visible to customers; nothing is sent; no provider is called.
begin;

do $preflight$
begin
 if to_regclass('private.sc19_voice_entitlements') is null
  or to_regprocedure('private.sc19_voice_trial_reference(uuid)') is null
  or to_regprocedure('private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)') is null then
  raise exception 'voice_package_pools_require_operator_grant' using errcode='55000';end if;
 if to_regclass('private.sc19_credit_journal') is null or to_regclass('sc19_commerce.orders') is null then
  raise exception 'voice_package_pools_require_packages' using errcode='55000';end if;
 if to_regprocedure('private.sc19_voice_package_reference(uuid,text,text)') is not null
  or to_regprocedure('private.sc19_voice_package_events(uuid)') is not null
  or to_regprocedure('private.sc19_voice_sync_package_pools(uuid)') is not null then
  raise exception 'voice_package_pools_already_installed' using errcode='55000';end if;
end $preflight$;

-- Deterministic opaque reference of one package of one company, per purpose
-- ('grant' or 'evidence'). Domain-separated from the trial reference.
create function private.sc19_voice_package_reference(target_company uuid, package_key text, purpose text)
returns uuid language sql immutable strict security definer set search_path='' as $$
 select substr(encode(pg_catalog.sha256(pg_catalog.convert_to(
  'skillcheck:sc19-voice-pool:package_'||purpose||':v1:'||target_company::text||':'||package_key,'UTF8')),'hex'),1,32)::uuid
$$;

-- The packages of ONE company: one row per package, read-only.
-- kind 'free' (key 'free', at most one) or 'paid' (key 'paid:'||settlement key).
create function private.sc19_voice_package_events(target_company uuid)
returns table(package_key text, package_kind text, occurred_at timestamptz)
language sql stable security definer set search_path='' as $$
 select e.k, min(e.kind), min(e.at) from (
  select 'free'::text k, 'free'::text kind, j.created_at at from private.sc19_credit_journal j
   where j.company_id=target_company and j.reason='trial'
  union all
  select 'paid:'||coalesce(j.reference,'journal:'||j.id::text), 'paid', j.created_at from private.sc19_credit_journal j
   where j.company_id=target_company and j.reason='paid_grant'
  union all
  select 'paid:settlement:'||o.settlement_reference, 'paid', o.settled_at from sc19_commerce.orders o
   where o.company_id=target_company and o.status='paid' and o.kind='package' and o.package_code<>'FREE'
 ) e group by e.k
$$;

-- Gives the company every package pool it does not have yet. Safe to call any
-- number of times, also in parallel. Returns how many packages have a pool and
-- how many pools this call created.
create function private.sc19_voice_sync_package_pools(target_company uuid)
returns table(package_pools integer, created integer)
language plpgsql volatile security definer set search_path='' as $$
declare
 ev record;
 reference uuid;
 window_end timestamptz;
 outcome record;
 pools integer:=0;
 made integer:=0;
begin
 if target_company is null then raise exception 'voice_grant_invalid' using errcode='22023';end if;
 perform 1 from public.companies c where c.id=target_company;
 if not found then raise exception 'voice_grant_company_unknown' using errcode='PT404';end if;
 -- Fixed order, so parallel calls take the per-reference locks in the same order.
 for ev in select * from private.sc19_voice_package_events(target_company) order by package_key loop
  if ev.package_kind='free' then
   reference:=private.sc19_voice_trial_reference(target_company);
  else
   reference:=private.sc19_voice_package_reference(target_company,ev.package_key,'grant');
  end if;
  -- Same lock as the operator grant; unique(grant_reference) is the final guard.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sc19_voice_grant:'||reference::text,0));
  if exists(select 1 from private.sc19_voice_entitlements e where e.grant_reference=reference) then
   if not exists(select 1 from private.sc19_voice_entitlements e where e.grant_reference=reference and e.company_id=target_company) then
    raise exception 'voice_grant_reference_conflict' using errcode='23505';end if;
   pools:=pools+1;
   continue;
  end if;
  window_end:=pg_catalog.date_trunc('second',ev.occurred_at)+interval '365 days';
  if window_end<=clock_timestamp()+interval '1 minute' then continue;end if;
  select * into outcome from private.sc19_voice_grant_interviews(
   target_company,
   case ev.package_kind when 'free' then 'trial_single' else 'operator_manual' end,
   case ev.package_kind when 'free' then 1 else 10 end,
   case ev.package_kind when 'free' then null else reference end,
   window_end,
   private.sc19_voice_package_reference(target_company,ev.package_key,'evidence'),
   window_end);
  pools:=pools+1;
  if not outcome.replayed then made:=made+1;end if;
 end loop;
 return query select pools,made;
end;
$$;

-- Owner only: close every actual ACL, including inherited defaults.
do $acl$
declare o record;g record;
begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.sc19_voice_package_reference(uuid,text,text)',
  'private.sc19_voice_package_events(uuid)',
  'private.sc19_voice_sync_package_pools(uuid)']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop
   execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;

do $postflight$
begin
 if exists(select 1 from pg_proc p where p.oid=any(array[
   'private.sc19_voice_package_reference(uuid,text,text)',
   'private.sc19_voice_package_events(uuid)',
   'private.sc19_voice_sync_package_pools(uuid)']::regprocedure[])
  and (not p.prosecdef or p.proconfig is null or p.proconfig[1] is distinct from 'search_path=""'
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))) then
  raise exception 'voice_package_pools_function_exposed' using errcode='55000';end if;
end $postflight$;

commit;
