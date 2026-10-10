-- R3 protocol. Credentials, ledger and execution configuration are deliberately unprovisioned.
begin;
do $$declare role_name text; r record;begin
 foreach role_name in array array['erasure_worker','erasure_ledger_attestor','erasure_restore_attestor','erasure_purge_owner'] loop
 if not exists(select 1 from pg_roles where rolname=role_name) then execute format('create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',role_name);end if;
 select * into r from pg_roles where rolname=role_name;
 if r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or exists(select 1 from pg_auth_members where roleid=r.oid or member=r.oid) then raise exception 'Unsafe erasure role configuration';end if;
 end loop;
end;$$;
create table private.erasure_execution_config (
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 external_inventory_verified boolean not null default false,backup_horizon_days integer check(backup_horizon_days between 1 and 36500),
 artifact_horizon_days integer check(artifact_horizon_days between 1 and 36500),retention_margin_days integer check(retention_margin_days between 1 and 36500),
 restore_isolated boolean not null default false
);
insert into private.erasure_execution_config(singleton) values(true);
create table private.erasure_executions (
 request_id uuid primary key,company_id uuid not null,candidate_ids uuid[] not null,scope_kind text not null check(scope_kind in ('candidate_record','confirmed_subject')),
 owner_id uuid not null,policy_copy jsonb not null,resolution_revision bigint not null,generation bigint not null,
 phase text not null check(phase in ('authorized','cancelled','erasing','active_data_erased')),sequence bigint not null default 0 check(sequence>=0),event_hash text,
 reservation_id uuid,pending_phase text check(pending_phase in ('authorized','cancelled','erasing','active_data_erased')),reservation_key uuid,
 envelope jsonb,envelope_hash text,lease_until timestamptz,
 manifest_hash text,schema_signature text,counts jsonb,receipt_id uuid,local_purged boolean not null default false,
 recovery_retain_until timestamptz not null,created_at timestamptz not null default clock_timestamp(),cancelled_at timestamptz,
 restore_checkpoint_sequence bigint,restore_checkpoint_hash text
);
create index erasure_executions_company_idx on private.erasure_executions(company_id,created_at desc,request_id desc);
create index erasure_executions_subject_idx on private.erasure_executions using gin(candidate_ids);
create table private.erasure_verified_ledger_events (
 request_id uuid not null,sequence bigint not null,reservation_id uuid not null,envelope_hash text not null,event_hash text not null,
 previous_event_hash text,phase text not null,verified_at timestamptz not null default clock_timestamp(),primary key(request_id,sequence)
);
create table private.erasure_holds (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,request_id uuid not null,actor_id uuid not null,
 reason text not null check(reason in ('legal_review','active_purpose','owner_review')),review_at timestamptz not null,expires_at timestamptz not null,
 request_key uuid not null,released_at timestamptz,created_at timestamptz not null default clock_timestamp(),unique(company_id,actor_id,request_key)
);
create table private.erasure_restore_checkpoint (
 singleton boolean primary key default true check(singleton),sequence bigint not null,checkpoint_hash text not null
);

create function private.erasure_execution_gate(restoring boolean default false) returns private.erasure_execution_config
language plpgsql stable security definer set search_path='' as $$
declare c private.erasure_execution_config;begin
 select * into c from private.erasure_execution_config where singleton;
 if c.enabled is distinct from true or c.external_inventory_verified is distinct from true or c.backup_horizon_days is null or c.artifact_horizon_days is null or c.retention_margin_days is null
 or (restoring and c.restore_isolated is distinct from true) or (not restoring and c.restore_isolated) then raise exception using errcode='PT409',message='Erasure execution is not configured';end if;
 return c;end;$$;

create function private.erasure_reserve_locked(target_request uuid,target_phase text,request_key uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;value jsonb;begin
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if request_key is null then raise exception using errcode='PT422',message='Request key required';end if;
 if e.reservation_id is not null then
  if e.pending_phase=target_phase and e.reservation_key=request_key then return jsonb_build_object('reservation_id',e.reservation_id,'envelope_text',e.envelope::text,'envelope_hash',e.envelope_hash);end if;
  raise exception using errcode='PT409',message='Ledger reconciliation required';
 end if;
 if not ((e.sequence=0 and target_phase='authorized') or (e.sequence>0 and e.phase='authorized' and target_phase in ('cancelled','erasing')) or (e.phase='erasing' and e.local_purged and target_phase='active_data_erased') or (e.phase='erasing' and not e.local_purged and target_phase='erasing')) then raise exception using errcode='PT409',message='Invalid erasure transition';end if;
 value:=jsonb_build_object('contract','sc010-r3-v1','company_id',e.company_id,'request_id',e.request_id,'generation',e.generation,'candidate_ids',e.candidate_ids,
 'scope_kind',e.scope_kind,'resolution_revision',e.resolution_revision,'authorized_at',e.created_at,'policy',e.policy_copy,
 'authorization',jsonb_build_object('kind','owner','actor_id',e.owner_id),'manifest_hash',e.manifest_hash,'schema_signature',e.schema_signature,
 'external_resources','[]'::jsonb,'phase',target_phase,'sequence',e.sequence+1,'previous_phase',case when e.sequence=0 then null else e.phase end,
 'previous_event_hash',e.event_hash,'retention_until',e.recovery_retain_until);
 update private.erasure_executions set reservation_id=gen_random_uuid(),pending_phase=target_phase,reservation_key=request_key,envelope=value,
 envelope_hash=private.erasure_hash(value),lease_until=clock_timestamp()+interval '5 minutes' where request_id=e.request_id returning * into e;
 return jsonb_build_object('reservation_id',e.reservation_id,'envelope_text',e.envelope::text,'envelope_hash',e.envelope_hash);
end;$$;

create function private.reserve_erasure_transition(target_request uuid,expected_sequence bigint,target_phase text,request_key uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare e private.erasure_executions;r private.erasure_requests;c private.erasure_execution_config;p private.candidate_retention_policies;resolution private.erasure_subject_resolutions;inventory jsonb;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 c:=private.erasure_execution_gate(false);
 if target_phase is null or target_phase not in ('authorized','erasing','active_data_erased') or expected_sequence is null then raise exception using errcode='PT422',message='Invalid transition';end if;
 select * into e from private.erasure_executions where request_id=target_request;
 if not found then
  if expected_sequence<>0 or target_phase<>'authorized' then raise exception using errcode='PT409',message='Erasure request changed';end if;
  select * into r from private.erasure_requests where id=target_request;
  if not found or r.status<>'authorized' then raise exception using errcode='PT404',message='Resource unavailable';end if;
  perform 1 from public.companies where id=r.company_id and owner_id=r.actor_id for update nowait;
  if not found then raise exception using errcode='PT409',message='Owner changed';end if;
  perform 1 from public.candidates where company_id=r.company_id and id=any(r.candidate_ids) order by id for update nowait;
  select * into r from private.erasure_requests where id=target_request for update nowait;
  if r.status<>'authorized' then raise exception using errcode='PT409',message='Erasure request changed';end if;
  select * into p from private.candidate_retention_policies where company_id=r.company_id order by revision desc limit 1;
  if p.revision is distinct from r.policy_revision or p.approved_by is distinct from r.actor_id or jsonb_array_length(p.rules)<>8 then raise exception using errcode='PT409',message='Retention policy changed';end if;
  if r.scope_kind='confirmed_subject' then
   select * into resolution from private.erasure_subject_resolutions where company_id=r.company_id and anchor_candidate_id=r.anchor_candidate_id order by revision desc limit 1;
   if resolution.revision is distinct from r.resolution_revision or resolution.candidate_ids is distinct from r.candidate_ids or resolution.confirmed_by is distinct from r.actor_id then raise exception using errcode='PT409',message='Subject resolution changed';end if;
  end if;
  if exists(select 1 from unnest(r.candidate_ids) s(id) left join private.erasure_candidate_lifecycle l on l.candidate_id=s.id where l.status is distinct from 'frozen' or l.request_id is distinct from r.id) then raise exception using errcode='PT409',message='Lifecycle changed';end if;
  insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
  values(r.id,r.company_id,r.candidate_ids,r.scope_kind,r.actor_id,jsonb_build_object('revision',p.revision,'rules',p.rules),r.resolution_revision,r.generation,'authorized',clock_timestamp()+make_interval(days=>greatest(c.backup_horizon_days,c.artifact_horizon_days)+c.retention_margin_days));
  inventory:=private.prepare_erasure_purge_manifest(target_request);
  update private.erasure_executions set manifest_hash=inventory->>'manifest_hash',schema_signature=inventory->>'schema_signature',counts=inventory->'counts' where request_id=target_request;
 end if;
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if e.sequence<>expected_sequence then raise exception using errcode='PT409',message='Ledger sequence changed';end if;
 if target_phase='erasing' and e.phase='authorized' then
  perform 1 from public.companies where id=e.company_id and owner_id=e.owner_id for update nowait;
  if not found then raise exception using errcode='PT409',message='Owner changed';end if;
  select * into p from private.candidate_retention_policies where company_id=e.company_id order by revision desc limit 1;
  if jsonb_build_object('revision',p.revision,'rules',p.rules) is distinct from e.policy_copy or p.approved_by is distinct from e.owner_id then raise exception using errcode='PT409',message='Retention policy changed';end if;
  if e.scope_kind='confirmed_subject' then
   select * into r from private.erasure_requests where id=target_request;
   select * into resolution from private.erasure_subject_resolutions where company_id=e.company_id and anchor_candidate_id=r.anchor_candidate_id order by revision desc limit 1;
   if resolution.revision is distinct from e.resolution_revision or resolution.candidate_ids is distinct from e.candidate_ids or resolution.confirmed_by is distinct from e.owner_id then raise exception using errcode='PT409',message='Subject resolution changed';end if;
  end if;
 end if;
 if target_phase='erasing' and exists(select 1 from private.erasure_holds where request_id=target_request and released_at is null) then raise exception using errcode='PT409',message='Erasure hold requires review';end if;
 if target_phase='erasing' and e.reservation_id is null then
  inventory:=private.prepare_erasure_purge_manifest(target_request);
  if inventory->>'schema_signature' is distinct from e.schema_signature then raise exception using errcode='PT409',message='Adapter schema changed';end if;
  update private.erasure_executions set manifest_hash=inventory->>'manifest_hash',counts=inventory->'counts' where request_id=target_request;
 end if;
 -- The worker may only request forward phases. Owner cancellation has its own authenticated entry point.
 return private.erasure_reserve_locked(target_request,target_phase,request_key);
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Erasure request busy';end;$$;

create function private.confirm_erasure_ledger_event(target_request uuid,reservation_id uuid,ledger_sequence bigint,previous_event_hash text,event_hash text,envelope_hash text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare e private.erasure_executions;seen private.erasure_verified_ledger_events;begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into seen from private.erasure_verified_ledger_events where request_id=target_request and sequence=ledger_sequence;
 if found then
  if seen.reservation_id=confirm_erasure_ledger_event.reservation_id and seen.event_hash=confirm_erasure_ledger_event.event_hash and seen.envelope_hash=confirm_erasure_ledger_event.envelope_hash and seen.previous_event_hash is not distinct from confirm_erasure_ledger_event.previous_event_hash then return jsonb_build_object('phase',e.phase,'sequence',e.sequence);end if;
  raise exception using errcode='PT409',message='Ledger event changed';
 end if;
 if event_hash is null or event_hash !~ '^[0-9a-f]{64}$' or envelope_hash is null or envelope_hash !~ '^[0-9a-f]{64}$'
 or e.reservation_id is distinct from reservation_id or e.sequence+1 is distinct from ledger_sequence or e.event_hash is distinct from previous_event_hash or e.envelope_hash is distinct from envelope_hash then raise exception using errcode='PT409',message='Ledger reservation mismatch';end if;
 -- Late ACK of the same reservation is authoritative, even after lease expiry; expiry never authorizes the opposite phase.
 insert into private.erasure_verified_ledger_events(request_id,sequence,reservation_id,envelope_hash,event_hash,previous_event_hash,phase)
 values(target_request,ledger_sequence,reservation_id,envelope_hash,event_hash,previous_event_hash,e.pending_phase);
 update private.erasure_executions set phase=pending_phase,sequence=ledger_sequence,event_hash=confirm_erasure_ledger_event.event_hash,reservation_id=null,pending_phase=null,reservation_key=null,lease_until=case when e.pending_phase='erasing' then clock_timestamp()+interval '5 minutes' else null end,
 cancelled_at=case when e.pending_phase='cancelled' then clock_timestamp() else cancelled_at end where request_id=target_request;
 if e.pending_phase='erasing' then perform private.install_erasure_tombstones(target_request);end if;
 if e.pending_phase='cancelled' then
  perform 1 from public.candidates where company_id=e.company_id and id=any(e.candidate_ids) order by id for update nowait;
  update private.erasure_candidate_lifecycle set generation=generation+1,status='active' where request_id=target_request and status='frozen';
  update private.erasure_requests set status='cancelled',generation=generation+1,cancelled_at=clock_timestamp() where id=target_request and status='authorized';
 end if;
 return jsonb_build_object('phase',e.pending_phase,'sequence',ledger_sequence);
exception when lock_not_available then raise exception using errcode='PT409',message='Erasure request busy';end;$$;

create function private.get_erasure_work(target_request uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('request_id',request_id,'phase',phase,'sequence',sequence,'pending_phase',pending_phase,'reservation_id',reservation_id,
 'envelope_text',envelope::text,'envelope_hash',envelope_hash,'local_purged',local_purged,'event_hash',event_hash) from private.erasure_executions where request_id=target_request
$$;

-- Keep R2 local cancellation only where no envelope has ever been made exportable.
alter function public.cancel_candidate_erasure(uuid,bigint,uuid) rename to cancel_candidate_erasure_local_r2;
alter function public.cancel_candidate_erasure_local_r2(uuid,bigint,uuid) set schema private;
revoke all on function private.cancel_candidate_erasure_local_r2(uuid,bigint,uuid) from public,anon,authenticated,screening_worker,contact_verifier;
create or replace function private.cancel_candidate_erasure_local_r2(target_request uuid,expected_generation bigint,request_key uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare r private.erasure_requests;old private.erasure_lifecycle_commands;payload text;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select * into r from private.erasure_requests where id=target_request;perform private.erasure_owner(r.company_id);
 perform 1 from public.companies where id=r.company_id and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if request_key is null or expected_generation is null or expected_generation<1 then raise exception using errcode='PT422',message='Invalid cancellation';end if;
 payload:=private.erasure_hash(jsonb_build_array(target_request,expected_generation));
 select * into old from private.erasure_lifecycle_commands c where c.company_id=r.company_id and c.actor_id=auth.uid() and c.operation='cancel' and c.request_key=cancel_candidate_erasure_local_r2.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 perform 1 from public.candidates where company_id=r.company_id and id=any(r.candidate_ids) order by id for update nowait;
 select * into r from private.erasure_requests where id=target_request for update nowait;
 if r.status<>'authorized' or r.generation<>expected_generation then raise exception using errcode='PT409',message='Erasure request changed';end if;
 if exists(select 1 from unnest(r.candidate_ids) s(id) left join private.erasure_candidate_lifecycle l on l.candidate_id=s.id
 where l.request_id is distinct from r.id or l.status is distinct from 'frozen') then raise exception using errcode='PT409',message='Lifecycle changed';end if;
 -- R2 is local and reversible: there is structurally no external recovery envelope or erasing executor.
 -- R3 must replace this cancellation protocol before introducing either capability.
 update private.erasure_candidate_lifecycle set generation=generation+1,status='active' where candidate_id=any(r.candidate_ids) and request_id=r.id;
 update private.erasure_requests set status='cancelled',generation=generation+1,cancelled_at=clock_timestamp() where id=r.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(r.company_id,r.id,auth.uid(),'cancelled',r.generation+1);
 insert into private.erasure_lifecycle_commands values(r.company_id,auth.uid(),'cancel',request_key,payload,r.id);
 return r.id;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Erasure request changed';end;$$;

create function public.cancel_candidate_erasure(target_request uuid,expected_generation bigint,request_key uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare e private.erasure_executions;tenant uuid;old private.erasure_lifecycle_commands;payload text;begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select company_id into tenant from private.erasure_requests where id=target_request;
 if tenant is null then select company_id into tenant from private.erasure_executions where request_id=target_request;end if;
 perform private.erasure_owner(tenant);
 perform 1 from public.companies where id=tenant and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if not found then return private.cancel_candidate_erasure_local_r2(target_request,expected_generation,request_key);end if;
 if request_key is null or expected_generation is null then raise exception using errcode='PT422',message='Invalid cancellation';end if;
 payload:=private.erasure_hash(jsonb_build_array(target_request,expected_generation));
 select * into old from private.erasure_lifecycle_commands c where c.company_id=tenant and c.actor_id=auth.uid() and c.operation='cancel' and c.request_key=cancel_candidate_erasure.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 if expected_generation is distinct from e.generation or e.phase<>'authorized' then raise exception using errcode='PT409',message='Cancellation unavailable';end if;
 perform private.erasure_reserve_locked(target_request,'cancelled',request_key);
 insert into private.erasure_lifecycle_commands values(tenant,auth.uid(),'cancel',request_key,payload,target_request);return target_request;
exception when lock_not_available then raise exception using errcode='PT409',message='Erasure request busy';end;$$;

-- This ingress belongs only to the isolated verifier runtime. It verifies signatures,
-- complete stream coverage and the authoritative global checkpoint outside the restored DB.
create function private.replay_erasure_envelope(envelope_text text,event_hash text,checkpoint_sequence bigint,checkpoint_hash text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare value jsonb;tenant uuid;request uuid;subjects uuid[];e private.erasure_executions;cp private.erasure_restore_checkpoint;inventory jsonb;seq bigint;phase text;expired boolean;
begin
 perform private.erasure_execution_gate(true);
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 if envelope_text is null or octet_length(envelope_text)>65536 or event_hash is null or event_hash !~ '^[0-9a-f]{64}$' or checkpoint_hash is null or checkpoint_hash !~ '^[0-9a-f]{64}$' or checkpoint_sequence is null or checkpoint_sequence<1 then raise exception using errcode='PT422',message='Invalid recovery envelope';end if;
 value:=envelope_text::jsonb;
 if value->>'contract' is distinct from 'sc010-r3-v1' or jsonb_typeof(value->'candidate_ids') is distinct from 'array' or jsonb_typeof(value->'policy'->'rules') is distinct from 'array'
 or value->>'scope_kind' not in ('candidate_record','confirmed_subject') or value->>'phase' not in ('authorized','cancelled','erasing','active_data_erased')
 or value->>'schema_signature' is distinct from private.erasure_schema_signature() or value->'external_resources' is distinct from '[]'::jsonb
 or value->'authorization'->>'kind' is distinct from 'owner' then raise exception using errcode='PT409',message='Recovery adapter unavailable';end if;
 if jsonb_array_length(value->'candidate_ids') not between 1 and 100 or jsonb_array_length(value->'policy'->'rules')<>8 then raise exception using errcode='PT422',message='Invalid recovery scope';end if;
 tenant:=(value->>'company_id')::uuid;request:=(value->>'request_id')::uuid;seq:=(value->>'sequence')::bigint;phase:=value->>'phase';
 select array_agg(x::uuid order by x::uuid) into subjects from jsonb_array_elements_text(value->'candidate_ids') x;
 if cardinality(subjects)<>(select count(distinct id) from unnest(subjects) s(id)) or array_position(subjects,null) is not null or seq<1 or (value->>'generation')::bigint<1 or not isfinite((value->>'retention_until')::timestamptz) then raise exception using errcode='PT409',message='Recovery envelope invalid';end if;
 expired:=(value->>'retention_until')::timestamptz<=clock_timestamp();
 if exists(select 1 from public.candidates where id=any(subjects) and company_id<>tenant) then raise exception using errcode='PT409',message='Recovery scope mismatch';end if;
 select * into cp from private.erasure_restore_checkpoint where singleton for update nowait;
 if found and (cp.sequence>checkpoint_sequence or (cp.sequence=checkpoint_sequence and cp.checkpoint_hash<>checkpoint_hash)) then raise exception using errcode='PT409',message='Recovery checkpoint regressed';end if;
 insert into private.erasure_restore_checkpoint values(true,checkpoint_sequence,checkpoint_hash) on conflict(singleton) do update set sequence=excluded.sequence,checkpoint_hash=excluded.checkpoint_hash;
 select * into e from private.erasure_executions where request_id=request for update nowait;
 if found then
  if e.company_id<>tenant or e.candidate_ids<>subjects or e.generation<>(value->>'generation')::bigint or e.scope_kind<>value->>'scope_kind' then raise exception using errcode='PT409',message='Recovery stream scope changed';end if;
  if e.sequence>seq or (e.sequence=seq and e.event_hash is distinct from event_hash) then raise exception using errcode='PT409',message='Recovery stream regressed';end if;
  if e.phase in ('erasing','active_data_erased') and phase in ('authorized','cancelled') then raise exception using errcode='PT409',message='Irreversible recovery phase';end if;
 end if;
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,sequence,event_hash,envelope,envelope_hash,manifest_hash,schema_signature,recovery_retain_until,created_at,restore_checkpoint_sequence,restore_checkpoint_hash)
 values(request,tenant,subjects,value->>'scope_kind',(value->'authorization'->>'actor_id')::uuid,value->'policy',(value->>'resolution_revision')::bigint,(value->>'generation')::bigint,
 case when phase='active_data_erased' then 'erasing' else phase end,seq,event_hash,value,private.erasure_hash(value),value->>'manifest_hash',value->>'schema_signature',(value->>'retention_until')::timestamptz,(value->>'authorized_at')::timestamptz,checkpoint_sequence,checkpoint_hash)
 on conflict(request_id) do update set phase=excluded.phase,sequence=excluded.sequence,event_hash=excluded.event_hash,envelope=excluded.envelope,envelope_hash=excluded.envelope_hash,
 reservation_id=null,pending_phase=null,reservation_key=null,lease_until=null,local_purged=false,restore_checkpoint_sequence=excluded.restore_checkpoint_sequence,restore_checkpoint_hash=excluded.restore_checkpoint_hash;
 -- Age is not erasure authority. For irreversible or pending authorizations,
 -- an expired envelope may acknowledge ONLY an already absent, fully reviewed
 -- operational/R1/R2 scope. R3 recovery control rows are deliberately excluded
 -- by the fixed inventory adapters. Unknown typed JSON or schema fails closed.
 -- Signed cancellation is separately replayed below: its authority is the
 -- terminal cancelled event, never its expiry, and may leave a live candidate.
 if expired and phase<>'cancelled' then
  inventory:=private.prepare_erasure_purge_manifest(request);
  if inventory->'counts' is distinct from '{}'::jsonb then
   raise exception using errcode='PT409',message='Expired recovery scope still present';end if;
  if phase in ('erasing','active_data_erased') then
   -- The ordinary helper intentionally requires an unexpired execution lease.
   -- Here full verified history + strict absence proof authorize only retaining
   -- retired IDs; no DELETE, lease extension, or operational mutation occurs.
   insert into private.retired_candidate_ids(candidate_id,company_id,generation,recovery_event_id,retain_until)
   select id,tenant,(value->>'generation')::bigint,event_hash,(value->>'retention_until')::timestamptz from unnest(subjects) s(id)
   on conflict(candidate_id) do update set retain_until=greatest(retired_candidate_ids.retain_until,excluded.retain_until)
   where retired_candidate_ids.company_id=excluded.company_id;
   if exists(select 1 from unnest(subjects) s(id) where not exists(select 1 from private.retired_candidate_ids t where t.candidate_id=s.id and t.company_id=tenant)) then
    raise exception using errcode='PT409',message='Retired identity mismatch';end if;
  end if;
  update private.erasure_executions set phase=value->>'phase',local_purged=(value->>'phase') in ('erasing','active_data_erased'),
   manifest_hash=inventory->>'manifest_hash',counts=inventory->'counts' where request_id=request;
  return jsonb_build_object('request_id',request,'phase',phase,'sequence',seq,'restore_isolated',true,'requires_purge',false,
   'local_purged',phase in ('erasing','active_data_erased'),'expired_noop',true,'scope_absent',true);
 end if;
 if phase in ('erasing','active_data_erased') then
  perform private.install_erasure_tombstones(request);
  inventory:=private.prepare_erasure_purge_manifest(request);
  update private.erasure_executions set manifest_hash=inventory->>'manifest_hash',schema_signature=inventory->>'schema_signature',counts=inventory->'counts' where request_id=request;
  perform private.restore_purge_candidate_erasure(request,seq);
  if phase='active_data_erased' then update private.erasure_executions set phase='active_data_erased' where request_id=request;end if;
 elsif phase='cancelled' then
  update private.erasure_candidate_lifecycle set status='active',generation=generation+1 where request_id=request and status='frozen';
  update private.erasure_requests set status='cancelled',generation=generation+1,cancelled_at=clock_timestamp() where id=request and status='authorized';
 end if;
 return jsonb_build_object('request_id',request,'phase',phase,'sequence',seq,'restore_isolated',true,'requires_purge',false,'local_purged',phase in ('erasing','active_data_erased'));
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then raise exception using errcode='PT422',message='Invalid recovery envelope';end;$$;

create function private.erasure_execution_status(e private.erasure_executions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('request_id',e.request_id,'company_id',e.company_id,'status',e.phase,'generation',e.generation,
 'scope_kind',e.scope_kind,'candidate_count',cardinality(e.candidate_ids),'created_at',e.created_at,'cancelled_at',e.cancelled_at,'execution_enabled',false,
 'phase',case when e.pending_phase='cancelled' then 'cancellation_pending' when e.pending_phase is not null then 'ledger_pending' else e.phase end,
 'can_cancel',e.phase='authorized' and e.reservation_id is null,'blockers',case when e.local_purged then jsonb_build_array('backup_pending') else jsonb_build_array('execution_not_provisioned') end,
 'ledger_sequence',e.sequence,'pending_phase',e.pending_phase,'local_purged',e.local_purged)
$$;
create or replace function public.get_erasure_status(target_request uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e private.erasure_executions;r private.erasure_requests;begin
 select * into e from private.erasure_executions where request_id=target_request;
 if found then perform private.erasure_owner(e.company_id);return private.erasure_execution_status(e);end if;
 select * into r from private.erasure_requests where id=target_request;perform private.erasure_owner(r.company_id);return private.erasure_status_json(r);
end;$$;
create or replace function public.get_candidate_erasure_status(target_candidate uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid;request uuid;begin
 select company_id into tenant from public.candidates where id=target_candidate;
 if tenant is null then select company_id into tenant from private.erasure_executions where target_candidate=any(candidate_ids) order by created_at desc limit 1;end if;
 perform private.erasure_owner(tenant);
 select id into request from (
  select e.request_id id,e.created_at from private.erasure_executions e where e.company_id=tenant and target_candidate=any(e.candidate_ids)
  union all select r.id,r.created_at from private.erasure_requests r where r.company_id=tenant and target_candidate=any(r.candidate_ids)
 ) all_requests order by created_at desc,id desc limit 1;
 if request is null then return null;end if;return public.get_erasure_status(request);
end;$$;
create or replace function public.list_candidate_erasure_requests(target_company uuid,before_created_at timestamptz default null,before_id uuid default null,page_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.erasure_owner(target_company);
 if page_size is null or page_size not between 1 and 100 or (before_created_at is null)<>(before_id is null) then raise exception using errcode='PT422',message='Invalid pagination';end if;
 return (select coalesce(jsonb_agg(value order by created_at desc,id desc),'[]'::jsonb) from (
  select * from (
   select e.created_at,e.request_id id,private.erasure_execution_status(e) value from private.erasure_executions e where e.company_id=target_company
   union all select r.created_at,r.id,private.erasure_status_json(r) from private.erasure_requests r where r.company_id=target_company and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)
  ) all_requests where before_created_at is null or (created_at,id)<(before_created_at,before_id) order by created_at desc,id desc limit page_size
 ) page);
end;$$;

do $$declare t text;f record;begin
 foreach t in array array['erasure_execution_config','erasure_executions','erasure_verified_ledger_events','erasure_restore_checkpoint','erasure_holds'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor,erasure_purge_owner',t);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in
 ('erasure_execution_gate','erasure_reserve_locked','reserve_erasure_transition','confirm_erasure_ledger_event','get_erasure_work','replay_erasure_envelope','erasure_execution_status') loop
 execute format('revoke all on function %s from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor,erasure_purge_owner',f.signature);
 end loop;
end;$$;
revoke all on function public.cancel_candidate_erasure(uuid,bigint,uuid) from public,anon,authenticated,screening_worker,contact_verifier;
grant execute on function public.cancel_candidate_erasure(uuid,bigint,uuid) to authenticated;
grant usage on schema private to erasure_worker,erasure_ledger_attestor,erasure_restore_attestor,erasure_purge_owner;
grant execute on function private.reserve_erasure_transition(uuid,bigint,text,uuid),private.get_erasure_work(uuid) to erasure_worker;
grant execute on function private.confirm_erasure_ledger_event(uuid,uuid,bigint,text,text,text) to erasure_ledger_attestor;
grant execute on function private.replay_erasure_envelope(text,text,bigint,text) to erasure_restore_attestor;
grant select on private.erasure_execution_config,private.erasure_executions to erasure_purge_owner;
grant update(local_purged,counts,receipt_id) on private.erasure_executions to erasure_purge_owner;
create policy erasure_purge_execution_read on private.erasure_executions for select to erasure_purge_owner using(true);
create policy erasure_purge_execution_update on private.erasure_executions for update to erasure_purge_owner using(true) with check(true);
create policy erasure_purge_config_read on private.erasure_execution_config for select to erasure_purge_owner using(true);

create function public.set_candidate_erasure_hold(target_request uuid,reason text,review_at timestamptz,expires_at timestamptz,request_key uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;e private.erasure_executions;existing private.erasure_holds;result uuid;begin
 select company_id into tenant from private.erasure_requests where id=target_request;
 if tenant is null then select company_id into tenant from private.erasure_executions where request_id=target_request;end if;
 perform private.erasure_owner(tenant);
 perform 1 from public.companies where id=tenant and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from private.erasure_requests where id=target_request for update nowait;
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if found and (e.phase<>'authorized' or e.pending_phase in ('erasing','active_data_erased','cancelled')) then raise exception using errcode='PT409',message='Irreversible transition or reconciliation pending';end if;
 if reason is null or reason not in ('legal_review','active_purpose','owner_review') or review_at is null or expires_at is null or not isfinite(review_at) or not isfinite(expires_at) or review_at<=clock_timestamp() or expires_at<review_at or request_key is null then raise exception using errcode='PT422',message='Finite hold review and expiry required';end if;
 select * into existing from private.erasure_holds h where h.company_id=tenant and h.actor_id=auth.uid() and h.request_key=set_candidate_erasure_hold.request_key;
 if found then
  if existing.request_id<>target_request or existing.reason<>reason or existing.review_at<>review_at or existing.expires_at<>expires_at then raise exception using errcode='PT409',message='Request key reused';end if;return existing.id;
 end if;
 insert into private.erasure_holds(company_id,request_id,actor_id,reason,review_at,expires_at,request_key) values(tenant,target_request,auth.uid(),reason,review_at,expires_at,request_key) returning id into result;return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Erasure hold busy';end;$$;
create function public.release_candidate_erasure_hold(target_hold uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare h private.erasure_holds;begin
 select * into h from private.erasure_holds where id=target_hold;perform private.erasure_owner(h.company_id);
 perform 1 from public.companies where id=h.company_id and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from private.erasure_requests where id=h.request_id for update nowait;
 perform 1 from private.erasure_executions where request_id=h.request_id for update nowait;
 update private.erasure_holds set released_at=coalesce(released_at,clock_timestamp()) where id=target_hold;return target_hold;
exception when lock_not_available then raise exception using errcode='PT409',message='Erasure hold busy';end;$$;
revoke all on function public.set_candidate_erasure_hold(uuid,text,timestamptz,timestamptz,uuid),public.release_candidate_erasure_hold(uuid) from public,anon,authenticated,screening_worker,contact_verifier;
grant execute on function public.set_candidate_erasure_hold(uuid,text,timestamptz,timestamptz,uuid),public.release_candidate_erasure_hold(uuid) to authenticated;

create or replace function public.request_candidate_erasure(preview_ticket_id uuid,request_key uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare t private.erasure_preview_tickets;old private.erasure_lifecycle_commands;p jsonb;payload text;result uuid;total integer;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select * into t from private.erasure_preview_tickets where id=preview_ticket_id and actor_id=auth.uid();perform private.erasure_owner(t.company_id);
 perform 1 from public.companies where id=t.company_id and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if request_key is null then raise exception using errcode='PT422',message='Request key required';end if;
 payload:=private.erasure_hash(jsonb_build_array(preview_ticket_id));
 select * into old from private.erasure_lifecycle_commands c where c.company_id=t.company_id and c.actor_id=auth.uid() and c.operation='authorize' and c.request_key=request_candidate_erasure.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 perform 1 from private.erasure_preview_tickets where id=t.id for update nowait;
 if t.expires_at<=clock_timestamp() or exists(select 1 from private.erasure_requests where erasure_requests.preview_ticket_id=t.id) then
 raise exception using errcode='PT409',message='Preview expired or consumed';end if;
 perform 1 from public.candidates where company_id=t.company_id and id=any(t.candidate_ids) order by id for update nowait;
 get diagnostics total=row_count;
 if total<>cardinality(t.candidate_ids) or exists(select 1 from private.erasure_candidate_lifecycle where candidate_id=any(t.candidate_ids) and status='frozen')
 or private.erasure_generation_snapshot(t.candidate_ids)<>t.generations then raise exception using errcode='PT409',message='Candidate changed';end if;
 p:=public.preview_candidate_erasure(t.anchor_candidate_id,t.scope_kind,t.resolution_id);
 if p->>'manifest_hash' is distinct from t.manifest_hash then raise exception using errcode='PT409',message='Preview changed';end if;
 if exists(select 1 from jsonb_array_elements_text(p->'blockers') b where b not in ('execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution')
 and not(b='subject_resolution_required' and t.scope_kind='candidate_record')) then raise exception using errcode='PT409',message='Preview has blockers';end if;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(t.company_id,auth.uid(),t.anchor_candidate_id,t.candidate_ids,t.scope_kind,t.id,t.manifest_hash,(p->>'policy_revision')::bigint,(p->>'resolution_revision')::bigint,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,t.company_id,1,'frozen',result from unnest(t.candidate_ids) s(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(t.company_id,result,auth.uid(),'authorized',1);
 insert into private.erasure_lifecycle_commands values(t.company_id,auth.uid(),'authorize',request_key,payload,result);
 return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Erasure request changed';end;$$;

create or replace function public.configure_candidate_retention_policy(target_company uuid,expected_revision bigint,policy_rules jsonb,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare r jsonb;classes text[]:='{}';payload text;old private.erasure_configuration_requests;latest bigint;result uuid;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 perform private.erasure_owner(target_company);
 perform 1 from public.companies where id=target_company and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if expected_revision is null or expected_revision<0 or request_key is null or jsonb_typeof(policy_rules) is distinct from 'array'
 or pg_column_size(policy_rules)>10000 then raise exception using errcode='PT422',message='Invalid retention policy';end if;
 if jsonb_array_length(policy_rules) not between 1 and 8 then raise exception using errcode='PT422',message='Invalid retention policy';end if;
 for r in select value from jsonb_array_elements(policy_rules) loop
 if jsonb_typeof(r) is distinct from 'object' then raise exception using errcode='PT422',message='Invalid retention policy';end if;
 if (select count(*) from jsonb_object_keys(r))<>4 or not r ?& array['data_class','trigger_event','duration_days','hold_review_days']
 or jsonb_typeof(r->'data_class') is distinct from 'string' or jsonb_typeof(r->'trigger_event') is distinct from 'string'
 or r->>'data_class' not in ('candidate','assessment','screening','communication','audit','external','backup','exports')
 or r->>'trigger_event' not in ('record_created','process_closed','consent_revoked') or r->>'data_class'=any(classes)
 or jsonb_typeof(r->'duration_days') is distinct from 'number' or jsonb_typeof(r->'hold_review_days') is distinct from 'number'
 or r->>'duration_days' !~ '^[1-9][0-9]{0,5}$' or r->>'hold_review_days' !~ '^[1-9][0-9]{0,5}$' then
 raise exception using errcode='PT422',message='Invalid retention policy';end if;
 classes:=array_append(classes,r->>'data_class');end loop;
 select jsonb_agg(value order by value->>'data_class') into policy_rules from jsonb_array_elements(policy_rules);
 payload:=private.erasure_hash(jsonb_build_array(expected_revision,policy_rules));
 select * into old from private.erasure_configuration_requests where company_id=target_company and actor_id=auth.uid() and operation='policy' and erasure_configuration_requests.request_key=configure_candidate_retention_policy.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 -- The company lock serializes configuration with the first irreversible reservation.
 if exists(select 1 from private.erasure_executions where company_id=target_company and pending_phase='erasing') then raise exception using errcode='PT409',message='Ledger reconciliation pending';end if;
 select coalesce(max(revision),0) into latest from private.candidate_retention_policies where company_id=target_company;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Policy revision changed';end if;
 insert into private.candidate_retention_policies(company_id,revision,rules,approved_by) values(target_company,latest+1,policy_rules,auth.uid()) returning id into result;
 insert into private.erasure_configuration_requests values(target_company,auth.uid(),'policy',request_key,payload,result,now());return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Configuration changed';end;$$;

create or replace function public.confirm_erasure_subject(target_candidate uuid,candidate_ids uuid[],expected_revision bigint,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;ids uuid[];latest bigint;payload text;old private.erasure_configuration_requests;result uuid;total integer;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
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
 -- Removing a frozen member from the new list must not bypass its existing subject binding.
 if exists(select 1 from unnest(coalesce((select sr.candidate_ids from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.anchor_candidate_id=target_candidate order by sr.revision desc limit 1),'{}'::uuid[])) previous(id)
 where private.erasure_candidate_frozen(previous.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 payload:=private.erasure_hash(jsonb_build_array(target_candidate,ids,expected_revision));
 select * into old from private.erasure_configuration_requests where company_id=tenant and actor_id=auth.uid() and operation='resolution' and erasure_configuration_requests.request_key=confirm_erasure_subject.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 select coalesce(max(revision),0) into latest from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Subject revision changed';end if;
 insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
 values(tenant,target_candidate,ids,latest+1,auth.uid()) returning id into result;
 insert into private.erasure_configuration_requests values(tenant,auth.uid(),'resolution',request_key,payload,result,now());return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Subject changed';end;$$;

commit;
