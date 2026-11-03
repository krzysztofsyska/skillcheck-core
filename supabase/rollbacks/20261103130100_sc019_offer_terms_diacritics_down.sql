-- Rollback of 20261103130100_sc019_offer_terms_diacritics: the accented revision
-- stops being offered and the previously seeded revision is offered again.
--
-- Neither ROW is deleted. private.sc19_payment_immutable() refuses every DELETE
-- on private.sc19_payment_offers and allows an UPDATE only of `active` and
-- `approved`, because paid orders reference the offer revision they were sold
-- under. Swapping the two flags is therefore the complete and only rollback:
-- lib/sc19-payment-postgres.ts and public.sc19_checkout_offers(uuid) list an
-- offer only when `approved and active`.
--
-- The previous revision is re-activated ONLY if it still exists, so running this
-- on a database where the seed itself was rolled back leaves no purchasable
-- offer rather than resurrecting one.
begin;

do $sc19_offer_terms_down$
begin
  if to_regclass('private.sc19_payment_offers') is null then
    return;
  end if;

  update private.sc19_payment_offers set active = false, approved = false
    where id = 'preselekcja-60-2026-11-r2' and (active or approved);

  update private.sc19_payment_offers set active = true, approved = true
    where id = 'preselekcja-60-2026-11' and not (active and approved);
end
$sc19_offer_terms_down$;

commit;
