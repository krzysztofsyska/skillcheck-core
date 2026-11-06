-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Usuwa oznaczenia wymagań razem z tabelą: to dane firmy, nie kandydata, i nie
-- wchodzą do inwentarza usuwania danych kandydatów.
begin;
drop function if exists public.set_position_requirement_flag(uuid,uuid,text,text,text);
drop function if exists public.position_requirement_flags(uuid,uuid);
drop table if exists requirements.position_flags;
drop schema if exists requirements;
commit;
