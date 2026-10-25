-- SC-010-C ISOLATED ONLY. Apply after the complete existing migration chain in
-- a throwaway database. Not a migration, provisioning or production authority.
-- B2 verification_invitation never implies consent to a voice_interview.
-- This new graph intentionally keeps deployed erasure inventory fail-closed;
-- an explicit reviewed inventory/purge adapter remains required before deployment.
begin;

do $$
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='voice_permission_verifier') then
  create role voice_permission_verifier nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 elsif exists(select 1 from pg_catalog.pg_roles where rolname='voice_permission_verifier'
  and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r
   on r.oid=m.roleid or r.oid=m.member where r.rolname='voice_permission_verifier') then
  raise exception using errcode='42501',message='VOICE_INTERVIEW_PERMISSION_REJECTED';
 end if;
end;$$;
grant usage on schema private to voice_permission_verifier;

-- Immutable reviewed versions. Disabled is the default; synthetic administrative
-- fixtures explicitly insert approved versions. A version may only be disabled,
-- never edited, deleted or re-enabled. New reviewed content needs a new identity.
create table private.voice_interview_permission_policies (
 company_id uuid not null references public.companies(id) on delete restrict,
 notice_version text not null check(notice_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 policy_sha256 text not null check(policy_sha256 ~ '^[0-9a-f]{64}$'),
 purpose text not null default 'voice_interview' check(purpose='voice_interview'),
 recording_allowed boolean not null default false check(recording_allowed=false),
 enabled boolean not null default false, valid_from timestamptz not null, valid_until timestamptz not null,
 primary key(company_id,notice_version,policy_sha256), check(valid_until>valid_from)
);
create table private.voice_interview_permission_issuers (
 company_id uuid not null references public.companies(id) on delete restrict,
 issuer_id text not null check(issuer_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 key_id text not null check(key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 enabled boolean not null default false, valid_from timestamptz not null, valid_until timestamptz not null,
 primary key(company_id,issuer_id,key_id), check(valid_until>valid_from)
);
create table private.voice_interview_permission_receipts (
 id uuid primary key, company_id uuid not null, candidate_id uuid not null,
 recruitment_id uuid not null, application_id uuid not null, contact_receipt_id uuid not null,
 contact_version bigint not null check(contact_version between 1 and 9007199254740990),
 global_permission_revision bigint not null check(global_permission_revision between 0 and 9007199254740990),
 scoped_permission_revision bigint not null check(scoped_permission_revision between 0 and 9007199254740990),
 preference_revision bigint not null check(preference_revision between 0 and 9007199254740990),
 schema_version integer not null check(schema_version=1),
 proof_type text not null check(proof_type='voice_interview_permission_and_notice_received_v1'),
 channel text not null check(channel='voice'), purpose text not null check(purpose='voice_interview'),
 recording_allowed boolean not null check(recording_allowed=false),
 notice_version text not null, policy_sha256 text not null, issuer_id text not null, key_id text not null, nonce uuid not null,
 notice_received_at timestamptz not null, interview_permission_granted_at timestamptz not null,
 issued_at timestamptz not null, expires_at timestamptz not null,
 receipt_json jsonb not null check(jsonb_typeof(receipt_json)='object'), created_at timestamptz not null default clock_timestamp(),
 unique(company_id,id), unique(company_id,application_id,id), unique(company_id,issuer_id,key_id,nonce),
 foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict,
 foreign key(company_id,recruitment_id,candidate_id,application_id)
  references public.applications(company_id,recruitment_id,candidate_id,id) on delete restrict,
 foreign key(company_id,contact_receipt_id) references private.candidate_verified_contact_receipts(company_id,id) on delete restrict,
 foreign key(company_id,notice_version,policy_sha256)
  references private.voice_interview_permission_policies(company_id,notice_version,policy_sha256) on delete restrict,
 foreign key(company_id,issuer_id,key_id)
  references private.voice_interview_permission_issuers(company_id,issuer_id,key_id) on delete restrict,
 check(notice_received_at<=interview_permission_granted_at and interview_permission_granted_at<=issued_at
  and expires_at>issued_at and expires_at<=issued_at+interval '15 minutes' and notice_received_at>=issued_at-interval '15 minutes')
);
create index voice_interview_permission_receipts_candidate_idx on private.voice_interview_permission_receipts(company_id,candidate_id);
create index voice_interview_permission_receipts_contact_idx on private.voice_interview_permission_receipts(company_id,contact_receipt_id);
create index voice_interview_permission_receipts_policy_idx on private.voice_interview_permission_receipts(company_id,notice_version,policy_sha256);

-- Monotonic receipt withdrawal, separate from a deny for the entire voice channel.
-- No direct grant or public API is introduced. This administrative-only fixture
-- record demonstrates revocation independently of notice or invitation consent.
create table private.voice_interview_permission_revocations (
 company_id uuid not null, receipt_id uuid not null, revoked_at timestamptz not null default clock_timestamp(),
 primary key(company_id,receipt_id),
 foreign key(company_id,receipt_id) references private.voice_interview_permission_receipts(company_id,id) on delete restrict
);
create function private.voice_interview_permission_protect_history() returns trigger
language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end;$$;
create function private.voice_interview_permission_protect_registry() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and old.enabled and not new.enabled and
  (to_jsonb(old)-'enabled')=(to_jsonb(new)-'enabled') then return new;end if;
 raise exception using errcode='42501',message='VOICE_INTERVIEW_PERMISSION_REJECTED';
end;$$;
create trigger immutable_history before update or delete on private.voice_interview_permission_receipts
 for each row execute function private.voice_interview_permission_protect_history();
create trigger immutable_history before update or delete on private.voice_interview_permission_revocations
 for each row execute function private.voice_interview_permission_protect_history();
create trigger immutable_policy before update or delete on private.voice_interview_permission_policies
 for each row execute function private.voice_interview_permission_protect_registry();
create trigger immutable_issuer before update or delete on private.voice_interview_permission_issuers
 for each row execute function private.voice_interview_permission_protect_registry();

create function private.voice_interview_permission_lock_revocation() returns trigger
language plpgsql security definer set search_path='' as $$
declare subject uuid;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
  raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 select candidate_id into subject from private.voice_interview_permission_receipts where id=new.receipt_id and company_id=new.company_id;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 -- Withdrawal must remain possible during a freeze. It only removes authority;
 -- the candidate row lock still serializes it with preparation and ingestion.
 perform 1 from public.candidates where id=subject and company_id=new.company_id for update nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 -- Candidate first, then the singleton restore gate, matching preparation.
 -- Keep the SHARE lock until COMMIT so restore isolation cannot change between
 -- this check and persistence. A missing configuration is also unavailable.
 perform 1 from private.erasure_execution_config where singleton and not restore_isolated for share nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 return new;
exception when lock_not_available then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';
end;$$;
create trigger serialize_revocation before insert on private.voice_interview_permission_revocations
 for each row execute function private.voice_interview_permission_lock_revocation();

-- Internal currentness helper, no EXECUTE grants. The owning preparation RPC
-- MUST hold candidate/erasure + application/recruitment + both interview and B2
-- issuer/policy row locks before using a NULL result as part of its transaction.
-- This function alone never produces a provider or dispatch capability.
create function private.voice_interview_permission_status(
 target_application uuid,target_contact_receipt uuid,target_permission_receipt uuid
) returns text language plpgsql stable security definer set search_path='' as $$
declare r private.voice_interview_permission_receipts; c private.candidate_verified_contact_receipts;
 p private.candidate_verified_contact_points; a public.applications; checked_at timestamptz:=clock_timestamp();reason text;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then return 'isolation_unavailable';end if;
 select * into r from private.voice_interview_permission_receipts
  where id=target_permission_receipt and application_id=target_application and contact_receipt_id=target_contact_receipt;
 if not found then return 'interview_permission_unavailable';end if;
 if exists(select 1 from private.voice_interview_permission_revocations where company_id=r.company_id and receipt_id=r.id) then return 'interview_permission_revoked';end if;
 if r.issued_at>checked_at or r.expires_at<=checked_at then return 'interview_permission_expired';end if;
 select * into a from public.applications where id=r.application_id and company_id=r.company_id
  and candidate_id=r.candidate_id and recruitment_id=r.recruitment_id;
 if not found or a.status not in ('new','in_progress') then return 'application_unavailable';end if;
 if private.erasure_candidate_frozen(r.candidate_id) then return 'candidate_unavailable';end if;
 if not exists(select 1 from public.recruitments where id=r.recruitment_id and company_id=r.company_id and status='open') then return 'application_unavailable';end if;
 if not exists(select 1 from private.voice_interview_permission_issuers where company_id=r.company_id and issuer_id=r.issuer_id and key_id=r.key_id
  and enabled and valid_from<=r.issued_at and valid_until>=r.expires_at) then return 'interview_issuer_unavailable';end if;
 if not exists(select 1 from private.voice_interview_permission_policies where company_id=r.company_id and notice_version=r.notice_version and policy_sha256=r.policy_sha256
  and purpose='voice_interview' and recording_allowed=false and enabled and valid_from<=r.notice_received_at and valid_until>=r.expires_at) then return 'interview_policy_unavailable';end if;
 select * into c from private.candidate_verified_contact_receipts where id=r.contact_receipt_id and company_id=r.company_id and candidate_id=r.candidate_id
  and recruitment_id=r.recruitment_id and channel='voice' and purpose='verification_invitation';
 if not found then return 'contact_receipt_unavailable';end if;
 if c.issued_at>checked_at or c.expires_at<=checked_at or r.notice_received_at<c.issued_at or r.expires_at>c.expires_at then return 'contact_receipt_expired';end if;
 if not exists(select 1 from private.contact_trusted_issuers where company_id=c.company_id and issuer_id=c.issuer_id and key_id=c.key_id
  and enabled and valid_from<=c.issued_at and valid_until>=c.expires_at) then return 'contact_issuer_unavailable';end if;
 if not exists(select 1 from private.contact_policy_templates where company_id=c.company_id and notice_version=c.notice_version and policy_version=c.policy_version
  and template_version=c.template_version and channel=c.channel and purpose=c.purpose and enabled and valid_from<=c.issued_at and valid_until>=c.expires_at) then return 'contact_policy_unavailable';end if;
 if r.global_permission_revision<>c.global_permission_revision or r.scoped_permission_revision<>c.scoped_permission_revision
  or r.preference_revision<>c.preference_revision then return 'permission_changed';end if;
 reason:=private.contact_receipt_permission_reason(r.company_id,r.candidate_id,r.recruitment_id,'voice',
  r.global_permission_revision,r.scoped_permission_revision,r.preference_revision);
 if reason is not null then return reason;end if;
 select * into p from private.candidate_verified_contact_points where id=c.contact_point_id and company_id=r.company_id and candidate_id=r.candidate_id and channel='voice';
 if not found or p.version<>r.contact_version
  or p.version<>(select max(version) from private.candidate_verified_contact_points where company_id=r.company_id and candidate_id=r.candidate_id and channel='voice')
  or p.candidate_updated_at is distinct from (select updated_at from public.candidates where id=r.candidate_id and company_id=r.company_id)
  then return 'contact_changed';end if;
 return null;
end;$$;

-- Only the separately pinned Ed25519 verifier may ingest this canonical safe
-- JSON. The verifier signs no phone/CV payload, and returns no private row data.
create function private.ingest_voice_interview_permission_receipt(receipt jsonb) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare r private.voice_interview_permission_receipts; existing private.voice_interview_permission_receipts;
 c private.candidate_verified_contact_receipts; field text; revision numeric;instant timestamptz;reason text;
begin
 if jsonb_typeof(receipt) is distinct from 'object' or pg_column_size(receipt)>16000 then
  raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 if (select count(*) from jsonb_object_keys(receipt))<>24 or not receipt ?& array[
  'schema_version','proof_type','receipt_id','company_id','candidate_id','recruitment_id','application_id','contact_receipt_id',
  'channel','purpose','recording_allowed','contact_version','global_permission_revision','scoped_permission_revision','preference_revision',
  'notice_version','policy_sha256','issuer_id','key_id','nonce','notice_received_at','interview_permission_granted_at','issued_at','expires_at'] then
  raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 for field in select jsonb_object_keys(receipt) loop
  if field in ('contact_version','global_permission_revision','scoped_permission_revision','preference_revision') then
   if jsonb_typeof(receipt->field) is distinct from 'number' or receipt->>field !~ '^[0-9]{1,16}$' then
    raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
   revision:=(receipt->>field)::numeric;
   if revision>9007199254740990 or (field='contact_version' and revision<1) then
    raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
  elsif field='recording_allowed' then
   if receipt->field is distinct from 'false'::jsonb then raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
  elsif field='schema_version' then
   if jsonb_typeof(receipt->field) is distinct from 'number' or receipt->>field<>'1' then raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
  elsif jsonb_typeof(receipt->field) is distinct from 'string' or length(receipt->>field)>100 then
   raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 end loop;
 foreach field in array array['receipt_id','company_id','candidate_id','recruitment_id','application_id','contact_receipt_id','nonce'] loop
  if receipt->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 end loop;
 foreach field in array array['issuer_id','key_id','notice_version'] loop
  if receipt->>field !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' then raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 end loop;
 if receipt->>'proof_type'<>'voice_interview_permission_and_notice_received_v1' or receipt->>'channel'<>'voice'
  or receipt->>'purpose'<>'voice_interview' or receipt->>'policy_sha256' !~ '^[0-9a-f]{64}$' then
  raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 foreach field in array array['notice_received_at','interview_permission_granted_at','issued_at','expires_at'] loop
  if receipt->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
   raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
  instant:=(receipt->>field)::timestamptz;
  if to_char(instant,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>receipt->>field then
   raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end if;
 end loop;
 r:=jsonb_populate_record(null::private.voice_interview_permission_receipts,receipt||jsonb_build_object('id',receipt->>'receipt_id','receipt_json',receipt));
 perform 1 from public.candidates where id=r.candidate_id and company_id=r.company_id for update nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 -- Retain the restore gate through COMMIT, including exact identity replay.
 perform 1 from private.erasure_execution_config where singleton and not restore_isolated for share nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 perform private.erasure_lock_candidate(r.candidate_id);
 select * into existing from private.voice_interview_permission_receipts where id=r.id;
 if found then
  if existing.receipt_json is distinct from receipt then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
  return existing.id; -- Identity replay never restores an expired or revoked grant.
 end if;
 if r.notice_received_at>r.interview_permission_granted_at or r.interview_permission_granted_at>r.issued_at
  or r.issued_at>clock_timestamp() or r.expires_at<=clock_timestamp() or r.expires_at<=r.issued_at
  or r.expires_at>r.issued_at+interval '15 minutes' or r.notice_received_at<r.issued_at-interval '15 minutes' then
  raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 perform 1 from public.applications where id=r.application_id and company_id=r.company_id and candidate_id=r.candidate_id and recruitment_id=r.recruitment_id for share nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 perform 1 from public.recruitments where id=r.recruitment_id and company_id=r.company_id for share nowait;
 select * into c from private.candidate_verified_contact_receipts where id=r.contact_receipt_id and company_id=r.company_id;
 if not found then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 perform 1 from private.voice_interview_permission_issuers where company_id=r.company_id and issuer_id=r.issuer_id and key_id=r.key_id for share nowait;
 perform 1 from private.voice_interview_permission_policies where company_id=r.company_id and notice_version=r.notice_version and policy_sha256=r.policy_sha256 for share nowait;
 perform 1 from private.contact_trusted_issuers where company_id=c.company_id and issuer_id=c.issuer_id and key_id=c.key_id for share nowait;
 perform 1 from private.contact_policy_templates where company_id=c.company_id and notice_version=c.notice_version and policy_version=c.policy_version
  and template_version=c.template_version and channel=c.channel and purpose=c.purpose for share nowait;
 -- Insert and currentness check share one transaction. Any failed check rolls the
 -- receipt back; no partial evidence or idempotency record becomes observable.
 insert into private.voice_interview_permission_receipts(
  id,company_id,candidate_id,recruitment_id,application_id,contact_receipt_id,contact_version,
  global_permission_revision,scoped_permission_revision,preference_revision,schema_version,proof_type,channel,purpose,recording_allowed,
  notice_version,policy_sha256,issuer_id,key_id,nonce,notice_received_at,interview_permission_granted_at,issued_at,expires_at,receipt_json)
 values(r.id,r.company_id,r.candidate_id,r.recruitment_id,r.application_id,r.contact_receipt_id,r.contact_version,
  r.global_permission_revision,r.scoped_permission_revision,r.preference_revision,r.schema_version,r.proof_type,r.channel,r.purpose,r.recording_allowed,
  r.notice_version,r.policy_sha256,r.issuer_id,r.key_id,r.nonce,r.notice_received_at,r.interview_permission_granted_at,r.issued_at,r.expires_at,receipt);
 reason:=private.voice_interview_permission_status(r.application_id,r.contact_receipt_id,r.id);
 if reason is not null then raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';end if;
 return r.id;
exception when lock_not_available or unique_violation or sqlstate 'PT409' or sqlstate 'PT404' then
 raise exception using errcode='PT409',message='VOICE_INTERVIEW_PERMISSION_NOT_ACCEPTED';
 when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range or check_violation or foreign_key_violation or not_null_violation then
 raise exception using errcode='PT422',message='VOICE_INTERVIEW_PERMISSION_REJECTED';
end;$$;

-- Object creation inherits any existing default privileges, including grants to
-- legacy workers or roles unknown to this installer. Close the actual ACL of
-- each new object, retaining only its owner, before granting the one entry point.
-- This does not alter defaults, schema privileges or any pre-existing object.
do $$declare t text;f record;recipient record;
begin
 foreach t in array array['voice_interview_permission_policies','voice_interview_permission_issuers','voice_interview_permission_receipts','voice_interview_permission_revocations'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('alter table private.%I force row level security',t);
  execute format('revoke all on table private.%I from public cascade',t);
  for recipient in
   select distinct a.grantee from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    where c.oid=format('private.%I',t)::pg_catalog.regclass and a.grantee<>0 and a.grantee<>c.relowner
  loop
   execute format('revoke all on table private.%I from %I cascade',t,pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
 end loop;
 for f in select p.oid,p.oid::pg_catalog.regprocedure signature,p.proname from pg_catalog.pg_proc p
  where p.oid in (
   'private.voice_interview_permission_protect_history()'::pg_catalog.regprocedure,
   'private.voice_interview_permission_protect_registry()'::pg_catalog.regprocedure,
   'private.voice_interview_permission_lock_revocation()'::pg_catalog.regprocedure,
   'private.voice_interview_permission_status(uuid,uuid,uuid)'::pg_catalog.regprocedure,
   'private.ingest_voice_interview_permission_receipt(jsonb)'::pg_catalog.regprocedure
  ) loop
  execute format('revoke all on function %s from public cascade',f.signature);
  for recipient in
   select distinct a.grantee from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    where p.oid=f.oid and a.grantee<>0 and a.grantee<>p.proowner
  loop
   execute format('revoke all on function %s from %I cascade',f.signature,pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
  if f.proname='ingest_voice_interview_permission_receipt' then
   execute format('grant execute on function %s to voice_permission_verifier',f.signature);end if;
 end loop;
end;$$;
commit;
