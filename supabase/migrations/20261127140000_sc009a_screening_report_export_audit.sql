-- R0 SC-009a — wpis w rejestrze pobrań przy eksporcie CSV raportu preselekcji.
--
-- Luka (znaleziona przez tests/sc009-preselection-report-database.test.mjs, PR #623):
-- pobranie CSV raportu kandydata zapisuje wpis w `report_audit.candidate_report_exports`
-- (SC-015-D, 20261116120000), a pobranie CSV raportu preselekcji całej rekrutacji
-- (lib/screening-report-export.ts) nie zapisywało nic. Ta migracja dokłada do niego
-- ten sam wzorzec: każde pobranie jest zapisane w bazie, zanim plik zostanie wydany;
-- błąd zapisu = brak pliku.
--
-- Co dochodzi:
--  * `report_audit.screening_report_exports` — wyłącznie dopisywany dziennik w
--    istniejącym, zamkniętym schemacie SC-015-D: kto (auth.uid()) w jakiej roli
--    (owner / recruiter / viewer), kiedy, której firmy i rekrutacji dotyczył eksport,
--    jakiego rodzaju i z jakim rozmiarem shortlisty (5–10). Bez nazwisk, bez treści CV,
--    bez treści raportu i bez identyfikatorów zgłoszeń czy kandydatów.
--  * `public.record_screening_report_export(...)` — jedyna droga zapisu (security definer).
--
-- Dlaczego osobna tabela, a nie wiersz w `report_audit.candidate_report_exports`:
-- tamta tabela ma `application_id not null` i więz `export_kind in ('candidate_report_csv')`,
-- a jej wpisy czytają funkcje SC-015-D2/D3 (historia raportu kandydata i przegląd firmy
-- z odnośnikami do zgłoszeń) oraz usuwanie danych kandydata z PR #626 (SC-010a-1).
-- Raport preselekcji nie dotyczy jednego zgłoszenia; dopisanie go tam wymagałoby zmiany
-- więzów istniejącego dziennika i trzech funkcji. Osobna tabela niczego z nich nie zmienia
-- (ten sam wybór co 20261117120000_sc_ac_session_export_audit.sql).
--
-- Minimalizacja danych i usuwanie danych kandydata (SC-010): wpis nie zawiera żadnego
-- identyfikatora zgłoszenia ani kandydata, więc nie łączy się z konkretną osobą i nie
-- wymaga usuwania przy wycofaniu zgody (to samo uzasadnienie, które PR #626 podaje dla
-- `report_audit.assessment_center_session_exports`). Usunięcie całej firmy: te same
-- wyzwalacze co w SC-015-D (report_audit.guard_entry / guard_truncate; wyjątek wyłącznie
-- przez set_config('report_audit.purge_company', '<uuid firmy>', true)).
--
-- Kontrola dostępu liczona w bazie tuż przed wydaniem pliku (ten sam zakres co odczyt
-- raportu przez RLS — członek firmy, także czytelnik):
--  * zalogowany członek tej firmy (private.has_company_access);
--  * rekrutacja istnieje pod tą firmą.
-- Obca firma, obca i nieistniejąca rekrutacja dają ten sam błąd 42501 — odpowiedź nie
-- zdradza, czy rekord innej firmy istnieje. Zły rodzaj lub rozmiar = 22023.
--
-- Odczyt dziennika nie jest wystawiony przez API (tylko operator bazy); schemat
-- `report_audit` pozostaje niewidoczny dla anon/authenticated/service_role.
--
-- Sygnatura SC-010: nowa tabela jest poza 'public'/'private', w 'public' dochodzi tylko
-- funkcja. Preflight zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
begin;

do $preflight$
begin
  if to_regclass('report_audit.screening_report_exports') is not null
     or to_regprocedure('public.record_screening_report_export(uuid,uuid,text,integer)') is not null then
    raise exception 'sc009a_already_installed' using errcode = '55000';
  end if;
  if to_regnamespace('report_audit') is null
     or to_regprocedure('report_audit.guard_entry()') is null
     or to_regprocedure('report_audit.guard_truncate()') is null
     or to_regclass('public.recruitments') is null or to_regclass('public.company_members') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.is_company_owner(uuid)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'sc009a_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('sc009a.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create table report_audit.screening_report_exports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  actor_id uuid not null,
  actor_role text not null check (actor_role in ('owner', 'recruiter', 'viewer')),
  export_kind text not null check (export_kind in ('screening_report_csv')),
  target_size integer not null check (target_size between 5 and 10),
  created_at timestamptz not null default clock_timestamp()
);
create index screening_report_exports_recruitment
  on report_audit.screening_report_exports (company_id, recruitment_id, created_at);

alter table report_audit.screening_report_exports enable row level security;
revoke all on report_audit.screening_report_exports from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on report_audit.screening_report_exports from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on report_audit.screening_report_exports from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on report_audit.screening_report_exports from service_role;
  end if;
end
$revoke$;

create trigger guard_entries before update or delete on report_audit.screening_report_exports
  for each row execute function report_audit.guard_entry();
create trigger guard_truncate before truncate on report_audit.screening_report_exports
  for each statement execute function report_audit.guard_truncate();

create function public.record_screening_report_export(
  target_company uuid,
  target_recruitment uuid,
  export_kind text,
  target_size integer
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  role_at_export text;
  entry uuid;
begin
  if actor is null or target_company is null or target_recruitment is null
     or not private.has_company_access(target_company) then
    raise exception 'screening_report_export_forbidden' using errcode = '42501';
  end if;
  if export_kind is distinct from 'screening_report_csv'
     or target_size is null or target_size not between 5 and 10 then
    raise exception 'screening_report_export_invalid' using errcode = '22023';
  end if;
  perform 1 from public.recruitments r where r.id = target_recruitment and r.company_id = target_company;
  if not found then
    raise exception 'screening_report_export_forbidden' using errcode = '42501';
  end if;
  if private.is_company_owner(target_company) then
    role_at_export := 'owner';
  else
    select m.role into role_at_export from public.company_members m
     where m.company_id = target_company and m.user_id = actor;
  end if;
  if role_at_export is null or role_at_export not in ('owner', 'recruiter', 'viewer') then
    raise exception 'screening_report_export_forbidden' using errcode = '42501';
  end if;
  insert into report_audit.screening_report_exports
    (company_id, recruitment_id, actor_id, actor_role, export_kind, target_size)
  values (target_company, target_recruitment, actor, role_at_export, export_kind, target_size)
  returning id into entry;
  return entry;
end;
$$;

do $grants$
declare fn text := 'public.record_screening_report_export(uuid,uuid,text,integer)';
begin
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
end
$grants$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('sc009a.signature_before', true) then
    raise exception 'sc009a_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'report_audit' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'sc009a_rls_missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_constraint k
              join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
             where n.nspname = 'report_audit' and fn.nspname <> 'report_audit') then
    raise exception 'sc009a_foreign_key_outside_schema' using errcode = '55000';
  end if;
  if exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
              and has_schema_privilege(r.oid, 'report_audit', 'USAGE')) then
    raise exception 'sc009a_schema_exposed' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.record_screening_report_export(uuid,uuid,text,integer)'::regprocedure
                  and prosecdef and proconfig = array['search_path=""']) then
    raise exception 'sc009a_function_unsafe' using errcode = '55000';
  end if;
end
$postflight$;

commit;
