begin;
-- SC-010-R2: reversible freeze. No purge capability or trigger bypass is introduced.
-- Independent denials remain authoritative, using transaction-owned private context.
create table private.erasure_denial_context (
 txid bigint not null, candidate_id uuid not null references public.candidates(id) on delete restrict,
 primary key(txid,candidate_id)
);
alter table private.erasure_denial_context enable row level security;
revoke all on private.erasure_denial_context from public,anon,authenticated,screening_worker,contact_verifier;

create function private.erasure_candidate_frozen(target_candidate uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.erasure_candidate_lifecycle where candidate_id=target_candidate and status='frozen')
$$;

create function private.erasure_lock_candidate(target_candidate uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Candidate workflow requires read committed';end if;
 if target_candidate is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.candidates where id=target_candidate for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if private.erasure_candidate_frozen(target_candidate) and not exists(
  select 1 from private.erasure_denial_context where txid=txid_current() and candidate_id=target_candidate
 ) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Candidate workflow busy';
end;$$;

-- Explicit graph adapter, never a UUID substring search. Resolve every candidate-bearing
-- reference, including cross references to a document, receipt or historical review.
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];subject uuid;
begin
 if adapter='public.candidates' then return array[(data->>'id')::uuid];end if;
 if adapter='private.contact_requests' then
  subject:=private.erasure_contact_request_candidate((data->>'company_id')::uuid,data->>'operation',data->'payload',(data->>'result_id')::uuid);
  if subject is null then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
  return array[subject];
 end if;
 if adapter not in ('public.candidate_documents','public.applications','public.candidate_assessments','public.behavior_assessment_entries','public.exercise_observation_entries','public.screening_analysis_versions','public.screening_analysis_attempts','public.screening_criterion_results','public.screening_result_reviews','public.screening_criterion_review_overrides','public.recruitment_shortlist_entries','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_communications','public.candidate_communication_events','public.candidate_communication_approvals','private.contact_audit','private.contact_requests','private.candidate_verified_contact_receipts','private.candidate_verified_contact_points') then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 with analyses as (
  select a.id,a.application_id,a.candidate_document_id from public.screening_analysis_versions a
  where a.id=(data->>'analysis_id')::uuid
   or a.id in(select r.analysis_id from public.screening_result_reviews r where r.id=(data->>'review_id')::uuid)
   or a.id in(select r.analysis_id from public.screening_criterion_results r where r.id=(data->>'criterion_result_id')::uuid)
 ), subjects as (
  select (data->>'candidate_id')::uuid id
  union select a.candidate_id from public.applications a where a.id=(data->>'application_id')::uuid or a.id in(select application_id from analyses)
  union select d.candidate_id from public.candidate_documents d where d.id=(data->>'candidate_document_id')::uuid or d.id in(select candidate_document_id from analyses)
  union select c.candidate_id from public.candidate_communications c where c.id=(data->>'communication_id')::uuid
  union select r.candidate_id from private.candidate_verified_contact_receipts r where r.id=(data->>'receipt_id')::uuid
  union select p.candidate_id from private.candidate_verified_contact_points p where p.id=(data->>'contact_point_id')::uuid
  union select a.candidate_id from public.applications a join public.recruitment_shortlist_entries s on s.application_id=a.id where s.id=(data->>'shortlist_entry_id')::uuid
 ) select array_agg(distinct id order by id) into ids from subjects where id is not null;
 if coalesce(cardinality(ids),0)=0 then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 return ids;
end;$$;

create function private.erasure_row_visible(adapter text,data jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then return false;end if;
 if auth.uid() is null or not private.has_company_access((data->>'company_id')::uuid) then return false;end if;
 if exists(select 1 from unnest(private.erasure_row_candidates(adapter,data)) s(id) where not exists(select 1 from public.candidates c where c.id=s.id and c.company_id=(data->>'company_id')::uuid)) then return false;end if;
 return not exists(select 1 from unnest(private.erasure_row_candidates(adapter,data)) s(id) where private.erasure_candidate_frozen(s.id));
exception when invalid_text_representation or sqlstate 'PT409' then return false;
end;$$;

-- INSERT ... RETURNING checks SELECT policy before the new candidate is queryable.
-- Tenant-filtered lifecycle lookup does not reveal another firm's UUID or freeze state.
create function private.candidate_workflow_visible(tenant uuid,subject uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select current_setting('transaction_isolation') in ('read committed','read uncommitted')
  and auth.uid() is not null and private.has_company_access(tenant)
  and not exists(select 1 from private.erasure_candidate_lifecycle where company_id=tenant and candidate_id=subject and status='frozen')
$$;

create function private.erasure_guard_candidate_row() returns trigger
language plpgsql security definer set search_path='' as $$
declare data jsonb;old_data jsonb;ids uuid[];subject uuid;k text;
begin
 if tg_op='DELETE' and tg_table_name in ('candidates','applications') then
  raise exception using errcode='PT409',message='Controlled erasure required';
 end if;
 if tg_op='UPDATE' then
  old_data:=to_jsonb(old);data:=to_jsonb(new);
  foreach k in array array['id','company_id','candidate_id','application_id','recruitment_id','candidate_document_id','analysis_id','review_id','criterion_result_id','communication_id','receipt_id','contact_point_id','shortlist_entry_id','stage_id','definition_entry_id','definition_id','exercise_definition_id'] loop
   if old_data->k is distinct from data->k then raise exception using errcode='PT409',message='Candidate identity is immutable';end if;
  end loop;
 end if;
 data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 -- The initial INSERT has no candidate row to lock; UUID/company mutations are forbidden above.
 if tg_table_name='candidates' and tg_op='INSERT' then return new;end if;
 ids:=private.erasure_row_candidates(tg_table_schema||'.'||tg_table_name,data);
 foreach subject in array ids loop perform private.erasure_lock_candidate(subject);end loop;
 if tg_op='DELETE' then return old;end if;
 return new;
end;$$;

-- Parent cascades are never a substitute for scoped erasure. Shared source updates
-- also lock their affected candidates, closing authorise-vs-context-change races.
create function private.erasure_guard_parent_row() returns trigger
language plpgsql security definer set search_path='' as $$
declare subjects uuid[];subject uuid;data jsonb:=to_jsonb(old);
begin
 if tg_op='UPDATE' and (to_jsonb(new)->'id' is distinct from data->'id' or to_jsonb(new)->'company_id' is distinct from data->'company_id') then
  raise exception using errcode='PT409',message='Parent identity is immutable';
 end if;
 if tg_table_name='companies' then select array_agg(id order by id) into subjects from public.candidates where company_id=old.id;
 elsif tg_table_name='positions' then
  select array_agg(distinct a.candidate_id order by a.candidate_id) into subjects from public.applications a join public.recruitments r on r.id=a.recruitment_id where r.position_id=old.id;
 elsif tg_table_name='recruitments' then
  select array_agg(distinct candidate_id order by candidate_id) into subjects from public.applications where recruitment_id=old.id;
 elsif tg_table_name in ('assessment_stages','exercise_definition_entries') then
  select array_agg(distinct candidate_id order by candidate_id) into subjects from public.applications where recruitment_id=(data->>'recruitment_id')::uuid;
 end if;
 if tg_op='DELETE' and cardinality(subjects)>0 then raise exception using errcode='PT409',message='Controlled erasure required';end if;
 foreach subject in array coalesce(subjects,'{}'::uuid[]) loop perform private.erasure_lock_candidate(subject);end loop;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
create trigger aa_erasure_guard before insert or update or delete on public.candidates for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidates as restrictive for select to authenticated using (private.candidate_workflow_visible(company_id,id));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_documents for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_documents as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_documents',to_jsonb(candidate_documents)));
create trigger aa_erasure_guard before insert or update or delete on public.applications for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.applications as restrictive for select to authenticated using (private.erasure_row_visible('public.applications',to_jsonb(applications)));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_assessments for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_assessments as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_assessments',to_jsonb(candidate_assessments)));
create trigger aa_erasure_guard before insert or update or delete on public.behavior_assessment_entries for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.behavior_assessment_entries as restrictive for select to authenticated using (private.erasure_row_visible('public.behavior_assessment_entries',to_jsonb(behavior_assessment_entries)));
create trigger aa_erasure_guard before insert or update or delete on public.exercise_observation_entries for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.exercise_observation_entries as restrictive for select to authenticated using (private.erasure_row_visible('public.exercise_observation_entries',to_jsonb(exercise_observation_entries)));
create trigger aa_erasure_guard before insert or update or delete on public.screening_analysis_versions for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.screening_analysis_versions as restrictive for select to authenticated using (private.erasure_row_visible('public.screening_analysis_versions',to_jsonb(screening_analysis_versions)));
create trigger aa_erasure_guard before insert or update or delete on public.screening_analysis_attempts for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.screening_analysis_attempts as restrictive for select to authenticated using (private.erasure_row_visible('public.screening_analysis_attempts',to_jsonb(screening_analysis_attempts)));
create trigger aa_erasure_guard before insert or update or delete on public.screening_criterion_results for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.screening_criterion_results as restrictive for select to authenticated using (private.erasure_row_visible('public.screening_criterion_results',to_jsonb(screening_criterion_results)));
create trigger aa_erasure_guard before insert or update or delete on public.screening_result_reviews for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.screening_result_reviews as restrictive for select to authenticated using (private.erasure_row_visible('public.screening_result_reviews',to_jsonb(screening_result_reviews)));
create trigger aa_erasure_guard before insert or update or delete on public.screening_criterion_review_overrides for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.screening_criterion_review_overrides as restrictive for select to authenticated using (private.erasure_row_visible('public.screening_criterion_review_overrides',to_jsonb(screening_criterion_review_overrides)));
create trigger aa_erasure_guard before insert or update or delete on public.recruitment_shortlist_entries for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.recruitment_shortlist_entries as restrictive for select to authenticated using (private.erasure_row_visible('public.recruitment_shortlist_entries',to_jsonb(recruitment_shortlist_entries)));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_contact_permissions for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_contact_permissions as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_contact_permissions',to_jsonb(candidate_contact_permissions)));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_contact_preferences for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_contact_preferences as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_contact_preferences',to_jsonb(candidate_contact_preferences)));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_communications for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_communications as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_communications',to_jsonb(candidate_communications)));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_communication_events for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_communication_events as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_communication_events',to_jsonb(candidate_communication_events)));
create trigger aa_erasure_guard before insert or update or delete on public.candidate_communication_approvals for each row execute function private.erasure_guard_candidate_row();
create policy erasure_read_guard on public.candidate_communication_approvals as restrictive for select to authenticated using (private.erasure_row_visible('public.candidate_communication_approvals',to_jsonb(candidate_communication_approvals)));
create trigger aa_erasure_guard before insert or update or delete on private.contact_audit for each row execute function private.erasure_guard_candidate_row();
create trigger aa_erasure_guard before insert or update or delete on private.contact_requests for each row execute function private.erasure_guard_candidate_row();
create trigger aa_erasure_guard before insert or update or delete on private.candidate_verified_contact_receipts for each row execute function private.erasure_guard_candidate_row();
create trigger aa_erasure_guard before insert or update or delete on private.candidate_verified_contact_points for each row execute function private.erasure_guard_candidate_row();
create trigger aa_erasure_parent_guard before update or delete on public.companies for each row execute function private.erasure_guard_parent_row();
create trigger aa_erasure_parent_guard before update or delete on public.positions for each row execute function private.erasure_guard_parent_row();
create trigger aa_erasure_parent_guard before update or delete on public.recruitments for each row execute function private.erasure_guard_parent_row();
create trigger aa_erasure_parent_guard before update or delete on public.assessment_stages for each row execute function private.erasure_guard_parent_row();
create trigger aa_erasure_parent_guard before update or delete on public.exercise_definition_entries for each row execute function private.erasure_guard_parent_row();

create or replace function private.contact_lock_candidate(target_candidate uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid; owner_actor uuid;
begin
  if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required'; end if;
  select company_id into tenant from public.candidates where id=target_candidate;
  if not found or not private.has_company_access(tenant) then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  if not private.has_company_access(tenant,true) then raise exception using errcode='PT403',message='Write access required'; end if;
  perform 1 from public.candidates where id=target_candidate and company_id=tenant for update nowait;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  select owner_id into owner_actor from public.companies where id=tenant for share nowait;
  if owner_actor is distinct from auth.uid() then
    perform 1 from public.company_members where company_id=tenant and user_id=auth.uid() and role='recruiter' for share nowait;
    if not found then raise exception using errcode='PT403',message='Write access required'; end if;
  end if;
  perform private.erasure_lock_candidate(target_candidate);
  return tenant;
exception when lock_not_available then raise exception using errcode='PT409',message='Contact source busy';
end;
$$;

create or replace function public.record_contact_permission(
  target_candidate uuid,target_recruitment uuid,contact_channel text,permission_state text,
  evidence_ref uuid,expected_revision bigint,request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid; data jsonb; result uuid; current_row public.candidate_contact_permissions;
begin
  if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required';end if;
  select company_id into tenant from public.candidates where id=target_candidate;
  if not found or not private.has_company_access(tenant) then raise exception using errcode='PT404',message='Resource unavailable';end if;
  if not private.has_company_access(tenant,true) then raise exception using errcode='PT403',message='Write access required';end if;
  if permission_state in ('revoked','blocked') then
    insert into private.erasure_denial_context values(txid_current(),target_candidate);
  end if;
  tenant:=private.contact_lock_candidate(target_candidate);
  if contact_channel is null or contact_channel not in ('email','sms','voice')
    or permission_state is null or permission_state not in ('unverified','revoked','blocked')
    or expected_revision is null or expected_revision<0
    or (permission_state='unverified' and evidence_ref is null) then
    raise exception using errcode='PT422',message='Invalid permission claim';
  end if;
  if target_recruitment is not null then
    perform 1 from public.recruitments where id=target_recruitment and company_id=tenant for share nowait;
    if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  end if;
  data:=jsonb_build_array(target_candidate,target_recruitment,contact_channel,permission_state,evidence_ref,expected_revision);
  result:=private.contact_request_result(tenant,'permission',request_key,data);
  if result is not null then delete from private.erasure_denial_context where txid=txid_current() and candidate_id=target_candidate;return result;end if;
  select * into current_row from public.candidate_contact_permissions
    where company_id=tenant and candidate_id=target_candidate and recruitment_id is not distinct from target_recruitment and channel=contact_channel;
  if coalesce(current_row.revision,0)<>expected_revision then raise exception using errcode='PT409',message='Permission revision changed'; end if;
  -- A claim cannot clear a recorded deny. Future verified grants require a separate reviewed API.
  if current_row.state in ('revoked','blocked') and permission_state='unverified' then
    raise exception using errcode='PT409',message='Permission remains denied';
  end if;
  if current_row.id is null then
    insert into public.candidate_contact_permissions(company_id,candidate_id,recruitment_id,channel,state,revision)
      values(tenant,target_candidate,target_recruitment,contact_channel,permission_state,1) returning id into result;
  else
    update public.candidate_contact_permissions set state=permission_state,revision=revision+1,updated_at=now() where id=current_row.id returning id into result;
  end if;
  insert into private.contact_audit(company_id,candidate_id,subject_id,actor_id,action,evidence_ref,revision)
    values(tenant,target_candidate,result,auth.uid(),permission_state,evidence_ref,expected_revision+1);
  if permission_state in ('revoked','blocked') then
    perform private.contact_cancel_drafts(tenant,target_candidate,target_recruitment,contact_channel,'permission_denied');
  end if;
  insert into private.contact_requests values(tenant,auth.uid(),'permission',request_key,data,result,now());
  delete from private.erasure_denial_context where txid=txid_current() and candidate_id=target_candidate;
  return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Contact source changed';
end;
$$;

create or replace function private.ingest_verified_contact_receipt(receipt jsonb,contact_envelope jsonb) returns uuid
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
 perform private.erasure_lock_candidate(r.candidate_id);
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

create or replace function public.get_communication_approval_status(target_communication uuid)
returns table(approval_id uuid,is_current boolean,reason text) language plpgsql stable security definer set search_path='' as $$
declare c public.candidate_communications;a public.candidate_communication_approvals;why text;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Candidate workflow requires read committed';end if;
 if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required';end if;
 select * into c from public.candidate_communications where id=target_communication;
 if not found or not private.has_company_access(c.company_id) then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if private.erasure_candidate_frozen(c.candidate_id) then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into a from public.candidate_communication_approvals where communication_id=c.id order by communication_version desc limit 1;
 if not found then return query select null::uuid,false,'not_approved'::text;return;end if;
 if a.communication_version<>c.version then why:='communication_changed';
 else why:=private.contact_receipt_status(c.id,a.receipt_id);end if;
 return query select a.id,why is null,coalesce(why,'current');
end;$$;

create or replace function public.confirm_erasure_subject(target_candidate uuid,candidate_ids uuid[],expected_revision bigint,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;ids uuid[];latest bigint;payload text;old private.erasure_configuration_requests;result uuid;total integer;
begin
 select company_id into tenant from public.candidates where id=target_candidate;
 perform private.erasure_owner(tenant);
 perform 1 from public.companies where id=tenant and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if expected_revision is null or expected_revision<0 or request_key is null or candidate_ids is null
 or cardinality(candidate_ids) not between 1 and 100 or array_ndims(candidate_ids)<>1 or array_position(candidate_ids,null) is not null
 or not target_candidate=any(candidate_ids) then raise exception using errcode='PT422',message='Invalid subject resolution';end if;
 select array_agg(distinct x order by x) into ids from unnest(candidate_ids) x;
 if cardinality(ids)<>cardinality(candidate_ids) then raise exception using errcode='PT422',message='Duplicate candidate IDs';end if;
 perform 1 from public.candidates where company_id=tenant and id=any(ids) order by id for share nowait;
 get diagnostics total=row_count;
 if total<>cardinality(ids) then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if exists(select 1 from unnest(ids) s(id) where private.erasure_candidate_frozen(s.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 payload:=private.erasure_hash(jsonb_build_array(target_candidate,ids,expected_revision));
 select * into old from private.erasure_configuration_requests where company_id=tenant and actor_id=auth.uid() and operation='resolution' and erasure_configuration_requests.request_key=confirm_erasure_subject.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 select coalesce(max(revision),0) into latest from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Subject revision changed';end if;
 insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
 values(tenant,target_candidate,ids,latest+1,auth.uid()) returning id into result;
 insert into private.erasure_configuration_requests values(tenant,auth.uid(),'resolution',request_key,payload,result,now());return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Subject changed';end;$$;

create or replace function public.start_screening_analysis(
  target_application uuid,
  expected_input_fingerprint text,
  expected_payload_schema_version integer,
  requested_result_schema_version integer,
  requested_prompt_version text,
  requested_provider text,
  requested_model text,
  requested_model_revision text,
  request_idempotency_key uuid,
  force_reanalysis boolean default false
) returns table (
  analysis_id uuid,
  attempt_id uuid,
  analysis_version integer,
  execution_status text,
  reused boolean
) language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  application_company uuid;
  material jsonb;
  contract_hash text;
  existing_analysis public.screening_analysis_versions%rowtype;
  existing_attempt public.screening_analysis_attempts%rowtype;
  new_analysis_id uuid;
  new_attempt_id uuid;
  next_version integer;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_application is null or request_idempotency_key is null
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_payload_schema_version <> 1
    or requested_result_schema_version is null or requested_result_schema_version < 1
    or length(btrim(requested_prompt_version)) not between 1 and 200
    or length(btrim(requested_provider)) not between 1 and 100
    or length(btrim(requested_model)) not between 1 and 200
    or (requested_model_revision is not null
      and length(btrim(requested_model_revision)) not between 1 and 200)
    then raise exception 'Invalid screening request' using errcode = '22023'; end if;

  select company_id into application_company from public.applications where id = target_application;
  if not found or not private.has_company_access(application_company, true)
    then raise exception 'No write access' using errcode = '42501'; end if;

  perform private.erasure_lock_candidate(candidate_id) from public.applications where id=target_application;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || target_application::text, 0));
  material := private.screening_material(target_application, true);
  if material->>'company_id' <> application_company::text
    then raise exception 'Invalid tenant binding' using errcode = '42501'; end if;
  if material->>'input_fingerprint' <> expected_input_fingerprint
    then raise exception 'Screening input changed' using errcode = 'PT409'; end if;
  contract_hash := private.screening_contract_hash(
    btrim(requested_provider), btrim(requested_model),
    case when requested_model_revision is null then null else btrim(requested_model_revision) end,
    btrim(requested_prompt_version), expected_payload_schema_version, requested_result_schema_version
  );

  select * into existing_attempt
  from public.screening_analysis_attempts attempt
  where attempt.company_id = application_company
    and attempt.idempotency_key = request_idempotency_key;
  if found then
    select * into existing_analysis
    from public.screening_analysis_versions analysis
    where analysis.company_id = existing_attempt.company_id
      and analysis.id = existing_attempt.analysis_id;
    if existing_analysis.application_id <> target_application
      or existing_analysis.input_fingerprint <> expected_input_fingerprint
      or existing_analysis.analysis_contract_hash <> contract_hash
      then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
    return query select existing_analysis.id, existing_attempt.id,
      existing_analysis.analysis_version, existing_analysis.execution_status, true;
    return;
  end if;

  update public.screening_analysis_versions analysis
  set stale_at = clock_timestamp(),
      stale_reason = coalesce(private.screening_stale_reason(analysis.id), 'manual_invalidation'),
      updated_at = clock_timestamp()
  where analysis.company_id = application_company
    and analysis.application_id = target_application
    and analysis.stale_at is null
    and analysis.input_fingerprint <> expected_input_fingerprint;

  if not force_reanalysis then
    select * into existing_analysis
    from public.screening_analysis_versions analysis
    where analysis.company_id = application_company
      and analysis.application_id = target_application
      and analysis.input_fingerprint = expected_input_fingerprint
      and analysis.analysis_contract_hash = contract_hash
      and analysis.execution_status = 'completed'
      and analysis.stale_at is null
      and (select count(*) from public.screening_criterion_results criterion
        where criterion.company_id = analysis.company_id and criterion.analysis_id = analysis.id)
        = jsonb_array_length(analysis.criteria_snapshot)
      and coalesce((
        select review.disposition from public.screening_result_reviews review
        where review.company_id = analysis.company_id and review.analysis_id = analysis.id
        order by review.review_version desc limit 1
      ), '') <> 'needs_reanalysis'
    order by analysis.analysis_version desc limit 1;
    if found then
      return query select existing_analysis.id, null::uuid,
        existing_analysis.analysis_version, existing_analysis.execution_status, true;
      return;
    end if;

    select * into existing_analysis
    from public.screening_analysis_versions analysis
    where analysis.company_id = application_company
      and analysis.application_id = target_application
      and analysis.input_fingerprint = expected_input_fingerprint
      and analysis.analysis_contract_hash = contract_hash
      and analysis.execution_status in ('pending', 'processing')
    order by analysis.analysis_version desc limit 1;
    if found then
      select * into existing_attempt from public.screening_analysis_attempts attempt
      where attempt.company_id = application_company and attempt.analysis_id = existing_analysis.id
        and attempt.status in ('pending', 'processing')
      order by attempt.attempt_no desc limit 1;
      return query select existing_analysis.id, existing_attempt.id,
        existing_analysis.analysis_version, existing_analysis.execution_status, true;
      return;
    end if;
  end if;

  -- Even an explicit reanalysis cannot create a second active execution for the
  -- same input and contract. It may create a new version after the active one
  -- reaches a terminal state.
  select * into existing_analysis
  from public.screening_analysis_versions analysis
  where analysis.company_id = application_company
    and analysis.application_id = target_application
    and analysis.input_fingerprint = expected_input_fingerprint
    and analysis.analysis_contract_hash = contract_hash
    and analysis.execution_status in ('pending', 'processing')
  order by analysis.analysis_version desc limit 1;
  if found then
    select * into existing_attempt from public.screening_analysis_attempts attempt
    where attempt.company_id = application_company and attempt.analysis_id = existing_analysis.id
      and attempt.status in ('pending', 'processing')
    order by attempt.attempt_no desc limit 1;
    return query select existing_analysis.id, existing_attempt.id,
      existing_analysis.analysis_version, existing_analysis.execution_status, true;
    return;
  end if;

  select coalesce(max(analysis.analysis_version), 0) + 1 into next_version
  from public.screening_analysis_versions analysis
  where analysis.company_id = application_company and analysis.application_id = target_application;

  insert into public.screening_analysis_versions(
    company_id, recruitment_id, application_id, position_id,
    candidate_document_id, candidate_document_version, analysis_version,
    input_fingerprint, analysis_contract_hash, payload_schema_version,
    result_schema_version, prompt_version, provider, model, model_revision,
    input_cv_text_snapshot, criteria_snapshot, binding_snapshot, created_by
  ) values (
    application_company,
    (material->>'recruitment_id')::uuid,
    target_application,
    (material->>'position_id')::uuid,
    (material->>'candidate_document_id')::uuid,
    (material->>'candidate_document_version')::integer,
    next_version,
    expected_input_fingerprint,
    contract_hash,
    expected_payload_schema_version,
    requested_result_schema_version,
    btrim(requested_prompt_version),
    btrim(requested_provider),
    btrim(requested_model),
    case when requested_model_revision is null then null else btrim(requested_model_revision) end,
    material->>'input_cv_text_snapshot',
    material->'criteria_snapshot',
    material->'binding_snapshot',
    actor
  ) returning id into new_analysis_id;

  insert into public.screening_analysis_attempts(
    company_id, analysis_id, attempt_no, idempotency_key
  ) values (
    application_company, new_analysis_id, 1, request_idempotency_key
  ) returning id into new_attempt_id;

  return query select new_analysis_id, new_attempt_id, next_version, 'pending'::text, false;
end;
$$;

create or replace function public.retry_screening_analysis(
  target_analysis uuid,
  request_idempotency_key uuid
) returns table (
  analysis_id uuid,
  attempt_id uuid,
  analysis_version integer
) language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  material jsonb;
  existing_attempt public.screening_analysis_attempts%rowtype;
  active_peer public.screening_analysis_versions%rowtype;
  next_attempt integer;
  next_version integer;
  new_analysis_id uuid;
  new_attempt_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_analysis is null or request_idempotency_key is null
    then raise exception 'Invalid retry request' using errcode = '22023'; end if;
  -- Authorize before taking a lock on tenant data; match start's lock order.
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  perform private.erasure_lock_candidate(candidate_id) from public.applications where id=analysis.application_id;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;

  select * into existing_attempt from public.screening_analysis_attempts
    where company_id = analysis.company_id and idempotency_key = request_idempotency_key;
  if found then
    if existing_attempt.analysis_id <> analysis.id
      then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
    return query select analysis.id, existing_attempt.id, analysis.analysis_version;
    return;
  end if;
  if analysis.execution_status not in ('failed', 'pending')
    or exists (
      select 1 from public.screening_analysis_attempts attempt
      where attempt.company_id = analysis.company_id and attempt.analysis_id = analysis.id
        and attempt.status in ('pending', 'processing')
    ) then raise exception 'Analysis cannot be retried' using errcode = '55000'; end if;

  material := private.screening_material(analysis.application_id, true);
  select * into active_peer
  from public.screening_analysis_versions peer
  where peer.company_id = analysis.company_id
    and peer.application_id = analysis.application_id
    and peer.id <> analysis.id
    and peer.input_fingerprint = material->>'input_fingerprint'
    and peer.analysis_contract_hash = analysis.analysis_contract_hash
    and peer.execution_status in ('pending', 'processing')
  order by peer.analysis_version desc
  limit 1;
  if found then
    select * into existing_attempt
    from public.screening_analysis_attempts attempt
    where attempt.company_id = active_peer.company_id
      and attempt.analysis_id = active_peer.id
      and attempt.status in ('pending', 'processing')
    order by attempt.attempt_no desc
    limit 1;
    if not found then raise exception 'Analysis cannot be retried' using errcode = '55000'; end if;
    return query select active_peer.id, existing_attempt.id, active_peer.analysis_version;
    return;
  end if;

  if exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then raise exception 'Analysis superseded' using errcode = 'PT409'; end if;

  begin
    if material->>'input_fingerprint' = analysis.input_fingerprint then
      select coalesce(max(item.attempt_no), 0) + 1 into next_attempt
        from public.screening_analysis_attempts item
        where item.company_id = analysis.company_id and item.analysis_id = analysis.id;
      insert into public.screening_analysis_attempts(
        company_id, analysis_id, attempt_no, idempotency_key
      ) values (
        analysis.company_id, analysis.id, next_attempt, request_idempotency_key
      ) returning id into new_attempt_id;
      update public.screening_analysis_versions
        set execution_status = 'pending', failed_at = null,
          failure_code = null, failure_message = null, updated_at = clock_timestamp()
        where id = analysis.id;
      return query select analysis.id, new_attempt_id, analysis.analysis_version;
      return;
    end if;

    update public.screening_analysis_versions
      set stale_at = coalesce(stale_at, clock_timestamp()),
        stale_reason = coalesce(screening_analysis_versions.stale_reason,
          private.screening_stale_reason(analysis.id), 'manual_invalidation'),
        updated_at = clock_timestamp()
      where id = analysis.id;
    select coalesce(max(item.analysis_version), 0) + 1 into next_version
      from public.screening_analysis_versions item
      where item.company_id = analysis.company_id and item.application_id = analysis.application_id;
    insert into public.screening_analysis_versions(
      company_id, recruitment_id, application_id, position_id,
      candidate_document_id, candidate_document_version, analysis_version,
      input_fingerprint, analysis_contract_hash, payload_schema_version,
      result_schema_version, prompt_version, provider, model, model_revision,
      input_cv_text_snapshot, criteria_snapshot, binding_snapshot, created_by
    ) values (
      analysis.company_id,
      (material->>'recruitment_id')::uuid,
      analysis.application_id,
      (material->>'position_id')::uuid,
      (material->>'candidate_document_id')::uuid,
      (material->>'candidate_document_version')::integer,
      next_version,
      material->>'input_fingerprint',
      analysis.analysis_contract_hash,
      analysis.payload_schema_version,
      analysis.result_schema_version,
      analysis.prompt_version,
      analysis.provider,
      analysis.model,
      analysis.model_revision,
      material->>'input_cv_text_snapshot',
      material->'criteria_snapshot',
      material->'binding_snapshot',
      actor
    ) returning id into new_analysis_id;
    insert into public.screening_analysis_attempts(
      company_id, analysis_id, attempt_no, idempotency_key
    ) values (
      analysis.company_id, new_analysis_id, 1, request_idempotency_key
    ) returning id into new_attempt_id;
    return query select new_analysis_id, new_attempt_id, next_version;
  exception
    when unique_violation then
      select * into existing_attempt
      from public.screening_analysis_attempts attempt
      where attempt.company_id = analysis.company_id
        and attempt.idempotency_key = request_idempotency_key;
      if found then
        if existing_attempt.analysis_id <> analysis.id
          then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
        return query select analysis.id, existing_attempt.id, analysis.analysis_version;
        return;
      end if;

      select * into active_peer
      from public.screening_analysis_versions peer
      where peer.company_id = analysis.company_id
        and peer.application_id = analysis.application_id
        and peer.id <> analysis.id
        and peer.input_fingerprint = material->>'input_fingerprint'
        and peer.analysis_contract_hash = analysis.analysis_contract_hash
        and peer.execution_status in ('pending', 'processing')
      order by peer.analysis_version desc
      limit 1;
      if found then
        select * into existing_attempt
        from public.screening_analysis_attempts attempt
        where attempt.company_id = active_peer.company_id
          and attempt.analysis_id = active_peer.id
          and attempt.status in ('pending', 'processing')
        order by attempt.attempt_no desc
        limit 1;
        if found then
          return query select active_peer.id, existing_attempt.id, active_peer.analysis_version;
          return;
        end if;
      end if;
      raise exception 'Screening concurrency conflict' using errcode = 'PT409';
  end;
end;
$$;

create or replace function public.review_screening_result(
  target_analysis uuid,
  expected_review_version integer,
  new_disposition text,
  new_review_note text,
  new_overrides jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  review_id uuid;
  override_item jsonb;
  criterion public.screening_criterion_results%rowtype;
  rating text;
  evidence jsonb;
  explanation text;
  detected_stale_reason text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if expected_review_version is null or expected_review_version < 0
    or new_disposition not in ('approved', 'approved_with_changes', 'needs_reanalysis')
    or length(coalesce(new_review_note, '')) > 10000
    or jsonb_typeof(new_overrides) is distinct from 'array'
    then raise exception 'Invalid review' using errcode = '22023'; end if;

  -- Authorize before taking a lock on tenant data; match start's lock order.
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  perform private.erasure_lock_candidate(candidate_id) from public.applications where id=analysis.application_id;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  if exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then raise exception 'Analysis superseded' using errcode = 'PT409'; end if;

  if analysis.execution_status <> 'completed'
    then raise exception 'Only completed results can be reviewed' using errcode = '55000'; end if;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is not null and analysis.stale_at is null then
    update public.screening_analysis_versions
      set stale_at = clock_timestamp(), stale_reason = detected_stale_reason,
        updated_at = clock_timestamp()
      where id = analysis.id;
    analysis.stale_at := clock_timestamp();
    analysis.stale_reason := detected_stale_reason;
  end if;
  if analysis.latest_review_version <> expected_review_version
    then raise exception 'Review changed' using errcode = 'PT409'; end if;
  if analysis.stale_at is not null
    and (new_disposition <> 'needs_reanalysis' or jsonb_array_length(new_overrides) <> 0)
    then raise exception 'Stale result requires reanalysis' using errcode = '55000'; end if;
  if (new_disposition = 'approved_with_changes' and jsonb_array_length(new_overrides) = 0)
    or (new_disposition in ('approved', 'needs_reanalysis')
      and jsonb_array_length(new_overrides) <> 0)
    then raise exception 'Overrides do not match disposition' using errcode = '22023'; end if;

  for override_item in select value from jsonb_array_elements(new_overrides) loop
    if jsonb_typeof(override_item) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(override_item) key
        where key not in (
          'criterion_result_id', 'rating_override',
          'evidence_override', 'explanation_override'
        )
      )
      or jsonb_typeof(override_item->'criterion_result_id') is distinct from 'string'
      or (override_item ? 'rating_override'
        and jsonb_typeof(override_item->'rating_override') not in ('string', 'null'))
      or (override_item ? 'evidence_override'
        and jsonb_typeof(override_item->'evidence_override') not in ('array', 'null'))
      or (override_item ? 'explanation_override'
        and jsonb_typeof(override_item->'explanation_override') not in ('string', 'null'))
      then raise exception 'Invalid review override' using errcode = '22023'; end if;
    begin
      select * into criterion from public.screening_criterion_results
      where id = (override_item->>'criterion_result_id')::uuid
        and company_id = analysis.company_id and analysis_id = analysis.id;
    exception when invalid_text_representation then
      raise exception 'Invalid criterion reference' using errcode = '22023';
    end;
    if not found then raise exception 'Criterion does not belong to analysis' using errcode = '22023'; end if;
    rating := coalesce(override_item->>'rating_override', criterion.rating);
    evidence := case when override_item ? 'evidence_override'
      and jsonb_typeof(override_item->'evidence_override') <> 'null'
      then override_item->'evidence_override' else criterion.evidence end;
    explanation := override_item->>'explanation_override';
    if not (override_item ? 'rating_override'
      or override_item ? 'evidence_override'
      or override_item ? 'explanation_override')
      or rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid review evidence' using errcode = '22023'; end if;
  end loop;
  if (
    select count(distinct value->>'criterion_result_id')
    from jsonb_array_elements(new_overrides)
  ) <> jsonb_array_length(new_overrides)
    then raise exception 'Duplicate review override' using errcode = '22023'; end if;

  insert into public.screening_result_reviews(
    company_id, analysis_id, review_version, reviewer_id,
    disposition, review_note
  ) values (
    analysis.company_id, analysis.id, expected_review_version + 1, actor,
    new_disposition, nullif(btrim(new_review_note), '')
  ) returning id into review_id;

  for override_item in select value from jsonb_array_elements(new_overrides) loop
    insert into public.screening_criterion_review_overrides(
      company_id, review_id, criterion_result_id,
      rating_override, evidence_override, explanation_override
    ) values (
      analysis.company_id,
      review_id,
      (override_item->>'criterion_result_id')::uuid,
      override_item->>'rating_override',
      case when override_item ? 'evidence_override'
        and jsonb_typeof(override_item->'evidence_override') <> 'null'
        then override_item->'evidence_override' else null end,
      override_item->>'explanation_override'
    );
  end loop;
  update public.screening_analysis_versions
    set latest_review_version = expected_review_version + 1,
      updated_at = clock_timestamp()
    where id = analysis.id;
  return review_id;
end;
$$;

create or replace function public.claim_screening_attempt(target_attempt uuid)
returns table (
  analysis_id uuid,
  attempt_id uuid,
  lease_token text,
  lease_expires_at timestamptz,
  input_fingerprint text,
  analysis_contract_hash text,
  payload_schema_version integer,
  result_schema_version integer,
  prompt_version text,
  provider text,
  model text,
  model_revision text,
  input_cv_text_snapshot text,
  criteria_snapshot jsonb
) language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  stale_reason text;
  raw_token text;
  expires_at timestamptz;
begin
  perform private.erasure_lock_candidate(a.candidate_id) from public.screening_analysis_attempts t join public.screening_analysis_versions v on v.id=t.analysis_id join public.applications a on a.id=v.application_id where t.id=target_attempt;
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if attempt.status <> 'pending'
    and not (attempt.status = 'processing' and attempt.lease_expires_at <= clock_timestamp())
    then raise exception 'Attempt is not claimable' using errcode = '55000'; end if;

  stale_reason := private.screening_stale_reason(analysis.id);
  if stale_reason is not null then
    update public.screening_analysis_attempts
      set status = 'abandoned', finished_at = clock_timestamp()
      where id = attempt.id;
    update public.screening_analysis_versions
      set execution_status = 'cancelled',
        stale_at = coalesce(stale_at, clock_timestamp()),
        stale_reason = coalesce(screening_analysis_versions.stale_reason, stale_reason),
        updated_at = clock_timestamp()
      where id = analysis.id;
    return;
  end if;

  raw_token := replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');
  expires_at := clock_timestamp() + interval '5 minutes';
  update public.screening_analysis_attempts
    set status = 'processing',
      lease_token_hash = private.screening_hash(raw_token),
      lease_expires_at = expires_at,
      started_at = coalesce(started_at, clock_timestamp())
    where id = attempt.id;
  update public.screening_analysis_versions
    set execution_status = 'processing',
      processing_started_at = coalesce(processing_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
    where id = analysis.id;
  return query select
    analysis.id,
    attempt.id,
    raw_token,
    expires_at,
    analysis.input_fingerprint,
    analysis.analysis_contract_hash,
    analysis.payload_schema_version,
    analysis.result_schema_version,
    analysis.prompt_version,
    analysis.provider,
    analysis.model,
    analysis.model_revision,
    analysis.input_cv_text_snapshot,
    analysis.criteria_snapshot;
end;
$$;

create or replace function public.complete_screening_analysis(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  findings jsonb,
  new_provider_request_id text default null,
  new_provider_response_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  expected_criterion jsonb;
  finding jsonb;
  item_order bigint;
  rating text;
  evidence jsonb;
  explanation text;
  confidence numeric;
  computed_finalization_hash text;
  detected_stale_reason text;
begin
  perform private.erasure_lock_candidate(a.candidate_id) from public.screening_analysis_attempts t join public.screening_analysis_versions v on v.id=t.analysis_id join public.applications a on a.id=v.application_id where t.id=target_attempt;
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(findings) is distinct from 'array'
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    or length(coalesce(new_provider_request_id, '')) > 500
    or length(coalesce(new_provider_response_id, '')) > 500
    then raise exception 'Invalid completion metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'findings', findings,
    'provider_request_id', new_provider_request_id,
    'provider_response_id', new_provider_response_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  -- Serialize finalization with start/review/retry before taking row locks.
  select * into attempt from public.screening_analysis_attempts where id = target_attempt;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;

  if attempt.status = 'completed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting completion' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;
  if jsonb_array_length(findings) <> jsonb_array_length(analysis.criteria_snapshot)
    then raise exception 'Incomplete criterion set' using errcode = '22023'; end if;

  for expected_criterion, item_order in
    select value, ordinality
    from jsonb_array_elements(analysis.criteria_snapshot) with ordinality
  loop
    select value into finding
    from jsonb_array_elements(findings)
    where value->>'criterion_id' = expected_criterion->>'id';
    if not found or (
      select count(*) from jsonb_array_elements(findings)
      where value->>'criterion_id' = expected_criterion->>'id'
    ) <> 1 then raise exception 'Invalid criterion set' using errcode = '22023'; end if;
    if jsonb_typeof(finding) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(finding) key
        where key not in ('criterion_id', 'rating', 'evidence', 'explanation', 'confidence')
      )
      or jsonb_typeof(finding->'criterion_id') is distinct from 'string'
      or jsonb_typeof(finding->'rating') is distinct from 'string'
      or jsonb_typeof(finding->'evidence') is distinct from 'array'
      or (finding ? 'explanation'
        and jsonb_typeof(finding->'explanation') not in ('string', 'null'))
      or (finding ? 'confidence'
        and jsonb_typeof(finding->'confidence') not in ('number', 'null'))
      then raise exception 'Invalid criterion result' using errcode = '22023'; end if;
    rating := finding->>'rating';
    evidence := finding->'evidence';
    explanation := finding->>'explanation';
    confidence := case when jsonb_typeof(finding->'confidence') = 'number'
      then (finding->>'confidence')::numeric else null end;
    if rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or confidence < 0 or confidence > 1
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid evidence' using errcode = '22023'; end if;

    insert into public.screening_criterion_results(
      company_id, analysis_id, criterion_id, criterion_kind, criterion_order,
      criterion_text_snapshot, rating, evidence, explanation, confidence
    ) values (
      analysis.company_id, analysis.id, expected_criterion->>'id',
      expected_criterion->>'kind', item_order, expected_criterion->>'text',
      rating, evidence, explanation, confidence
    );
  end loop;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is null and exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then detected_stale_reason := 'manual_invalidation'; end if;
  if detected_stale_reason is null and analysis.stale_at is null then
    update public.screening_analysis_versions previous
    set stale_at = clock_timestamp(),
      stale_reason = case
        when previous.input_fingerprint <> analysis.input_fingerprint
          then coalesce(private.screening_stale_reason(previous.id), 'manual_invalidation')
        when previous.analysis_contract_hash <> analysis.analysis_contract_hash
          then 'screening_contract_changed'
        else 'manual_invalidation'
      end,
      superseded_by_analysis_id = analysis.id,
      updated_at = clock_timestamp()
    where previous.company_id = analysis.company_id
      and previous.application_id = analysis.application_id
      and previous.id <> analysis.id
      and previous.execution_status = 'completed'
      and previous.stale_at is null;
  end if;

  update public.screening_analysis_attempts
  set status = 'completed',
    provider_request_id = new_provider_request_id,
    provider_response_id = new_provider_response_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'completed',
    completed_at = clock_timestamp(),
    failed_at = null,
    failure_code = null,
    failure_message = null,
    stale_at = case when detected_stale_reason is not null or stale_at is not null
      then coalesce(stale_at, clock_timestamp()) else null end,
    stale_reason = case when detected_stale_reason is not null or stale_at is not null
      then case when detected_stale_reason = 'manual_invalidation' then 'manual_invalidation' else 'input_changed_during_processing' end else null end,
    overall_score = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid completion payload' using errcode = '22023';
end;
$$;

create or replace function public.fail_screening_attempt(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  new_error_code text,
  new_error_message text default null,
  new_provider_request_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  computed_finalization_hash text;
begin
  perform private.erasure_lock_candidate(a.candidate_id) from public.screening_analysis_attempts t join public.screening_analysis_versions v on v.id=t.analysis_id join public.applications a on a.id=v.application_id where t.id=target_attempt;
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or new_error_code is null or new_error_code !~ '^[a-z0-9_:-]{1,100}$'
    or length(coalesce(new_error_message, '')) > 2000
    or length(coalesce(new_provider_request_id, '')) > 500
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    then raise exception 'Invalid failure metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'error_code', new_error_code,
    'error_message', new_error_message,
    'provider_request_id', new_provider_request_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if attempt.status = 'failed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting failure' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;

  update public.screening_analysis_attempts
  set status = 'failed',
    provider_request_id = new_provider_request_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    error_code = new_error_code,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'failed',
    failure_code = new_error_code,
    failure_message = new_error_message,
    failed_at = clock_timestamp(),
    completed_at = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
end;
$$;

-- New helpers have no PUBLIC default execution. Only the non-sensitive RLS boolean
-- may be called by authenticated; it verifies tenant access before inspecting lifecycle.
revoke all on function private.candidate_workflow_visible(uuid,uuid),private.erasure_candidate_frozen(uuid),private.erasure_lock_candidate(uuid),private.erasure_row_candidates(text,jsonb),private.erasure_row_visible(text,jsonb),private.erasure_guard_candidate_row(),private.erasure_guard_parent_row() from public,anon,authenticated,screening_worker,contact_verifier;
grant execute on function private.erasure_row_visible(text,jsonb),private.candidate_workflow_visible(uuid,uuid) to authenticated;
commit;
