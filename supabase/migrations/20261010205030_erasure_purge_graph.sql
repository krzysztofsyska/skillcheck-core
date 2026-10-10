-- R3 graph executor. No runtime memberships, credentials, external calls or enabled execution.
begin;
create table private.erasure_purge_manifest (
 request_id uuid not null,manifest_hash text not null,adapter text not null,row_key text not null,row_hash text not null,
 primary key(request_id,manifest_hash,adapter,row_key)
);
create table private.erasure_purge_context (
 txid bigint primary key,request_id uuid not null,company_id uuid not null,manifest_hash text not null,
 mode text not null check(mode in ('delete','cancel'))
);
create table private.erasure_purge_context_rows (
 txid bigint not null references private.erasure_purge_context(txid) on delete cascade,
 adapter text not null,row_key text not null,row_hash text not null,command text not null check(command in ('delete','insert')),
 primary key(txid,adapter,row_key)
);
create table private.retired_candidate_ids (
 candidate_id uuid primary key,company_id uuid not null,generation bigint not null,
 recovery_event_id text not null,retain_until timestamptz not null
);
create table private.erasure_receipts (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,policy_revision bigint not null,
 phase text not null check(phase='active_data_erased'),counts jsonb not null,
 created_at timestamptz not null default date_trunc('hour',clock_timestamp())
);

create function private.erasure_purge_key(adapter text,data jsonb) returns text
language sql immutable set search_path='' as $$
 select case
 when adapter in ('private.contact_requests','private.erasure_configuration_requests','private.erasure_lifecycle_commands') then data->>'actor_id'||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter='private.erasure_candidate_lifecycle' then data->>'candidate_id'
 when adapter='private.erasure_denial_context' then data->>'txid'||':'||(data->>'candidate_id')
 else data->>'id' end
$$;

create function private.erasure_purge_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb)
language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 with requests as (select id from private.erasure_requests where company_id=tenant and candidate_ids && subjects union select request_id from private.erasure_executions where company_id=tenant and candidate_ids && subjects)
 select * from private.erasure_inventory_rows(tenant,subjects)
 union all select 'private.erasure_preview_tickets',t.id::text,to_jsonb(t) from private.erasure_preview_tickets t where t.company_id=tenant and t.candidate_ids && subjects
 union all select 'private.erasure_requests',t.id::text,to_jsonb(t) from private.erasure_requests t where t.id in(select id from requests)
 union all select 'private.erasure_lifecycle_events',t.id::text,to_jsonb(t) from private.erasure_lifecycle_events t where t.company_id=tenant and t.request_id in(select id from requests)
 union all select 'private.erasure_lifecycle_commands',private.erasure_purge_key('private.erasure_lifecycle_commands',to_jsonb(t)),to_jsonb(t) from private.erasure_lifecycle_commands t where t.company_id=tenant and t.result_id in(select id from requests)
 union all select 'private.erasure_candidate_lifecycle',t.candidate_id::text,to_jsonb(t) from private.erasure_candidate_lifecycle t where t.company_id=tenant and t.candidate_id=any(subjects)
 union all select 'private.erasure_holds',t.id::text,to_jsonb(t) from private.erasure_holds t where t.company_id=tenant and t.request_id in(select id from requests)
 union all select 'private.erasure_denial_context',private.erasure_purge_key('private.erasure_denial_context',to_jsonb(t)),to_jsonb(t) from private.erasure_denial_context t where t.candidate_id=any(subjects)
$$;

create function private.erasure_check_purge_scope(target_request uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare e private.erasure_executions;r record;refs uuid[];
begin
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.candidates where company_id=e.company_id and id=any(e.candidate_ids) order by id for update nowait;
 if exists(select 1 from private.erasure_subject_resolutions where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids)
 or exists(select 1 from private.erasure_preview_tickets where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids)
 or exists(select 1 from private.erasure_requests where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids)
 or exists(select 1 from private.erasure_executions x where x.company_id=e.company_id and x.candidate_ids && e.candidate_ids and not x.candidate_ids <@ e.candidate_ids and exists(select 1 from private.erasure_holds h where h.request_id=x.request_id)) then
  raise exception using errcode='PT409',message='Shared administrative scope requires separate adapter';end if;
 if exists(select 1 from private.contact_requests where company_id=e.company_id and private.erasure_contact_request_candidate(company_id,operation,payload,result_id) is null) then
  raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 for r in select * from private.erasure_purge_rows(e.company_id,e.candidate_ids) loop
  if r.adapter not like 'private.erasure_%' then
   refs:=private.erasure_row_candidates(r.adapter,r.row_data);
   if not refs <@ e.candidate_ids then raise exception using errcode='PT409',message='Shared candidate scope requires separate adapter';end if;
  end if;
 end loop;
 -- Self-FK SET NULL must never mutate another candidate when deleting an analysis.
 if exists(select 1 from public.screening_analysis_versions a join public.applications app on app.id=a.application_id
 where a.company_id=e.company_id and not app.candidate_id=any(e.candidate_ids)
 and a.superseded_by_analysis_id in(select (row_data->>'id')::uuid from private.erasure_purge_rows(e.company_id,e.candidate_ids) where adapter='public.screening_analysis_versions')) then
 raise exception using errcode='PT409',message='Shared analysis scope requires separate adapter';end if;
 -- Actual external provider resources require a real delete/reconcile adapter.
 if exists(select 1 from private.erasure_purge_rows(e.company_id,e.candidate_ids) external_row where
 external_row.adapter in ('public.screening_analysis_versions','public.screening_analysis_attempts') and (nullif(external_row.row_data->>'provider_request_id','') is not null or nullif(external_row.row_data->>'provider_response_id','') is not null)) then
 raise exception using errcode='PT409',message='External resource adapter required';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Erasure source busy';end;$$;

create function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R3 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r3 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;

create function private.install_erasure_tombstones(target_request uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare e private.erasure_executions;begin
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if not found or e.phase not in ('erasing','active_data_erased') or e.sequence<2 or e.event_hash is null or e.recovery_retain_until<=clock_timestamp() then
 raise exception using errcode='PT409',message='Durable erasing event required';end if;
 insert into private.retired_candidate_ids(candidate_id,company_id,generation,recovery_event_id,retain_until)
 select id,e.company_id,e.generation,e.event_hash,e.recovery_retain_until from unnest(e.candidate_ids) s(id)
 on conflict(candidate_id) do update set retain_until=greatest(retired_candidate_ids.retain_until,excluded.retain_until)
 where retired_candidate_ids.company_id=excluded.company_id;
 if exists(select 1 from unnest(e.candidate_ids) s(id) where not exists(select 1 from private.retired_candidate_ids t where t.candidate_id=s.id and t.company_id=e.company_id)) then
 raise exception using errcode='PT409',message='Retired identity mismatch';end if;
end;$$;

create function private.erasure_purge_allowed(adapter text,data jsonb,command text default 'delete') returns boolean
language sql stable security invoker set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select current_user='erasure_purge_owner' and exists(
 select 1 from private.erasure_purge_context c join private.erasure_purge_context_rows r on r.txid=c.txid
 where c.txid=txid_current() and r.adapter=erasure_purge_allowed.adapter
 and r.row_key=private.erasure_purge_key(adapter,data) and r.row_hash=private.erasure_hash(data)
 and r.command=erasure_purge_allowed.command)
$$;

create function private.erasure_purge_visible(adapter text,data jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select current_user='erasure_purge_owner' and exists(select 1 from private.erasure_purge_context_rows
 where txid=txid_current() and erasure_purge_context_rows.adapter=erasure_purge_visible.adapter
 and row_key=private.erasure_purge_key(adapter,data))
$$;

create or replace function private.contact_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' then
  if private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 end if;
 raise exception using errcode='42501',message='Immutable contact history';
end;$$;

create or replace function private.erasure_lock_candidate(target_candidate uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
 if exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then raise exception using errcode='PT409',message='Restore isolation required';end if;
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Candidate workflow requires read committed';end if;
 if target_candidate is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.candidates where id=target_candidate for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if private.erasure_candidate_frozen(target_candidate) and not exists(
  select 1 from private.erasure_denial_context where txid=txid_current() and candidate_id=target_candidate
 ) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Candidate workflow busy';
end;$$;

create or replace function private.erasure_owner(tenant uuid) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then raise exception using errcode='PT409',message='Restore isolation required';end if;
 if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required';end if;
 if not exists(select 1 from public.companies where id=tenant and owner_id=auth.uid()) then
 raise exception using errcode='PT404',message='Resource unavailable';end if;
end;$$;

create function private.erasure_normal_row_guard(operation text,schema_name text,table_name text,old_row jsonb,new_row jsonb) returns void language plpgsql security definer set search_path='' as $$
declare data jsonb;old_data jsonb;ids uuid[];subject uuid;k text;
begin
 if pg_trigger_depth()=0 then raise exception using errcode='42501',message='Trigger context required';end if;
 if operation='DELETE' and table_name in ('candidates','applications') then
  raise exception using errcode='PT409',message='Controlled erasure required';
 end if;
 if operation='UPDATE' then
  old_data:=old_row;data:=new_row;
  foreach k in array array['id','company_id','candidate_id','application_id','recruitment_id','candidate_document_id','analysis_id','review_id','criterion_result_id','communication_id','receipt_id','contact_point_id','shortlist_entry_id','stage_id','definition_entry_id','definition_id','exercise_definition_id'] loop
   if old_data->k is distinct from data->k then raise exception using errcode='PT409',message='Candidate identity is immutable';end if;
  end loop;
 end if;
 data:=case when operation='DELETE' then old_row else new_row end;
 -- The initial INSERT has no candidate row to lock; UUID/company mutations are forbidden above.
 if table_name='candidates' and operation='INSERT' then
  if exists(select 1 from private.retired_candidate_ids where candidate_id=(new_row->>'id')::uuid) or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then raise exception using errcode='PT409',message='Candidate identity unavailable';end if;
  return;end if;
 perform private.erasure_assert_row_tenant(data);
 ids:=private.erasure_row_candidates(schema_name||'.'||table_name,data);
 if exists(select 1 from unnest(ids) s(id) where not exists(select 1 from public.candidates c where c.id=s.id and c.company_id=(data->>'company_id')::uuid)) then
  raise exception using errcode='PT404',message='Resource unavailable';
 end if;
 foreach subject in array ids loop perform private.erasure_lock_candidate(subject);end loop;
 if operation='DELETE' then return;end if;
 return;
end;$$;

create or replace function private.erasure_guard_candidate_row() returns trigger
language plpgsql security invoker set search_path='' as $$
declare adapter text:=tg_table_schema||'.'||tg_table_name;begin
 if current_user='erasure_purge_owner' then
  if tg_op='DELETE' and private.erasure_purge_allowed(adapter,to_jsonb(old)) then return old;end if;
  if tg_op='INSERT' and adapter='public.candidate_communication_events' and private.erasure_purge_allowed(adapter,to_jsonb(new),'insert') then return new;end if;
  if tg_op='UPDATE' and adapter='public.candidate_communications' and private.erasure_purge_allowed(adapter,to_jsonb(old))
   and exists(select 1 from private.erasure_purge_context where txid=txid_current() and mode='cancel')
   and old.state='draft' and new.state='cancelled' and new.version=old.version+1 and new.cancelled_at is not null
   and (to_jsonb(old)-array['state','version','updated_at','cancelled_at'])=(to_jsonb(new)-array['state','version','updated_at','cancelled_at']) then return new;end if;
  raise exception using errcode='42501',message='Purge manifest boundary';
 end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end);
 if tg_op='DELETE' then return old;end if;return new;
end;$$;


create or replace function private.erasure_candidate_frozen(target_candidate uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.erasure_execution_config where singleton and restore_isolated)
 or exists(select 1 from private.erasure_candidate_lifecycle where candidate_id=target_candidate and status='frozen')
 or exists(select 1 from private.erasure_executions where target_candidate=any(candidate_ids) and phase<>'cancelled')
$$;
create or replace function private.candidate_workflow_visible(tenant uuid,subject uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select current_setting('transaction_isolation') in ('read committed','read uncommitted') and auth.uid() is not null and private.has_company_access(tenant)
 and not exists(select 1 from private.erasure_execution_config where singleton and restore_isolated)
 and not exists(select 1 from private.erasure_candidate_lifecycle where company_id=tenant and candidate_id=subject and status='frozen')
 and not exists(select 1 from private.erasure_executions where company_id=tenant and subject=any(candidate_ids) and phase<>'cancelled')
$$;

create function private.erasure_validate_purge(target_request uuid,expected_sequence bigint,restoring boolean) returns void
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;actual jsonb;begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 perform private.erasure_execution_gate(restoring);
 if restoring and e.restore_checkpoint_sequence is null then raise exception using errcode='42501',message='Verified restore checkpoint required';end if;
 if e.request_id is null or expected_sequence is null or e.phase<>'erasing' or e.sequence<>expected_sequence or e.sequence<2 or e.event_hash is null or e.reservation_id is not null or e.pending_phase is not null then
 raise exception using errcode='PT409',message='Durable erasing event required';end if;
 if e.local_purged then return;end if;
 if not restoring and (e.lease_until is null or e.lease_until<=clock_timestamp()) then raise exception using errcode='PT409',message='Erasure execution lease expired';end if;
 actual:=private.prepare_erasure_purge_manifest(target_request);
 if actual->>'manifest_hash' is distinct from e.manifest_hash or actual->>'schema_signature' is distinct from e.schema_signature then
 raise exception using errcode='PT409',message='Erasure manifest changed; ledger reconciliation required';end if;
 if exists(select 1 from unnest(e.candidate_ids) s(id) where not exists(select 1 from private.retired_candidate_ids where candidate_id=s.id and company_id=e.company_id and retain_until>=e.recovery_retain_until)) then
 raise exception using errcode='PT409',message='Durable retired identity required';end if;
end;$$;

create function private.erasure_purge_engine(target_request uuid,expected_sequence bigint,restoring boolean) returns jsonb
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
end;$$;
alter function private.erasure_purge_engine(uuid,bigint,boolean) owner to erasure_purge_owner;
create function private.purge_candidate_erasure(target_request uuid,expected_sequence bigint) returns jsonb
language sql volatile security definer set search_path='' as $$
 select private.erasure_purge_engine(target_request,expected_sequence,false)
$$;
alter function private.purge_candidate_erasure(uuid,bigint) owner to erasure_purge_owner;
create function private.restore_purge_candidate_erasure(target_request uuid,expected_sequence bigint) returns jsonb
language sql volatile security definer set search_path='' as $$
 select private.erasure_purge_engine(target_request,expected_sequence,true)
$$;
alter function private.restore_purge_candidate_erasure(uuid,bigint) owner to erasure_purge_owner;
grant select,delete on public.candidate_communication_approvals to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_communication_approvals for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_communication_approvals',to_jsonb(candidate_communication_approvals)));
create policy erasure_purge_delete on public.candidate_communication_approvals for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_communication_approvals',to_jsonb(candidate_communication_approvals)));
grant select,delete on public.candidate_communication_events to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_communication_events for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_communication_events',to_jsonb(candidate_communication_events)));
create policy erasure_purge_delete on public.candidate_communication_events for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_communication_events',to_jsonb(candidate_communication_events)));
grant select,delete on public.candidate_communications to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_communications for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_communications',to_jsonb(candidate_communications)));
create policy erasure_purge_delete on public.candidate_communications for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_communications',to_jsonb(candidate_communications)));
grant select,delete on public.candidate_contact_permissions to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_contact_permissions for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_contact_permissions',to_jsonb(candidate_contact_permissions)));
create policy erasure_purge_delete on public.candidate_contact_permissions for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_contact_permissions',to_jsonb(candidate_contact_permissions)));
grant select,delete on public.candidate_contact_preferences to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_contact_preferences for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_contact_preferences',to_jsonb(candidate_contact_preferences)));
create policy erasure_purge_delete on public.candidate_contact_preferences for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_contact_preferences',to_jsonb(candidate_contact_preferences)));
grant select,delete on public.recruitment_shortlist_entries to erasure_purge_owner;
create policy erasure_purge_select on public.recruitment_shortlist_entries for select to erasure_purge_owner using (private.erasure_purge_visible('public.recruitment_shortlist_entries',to_jsonb(recruitment_shortlist_entries)));
create policy erasure_purge_delete on public.recruitment_shortlist_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.recruitment_shortlist_entries',to_jsonb(recruitment_shortlist_entries)));
grant select,delete on public.screening_criterion_review_overrides to erasure_purge_owner;
create policy erasure_purge_select on public.screening_criterion_review_overrides for select to erasure_purge_owner using (private.erasure_purge_visible('public.screening_criterion_review_overrides',to_jsonb(screening_criterion_review_overrides)));
create policy erasure_purge_delete on public.screening_criterion_review_overrides for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.screening_criterion_review_overrides',to_jsonb(screening_criterion_review_overrides)));
grant select,delete on public.screening_result_reviews to erasure_purge_owner;
create policy erasure_purge_select on public.screening_result_reviews for select to erasure_purge_owner using (private.erasure_purge_visible('public.screening_result_reviews',to_jsonb(screening_result_reviews)));
create policy erasure_purge_delete on public.screening_result_reviews for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.screening_result_reviews',to_jsonb(screening_result_reviews)));
grant select,delete on public.screening_criterion_results to erasure_purge_owner;
create policy erasure_purge_select on public.screening_criterion_results for select to erasure_purge_owner using (private.erasure_purge_visible('public.screening_criterion_results',to_jsonb(screening_criterion_results)));
create policy erasure_purge_delete on public.screening_criterion_results for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.screening_criterion_results',to_jsonb(screening_criterion_results)));
grant select,delete on public.screening_analysis_attempts to erasure_purge_owner;
create policy erasure_purge_select on public.screening_analysis_attempts for select to erasure_purge_owner using (private.erasure_purge_visible('public.screening_analysis_attempts',to_jsonb(screening_analysis_attempts)));
create policy erasure_purge_delete on public.screening_analysis_attempts for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.screening_analysis_attempts',to_jsonb(screening_analysis_attempts)));
grant select,delete on public.screening_analysis_versions to erasure_purge_owner;
create policy erasure_purge_select on public.screening_analysis_versions for select to erasure_purge_owner using (private.erasure_purge_visible('public.screening_analysis_versions',to_jsonb(screening_analysis_versions)));
create policy erasure_purge_delete on public.screening_analysis_versions for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.screening_analysis_versions',to_jsonb(screening_analysis_versions)));
grant select,delete on public.exercise_observation_entries to erasure_purge_owner;
create policy erasure_purge_select on public.exercise_observation_entries for select to erasure_purge_owner using (private.erasure_purge_visible('public.exercise_observation_entries',to_jsonb(exercise_observation_entries)));
create policy erasure_purge_delete on public.exercise_observation_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.exercise_observation_entries',to_jsonb(exercise_observation_entries)));
grant select,delete on public.behavior_assessment_entries to erasure_purge_owner;
create policy erasure_purge_select on public.behavior_assessment_entries for select to erasure_purge_owner using (private.erasure_purge_visible('public.behavior_assessment_entries',to_jsonb(behavior_assessment_entries)));
create policy erasure_purge_delete on public.behavior_assessment_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.behavior_assessment_entries',to_jsonb(behavior_assessment_entries)));
grant select,delete on public.candidate_assessments to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_assessments for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_assessments',to_jsonb(candidate_assessments)));
create policy erasure_purge_delete on public.candidate_assessments for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_assessments',to_jsonb(candidate_assessments)));
grant select,delete on public.applications to erasure_purge_owner;
create policy erasure_purge_select on public.applications for select to erasure_purge_owner using (private.erasure_purge_visible('public.applications',to_jsonb(applications)));
create policy erasure_purge_delete on public.applications for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.applications',to_jsonb(applications)));
grant select,delete on public.candidate_documents to erasure_purge_owner;
create policy erasure_purge_select on public.candidate_documents for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidate_documents',to_jsonb(candidate_documents)));
create policy erasure_purge_delete on public.candidate_documents for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_documents',to_jsonb(candidate_documents)));
grant select,delete on public.candidates to erasure_purge_owner;
create policy erasure_purge_select on public.candidates for select to erasure_purge_owner using (private.erasure_purge_visible('public.candidates',to_jsonb(candidates)));
create policy erasure_purge_delete on public.candidates for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.candidates',to_jsonb(candidates)));
grant select,delete on private.contact_requests to erasure_purge_owner;
create policy erasure_purge_select on private.contact_requests for select to erasure_purge_owner using (private.erasure_purge_visible('private.contact_requests',to_jsonb(contact_requests)));
create policy erasure_purge_delete on private.contact_requests for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.contact_requests',to_jsonb(contact_requests)));
grant select,delete on private.candidate_verified_contact_receipts to erasure_purge_owner;
create policy erasure_purge_select on private.candidate_verified_contact_receipts for select to erasure_purge_owner using (private.erasure_purge_visible('private.candidate_verified_contact_receipts',to_jsonb(candidate_verified_contact_receipts)));
create policy erasure_purge_delete on private.candidate_verified_contact_receipts for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.candidate_verified_contact_receipts',to_jsonb(candidate_verified_contact_receipts)));
grant select,delete on private.candidate_verified_contact_points to erasure_purge_owner;
create policy erasure_purge_select on private.candidate_verified_contact_points for select to erasure_purge_owner using (private.erasure_purge_visible('private.candidate_verified_contact_points',to_jsonb(candidate_verified_contact_points)));
create policy erasure_purge_delete on private.candidate_verified_contact_points for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.candidate_verified_contact_points',to_jsonb(candidate_verified_contact_points)));
grant select,delete on private.contact_audit to erasure_purge_owner;
create policy erasure_purge_select on private.contact_audit for select to erasure_purge_owner using (private.erasure_purge_visible('private.contact_audit',to_jsonb(contact_audit)));
create policy erasure_purge_delete on private.contact_audit for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.contact_audit',to_jsonb(contact_audit)));
grant select,delete on private.erasure_configuration_requests to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_configuration_requests for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_configuration_requests',to_jsonb(erasure_configuration_requests)));
create policy erasure_purge_delete on private.erasure_configuration_requests for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_configuration_requests',to_jsonb(erasure_configuration_requests)));
grant select,delete on private.erasure_lifecycle_commands to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_lifecycle_commands for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_lifecycle_commands',to_jsonb(erasure_lifecycle_commands)));
create policy erasure_purge_delete on private.erasure_lifecycle_commands for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_lifecycle_commands',to_jsonb(erasure_lifecycle_commands)));
grant select,delete on private.erasure_lifecycle_events to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_lifecycle_events for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_lifecycle_events',to_jsonb(erasure_lifecycle_events)));
create policy erasure_purge_delete on private.erasure_lifecycle_events for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_lifecycle_events',to_jsonb(erasure_lifecycle_events)));
grant select,delete on private.erasure_candidate_lifecycle to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_candidate_lifecycle for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_candidate_lifecycle',to_jsonb(erasure_candidate_lifecycle)));
create policy erasure_purge_delete on private.erasure_candidate_lifecycle for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_candidate_lifecycle',to_jsonb(erasure_candidate_lifecycle)));
grant select,delete on private.erasure_requests to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_requests for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_requests',to_jsonb(erasure_requests)));
create policy erasure_purge_delete on private.erasure_requests for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_requests',to_jsonb(erasure_requests)));
grant select,delete on private.erasure_preview_tickets to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_preview_tickets for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_preview_tickets',to_jsonb(erasure_preview_tickets)));
create policy erasure_purge_delete on private.erasure_preview_tickets for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_preview_tickets',to_jsonb(erasure_preview_tickets)));
grant select,delete on private.erasure_subject_resolutions to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_subject_resolutions for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_subject_resolutions',to_jsonb(erasure_subject_resolutions)));
create policy erasure_purge_delete on private.erasure_subject_resolutions for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_subject_resolutions',to_jsonb(erasure_subject_resolutions)));
grant select,delete on private.erasure_denial_context to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_denial_context for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_denial_context',to_jsonb(erasure_denial_context)));
create policy erasure_purge_delete on private.erasure_denial_context for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_denial_context',to_jsonb(erasure_denial_context)));
grant select,delete on private.erasure_holds to erasure_purge_owner;
create policy erasure_purge_select on private.erasure_holds for select to erasure_purge_owner using (private.erasure_purge_visible('private.erasure_holds',to_jsonb(erasure_holds)));
create policy erasure_purge_delete on private.erasure_holds for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.erasure_holds',to_jsonb(erasure_holds)));

grant update(state,version,cancelled_at,updated_at) on public.candidate_communications to erasure_purge_owner;
create policy erasure_purge_cancel on public.candidate_communications for update to erasure_purge_owner using (private.erasure_purge_allowed('public.candidate_communications',to_jsonb(candidate_communications))) with check (true);
grant insert on public.candidate_communication_events to erasure_purge_owner;
create policy erasure_purge_event on public.candidate_communication_events for insert to erasure_purge_owner with check (private.erasure_purge_allowed('public.candidate_communication_events',to_jsonb(candidate_communication_events),'insert'));
alter table private.erasure_purge_manifest enable row level security;
revoke all on private.erasure_purge_manifest from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor;
alter table private.erasure_purge_context enable row level security;
revoke all on private.erasure_purge_context from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor;
alter table private.erasure_purge_context_rows enable row level security;
revoke all on private.erasure_purge_context_rows from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor;
alter table private.retired_candidate_ids enable row level security;
revoke all on private.retired_candidate_ids from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor;
alter table private.erasure_receipts enable row level security;
revoke all on private.erasure_receipts from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor;
grant select,delete on private.erasure_purge_manifest to erasure_purge_owner;
create policy purge_owner_context on private.erasure_purge_manifest to erasure_purge_owner using (true) with check(true);
grant select,insert,update,delete on private.erasure_purge_context to erasure_purge_owner;
create policy purge_owner_context on private.erasure_purge_context to erasure_purge_owner using (true) with check(true);
grant select,insert,update,delete on private.erasure_purge_context_rows to erasure_purge_owner;
create policy purge_owner_context on private.erasure_purge_context_rows to erasure_purge_owner using (true) with check(true);
grant select,insert on private.erasure_receipts to erasure_purge_owner;
create policy purge_owner_context on private.erasure_receipts to erasure_purge_owner using (true) with check(true);

revoke all on function private.erasure_purge_key(text,jsonb),private.erasure_purge_rows(uuid,uuid[]),private.erasure_check_purge_scope(uuid),private.prepare_erasure_purge_manifest(uuid),private.install_erasure_tombstones(uuid),private.erasure_purge_allowed(text,jsonb,text),private.erasure_purge_visible(text,jsonb),private.erasure_normal_row_guard(text,text,text,jsonb,jsonb),private.erasure_validate_purge(uuid,bigint,boolean),private.erasure_purge_engine(uuid,bigint,boolean),private.restore_purge_candidate_erasure(uuid,bigint),private.purge_candidate_erasure(uuid,bigint) from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor;
grant usage on schema private,public to erasure_purge_owner;
grant execute on function private.erasure_purge_key(text,jsonb),private.erasure_purge_allowed(text,jsonb,text),private.erasure_purge_visible(text,jsonb),private.erasure_hash(jsonb),private.erasure_validate_purge(uuid,bigint,boolean) to erasure_purge_owner;
grant execute on function private.purge_candidate_erasure(uuid,bigint) to erasure_worker;
grant execute on function private.restore_purge_candidate_erasure(uuid,bigint) to erasure_restore_attestor;
-- Only trigger invocations may enter this helper; normal tenant/write authorization remains enforced.
grant execute on function private.erasure_normal_row_guard(text,text,text,jsonb,jsonb) to authenticated,screening_worker,contact_verifier;
commit;
