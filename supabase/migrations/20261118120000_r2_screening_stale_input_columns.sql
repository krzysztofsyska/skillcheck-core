-- R2-B1 — przesunięcie kandydata między etapami albo zapis decyzji rekrutera nie oznacza już
-- analizy CV jako nieaktualnej (docs/ROADMAP.md, R2; docs/checks/r2-preview-walk-2026-11-18.md, B1).
--
-- Przyczyna: dwa mechanizmy reagowały na KAŻDĄ zmianę wiersza zgłoszenia / rekrutacji:
--  1. wyzwalacze screening_application_stale i screening_recruitment_stale (20261004000200)
--     ustawiały stale_at bez sprawdzenia, co się zmieniło;
--  2. private.touch_updated_at() (20260930000100) podbijało applications.updated_at
--     i recruitments.updated_at, a te znaczniki są częścią wiązania analizy
--     (binding_snapshot, input_fingerprint): private.screening_stale_reason,
--     private.screening_ranking_freshness_reason oraz lib/screening.ts (raport kandydata)
--     uznawały więc wynik za nieaktualny nawet bez stale_at.
-- Sama poprawka wyzwalaczy nie wystarczy — dlatego zmieniamy oba miejsca.
--
-- Zmiana: `create or replace` trzech istniejących funkcji, te same sygnatury. Definicje
-- wyzwalaczy (pg_trigger), tabele, kolumny i ograniczenia zostają bez zmian, więc sygnatura
-- SC-010 (private.erasure_schema_signature) jest ta sama — postflight to sprawdza.
--  * Kolumny, które NIE są wejściem analizy CV (lista wykluczeń; każda inna kolumna, także
--    dodana w przyszłości, nadal unieważnia analizę — bezpieczniejsza strona):
--      public.applications: current_stage_id, human_decision, human_decision_reason
--        (etap i decyzja człowieka; mają własną historię w application_stage_events i
--        application_decision_events);
--      public.recruitments: name (nazwa rekrutacji nie trafia do danych analizy).
--    Wejście analizy (private.screening_input_material, lib/screening.ts): z applications
--    company_id, recruitment_id, candidate_id, status; z recruitments company_id,
--    position_id, status; reszta pochodzi z positions i candidate_documents — ich wyzwalacze
--    zostają bez zmian.
--  * private.touch_updated_at(): dla tych dwóch tabel, gdy zmieniły się wyłącznie kolumny
--    z listy wykluczeń, updated_at zostaje stare. Każda inna tabela i każda inna zmiana —
--    jak dotąd (now()).
--  * private.screening_application_stale_trigger() / private.screening_recruitment_stale_trigger():
--    gdy zmieniły się wyłącznie kolumny z listy wykluczeń, nic nie robią; w przeciwnym razie
--    działają jak dotąd.
--  * Nie zmienia danych: istniejące stale_at zostają (nic nie jest czyszczone). NICZEGO NIE WYSYŁA.
--  * Właściciel, security definer/invoker, search_path = '' i uprawnienia bez zmian —
--    `create or replace` je zachowuje, a postflight to sprawdza.
--  * Drugie uruchomienie kończy się błędem w preflight (treść funkcji już inna).
begin;

do $preflight$
declare
  item record;
begin
  for item in select * from (values
      (1, 'private.touch_updated_at()', 'ce58f72c076133a6714fe25fb2811de2b4cdc36cb7b1e7bbcab220f62b2b1d7e', false),
      (2, 'private.screening_application_stale_trigger()', 'c14f0b8588fda69794aab4829531eb8089c2c185e92e4bbeb031ab662faabbd4', true),
      (3, 'private.screening_recruitment_stale_trigger()', '80a51cd0900c483aeddb5834cc1ebf4fc8036f1254816bd88802bf344731e15a', true)
    ) as expected(n, signature, body_hash, definer) loop
    if not exists (select 1 from pg_catalog.pg_proc p
        where p.oid = to_regprocedure(item.signature)
          and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = item.body_hash
          and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef = item.definer
          and p.proconfig = array['search_path=""']) then
      raise exception 'r2_b1_dependency_unreviewed:%', item.signature using errcode = '55000';
    end if;
    perform set_config('r2_b1.acl_' || item.n,
      coalesce((select p.proacl::text from pg_catalog.pg_proc p where p.oid = to_regprocedure(item.signature)), '<null>'), true);
  end loop;
  if (select count(*) from pg_catalog.pg_attribute
      where attrelid = 'public.applications'::regclass and not attisdropped
        and attname in ('current_stage_id', 'human_decision', 'human_decision_reason')) <> 3
     or not exists (select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.recruitments'::regclass and not attisdropped and attname = 'name') then
    raise exception 'r2_b1_columns_missing' using errcode = '55000';
  end if;
  perform set_config('r2_b1.triggers_before', (
    select string_agg(pg_catalog.pg_get_triggerdef(t.oid, true), E'\n' order by t.tgrelid::regclass::text, t.tgname)
    from pg_catalog.pg_trigger t
    where t.tgrelid in ('public.applications'::regclass, 'public.recruitments'::regclass) and not t.tgisinternal), true);
  if to_regprocedure('private.erasure_schema_signature()') is not null then
    perform set_config('r2_b1.signature_before', private.erasure_schema_signature(), true);
  end if;
end
$preflight$;

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- R2-B1: stage, human decision (applications) and name (recruitments) are not inputs of the
  -- CV analysis. Their updated_at is part of the analysis binding, so a change limited to these
  -- columns keeps the previous updated_at. Every other table and every other change: now().
  if tg_table_schema = 'public' and (
      (tg_table_name = 'applications'
        and (to_jsonb(old) - '{updated_at,current_stage_id,human_decision,human_decision_reason}'::text[])
          = (to_jsonb(new) - '{updated_at,current_stage_id,human_decision,human_decision_reason}'::text[]))
      or (tg_table_name = 'recruitments'
        and (to_jsonb(old) - '{updated_at,name}'::text[]) = (to_jsonb(new) - '{updated_at,name}'::text[]))) then
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.screening_application_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- R2-B1: a stage move or a human decision is not a CV-analysis input.
  if (to_jsonb(old) - '{updated_at,current_stage_id,human_decision,human_decision_reason}'::text[])
     = (to_jsonb(new) - '{updated_at,current_stage_id,human_decision,human_decision_reason}'::text[]) then
    return new;
  end if;
  perform private.mark_screening_stale_for_application(new.id, 'application_changed');
  return new;
end;
$$;

create or replace function private.screening_recruitment_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- R2-B1: the recruitment name is not a CV-analysis input.
  if (to_jsonb(old) - '{updated_at,name}'::text[]) = (to_jsonb(new) - '{updated_at,name}'::text[]) then
    return new;
  end if;
  update public.screening_analysis_versions
  set stale_at = clock_timestamp(), stale_reason = 'recruitment_changed', updated_at = clock_timestamp()
  where company_id = new.company_id and recruitment_id = new.id and stale_at is null;
  return new;
end;
$$;

do $postflight$
declare
  item record;
begin
  for item in select * from (values
      (1, 'private.touch_updated_at()', '18f36105edd60183bbdf2cff454aae54c1b4f82c758d18f8a1c2e839b99269b7', false),
      (2, 'private.screening_application_stale_trigger()', '6737cb1aa3cc6fccdb989b40505ebba9a8814a256284f270a70e0030b70a0e37', true),
      (3, 'private.screening_recruitment_stale_trigger()', '5881ab7033193218b433caf1f34c30bdd0172e62ca59c67d88d5925f8ad596bb', true)
    ) as expected(n, signature, body_hash, definer) loop
    if not exists (select 1 from pg_catalog.pg_proc p
        where p.oid = to_regprocedure(item.signature)
          and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = item.body_hash
          and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef = item.definer
          and p.proconfig = array['search_path=""']
          and coalesce(p.proacl::text, '<null>') = current_setting('r2_b1.acl_' || item.n, true)) then
      raise exception 'r2_b1_function_mismatch:%', item.signature using errcode = '55000';
    end if;
  end loop;
  if (select string_agg(pg_catalog.pg_get_triggerdef(t.oid, true), E'\n' order by t.tgrelid::regclass::text, t.tgname)
      from pg_catalog.pg_trigger t
      where t.tgrelid in ('public.applications'::regclass, 'public.recruitments'::regclass) and not t.tgisinternal)
     is distinct from current_setting('r2_b1.triggers_before', true) then
    raise exception 'r2_b1_triggers_changed' using errcode = '55000';
  end if;
  -- Nested IF: the inner statement is planned only when the function exists.
  if to_regprocedure('private.erasure_schema_signature()') is not null then
    if private.erasure_schema_signature() is distinct from current_setting('r2_b1.signature_before', true) then
      raise exception 'r2_b1_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
    end if;
  end if;
end
$postflight$;
commit;
