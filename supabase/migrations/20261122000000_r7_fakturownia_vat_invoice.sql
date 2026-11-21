-- R7 (docs/ROADMAP.md, „Prawdziwe płatności Stripe…”): one Fakturownia VAT invoice
-- per paid LIVE Stripe order (owner decision 20.11.2026, point 5, docs/DECYZJE.md).
--
-- ADDITIVE ONLY. One new table and two functions in the existing schema
-- sc19_stripe (20261121110000_r7_stripe_checkout.sql), plus EXECUTE grants for the
-- payment adapter's existing restricted roles (sc19_p24_preview on
-- skillcheck-preview, sc19_p24_checkout on production; each only where it exists).
-- No existing table, column, constraint, trigger, policy, function body, grant or
-- row is changed or removed. The roles get NO direct access to the new table and
-- NO new access to orders or to the NIP column; everything goes through the two
-- functions. The SC-010 erasure schema signature stays the same (sc19_stripe is
-- outside public/private; checked in the postflight).
--
--  * sc19_stripe.vat_invoices — the invoice record of one order: 'issuing' (claimed,
--    call in flight, or interrupted — the operator checks Fakturownia), 'issued'
--    (Fakturownia id and number), 'failed' (Fakturownia certainly created nothing;
--    may be claimed again), 'check' (the outcome is unknown; never claimed again
--    automatically). Accounting record of a company, no candidate data, no buyer
--    personal data (only ids, a status and a fixed error code). No foreign key
--    (keeps the erasure inventory untouched, as sc19_stripe.customers).
--  * sc19_stripe.claim_vat_invoice(order, company) — claims the invoice of a PAID
--    LIVE order of the KTIG Stripe account and of that company, once, from either
--    order store (private.sc19_payment_orders for PRESELEKCJA, sc19_stripe.
--    package_orders for WERYFIKACJA / ASSESSMENT CENTER): inserts 'issuing' (or
--    re-claims a 'failed' row) and returns the company name, NIP and the order's
--    amount snapshot for the invoice. Anything else
--    returns the current status and no buyer data. Concurrent calls serialize on
--    the primary key / row lock, so exactly one caller gets 'claimed'.
--  * sc19_stripe.finish_vat_invoice(order, status, id, number, code) — records the
--    outcome; changes only a row that is still 'issuing'.
--
-- A TEST-mode order is never eligible: an invoice goes to KSeF and cannot be undone.
-- Nothing here issues a document, sends anything, sets a price or stores a key.
-- Production: applied only through db-migrate-production after the owner's
-- approval. Code compatibility: without this migration the claim fails, the
-- application logs SC19_INVOICE_STORE_UNAVAILABLE and issues no invoice; the
-- payment and the grant are unaffected.
-- Rollback: supabase/rollbacks/20261122000000_r7_fakturownia_vat_invoice_down.sql.
begin;

do $preflight$
begin
 if to_regnamespace('sc19_stripe') is null or to_regclass('private.sc19_payment_orders') is null
  or to_regclass('sc19_stripe.package_orders') is null
  or to_regclass('private.sc19_trial_approvals') is null or to_regclass('public.companies') is null then
  raise exception 'r7_vat_invoice_requires_stripe_checkout' using errcode='55000';end if;
 if to_regclass('sc19_stripe.vat_invoices') is not null then
  raise exception 'r7_vat_invoice_already_installed' using errcode='55000';end if;
 perform set_config('r7_vat_invoice.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

create table sc19_stripe.vat_invoices (
 order_id uuid primary key,
 status text not null check (status in ('issuing','issued','failed','check')),
 attempts integer not null default 1 check (attempts between 1 and 20),
 fakturownia_id bigint check (fakturownia_id > 0),
 invoice_number text check (invoice_number is null or length(invoice_number) between 1 and 100),
 error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check ((status = 'issued') = (fakturownia_id is not null)),
 check ((status in ('failed','check')) = (error_code is not null)),
 check (status = 'issued' or invoice_number is null)
);
alter table sc19_stripe.vat_invoices enable row level security;
revoke all on sc19_stripe.vat_invoices from public, anon, authenticated;

create function sc19_stripe.claim_vat_invoice(target_order uuid, target_company uuid)
returns table(outcome text, company_name text, nip text, amount_minor integer)
language plpgsql volatile security definer set search_path='' as $$
declare
 order_amount integer;
 sources integer;
 current_status text;
begin
 -- Both order stores: PRESELEKCJA (private.sc19_payment_orders) and WERYFIKACJA /
 -- ASSESSMENT CENTER (sc19_stripe.package_orders). Same rules for both: KTIG Stripe
 -- account, LIVE, paid, of exactly this company. The amount is that order's snapshot.
 select count(*), min(x.amount) into sources, order_amount from (
  select o.amount_minor as amount from private.sc19_payment_orders o
   where o.id = target_order and o.company_id = target_company and o.provider = 'stripe'
    and o.account = 'ktig-consulting' and o.mode = 'live' and o.status = 'paid'
  union all
  select p.amount_minor from sc19_stripe.package_orders p
   where p.id = target_order and p.company_id = target_company and p.provider = 'stripe'
    and p.account = 'ktig-consulting' and p.mode = 'live' and p.status = 'paid') x;
 if sources <> 1 then
  return query select 'not_eligible'::text, null::text, null::text, null::integer; return;
 end if;
 insert into sc19_stripe.vat_invoices(order_id, status) values (target_order, 'issuing')
  on conflict (order_id) do nothing;
 if not found then
  -- Only an outcome that certainly created nothing may be claimed again.
  update sc19_stripe.vat_invoices set status = 'issuing', attempts = attempts + 1, error_code = null, updated_at = now()
   where order_id = target_order and status = 'failed' and attempts < 20;
  if not found then
   select v.status into current_status from sc19_stripe.vat_invoices v where v.order_id = target_order;
   return query select current_status, null::text, null::text, null::integer; return;
  end if;
 end if;
 return query select 'claimed'::text, c.name, a.nip, order_amount from public.companies c
  left join private.sc19_trial_approvals a on a.company_id = c.id where c.id = target_company;
end $$;
revoke all on function sc19_stripe.claim_vat_invoice(uuid,uuid) from public, anon, authenticated;

create function sc19_stripe.finish_vat_invoice(target_order uuid, final_status text, invoice_id bigint,
 invoice_no text, code text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if final_status is null or final_status not in ('issued','failed','check') then
  raise exception 'vat_invoice_status_invalid' using errcode='22023';end if;
 update sc19_stripe.vat_invoices set status = final_status,
  fakturownia_id = case when final_status = 'issued' then invoice_id end,
  invoice_number = case when final_status = 'issued' then invoice_no end,
  error_code = case when final_status = 'issued' then null else code end,
  updated_at = now()
  where order_id = target_order and status = 'issuing';
 return found;
end $$;
revoke all on function sc19_stripe.finish_vat_invoice(uuid,text,bigint,text,text) from public, anon, authenticated;

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('grant execute on function sc19_stripe.claim_vat_invoice(uuid,uuid) to %I', r);
  execute format('grant execute on function sc19_stripe.finish_vat_invoice(uuid,text,bigint,text,text) to %I', r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_vat_invoice.signature_before') then
  raise exception 'r7_vat_invoice_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
