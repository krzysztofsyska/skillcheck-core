-- Rollback SC-021-C. Usuwa budżety kosztów AI, ale WYŁĄCZNIE gdy nie ma w nich żadnej
-- konfiguracji, rezerwacji, zdarzeń ani audytu (to dokumenty decyzji operatora — ich usunięcie
-- to decyzja właściciela, nie rollback). Przywraca pełny zakaz zmian cennika z SC-021-B.
-- Kod budżetów działa tylko przy AI_GATEWAY_ENABLED=true; przed rollbackiem flaga musi być wyłączona.
begin;
do $guard$
begin
  if exists (select 1 from ai_ledger.budget_reservations) or exists (select 1 from ai_ledger.budget_audit)
    or exists (select 1 from ai_ledger.budget_events) or exists (select 1 from ai_ledger.plan_budgets)
    or exists (select 1 from ai_ledger.company_budgets) or exists (select 1 from ai_ledger.budget_overrides) then
    raise exception 'sc021c_rollback_budgets_not_empty' using errcode = '55000';
  end if;
end
$guard$;
drop function public.reserve_screening_ai_budget(uuid);
drop function ai_ledger.operator_budget_audit(uuid, integer);
drop function ai_ledger.operator_close_price(uuid, timestamptz, text);
drop function ai_ledger.operator_revoke_override(uuid, text);
drop function ai_ledger.operator_grant_override(uuid, text, bigint, text, timestamptz, text);
drop function ai_ledger.operator_set_company_budget(uuid, bigint, text, text);
drop function ai_ledger.operator_set_plan_budget(text, bigint, text, text);
drop function ai_ledger.require_operator();
drop function ai_ledger.company_budget_status(uuid);
drop function ai_ledger.release_exercise_budget(uuid, uuid, uuid);
drop function ai_ledger.reserve_exercise_budget(uuid, uuid, uuid);
drop function ai_ledger.reserve_budget(text, uuid, uuid, uuid, interval);
drop function ai_ledger.budget_state(uuid, timestamptz);
drop function ai_ledger.budget_usage(uuid, timestamptz, timestamptz, text, timestamptz);
drop function ai_ledger.effective_budget(uuid, timestamptz);
drop function ai_ledger.attempt_estimate(text, timestamptz);
drop function ai_ledger.period_bounds(timestamptz);
drop table ai_ledger.budget_reservations, ai_ledger.budget_events, ai_ledger.budget_audit,
  ai_ledger.budget_overrides, ai_ledger.company_budgets, ai_ledger.plan_budgets, ai_ledger.budget_estimates;
drop trigger prices_close_once on ai_ledger.prices;
drop function ai_ledger.guard_one_time_update();
create trigger prices_append_only before update or delete on ai_ledger.prices
  for each row execute function ai_ledger.append_only();
commit;
