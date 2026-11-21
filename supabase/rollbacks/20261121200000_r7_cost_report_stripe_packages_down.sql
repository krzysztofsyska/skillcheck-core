-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback of 20261121200000_r7_cost_report_stripe_packages.sql: restores the bodies of
-- ai_ledger.package_ranges() and public.sc021_operator_margin(date,date,text) verbatim
-- from 20261110090000_sc021_cost_dashboard.sql (create or replace keeps owner and ACL),
-- then drops ai_ledger.stripe_package_settlements(). Functions only: no row, table or
-- grant changes; the SC-010 erasure schema signature is unaffected. After it, Stripe
-- WERYFIKACJA / ASSESSMENT CENTER grants are again reported as PRESELEKCJA.
-- Run with `psql -v ON_ERROR_STOP=1`.
begin;

create or replace function ai_ledger.package_ranges()
returns table (company_id uuid, package_code text, t_from timestamptz, t_to timestamptz)
language sql stable set search_path = '' as $$
  select e.company_id, e.pkg, e.t, lead(e.t) over (partition by e.company_id order by e.t, e.pkg)
  from (
    select o.company_id, o.package_code pkg, o.settled_at t from sc19_commerce.orders o
    where o.status = 'paid' and o.kind = 'package'
    union all
    select j.company_id, case j.reason when 'trial' then 'FREE' else 'PRESELEKCJA' end, j.created_at
    from private.sc19_credit_journal j
    where j.reason in ('trial', 'paid_grant') and not ai_ledger.is_catalog_settlement(j.reference)
  ) e
$$;


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
    select j.company_id, 'PRESELEKCJA', ai_ledger.warsaw_month(j.created_at), 0::bigint, 0::bigint, true
    from private.sc19_credit_journal j
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

drop function ai_ledger.stripe_package_settlements();

commit;
