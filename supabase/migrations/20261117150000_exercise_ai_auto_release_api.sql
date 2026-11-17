-- R1-SWITCH — przełącznik rekrutera „Zatwierdzam zadania sam" / „Automatycznie" (docs/ROADMAP.md, R1).
--
-- Wybór trybu istnieje w bazie od SC-014-C6 (20261106130000_exercise_ai_proposals.sql):
-- tabela exercise_ai.recruitment_settings i funkcja exercise_ai.set_auto_release.
-- Schemat `exercise_ai` celowo NIE jest wystawiony w Supabase Data API
-- (docs/plan-budowy-2026-11-02.md), więc aplikacja nie mogła ani odczytać, ani zmienić trybu.
-- Ta migracja dokłada dwie cienkie funkcje w `public`, tym samym wzorcem co
-- read_/approve_/reject_/edit_exercise_ai_proposal:
--  * public.read_exercise_ai_settings(firma, rekrutacja) -> boolean (czy tryb automatyczny);
--  * public.set_exercise_ai_auto_release(firma, rekrutacja, włączone) -> boolean.
--
-- Kontrola dostępu w bazie:
--  * zalogowany właściciel firmy albo rekruter (private.has_company_access(..., true));
--    czytelnik (viewer) i kandydat nie mają dostępu ani do odczytu, ani do zmiany;
--  * rekrutacja musi należeć do podanej firmy. Obca firma, obca rekrutacja,
--    rekrutacja nieistniejąca i brak uprawnień dają ten sam błąd 42501;
--  * zmiana trybu w rekrutacji zamkniętej/wstrzymanej albo przy zarchiwizowanym
--    stanowisku jest odrzucana (55000), tak jak odrzucenie i edycja propozycji.
-- Sam zapis robi istniejąca, przypięta funkcja exercise_ai.set_auto_release
-- (zapisuje imiennie, kto i kiedy zmienił tryb). Reguła R1 (test tylko dla kandydata
-- z krótkiej listy) zostaje w bazie bez zmian. Migracja niczego nie wysyła kandydatom.
--
-- Sygnatura SC-010: nie dochodzi żadna relacja, tylko dwie funkcje w 'public'.
-- Preflight zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
begin;

do $preflight$
begin
  if to_regprocedure('public.read_exercise_ai_settings(uuid,uuid)') is not null
     or to_regprocedure('public.set_exercise_ai_auto_release(uuid,uuid,boolean)') is not null then
    raise exception 'r1_switch_already_installed' using errcode = '55000';
  end if;
  if to_regclass('exercise_ai.recruitment_settings') is null
     or to_regclass('public.recruitments') is null or to_regclass('public.positions') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'r1_switch_dependency_missing' using errcode = '55000';
  end if;
  -- Zapis deleguje do przejrzanej wersji exercise_ai.set_auto_release (PR #291).
  if not exists (select 1 from pg_proc
      where oid = to_regprocedure('exercise_ai.set_auto_release(uuid,boolean)')
        and encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = '1f0f4ace93ff85c81a7f2e11ce9dcd0802afe2532ba0a2bd3784737bd7ab016d'
        and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
        and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'r1_switch_dependency_unreviewed:exercise_ai.set_auto_release(uuid,boolean)' using errcode = '55000';
  end if;
  perform set_config('r1_switch.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

-- Brak wiersza ustawień znaczy tryb ręczny (bezpieczniejszy stan domyślny).
create function public.read_exercise_ai_settings(target_company uuid, target_recruitment uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  result boolean;
begin
  if (select auth.uid()) is null or target_company is null or target_recruitment is null
     or not private.has_company_access(target_company, true) then
    raise exception 'exercise_ai_settings_forbidden' using errcode = '42501';
  end if;
  select coalesce(s.auto_release, false) into result
    from public.recruitments r
    left join exercise_ai.recruitment_settings s
      on s.company_id = r.company_id and s.recruitment_id = r.id
   where r.company_id = target_company and r.id = target_recruitment;
  if not found then
    raise exception 'exercise_ai_settings_forbidden' using errcode = '42501';
  end if;
  return result;
end;
$$;

create function public.set_exercise_ai_auto_release(target_company uuid, target_recruitment uuid, enabled boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or target_company is null or target_recruitment is null
     or not private.has_company_access(target_company, true) then
    raise exception 'exercise_ai_settings_forbidden' using errcode = '42501';
  end if;
  if enabled is null then
    raise exception 'exercise_ai_settings_invalid' using errcode = '22023';
  end if;
  perform 1 from public.recruitments r
   where r.company_id = target_company and r.id = target_recruitment for share;
  if not found then
    raise exception 'exercise_ai_settings_forbidden' using errcode = '42501';
  end if;
  perform 1 from public.recruitments r
    join public.positions p on p.company_id = r.company_id and p.id = r.position_id
   where r.company_id = target_company and r.id = target_recruitment
     and r.status in ('draft', 'open') and p.status <> 'archived'
     for share of r, p;
  if not found then
    raise exception 'exercise_ai_settings_closed' using errcode = '55000';
  end if;
  return exercise_ai.set_auto_release(target_recruitment, enabled);
end;
$$;

alter function public.read_exercise_ai_settings(uuid,uuid) owner to postgres;
alter function public.set_exercise_ai_auto_release(uuid,uuid,boolean) owner to postgres;
-- Usuń domyślne uprawnienia (także wrogie domyślne dla ról spoza aplikacji).
do $acl$ declare o record; g record; begin
  for o in select oid, proowner from pg_proc where oid = any(array[
    'public.read_exercise_ai_settings(uuid,uuid)'::regprocedure,
    'public.set_exercise_ai_auto_release(uuid,uuid,boolean)'::regprocedure]) loop
    execute format('revoke all on function %s from public', o.oid::regprocedure);
    for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
      join pg_roles r on r.oid = a.grantee where p.oid = o.oid and a.grantee <> o.proowner loop
      execute format('revoke all on function %s from %I', o.oid::regprocedure, g.rolname);
    end loop;
  end loop;
end $acl$;
grant execute on function public.read_exercise_ai_settings(uuid,uuid),
  public.set_exercise_ai_auto_release(uuid,uuid,boolean) to authenticated;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r1_switch.signature_before', true) then
    raise exception 'r1_switch_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if (select count(*) from pg_proc where oid = any(array[
      'public.read_exercise_ai_settings(uuid,uuid)'::regprocedure,
      'public.set_exercise_ai_auto_release(uuid,uuid,boolean)'::regprocedure])
      and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
      and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') <> 2 then
    raise exception 'r1_switch_acl_mismatch' using errcode = '55000';
  end if;
end
$postflight$;
commit;
