-- Rollback of 20261103120000_sc019_seed_packages_offer: the purchase path stops
-- offering PRESELEKCJA and no quota is granted for FREE or PRESELEKCJA.
--
-- The offer ROW is not deleted. private.sc19_payment_immutable() refuses every
-- DELETE on private.sc19_payment_offers and allows an UPDATE only of `active`
-- and `approved`, because paid orders reference the offer revision they were
-- sold under. Deactivating is therefore the complete and only rollback:
-- lib/sc19-payment-postgres.ts lists an offer only when `approved and active`.
--
-- The package policy rows are removed only when they still hold exactly the
-- seeded values. A quota an operator has since changed through
-- public.sc19_operator_set_package_policy() is left alone, so a rollback of
-- this seed cannot silently undo an operator's billing decision.
begin;

do $sc19_seed_packages_down$
begin
  if to_regclass('private.sc19_payment_offers') is not null then
    update private.sc19_payment_offers set active = false, approved = false
      where id = 'preselekcja-60-2026-11' and (active or approved);
  end if;

  if to_regclass('private.sc19_package_policy') is not null then
    delete from private.sc19_package_policy
      where (plan, credits) in (('FREE', 5), ('PRESELEKCJA', 60));
    if exists (select 1 from private.sc19_package_policy) then
      raise notice 'sc019_seed_packages_offer_down: operator-changed package quotas kept';
    end if;
  end if;
end
$sc19_seed_packages_down$;

commit;
