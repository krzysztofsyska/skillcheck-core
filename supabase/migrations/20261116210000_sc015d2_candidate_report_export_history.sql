-- SC-015-D2 — historia eksportu raportu kandydata widoczna na ekranie raportu.
--
-- SC-015-D (20261116120000_sc015d_candidate_report_export_audit.sql) zapisuje
-- każde pobranie CSV w `report_audit.candidate_report_exports`, ale żaden ekran
-- ani API tego dziennika nie czytał. Ta migracja dodaje jedyną drogę odczytu:
-- `public.list_candidate_report_exports(...)` (security definer, tylko odczyt).
--
-- Kontrola dostępu liczona w bazie, tak samo jak przy zapisie:
--  * zalogowany członek tej firmy (private.has_company_access — także czytelnik,
--    bo czytelnik widzi raport i może go pobrać);
--  * zgłoszenie istnieje pod tą firmą i tą rekrutacją;
--  * obca firma, obca rekrutacja i nieistniejące zgłoszenie dają ten sam błąd
--    42501 — odpowiedź nie zdradza, czy rekord innej firmy istnieje.
--
-- Co zwraca (najwyżej 50 wpisów, najnowsze pierwsze):
--  * exported_at — kiedy;
--  * actor_id — kto (identyfikator konta; członkowie firmy i tak widzą
--    identyfikatory członków w public.company_members przez RLS);
--  * actor_role — 'owner' / 'recruiter' / 'viewer' według bieżącego stanu firmy
--    (companies.owner_id i company_members.role, które członek firmy już widzi
--    przez RLS) albo 'former_member', gdy osoby nie ma już w zespole;
--  * is_me — czy to bieżący użytkownik.
-- Bez adresów e-mail (schemat nie udostępnia ich członkom firmy), bez danych
-- kandydata, bez treści raportu.
--
-- Nie zmienia tabeli dziennika ani funkcji zapisu. Dostęp do schematu
-- `report_audit` dla ról API pozostaje zamknięty; czyta wyłącznie ta funkcja.
-- Wycofanie zgłoszenia nie ukrywa historii: to zapis dostępu do danych, który
-- ma zostać widoczny dla firmy, i nie zawiera danych kandydata.
--
-- Sygnatura SC-010: migracja dodaje tylko funkcję w 'public'; preflight
-- zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
begin;

do $preflight$
begin
  if to_regprocedure('public.list_candidate_report_exports(uuid,uuid,uuid)') is not null then
    raise exception 'sc015d2_already_installed' using errcode = '55000';
  end if;
  if to_regclass('report_audit.candidate_report_exports') is null
     or to_regprocedure('public.record_candidate_report_export(uuid,uuid,uuid,text,integer)') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'sc015d2_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('sc015d2.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create function public.list_candidate_report_exports(
  target_company uuid,
  target_recruitment uuid,
  target_application uuid
) returns table (exported_at timestamptz, actor_id uuid, actor_role text, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null or target_company is null or target_recruitment is null or target_application is null
     or not private.has_company_access(target_company) then
    raise exception 'candidate_report_forbidden' using errcode = '42501';
  end if;
  perform 1
    from public.applications a
    join public.recruitments r on r.id = a.recruitment_id and r.company_id = a.company_id
   where a.company_id = target_company and a.recruitment_id = target_recruitment and a.id = target_application;
  if not found then
    raise exception 'candidate_report_forbidden' using errcode = '42501';
  end if;
  return query
    select e.created_at,
           e.actor_id,
           case when c.owner_id = e.actor_id then 'owner'
                when m.role in ('recruiter', 'viewer') then m.role
                else 'former_member' end,
           e.actor_id = actor
      from report_audit.candidate_report_exports e
      join public.companies c on c.id = e.company_id
      left join public.company_members m on m.company_id = e.company_id and m.user_id = e.actor_id
     where e.company_id = target_company
       and e.recruitment_id = target_recruitment
       and e.application_id = target_application
     order by e.created_at desc, e.id desc
     limit 50;
end;
$$;

do $grants$
declare fn text := 'public.list_candidate_report_exports(uuid,uuid,uuid)';
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
  if private.erasure_schema_signature() is distinct from current_setting('sc015d2.signature_before', true) then
    raise exception 'sc015d2_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if has_schema_privilege('authenticated', 'report_audit', 'USAGE')
     or has_schema_privilege('anon', 'report_audit', 'USAGE') then
    raise exception 'sc015d2_report_audit_exposed' using errcode = '55000';
  end if;
end
$postflight$;

commit;
