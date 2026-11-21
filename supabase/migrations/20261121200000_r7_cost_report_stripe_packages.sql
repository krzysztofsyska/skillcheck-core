-- R7 (docs/ROADMAP.md, Stripe Checkout) fix: the operator AI cost and margin report
-- (/operator/ai-costs, SC-021-D) attributes a WERYFIKACJA / ASSESSMENT CENTER
-- package bought through Stripe to its own package, not to PRESELEKCJA
-- (Codex P2 on promotion PR #566, thread r4649510675).
--
-- WHY: ai_ledger.package_ranges() (20261110090000_sc021_cost_dashboard.sql) knows a
-- package's code only from sc19_commerce.orders and treats every other 'paid_grant'
-- row of private.sc19_credit_journal as PRESELEKCJA. A Stripe package order lives in
-- sc19_stripe.package_orders (20261121150000_r7_stripe_packages.sql) and its grant
-- (sc19_stripe.grant_package) writes a 'paid_grant' journal row with the reference
-- 'settlement:sc19:'||sha256(payment key). So every AI call after such a purchase was
-- counted for PRESELEKCJA in the per-package cost and margin views, and the payment
-- itself was counted as a PRESELEKCJA payment without amount.
--
-- WHAT CHANGES (functions only, create or replace keeps owner and ACL):
--  * new ai_ledger.stripe_package_settlements(): the journal reference, company and
--    package code of every PAID Stripe package order (package_grants -> package_orders),
--    computed with the same reference formula as sc19_stripe.grant_package. Not
--    security definer, empty search_path, no grantee besides its owner (like the other
--    ai_ledger helpers; only the operator's security definer reads call it).
--  * ai_ledger.package_ranges(): a journal 'paid_grant' row that is such a settlement
--    starts the range of ITS package (WERYFIKACJA / ASSESSMENT_CENTER) at the grant
--    time; every other row keeps the old meaning (PRESELEKCJA operator grant or
--    PRESELEKCJA checkout, FREE trial, catalog orders unchanged).
--  * public.sc021_operator_margin(): body identical except the "payments without
--    amount" branch, which now counts such a payment for its own package. It stays a
--    payment WITHOUT amount, exactly like a PRESELEKCJA checkout: Stripe packages are
--    TEST mode only (grant_package refuses anything else), so no test-mode money is
--    shown as revenue.
-- No table, row, grant, role, price or payment rule changes; nothing is sent. The
-- SC-010 erasure schema signature is unchanged (checked in the postflight).
--
-- Code compatibility: no application code changes; /operator/ai-costs reads the same
-- function signatures before and after this migration.
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261121200000_r7_cost_report_stripe_packages_down.sql.
begin;

do $preflight$
begin
 if to_regprocedure('ai_ledger.package_ranges()') is null
  or to_regprocedure('public.sc021_operator_margin(date,date,text)') is null
  or to_regprocedure('ai_ledger.is_catalog_settlement(text)') is null
  or to_regclass('sc19_stripe.package_orders') is null or to_regclass('sc19_stripe.package_grants') is null then
  raise exception 'r7_cost_report_stripe_packages_requires_sc021_and_stripe_packages' using errcode='55000';end if;
 if to_regprocedure('ai_ledger.stripe_package_settlements()') is not null then
  raise exception 'r7_cost_report_stripe_packages_already_installed' using errcode='55000';end if;
 perform set_config('r7_cost_report_stripe_packages.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

-- Journal reference of every paid Stripe package order. Same formula as
-- sc19_stripe.grant_package; the payment key is the primary key of package_grants,
-- so each reference occurs at most once.
create function ai_ledger.stripe_package_settlements()
returns table (reference text, company_id uuid, package_code text)
language sql stable set search_path = '' as $$
  select 'settlement:sc19:' || encode(sha256(convert_to(g.payment_key, 'UTF8')), 'hex'), o.company_id, o.package_code
  from sc19_stripe.package_grants g join sc19_stripe.package_orders o on o.id = g.order_id
  where o.status = 'paid'
$$;

-- Oś czasu pakietu każdej firmy (jak w 20261110090000), plus: przydział z opłaconego
-- zamówienia Stripe WERYFIKACJA / ASSESSMENT CENTER = jego własny pakiet.
create or replace function ai_ledger.package_ranges()
returns table (company_id uuid, package_code text, t_from timestamptz, t_to timestamptz)
language sql stable set search_path = '' as $$
  select e.company_id, e.pkg, e.t, lead(e.t) over (partition by e.company_id order by e.t, e.pkg)
  from (
    select o.company_id, o.package_code pkg, o.settled_at t from sc19_commerce.orders o
    where o.status = 'paid' and o.kind = 'package'
    union all
    select j.company_id, case j.reason when 'trial' then 'FREE' else coalesce(s.package_code, 'PRESELEKCJA') end, j.created_at
    from private.sc19_credit_journal j
    left join ai_ledger.stripe_package_settlements() s
      on j.reason = 'paid_grant' and s.reference = j.reference and s.company_id = j.company_id
    where j.reason in ('trial', 'paid_grant') and not ai_ledger.is_catalog_settlement(j.reference)
  ) e
$$;

-- Marża (jak w 20261110090000); jedyna zmiana: gałąź „wpłaty bez kwoty” (patrz nagłówek).
create or replace function public.sc021_operator_margin(from_month date, to_month date, group_by text)
returns table (group_key text, group_label text, company_id uuid, company_name text,
  paid_orders bigint, revenue_gross_minor bigint, revenue_net_minor bigint, payments_without_amount bigint,
  ai_cost_pln_minor bigint, other_costs_minor bigint, margin_minor bigint, margin_status text, reasons text[])
language plpgsql stable security definer set search_path = '' as $$
declare f timestamptz; t timestamptz;
begin
  perform private.sc19_require_operator();
  if group_by is null or group_by not in ('total', 'company', 'package', 'month') then
    raise exception 'sc021d_invalid_grouping' using errcode = '22023';
  end if;
  select r.from_ts, r.to_ts into f, t from ai_ledger.month_range(from_month, to_month) r;
  return query
  with rev as (
    select o.company_id cid, o.package_code pkg, ai_ledger.warsaw_month(o.settled_at) mon,
      o.gross_minor::bigint gross, ai_ledger.net_from_gross(o.gross_minor, v.vat_basis_points) net, false no_amount
    from sc19_commerce.orders o join pricing.catalog_versions v on v.id = o.version_id
    where o.status = 'paid' and o.settled_at >= f and o.settled_at < t
    union all
    -- R7: a Stripe WERYFIKACJA / ASSESSMENT CENTER grant counts for its own package, not PRESELEKCJA.
    select j.company_id, coalesce(s.package_code, 'PRESELEKCJA'), ai_ledger.warsaw_month(j.created_at), 0::bigint, 0::bigint, true
    from private.sc19_credit_journal j
    left join ai_ledger.stripe_package_settlements() s on s.reference = j.reference and s.company_id = j.company_id
    where j.reason = 'paid_grant' and j.created_at >= f and j.created_at < t and not ai_ledger.is_catalog_settlement(j.reference)
  ),
  ai as (select c.company_id cid, c.package_code pkg, c.month mon, c.* from ai_ledger.cost_rows(f, t) c),
  -- Koszt bez pakietu przypisujemy pakietowi firmy na koniec swojego miesiąca (czas Europe/Warsaw).
  oth as (
    select l.company_id cid, coalesce(l.package_code, (select r.package_code from ai_ledger.package_ranges() r
        where r.company_id = l.company_id and r.t_from < ((l.period_month + interval '1 month')::timestamp at time zone 'Europe/Warsaw')
          and (r.t_to is null or r.t_to >= ((l.period_month + interval '1 month')::timestamp at time zone 'Europe/Warsaw'))
        order by r.t_from desc limit 1), 'BRAK') pkg,
      l.period_month mon, l.amount_minor
    from ai_ledger.other_cost_lines l
    where l.period_month >= ai_ledger.warsaw_month(f) and l.period_month < ai_ledger.warsaw_month(t)
      and not exists (select 1 from ai_ledger.other_cost_lines s where s.supersedes = l.id)
  ),
  keyed as (
    select case group_by when 'total' then 'all' when 'company' then x.cid::text when 'package' then x.pkg
      else to_char(x.mon, 'YYYY-MM') end k, x.*
    from (
      select 'rev' src, r.cid, r.pkg, r.mon, r.gross, r.net, r.no_amount, null::text cls, null::bigint micros,
        null::bigint rate, null::boolean rate_ph, null::boolean rate_stale, null::bigint other from rev r
      union all
      select 'ai', a.cid, a.pkg, a.mon, null, null, null, a.cost_class, a.cost_micros, a.rate_micros, a.rate_placeholder, a.rate_stale, null from ai a
      union all
      select 'oth', o.cid, o.pkg, o.mon, null, null, null, null, null, null, null, null, o.amount_minor from oth o
      union all
      -- Żywe rezerwacje SC-021-C: nie są kosztem, ale marża z nimi jest szacunkiem.
      select 'res', y.company_id, y.package_code, y.month, null, null, null, 'held', null, null, null, null, null
      from ai_ledger.live_reservations(f, t, clock_timestamp()) y
    ) x
  ),
  agg as (
    select k.k,
      case when group_by = 'company' then (array_agg(k.cid))[1] end cid,
      count(*) filter (where k.src = 'rev' and not k.no_amount) orders,
      coalesce(sum(k.gross) filter (where k.src = 'rev'), 0)::bigint gross,
      coalesce(sum(k.net) filter (where k.src = 'rev'), 0)::bigint net,
      count(*) filter (where k.src = 'rev' and k.no_amount) no_amount,
      coalesce(bool_or(k.src = 'ai' and k.cls in ('confirmed', 'placeholder') and k.rate is null), false) fx_missing,
      coalesce(bool_or(k.src = 'ai' and k.cls in ('confirmed', 'placeholder') and k.rate_ph), false) fx_ph,
      coalesce(bool_or(k.src = 'ai' and k.cls in ('confirmed', 'placeholder') and k.rate_stale), false) fx_stale,
      coalesce(bool_or(k.src = 'ai' and k.cls = 'placeholder'), false) price_ph,
      coalesce(bool_or(k.src = 'ai' and k.cls = 'unpriced'), false) unpriced,
      coalesce(bool_or(k.src = 'ai' and k.cls = 'unknown'), false) unknown,
      coalesce(bool_or((k.src = 'ai' and k.cls = 'reserved') or k.src = 'res'), false) reserved,
      ceil(coalesce(sum(k.micros::numeric * k.rate) filter (where k.src = 'ai' and k.cls in ('confirmed', 'placeholder')), 0)
        / 10000000000)::bigint ai_pln,
      coalesce(sum(k.other) filter (where k.src = 'oth'), 0)::bigint other
    from keyed k group by k.k
  ),
  flagged as (
    select a.*, array_remove(array[
        case when a.fx_missing then 'fx_missing' end,
        case when a.fx_ph then 'fx_placeholder' end,
        case when a.fx_stale then 'fx_stale' end,
        case when a.price_ph then 'placeholder_prices' end,
        case when a.unpriced then 'unpriced_attempts' end,
        case when a.unknown then 'unknown_attempts' end,
        case when a.reserved then 'reserved_not_counted' end,
        case when a.no_amount > 0 then 'payments_without_amount' end], null) why
    from agg a
  )
  select a.k,
    case group_by when 'total' then 'Razem' when 'company' then coalesce(co.name, 'Firma usunięta')
      when 'package' then ai_ledger.package_label(a.k) else a.k end,
    a.cid, co.name, a.orders, a.gross, a.net, a.no_amount,
    case when a.fx_missing then null else a.ai_pln end,
    a.other,
    case when a.fx_missing then null else a.net - a.ai_pln - a.other end,
    case when a.fx_missing then 'unavailable' when cardinality(a.why) > 0 then 'estimated' else 'confirmed' end,
    a.why
  from flagged a
  left join public.companies co on co.id = a.cid
  order by a.k;
end;
$$;

-- The new helper: no grantee besides its owner (revokes any default privileges).
do $acl$
declare g record;
begin
  revoke all on function ai_ledger.stripe_package_settlements() from public;
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
    join pg_roles r on r.oid = a.grantee
    where p.oid = 'ai_ledger.stripe_package_settlements()'::regprocedure and a.grantee <> p.proowner loop
    execute format('revoke all on function ai_ledger.stripe_package_settlements() from %I', g.rolname);
  end loop;
end
$acl$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_cost_report_stripe_packages.signature_before') then
  raise exception 'r7_cost_report_stripe_packages_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
