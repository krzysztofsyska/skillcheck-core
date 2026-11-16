-- SC-PROCESS B: explicit-purpose follow-up. No automated personnel decisions.
create table private.process_followup_cases (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, recruitment_id uuid not null, application_id uuid not null,
 purpose text not null check(purpose in ('post_hire','internal_assessment','promotion')),
 start_date date not null, criteria text not null check(length(private.behavior_trim(criteria)) between 10 and 4000),
 initial_result text not null check(length(private.behavior_trim(initial_result)) between 10 and 4000),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default clock_timestamp(),
 unique(id,company_id,recruitment_id,application_id),
 foreign key(company_id,recruitment_id,application_id) references public.applications(company_id,recruitment_id,id)
);
create table private.process_followup_grants (
 id uuid primary key default gen_random_uuid(), case_id uuid not null, company_id uuid not null,recruitment_id uuid not null,application_id uuid not null,
 user_id uuid not null references auth.users(id), allowed boolean not null,
 recorded_by uuid not null references auth.users(id), recorded_at timestamptz not null default clock_timestamp(),
 sequence bigint generated always as identity,
 foreign key(case_id,company_id,recruitment_id,application_id) references private.process_followup_cases(id,company_id,recruitment_id,application_id)
);
create index process_followup_grants_latest on private.process_followup_grants(case_id,user_id,sequence desc);
create table private.process_followup_observations (
 id uuid primary key default gen_random_uuid(),case_id uuid not null,company_id uuid not null,recruitment_id uuid not null,application_id uuid not null,
 checkpoint integer not null check(checkpoint in (30,90,180)),body jsonb not null,
 recorded_by uuid not null references auth.users(id),recorded_at timestamptz not null default clock_timestamp(),
 unique(case_id,checkpoint),
 foreign key(case_id,company_id,recruitment_id,application_id) references private.process_followup_cases(id,company_id,recruitment_id,application_id)
);
create function private.process_followup_application(target uuid) returns public.applications
language plpgsql security definer set search_path='' as $$
declare a public.applications;
begin
 select * into a from public.applications where id=target;
 if a.id is null or auth.uid() is null or not private.has_company_access(a.company_id,true)
  or not exists(select 1 from public.companies c where c.id=a.company_id and c.owner_id=auth.uid())
     and not exists(select 1 from public.company_members m where m.company_id=a.company_id and m.user_id=auth.uid() and m.role='recruiter') then
  raise exception using errcode='42501',message='Follow-up unavailable';end if;
 perform private.competency_authority(a.company_id);
 perform private.erasure_lock_candidate(a.candidate_id);
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated)
  or not private.erasure_row_visible('public.applications',to_jsonb(a)) then
  raise exception using errcode='42501',message='Follow-up unavailable';end if;
 perform 1 from public.applications where id=a.id for share nowait;
 return a;
exception when lock_not_available then raise exception using errcode='PT409',message='Follow-up busy';end;$$;
create function private.process_followup_access(target uuid,owner_only boolean default false) returns private.process_followup_cases
language plpgsql security definer set search_path='' as $$
declare c private.process_followup_cases;a public.applications;is_owner boolean;
begin
 select * into c from private.process_followup_cases where id=target;
 a:=private.process_followup_application(c.application_id);
 -- Serializes grant revocation with reads/writes on this case.
 select * into c from private.process_followup_cases where id=target for update nowait;
 select exists(select 1 from public.companies where id=c.company_id and owner_id=auth.uid()) into is_owner;
 if c.id is null or (not is_owner and (owner_only or not coalesce((select g.allowed from private.process_followup_grants g
  where g.case_id=c.id and g.user_id=auth.uid() order by g.sequence desc limit 1),false))) then
  raise exception using errcode='42501',message='Follow-up unavailable';end if;
 return c;
exception when lock_not_available then raise exception using errcode='PT409',message='Follow-up busy';end;$$;
create function private.process_followup_row_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare adapter text:=tg_table_schema||'.'||tg_table_name;
begin
 if current_user='erasure_purge_owner' and tg_op='DELETE' and private.erasure_purge_allowed(adapter,to_jsonb(old)) then return old;end if;
 if tg_op<>'INSERT' then raise exception using errcode='42501',message='Immutable follow-up; controlled erasure required';end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,null,to_jsonb(new));
 return new;
end;$$;
do $guards$
declare t text;
begin
 foreach t in array array['process_followup_cases','process_followup_grants','process_followup_observations'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('create trigger followup_row_guard before insert or update or delete on private.%I for each row execute function private.process_followup_row_guard()',t);
  execute format('create trigger zz_retention_observed after insert or update or delete on private.%I for each row execute function private.retention_observe_candidate()',t);
  execute format('create policy erasure_purge_select on private.%1$I for select to erasure_purge_owner using(private.erasure_purge_visible(%2$L,to_jsonb(%1$I)))',t,'private.'||t);
  execute format('create policy erasure_purge_delete on private.%1$I for delete to erasure_purge_owner using(private.erasure_purge_allowed(%2$L,to_jsonb(%1$I)))',t,'private.'||t);
 end loop;
end $guards$;
create function public.process_followup_create(target_application uuid,purpose text,start_date date,criteria text,initial_result text) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.applications;saved uuid;
begin
 a:=private.process_followup_application(target_application);
 if not exists(select 1 from public.companies where id=a.company_id and owner_id=auth.uid()) then raise exception using errcode='42501',message='Follow-up unavailable';end if;
 if purpose is null or purpose not in ('post_hire','internal_assessment','promotion') or start_date is null or start_date>current_date
  or criteria is null or criteria ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' or initial_result ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' or length(private.behavior_trim(criteria)) not between 10 and 4000 or initial_result is null or length(private.behavior_trim(initial_result)) not between 10 and 4000 then
  raise exception using errcode='22023',message='Invalid follow-up';end if;
 insert into private.process_followup_cases(company_id,recruitment_id,application_id,purpose,start_date,criteria,initial_result,created_by)
 values(a.company_id,a.recruitment_id,a.id,purpose,start_date,private.behavior_trim(criteria),private.behavior_trim(initial_result),auth.uid()) returning id into saved;
 return saved;
end;$$;
create function public.process_followup_grant(target_case uuid,target_user uuid,allowed boolean) returns void
language plpgsql security definer set search_path='' as $$
declare c private.process_followup_cases;
begin
 c:=private.process_followup_access(target_case,true);
 perform 1 from public.company_members where company_id=c.company_id and user_id=target_user and role='recruiter' for share nowait;
 if allowed is null or (allowed and not found) or (not allowed and not exists(select 1 from private.process_followup_grants where case_id=c.id and user_id=target_user)) then raise exception using errcode='42501',message='Follow-up unavailable';end if;
 insert into private.process_followup_grants(case_id,company_id,recruitment_id,application_id,user_id,allowed,recorded_by)
 values(c.id,c.company_id,c.recruitment_id,c.application_id,target_user,allowed,auth.uid());
exception when lock_not_available then raise exception using errcode='PT409',message='Follow-up busy';end;$$;
create function public.process_followup_record(target_case uuid,checkpoint integer,observation jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare c private.process_followup_cases;saved uuid;k text;
begin
 c:=private.process_followup_access(target_case);
 if checkpoint is null or checkpoint not in (30,90,180) or current_date<c.start_date+checkpoint
  or observation is null or jsonb_typeof(observation)<>'object' or (select count(*) from jsonb_object_keys(observation))<>9
  or not (observation ?& array['tasks','onboarding','resources','support','autonomy','evidence','outcome','probation','retained']) then
  raise exception using errcode='22023',message='Invalid or premature observation';end if;
 foreach k in array array['tasks','onboarding','resources','support','autonomy','evidence'] loop
  if jsonb_typeof(observation->k)<>'string' or (observation->>k) ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' or length(private.behavior_trim(observation->>k)) not between 1 and 2000 then
   raise exception using errcode='22023',message='Observation evidence required';end if;
  observation:=jsonb_set(observation,array[k],to_jsonb(private.behavior_trim(observation->>k)));
 end loop;
 if observation->>'outcome' is null or observation->>'probation' is null or observation->>'retained' is null or observation->>'outcome' not in ('met','not_met','not_measured') or observation->>'probation' not in ('passed','failed','not_measured')
  or observation->>'retained' not in ('yes','no','not_measured') then raise exception using errcode='22023',message='Invalid observation outcome';end if;
 insert into private.process_followup_observations(case_id,company_id,recruitment_id,application_id,checkpoint,body,recorded_by)
 values(c.id,c.company_id,c.recruitment_id,c.application_id,checkpoint,observation,auth.uid()) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Observation already recorded';end;$$;
create function public.process_followup_read(target_application uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.applications;c private.process_followup_cases;is_owner boolean;result jsonb:='[]'::jsonb;
begin
 a:=private.process_followup_application(target_application);
 select exists(select 1 from public.companies where id=a.company_id and owner_id=auth.uid()) into is_owner;
 for c in select * from private.process_followup_cases where application_id=a.id order by created_at,id loop
  if is_owner or coalesce((select g.allowed from private.process_followup_grants g where g.case_id=c.id and g.user_id=auth.uid() order by g.sequence desc limit 1),false) then
   c:=private.process_followup_access(c.id);
   result:=result||jsonb_build_object('id',c.id,'purpose',c.purpose,'start_date',c.start_date,'criteria',c.criteria,'initial_result',c.initial_result,
    'created_at',c.created_at,'can_manage',is_owner,'can_record',true,
    'grants',case when is_owner then (select coalesce(jsonb_agg(jsonb_build_object('user_id',g.user_id,'allowed',g.allowed)),'[]') from
     (select distinct on(user_id) user_id,allowed from private.process_followup_grants where case_id=c.id order by user_id,sequence desc) g) else '[]'::jsonb end,
    'observations',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'checkpoint',o.checkpoint,'recorded_at',o.recorded_at,'body',o.body) order by o.checkpoint),'[]') from private.process_followup_observations o where o.case_id=c.id));
  end if;
 end loop;
 return jsonb_build_object('can_create',is_owner,'cases',result);
end;$$;

-- Recruitment metrics use only the caller's currently authorized, visible population.
-- One application contributes once: its latest authorized post-hire case. Internal
-- assessments/promotions and inaccessible or frozen cases do not enter any count.
create function public.process_followup_recruitment_metrics(target_company uuid,target_recruitment uuid,checkpoint integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.process_followup_cases;o jsonb;is_owner boolean;population integer:=0;
 probation_measured integer:=0;probation_positive integer:=0;retention_measured integer:=0;retention_positive integer:=0;
begin
 if auth.uid() is null or not private.has_company_access(target_company,true)
  or not exists(select 1 from public.recruitments where company_id=target_company and id=target_recruitment)
  or not exists(select 1 from public.companies where id=target_company and owner_id=auth.uid())
    and not exists(select 1 from public.company_members where company_id=target_company and user_id=auth.uid() and role='recruiter') then
  raise exception using errcode='42501',message='Follow-up unavailable';end if;
 perform private.competency_authority(target_company);
 if checkpoint is null or checkpoint not in (30,90,180) then raise exception using errcode='22023',message='Invalid observation checkpoint';end if;
 select exists(select 1 from public.companies where id=target_company and owner_id=auth.uid()) into is_owner;
 for c in select chosen.* from (
  select distinct on(f.application_id) f.* from private.process_followup_cases f
  join public.applications a on a.id=f.application_id and a.company_id=f.company_id and a.recruitment_id=f.recruitment_id
  where f.company_id=target_company and f.recruitment_id=target_recruitment and f.purpose='post_hire'
   and private.erasure_row_visible('public.applications',to_jsonb(a))
   and (is_owner or coalesce((select g.allowed from private.process_followup_grants g where g.case_id=f.id and g.user_id=auth.uid() order by g.sequence desc limit 1),false))
  order by f.application_id,f.created_at desc,f.id desc
 ) chosen order by chosen.application_id loop
  -- Lock/recheck authority and candidate freeze against concurrent revocation/erasure.
  c:=private.process_followup_access(c.id);
  population:=population+1;
  select body into o from private.process_followup_observations where case_id=c.id and process_followup_observations.checkpoint=process_followup_recruitment_metrics.checkpoint;
  if o->>'probation' in ('passed','failed') then probation_measured:=probation_measured+1;end if;
  if o->>'probation'='passed' then probation_positive:=probation_positive+1;end if;
  if o->>'retained' in ('yes','no') then retention_measured:=retention_measured+1;end if;
  if o->>'retained'='yes' then retention_positive:=retention_positive+1;end if;
 end loop;
 return jsonb_build_object('checkpoint',checkpoint,'scope','latest_authorized_post_hire_case_per_application','population',population,
  'probation',jsonb_build_object('positive',probation_positive,'measured',probation_measured,'missing',population-probation_measured,'rate',case when probation_measured>0 then round(100.0*probation_positive/probation_measured,2) end),
  'retention',jsonb_build_object('positive',retention_positive,'measured',retention_measured,'missing',population-retention_measured,'rate',case when retention_measured>0 then round(100.0*retention_positive/retention_measured,2) end));
end;$$;
