-- SC-010-R1: owner-controlled configuration and read-only inventory, never erasure.
begin;
create table private.candidate_retention_policies (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete restrict,
 revision bigint not null check(revision>0),rules jsonb not null,approved_by uuid not null,
 approved_at timestamptz not null default now(),unique(company_id,revision)
);
create table private.erasure_subject_resolutions (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete restrict,
 anchor_candidate_id uuid not null,candidate_ids uuid[] not null,revision bigint not null check(revision>0),
 confirmed_by uuid not null,confirmed_at timestamptz not null default now(),unique(company_id,anchor_candidate_id,revision),
 foreign key(company_id,anchor_candidate_id) references public.candidates(company_id,id) on delete restrict
);
create index erasure_resolution_candidates_idx on private.erasure_subject_resolutions using gin(candidate_ids);
create table private.erasure_configuration_requests (
 company_id uuid not null references public.companies(id) on delete restrict,actor_id uuid not null,
 operation text not null check(operation in ('policy','resolution')),request_key uuid not null,
 payload_hash text not null,result_id uuid not null,created_at timestamptz not null default now(),
 primary key(company_id,actor_id,operation,request_key)
);
create table private.erasure_inventory_baseline (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);

create function private.erasure_owner(tenant uuid) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception using errcode='PT401',message='Authentication required';end if;
 if not exists(select 1 from public.companies where id=tenant and owner_id=auth.uid()) then
 raise exception using errcode='PT404',message='Resource unavailable';end if;
end;$$;
create function private.erasure_hash(value jsonb) returns text language sql immutable strict set search_path='' as $$
 select encode(sha256(convert_to(value::text,'UTF8')),'hex')
$$;

-- Includes new tables/columns and incoming FKs from ANY schema; OIDs are not portable.
create function private.erasure_schema_signature() returns text language sql stable security definer set search_path='' as $$
 with tracked as (select c.oid,n.nspname,c.relname,c.relkind,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','f')),
 objects as (
 select 'relation:'||nspname||'.'||relname key,jsonb_build_array(relkind,relrowsecurity) value from tracked
 union all select 'column:'||t.nspname||'.'||t.relname||'.'||a.attname,
 jsonb_build_array(a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid))
 from tracked t join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
 left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 union all select 'constraint:'||n.nspname||'.'||c.relname||'.'||k.conname,to_jsonb(pg_get_constraintdef(k.oid,true))
 from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
 -- PostgreSQL 18 additionally represents NOT NULL in pg_constraint; attnotnull above is the portable source.
 where k.contype<>'n' and (k.conrelid in(select oid from tracked) or k.confrelid in(select oid from tracked))
 union all select 'trigger:'||t.nspname||'.'||t.relname||'.'||g.tgname,to_jsonb(pg_get_triggerdef(g.oid,true))
 from tracked t join pg_trigger g on g.tgrelid=t.oid and not g.tgisinternal
 ) select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key),'[]'::jsonb)) from objects
$$;

create function public.configure_candidate_retention_policy(target_company uuid,expected_revision bigint,policy_rules jsonb,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare r jsonb;classes text[]:='{}';payload text;old private.erasure_configuration_requests;latest bigint;result uuid;
begin
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
 select coalesce(max(revision),0) into latest from private.candidate_retention_policies where company_id=target_company;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Policy revision changed';end if;
 insert into private.candidate_retention_policies(company_id,revision,rules,approved_by) values(target_company,latest+1,policy_rules,auth.uid()) returning id into result;
 insert into private.erasure_configuration_requests values(target_company,auth.uid(),'policy',request_key,payload,result,now());return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Configuration changed';end;$$;

create function public.get_candidate_retention_policy(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p private.candidate_retention_policies;
begin perform private.erasure_owner(target_company);
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 return jsonb_build_object('id',p.id,'revision',coalesce(p.revision,0),'rules',coalesce(p.rules,'[]'::jsonb),'configured',p.id is not null,
 'owner_current',p.approved_by is not distinct from auth.uid(),'execution_enabled',false);
end;$$;

create function public.confirm_erasure_subject(target_candidate uuid,candidate_ids uuid[],expected_revision bigint,request_key uuid)
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
 payload:=private.erasure_hash(jsonb_build_array(target_candidate,ids,expected_revision));
 select * into old from private.erasure_configuration_requests where company_id=tenant and actor_id=auth.uid() and operation='resolution' and erasure_configuration_requests.request_key=confirm_erasure_subject.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 select coalesce(max(revision),0) into latest from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Subject revision changed';end if;
 insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
 values(tenant,target_candidate,ids,latest+1,auth.uid()) returning id into result;
 insert into private.erasure_configuration_requests values(tenant,auth.uid(),'resolution',request_key,payload,result,now());return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Subject changed';end;$$;

-- Typed adapter for B1/B2 JSON edges. A NULL result means unknown/malformed, never "safe to ignore".
create function private.erasure_contact_request_candidate(tenant uuid,op text,payload jsonb,result_id uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;ref uuid;other uuid;communication public.candidate_communications;w jsonb;
begin
 if jsonb_typeof(payload) is distinct from 'array' or pg_column_size(payload)>20000 then return null;end if;
 if op='permission' then
  if jsonb_array_length(payload)<>6 or jsonb_typeof(payload->0) is distinct from 'string' or jsonb_typeof(payload->2) is distinct from 'string'
   or jsonb_typeof(payload->3) is distinct from 'string'
   or jsonb_typeof(payload->1) not in ('string','null') or jsonb_typeof(payload->4) not in ('string','null')
   or (payload->>3='unverified' and jsonb_typeof(payload->4) is distinct from 'string')
   or payload->>2 not in ('email','sms','voice') or payload->>3 not in ('unverified','revoked','blocked')
   or jsonb_typeof(payload->5) is distinct from 'number' or payload->>5 !~ '^[0-9]+$' then return null;end if;
  subject:=(payload->>0)::uuid;ref:=(payload->>1)::uuid;other:=(payload->>4)::uuid;
  if not exists(select 1 from public.candidate_contact_permissions p where p.company_id=tenant and p.id=result_id and p.candidate_id=subject and p.recruitment_id is not distinct from ref and p.channel=payload->>2) then return null;end if;
 elsif op='preferences' then
  if jsonb_array_length(payload)<>5 or jsonb_typeof(payload->0) is distinct from 'string' or jsonb_typeof(payload->1) is distinct from 'string'
   or jsonb_typeof(payload->2) is distinct from 'array' or jsonb_typeof(payload->3) is distinct from 'array' or jsonb_typeof(payload->4) is distinct from 'number' or payload->>4 !~ '^[0-9]+$' then return null;end if;
  if jsonb_array_length(payload->2)>7 or jsonb_array_length(payload->3)>3 or length(payload->>1)>100 then return null;end if;
  for w in select value from jsonb_array_elements(payload->2) loop
   if jsonb_typeof(w) is distinct from 'object' then return null;end if;
   if (select count(*) from jsonb_object_keys(w))<>3 or not w ?& array['weekday','start_minute','end_minute']
    or jsonb_typeof(w->'weekday') is distinct from 'number' or w->>'weekday' !~ '^[1-7]$'
    or jsonb_typeof(w->'start_minute') is distinct from 'number' or w->>'start_minute' !~ '^[0-9]{1,4}$'
    or jsonb_typeof(w->'end_minute') is distinct from 'number' or w->>'end_minute' !~ '^[0-9]{1,4}$' then return null;end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(payload->3) x where jsonb_typeof(value) is distinct from 'string' or value#>>'{}' not in ('email','sms','voice')) then return null;end if;
  subject:=(payload->>0)::uuid;
  if not exists(select 1 from public.candidate_contact_preferences p where p.company_id=tenant and p.id=result_id and p.candidate_id=subject) then return null;end if;
 elsif op='draft' then
  if jsonb_array_length(payload)<>3 or jsonb_typeof(payload->0) is distinct from 'string' or jsonb_typeof(payload->1) is distinct from 'string' or jsonb_typeof(payload->2) is distinct from 'string' or payload->>2 not in ('email','sms','voice') then return null;end if;
  ref:=(payload->>0)::uuid;other:=(payload->>1)::uuid;
  select * into communication from public.candidate_communications where company_id=tenant and id=result_id and application_id=ref and shortlist_entry_id=other and channel=payload->>2;
  subject:=communication.candidate_id;
 elsif op in ('cancel','approve') then
  if jsonb_array_length(payload)<>(case when op='cancel' then 2 else 3 end) or jsonb_typeof(payload->0) is distinct from 'string'
   or jsonb_typeof(payload->1) is distinct from 'number' or payload->>1 !~ '^[1-9][0-9]*$' then return null;end if;
  ref:=(payload->>0)::uuid;
  select * into communication from public.candidate_communications where company_id=tenant and id=ref;
  subject:=communication.candidate_id;
  if op='cancel' and result_id<>ref then return null;end if;
  if op='approve' then
   if jsonb_typeof(payload->2) is distinct from 'string' then return null;end if;
   other:=(payload->>2)::uuid;
   if not exists(select 1 from public.candidate_communication_approvals a where a.company_id=tenant and a.id=result_id and a.communication_id=ref and a.receipt_id=other) then return null;end if;
  end if;
 else return null;end if;
 if not exists(select 1 from public.candidates where company_id=tenant and id=subject) then return null;end if;
 return subject;
exception when invalid_text_representation or numeric_value_out_of_range then return null;end;$$;

create function public.get_erasure_subject_resolution(target_candidate uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid;r private.erasure_subject_resolutions;
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 select * into r from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate order by revision desc limit 1;
 return jsonb_build_object('id',r.id,'revision',coalesce(r.revision,0),'candidate_ids',coalesce(to_jsonb(r.candidate_ids),'[]'::jsonb),'owner_current',r.confirmed_by is not distinct from auth.uid());
end;$$;

-- Fixed adapters only; row content is used internally for the digest and never returned.
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' as $$
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
$$;

create function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_implemented','external_inventory_unverified','backup_policy_unverified'];generated timestamptz:=statement_timestamp();
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
 select * into baseline from private.erasure_inventory_baseline where singleton;
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

do $$declare t text;f record;
begin
 foreach t in array array['candidate_retention_policies','erasure_subject_resolutions','erasure_configuration_requests','erasure_inventory_baseline'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,screening_worker,contact_verifier',t);
 execute format('create trigger immutable_history before update or delete on private.%I for each row execute function private.contact_immutable()',t);
 end loop;
 for f in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='private' and p.proname in ('erasure_owner','erasure_hash','erasure_schema_signature','erasure_contact_request_candidate','erasure_inventory_rows'))
 or(n.nspname='public' and p.proname in ('configure_candidate_retention_policy','get_candidate_retention_policy','confirm_erasure_subject','get_erasure_subject_resolution','preview_candidate_erasure')) loop
 execute format('revoke all on function %s from public,anon,authenticated,screening_worker,contact_verifier',f.signature);
 if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.signature);end if;
 end loop;
end;$$;

-- Explicit reviewed baseline table names, not learned from the deployment database.
-- Fingerprint generated from the complete reviewed migration chain in an isolated clean database.
-- Never learn an unknown deployment schema as an approved baseline.
insert into private.erasure_inventory_baseline values(true,'df5ae6d34210c8544359281bb638de5565b13d3c4c68ae86a8eef7cf230e5e6f',array[
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
 'public.screening_result_reviews']);
commit;
