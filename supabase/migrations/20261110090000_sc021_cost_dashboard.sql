-- SC-021-D — panel kosztów AI i marży (tylko operator).
--
-- Odczyt rejestru prób AI (ai_ledger.attempts, SC-021-B) w przekrojach: firma, rekrutacja,
-- kandydat (pseudonim), pakiet, model, dostawca, zadanie, miesiąc. Marża kontrybucyjna:
-- przychód netto z opłaconych zamówień katalogowych (sc19_commerce.orders, netto = brutto − VAT
-- wg vat_basis_points wersji katalogu, z której zamówienie wyceniono) − koszt AI w PLN − inne
-- koszty zmienne wpisane przez operatora.
--
-- Nowe tabele leżą w schemacie ai_ledger (poza public/private, bez kluczy obcych do tych
-- schematów), więc sygnatura inwentarza SC-010 (R15) się nie zmienia (preflight/postflight).
-- Funkcje odczytu w public (RPC) nie wchodzą do sygnatury; każda sprawdza operatora
-- (private.sc19_require_operator — ta sama lista co /operator/billing).
--
-- Kursy walut (ai_ledger.fx_rates) i inne koszty zmienne (ai_ledger.other_cost_lines) są tylko
-- dopisywane: korekta to nowy wiersz (kurs: ta sama data obowiązywania, nowszy wpis wygrywa;
-- koszt: wiersz `supersedes` wskazujący poprzednią wersję). Każdy wiersz ma autora i czas.
-- W migracji jest WYŁĄCZNIE kurs testowy USD→PLN (placeholder = true). To nie jest kurs NBP ani
-- rynkowy. Marża policzona na nim jest oznaczona jako szacunek. Brak kursu → koszt w PLN i marża
-- niedostępne (NULL), nigdy zgadywane. Żadnych prawdziwych kosztów innych nie wpisujemy.
--
-- Klasy kosztu próby (rozłączne):
--   confirmed   — settled, wyceniona stawką zatwierdzoną (approved, nie testową);
--   placeholder — settled, wyceniona stawką testową (szacunek, nie koszt rzeczywisty);
--   unpriced    — settled, brak stawki (koszt NULL; koszt zaniżony);
--   unknown     — maybe billed bez tokenów (koszt nieznany);
--   released    — not billed (0);
--   reserved    — rezerwacja SC-021-C (nie wliczana do kosztu; punkt rozszerzenia).
-- bounds_exceeded to osobna flaga (anomalia), niezależna od klasy.
--
-- Zaokrąglenia (arytmetyka całkowita na numeric, bez float):
--   koszt PLN [grosze] = ceil(Σ cost_micros · rate_micros / 10^10) na grupę (w górę: koszt
--     nigdy niedoszacowany; suma grup może przekroczyć całość o < 1 gr na grupę);
--   netto [grosze] = round_half_up(brutto · 10000 / (10000 + vat_bp)) na zamówienie.
begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc021d_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regclass('ai_ledger.attempts') is null or to_regclass('sc19_commerce.orders') is null
    or to_regclass('pricing.catalog_versions') is null or to_regclass('private.sc19_credit_journal') is null
    or to_regprocedure('private.sc19_require_operator()') is null then
    raise exception 'sc021d_dependency_missing' using errcode = '55000';
  end if;
  if to_regclass('ai_ledger.fx_rates') is not null or to_regclass('ai_ledger.other_cost_lines') is not null then
    raise exception 'sc021d_already_installed' using errcode = '55000';
  end if;
end
$preflight$;

-- Kurs: ile PLN za 1 jednostkę waluty bazowej, skalowane ×1 000 000 (4,123456 PLN/USD = 4123456).
create table ai_ledger.fx_rates (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  base_currency text not null check (base_currency in ('USD', 'EUR')),
  quote_currency text not null default 'PLN' check (quote_currency = 'PLN'),
  rate_micros bigint not null check (rate_micros between 1 and 1000000000),
  valid_from timestamptz not null,
  placeholder boolean not null,
  source_note text not null check (length(btrim(source_note)) between 3 and 300),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  -- NULL autor = wiersz z migracji (wyłącznie stawka testowa).
  check (created_by is not null or placeholder)
);
create index fx_rates_lookup on ai_ledger.fx_rates (base_currency, valid_from desc);

-- Inne koszty zmienne (opłaty płatnicze, SMS, e-mail, inne) — netto, PLN, na miesiąc i firmę,
-- opcjonalnie przypisane do pakietu. Wpisuje wyłącznie operator.
create table ai_ledger.other_cost_lines (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  company_id uuid not null,
  package_code text check (package_code in ('FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER')),
  category text not null check (category in ('payment_fee', 'sms', 'email', 'other')),
  amount_minor bigint not null check (amount_minor between 0 and 10000000000),
  currency text not null default 'PLN' check (currency = 'PLN'),
  note text check (note is null or length(note) <= 300),
  supersedes uuid unique references ai_ledger.other_cost_lines (id),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check (supersedes is distinct from id)
);
create index other_cost_lines_period on ai_ledger.other_cost_lines (period_month, company_id);

create trigger fx_rates_append_only before update or delete on ai_ledger.fx_rates
  for each row execute function ai_ledger.append_only();
create trigger other_cost_lines_append_only before update or delete on ai_ledger.other_cost_lines
  for each row execute function ai_ledger.append_only();

alter table ai_ledger.fx_rates enable row level security;
alter table ai_ledger.other_cost_lines enable row level security;
revoke all on ai_ledger.fx_rates, ai_ledger.other_cost_lines from public;
do $revoke$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'screening_worker', 'ai_ledger_writer'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on ai_ledger.fx_rates, ai_ledger.other_cost_lines from %I', r);
    end if;
  end loop;
end
$revoke$;

-- Zakres miesięcy (włącznie) w czasie Europe/Warsaw → [od, do). Maks. 24 miesiące.
create function ai_ledger.month_range(from_month date, to_month date, out from_ts timestamptz, out to_ts timestamptz)
language plpgsql stable set search_path = '' as $$
declare f date := date_trunc('month', from_month)::date; t date := date_trunc('month', to_month)::date;
begin
  if f is null or t is null or t < f or t > (f + interval '23 months')::date then
    raise exception 'sc021d_invalid_period' using errcode = '22023';
  end if;
  from_ts := f::timestamp at time zone 'Europe/Warsaw';
  to_ts := (t + interval '1 month')::timestamp at time zone 'Europe/Warsaw';
end;
$$;

create function ai_ledger.warsaw_month(at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select date_trunc('month', at at time zone 'Europe/Warsaw')::date
$$;

create function ai_ledger.cost_class(status text, price_id uuid, price_placeholder boolean) returns text
language sql immutable set search_path = '' as $$
  select case status
    when 'released' then 'released'
    when 'reserved' then 'reserved'
    when 'unknown' then 'unknown'
    when 'settled' then case when price_id is null then 'unpriced' when price_placeholder then 'placeholder' else 'confirmed' end
  end
$$;

-- Kurs waluty → PLN obowiązujący w chwili `at` (= created_at próby): kurs prawdziwy przed testowym
-- (także starszy — wtedy marża dostaje powód fx_stale, gdy ma > 45 dni), najnowszy valid_from, przy
-- tej samej dacie najnowszy wpis (korekta). PLN = 1. Brak → brak wiersza.
create function ai_ledger.fx_to_pln(currency text, at timestamptz, out rate_micros bigint, out placeholder boolean,
  out stale boolean)
returns setof record language sql stable set search_path = '' as $$
  select 1000000::bigint, false, false where currency = 'PLN'
  union all
  (select f.rate_micros, f.placeholder, not f.placeholder and f.valid_from < at - interval '45 days' from ai_ledger.fx_rates f
   where currency <> 'PLN' and f.base_currency = currency and f.quote_currency = 'PLN' and f.valid_from <= at
   order by f.placeholder asc, f.valid_from desc, f.created_at desc, f.id
   limit 1)
$$;

-- Netto z brutto: round_half_up(brutto · 10000 / (10000 + vat_bp)), liczby całkowite.
create function ai_ledger.net_from_gross(gross_minor bigint, vat_basis_points integer) returns bigint
language sql immutable set search_path = '' as $$
  select ((gross_minor * 20000 + (10000 + vat_basis_points)) / (2 * (10000 + vat_basis_points)))::bigint
$$;

-- Wpłaty bez kwoty w systemie: przydział PRESELEKCJI z dziennika analiz, który nie jest
-- rozliczeniem zamówienia katalogowego (ręczny przydział operatora, przyszłe P24).
-- Porównanie po settlement_reference (unikalny indeks), nie po wyrażeniu na kolumnie.
create function ai_ledger.is_catalog_settlement(reference text) returns boolean
language sql stable set search_path = '' as $$
  select reference like 'settlement:%' and exists (select 1 from sc19_commerce.orders o
    where o.settlement_reference = substr(reference, 12) and o.status = 'paid')
$$;

-- Oś czasu pakietu każdej firmy, liczona raz na zapytanie: zdarzenia (opłacone zamówienie pakietu
-- → jego kod, ręczny przydział PRESELEKCJI, aktywacja FREE) jako przedziały [od, do następnego).
-- Pakiet w chwili t = przedział zawierający t; brak → 'BRAK'.
create function ai_ledger.package_ranges()
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

-- Wiersze kosztu w okresie, z klasą, tożsamością operacji (reguła z SC-021-B), kursem i pakietem.
-- Tożsamość operacji: screening = operation_id; pozostałe = (firma, rekrutacja, operation_id).
create function ai_ledger.cost_rows(from_ts timestamptz, to_ts timestamptz)
returns table (company_id uuid, process_id uuid, candidate_ref uuid, task text, provider text, model text,
  op_key text, cost_class text, currency text, cost_micros bigint, reserved_micros bigint, bounds_exceeded boolean,
  rate_micros bigint, rate_placeholder boolean, rate_stale boolean, package_code text, month date)
language sql stable set search_path = '' as $$
  with ranges as materialized (select * from ai_ledger.package_ranges())
  select a.company_id, a.process_id, a.candidate_ref, a.task, a.provider, a.model,
    case when a.task = 'cv_screening' then 's:' || a.operation_id
      else 'x:' || a.company_id || ':' || coalesce(a.process_id::text, '-') || ':' || a.operation_id end,
    ai_ledger.cost_class(a.status, a.price_id, a.price_placeholder),
    a.currency, a.cost_micros, a.reserved_micros, a.bounds_exceeded,
    fx.rate_micros, fx.placeholder, fx.stale,
    coalesce(r.package_code, 'BRAK'),
    ai_ledger.warsaw_month(a.created_at)
  from ai_ledger.attempts a
  left join lateral ai_ledger.fx_to_pln(a.currency, a.created_at) fx on true
  left join ranges r on r.company_id = a.company_id and a.created_at >= r.t_from and (r.t_to is null or a.created_at < r.t_to)
  where a.created_at >= from_ts and a.created_at < to_ts
$$;

-- Klucz pseudonimów kandydatów: losowy, generowany raz w migracji, nigdy nie zwracany; bez niego
-- pseudonimu nie da się policzyć z identyfikatora zgłoszenia. Brak dostępu dla ról API.
create table ai_ledger.pseudonym_key (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (length(secret) = 32)
);
alter table ai_ledger.pseudonym_key enable row level security;
revoke all on ai_ledger.pseudonym_key from public;
insert into ai_ledger.pseudonym_key (secret) values (extensions.gen_random_bytes(32));
create trigger pseudonym_key_append_only before update or delete on ai_ledger.pseudonym_key
  for each row execute function ai_ledger.append_only();
do $revoke_key$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'screening_worker', 'ai_ledger_writer'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on ai_ledger.pseudonym_key from %I', r);
    end if;
  end loop;
end
$revoke_key$;

-- Pseudonim: 'K-' + 16 znaków HMAC-SHA256(klucz, id zgłoszenia).
create function ai_ledger.candidate_pseudonym(candidate_ref uuid) returns text
language sql stable set search_path = '' as $$
  select 'K-' || upper(left(encode(extensions.hmac(convert_to(candidate_ref::text, 'UTF8'), k.secret, 'sha256'), 'hex'), 16))
  from ai_ledger.pseudonym_key k where k.singleton
$$;

create function ai_ledger.package_label(code text) returns text
language sql immutable set search_path = '' as $$
  select case code when 'FREE' then 'FREE' when 'PRESELEKCJA' then 'PRESELEKCJA' when 'WERYFIKACJA' then 'WERYFIKACJA'
    when 'ASSESSMENT_CENTER' then 'ASSESSMENT CENTER' else 'Bez pakietu' end
$$;

-- Koszty AI w przekroju. Kandydat wyłącznie jako pseudonim (skrót z identyfikatora zgłoszenia);
-- funkcja nigdy nie zwraca identyfikatora zgłoszenia ani danych osobowych.
create function public.sc021_operator_ai_costs(from_month date, to_month date, group_by text)
returns table (group_key text, group_label text, company_id uuid, company_name text,
  attempts bigint, operations bigint,
  confirmed_count bigint, placeholder_count bigint, unpriced_count bigint, unknown_count bigint,
  released_count bigint, reserved_count bigint, bounds_exceeded_count bigint,
  cost_micros jsonb, confirmed_pln_minor bigint, placeholder_pln_minor bigint,
  fx_missing boolean, fx_placeholder boolean, fx_stale boolean)
language plpgsql stable security definer set search_path = '' as $$
declare f timestamptz; t timestamptz;
begin
  perform private.sc19_require_operator();
  if group_by is null or group_by not in ('total', 'company', 'recruitment', 'candidate', 'package', 'model', 'provider', 'task', 'month') then
    raise exception 'sc021d_invalid_grouping' using errcode = '22023';
  end if;
  select r.from_ts, r.to_ts into f, t from ai_ledger.month_range(from_month, to_month) r;
  return query
  with base as (
    select c.*,
      case group_by
        when 'total' then 'all'
        when 'company' then c.company_id::text
        when 'recruitment' then c.company_id || ':' || coalesce(c.process_id::text, '-')
        when 'candidate' then case when c.candidate_ref is null then 'none'
          else ai_ledger.candidate_pseudonym(c.candidate_ref) end
        when 'package' then c.package_code
        when 'model' then c.provider || ':' || c.model
        when 'provider' then c.provider
        when 'task' then c.task
        when 'month' then to_char(c.month, 'YYYY-MM')
      end k
    from ai_ledger.cost_rows(f, t) c
  ),
  money as (
    select b.k, jsonb_object_agg(b.cur, jsonb_build_object('confirmed', b.confirmed, 'placeholder', b.placeholder, 'reserved', b.reserved)) j
    from (select x.k, coalesce(x.currency, '?') cur,
        coalesce(sum(x.cost_micros) filter (where x.cost_class = 'confirmed'), 0) confirmed,
        coalesce(sum(x.cost_micros) filter (where x.cost_class = 'placeholder'), 0) placeholder,
        coalesce(sum(x.reserved_micros) filter (where x.cost_class = 'reserved'), 0) reserved
      from base x where x.cost_class in ('confirmed', 'placeholder', 'reserved') group by 1, 2) b
    group by b.k
  ),
  agg as (
    select b.k,
      -- Firma grupy: jednoznaczna dla przekrojów firma / rekrutacja / kandydat.
      case when group_by in ('company', 'recruitment', 'candidate') and count(distinct b.company_id) = 1
        then (array_agg(b.company_id))[1] end cid,
      (array_agg(b.process_id))[1] pid,
      count(*) n, count(distinct b.op_key) ops,
      count(*) filter (where b.cost_class = 'confirmed') c_confirmed,
      count(*) filter (where b.cost_class = 'placeholder') c_placeholder,
      count(*) filter (where b.cost_class = 'unpriced') c_unpriced,
      count(*) filter (where b.cost_class = 'unknown') c_unknown,
      count(*) filter (where b.cost_class = 'released') c_released,
      count(*) filter (where b.cost_class = 'reserved') c_reserved,
      count(*) filter (where b.bounds_exceeded) c_bounds,
      bool_or(b.cost_class = 'confirmed' and b.rate_micros is null) miss_confirmed,
      bool_or(b.cost_class = 'placeholder' and b.rate_micros is null) miss_placeholder,
      coalesce(sum(b.cost_micros::numeric * b.rate_micros) filter (where b.cost_class = 'confirmed'), 0) pln_confirmed,
      coalesce(sum(b.cost_micros::numeric * b.rate_micros) filter (where b.cost_class = 'placeholder'), 0) pln_placeholder,
      coalesce(bool_or(b.cost_class in ('confirmed', 'placeholder') and b.rate_placeholder), false) fx_ph,
      coalesce(bool_or(b.cost_class in ('confirmed', 'placeholder') and b.rate_stale), false) fx_old
    from base b group by b.k
  )
  select a.k,
    case group_by
      when 'total' then 'Razem'
      when 'company' then coalesce(co.name, 'Firma usunięta')
      when 'recruitment' then case when a.pid is null then 'Bez rekrutacji' else coalesce(rc.name, 'Rekrutacja usunięta') end
      when 'candidate' then case when a.k = 'none' then 'Bez kandydata (np. generowanie zadań)' else 'Kandydat ' || a.k end
      when 'package' then ai_ledger.package_label(a.k)
      when 'model' then a.k
      when 'provider' then a.k
      when 'task' then case a.k when 'cv_screening' then 'Analiza CV' when 'exercise_generation' then 'Generowanie zadań'
        when 'competency_test_generation' then 'Generowanie testu kompetencji' when 'interview_plan' then 'Plan rozmowy'
        when 'report_summary' then 'Podsumowanie raportu' else a.k end
      when 'month' then a.k
    end,
    a.cid, co.name,
    a.n, a.ops, a.c_confirmed, a.c_placeholder, a.c_unpriced, a.c_unknown, a.c_released, a.c_reserved, a.c_bounds,
    coalesce(m.j, '{}'::jsonb),
    case when a.miss_confirmed then null else ceil(a.pln_confirmed / 10000000000)::bigint end,
    case when a.miss_placeholder then null else ceil(a.pln_placeholder / 10000000000)::bigint end,
    a.miss_confirmed or a.miss_placeholder, a.fx_ph, a.fx_old
  from agg a
  left join money m on m.k = a.k
  left join public.companies co on co.id = a.cid
  left join public.recruitments rc on group_by = 'recruitment' and rc.id = a.pid
  order by a.k;
end;
$$;

-- Marża kontrybucyjna (wewnętrzna, tylko operator): przychód netto − koszt AI (PLN) − inne koszty.
-- Status: 'unavailable' gdy brakuje kursu dla wycenionego kosztu; 'estimated' gdy cokolwiek jest
-- szacunkiem lub niepełne; inaczej 'confirmed'. Powody w `reasons`.
create function public.sc021_operator_margin(from_month date, to_month date, group_by text)
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
      coalesce(bool_or(k.src = 'ai' and k.cls = 'reserved'), false) reserved,
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

create function public.sc021_operator_fx_rates()
returns table (id uuid, base_currency text, quote_currency text, rate_micros bigint, valid_from timestamptz,
  placeholder boolean, source_note text, created_at timestamptz, from_migration boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.sc19_require_operator();
  return query select f.id, f.base_currency, f.quote_currency, f.rate_micros, f.valid_from, f.placeholder, f.source_note,
    f.created_at, f.created_by is null
  from ai_ledger.fx_rates f order by f.base_currency, f.valid_from desc, f.created_at desc limit 200;
end;
$$;

create function public.sc021_operator_add_fx_rate(request_key uuid, base_currency text, rate_micros bigint,
  valid_from timestamptz, source_note text, placeholder boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.sc19_require_operator(); existing ai_ledger.fx_rates; new_id uuid;
begin
  if request_key is null or base_currency is null or base_currency not in ('USD', 'EUR')
    or rate_micros is null or rate_micros not between 1 and 1000000000 or valid_from is null
    or source_note is null or length(btrim(source_note)) not between 3 and 300 or placeholder is null then
    raise exception 'sc021d_invalid_fx_rate' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sc021d:' || request_key::text, 0));
  select * into existing from ai_ledger.fx_rates x where x.request_key = sc021_operator_add_fx_rate.request_key;
  if found then
    if existing.base_currency <> base_currency or existing.rate_micros <> rate_micros or existing.valid_from <> valid_from
      or existing.placeholder <> placeholder or existing.source_note <> btrim(source_note) then
      raise exception 'sc021d_request_conflict' using errcode = 'PT409';
    end if;
    return existing.id;
  end if;
  insert into ai_ledger.fx_rates (request_key, base_currency, rate_micros, valid_from, placeholder, source_note, created_by)
  values (request_key, base_currency, rate_micros, valid_from, placeholder, btrim(source_note), actor)
  returning id into new_id;
  return new_id;
end;
$$;

create function public.sc021_operator_other_costs(from_month date, to_month date)
returns table (id uuid, period_month date, company_id uuid, company_name text, package_code text, category text,
  amount_minor bigint, note text, supersedes uuid, superseded boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare f timestamptz; t timestamptz;
begin
  perform private.sc19_require_operator();
  select r.from_ts, r.to_ts into f, t from ai_ledger.month_range(from_month, to_month) r;
  return query select l.id, l.period_month, l.company_id, co.name, l.package_code, l.category, l.amount_minor, l.note,
    l.supersedes, exists (select 1 from ai_ledger.other_cost_lines s where s.supersedes = l.id), l.created_at
  from ai_ledger.other_cost_lines l left join public.companies co on co.id = l.company_id
  where l.period_month >= ai_ledger.warsaw_month(f) and l.period_month < ai_ledger.warsaw_month(t)
  order by l.period_month desc, co.name, l.created_at desc limit 500;
end;
$$;

create function public.sc021_operator_add_other_cost(request_key uuid, period_month date, target_company uuid,
  package_code text, category text, amount_minor bigint, note text, supersedes uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.sc19_require_operator(); existing ai_ledger.other_cost_lines; prior ai_ledger.other_cost_lines;
  new_id uuid; clean_note text := nullif(btrim(note), '');
begin
  if request_key is null or period_month is null or period_month <> date_trunc('month', period_month)::date
    or target_company is null or category is null or category not in ('payment_fee', 'sms', 'email', 'other')
    or (package_code is not null and package_code not in ('FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER'))
    or amount_minor is null or amount_minor not between 0 and 10000000000
    or (clean_note is not null and length(clean_note) > 300) then
    raise exception 'sc021d_invalid_cost_line' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sc021d:' || request_key::text, 0));
  select * into existing from ai_ledger.other_cost_lines x where x.request_key = sc021_operator_add_other_cost.request_key;
  if found then
    if existing.period_month <> period_month or existing.company_id <> target_company
      or existing.package_code is distinct from package_code or existing.category <> category
      or existing.amount_minor <> amount_minor or existing.note is distinct from clean_note
      or existing.supersedes is distinct from supersedes then
      raise exception 'sc021d_request_conflict' using errcode = 'PT409';
    end if;
    return existing.id;
  end if;
  if not exists (select 1 from public.companies c where c.id = target_company) then
    raise exception 'sc021d_company_unavailable' using errcode = 'PT404';
  end if;
  if supersedes is not null then
    perform pg_advisory_xact_lock(hashtextextended('sc021d:supersedes:' || supersedes::text, 0));
    select * into prior from ai_ledger.other_cost_lines x where x.id = sc021_operator_add_other_cost.supersedes;
    if not found or prior.period_month <> period_month or prior.company_id <> target_company
      or prior.package_code is distinct from package_code or prior.category <> category then
      raise exception 'sc021d_invalid_cost_line' using errcode = '22023';
    end if;
    if exists (select 1 from ai_ledger.other_cost_lines x where x.supersedes = prior.id) then
      raise exception 'sc021d_cost_line_already_corrected' using errcode = 'PT409';
    end if;
  end if;
  insert into ai_ledger.other_cost_lines (request_key, period_month, company_id, package_code, category, amount_minor,
    note, supersedes, created_by)
  values (request_key, period_month, target_company, package_code, category, amount_minor, clean_note, supersedes, actor)
  returning id into new_id;
  return new_id;
end;
$$;

do $acl$
declare o record; g record;
begin
  for o in select p.oid, p.proowner from pg_proc p where p.oid = any(array[
    'ai_ledger.month_range(date,date)'::regprocedure,
    'ai_ledger.warsaw_month(timestamptz)'::regprocedure,
    'ai_ledger.cost_class(text,uuid,boolean)'::regprocedure,
    'ai_ledger.fx_to_pln(text,timestamptz)'::regprocedure,
    'ai_ledger.net_from_gross(bigint,integer)'::regprocedure,
    'ai_ledger.is_catalog_settlement(text)'::regprocedure,
    'ai_ledger.package_ranges()'::regprocedure,
    'ai_ledger.candidate_pseudonym(uuid)'::regprocedure,
    'ai_ledger.cost_rows(timestamptz,timestamptz)'::regprocedure,
    'ai_ledger.package_label(text)'::regprocedure,
    'public.sc021_operator_ai_costs(date,date,text)'::regprocedure,
    'public.sc021_operator_margin(date,date,text)'::regprocedure,
    'public.sc021_operator_fx_rates()'::regprocedure,
    'public.sc021_operator_add_fx_rate(uuid,text,bigint,timestamptz,text,boolean)'::regprocedure,
    'public.sc021_operator_other_costs(date,date)'::regprocedure,
    'public.sc021_operator_add_other_cost(uuid,date,uuid,text,text,bigint,text,uuid)'::regprocedure]) loop
    execute format('revoke all on function %s from public', o.oid::regprocedure);
    for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
      join pg_roles r on r.oid = a.grantee where p.oid = o.oid and a.grantee <> o.proowner loop
      execute format('revoke all on function %s from %I', o.oid::regprocedure, g.rolname);
    end loop;
  end loop;
end
$acl$;
-- Wyłącznie sesja zalogowana; każda funkcja sama sprawdza aktualną listę operatorów (z odwołaniem).
grant execute on function public.sc021_operator_ai_costs(date, date, text), public.sc021_operator_margin(date, date, text),
  public.sc021_operator_fx_rates(), public.sc021_operator_add_fx_rate(uuid, text, bigint, timestamptz, text, boolean),
  public.sc021_operator_other_costs(date, date),
  public.sc021_operator_add_other_cost(uuid, date, uuid, text, text, bigint, text, uuid) to authenticated;

-- Kurs TESTOWY USD→PLN (placeholder). To NIE jest kurs NBP ani rynkowy. Marża policzona na nim
-- jest oznaczona jako szacunek. Prawdziwy kurs wpisuje operator jako osobny wiersz.
insert into ai_ledger.fx_rates (request_key, base_currency, rate_micros, valid_from, placeholder, source_note)
values ('5c021d00-0000-4000-8000-000000000001', 'USD', 4000000, '2026-01-01T00:00:00Z', true,
  'Kurs testowy SC-021-D, nie jest kursem NBP ani rynkowym. Do zastąpienia kursem wpisanym przez operatora.');

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc021d_inventory_changed' using errcode = '55000';
  end if;
end
$postflight$;
commit;
