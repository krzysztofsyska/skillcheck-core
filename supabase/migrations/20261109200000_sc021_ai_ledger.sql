-- SC-021-B — rejestr fizycznych prób AI i ich kosztu (ledger) + wersjonowany cennik modeli.
--
-- Każda fizyczna próba wywołania modelu przez AI gateway (lib/ai-gateway) zapisuje dokładnie
-- jeden wiersz: kto (firma, proces), co (zadanie, dostawca, model, wersja polityki), ile
-- (tokeny, koszt w mikro-jednostkach waluty), z jakim skutkiem (status, pewność naliczenia,
-- kod wyniku, czas). Bez promptu, bez tekstu CV, bez treści odpowiedzi dostawcy.
--
-- Dlaczego osobny schemat `ai_ledger`, a nie `public`/`private` (wzorzec z
-- 20261104080000_pricing_catalog.sql): private.erasure_schema_signature() obejmuje relacje
-- w 'public' i 'private' oraz więzy, które się do nich odwołują, i jest przypięta do
-- baseline'u inwentarza usuwania danych kandydatów (SC-010, R15). Rejestr kosztów to
-- dokument finansowy firmy, który ma przetrwać usunięcie danych kandydata. Dlatego:
--   * tabele `ai_ledger.*` NIE mają kluczy obcych do public/private (taki więz zmieniłby
--     sygnaturę); firmę ustala wyłącznie funkcja zapisu z zaufanego stanu bazy;
--   * rejestr nie przechowuje żadnej wartości, która po usunięciu danych kandydata
--     pozwalałaby go zidentyfikować (wariant (b) z kontraktu zadania):
--       - `operation_id` screeningu = id próby public.screening_analysis_attempts,
--       - `candidate_ref` = id zgłoszenia public.applications,
--     a jedyne mapowanie tych identyfikatorów na osobę żyje w tabelach objętych
--     inwentarzem R15 i jest usuwane przez private.erasure_purge_engine (test
--     tests/ai-ledger-database.test.mjs przeszukuje po purge wszystkie schematy);
--       - `provider_request_id` NIE jest zapisywany dla screeningu (wskazywałby rekord
--         u dostawcy z treścią CV; dla screeningu ten identyfikator żyje wyłącznie w
--         public.screening_analysis_attempts, które inwentarz zna i obsługuje);
--       - generowanie zadań nie dotyczy kandydatów (`candidate_ref` zawsze NULL).
-- Ta migracja nie tworzy, nie zmienia ani nie usuwa żadnej relacji, kolumny, więzu ani
-- wyzwalacza w 'public' lub 'private'; dodaje jedynie funkcje. Sygnatura SC-010 pozostaje
-- niezmieniona (preflight i postflight).
--
-- Kto zapisuje (wyłącznie role serwerowe; żadnych danych firmy z wejścia przeglądarki):
--   * screening — rola screening_worker (worker Edge, ten sam, który trzyma claim),
--     public.record_screening_ai_attempt: firma, rekrutacja i zgłoszenie wyprowadzone z
--     public.screening_analysis_attempts po `operation_id` (= attempt_id claimu);
--   * generowanie zadań — nowa rola NOLOGIN `ai_ledger_writer`, osiągana wyłącznie przez
--     serwerowe połączenie AI_LEDGER_DATABASE_URL (login z członkostwem w tej roli i hasło
--     tworzy operator/właściciel osobno; ta migracja NIE tworzy loginu ani hasła).
--     ai_ledger.record_exercise_attempt nie korzysta z auth.uid(): firma i rekrutacja muszą
--     zgadzać się z rezerwacją generacji (exercise_ai.recruitment_settings.generation_requests
--     [operation_id]), która musi mieć status 'reserved' i niewygasłe expires_at; ta sama blokada
--     `exercise_ai:` co reserve/finish; dostawca, model, klucz modelu i wersja polityki z listy
--     dozwolonych (ai_ledger.route_allowlist); tokeny ograniczone limitami trasy; maks. tyle
--     wierszy na operację, ile prób ma trasa (1).
-- Identyfikator próby (`attempt_id`) NIE jest wysyłany do dostawcy: nagłówek
-- x-client-request-id niesie osobny, losowy identyfikator, którego nigdzie nie zapisujemy.
-- Kto czyta: członek firmy, wyłącznie wiersze swojej firmy (RLS, private.has_company_access).
-- Cennik (`ai_ledger.prices`): brak dostępu dla anon/authenticated.
--
-- Koszt: liczby całkowite. Stawki w mikro-jednostkach waluty za 1 000 000 tokenów,
-- koszt w mikro-jednostkach: ceil(((wejście − cache)·s_we + cache·s_cache + wyjście·s_wy) / 1 000 000)
-- liczony na typie numeric (dokładnie, bez float), zaokrąglany W GÓRĘ.
-- Ceny: w tej migracji WYŁĄCZNIE stawki testowe (placeholder = true,
-- price_version 'placeholder-test-2026-11-09'). To NIE są ceny dostawcy. Koszt policzony na
-- nich ma price_placeholder = true. Brak stawki → koszt NULL (wiersz „bez wyceny”), nigdy zgadywanie.
begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc021b_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if not exists (select 1 from private.erasure_inventory_baseline_r15 where singleton
      and schema_signature = '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44') then
    raise exception 'sc021b_requires_reviewed_r15' using errcode = '55000';
  end if;
  if to_regnamespace('ai_ledger') is not null then
    raise exception 'sc021b_already_installed' using errcode = '55000';
  end if;
  if to_regclass('exercise_ai.recruitment_settings') is null
    or to_regprocedure('private.competency_authority(uuid,boolean)') is null
    or to_regrole('screening_worker') is null then
    raise exception 'sc021b_dependency_missing' using errcode = '55000';
  end if;
end
$preflight$;

-- Rola serwerowa zapisu prób generowania zadań. NOLOGIN: login (członkostwo + hasło) to osobny
-- krok operatora, warunek włączenia AI_GATEWAY_ENABLED. Rola nie dziedziczy niczego.
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_ledger_writer') then
    create role ai_ledger_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'ai_ledger_writer'
      and (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolinherit or rolcanlogin or rolreplication))
    or exists (select 1 from pg_auth_members where member = 'ai_ledger_writer'::regrole) then
    raise exception 'sc021b_unsafe_writer_role' using errcode = '55000';
  end if;
end
$role$;

create schema ai_ledger;
revoke all on schema ai_ledger from public;

-- Wersjonowany cennik. Stawka jest używana do wyceny, gdy jest zatwierdzona (approved) albo
-- jest jawną stawką testową (placeholder). Szkic (ani jedno, ani drugie) nie wycenia niczego.
create table ai_ledger.prices (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null check (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  -- NULL = stawka dla każdej rewizji modelu; stawka z dokładną rewizją ma pierwszeństwo.
  model_revision text check (model_revision is null or model_revision ~ '^[A-Za-z0-9._:-]{1,100}$'),
  price_version text not null check (price_version ~ '^[a-z0-9._-]{1,64}$'),
  currency text not null check (currency in ('USD', 'EUR', 'PLN')),
  input_per_mtok_micros bigint not null check (input_per_mtok_micros between 0 and 1000000000000),
  cached_input_per_mtok_micros bigint not null check (cached_input_per_mtok_micros between 0 and 1000000000000),
  output_per_mtok_micros bigint not null check (output_per_mtok_micros between 0 and 1000000000000),
  placeholder boolean not null,
  approved boolean not null default false,
  valid_from timestamptz not null,
  valid_to timestamptz,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  check (not (placeholder and approved)),
  check (valid_to is null or valid_to > valid_from)
);
create unique index prices_version_key on ai_ledger.prices (provider, model, coalesce(model_revision, ''), price_version);

-- Dozwolone wpisy polityki dla zapisów z roli ai_ledger_writer (generowanie zadań). Zmiana polityki
-- (model, wersja) wymaga nowego wiersza tutaj — zapis z nieznanym wpisem jest odrzucany.
create table ai_ledger.route_allowlist (
  task text not null check (task in ('exercise_generation')),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null check (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  model_revision text check (model_revision is null or model_revision ~ '^[A-Za-z0-9._:-]{1,100}$'),
  model_key text not null check (model_key ~ '^[A-Za-z0-9._:-]{1,64}$'),
  policy_version text not null check (policy_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  max_attempts integer not null check (max_attempts between 1 and 16),
  max_input_tokens integer not null check (max_input_tokens between 1 and 2000000),
  max_output_tokens integer not null check (max_output_tokens between 1 and 200000),
  created_at timestamptz not null default clock_timestamp(),
  primary key (task, provider, model, model_key, policy_version)
);

-- Jedna fizyczna próba = jeden wiersz. `attempt_id` (UNIQUE) jest kluczem idempotencji.
create table ai_ledger.attempts (
  id bigint generated always as identity primary key,
  attempt_id uuid not null unique,
  operation_id uuid not null,
  company_id uuid not null,
  process_id uuid,
  candidate_ref uuid,
  task text not null check (task in ('cv_screening', 'exercise_generation', 'competency_test_generation', 'interview_plan', 'report_summary')),
  attempt_no integer not null check (attempt_no between 1 and 100),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null check (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  model_revision text check (model_revision is null or model_revision ~ '^[A-Za-z0-9._:-]{1,100}$'),
  model_key text not null check (model_key ~ '^[A-Za-z0-9._:-]{1,64}$'),
  policy_version text not null check (policy_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  outcome text not null check (outcome ~ '^[a-z_]{1,40}$'),
  billing text not null check (billing in ('billed', 'maybe_billed', 'not_billed')),
  -- 'reserved' istnieje w domenie dla SC-021-C (rezerwacje budżetu); B go nie zapisuje.
  status text not null check (status in ('reserved', 'settled', 'unknown', 'released')),
  input_tokens integer check (input_tokens >= 0),
  cached_input_tokens integer check (cached_input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  price_id uuid references ai_ledger.prices (id),
  price_version text,
  price_placeholder boolean,
  currency text check (currency is null or currency in ('USD', 'EUR', 'PLN')),
  cost_micros bigint check (cost_micros is null or cost_micros >= 0),
  reserved_micros bigint check (reserved_micros is null or reserved_micros >= 0),
  provider_request_id text check (provider_request_id is null or provider_request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  latency_ms integer not null check (latency_ms between 0 and 3600000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  check ((input_tokens is null) = (cached_input_tokens is null) and (input_tokens is null) = (output_tokens is null)),
  check (cached_input_tokens is null or cached_input_tokens <= input_tokens),
  check ((billing = 'billed') = (outcome in ('completed', 'refused', 'incomplete'))),
  check ((price_id is null) = (price_version is null) and (price_id is null) = (price_placeholder is null)
    and (price_id is null) = (currency is null)),
  check (status <> 'released' or (billing = 'not_billed' and cost_micros = 0 and input_tokens is null and price_id is null)),
  check (status <> 'settled' or (billing <> 'not_billed' and input_tokens is not null and settled_at is not null
    and (cost_micros is null) = (price_id is null))),
  check (status <> 'unknown' or (billing <> 'not_billed' and cost_micros is null and input_tokens is null and price_id is null)),
  check (status <> 'reserved' or (cost_micros is null and reserved_micros is not null)),
  check (billing <> 'not_billed' or status = 'released'),
  -- Zasady retencji (nagłówek): nic, co po usunięciu danych kandydata pozwoliłoby go wskazać.
  check (task = 'cv_screening' or candidate_ref is null),
  check (task <> 'cv_screening' or provider_request_id is null)
);
create index attempts_company_created on ai_ledger.attempts (company_id, created_at desc);
create index attempts_operation on ai_ledger.attempts (operation_id);

-- Rejestr jest tylko dopisywany (dokument finansowy). SC-021-C, wprowadzając rozliczanie
-- rezerwacji (reserved → settled), zastąpi ten wyzwalacz przejściem dozwolonym jawnie.
create function ai_ledger.append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'AI ledger is append-only' using errcode = '42501';
end;
$$;
create trigger attempts_append_only before update or delete on ai_ledger.attempts
  for each row execute function ai_ledger.append_only();
create trigger prices_append_only before update or delete on ai_ledger.prices
  for each row execute function ai_ledger.append_only();
create trigger route_allowlist_append_only before update or delete on ai_ledger.route_allowlist
  for each row execute function ai_ledger.append_only();

alter table ai_ledger.prices enable row level security;
alter table ai_ledger.attempts enable row level security;
alter table ai_ledger.route_allowlist enable row level security;
revoke all on ai_ledger.prices, ai_ledger.attempts, ai_ledger.route_allowlist from public;
do $revoke$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'screening_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on ai_ledger.prices, ai_ledger.attempts, ai_ledger.route_allowlist from %I', r);
      execute format('revoke all on sequence ai_ledger.attempts_id_seq from %I', r);
    end if;
  end loop;
end
$revoke$;

-- Odczyt: członek firmy (właściciel, rekruter, przeglądający) widzi tylko wiersze swojej firmy.
grant usage on schema ai_ledger to authenticated;
grant select on ai_ledger.attempts to authenticated;
create policy attempts_member_read on ai_ledger.attempts for select to authenticated
  using (private.has_company_access(company_id));

-- Wybór stawki: zatwierdzona przed testową, dokładna rewizja przed ogólną, najnowsza ważna.
create function ai_ledger.price_for(target_provider text, target_model text, target_revision text, at timestamptz)
returns ai_ledger.prices language sql stable security definer set search_path = '' as $$
  select p.* from ai_ledger.prices p
  where p.provider = target_provider and p.model = target_model
    and (p.model_revision is null or p.model_revision = target_revision)
    and (p.approved or p.placeholder)
    and p.valid_from <= at and (p.valid_to is null or at < p.valid_to)
  order by p.approved desc, (p.model_revision is not null) desc, p.valid_from desc, p.id
  limit 1
$$;

-- Koszt w mikro-jednostkach, liczby całkowite, zaokrąglenie w górę. NULL bez stawki.
create function ai_ledger.cost_micros(price ai_ledger.prices, input_tokens integer, cached_tokens integer, output_tokens integer)
returns bigint language sql immutable set search_path = '' as $$
  select case when price.id is null or input_tokens is null then null else
    ceil(((input_tokens::numeric - cached_tokens::numeric) * price.input_per_mtok_micros
      + cached_tokens::numeric * price.cached_input_per_mtok_micros
      + output_tokens::numeric * price.output_per_mtok_micros) / 1000000)::bigint end
$$;

-- Wspólny zapis. Nie jest dostępny dla żadnej roli poza właścicielem; wołają go wyłącznie
-- dwie funkcje public.record_*_ai_attempt, które ustalają firmę z zaufanego stanu bazy.
create function ai_ledger.record_attempt(tenant uuid, process uuid, subject uuid, expected_task text,
  payload jsonb, keep_request_id boolean, allow_new boolean, max_rows integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  keys text[] := array['attempt_id','operation_id','company_id','task','attempt','provider','model','model_revision',
    'model_key','policy_version','outcome','billing','input_tokens','cached_input_tokens','output_tokens',
    'provider_request_id','latency_ms'];
  uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_attempt uuid; v_operation uuid; v_billing text; v_outcome text; v_status text;
  v_in integer; v_cached integer; v_out integer; v_request text;
  normalized jsonb; digest text; price ai_ledger.prices; cost bigint; existing ai_ledger.attempts; row_id bigint;
  used integer;
begin
  if tenant is null or jsonb_typeof(payload) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(payload)) <> cardinality(keys)
    or not payload ?& keys then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  if jsonb_typeof(payload->'attempt_id') is distinct from 'string' or lower(payload->>'attempt_id') !~ uuid_re
    or jsonb_typeof(payload->'operation_id') is distinct from 'string' or lower(payload->>'operation_id') !~ uuid_re
    or jsonb_typeof(payload->'company_id') is distinct from 'string' or lower(payload->>'company_id') !~ uuid_re
    or payload->>'task' is distinct from expected_task
    or jsonb_typeof(payload->'attempt') is distinct from 'number' or payload->>'attempt' !~ '^[1-9][0-9]?$'
    or jsonb_typeof(payload->'provider') is distinct from 'string' or payload->>'provider' not in ('openai','anthropic')
    or jsonb_typeof(payload->'model') is distinct from 'string' or payload->>'model' !~ '^[A-Za-z0-9._:-]{1,100}$'
    or (jsonb_typeof(payload->'model_revision') is distinct from 'null'
      and (jsonb_typeof(payload->'model_revision') is distinct from 'string' or payload->>'model_revision' !~ '^[A-Za-z0-9._:-]{1,100}$'))
    or jsonb_typeof(payload->'model_key') is distinct from 'string' or payload->>'model_key' !~ '^[A-Za-z0-9._:-]{1,64}$'
    or jsonb_typeof(payload->'policy_version') is distinct from 'string' or payload->>'policy_version' !~ '^[A-Za-z0-9._:-]{1,64}$'
    or jsonb_typeof(payload->'outcome') is distinct from 'string' or payload->>'outcome' !~ '^[a-z_]{1,40}$'
    or jsonb_typeof(payload->'billing') is distinct from 'string' or payload->>'billing' not in ('billed','maybe_billed','not_billed')
    or jsonb_typeof(payload->'latency_ms') is distinct from 'number' or payload->>'latency_ms' !~ '^[0-9]{1,7}$'
    or (payload->>'latency_ms')::integer > 3600000
    or (jsonb_typeof(payload->'provider_request_id') is distinct from 'null'
      and (jsonb_typeof(payload->'provider_request_id') is distinct from 'string' or payload->>'provider_request_id' !~ '^[A-Za-z0-9._:-]{1,128}$')) then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  -- Tokeny: wszystkie trzy albo żaden; liczby całkowite w zakresie integer; cache ≤ wejście.
  if not ((jsonb_typeof(payload->'input_tokens') = 'null' and jsonb_typeof(payload->'cached_input_tokens') = 'null'
      and jsonb_typeof(payload->'output_tokens') = 'null')
    or (jsonb_typeof(payload->'input_tokens') = 'number' and payload->>'input_tokens' ~ '^[0-9]{1,10}$'
      and jsonb_typeof(payload->'cached_input_tokens') = 'number' and payload->>'cached_input_tokens' ~ '^[0-9]{1,10}$'
      and jsonb_typeof(payload->'output_tokens') = 'number' and payload->>'output_tokens' ~ '^[0-9]{1,10}$'
      and (payload->>'input_tokens')::bigint <= 2147483647 and (payload->>'output_tokens')::bigint <= 2147483647
      and (payload->>'cached_input_tokens')::bigint <= (payload->>'input_tokens')::bigint)) then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  -- Firma z wejścia jest wyłącznie kontrolą spójności; zapisywana jest firma ustalona przez wywołującego.
  if (payload->>'company_id')::uuid is distinct from tenant then
    raise exception 'AI attempt tenant mismatch' using errcode = '42501';
  end if;
  v_attempt := (payload->>'attempt_id')::uuid;
  v_operation := (payload->>'operation_id')::uuid;
  v_billing := payload->>'billing';
  v_outcome := payload->>'outcome';
  if (v_billing = 'billed') <> (v_outcome in ('completed','refused','incomplete')) then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  v_in := (payload->>'input_tokens')::integer;
  v_cached := (payload->>'cached_input_tokens')::integer;
  v_out := (payload->>'output_tokens')::integer;
  if v_billing = 'not_billed' and v_in is not null then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  v_request := case when keep_request_id then payload->>'provider_request_id' end;

  normalized := jsonb_build_object('tenant', tenant, 'process', process, 'subject', subject)
    || (payload - 'provider_request_id') || jsonb_build_object('provider_request_id', v_request,
      'attempt_id', v_attempt, 'operation_id', v_operation, 'company_id', tenant);
  digest := encode(sha256(convert_to(normalized::text, 'UTF8')), 'hex');

  -- Idempotencja: ten sam attempt_id i ta sama treść → istniejący wiersz; inna treść → konflikt.
  perform pg_advisory_xact_lock(hashtextextended('ai_ledger:' || v_operation::text, 0));
  select * into existing from ai_ledger.attempts where attempt_id = v_attempt;
  if found then
    if existing.content_hash is distinct from digest or existing.company_id is distinct from tenant then
      raise exception 'AI attempt conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('ledger_id', existing.id, 'attempt_id', existing.attempt_id, 'status', existing.status,
      'cost_micros', existing.cost_micros, 'priced', existing.price_id is not null,
      'price_placeholder', existing.price_placeholder, 'replayed', true);
  end if;
  if not allow_new then
    raise exception 'AI attempt operation closed' using errcode = 'PT409';
  end if;
  -- Limit i spójność firmy liczone per (operacja, zadanie): wiersze innego zadania nie blokują zapisu.
  select count(*) into used from ai_ledger.attempts where operation_id = v_operation and task = expected_task;
  if used >= least(max_rows, 16) then
    raise exception 'AI attempt limit' using errcode = 'PT429';
  end if;
  if exists (select 1 from ai_ledger.attempts where operation_id = v_operation and task = expected_task and company_id <> tenant) then
    raise exception 'AI attempt conflict' using errcode = 'PT409';
  end if;

  v_status := case
    when v_billing = 'not_billed' then 'released'
    when v_in is not null then 'settled'
    else 'unknown' end;
  if v_status = 'settled' then
    price := ai_ledger.price_for(payload->>'provider', payload->>'model', payload->>'model_revision', clock_timestamp());
    cost := ai_ledger.cost_micros(price, v_in, v_cached, v_out);
  end if;

  insert into ai_ledger.attempts (attempt_id, operation_id, company_id, process_id, candidate_ref, task, attempt_no,
    provider, model, model_revision, model_key, policy_version, outcome, billing, status,
    input_tokens, cached_input_tokens, output_tokens, price_id, price_version, price_placeholder, currency,
    cost_micros, provider_request_id, latency_ms, content_hash, settled_at)
  values (v_attempt, v_operation, tenant, process, subject, expected_task, (payload->>'attempt')::integer,
    payload->>'provider', payload->>'model', payload->>'model_revision', payload->>'model_key', payload->>'policy_version',
    v_outcome, v_billing, v_status, v_in, v_cached, v_out,
    price.id, price.price_version, case when price.id is not null then price.placeholder end, price.currency,
    case when v_status = 'released' then 0 else cost end, v_request, (payload->>'latency_ms')::integer, digest,
    case when v_status = 'settled' then clock_timestamp() end)
  returning id into row_id;
  return jsonb_build_object('ledger_id', row_id, 'attempt_id', v_attempt, 'status', v_status,
    'cost_micros', case when v_status = 'released' then 0 else cost end, 'priced', price.id is not null,
    'price_placeholder', case when price.id is not null then price.placeholder end, 'replayed', false);
end;
$$;

-- Screening worker: firma, rekrutacja i zgłoszenie z próby analizy, którą worker trzyma w claimie.
create function public.record_screening_ai_attempt(attempt jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare tenant uuid; process uuid; subject uuid;
begin
  if jsonb_typeof(attempt) is distinct from 'object' or jsonb_typeof(attempt->'operation_id') is distinct from 'string'
    or lower(attempt->>'operation_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  select t.company_id, v.recruitment_id, v.application_id into tenant, process, subject
  from public.screening_analysis_attempts t
  join public.screening_analysis_versions v on v.id = t.analysis_id and v.company_id = t.company_id
  where t.id = (attempt->>'operation_id')::uuid;
  if tenant is null then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  return ai_ledger.record_attempt(tenant, process, subject, 'cv_screening', attempt, false, true, 16);
end;
$$;

-- Firma próby analizy dla claimu workera (SC-021-B wiąże firmę z kontekstem gatewaya).
create function public.screening_attempt_tenant(target_attempt uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare tenant uuid;
begin
  select t.company_id into tenant from public.screening_analysis_attempts t where t.id = target_attempt;
  if tenant is null then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  return tenant;
end;
$$;

-- Generowanie zadań: wyłącznie rola ai_ledger_writer (połączenie serwerowe). Bez auth.uid():
-- firma i rekrutacja (przekazane przez serwer z zaufanego kontekstu) muszą wskazywać rezerwację
-- generacji o kluczu `operation_id`; nowe wiersze tylko gdy jest 'reserved' i nie wygasła.
create function ai_ledger.record_exercise_attempt(target_company uuid, target_recruitment uuid, attempt jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare op uuid; item jsonb; allowed ai_ledger.route_allowlist; live boolean;
begin
  if target_company is null or target_recruitment is null or jsonb_typeof(attempt) is distinct from 'object'
    or jsonb_typeof(attempt->'operation_id') is distinct from 'string'
    or lower(attempt->>'operation_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid AI attempt' using errcode = '22023';
  end if;
  op := (attempt->>'operation_id')::uuid;
  -- Klucz rezerwacji wybiera klient: nie może podszyć się pod operację screeningu ani innego zadania.
  if exists (select 1 from public.screening_analysis_attempts where id = op)
    or exists (select 1 from ai_ledger.attempts where operation_id = op and task <> 'exercise_generation') then
    raise exception 'AI attempt conflict' using errcode = 'PT409';
  end if;
  perform 1 from public.recruitments r where r.id = target_recruitment and r.company_id = target_company;
  if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  -- Ta sama blokada co reserve/finish: zakończenie generacji czeka na zapis próby i odwrotnie.
  perform pg_advisory_xact_lock(hashtextextended('exercise_ai:' || target_recruitment::text, 0));
  select s.generation_requests->op::text into item from exercise_ai.recruitment_settings s
  where s.company_id = target_company and s.recruitment_id = target_recruitment;
  if item is null then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
  select * into allowed from ai_ledger.route_allowlist a
  where a.task = 'exercise_generation' and a.provider = attempt->>'provider' and a.model = attempt->>'model'
    and a.model_revision is not distinct from (attempt->>'model_revision')
    and a.model_key = attempt->>'model_key' and a.policy_version = attempt->>'policy_version';
  if not found then raise exception 'AI attempt route not allowed' using errcode = '22023'; end if;
  if jsonb_typeof(attempt->'input_tokens') = 'number' and (
      (attempt->>'input_tokens')::numeric > allowed.max_input_tokens
      or jsonb_typeof(attempt->'output_tokens') is distinct from 'number'
      or (attempt->>'output_tokens')::numeric > allowed.max_output_tokens) then
    raise exception 'AI attempt tokens out of bounds' using errcode = '22023';
  end if;
  live := item->>'status' = 'reserved' and (item->>'expires_at')::timestamptz > clock_timestamp();
  return ai_ledger.record_attempt(target_company, target_recruitment, null, 'exercise_generation', attempt, true,
    live, allowed.max_attempts);
end;
$$;

do $acl$
declare o record; g record;
begin
  for o in select p.oid, p.proowner from pg_proc p where p.oid = any(array[
    'ai_ledger.price_for(text,text,text,timestamptz)'::regprocedure,
    'ai_ledger.cost_micros(ai_ledger.prices,integer,integer,integer)'::regprocedure,
    'ai_ledger.record_attempt(uuid,uuid,uuid,text,jsonb,boolean,boolean,integer)'::regprocedure,
    'ai_ledger.append_only()'::regprocedure,
    'public.record_screening_ai_attempt(jsonb)'::regprocedure,
    'public.screening_attempt_tenant(uuid)'::regprocedure,
    'ai_ledger.record_exercise_attempt(uuid,uuid,jsonb)'::regprocedure]) loop
    execute format('revoke all on function %s from public', o.oid::regprocedure);
    for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
      join pg_roles r on r.oid = a.grantee where p.oid = o.oid and a.grantee <> o.proowner loop
      execute format('revoke all on function %s from %I', o.oid::regprocedure, g.rolname);
    end loop;
  end loop;
end
$acl$;
grant execute on function public.record_screening_ai_attempt(jsonb), public.screening_attempt_tenant(uuid) to screening_worker;
grant usage on schema ai_ledger to ai_ledger_writer;
grant execute on function ai_ledger.record_exercise_attempt(uuid, uuid, jsonb) to ai_ledger_writer;

-- Stawki TESTOWE (placeholder). To NIE są ceny OpenAI. Koszty liczone na nich są oznaczone
-- price_placeholder = true. Prawdziwe stawki wymagają osobnego, zatwierdzonego wiersza (approved).
insert into ai_ledger.prices (provider, model, model_revision, price_version, currency,
  input_per_mtok_micros, cached_input_per_mtok_micros, output_per_mtok_micros, placeholder, approved, valid_from, note)
values ('openai', 'gpt-5.4-mini-2026-03-17', null, 'placeholder-test-2026-11-09', 'USD',
  1000000, 500000, 2000000, true, false, '2026-11-09T00:00:00Z',
  'Stawki testowe SC-021-B, nie są cenami dostawcy. Do zastąpienia zatwierdzoną wersją.');

-- Wpis polityki generowania zadań z lib/ai-gateway/default-policy.ts (sc021-a2-2026-11-09):
-- 1 próba; wejście ograniczone limitem bajtów żądania (48 000 B → ≤ 48 000 tokenów),
-- wyjście limitem max_output_tokens (4 000).
insert into ai_ledger.route_allowlist (task, provider, model, model_revision, model_key, policy_version,
  max_attempts, max_input_tokens, max_output_tokens)
values ('exercise_generation', 'openai', 'gpt-5.4-mini-2026-03-17', null, 'openai-exercise', 'sc021-a2-2026-11-09', 1, 48000, 4000);

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc021b_inventory_changed' using errcode = '55000';
  end if;
end
$postflight$;
commit;
