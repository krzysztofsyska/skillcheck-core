-- Rollback SC-021-B. Usuwa rejestr prób AI i cennik modeli, ale WYŁĄCZNIE gdy rejestr jest pusty:
-- wiersze rejestru są dokumentem kosztów firmy, a ich usunięcie to decyzja właściciela, nie
-- rollback. Kod (lib/ai-gateway/ledger.ts) jest używany tylko przy AI_GATEWAY_ENABLED=true;
-- przed tym rollbackiem flaga musi być wyłączona (domyślnie jest).
begin;
do $guard$
begin
  if to_regclass('ai_ledger.attempts') is not null and exists (select 1 from ai_ledger.attempts) then
    raise exception 'sc021b_rollback_ledger_not_empty' using errcode = '55000';
  end if;
end
$guard$;
drop function if exists public.record_screening_ai_attempt(jsonb);
drop function if exists public.screening_attempt_tenant(uuid);
drop schema if exists ai_ledger cascade;
-- The NOLOGIN role ai_ledger_writer is cluster-wide and kept (operator logins may be members of it);
-- without the schema it can do nothing.
commit;
