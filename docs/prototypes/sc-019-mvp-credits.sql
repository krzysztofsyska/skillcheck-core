-- SC-019 MVP: REVIEW-ONLY PostgreSQL PROTOTYPE. NOT A PRODUCTION MIGRATION.
-- Convert with Supabase CLI 'migration new' after independent review, production
-- migration-history reconciliation and explicit release approval.
-- Depends on SC-004/005/006 schemas (screening_analysis_versions).
begin;

create table private.sc19_balances (
  company_id uuid primary key references public.companies(id) on delete restrict,
  plan text not null check(plan in ('FREE','PRESELEKCJA')),
  available integer not null default 0 check (available >= 0),
  free_claimed boolean not null default false,
  updated_at timestamptz not null default now()
);
create table private.sc19_trial_nips (
  company_id uuid primary key references public.companies(id) on delete restrict,
  nip text not null unique check(nip ~ '^[0-9]{10}$'),
  claimed_at timestamptz not null default now()
);
create table private.sc19_analysis_spend (
  analysis_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  state text not null check(state in ('reserved','released')),
  updated_at timestamptz not null default now()
);
create table private.sc19_credit_journal (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  analysis_id uuid,
  reason text not null check(reason in ('trial','paid_grant','analysis_reserve','analysis_release','analysis_retry')),
  delta integer not null check(delta <> 0),
  reference text,
  created_at timestamptz not null default now(),
  unique (reference)
);

-- Only SQL operator privileges can grant a paid pack. No user-facing direct
-- balance/journal CRUD. NIP is never included in public balance responses.
revoke all on private.sc19_balances, private.sc19_trial_nips,
  private.sc19_analysis_spend, private.sc19_credit_journal from public, anon, authenticated;
alter table private.sc19_balances enable row level security;
alter table private.sc19_trial_nips enable row level security;
alter table private.sc19_analysis_spend enable row level security;
alter table private.sc19_credit_journal enable row level security;

create function private.sc19_valid_nip(value text)
returns boolean language sql immutable set search_path = '' as $$
  -- CASE ensures only digit strings reach integer casts, including in PG16.
  select case when value ~ '^[0-9]{10}$' then
    (
      (substring(value,1,1)::int*6 + substring(value,2,1)::int*5
      + substring(value,3,1)::int*7 + substring(value,4,1)::int*2
      + substring(value,5,1)::int*3 + substring(value,6,1)::int*4
      + substring(value,7,1)::int*5 + substring(value,8,1)::int*6
      + substring(value,9,1)::int*7) % 11
    ) = substring(value,10,1)::int
  else false end;
$$;
revoke all on function private.sc19_valid_nip(text) from public, anon, authenticated;

create function public.sc19_claim_trial(target_company uuid, supplied_nip text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  existing_nip text;
  current_credits integer;
begin
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode = '42501';
  end if;
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode = '22023';
  end if;
  -- Serialize per company and use a globally UNIQUE NIP across all owners.
  perform 1 from public.companies where id=target_company for update;
  select nip into existing_nip from private.sc19_trial_nips where company_id=target_company;
  if existing_nip is not null then
    if existing_nip <> normalized then
      raise exception 'sc19_trial_already_claimed' using errcode = '23505';
    end if;
    select available into current_credits from private.sc19_balances where company_id=target_company;
    return current_credits; -- same company, same NIP = idempotent, no extra grant
  end if;
  insert into private.sc19_trial_nips(company_id,nip) values (target_company,normalized);
  insert into private.sc19_balances(company_id,plan,available,free_claimed)
    values(target_company,'FREE',5,true)
    on conflict(company_id) do update
      set available=private.sc19_balances.available+5,free_claimed=true,updated_at=now()
      where not private.sc19_balances.free_claimed;
  if not found then raise exception 'sc19_trial_already_claimed' using errcode='23505'; end if;
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values(target_company,'trial',5,'trial:'||normalized);
  select available into current_credits from private.sc19_balances where company_id=target_company;
  return current_credits;
end;
$$;
revoke all on function public.sc19_claim_trial(uuid,text) from public, anon, authenticated;
grant execute on function public.sc19_claim_trial(uuid,text) to authenticated;

create function public.sc19_get_balance(target_company uuid)
returns table(plan text,available integer,free_claimed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_company_access(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  return query select b.plan,b.available,b.free_claimed
    from private.sc19_balances b where b.company_id=target_company;
end;
$$;
revoke all on function public.sc19_get_balance(uuid) from public, anon, authenticated;
grant execute on function public.sc19_get_balance(uuid) to authenticated;

-- MANUAL PAID FULFILLMENT ONLY: call from trusted admin SQL after confirming
-- bank settlement / external processor settlement. Never GRANT to authenticated.
create function private.sc19_grant_paid(target_company uuid, settlement_reference text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  prior_company uuid;
  credits integer;
begin
  if length(btrim(coalesce(settlement_reference,''))) not between 8 and 160 then
    raise exception 'sc19_invalid_settlement' using errcode='22023';
  end if;
  perform 1 from public.companies where id=target_company for update;
  if not found then raise exception 'sc19_company_missing' using errcode='22023'; end if;
  select company_id into prior_company from private.sc19_credit_journal
    where reference='settlement:'||btrim(settlement_reference);
  if prior_company is not null then
    if prior_company <> target_company then
      raise exception 'sc19_reference_conflict' using errcode='23505';
    end if;
    select available into credits from private.sc19_balances where company_id=target_company;
    return credits; -- same payment, no second grant
  end if;
  insert into private.sc19_balances(company_id,plan,available)
    values(target_company,'PRESELEKCJA',60)
    on conflict(company_id) do update
      set plan='PRESELEKCJA',available=private.sc19_balances.available+60,updated_at=now();
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values(target_company,'paid_grant',60,'settlement:'||btrim(settlement_reference));
  select available into credits from private.sc19_balances where company_id=target_company;
  return credits;
end;
$$;
revoke all on function private.sc19_grant_paid(uuid,text) from public, anon, authenticated;

-- DB TRIGGER, not frontend check: all entrypoints including legacy screening RPC
-- are billed on a newly INSERTed logical analysis. Completed reuse does not INSERT.
-- Locking the balance row serializes two applicants racing for the final credit.
create function private.sc19_charge_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update private.sc19_balances
    set available=available-1,updated_at=now()
    where company_id=new.company_id and available>0;
  if not found then raise exception 'sc19_quota_exhausted' using errcode='PT402'; end if;
  insert into private.sc19_analysis_spend(analysis_id,company_id,state)
    values(new.id,new.company_id,'reserved');
  insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
    values(new.company_id,new.id,'analysis_reserve',-1);
  return null;
end;
$$;
revoke all on function private.sc19_charge_analysis() from public, anon, authenticated;
create trigger sc19_analysis_bill after insert on public.screening_analysis_versions
  for each row execute function private.sc19_charge_analysis();

-- Fail/cancel refunds exactly once; same-analysis retry re-reserves exactly once.
-- Future cancellation/retention workflows need explicit reconciliation review.
create function private.sc19_reconcile_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_state text;
begin
  if old.execution_status is not distinct from new.execution_status then return null; end if;
  select state into previous_state from private.sc19_analysis_spend
    where analysis_id=new.id and company_id=new.company_id for update;
  if previous_state is null then raise exception 'sc19_spend_missing' using errcode='23503'; end if;
  if new.execution_status in ('failed','cancelled') and previous_state='reserved' then
    update private.sc19_balances set available=available+1,updated_at=now()
      where company_id=new.company_id;
    update private.sc19_analysis_spend set state='released',updated_at=now() where analysis_id=new.id;
    insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
      values(new.company_id,new.id,'analysis_release',1);
  elsif new.execution_status='pending' and old.execution_status in ('failed','cancelled')
    and previous_state='released' then
    update private.sc19_balances set available=available-1,updated_at=now()
      where company_id=new.company_id and available>0;
    if not found then raise exception 'sc19_quota_exhausted' using errcode='PT402'; end if;
    update private.sc19_analysis_spend set state='reserved',updated_at=now() where analysis_id=new.id;
    insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
      values(new.company_id,new.id,'analysis_retry',-1);
  end if;
  return null;
end;
$$;
revoke all on function private.sc19_reconcile_analysis() from public, anon, authenticated;
create trigger sc19_analysis_reconcile after update of execution_status on public.screening_analysis_versions
  for each row execute function private.sc19_reconcile_analysis();
commit;
