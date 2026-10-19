-- SC-010-R4-VOICE (#131). ISOLATED ONLY, after the accepted migration chain
-- and the seven SC-012/SC-010-C isolated modules. No production migration.
-- Extends the existing R4 authority/manifest/restore protocol, not a second engine.
begin;


-- Resolve opaque request results by operation AND tenant, never by UUID text.
create function private.erasure_voice_request_candidate(tenant uuid,operation text,result uuid)
returns uuid language sql stable security definer set search_path='' as $$
 select a.candidate_id from public.applications a where a.company_id=tenant and a.id in (
  select p.application_id from public.voice_plan_versions p where operation='generate' and p.company_id=tenant and p.id=result
  union all select r.application_id from private.voice_plan_review_entries r where operation='review' and r.company_id=tenant and r.id=result
  union all select r.application_id from private.voice_plan_release_entries r where operation='release' and r.company_id=tenant and r.id=result
 )
$$;
revoke all on function private.erasure_voice_request_candidate(uuid,text,uuid) from public;


create or replace function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];subject uuid;
begin
 if adapter='private.voice_plan_request_keys' then
  subject:=private.erasure_voice_request_candidate((data->>'company_id')::uuid,data->>'operation',(data->>'result_id')::uuid);
  if subject is null then raise exception using errcode='PT409',message='Unknown voice request dependency';end if;
  return array[subject];
 end if;
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
 if adapter in ('public.voice_plan_versions','private.voice_plan_review_entries','private.voice_plan_release_entries',
  'private.voice_plan_current_releases','private.voice_interview_permission_receipts','private.sc010c_voice_preparations') then
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
 if adapter='public.candidates'  then return array[(data->>'id')::uuid];end if;
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

create or replace function private.erasure_purge_key(adapter text,data jsonb) returns text
language sql immutable set search_path='' as $$
 select case
 when adapter='private.voice_plan_request_keys' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter='private.sc010c_voice_preparation_requests' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'request_key')
 when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
 when adapter='private.voice_interview_permission_revocations' then data->>'company_id'||':'||(data->>'receipt_id')
 when adapter in ('private.contact_requests','private.erasure_configuration_requests','private.erasure_lifecycle_commands') then data->>'actor_id'||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter in ('private.erasure_candidate_lifecycle','private.retention_candidate_clocks') then data->>'candidate_id'
 when adapter='private.erasure_denial_context' then data->>'txid'||':'||(data->>'candidate_id')
 else data->>'id' end
$$;

create or replace function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 with apps as (select id from public.applications where company_id=tenant and candidate_id=any(subjects)),
 docs as(select id from public.candidate_documents where company_id=tenant and candidate_id=any(subjects)),
 analyses as(select id from public.screening_analysis_versions where company_id=tenant and (application_id in(select id from apps) or candidate_document_id in(select id from docs))),
 reviews as(select id from public.screening_result_reviews where company_id=tenant and analysis_id in(select id from analyses)),
 criteria as(select id from public.screening_criterion_results where company_id=tenant and analysis_id in(select id from analyses)),
 communications as(select id from public.candidate_communications where company_id=tenant and candidate_id=any(subjects))
 select 'public.candidates',t.id::text,to_jsonb(t) from public.candidates t where t.company_id=tenant and (t.id=any(subjects))
 union all
 select 'public.candidate_documents',t.id::text,to_jsonb(t) from public.candidate_documents t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'public.applications',t.id::text,to_jsonb(t) from public.applications t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'public.candidate_assessments',t.id::text,to_jsonb(t) from public.candidate_assessments t where t.company_id=tenant and (t.application_id in(select id from apps))
 union all
 select 'public.behavior_assessment_entries',t.id::text,to_jsonb(t) from public.behavior_assessment_entries t where t.company_id=tenant and (t.application_id in(select id from apps))
 union all
 select 'public.exercise_observation_entries',t.id::text,to_jsonb(t) from public.exercise_observation_entries t where t.company_id=tenant and (t.application_id in(select id from apps))
 union all
 select 'public.screening_analysis_versions',t.id::text,to_jsonb(t) from public.screening_analysis_versions t where t.company_id=tenant and (t.id in(select id from analyses))
 union all
 select 'public.screening_analysis_attempts',t.id::text,to_jsonb(t) from public.screening_analysis_attempts t where t.company_id=tenant and (t.analysis_id in(select id from analyses))
 union all
 select 'public.screening_criterion_results',t.id::text,to_jsonb(t) from public.screening_criterion_results t where t.company_id=tenant and (t.analysis_id in(select id from analyses))
 union all
 select 'public.screening_result_reviews',t.id::text,to_jsonb(t) from public.screening_result_reviews t where t.company_id=tenant and (t.analysis_id in(select id from analyses))
 union all
 select 'public.screening_criterion_review_overrides',t.id::text,to_jsonb(t) from public.screening_criterion_review_overrides t where t.company_id=tenant and ((t.review_id in(select id from reviews) or t.criterion_result_id in(select id from criteria)))
 union all
 select 'public.recruitment_shortlist_entries',t.id::text,to_jsonb(t) from public.recruitment_shortlist_entries t where t.company_id=tenant and ((t.application_id in(select id from apps) or t.analysis_id in(select id from analyses) or t.review_id in(select id from reviews)))
 union all
 select 'public.candidate_contact_permissions',t.id::text,to_jsonb(t) from public.candidate_contact_permissions t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'public.candidate_contact_preferences',t.id::text,to_jsonb(t) from public.candidate_contact_preferences t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'public.candidate_communications',t.id::text,to_jsonb(t) from public.candidate_communications t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'public.candidate_communication_events',t.id::text,to_jsonb(t) from public.candidate_communication_events t where t.company_id=tenant and (t.communication_id in(select id from communications))
 union all
 select 'public.candidate_communication_approvals',t.id::text,to_jsonb(t) from public.candidate_communication_approvals t where t.company_id=tenant and (t.communication_id in(select id from communications))
 union all
 select 'private.contact_audit',t.id::text,to_jsonb(t) from private.contact_audit t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'private.contact_requests',t.actor_id::text||':'||t.operation||':'||t.request_key::text,to_jsonb(t) from private.contact_requests t where t.company_id=tenant and (private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id)=any(subjects))
 union all
 select 'private.candidate_verified_contact_receipts',t.id::text,to_jsonb(t) from private.candidate_verified_contact_receipts t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'private.candidate_verified_contact_points',t.id::text,to_jsonb(t) from private.candidate_verified_contact_points t where t.company_id=tenant and (t.candidate_id=any(subjects))
 union all
 select 'private.erasure_subject_resolutions',t.id::text,to_jsonb(t) from private.erasure_subject_resolutions t where t.company_id=tenant and (t.candidate_ids && subjects)
 union all
 select 'private.erasure_configuration_requests',t.actor_id::text||':'||t.operation||':'||t.request_key::text,to_jsonb(t) from private.erasure_configuration_requests t where t.company_id=tenant and (t.operation='resolution' and t.result_id in(select id from private.erasure_subject_resolutions where company_id=tenant and candidate_ids && subjects))
 union all select 'public.voice_plan_versions',private.erasure_purge_key('public.voice_plan_versions',to_jsonb(t)),to_jsonb(t) from public.voice_plan_versions t where t.company_id=tenant and (private.erasure_row_candidates('public.voice_plan_versions',to_jsonb(t)) && subjects)
 union all select 'private.voice_plan_review_entries',private.erasure_purge_key('private.voice_plan_review_entries',to_jsonb(t)),to_jsonb(t) from private.voice_plan_review_entries t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_plan_review_entries',to_jsonb(t)) && subjects)
 union all select 'private.voice_plan_release_entries',private.erasure_purge_key('private.voice_plan_release_entries',to_jsonb(t)),to_jsonb(t) from private.voice_plan_release_entries t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_plan_release_entries',to_jsonb(t)) && subjects)
 union all select 'private.voice_plan_current_releases',private.erasure_purge_key('private.voice_plan_current_releases',to_jsonb(t)),to_jsonb(t) from private.voice_plan_current_releases t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_plan_current_releases',to_jsonb(t)) && subjects)
 union all select 'private.voice_plan_request_keys',private.erasure_purge_key('private.voice_plan_request_keys',to_jsonb(t)),to_jsonb(t) from private.voice_plan_request_keys t where t.company_id=tenant and (private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id)=any(subjects))
 union all select 'private.voice_interview_permission_receipts',private.erasure_purge_key('private.voice_interview_permission_receipts',to_jsonb(t)),to_jsonb(t) from private.voice_interview_permission_receipts t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_interview_permission_receipts',to_jsonb(t)) && subjects)
 union all select 'private.voice_interview_permission_revocations',private.erasure_purge_key('private.voice_interview_permission_revocations',to_jsonb(t)),to_jsonb(t) from private.voice_interview_permission_revocations t where t.company_id=tenant and (private.erasure_row_candidates('private.voice_interview_permission_revocations',to_jsonb(t)) && subjects)
 union all select 'private.sc010c_voice_preparations',private.erasure_purge_key('private.sc010c_voice_preparations',to_jsonb(t)),to_jsonb(t) from private.sc010c_voice_preparations t where t.company_id=tenant and (private.erasure_row_candidates('private.sc010c_voice_preparations',to_jsonb(t)) && subjects)
 union all select 'private.sc010c_voice_preparation_requests',private.erasure_purge_key('private.sc010c_voice_preparation_requests',to_jsonb(t)),to_jsonb(t) from private.sc010c_voice_preparation_requests t where t.company_id=tenant and (private.erasure_row_candidates('private.sc010c_voice_preparation_requests',to_jsonb(t)) && subjects)
$$;

create table private.erasure_inventory_baseline_r4_voice (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r4_voice enable row level security;
revoke all on private.erasure_inventory_baseline_r4_voice from public;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r4_voice
 for each row execute function private.contact_immutable();


create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r4_voice;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
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
 select * into baseline from private.erasure_inventory_baseline_r4_voice where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  if exists(select 1 from private.voice_plan_request_keys t where t.company_id=tenant and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null) then blockers:=array_append(blockers,'voice_request_adapter_unknown');end if;
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
 select schema_signature into baseline from private.erasure_inventory_baseline_r4_voice where singleton;
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
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r4_voice where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
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
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r4_voice where singleton);
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

create or replace function private.erasure_check_purge_scope(target_request uuid) returns void
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
 if exists(select 1 from private.retention_suggestions where company_id=e.company_id and candidate_ids && e.candidate_ids and not candidate_ids <@ e.candidate_ids) then
  raise exception using errcode='PT409',message='Shared retention scope requires separate adapter';end if;
 if exists(select 1 from private.contact_requests where company_id=e.company_id and private.erasure_contact_request_candidate(company_id,operation,payload,result_id) is null) then
  raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 if exists(select 1 from private.voice_plan_request_keys t where t.company_id=e.company_id and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null) then raise exception using errcode='PT409',message='Unknown voice request dependency';end if;
 for r in select * from private.erasure_purge_rows(e.company_id,e.candidate_ids) loop
  if r.adapter not like 'private.erasure_%' then
   if r.adapter='private.retention_candidate_clocks' then refs:=array[(r.row_data->>'candidate_id')::uuid];
   elsif r.adapter='private.retention_suggestions' then select array_agg(value::uuid) into refs from jsonb_array_elements_text(r.row_data->'candidate_ids');
   else refs:=private.erasure_row_candidates(r.adapter,r.row_data);end if;
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

create or replace function private.voice_plan_protect_history()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
  raise exception using errcode='42501',message='VOICE_PLAN_HISTORY_IMMUTABLE';
end;
$$;

create or replace function private.voice_interview_permission_protect_history() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if; raise exception using errcode='42501',message='VOICE_INTERVIEW_PERMISSION_REJECTED';end;$$;

create or replace function private.sc010c_preparation_guard() returns trigger
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

create or replace function private.sc010c_request_guard() returns trigger
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

create function private.erasure_voice_row_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then
  if current_user='erasure_purge_owner' and private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
  if tg_table_name<>'voice_plan_current_releases' then
   raise exception using errcode='42501',message='Controlled voice erasure required';end if;
 end if;
 if tg_table_name='voice_plan_request_keys' and tg_op='UPDATE' then
  raise exception using errcode='42501',message='Immutable voice request';end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,
  case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
  case when tg_op<>'DELETE' then to_jsonb(new) end);
 if tg_op='DELETE' then return old;end if;
 return new;
end;$$;
revoke all on function private.erasure_voice_row_guard() from public;


create trigger erasure_voice_guard before insert or update or delete on public.voice_plan_versions
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on public.voice_plan_versions to erasure_purge_owner;
create policy erasure_purge_select on public.voice_plan_versions for select to erasure_purge_owner using (private.erasure_purge_visible('public.voice_plan_versions',to_jsonb(voice_plan_versions)));
create policy erasure_purge_delete on public.voice_plan_versions for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.voice_plan_versions',to_jsonb(voice_plan_versions)));

create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_review_entries
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.voice_plan_review_entries to erasure_purge_owner;
create policy erasure_purge_select on private.voice_plan_review_entries for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_review_entries',to_jsonb(voice_plan_review_entries)));
create policy erasure_purge_delete on private.voice_plan_review_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_review_entries',to_jsonb(voice_plan_review_entries)));

create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_release_entries
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.voice_plan_release_entries to erasure_purge_owner;
create policy erasure_purge_select on private.voice_plan_release_entries for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_release_entries',to_jsonb(voice_plan_release_entries)));
create policy erasure_purge_delete on private.voice_plan_release_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_release_entries',to_jsonb(voice_plan_release_entries)));

create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_current_releases
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.voice_plan_current_releases to erasure_purge_owner;
create policy erasure_purge_select on private.voice_plan_current_releases for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_current_releases',to_jsonb(voice_plan_current_releases)));
create policy erasure_purge_delete on private.voice_plan_current_releases for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_current_releases',to_jsonb(voice_plan_current_releases)));

create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_request_keys
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.voice_plan_request_keys to erasure_purge_owner;
create policy erasure_purge_select on private.voice_plan_request_keys for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_request_keys',to_jsonb(voice_plan_request_keys)));
create policy erasure_purge_delete on private.voice_plan_request_keys for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_request_keys',to_jsonb(voice_plan_request_keys)));

create trigger erasure_voice_guard before insert or update or delete on private.voice_interview_permission_receipts
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.voice_interview_permission_receipts to erasure_purge_owner;
create policy erasure_purge_select on private.voice_interview_permission_receipts for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_interview_permission_receipts',to_jsonb(voice_interview_permission_receipts)));
create policy erasure_purge_delete on private.voice_interview_permission_receipts for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_interview_permission_receipts',to_jsonb(voice_interview_permission_receipts)));

grant select,delete on private.voice_interview_permission_revocations to erasure_purge_owner;
create policy erasure_purge_select on private.voice_interview_permission_revocations for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_interview_permission_revocations',to_jsonb(voice_interview_permission_revocations)));
create policy erasure_purge_delete on private.voice_interview_permission_revocations for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_interview_permission_revocations',to_jsonb(voice_interview_permission_revocations)));

create trigger erasure_voice_guard before insert or update or delete on private.sc010c_voice_preparations
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.sc010c_voice_preparations to erasure_purge_owner;
create policy erasure_purge_select on private.sc010c_voice_preparations for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc010c_voice_preparations',to_jsonb(sc010c_voice_preparations)));
create policy erasure_purge_delete on private.sc010c_voice_preparations for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc010c_voice_preparations',to_jsonb(sc010c_voice_preparations)));

create trigger erasure_voice_guard before insert or update or delete on private.sc010c_voice_preparation_requests
 for each row execute function private.erasure_voice_row_guard();

grant select,delete on private.sc010c_voice_preparation_requests to erasure_purge_owner;
create policy erasure_purge_select on private.sc010c_voice_preparation_requests for select to erasure_purge_owner using (private.erasure_purge_visible('private.sc010c_voice_preparation_requests',to_jsonb(sc010c_voice_preparation_requests)));
create policy erasure_purge_delete on private.sc010c_voice_preparation_requests for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.sc010c_voice_preparation_requests',to_jsonb(sc010c_voice_preparation_requests)));

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
revoke all on function private.erasure_voice_refund_deleted() from public;
create trigger erasure_voice_refund after delete on private.sc010c_voice_preparations
 for each row execute function private.erasure_voice_refund_deleted();


create or replace function private.retention_observe_candidate() returns trigger language plpgsql security definer set search_path='' as $$
declare ids uuid[];subject uuid;tenant uuid;begin
 if tg_op='UPDATE' and to_jsonb(new)=to_jsonb(old) then return new;end if;
 if exists(select 1 from private.erasure_purge_context where txid=txid_current()) then return coalesce(new,old);end if;
 if tg_table_name='positions' then
  select array_agg(distinct a.candidate_id order by a.candidate_id) into ids from public.applications a join public.recruitments r on r.id=a.recruitment_id where r.position_id=coalesce(new.id,old.id);
 elsif tg_table_name in ('assessment_stages','exercise_definition_entries') then
  select array_agg(distinct candidate_id order by candidate_id) into ids from public.applications where recruitment_id=coalesce(new.recruitment_id,old.recruitment_id);
 elsif tg_table_name='recruitments' then
  if tg_op='UPDATE' and new.status is not distinct from old.status then return new;end if;
  select array_agg(distinct candidate_id order by candidate_id) into ids from public.applications where recruitment_id=coalesce(new.id,old.id);
 else ids:=private.erasure_row_candidates(tg_table_schema||'.'||tg_table_name,case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end);end if;
 foreach subject in array coalesce(ids,'{}'::uuid[]) loop
  select company_id into tenant from public.candidates where id=subject;
  if tenant is not null then
   insert into private.retention_candidate_clocks(candidate_id,company_id) values(subject,tenant)
   on conflict(candidate_id) do update set observed_at=clock_timestamp(),closed_at=null,consent_at=null,generation=retention_candidate_clocks.generation+1;
  end if;
 end loop;return coalesce(new,old);
end;$$;

create trigger zz_retention_observed after insert or update or delete on public.voice_plan_versions
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.voice_plan_review_entries
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.voice_plan_release_entries
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.voice_plan_current_releases
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.voice_plan_request_keys
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.voice_interview_permission_receipts
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.voice_interview_permission_revocations
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.sc010c_voice_preparations
 for each row execute function private.retention_observe_candidate();

create trigger zz_retention_observed after insert or update or delete on private.sc010c_voice_preparation_requests
 for each row execute function private.retention_observe_candidate();

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
 -- All existing authority checks and the tx-bound manifest are already installed.
 -- Lock shared quotas in a deterministic order before per-deleted-row refunds.
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
 -- RESTRICT lineage: delete each newest plan's reviews then the plan before
 -- touching the reviews of its predecessor. No FK or immutable guard is disabled.
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
revoke all on function private.erasure_voice_lock_entitlements(uuid) from public;
grant execute on function private.erasure_voice_lock_entitlements(uuid) to erasure_purge_owner;


-- Generated from a clean synthetic accepted chain; never learned from runtime data.
insert into private.erasure_inventory_baseline_r4_voice values(true,'70cdbf43562f147294c417639b76fe121154f4dc6e49799b9764232a4aedc444',array[
 'private.candidate_retention_policies',
 'private.candidate_verified_contact_points',
 'private.candidate_verified_contact_receipts',
 'private.contact_audit',
 'private.contact_policy_templates',
 'private.contact_requests',
 'private.contact_trusted_issuers',
 'private.erasure_configuration_requests',
 'private.erasure_inventory_baseline',
 'private.erasure_subject_resolutions',
 'private.sales_lead_attempts',
 'private.sales_lead_closures',
 'private.sales_lead_replay_state',
 'private.sales_lead_settings',
 'private.sales_mail_outbox',
 'private.sales_mail_settings',
 'private.sales_pipeline',
 'private.sales_pipeline_events',
 'private.screening_ranking_policies',
 'public.applications',
 'public.assessment_stages',
 'public.behavior_assessment_entries',
 'public.candidate_assessments',
 'public.candidate_communication_approvals',
 'public.candidate_communication_events',
 'public.candidate_communications',
 'public.candidate_contact_permissions',
 'public.candidate_contact_preferences',
 'public.candidate_documents',
 'public.candidates',
 'public.companies',
 'public.company_members',
 'public.company_profiles',
 'public.exercise_definition_entries',
 'public.exercise_observation_entries',
 'public.platform_operators',
 'public.positions',
 'public.recruitment_shortlist_entries',
 'public.recruitments',
 'public.sales_leads',
 'public.screening_analysis_attempts',
 'public.screening_analysis_versions',
 'public.screening_criterion_results',
 'public.screening_criterion_review_overrides',
 'public.screening_result_reviews',
 'private.erasure_inventory_baseline_r2',
 'private.erasure_inventory_baseline_r3',
 'private.erasure_inventory_baseline_r4',
 'private.erasure_preview_tickets',
 'private.erasure_requests',
 'private.erasure_candidate_lifecycle',
 'private.erasure_lifecycle_events',
 'private.erasure_lifecycle_commands',
 'private.erasure_denial_context',
 'private.erasure_execution_config',
 'private.erasure_executions',
 'private.erasure_verified_ledger_events',
 'private.erasure_restore_checkpoint',
 'private.erasure_holds',
 'private.erasure_purge_manifest',
 'private.erasure_purge_context',
 'private.erasure_purge_context_rows',
 'private.retired_candidate_ids',
 'private.erasure_receipts',
 'private.retention_delegations',
 'private.retention_schedule_commands',
 'private.retention_candidate_clocks',
 'private.retention_suggestions',
 'private.retention_authorizations',
 'private.retention_ticks',
 'public.voice_plan_versions',
 'private.voice_plan_review_entries',
 'private.voice_plan_release_entries',
 'private.voice_plan_current_releases',
 'private.voice_plan_request_keys',
 'private.voice_interview_permission_receipts',
 'private.voice_interview_permission_revocations',
 'private.sc010c_voice_preparations',
 'private.sc010c_voice_preparation_requests',
 'private.voice_plan_template_catalog',
 'private.voice_interview_permission_policies',
 'private.voice_interview_permission_issuers',
 'private.sc19_voice_entitlements',
 'private.erasure_inventory_baseline_r4_voice']);

do $$declare r record;g record;begin
 for r in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
 and p.proname in ('erasure_voice_request_candidate','erasure_voice_row_guard','erasure_voice_refund_deleted','erasure_voice_lock_entitlements') loop
  for g in select distinct x.grantee,role.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x left join pg_roles role on role.oid=x.grantee where p.oid=r.oid and x.grantee<>r.proowner loop
   if g.grantee=0 then execute format('revoke all on function %s from public',r.oid::regprocedure);
   else execute format('revoke all on function %s from %I',r.oid::regprocedure,g.rolname);end if;
  end loop;
 end loop;
 for g in select distinct x.grantee,role.rolname from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x left join pg_roles role on role.oid=x.grantee where c.oid='private.erasure_inventory_baseline_r4_voice'::regclass and x.grantee<>c.relowner loop
  if g.grantee=0 then revoke all on private.erasure_inventory_baseline_r4_voice from public;
  else execute format('revoke all on private.erasure_inventory_baseline_r4_voice from %I',g.rolname);end if;
 end loop;
end;$$;
grant execute on function private.erasure_voice_lock_entitlements(uuid) to erasure_purge_owner;
commit;
