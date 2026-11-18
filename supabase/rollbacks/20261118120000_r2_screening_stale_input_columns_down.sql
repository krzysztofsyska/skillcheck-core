-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R2-B1: przywraca treść trzech funkcji sprzed 20261118120000:
-- private.touch_updated_at() (20260930000100) oraz
-- private.screening_application_stale_trigger() i private.screening_recruitment_stale_trigger()
-- (20261004000200). Po rollbacku każda zmiana wiersza zgłoszenia / rekrutacji znów oznacza
-- analizę CV jako nieaktualną. Dane bez zmian (nic nie jest kasowane ani czyszczone).
-- Wyzwalacze, tabele i uprawnienia bez zmian, sygnatura SC-010 ta sama.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  if to_regprocedure('private.erasure_schema_signature()') is not null then
    perform set_config('r2_b1.signature_before', private.erasure_schema_signature(), true);
  end if;
end
$preflight$;

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.screening_application_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.mark_screening_stale_for_application(new.id, 'application_changed');
  return new;
end;
$$;

create or replace function private.screening_recruitment_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
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
      ('private.touch_updated_at()', 'ce58f72c076133a6714fe25fb2811de2b4cdc36cb7b1e7bbcab220f62b2b1d7e'),
      ('private.screening_application_stale_trigger()', 'c14f0b8588fda69794aab4829531eb8089c2c185e92e4bbeb031ab662faabbd4'),
      ('private.screening_recruitment_stale_trigger()', '80a51cd0900c483aeddb5834cc1ebf4fc8036f1254816bd88802bf344731e15a')
    ) as expected(signature, body_hash) loop
    if not exists (select 1 from pg_catalog.pg_proc p
        where p.oid = to_regprocedure(item.signature)
          and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = item.body_hash) then
      raise exception 'r2_b1_rollback_mismatch:%', item.signature using errcode = '55000';
    end if;
  end loop;
  if to_regprocedure('private.erasure_schema_signature()') is not null then
    if private.erasure_schema_signature() is distinct from current_setting('r2_b1.signature_before', true) then
      raise exception 'r2_b1_rollback_inventory_changed' using errcode = '55000';
    end if;
  end if;
end
$postflight$;
commit;
