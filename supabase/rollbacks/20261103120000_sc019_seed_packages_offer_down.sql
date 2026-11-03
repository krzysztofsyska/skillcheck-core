-- Rollback of 20261103120000_sc019_seed_packages_offer: the purchase path stops
-- offering PRESELEKCJA. Package quotas are left as they are and only reported;
-- see below.
--
-- The offer ROW is not deleted. private.sc19_payment_immutable() refuses every
-- DELETE on private.sc19_payment_offers and allows an UPDATE only of `active`
-- and `approved`, because paid orders reference the offer revision they were
-- sold under. Deactivating is therefore the complete and only rollback:
-- lib/sc19-payment-postgres.ts lists an offer only when `approved and active`.
--
-- The package policy rows are NOT removed, only reported.
--
-- private.sc19_package_policy has no provenance column: a row holding FREE=5 /
-- PRESELEKCJA=60 is indistinguishable from the same values set deliberately by
-- an operator through public.sc19_operator_set_package_policy(). Those are the
-- owner-approved numbers, so they are exactly the values an operator is most
-- likely to have entered. Deleting by value would therefore destroy a live
-- billing configuration — after which private.sc19_grant_paid() raises
-- sc19_missing_paid_policy and every paid grant stops — on the strength of a
-- guess about who wrote the row.
--
-- A migration never overwrites or removes an operator billing decision (the
-- same principle the forward migration follows when it keeps a differing quota
-- and only reports it). Quotas are an operator action in /operator/billing;
-- taking them away is one too. Deactivating the offer is the complete rollback
-- of what this migration made purchasable.
begin;

do $sc19_seed_packages_down$
declare
  policy record;
begin
  if to_regclass('private.sc19_payment_offers') is not null then
    update private.sc19_payment_offers set active = false, approved = false
      where id = 'preselekcja-60-2026-11' and (active or approved);
  end if;

  if to_regclass('private.sc19_package_policy') is not null then
    for policy in select plan, credits from private.sc19_package_policy order by plan loop
      raise notice 'sc019_seed_packages_offer_down: package quota kept, remove it in /operator/billing if it is unwanted: % = % analiz CV', policy.plan, policy.credits;
    end loop;
  end if;
end
$sc19_seed_packages_down$;

commit;
