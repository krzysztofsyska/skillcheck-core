-- SC-011-B2 dispatch ledger and Retell webhook receipts, installed only in a
-- disposable test database after sc010c-voice-preparation.sql.
-- No public RPC/grant, migration or provider transport. The trusted worker
-- records the provider call id after a successful create-phone-call; webhooks
-- are correlated only through that id (Retell metadata stays empty).
-- These candidate-linked tables MUST gain reviewed erasure/restore adapters
-- before deployment, like the SC-010-C preparation tables.
begin;

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
-- (event, call id). Uncorrelated and ignored events are kept without a tenant.
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
language plpgsql security definer set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
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
 if (to_jsonb(new)-array['status','outcome','dnc_requested','updated_at']) is distinct from
    (to_jsonb(old)-array['status','outcome','dnc_requested','updated_at'])
  or (old.status in ('completed','failed','cancelled') and new is distinct from old) then
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
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_WEBHOOK_RECEIPT_IMMUTABLE';
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

revoke all on private.sc011b_voice_attempts, private.sc011b_voice_webhook_receipts from public, anon, authenticated;
revoke all on function private.sc011b_attempt_guard(), private.sc011b_receipt_guard(),
 private.sc011b_block_cancel_after_dispatch() from public, anon, authenticated;

commit;
