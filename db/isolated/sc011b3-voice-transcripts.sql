-- SC-011-B3 voice interview transcripts, installed only in a disposable test
-- database after sc011b2-voice-dispatch.sql. No public RPC/grant or migration.
-- Retention (owner decision 2026-10-30): kept while the recruitment is not
-- closed and for 90 days after it closes; reopening the recruitment pauses it.
-- Like the SC-010-C and B2 tables, this candidate-linked table MUST gain a
-- reviewed erasure/restore adapter before deployment.
begin;

create table private.sc011b_voice_transcripts (
 attempt_id uuid primary key,
 company_id uuid not null,
 recruitment_id uuid not null,
 candidate_id uuid not null,
 -- Minimized by lib/voice/retell-webhook.ts: [{speaker: agent|candidate, text}].
 utterances jsonb not null check(
  jsonb_typeof(utterances)='array' and jsonb_array_length(utterances) between 1 and 400 and
  pg_column_size(utterances) <= 262144),
 received_at timestamptz not null default clock_timestamp(),
 unique(company_id,attempt_id),
 foreign key(company_id,attempt_id)
  references private.sc011b_voice_attempts(company_id,id) on delete restrict,
 foreign key(company_id,recruitment_id)
  references public.recruitments(company_id,id) on delete restrict
);
create index sc011b_transcript_recruitment_idx on private.sc011b_voice_transcripts(company_id,recruitment_id);
create index sc011b_transcript_candidate_idx on private.sc011b_voice_transcripts(company_id,candidate_id);

create function private.sc011b_transcript_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare a private.sc011b_voice_attempts; prep private.sc010c_voice_preparations;
begin
 if tg_op='TRUNCATE' or tg_op='UPDATE' then
  raise exception using errcode='42501',message='VOICE_TRANSCRIPT_IMMUTABLE';
 end if;
 if tg_op='DELETE' then
  -- Only the retention purge below may delete.
  if pg_catalog.current_setting('skillcheck.sc011b_transcript_purge',true) is distinct from 'on' then
   raise exception using errcode='42501',message='VOICE_TRANSCRIPT_IMMUTABLE';
  end if;
  return old;
 end if;
 select * into a from private.sc011b_voice_attempts
  where company_id=new.company_id and id=new.attempt_id for share;
 if not found or a.status<>'completed' then
  raise exception using errcode='PT409',message='VOICE_TRANSCRIPT_UNAVAILABLE';
 end if;
 select * into prep from private.sc010c_voice_preparations
  where company_id=a.company_id and id=a.preparation_id;
 perform private.erasure_lock_candidate(a.candidate_id);
 -- Tenant, candidate and recruitment always come from the dispatch record.
 new.candidate_id:=a.candidate_id;
 new.recruitment_id:=prep.recruitment_id;
 new.received_at:=clock_timestamp();
 return new;
end;$$;
create trigger sc011b_transcript_guard before insert or update or delete
 on private.sc011b_voice_transcripts for each row execute function private.sc011b_transcript_guard();
create trigger sc011b_transcript_no_truncate before truncate
 on private.sc011b_voice_transcripts for each statement execute function private.sc011b_transcript_guard();

-- Retention counts from closed_at, but a recruitment may be closed by changing
-- only its status. Stamp the closure time on every transition into 'closed'
-- unless the caller sets a new one; a re-close after reopening restarts it.
create function private.sc011b_recruitment_closed_at() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='closed' and (tg_op='INSERT' or old.status<>'closed') and
    (new.closed_at is null or (tg_op='UPDATE' and new.closed_at is not distinct from old.closed_at)) then
  new.closed_at:=pg_catalog.now();
 end if;
 return new;
end;$$;
create trigger sc011b_recruitment_closed_at before insert or update of status on public.recruitments
 for each row execute function private.sc011b_recruitment_closed_at();

-- Deletes transcripts of recruitments closed for at least 90 days. Intended for
-- a trusted scheduler; returns the number of transcripts removed.
create function private.sc011b_purge_voice_transcripts() returns integer
language plpgsql volatile security definer set search_path='' as $$
declare removed integer;
begin
 perform pg_catalog.set_config('skillcheck.sc011b_transcript_purge','on',true);
 delete from private.sc011b_voice_transcripts t
  using public.recruitments r
  where r.company_id=t.company_id and r.id=t.recruitment_id
   and r.status='closed' and r.closed_at is not null
   and r.closed_at <= pg_catalog.clock_timestamp() - interval '90 days';
 get diagnostics removed = row_count;
 perform pg_catalog.set_config('skillcheck.sc011b_transcript_purge','off',true);
 return removed;
end;$$;

alter table private.sc011b_voice_transcripts enable row level security;
alter table private.sc011b_voice_transcripts force row level security;
-- Same hardening as SC-010-C and B2.
do $$
declare f record; recipient record;
begin
 execute 'revoke all on table private.sc011b_voice_transcripts from public cascade';
 for recipient in
  select distinct a.grantee from pg_catalog.pg_class c
   cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   where c.oid='private.sc011b_voice_transcripts'::pg_catalog.regclass
    and a.grantee<>0 and a.grantee<>c.relowner
 loop
  execute pg_catalog.format('revoke all on table private.sc011b_voice_transcripts from %I cascade',
   pg_catalog.pg_get_userbyid(recipient.grantee));
 end loop;
 for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
  from pg_catalog.pg_proc p where p.oid in (
   'private.sc011b_transcript_guard()'::pg_catalog.regprocedure,
   'private.sc011b_purge_voice_transcripts()'::pg_catalog.regprocedure,
   'private.sc011b_recruitment_closed_at()'::pg_catalog.regprocedure
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
