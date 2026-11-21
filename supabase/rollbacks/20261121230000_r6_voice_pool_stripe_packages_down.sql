-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Operational rollback for 20261121230000_r6_voice_pool_stripe_packages.sql:
-- restores the previous body of private.sc19_voice_package_events(uuid)
-- (verbatim from 20261121160000_r6_voice_pool_package_count.sql: 10 interviews
-- per package, Stripe package orders not recognised). Pools already given stay
-- (the pool guard forbids deletion) and keep their references, so a later
-- forward migration never grants the same package twice. Functions only: the
-- SC-010 erasure schema signature is unaffected; the ACL stays owner-only.
-- Run with `psql -v ON_ERROR_STOP=1`.
begin;
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
commit;
