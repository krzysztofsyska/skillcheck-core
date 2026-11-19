-- R6-1c (part 2): voice interview permission receipts (SC-010-C), the voice
-- interview pool (SC-019, no package/price/order/catalog) and offline voice
-- preparations (SC-010-C) as a real migration.
-- Generated offline by scripts/r6-voice-permission-pool-compose.mjs from the
-- reviewed isolated sources and the R18 erasure inventory; erasure inventory R19
-- adds the four candidate-linked tables (R4 voice adapter, reduced to these
-- tables) and refunds a held pool unit when its preparation is purged.
--
-- Nothing is used by the application yet and nothing is customer-visible: no
-- table or function is granted to anon, authenticated or service_role, no issuer,
-- policy or pool grant is seeded, no provider is called and no package, price or
-- order state is touched. Receipt ingestion is executable only by the nologin
-- role voice_permission_verifier (no members); everything else only by its owner.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r18') is null then raise exception 'voice_pool_requires_r18' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r19') is not null
  or to_regclass('private.voice_interview_permission_receipts') is not null
  or to_regclass('private.voice_interview_permission_revocations') is not null
  or to_regclass('private.sc010c_voice_preparations') is not null
  or to_regclass('private.sc010c_voice_preparation_requests') is not null
  or to_regclass('private.voice_interview_permission_policies') is not null
  or to_regclass('private.voice_interview_permission_issuers') is not null
  or to_regclass('private.sc19_voice_entitlements') is not null then
  raise exception 'voice_pool_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r18 where singleton and schema_signature='d77384591cfa80a1a2f16d641b7af5e653a21ce49ccc1b7f2db2bbc2539aaebb')
  or private.erasure_schema_signature() is distinct from 'd77384591cfa80a1a2f16d641b7af5e653a21ce49ccc1b7f2db2bbc2539aaebb' then
  raise exception 'voice_pool_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r18 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_pool_source_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_inventory_rows(uuid,uuid[])'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7849430db010352fbdcfe5fe384ed1c0f6608d92ad00763f6015b0d2f785e4d6'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_pool_source_function_unreviewed:private.erasure_inventory_rows' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_row_candidates(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='c6406938dfe25062294a72d658cb48d0e9722f9bd39bea7968eeec7e2f9621ec'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_pool_source_function_unreviewed:private.erasure_row_candidates' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_engine(uuid,bigint,boolean)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='12f4c4d9547fce167dc23a0b03df4d5f62c5a62234bb64a9e48615f6b7577e80'
  and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{erasure_purge_owner=X/erasure_purge_owner}') then
  raise exception 'voice_pool_source_function_unreviewed:private.erasure_purge_engine' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.preview_candidate_erasure(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='367999b1369770151d23e2971d7131820c4ae94e06a624a057484f078a0253d1'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'voice_pool_source_function_unreviewed:public.preview_candidate_erasure' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.prepare_erasure_purge_manifest(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='46622a6d335419eb3fb98f2f1d531c2c6c83df45ebb121ab2a504f22b0a6fbdd'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_pool_source_function_unreviewed:private.prepare_erasure_purge_manifest' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.authorize_retention_suggestion(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e078817c8d418075bfdf8854ab66ba3afb1e12fb14236dde058ce8f9782fc600'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_pool_source_function_unreviewed:private.authorize_retention_suggestion' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.get_retention_schedule(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='cfaab18a582cec4e891449404173cbf9db832ae1690da6bee0029ea16cde0b9d'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'voice_pool_source_function_unreviewed:public.get_retention_schedule' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_key(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='4191dbdfdbdd211ae933739258b33628927222bc5ef35130759d37dbeee3115b') then
  raise exception 'voice_pool_source_function_unreviewed:private.erasure_purge_key' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_voice_row_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='1f5e6ff865ae47397e5b236286e9bd17bbf7ce7eb160a948ac89d731e3e374cb') then
  raise exception 'voice_pool_source_function_unreviewed:private.erasure_voice_row_guard' using errcode='55000';end if;
 if to_regprocedure('private.erasure_inventory_rows_r18(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r18(text,jsonb)') is not null then
  raise exception 'voice_pool_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.erasure_lock_candidate(uuid)') is null or to_regprocedure('private.erasure_candidate_frozen(uuid)') is null
  or to_regprocedure('private.contact_lock_candidate(uuid)') is null or to_regprocedure('private.contact_receipt_status(uuid,uuid)') is null
  or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='contact_receipt_permission_reason')
  or to_regclass('private.candidate_verified_contact_receipts') is null or to_regclass('private.candidate_verified_contact_points') is null
  or to_regclass('private.contact_trusted_issuers') is null or to_regclass('private.contact_policy_templates') is null
  or to_regclass('public.candidate_contact_preferences') is null or to_regclass('private.erasure_execution_config') is null
  or to_regprocedure('private.retention_observe_candidate()') is null or to_regprocedure('private.contact_immutable()') is null
  or to_regrole('erasure_purge_owner') is null then
  raise exception 'voice_pool_dependency_missing' using errcode='55000';end if;
 -- The preparation's composite foreign key needs an existing unique index on these
 -- four application columns; the isolated duplicate index is not created.
 if not exists(select 1 from pg_index i where i.indrelid='public.applications'::regclass and i.indisunique and i.indpred is null
  and (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey) with ordinality k(attnum,ord)
   join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)=array['company_id','recruitment_id','candidate_id','id']) then
  raise exception 'voice_pool_application_key_missing' using errcode='55000';end if;
end $preflight$;

-- SC-010-C interview permission (source: db/isolated/sc010c-interview-permission.sql).

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

-- Immutable reviewed versions. Disabled is the default and no version is seeded;
-- only a separately reviewed administrative step may insert an approved version. A version may only be disabled,
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
-- No direct grant or public API is introduced; only trusted server code inserts
-- a revocation, independently of notice or invitation consent.
create table private.voice_interview_permission_revocations (
 company_id uuid not null, receipt_id uuid not null, revoked_at timestamptz not null default clock_timestamp(),
 primary key(company_id,receipt_id),
 foreign key(company_id,receipt_id) references private.voice_interview_permission_receipts(company_id,id) on delete restrict
);
create function private.voice_interview_permission_protect_history() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if; raise exception using errcode='42501',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end;$$;
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

-- SC-019 voice interview pool (source: db/isolated/sc019-voice-entitlements.sql, without packages).

create table private.sc19_voice_entitlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  resource text not null default 'voice_interview' check (resource = 'voice_interview'),
  total integer not null check (total between 1 and 100000),
  used integer not null default 0 check (used >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  revision bigint not null default 1 check (revision > 0),
  -- The opaque UUID refers to an independently verified operator grant record.
  -- It is never a client request key, payment redirect, NIP, contact detail,
  -- price, package or new reference on each retry.
  grant_reference uuid not null unique,
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  active boolean not null default false,
  revoked_at timestamptz,
  company_verified boolean not null default false,
  company_verification_reference uuid,
  company_verification_expires_at timestamptz,
  grant_verified boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  check (used + reserved <= total),
  check (expires_at > valid_from),
  check ((company_verification_reference is null) = (company_verification_expires_at is null)),
  check (not company_verified or company_verification_reference is not null),
  check (revoked_at is null or not active)
);

-- The history row survives expiry, revocation, consumption and cancellation.
create index sc19_voice_entitlements_company_idx
  on private.sc19_voice_entitlements(company_id, valid_from, id);
alter table private.sc19_voice_entitlements enable row level security;
alter table private.sc19_voice_entitlements force row level security;
revoke all on private.sc19_voice_entitlements from public;

-- This helper validates a freshly locked database row, never a caller JSON DTO.
-- It grants no capability: the reservation RPC must also authenticate the tenant,
-- recheck SC-010/012, lock this exact (company_id,id) FOR UPDATE NOWAIT, check
-- used+reserved<total for a NEW reservation, and commit reserved=reserved+1 with
-- its unique operation row in one transaction. Eligibility omits headroom so an
-- existing operation can replay while its reservation occupies the last unit.
create function private.sc19_voice_entitlement_eligible(
  entitlement private.sc19_voice_entitlements
) returns boolean language sql volatile security invoker set search_path = '' as $$
  select coalesce(
    entitlement.resource = 'voice_interview'
    and entitlement.active
    and entitlement.revoked_at is null
    and entitlement.valid_from <= clock_timestamp()
    and entitlement.expires_at > clock_timestamp()
    and entitlement.company_verified
    and entitlement.company_verification_reference is not null
    and entitlement.company_verification_expires_at > clock_timestamp()
    and entitlement.grant_verified,
    false
  );
$$;
revoke all on function private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements) from public;

create function private.sc19_voice_entitlement_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  usage_delta integer;
  reservation_delta integer;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'voice_entitlement_history_immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.used <> 0 or new.reserved <> 0 or new.revision <> 1 then
      raise exception 'voice_entitlement_initial_counters_invalid' using errcode = '22023';
    end if;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    if new.revoked_at is not null then
      new.revoked_at := new.created_at;
      new.active := false;
    end if;
    return new;
  end if;

  -- A top-up is a new immutable grant with a different grant reference.
  -- It never rewrites a previous grant or its consumed/pending units. Grant
  -- windows are economic terms, so extending them requires a separately reviewed
  -- policy instead of updating a row that may already have been consumed.
  if row(new.id, new.company_id, new.resource, new.total,
      new.grant_reference, new.valid_from, new.expires_at, new.created_at)
    is distinct from
    row(old.id, old.company_id, old.resource, old.total,
      old.grant_reference, old.valid_from, old.expires_at, old.created_at) then
    raise exception 'voice_entitlement_grant_immutable' using errcode = '55000';
  end if;
  if old.revoked_at is not null
    and (new.revoked_at is distinct from old.revoked_at or new.active) then
    raise exception 'voice_entitlement_revocation_final' using errcode = '55000';
  end if;

  usage_delta := new.used - old.used;
  reservation_delta := new.reserved - old.reserved;
  if usage_delta <> 0 or reservation_delta <> 0 then
    -- Never combine operator evidence/policy changes with operational accounting.
    if row(new.active, new.revoked_at, new.company_verified,
        new.company_verification_reference, new.company_verification_expires_at,
        new.grant_verified)
      is distinct from
      row(old.active, old.revoked_at, old.company_verified,
        old.company_verification_reference, old.company_verification_expires_at,
        old.grant_verified) then
      raise exception 'voice_entitlement_mixed_mutation' using errcode = '55000';
    end if;
    -- One operation reserves one unit, then releases it before send or settles
    -- that held unit as used. Used never decreases. UNKNOWN has no transition
    -- here and keeps its reserved unit until the operation is reconciled.
    if not (
      (usage_delta = 0 and reservation_delta in (-1, 1))
      or (usage_delta = 1 and reservation_delta = -1)
    ) then
      raise exception 'voice_entitlement_counter_transition_invalid' using errcode = '55000';
    end if;
    if reservation_delta = 1 and (
      not private.sc19_voice_entitlement_eligible(old)
      or old.used + old.reserved >= old.total
    ) then
      raise exception 'voice_entitlement_unavailable' using errcode = 'PT402';
    end if;
  end if;

  if new.revision not in (old.revision, old.revision + 1) then
    raise exception 'voice_entitlement_revision_invalid' using errcode = '55000';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := clock_timestamp();
    new.active := false;
  end if;
  -- Callers can use a WHERE revision=expected CAS, but cannot choose/backdate the
  -- resulting revision or clock. Explicit revision=revision+1 is also accepted.
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function private.sc19_voice_entitlement_guard() from public;
create trigger sc19_voice_entitlement_guard
  before insert or update or delete on private.sc19_voice_entitlements
  for each row execute function private.sc19_voice_entitlement_guard();
create trigger sc19_voice_entitlement_no_truncate
  before truncate on private.sc19_voice_entitlements
  for each statement execute function private.sc19_voice_entitlement_guard();

-- No RLS policies or role grants. Close actual ACLs, including arbitrary
-- inherited defaults and grant options, on these three new objects only.
-- The owner and its defaults remain unchanged; workers get no general CRUD.
do $$
declare f record; recipient record;
begin
  revoke all on table private.sc19_voice_entitlements from public cascade;
  for recipient in
    select distinct a.grantee from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      where c.oid='private.sc19_voice_entitlements'::pg_catalog.regclass
        and a.grantee<>0 and a.grantee<>c.relowner
  loop
    execute pg_catalog.format('revoke all on table private.sc19_voice_entitlements from %I cascade',
      pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
  for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p where p.oid in (
      'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)'::pg_catalog.regprocedure,
      'private.sc19_voice_entitlement_guard()'::pg_catalog.regprocedure
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
end;
$$;

-- SC-010-C offline preparation (source: db/isolated/sc010c-voice-preparation.sql).

create unique index sc010c_approval_communication_uq
 on public.candidate_communication_approvals(company_id,communication_id,id);

create table private.sc010c_voice_preparations (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 recruitment_id uuid not null,
 candidate_id uuid not null,
 application_id uuid not null,
 communication_id uuid not null,
 approval_id uuid not null,
 permission_receipt_id uuid not null,
 contact_receipt_id uuid not null,
 contact_point_id uuid not null,
 contact_version bigint not null check(contact_version>0),
 plan_id uuid not null,
 release_id uuid not null,
 pointer_version bigint not null check(pointer_version>0),
 entitlement_id uuid not null,
 binding_json jsonb not null check(jsonb_typeof(binding_json)='object'),
 binding_hash text not null check(binding_hash ~ '^[0-9a-f]{64}$'),
 provider_key_envelope jsonb not null check(
  jsonb_typeof(provider_key_envelope)='object' and
  provider_key_envelope->>'algorithm'='A256GCM' and
  provider_key_envelope ?& array['algorithm','key_id','iv','ciphertext','tag']),
 provider_key_digest text not null unique check(provider_key_digest ~ '^[0-9a-f]{64}$'),
 state text not null default 'prepared_offline' check(state in ('prepared_offline','cancelled_offline')),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 cancelled_at timestamptz,
 check((state='cancelled_offline')=(cancelled_at is not null)),
 unique(company_id,id),
 unique(company_id,approval_id),
 foreign key(company_id,recruitment_id,candidate_id,application_id)
  references public.applications(company_id,recruitment_id,candidate_id,id) on delete restrict,
 foreign key(company_id,communication_id,approval_id)
  references public.candidate_communication_approvals(company_id,communication_id,id) on delete restrict,
 foreign key(company_id,contact_receipt_id)
  references private.candidate_verified_contact_receipts(company_id,id) on delete restrict,
 foreign key(company_id,contact_point_id)
  references private.candidate_verified_contact_points(company_id,id) on delete restrict,
 foreign key(company_id,application_id,plan_id,release_id)
  references private.voice_plan_release_entries(company_id,application_id,plan_id,id) on delete restrict,
 foreign key(company_id,permission_receipt_id)
  references private.voice_interview_permission_receipts(company_id,id) on delete restrict,
 foreign key(company_id,entitlement_id)
  references private.sc19_voice_entitlements(company_id,id) on delete restrict
);
-- A new approval or another request key cannot create a second held operation
-- for the same communication. A cancellation remains terminal for its approval.
create unique index sc010c_one_held_communication_uq
 on private.sc010c_voice_preparations(company_id,communication_id)
 where state='prepared_offline';
create index sc010c_preparation_candidate_idx
 on private.sc010c_voice_preparations(company_id,candidate_id);
create index sc010c_preparation_entitlement_idx
 on private.sc010c_voice_preparations(company_id,entitlement_id,state);

create table private.sc010c_voice_preparation_requests (
 company_id uuid not null,
 actor_id uuid not null references auth.users(id) on delete restrict,
 request_key uuid not null,
 operation_id uuid not null,
 binding_hash text not null check(binding_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(company_id,actor_id,request_key),
 foreign key(company_id,operation_id)
  references private.sc010c_voice_preparations(company_id,id) on delete restrict
);
create index sc010c_preparation_request_operation_idx
 on private.sc010c_voice_preparation_requests(company_id,operation_id);

create function private.sc010c_preparation_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_PREPARATION_IMMUTABLE';
 end if;
 perform private.erasure_lock_candidate(new.candidate_id);
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 if tg_op='UPDATE' then
  -- An exact replay queues the deferred currentness check without changing any
  -- stored value. All historical fields and terminal states remain immutable.
  if old.state='prepared_offline' and to_jsonb(new)=to_jsonb(old) then return new;end if;
  if old.state<>'prepared_offline' or new.state<>'cancelled_offline'
   or (to_jsonb(new)-array['state','cancelled_at']) is distinct from
      (to_jsonb(old)-array['state','cancelled_at']) then
   raise exception using errcode='42501',message='VOICE_PREPARATION_IMMUTABLE';
  end if;
  new.cancelled_at:=clock_timestamp();
 elsif new.state<>'prepared_offline' or new.cancelled_at is not null then
  raise exception using errcode='42501',message='VOICE_PREPARATION_INVALID_STATE';
 end if;
 return new;
end;$$;
create trigger sc010c_preparation_guard before insert or update or delete
 on private.sc010c_voice_preparations for each row
 execute function private.sc010c_preparation_guard();
create trigger sc010c_preparation_no_truncate before truncate
 on private.sc010c_voice_preparations for each statement
 execute function private.sc010c_preparation_guard();

create function private.sc010c_request_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare subject uuid;
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_PREPARATION_IMMUTABLE';
 end if;
 select candidate_id into subject from private.sc010c_voice_preparations
  where company_id=new.company_id and id=new.operation_id;
 if not found then raise exception using errcode='PT409',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 perform private.erasure_lock_candidate(subject);
 return new;
end;$$;
create trigger sc010c_request_guard before insert or update or delete
 on private.sc010c_voice_preparation_requests for each row
 execute function private.sc010c_request_guard();
create trigger sc010c_request_no_truncate before truncate
 on private.sc010c_voice_preparation_requests for each statement
 execute function private.sc010c_request_guard();

-- Only a trusted server connection may invoke this. Browser roles cannot call
-- it or read ciphertext. The actor still comes from the authenticated session.
-- All returned data remains inside the server's open preparation transaction.
create function private.sc010c_lock_voice_contact(
 target_company uuid,target_communication uuid,target_approval uuid,target_permission uuid
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c public.candidate_communications; a public.candidate_communication_approvals;
 r private.candidate_verified_contact_receipts; p private.candidate_verified_contact_points;
 permission private.voice_interview_permission_receipts;
 pref public.candidate_contact_preferences; local_time timestamp; why text; tenant uuid;
begin
 if target_company is null or target_communication is null or target_approval is null or target_permission is null then
  raise exception using errcode='PT422',message='VOICE_PREPARATION_INVALID';end if;
 select * into c from public.candidate_communications
  where company_id=target_company and id=target_communication;
 if not found then raise exception using errcode='PT404',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 tenant:=private.contact_lock_candidate(c.candidate_id);
 if tenant is distinct from target_company then
  raise exception using errcode='PT404',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 -- Keep a restore-mode transition from committing between the final status
 -- read and preparation COMMIT. Candidate freezes use the candidate row lock.
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 select * into c from public.candidate_communications
  where company_id=tenant and id=target_communication for update nowait;
 if not found or c.state<>'draft' or c.channel<>'voice' or c.purpose<>'verification_invitation' then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_CONTACT_CHANGED';end if;
 select * into a from public.candidate_communication_approvals
  where company_id=tenant and communication_id=c.id and id=target_approval for share nowait;
 if not found or a.communication_version<>c.version or a.shortlist_entry_id<>c.shortlist_entry_id then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_APPROVAL_CHANGED';end if;
 select * into r from private.candidate_verified_contact_receipts
  where company_id=tenant and id=a.receipt_id for share nowait;
 if not found or r.expires_at<=clock_timestamp() or r.issued_at>clock_timestamp() then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_CONTACT_CHANGED';end if;
 select * into p from private.candidate_verified_contact_points
  where company_id=tenant and id=r.contact_point_id for share nowait;
 if not found or p.version<>a.contact_version then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_CONTACT_CHANGED';end if;
 perform 1 from private.contact_trusted_issuers where company_id=tenant
  and issuer_id=r.issuer_id and key_id=r.key_id for share nowait;
 perform 1 from private.contact_policy_templates where company_id=tenant
  and notice_version=r.notice_version and policy_version=r.policy_version
  and template_version=r.template_version and channel=r.channel and purpose=r.purpose for share nowait;
 why:=private.contact_receipt_status(c.id,r.id);
 if why is not null then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_CONTACT_CHANGED';end if;
 select * into permission from private.voice_interview_permission_receipts
  where company_id=tenant and id=target_permission for share nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_PREPARATION_PERMISSION_UNAVAILABLE';end if;
 perform 1 from private.voice_interview_permission_issuers
  where company_id=tenant and issuer_id=permission.issuer_id and key_id=permission.key_id for share nowait;
 perform 1 from private.voice_interview_permission_policies
  where company_id=tenant and notice_version=permission.notice_version and policy_sha256=permission.policy_sha256 for share nowait;
 why:=private.voice_interview_permission_status(c.application_id,r.id,permission.id);
 if why is not null then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_PERMISSION_UNAVAILABLE';end if;
 -- A receipt without a candidate's explicit weekly preference is not a schedule.
 select * into pref from public.candidate_contact_preferences
  where company_id=tenant and candidate_id=c.candidate_id for share nowait;
 if not found or not exists(select 1 from pg_catalog.pg_timezone_names where name=pref.timezone) then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_OUTSIDE_WINDOW';end if;
 local_time:=clock_timestamp() at time zone pref.timezone;
 if not exists(select 1 from jsonb_array_elements(pref.weekday_windows) w
  where (w->>'weekday')::integer=extract(isodow from local_time)::integer
   and extract(hour from local_time)*60+extract(minute from local_time)>=(w->>'start_minute')::integer
   and extract(hour from local_time)*60+extract(minute from local_time)<(w->>'end_minute')::integer) then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_OUTSIDE_WINDOW';end if;
 return jsonb_build_object(
  'companyId',tenant,'candidateId',c.candidate_id,'applicationId',c.application_id,
  'recruitmentId',c.recruitment_id,'communicationId',c.id,'approvalId',a.id,
  'permissionReceiptId',permission.id,'contactReceiptId',r.id,'contactPointId',p.id,
  'contactVersion',p.version,'analysisId',a.analysis_id,'reviewId',a.review_id,
  'shortlistEntryId',a.shortlist_entry_id,'noticeVersion',permission.notice_version,
  'permissionPolicySha256',permission.policy_sha256,
  'noticeReceivedAt',permission.notice_received_at,
  'contactEnvelope',p.envelope,'contactDigest',p.contact_digest,
  'contactNoticeVersion',r.notice_version,'contactPolicyVersion',r.policy_version,
  'contactTemplateVersion',r.template_version,
  'globalPermissionRevision',r.global_permission_revision,
  'scopedPermissionRevision',r.scoped_permission_revision,'preferenceRevision',r.preference_revision
 );
exception when lock_not_available or deadlock_detected or serialization_failure then
 raise exception using errcode='PT409',message='VOICE_PREPARATION_CONFLICT';
end;$$;

-- Time may advance while the server compiles the draft, or after its last SQL
-- read. This deferred constraint runs inside COMMIT, with all authority locks
-- retained. Creation and EVERY replay must queue it; failure rolls back quota,
-- operation and request-key changes together. Cancellation only removes an
-- unsent draft and intentionally does not need unexpired contact authority.
create function private.sc010c_preparation_current_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare preparation private.sc010c_voice_preparations; contact jsonb;
begin
 select * into preparation from private.sc010c_voice_preparations
  where company_id=new.company_id and id=new.id;
 if not found then raise exception using errcode='PT409',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 if preparation.state='cancelled_offline' then return null;end if;
 contact:=private.sc010c_lock_voice_contact(preparation.company_id,preparation.communication_id,
  preparation.approval_id,preparation.permission_receipt_id);
 if contact->>'candidateId' is distinct from preparation.candidate_id::text
  or contact->>'applicationId' is distinct from preparation.application_id::text
  or contact->>'recruitmentId' is distinct from preparation.recruitment_id::text
  or contact->>'contactReceiptId' is distinct from preparation.contact_receipt_id::text
  or contact->>'contactPointId' is distinct from preparation.contact_point_id::text
  or (contact->>'contactVersion')::bigint is distinct from preparation.contact_version then
  raise exception using errcode='PT409',message='VOICE_PREPARATION_CONTACT_CHANGED';end if;
 perform 1 from private.voice_plan_current_releases c
  join public.voice_plan_versions p on p.company_id=c.company_id
   and p.application_id=c.application_id and p.id=c.plan_id
  join private.voice_plan_release_entries l on l.company_id=c.company_id
   and l.application_id=c.application_id and l.plan_id=c.plan_id and l.id=c.release_entry_id
  join private.voice_plan_review_entries r on r.company_id=l.company_id
   and r.application_id=l.application_id and r.plan_id=l.plan_id and r.id=l.approved_review_id
  where c.company_id=preparation.company_id and c.application_id=preparation.application_id
   and c.plan_id=preparation.plan_id and c.release_entry_id=preparation.release_id
   and c.pointer_version=preparation.pointer_version and r.decision='approved'
   and p.source_hash=l.source_hash and p.source_hash=r.source_hash
   and p.retention_deadline>clock_timestamp() and l.retention_deadline>clock_timestamp()
   and r.retention_deadline>clock_timestamp() and r.created_at<=l.released_at
   and l.released_at<=clock_timestamp()
  for share of c,p,l,r nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_PREPARATION_PLAN_CHANGED';end if;
 perform 1 from private.sc19_voice_entitlements e
  where e.company_id=preparation.company_id and e.id=preparation.entitlement_id
   and e.reserved>0 and private.sc19_voice_entitlement_eligible(e)
  for share nowait;
 if not found then raise exception using errcode='PT409',message='VOICE_PREPARATION_UNAVAILABLE';end if;
 return null;
exception when lock_not_available or deadlock_detected or serialization_failure then
 raise exception using errcode='PT409',message='VOICE_PREPARATION_CONFLICT';
end;$$;
create constraint trigger sc010c_preparation_current_at_commit
 after insert or update on private.sc010c_voice_preparations
 deferrable initially deferred for each row
 execute function private.sc010c_preparation_current_guard();

alter table private.sc010c_voice_preparations enable row level security;
alter table private.sc010c_voice_preparation_requests enable row level security;
alter table private.sc010c_voice_preparations force row level security;
alter table private.sc010c_voice_preparation_requests force row level security;
-- Every new object is private even when its owner has unsafe default grants.
-- Inspect actual ACLs, remove all non-owner recipients (and grant options), and
-- leave defaults, schema privileges and all pre-existing objects unchanged.
do $$
declare t text; f record; recipient record;
begin
 foreach t in array array['sc010c_voice_preparations','sc010c_voice_preparation_requests'] loop
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
   'private.sc010c_preparation_guard()'::pg_catalog.regprocedure,
   'private.sc010c_request_guard()'::pg_catalog.regprocedure,
   'private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure,
   'private.sc010c_preparation_current_guard()'::pg_catalog.regprocedure
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
-- its key (this function was last defined by 20261119100000, R18).
create or replace function private.erasure_purge_key(adapter text,data jsonb) returns text
language sql immutable set search_path='' as $$
 select case
 when adapter='private.voice_plan_request_keys' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
 when adapter='private.sc010c_voice_preparation_requests' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'request_key')
 when adapter='private.voice_interview_permission_revocations' then data->>'company_id'||':'||(data->>'receipt_id')
 when adapter in ('private.contact_requests','private.erasure_configuration_requests','private.erasure_lifecycle_commands') then data->>'actor_id'||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter in ('private.erasure_candidate_lifecycle','private.retention_candidate_clocks') then data->>'candidate_id'
 when adapter='private.erasure_denial_context' then data->>'txid'||':'||(data->>'candidate_id')
 else data->>'id' end
$$;

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r18;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r18;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;ids uuid[];
begin
 if adapter='private.sc010c_voice_preparation_requests' then
  select candidate_id into subject from private.sc010c_voice_preparations
   where company_id=(data->>'company_id')::uuid and id=(data->>'operation_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown voice preparation dependency';end if;
  return array[subject];
 end if;
 if adapter='private.voice_interview_permission_revocations' then
  select candidate_id into subject from private.voice_interview_permission_receipts
   where company_id=(data->>'company_id')::uuid and id=(data->>'receipt_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown voice permission dependency';end if;
  return array[subject];
 end if;
 if adapter in ('private.voice_interview_permission_receipts','private.sc010c_voice_preparations') then
  -- Every candidate referenced by the row (directly, through its application,
  -- plan/release, permission or contact evidence) is a subject of the row.
  with refs as (
   select (data->>'candidate_id')::uuid id
   union select a.candidate_id from public.applications a where a.company_id=(data->>'company_id')::uuid
    and (a.id=(data->>'application_id')::uuid or a.id in (
     select p.application_id from public.voice_plan_versions p where p.company_id=a.company_id
      and p.id in ((data->>'plan_id')::uuid,(data->>'supersedes_plan_id')::uuid)
     union select r.application_id from private.voice_plan_review_entries r where r.company_id=a.company_id
      and r.id in ((data->>'corrects_review_id')::uuid,(data->>'approved_review_id')::uuid)
     union select r.application_id from private.voice_plan_release_entries r where r.company_id=a.company_id
      and r.id in ((data->>'release_id')::uuid,(data->>'release_entry_id')::uuid)))
   union select r.candidate_id from private.voice_interview_permission_receipts r where r.company_id=(data->>'company_id')::uuid and r.id=(data->>'permission_receipt_id')::uuid
   union select r.candidate_id from private.candidate_verified_contact_receipts r where r.company_id=(data->>'company_id')::uuid and r.id=(data->>'contact_receipt_id')::uuid
   union select r.candidate_id from private.candidate_verified_contact_points r where r.company_id=(data->>'company_id')::uuid and r.id=(data->>'contact_point_id')::uuid
   union select r.candidate_id from public.candidate_communications r where r.company_id=(data->>'company_id')::uuid and r.id=(data->>'communication_id')::uuid
  ) select array_agg(distinct id order by id) into ids from refs where id is not null;
  if coalesce(cardinality(ids),0)=0 then raise exception using errcode='PT409',message='Unknown voice candidate dependency';end if;
  return ids;
 end if;
 return private.erasure_row_candidates_r18(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r18(tenant,subjects)
 union all select 'private.voice_interview_permission_receipts',private.erasure_purge_key('private.voice_interview_permission_receipts',to_jsonb(t)),to_jsonb(t) from private.voice_interview_permission_receipts t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_interview_permission_receipts',to_jsonb(t)) && subjects)
 union all select 'private.voice_interview_permission_revocations',private.erasure_purge_key('private.voice_interview_permission_revocations',to_jsonb(t)),to_jsonb(t) from private.voice_interview_permission_revocations t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_interview_permission_revocations',to_jsonb(t)) && subjects)
 union all select 'private.sc010c_voice_preparations',private.erasure_purge_key('private.sc010c_voice_preparations',to_jsonb(t)),to_jsonb(t) from private.sc010c_voice_preparations t where t.company_id=tenant and (private.erasure_row_candidates('private.sc010c_voice_preparations',to_jsonb(t)) && subjects)
 union all select 'private.sc010c_voice_preparation_requests',private.erasure_purge_key('private.sc010c_voice_preparation_requests',to_jsonb(t)),to_jsonb(t) from private.sc010c_voice_preparation_requests t where t.company_id=tenant and (private.erasure_row_candidates('private.sc010c_voice_preparation_requests',to_jsonb(t)) && subjects)
$$;
create table private.erasure_inventory_baseline_r19 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r19 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r19
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r19 select true,'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39',
 known_tables||array['private.voice_interview_permission_receipts','private.voice_interview_permission_revocations','private.sc010c_voice_preparations','private.sc010c_voice_preparation_requests','private.voice_interview_permission_policies','private.voice_interview_permission_issuers','private.sc19_voice_entitlements','private.erasure_inventory_baseline_r19']
 from private.erasure_inventory_baseline_r18 where singleton;

-- Normal writes take the candidate lock and refuse frozen candidates (R18 voice
-- guard). A revocation stays possible during a freeze: it only removes authority
-- and its own trigger serializes it on the candidate row (R4 voice adapter).
create trigger erasure_voice_guard before insert or update or delete on private.voice_interview_permission_receipts
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.voice_interview_permission_receipts
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.voice_interview_permission_receipts for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_interview_permission_receipts',to_jsonb(voice_interview_permission_receipts)));
create policy erasure_purge_delete on private.voice_interview_permission_receipts for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_interview_permission_receipts',to_jsonb(voice_interview_permission_receipts)));
create trigger zz_retention_observed after insert or update or delete on private.voice_interview_permission_revocations
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.voice_interview_permission_revocations for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_interview_permission_revocations',to_jsonb(voice_interview_permission_revocations)));
create policy erasure_purge_delete on private.voice_interview_permission_revocations for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_interview_permission_revocations',to_jsonb(voice_interview_permission_revocations)));
create trigger erasure_voice_guard before insert or update or delete on private.sc010c_voice_preparations
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.sc010c_voice_preparations
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.sc010c_voice_preparations for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc010c_voice_preparations',to_jsonb(sc010c_voice_preparations)));
create policy erasure_purge_delete on private.sc010c_voice_preparations for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc010c_voice_preparations',to_jsonb(sc010c_voice_preparations)));
create trigger erasure_voice_guard before insert or update or delete on private.sc010c_voice_preparation_requests
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.sc010c_voice_preparation_requests
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.sc010c_voice_preparation_requests for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc010c_voice_preparation_requests',to_jsonb(sc010c_voice_preparation_requests)));
create policy erasure_purge_delete on private.sc010c_voice_preparation_requests for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc010c_voice_preparation_requests',to_jsonb(sc010c_voice_preparation_requests)));

-- A purged prepared_offline operation returns its held pool unit exactly once;
-- quotas are locked in a deterministic order and reconciled first (R4 voice).
create function private.erasure_voice_refund_deleted() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'DELETE' or tg_table_schema<>'private' or tg_table_name<>'sc010c_voice_preparations'
  or not exists(select 1 from private.erasure_purge_context c join private.erasure_purge_context_rows r on r.txid=c.txid
    where c.txid=txid_current() and c.company_id=old.company_id and c.mode='delete'
     and r.adapter='private.sc010c_voice_preparations' and r.row_key=old.id::text
     and r.row_hash=private.erasure_hash(to_jsonb(old)) and r.command='delete') then
  raise exception using errcode='42501',message='Voice refund requires authorized deletion';end if;
 if old.state='prepared_offline' then
  update private.sc19_voice_entitlements set reserved=reserved-1
   where company_id=old.company_id and id=old.entitlement_id and reserved>0;
  if not found then raise exception using errcode='PT409',message='Voice reservation accounting mismatch';end if;
 end if;
 return old;
end;$$;
create trigger erasure_voice_refund after delete on private.sc010c_voice_preparations
 for each row execute function private.erasure_voice_refund_deleted();
create function private.erasure_voice_lock_entitlements(tenant uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from private.sc19_voice_entitlements e where e.company_id=tenant and e.id in (
  select p.entitlement_id from private.sc010c_voice_preparations p
  join private.erasure_purge_context_rows r on r.txid=txid_current()
   and r.adapter='private.sc010c_voice_preparations' and r.row_key=p.id::text
   and r.row_hash=private.erasure_hash(to_jsonb(p)) and r.command='delete'
  join private.erasure_purge_context c on c.txid=r.txid and c.company_id=p.company_id and c.mode='delete'
  where p.company_id=tenant and p.state='prepared_offline') order by e.company_id,e.id for update nowait;
 -- A mixed restore must not refund a different person's held unit. A coherent
 -- snapshot has exactly one counter unit for each prepared_offline operation.
 -- Read after acquiring the quota locks (fresh READ COMMITTED statement).
 if exists(select 1 from private.sc19_voice_entitlements e where e.company_id=tenant
  and e.id in(select p.entitlement_id from private.sc010c_voice_preparations p
   join private.erasure_purge_context_rows r on r.txid=txid_current()
    and r.adapter='private.sc010c_voice_preparations' and r.row_key=p.id::text
    and r.row_hash=private.erasure_hash(to_jsonb(p)) and r.command='delete'
   where p.company_id=tenant and p.state='prepared_offline')
  and e.reserved<>(select count(*) from private.sc010c_voice_preparations p
   where p.company_id=e.company_id and p.entitlement_id=e.id and p.state='prepared_offline')) then
  raise exception using errcode='PT409',message='Voice reservation reconciliation required';end if;
end;$$;

create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r19;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
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
 select * into baseline from private.erasure_inventory_baseline_r19 where singleton;
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
 select schema_signature into baseline from private.erasure_inventory_baseline_r19 where singleton;
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
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r19 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
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
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r19 where singleton);
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
-- the existing manifest-checked purge role and the nologin receipt verifier.
-- No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('private.voice_interview_permission_receipts'::regclass,'private.voice_interview_permission_revocations'::regclass,'private.sc010c_voice_preparations'::regclass,'private.sc010c_voice_preparation_requests'::regclass,'private.voice_interview_permission_policies'::regclass,'private.voice_interview_permission_issuers'::regclass,'private.sc19_voice_entitlements'::regclass,'private.erasure_inventory_baseline_r19'::regclass) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.voice_interview_permission_protect_history()',
  'private.voice_interview_permission_protect_registry()',
  'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)',
  'private.sc19_voice_entitlement_guard()',
  'private.sc010c_preparation_guard()',
  'private.sc010c_request_guard()',
  'private.voice_interview_permission_lock_revocation()',
  'private.voice_interview_permission_status(uuid,uuid,uuid)',
  'private.ingest_voice_interview_permission_receipt(jsonb)',
  'private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)',
  'private.sc010c_preparation_current_guard()',
  'private.erasure_voice_refund_deleted()',
  'private.erasure_voice_lock_entitlements(uuid)',
  'private.erasure_row_candidates(text,jsonb)',
  'private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant select,delete on private.voice_interview_permission_receipts,private.voice_interview_permission_revocations,private.sc010c_voice_preparations,private.sc010c_voice_preparation_requests to erasure_purge_owner;
grant execute on function private.erasure_voice_lock_entitlements(uuid) to erasure_purge_owner;
grant execute on function private.ingest_voice_interview_permission_receipt(jsonb) to voice_permission_verifier;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from 'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39' then
  raise exception 'voice_pool_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r19 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_pool_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-8])([^0-9]|$)') then
  raise exception 'voice_pool_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r19%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_pool_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r18(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r18(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_pool_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid in ('private.voice_interview_permission_receipts'::regclass,'private.voice_interview_permission_revocations'::regclass,'private.sc010c_voice_preparations'::regclass,'private.sc010c_voice_preparation_requests'::regclass,'private.voice_interview_permission_policies'::regclass,'private.voice_interview_permission_issuers'::regclass,'private.sc19_voice_entitlements'::regclass)
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_pool_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array['private.voice_interview_permission_protect_history()','private.voice_interview_permission_protect_registry()','private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)','private.sc19_voice_entitlement_guard()','private.sc010c_preparation_guard()','private.sc010c_request_guard()','private.voice_interview_permission_lock_revocation()','private.voice_interview_permission_status(uuid,uuid,uuid)','private.ingest_voice_interview_permission_receipt(jsonb)','private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)','private.sc010c_preparation_current_guard()','private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_pool_function_exposed' using errcode='55000';end if;
 -- The receipt verifier is an isolated nologin role: one entry point, no table access.
 if exists(select 1 from pg_roles where rolname='voice_permission_verifier'
  and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_auth_members m where m.roleid='voice_permission_verifier'::regrole and m.member<>(select oid from pg_roles where rolname=current_user))
  or exists(select 1 from pg_auth_members m where m.member='voice_permission_verifier'::regrole)
  or exists(select 1 from pg_class c where c.oid in ('private.voice_interview_permission_receipts'::regclass,'private.voice_interview_permission_revocations'::regclass,'private.sc010c_voice_preparations'::regclass,'private.sc010c_voice_preparation_requests'::regclass,'private.voice_interview_permission_policies'::regclass,'private.voice_interview_permission_issuers'::regclass,'private.sc19_voice_entitlements'::regclass,'private.erasure_inventory_baseline_r19'::regclass)
   and has_table_privilege('voice_permission_verifier',c.oid,'select,insert,update,delete,truncate,references,trigger'))
  or exists(select 1 from pg_proc p where p.oid=any(array['private.voice_interview_permission_protect_history()','private.voice_interview_permission_protect_registry()','private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)','private.sc19_voice_entitlement_guard()','private.sc010c_preparation_guard()','private.sc010c_request_guard()','private.voice_interview_permission_lock_revocation()','private.voice_interview_permission_status(uuid,uuid,uuid)','private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)','private.sc010c_preparation_current_guard()','private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[])
   and has_function_privilege('voice_permission_verifier',p.oid,'execute'))
  or not has_function_privilege('voice_permission_verifier','private.ingest_voice_interview_permission_receipt(jsonb)','execute') then
  raise exception 'voice_pool_verifier_not_isolated' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array['private.voice_interview_permission_lock_revocation()','private.voice_interview_permission_status(uuid,uuid,uuid)','private.ingest_voice_interview_permission_receipt(jsonb)','private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)','private.sc010c_preparation_current_guard()','private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array['private.voice_interview_permission_protect_history()','private.voice_interview_permission_protect_registry()','private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)','private.sc19_voice_entitlement_guard()','private.sc010c_preparation_guard()','private.sc010c_request_guard()','private.voice_interview_permission_lock_revocation()','private.voice_interview_permission_status(uuid,uuid,uuid)','private.ingest_voice_interview_permission_receipt(jsonb)','private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)','private.sc010c_preparation_current_guard()','private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_pool_definer_search_path' using errcode='55000';end if;
 if exists(select 1 from pg_attribute where attrelid='private.sc19_voice_entitlements'::regclass and attnum>0 and not attisdropped
  and attname in ('package','price','amount','currency','order_id','free_trial_approved','paid_settlement_verified')) then
  raise exception 'voice_pool_commerce_column' using errcode='55000';end if;
end $postflight$;
commit;
