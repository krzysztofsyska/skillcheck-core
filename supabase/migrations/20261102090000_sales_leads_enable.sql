-- SC-MVP-RELEASE: turn on the contact form /rozmowa in the database
-- (owner decision 2026-11-02: YES to enabling the form with the release).
-- Production data switch through the approved db-migrate-production workflow
-- instead of a manual SQL edit (AGENTS.md, production access rule 4).
-- The application side is the Vercel env SALES_LEADS_ENABLED (owner).
-- No schema change: the SC-010 erasure schema signature is unaffected.
-- Auto-reply e-mail stays off (separate Vercel flag, not touched here).
begin;

-- Turns the form on only where it can work: the settings row exists and the
-- request signing secret is set (production, checked read-only 2026-11-02).
-- Elsewhere (test chains, skillcheck-preview) it changes nothing and the form
-- stays off. Fail-safe direction. After the production run the agent checks
-- leads_enabled read-only.
update private.sales_lead_settings set leads_enabled = true
  where id and not leads_enabled and request_secret_current is not null;

do $$
begin
  if exists (select 1 from private.sales_lead_settings
             where id and request_secret_current is not null and not leads_enabled) then
    raise exception 'sales_leads_not_enabled';
  end if;
  if not exists (select 1 from private.sales_lead_settings where id and leads_enabled) then
    raise notice 'sales_leads_enable: no request signing secret here, the contact form stays off';
  end if;
end $$;

commit;
