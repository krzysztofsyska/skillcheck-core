-- R6-2 (packages), fix: 10 voice interviews PER package, also when one payment
-- bought several packages. Owner decision 20.11.2026 (docs/DECYZJE.md): FREE 1;
-- PRESELEKCJA, WERYFIKACJA, ASSESSMENT_CENTER 10 each. Review finding on PR #566:
-- private.sc19_voice_package_events (20261121130000) turned one settled payment
-- into ONE package, so 2 PRESELEKCJA packages bought in one payment gave 10
-- interviews instead of 20.
--
-- Only the body of private.sc19_voice_package_events(uuid) changes (same name,
-- arguments and result columns, so every caller keeps working: the package
-- sync and the prepared top-up). It now returns one row PER PACKAGE:
--   * the first package of a purchase keeps the key it had before, so a pool
--     that already exists is recognised and never granted again;
--   * every further package k (2..n) of the same purchase gets its own key
--     'extra:'||k||':'||<key of the purchase>. No purchase key starts with
--     'extra:' ('free' or 'paid:...'), so the keys never collide. The sync
--     turns each key into its own derived grant reference, takes the same
--     per-reference advisory lock and relies on unique(grant_reference), so an
--     extra package of an already synced purchase is added exactly once, and
--     retries and parallel calls never grant twice. Every package of one
--     purchase has the same 3-month window (from the purchase).
--
-- How many packages a purchase is (derived from what was really bought; when
-- that cannot be shown, ONE package: fail-safe, never more):
--   * catalog order (sc19_commerce.orders, kind 'package', paid): its quantity
--     when 1..20, otherwise 1;
--   * PRESELEKCJA checkout (journal row 'settlement:sc19:'||sha256(payment key),
--     written by the payment store together with private.sc19_payment_grants):
--     the paid order of that payment key, for the same company, whose credits
--     equal the journal row; packages = order credits / credits of the offer
--     revision it was bought under, only when it is a whole number 1..20 and
--     the amount is the same whole multiple of the offer price (the checkout's
--     own rule, MAX_PACKAGES = 20 in lib/stripe-catalog.ts); a matched order
--     that does not satisfy this is 1 package;
--   * any other 'paid_grant' row (operator grant sc19_grant_paid, legacy pack):
--     only CV credits are known: credits / 60 (1 package = 60 CV, 300 zł,
--     docs/cennik-2026-11-02.md) when it divides exactly and is 1..10,
--     otherwise 1.
-- 20 and 10 are upper bounds that stop a malformed row from creating many
-- pools; above them the purchase counts as 1 package (never more).
--
-- Functions only: no table, column, constraint or trigger is added or changed,
-- so the SC-010 erasure schema signature stays as it is. Package, order,
-- payment and journal data is only READ. security definer, search_path='',
-- nothing granted to anon, authenticated, service_role or any other role.
-- Not visible to customers; nothing is sent; no provider is called.
begin;

do $preflight$
begin
 if to_regprocedure('private.sc19_voice_package_events(uuid)') is null
  or to_regprocedure('private.sc19_voice_sync_package_pools(uuid)') is null
  or to_regprocedure('private.sc19_voice_package_reference(uuid,text,text)') is null then
  raise exception 'voice_pool_package_count_requires_package_pools' using errcode='55000';end if;
 if to_regclass('private.sc19_credit_journal') is null or to_regclass('sc19_commerce.orders') is null
  or to_regclass('private.sc19_payment_orders') is null or to_regclass('private.sc19_payment_offers') is null
  or to_regclass('private.sc19_payment_grants') is null then
  raise exception 'voice_pool_package_count_requires_packages' using errcode='55000';end if;
 if exists(select 1 from pg_proc p where p.oid='private.sc19_voice_package_events(uuid)'::regprocedure
   and pg_catalog.pg_get_functiondef(p.oid) like '%extra:%') then
  raise exception 'voice_pool_package_count_already_installed' using errcode='55000';end if;
end $preflight$;

-- The packages of ONE company: one row per package, read-only.
-- key 'free' (at most one), 'paid:settlement:'||reference / 'paid:journal:'||id
-- for the first package of a purchase, 'extra:'||k||':'||that key for package k>1.
create or replace function private.sc19_voice_package_events(target_company uuid)
returns table(package_key text, package_code text, occurred_at timestamptz)
language sql stable security definer set search_path='' as $$
 with purchases as (
  -- A legacy pack (operator grant or PRESELEKCJA checkout): only PRESELEKCJA
  -- writes such a row. A row that a catalog order settled is that order's package.
  select 'paid:'||coalesce(j.reference,'journal:'||j.id::text) as base_key, 'PRESELEKCJA'::text as code, j.created_at as at,
   case
    when po.id is not null then
     case when po.credits=j.delta and f.credits>0 and po.credits%f.credits=0
       and po.credits/f.credits between 1 and 20 and po.amount_minor=f.amount_minor*(po.credits/f.credits)
      then po.credits/f.credits else 1 end
    when j.delta%60=0 and j.delta/60 between 1 and 10 then j.delta/60
    else 1 end as packages
  from private.sc19_credit_journal j
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
  raise exception 'voice_pool_package_count_function_exposed' using errcode='55000';end if;
end $postflight$;

commit;
