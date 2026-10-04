begin;

create table public.exercise_observation_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  definition_entry_id uuid not null,
  version integer not null check (version > 0),
  work_sample text not null check (length(work_sample) <= 20000),
  observations jsonb not null check (jsonb_typeof(observations) = 'array'),
  author_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(application_id, definition_entry_id, version),
  foreign key(company_id,recruitment_id,application_id) references public.applications(company_id,recruitment_id,id) on delete cascade,
  foreign key(company_id,recruitment_id,definition_entry_id) references public.exercise_definition_entries(company_id,recruitment_id,id) on delete cascade
);
create index exercise_observations_tenant_idx on public.exercise_observation_entries(company_id,application_id,definition_entry_id,version desc);
alter table public.exercise_observation_entries enable row level security;
revoke all on public.exercise_observation_entries from public,anon,authenticated;
grant select on public.exercise_observation_entries to authenticated;
create policy exercise_observations_read on public.exercise_observation_entries for select to authenticated
  using(private.has_company_access(company_id));
create view public.latest_exercise_observations with(security_invoker = true) as
  select distinct on (application_id,definition_entry_id) * from public.exercise_observation_entries
  order by application_id,definition_entry_id,version desc;
revoke all on public.latest_exercise_observations from public,anon,authenticated;
grant select on public.latest_exercise_observations to authenticated;

-- The definition revision is explicit and immutable. New definitions must not
-- silently change the rubric against which an existing work sample was observed.
create function public.save_exercise_observations(target_application uuid, target_definition uuid,
  expected_version integer, new_work_sample text, new_observations jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); app public.applications%rowtype;
  recruitment public.recruitments%rowtype; position public.positions%rowtype;
  rubric public.exercise_definition_entries%rowtype;
  item jsonb; canonical jsonb := '[]'; ordinal integer := 0;
  last_version integer; entry_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if expected_version is null or expected_version < 0 or new_work_sample is null
    or length(new_work_sample) > 20000 or jsonb_typeof(new_observations) is distinct from 'array' then
    raise exception 'Invalid observations' using errcode='22023';
  end if;
  select * into app from public.applications a where a.id=target_application
    and private.has_company_access(a.company_id,true) for share;
  if not found then raise exception 'No write access' using errcode='42501'; end if;
  select * into recruitment from public.recruitments r where r.id=app.recruitment_id and r.company_id=app.company_id for share;
  if not found then raise exception 'No recruitment' using errcode='42501'; end if;
  select * into position from public.positions p where p.id=recruitment.position_id and p.company_id=app.company_id for share;
  if not found then raise exception 'No position' using errcode='42501'; end if;
  if app.status not in ('new','in_progress') or recruitment.status not in ('draft','open') or position.status='archived' then
    raise exception 'Assessment closed' using errcode='55000';
  end if;
  select * into rubric from public.exercise_definition_entries e where e.id=target_definition
    and e.company_id=app.company_id and e.recruitment_id=app.recruitment_id for share;
  if not found then raise exception 'No definition access' using errcode='42501'; end if;
  if jsonb_array_length(new_observations) <> jsonb_array_length(rubric.definition->'criteria') then
    raise exception 'Criterion count mismatch' using errcode='22023';
  end if;
  for item in select * from jsonb_array_elements(new_observations) loop
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'criterionIndex') is distinct from 'number'
      or item->'criterionIndex' is distinct from to_jsonb(ordinal)
      or (item->>'rating') is null or item->>'rating' not in ('insufficient_data','below','meets','above')
      or jsonb_typeof(item->'evidence') is distinct from 'string' then
      raise exception 'Invalid criterion observation' using errcode='22023';
    end if;
    if length(item->>'evidence') > 10000 or (item->>'rating' <> 'insufficient_data' and length(private.behavior_trim(item->>'evidence'))=0) then
      raise exception 'Evidence required' using errcode='22023';
    end if;
    canonical := canonical || jsonb_build_array(jsonb_build_object('criterionIndex',ordinal,
      'rating',item->>'rating','evidence',private.behavior_trim(item->>'evidence')));
    ordinal := ordinal+1;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('exercise-observation:'||app.id::text||':'||rubric.id::text,0));
  select coalesce(max(version),0) into last_version from public.exercise_observation_entries
    where application_id=app.id and definition_entry_id=rubric.id;
  if last_version<>expected_version then raise exception 'Observation changed' using errcode='PT409'; end if;
  insert into public.exercise_observation_entries(company_id,recruitment_id,application_id,definition_entry_id,
    version,work_sample,observations,author_id)
    values(app.company_id,app.recruitment_id,app.id,rubric.id,last_version+1,private.behavior_trim(new_work_sample),canonical,actor)
    returning id into entry_id;
  return entry_id;
end;
$$;
revoke all on function public.save_exercise_observations(uuid,uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_exercise_observations(uuid,uuid,integer,text,jsonb) to authenticated;
commit;
