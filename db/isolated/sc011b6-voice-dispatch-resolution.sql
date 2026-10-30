-- SC-011-B6 operator resolution of `unknown` voice dispatches, installed only
-- in a disposable test database after sc011b2 (ledger), sc011b4 (settlement)
-- and sc011b5 (worker). A claim becomes unknown when Retell's one-hour
-- deduplication window passed without a known result: the worker never
-- redials. A platform operator checks the Retell dashboard and records what
-- happened. No public RPC/grant or migration.
begin;

create table private.sc011b_dispatch_resolutions (
 company_id uuid not null,
 preparation_id uuid not null,
 resolution text not null check(resolution in ('not_placed','placed')),
 provider_call_id text check(provider_call_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
 outcome text check(outcome in
  ('completed','dnc_requested','no_answer','busy','voicemail','provider_error','other')),
 resolved_by uuid not null references auth.users(id) on delete restrict,
 resolved_at timestamptz not null default clock_timestamp(),
 check((resolution='placed') = (provider_call_id is not null and outcome is not null)),
 primary key(company_id,preparation_id),
 foreign key(company_id,preparation_id)
  references private.sc011b_voice_dispatches(company_id,preparation_id) on delete restrict
);

create function private.sc011b_resolution_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_DISPATCH_RESOLUTION_IMMUTABLE';
 end if;
 new.resolved_at:=clock_timestamp();
 return new;
end;$$;
create trigger sc011b_resolution_guard before insert or update or delete
 on private.sc011b_dispatch_resolutions for each row execute function private.sc011b_resolution_guard();
create trigger sc011b_resolution_no_truncate before truncate
 on private.sc011b_dispatch_resolutions for each statement execute function private.sc011b_resolution_guard();

-- Unknown claims awaiting an operator, oldest first. No candidate data.
create function private.sc011b_list_unknown_dispatches(result_limit integer)
returns table(company_id uuid, preparation_id uuid, started_at timestamptz,
  last_attempt_at timestamptz, attempts integer)
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_platform_operator((select auth.uid())) then
  raise exception using errcode='42501',message='VOICE_DISPATCH_RESOLUTION_FORBIDDEN';
 end if;
 return query select d.company_id,d.preparation_id,d.started_at,d.last_attempt_at,d.attempts
  from private.sc011b_voice_dispatches d where d.state='unknown'
  order by d.started_at,d.preparation_id
  limit greatest(1,least(200,coalesce(result_limit,50)));
end;$$;

-- `not_placed`: the call never left; the preparation is cancelled and its
-- interview returns to the pool. `placed`: the operator found the call; it is
-- recorded with its final outcome, and the SC-011-B4 settlement (pool use,
-- DNC contact block) runs exactly as for a webhook.
create function private.sc011b_resolve_unknown_dispatch(
 target_company uuid, target_preparation uuid, target_resolution text,
 target_agent text, target_call_id text, target_outcome text
) returns text language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());
 caller_sub text:=pg_catalog.current_setting('request.jwt.claim.sub',true);
 claim private.sc011b_voice_dispatches;
 prep private.sc010c_voice_preparations; attempt uuid; existing private.sc011b_voice_attempts;
begin
 if actor is null or not private.is_platform_operator(actor) then
  raise exception using errcode='42501',message='VOICE_DISPATCH_RESOLUTION_FORBIDDEN';
 end if;
 -- The operator is authorized and recorded as resolved_by. The effects below
 -- (cancellation, pool settlement, DNC contact block) run as the system, like
 -- a webhook on the trusted server connection: the operator is not a member of
 -- the tenant, so the erasure row guard would otherwise refuse them.
 perform pg_catalog.set_config('request.jwt.claim.sub','',true);
 select * into claim from private.sc011b_voice_dispatches
  where company_id=target_company and preparation_id=target_preparation for update;
 if not found or claim.state<>'unknown' then
  raise exception using errcode='PT409',message='VOICE_DISPATCH_NOT_UNKNOWN';
 end if;
 if target_resolution='not_placed' then
  if target_call_id is not null or target_outcome is not null then
   raise exception using errcode='PT422',message='VOICE_DISPATCH_RESOLUTION_INVALID';
  end if;
  perform pg_catalog.set_config('skillcheck.sc011b_resolution','on',true);
  update private.sc011b_voice_dispatches set state='abandoned'
   where company_id=target_company and preparation_id=target_preparation;
  perform pg_catalog.set_config('skillcheck.sc011b_resolution','off',true);
 elsif target_resolution='placed' then
  if target_call_id is null or target_outcome is null or target_agent is null then
   raise exception using errcode='PT422',message='VOICE_DISPATCH_RESOLUTION_INVALID';
  end if;
  -- A late acceptance may already have recorded the call before a crash left
  -- the claim unknown: reuse it if it is the same call, never a second one.
  select * into existing from private.sc011b_voice_attempts
   where company_id=target_company and preparation_id=target_preparation for update;
  if found then
   if existing.provider_call_id<>target_call_id or existing.provider_account_id<>target_agent then
    raise exception using errcode='PT409',message='VOICE_DISPATCH_CALL_MISMATCH';
   end if;
   attempt:=existing.id;
  else
   select * into prep from private.sc010c_voice_preparations
    where company_id=target_company and id=target_preparation;
   insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
    values(target_company,target_preparation,prep.candidate_id,target_agent,target_call_id)
    returning id into attempt;
  end if;
  -- An attempt a webhook already finished keeps its outcome and is not
  -- settled twice; otherwise the operator's outcome finishes it once.
  if existing.id is null or existing.status not in ('completed','failed','cancelled') then
   update private.sc011b_voice_attempts
    set status=case when target_outcome in ('completed','dnc_requested') then 'completed' else 'failed' end,
        outcome=target_outcome, dnc_requested=(target_outcome='dnc_requested')
    where company_id=target_company and id=attempt;
  elsif target_outcome='dnc_requested' and not existing.dnc_requested then
   -- The pool was already settled, but a candidate's request not to be
   -- called again must never be dropped.
   perform private.sc011b_block_candidate_contact(target_company,existing.candidate_id);
  end if;
  update private.sc011b_voice_dispatches set state='accepted'
   where company_id=target_company and preparation_id=target_preparation;
 else
  raise exception using errcode='PT422',message='VOICE_DISPATCH_RESOLUTION_INVALID';
 end if;
 insert into private.sc011b_dispatch_resolutions
  (company_id,preparation_id,resolution,provider_call_id,outcome,resolved_by)
 values(target_company,target_preparation,target_resolution,target_call_id,target_outcome,actor);
 -- set_config(...,true) lasts until the end of the caller's transaction:
 -- restore the operator for any statement that follows in it.
 perform pg_catalog.set_config('request.jwt.claim.sub',coalesce(caller_sub,''),true);
 return target_resolution;
end;$$;

alter table private.sc011b_dispatch_resolutions enable row level security;
alter table private.sc011b_dispatch_resolutions force row level security;
do $$
declare f record; recipient record;
begin
 execute 'revoke all on table private.sc011b_dispatch_resolutions from public cascade';
 for recipient in
  select distinct a.grantee from pg_catalog.pg_class c
   cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   where c.oid='private.sc011b_dispatch_resolutions'::pg_catalog.regclass
    and a.grantee<>0 and a.grantee<>c.relowner
 loop
  execute pg_catalog.format('revoke all on table private.sc011b_dispatch_resolutions from %I cascade',
   pg_catalog.pg_get_userbyid(recipient.grantee));
 end loop;
 for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
  from pg_catalog.pg_proc p where p.oid in (
   'private.sc011b_resolution_guard()'::pg_catalog.regprocedure,
   'private.sc011b_list_unknown_dispatches(integer)'::pg_catalog.regprocedure,
   'private.sc011b_resolve_unknown_dispatch(uuid,uuid,text,text,text,text)'::pg_catalog.regprocedure
  )
 loop
  execute pg_catalog.format('revoke all on function %s from public cascade',f.signature);
  for recipient in
   select distinct a.grantee from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    where p.oid=f.oid and a.grantee<>0 and a.grantee<>p.proowner
  loop
   execute pg_catalog.format('revoke all on function %s from %I cascade',f.signature,
    pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
 end loop;
end;$$;

commit;
