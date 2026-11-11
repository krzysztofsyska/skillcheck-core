-- Undoes 20261111090000_sc19_offer_publication.sql: removes the three functions
-- and their grants. Nothing else exists to undo — that migration creates no
-- table, column, constraint, trigger or row, and publishes no offer.
--
-- DATA IS NOT TOUCHED. If an operator has already published the offer, the row
-- in private.sc19_payment_offers stays approved and active and the package stays
-- purchasable after this rollback. Withdrawing a published offer is a billing
-- action and the owner's decision; it is done BEFORE this rollback, by the
-- operator, because this script removes the function that can do it. Any paid
-- order references its offer row, which is immutable and undeletable by design
-- (private.sc19_payment_immutable()).
--
-- Re-runnable: `if exists` on every drop, so a partial earlier rollback finishes
-- cleanly.
begin;

drop function if exists public.sc19_operator_publish_offer();
drop function if exists public.sc19_operator_published_offer();
drop function if exists private.sc19_offer_revision();

commit;
