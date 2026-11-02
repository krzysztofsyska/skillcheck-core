-- Rollback of 20261102090000_sales_leads_enable: the form stops accepting submissions.
begin;
update private.sales_lead_settings set leads_enabled = false where id and leads_enabled;
commit;
