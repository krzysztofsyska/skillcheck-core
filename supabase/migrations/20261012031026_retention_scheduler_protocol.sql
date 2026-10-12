-- R4 owner delegation and conservative server-observed retention clocks.
begin;
do $$declare r record;begin
 if not exists(select 1 from pg_roles where rolname='erasure_scheduler') then create role erasure_scheduler nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;end if;
 select * into r from pg_roles where rolname='erasure_scheduler';
 if r.rolcanlogin or r.rolsuper or r.rolinherit or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or exists(select 1 from pg_auth_members where roleid=r.oid or member=r.oid) then raise exception 'Unsafe scheduler role';end if;
end;$$;
create table private.retention_delegations (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete restrict,
 owner_id uuid not null,revision bigint not null,policy_id uuid not null references private.candidate_retention_policies(id) on delete restrict,
 policy_revision bigint not null,execution_mode text not null check(execution_mode in ('suggest_only','automatic')),max_batch integer not null check(max_batch between 1 and 100),
 revoked boolean not null default false,created_at timestamptz not null default clock_timestamp(),unique(company_id,revision)
);
create table private.retention_schedule_commands (
 company_id uuid not null,actor_id uuid not null,request_key uuid not null,payload_hash text not null,result_id uuid not null references private.retention_delegations(id),primary key(company_id,actor_id,request_key)
);
create table private.retention_candidate_clocks (
 candidate_id uuid primary key,company_id uuid not null,observed_at timestamptz not null default clock_timestamp(),closed_at timestamptz,consent_at timestamptz,generation bigint not null default 1,
 foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict
);
insert into private.retention_candidate_clocks(candidate_id,company_id) select id,company_id from public.candidates;
create table private.retention_suggestions (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,candidate_ids uuid[] not null,resolution_id uuid not null,delegation_id uuid not null references private.retention_delegations(id),
 evidence_hash text not null,due_generation bigint generated always as identity check(due_generation between 1 and 9007199254740991),due_at timestamptz,
 status text not null check(status in ('suggested','authorized','blocked')),request_id uuid,blockers jsonb not null,created_at timestamptz not null default clock_timestamp(),last_evaluated_at timestamptz not null default clock_timestamp(),
 unique(company_id,delegation_id,resolution_id,evidence_hash)
);
create table private.retention_authorizations (
 request_id uuid primary key,authorization_json jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table private.retention_ticks (
 id uuid primary key default gen_random_uuid(),company_id uuid not null,delegation_id uuid not null,processed integer not null,suggested integer not null,authorized integer not null,blocked integer not null,
 created_at timestamptz not null default clock_timestamp()
);

create function public.configure_retention_schedule(target_company uuid,expected_revision bigint,policy_revision bigint,execution_mode text default 'suggest_only',max_batch integer default 25,request_key uuid default null) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare p private.candidate_retention_policies;old private.retention_schedule_commands;latest bigint;payload text;result uuid;begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 perform private.erasure_owner(target_company);perform 1 from public.companies where id=target_company and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if expected_revision is null or expected_revision<0 or policy_revision is null or policy_revision<1 or execution_mode is null or execution_mode not in ('suggest_only','automatic') or max_batch is null or max_batch not between 1 and 100 or request_key is null then raise exception using errcode='PT422',message='Invalid retention delegation';end if;
 payload:=private.erasure_hash(jsonb_build_array('configure',expected_revision,policy_revision,execution_mode,max_batch));
 select * into old from private.retention_schedule_commands c where c.company_id=target_company and c.actor_id=auth.uid() and c.request_key=configure_retention_schedule.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 if exists(select 1 from private.erasure_executions where company_id=target_company and pending_phase='erasing') then raise exception using errcode='PT409',message='Ledger reconciliation pending';end if;
 select coalesce(max(revision),0) into latest from private.retention_delegations where company_id=target_company;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Delegation revision changed';end if;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 if p.revision is distinct from policy_revision or p.approved_by is distinct from auth.uid() or jsonb_array_length(p.rules)<>8 then raise exception using errcode='PT409',message='Complete current owner policy required';end if;
 insert into private.retention_delegations(company_id,owner_id,revision,policy_id,policy_revision,execution_mode,max_batch) values(target_company,auth.uid(),latest+1,p.id,p.revision,execution_mode,max_batch) returning id into result;
 insert into private.retention_schedule_commands values(target_company,auth.uid(),request_key,payload,result);return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Retention configuration busy';end;$$;
create function public.revoke_retention_schedule(target_company uuid,expected_revision bigint,request_key uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare d private.retention_delegations;old private.retention_schedule_commands;payload text;result uuid;begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 perform private.erasure_owner(target_company);perform 1 from public.companies where id=target_company and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if request_key is null or expected_revision is null or expected_revision<1 then raise exception using errcode='PT422',message='Invalid revocation';end if;
 payload:=private.erasure_hash(jsonb_build_array('revoke',expected_revision));
 select * into old from private.retention_schedule_commands c where c.company_id=target_company and c.actor_id=auth.uid() and c.request_key=revoke_retention_schedule.request_key;
 if found then if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;return old.result_id;end if;
 if exists(select 1 from private.erasure_executions where company_id=target_company and pending_phase='erasing') then raise exception using errcode='PT409',message='Ledger reconciliation pending';end if;
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 if d.revision is distinct from expected_revision then raise exception using errcode='PT409',message='Delegation revision changed';end if;
 insert into private.retention_delegations(company_id,owner_id,revision,policy_id,policy_revision,execution_mode,max_batch,revoked) values(target_company,auth.uid(),d.revision+1,d.policy_id,d.policy_revision,d.execution_mode,d.max_batch,true) returning id into result;
 insert into private.retention_schedule_commands values(target_company,auth.uid(),request_key,payload,result);return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Retention configuration busy';end;$$;

-- Every known graph mutation conservatively advances all class clocks. This may
-- retain longer than class-specific timing, never less. User timestamps are ignored.
create function private.retention_observe_candidate() returns trigger language plpgsql security definer set search_path='' as $$
declare ids uuid[];subject uuid;tenant uuid;begin
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
do $$declare t text;begin
 foreach t in array array['public.candidates','public.candidate_documents','public.applications','public.candidate_assessments','public.behavior_assessment_entries','public.exercise_observation_entries','public.screening_analysis_versions','public.screening_analysis_attempts','public.screening_criterion_results','public.screening_result_reviews','public.screening_criterion_review_overrides','public.recruitment_shortlist_entries','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_communications','public.candidate_communication_events','public.candidate_communication_approvals','private.contact_audit','private.contact_requests','private.candidate_verified_contact_receipts','private.candidate_verified_contact_points','public.recruitments','public.positions','public.assessment_stages','public.exercise_definition_entries'] loop
 execute format('create trigger zz_retention_observed after insert or update or delete on %s for each row execute function private.retention_observe_candidate()',t);
 end loop;
end;$$;

create function private.evaluate_retention_subject(target_resolution uuid,target_delegation uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare r private.erasure_subject_resolutions;d private.retention_delegations;p private.candidate_retention_policies;blockers text[]:='{}';rule jsonb;base timestamptz;due timestamptz:='-infinity';clocks jsonb;eligible boolean;consent boolean;
begin
 select * into d from private.retention_delegations where id=target_delegation;
 select * into r from private.erasure_subject_resolutions where id=target_resolution and company_id=d.company_id;
 if r.id is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform 1 from public.companies where id=d.company_id and owner_id=d.owner_id for update nowait;
 if not found then blockers:=array_append(blockers,'owner_changed');end if;
 if d.revoked or d.revision is distinct from (select max(revision) from private.retention_delegations where company_id=d.company_id) then blockers:=array_append(blockers,'delegation_changed');end if;
 select * into p from private.candidate_retention_policies where company_id=d.company_id order by revision desc limit 1;
 if p.id is distinct from d.policy_id or p.approved_by is distinct from d.owner_id then blockers:=array_append(blockers,'policy_changed');end if;
 if r.confirmed_by<>d.owner_id or r.revision is distinct from (select max(revision) from private.erasure_subject_resolutions where company_id=d.company_id and anchor_candidate_id=r.anchor_candidate_id) then blockers:=array_append(blockers,'subject_resolution_changed');end if;
 perform 1 from public.candidates where company_id=d.company_id and id=any(r.candidate_ids) order by id for update nowait;
 if cardinality(r.candidate_ids)<>(select count(*) from public.candidates where company_id=d.company_id and id=any(r.candidate_ids)) then blockers:=array_append(blockers,'subject_resolution_changed');end if;
 perform 1 from public.recruitments where company_id=d.company_id and id in(select recruitment_id from public.applications where candidate_id=any(r.candidate_ids)) order by id for share nowait;
 eligible:=not exists(select 1 from unnest(r.candidate_ids) s(id) where not exists(select 1 from public.applications a where a.company_id=d.company_id and a.candidate_id=s.id))
 and not exists(select 1 from public.applications a join public.recruitments rec on rec.id=a.recruitment_id where a.company_id=d.company_id and a.candidate_id=any(r.candidate_ids) and (a.status not in ('rejected','withdrawn') or rec.status<>'closed'));
 if not eligible then blockers:=array_append(blockers,'active_purpose');
  update private.retention_candidate_clocks set closed_at=null,consent_at=null where candidate_id=any(r.candidate_ids) and (closed_at is not null or consent_at is not null);
 else
  update private.retention_candidate_clocks set closed_at=clock_timestamp() where candidate_id=any(r.candidate_ids) and closed_at is null;
 end if;
 -- Every recruitment/channel needs an observed current denial, optionally global.
 consent:=eligible and not exists(select 1 from public.applications a cross join unnest(array['email','sms','voice']) channel where a.company_id=d.company_id and a.candidate_id=any(r.candidate_ids)
 and not exists(select 1 from public.candidate_contact_permissions cp where cp.company_id=d.company_id and cp.candidate_id=a.candidate_id and cp.channel=channel and (cp.recruitment_id is null or cp.recruitment_id=a.recruitment_id) and cp.state in ('revoked','blocked')));
 if consent then update private.retention_candidate_clocks set consent_at=clock_timestamp() where candidate_id=any(r.candidate_ids) and consent_at is null;
 else update private.retention_candidate_clocks set consent_at=null where candidate_id=any(r.candidate_ids) and consent_at is not null;end if;
 if cardinality(r.candidate_ids)<>(select count(*) from private.retention_candidate_clocks where candidate_id=any(r.candidate_ids)) then blockers:=array_append(blockers,'canonical_event_missing');end if;
 if jsonb_array_length(p.rules)<>8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 for rule in select value from jsonb_array_elements(p.rules) loop
  select max(case rule->>'trigger_event' when 'record_created' then observed_at when 'process_closed' then greatest(closed_at,observed_at) when 'consent_revoked' then greatest(consent_at,observed_at) end) into base
  from private.retention_candidate_clocks where candidate_id=any(r.candidate_ids);
  if base is null or (rule->>'trigger_event'='process_closed' and not eligible) or (rule->>'trigger_event'='consent_revoked' and not consent) then blockers:=array_append(blockers,'canonical_event_missing');
  else due:=greatest(due,base+make_interval(days=>(rule->>'duration_days')::integer));end if;
 end loop;
 if not isfinite(due) then blockers:=array_append(blockers,'canonical_event_missing');elsif due>clock_timestamp() then blockers:=array_append(blockers,'retention_not_due');end if;
 if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=d.company_id and sr.candidate_ids && r.candidate_ids and not sr.candidate_ids <@ r.candidate_ids) then blockers:=array_append(blockers,'shared_subject');end if;
 if exists(select 1 from private.erasure_holds h join private.erasure_requests er on er.id=h.request_id where er.company_id=d.company_id and er.candidate_ids && r.candidate_ids and h.released_at is null) then blockers:=array_append(blockers,'hold_requires_review');end if;
 if exists(select 1 from public.screening_analysis_versions av join public.applications a on a.id=av.application_id where a.candidate_id=any(r.candidate_ids) and av.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
 select jsonb_agg(to_jsonb(c) order by candidate_id) into clocks from private.retention_candidate_clocks c where candidate_id=any(r.candidate_ids);
 return jsonb_build_object('candidate_ids',r.candidate_ids,'anchor_candidate_id',r.anchor_candidate_id,'resolution_revision',r.revision,'due_at',case when isfinite(due) then due else null end,'blockers',to_jsonb(blockers),
 'evidence_hash',private.erasure_hash(jsonb_build_array(to_jsonb(d),to_jsonb(r),to_jsonb(p),clocks,blockers)));
end;$$;

create function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r4 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
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
 update private.retention_suggestions set status='authorized',request_id=result where id=s.id;
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

create function private.validate_retention_authorization(target_request uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare a jsonb;s private.retention_suggestions;p jsonb;begin
 select authorization_json into a from private.retention_authorizations where request_id=target_request;
 if a is null then return;end if;
 select * into s from private.retention_suggestions where request_id=target_request;
 if s.id is null or s.due_generation is distinct from (a->>'due_generation')::bigint or s.delegation_id is distinct from (a->>'delegation_id')::uuid then raise exception using errcode='PT409',message='Retention authorization missing';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,s.delegation_id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash' is distinct from a->>'evidence_hash' then raise exception using errcode='PT409',message='Retention authorization changed';end if;
end;$$;

create function private.tick_retention_schedule(batch_limit integer default 25) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;s private.retention_suggestions;result uuid;results jsonb:='[]';processed integer:=0;suggested integer:=0;authorized integer:=0;blocked integer:=0;per_tenant integer;nt integer;na integer;nb integer;ns integer;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 if batch_limit is null or batch_limit not between 1 and 100 then raise exception using errcode='PT422',message='Invalid scheduler batch';end if;
 for d in select latest.* from private.retention_delegations latest where not latest.revoked and latest.revision=(select max(revision) from private.retention_delegations where company_id=latest.company_id)
 order by (select max(created_at) from private.retention_ticks where company_id=latest.company_id) nulls first,latest.company_id limit batch_limit loop
  per_tenant:=0;nt:=0;na:=0;nb:=0;ns:=0;
  for r in select sr.* from private.erasure_subject_resolutions sr where sr.company_id=d.company_id and sr.revision=(select max(revision) from private.erasure_subject_resolutions where company_id=sr.company_id and anchor_candidate_id=sr.anchor_candidate_id)
   and not exists(select 1 from unnest(sr.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id))
   order by (select max(last_evaluated_at) from private.retention_suggestions where resolution_id=sr.id) nulls first,sr.id loop
   exit when processed>=batch_limit or per_tenant>=d.max_batch;
   processed:=processed+1;per_tenant:=per_tenant+1;nt:=nt+1;result:=null;
   begin
    perform 1 from public.companies where id=d.company_id for update nowait;
    if exists(select 1 from unnest(r.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
    p:=private.evaluate_retention_subject(r.id,d.id);
    insert into private.retention_suggestions(company_id,candidate_ids,resolution_id,delegation_id,evidence_hash,due_at,status,blockers)
    values(d.company_id,r.candidate_ids,r.id,d.id,p->>'evidence_hash',(p->>'due_at')::timestamptz,case when p->'blockers'='[]'::jsonb then 'suggested' else 'blocked' end,p->'blockers')
    on conflict(company_id,delegation_id,resolution_id,evidence_hash) do update set last_evaluated_at=clock_timestamp();
    select * into s from private.retention_suggestions where company_id=d.company_id and delegation_id=d.id and resolution_id=r.id and evidence_hash=p->>'evidence_hash';
    if s.status in ('suggested','blocked') and p->'blockers'='[]'::jsonb and d.execution_mode='automatic' then
     begin result:=private.authorize_retention_suggestion(s.id);
     exception when sqlstate 'PT409' or lock_not_available then
      update private.retention_suggestions set status='blocked',blockers=jsonb_build_array('execution_not_provisioned_or_busy') where id=s.id;
     end;
     select * into s from private.retention_suggestions where id=s.id;
    end if;
    if s.status='authorized' then authorized:=authorized+1;na:=na+1;
    elsif s.status='suggested' then suggested:=suggested+1;ns:=ns+1;
    else blocked:=blocked+1;nb:=nb+1;end if;
    results:=results||jsonb_build_array(jsonb_build_object('suggestion_id',s.id,'request_id',s.request_id,'status',s.status,'blockers',s.blockers));
   exception when lock_not_available or sqlstate 'PT409' then
    blocked:=blocked+1;nb:=nb+1;results:=results||jsonb_build_array(jsonb_build_object('suggestion_id',null,'request_id',null,'status','blocked','blockers',jsonb_build_array('retention_scope_busy')));
   end;
  end loop;
  insert into private.retention_ticks(company_id,delegation_id,processed,suggested,authorized,blocked) values(d.company_id,d.id,nt,ns,na,nb);
  exit when processed>=batch_limit;
 end loop;
 return jsonb_build_object('processed',processed,'suggested',suggested,'authorized',authorized,'blocked',blocked,'results',results);
end;$$;

create function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),'execution_enabled',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;

do $$declare t text;f record;begin
 foreach t in array array['retention_delegations','retention_schedule_commands','retention_candidate_clocks','retention_suggestions','retention_authorizations','retention_ticks'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor,erasure_scheduler',t);
 if t in ('retention_delegations','retention_schedule_commands','retention_authorizations','retention_ticks') then execute format('create trigger immutable_history before update or delete on private.%I for each row execute function private.contact_immutable()',t);end if;
 end loop;
 for f in select p.oid::regprocedure signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in
 ('configure_retention_schedule','revoke_retention_schedule','get_retention_schedule','retention_observe_candidate','evaluate_retention_subject','authorize_retention_suggestion','validate_retention_authorization','tick_retention_schedule') and n.nspname in ('public','private') loop
 execute format('revoke all on function %s from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor,erasure_scheduler',f.signature);
 if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.signature);end if;
 end loop;
end;$$;
revoke all on sequence private.retention_suggestions_due_generation_seq from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_ledger_attestor,erasure_restore_attestor,erasure_scheduler;
grant usage on schema private to erasure_scheduler;
grant execute on function private.tick_retention_schedule(integer) to erasure_scheduler;

create or replace function private.erasure_reserve_locked(target_request uuid,target_phase text,request_key uuid) returns jsonb
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
 'authorization',coalesce((select authorization_json from private.retention_authorizations where request_id=e.request_id),jsonb_build_object('kind','owner','actor_id',e.owner_id)),'manifest_hash',e.manifest_hash,'schema_signature',e.schema_signature,
 'external_resources','[]'::jsonb,'phase',target_phase,'sequence',e.sequence+1,'previous_phase',case when e.sequence=0 then null else e.phase end,
 'previous_event_hash',e.event_hash,'retention_until',e.recovery_retain_until);
 update private.erasure_executions set reservation_id=gen_random_uuid(),pending_phase=target_phase,reservation_key=request_key,envelope=value,
 envelope_hash=private.erasure_hash(value),lease_until=clock_timestamp()+interval '5 minutes' where request_id=e.request_id returning * into e;
 return jsonb_build_object('reservation_id',e.reservation_id,'envelope_text',e.envelope::text,'envelope_hash',e.envelope_hash);
end;$$;


create or replace function private.reserve_erasure_transition(target_request uuid,expected_sequence bigint,target_phase text,request_key uuid) returns jsonb
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
  perform private.validate_retention_authorization(target_request);
  select * into p from private.candidate_retention_policies where company_id=r.company_id order by revision desc limit 1;
  if p.revision is distinct from r.policy_revision or p.approved_by is distinct from r.actor_id or jsonb_array_length(p.rules)<>8 then raise exception using errcode='PT409',message='Retention policy changed';end if;
  if r.scope_kind='confirmed_subject' then
   select * into resolution from private.erasure_subject_resolutions where company_id=r.company_id and anchor_candidate_id=r.anchor_candidate_id order by revision desc limit 1;
   if resolution.revision is distinct from r.resolution_revision or resolution.candidate_ids is distinct from r.candidate_ids or resolution.confirmed_by is distinct from r.actor_id then raise exception using errcode='PT409',message='Subject resolution changed';end if;
  end if;
  if exists(select 1 from unnest(r.candidate_ids) s(id) left join private.erasure_candidate_lifecycle l on l.candidate_id=s.id where l.status is distinct from 'frozen' or l.request_id is distinct from r.id) then raise exception using errcode='PT409',message='Lifecycle changed';end if;
  insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until,created_at,execution_started_at)
  values(r.id,r.company_id,r.candidate_ids,r.scope_kind,r.actor_id,jsonb_build_object('revision',p.revision,'rules',p.rules),r.resolution_revision,r.generation,'authorized',clock_timestamp()+make_interval(days=>greatest(c.backup_horizon_days,c.artifact_horizon_days)+c.retention_margin_days),r.created_at,clock_timestamp());
  inventory:=private.prepare_erasure_purge_manifest(target_request);
  update private.erasure_executions set manifest_hash=inventory->>'manifest_hash',schema_signature=inventory->>'schema_signature',counts=inventory->'counts' where request_id=target_request;
 end if;
 select * into e from private.erasure_executions where request_id=target_request for update nowait;
 if e.sequence<>expected_sequence then raise exception using errcode='PT409',message='Ledger sequence changed';end if;
 if target_phase='erasing' and e.phase='authorized' then
  if e.reservation_id is null then perform private.validate_retention_authorization(target_request);end if;
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
 -- Do not open an irreversible erasing reservation after the recovery horizon.
 -- The same reservation remains retryable so a durable ledger event can still be acknowledged.
 if target_phase='erasing' and e.phase='authorized' and e.reservation_id is null and e.recovery_retain_until<=clock_timestamp() then raise exception using errcode='PT409',message='Recovery horizon elapsed';end if;
 if target_phase='erasing' and e.reservation_id is null then
  inventory:=private.prepare_erasure_purge_manifest(target_request);
  if inventory->>'schema_signature' is distinct from e.schema_signature then raise exception using errcode='PT409',message='Adapter schema changed';end if;
  update private.erasure_executions set manifest_hash=inventory->>'manifest_hash',counts=inventory->'counts' where request_id=target_request;
 end if;
 -- The worker may only request forward phases. Owner cancellation has its own authenticated entry point.
 return private.erasure_reserve_locked(target_request,target_phase,request_key);
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Erasure request busy';end;$$;


create or replace function private.replay_erasure_envelope(envelope_text text,event_hash text,checkpoint_sequence bigint,checkpoint_hash text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare value jsonb;tenant uuid;request uuid;subjects uuid[];e private.erasure_executions;cp private.erasure_restore_checkpoint;inventory jsonb;seq bigint;phase text;expired boolean;
begin
 perform private.erasure_execution_gate(true);
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 if envelope_text is null or octet_length(envelope_text)>65536 or event_hash is null or event_hash !~ '^[0-9a-f]{64}$' or checkpoint_hash is null or checkpoint_hash !~ '^[0-9a-f]{64}$' or checkpoint_sequence is null or checkpoint_sequence<1 then raise exception using errcode='PT422',message='Invalid recovery envelope';end if;
 value:=envelope_text::jsonb;
 if value->'authorization'->>'kind'='retention_policy' then
  if jsonb_typeof(value->'authorization')<>'object' or (select count(*) from jsonb_object_keys(value->'authorization'))<>8
   or not (value->'authorization') ?& array['kind','actor_id','delegation_id','activation_revision','policy_revision','due_generation','due_at','evidence_hash']
   or jsonb_typeof(value->'authorization'->'actor_id') is distinct from 'string' or jsonb_typeof(value->'authorization'->'delegation_id') is distinct from 'string'
   or jsonb_typeof(value->'authorization'->'activation_revision') is distinct from 'number' or jsonb_typeof(value->'authorization'->'policy_revision') is distinct from 'number' or jsonb_typeof(value->'authorization'->'due_generation') is distinct from 'number'
   or jsonb_typeof(value->'authorization'->'due_at') is distinct from 'string' or jsonb_typeof(value->'authorization'->'evidence_hash') is distinct from 'string'
   or coalesce(value->'authorization'->>'policy_revision','') !~ '^[1-9][0-9]*$' or (value->'authorization'->>'policy_revision')::numeric>9007199254740991
   or coalesce(value->'authorization'->>'due_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|\+00:00)$'
   or coalesce(value->'authorization'->>'evidence_hash','') !~ '^[0-9a-f]{64}$'
   or coalesce(value->'authorization'->>'activation_revision','') !~ '^[1-9][0-9]*$' or coalesce(value->'authorization'->>'due_generation','') !~ '^[1-9][0-9]*$'
   or (value->'authorization'->>'activation_revision')::numeric>9007199254740991 or (value->'authorization'->>'due_generation')::numeric>9007199254740991
   or (value->'authorization'->>'policy_revision') is distinct from value->'policy'->>'revision'
   or (value->'authorization'->>'due_at') is null or (value->'authorization'->>'due_at')::timestamptz>(value->>'authorized_at')::timestamptz
   or not isfinite((value->'authorization'->>'due_at')::timestamptz)
   or (value->'authorization'->>'actor_id')::uuid is null or (value->'authorization'->>'delegation_id')::uuid is null then raise exception using errcode='PT422',message='Invalid retention provenance';end if;
 end if;
 if value->'authorization'->>'kind'='owner' and ((select count(*) from jsonb_object_keys(value->'authorization'))<>2 or not (value->'authorization') ?& array['kind','actor_id'] or jsonb_typeof(value->'authorization'->'actor_id') is distinct from 'string' or (value->'authorization'->>'actor_id')::uuid is null) then raise exception using errcode='PT422',message='Invalid owner provenance';end if;
 if exists(select 1 from private.retention_authorizations where request_id=(value->>'request_id')::uuid and authorization_json is distinct from value->'authorization') then raise exception using errcode='PT409',message='Recovery authorization changed';end if;
 if value->>'contract' is distinct from 'sc010-r3-v1' or jsonb_typeof(value->'candidate_ids') is distinct from 'array' or jsonb_typeof(value->'policy'->'rules') is distinct from 'array'
 or value->>'scope_kind' not in ('candidate_record','confirmed_subject') or value->>'phase' not in ('authorized','cancelled','erasing','active_data_erased')
 or value->>'schema_signature' is distinct from private.erasure_schema_signature() or value->'external_resources' is distinct from '[]'::jsonb
 or coalesce(value->'authorization'->>'kind','') not in ('owner','retention_policy') then raise exception using errcode='PT409',message='Recovery adapter unavailable';end if;
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
  -- A completed checkpoint is not proof that a restored graph is still absent.
  -- Recheck the reviewed adapters before preserving the original receipt/counts.
  if e.sequence=seq and e.event_hash=event_hash and e.local_purged and e.phase=phase and phase in ('erasing','active_data_erased') then
   inventory:=private.prepare_erasure_purge_manifest(request);
   if inventory->'counts'='{}'::jsonb then
    perform private.install_erasure_tombstones(request);
    update private.erasure_executions set restore_checkpoint_sequence=checkpoint_sequence,restore_checkpoint_hash=checkpoint_hash where request_id=request;
    return jsonb_build_object('request_id',request,'phase',e.phase,'sequence',seq,'restore_isolated',true,'requires_purge',false,'local_purged',true,'replay_noop',true,'scope_absent',true);
   end if;
  end if;
 end if;
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,sequence,event_hash,envelope,envelope_hash,manifest_hash,schema_signature,recovery_retain_until,created_at,restore_checkpoint_sequence,restore_checkpoint_hash)
 values(request,tenant,subjects,value->>'scope_kind',(value->'authorization'->>'actor_id')::uuid,value->'policy',(value->>'resolution_revision')::bigint,(value->>'generation')::bigint,
 case when phase='active_data_erased' then 'erasing' else phase end,seq,event_hash,value,private.erasure_hash(value),value->>'manifest_hash',value->>'schema_signature',(value->>'retention_until')::timestamptz,(value->>'authorized_at')::timestamptz,checkpoint_sequence,checkpoint_hash)
 on conflict(request_id) do update set phase=excluded.phase,sequence=excluded.sequence,event_hash=excluded.event_hash,envelope=excluded.envelope,envelope_hash=excluded.envelope_hash,
 reservation_id=null,pending_phase=null,reservation_key=null,lease_until=null,local_purged=false,recovery_retain_until=excluded.recovery_retain_until,restore_checkpoint_sequence=excluded.restore_checkpoint_sequence,restore_checkpoint_hash=excluded.restore_checkpoint_hash;
 if value->'authorization'->>'kind'='retention_policy' then
  insert into private.retention_authorizations(request_id,authorization_json) values(request,value->'authorization') on conflict(request_id) do nothing;
 end if;
 -- Age is not erasure authority. For irreversible authorizations,
 -- an expired envelope may acknowledge ONLY an already absent, fully reviewed
 -- operational/R1/R2 scope. R3 recovery control rows are deliberately excluded
 -- by the fixed inventory adapters. Unknown typed JSON or schema fails closed.
 -- Signed cancellation is separately replayed below: its authority is the
 -- terminal cancelled event, never its expiry, and may leave a live candidate.
 if expired and phase in ('erasing','active_data_erased') then
  inventory:=private.prepare_erasure_purge_manifest(request);
  if inventory->'counts' is distinct from '{}'::jsonb then
   raise exception using errcode='PT409',message='Expired recovery scope still present';end if;
  if phase in ('erasing','active_data_erased') then
   -- Full verified history + strict absence proof authorize only retaining
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

create function public.get_retention_suggestions(target_company uuid,before_created_at timestamptz default null,before_id uuid default null,page_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.erasure_owner(target_company);
 if page_size is null or page_size not between 1 and 100 or (before_created_at is null)<>(before_id is null) then raise exception using errcode='PT422',message='Invalid pagination';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'anchor_candidate_id',r.anchor_candidate_id,'status',s.status,'due_at',s.due_at,'blockers',s.blockers,'created_at',s.created_at,'request_id',s.request_id) order by s.created_at desc,s.id desc),'[]'::jsonb)
 from (select * from private.retention_suggestions where company_id=target_company and (before_created_at is null or (created_at,id)<(before_created_at,before_id)) order by created_at desc,id desc limit page_size) s
 join private.erasure_subject_resolutions r on r.id=s.resolution_id and r.company_id=target_company);
end;$$;
revoke all on function public.get_retention_suggestions(uuid,timestamptz,uuid,integer) from public,anon,authenticated,screening_worker,contact_verifier,erasure_worker,erasure_scheduler;
grant execute on function public.get_retention_suggestions(uuid,timestamptz,uuid,integer) to authenticated;

commit;
