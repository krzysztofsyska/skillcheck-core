-- Run once with psql after verifying the target connection belongs to Preview.
-- This file is deliberately outside both the production and preview migration chains.
-- Create the secret LOGIN password separately; it must never appear in source.
begin;
set local sc19.preview_ref = :'sc19_seed_target_ref';
do $guard$
begin
  if current_setting('sc19.preview_ref',true) is distinct from 'orbyscrupgnupifzlqxp' then
    raise exception 'Sandbox database required';
  end if;
  -- Read on the designated hosted Preview itself. A copied psql argument or a
  -- connection to a different cluster cannot satisfy this independent check.
  if (select system_identifier from pg_catalog.pg_control_system()) <> 7692130048193495360 then
    raise exception 'Unexpected database cluster';
  end if;
  -- Refuse reuse of a pre-existing identity whose privileges we do not control.
  if exists (select 1 from pg_roles where rolname='sc19_p24_preview') then
    raise exception 'Sandbox payment role already exists';
  end if;
end
$guard$;
create role sc19_p24_preview nologin noinherit nobypassrls;
grant usage on schema private, public to sc19_p24_preview;
-- Commerce may be installed before this dedicated role is provisioned.
do $commerce_acl$ begin
 if to_regprocedure('private.sc19_has_pending_catalog_order(uuid)') is not null then
  grant execute on function private.sc19_has_pending_catalog_order(uuid) to sc19_p24_preview;
 end if;
end $commerce_acl$;

-- FOR UPDATE / FOR SHARE need UPDATE privilege and a policy that can see the row.
-- No update to these three read/lock-only relations can pass the restrictive check.
grant select(id,owner_id),update(id) on public.companies to sc19_p24_preview;
grant select(company_id),update(company_id) on private.sc19_trial_approvals to sc19_p24_preview;
grant select,update(id) on private.sc19_payment_offers to sc19_p24_preview;
create policy p24_read on public.companies for select to sc19_p24_preview using (true);
create policy p24_lock on public.companies for update to sc19_p24_preview using (true) with check (false);
create policy p24_no_company_edit on public.companies as restrictive for update to sc19_p24_preview using (true) with check (false);
create policy p24_read on private.sc19_trial_approvals for select to sc19_p24_preview using (true);
create policy p24_lock on private.sc19_trial_approvals for update to sc19_p24_preview using (true) with check (false);
create policy p24_read on private.sc19_payment_offers for select to sc19_p24_preview using (approved and active);
create policy p24_lock on private.sc19_payment_offers for update to sc19_p24_preview using (approved and active) with check (false);

grant select,insert,update(status,session_id,checkout_url,payment_id) on private.sc19_payment_orders to sc19_p24_preview;
create policy p24_orders on private.sc19_payment_orders to sc19_p24_preview
  using (mode='test' and provider='przelewy24') with check (mode='test' and provider='przelewy24');
grant select,insert on private.sc19_payment_requests, private.sc19_payment_grants to sc19_p24_preview;
create policy p24_requests on private.sc19_payment_requests to sc19_p24_preview
  using (exists (select 1 from private.sc19_payment_orders o where o.id=order_id))
  with check (exists (select 1 from private.sc19_payment_orders o where o.id=order_id));
create policy p24_receipts on private.sc19_payment_grants to sc19_p24_preview
  using (exists (select 1 from private.sc19_payment_orders o where o.id=order_id))
  with check (exists (select 1 from private.sc19_payment_orders o where o.id=order_id));

grant insert(company_id,reason,delta,reference) on private.sc19_credit_journal to sc19_p24_preview;
create policy p24_grant on private.sc19_credit_journal for insert to sc19_p24_preview
  with check (reason='paid_grant' and delta>0 and reference ~ '^settlement:sc19:[0-9a-f]{64}$');
grant select,insert(company_id,plan,available),update(plan,available,updated_at)
  on private.sc19_balances to sc19_p24_preview;
create policy p24_balance on private.sc19_balances to sc19_p24_preview
  using (true) with check (plan='PRESELEKCJA');
commit;
