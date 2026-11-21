-- R6-2 (packages), fix: a WERYFIKACJA or ASSESSMENT CENTER package bought through
-- the TEST-mode Stripe checkout (sc19_stripe.package_orders) is ONE package with
-- its own code, also when it holds a larger CV pool. Codex P2 finding on PR #566:
-- sc19_stripe.grant_package writes a 'paid_grant' journal row with delta = the
-- order's credits (60..150, 20261121190000_r7_stripe_package_cv_overage.sql)
-- under 'settlement:sc19:'||sha256(payment key). The body from
-- 20261121160000_r6_voice_pool_package_count.sql only recognises the
-- PRESELEKCJA payment store (private.sc19_payment_orders), so such a row fell
-- through to the legacy rule "credits / 60": one WERYFIKACJA package with 120
-- CV became 2 PRESELEKCJA packages = 20 voice interviews instead of 10.
--
-- Only the body of private.sc19_voice_package_events(uuid) changes (same name,
-- arguments and result columns; callers unchanged). Body identical to
-- 20261121160000 plus one rule, checked FIRST: a 'paid_grant' row whose
-- reference equals 'settlement:sc19:'||sha256(payment key) of a PAID
-- sc19_stripe.package_orders order of the SAME company (receipt in
-- sc19_stripe.package_grants; the same formula as sc19_stripe.grant_package and
-- ai_ledger.stripe_package_settlements in 20261121200000) is exactly 1 package
-- with that order's package_code, whatever its CV pool. The first-package key
-- ('paid:'||reference) is unchanged, so a pool that already exists for such a
-- purchase is recognised and never granted again. Pools already given on a test
-- database for a wrong extra package stay (the pool guard forbids deletion).
--
-- Functions only: no table, column, constraint or trigger is added or changed,
-- so the SC-010 erasure schema signature stays as it is. Package, order,
-- payment and journal data is only READ. security definer, search_path='',
-- nothing granted to anon, authenticated, service_role or any other role.
-- Not visible to customers; nothing is sent; no provider is called.
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261121230000_r6_voice_pool_stripe_packages_down.sql.
begin;

do $preflight$
begin
 if to_regprocedure('private.sc19_voice_package_events(uuid)') is null
  or to_regprocedure('private.sc19_voice_sync_package_pools(uuid)') is null
  or to_regprocedure('private.sc19_voice_package_reference(uuid,text,text)') is null then
  raise exception 'voice_pool_stripe_packages_requires_package_pools' using errcode='55000';end if;
 if not exists(select 1 from pg_proc p where p.oid='private.sc19_voice_package_events(uuid)'::regprocedure
   and pg_catalog.pg_get_functiondef(p.oid) like '%extra:%') then
  raise exception 'voice_pool_stripe_packages_requires_package_count' using errcode='55000';end if;
 if to_regclass('private.sc19_credit_journal') is null or to_regclass('sc19_commerce.orders') is null
  or to_regclass('private.sc19_payment_orders') is null or to_regclass('private.sc19_payment_offers') is null
  or to_regclass('private.sc19_payment_grants') is null
  or to_regclass('sc19_stripe.package_orders') is null or to_regclass('sc19_stripe.package_grants') is null then
  raise exception 'voice_pool_stripe_packages_requires_packages' using errcode='55000';end if;
 if exists(select 1 from pg_proc p where p.oid='private.sc19_voice_package_events(uuid)'::regprocedure
   and pg_catalog.pg_get_functiondef(p.oid) like '%sc19_stripe.package_grants%') then
  raise exception 'voice_pool_stripe_packages_already_installed' using errcode='55000';end if;
end $preflight$;

-- The packages of ONE company: one row per package, read-only.
-- key 'free' (at most one), 'paid:settlement:'||reference / 'paid:journal:'||id
-- for the first package of a purchase, 'extra:'||k||':'||that key for package k>1.
create or replace function private.sc19_voice_package_events(target_company uuid)
returns table(package_key text, package_code text, occurred_at timestamptz)
language sql stable security definer set search_path='' as $$
 with purchases as (
  -- A Stripe package order (WERYFIKACJA / ASSESSMENT_CENTER): one package with its
  -- own code. A legacy pack (operator grant or PRESELEKCJA checkout): PRESELEKCJA.
  -- A row that a catalog order settled is that order's package.
  select 'paid:'||coalesce(j.reference,'journal:'||j.id::text) as base_key,
   coalesce(so.package_code,'PRESELEKCJA')::text as code, j.created_at as at,
   case
    when so.id is not null then 1
    when po.id is not null then
     case when po.credits=j.delta and f.credits>0 and po.credits%f.credits=0
       and po.credits/f.credits between 1 and 20 and po.amount_minor=f.amount_minor*(po.credits/f.credits)
      then po.credits/f.credits else 1 end
    when j.delta%60=0 and j.delta/60 between 1 and 10 then j.delta/60
    else 1 end as packages
  from private.sc19_credit_journal j
  left join lateral (
   select o.id,o.package_code
    from sc19_stripe.package_grants g join sc19_stripe.package_orders o on o.id=g.order_id
    where j.reference like 'settlement:sc19:%' and o.company_id=target_company and o.status='paid'
     and 'settlement:sc19:'||encode(pg_catalog.sha256(pg_catalog.convert_to(g.payment_key,'UTF8')),'hex')=j.reference
    order by o.id limit 1) so on true
  left join lateral (
   select o.id,o.credits,o.amount_minor,o.offer_id,o.offer_revision
    from private.sc19_payment_grants g join private.sc19_payment_orders o on o.id=g.order_id
    where j.reference like 'settlement:sc19:%' and o.company_id=target_company and o.status='paid'
     and 'settlement:sc19:'||encode(pg_catalog.sha256(pg_catalog.convert_to(g.payment_key,'UTF8')),'hex')=j.reference
    order by o.id limit 1) po on true
  left join private.sc19_payment_offers f on f.id=po.offer_id and f.revision=po.offer_revision
  where j.company_id=target_company and j.reason='paid_grant' and j.delta>0
   and not (j.reference like 'settlement:%' and exists(select 1 from sc19_commerce.orders o
    where o.settlement_reference=substr(j.reference,12)))
  union all
  select 'paid:settlement:'||o.settlement_reference, o.package_code, o.settled_at,
   case when o.quantity between 1 and 20 then o.quantity else 1 end
  from sc19_commerce.orders o
  where o.company_id=target_company and o.status='paid' and o.kind='package' and o.package_code<>'FREE'
 )
 select 'free'::text, 'FREE'::text, min(j.created_at) from private.sc19_credit_journal j
  where j.company_id=target_company and j.reason='trial'
  having count(*)>0
 union all
 select case k when 1 then p.base_key else 'extra:'||k::text||':'||p.base_key end, p.code, p.at
  from purchases p cross join lateral pg_catalog.generate_series(1,p.packages) k
$$;

-- Owner only: close every actual ACL, including inherited defaults.
do $acl$
declare o record;g record;
begin
 for o in select oid,proowner from pg_proc where oid='private.sc19_voice_package_events(uuid)'::regprocedure loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop
   execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;

do $postflight$
begin
 if exists(select 1 from pg_proc p where p.oid=any(array[
   'private.sc19_voice_package_events(uuid)',
   'private.sc19_voice_sync_package_pools(uuid)',
   'private.sc19_voice_grant_topup(uuid,uuid,integer,timestamptz)']::regprocedure[])
  and (not p.prosecdef or p.proconfig is null or p.proconfig[1] is distinct from 'search_path=""'
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))) then
  raise exception 'voice_pool_stripe_packages_function_exposed' using errcode='55000';end if;
end $postflight$;

commit;
