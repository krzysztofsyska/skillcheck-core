-- Operational rollback for 20261121160000_r6_voice_pool_package_count.sql:
-- restores the previous body of private.sc19_voice_package_events(uuid)
-- (verbatim from 20261121130000_r6_voice_package_pools.sql: one row per
-- purchase). Pools already given for extra packages stay (the pool guard
-- forbids deletion) and keep their derived references, so a later forward
-- migration never grants the same package twice. Functions only: the SC-010
-- erasure schema signature is unaffected; the ACL stays owner-only.
begin;
-- The packages of ONE company: one row per package, read-only.
-- key 'free' (at most one) or 'paid:settlement:'||reference / 'paid:journal:'||id.
create or replace function private.sc19_voice_package_events(target_company uuid)
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
   and not (j.reference like 'settlement:%' and exists(select 1 from sc19_commerce.orders o
    where o.settlement_reference=substr(j.reference,12)))
 union all
 select 'paid:settlement:'||o.settlement_reference, o.package_code, o.settled_at from sc19_commerce.orders o
  where o.company_id=target_company and o.status='paid' and o.kind='package' and o.package_code<>'FREE'
$$;
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
