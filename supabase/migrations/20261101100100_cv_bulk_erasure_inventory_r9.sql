-- SC-BULK-001 / SC-010 R9: reviewed erasure inventory revision for the bulk
-- CV intake tables (20261101100000_cv_bulk_intake.sql).
--
-- Order is mandatory: R8 (20261030160100) -> bulk intake (20261101100000) ->
-- this migration. Without R9 the bulk intake tables make every erasure
-- preview/purge fail closed with schema_dependency_unknown / PT409.
--
-- Inventory classification:
--   private.cv_bulk_items: personal data (file name, link to the candidate,
--     token usage); candidate-linked through candidate_id / application_id, or
--     through duplicate_of_application for a duplicate file that never became
--     a candidate. Erased by the FK cascades from public.candidates /
--     public.applications, listed by the private.cv_bulk_items adapter.
--   private.application_preselection_groups: classification (proposal group,
--     score); erased by FK cascade from public.applications.
--   private.application_preselection_group_events: audit and free text (note);
--     erased by FK cascade from public.applications, append-only otherwise:
--     the R8 cascade guard refuses any delete outside a manifest-checked purge.
--   private.cv_bulk_batches / private.cv_bulk_settings: no candidate data
--     (counts, operator id, worker configuration); known tables, no adapter.
--
-- Adapters are layered exactly like R8: the reviewed R8 wrappers are renamed to
-- *_r8 after a source-hash check and wrapped again. Signatures and source
-- hashes are reviewed literals, never learned from the target database.
begin;

do $r9_preflight$
declare
  r8_signature text; r8_tables text[]; source text; expected text;
  bulk_tables text[]:=array['private.application_preselection_group_events','private.application_preselection_groups','private.cv_bulk_batches','private.cv_bulk_items','private.cv_bulk_settings'];
  actual_tables text[];
begin
  if to_regclass('private.erasure_inventory_baseline_r8') is null then
    raise exception 'sc_r9_requires_r8_inventory' using errcode='55000';
  end if;
  if to_regclass('private.erasure_inventory_baseline_r9') is not null then
    raise exception 'sc_r9_already_installed' using errcode='55000';
  end if;
  if to_regclass('private.cv_bulk_items') is null or to_regclass('private.application_preselection_groups') is null
    or to_regclass('private.application_preselection_group_events') is null then
    raise exception 'sc_r9_requires_bulk_intake' using errcode='55000';
  end if;
  execute 'select schema_signature,known_tables from private.erasure_inventory_baseline_r8 where singleton'
    into r8_signature,r8_tables;
  case r8_signature
    when 'd87bccd9dcf7834aeed6bd361cb117b1b11f221f2bc0280d852843d29996bdaf' then
      source:='69c8c7887c71ab22c8f144dc6186e966f8dd67e975bafc6ef6986e69aef55b0a';
      expected:='8ce45788dc158abbc7926f9b2bef4b7be37115ed0682cfb3e7fa8a849ef9b402';
    when 'f057e8bce49280b3ec6dfff5259bb9b27174829ba068b1f429b003b8cb61cda9' then
      source:='c8aafd04c12c9306f5fa5d03b9f96494003c690cf53ea2d9e4a0d3433c639343';
      expected:='c1eb5b5962625d2e01b1c523e6d473efd5332510ed9769c85563f9ca002d57ea';
    else raise exception 'sc_r9_r8_baseline_unreviewed' using errcode='55000';
  end case;
  if private.erasure_schema_signature() is distinct from source then
    raise exception 'sc_r9_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';
  end if;
  if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='private.erasure_inventory_rows(uuid,uuid[])'::regprocedure)
      is distinct from 'c2891f2bb5a211a7c049402f2fecde3aa373e3f4e9be2fbd0ed2600e7aa0d706'
    or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='private.erasure_row_candidates(text,jsonb)'::regprocedure)
      is distinct from '1014144636e800b8c26788fefef101fc43d8d1794ef410255dd25d6a1cf7bcb5' then
    raise exception 'sc_r9_adapter_source_unreviewed' using errcode='55000';
  end if;
  if to_regprocedure('private.erasure_inventory_rows_r8(uuid,uuid[])') is not null
    or to_regprocedure('private.erasure_row_candidates_r8(text,jsonb)') is not null then
    raise exception 'sc_r9_adapter_name_taken' using errcode='55000';
  end if;
  select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual_tables
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','f');
  if actual_tables is distinct from (select array_agg(x order by x collate "C") from unnest(r8_tables||bulk_tables) x) then
    raise exception 'sc_r9_inventory_gap' using errcode='55000';
  end if;

  create table private.erasure_inventory_baseline_r9 (
    singleton boolean primary key default true check(singleton),
    schema_signature text not null,known_tables text[] not null
  );
  alter table private.erasure_inventory_baseline_r9 enable row level security;
  create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r9
    for each row execute function private.contact_immutable();
  insert into private.erasure_inventory_baseline_r9 values (true,expected,
    r8_tables||bulk_tables||array['private.erasure_inventory_baseline_r9']);
end $r9_preflight$;

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r8;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r8;

create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 with apps as (select id from public.applications where company_id=tenant and candidate_id=any(subjects))
 select * from private.erasure_inventory_rows_r8(tenant,subjects)
 union all
 select 'private.cv_bulk_items',t.id::text,to_jsonb(t) from private.cv_bulk_items t where t.company_id=tenant
  and (t.candidate_id=any(subjects) or t.application_id in(select id from apps) or t.duplicate_of_application in(select id from apps))
 union all
 select 'private.application_preselection_groups',t.id::text,to_jsonb(t) from private.application_preselection_groups t where t.company_id=tenant and (t.application_id in(select id from apps))
 union all
 select 'private.application_preselection_group_events',t.id::text,to_jsonb(t) from private.application_preselection_group_events t where t.company_id=tenant and (t.application_id in(select id from apps))
$$;

create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];
begin
 if adapter='private.cv_bulk_items' then
  select array_agg(distinct s.id order by s.id) into ids from (
   select c.id from public.candidates c where c.id=(data->>'candidate_id')::uuid and c.company_id=(data->>'company_id')::uuid
   union select a.candidate_id from public.applications a where a.company_id=(data->>'company_id')::uuid
    and a.id in ((data->>'application_id')::uuid,(data->>'duplicate_of_application')::uuid)) s;
  if coalesce(cardinality(ids),0)=0 then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
  return ids;
 end if;
 if adapter in ('private.application_preselection_groups','private.application_preselection_group_events') then
  select array_agg(distinct a.candidate_id order by a.candidate_id) into ids from public.applications a
   where a.id=(data->>'application_id')::uuid and a.company_id=(data->>'company_id')::uuid;
  if coalesce(cardinality(ids),0)=0 then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
  return ids;
 end if;
 return private.erasure_row_candidates_r8(adapter,data);
end;$$;

revoke all on function private.erasure_inventory_rows(uuid,uuid[]),private.erasure_row_candidates(text,jsonb) from public,anon,authenticated;

-- Append-only group history: deletable only inside a manifest-checked purge.
create trigger aa_erasure_cascade_guard before delete on private.application_preselection_group_events
 for each row execute function private.erasure_step4_cascade_guard();

comment on table private.cv_bulk_items is
  'SC-010 R9: candidate-linked personal data (file name); erased by FK cascade from public.candidates/public.applications, listed by the private.cv_bulk_items adapter.';
comment on table private.application_preselection_groups is
  'SC-010 R9: candidate-linked classification; erased by FK cascade from public.applications, listed by the private.application_preselection_groups adapter.';
comment on table private.application_preselection_group_events is
  'SC-010 R9: candidate-linked audit and free text (note); erased by FK cascade from public.applications, listed by the private.application_preselection_group_events adapter.';

-- Exact reviewed R8 source bodies, retargeted from R8 to R9 at source level
-- (only the baseline table name differs). CREATE OR REPLACE keeps existing ACLs.
create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r9;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
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
 select * into baseline from private.erasure_inventory_baseline_r9 where singleton;
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
 select schema_signature into baseline from private.erasure_inventory_baseline_r9 where singleton;
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
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r9 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
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
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r9 where singleton);
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


do $r9_postflight$
declare expected text; known text[]; actual_tables text[]; adapter_table text;
begin
  select schema_signature,known_tables into expected,known from private.erasure_inventory_baseline_r9 where singleton;
  if private.erasure_schema_signature() is distinct from expected then
    raise exception 'sc_r9_final_schema_signature_mismatch:%',private.erasure_schema_signature() using errcode='55000';
  end if;
  select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual_tables
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','f');
  if actual_tables is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
    raise exception 'sc_r9_final_inventory_gap' using errcode='55000';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r[45678]([^0-9]|$)') then
    raise exception 'sc_r9_stale_inventory_reference' using errcode='55000';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prosrc like '%erasure_inventory_baseline_r9%'
      and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule')) <> 4 then
    raise exception 'sc_r9_inventory_reference_missing' using errcode='55000';
  end if;
  if exists(select 1 from (values
      ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r8(uuid,uuid[])'::regprocedure),
      ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r8(text,jsonb)'::regprocedure)) v(wrapper,base)
    join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
    where w.proowner<>b.proowner or not w.prosecdef or not b.prosecdef or w.proacl::text is distinct from b.proacl::text) then
    raise exception 'sc_r9_wrapper_acl_mismatch' using errcode='55000';
  end if;
  -- Erasure of bulk rows relies on these exact cascades.
  foreach adapter_table in array array['private.cv_bulk_items','private.application_preselection_groups','private.application_preselection_group_events'] loop
    if not exists(select 1 from pg_constraint where conrelid=adapter_table::regclass and contype='f'
        and confrelid='public.applications'::regclass and confdeltype='c') then
      raise exception 'sc_r9_cascade_contract_changed:%',adapter_table using errcode='55000';
    end if;
  end loop;
  if (select count(*) from pg_constraint where conrelid='private.cv_bulk_items'::regclass and contype='f'
      and confrelid in ('public.applications'::regclass,'public.candidates'::regclass) and confdeltype='c') <> 3
    or not exists(select 1 from pg_trigger where tgrelid='private.application_preselection_group_events'::regclass
      and tgname='aa_erasure_cascade_guard' and tgfoid='private.erasure_step4_cascade_guard()'::regprocedure and tgenabled='O') then
    raise exception 'sc_r9_cascade_contract_changed' using errcode='55000';
  end if;
end $r9_postflight$;
commit;
