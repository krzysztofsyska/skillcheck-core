-- SC-011-B4 owner decisions of 2026-10-30, installed only in a disposable test
-- database after sc011b2-voice-dispatch.sql:
--  1. A candidate's in-call request not to be called again blocks every
--     further contact channel for that candidate.
--  2. Only a call that took place uses a voice interview from the FREE or
--     PRESELEKCJA pool; an unanswered, busy, voicemail or failed call releases
--     its reservation.
-- Both effects run inside the transaction that records the provider outcome.
begin;

create function private.sc011b_attempt_settlement() returns trigger
language plpgsql security definer set search_path='' as $$
declare entitlement uuid;
begin
 if new.dnc_requested and not old.dnc_requested then
  -- Reuses the existing enforcement: every permission/receipt check denies a
  -- blocked channel and a changed preference revision.
  -- TODO(migration): add source 'candidate_requested'; the column only admits
  -- 'operator_recorded' today. The attempt row keeps the provenance meanwhile.
  update public.candidate_contact_preferences
   set blocked_channels=array['email','sms','voice']::text[],revision=revision+1,updated_at=pg_catalog.now()
   where company_id=new.company_id and candidate_id=new.candidate_id;
  if not found then
   insert into public.candidate_contact_preferences
    (company_id,candidate_id,revision,timezone,weekday_windows,blocked_channels)
   values(new.company_id,new.candidate_id,1,'Europe/Warsaw','[]'::jsonb,array['email','sms','voice']::text[]);
  end if;
 end if;
 if old.status not in ('completed','failed','cancelled')
    and new.status in ('completed','failed','cancelled') then
  select entitlement_id into entitlement from private.sc010c_voice_preparations
   where company_id=new.company_id and id=new.preparation_id;
  if new.status='completed' then
   update private.sc19_voice_entitlements set used=used+1,reserved=reserved-1
    where company_id=new.company_id and id=entitlement;
  else
   update private.sc19_voice_entitlements set reserved=reserved-1
    where company_id=new.company_id and id=entitlement;
  end if;
  if not found then
   raise exception using errcode='PT409',message='VOICE_SETTLEMENT_UNAVAILABLE';
  end if;
 end if;
 return null;
end;$$;
create trigger sc011b_attempt_settlement after update on private.sc011b_voice_attempts
 for each row execute function private.sc011b_attempt_settlement();

do $$
declare recipient record;
begin
 execute 'revoke all on function private.sc011b_attempt_settlement() from public cascade';
 for recipient in
  select distinct a.grantee from pg_catalog.pg_proc p
   cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   where p.oid='private.sc011b_attempt_settlement()'::pg_catalog.regprocedure
    and a.grantee<>0 and a.grantee<>p.proowner
 loop
  execute pg_catalog.format('revoke all on function private.sc011b_attempt_settlement() from %I cascade',
   pg_catalog.pg_get_userbyid(recipient.grantee));
 end loop;
end;$$;

commit;
