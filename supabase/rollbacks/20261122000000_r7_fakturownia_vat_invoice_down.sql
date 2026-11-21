-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 Fakturownia VAT invoice record (20261122000000_r7_fakturownia_vat_invoice.sql).
-- Refuses while any invoice record exists: it is the accounting trace of a document
-- sent to KSeF and is never deleted by a rollback. Run with `psql -v ON_ERROR_STOP=1`.
begin;

do $guard$
begin
 if to_regclass('sc19_stripe.vat_invoices') is not null and exists(select 1 from sc19_stripe.vat_invoices) then
  raise exception 'r7_vat_invoice_rollback_refused_records_exist' using errcode='55000';end if;
end $guard$;

drop function if exists sc19_stripe.finish_vat_invoice(uuid,text,bigint,text,text);
drop function if exists sc19_stripe.claim_vat_invoice(uuid,uuid);
drop table if exists sc19_stripe.vat_invoices;

commit;
