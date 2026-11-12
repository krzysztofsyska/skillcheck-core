-- SC-PROCESS / #277, część A — diagnostyka rekrutacji przy małym napływie CV
-- oraz wskaźniki czasu rekrutacji z definicją i zakresem danych.
--
-- Co dochodzi:
--  * `process.diagnostic_records` — wersjonowany, wyłącznie dopisywany zapis
--    diagnozy rekrutacji: stała lista pięciu obszarów (kanały, nazwa roli,
--    zadania, ogłoszenie, warunki rynkowe), każdy ze statusem
--    ok / problem / not_checked i krótką notatką, oraz zalecenie.
--    Reguła z #277 egzekwowana w bazie: zalecenia „zmień budżet" NIE da się
--    zapisać, dopóki którykolwiek obszar ma status not_checked.
--  * napływ CV i wskaźniki czasu — liczone przy każdym odczycie z danych, które
--    już istnieją (public.applications, public.recruitment_shortlist_entries,
--    public.application_decision_events). Nic z tego nie jest kopiowane do
--    nowych tabel poza samymi liczbami (migawka napływu w zapisie diagnozy:
--    cztery liczby, bez identyfikatorów i bez dat zgłoszeń).
--
-- Czego tu NIE ma (część B, osobny PR): obserwacji po zatrudnieniu 30/90/180,
-- oceny wewnętrznej / awansu, puli talentów. Wskaźniki przejścia próby
-- i retencji są w katalogu, ale zawsze zwracają `not_measured` z powodem
-- `requires_post_hire_observations` — nie są udawane.
--
-- Dlaczego osobny schemat `process`, a nie `public`/`private` (wzorzec
-- z 20261112100000_sc_method_profile.sql): private.erasure_schema_signature()
-- obejmuje relacje w 'public' i 'private' oraz więzy, które się do nich
-- odwołują, i jest przypięta do inwentarza usuwania danych kandydatów (SC-010).
-- Zapis diagnozy to dane firmy o rekrutacji, bez danych kandydata, więc do tego
-- inwentarza nie należy. Dlatego tabela NIE ma kluczy obcych do public.*;
-- firmę, rekrutację i uprawnienia sprawdzają wyłącznie funkcje poniżej.
-- Migracja dodaje w 'public' tylko trzy funkcje public.process_*.
--
-- Sygnatura SC-010: ta migracja NIE przypina konkretnej wartości (równolegle
-- inny PR przenosi inwentarz z R15 na R16). Zapamiętuje wartość z preflight
-- i w postflight wymaga, żeby była identyczna — czyli „niezmieniona przez tę
-- migrację", niezależnie od tego, która rewizja inwentarza obowiązuje.
--
-- Dostęp: schemat `process` nie jest widoczny dla anon/authenticated; RLS jest
-- włączone bez polityk. Jedyna droga to funkcje public.process_* (security definer):
--   * odczyt (stan, historia, wskaźniki) — każdy członek firmy;
--   * zapis diagnozy — właściciel lub rekruter tej firmy
--     (private.has_company_access(firma, true)); czytelnik (viewer) nie.
-- Funkcje nie oceniają kandydatów i nie podejmują żadnej decyzji kadrowej.
--
-- Usuwanie: historia jest niezmienna. Jedyny wyjątek to przyszła,
-- uprzywilejowana procedura usuwania firmy, która w tej samej transakcji
-- ustawi set_config('process.purge_company', '<uuid firmy>', true).
begin;

do $preflight$
begin
  if to_regnamespace('process') is not null then
    raise exception 'sc_process_already_installed' using errcode = '55000';
  end if;
  if to_regclass('public.recruitments') is null or to_regclass('public.applications') is null
     or to_regclass('public.recruitment_shortlist_entries') is null
     or to_regclass('public.application_decision_events') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'sc_process_dependency_missing' using errcode = '55000';
  end if;
  -- Wartość sprzed migracji, widoczna tylko w tej transakcji; porównywana w postflight.
  perform set_config('sc_process.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create schema process;
revoke all on schema process from public;
-- Bez `grant usage`: do tabeli nie sięga żadna rola aplikacji bezpośrednio.

create table process.diagnostic_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  -- Kolejny numer zapisu w rekrutacji (1, 2, 3…); zapis nigdy nie jest zmieniany.
  record_no integer not null check (record_no between 1 and 1000),
  -- Postać kanoniczna z process.normalize_content(): areas{5 obszarów}, channelsUsed[].
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 20000),
  recommendation_kind text not null check (recommendation_kind in ('fix_areas', 'keep_watching', 'change_budget')),
  recommendation text not null check (length(recommendation) between 1 and 1000),
  -- Same liczby z chwili zapisu: total, last_14_days, last_30_days, days_open.
  inflow_snapshot jsonb not null check (jsonb_typeof(inflow_snapshot) = 'object' and octet_length(inflow_snapshot::text) <= 1000),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, recruitment_id, record_no),
  -- Druga linia obrony reguły z #277, niezależna od funkcji zapisu.
  constraint budget_requires_full_check check (
    recommendation_kind <> 'change_budget'
    or not (content -> 'areas') @? '$.* ? (@.status == "not_checked")')
);

alter table process.diagnostic_records enable row level security;
revoke all on process.diagnostic_records from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on process.diagnostic_records from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on process.diagnostic_records from authenticated;
  end if;
end
$revoke$;

create function process.purge_allowed(target_company uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('process.purge_company', true), '') = target_company::text
$$;

create function process.guard_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and process.purge_allowed(old.company_id) then
    return old;
  end if;
  raise exception 'process_history_immutable' using errcode = '42501';
end;
$$;
create trigger guard_records before update or delete on process.diagnostic_records
  for each row execute function process.guard_record();

-- Przycięcie białych znaków z obu końców: ten sam zestaw co trimWs()
-- w lib/process-diagnostics.ts (spacja, tabulator, nowa linia, CR, FF, VT, twarda spacja).
create function process.trim_ws(value text) returns text
language sql immutable set search_path = '' as $$
  select btrim(value, E' \t\n\r\f\u000B ')
$$;

-- Tekst: przycięty, bez znaków sterujących, do max_len znaków. Null = pusty; za długi lub zły = null.
create function process.clean_text(value text, max_len integer) returns text
language sql immutable set search_path = '' as $$
  select case
    when value is null then ''
    when length(process.trim_ws(value)) <= max_len
      and process.trim_ws(value) !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
      then process.trim_ws(value)
  end
$$;

-- Walidacja i postać kanoniczna diagnozy. Te same reguły co
-- parseDiagnosticContent() / diagnosticProblems() w lib/process-diagnostics.ts;
-- baza jest ostateczną granicą.
create function process.normalize_content(value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  area text; item jsonb; status_code text; note text; areas jsonb := '{}'::jsonb;
  channel jsonb; channels text[] := array[]::text[]; raw_channels jsonb;
  known_areas constant text[] := array['channels', 'role_name', 'tasks', 'job_ad', 'market'];
  known_channels constant text[] := array['job_board', 'company_site', 'social_media', 'referrals', 'agency', 'employment_office', 'other'];
begin
  if jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(value -> 'areas') is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(value -> 'areas') k where k <> all (known_areas)) then
    raise exception 'process_diagnostic_invalid' using errcode = '22023';
  end if;
  foreach area in array known_areas loop
    item := value -> 'areas' -> area;
    if jsonb_typeof(item) is distinct from 'object'
       or jsonb_typeof(item -> 'status') is distinct from 'string'
       or jsonb_typeof(coalesce(item -> 'note', '""'::jsonb)) not in ('string', 'null') then
      raise exception 'process_diagnostic_invalid' using errcode = '22023';
    end if;
    status_code := item ->> 'status';
    note := process.clean_text(item ->> 'note', 500);
    if status_code not in ('ok', 'problem', 'not_checked') or note is null then
      raise exception 'process_diagnostic_invalid' using errcode = '22023';
    end if;
    -- „Problem" bez opisu nie mówi następnej osobie, co poprawić.
    if status_code = 'problem' and note = '' then
      raise exception 'process_diagnostic_incomplete:%.note', area using errcode = '22023';
    end if;
    areas := areas || jsonb_build_object(area, jsonb_build_object('status', status_code, 'note', note));
  end loop;
  raw_channels := coalesce(value -> 'channelsUsed', '[]'::jsonb);
  if jsonb_typeof(raw_channels) is distinct from 'array' or jsonb_array_length(raw_channels) > 7 then
    raise exception 'process_diagnostic_invalid' using errcode = '22023';
  end if;
  for channel in select c.value from jsonb_array_elements(raw_channels) c loop
    if jsonb_typeof(channel) is distinct from 'string' or (channel #>> '{}') <> all (known_channels)
       or (channel #>> '{}') = any (channels) then
      raise exception 'process_diagnostic_invalid' using errcode = '22023';
    end if;
    channels := channels || (channel #>> '{}');
  end loop;
  -- Kanały w stałej kolejności katalogu, żeby ta sama treść dawała ten sam zapis.
  return jsonb_build_object('areas', areas, 'channelsUsed',
    coalesce((select jsonb_agg(k order by array_position(known_channels, k)) from unnest(channels) k), '[]'::jsonb));
end;
$$;

-- Początek rekrutacji dla napływu i wskaźników: data otwarcia, a gdy jej nie
-- zapisano — data utworzenia rekrutacji. Źródło jest zawsze zwracane obok wartości.
create function process.started_at(r public.recruitments) returns timestamptz
language sql immutable set search_path = '' as $$
  select coalesce(r.opened_at, r.created_at)
$$;

create function process.days_between(from_at timestamptz, to_at timestamptz) returns numeric
language sql immutable set search_path = '' as $$
  select round((extract(epoch from (to_at - from_at)) / 86400.0)::numeric, 1)
$$;

-- Napływ CV: wyłącznie liczby i dwie skrajne daty zgłoszeń tej rekrutacji.
create function process.inflow(r public.recruitments) returns jsonb
language sql stable set search_path = '' as $$
  with apps as (
    select a.created_at from public.applications a
     where a.company_id = r.company_id and a.recruitment_id = r.id),
  moment as (select now() as ts)
  select jsonb_build_object(
    'status', r.status,
    'started_at', process.started_at(r),
    'start_source', case when r.opened_at is not null then 'opened_at' else 'created_at' end,
    'closed_at', r.closed_at,
    'days_open', greatest(0, floor(extract(epoch from (coalesce(r.closed_at, (select ts from moment)) - process.started_at(r))) / 86400.0))::integer,
    'total', (select count(*) from apps),
    'last_7_days', (select count(*) from apps, moment where apps.created_at > moment.ts - interval '7 days'),
    'last_14_days', (select count(*) from apps, moment where apps.created_at > moment.ts - interval '14 days'),
    'last_30_days', (select count(*) from apps, moment where apps.created_at > moment.ts - interval '30 days'),
    'first_application_at', (select min(created_at) from apps),
    'last_application_at', (select max(created_at) from apps),
    -- Osiem kolejnych okresów po 7 dni wstecz od teraz; weeks_ago = 0 to ostatnie 7 dni.
    'weekly', (select jsonb_agg(jsonb_build_object('weeks_ago', w.n, 'count',
                 (select count(*) from apps, moment
                   where apps.created_at > moment.ts - make_interval(days => 7 * (w.n + 1))
                     and apps.created_at <= moment.ts - make_interval(days => 7 * w.n))) order by w.n)
                 from generate_series(0, 7) w(n)))
$$;

-- Wspólne sprawdzenie: zalogowany członek firmy (write = właściciel lub rekruter)
-- i rekrutacja tej samej firmy. Zwraca wiersz rekrutacji.
create function process.require_member(target_company uuid, target_recruitment uuid, write_access boolean) returns public.recruitments
language plpgsql stable security definer set search_path = '' as $$
declare r public.recruitments;
begin
  if (select auth.uid()) is null or target_company is null or target_recruitment is null
     or not private.has_company_access(target_company, write_access) then
    raise exception 'process_forbidden' using errcode = '42501';
  end if;
  select * into r from public.recruitments x
   where x.company_id = target_company and x.id = target_recruitment;
  if not found then
    raise exception 'process_forbidden' using errcode = '42501';
  end if;
  return r;
end;
$$;

revoke all on function process.purge_allowed(uuid), process.guard_record(), process.trim_ws(text),
  process.clean_text(text, integer), process.normalize_content(jsonb), process.started_at(public.recruitments),
  process.days_between(timestamptz, timestamptz), process.inflow(public.recruitments),
  process.require_member(uuid, uuid, boolean) from public;

-- Zapis diagnozy. expected_record_no to numer ostatniego zapisu, który rekruter
-- widział (0, gdy rekrutacja nie ma jeszcze żadnego). Niezgodność = PT409, bez
-- zapisu: dwie karty nie dopiszą po cichu dwóch sprzecznych diagnoz.
create function public.process_record_diagnostic(target_company uuid, target_recruitment uuid,
  diagnostic jsonb, recommendation_kind text, recommendation text, expected_record_no integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); r public.recruitments; canonical jsonb; advice text;
  current_no integer; unchecked text[]; flow jsonb;
begin
  r := process.require_member(target_company, target_recruitment, true);
  if expected_record_no is null or expected_record_no < 0 then
    raise exception 'process_diagnostic_invalid' using errcode = '22023';
  end if;
  canonical := process.normalize_content(diagnostic);
  advice := process.clean_text(recommendation, 1000);
  if recommendation_kind is null or recommendation_kind not in ('fix_areas', 'keep_watching', 'change_budget') or advice is null then
    raise exception 'process_diagnostic_invalid' using errcode = '22023';
  end if;
  if advice = '' then
    raise exception 'process_diagnostic_incomplete:recommendation' using errcode = '22023';
  end if;
  -- #277: kanały, nazwa roli, zadania, ogłoszenie i warunki rynkowe sprawdza się PRZED zmianą budżetu.
  select coalesce(array_agg(a.key order by a.key), array[]::text[]) into unchecked
    from jsonb_each(canonical -> 'areas') a where a.value ->> 'status' = 'not_checked';
  if recommendation_kind = 'change_budget' and cardinality(unchecked) > 0 then
    raise exception 'process_budget_requires_full_check:%', array_to_string(unchecked, ',') using errcode = '22023';
  end if;
  if recommendation_kind = 'fix_areas'
     and not exists (select 1 from jsonb_each(canonical -> 'areas') a where a.value ->> 'status' = 'problem') then
    raise exception 'process_diagnostic_incomplete:fix_areas.problem' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sc-process:' || target_recruitment::text, 0));
  select coalesce(max(d.record_no), 0) into current_no from process.diagnostic_records d
   where d.company_id = target_company and d.recruitment_id = target_recruitment;
  if current_no <> expected_record_no then
    raise exception 'process_record_changed' using errcode = 'PT409';
  end if;
  if current_no >= 1000 then
    raise exception 'process_diagnostic_limit' using errcode = '54000';
  end if;
  flow := process.inflow(r);
  insert into process.diagnostic_records (company_id, recruitment_id, record_no, content, recommendation_kind,
      recommendation, inflow_snapshot, created_by)
    values (target_company, target_recruitment, current_no + 1, canonical, recommendation_kind, advice,
      jsonb_build_object('total', flow -> 'total', 'last_14_days', flow -> 'last_14_days',
        'last_30_days', flow -> 'last_30_days', 'days_open', flow -> 'days_open'), actor);
  return current_no + 1;
end;
$$;

-- Stan dla panelu: napływ CV (liczony teraz), numer ostatniego zapisu i historia diagnoz.
create function public.process_diagnostics_state(target_company uuid, target_recruitment uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.recruitments;
begin
  r := process.require_member(target_company, target_recruitment, false);
  return jsonb_build_object(
    'can_edit', private.has_company_access(target_company, true),
    'latest_record_no', (select coalesce(max(d.record_no), 0) from process.diagnostic_records d
                          where d.company_id = target_company and d.recruitment_id = target_recruitment),
    'inflow', process.inflow(r),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('id', h.id, 'record_no', h.record_no, 'content', h.content,
               'recommendation_kind', h.recommendation_kind, 'recommendation', h.recommendation,
               'inflow_snapshot', h.inflow_snapshot, 'created_at', h.created_at) order by h.record_no desc)
        from (select * from process.diagnostic_records d
               where d.company_id = target_company and d.recruitment_id = target_recruitment
               order by d.record_no desc limit 50) h), '[]'::jsonb));
end;
$$;

-- Wskaźniki z definicją i zakresem danych. Każdy ma jawny stan:
--   measured     — value jest liczbą (także 0 lub ujemną);
--   not_measured — value = null, reason mówi dlaczego. To NIE jest zero.
-- Definicje słowne: lib/process-metrics.ts (ta sama wersja katalogu).
create function public.process_recruitment_metrics(target_company uuid, target_recruitment uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r public.recruitments; started timestamptz; min_rows constant integer := 3;
  apps integer; first_app timestamptz;
  shortlisted integer; first_shortlist timestamptz;
  next_stage integer; first_next_stage timestamptz;
  decided integer; median_days numeric; decided_from timestamptz; decided_to timestamptz;
  metrics jsonb := '[]'::jsonb;
begin
  r := process.require_member(target_company, target_recruitment, false);
  started := process.started_at(r);

  select count(*), min(a.created_at) into apps, first_app from public.applications a
   where a.company_id = target_company and a.recruitment_id = target_recruitment;
  metrics := metrics || jsonb_build_object('key', 'days_to_first_application', 'unit', 'days',
    'state', case when apps > 0 then 'measured' else 'not_measured' end,
    'value', case when apps > 0 then process.days_between(started, first_app) end,
    'reason', case when apps = 0 then 'no_data' end,
    'scope', jsonb_build_object('source', 'applications', 'rows', apps, 'period_from', started, 'period_to', first_app));

  -- Wszystkie wpisy krótkiej listy, także później wycofane: liczy się chwila pierwszego wyboru.
  select count(*), min(s.selected_at) into shortlisted, first_shortlist from public.recruitment_shortlist_entries s
   where s.company_id = target_company and s.recruitment_id = target_recruitment;
  metrics := metrics || jsonb_build_object('key', 'days_to_first_shortlist', 'unit', 'days',
    'state', case when shortlisted > 0 then 'measured' else 'not_measured' end,
    'value', case when shortlisted > 0 then process.days_between(started, first_shortlist) end,
    'reason', case when shortlisted = 0 then 'no_data' end,
    'scope', jsonb_build_object('source', 'recruitment_shortlist_entries', 'rows', shortlisted, 'period_from', started, 'period_to', first_shortlist));

  select count(*), min(e.created_at) into next_stage, first_next_stage from public.application_decision_events e
   where e.company_id = target_company and e.recruitment_id = target_recruitment and e.new_decision = 'next_stage';
  metrics := metrics || jsonb_build_object('key', 'days_to_first_next_stage_decision', 'unit', 'days',
    'state', case when next_stage > 0 then 'measured' else 'not_measured' end,
    'value', case when next_stage > 0 then process.days_between(started, first_next_stage) end,
    'reason', case when next_stage = 0 then 'no_data' end,
    'scope', jsonb_build_object('source', 'application_decision_events', 'rows', next_stage, 'period_from', started, 'period_to', first_next_stage));

  -- Mediana czasu od zgłoszenia do pierwszej decyzji rekrutera (dowolnej), po jednym pomiarze na zgłoszenie.
  select count(*), percentile_cont(0.5) within group (order by extract(epoch from (d.first_decision - d.applied_at))),
         min(d.applied_at), max(d.first_decision)
    into decided, median_days, decided_from, decided_to
    from (select a.created_at as applied_at, min(e.created_at) as first_decision
            from public.applications a
            join public.application_decision_events e
              on e.company_id = a.company_id and e.recruitment_id = a.recruitment_id and e.application_id = a.id
           where a.company_id = target_company and a.recruitment_id = target_recruitment
           group by a.id, a.created_at) d;
  metrics := metrics || jsonb_build_object('key', 'median_days_application_to_decision', 'unit', 'days',
    'state', case when decided >= min_rows then 'measured' else 'not_measured' end,
    'value', case when decided >= min_rows then round((median_days / 86400.0)::numeric, 1) end,
    'reason', case when decided = 0 then 'no_data' when decided < min_rows then 'too_few_rows' end,
    'scope', jsonb_build_object('source', 'application_decision_events', 'rows', decided, 'population', apps,
      'min_rows', min_rows, 'period_from', decided_from, 'period_to', decided_to));

  metrics := metrics || jsonb_build_object('key', 'recruitment_duration_days', 'unit', 'days',
    'state', case when r.closed_at is not null then 'measured' else 'not_measured' end,
    'value', case when r.closed_at is not null then process.days_between(started, r.closed_at) end,
    'reason', case when r.closed_at is null then 'recruitment_not_closed' end,
    'scope', jsonb_build_object('source', 'recruitments', 'rows', 1, 'period_from', started, 'period_to', r.closed_at));

  -- Bez daty zatrudnienia i bez obserwacji po zatrudnieniu tych wskaźników nie da się policzyć.
  -- Zwracane jawnie jako brak pomiaru; część B doda dane, nie ta migracja.
  metrics := metrics
    || jsonb_build_object('key', 'days_to_hire', 'unit', 'days', 'state', 'not_measured', 'value', null,
         'reason', 'requires_hire_date', 'scope', jsonb_build_object('source', null, 'rows', 0, 'period_from', null, 'period_to', null))
    || jsonb_build_object('key', 'probation_pass_rate', 'unit', 'percent', 'state', 'not_measured', 'value', null,
         'reason', 'requires_post_hire_observations', 'scope', jsonb_build_object('source', null, 'rows', 0, 'period_from', null, 'period_to', null))
    || jsonb_build_object('key', 'retention_rate', 'unit', 'percent', 'state', 'not_measured', 'value', null,
         'reason', 'requires_post_hire_observations', 'scope', jsonb_build_object('source', null, 'rows', 0, 'period_from', null, 'period_to', null));

  return jsonb_build_object('definition_version', 'process-metrics-v1', 'computed_at', now(),
    'started_at', started, 'start_source', case when r.opened_at is not null then 'opened_at' else 'created_at' end,
    'metrics', metrics);
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.process_record_diagnostic(uuid,uuid,jsonb,text,text,integer)',
    'public.process_diagnostics_state(uuid,uuid)',
    'public.process_recruitment_metrics(uuid,uuid)'] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'screening_worker') then
      execute format('revoke all on function %s from screening_worker', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', fn);
    end if;
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end
$grants$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc_process.signature_before', true) then
    raise exception 'sc_process_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'process' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'sc_process_rls_missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_constraint k
              join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
             where n.nspname = 'process' and fn.nspname <> 'process') then
    raise exception 'sc_process_foreign_key_outside_schema' using errcode = '55000';
  end if;
end
$postflight$;

commit;
