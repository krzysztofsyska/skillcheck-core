-- R6-2 (packages): a company that has a package gets its voice interview pool
-- automatically, and a future purchase of extra interviews has one prepared,
-- unused entry point. Owner decision 20.11.2026 (docs/DECYZJE.md):
--   FREE 1 trial interview; PRESELEKCJA, WERYFIKACJA, ASSESSMENT_CENTER 10 each;
--   extra interviews can be bought later (price, size, validity and how they are
--   bought are NOT decided: nothing here prices, sells or charges anything).
-- The per-package numbers live in ONE place: private.sc19_voice_package_allowance.
-- Any other or unknown package, and every add-on, gives 0 (fail-closed).
--
-- Functions only, on top of the R19 pool and the R6-2 operator grant
-- (20261119150000). No table, column, constraint or trigger is added or
-- changed, so the SC-010 erasure schema signature stays as it is. The package
-- data is only READ; no package, order, price, catalog, balance or journal
-- function or row is changed. A package is only one that the company really has:
--   FREE        = a 'trial' row of private.sc19_credit_journal (FREE activation);
--   paid package = a paid package order in sc19_commerce.orders (its own
--                 package code), or a 'paid_grant' row of the journal that no
--                 order settled (a legacy PRESELEKCJA pack: operator grant or the
--                 PRESELEKCJA checkout). A catalog settlement writes a journal
--                 row and the order under the same 'settlement:'||reference; the
--                 order decides (one package, with its real code), and a pending
--                 or cancelled order gives nothing.
--
-- Idempotent: every package has one derived, domain-separated grant reference,
-- and the existing unique(grant_reference) of the pool is the final guard. FREE
-- uses the trial reference of the operator grant, so FREE and an operator trial
-- never add up to two interviews. Retries and parallel calls never grant twice.
--
-- Window: a package pool ends private.sc19_voice_package_window() after the
-- package (the pool design requires an end date, at most 366 days ahead). This is
-- a TECHNICAL placeholder of 365 days, kept in that single function until the
-- owner decides the validity; a package older than that gives no pool.
--
-- Reservation, settlement and refund of a unit are NOT redefined here: the
-- R19/R20/R21 pool already reserves a unit when an interview is ordered, uses it
-- when the call completes and returns it when the call does not take place or
-- the draft is cancelled, and its check(used+reserved<=total) stops parallel
-- orders from exceeding the pool.
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
  or to_regprocedure('private.sc19_voice_sync_package_pools(uuid)') is not null
  or to_regprocedure('private.sc19_voice_package_allowance(text)') is not null
  or to_regprocedure('private.sc19_voice_package_window()') is not null
  or to_regprocedure('private.sc19_voice_grant_topup(uuid,uuid,integer,timestamptz)') is not null then
  raise exception 'voice_package_pools_already_installed' using errcode='55000';end if;
end $preflight$;

-- Deterministic opaque reference of one package of one company, per purpose
-- ('grant' or 'evidence'). Domain-separated from the trial reference.
create function private.sc19_voice_package_reference(target_company uuid, package_key text, purpose text)
returns uuid language sql immutable strict security definer set search_path='' as $$
 select substr(encode(pg_catalog.sha256(pg_catalog.convert_to(
  'skillcheck:sc19-voice-pool:package_'||purpose||':v1:'||target_company::text||':'||package_key,'UTF8')),'hex'),1,32)::uuid
$$;

-- The ONLY place where a package is mapped to its interviews (owner, 20.11.2026).
create function private.sc19_voice_package_allowance(package_code text)
returns integer language sql immutable security definer set search_path='' as $$
 select case package_code
  when 'FREE' then 1
  when 'PRESELEKCJA' then 10
  when 'WERYFIKACJA' then 10
  when 'ASSESSMENT_CENTER' then 10
  else 0 end
$$;

-- Technical validity of a package pool (placeholder until the owner decides).
create function private.sc19_voice_package_window()
returns interval language sql immutable security definer set search_path='' as $$
 select interval '365 days'
$$;

-- The packages of ONE company: one row per package, read-only.
-- key 'free' (at most one) or 'paid:settlement:'||reference / 'paid:journal:'||id.
create function private.sc19_voice_package_events(target_company uuid)
returns table(package_key text, package_code text, occurred_at timestamptz)
language sql stable security definer set search_path='' as $$
 select 'free'::text, 'FREE'::text, min(j.created_at) from private.sc19_credit_journal j
  where j.company_id=target_company and j.reason='trial'
  having count(*)>0
 union all
 -- A legacy pack (operator grant or PRESELEKCJA checkout): only PRESELEKCJA
 -- writes such a row. A row that an order settled is that order's package.
 select 'paid:'||coalesce(j.reference,'journal:'||j.id::text), 'PRESELEKCJA'::text, j.created_at
  from private.sc19_credit_journal j
  where j.company_id=target_company and j.reason='paid_grant' and j.delta>0
   and not exists(select 1 from sc19_commerce.orders o
    where j.reference is not null and 'settlement:'||o.settlement_reference=j.reference)
 union all
 select 'paid:settlement:'||o.settlement_reference, o.package_code, o.settled_at from sc19_commerce.orders o
  where o.company_id=target_company and o.status='paid' and o.kind='package' and o.package_code<>'FREE'
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
 interviews integer;
begin
 if target_company is null then raise exception 'voice_grant_invalid' using errcode='22023';end if;
 perform 1 from public.companies c where c.id=target_company;
 if not found then raise exception 'voice_grant_company_unknown' using errcode='PT404';end if;
 -- Fixed order, so parallel calls take the per-reference locks in the same order.
 for ev in select * from private.sc19_voice_package_events(target_company) order by package_key loop
  interviews:=private.sc19_voice_package_allowance(ev.package_code);
  if interviews<1 then continue;end if;
  if ev.package_code='FREE' then
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
  window_end:=pg_catalog.date_trunc('second',ev.occurred_at)+private.sc19_voice_package_window();
  if window_end<=clock_timestamp()+interval '1 minute' then continue;end if;
  select * into outcome from private.sc19_voice_grant_interviews(
   target_company,
   case ev.package_code when 'FREE' then 'trial_single' else 'operator_manual' end,
   interviews,
   case ev.package_code when 'FREE' then null else reference end,
   window_end,
   private.sc19_voice_package_reference(target_company,ev.package_key,'evidence'),
   window_end);
  pools:=pools+1;
  if not outcome.replayed then made:=made+1;end if;
 end loop;
 return query select pools,made;
end;
$$;

-- Prepared entry point for interviews bought on top of a package (owner,
-- 20.11.2026: extra interviews can be bought later). NOT called anywhere yet:
-- no price, no checkout, no payment, no order kind. A future, separately
-- approved purchase flow passes its own settled purchase reference, the number
-- of interviews and the validity it sold; this function only turns that into a
-- pool, once per purchase (derived reference + unique(grant_reference)); a
-- replay with the same terms returns the same pool, other terms are refused by
-- the operator grant. Only a company that really has a package can top up.
create function private.sc19_voice_grant_topup(
 target_company uuid, purchase_reference uuid, interviews integer, pool_expires_at timestamptz
) returns table(entitlement_id uuid, replayed boolean)
language plpgsql volatile security definer set search_path='' as $$
declare reference uuid;
begin
 if target_company is null or purchase_reference is null or interviews is null or pool_expires_at is null
  or interviews not between 1 and 1000 then
  raise exception 'voice_grant_invalid' using errcode='22023';end if;
 perform 1 from public.companies c where c.id=target_company;
 if not found then raise exception 'voice_grant_company_unknown' using errcode='PT404';end if;
 if not exists(select 1 from private.sc19_voice_package_events(target_company) e
   where private.sc19_voice_package_allowance(e.package_code)>0) then
  raise exception 'voice_topup_package_required' using errcode='PT422';end if;
 reference:=private.sc19_voice_package_reference(target_company,'topup:'||purchase_reference::text,'grant');
 return query select g.entitlement_id,g.replayed from private.sc19_voice_grant_interviews(
  target_company,'operator_manual',interviews,reference,pool_expires_at,
  private.sc19_voice_package_reference(target_company,'topup:'||purchase_reference::text,'evidence'),
  pool_expires_at) g;
end;
$$;

-- Owner only: close every actual ACL, including inherited defaults.
do $acl$
declare o record;g record;
begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.sc19_voice_package_reference(uuid,text,text)',
  'private.sc19_voice_package_allowance(text)',
  'private.sc19_voice_package_window()',
  'private.sc19_voice_package_events(uuid)',
  'private.sc19_voice_sync_package_pools(uuid)',
  'private.sc19_voice_grant_topup(uuid,uuid,integer,timestamptz)']::regprocedure[]) loop
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
   'private.sc19_voice_package_allowance(text)',
   'private.sc19_voice_package_window()',
   'private.sc19_voice_package_events(uuid)',
   'private.sc19_voice_sync_package_pools(uuid)',
   'private.sc19_voice_grant_topup(uuid,uuid,integer,timestamptz)']::regprocedure[])
  and (not p.prosecdef or p.proconfig is null or p.proconfig[1] is distinct from 'search_path=""'
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))) then
  raise exception 'voice_package_pools_function_exposed' using errcode='55000';end if;
end $postflight$;

commit;
