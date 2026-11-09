-- SC-021-C — budżety kosztów AI: rezerwacja przed wywołaniem, ostrzeżenie 80%, blokada 100%,
-- audytowany override operatora, jednorazowe zamknięcie stawki cennika.
--
-- Model budżetu (docs/sc-021-c-ai-budgets.md):
--   * okres = miesiąc kalendarzowy Europe/Warsaw;
--   * limit firmy = ostatnia wersja ai_ledger.company_budgets tej firmy, a gdy jej nie ma (albo
--     ostatnia wersja ma limit NULL = „dziedzicz”) — ostatnia wersja ai_ledger.plan_budgets dla
--     bieżącego pakietu firmy (private.sc19_balances.plan); brak obu → `budget_unconfigured`
--     (fail closed). Żaden limit nie jest tu ustawiany: to krok operatora;
--   * aktywne overridy 'raise' podnoszą limit, aktywny 'bypass' zdejmuje blokadę 100% (nie
--     ostrzeżenie); każdy ma powód, autora i datę wygaśnięcia;
--   * zaangażowany koszt = rozliczony (settled, z ceną w walucie budżetu) + niepewny (unknown,
--     bez wyceny albo w innej walucie — liczony najgorszym szacunkiem próby) + pozostała część
--     aktywnych rezerwacji.
-- Rezerwacja: jedna na operację (screening: operation_id; generowanie zadań: firma + rekrutacja +
-- operation_id — reguła tożsamości z SC-021-B), kwota = najgorszy szacunek próby (maks. tokeny
-- wejścia i wyjścia × stawka zatwierdzona albo testowa) × liczba prób operacji. Rezerwacja
-- przestaje trzymać kwotę, gdy: zostanie zwolniona, wygaśnie (expires_at) albo operacja biznesowa
-- się zakończy (próba analizy nie jest już pending/processing; generacja nie jest już 'reserved').
-- Operacja, która ma rezerwację, nigdy nie jest odcinana (ponowienia przechodzą); blokowane są
-- tylko NOWE operacje.
--
-- Schemat ai_ledger leży poza public/private: sygnatura SC-010 (R15) bez zmian (preflight i
-- postflight). Tabele nie mają kluczy obcych do public/private i nie przechowują danych kandydata
-- (operation_id screeningu to pseudonim, jak w SC-021-B).
begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc021c_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regclass('ai_ledger.attempts') is null or to_regclass('ai_ledger.prices') is null then
    raise exception 'sc021c_requires_sc021b' using errcode = '55000';
  end if;
  if to_regclass('ai_ledger.budget_reservations') is not null then
    raise exception 'sc021c_already_installed' using errcode = '55000';
  end if;
  if to_regprocedure('private.is_platform_operator(uuid)') is null
    or to_regprocedure('private.has_company_access(uuid,boolean)') is null
    or to_regclass('private.sc19_balances') is null
    or to_regrole('ai_ledger_writer') is null or to_regrole('screening_worker') is null then
    raise exception 'sc021c_dependency_missing' using errcode = '55000';
  end if;
end
$preflight$;

-- Najgorszy szacunek próby dla zadania (wersjonowany, tylko dopisywany; obowiązuje najnowszy).
create table ai_ledger.budget_estimates (
  id uuid primary key default gen_random_uuid(),
  task text not null check (task in ('cv_screening', 'exercise_generation')),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null check (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  model_revision text check (model_revision is null or model_revision ~ '^[A-Za-z0-9._:-]{1,100}$'),
  max_input_tokens integer not null check (max_input_tokens between 1 and 2000000),
  max_output_tokens integer not null check (max_output_tokens between 1 and 200000),
  attempts_per_operation integer not null check (attempts_per_operation between 1 and 16),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default clock_timestamp()
);
create index budget_estimates_task on ai_ledger.budget_estimates (task, created_at desc);

-- Domyślny limit pakietu (wersje; obowiązuje najnowsza dla planu).
create table ai_ledger.plan_budgets (
  id uuid primary key default gen_random_uuid(),
  plan text not null check (plan ~ '^[A-Z][A-Z_]{1,39}$'),
  limit_micros bigint not null check (limit_micros between 0 and 10000000000000),
  currency text not null check (currency in ('USD', 'EUR', 'PLN')),
  created_by uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create index plan_budgets_plan on ai_ledger.plan_budgets (plan, created_at desc);

-- Limit konkretnej firmy (wersje; limit NULL = dziedzicz limit pakietu).
create table ai_ledger.company_budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  limit_micros bigint check (limit_micros is null or limit_micros between 0 and 10000000000000),
  currency text check (currency is null or currency in ('USD', 'EUR', 'PLN')),
  created_by uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  check ((limit_micros is null) = (currency is null))
);
create index company_budgets_company on ai_ledger.company_budgets (company_id, created_at desc);

-- Override operatora: czasowe podniesienie limitu albo zdjęcie blokady 100%.
create table ai_ledger.budget_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  kind text not null check (kind in ('raise', 'bypass')),
  extra_micros bigint check (extra_micros is null or extra_micros between 1 and 10000000000000),
  currency text check (currency is null or currency in ('USD', 'EUR', 'PLN')),
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  created_by uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (revoke_reason is null or length(btrim(revoke_reason)) between 8 and 500),
  check ((kind = 'raise') = (extra_micros is not null) and (extra_micros is null) = (currency is null)),
  check (expires_at > valid_from and expires_at <= valid_from + interval '31 days'),
  check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null))
);
create index budget_overrides_company on ai_ledger.budget_overrides (company_id, expires_at desc);

-- Rezerwacja budżetu: jedna na operację biznesową, przed pierwszą próbą.
create table ai_ledger.budget_reservations (
  id bigint generated always as identity primary key,
  task text not null check (task in ('cv_screening', 'exercise_generation')),
  company_id uuid not null,
  process_id uuid not null,
  operation_id uuid not null,
  period_start timestamptz not null,
  currency text not null check (currency in ('USD', 'EUR', 'PLN')),
  per_attempt_micros bigint not null check (per_attempt_micros >= 0),
  attempts integer not null check (attempts between 1 and 16),
  reserved_micros bigint not null check (reserved_micros >= 0),
  estimate_id uuid not null references ai_ledger.budget_estimates (id),
  price_id uuid not null references ai_ledger.prices (id),
  bypass_override_id uuid references ai_ledger.budget_overrides (id),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  released_at timestamptz,
  check (reserved_micros = per_attempt_micros * attempts),
  check (expires_at > created_at),
  unique (task, company_id, process_id, operation_id)
);
create index budget_reservations_company on ai_ledger.budget_reservations (company_id, period_start);
create index budget_reservations_operation on ai_ledger.budget_reservations (operation_id, task);

-- Zdarzenia budżetu: jedno ostrzeżenie 80% i jedna blokada 100% na firmę i okres. Bez wysyłek.
create table ai_ledger.budget_events (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  period_start timestamptz not null,
  kind text not null check (kind in ('warning_80', 'blocked_100')),
  limit_micros bigint not null,
  committed_micros bigint not null,
  currency text not null check (currency in ('USD', 'EUR', 'PLN')),
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, period_start, kind)
);

-- Audyt każdej zmiany konfiguracji budżetu, overridu i zamknięcia stawki (tylko dopisywany).
create table ai_ledger.budget_audit (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null check (action in ('set_plan_budget', 'set_company_budget', 'grant_override', 'revoke_override', 'close_price')),
  company_id uuid,
  target_id text not null check (length(target_id) between 1 and 100),
  details jsonb not null check (jsonb_typeof(details) = 'object'),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create index budget_audit_company on ai_ledger.budget_audit (company_id, created_at desc);

-- Tylko dopisywanie (funkcja z SC-021-B).
create trigger budget_estimates_append_only before update or delete on ai_ledger.budget_estimates
  for each row execute function ai_ledger.append_only();
create trigger plan_budgets_append_only before update or delete on ai_ledger.plan_budgets
  for each row execute function ai_ledger.append_only();
create trigger company_budgets_append_only before update or delete on ai_ledger.company_budgets
  for each row execute function ai_ledger.append_only();
create trigger budget_events_append_only before update or delete on ai_ledger.budget_events
  for each row execute function ai_ledger.append_only();
create trigger budget_audit_append_only before update or delete on ai_ledger.budget_audit
  for each row execute function ai_ledger.append_only();

-- Jedyne dozwolone zmiany: jednorazowe ustawienie pola z pustego na wartość, reszta bez zmian.
create function ai_ledger.guard_one_time_update() returns trigger
language plpgsql set search_path = '' as $$
declare cols text[] := array(select unnest(tg_argv)); c text; before jsonb := to_jsonb(old); after jsonb := to_jsonb(new);
begin
  if tg_op <> 'UPDATE' then
    raise exception 'AI ledger is append-only' using errcode = '42501';
  end if;
  foreach c in array cols loop
    if before->>c is not null then
      raise exception 'AI ledger is append-only' using errcode = '42501';
    end if;
    before := before - c; after := after - c;
  end loop;
  if before is distinct from after or (to_jsonb(new)->>cols[1]) is null then
    raise exception 'AI ledger is append-only' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger budget_overrides_revoke_once before update or delete on ai_ledger.budget_overrides
  for each row execute function ai_ledger.guard_one_time_update('revoked_at', 'revoked_by', 'revoke_reason');
create trigger budget_reservations_release_once before update or delete on ai_ledger.budget_reservations
  for each row execute function ai_ledger.guard_one_time_update('released_at');
-- Cennik: zamiast pełnego zakazu zmian (SC-021-B) — wyłącznie jednorazowe ustawienie valid_to.
drop trigger prices_append_only on ai_ledger.prices;
create trigger prices_close_once before update or delete on ai_ledger.prices
  for each row execute function ai_ledger.guard_one_time_update('valid_to');

alter table ai_ledger.budget_estimates enable row level security;
alter table ai_ledger.plan_budgets enable row level security;
alter table ai_ledger.company_budgets enable row level security;
alter table ai_ledger.budget_overrides enable row level security;
alter table ai_ledger.budget_reservations enable row level security;
alter table ai_ledger.budget_events enable row level security;
alter table ai_ledger.budget_audit enable row level security;
do $revoke$
declare r text; t text;
begin
  foreach t in array array['ai_ledger.budget_estimates', 'ai_ledger.plan_budgets', 'ai_ledger.company_budgets',
    'ai_ledger.budget_overrides', 'ai_ledger.budget_reservations', 'ai_ledger.budget_events', 'ai_ledger.budget_audit'] loop
    execute format('revoke all on %s from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role', 'screening_worker', 'ai_ledger_writer'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %s from %I', t, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role', 'screening_worker', 'ai_ledger_writer'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on sequence ai_ledger.budget_reservations_id_seq, ai_ledger.budget_events_id_seq, ai_ledger.budget_audit_id_seq from %I', r);
    end if;
  end loop;
end
$revoke$;

-- Członek firmy widzi zdarzenia budżetu swojej firmy (stan — przez company_budget_status).
grant select on ai_ledger.budget_events to authenticated;
create policy budget_events_member_read on ai_ledger.budget_events for select to authenticated
  using (private.has_company_access(company_id));

-- Okres rozliczeniowy: miesiąc kalendarzowy w strefie Europe/Warsaw.
create function ai_ledger.period_bounds(ts timestamptz, out period_start timestamptz, out period_end timestamptz)
language sql stable set search_path = '' as $$
  select (date_trunc('month', ts at time zone 'Europe/Warsaw')) at time zone 'Europe/Warsaw',
    (date_trunc('month', ts at time zone 'Europe/Warsaw') + interval '1 month') at time zone 'Europe/Warsaw'
$$;

-- Najgorszy koszt jednej próby: maks. tokeny wejścia (bez rabatu za cache) i wyjścia × stawka.
create function ai_ledger.attempt_estimate(target_task text, at timestamptz,
  out estimate_id uuid, out price_id uuid, out currency text, out per_attempt_micros bigint, out attempts integer)
language plpgsql stable security definer set search_path = '' as $$
declare e ai_ledger.budget_estimates; p ai_ledger.prices;
begin
  select * into e from ai_ledger.budget_estimates b where b.task = target_task and b.created_at <= at
  order by b.created_at desc, b.id limit 1;
  if not found then return; end if;
  estimate_id := e.id; attempts := e.attempts_per_operation;
  p := ai_ledger.price_for(e.provider, e.model, e.model_revision, at);
  if p.id is null then return; end if;
  price_id := p.id; currency := p.currency;
  per_attempt_micros := ai_ledger.cost_micros(p, e.max_input_tokens, 0, e.max_output_tokens);
end;
$$;

-- Obowiązujący budżet firmy w chwili `at`.
create function ai_ledger.effective_budget(target_company uuid, at timestamptz,
  out source text, out version_id uuid, out plan text, out base_limit_micros bigint, out currency text,
  out raise_micros bigint, out bypass_override_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare cb ai_ledger.company_budgets; pb ai_ledger.plan_budgets;
begin
  select b.plan into plan from private.sc19_balances b where b.company_id = target_company;
  select * into cb from ai_ledger.company_budgets c where c.company_id = target_company and c.created_at <= at
  order by c.created_at desc, c.id limit 1;
  if found and cb.limit_micros is not null then
    source := 'company'; version_id := cb.id; base_limit_micros := cb.limit_micros; currency := cb.currency;
  elsif plan is not null then
    select * into pb from ai_ledger.plan_budgets p where p.plan = effective_budget.plan and p.created_at <= at
    order by p.created_at desc, p.id limit 1;
    if found then
      source := 'plan'; version_id := pb.id; base_limit_micros := pb.limit_micros; currency := pb.currency;
    end if;
  end if;
  if source is null then return; end if;
  select coalesce(sum(o.extra_micros), 0) into raise_micros from ai_ledger.budget_overrides o
  where o.company_id = target_company and o.kind = 'raise' and o.currency = effective_budget.currency
    and o.revoked_at is null and o.valid_from <= at and at < o.expires_at;
  select o.id into bypass_override_id from ai_ledger.budget_overrides o
  where o.company_id = target_company and o.kind = 'bypass'
    and o.revoked_at is null and o.valid_from <= at and at < o.expires_at
  order by o.expires_at desc, o.id limit 1;
end;
$$;

-- Zaangażowany koszt firmy w okresie (w walucie budżetu).
create function ai_ledger.budget_usage(target_company uuid, p_start timestamptz, p_end timestamptz, cur text, at timestamptz,
  out settled_micros bigint, out unknown_micros bigint, out reserved_micros bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Próby w okresie: koszt znany w walucie budżetu albo najgorszy szacunek (z rezerwacji operacji,
  -- a bez niej — bieżący szacunek zadania). 'released' (nie naliczone) = 0.
  select
    coalesce(sum(x.known) filter (where x.known is not null), 0),
    coalesce(sum(coalesce(x.r_per, x.live_per, 0)) filter (where x.known is null), 0)
  into settled_micros, unknown_micros
  from (
    select case when a.status = 'released' then 0
        when a.status = 'settled' and a.cost_micros is not null and a.currency = cur then a.cost_micros end known,
      r.per_attempt_micros r_per,
      (select case when e.currency = cur then e.per_attempt_micros end from ai_ledger.attempt_estimate(a.task, at) e) live_per
    from ai_ledger.attempts a
    left join ai_ledger.budget_reservations r on r.task = a.task and r.company_id = a.company_id
      and r.process_id = a.process_id and r.operation_id = a.operation_id and r.currency = cur
    where a.company_id = target_company and a.created_at >= p_start and a.created_at < p_end
  ) x;
  -- Aktywne rezerwacje trzymają tylko to, czego ich próby jeszcze nie zużyły.
  select coalesce(sum(greatest(0, r.reserved_micros - coalesce(u.used, 0))), 0) into reserved_micros
  from ai_ledger.budget_reservations r
  left join lateral (
    select sum(case when a.status = 'released' then 0
        when a.status = 'settled' and a.cost_micros is not null and a.currency = cur then a.cost_micros
        else r.per_attempt_micros end) used
    from ai_ledger.attempts a
    where a.task = r.task and a.company_id = r.company_id and a.process_id = r.process_id and a.operation_id = r.operation_id
  ) u on true
  where r.company_id = target_company and r.period_start = p_start and r.currency = cur
    and r.released_at is null and r.expires_at > at
    and case r.task
      when 'cv_screening' then exists (select 1 from public.screening_analysis_attempts t
        where t.id = r.operation_id and t.company_id = r.company_id and t.status in ('pending', 'processing'))
      when 'exercise_generation' then coalesce((select s.generation_requests->r.operation_id::text->>'status' = 'reserved'
          and ((s.generation_requests->r.operation_id::text->>'expires_at')::timestamptz > at)
          or not (s.generation_requests ? r.operation_id::text)
        from exercise_ai.recruitment_settings s where s.company_id = r.company_id and s.recruitment_id = r.process_id), true)
      else false end;
end;
$$;

-- Stan budżetu: ok / warning (≥ 80%) / exceeded (≥ 100%) / unconfigured.
create function ai_ledger.budget_state(target_company uuid, at timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b record; u record; pb record; lim bigint; committed bigint; st text;
begin
  select * into pb from ai_ledger.period_bounds(at);
  select * into b from ai_ledger.effective_budget(target_company, at);
  if b.source is null then
    return jsonb_build_object('state', 'unconfigured', 'period_start', pb.period_start, 'period_end', pb.period_end,
      'plan', b.plan, 'bypass_active', false);
  end if;
  select * into u from ai_ledger.budget_usage(target_company, pb.period_start, pb.period_end, b.currency, at);
  lim := b.base_limit_micros + b.raise_micros;
  committed := u.settled_micros + u.unknown_micros + u.reserved_micros;
  st := case when committed >= lim then 'exceeded' when committed * 100 >= lim * 80 then 'warning' else 'ok' end;
  return jsonb_build_object('state', st, 'period_start', pb.period_start, 'period_end', pb.period_end,
    'source', b.source, 'plan', b.plan, 'version_id', b.version_id, 'currency', b.currency,
    'base_limit_micros', b.base_limit_micros, 'raise_micros', b.raise_micros, 'limit_micros', lim,
    'settled_micros', u.settled_micros, 'unknown_micros', u.unknown_micros, 'reserved_micros', u.reserved_micros,
    'committed_micros', committed, 'bypass_active', b.bypass_override_id is not null);
end;
$$;

-- Rdzeń rezerwacji (tylko właściciel; wołają go funkcje screeningu i generowania zadań).
-- Blokada doradcza na firmę serializuje sprawdzenie sumy i wstawienie rezerwacji.
create function ai_ledger.reserve_budget(target_task text, target_company uuid, target_process uuid, op uuid, ttl interval)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing ai_ledger.budget_reservations; at timestamptz := clock_timestamp(); pb record; b record; e record;
  u record; lim bigint; committed bigint; amount bigint; rid bigint; st jsonb;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Read committed required' using errcode = 'PT409';
  end if;
  if target_task not in ('cv_screening', 'exercise_generation') or target_company is null or target_process is null or op is null then
    raise exception 'Invalid AI budget request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_budget:' || target_company::text, 0));
  select * into existing from ai_ledger.budget_reservations r
  where r.task = target_task and r.company_id = target_company and r.process_id = target_process and r.operation_id = op;
  if found then
    -- Operacja już rozpoczęta: nigdy nie jest odcinana (ponowienia przechodzą).
    return jsonb_build_object('allowed', true, 'created', false, 'reservation_id', existing.id);
  end if;
  if target_task = 'cv_screening' and exists (select 1 from ai_ledger.budget_reservations r
      where r.task = 'cv_screening' and r.operation_id = op) then
    raise exception 'AI budget conflict' using errcode = 'PT409';
  end if;
  select * into pb from ai_ledger.period_bounds(at);
  select * into b from ai_ledger.effective_budget(target_company, at);
  if b.source is null then
    return jsonb_build_object('allowed', false, 'code', 'budget_unconfigured', 'reason', 'no_budget');
  end if;
  select * into e from ai_ledger.attempt_estimate(target_task, at);
  if e.price_id is null or e.currency is distinct from b.currency then
    return jsonb_build_object('allowed', false, 'code', 'budget_unconfigured', 'reason', 'no_price_in_budget_currency');
  end if;
  select * into u from ai_ledger.budget_usage(target_company, pb.period_start, pb.period_end, b.currency, at);
  lim := b.base_limit_micros + b.raise_micros;
  committed := u.settled_micros + u.unknown_micros + u.reserved_micros;
  amount := e.per_attempt_micros * e.attempts;
  if committed + amount > lim and b.bypass_override_id is null then
    insert into ai_ledger.budget_events (company_id, period_start, kind, limit_micros, committed_micros, currency)
    values (target_company, pb.period_start, 'blocked_100', lim, committed, b.currency)
    on conflict (company_id, period_start, kind) do nothing;
    return jsonb_build_object('allowed', false, 'code', 'budget_exceeded');
  end if;
  insert into ai_ledger.budget_reservations (task, company_id, process_id, operation_id, period_start, currency,
    per_attempt_micros, attempts, reserved_micros, estimate_id, price_id, bypass_override_id, created_at, expires_at)
  values (target_task, target_company, target_process, op, pb.period_start, b.currency,
    e.per_attempt_micros, e.attempts, amount, e.estimate_id, e.price_id,
    case when committed + amount > lim then b.bypass_override_id end, at, at + ttl)
  returning id into rid;
  if (committed + amount) * 100 >= lim * 80 then
    insert into ai_ledger.budget_events (company_id, period_start, kind, limit_micros, committed_micros, currency)
    values (target_company, pb.period_start, 'warning_80', lim, committed + amount, b.currency)
    on conflict (company_id, period_start, kind) do nothing;
  end if;
  return jsonb_build_object('allowed', true, 'created', true, 'reservation_id', rid,
    'bypass', committed + amount > lim);
end;
$$;

-- Screening worker: firma i rekrutacja z próby analizy, którą worker trzyma (status 'processing').
create function public.reserve_screening_ai_budget(operation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare tenant uuid; process uuid;
begin
  select t.company_id, v.recruitment_id into tenant, process
  from public.screening_analysis_attempts t
  join public.screening_analysis_versions v on v.id = t.analysis_id and v.company_id = t.company_id
  where t.id = operation and t.status = 'processing';
  if tenant is null then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  return ai_ledger.reserve_budget('cv_screening', tenant, process, operation, interval '15 minutes');
end;
$$;

-- Generowanie zadań: wyłącznie rola ai_ledger_writer (połączenie serwerowe), przed rezerwacją
-- generacji — odmowa budżetu nie zużywa limitu propozycji rekrutacji.
create function ai_ledger.reserve_exercise_budget(target_company uuid, target_recruitment uuid, op uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  if target_company is null or target_recruitment is null or op is null then
    raise exception 'Invalid AI budget request' using errcode = '22023';
  end if;
  perform 1 from public.recruitments r where r.id = target_recruitment and r.company_id = target_company;
  if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  if exists (select 1 from public.screening_analysis_attempts where id = op)
    or exists (select 1 from ai_ledger.attempts where operation_id = op and task <> 'exercise_generation') then
    raise exception 'AI budget conflict' using errcode = 'PT409';
  end if;
  select s.generation_requests->op::text into item from exercise_ai.recruitment_settings s
  where s.company_id = target_company and s.recruitment_id = target_recruitment;
  -- Generacja już zakończona: nie będzie wywołania dostawcy, rezerwacja zbędna.
  if item is not null and item->>'status' <> 'reserved' then
    return jsonb_build_object('allowed', true, 'created', false, 'skipped', true);
  end if;
  return ai_ledger.reserve_budget('exercise_generation', target_company, target_recruitment, op, interval '5 minutes');
end;
$$;

create function ai_ledger.release_exercise_budget(target_company uuid, target_recruitment uuid, op uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update ai_ledger.budget_reservations set released_at = clock_timestamp()
  where task = 'exercise_generation' and company_id = target_company and process_id = target_recruitment
    and operation_id = op and released_at is null;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Odczyt stanu: członek firmy (każda rola) albo operator platformy.
create function ai_ledger.company_budget_status(target_company uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); pb record;
begin
  if actor is null or target_company is null
    or not (private.has_company_access(target_company) or private.is_platform_operator(actor)) then
    raise exception 'AI budget unavailable' using errcode = '42501';
  end if;
  select * into pb from ai_ledger.period_bounds(clock_timestamp());
  return ai_ledger.budget_state(target_company, clock_timestamp()) || jsonb_build_object('events',
    coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'created_at', e.created_at,
      'limit_micros', e.limit_micros, 'committed_micros', e.committed_micros, 'currency', e.currency) order by e.created_at)
      from ai_ledger.budget_events e where e.company_id = target_company and e.period_start = pb.period_start), '[]'::jsonb));
end;
$$;

-- Ścieżka operatora (private.is_platform_operator). Każda zmiana = wiersz audytu.
create function ai_ledger.require_operator() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null or not private.is_platform_operator(actor) then
    raise exception 'ai_budget_operator_forbidden' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create function ai_ledger.operator_set_plan_budget(target_plan text, new_limit_micros bigint, new_currency text, change_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := ai_ledger.require_operator(); rid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_budget_plan:' || coalesce(target_plan, ''), 0));
  insert into ai_ledger.plan_budgets (plan, limit_micros, currency, created_by, reason)
  values (target_plan, new_limit_micros, new_currency, actor, btrim(change_reason)) returning id into rid;
  insert into ai_ledger.budget_audit (actor, action, company_id, target_id, details, reason)
  values (actor, 'set_plan_budget', null, rid::text, jsonb_build_object('plan', target_plan,
    'limit_micros', new_limit_micros, 'currency', new_currency), btrim(change_reason));
  return rid;
end;
$$;

create function ai_ledger.operator_set_company_budget(target_company uuid, new_limit_micros bigint, new_currency text, change_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := ai_ledger.require_operator(); rid uuid;
begin
  perform 1 from public.companies where id = target_company;
  if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_budget:' || target_company::text, 0));
  insert into ai_ledger.company_budgets (company_id, limit_micros, currency, created_by, reason)
  values (target_company, new_limit_micros, new_currency, actor, btrim(change_reason)) returning id into rid;
  insert into ai_ledger.budget_audit (actor, action, company_id, target_id, details, reason)
  values (actor, 'set_company_budget', target_company, rid::text, jsonb_build_object(
    'limit_micros', new_limit_micros, 'currency', new_currency), btrim(change_reason));
  return rid;
end;
$$;

create function ai_ledger.operator_grant_override(target_company uuid, override_kind text, new_extra_micros bigint,
  new_currency text, new_expires_at timestamptz, change_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := ai_ledger.require_operator(); rid uuid;
begin
  perform 1 from public.companies where id = target_company;
  if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_budget:' || target_company::text, 0));
  insert into ai_ledger.budget_overrides (company_id, kind, extra_micros, currency, expires_at, created_by, reason)
  values (target_company, override_kind, new_extra_micros, new_currency, new_expires_at, actor, btrim(change_reason))
  returning id into rid;
  insert into ai_ledger.budget_audit (actor, action, company_id, target_id, details, reason)
  values (actor, 'grant_override', target_company, rid::text, jsonb_build_object('kind', override_kind,
    'extra_micros', new_extra_micros, 'currency', new_currency, 'expires_at', new_expires_at), btrim(change_reason));
  return rid;
end;
$$;

create function ai_ledger.operator_revoke_override(target_override uuid, change_reason text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare actor uuid := ai_ledger.require_operator(); o ai_ledger.budget_overrides; at timestamptz := clock_timestamp();
begin
  select * into o from ai_ledger.budget_overrides where id = target_override;
  if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_budget:' || o.company_id::text, 0));
  update ai_ledger.budget_overrides set revoked_at = at, revoked_by = actor, revoke_reason = btrim(change_reason)
  where id = target_override and revoked_at is null;
  if not found then raise exception 'Override already revoked' using errcode = 'PT409'; end if;
  insert into ai_ledger.budget_audit (actor, action, company_id, target_id, details, reason)
  values (actor, 'revoke_override', o.company_id, o.id::text, jsonb_build_object('kind', o.kind), btrim(change_reason));
  return at;
end;
$$;

-- Jednorazowe zamknięcie stawki: valid_to z pustego na datę nie wcześniejszą niż teraz
-- (bez zmiany przeszłych wycen); stawki bez zmian.
create function ai_ledger.operator_close_price(target_price uuid, new_valid_to timestamptz, change_reason text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare actor uuid := ai_ledger.require_operator(); p ai_ledger.prices;
begin
  if length(btrim(coalesce(change_reason, ''))) not between 8 and 500 then
    raise exception 'Invalid reason' using errcode = '22023';
  end if;
  select * into p from ai_ledger.prices where id = target_price for update;
  if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  if p.valid_to is not null then raise exception 'Price already closed' using errcode = 'PT409'; end if;
  if new_valid_to is null or new_valid_to < clock_timestamp() or new_valid_to <= p.valid_from then
    raise exception 'Invalid valid_to' using errcode = '22023';
  end if;
  update ai_ledger.prices set valid_to = new_valid_to where id = target_price;
  insert into ai_ledger.budget_audit (actor, action, company_id, target_id, details, reason)
  values (actor, 'close_price', null, p.id::text, jsonb_build_object('price_version', p.price_version,
    'provider', p.provider, 'model', p.model, 'valid_to', new_valid_to), btrim(change_reason));
  return new_valid_to;
end;
$$;

create function ai_ledger.operator_budget_audit(target_company uuid, result_limit integer default 100)
returns setof ai_ledger.budget_audit language plpgsql stable security definer set search_path = '' as $$
begin
  perform ai_ledger.require_operator();
  return query select * from ai_ledger.budget_audit a
  where target_company is null or a.company_id = target_company
  order by a.created_at desc, a.id desc limit greatest(1, least(500, coalesce(result_limit, 100)));
end;
$$;

do $acl$
declare o record; g record;
begin
  for o in select p.oid, p.proowner from pg_proc p where p.oid = any(array[
    'ai_ledger.guard_one_time_update()'::regprocedure,
    'ai_ledger.period_bounds(timestamptz)'::regprocedure,
    'ai_ledger.attempt_estimate(text,timestamptz)'::regprocedure,
    'ai_ledger.effective_budget(uuid,timestamptz)'::regprocedure,
    'ai_ledger.budget_usage(uuid,timestamptz,timestamptz,text,timestamptz)'::regprocedure,
    'ai_ledger.budget_state(uuid,timestamptz)'::regprocedure,
    'ai_ledger.reserve_budget(text,uuid,uuid,uuid,interval)'::regprocedure,
    'public.reserve_screening_ai_budget(uuid)'::regprocedure,
    'ai_ledger.reserve_exercise_budget(uuid,uuid,uuid)'::regprocedure,
    'ai_ledger.release_exercise_budget(uuid,uuid,uuid)'::regprocedure,
    'ai_ledger.company_budget_status(uuid)'::regprocedure,
    'ai_ledger.require_operator()'::regprocedure,
    'ai_ledger.operator_set_plan_budget(text,bigint,text,text)'::regprocedure,
    'ai_ledger.operator_set_company_budget(uuid,bigint,text,text)'::regprocedure,
    'ai_ledger.operator_grant_override(uuid,text,bigint,text,timestamptz,text)'::regprocedure,
    'ai_ledger.operator_revoke_override(uuid,text)'::regprocedure,
    'ai_ledger.operator_close_price(uuid,timestamptz,text)'::regprocedure,
    'ai_ledger.operator_budget_audit(uuid,integer)'::regprocedure]) loop
    execute format('revoke all on function %s from public', o.oid::regprocedure);
    for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
      join pg_roles r on r.oid = a.grantee where p.oid = o.oid and a.grantee <> o.proowner loop
      execute format('revoke all on function %s from %I', o.oid::regprocedure, g.rolname);
    end loop;
  end loop;
end
$acl$;
grant execute on function public.reserve_screening_ai_budget(uuid) to screening_worker;
grant execute on function ai_ledger.reserve_exercise_budget(uuid, uuid, uuid), ai_ledger.release_exercise_budget(uuid, uuid, uuid)
  to ai_ledger_writer;
grant execute on function ai_ledger.company_budget_status(uuid),
  ai_ledger.operator_set_plan_budget(text, bigint, text, text),
  ai_ledger.operator_set_company_budget(uuid, bigint, text, text),
  ai_ledger.operator_grant_override(uuid, text, bigint, text, timestamptz, text),
  ai_ledger.operator_revoke_override(uuid, text),
  ai_ledger.operator_close_price(uuid, timestamptz, text),
  ai_ledger.operator_budget_audit(uuid, integer) to authenticated;

-- Szacunki tras z kodu (lib/ai-gateway/budget.ts BUDGET_ESTIMATES; test przypina je do stałych):
--   screening: wejście ≤ 120 000 tokenów (CV ≤ 100 000 znaków + kryteria + instrukcje + schemat),
--     wyjście ≤ 4 000 (SCREENING_OPENAI_MAX_OUTPUT_TOKENS), 3 próby (1 + SCREENING_OPENAI_MAX_RETRIES);
--   generowanie zadań: wejście ≤ 48 000 (limit bajtów żądania), wyjście ≤ 4 000, 1 próba.
insert into ai_ledger.budget_estimates (task, provider, model, model_revision, max_input_tokens, max_output_tokens,
  attempts_per_operation, note)
values
  ('cv_screening', 'openai', 'gpt-5.4-mini-2026-03-17', null, 120000, 4000, 3, 'SC-021-C: najgorszy przypadek próby screeningu'),
  ('exercise_generation', 'openai', 'gpt-5.4-mini-2026-03-17', null, 48000, 4000, 1, 'SC-021-C: najgorszy przypadek generowania zadania');

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc021c_inventory_changed' using errcode = '55000';
  end if;
end
$postflight$;
commit;
