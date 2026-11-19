-- R6-1c (part 4): voice dispatch ledger (SC-011-B2: provider call attempts and
-- webhook receipts) and once-only dispatch claims (SC-011-B5) as a real migration.
-- Generated offline by scripts/r6-voice-dispatch-compose.mjs from the reviewed
-- isolated sources and the R19 erasure inventory; erasure inventory R20 adds the
-- three candidate-linked tables and purges them before the preparations they
-- reference.
--
-- Nothing is used by the application yet and nothing is customer-visible: no
-- table or function is granted to anon, authenticated or service_role, nothing is
-- seeded, no provider is called, no webhook route exists and no package, price or
-- order state is touched. Settlement (SC-011-B4), transcripts (SC-011-B3) and the
-- operator resolution (SC-011-B6) are not part of this step.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r19') is null or to_regclass('private.sc010c_voice_preparations') is null
  or to_regclass('private.sc19_voice_entitlements') is null then
  raise exception 'voice_dispatch_requires_r19' using errcode='55000';end if;
 -- R6-2 operator grant (20261119150000) is installed and left the R19 schema unchanged.
 if to_regprocedure('private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)') is null
  or to_regprocedure('private.sc19_voice_interview_balance(uuid)') is null
  or to_regprocedure('private.sc19_voice_trial_reference(uuid)') is null then
  raise exception 'voice_dispatch_requires_operator_grant' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r20') is not null
  or to_regclass('private.sc011b_voice_attempts') is not null
  or to_regclass('private.sc011b_voice_webhook_receipts') is not null
  or to_regclass('private.sc011b_voice_dispatches') is not null then
  raise exception 'voice_dispatch_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r19 where singleton and schema_signature='c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39')
  or private.erasure_schema_signature() is distinct from 'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39' then
  raise exception 'voice_dispatch_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r19 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_dispatch_source_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_inventory_rows(uuid,uuid[])'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='af45d43b723c0191e23929f00103eecc31cb38c35368feba72b518046592e6e2'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.erasure_inventory_rows' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_row_candidates(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='10fd91c288bd03beca7f8ff755b6e17480e4c6086e209faee1174d13d025ba59'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.erasure_row_candidates' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_engine(uuid,bigint,boolean)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f19c6eac2499fba5efb0fa0b982a0b42a26acab769605f04c1b9e7ebb8316271'
  and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{erasure_purge_owner=X/erasure_purge_owner}') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.erasure_purge_engine' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.preview_candidate_erasure(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='133718334bff2d1159eabe19f925e491b5c8a03cf75364e36089d8d0e09e9cff'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'voice_dispatch_source_function_unreviewed:public.preview_candidate_erasure' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.prepare_erasure_purge_manifest(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='eb419cb4e8b1b1102dc3f39e3e47e25d2cea4665f4918436e8364cc816cdbe00'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.prepare_erasure_purge_manifest' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.authorize_retention_suggestion(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7523115bbb229ec54bb02e58ecc747c0724cb6ff3bddd3f7720e815feab2253d'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.authorize_retention_suggestion' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.get_retention_schedule(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3a2a7e64658a9e56e844b0b8df921e6f1fdedf4ccd04d2a89805a69e6d3d9c7f'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'voice_dispatch_source_function_unreviewed:public.get_retention_schedule' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_key(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='8c2e9b9d3fde3f9e132ae46259e154935342980919ffd5789a8be2e961343229') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.erasure_purge_key' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_voice_row_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='1f5e6ff865ae47397e5b236286e9bd17bbf7ce7eb160a948ac89d731e3e374cb') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.erasure_voice_row_guard' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.sc010c_preparation_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='25c1be213d6495ad4891acb7e3b67356119921a6afa60559d0d5746435bd11cf') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.sc010c_preparation_guard' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_voice_refund_deleted()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7bdbcecd3659f5198fe4c9a2ddd9902b90ed31961e824bb4094c4d891a9371e5') then
  raise exception 'voice_dispatch_source_function_unreviewed:private.erasure_voice_refund_deleted' using errcode='55000';end if;
 if to_regprocedure('private.erasure_inventory_rows_r19(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r19(text,jsonb)') is not null then
  raise exception 'voice_dispatch_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.erasure_lock_candidate(uuid)') is null or to_regprocedure('private.retention_observe_candidate()') is null
  or to_regprocedure('private.contact_immutable()') is null or to_regprocedure('private.erasure_purge_allowed(text,jsonb,text)') is null
  or to_regprocedure('private.erasure_purge_visible(text,jsonb)') is null or to_regrole('erasure_purge_owner') is null then
  raise exception 'voice_dispatch_dependency_missing' using errcode='55000';end if;
 -- The ledger references a preparation by (company_id,id) and compares its provider key digest.
 if not exists(select 1 from pg_constraint where conrelid='private.sc010c_voice_preparations'::regclass and contype='u'
   and (select array_agg(a.attname::text order by k.ord) from unnest(conkey) with ordinality k(attnum,ord)
    join pg_attribute a on a.attrelid=conrelid and a.attnum=k.attnum)=array['company_id','id'])
  or not exists(select 1 from pg_attribute where attrelid='private.sc010c_voice_preparations'::regclass
   and attname='provider_key_digest' and not attisdropped) then
  raise exception 'voice_dispatch_preparation_key_missing' using errcode='55000';end if;
end $preflight$;

-- SC-011-B2 dispatch ledger (source: db/isolated/sc011b2-voice-dispatch.sql).

create table private.sc011b_voice_attempts (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 preparation_id uuid not null,
 candidate_id uuid not null,
 provider_account_id text not null
  check(provider_account_id ~ '^(agent_[A-Za-z0-9]{16,64}|[A-Za-z0-9]{32})$'),
 provider_call_id text not null unique
  check(provider_call_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
 status text not null default 'accepted'
  check(status in ('accepted','ringing','connected','completed','failed','cancelled','unknown')),
 outcome text check(outcome in
  ('completed','dnc_requested','no_answer','busy','voicemail','provider_error','other')),
 dnc_requested boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check(dnc_requested = (outcome is not distinct from 'dnc_requested')),
 unique(company_id,id),
 -- One provider call per prepared operation; a redial needs a new preparation.
 unique(company_id,preparation_id),
 foreign key(company_id,preparation_id)
  references private.sc010c_voice_preparations(company_id,id) on delete restrict
);
create index sc011b_attempt_candidate_idx on private.sc011b_voice_attempts(company_id,candidate_id);

-- Retell retries a delivery up to 3 times; the receipt id is stable per
-- (event, call id). Ignored events are kept without a tenant; an event for an
-- unknown call id gets no receipt so its retry can apply once dispatch commits.
create table private.sc011b_voice_webhook_receipts (
 receipt_id text primary key check(receipt_id ~ '^[0-9a-f]{64}$'),
 company_id uuid,
 attempt_id uuid,
 event text not null check(event in ('call_started','call_ended','call_analyzed','other')),
 result text not null check(result in
  ('applied','duplicate_status','ignored_terminal','out_of_order','recorded','ignored','uncorrelated')),
 received_at timestamptz not null default clock_timestamp(),
 check((company_id is null) = (attempt_id is null)),
 foreign key(company_id,attempt_id)
  references private.sc011b_voice_attempts(company_id,id) on delete restrict
);

create function private.sc011b_attempt_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_ATTEMPT_IMMUTABLE';
 end if;
 if tg_op='INSERT' then
  select * into prep from private.sc010c_voice_preparations
   where company_id=new.company_id and id=new.preparation_id for share;
  if not found or prep.state<>'prepared_offline' then
   raise exception using errcode='PT409',message='VOICE_ATTEMPT_UNAVAILABLE';
  end if;
  perform private.erasure_lock_candidate(prep.candidate_id);
  new.candidate_id:=prep.candidate_id;
  if new.status<>'accepted' or new.outcome is not null or new.dnc_requested then
   raise exception using errcode='42501',message='VOICE_ATTEMPT_INVALID_STATE';
  end if;
  return new;
 end if;
 perform private.erasure_lock_candidate(old.candidate_id);
 -- Only provider progress may change, and a terminal status never moves again.
 -- The one exception: a candidate's late request not to be called again is
 -- still recorded on a finished attempt (status kept, so nothing resettles).
 if (to_jsonb(new)-array['status','outcome','dnc_requested','updated_at']) is distinct from
    (to_jsonb(old)-array['status','outcome','dnc_requested','updated_at'])
  or (old.status in ('completed','failed','cancelled') and new is distinct from old
      and not (new.status=old.status and not old.dnc_requested and new.dnc_requested)) then
  raise exception using errcode='42501',message='VOICE_ATTEMPT_IMMUTABLE';
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end;$$;
create trigger sc011b_attempt_guard before insert or update or delete
 on private.sc011b_voice_attempts for each row execute function private.sc011b_attempt_guard();
create trigger sc011b_attempt_no_truncate before truncate
 on private.sc011b_voice_attempts for each statement execute function private.sc011b_attempt_guard();

create function private.sc011b_receipt_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_WEBHOOK_RECEIPT_IMMUTABLE';
 end if;
 -- A correlated receipt is candidate data: serialize it on the candidate row and
 -- refuse it while the candidate is frozen for erasure, like its attempt.
 if new.attempt_id is not null then
  perform private.erasure_lock_candidate((select a.candidate_id from private.sc011b_voice_attempts a
   where a.company_id=new.company_id and a.id=new.attempt_id));
 end if;
 return new;
end;$$;
create trigger sc011b_receipt_guard before insert or update or delete
 on private.sc011b_voice_webhook_receipts for each row execute function private.sc011b_receipt_guard();
create trigger sc011b_receipt_no_truncate before truncate
 on private.sc011b_voice_webhook_receipts for each statement execute function private.sc011b_receipt_guard();

-- Once a call left, the offline preparation can no longer be cancelled/refunded.
create function private.sc011b_block_cancel_after_dispatch() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.sc011b_voice_attempts
   where company_id=old.company_id and preparation_id=old.id) then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_DISPATCHED';
 end if;
 return new;
end;$$;
create trigger sc011b_block_cancel_after_dispatch before update
 on private.sc010c_voice_preparations for each row
 when (new.state='cancelled_offline' and old.state='prepared_offline')
 execute function private.sc011b_block_cancel_after_dispatch();

alter table private.sc011b_voice_attempts enable row level security;
alter table private.sc011b_voice_webhook_receipts enable row level security;
alter table private.sc011b_voice_attempts force row level security;
alter table private.sc011b_voice_webhook_receipts force row level security;
-- Same hardening as SC-010-C: every new object is private even when its owner
-- has unsafe default grants. Remove all non-owner recipients and grant options.
do $$
declare t text; f record; recipient record;
begin
 foreach t in array array['sc011b_voice_attempts','sc011b_voice_webhook_receipts'] loop
  execute pg_catalog.format('revoke all on table private.%I from public cascade',t);
  for recipient in
   select distinct a.grantee from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    where c.oid=pg_catalog.format('private.%I',t)::pg_catalog.regclass
     and a.grantee<>0 and a.grantee<>c.relowner
  loop
   execute pg_catalog.format('revoke all on table private.%I from %I cascade',t,
    pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
 end loop;
 for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
  from pg_catalog.pg_proc p where p.oid in (
   'private.sc011b_attempt_guard()'::pg_catalog.regprocedure,
   'private.sc011b_receipt_guard()'::pg_catalog.regprocedure,
   'private.sc011b_block_cancel_after_dispatch()'::pg_catalog.regprocedure
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

-- SC-011-B5 once-only dispatch claims (source: db/isolated/sc011b5-voice-dispatch-worker.sql).

create table private.sc011b_voice_dispatches (
 company_id uuid not null,
 preparation_id uuid not null,
 state text not null default 'sending' check(state in ('sending','accepted','rejected','unknown','abandoned')),
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
language plpgsql security invoker set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
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
       or (old.state='unknown' and new.state='accepted' and new.attempts=old.attempts)
       -- Only the SC-011-B6 operator resolution may abandon an unknown claim.
       or (old.state='unknown' and new.state='abandoned' and new.attempts=old.attempts
           -- An unset setting is NULL: coalesce so absence is a refusal, never unknown.
           and coalesce(pg_catalog.current_setting('skillcheck.sc011b_resolution',true),'')='on')) then
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

-- A request Retell refused as invalid never left (or an operator confirmed an
-- unknown one never did): drop the offline preparation and return its
-- reserved interview to the pool, in the same transaction.
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
 for each row when ((new.state='rejected' and old.state='sending') or (new.state='abandoned' and old.state='unknown'))
 execute function private.sc011b_dispatch_rejected();

-- While a call may have left (sending, accepted or unknown), the preparation
-- cannot be cancelled and refunded offline.
create function private.sc011b_block_cancel_while_dispatching() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.sc011b_voice_dispatches
   where company_id=old.company_id and preparation_id=old.id and state not in ('rejected','abandoned')) then
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

-- Row keys of the two new tables without an id column; every other adapter keeps
-- its key (this function was last defined by 20261119120000, R19).
create or replace function private.erasure_purge_key(adapter text,data jsonb) returns text
language sql immutable set search_path='' as $$
 select case
 when adapter='private.voice_plan_request_keys' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
 when adapter='private.sc010c_voice_preparation_requests' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'request_key')
 when adapter='private.voice_interview_permission_revocations' then data->>'company_id'||':'||(data->>'receipt_id')
 when adapter='private.sc011b_voice_dispatches' then data->>'company_id'||':'||(data->>'preparation_id')
 when adapter='private.sc011b_voice_webhook_receipts' then data->>'receipt_id'
 when adapter in ('private.contact_requests','private.erasure_configuration_requests','private.erasure_lifecycle_commands') then data->>'actor_id'||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter in ('private.erasure_candidate_lifecycle','private.retention_candidate_clocks') then data->>'candidate_id'
 when adapter='private.erasure_denial_context' then data->>'txid'||':'||(data->>'candidate_id')
 else data->>'id' end
$$;

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r19;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r19;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];prep jsonb;attempt jsonb;
begin
 if adapter in ('private.sc011b_voice_attempts','private.sc011b_voice_dispatches') then
  -- A call attempt or dispatch claim belongs to every subject of its preparation
  -- (purging any of them deletes the preparation, which these rows reference).
  select to_jsonb(p) into prep from private.sc010c_voice_preparations p
   where p.company_id=(data->>'company_id')::uuid and p.id=(data->>'preparation_id')::uuid;
  if prep is null then raise exception using errcode='PT409',message='Unknown voice dispatch dependency';end if;
  select array_agg(distinct id order by id) into ids from unnest(
   private.erasure_row_candidates('private.sc010c_voice_preparations',prep)||array[(data->>'candidate_id')::uuid]) id
   where id is not null;
  return ids;
 end if;
 if adapter='private.sc011b_voice_webhook_receipts' then
  -- An ignored or uncorrelated delivery carries no tenant and no candidate.
  if data->>'attempt_id' is null then return '{}'::uuid[];end if;
  select to_jsonb(a) into attempt from private.sc011b_voice_attempts a
   where a.company_id=(data->>'company_id')::uuid and a.id=(data->>'attempt_id')::uuid;
  if attempt is null then raise exception using errcode='PT409',message='Unknown voice dispatch dependency';end if;
  return private.erasure_row_candidates('private.sc011b_voice_attempts',attempt);
 end if;
 return private.erasure_row_candidates_r19(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r19(tenant,subjects)
 union all select 'private.sc011b_voice_attempts',private.erasure_purge_key('private.sc011b_voice_attempts',to_jsonb(t)),to_jsonb(t) from private.sc011b_voice_attempts t where t.company_id=tenant and (private.erasure_row_candidates('private.sc011b_voice_attempts',to_jsonb(t)) && subjects)
 union all select 'private.sc011b_voice_webhook_receipts',private.erasure_purge_key('private.sc011b_voice_webhook_receipts',to_jsonb(t)),to_jsonb(t) from private.sc011b_voice_webhook_receipts t where t.company_id=tenant and (private.erasure_row_candidates('private.sc011b_voice_webhook_receipts',to_jsonb(t)) && subjects)
 union all select 'private.sc011b_voice_dispatches',private.erasure_purge_key('private.sc011b_voice_dispatches',to_jsonb(t)),to_jsonb(t) from private.sc011b_voice_dispatches t where t.company_id=tenant and (private.erasure_row_candidates('private.sc011b_voice_dispatches',to_jsonb(t)) && subjects)
$$;
create table private.erasure_inventory_baseline_r20 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r20 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r20
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r20 select true,'1a657cdd163107054029c177c44c66e44a05ad5615a374fb85466c30bc95b806',
 known_tables||array['private.sc011b_voice_attempts','private.sc011b_voice_webhook_receipts','private.sc011b_voice_dispatches','private.erasure_inventory_baseline_r20']
 from private.erasure_inventory_baseline_r19 where singleton;

-- Normal writes of attempts and claims take the candidate lock and refuse frozen
-- candidates (R18 voice guard). A webhook receipt has no candidate column and may
-- carry no tenant; its own guard takes the candidate lock when it is correlated.
create trigger erasure_voice_guard before insert or update or delete on private.sc011b_voice_attempts
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.sc011b_voice_attempts
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.sc011b_voice_attempts for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc011b_voice_attempts',to_jsonb(sc011b_voice_attempts)));
create policy erasure_purge_delete on private.sc011b_voice_attempts for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc011b_voice_attempts',to_jsonb(sc011b_voice_attempts)));
create trigger zz_retention_observed after insert or update or delete on private.sc011b_voice_webhook_receipts
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.sc011b_voice_webhook_receipts for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc011b_voice_webhook_receipts',to_jsonb(sc011b_voice_webhook_receipts)));
create policy erasure_purge_delete on private.sc011b_voice_webhook_receipts for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc011b_voice_webhook_receipts',to_jsonb(sc011b_voice_webhook_receipts)));
create trigger erasure_voice_guard before insert or update or delete on private.sc011b_voice_dispatches
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.sc011b_voice_dispatches
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.sc011b_voice_dispatches for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc011b_voice_dispatches',to_jsonb(sc011b_voice_dispatches)));
create policy erasure_purge_delete on private.sc011b_voice_dispatches for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc011b_voice_dispatches',to_jsonb(sc011b_voice_dispatches)));

create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r20;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 if scope_kind is null or scope_kind not in ('candidate_record','confirmed_subject')
 or (scope_kind='candidate_record' and resolution_id is not null) or (scope_kind='confirmed_subject' and resolution_id is null)
 then raise exception using errcode='PT422',message='Invalid preview scope';end if;
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then
  select * into r from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant and anchor_candidate_id=target_candidate;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  subjects:=r.candidate_ids;
  if r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate)
   or r.confirmed_by<>auth.uid() then blockers:=array_append(blockers,'subject_resolution_changed');end if;
  if cardinality(subjects)<>(select count(*) from public.candidates where company_id=tenant and id=any(subjects)) then
   blockers:=array_append(blockers,'subject_resolution_changed');end if;
 else blockers:=array_append(blockers,'subject_resolution_required');end if;
 select * into p from private.candidate_retention_policies where company_id=tenant order by revision desc limit 1;
 if p.id is null then blockers:=array_append(blockers,'retention_policy_required');
 elsif jsonb_array_length(p.rules)<8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 if p.id is not null and p.approved_by<>auth.uid() then blockers:=array_append(blockers,'policy_owner_changed');end if;
 select * into baseline from private.erasure_inventory_baseline_r20 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  -- Preserve the R4-VOICE preview denial as well as its purge/restore adapters.
  -- The legacy R4 fixture has no voice module; SQL in this branch is planned
  -- only when the reviewed voice helper exists.
  if to_regprocedure('private.erasure_voice_request_candidate(uuid,text,uuid)') is not null then
    if exists(select 1 from private.voice_plan_request_keys t where t.company_id=tenant
      and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null)
    then blockers:=array_append(blockers,'voice_request_adapter_unknown');end if;
  end if;
  if exists(select 1 from private.contact_requests t where t.company_id=tenant
   and private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id) is null) then blockers:=array_append(blockers,'contact_request_adapter_unknown');end if;
  if exists(select 1 from public.screening_analysis_versions a join public.applications ap on ap.company_id=a.company_id and ap.id=a.application_id
   where ap.company_id=tenant and ap.candidate_id=any(subjects) and a.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
  if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.candidate_ids && subjects and not sr.candidate_ids <@ subjects)
   then blockers:=array_append(blockers,'shared_resolution_requires_adapter');end if;
  if exists(select 1 from private.competency_test_cancellations c where c.company_id=tenant
   and private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) && subjects
   and not private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) <@ subjects)
   then blockers:=array_append(blockers,'shared_competency_cancellation_requires_adapter');end if;
  with rows as materialized(select * from private.erasure_inventory_rows(tenant,subjects)),
  grouped as(select adapter,count(*) n from rows group by adapter)
  select coalesce((select jsonb_object_agg(adapter,n) from grouped),'{}'::jsonb),
   coalesce((select jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key) from rows),'[]'::jsonb)
  into counts,row_digest;
 end if;
 manifest:=private.erasure_hash(jsonb_build_object('contract','sc010-r1-v1','tenant',tenant,'owner',auth.uid(),'scope',scope_kind,'subjects',subjects,
 'resolution',to_jsonb(r),'current_resolution_revision',(select coalesce(max(revision),0) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate),
 'policy',to_jsonb(p),'schema',signature,'rows',row_digest,'blockers',blockers));
 return jsonb_build_object('scope_kind',scope_kind,'candidate_count',cardinality(subjects),'counts',counts,'blockers',to_jsonb(blockers),
 'policy_revision',coalesce(p.revision,0),'resolution_revision',coalesce(r.revision,0),'manifest_hash',manifest,'schema_signature',signature,
 'generated_at',generated,'expires_at',generated+interval '5 minutes','execution_enabled',false);
end;$$;

create or replace function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R4 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r20 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;

create or replace function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r20 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,d.id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash'<>s.evidence_hash then raise exception using errcode='PT409',message='Retention eligibility changed';end if;
 if exists(select 1 from unnest(s.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 select * into r from private.erasure_subject_resolutions where id=s.resolution_id;
 -- Fixed graph checks, with unknown schema/JSON/dependencies rejected by the R3 adapter before commit.
 if exists(select 1 from private.contact_requests c where c.company_id=s.company_id and private.erasure_contact_request_candidate(c.company_id,c.operation,c.payload,c.result_id) is null) then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,'confirmed_subject',r.id,s.candidate_ids,s.evidence_hash,private.erasure_generation_snapshot(s.candidate_ids),issued,issued+interval '5 minutes') returning id into ticket;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,s.candidate_ids,'confirmed_subject',ticket,s.evidence_hash,d.policy_revision,r.revision,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,s.company_id,1,'frozen',result from unnest(s.candidate_ids) x(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 authz:=jsonb_build_object('kind','retention_policy','actor_id',d.owner_id,'delegation_id',d.id,'activation_revision',d.revision,'policy_revision',d.policy_revision,'due_generation',s.due_generation,'due_at',s.due_at,'evidence_hash',s.evidence_hash);
 insert into private.retention_authorizations(request_id,authorization_json) values(result,authz);
 update private.retention_suggestions set status='authorized',request_id=result,blockers='[]'::jsonb where id=s.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(s.company_id,result,d.owner_id,'authorized',1);
 -- Reuse the complete reviewed R3 scope validator inside this transaction. This
 -- temporary non-exportable execution never receives a reservation or ledger ACK.
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
 select result,s.company_id,s.candidate_ids,'confirmed_subject',d.owner_id,jsonb_build_object('revision',p2.revision,'rules',p2.rules),r.revision,1,'authorized',clock_timestamp()+interval '1 second'
 from private.candidate_retention_policies p2 where p2.id=d.policy_id;
 perform private.erasure_check_purge_scope(result);
 delete from private.erasure_executions where request_id=result;
 return result;
end;$$;

create or replace function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;p private.candidate_retention_policies;schema_ok boolean;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r20 where singleton);
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),
 'authorization_enabled',coalesce(schema_ok and not d.revoked and d.execution_mode='automatic' and d.owner_id=auth.uid() and d.policy_id=p.id and d.policy_revision=p.revision and p.approved_by=auth.uid()
  and c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated,false),
 'production_ready',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end || case when schema_ok then '[]'::jsonb else jsonb_build_array('schema_dependency_unknown') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;

-- PG16+ non-superuser creators retain ADMIN only. Ownership transfers need
-- SET plus schema CREATE, confined to this transaction and restored below.
create temporary table sc010_purge_migration_access on commit drop as
 select (select rolsuper from pg_roles where rolname=current_user) superuser,
   (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    from pg_auth_members m where m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole) memberships,
   (select nspacl from pg_namespace where nspname='private') schema_acl;
do $$begin
 if current_user<>session_user then raise exception 'Migration identity must be direct';end if;
 if has_schema_privilege('erasure_purge_owner','private','CREATE') then
   raise exception 'Unsafe purge owner schema privileges';
 end if;
 if not (select superuser from pg_temp.sc010_purge_migration_access) then
   if current_user<>'postgres' or exists(select 1 from pg_auth_members m
     where (m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole)
       and not (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid='erasure_purge_owner'::regrole and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option)) or not exists(select 1 from pg_auth_members m where (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid='erasure_purge_owner'::regrole and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option)) then
     raise exception 'Unsafe purge owner migration membership';
   end if;
   grant erasure_purge_owner to postgres with admin false, inherit false, set true;
 end if;
 grant create on schema private to erasure_purge_owner;
end;$$;







set local role erasure_purge_owner;
create or replace function private.erasure_purge_engine(target_request uuid,expected_sequence bigint,restoring boolean) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;receipt uuid;c record;deleted_count bigint;expected_count bigint;deleted_counts jsonb:='{}';event_row public.candidate_communication_events;begin
 perform private.erasure_validate_purge(target_request,expected_sequence,restoring);
 select * into e from private.erasure_executions where request_id=target_request;
 if e.local_purged then return jsonb_build_object('receipt_id',e.receipt_id,'phase','active_data_erased','counts',e.counts);end if;
 insert into private.erasure_purge_context values(txid_current(),e.request_id,e.company_id,e.manifest_hash,'cancel');
 insert into private.erasure_purge_context_rows select txid_current(),adapter,row_key,row_hash,'delete' from private.erasure_purge_manifest where request_id=e.request_id and manifest_hash=e.manifest_hash;
 -- The authoritative erasing ACK precedes the first irreversible cancellation.
 for c in select * from public.candidate_communications where state='draft' loop
  update public.candidate_communications set state='cancelled',version=version+1,cancelled_at=now(),updated_at=now() where id=c.id;
  update private.erasure_purge_context_rows set row_hash=(select private.erasure_hash(to_jsonb(x)) from public.candidate_communications x where x.id=c.id) where txid=txid_current() and adapter='public.candidate_communications' and row_key=c.id::text;
  event_row:=row(gen_random_uuid(),e.company_id,c.id,'cancelled',e.owner_id,now())::public.candidate_communication_events;
  insert into private.erasure_purge_context_rows values(txid_current(),'public.candidate_communication_events',event_row.id::text,private.erasure_hash(to_jsonb(event_row)),'insert');
  insert into public.candidate_communication_events select event_row.*;
  update private.erasure_purge_context_rows set command='delete' where txid=txid_current() and adapter='public.candidate_communication_events' and row_key=event_row.id::text;
 end loop;
 update private.erasure_purge_context set mode='delete' where txid=txid_current();
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc011b_voice_webhook_receipts';
 delete from private.sc011b_voice_webhook_receipts t where private.erasure_purge_allowed('private.sc011b_voice_webhook_receipts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.sc011b_voice_webhook_receipts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc011b_voice_attempts';
 delete from private.sc011b_voice_attempts t where private.erasure_purge_allowed('private.sc011b_voice_attempts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.sc011b_voice_attempts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc011b_voice_dispatches';
 delete from private.sc011b_voice_dispatches t where private.erasure_purge_allowed('private.sc011b_voice_dispatches',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.sc011b_voice_dispatches',deleted_count);
 -- Lock shared voice pool quotas in a deterministic order before per-row refunds.
 perform private.erasure_voice_lock_entitlements(e.company_id);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc010c_voice_preparation_requests';
 delete from private.sc010c_voice_preparation_requests t where private.erasure_purge_allowed('private.sc010c_voice_preparation_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.sc010c_voice_preparation_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc010c_voice_preparations';
 delete from private.sc010c_voice_preparations t where private.erasure_purge_allowed('private.sc010c_voice_preparations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.sc010c_voice_preparations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_interview_permission_revocations';
 delete from private.voice_interview_permission_revocations t where private.erasure_purge_allowed('private.voice_interview_permission_revocations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_interview_permission_revocations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_interview_permission_receipts';
 delete from private.voice_interview_permission_receipts t where private.erasure_purge_allowed('private.voice_interview_permission_receipts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_interview_permission_receipts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_request_keys';
 delete from private.voice_plan_request_keys t where private.erasure_purge_allowed('private.voice_plan_request_keys',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_plan_request_keys',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_current_releases';
 delete from private.voice_plan_current_releases t where private.erasure_purge_allowed('private.voice_plan_current_releases',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_plan_current_releases',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_release_entries';
 delete from private.voice_plan_release_entries t where private.erasure_purge_allowed('private.voice_plan_release_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_plan_release_entries',deleted_count);
 for c in select * from public.voice_plan_versions order by company_id,application_id,plan_version desc loop
  delete from private.voice_plan_review_entries t where t.company_id=c.company_id and t.plan_id=c.id
   and private.erasure_purge_allowed('private.voice_plan_review_entries',to_jsonb(t));
  get diagnostics deleted_count=row_count;
  deleted_counts:=jsonb_set(deleted_counts,'{private.voice_plan_review_entries}',to_jsonb(coalesce((deleted_counts->>'private.voice_plan_review_entries')::bigint,0)+deleted_count));
  delete from public.voice_plan_versions t where t.id=c.id and private.erasure_purge_allowed('public.voice_plan_versions',to_jsonb(t));
  get diagnostics deleted_count=row_count;
  if deleted_count<>1 then raise exception using errcode='PT409',message='Purge plan manifest changed';end if;
  deleted_counts:=jsonb_set(deleted_counts,'{public.voice_plan_versions}',to_jsonb(coalesce((deleted_counts->>'public.voice_plan_versions')::bigint,0)+deleted_count));
 end loop;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.voice_plan_versions';
 if coalesce((deleted_counts->>'public.voice_plan_versions')::bigint,0)<>expected_count then raise exception using errcode='PT409',message='Purge plan count changed';end if;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_review_entries';
 if coalesce((deleted_counts->>'private.voice_plan_review_entries')::bigint,0)<>expected_count then raise exception using errcode='PT409',message='Purge review count changed';end if;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.process_followup_observations';
 delete from private.process_followup_observations t where private.erasure_purge_allowed('private.process_followup_observations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.process_followup_observations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.process_followup_grants';
 delete from private.process_followup_grants t where private.erasure_purge_allowed('private.process_followup_grants',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.process_followup_grants',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.process_followup_cases';
 delete from private.process_followup_cases t where private.erasure_purge_allowed('private.process_followup_cases',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.process_followup_cases',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_session_entries';
 delete from private.ac_session_entries t where private.erasure_purge_allowed('private.ac_session_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_session_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_reconciliations';
 delete from private.ac_reconciliations t where private.erasure_purge_allowed('private.ac_reconciliations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_reconciliations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_session_finalists';
 delete from private.ac_session_finalists t where private.erasure_purge_allowed('private.ac_session_finalists',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_session_finalists',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_paired_sheets';
 delete from private.ac_paired_sheets t where private.erasure_purge_allowed('private.ac_paired_sheets',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_paired_sheets',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_drafts';
 delete from private.competency_test_drafts t where private.erasure_purge_allowed('private.competency_test_drafts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_drafts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.competency_test_review_entries';
 delete from public.competency_test_review_entries t where private.erasure_purge_allowed('public.competency_test_review_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.competency_test_review_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_sessions';
 delete from private.competency_test_sessions t where private.erasure_purge_allowed('private.competency_test_sessions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_sessions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_grant_events';
 delete from private.competency_test_grant_events t where private.erasure_purge_allowed('private.competency_test_grant_events',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_grant_events',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.competency_test_attempts';
 delete from public.competency_test_attempts t where private.erasure_purge_allowed('public.competency_test_attempts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.competency_test_attempts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_grants';
 delete from private.competency_test_grants t where private.erasure_purge_allowed('private.competency_test_grants',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_grants',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_cancellations';
 delete from private.competency_test_cancellations t where private.erasure_purge_allowed('private.competency_test_cancellations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_cancellations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.retention_suggestions';
 delete from private.retention_suggestions t where private.erasure_purge_allowed('private.retention_suggestions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.retention_suggestions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.retention_candidate_clocks';
 delete from private.retention_candidate_clocks t where private.erasure_purge_allowed('private.retention_candidate_clocks',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.retention_candidate_clocks',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.contact_requests';
 delete from private.contact_requests t where private.erasure_purge_allowed('private.contact_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.contact_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_communication_approvals';
 delete from public.candidate_communication_approvals t where private.erasure_purge_allowed('public.candidate_communication_approvals',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_communication_approvals',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_communication_events';
 delete from public.candidate_communication_events t where private.erasure_purge_allowed('public.candidate_communication_events',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_communication_events',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_communications';
 delete from public.candidate_communications t where private.erasure_purge_allowed('public.candidate_communications',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_communications',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.candidate_verified_contact_receipts';
 delete from private.candidate_verified_contact_receipts t where private.erasure_purge_allowed('private.candidate_verified_contact_receipts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.candidate_verified_contact_receipts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.candidate_verified_contact_points';
 delete from private.candidate_verified_contact_points t where private.erasure_purge_allowed('private.candidate_verified_contact_points',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.candidate_verified_contact_points',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_contact_permissions';
 delete from public.candidate_contact_permissions t where private.erasure_purge_allowed('public.candidate_contact_permissions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_contact_permissions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_contact_preferences';
 delete from public.candidate_contact_preferences t where private.erasure_purge_allowed('public.candidate_contact_preferences',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_contact_preferences',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.contact_audit';
 delete from private.contact_audit t where private.erasure_purge_allowed('private.contact_audit',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.contact_audit',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.recruitment_shortlist_entries';
 delete from public.recruitment_shortlist_entries t where private.erasure_purge_allowed('public.recruitment_shortlist_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.recruitment_shortlist_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_criterion_review_overrides';
 delete from public.screening_criterion_review_overrides t where private.erasure_purge_allowed('public.screening_criterion_review_overrides',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_criterion_review_overrides',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_result_reviews';
 delete from public.screening_result_reviews t where private.erasure_purge_allowed('public.screening_result_reviews',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_result_reviews',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_criterion_results';
 delete from public.screening_criterion_results t where private.erasure_purge_allowed('public.screening_criterion_results',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_criterion_results',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_analysis_attempts';
 delete from public.screening_analysis_attempts t where private.erasure_purge_allowed('public.screening_analysis_attempts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_analysis_attempts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_analysis_versions';
 delete from public.screening_analysis_versions t where private.erasure_purge_allowed('public.screening_analysis_versions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_analysis_versions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.exercise_observation_entries';
 delete from public.exercise_observation_entries t where private.erasure_purge_allowed('public.exercise_observation_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.exercise_observation_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.behavior_assessment_entries';
 delete from public.behavior_assessment_entries t where private.erasure_purge_allowed('public.behavior_assessment_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.behavior_assessment_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_assessments';
 delete from public.candidate_assessments t where private.erasure_purge_allowed('public.candidate_assessments',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_assessments',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_configuration_requests';
 delete from private.erasure_configuration_requests t where private.erasure_purge_allowed('private.erasure_configuration_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_configuration_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_holds';
 delete from private.erasure_holds t where private.erasure_purge_allowed('private.erasure_holds',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_holds',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_lifecycle_commands';
 delete from private.erasure_lifecycle_commands t where private.erasure_purge_allowed('private.erasure_lifecycle_commands',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_lifecycle_commands',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_lifecycle_events';
 delete from private.erasure_lifecycle_events t where private.erasure_purge_allowed('private.erasure_lifecycle_events',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_lifecycle_events',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_candidate_lifecycle';
 delete from private.erasure_candidate_lifecycle t where private.erasure_purge_allowed('private.erasure_candidate_lifecycle',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_candidate_lifecycle',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_requests';
 delete from private.erasure_requests t where private.erasure_purge_allowed('private.erasure_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_preview_tickets';
 delete from private.erasure_preview_tickets t where private.erasure_purge_allowed('private.erasure_preview_tickets',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_preview_tickets',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_subject_resolutions';
 delete from private.erasure_subject_resolutions t where private.erasure_purge_allowed('private.erasure_subject_resolutions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_subject_resolutions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_denial_context';
 delete from private.erasure_denial_context t where private.erasure_purge_allowed('private.erasure_denial_context',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_denial_context',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.applications';
 delete from public.applications t where private.erasure_purge_allowed('public.applications',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.applications',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_documents';
 delete from public.candidate_documents t where private.erasure_purge_allowed('public.candidate_documents',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_documents',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidates';
 delete from public.candidates t where private.erasure_purge_allowed('public.candidates',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidates',deleted_count);

 insert into private.erasure_receipts(company_id,policy_revision,phase,counts) values(e.company_id,(e.policy_copy->>'revision')::bigint,'active_data_erased',deleted_counts) returning id into receipt;
 update private.erasure_executions set local_purged=true,receipt_id=receipt,counts=deleted_counts where request_id=e.request_id;
 delete from private.erasure_purge_manifest where request_id=e.request_id;
 delete from private.erasure_purge_context_rows where txid=txid_current();
 delete from private.erasure_purge_context where txid=txid_current();
 return jsonb_build_object('receipt_id',receipt,'phase','active_data_erased','counts',deleted_counts);
exception when lock_not_available then
 raise exception using errcode='PT409',message='Erasure source busy';
end;$$;
reset role;
do $$begin
 revoke create on schema private from erasure_purge_owner;
 if not (select superuser from pg_temp.sc010_purge_migration_access) then
   revoke erasure_purge_owner from postgres granted by postgres;
 end if;
 if (select nspacl from pg_namespace where nspname='private') is distinct from
      (select schema_acl from pg_temp.sc010_purge_migration_access) or
   has_schema_privilege('erasure_purge_owner','private','CREATE') or
   (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    from pg_auth_members m where m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole)
      is distinct from (select memberships from pg_temp.sc010_purge_migration_access) then
   raise exception 'Purge migration privileges not restored';
 end if;
end;$$;














-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('private.sc011b_voice_attempts'::regclass,'private.sc011b_voice_webhook_receipts'::regclass,'private.sc011b_voice_dispatches'::regclass,'private.erasure_inventory_baseline_r20'::regclass) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.sc011b_attempt_guard()',
  'private.sc011b_receipt_guard()',
  'private.sc011b_dispatch_guard()',
  'private.sc011b_block_cancel_after_dispatch()',
  'private.sc011b_dispatch_rejected()',
  'private.sc011b_block_cancel_while_dispatching()',
  'private.erasure_row_candidates(text,jsonb)',
  'private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant select,delete on private.sc011b_voice_attempts,private.sc011b_voice_webhook_receipts,private.sc011b_voice_dispatches to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '1a657cdd163107054029c177c44c66e44a05ad5615a374fb85466c30bc95b806' then
  raise exception 'voice_dispatch_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r20 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_dispatch_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-9])([^0-9]|$)') then
  raise exception 'voice_dispatch_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r20%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_dispatch_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r19(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r19(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_dispatch_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid in ('private.sc011b_voice_attempts'::regclass,'private.sc011b_voice_webhook_receipts'::regclass,'private.sc011b_voice_dispatches'::regclass)
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_dispatch_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array['private.sc011b_attempt_guard()','private.sc011b_receipt_guard()','private.sc011b_dispatch_guard()','private.sc011b_block_cancel_after_dispatch()','private.sc011b_dispatch_rejected()','private.sc011b_block_cancel_while_dispatching()','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_dispatch_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array['private.sc011b_block_cancel_after_dispatch()','private.sc011b_dispatch_rejected()','private.sc011b_block_cancel_while_dispatching()','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array['private.sc011b_attempt_guard()','private.sc011b_receipt_guard()','private.sc011b_dispatch_guard()','private.sc011b_block_cancel_after_dispatch()','private.sc011b_dispatch_rejected()','private.sc011b_block_cancel_while_dispatching()','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_dispatch_definer_search_path' using errcode='55000';end if;
 -- Purge-aware guards run as the caller, never as their owner.
 if exists(select 1 from pg_proc where oid=any(array['private.sc011b_attempt_guard()','private.sc011b_receipt_guard()',
  'private.sc011b_dispatch_guard()']::regprocedure[]) and prosecdef) then
  raise exception 'voice_dispatch_guard_definer' using errcode='55000';end if;
end $postflight$;
commit;
