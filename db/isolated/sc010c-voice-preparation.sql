-- SC-010-C offline preparation, installed only in a disposable test database.
-- Requires the full accepted migration chain, SC012 isolated plan persistence,
-- SC010 interview permission receipts and the separate SC019 voice entitlement.
-- No public RPC/grant, migration, dispatch state or provider transport.
-- These candidate-linked tables MUST gain reviewed erasure/restore adapters
-- before deployment. The installed R4 schema inventory is deliberately unchanged.
begin;

create unique index sc010c_application_subject_uq
 on public.applications(company_id,recruitment_id,candidate_id,id);
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
language plpgsql security definer set search_path='' as $$
begin
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
language plpgsql security definer set search_path='' as $$
declare subject uuid;
begin
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
commit;
