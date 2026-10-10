-- SC-010-R2: reviewed new baseline; R1 migration/history remains immutable.
-- Administrative IDs/hashes are pseudonymous data. R3 must inventory/purge these
-- explicitly. They are excluded from the operational digest to avoid self-invalidating
-- preview tickets; generation snapshots separately bind every lifecycle transition.
begin;
create table private.erasure_inventory_baseline_r2 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r2 enable row level security;
revoke all on private.erasure_inventory_baseline_r2 from public,anon,authenticated,screening_worker,contact_verifier;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r2 for each row execute function private.contact_immutable();
create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r2;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_implemented','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
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
 select * into baseline from private.erasure_inventory_baseline_r2 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
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
-- Literal generated from the complete clean, reviewed migration chain, never a deployment catalog.
insert into private.erasure_inventory_baseline_r2 values(true,'e6a4e0ba802c89a8d1a43b75c44c0660b4e219578781c2a8861ab2426bff02ca',array[
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
 'private.erasure_preview_tickets',
 'private.erasure_requests',
 'private.erasure_candidate_lifecycle',
 'private.erasure_lifecycle_events',
 'private.erasure_lifecycle_commands',
 'private.erasure_denial_context']);
commit;
