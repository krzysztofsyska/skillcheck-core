-- R1-AUTO-ACCESS — w trybie „Automatycznie" dostęp do testu kompetencji dla krótkiej
-- listy powstaje bez kliknięcia rekrutera (docs/ROADMAP.md, R1; issue #367).
--
-- Jedna nowa funkcja w `public`, tym samym wzorcem co R1-SWITCH
-- (20261117150000_exercise_ai_auto_release_api.sql):
--   public.issue_exercise_ai_auto_access(firma, rekrutacja) -> jsonb
--
-- Co robi:
--  * tylko zalogowany właściciel firmy albo rekruter (private.has_company_access(..., true)
--    i ponownie private.competency_authority przy każdym zgłoszeniu); czytelnik, kandydat,
--    obca firma, obca albo nieistniejąca rekrutacja dostają ten sam błąd 42501;
--  * w trybie ręcznym (brak wiersza ustawień albo auto_release = false), w rekrutacji
--    zamkniętej/wstrzymanej albo przy zarchiwizowanym stanowisku NICZEGO nie wydaje;
--  * w trybie automatycznym wydaje dostęp do NAJNOWSZEJ wersji każdego testu kompetencji
--    przygotowanego przez AI, która jest zwolniona (zatwierdzona przez automat albo przez
--    rekrutera), wyłącznie zgłoszeniom z aktywnym wpisem na krótkiej liście
--    (recruitment_shortlist_entries, removed_at is null), bez wycofanej zgody/zgłoszenia;
--  * każde zgłoszenie przechodzi przez te same, przejrzane funkcje co ręczne wydanie
--    (private.competency_lock_application + private.competency_eligible): reguła R1
--    (krótka lista, z blokadą wiersza), status zgłoszenia/rekrutacji/stanowiska,
--    zakaz dla niezatwierdzonej propozycji AI i poprawność definicji są sprawdzane w bazie;
--  * idempotentnie: istniejący dostęp (także odwołany) nie jest wydawany ponownie;
--    klucz wydania jest wyliczany z pary (zgłoszenie, wersja testu), więc w dzienniku
--    zdarzeń widać, że dostęp wydał automat; aktorem w dzienniku jest zalogowana osoba,
--    w której sesji automat zadziałał;
--  * sekretu linku nie zapisuje i nie zwraca (baza trzyma tylko skrót). Link do
--    przekazania kandydatowi rekruter dostaje istniejącą rotacją (C3) na stronie
--    zadań kandydata; rotacja unieważnia wcześniejszy, nikomu nieznany sekret;
--  * każdy błąd przerywa całe wywołanie (transakcja), nic nie zostaje wydane częściowo.
-- NICZEGO NIE WYSYŁA kandydatom (żadnego e-maila ani SMS-a): przekazanie linku to
-- osobna, nowa prawdziwa wysyłka i pozostaje zamknięta.
--
-- Sygnatura SC-010: nie dochodzi żadna relacja, tylko jedna funkcja w 'public'.
begin;

do $preflight$
begin
  if to_regprocedure('public.issue_exercise_ai_auto_access(uuid,uuid)') is not null then
    raise exception 'r1_auto_access_already_installed' using errcode = '55000';
  end if;
  if to_regclass('exercise_ai.recruitment_settings') is null or to_regclass('exercise_ai.proposals') is null
     or to_regclass('private.competency_test_grants') is null
     or to_regclass('public.recruitment_shortlist_entries') is null
     or to_regprocedure('public.read_exercise_ai_settings(uuid,uuid)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'r1_auto_access_dependency_missing' using errcode = '55000';
  end if;
  -- Wydanie deleguje sprawdzenia do przejrzanych wersji (C1 + strażnik C6 z PR #285/#291).
  if not exists (select 1 from pg_proc
      where oid = to_regprocedure('private.competency_lock_application(uuid,boolean,boolean)')
        and encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = '549bfbef57f08fd341921a9e3646b8e310879203bb7662e46895b88cd0cb4612'
        and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
        and proacl::text = '{postgres=X/postgres}') then
    raise exception 'r1_auto_access_dependency_unreviewed:private.competency_lock_application' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc
      where oid = to_regprocedure('private.competency_eligible(public.applications,uuid)')
        and encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = '049330d807c11f0d61ea3de962f33784851e0e5942ee488e71a5ffb25ff99dc5'
        and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
        and proacl::text = '{postgres=X/postgres}') then
    raise exception 'r1_auto_access_dependency_unreviewed:private.competency_eligible' using errcode = '55000';
  end if;
  perform set_config('r1_auto_access.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create function public.issue_exercise_ai_auto_access(target_company uuid, target_recruitment uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  r public.recruitments; p public.positions; is_auto boolean;
  pair record; a public.applications; d public.exercise_definition_entries;
  issued integer := 0; inserted integer; access_list jsonb;
begin
  if actor is null or target_company is null or target_recruitment is null
     or not private.has_company_access(target_company, true) then
    raise exception 'exercise_ai_auto_access_forbidden' using errcode = '42501';
  end if;
  -- Sprawdzenia nieobecności (brak dostępu, brak wpisu) muszą widzieć ostatni zatwierdzony stan.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Read committed transaction required' using errcode = 'PT409';
  end if;
  select * into r from public.recruitments x
   where x.company_id = target_company and x.id = target_recruitment for share;
  if not found then
    raise exception 'exercise_ai_auto_access_forbidden' using errcode = '42501';
  end if;
  select * into p from public.positions x where x.company_id = r.company_id and x.id = r.position_id for share;
  -- Brak wiersza ustawień znaczy tryb ręczny.
  select coalesce(s.auto_release, false) into is_auto
    from (select 1) one
    left join exercise_ai.recruitment_settings s on s.company_id = r.company_id and s.recruitment_id = r.id;

  if is_auto and r.status in ('draft', 'open') and p.id is not null and p.status <> 'archived' then
    -- Ta sama blokada co zapis/generowanie propozycji AI tej rekrutacji.
    perform pg_advisory_xact_lock(hashtextextended('exercise_ai:' || r.id::text, 0));
    for pair in
      select e.application_id, d0.id as definition_id
        from public.recruitment_shortlist_entries e
        join public.applications app
          on app.company_id = e.company_id and app.recruitment_id = e.recruitment_id and app.id = e.application_id
        join public.candidates c on c.company_id = app.company_id and c.id = app.candidate_id
        join public.exercise_definition_entries d0
          on d0.company_id = r.company_id and d0.recruitment_id = r.id
        join exercise_ai.proposals ai
          on ai.company_id = d0.company_id and ai.recruitment_id = d0.recruitment_id and ai.definition_entry_id = d0.id
       where e.company_id = r.company_id and e.recruitment_id = r.id and e.removed_at is null
         and app.status in ('new', 'in_progress')
         and app.competency_access_cancelled_at is null and c.competency_access_cancelled_at is null
         and d0.definition->>'kind' = 'competency_test'
         and ai.approved_at is not null and ai.approval_mode is not null
         and coalesce(ai.provenance->'workflow'->>'state', '') not in ('rejected', 'superseded')
         and not exists (select 1 from public.exercise_definition_entries n
                          where n.company_id = d0.company_id and n.recruitment_id = d0.recruitment_id
                            and n.exercise_id = d0.exercise_id and n.version > d0.version)
         and not exists (select 1 from private.competency_test_grants g
                          where g.company_id = r.company_id and g.application_id = app.id
                            and g.definition_entry_id = d0.id)
       order by e.application_id, d0.id
       limit 200
    loop
      -- Te same strażniki co ręczne wydanie (create_competency_test_grant): uprawnienie,
      -- wycofanie zgody, R1 z blokadą wpisu na krótkiej liście, status, zatwierdzenie AI.
      a := private.competency_lock_application(pair.application_id, true);
      d := private.competency_eligible(a, pair.definition_id);
      insert into private.competency_test_grants(company_id, candidate_id, recruitment_id, application_id,
          definition_entry_id, token_digest, start_by_at, created_by, issuance_request_key, event_request_key)
        values (a.company_id, a.candidate_id, a.recruitment_id, a.id, d.id,
          extensions.digest(encode(extensions.gen_random_bytes(32), 'hex'), 'sha256'),
          clock_timestamp() + interval '7 days', actor,
          md5('r1-auto-access:' || a.id::text || ':' || d.id::text)::uuid,
          md5('r1-auto-access:' || a.id::text || ':' || d.id::text)::uuid)
        on conflict do nothing;
      get diagnostics inserted = row_count;
      issued := issued + inserted;
    end loop;
  end if;

  -- Lista dostępów wydanych przez automat w tej rekrutacji (do pokazania rekruterowi).
  select coalesce(jsonb_agg(jsonb_build_object(
      'grantId', g.id, 'applicationId', g.application_id, 'definitionId', g.definition_entry_id,
      'candidateName', btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')),
      'title', d0.definition->>'title', 'version', d0.version, 'revision', g.revision,
      'startBy', g.start_by_at, 'revoked', g.revoked_at is not null)
      order by g.created_at desc, g.id), '[]'::jsonb)
    into access_list
    from (select * from private.competency_test_grants g0
           where g0.company_id = r.company_id and g0.recruitment_id = r.id
             and g0.issuance_request_key = md5('r1-auto-access:' || g0.application_id::text || ':' || g0.definition_entry_id::text)::uuid
           order by g0.created_at desc, g0.id limit 200) g
    join public.candidates c on c.company_id = g.company_id and c.id = g.candidate_id
    join public.exercise_definition_entries d0
      on d0.company_id = g.company_id and d0.recruitment_id = g.recruitment_id and d0.id = g.definition_entry_id;

  return jsonb_build_object('autoRelease', is_auto, 'issued', issued, 'access', access_list);
end;
$$;

alter function public.issue_exercise_ai_auto_access(uuid,uuid) owner to postgres;
-- Usuń domyślne uprawnienia (także wrogie domyślne dla ról spoza aplikacji).
do $acl$ declare o record; g record; begin
  for o in select oid, proowner from pg_proc
            where oid = 'public.issue_exercise_ai_auto_access(uuid,uuid)'::regprocedure loop
    execute format('revoke all on function %s from public', o.oid::regprocedure);
    for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
      join pg_roles r on r.oid = a.grantee where p.oid = o.oid and a.grantee <> o.proowner loop
      execute format('revoke all on function %s from %I', o.oid::regprocedure, g.rolname);
    end loop;
  end loop;
end $acl$;
grant execute on function public.issue_exercise_ai_auto_access(uuid,uuid) to authenticated;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r1_auto_access.signature_before', true) then
    raise exception 'r1_auto_access_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc
      where oid = 'public.issue_exercise_ai_auto_access(uuid,uuid)'::regprocedure
        and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
        and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'r1_auto_access_acl_mismatch' using errcode = '55000';
  end if;
end
$postflight$;
commit;
