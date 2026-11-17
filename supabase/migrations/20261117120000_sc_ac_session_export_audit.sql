-- SC-AC-EXPORT-AUDIT — dziennik pobrań CSV podsumowania sesji Assessment Center.
--
-- Eksport z PR #480 (lib/assessment-center-session-export.ts) wydaje plik z ocenami
-- finalistów. Ta migracja dokłada do niego ten sam wzorzec co SC-015-D
-- (20261116120000_sc015d_candidate_report_export_audit.sql): każde pobranie jest
-- zapisane w bazie, zanim plik zostanie wydany; błąd zapisu = brak pliku.
--
-- Co dochodzi:
--  * `report_audit.assessment_center_session_exports` — wyłącznie dopisywany dziennik
--    w istniejącym schemacie SC-015-D: kto (auth.uid()) w jakiej roli (owner /
--    recruiter), kiedy, której firmy / rekrutacji / sesji dotyczył eksport. Bez nazwisk,
--    bez ocen, bez treści sesji — same identyfikatory, rodzaj i rola.
--  * `public.record_assessment_center_session_export(...)` — jedyna droga zapisu
--    (security definer).
--
-- Dlaczego osobna tabela, a nie wiersz w `report_audit.candidate_report_exports`:
-- tamta tabela ma `application_id not null` i więz `export_kind in ('candidate_report_csv')`,
-- a jej wpisy czytają funkcje SC-015-D2/D3 (historia raportu kandydata i przegląd firmy
-- z odnośnikami do zgłoszeń). Eksport sesji nie dotyczy jednego zgłoszenia; dopisanie
-- go tam wymagałoby zmiany więzów istniejącego dziennika i obu funkcji odczytu.
-- Osobna tabela w tym samym, zamkniętym schemacie niczego z SC-015-D nie zmienia.
--
-- Kontrola dostępu liczona w bazie tuż przed wydaniem pliku (ta sama co strona sesji
-- i RPC ac_session_find / ac_session_read):
--  * zalogowany właściciel firmy albo rekruter (private.has_company_access(..., true));
--    czytelnik nie widzi strony sesji, więc nie zapisze eksportu;
--  * sesja istnieje pod tą firmą i tą rekrutacją, a rekrutacja należy do tej firmy.
-- Obca firma, obca rekrutacja, obca i nieistniejąca sesja dają ten sam błąd 42501.
--
-- Sygnatura SC-010: nowa tabela jest poza 'public'/'private', w 'public' dochodzi tylko
-- funkcja. Preflight zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
--
-- Usuwanie: dziennik jest niezmienny — te same wyzwalacze co w SC-015-D
-- (report_audit.guard_entry / guard_truncate; wyjątek wyłącznie dla przyszłej procedury
-- usuwania firmy przez set_config('report_audit.purge_company', ...)).
begin;

do $preflight$
begin
  if to_regclass('report_audit.assessment_center_session_exports') is not null
     or to_regprocedure('public.record_assessment_center_session_export(uuid,uuid,uuid,text)') is not null then
    raise exception 'sc_ac_export_audit_already_installed' using errcode = '55000';
  end if;
  if to_regnamespace('report_audit') is null
     or to_regprocedure('report_audit.guard_entry()') is null
     or to_regprocedure('report_audit.guard_truncate()') is null
     or to_regclass('private.ac_sessions') is null or to_regclass('public.recruitments') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.is_company_owner(uuid)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'sc_ac_export_audit_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('sc_ac_export_audit.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create table report_audit.assessment_center_session_exports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  session_id uuid not null,
  actor_id uuid not null,
  actor_role text not null check (actor_role in ('owner', 'recruiter')),
  export_kind text not null check (export_kind in ('ac_session_csv')),
  created_at timestamptz not null default clock_timestamp()
);
create index assessment_center_session_exports_recruitment
  on report_audit.assessment_center_session_exports (company_id, recruitment_id, created_at);

alter table report_audit.assessment_center_session_exports enable row level security;
revoke all on report_audit.assessment_center_session_exports from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on report_audit.assessment_center_session_exports from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on report_audit.assessment_center_session_exports from authenticated;
  end if;
end
$revoke$;

create trigger guard_entries before update or delete on report_audit.assessment_center_session_exports
  for each row execute function report_audit.guard_entry();
create trigger guard_truncate before truncate on report_audit.assessment_center_session_exports
  for each statement execute function report_audit.guard_truncate();

create function public.record_assessment_center_session_export(
  target_company uuid,
  target_recruitment uuid,
  target_session uuid,
  export_kind text
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  role_at_export text;
  entry uuid;
begin
  if actor is null or target_company is null or target_recruitment is null or target_session is null
     or not private.has_company_access(target_company, true) then
    raise exception 'ac_session_export_forbidden' using errcode = '42501';
  end if;
  if export_kind is distinct from 'ac_session_csv' then
    raise exception 'ac_session_export_invalid' using errcode = '22023';
  end if;
  perform 1
    from private.ac_sessions s
    join public.recruitments r on r.id = s.recruitment_id and r.company_id = s.company_id
   where s.id = target_session and s.company_id = target_company and s.recruitment_id = target_recruitment;
  if not found then
    raise exception 'ac_session_export_forbidden' using errcode = '42501';
  end if;
  role_at_export := case when private.is_company_owner(target_company) then 'owner' else 'recruiter' end;
  insert into report_audit.assessment_center_session_exports
    (company_id, recruitment_id, session_id, actor_id, actor_role, export_kind)
  values (target_company, target_recruitment, target_session, actor, role_at_export, export_kind)
  returning id into entry;
  return entry;
end;
$$;

do $grants$
declare fn text := 'public.record_assessment_center_session_export(uuid,uuid,uuid,text)';
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
  if private.erasure_schema_signature() is distinct from current_setting('sc_ac_export_audit.signature_before', true) then
    raise exception 'sc_ac_export_audit_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'report_audit' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'sc_ac_export_audit_rls_missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_constraint k
              join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
             where n.nspname = 'report_audit' and fn.nspname <> 'report_audit') then
    raise exception 'sc_ac_export_audit_foreign_key_outside_schema' using errcode = '55000';
  end if;
  if exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated')
              and has_schema_privilege(r.oid, 'report_audit', 'USAGE')) then
    raise exception 'sc_ac_export_audit_schema_exposed' using errcode = '55000';
  end if;
end
$postflight$;

commit;
