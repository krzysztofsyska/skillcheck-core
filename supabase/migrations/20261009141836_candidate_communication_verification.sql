-- SC-010 B2: offline verified evidence and human approval; no dispatch capability.
begin;
do $$
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='contact_verifier') then
  create role contact_verifier nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 elsif exists(select 1 from pg_catalog.pg_roles where rolname='contact_verifier'
  and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r
   on r.oid=m.roleid or r.oid=m.member where r.rolname='contact_verifier') then
  raise exception using errcode='42501',message='Existing contact verifier role is not isolated';
 end if;
end;$$;
grant usage on schema private to contact_verifier;

-- Empty deployment registries. Only separately reviewed administrative provisioning may populate these.
create table private.contact_trusted_issuers (
 company_id uuid not null references public.companies(id) on delete restrict,
 issuer_id text not null, key_id text not null, enabled boolean not null default false,
 valid_from timestamptz not null, valid_until timestamptz not null,
 primary key(company_id,issuer_id,key_id), check(valid_until>valid_from),
 check(issuer_id ~ '^[A-Za-z0-9_.-]{1,80}$' and key_id ~ '^[A-Za-z0-9_.-]{1,80}$')
);
create table private.contact_policy_templates (
 company_id uuid not null references public.companies(id) on delete restrict,
 notice_version text not null, policy_version text not null, template_version text not null,
 channel text not null check(channel in ('email','sms','voice')),
 purpose text not null check(purpose='verification_invitation'), enabled boolean not null default false,
 valid_from timestamptz not null, valid_until timestamptz not null,
 primary key(company_id,notice_version,policy_version,template_version,channel,purpose),
 check(valid_until>valid_from), check(length(notice_version) between 1 and 80 and length(policy_version) between 1 and 80 and length(template_version) between 1 and 80)
);
create table private.candidate_verified_contact_points (
 id uuid primary key default gen_random_uuid(), company_id uuid not null,candidate_id uuid not null,
 channel text not null check(channel in ('email','sms','voice')), version bigint not null check(version>0),
 contact_digest text not null check(contact_digest ~ '^[0-9a-f]{64}$'), envelope jsonb not null,
 candidate_updated_at timestamptz not null, created_at timestamptz not null default now(),
 unique(company_id,candidate_id,channel,version), unique(company_id,id),
 foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict
);
create table private.candidate_verified_contact_receipts (
 id uuid primary key,company_id uuid not null,candidate_id uuid not null,recruitment_id uuid not null,
 channel text not null check(channel in ('email','sms','voice')),purpose text not null check(purpose='verification_invitation'),
 contact_point_id uuid not null,issuer_id text not null,key_id text not null,nonce uuid not null,
 notice_version text not null,policy_version text not null,template_version text not null,
 global_permission_revision bigint not null,scoped_permission_revision bigint not null,preference_revision bigint not null,
 issued_at timestamptz not null,expires_at timestamptz not null,receipt_json jsonb not null,created_at timestamptz not null default now(),
 unique(company_id,id),unique(company_id,issuer_id,key_id,nonce),
 foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict,
 foreign key(company_id,recruitment_id) references public.recruitments(company_id,id) on delete restrict,
 foreign key(company_id,contact_point_id) references private.candidate_verified_contact_points(company_id,id) on delete restrict,
 foreign key(company_id,issuer_id,key_id) references private.contact_trusted_issuers(company_id,issuer_id,key_id) on delete restrict,
 foreign key(company_id,notice_version,policy_version,template_version,channel,purpose) references private.contact_policy_templates(company_id,notice_version,policy_version,template_version,channel,purpose) on delete restrict
);
create index verified_receipts_candidate_idx on private.candidate_verified_contact_receipts(company_id,candidate_id);
create index verified_receipts_recruitment_idx on private.candidate_verified_contact_receipts(company_id,recruitment_id);
create index verified_receipts_contact_idx on private.candidate_verified_contact_receipts(company_id,contact_point_id);
create index verified_receipts_policy_idx on private.candidate_verified_contact_receipts(company_id,notice_version,policy_version,template_version,channel,purpose);
create table public.candidate_communication_approvals (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,communication_id uuid not null,
 communication_version bigint not null,receipt_id uuid not null,contact_version bigint not null,
 shortlist_entry_id uuid not null,analysis_id uuid not null,review_id uuid not null,ranking_policy_version text not null,
 approved_by uuid not null,approved_at timestamptz not null default now(),
 unique(communication_id,communication_version),unique(communication_id,receipt_id),
 foreign key(company_id,communication_id) references public.candidate_communications(company_id,id) on delete restrict,
 foreign key(company_id,receipt_id) references private.candidate_verified_contact_receipts(company_id,id) on delete restrict,
 foreign key(company_id,shortlist_entry_id) references public.recruitment_shortlist_entries(company_id,id) on delete restrict,
 foreign key(company_id,analysis_id) references public.screening_analysis_versions(company_id,id) on delete restrict,
 foreign key(company_id,review_id) references public.screening_result_reviews(company_id,id) on delete restrict
);
create index communication_approvals_company_idx on public.candidate_communication_approvals(company_id,communication_id);
create index communication_approvals_shortlist_idx on public.candidate_communication_approvals(company_id,shortlist_entry_id);
create index communication_approvals_analysis_idx on public.candidate_communication_approvals(company_id,analysis_id);
create index communication_approvals_review_idx on public.candidate_communication_approvals(company_id,review_id);
create index communication_approvals_receipt_idx on public.candidate_communication_approvals(company_id,receipt_id);

-- No public entry point: the offline server verifies Ed25519 and encrypts first.
-- This dedicated capability is trusted only for that attestation; ordinary actors cannot call it.
create function private.ingest_verified_contact_receipt(receipt jsonb,contact_envelope jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare r private.candidate_verified_contact_receipts; existing private.candidate_verified_contact_receipts;
 candidate public.candidates; point_id uuid; current_version bigint; field text; revision bigint;
begin
 if jsonb_typeof(receipt) is distinct from 'object' or pg_column_size(receipt)>10000
  or jsonb_typeof(contact_envelope) is distinct from 'object' or pg_column_size(contact_envelope)>8000 then
  raise exception using errcode='PT422',message='Invalid verification receipt'; end if;
 if (select count(*) from jsonb_object_keys(receipt))<>20 or not receipt ?& array[
 'receipt_id','company_id','candidate_id','recruitment_id','channel','purpose','notice_version','policy_version','template_version',
 'contact_digest','global_permission_revision','scoped_permission_revision','preference_revision','expected_contact_version',
 'issuer_id','key_id','nonce','issued_at','expires_at','proof_type'] then
 -- 20 canonical fields. Reject all additional data, especially plaintext contact values.
 raise exception using errcode='PT422',message='Invalid verification receipt'; end if;
 for field in select jsonb_object_keys(receipt) loop
  if field in ('global_permission_revision','scoped_permission_revision','preference_revision','expected_contact_version') then
   if jsonb_typeof(receipt->field) is distinct from 'number' or receipt->>field !~ '^[0-9]{1,16}$'
    or (receipt->>field)::numeric>9007199254740990 then raise exception using errcode='PT422',message='Invalid verification receipt'; end if;
  elsif jsonb_typeof(receipt->field) is distinct from 'string' or length(receipt->>field)>100 then
   raise exception using errcode='PT422',message='Invalid verification receipt'; end if;
 end loop;
 if receipt->>'proof_type'<>'candidate_contact_and_permission_verified_v1'
  or receipt->>'channel' not in ('email','sms','voice') or receipt->>'purpose'<>'verification_invitation'
  or receipt->>'contact_digest' !~ '^[0-9a-f]{64}$'
  or receipt->>'issuer_id' !~ '^[A-Za-z0-9_.-]{1,80}$' or receipt->>'key_id' !~ '^[A-Za-z0-9_.-]{1,80}$'
  or (select count(*) from jsonb_object_keys(contact_envelope))<>5
  or not contact_envelope ?& array['algorithm','key_id','iv','ciphertext','tag']
  or contact_envelope->>'algorithm'<>'A256GCM' then raise exception using errcode='PT422',message='Invalid verification receipt'; end if;
 for field in select jsonb_object_keys(contact_envelope) loop
  if jsonb_typeof(contact_envelope->field) is distinct from 'string' then raise exception using errcode='PT422',message='Invalid encrypted contact'; end if;
 end loop;
 if contact_envelope->>'key_id' !~ '^[A-Za-z0-9_.-]{1,80}$' or contact_envelope->>'iv' !~ '^[A-Za-z0-9_-]{16}$'
  or contact_envelope->>'tag' !~ '^[A-Za-z0-9_-]{22}$' or (contact_envelope->>'ciphertext' !~ '^[A-Za-z0-9_-]+$' or length(contact_envelope->>'ciphertext')>2048)
 then raise exception using errcode='PT422',message='Invalid encrypted contact'; end if;
 r.id:=(receipt->>'receipt_id')::uuid;r.company_id:=(receipt->>'company_id')::uuid;
 r.candidate_id:=(receipt->>'candidate_id')::uuid;r.recruitment_id:=(receipt->>'recruitment_id')::uuid;
 r.channel:=receipt->>'channel';r.purpose:=receipt->>'purpose';r.issuer_id:=receipt->>'issuer_id';r.key_id:=receipt->>'key_id';r.nonce:=(receipt->>'nonce')::uuid;
 r.notice_version:=receipt->>'notice_version';r.policy_version:=receipt->>'policy_version';r.template_version:=receipt->>'template_version';
 r.global_permission_revision:=(receipt->>'global_permission_revision')::bigint;
 r.scoped_permission_revision:=(receipt->>'scoped_permission_revision')::bigint;r.preference_revision:=(receipt->>'preference_revision')::bigint;
 if receipt->>'issued_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$'
  or receipt->>'expires_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$' then
 raise exception using errcode='PT422',message='Invalid verification receipt'; end if;
 r.issued_at:=(receipt->>'issued_at')::timestamptz;r.expires_at:=(receipt->>'expires_at')::timestamptz;
 select * into candidate from public.candidates where company_id=r.company_id and id=r.candidate_id for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
 select * into existing from private.candidate_verified_contact_receipts where id=r.id;
 if found then
  if existing.receipt_json is distinct from receipt then raise exception using errcode='PT409',message='Receipt conflict'; end if;
  return existing.id; -- Replay never restores contact versions, permissions or cancelled drafts.
 end if;
 if r.issued_at>now() or r.expires_at<=now() or r.expires_at<=r.issued_at or r.expires_at>r.issued_at+interval '15 minutes' then
 raise exception using errcode='PT409',message='Verification receipt expired or unavailable'; end if;
 perform 1 from private.contact_trusted_issuers where company_id=r.company_id and issuer_id=r.issuer_id and key_id=r.key_id
  and enabled and valid_from<=r.issued_at and valid_until>=r.expires_at for share nowait;
 if not found then raise exception using errcode='PT409',message='Verification authority unavailable'; end if;
 perform 1 from private.contact_policy_templates where company_id=r.company_id and notice_version=r.notice_version and policy_version=r.policy_version
  and template_version=r.template_version and channel=r.channel and purpose=r.purpose and enabled and valid_from<=r.issued_at and valid_until>=r.expires_at for share nowait;
 if not found then raise exception using errcode='PT409',message='Verification policy unavailable'; end if;
 perform 1 from public.recruitments where id=r.recruitment_id and company_id=r.company_id for share nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
 if private.contact_receipt_permission_reason(r.company_id,r.candidate_id,r.recruitment_id,r.channel,
  r.global_permission_revision,r.scoped_permission_revision,r.preference_revision) is not null then
 raise exception using errcode='PT409',message='Contact permission changed or denied'; end if;
 select coalesce(max(version),0) into current_version from private.candidate_verified_contact_points where company_id=r.company_id and candidate_id=r.candidate_id and channel=r.channel;
 if current_version<>(receipt->>'expected_contact_version')::bigint then raise exception using errcode='PT409',message='Contact version changed'; end if;
 insert into private.candidate_verified_contact_points(company_id,candidate_id,channel,version,contact_digest,envelope,candidate_updated_at)
 values(r.company_id,r.candidate_id,r.channel,current_version+1,receipt->>'contact_digest',contact_envelope,candidate.updated_at) returning id into point_id;
 insert into private.candidate_verified_contact_receipts(id,company_id,candidate_id,recruitment_id,channel,purpose,contact_point_id,issuer_id,key_id,nonce,
 notice_version,policy_version,template_version,global_permission_revision,scoped_permission_revision,preference_revision,issued_at,expires_at,receipt_json)
 values(r.id,r.company_id,r.candidate_id,r.recruitment_id,r.channel,r.purpose,point_id,r.issuer_id,r.key_id,r.nonce,r.notice_version,r.policy_version,r.template_version,
 r.global_permission_revision,r.scoped_permission_revision,r.preference_revision,r.issued_at,r.expires_at,receipt);
 return r.id;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Verification source changed';
 when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range or check_violation or foreign_key_violation then
 raise exception using errcode='PT422',message='Invalid verification receipt';
end;$$;

create function private.contact_receipt_permission_reason(tenant uuid,candidate uuid,recruitment uuid,contact_channel text,global_revision bigint,scoped_revision bigint,pref_revision bigint)
returns text language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from public.candidate_contact_permissions where company_id=tenant and candidate_id=candidate and channel=contact_channel
  and (recruitment_id is null or recruitment_id=recruitment) and state in ('blocked','revoked'))
  or exists(select 1 from public.candidate_contact_preferences where company_id=tenant and candidate_id=candidate and contact_channel=any(blocked_channels)) then return 'permission_denied';end if;
 if coalesce((select revision from public.candidate_contact_permissions where company_id=tenant and candidate_id=candidate and channel=contact_channel and recruitment_id is null),0)<>global_revision
  or coalesce((select revision from public.candidate_contact_permissions where company_id=tenant and candidate_id=candidate and channel=contact_channel and recruitment_id=recruitment),0)<>scoped_revision
  or coalesce((select revision from public.candidate_contact_preferences where company_id=tenant and candidate_id=candidate),0)<>pref_revision then return 'permission_changed';end if;
 return null;
end;$$;

create function private.contact_receipt_status(target_communication uuid,target_receipt uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare c public.candidate_communications;r private.candidate_verified_contact_receipts;p private.candidate_verified_contact_points;reason text;s record;
begin
 select * into c from public.candidate_communications where id=target_communication;
 if c.id is null or c.state<>'draft' then return 'communication_cancelled';end if;
 select * into r from private.candidate_verified_contact_receipts where id=target_receipt and company_id=c.company_id and candidate_id=c.candidate_id
 and recruitment_id=c.recruitment_id and channel=c.channel and purpose=c.purpose;
 if not found then return 'receipt_unavailable';end if;
 if r.expires_at<=now() or r.issued_at>now() then return 'receipt_expired';end if;
 if not exists(select 1 from private.contact_trusted_issuers where company_id=r.company_id and issuer_id=r.issuer_id and key_id=r.key_id and enabled and valid_from<=r.issued_at and valid_until>=r.expires_at)
 then return 'issuer_unavailable';end if;
 if not exists(select 1 from private.contact_policy_templates where company_id=r.company_id and notice_version=r.notice_version and policy_version=r.policy_version
 and template_version=r.template_version and channel=r.channel and purpose=r.purpose and enabled and valid_from<=r.issued_at and valid_until>=r.expires_at)
 then return 'policy_unavailable';end if;
 reason:=private.contact_receipt_permission_reason(r.company_id,r.candidate_id,r.recruitment_id,r.channel,r.global_permission_revision,r.scoped_permission_revision,r.preference_revision);
 if reason is not null then return reason;end if;
 select * into p from private.candidate_verified_contact_points where id=r.contact_point_id;
 if p.version<>(select max(version) from private.candidate_verified_contact_points where company_id=r.company_id and candidate_id=r.candidate_id and channel=r.channel)
 or p.candidate_updated_at is distinct from (select updated_at from public.candidates where id=r.candidate_id and company_id=r.company_id) then return 'contact_changed';end if;
 if not exists(select 1 from public.applications where id=c.application_id and company_id=c.company_id and candidate_id=c.candidate_id and recruitment_id=c.recruitment_id and status in ('new','in_progress'))
 or not exists(select 1 from public.recruitments where id=c.recruitment_id and company_id=c.company_id and status='open') then return 'application_unavailable';end if;
 select * into s from public.get_recruitment_shortlist(c.recruitment_id,false) where entry_id=c.shortlist_entry_id;
 if not found or not s.snapshot_current or not s.policy_current then return 'shortlist_changed';end if;
 return null;
end;$$;

create function public.approve_candidate_communication(target_communication uuid,expected_version bigint,receipt_id uuid,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare c public.candidate_communications;tenant uuid;result uuid;data jsonb;r private.candidate_verified_contact_receipts;
 e public.recruitment_shortlist_entries;a public.screening_analysis_versions;reason text;
begin
 select * into c from public.candidate_communications where id=target_communication;
 tenant:=private.contact_lock_candidate(c.candidate_id);
 if expected_version is null or expected_version<1 or receipt_id is null then raise exception using errcode='PT422',message='Invalid approval input';end if;
 data:=jsonb_build_array(target_communication,expected_version,receipt_id);
 result:=private.contact_request_result(tenant,'approve',request_key,data);
 if result is not null then return result;end if;
 select * into c from public.candidate_communications where id=target_communication and company_id=tenant for update nowait;
 if c.version<>expected_version or c.state<>'draft' then raise exception using errcode='PT409',message='Communication changed';end if;
 select * into e from public.recruitment_shortlist_entries where id=c.shortlist_entry_id and company_id=tenant for share nowait;
 select * into a from public.screening_analysis_versions where id=e.analysis_id and company_id=tenant for share nowait;
 perform 1 from public.applications where id=c.application_id and company_id=tenant for share nowait;
 perform 1 from public.recruitments where id=c.recruitment_id and company_id=tenant for share nowait;
 perform 1 from public.positions where id=a.position_id and company_id=tenant for share nowait;
 perform 1 from public.candidate_documents where company_id=tenant and candidate_id=c.candidate_id order by created_at desc,id desc limit 1 for share nowait;
 select * into r from private.candidate_verified_contact_receipts where id=receipt_id and company_id=tenant;
 perform 1 from private.contact_trusted_issuers where company_id=tenant and issuer_id=r.issuer_id and key_id=r.key_id for share nowait;
 perform 1 from private.contact_policy_templates where company_id=tenant and notice_version=r.notice_version and policy_version=r.policy_version and template_version=r.template_version and channel=r.channel and purpose=r.purpose for share nowait;
 reason:=private.contact_receipt_status(c.id,receipt_id);
 if reason is not null then raise exception using errcode='PT409',message='Approval evidence unavailable or changed';end if;
 update public.candidate_communications set version=version+1,updated_at=now() where id=c.id returning version into c.version;
 insert into public.candidate_communication_approvals(company_id,communication_id,communication_version,receipt_id,contact_version,shortlist_entry_id,analysis_id,review_id,ranking_policy_version,approved_by)
 values(tenant,c.id,c.version,receipt_id,(select version from private.candidate_verified_contact_points where id=r.contact_point_id),e.id,e.analysis_id,e.review_id,e.ranking_policy_version,auth.uid()) returning id into result;
 insert into private.contact_requests values(tenant,auth.uid(),'approve',request_key,data,result,now());
 return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Approval source changed';
end;$$;

create function public.get_communication_approval_status(target_communication uuid)
returns table(approval_id uuid,is_current boolean,reason text) language plpgsql stable security definer set search_path='' as $$
declare c public.candidate_communications;a public.candidate_communication_approvals;why text;
begin
 if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required';end if;
 select * into c from public.candidate_communications where id=target_communication;
 if not found or not private.has_company_access(c.company_id) then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into a from public.candidate_communication_approvals where communication_id=c.id order by communication_version desc limit 1;
 if not found then return query select null::uuid,false,'not_approved'::text;return;end if;
 if a.communication_version<>c.version then why:='communication_changed';
 else why:=private.contact_receipt_status(c.id,a.receipt_id);end if;
 return query select a.id,why is null,coalesce(why,'current');
end;$$;

do $$declare t text;f record;
begin
 foreach t in array array['candidate_verified_contact_points','candidate_verified_contact_receipts'] loop
 execute format('create trigger immutable_history before update or delete on private.%I for each row execute function private.contact_immutable()',t);end loop;
 create trigger immutable_history before update or delete on public.candidate_communication_approvals for each row execute function private.contact_immutable();
 foreach t in array array['contact_trusted_issuers','contact_policy_templates','candidate_verified_contact_points','candidate_verified_contact_receipts'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,screening_worker,contact_verifier',t);end loop;
 alter table public.candidate_communication_approvals enable row level security;
 revoke all on public.candidate_communication_approvals from public,anon,authenticated,screening_worker,contact_verifier;
 grant select on public.candidate_communication_approvals to authenticated;
 create policy tenant_read on public.candidate_communication_approvals for select to authenticated using(private.has_company_access(company_id));
 for f in select p.oid::regprocedure signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='private' and p.proname in ('ingest_verified_contact_receipt','contact_receipt_permission_reason','contact_receipt_status'))
 or (n.nspname='public' and p.proname in ('approve_candidate_communication','get_communication_approval_status')) loop
 execute format('revoke all on function %s from public,anon,authenticated,screening_worker,contact_verifier',f.signature);
 if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.signature);
 elsif f.proname='ingest_verified_contact_receipt' then execute format('grant execute on function %s to contact_verifier',f.signature);end if;end loop;
end;$$;
commit;
