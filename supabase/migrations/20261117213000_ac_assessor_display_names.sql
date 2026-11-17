-- R3-AC-NAMES — asesorzy sesji Assessment Center pokazani z nazwy (docs/ROADMAP.md, R3; issue #338).
--
-- PR #500 zastąpił identyfikator konta etykietą („Ty”, „Właściciel firmy”, „Członek zespołu N”).
-- Ta migracja dokłada jedną funkcję odczytu, żeby strona sesji i plik CSV mogły pokazać,
-- KTO ocenia:
--  * public.ac_assessor_display_names(firma, rekrutacja) -> (user_id, display_name).
--
-- Co jest nazwą: adres e-mail konta. Aplikacja nie ma pola imienia i nazwiska, a
-- `raw_user_meta_data` użytkownik może sam zmienić bez potwierdzenia (członek mógłby się
-- podpisać cudzym imieniem). Adres e-mail konta zmienia się tylko po potwierdzeniu, więc
-- nie da się nim podszyć pod innego członka zespołu. Nic innego z auth.users nie wychodzi.
--
-- Kontrola dostępu w bazie (ta sama co ac_session_read i eksport CSV sesji):
--  * zalogowany właściciel firmy albo rekruter (private.has_company_access(..., true));
--    czytelnik (viewer), osoba spoza firmy i anonim dostają 42501;
--  * rekrutacja musi należeć do podanej firmy. Obca firma, obca rekrutacja i rekrutacja
--    nieistniejąca dają ten sam błąd 42501 (bez zdradzania, czy rekord istnieje).
-- Zwracane są wyłącznie osoby z dostępem do sesji AC tej firmy: właściciel firmy i obecni
-- członkowie z rolą `recruiter`. Członek usunięty z zespołu, czytelnik i członkowie innych
-- firm nie są zwracani — aplikacja pokazuje dla nich dotychczasową etykietę z PR #500.
--
-- Sygnatura SC-010: nie dochodzi żadna relacja, tylko jedna funkcja w 'public'.
-- Preflight zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
begin;

do $preflight$
begin
  if to_regprocedure('public.ac_assessor_display_names(uuid,uuid)') is not null then
    raise exception 'ac_assessor_names_already_installed' using errcode = '55000';
  end if;
  if to_regclass('auth.users') is null or to_regclass('public.companies') is null
     or to_regclass('public.company_members') is null or to_regclass('public.recruitments') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'ac_assessor_names_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('ac_assessor_names.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create function public.ac_assessor_display_names(target_company uuid, target_recruitment uuid)
returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null or target_company is null or target_recruitment is null
     or not private.has_company_access(target_company, true) then
    raise exception 'ac_assessor_names_forbidden' using errcode = '42501';
  end if;
  perform 1 from public.recruitments r where r.id = target_recruitment and r.company_id = target_company;
  if not found then
    raise exception 'ac_assessor_names_forbidden' using errcode = '42501';
  end if;
  -- Tylko kolumna email (odczyt przez to_jsonb, jak w cv_bulk_intake); żadnych metadanych.
  return query
    select a.id, left(btrim(to_jsonb(u) ->> 'email'), 320)
      from (select c.owner_id as id from public.companies c where c.id = target_company
            union
            select m.user_id from public.company_members m
             where m.company_id = target_company and m.role = 'recruiter') a
      join auth.users u on u.id = a.id
     where nullif(btrim(to_jsonb(u) ->> 'email'), '') is not null;
end;
$$;

-- Usuń domyślne uprawnienia (także wrogie domyślne dla ról spoza aplikacji).
do $acl$ declare o record; g record; begin
  for o in select oid, proowner from pg_proc where oid = 'public.ac_assessor_display_names(uuid,uuid)'::regprocedure loop
    execute format('revoke all on function %s from public', o.oid::regprocedure);
    for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
      join pg_roles r on r.oid = a.grantee where p.oid = o.oid and a.grantee <> o.proowner loop
      execute format('revoke all on function %s from %I', o.oid::regprocedure, g.rolname);
    end loop;
  end loop;
end $acl$;
grant execute on function public.ac_assessor_display_names(uuid,uuid) to authenticated;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('ac_assessor_names.signature_before', true) then
    raise exception 'ac_assessor_names_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.ac_assessor_display_names(uuid,uuid)'::regprocedure
      and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
      and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'ac_assessor_names_acl_mismatch' using errcode = '55000';
  end if;
end
$postflight$;
commit;
