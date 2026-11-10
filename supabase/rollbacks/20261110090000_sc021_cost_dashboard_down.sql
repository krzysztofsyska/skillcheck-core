-- Rollback SC-021-D. Usuwa panel kosztów AI i marży (funkcje odczytu/zapisu operatora, kursy walut,
-- inne koszty zmienne, klucz pseudonimów), ale WYŁĄCZNIE gdy operator niczego nie wpisał: kursy
-- i koszty wpisane przez operatora to dane finansowe, a ich usunięcie to decyzja właściciela, nie
-- rollback. Kurs testowy z migracji (created_by NULL) może zostać usunięty. Rejestr prób
-- (ai_ledger.attempts, SC-021-B) zostaje nietknięty.
begin;
do $guard$
begin
  if (to_regclass('ai_ledger.fx_rates') is not null and exists (select 1 from ai_ledger.fx_rates where created_by is not null))
    or (to_regclass('ai_ledger.other_cost_lines') is not null and exists (select 1 from ai_ledger.other_cost_lines)) then
    raise exception 'sc021d_rollback_operator_data_present' using errcode = '55000';
  end if;
end
$guard$;
drop function if exists public.sc021_operator_ai_costs(date, date, text);
drop function if exists public.sc021_operator_margin(date, date, text);
drop function if exists public.sc021_operator_fx_rates();
drop function if exists public.sc021_operator_add_fx_rate(uuid, text, bigint, timestamptz, text, boolean);
drop function if exists public.sc021_operator_other_costs(date, date, uuid, integer, integer);
drop function if exists public.sc021_operator_add_other_cost(uuid, date, uuid, text, text, bigint, text, uuid);
drop function if exists ai_ledger.live_reservations(timestamptz, timestamptz, timestamptz);
drop function if exists ai_ledger.reservation_unused_micros(ai_ledger.budget_reservations);
drop function if exists ai_ledger.reservation_is_live(ai_ledger.budget_reservations, timestamptz);
drop function if exists ai_ledger.cost_rows(timestamptz, timestamptz);
drop function if exists ai_ledger.package_ranges();
drop function if exists ai_ledger.candidate_pseudonym(uuid);
drop function if exists ai_ledger.is_catalog_settlement(text);
drop function if exists ai_ledger.fx_to_pln(text, timestamptz);
drop function if exists ai_ledger.net_from_gross(bigint, integer);
drop function if exists ai_ledger.cost_class(text, uuid, boolean);
drop function if exists ai_ledger.warsaw_month(timestamptz);
drop function if exists ai_ledger.month_range(date, date);
drop function if exists ai_ledger.package_label(text);
-- Wyzwalacze "tylko dopisywanie" znikają razem z tabelami.
drop table if exists ai_ledger.other_cost_lines;
drop table if exists ai_ledger.fx_rates;
drop table if exists ai_ledger.pseudonym_key;
commit;
