-- R7 (docs/ROADMAP.md, „Zakup PRESELEKCJI, WERYFIKACJI i ASSESSMENT CENTER przez
-- Stripe Checkout”): an EXPIRED, UNPAID Stripe Checkout session closes its order
-- without granting anything, so the company can start a new purchase. Known issue
-- of PR #556 / #563 (issue #367, R7-STRIPE-EXPIRED-SESSION): until now such an order
-- stayed 'awaiting_payment' for good (triggers sc19_order_immutable and
-- package_order_immutable), held the company's one unresolved purchase slot, and the
-- buyer got SC19_PAYMENT_RECONCILIATION_REQUIRED forever.
--
-- WHAT CLOSES AN ORDER
-- Only sc19_stripe.close_expired_order(order, session). The application calls it
-- after Stripe itself confirmed that the order's stored session is expired and not
-- paid (a GET of the session, or a signed checkout.session.expired event re-read
-- from the API). The function closes only a TEST-mode Stripe order of the KTIG
-- account that is still 'awaiting_payment', is bound to exactly that session and has
-- no receipt; anything else is refused (stripe_order_close_invalid). It records the
-- closure in sc19_stripe.order_closures (append-only) and grants NOTHING: no CV
-- analyses, no package entitlement, no receipt. Live mode stays closed.
--
-- HOW A CLOSED ORDER LOOKS
--  * WERYFIKACJA / ASSESSMENT CENTER (sc19_stripe.package_orders, outside the
--    erasure signature): status 'expired'. The status check is widened, and
--    sc19_stripe.package_immutable() lets awaiting_payment -> expired happen only
--    with a closure row for the same session; an expired order never changes again,
--    so it can never become paid. The index package_one_unresolved already counts
--    only 'awaiting_payment', so the slot is free.
--  * PRESELEKCJA (private.sc19_payment_orders): its status check is part of the
--    SC-010 erasure schema signature, so it is NOT widened (that would stop the
--    retention scheduler until a new inventory baseline). Instead the order keeps
--    status 'awaiting_payment' and its session id, and its checkout_url becomes the
--    fixed marker 'sc19:expired' (no longer a link). private.sc19_payment_immutable()
--    (function body only; the trigger definitions, columns and constraints stay
--    identical) allows that one change only with a closure row for the same session,
--    and refuses every later change of a closed order, so it can never become paid.
--    The index sc19_payment_one_unresolved (indexes are not in the signature) is
--    rebuilt with the same name and rule, now also skipping the marker, so the slot
--    is free. sc19_stripe.buyer() and public.sc19_create_catalog_order() are
--    redefined (same signatures, grants, security definer, empty search_path) to
--    skip a closed order too; bodies otherwise identical to 20261121150000.
--
-- LATE PAYMENT: a session Stripe reported expired cannot be paid. If a
-- checkout.session.completed ever arrived for a closed order anyway, nothing is
-- granted: sc19_stripe.grant_package refuses a non-awaiting order, the PRESELEKCJA
-- order update to 'paid' is refused by the trigger (rolling back the receipt and the
-- balance in the same transaction), and the application answers
-- SC19_PAYMENT_ORDER_CLOSED_REVIEW (refund / manual review).
--
-- Nothing is deleted; no price, offer or catalog changes; no candidate data. Roles:
-- only the payment adapter's restricted logins (sc19_p24_preview / sc19_p24_checkout,
-- each only where it exists) may execute the new function; nothing for anon,
-- authenticated or public. The closures table has RLS on and no grants at all.
--
-- Code compatibility: the application code shipped with this change works on the
-- pre-migration schema: without sc19_stripe.close_expired_order it answers an expired
-- session with SC19_PAYMENT_RECONCILIATION_REQUIRED, exactly as before.
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261121180000_r7_stripe_expired_session_down.sql
-- (refused once any order has been closed: closures are accounting records).
begin;

do $preflight$
begin
 if to_regclass('sc19_stripe.package_orders') is null or to_regclass('sc19_stripe.package_grants') is null
  or to_regclass('private.sc19_payment_orders') is null or to_regclass('private.sc19_payment_grants') is null
  or to_regprocedure('private.sc19_payment_immutable()') is null or to_regprocedure('sc19_stripe.package_immutable()') is null
  or to_regprocedure('sc19_stripe.buyer(uuid)') is null
  or to_regprocedure('public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean)') is null then
  raise exception 'r7_stripe_expired_session_requires_r7_stripe_packages' using errcode='55000';end if;
 if to_regclass('sc19_stripe.order_closures') is not null then
  raise exception 'r7_stripe_expired_session_already_installed' using errcode='55000';end if;
 -- The marker must be free: no stored checkout link may already equal it.
 if exists(select 1 from private.sc19_payment_orders where checkout_url='sc19:expired') then
  raise exception 'r7_stripe_expired_session_marker_in_use' using errcode='55000';end if;
 perform set_config('r7_stripe_expired.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

-- Append-only record of every closed order (both order tables). No foreign key into
-- public/private: an incoming key would change the erasure signature.
create table sc19_stripe.order_closures (
 order_id uuid primary key,
 company_id uuid not null,
 order_source text not null check (order_source in ('preselekcja','package')),
 session_id text not null check (length(session_id) between 1 and 255),
 reason text not null check (reason='session_expired'),
 closed_at timestamptz not null default now()
);
alter table sc19_stripe.order_closures enable row level security;
revoke all on sc19_stripe.order_closures from public, anon, authenticated;

-- WERYFIKACJA / ASSESSMENT CENTER: a closed order is 'expired'.
alter table sc19_stripe.package_orders drop constraint package_orders_status_check;
alter table sc19_stripe.package_orders add constraint package_orders_status_check
 check (status in ('awaiting_payment','paid','expired'));

-- Same rules as 20261121150000 plus: closures never change; awaiting_payment ->
-- expired only with the closure row of the same session; expired is final.
create or replace function sc19_stripe.package_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or tg_table_name in ('package_requests','package_grants','order_closures') then
  raise exception 'sc19_stripe_package_immutable' using errcode='55000';end if;
 if (to_jsonb(new)-array['status','session_id','checkout_url','payment_id'])
     is distinct from (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
  or (old.session_id is not null and (new.session_id is distinct from old.session_id
      or new.checkout_url is distinct from old.checkout_url))
  or (old.status in ('paid','expired') and to_jsonb(new) is distinct from to_jsonb(old))
  or (old.status='awaiting_payment' and new.status='paid' and not exists(
      select 1 from sc19_stripe.package_grants g where g.order_id=new.id))
  or (old.status='awaiting_payment' and new.status='expired' and (old.session_id is null
      or new.payment_id is not null
      or exists(select 1 from sc19_stripe.package_grants g where g.order_id=new.id)
      or not exists(select 1 from sc19_stripe.order_closures c
        where c.order_id=new.id and c.order_source='package' and c.session_id=old.session_id))) then
  raise exception 'sc19_stripe_package_immutable' using errcode='55000';end if;
 return new;
end;$$;
revoke all on function sc19_stripe.package_immutable() from public, anon, authenticated;
create trigger order_closure_immutable before update or delete on sc19_stripe.order_closures
 for each row execute function sc19_stripe.package_immutable();

-- PRESELEKCJA: body of 20261021084732 plus the closure rules (see the header).
-- Not security definer, as before: the closure row is read with the privileges of
-- the caller, which for a closure is sc19_stripe.close_expired_order (its owner).
-- A direct update by any other role cannot read the closures table and fails.
create or replace function private.sc19_payment_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or tg_table_name in ('sc19_payment_grants','sc19_payment_requests') then raise exception 'sc19_payment_immutable' using errcode='55000'; end if;
  if tg_table_name='sc19_payment_offers' then
    if (to_jsonb(new)-array['active','approved']) is distinct from
       (to_jsonb(old)-array['active','approved']) then
      raise exception 'sc19_offer_revision_immutable' using errcode='55000';
    end if;
  elsif old.checkout_url is not distinct from 'sc19:expired' then
    -- R7: a closed order (expired Stripe session) never changes again.
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'sc19_order_immutable' using errcode='55000';
    end if;
  elsif new.checkout_url is not distinct from 'sc19:expired' then
    -- R7: closing changes only checkout_url, of an unpaid order bound to a session,
    -- with the closure row of that session.
    if (to_jsonb(new)-'checkout_url') is distinct from (to_jsonb(old)-'checkout_url')
      or old.status<>'awaiting_payment' or old.session_id is null
      or not exists(select 1 from sc19_stripe.order_closures c
        where c.order_id=new.id and c.order_source='preselekcja' and c.session_id=old.session_id) then
      raise exception 'sc19_order_immutable' using errcode='55000';
    end if;
  elsif (to_jsonb(new)-array['status','session_id','checkout_url','payment_id']) is distinct from
        (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
    or (old.session_id is not null and (new.session_id is distinct from old.session_id
        or new.checkout_url is distinct from old.checkout_url))
    or (old.status='paid' and to_jsonb(new) is distinct from to_jsonb(old)) then
      raise exception 'sc19_order_immutable' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function private.sc19_payment_immutable() from public,anon,authenticated;

-- The ONE way an order is closed. Returns true when this call closed it, false when
-- the same session had already closed it (idempotent webhook / retry).
create function sc19_stripe.close_expired_order(target_order uuid, expired_session text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare p private.sc19_payment_orders; k sc19_stripe.package_orders;
begin
 if target_order is null or expired_session is null or length(expired_session) not between 1 and 255 then
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 select * into p from private.sc19_payment_orders where id=target_order for update;
 if found then
  if p.checkout_url is not distinct from 'sc19:expired' then
   if p.session_id=expired_session then return false;end if;
   raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
  if p.provider<>'stripe' or p.account<>'ktig-consulting' or p.mode<>'test' or p.status<>'awaiting_payment'
   or p.session_id is distinct from expired_session
   or exists(select 1 from private.sc19_payment_grants g where g.order_id=p.id) then
   raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
  insert into sc19_stripe.order_closures(order_id, company_id, order_source, session_id, reason)
  values (p.id, p.company_id, 'preselekcja', p.session_id, 'session_expired');
  update private.sc19_payment_orders set checkout_url='sc19:expired' where id=p.id;
  return true;
 end if;
 select * into k from sc19_stripe.package_orders where id=target_order for update;
 if not found then raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 if k.status='expired' then
  if k.session_id=expired_session then return false;end if;
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 if k.provider<>'stripe' or k.account<>'ktig-consulting' or k.mode<>'test' or k.status<>'awaiting_payment'
  or k.session_id is distinct from expired_session
  or exists(select 1 from sc19_stripe.package_grants g where g.order_id=k.id) then
  raise exception 'stripe_order_close_invalid' using errcode='22023';end if;
 insert into sc19_stripe.order_closures(order_id, company_id, order_source, session_id, reason)
 values (k.id, k.company_id, 'package', k.session_id, 'session_expired');
 update sc19_stripe.package_orders set status='expired' where id=k.id;
 return true;
end;$$;
revoke all on function sc19_stripe.close_expired_order(uuid, text) from public, anon, authenticated;

-- One unresolved PRESELEKCJA order per company, as before, without a closed order.
drop index if exists private.sc19_payment_one_unresolved;
create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id)
 where status='awaiting_payment' and provider<>'przelewy24' and checkout_url is distinct from 'sc19:expired';

-- Buyer data: a closed PRESELEKCJA order no longer counts as unpaid. Otherwise the
-- body of 20261121150000.
create or replace function sc19_stripe.buyer(target_company uuid)
returns table(company_name text, nip text)
language sql stable security definer set search_path='' as $$
 select c.name, a.nip from public.companies c
 left join private.sc19_trial_approvals a on a.company_id=c.id
 where c.id=target_company and (
  exists(select 1 from private.sc19_payment_orders o
   where o.company_id=target_company and o.provider='stripe' and o.status='awaiting_payment'
    and o.checkout_url is distinct from 'sc19:expired')
  or exists(select 1 from sc19_stripe.package_orders p
   where p.company_id=target_company and p.provider='stripe' and p.mode='test' and p.status='awaiting_payment'))
$$;
revoke all on function sc19_stripe.buyer(uuid) from public, anon, authenticated;

-- Catalog orders: a closed PRESELEKCJA order no longer blocks one (an expired
-- package order already does not: its status is 'expired'). Otherwise the body of
-- 20261121150000.
create or replace function public.sc19_create_catalog_order(target_company uuid,request_key uuid,
 expected_quote jsonb,accepted boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare quote jsonb; previous sc19_commerce.orders; oid uuid;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'commerce_read_committed_required' using errcode='25001';end if;
 perform sc19_commerce.authorize(target_company,true);
 perform private.sc19_lock_company(target_company);
 -- A concurrent NIP release may have committed while the company lock waited.
 perform sc19_commerce.authorize(target_company,true);
 if accepted is distinct from true or request_key is null or jsonb_typeof(expected_quote) is distinct from 'object' then
  raise exception 'commerce_invalid' using errcode='22023';end if;
 select * into previous from sc19_commerce.orders where company_id=target_company and request_id=request_key;
 if found then
  if previous.buyer_id<>auth.uid() or previous.kind is distinct from expected_quote->>'kind'
   or previous.code is distinct from expected_quote->>'code' or previous.package_code is distinct from expected_quote->>'packageCode'
   or previous.quantity is distinct from (expected_quote->>'quantity')::integer
   or previous.version_id::text is distinct from expected_quote->>'versionId'
   or previous.terms_revision is distinct from expected_quote->>'termsRevision'
   or previous.terms_text is distinct from expected_quote->>'termsText'
   or previous.cv_credits is distinct from (expected_quote->>'cvCredits')::integer
   or previous.service_code is distinct from expected_quote->>'serviceCode'
   or previous.service_units is distinct from (expected_quote->>'serviceUnits')::integer
   or previous.gross_minor is distinct from (expected_quote->>'grossMinor')::integer then
   raise exception 'commerce_request_conflict' using errcode='23505';end if;
  return previous.id;
 end if;
 -- Do not create an independent order while a Stripe checkout (PRESELEKCJA or a
 -- package) or another catalog order is unresolved.
 if exists(select 1 from private.sc19_payment_orders where company_id=target_company and status='awaiting_payment'
   and provider<>'przelewy24' and checkout_url is distinct from 'sc19:expired')
  or exists(select 1 from sc19_stripe.package_orders where company_id=target_company and status='awaiting_payment')
  or exists(select 1 from sc19_commerce.orders where company_id=target_company and status='pending') then
  raise exception 'commerce_pending_order' using errcode='23505';end if;
 quote:=sc19_commerce.quote(target_company,expected_quote->>'kind',expected_quote->>'code',
  expected_quote->>'packageCode',(expected_quote->>'quantity')::integer);
 if quote is distinct from expected_quote then raise exception 'commerce_stale_quote' using errcode='22023';end if;
 -- P24 uses SERIALIZABLE: a company row lock alone does not refresh its snapshot.
 -- Write a new version of the already-verified approval without changing proof or
 -- approved_at. P24's FOR SHARE approval read must retry a stale snapshot (40001).
 -- Do not touch companies: its erasure guard would lock every candidate.
 update private.sc19_trial_approvals set approved_at=approved_at where company_id=target_company;
 insert into sc19_commerce.orders(company_id,buyer_id,request_id,version_id,kind,code,package_code,quantity,
  gross_minor,cv_credits,service_code,service_units,terms_revision,terms_text)
 values(target_company,auth.uid(),request_key,(quote->>'versionId')::uuid,quote->>'kind',quote->>'code',
  quote->>'packageCode',(quote->>'quantity')::integer,(quote->>'grossMinor')::integer,(quote->>'cvCredits')::integer,
  quote->>'serviceCode',(quote->>'serviceUnits')::integer,quote->>'termsRevision',quote->>'termsText') returning id into oid;
 return oid;
end;$$;
revoke all on function public.sc19_create_catalog_order(uuid,uuid,jsonb,boolean) from public,anon;

do $roles$
declare r text;
begin
 foreach r in array array['sc19_p24_preview','sc19_p24_checkout'] loop
  continue when not exists(select 1 from pg_roles where rolname=r);
  execute format('grant execute on function sc19_stripe.close_expired_order(uuid, text) to %I', r);
 end loop;
end $roles$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_stripe_expired.signature_before') then
  raise exception 'r7_stripe_expired_session_changed_erasure_schema' using errcode='55000';end if;
end $postflight$;

commit;
