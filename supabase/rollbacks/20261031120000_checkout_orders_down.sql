-- Rollback for 20261031120000_checkout_orders.sql. Drops order history: export first.
begin;
drop function if exists public.checkout_pending_orders(integer, integer, bigint, text);
drop function if exists public.checkout_read_order(uuid, bigint, text);
drop function if exists public.checkout_update_order(uuid, text, bigint, integer, bigint, text);
drop function if exists public.checkout_create_order(uuid, text, integer, integer, text, text, text, text, text, bigint, text);
drop schema if exists checkout cascade;
commit;
