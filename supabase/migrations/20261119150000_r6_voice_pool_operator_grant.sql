-- R6-2 (part independent of the payment-path freeze): operator grant of voice
-- interviews to a company and the remaining-interview check, on top of the R19
-- voice interview pool (private.sc19_voice_entitlements).
--
-- Functions only. No table, column, constraint or trigger is added or changed,
-- so the SC-010 erasure schema signature and inventory R19 stay exactly as they
-- are (a schema change here would block every candidate erasure until a new
-- inventory baseline is reviewed).
--
-- Nothing refers to packages, prices, orders, the pricing catalog or a payment
-- provider. A grant has a neutral kind:
--   trial_single     exactly 1 interview, at most once per company, ever. Its
--                    grant reference is derived from the company id, so the
--                    existing unique(grant_reference) enforces "once" even after
--                    the grant expired, was revoked or was used (rows are never
--                    deleted by the pool guard).
--   operator_manual  1..1000 interviews under an operator-supplied reference to
--                    an independently kept operator grant record.
-- Both are idempotent by grant reference: a replay with identical terms returns
-- the existing grant; different terms under the same reference are refused.
--
-- Nothing is granted to anon, authenticated, service_role or any other role:
-- only the function owner (a trusted SQL operator or a later reviewed server
-- role) can execute them. Not used by the application, not visible to customers.
begin;

do $preflight$
begin
 if to_regclass('private.sc19_voice_entitlements') is null
  or to_regclass('private.erasure_inventory_baseline_r19') is null
  or to_regprocedure('private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)') is null then
  raise exception 'voice_pool_grant_requires_r19' using errcode='55000';end if;
 if to_regprocedure('private.sc19_voice_trial_reference(uuid)') is not null
  or to_regprocedure('private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)') is not null
  or to_regprocedure('private.sc19_voice_interview_balance(uuid)') is not null then
  raise exception 'voice_pool_grant_already_installed' using errcode='55000';end if;
 if private.erasure_schema_signature() is distinct from 'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39' then
  raise exception 'voice_pool_grant_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
end $preflight$;

-- Deterministic, opaque reference of the single trial grant of one company.
-- Domain-separated so it cannot equal a reference derived for anything else.
create function private.sc19_voice_trial_reference(target_company uuid)
returns uuid language sql immutable strict security definer set search_path='' as $$
 select substr(encode(pg_catalog.sha256(pg_catalog.convert_to(
  'skillcheck:sc19-voice-pool:trial_single:v1:'||target_company::text,'UTF8')),'hex'),1,32)::uuid
$$;

create function private.sc19_voice_grant_interviews(
 target_company uuid,
 grant_kind text,
 interviews integer,
 grant_reference uuid,
 grant_expires_at timestamptz,
 company_verification_reference uuid,
 company_verification_expires_at timestamptz
) returns table(entitlement_id uuid, replayed boolean)
language plpgsql volatile security definer set search_path='' as $$
declare
 reference uuid;
 existing private.sc19_voice_entitlements;
 created uuid;
 now_ts timestamptz:=clock_timestamp();
begin
 if target_company is null or grant_kind is null or interviews is null or grant_expires_at is null
  or company_verification_reference is null or company_verification_expires_at is null then
  raise exception 'voice_grant_invalid' using errcode='22023';end if;
 if grant_expires_at<=now_ts or grant_expires_at>now_ts+interval '366 days'
  or company_verification_expires_at<=now_ts then
  raise exception 'voice_grant_window_invalid' using errcode='22023';end if;
 perform 1 from public.companies c where c.id=target_company;
 if not found then raise exception 'voice_grant_company_unknown' using errcode='PT404';end if;

 if grant_kind='trial_single' then
  if interviews<>1 then raise exception 'voice_grant_trial_is_single' using errcode='22023';end if;
  reference:=private.sc19_voice_trial_reference(target_company);
  if grant_reference is not null and grant_reference is distinct from reference then
   raise exception 'voice_grant_trial_reference_derived' using errcode='22023';end if;
 elsif grant_kind='operator_manual' then
  if interviews not between 1 and 1000 then raise exception 'voice_grant_interviews_invalid' using errcode='22023';end if;
  if grant_reference is null then raise exception 'voice_grant_reference_required' using errcode='22023';end if;
  -- A manual grant can never occupy or imitate any company's trial reference.
  if grant_reference=private.sc19_voice_trial_reference(target_company) then
   raise exception 'voice_grant_reference_reserved' using errcode='22023';end if;
  reference:=grant_reference;
 else
  raise exception 'voice_grant_kind_invalid' using errcode='22023';
 end if;

 -- Serialize grants of one reference; unique(grant_reference) is the final guard.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sc19_voice_grant:'||reference::text,0));
 select * into existing from private.sc19_voice_entitlements e where e.grant_reference=reference;
 if found then
  if existing.company_id is distinct from target_company then
   raise exception 'voice_grant_reference_conflict' using errcode='23505';end if;
  if grant_kind='trial_single' then
   -- Once per company: a repeated trial grant never creates a second unit,
   -- whatever window it asks for.
   return query select existing.id,true;return;
  end if;
  if existing.total is distinct from interviews or existing.expires_at is distinct from grant_expires_at then
   raise exception 'voice_grant_reference_conflict' using errcode='23505';end if;
  return query select existing.id,true;return;
 end if;

 insert into private.sc19_voice_entitlements(company_id,total,grant_reference,valid_from,expires_at,active,
  company_verified,company_verification_reference,company_verification_expires_at,grant_verified)
 values(target_company,interviews,reference,now_ts,grant_expires_at,true,
  true,company_verification_reference,company_verification_expires_at,true)
 returning id into created;
 return query select created,false;
end;
$$;

-- Remaining interviews of a company across its currently eligible grants
-- (active, not revoked, inside its window, company evidence current, verified).
-- available = granted - used - reserved, never negative. Read-only.
create function private.sc19_voice_interview_balance(target_company uuid)
returns table(granted integer, used integer, reserved integer, available integer)
language sql volatile security definer set search_path='' as $$
 select coalesce(sum(e.total),0)::integer,coalesce(sum(e.used),0)::integer,coalesce(sum(e.reserved),0)::integer,
  coalesce(sum(greatest(e.total-e.used-e.reserved,0)),0)::integer
 from private.sc19_voice_entitlements e
 where e.company_id=target_company and private.sc19_voice_entitlement_eligible(e)
$$;

-- Owner only: close every actual ACL, including inherited defaults.
do $acl$
declare o record;g record;
begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.sc19_voice_trial_reference(uuid)',
  'private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)',
  'private.sc19_voice_interview_balance(uuid)']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop
   execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from 'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39' then
  raise exception 'voice_pool_grant_schema_changed:%',private.erasure_schema_signature() using errcode='55000';end if;
 if exists(select 1 from pg_proc p where p.oid=any(array[
   'private.sc19_voice_trial_reference(uuid)',
   'private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)',
   'private.sc19_voice_interview_balance(uuid)']::regprocedure[])
  and (not p.prosecdef or p.proconfig is null or p.proconfig[1] is distinct from 'search_path=""'
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))) then
  raise exception 'voice_pool_grant_function_exposed' using errcode='55000';end if;
end $postflight$;

commit;
