-- SC-011-B5 once-only dispatch claims for the Retell create-phone-call worker,
-- installed only in a disposable test database after sc011b2-voice-dispatch.sql.
-- Retell deduplicates a repeated idempotency key for up to one hour, so a
-- claim may resend the same request inside that window and never afterwards.
-- No public RPC/grant, migration or provider transport.
begin;

create table private.sc011b_voice_dispatches (
 company_id uuid not null,
 preparation_id uuid not null,
 state text not null default 'sending' check(state in ('sending','accepted','rejected','unknown')),
 started_at timestamptz not null default clock_timestamp(),
 last_attempt_at timestamptz not null default clock_timestamp(),
 attempts integer not null default 1 check(attempts between 1 and 10),
 rejection text check(rejection in ('invalid_request','unprocessable')),
 -- SHA-256 of the provider idempotency key (must equal the preparation's) and
 -- of the exact JSON payload: every resend must carry the identical request.
 provider_key_digest text not null check(provider_key_digest ~ '^[0-9a-f]{64}$'),
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),
 -- In-flight lease: while it runs, no other worker resends or uses an attempt.
 lease_until timestamptz,
 check((state='rejected') = (rejection is not null)),
 primary key(company_id,preparation_id),
 foreign key(company_id,preparation_id)
  references private.sc010c_voice_preparations(company_id,id) on delete restrict
);

create function private.sc011b_dispatch_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_DISPATCH_IMMUTABLE';
 end if;
 if tg_op='INSERT' then
  -- BEFORE INSERT runs ahead of ON CONFLICT: an existing claim is left as is.
  if exists(select 1 from private.sc011b_voice_dispatches
    where company_id=new.company_id and preparation_id=new.preparation_id) then
   return null;
  end if;
  select * into prep from private.sc010c_voice_preparations
   where company_id=new.company_id and id=new.preparation_id for share;
  if not found or prep.state<>'prepared_offline' then
   raise exception using errcode='PT409',message='VOICE_DISPATCH_UNAVAILABLE';
  end if;
  perform private.erasure_lock_candidate(prep.candidate_id);
  if new.provider_key_digest<>prep.provider_key_digest then
   raise exception using errcode='42501',message='VOICE_DISPATCH_DRAFT_MISMATCH';
  end if;
  -- Queue the SC-010-C deferred currentness check (contact, permission,
  -- release, entitlement) for this transaction's COMMIT: no claim without it.
  update private.sc010c_voice_preparations set state=state
   where company_id=new.company_id and id=new.preparation_id;
  if new.state<>'sending' or new.attempts<>1 or new.rejection is not null then
   raise exception using errcode='42501',message='VOICE_DISPATCH_INVALID_STATE';
  end if;
  new.started_at:=clock_timestamp(); new.last_attempt_at:=new.started_at;
  new.lease_until:=new.started_at+interval '15 seconds';
  return new;
 end if;
 -- A sending claim moves by one resend, a lease release, or one terminal
 -- outcome. An unknown claim may still learn that its call was accepted.
 if new.company_id<>old.company_id or new.preparation_id<>old.preparation_id
  or new.started_at<>old.started_at or new.provider_key_digest<>old.provider_key_digest
  or new.payload_sha256<>old.payload_sha256 or new.attempts<old.attempts
  or not ((old.state='sending' and new.state='sending' and new.attempts=old.attempts+1)
       or (old.state='sending' and new.state='sending' and new.attempts=old.attempts
           and new.lease_until is null)
       or (old.state='sending' and new.state in ('accepted','rejected','unknown') and new.attempts=old.attempts)
       or (old.state='unknown' and new.state='accepted' and new.attempts=old.attempts)) then
  raise exception using errcode='42501',message='VOICE_DISPATCH_IMMUTABLE';
 end if;
 if new.state='sending' and new.attempts=old.attempts+1 then
  if old.lease_until>clock_timestamp() then
   raise exception using errcode='PT409',message='VOICE_DISPATCH_IN_FLIGHT';
  end if;
  -- Every resend re-proves current contact authority at COMMIT as well.
  update private.sc010c_voice_preparations set state=state
   where company_id=new.company_id and id=new.preparation_id;
  new.last_attempt_at:=clock_timestamp();
  new.lease_until:=new.last_attempt_at+interval '15 seconds';
 else
  new.last_attempt_at:=old.last_attempt_at;
  if new.state<>'sending' then new.lease_until:=null; end if;
 end if;
 return new;
end;$$;
create trigger sc011b_dispatch_guard before insert or update or delete
 on private.sc011b_voice_dispatches for each row execute function private.sc011b_dispatch_guard();
create trigger sc011b_dispatch_no_truncate before truncate
 on private.sc011b_voice_dispatches for each statement execute function private.sc011b_dispatch_guard();

-- A request Retell refused as invalid never left: drop the offline preparation
-- and return its reserved interview to the pool, in the same transaction.
create function private.sc011b_dispatch_rejected() returns trigger
language plpgsql security definer set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
 select * into prep from private.sc010c_voice_preparations
  where company_id=new.company_id and id=new.preparation_id for update;
 update private.sc010c_voice_preparations set state='cancelled_offline'
  where company_id=new.company_id and id=new.preparation_id;
 update private.sc19_voice_entitlements set reserved=reserved-1
  where company_id=new.company_id and id=prep.entitlement_id;
 if not found then raise exception using errcode='PT409',message='VOICE_DISPATCH_UNAVAILABLE';end if;
 return null;
end;$$;
create trigger sc011b_dispatch_rejected after update on private.sc011b_voice_dispatches
 for each row when (new.state='rejected' and old.state='sending')
 execute function private.sc011b_dispatch_rejected();

-- While a call may have left (sending, accepted or unknown), the preparation
-- cannot be cancelled and refunded offline.
create function private.sc011b_block_cancel_while_dispatching() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.sc011b_voice_dispatches
   where company_id=old.company_id and preparation_id=old.id and state<>'rejected') then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_DISPATCHED';
 end if;
 return new;
end;$$;
create trigger sc011b_block_cancel_while_dispatching before update
 on private.sc010c_voice_preparations for each row
 when (new.state='cancelled_offline' and old.state='prepared_offline')
 execute function private.sc011b_block_cancel_while_dispatching();

alter table private.sc011b_voice_dispatches enable row level security;
alter table private.sc011b_voice_dispatches force row level security;
do $$
declare f record; recipient record;
begin
 execute 'revoke all on table private.sc011b_voice_dispatches from public cascade';
 for recipient in
  select distinct a.grantee from pg_catalog.pg_class c
   cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   where c.oid='private.sc011b_voice_dispatches'::pg_catalog.regclass
    and a.grantee<>0 and a.grantee<>c.relowner
 loop
  execute pg_catalog.format('revoke all on table private.sc011b_voice_dispatches from %I cascade',
   pg_catalog.pg_get_userbyid(recipient.grantee));
 end loop;
 for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
  from pg_catalog.pg_proc p where p.oid in (
   'private.sc011b_dispatch_guard()'::pg_catalog.regprocedure,
   'private.sc011b_dispatch_rejected()'::pg_catalog.regprocedure,
   'private.sc011b_block_cancel_while_dispatching()'::pg_catalog.regprocedure
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
