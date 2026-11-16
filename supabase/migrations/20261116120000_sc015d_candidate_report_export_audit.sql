-- SC-015-D — eksport CSV raportu kandydata i audyt dostępu do jego danych.
--
-- Co dochodzi:
--  * `report_audit.candidate_report_exports` — wyłącznie dopisywany dziennik:
--    kto (auth.uid()), kiedy, której firmy / rekrutacji / zgłoszenia dotyczył
--    eksport i jakiego rodzaju był. Bez nazwiska, bez treści CV, bez treści
--    raportu — same identyfikatory, rodzaj i numer wersji analizy.
--  * `public.record_candidate_report_export(...)` — jedyna droga zapisu
--    (security definer). Eksport w aplikacji (lib/candidate-report-export.ts)
--    oddaje plik dopiero po udanym zapisie; błąd zapisu = brak pliku.
--
-- Funkcja jest też ostatnią kontrolą dostępu tuż przed wydaniem pliku, liczoną
-- w bazie, a nie z sesji widoku:
--  * zalogowany członek tej firmy (private.has_company_access — także czytelnik,
--    bo czytelnik widzi ten raport na ekranie);
--  * zgłoszenie istnieje pod tą firmą i tą rekrutacją;
--  * dane kandydata nie są zamrożone ani w trakcie usuwania po wycofaniu zgody
--    (private.candidate_workflow_visible — ten sam warunek, który osłania
--    odczyt raportu przez RLS, erasure_read_guard);
--  * zgłoszenie nie jest wycofane (applications.status = 'withdrawn').
-- Obca firma, obca rekrutacja i nieistniejące zgłoszenie dają ten sam błąd
-- 42501 — odpowiedź nie zdradza, czy rekord innej firmy istnieje.
--
-- Dlaczego osobny schemat `report_audit`, a nie public/private (wzorzec
-- z 20261112140000_sc_process_diagnostics.sql i 20261104120000_position_requirement_flags.sql):
-- private.erasure_schema_signature() obejmuje relacje w 'public' i 'private' oraz
-- więzy, które się do nich odwołują, i jest przypięta do inwentarza usuwania
-- danych kandydatów (SC-010). Nowa relacja tam blokowałaby każdy podgląd
-- i każde usunięcie danych kandydata. Dziennik nie ma kluczy obcych do public.*;
-- spójność sprawdza funkcja zapisu. Migracja dodaje w 'public' tylko funkcję.
--
-- Sygnatura SC-010: migracja nie przypina konkretnej wartości. Zapamiętuje
-- wartość z preflight i w postflight wymaga, żeby była identyczna.
--
-- Dostęp: schemat `report_audit` nie jest widoczny dla anon/authenticated; RLS
-- włączone bez polityk. Odczyt dziennika nie jest wystawiony przez API (na razie
-- tylko dla operatora bazy); zapis wyłącznie przez funkcję poniżej.
--
-- Usuwanie: dziennik jest niezmienny. Jedyny wyjątek to przyszła, uprzywilejowana
-- procedura usuwania firmy, która w tej samej transakcji ustawi
-- set_config('report_audit.purge_company', '<uuid firmy>', true).
begin;

do $preflight$
begin
  if to_regnamespace('report_audit') is not null then
    raise exception 'sc015d_already_installed' using errcode = '55000';
  end if;
  if to_regclass('public.applications') is null or to_regclass('public.recruitments') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.candidate_workflow_visible(uuid,uuid)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'sc015d_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('sc015d.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create schema report_audit;
revoke all on schema report_audit from public;
-- Bez `grant usage`: do tabeli nie sięga żadna rola aplikacji bezpośrednio.

create table report_audit.candidate_report_exports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  actor_id uuid not null,
  export_kind text not null check (export_kind in ('candidate_report_csv')),
  -- Wersja analizy CV widoczna w pliku; null, gdy analizy jeszcze nie było.
  analysis_version integer check (analysis_version is null or analysis_version between 1 and 1000000),
  created_at timestamptz not null default clock_timestamp()
);
create index candidate_report_exports_application
  on report_audit.candidate_report_exports (company_id, application_id, created_at);

alter table report_audit.candidate_report_exports enable row level security;
revoke all on report_audit.candidate_report_exports from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on report_audit.candidate_report_exports from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on report_audit.candidate_report_exports from authenticated;
  end if;
end
$revoke$;

create function report_audit.purge_allowed(target_company uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('report_audit.purge_company', true), '') = target_company::text
$$;

create function report_audit.guard_entry() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and report_audit.purge_allowed(old.company_id) then
    return old;
  end if;
  raise exception 'report_audit_immutable' using errcode = '42501';
end;
$$;
create trigger guard_entries before update or delete on report_audit.candidate_report_exports
  for each row execute function report_audit.guard_entry();

create function report_audit.guard_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'report_audit_immutable' using errcode = '42501';
end;
$$;
create trigger guard_truncate before truncate on report_audit.candidate_report_exports
  for each statement execute function report_audit.guard_truncate();

revoke all on function report_audit.purge_allowed(uuid), report_audit.guard_entry(),
  report_audit.guard_truncate() from public;

create function public.record_candidate_report_export(
  target_company uuid,
  target_recruitment uuid,
  target_application uuid,
  export_kind text,
  analysis_version integer default null
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  subject uuid;
  application_status text;
  entry uuid;
begin
  if actor is null or target_company is null or target_recruitment is null or target_application is null
     or not private.has_company_access(target_company) then
    raise exception 'candidate_report_forbidden' using errcode = '42501';
  end if;
  if export_kind is distinct from 'candidate_report_csv' then
    raise exception 'candidate_report_export_invalid' using errcode = '22023';
  end if;
  if analysis_version is not null and analysis_version not between 1 and 1000000 then
    raise exception 'candidate_report_export_invalid' using errcode = '22023';
  end if;
  -- Blokada współdzielona: równoległa zmiana statusu zgłoszenia czeka na koniec zapisu.
  select a.candidate_id, a.status into subject, application_status
    from public.applications a
    join public.recruitments r on r.id = a.recruitment_id and r.company_id = a.company_id
   where a.company_id = target_company and a.recruitment_id = target_recruitment and a.id = target_application
   for share of a;
  if not found then
    raise exception 'candidate_report_forbidden' using errcode = '42501';
  end if;
  if not private.candidate_workflow_visible(target_company, subject) or application_status = 'withdrawn' then
    raise exception 'candidate_report_withdrawn' using errcode = '55000';
  end if;
  insert into report_audit.candidate_report_exports
    (company_id, recruitment_id, application_id, actor_id, export_kind, analysis_version)
  values (target_company, target_recruitment, target_application, actor, export_kind, analysis_version)
  returning id into entry;
  return entry;
end;
$$;

do $grants$
declare fn text := 'public.record_candidate_report_export(uuid,uuid,uuid,text,integer)';
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
  if private.erasure_schema_signature() is distinct from current_setting('sc015d.signature_before', true) then
    raise exception 'sc015d_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'report_audit' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'sc015d_rls_missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_constraint k
              join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
             where n.nspname = 'report_audit' and fn.nspname <> 'report_audit') then
    raise exception 'sc015d_foreign_key_outside_schema' using errcode = '55000';
  end if;
end
$postflight$;

commit;
