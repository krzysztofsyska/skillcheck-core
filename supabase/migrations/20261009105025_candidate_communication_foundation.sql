-- SC-010 B1: offline records only. No effective grant, dispatch, address or provider API.
-- Delivery remains structurally unreachable even if application feature flags change.
begin;

alter table public.applications add constraint applications_contact_identity_key
  unique (company_id, recruitment_id, candidate_id, id);
alter table public.recruitment_shortlist_entries add constraint shortlist_contact_identity_key
  unique (company_id, recruitment_id, application_id, id);

create table public.candidate_contact_permissions (
  id uuid primary key default gen_random_uuid(), company_id uuid not null,
  candidate_id uuid not null, recruitment_id uuid,
  purpose text not null default 'verification_invitation' check (purpose = 'verification_invitation'),
  channel text not null check (channel in ('email','sms','voice')),
  state text not null check (state in ('unverified','revoked','blocked')),
  source text not null default 'operator_recorded' check(source='operator_recorded'),
  revision bigint not null check (revision > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (company_id,candidate_id) references public.candidates(company_id,id) on delete restrict,
  foreign key (company_id,recruitment_id) references public.recruitments(company_id,id) on delete restrict
);
create unique index contact_permissions_global_key on public.candidate_contact_permissions(company_id,candidate_id,channel) where recruitment_id is null;
create unique index contact_permissions_scoped_key on public.candidate_contact_permissions(company_id,candidate_id,recruitment_id,channel) where recruitment_id is not null;
create index contact_permissions_recruitment_idx on public.candidate_contact_permissions(company_id,recruitment_id);

create table public.candidate_contact_preferences (
  id uuid primary key default gen_random_uuid(), company_id uuid not null, candidate_id uuid not null,
  revision bigint not null check (revision > 0), timezone text not null,
  source text not null default 'operator_recorded' check(source='operator_recorded'),
  weekday_windows jsonb not null, blocked_channels text[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(company_id,candidate_id),
  foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict
);

create table public.candidate_communications (
  id uuid primary key default gen_random_uuid(), company_id uuid not null,
  recruitment_id uuid not null, candidate_id uuid not null, application_id uuid not null,
  shortlist_entry_id uuid not null, channel text not null check(channel in ('email','sms','voice')),
  purpose text not null default 'verification_invitation' check(purpose = 'verification_invitation'),
  state text not null default 'draft' check(state in ('draft','cancelled')),
  version bigint not null default 1 check(version > 0),
  created_by uuid not null, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), cancelled_at timestamptz,
  unique(company_id,id),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  foreign key(company_id,recruitment_id,candidate_id,application_id)
    references public.applications(company_id,recruitment_id,candidate_id,id) on delete restrict,
  foreign key(company_id,recruitment_id,application_id,shortlist_entry_id)
    references public.recruitment_shortlist_entries(company_id,recruitment_id,application_id,id) on delete restrict
);
create unique index communications_one_draft on public.candidate_communications(company_id,application_id,purpose) where state='draft';
create index communications_candidate_idx on public.candidate_communications(company_id,candidate_id);
create index communications_application_idx on public.candidate_communications(company_id,recruitment_id,candidate_id,application_id);
create index communications_shortlist_idx on public.candidate_communications(company_id,recruitment_id,application_id,shortlist_entry_id);
create index communications_page_idx on public.candidate_communications(application_id,created_at,id);

create table public.candidate_communication_events (
  id uuid primary key default gen_random_uuid(), company_id uuid not null, communication_id uuid not null,
  event_type text not null check(event_type in ('draft_created','cancelled','permission_denied','preferences_changed')),
  actor_id uuid not null, created_at timestamptz not null default now(),
  foreign key(company_id,communication_id) references public.candidate_communications(company_id,id) on delete restrict
);
create index communication_events_page_idx on public.candidate_communication_events(communication_id,created_at,id);
create index communication_events_parent_idx on public.candidate_communication_events(company_id,communication_id);

create table private.contact_requests (
  company_id uuid not null references public.companies(id) on delete restrict,
  actor_id uuid not null, operation text not null, request_key uuid not null,
  payload jsonb not null, result_id uuid not null,
  created_at timestamptz not null default now(), primary key(company_id,actor_id,operation,request_key)
);
create table private.contact_audit (
  id uuid primary key default gen_random_uuid(), company_id uuid not null,
  candidate_id uuid not null, subject_id uuid not null, actor_id uuid not null,
  action text not null check(action in ('unverified','revoked','blocked','preferences_changed')),
  evidence_ref uuid, revision bigint not null, created_at timestamptz not null default now(),
  foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict
);
create index contact_audit_candidate_idx on private.contact_audit(company_id,candidate_id);

create function private.contact_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='Immutable contact history'; end;
$$;
create trigger immutable_events before update or delete on public.candidate_communication_events for each row execute function private.contact_immutable();
create trigger immutable_audit before update or delete on private.contact_audit for each row execute function private.contact_immutable();
create trigger immutable_requests before update or delete on private.contact_requests for each row execute function private.contact_immutable();

-- Every mutation serializes on candidate, including revoke and preference changes.
-- NOWAIT deliberately rejects conflicting SC-008/material lock orders with PT409.
create function private.contact_lock_candidate(target_candidate uuid) returns uuid
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
  return tenant;
exception when lock_not_available then raise exception using errcode='PT409',message='Contact source busy';
end;
$$;

create function private.contact_request_result(tenant uuid,op text,req uuid,data jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare previous private.contact_requests;
begin
  if req is null then raise exception using errcode='PT422',message='Request key required'; end if;
  select * into previous from private.contact_requests where company_id=tenant and actor_id=auth.uid() and operation=op and request_key=req;
  if found then
    if previous.payload is distinct from data then raise exception using errcode='PT409',message='Request key reused'; end if;
    return previous.result_id;
  end if;
  return null;
end;
$$;

create function private.contact_cancel_drafts(tenant uuid,candidate uuid,recruitment uuid,contact_channel text,event_name text)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  with cancelled as (
    update public.candidate_communications set state='cancelled',version=version+1,cancelled_at=now(),updated_at=now()
    where company_id=tenant and candidate_id=candidate and state='draft'
      and (recruitment is null or recruitment_id=recruitment)
      and (contact_channel is null or channel=contact_channel) returning id
  ) insert into public.candidate_communication_events(company_id,communication_id,event_type,actor_id)
    select tenant,id,event_name,auth.uid() from cancelled;
end;
$$;

create function public.record_contact_permission(
  target_candidate uuid,target_recruitment uuid,contact_channel text,permission_state text,
  evidence_ref uuid,expected_revision bigint,request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid; data jsonb; result uuid; current_row public.candidate_contact_permissions;
begin
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
  if result is not null then return result; end if;
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
  return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Contact source changed';
end;
$$;

create function public.set_contact_preferences(
  target_candidate uuid,contact_timezone text,weekday_windows jsonb,blocked_channels text[],expected_revision bigint,request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid; data jsonb; result uuid; current_row public.candidate_contact_preferences; w jsonb; days integer[]:='{}'; day integer;
begin
  tenant:=private.contact_lock_candidate(target_candidate);
  if contact_timezone is null or length(contact_timezone)>100
    or not exists(select 1 from pg_catalog.pg_timezone_names where name=contact_timezone and (name like '%/%' or name='UTC'))
    or jsonb_typeof(weekday_windows) is distinct from 'array'
    or expected_revision is null or expected_revision<0 or blocked_channels is null
    or cardinality(blocked_channels)>3 or array_ndims(blocked_channels)>1
    or array_position(blocked_channels,null) is not null
    or not blocked_channels <@ array['email','sms','voice']::text[] then
    raise exception using errcode='PT422',message='Invalid contact preferences';
  end if;
  if jsonb_array_length(weekday_windows)>7 then raise exception using errcode='PT422',message='Invalid contact windows'; end if;
  for w in select value from jsonb_array_elements(weekday_windows) loop
    if jsonb_typeof(w) is distinct from 'object' or (select count(*) from jsonb_object_keys(w))<>3
      or not (w ?& array['weekday','start_minute','end_minute'])
      or jsonb_typeof(w->'weekday') is distinct from 'number'
      or jsonb_typeof(w->'start_minute') is distinct from 'number'
      or jsonb_typeof(w->'end_minute') is distinct from 'number'
      or coalesce(w->>'weekday','') !~ '^[1-7]$'
      or coalesce(w->>'start_minute','') !~ '^[0-9]{1,4}$'
      or coalesce(w->>'end_minute','') !~ '^[0-9]{1,4}$' then
      raise exception using errcode='PT422',message='Invalid contact windows';
    end if;
    day:=(w->>'weekday')::integer;
    if day=any(days) or (w->>'start_minute')::integer not between 0 and 1439
      or (w->>'end_minute')::integer not between 1 and 1440
      or (w->>'start_minute')::integer >= (w->>'end_minute')::integer then
      raise exception using errcode='PT422',message='Invalid contact windows';
    end if;
    days:=array_append(days,day);
  end loop;
  data:=jsonb_build_array(target_candidate,contact_timezone,weekday_windows,blocked_channels,expected_revision);
  result:=private.contact_request_result(tenant,'preferences',request_key,data);
  if result is not null then return result; end if;
  select * into current_row from public.candidate_contact_preferences where company_id=tenant and candidate_id=target_candidate;
  if coalesce(current_row.revision,0)<>expected_revision then raise exception using errcode='PT409',message='Preference revision changed'; end if;
  if current_row.id is null then
    insert into public.candidate_contact_preferences(company_id,candidate_id,revision,timezone,weekday_windows,blocked_channels)
      values(tenant,target_candidate,1,contact_timezone,weekday_windows,blocked_channels) returning id into result;
  else
    update public.candidate_contact_preferences set revision=revision+1,timezone=contact_timezone,
      weekday_windows=set_contact_preferences.weekday_windows,blocked_channels=set_contact_preferences.blocked_channels,updated_at=now()
      where id=current_row.id returning id into result;
  end if;
  insert into private.contact_audit(company_id,candidate_id,subject_id,actor_id,action,revision)
    values(tenant,target_candidate,result,auth.uid(),'preferences_changed',expected_revision+1);
  perform private.contact_cancel_drafts(tenant,target_candidate,null,null,'preferences_changed');
  insert into private.contact_requests values(tenant,auth.uid(),'preferences',request_key,data,result,now());
  return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Contact source changed';
end;
$$;

create function public.prepare_candidate_communication(target_application uuid,target_shortlist uuid,contact_channel text,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare app public.applications; tenant uuid; entry public.recruitment_shortlist_entries;
  analysis public.screening_analysis_versions; result uuid; data jsonb; current_shortlist record;
begin
  select * into app from public.applications where id=target_application;
  tenant:=private.contact_lock_candidate(app.candidate_id);
  if contact_channel is null or contact_channel not in ('email','sms','voice') or target_shortlist is null then
    raise exception using errcode='PT422',message='Invalid draft input';
  end if;
  data:=jsonb_build_array(target_application,target_shortlist,contact_channel);
  result:=private.contact_request_result(tenant,'draft',request_key,data);
  if result is not null then return result; end if;
  select * into entry from public.recruitment_shortlist_entries
    where id=target_shortlist and company_id=tenant and application_id=app.id and recruitment_id=app.recruitment_id for share nowait;
  if not found or entry.removed_at is not null then raise exception using errcode='PT409',message='Current human shortlist required'; end if;
  select * into analysis from public.screening_analysis_versions where id=entry.analysis_id and company_id=tenant for share nowait;
  if not found then raise exception using errcode='PT409',message='Shortlist source changed'; end if;
  select * into app from public.applications where id=target_application and company_id=tenant for share nowait;
  if not found or app.status not in ('new','in_progress') then raise exception using errcode='PT409',message='Application unavailable for contact'; end if;
  perform 1 from public.recruitments where id=app.recruitment_id and company_id=tenant and status='open' and position_id=analysis.position_id for share nowait;
  if not found then raise exception using errcode='PT409',message='Recruitment unavailable for contact'; end if;
  perform 1 from public.positions where id=analysis.position_id and company_id=tenant for share nowait;
  perform 1 from public.candidate_documents where company_id=tenant and candidate_id=app.candidate_id order by created_at desc,id desc limit 1 for share nowait;
  select * into current_shortlist from public.get_recruitment_shortlist(app.recruitment_id,false) where entry_id=target_shortlist;
  if not found or not current_shortlist.snapshot_current or not current_shortlist.policy_current then
    raise exception using errcode='PT409',message='Shortlist source changed';
  end if;
  if exists(select 1 from public.candidate_contact_permissions where company_id=tenant and candidate_id=app.candidate_id
    and (recruitment_id is null or recruitment_id=app.recruitment_id) and channel=contact_channel and state in ('revoked','blocked'))
    or exists(select 1 from public.candidate_contact_preferences where company_id=tenant and candidate_id=app.candidate_id and contact_channel=any(blocked_channels)) then
    raise exception using errcode='PT409',message='Contact channel denied';
  end if;
  insert into public.candidate_communications(company_id,recruitment_id,candidate_id,application_id,shortlist_entry_id,channel,created_by)
    values(tenant,app.recruitment_id,app.candidate_id,app.id,entry.id,contact_channel,auth.uid()) returning id into result;
  insert into public.candidate_communication_events(company_id,communication_id,event_type,actor_id)
    values(tenant,result,'draft_created',auth.uid());
  insert into private.contact_requests values(tenant,auth.uid(),'draft',request_key,data,result,now());
  return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Contact source changed';
end;
$$;

create function public.cancel_candidate_communication(target_id uuid,expected_version bigint,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare current_row public.candidate_communications; tenant uuid; data jsonb; result uuid;
begin
  select * into current_row from public.candidate_communications where id=target_id;
  tenant:=private.contact_lock_candidate(current_row.candidate_id);
  if expected_version is null or expected_version<1 then raise exception using errcode='PT422',message='Invalid communication version'; end if;
  data:=jsonb_build_array(target_id,expected_version);
  result:=private.contact_request_result(tenant,'cancel',request_key,data);
  if result is not null then return result; end if;
  select * into current_row from public.candidate_communications where id=target_id and company_id=tenant for update nowait;
  -- Repeated cancel is harmless even if caller still has the former version.
  if current_row.state<>'cancelled' then
    if current_row.version<>expected_version then raise exception using errcode='PT409',message='Communication version changed'; end if;
    update public.candidate_communications set state='cancelled',version=version+1,cancelled_at=now(),updated_at=now() where id=target_id;
    insert into public.candidate_communication_events(company_id,communication_id,event_type,actor_id) values(tenant,target_id,'cancelled',auth.uid());
  end if;
  insert into private.contact_requests values(tenant,auth.uid(),'cancel',request_key,data,target_id,now());
  return target_id;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Contact source changed';
end;
$$;

create function public.get_candidate_communications(target_application uuid,after_created_at timestamptz default null,after_id uuid default null,page_size integer default 50)
returns setof public.candidate_communications language plpgsql stable security invoker set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required'; end if;
  if page_size is null or page_size not between 1 and 100 or (after_created_at is null)<>(after_id is null) then
    raise exception using errcode='PT422',message='Invalid pagination';
  end if;
  if not exists(select 1 from public.applications where id=target_application) then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  return query select c.* from public.candidate_communications c where c.application_id=target_application
    and (after_id is null or (c.created_at,c.id)>(after_created_at,after_id)) order by c.created_at,c.id limit page_size;
end;
$$;
create function public.get_candidate_communication_history(target_id uuid,after_created_at timestamptz default null,after_id uuid default null,page_size integer default 50)
returns setof public.candidate_communication_events language plpgsql stable security invoker set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required'; end if;
  if page_size is null or page_size not between 1 and 100 or (after_created_at is null)<>(after_id is null) then
    raise exception using errcode='PT422',message='Invalid pagination';
  end if;
  if not exists(select 1 from public.candidate_communications where id=target_id) then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  return query select e.* from public.candidate_communication_events e where e.communication_id=target_id
    and (after_id is null or (e.created_at,e.id)>(after_created_at,after_id)) order by e.created_at,e.id limit page_size;
end;
$$;

-- No table mutation grants, no anonymous API, no contact capability for screening workers.
do $$
declare t text; f record;
begin
  foreach t in array array['candidate_contact_permissions','candidate_contact_preferences','candidate_communications','candidate_communication_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,screening_worker',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy tenant_read on public.%I for select to authenticated using (private.has_company_access(company_id))',t);
  end loop;
  foreach t in array array['contact_requests','contact_audit'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,screening_worker',t);
  end loop;
  for f in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='private' and p.proname in ('contact_immutable','contact_lock_candidate','contact_request_result','contact_cancel_drafts'))
      or (n.nspname='public' and p.proname in ('record_contact_permission','set_contact_preferences','prepare_candidate_communication','cancel_candidate_communication','get_candidate_communications','get_candidate_communication_history')) loop
    execute format('revoke all on function %s from public,anon,authenticated,screening_worker',f.signature);
    if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.signature); end if;
  end loop;
end;
$$;
commit;
