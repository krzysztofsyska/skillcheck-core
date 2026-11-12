-- SC-METHOD / #275 — profil metody dla stanowiska i macierz dowodów.
--
-- Co dochodzi: wersjonowany „profil metody" stanowiska — cel, oczekiwany wynik,
-- ograniczenia, poziom odpowiedzialności (specjalista / menedżer / dyrektor) —
-- oraz macierz dowodów: dla każdej kompetencji oczekiwany dowód, metoda oceny
-- z uzasadnieniem, kryteria i granice wniosku. Zadania i samodzielność są już
-- w public.positions; zatwierdzona wersja zapisuje ich kopię.
--
-- Cykl życia: szkic -> zatwierdzona. Jeden szkic na stanowisko, edytowalny.
-- Zatwierdzenie nadaje numer wersji i odcisk treści; zatwierdzona wersja jest
-- NIEZMIENNA dla wszystkich ról (wyzwalacz method.guard_version). Późniejsza
-- zmiana to nowy szkic i nowa wersja; starsze wersje zostają w historii.
--
-- Dlaczego osobny schemat `method`, a nie `public`/`private` (wzorzec z
-- 20261104120000_position_requirement_flags.sql i 20261109190000_sc020_brand_configuration.sql):
-- private.erasure_schema_signature() obejmuje relacje w 'public' i 'private'
-- oraz więzy, które się do nich odwołują, i jest przypięta do baseline'u
-- inwentarza usuwania danych kandydatów (SC-010, R15). Profil metody to dane
-- firmy o stanowisku, bez żadnych danych kandydata, więc do tego inwentarza nie
-- należy. Dlatego tabele `method.*` NIE mają kluczy obcych do public.positions,
-- public.companies ani public.exercise_definition_entries (taki więz zmieniłby
-- sygnaturę); firmę, stanowisko i uprawnienia sprawdzają wyłącznie funkcje
-- poniżej. Ta migracja nie tworzy, nie zmienia ani nie usuwa żadnej relacji,
-- kolumny, więzu, wyzwalacza ani funkcji w 'public' lub 'private' poza
-- dodaniem sześciu funkcji public.method_*. Sygnatura SC-010 pozostaje
-- niezmieniona (sprawdzane w preflight i postflight).
--
-- Powiązanie z definicją zadania (SC-014 / #270, #271): definicja zadania
-- (public.exercise_definition_entries) jest niezmienną wersją, a nadania i
-- próby wskazują dokładny definition_entry_id. Dopisanie odcisku metody do
-- position_snapshot wymagałoby podmiany public.save_exercise_definition, której
-- treść jest przypięta w testach migracji; zamiast tego powiązanie
-- definition_entry_id -> wersja metody żyje w `method.definition_bindings`
-- (bez klucza obcego). Reguła jest deterministyczna: definicja wiąże się z tą
-- zatwierdzoną wersją metody stanowiska, która obowiązywała w chwili utworzenia
-- definicji (approved_at <= created_at definicji, najwyższy numer). Wynik nie
-- zależy więc od tego, kiedy powiązanie zostało zapisane, a zatwierdzenie
-- nowszej wersji metody nie zmienia ani powiązania, ani definicji, ani próby.
--
-- Dostęp: schemat `method` nie jest widoczny dla anon/authenticated; RLS jest
-- włączone bez polityk, więc każdy bezpośredni odczyt i zapis jest odmawiany.
-- Jedyna droga to funkcje public.method_* (security definer):
--   * odczyt zatwierdzonych wersji i historii — każdy członek firmy;
--   * szkic, zatwierdzenie, powiązanie — właściciel lub rekruter tej firmy
--     (private.has_company_access(firma, true)); czytelnik (viewer) nie.
-- Funkcje nie podejmują żadnej decyzji o kandydacie i niczego nie punktują.
--
-- Usuwanie: historia jest niezmienna. Jedyny wyjątek to przyszła,
-- uprzywilejowana procedura usuwania firmy, która w tej samej transakcji
-- ustawi set_config('method.purge_company', '<uuid firmy>', true); wtedy
-- wyzwalacze pozwalają usunąć wiersze tylko tej firmy. Nic w tej migracji
-- tego nie robi.
begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc_method_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('method') is not null then
    raise exception 'sc_method_already_installed' using errcode = '55000';
  end if;
  if to_regclass('public.positions') is null or to_regclass('public.exercise_definition_entries') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null then
    raise exception 'sc_method_dependency_missing' using errcode = '55000';
  end if;
end
$preflight$;

create schema method;
revoke all on schema method from public;
-- Bez `grant usage`: do tabel nie sięga żadna rola aplikacji bezpośrednio.

create table method.profile_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  position_id uuid not null,
  status text not null check (status in ('draft', 'approved')),
  -- Licznik zapisów szkicu: ochrona przed nadpisaniem zmian z drugiej karty.
  revision integer not null default 1 check (revision between 1 and 1000000),
  version_no integer check (version_no between 1 and 1000000),
  -- Kanoniczna treść z method.normalize_content(): goal, expectedOutcome,
  -- constraints, responsibilityLevel, matrix[]. Wyłącznie dane o stanowisku.
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 600000),
  -- Kopia profilu stanowiska z chwili zatwierdzenia (tytuł, zadania, mierniki,
  -- samodzielność, kompetencje) — zatwierdzona wersja jest przez to kompletna.
  position_snapshot jsonb,
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  approved_by uuid,
  approved_at timestamptz,
  unique (company_id, id),
  unique (company_id, position_id, version_no),
  check ((status = 'draft') = (version_no is null)),
  check ((status = 'draft') = (approved_at is null)),
  check ((status = 'draft') = (approved_by is null)),
  check ((status = 'draft') = (content_hash is null)),
  check ((status = 'draft') = (position_snapshot is null))
);
create unique index profile_versions_one_draft on method.profile_versions (company_id, position_id) where status = 'draft';
create index profile_versions_effective_idx on method.profile_versions (company_id, position_id, version_no desc) where status = 'approved';

-- Powiązanie niezmiennej wersji definicji zadania z dokładną wersją metody.
-- definition_entry_id to id z public.exercise_definition_entries (bez klucza obcego).
create table method.definition_bindings (
  definition_entry_id uuid primary key,
  company_id uuid not null,
  position_id uuid not null,
  method_version_id uuid not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  bound_by uuid not null,
  bound_at timestamptz not null default clock_timestamp(),
  foreign key (company_id, method_version_id) references method.profile_versions (company_id, id)
);
create index definition_bindings_version_idx on method.definition_bindings (company_id, method_version_id);

alter table method.profile_versions enable row level security;
alter table method.definition_bindings enable row level security;
revoke all on method.profile_versions, method.definition_bindings from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on method.profile_versions, method.definition_bindings from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on method.profile_versions, method.definition_bindings from authenticated;
  end if;
end
$revoke$;

create function method.purge_allowed(target_company uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('method.purge_company', true), '') = target_company::text
$$;

create function method.guard_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if method.purge_allowed(old.company_id) then
      return old;
    end if;
    raise exception 'method_history_immutable' using errcode = '42501';
  end if;
  if old.status <> 'draft'
     or new.id <> old.id or new.company_id <> old.company_id or new.position_id <> old.position_id
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'method_history_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_versions before update or delete on method.profile_versions
  for each row execute function method.guard_version();

create function method.guard_binding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and method.purge_allowed(old.company_id) then
    return old;
  end if;
  raise exception 'method_history_immutable' using errcode = '42501';
end;
$$;
create trigger guard_bindings before update or delete on method.definition_bindings
  for each row execute function method.guard_binding();

-- Tekst z JSON: przycięty, bez znaków sterujących, do max_len znaków.
-- Brak pola lub null = pusty tekst; zły typ lub przekroczony limit = null.
create function method.clean_text(value jsonb, max_len integer) returns text
language sql immutable set search_path = '' as $$
  select case
    when value is null or jsonb_typeof(value) = 'null' then ''
    when jsonb_typeof(value) = 'string'
      and length(btrim(value #>> '{}')) <= max_len
      and (value #>> '{}') !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
      then btrim(value #>> '{}')
  end
$$;

-- Walidacja i postać kanoniczna treści profilu. Te same reguły co
-- parseMethodProfileContent() / methodProfileProblems() w lib/method-profile.ts;
-- baza jest ostateczną granicą. strict = false: szkic (pola mogą być puste).
-- strict = true: zatwierdzenie — wszystko uzupełnione, a macierz obejmuje
-- dokładnie kompetencje z aktualnego profilu stanowiska.
create function method.normalize_content(value jsonb, strict boolean, competencies text[]) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  goal text; outcome text; profile_limits text; level_code text;
  item jsonb; entry jsonb; matrix_rows jsonb := '[]'::jsonb;
  competency text; evidence text; method_code text; justification text; conclusion_limits text;
  criterion text; criteria jsonb; seen text[] := array[]::text[]; required text[];
begin
  if jsonb_typeof(value) is distinct from 'object' then
    raise exception 'method_profile_invalid' using errcode = '22023';
  end if;
  goal := method.clean_text(value -> 'goal', 1000);
  outcome := method.clean_text(value -> 'expectedOutcome', 1000);
  profile_limits := method.clean_text(value -> 'constraints', 1000);
  level_code := method.clean_text(value -> 'responsibilityLevel', 20);
  if goal is null or outcome is null or profile_limits is null or level_code is null
     or level_code not in ('', 'specialist', 'manager', 'director')
     or jsonb_typeof(coalesce(value -> 'matrix', '[]'::jsonb)) is distinct from 'array'
     or jsonb_array_length(coalesce(value -> 'matrix', '[]'::jsonb)) > 30 then
    raise exception 'method_profile_invalid' using errcode = '22023';
  end if;
  for item in select m.value from jsonb_array_elements(coalesce(value -> 'matrix', '[]'::jsonb)) with ordinality m(value, n) order by m.n loop
    if jsonb_typeof(item) is distinct from 'object' then
      raise exception 'method_profile_invalid' using errcode = '22023';
    end if;
    competency := method.clean_text(item -> 'competency', 500);
    evidence := method.clean_text(item -> 'evidence', 600);
    method_code := method.clean_text(item -> 'method', 30);
    justification := method.clean_text(item -> 'justification', 600);
    conclusion_limits := method.clean_text(item -> 'limits', 600);
    if competency is null or competency = '' or evidence is null or method_code is null
       or justification is null or conclusion_limits is null
       or method_code not in ('', 'cv_evidence', 'competency_test', 'case_study', 'simulation', 'interview')
       or lower(competency) = any (seen)
       or jsonb_typeof(coalesce(item -> 'criteria', '[]'::jsonb)) is distinct from 'array'
       or jsonb_array_length(coalesce(item -> 'criteria', '[]'::jsonb)) > 8 then
      raise exception 'method_profile_invalid' using errcode = '22023';
    end if;
    seen := seen || lower(competency);
    criteria := '[]'::jsonb;
    for entry in select c.value from jsonb_array_elements(coalesce(item -> 'criteria', '[]'::jsonb)) with ordinality c(value, n) order by c.n loop
      criterion := method.clean_text(entry, 300);
      if criterion is null then
        raise exception 'method_profile_invalid' using errcode = '22023';
      end if;
      if criterion <> '' then
        criteria := criteria || jsonb_build_array(criterion);
      end if;
    end loop;
    if strict then
      if evidence = '' then raise exception 'method_profile_incomplete:matrix.evidence' using errcode = '22023'; end if;
      if method_code = '' then raise exception 'method_profile_incomplete:matrix.method' using errcode = '22023'; end if;
      if justification = '' then raise exception 'method_profile_incomplete:matrix.justification' using errcode = '22023'; end if;
      if jsonb_array_length(criteria) = 0 then raise exception 'method_profile_incomplete:matrix.criteria' using errcode = '22023'; end if;
      if conclusion_limits = '' then raise exception 'method_profile_incomplete:matrix.limits' using errcode = '22023'; end if;
    end if;
    matrix_rows := matrix_rows || jsonb_build_array(jsonb_build_object(
      'competency', competency, 'evidence', evidence, 'method', method_code,
      'justification', justification, 'criteria', criteria, 'limits', conclusion_limits));
  end loop;
  if strict then
    if goal = '' then raise exception 'method_profile_incomplete:goal' using errcode = '22023'; end if;
    if outcome = '' then raise exception 'method_profile_incomplete:expectedOutcome' using errcode = '22023'; end if;
    if profile_limits = '' then raise exception 'method_profile_incomplete:constraints' using errcode = '22023'; end if;
    if level_code = '' then raise exception 'method_profile_incomplete:responsibilityLevel' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct lower(btrim(c))), array[]::text[]) into required
      from unnest(coalesce(competencies, array[]::text[])) c where btrim(c) <> '';
    if cardinality(required) = 0 then
      raise exception 'method_profile_incomplete:position.competencies' using errcode = '22023';
    end if;
    if jsonb_array_length(matrix_rows) = 0 or not (required <@ seen) then
      raise exception 'method_profile_incomplete:matrix.coverage' using errcode = '22023';
    end if;
    if not (seen <@ required) then
      raise exception 'method_profile_incomplete:matrix.unknown' using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object('goal', goal, 'expectedOutcome', outcome, 'constraints', profile_limits,
    'responsibilityLevel', level_code, 'matrix', matrix_rows);
end;
$$;

-- Wspólne sprawdzenie zapisu: zalogowany właściciel lub rekruter tej firmy
-- i stanowisko tej samej firmy. Zwraca wiersz stanowiska z blokadą FOR SHARE.
create function method.require_writer(target_company uuid, target_position uuid) returns public.positions
language plpgsql security definer set search_path = '' as $$
declare p public.positions;
begin
  if (select auth.uid()) is null or target_company is null or target_position is null
     or not private.has_company_access(target_company, true) then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  select * into p from public.positions x
   where x.company_id = target_company and x.id = target_position for share;
  if not found then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  if p.status = 'archived' then
    raise exception 'method_position_archived' using errcode = '55000';
  end if;
  return p;
end;
$$;

revoke all on function method.purge_allowed(uuid), method.guard_version(), method.guard_binding(),
  method.clean_text(jsonb, integer), method.normalize_content(jsonb, boolean, text[]),
  method.require_writer(uuid, uuid) from public;

-- Zapis szkicu. expected_revision = 0, gdy szkicu jeszcze nie ma; w przeciwnym
-- razie numer zapisu, który rekruter widział. Niezgodność = PT409, bez zapisu.
create function public.method_profile_save_draft(target_company uuid, target_position uuid,
  draft_content jsonb, expected_revision integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); canonical jsonb; d method.profile_versions; saved integer;
begin
  perform method.require_writer(target_company, target_position);
  if expected_revision is null or expected_revision < 0 then
    raise exception 'method_profile_invalid' using errcode = '22023';
  end if;
  canonical := method.normalize_content(draft_content, false, null);
  perform pg_advisory_xact_lock(hashtextextended('sc-method:' || target_position::text, 0));
  select * into d from method.profile_versions v
   where v.company_id = target_company and v.position_id = target_position and v.status = 'draft' for update;
  if coalesce(d.revision, 0) <> expected_revision then
    raise exception 'method_draft_changed' using errcode = 'PT409';
  end if;
  if d.id is null then
    insert into method.profile_versions (company_id, position_id, status, content, created_by, updated_by)
      values (target_company, target_position, 'draft', canonical, actor, actor)
      returning revision into saved;
  else
    update method.profile_versions
       set content = canonical, revision = d.revision + 1, updated_by = actor, updated_at = clock_timestamp()
     where id = d.id
     returning revision into saved;
  end if;
  return saved;
end;
$$;

-- Zatwierdzenie bieżącego szkicu: pełna walidacja względem aktualnego profilu
-- stanowiska, numer wersji, odcisk treści, kopia profilu stanowiska.
create function public.method_profile_approve(target_company uuid, target_position uuid, expected_revision integer)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); p public.positions; d method.profile_versions;
  canonical jsonb; snapshot jsonb; next_no integer;
begin
  p := method.require_writer(target_company, target_position);
  perform pg_advisory_xact_lock(hashtextextended('sc-method:' || target_position::text, 0));
  select * into d from method.profile_versions v
   where v.company_id = target_company and v.position_id = target_position and v.status = 'draft' for update;
  if d.id is null or expected_revision is null or d.revision <> expected_revision then
    raise exception 'method_draft_changed' using errcode = 'PT409';
  end if;
  canonical := method.normalize_content(d.content, true, p.required_competencies);
  snapshot := jsonb_build_object('title', p.title, 'description', p.description, 'tasks', p.tasks,
    'kpis', p.kpis, 'autonomy_level', p.autonomy_level, 'required_competencies', p.required_competencies,
    'position_updated_at', p.updated_at);
  select coalesce(max(v.version_no), 0) + 1 into next_no from method.profile_versions v
   where v.company_id = target_company and v.position_id = target_position;
  update method.profile_versions
     set status = 'approved', version_no = next_no, content = canonical, position_snapshot = snapshot,
         content_hash = encode(sha256(convert_to(
           jsonb_build_object('content', canonical, 'position', snapshot)::text, 'UTF8')), 'hex'),
         approved_by = actor, approved_at = clock_timestamp(), updated_by = actor, updated_at = clock_timestamp()
   where id = d.id;
  return d.id;
end;
$$;

-- Stan dla panelu: aktualna zatwierdzona wersja, historia i (tylko dla osób
-- z prawem zapisu) szkic.
create function public.method_profile_state(target_company uuid, target_position uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare writer boolean;
begin
  if (select auth.uid()) is null or target_company is null or target_position is null
     or not private.has_company_access(target_company) then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.positions p where p.company_id = target_company and p.id = target_position) then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  writer := private.has_company_access(target_company, true);
  return jsonb_build_object(
    'can_edit', writer,
    'draft', case when writer then (
      select jsonb_build_object('id', d.id, 'revision', d.revision, 'content', d.content, 'updated_at', d.updated_at)
        from method.profile_versions d
       where d.company_id = target_company and d.position_id = target_position and d.status = 'draft') end,
    'approved', (
      select jsonb_build_object('id', v.id, 'version_no', v.version_no, 'content', v.content,
               'position_snapshot', v.position_snapshot, 'content_hash', v.content_hash, 'approved_at', v.approved_at)
        from method.profile_versions v
       where v.company_id = target_company and v.position_id = target_position and v.status = 'approved'
       order by v.version_no desc limit 1),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('id', h.id, 'version_no', h.version_no, 'approved_at', h.approved_at,
               'content_hash', h.content_hash, 'responsibility_level', h.content ->> 'responsibilityLevel')
               order by h.version_no desc)
        from (select * from method.profile_versions v
               where v.company_id = target_company and v.position_id = target_position and v.status = 'approved'
               order by v.version_no desc limit 50) h), '[]'::jsonb));
end;
$$;

-- Jedna zatwierdzona wersja (podgląd z historii). Null, gdy nie ma takiej w tej firmie.
create function public.method_profile_version(target_company uuid, target_version uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or target_company is null or not private.has_company_access(target_company) then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('id', v.id, 'position_id', v.position_id, 'version_no', v.version_no, 'content', v.content,
             'position_snapshot', v.position_snapshot, 'content_hash', v.content_hash, 'approved_at', v.approved_at)
      from method.profile_versions v
     where v.company_id = target_company and v.id = target_version and v.status = 'approved');
end;
$$;

-- Wiąże wersję definicji zadania z wersją metody obowiązującą w chwili
-- utworzenia definicji. Idempotentne; istniejącego powiązania nie zmienia.
-- Zwraca id wersji metody albo null, gdy stanowisko nie miało wtedy
-- zatwierdzonej metody (wtedy nic nie jest zapisywane).
create function public.method_bind_definition(target_company uuid, target_definition uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); entry public.exercise_definition_entries;
  existing uuid; chosen method.profile_versions;
begin
  if actor is null or target_company is null or target_definition is null
     or not private.has_company_access(target_company, true) then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  select * into entry from public.exercise_definition_entries e
   where e.company_id = target_company and e.id = target_definition;
  if not found then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sc-method:' || entry.position_id::text, 0));
  select b.method_version_id into existing from method.definition_bindings b
   where b.definition_entry_id = entry.id and b.company_id = target_company;
  if existing is not null then
    return existing;
  end if;
  select * into chosen from method.profile_versions v
   where v.company_id = target_company and v.position_id = entry.position_id
     and v.status = 'approved' and v.approved_at <= entry.created_at
   order by v.version_no desc limit 1;
  if chosen.id is null then
    return null;
  end if;
  insert into method.definition_bindings (definition_entry_id, company_id, position_id, method_version_id, content_hash, bound_by)
    values (entry.id, target_company, entry.position_id, chosen.id, chosen.content_hash, actor);
  return chosen.id;
end;
$$;

-- Odczyt powiązania: dokładna wersja metody, z którą powstała definicja zadania.
create function public.method_definition_binding(target_company uuid, target_definition uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or target_company is null or not private.has_company_access(target_company) then
    raise exception 'method_forbidden' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('definition_entry_id', b.definition_entry_id, 'method_version_id', v.id,
             'version_no', v.version_no, 'content_hash', b.content_hash, 'content', v.content,
             'position_snapshot', v.position_snapshot, 'approved_at', v.approved_at, 'bound_at', b.bound_at)
      from method.definition_bindings b
      join method.profile_versions v on v.company_id = b.company_id and v.id = b.method_version_id
     where b.company_id = target_company and b.definition_entry_id = target_definition);
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.method_profile_save_draft(uuid,uuid,jsonb,integer)',
    'public.method_profile_approve(uuid,uuid,integer)',
    'public.method_profile_state(uuid,uuid)',
    'public.method_profile_version(uuid,uuid)',
    'public.method_bind_definition(uuid,uuid)',
    'public.method_definition_binding(uuid,uuid)'] loop
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
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc_method_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'method' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'sc_method_rls_missing' using errcode = '55000';
  end if;
end
$postflight$;

commit;
