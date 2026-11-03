-- Rollback of 20261103130000_sc019_checkout_offers_read: the checkout page can no
-- longer read the approved offer, so GET /api/billing/offers answers
-- "payments unavailable" again. Nothing else changes: the function held no state,
-- wrote nothing and created no schema object.
begin;

drop function if exists public.sc19_checkout_offers(uuid);

commit;
