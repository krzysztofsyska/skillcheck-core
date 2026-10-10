-- SC-010-R2: reversible local freeze only. No purge, external ledger or erasing capability.
begin;
create table private.erasure_preview_tickets (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete restrict,
 actor_id uuid not null,anchor_candidate_id uuid not null,scope_kind text not null check(scope_kind in ('candidate_record','confirmed_subject')),
 resolution_id uuid references private.erasure_subject_resolutions(id) on delete restrict,candidate_ids uuid[] not null,
 manifest_hash text not null,generations jsonb not null,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 foreign key(company_id,anchor_candidate_id) references public.candidates(company_id,id) on delete restrict
);
create table private.erasure_requests (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete restrict,
 actor_id uuid not null,anchor_candidate_id uuid not null,candidate_ids uuid[] not null,
 scope_kind text not null check(scope_kind in ('candidate_record','confirmed_subject')),
 preview_ticket_id uuid not null unique references private.erasure_preview_tickets(id) on delete restrict,
 manifest_hash text not null,policy_revision bigint not null,resolution_revision bigint not null,
 status text not null check(status in ('authorized','cancelled')),generation bigint not null check(generation>0),
 created_at timestamptz not null default clock_timestamp(),cancelled_at timestamptz,
 foreign key(company_id,anchor_candidate_id) references public.candidates(company_id,id) on delete restrict
);
create table private.erasure_candidate_lifecycle (
 candidate_id uuid primary key,company_id uuid not null,generation bigint not null check(generation>0),
 status text not null check(status in ('active','frozen')),request_id uuid not null references private.erasure_requests(id) on delete restrict,
 foreign key(company_id,candidate_id) references public.candidates(company_id,id) on delete restrict
);
create table private.erasure_lifecycle_events (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete restrict,
 request_id uuid not null references private.erasure_requests(id) on delete restrict,actor_id uuid not null,
 event text not null check(event in ('authorized','cancelled')),generation bigint not null,created_at timestamptz not null default clock_timestamp()
);
create table private.erasure_lifecycle_commands (
 company_id uuid not null references public.companies(id) on delete restrict,actor_id uuid not null,
 operation text not null check(operation in ('authorize','cancel')),request_key uuid not null,payload_hash text not null,
 result_id uuid not null references private.erasure_requests(id) on delete restrict,
 primary key(company_id,actor_id,operation,request_key)
);
create index erasure_requests_company_page_idx on private.erasure_requests(company_id,created_at desc,id desc);
create index erasure_requests_subjects_idx on private.erasure_requests using gin(candidate_ids);

create function private.erasure_generation_snapshot(subjects uuid[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(s.id::text,coalesce(l.generation,0)),'{}'::jsonb)
 from unnest(subjects) s(id) left join private.erasure_candidate_lifecycle l on l.candidate_id=s.id
$$;

create function public.issue_candidate_erasure_preview(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;subjects uuid[];p jsonb;ticket uuid;issued timestamptz;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 perform 1 from public.companies where id=tenant and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 p:=public.preview_candidate_erasure(target_candidate,scope_kind,resolution_id);
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then select candidate_ids into subjects from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant;end if;
 perform 1 from public.candidates where company_id=tenant and id=any(subjects) order by id for update nowait;
 if exists(select 1 from private.erasure_candidate_lifecycle where candidate_id=any(subjects) and status='frozen') then
 raise exception using errcode='PT409',message='Candidate frozen';end if;
 -- Fresh content after locking. Administrative tickets are deliberately outside the operational digest.
 p:=public.preview_candidate_erasure(target_candidate,scope_kind,resolution_id);issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(tenant,auth.uid(),target_candidate,scope_kind,resolution_id,subjects,p->>'manifest_hash',private.erasure_generation_snapshot(subjects),issued,issued+interval '5 minutes') returning id into ticket;
 return p||jsonb_build_object('preview_ticket_id',ticket,'generated_at',issued,'expires_at',issued+interval '5 minutes');
exception when lock_not_available then raise exception using errcode='PT409',message='Candidate changed';end;$$;

create function public.request_candidate_erasure(preview_ticket_id uuid,request_key uuid) returns uuid
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
 if exists(select 1 from jsonb_array_elements_text(p->'blockers') b where b not in ('execution_not_implemented','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution')
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

create function public.cancel_candidate_erasure(target_request uuid,expected_generation bigint,request_key uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare r private.erasure_requests;old private.erasure_lifecycle_commands;payload text;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception using errcode='PT409',message='Fresh transaction required';end if;
 select * into r from private.erasure_requests where id=target_request;perform private.erasure_owner(r.company_id);
 perform 1 from public.companies where id=r.company_id and owner_id=auth.uid() for update nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if request_key is null or expected_generation is null or expected_generation<1 then raise exception using errcode='PT422',message='Invalid cancellation';end if;
 payload:=private.erasure_hash(jsonb_build_array(target_request,expected_generation));
 select * into old from private.erasure_lifecycle_commands c where c.company_id=r.company_id and c.actor_id=auth.uid() and c.operation='cancel' and c.request_key=cancel_candidate_erasure.request_key;
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

create function private.erasure_status_json(r private.erasure_requests) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('request_id',r.id,'company_id',r.company_id,'status',r.status,'generation',r.generation,'scope_kind',r.scope_kind,
 'candidate_count',cardinality(r.candidate_ids),'created_at',r.created_at,'cancelled_at',r.cancelled_at,'execution_enabled',false,
 'phase',case when r.status='authorized' then 'local_frozen' else 'cancelled' end,'can_cancel',r.status='authorized',
 'blockers',jsonb_build_array('execution_not_implemented','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'))
$$;
create function public.get_erasure_status(target_request uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r private.erasure_requests;begin
 select * into r from private.erasure_requests where id=target_request;perform private.erasure_owner(r.company_id);return private.erasure_status_json(r);
end;$$;
create function public.get_candidate_erasure_status(target_candidate uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid;r private.erasure_requests;begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 select * into r from private.erasure_requests where company_id=tenant and target_candidate=any(candidate_ids) order by created_at desc,id desc limit 1;
 if r.id is null then return null;end if;return private.erasure_status_json(r);
end;$$;
create function public.list_candidate_erasure_requests(target_company uuid,before_created_at timestamptz default null,before_id uuid default null,page_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.erasure_owner(target_company);
 if page_size is null or page_size not between 1 and 100 or (before_created_at is null)<>(before_id is null) then raise exception using errcode='PT422',message='Invalid pagination';end if;
 return (select coalesce(jsonb_agg(private.erasure_status_json(r) order by r.created_at desc,r.id desc),'[]'::jsonb)
 from(select * from private.erasure_requests where company_id=target_company and (before_created_at is null or (created_at,id)<(before_created_at,before_id)) order by created_at desc,id desc limit page_size) r);
end;$$;

do $$declare t text;f record;begin
 foreach t in array array['erasure_preview_tickets','erasure_requests','erasure_candidate_lifecycle','erasure_lifecycle_events','erasure_lifecycle_commands'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,screening_worker,contact_verifier',t);
 if t not in ('erasure_requests','erasure_candidate_lifecycle') then execute format('create trigger immutable_history before update or delete on private.%I for each row execute function private.contact_immutable()',t);end if;
 end loop;
 for f in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='private' and p.proname in ('erasure_generation_snapshot','erasure_status_json')) or(n.nspname='public' and p.proname in
 ('issue_candidate_erasure_preview','request_candidate_erasure','cancel_candidate_erasure','get_erasure_status','get_candidate_erasure_status','list_candidate_erasure_requests')) loop
 execute format('revoke all on function %s from public,anon,authenticated,screening_worker,contact_verifier',f.signature);
 if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.signature);end if;
 end loop;
end;$$;
commit;
