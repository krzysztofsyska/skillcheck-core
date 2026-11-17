-- SC-015-D3 — historia eksportów raportów kandydatów na poziomie całej firmy.
--
-- SC-015-D (20261116120000_sc015d_candidate_report_export_audit.sql) zapisuje
-- każde pobranie CSV w `report_audit.candidate_report_exports`, a SC-015-D2
-- (20261116210000_sc015d2_candidate_report_export_history.sql) pokazuje historię
-- jednego zgłoszenia na ekranie raportu. Ta migracja dodaje drugą, wyłącznie
-- odczytową drogę: `public.list_company_report_exports(...)` — wszystkie eksporty
-- raportów w firmie, dla właściciela konta firmy.
--
-- Kontrola dostępu liczona w bazie:
--  * tylko zalogowany WŁAŚCICIEL firmy (private.is_company_owner, ten sam
--    warunek co companies.owner_id = auth.uid()); rekruter i czytelnik widzą
--    historię pojedynczego raportu (SC-015-D2), ale nie przegląd całej firmy;
--  * rekruter, czytelnik, osoba spoza firmy, obca firma i nieistniejąca firma
--    dostają ten sam błąd 42501 — odpowiedź nie zdradza, czy firma istnieje.
--
-- Co zwraca (domyślnie 100, najwyżej 200 wpisów, najnowsze pierwsze):
--  * export_id — identyfikator wpisu dziennika (tylko do stronicowania);
--  * exported_at, actor_id, actor_role, is_me — jak w SC-015-D2;
--  * recruitment_id, application_id — do odnośników do raportu.
-- Bez adresów e-mail, bez danych kandydata, bez treści raportu.
--
-- Stronicowanie: (before_at, before_id) z ostatniego wpisu poprzedniej strony;
-- porządek (created_at desc, id desc) jest całkowity, więc wpisy o tym samym
-- czasie nie giną między stronami. Podanie tylko jednego z pary = 22023.
--
-- Nie zmienia tabeli dziennika, jej indeksów ani funkcji zapisu/odczytu z D i D2.
-- Dostęp do schematu `report_audit` dla ról API pozostaje zamknięty.
--
-- Sygnatura SC-010: migracja dodaje tylko funkcję w 'public'; preflight
-- zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
begin;

do $preflight$
begin
  if to_regprocedure('public.list_company_report_exports(uuid,integer,timestamptz,uuid)') is not null then
    raise exception 'sc015d3_already_installed' using errcode = '55000';
  end if;
  if to_regclass('report_audit.candidate_report_exports') is null
     or to_regprocedure('public.list_candidate_report_exports(uuid,uuid,uuid)') is null
     or to_regprocedure('private.is_company_owner(uuid)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'sc015d3_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('sc015d3.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create function public.list_company_report_exports(
  target_company uuid,
  row_limit integer default 100,
  before_at timestamptz default null,
  before_id uuid default null
) returns table (
  export_id uuid, exported_at timestamptz, actor_id uuid, actor_role text, is_me boolean,
  recruitment_id uuid, application_id uuid
)
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  effective_limit integer := least(greatest(coalesce(row_limit, 100), 1), 200);
begin
  if actor is null or target_company is null or not private.is_company_owner(target_company) then
    raise exception 'company_report_exports_forbidden' using errcode = '42501';
  end if;
  if (before_at is null) <> (before_id is null) then
    raise exception 'company_report_exports_invalid' using errcode = '22023';
  end if;
  return query
    select e.id,
           e.created_at,
           e.actor_id,
           case when c.owner_id = e.actor_id then 'owner'
                when m.role in ('recruiter', 'viewer') then m.role
                else 'former_member' end,
           e.actor_id = actor,
           e.recruitment_id,
           e.application_id
      from report_audit.candidate_report_exports e
      join public.companies c on c.id = e.company_id
      left join public.company_members m on m.company_id = e.company_id and m.user_id = e.actor_id
     where e.company_id = target_company
       and (before_at is null or (e.created_at, e.id) < (before_at, before_id))
     order by e.created_at desc, e.id desc
     limit effective_limit;
end;
$$;

do $grants$
declare fn text := 'public.list_company_report_exports(uuid,integer,timestamptz,uuid)';
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
  if private.erasure_schema_signature() is distinct from current_setting('sc015d3.signature_before', true) then
    raise exception 'sc015d3_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if has_schema_privilege('authenticated', 'report_audit', 'USAGE')
     or has_schema_privilege('anon', 'report_audit', 'USAGE') then
    raise exception 'sc015d3_report_audit_exposed' using errcode = '55000';
  end if;
end
$postflight$;

commit;
