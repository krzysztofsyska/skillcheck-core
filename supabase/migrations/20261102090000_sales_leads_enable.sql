-- SC-MVP-RELEASE: turn on the contact form /rozmowa in the database
-- (owner decision 2026-11-02: YES to enabling the form with the release).
-- Production data switch through the approved db-migrate-production workflow
-- instead of a manual SQL edit (AGENTS.md, production access rule 4).
-- The application side is the Vercel env SALES_LEADS_ENABLED (owner).
-- No schema change: the SC-010 erasure schema signature is unaffected.
-- Auto-reply e-mail stays off (separate Vercel flag, not touched here).
begin;

do $$
begin
  if not exists (select 1 from private.sales_lead_settings where id) then
    raise exception 'sales_lead_settings row missing';
  end if;
  -- The form signs requests with this secret; enabling without it would only fail.
  if exists (select 1 from private.sales_lead_settings where id and request_secret_current is null) then
    raise exception 'sales_lead_request_secret_missing';
  end if;
end $$;

update private.sales_lead_settings set leads_enabled = true where id and not leads_enabled;

do $$
begin
  if not (select leads_enabled from private.sales_lead_settings where id) then
    raise exception 'sales_leads_not_enabled';
  end if;
end $$;

commit;
