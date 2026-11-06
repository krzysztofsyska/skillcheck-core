-- AC domain component. Installed atomically by the R13 forward migration.
create table private.ac_paired_sheets (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,recruitment_id uuid not null,application_id uuid not null,definition_id uuid not null,
 first_assessor uuid not null references auth.users(id),second_assessor uuid not null references auth.users(id),
 first_sheet jsonb,second_sheet jsonb,
 created_at timestamptz not null default clock_timestamp(),first_submitted_at timestamptz,second_submitted_at timestamptz,
 check(first_assessor<>second_assessor),
 check((first_sheet is null)=(first_submitted_at is null)),
 check((second_sheet is null)=(second_submitted_at is null)),
 unique(application_id,definition_id),
 foreign key(company_id,recruitment_id,application_id) references public.applications(company_id,recruitment_id,id),
 foreign key(company_id,recruitment_id,definition_id) references public.exercise_definition_entries(company_id,recruitment_id,id)
);
alter table private.ac_paired_sheets enable row level security;
comment on table private.ac_paired_sheets is 'Candidate-linked assessment evidence; exact immutable exercise revision, two independent submissions. R13 manifest-checked candidate purge only.';

-- Candidate, restore configuration, application, authority and process locks are
-- held until COMMIT. Closed/withdrawn processes permit historical read only.
create function private.ac_lock_application(target uuid) returns public.applications
language plpgsql security definer set search_path='' as $$
declare a public.applications;seed public.applications;c public.candidates;r public.recruitments;p public.positions;
begin
 select * into seed from public.applications where id=target;
 if seed.id is null or not private.has_company_access(seed.company_id,true) then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 perform private.erasure_lock_candidate(seed.candidate_id);
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='Assessment frozen';end if;
 select * into a from public.applications where id=target for update nowait;
 perform private.competency_authority(a.company_id);
 -- A confirmed-subject withdrawal records durable markers even while status
 -- stays new/in_progress. Block future human AC writes on either marker; a
 -- revoked single B2 grant creates no such marker and remains independent.
 select * into c from public.candidates where id=a.candidate_id and company_id=a.company_id;
 if c.id is null or c.competency_access_cancelled_at is not null or a.competency_access_cancelled_at is not null then
  raise exception using errcode='42501',message='Assessment access withdrawn';end if;
 select * into r from public.recruitments where company_id=a.company_id and id=a.recruitment_id for share nowait;
 select * into p from public.positions where company_id=a.company_id and id=r.position_id for share nowait;
 if a.id is null or row(a.company_id,a.recruitment_id,a.candidate_id) is distinct from row(seed.company_id,seed.recruitment_id,seed.candidate_id)
  or a.status not in ('new','in_progress') or r.id is null or r.status not in ('draft','open') or p.id is null or p.status='archived' then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 return a;
exception when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;

create function public.ac_assign_pair(application uuid,revision uuid,first_id uuid,second_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare a public.applications;owner_id uuid;participant uuid;saved uuid;
begin
 a:=private.ac_lock_application(application);
 perform private.competency_authority(a.company_id,true);
 if first_id is null or second_id is null or first_id=second_id or not exists(
  select 1 from public.exercise_definition_entries d where d.id=revision and d.company_id=a.company_id
  and d.recruitment_id=a.recruitment_id and d.definition->>'kind'='assessment_center') then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 select c.owner_id into owner_id from public.companies c where c.id=a.company_id;
 foreach participant in array array[first_id,second_id] loop
  if participant<>owner_id then
   perform 1 from public.company_members m where m.company_id=a.company_id and m.user_id=participant and m.role='recruiter' for share nowait;
   if not found then raise exception using errcode='42501',message='Assessor unavailable';end if;
  end if;
 end loop;
 insert into private.ac_paired_sheets(company_id,recruitment_id,application_id,definition_id,first_assessor,second_assessor)
 values(a.company_id,a.recruitment_id,a.id,revision,first_id,second_id) returning id into saved;
 return saved;
exception when unique_violation or lock_not_available then raise exception using errcode='PT409',message='Assessment assignment changed';end;$$;

create function public.ac_submit_sheet(pair_id uuid,sheet jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare pair private.ac_paired_sheets;seed private.ac_paired_sheets;rubric jsonb;item jsonb;idx integer:=0;a public.applications;normalized jsonb:='[]';
begin
 select * into seed from private.ac_paired_sheets where id=pair_id;
 if seed.id is null or auth.uid() not in (seed.first_assessor,seed.second_assessor) or auth.uid() is null then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 a:=private.ac_lock_application(seed.application_id);
 select * into pair from private.ac_paired_sheets where id=pair_id and company_id=a.company_id for update nowait;
 if pair.id is null then raise exception using errcode='42501',message='Assessment unavailable';end if;
 if (auth.uid()=pair.first_assessor and pair.first_sheet is not null) or (auth.uid()=pair.second_assessor and pair.second_sheet is not null) then
  raise exception using errcode='PT409',message='Sheet already submitted';end if;
 select definition into strict rubric from public.exercise_definition_entries
  where id=pair.definition_id and company_id=pair.company_id and recruitment_id=pair.recruitment_id;
 if jsonb_typeof(sheet) is distinct from 'array' or jsonb_array_length(sheet)<>jsonb_array_length(rubric->'criteria') then
  raise exception using errcode='22023',message='Invalid sheet';end if;
 for item in select value from jsonb_array_elements(sheet) loop
  if jsonb_typeof(item) is distinct from 'object' or item-'criterionIndex'-'rating'-'evidence'-'context'<>'{}'::jsonb
   or item->'criterionIndex' is distinct from to_jsonb(idx)
   or coalesce(item->>'rating','') not in ('meets','above','below','insufficient_data')
   or jsonb_typeof(item->'evidence') is distinct from 'string' or length(item->>'evidence')>4000
   or jsonb_typeof(item->'context') is distinct from 'string' or length(item->>'context')>2000
   or (item->>'rating'='insufficient_data' and private.behavior_trim(item->>'evidence')<>'')
   or (item->>'rating'<>'insufficient_data' and (length(private.behavior_trim(item->>'evidence'))<10 or length(private.behavior_trim(item->>'context'))<5)) then
   raise exception using errcode='22023',message='Invalid observation';end if;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('criterionIndex',idx,'rating',item->>'rating',
   'evidence',private.behavior_trim(item->>'evidence'),'context',private.behavior_trim(item->>'context')));
  idx:=idx+1;
 end loop;
 if auth.uid()=pair.first_assessor then
  update private.ac_paired_sheets set first_sheet=normalized,first_submitted_at=clock_timestamp() where id=pair.id;
 else
  update private.ac_paired_sheets set second_sheet=normalized,second_submitted_at=clock_timestamp() where id=pair.id;
 end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;

create function public.ac_read_pair(pair_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pair private.ac_paired_sheets;
begin
 select s.* into pair from private.ac_paired_sheets s join public.applications a on a.id=s.application_id and a.company_id=s.company_id
 where s.id=pair_id and private.has_company_access(s.company_id,true)
  and private.candidate_workflow_visible(s.company_id,a.candidate_id)
  and (auth.uid() in (s.first_assessor,s.second_assessor) or private.is_company_owner(s.company_id));
 if pair.id is null then raise exception using errcode='42501',message='Assessment unavailable';end if;
 if pair.first_sheet is null or pair.second_sheet is null then
  return jsonb_build_object('state','pending','ownSubmitted',case auth.uid()
   when pair.first_assessor then pair.first_sheet is not null when pair.second_assessor then pair.second_sheet is not null end);
 end if;
 return jsonb_build_object('state','ready','definitionId',pair.definition_id,'sheets',jsonb_build_array(
  jsonb_build_object('authorId',pair.first_assessor,'submittedAt',pair.first_submitted_at,'observations',pair.first_sheet),
  jsonb_build_object('authorId',pair.second_assessor,'submittedAt',pair.second_submitted_at,'observations',pair.second_sheet)));
end;$$;
create function public.ac_find_pair(application uuid,revision uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select s.id from private.ac_paired_sheets s join public.applications a on a.id=s.application_id and a.company_id=s.company_id
 where s.application_id=application and s.definition_id=revision and private.has_company_access(s.company_id,true)
  and private.candidate_workflow_visible(s.company_id,a.candidate_id)
  and (auth.uid() in (s.first_assessor,s.second_assessor) or private.is_company_owner(s.company_id))
$$;

-- Defense in depth: no reassignment, rewrite, ordinary DELETE or identity change.
-- The purge role is allowed only the already validated manifest DELETE.
create function private.ac_sheet_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_user='erasure_purge_owner' then
  if tg_op='DELETE' and private.erasure_purge_allowed('private.ac_paired_sheets',to_jsonb(old)) then return old;end if;
  raise exception using errcode='42501',message='Purge boundary';end if;
 if tg_op='DELETE' then raise exception using errcode='42501',message='Controlled erasure required';end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='Assessment frozen';end if;
 if tg_op='UPDATE' then
  if (to_jsonb(old)-array['first_sheet','second_sheet','first_submitted_at','second_submitted_at']) is distinct from
   (to_jsonb(new)-array['first_sheet','second_sheet','first_submitted_at','second_submitted_at'])
   or (old.first_sheet is not null and row(new.first_sheet,new.first_submitted_at) is distinct from row(old.first_sheet,old.first_submitted_at))
   or (old.second_sheet is not null and row(new.second_sheet,new.second_submitted_at) is distinct from row(old.second_sheet,old.second_submitted_at))
   or (row(new.first_sheet,new.first_submitted_at) is distinct from row(old.first_sheet,old.first_submitted_at) and auth.uid() is distinct from old.first_assessor)
   or (row(new.second_sheet,new.second_submitted_at) is distinct from row(old.second_sheet,old.second_submitted_at) and auth.uid() is distinct from old.second_assessor) then
   raise exception using errcode='42501',message='Immutable assessment';end if;
 end if;
 return new;
exception when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;
create trigger ac_sheet_guard before insert or update or delete on private.ac_paired_sheets for each row execute function private.ac_sheet_guard();
create trigger zz_retention_observed after insert or update or delete on private.ac_paired_sheets for each row execute function private.retention_observe_candidate();
grant select,delete on private.ac_paired_sheets to erasure_purge_owner;
create policy erasure_purge_select on private.ac_paired_sheets for select to erasure_purge_owner
 using(private.erasure_purge_visible('private.ac_paired_sheets',to_jsonb(ac_paired_sheets)));
create policy erasure_purge_delete on private.ac_paired_sheets for delete to erasure_purge_owner
 using(private.erasure_purge_allowed('private.ac_paired_sheets',to_jsonb(ac_paired_sheets)));
