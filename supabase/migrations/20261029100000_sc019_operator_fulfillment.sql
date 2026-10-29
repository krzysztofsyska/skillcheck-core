-- SC-019 operator fulfillment: platform operators approve FREE trials, set the
-- package policy and grant a paid PRESELEKCJA pack from the application,
-- instead of privileged SQL on the production database.
--
-- Functions only. No table, column, constraint or trigger is added, so the
-- SC-010 erasure inventory signature (R7) is unchanged. Every function is
-- SECURITY DEFINER, checks private.is_platform_operator(auth.uid()) first and
-- reuses the reviewed M13 primitives (private.sc19_lock_company,
-- private.sc19_valid_nip, private.sc19_grant_paid). Nothing is seeded: the
-- package policy and every grant remain explicit operator actions.
begin;

do $preflight$
begin
  if to_regclass('private.sc19_trial_approvals') is null
     or to_regclass('private.sc19_package_policy') is null
     or to_regprocedure('private.sc19_grant_paid(uuid,text)') is null
     or to_regprocedure('private.sc19_lock_company(uuid)') is null
     or to_regprocedure('private.sc19_valid_nip(text)') is null then
    raise exception 'sc19_operator_requires_m13' using errcode='55000';
  end if;
  if to_regprocedure('private.is_platform_operator(uuid)') is null then
    raise exception 'sc19_operator_requires_platform_operators' using errcode='55000';
  end if;
end
$preflight$;

create function private.sc19_require_operator()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null or not private.is_platform_operator(actor) then
    raise exception 'sc19_operator_forbidden' using errcode='42501';
  end if;
  return actor;
end;
$$;
revoke all on function private.sc19_require_operator() from public, anon, authenticated;

-- Operator overview. No owner e-mail and no journal references; the approved
-- NIP is visible to platform operators only, who recorded it.
create function public.sc19_operator_companies(search text default null)
returns table(company_id uuid, company_name text, created_at timestamptz,
  plan text, available integer, free_claimed boolean, approved_nip text, approved_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare needle text := nullif(btrim(coalesce(search,'')),'');
begin
  perform private.sc19_require_operator();
  if length(needle) > 200 then raise exception 'sc19_invalid_search' using errcode='22023'; end if;
  return query
    select c.id, c.name, c.created_at, b.plan, b.available, coalesce(b.free_claimed,false),
      a.nip, a.approved_at
    from public.companies c
    left join private.sc19_balances b on b.company_id=c.id
    left join private.sc19_trial_approvals a on a.company_id=c.id
    where needle is null or c.id::text=lower(needle)
      or strpos(lower(c.name), lower(needle)) > 0
    order by c.created_at desc, c.id
    limit 200;
end;
$$;
revoke all on function public.sc19_operator_companies(text) from public, anon, authenticated;
grant execute on function public.sc19_operator_companies(text) to authenticated;

create function public.sc19_operator_package_policy()
returns table(plan text, credits integer, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.sc19_require_operator();
  return query select p.plan, p.credits, p.updated_at from private.sc19_package_policy p order by p.plan;
end;
$$;
revoke all on function public.sc19_operator_package_policy() from public, anon, authenticated;
grant execute on function public.sc19_operator_package_policy() to authenticated;

-- Changes only future trials and grants; existing balances are untouched.
-- updated_at is stamped by the M13 touch_updated_at trigger.
create function public.sc19_operator_set_package_policy(target_plan text, target_credits integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.sc19_require_operator();
  if target_plan is null or target_plan not in ('FREE','PRESELEKCJA')
     or target_credits is null or target_credits not between 1 and 100000 then
    raise exception 'sc19_invalid_policy' using errcode='22023';
  end if;
  insert into private.sc19_package_policy(plan,credits) values(target_plan,target_credits)
    on conflict(plan) do update set credits=excluded.credits;
  return target_credits;
end;
$$;
revoke all on function public.sc19_operator_set_package_policy(text,integer) from public, anon, authenticated;
grant execute on function public.sc19_operator_set_package_policy(text,integer) to authenticated;

-- Records the operator's verification of the company/NIP relationship, which
-- sc19_claim_trial requires before FREE. The proof is an operator-written
-- reference (for example a KRS extract or verification ticket), stored with the
-- approving operator's id. Same company + same NIP is idempotent; anything else
-- that conflicts is refused.
create function public.sc19_operator_approve_trial(target_company uuid, supplied_nip text, proof text)
returns timestamptz language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := private.sc19_require_operator();
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  trimmed_proof text := btrim(coalesce(proof,''));
  existing private.sc19_trial_approvals;
  result timestamptz;
begin
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode='22023';
  end if;
  if length(trimmed_proof) not between 8 and 100 then
    raise exception 'sc19_invalid_proof' using errcode='22023';
  end if;
  perform private.sc19_lock_company(target_company);
  select * into existing from private.sc19_trial_approvals where company_id=target_company;
  if found then
    if existing.nip <> normalized then
      raise exception 'sc19_trial_approval_conflict' using errcode='23505';
    end if;
    return existing.approved_at;
  end if;
  if exists(select 1 from private.sc19_trial_approvals where nip=normalized)
     or exists(select 1 from private.sc19_trial_nips where nip=normalized) then
    raise exception 'sc19_trial_nip_taken' using errcode='23505';
  end if;
  insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
    values(target_company,normalized,format('%s [operator:%s]',trimmed_proof,actor))
    returning approved_at into result;
  return result;
end;
$$;
revoke all on function public.sc19_operator_approve_trial(uuid,text,text) from public, anon, authenticated;
grant execute on function public.sc19_operator_approve_trial(uuid,text,text) to authenticated;

-- Grants one PRESELEKCJA pack after the operator has confirmed settlement
-- outside the browser (paid invoice, bank transfer, payment processor). The
-- settlement reference is the idempotency key: repeating it never grants twice.
create function public.sc19_operator_grant_paid(target_company uuid, settlement_reference text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.sc19_require_operator();
  return private.sc19_grant_paid(target_company, settlement_reference);
end;
$$;
revoke all on function public.sc19_operator_grant_paid(uuid,text) from public, anon, authenticated;
grant execute on function public.sc19_operator_grant_paid(uuid,text) to authenticated;

commit;
