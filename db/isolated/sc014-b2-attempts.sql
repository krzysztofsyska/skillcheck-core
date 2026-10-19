-- SC-014-B2. Isolated composition only; never an active production migration.
begin;
-- Installed only after the accepted voice + billing retention composition.
do $$begin
 if to_regclass('private.erasure_inventory_baseline_r5') is null then
  raise exception 'SC-014 requires accepted SC-010 + voice + billing composition';end if;
 if not exists(select 1 from pg_roles where rolname='competency_test_gateway') then
  create role competency_test_gateway nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;end if;
 if not exists(select 1 from pg_roles where rolname='competency_test_marker_writer') then
  create role competency_test_marker_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;end if;
 if exists(select 1 from pg_roles where rolname in ('competency_test_gateway','competency_test_marker_writer')
  and (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolinherit or rolcanlogin))
  or exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.roleid or r.oid=m.member
   where r.rolname in ('competency_test_gateway','competency_test_marker_writer')) then
  raise exception 'Unsafe existing competency role';end if;
end;$$;
grant usage on schema private to competency_test_gateway,competency_test_marker_writer;
alter table public.candidates add column competency_access_cancelled_at timestamptz,
 add column competency_access_cancel_reason text check(competency_access_cancel_reason in ('consent_withdrawn','candidate_withdrawn')),
 add constraint competency_candidate_marker_pair check((competency_access_cancelled_at is null)=(competency_access_cancel_reason is null));
alter table public.applications add column competency_access_cancelled_at timestamptz,
 add column competency_access_cancel_reason text check(competency_access_cancel_reason in ('consent_withdrawn','candidate_withdrawn')),
 add constraint competency_application_marker_pair check((competency_access_cancelled_at is null)=(competency_access_cancel_reason is null)),
 add constraint competency_application_pair unique(company_id,id),
 add constraint competency_application_binding unique(company_id,recruitment_id,candidate_id,id);
create table private.competency_test_grants (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_id uuid not null,
 recruitment_id uuid not null,application_id uuid not null,definition_entry_id uuid not null,
 token_digest bytea not null unique check(octet_length(token_digest)=32),revision bigint not null default 1 check(revision>0),
 start_by_at timestamptz not null,created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 revoked_by uuid,revoked_at timestamptz,issuance_request_key uuid not null,event_request_key uuid not null,
 unique(company_id,application_id,definition_entry_id),unique(company_id,created_by,issuance_request_key),
 unique(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id),
 foreign key(company_id,recruitment_id,candidate_id,application_id) references public.applications(company_id,recruitment_id,candidate_id,id),
 foreign key(company_id,recruitment_id,definition_entry_id) references public.exercise_definition_entries(company_id,recruitment_id,id),
 check((revoked_by is null)=(revoked_at is null))
);
create table private.competency_test_grant_events (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_id uuid not null,
 recruitment_id uuid not null,application_id uuid not null,definition_entry_id uuid not null,grant_id uuid not null,
 kind text not null check(kind in ('issued','rotated','revoked')),actor_id uuid not null,
 previous_revision bigint not null,revision bigint not null,token_digest bytea not null check(octet_length(token_digest)=32),
 request_key uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(company_id,actor_id,kind,request_key),
 foreign key(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,grant_id)
 references private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id)
);
create table public.competency_test_attempts (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_id uuid not null,
 recruitment_id uuid not null,application_id uuid not null,definition_entry_id uuid not null,grant_id uuid not null unique,
 state text not null default 'in_progress' check(state in ('in_progress','submitted')),
 started_at timestamptz not null,deadline_at timestamptz not null,submitted_at timestamptz,
 work_sample text,submission_digest bytea,start_request_key uuid not null,
 unique(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id),
 foreign key(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,grant_id)
 references private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id),
 check(deadline_at>started_at),
 check((state='in_progress' and submitted_at is null and work_sample is null and submission_digest is null)
 or(state='submitted' and submitted_at is not null and work_sample is not null and submission_digest is not null
 and octet_length(submission_digest)=32 and submitted_at<deadline_at
 and work_sample=private.competency_answer(jsonb_build_object('workSample',work_sample))))
);
create table private.competency_test_sessions (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_id uuid not null,
 recruitment_id uuid not null,application_id uuid not null,definition_entry_id uuid not null,grant_id uuid not null,
 session_digest bytea not null unique check(octet_length(session_digest)=32),grant_revision bigint not null,
 created_at timestamptz not null default clock_timestamp(),absolute_expires_at timestamptz not null,
 idle_expires_at timestamptz not null,invalidated_at timestamptz,
 unique(grant_id,grant_revision),
 foreign key(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,grant_id)
 references private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id)
);
create table private.competency_test_drafts (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_id uuid not null,
 recruitment_id uuid not null,application_id uuid not null,definition_entry_id uuid not null,attempt_id uuid not null unique,
 draft_text text not null check(length(draft_text)<=20000),version bigint not null check(version>0),request_key uuid not null,
 foreign key(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,attempt_id)
 references public.competency_test_attempts(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id)
);
create table public.competency_test_review_entries (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_id uuid not null,
 recruitment_id uuid not null,application_id uuid not null,definition_entry_id uuid not null,attempt_id uuid not null,
 reviewer_id uuid not null,version bigint not null check(version>0),submission_digest bytea not null,
 policy_version text not null check(policy_version='competency-test-rubric-v1'),observations jsonb not null,
 coverage numeric not null check(coverage between 0 and 1),score numeric check(score between 0 and 100),
 status text not null check(status in ('review_required','insufficient_evidence')),created_at timestamptz not null default clock_timestamp(),
 unique(attempt_id,version),
 foreign key(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,attempt_id)
 references public.competency_test_attempts(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,id)
);
-- Candidate arrays are explicit SC-010 edges, never guessed from UUID strings.
create table private.competency_test_cancellations (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),
 candidate_ids uuid[] not null check(cardinality(candidate_ids) between 1 and 100),application_id uuid,
 scope_kind text not null check(scope_kind in ('application','confirmed_subject','resolution_link','historical_withdrawn')),
 resolution_id uuid,resolution_revision bigint,reason text not null check(reason in ('consent_withdrawn','candidate_withdrawn')),
 actor_id uuid not null,request_key uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(company_id,actor_id,request_key),
 foreign key(company_id,application_id) references public.applications(company_id,id)
);
-- Application lacks this pair in older baselines; the composite binding above
-- already establishes the stricter tenant/recruitment/candidate relationship.

create function private.competency_authority(tenant uuid,owner_only boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.companies where id=tenant for share nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if exists(select 1 from public.companies where id=tenant and owner_id=auth.uid()) then return;end if;
 if owner_only then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.company_members where company_id=tenant and user_id=auth.uid() for share nowait;
 if not found or not exists(select 1 from public.company_members where company_id=tenant and user_id=auth.uid() and role='recruiter') then
  raise exception using errcode='PT404',message='Resource unavailable';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Authority busy';end;$$;

create function private.competency_lock_application(target uuid,staff boolean default false,allow_cancelled boolean default false)
returns public.applications language plpgsql security definer set search_path='' as $$
declare a public.applications;seed public.applications;c public.candidates;
begin
 select * into seed from public.applications where id=target;
 perform private.erasure_lock_candidate(seed.candidate_id);
 -- Serialize restore activation with every B2 operation until COMMIT.
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='Restore isolation required';end if;
 select * into a from public.applications where id=target for update nowait;
 if a.id is null or row(a.company_id,a.candidate_id,a.recruitment_id) is distinct from row(seed.company_id,seed.candidate_id,seed.recruitment_id) then
  raise exception using errcode='PT409',message='Application changed';end if;
 if staff then perform private.competency_authority(a.company_id);end if;
 select * into c from public.candidates where id=a.candidate_id and company_id=a.company_id;
 if c.id is null or (not allow_cancelled and (c.competency_access_cancelled_at is not null
  or a.competency_access_cancelled_at is not null or a.status='withdrawn')) then
  raise exception using errcode='PT404',message='Resource unavailable';end if;
 return a;
exception when lock_not_available then raise exception using errcode='PT409',message='Application busy';end;$$;

create function private.competency_eligible(a public.applications,definition_id uuid) returns public.exercise_definition_entries
language plpgsql security definer set search_path='' as $$
declare d public.exercise_definition_entries;r public.recruitments;p public.positions;
begin
 select * into r from public.recruitments where company_id=a.company_id and id=a.recruitment_id for share nowait;
 select * into p from public.positions where company_id=a.company_id and id=r.position_id for share nowait;
 select * into d from public.exercise_definition_entries where company_id=a.company_id and recruitment_id=a.recruitment_id and id=definition_id;
 if a.status not in ('new','in_progress') or r.id is null or r.status not in ('draft','open') or p.id is null or p.status='archived'
  or d.id is null or d.definition->>'kind'<>'competency_test' then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform private.competency_validate_definition(d.definition);
 return d;
exception when lock_not_available then raise exception using errcode='PT409',message='Workflow busy';end;$$;

create function private.competency_grant_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare event_kind text;before_revision bigint;
begin
 if auth.uid() is null then raise exception using errcode='PT404',message='Actor required';end if;
 if tg_op='INSERT' then event_kind:='issued';before_revision:=0;
 else
  if (to_jsonb(new)-array['token_digest','revision','revoked_by','revoked_at','event_request_key']) is distinct from
   (to_jsonb(old)-array['token_digest','revision','revoked_by','revoked_at','event_request_key']) or old.revoked_at is not null then
   raise exception using errcode='42501',message='Grant identity immutable';end if;
  before_revision:=old.revision;
  if new.revoked_at is not null and new.revoked_by=auth.uid() and new.revision=old.revision and new.token_digest=old.token_digest then event_kind:='revoked';
  elsif new.revoked_at is null and new.revision=old.revision+1 and new.token_digest<>old.token_digest then event_kind:='rotated';
  else raise exception using errcode='42501',message='Invalid grant transition';end if;
 end if;
 insert into private.competency_test_grant_events(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,grant_id,
 kind,actor_id,previous_revision,revision,token_digest,request_key)
 values(new.company_id,new.candidate_id,new.recruitment_id,new.application_id,new.definition_entry_id,new.id,event_kind,
 auth.uid(),before_revision,new.revision,new.token_digest,new.event_request_key);
 return new;
end;$$;
create trigger zz_competency_grant_audit after insert or update on private.competency_test_grants for each row execute function private.competency_grant_audit();

create function public.create_competency_test_grant(target_application uuid,target_definition uuid,start_by timestamptz,request_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.applications;d public.exercise_definition_entries;g private.competency_test_grants;secret text;
begin
 a:=private.competency_lock_application(target_application,true);
 if request_key is null or start_by is null then raise exception using errcode='PT422',message='Invalid grant';end if;
 select * into g from private.competency_test_grants where company_id=a.company_id and created_by=auth.uid() and issuance_request_key=request_key;
 if found then
  if g.application_id<>a.id or g.definition_entry_id<>target_definition or g.start_by_at<>start_by then raise exception using errcode='PT409',message='Request key reused';end if;
  return jsonb_build_object('grantId',g.id,'revision',g.revision,'state','secret_unavailable_rotate_required');end if;
 d:=private.competency_eligible(a,target_definition);
 if start_by<=clock_timestamp() or start_by>clock_timestamp()+interval '7 days' then raise exception using errcode='PT422',message='Invalid start window';end if;
 secret:=encode(extensions.gen_random_bytes(32),'hex');
 insert into private.competency_test_grants(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,token_digest,
 start_by_at,created_by,issuance_request_key,event_request_key) values(a.company_id,a.candidate_id,a.recruitment_id,a.id,d.id,
 extensions.digest(secret,'sha256'),start_by,auth.uid(),request_key,request_key) returning * into g;
 return jsonb_build_object('grantId',g.id,'revision',g.revision,'token',secret);
exception when unique_violation then raise exception using errcode='PT409',message='Grant already exists';end;$$;

create function private.competency_staff_grant(target uuid,allow_cancelled boolean default false) returns private.competency_test_grants
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;a public.applications;
begin
 select * into g from private.competency_test_grants where id=target;
 a:=private.competency_lock_application(g.application_id,true,allow_cancelled);
 select * into g from private.competency_test_grants where id=target and company_id=a.company_id and candidate_id=a.candidate_id for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;return g;
exception when lock_not_available then raise exception using errcode='PT409',message='Grant busy';end;$$;
create function public.get_competency_test_grant_status(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare g private.competency_test_grants;begin
 g:=private.competency_staff_grant(target);return jsonb_build_object('grantId',g.id,'revision',g.revision,'revoked',g.revoked_at is not null,'startBy',g.start_by_at);end;$$;
create function public.rotate_competency_test_grant(target uuid,expected_revision bigint,request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;e private.competency_test_grant_events;secret text;a public.competency_test_attempts;
begin
 g:=private.competency_staff_grant(target);
 if request_key is null or expected_revision is null then raise exception using errcode='PT422',message='Invalid rotation';end if;
 select * into e from private.competency_test_grant_events where company_id=g.company_id and actor_id=auth.uid() and kind='rotated' and competency_test_grant_events.request_key=rotate_competency_test_grant.request_key;
 if found then
  if e.grant_id<>g.id or e.previous_revision<>expected_revision then raise exception using errcode='PT409',message='Request key reused';end if;
  return jsonb_build_object('grantId',g.id,'revision',g.revision,'state','secret_unavailable_rotate_required');end if;
 if g.revoked_at is not null or g.revision<>expected_revision then raise exception using errcode='PT409',message='Grant changed';end if;
 select * into a from public.competency_test_attempts where grant_id=g.id;
 if (a.id is null and g.start_by_at<=clock_timestamp()) or (a.id is not null and a.deadline_at+interval '15 minutes'<=clock_timestamp()) then
  raise exception using errcode='PT404',message='Resource unavailable';end if;
 secret:=encode(extensions.gen_random_bytes(32),'hex');
 update private.competency_test_grants set token_digest=extensions.digest(secret,'sha256'),revision=revision+1,event_request_key=request_key where id=g.id returning * into g;
 update private.competency_test_sessions set invalidated_at=clock_timestamp() where grant_id=g.id and invalidated_at is null;
 return jsonb_build_object('grantId',g.id,'revision',g.revision,'token',secret);
end;$$;
create function public.revoke_competency_test_grant(target uuid,request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare g private.competency_test_grants;begin
 g:=private.competency_staff_grant(target,true);
 if request_key is null then raise exception using errcode='PT422',message='Invalid revocation';end if;
 if g.revoked_at is null then
  update private.competency_test_grants set revoked_at=clock_timestamp(),revoked_by=auth.uid(),event_request_key=request_key where id=g.id;
  update private.competency_test_sessions set invalidated_at=clock_timestamp() where grant_id=g.id and invalidated_at is null;
 end if;return jsonb_build_object('grantId',g.id,'revoked',true);
end;$$;

-- The gateway only knows a capability, never an auth.uid or company authority.
create function private.exchange_candidate_competency_test_session(token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;a public.applications;attempt public.competency_test_attempts;secret text;expiry timestamptz;
begin
 if token is null or token !~ '^[0-9a-f]{64}$' then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into g from private.competency_test_grants where token_digest=extensions.digest(token,'sha256');
 a:=private.competency_lock_application(g.application_id);
 select * into g from private.competency_test_grants where id=g.id for update nowait;
 if g.token_digest<>extensions.digest(token,'sha256') or g.revoked_at is not null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into attempt from public.competency_test_attempts where grant_id=g.id;
 expiry:=case when attempt.id is null then g.start_by_at else attempt.deadline_at+interval '15 minutes' end;
 if clock_timestamp()>=expiry then raise exception using errcode='PT404',message='Resource unavailable';end if;
 secret:=encode(extensions.gen_random_bytes(32),'hex');
 insert into private.competency_test_sessions(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,grant_id,session_digest,grant_revision,absolute_expires_at,idle_expires_at)
 values(g.company_id,g.candidate_id,g.recruitment_id,g.application_id,g.definition_entry_id,g.id,extensions.digest(secret,'sha256'),g.revision,expiry,expiry);
 return jsonb_build_object('session',secret,'expiresAt',expiry);
exception when unique_violation then raise exception using errcode='PT404',message='Resource unavailable';
 when lock_not_available then raise exception using errcode='PT409',message='Resource busy';end;$$;

create function private.competency_session(session_hash bytea) returns private.competency_test_grants
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;s private.competency_test_sessions;a public.applications;
begin
 if session_hash is null or octet_length(session_hash)<>32 then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into s from private.competency_test_sessions where session_digest=session_hash;
 a:=private.competency_lock_application(s.application_id);
 select * into g from private.competency_test_grants where id=s.grant_id for update nowait;
 select * into s from private.competency_test_sessions where session_digest=session_hash;
 if s.id is null or g.id is null or g.revoked_at is not null or s.invalidated_at is not null or s.grant_revision<>g.revision
  or clock_timestamp()>=least(s.absolute_expires_at,s.idle_expires_at) then raise exception using errcode='PT404',message='Resource unavailable';end if;
 return g;
exception when lock_not_available then raise exception using errcode='PT409',message='Resource busy';end;$$;

create function private.inspect_candidate_competency_test(session_hash bytea) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;a public.competency_test_attempts;d public.exercise_definition_entries;draft private.competency_test_drafts;
begin
 g:=private.competency_session(session_hash);
 select * into a from public.competency_test_attempts where grant_id=g.id for update nowait;
 if a.state='submitted' then return jsonb_build_object('state','submitted','attemptId',a.id);end if;
 select * into d from public.exercise_definition_entries where id=g.definition_entry_id;
 if a.id is null then
  if clock_timestamp()>=g.start_by_at then raise exception using errcode='PT404',message='Resource unavailable';end if;
  return jsonb_build_object('state','not_started','revisionId',d.id,'version',d.version,'durationMinutes',d.definition->'durationMinutes','label','Test kompetencji');end if;
 if clock_timestamp()>=a.deadline_at then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into draft from private.competency_test_drafts where attempt_id=a.id;
 return jsonb_build_object('state','in_progress','attemptId',a.id,'startedAt',a.started_at,'deadlineAt',a.deadline_at,
 'test',jsonb_build_object('revisionId',d.id,'version',d.version,'title',d.definition->'title','instructions',d.definition->'instructions',
 'expectedOutput',d.definition->'expectedOutput','durationMinutes',d.definition->'durationMinutes'),
 'draft',jsonb_build_object('text',coalesce(draft.draft_text,''),'version',coalesce(draft.version,0)));
end;$$;
create function private.start_candidate_competency_test(session_hash bytea,request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;a public.competency_test_attempts;app public.applications;d public.exercise_definition_entries;started timestamptz;
begin
 g:=private.competency_session(session_hash);
 if request_key is null then raise exception using errcode='PT422',message='Invalid request';end if;
 select * into a from public.competency_test_attempts where grant_id=g.id for update nowait;
 if a.id is not null then return private.inspect_candidate_competency_test(session_hash);end if;
 select * into app from public.applications where id=g.application_id;
 d:=private.competency_eligible(app,g.definition_entry_id);started:=clock_timestamp();
 if started>=g.start_by_at then raise exception using errcode='PT404',message='Resource unavailable';end if;
 insert into public.competency_test_attempts(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,grant_id,started_at,deadline_at,start_request_key)
 values(g.company_id,g.candidate_id,g.recruitment_id,g.application_id,g.definition_entry_id,g.id,started,
 started+(d.definition->>'durationMinutes')::integer*interval '1 minute',request_key) returning * into a;
 update private.competency_test_sessions set absolute_expires_at=a.deadline_at+interval '15 minutes',idle_expires_at=a.deadline_at+interval '15 minutes'
 where grant_id=g.id and grant_revision=g.revision and invalidated_at is null;
 -- Transport buffers this result and exposes it only after a successful COMMIT.
 return private.inspect_candidate_competency_test(session_hash);
end;$$;
create function private.save_candidate_competency_test_draft(session_hash bytea,draft_text text,expected_version bigint,request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;a public.competency_test_attempts;d private.competency_test_drafts;
begin
 g:=private.competency_session(session_hash);
 select * into a from public.competency_test_attempts where grant_id=g.id for update nowait;
 if a.id is null or a.state<>'in_progress' or clock_timestamp()>=a.deadline_at then raise exception using errcode='PT409',message='Attempt unavailable';end if;
 if draft_text is null or length(draft_text)>20000 or expected_version is null or expected_version<0 or request_key is null then raise exception using errcode='PT422',message='Invalid draft';end if;
 select * into d from private.competency_test_drafts where attempt_id=a.id;
 if d.request_key=request_key and d.version=expected_version+1 and d.draft_text=draft_text then return jsonb_build_object('version',d.version);end if;
 if coalesce(d.version,0)<>expected_version or d.request_key=request_key then raise exception using errcode='PT409',message='Draft changed';end if;
 insert into private.competency_test_drafts(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,attempt_id,draft_text,version,request_key)
 values(g.company_id,g.candidate_id,g.recruitment_id,g.application_id,g.definition_entry_id,a.id,draft_text,expected_version+1,request_key)
 on conflict(attempt_id) do update set draft_text=excluded.draft_text,version=excluded.version,request_key=excluded.request_key;
 return jsonb_build_object('version',expected_version+1);
end;$$;
create function private.submit_candidate_competency_test(session_hash bytea,answer jsonb,request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.competency_test_grants;a public.competency_test_attempts;canonical text;hash bytea;
begin
 g:=private.competency_session(session_hash);
 select * into a from public.competency_test_attempts where grant_id=g.id for update nowait;
 if a.id is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if request_key is null then raise exception using errcode='PT422',message='Invalid request';end if;
 canonical:=private.competency_answer(answer);hash:=extensions.digest(canonical,'sha256');
 if a.state='submitted' then
  if a.submission_digest<>hash then raise exception using errcode='PT409',message='Already submitted';end if;
  return jsonb_build_object('state','submitted','attemptId',a.id);end if;
 if clock_timestamp()>=a.deadline_at then raise exception using errcode='PT409',message='Attempt expired';end if;
 update public.competency_test_attempts set state='submitted',work_sample=canonical,submission_digest=hash,submitted_at=clock_timestamp() where id=a.id;
 delete from private.competency_test_drafts where attempt_id=a.id;
 return jsonb_build_object('state','submitted','attemptId',a.id);
end;$$;
create function private.status_candidate_competency_test(session_hash bytea) returns jsonb
language plpgsql security definer set search_path='' as $$declare g private.competency_test_grants;a public.competency_test_attempts;begin
 g:=private.competency_session(session_hash);
 select * into a from public.competency_test_attempts where grant_id=g.id;
 if a.state is distinct from 'submitted' then raise exception using errcode='PT404',message='Resource unavailable';end if;
 return jsonb_build_object('state','submitted','attemptId',a.id);end;$$;

create function public.read_competency_test_response(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.competency_test_attempts;app public.applications;g private.competency_test_grants;
begin
 select * into a from public.competency_test_attempts where id=target;
 app:=private.competency_lock_application(a.application_id,true);
 select * into g from private.competency_test_grants where id=a.grant_id for update nowait;
 select * into a from public.competency_test_attempts where id=target for update nowait;
 if a.state is distinct from 'submitted' then raise exception using errcode='PT404',message='Resource unavailable';end if;
 return jsonb_build_object('attemptId',a.id,'workSample',a.work_sample,'definitionId',a.definition_entry_id,
 'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by version),'[]'::jsonb) from public.competency_test_review_entries r where attempt_id=a.id));
end;$$;
create function public.save_competency_test_review(target uuid,expected_version bigint,observations jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.competency_test_attempts;d public.exercise_definition_entries;v bigint;scored jsonb;result uuid;
begin
 perform public.read_competency_test_response(target);
 select * into a from public.competency_test_attempts where id=target;
 select * into d from public.exercise_definition_entries where id=a.definition_entry_id;
 select coalesce(max(version),0) into v from public.competency_test_review_entries where attempt_id=a.id;
 if expected_version is null or v<>expected_version then raise exception using errcode='PT409',message='Review changed';end if;
 scored:=private.competency_score(d.definition,a.work_sample,observations);
 insert into public.competency_test_review_entries(company_id,candidate_id,recruitment_id,application_id,definition_entry_id,attempt_id,
 reviewer_id,version,submission_digest,policy_version,observations,coverage,score,status)
 values(a.company_id,a.candidate_id,a.recruitment_id,a.application_id,a.definition_entry_id,a.id,auth.uid(),v+1,a.submission_digest,
 scored->>'policyVersion',scored->'criterionResults',(scored->>'coverage')::numeric,(scored->>'score')::numeric,scored->>'status') returning id into result;
 return result;
end;$$;

create function private.competency_protect_history() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 raise exception using errcode='42501',message='Competency history immutable';
end;$$;
create function private.competency_protect_attempt() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op='UPDATE' and old.state='in_progress' and new.state='submitted'
 and (to_jsonb(new)-array['state','work_sample','submission_digest','submitted_at'])=(to_jsonb(old)-array['state','work_sample','submission_digest','submitted_at'])
 and new.submission_digest=extensions.digest(new.work_sample,'sha256') then return new;end if;
 raise exception using errcode='42501',message='Attempt immutable';end;$$;
create trigger competency_immutable before update or delete on public.competency_test_attempts for each row execute function private.competency_protect_attempt();
create trigger competency_immutable before update or delete on public.competency_test_review_entries for each row execute function private.competency_protect_history();
create trigger competency_immutable before update or delete on private.competency_test_grant_events for each row execute function private.competency_protect_history();
create trigger competency_immutable before update or delete on private.competency_test_cancellations for each row execute function private.competency_protect_history();
create trigger competency_no_delete before delete on private.competency_test_grants for each row execute function private.competency_protect_history();

-- Strip hostile default ACLs, not only the usual two API roles. Every function
-- starts private; the exact exposed surfaces below are the only grants.
do $$declare r record;g record;begin
 for r in select c.oid,n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private') and c.relname like 'competency_test_%' and c.relkind='r' loop
  execute format('alter table %s enable row level security',r.oid::regclass);
  for g in select distinct x.grantee,role.rolname from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   left join pg_roles role on role.oid=x.grantee where c.oid=r.oid and x.grantee<>c.relowner loop
   if g.grantee=0 then execute format('revoke all on table %s from public',r.oid::regclass);
   else execute format('revoke all on table %s from %I',r.oid::regclass,g.rolname);end if;
  end loop;
  if r.relname<>'competency_test_cancellations' then execute format('create index %I on %s(company_id,candidate_id)',r.relname||'_candidate',r.oid::regclass);end if;
 end loop;
 for r in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and (p.proname like 'competency_%' or p.proname like '%competency_test%') loop
  for g in select distinct x.grantee,role.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
   left join pg_roles role on role.oid=x.grantee where p.oid=r.oid and x.grantee<>r.proowner loop
   if g.grantee=0 then execute format('revoke all on function %s from public',r.oid::regprocedure);
   else execute format('revoke all on function %s from %I',r.oid::regprocedure,g.rolname);end if;
  end loop;
 end loop;
end;$$;
create index competency_cancellation_candidates on private.competency_test_cancellations using gin(candidate_ids);
grant execute on function public.create_competency_test_grant(uuid,uuid,timestamptz,uuid),
 public.get_competency_test_grant_status(uuid),public.rotate_competency_test_grant(uuid,bigint,uuid),
 public.revoke_competency_test_grant(uuid,uuid),public.read_competency_test_response(uuid),
 public.save_competency_test_review(uuid,bigint,jsonb) to authenticated;
grant execute on function private.exchange_candidate_competency_test_session(text),
 private.inspect_candidate_competency_test(bytea),private.start_candidate_competency_test(bytea,uuid),
 private.save_candidate_competency_test_draft(bytea,text,bigint,uuid),private.submit_candidate_competency_test(bytea,jsonb,uuid),
 private.status_candidate_competency_test(bytea) to competency_test_gateway;
commit;
