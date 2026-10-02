begin;

-- Same whitespace set as JavaScript String.trim; duplicates must not be hidden
-- from the database validator by tabs or non-breaking spaces in legacy profiles.
create function private.behavior_trim(value text) returns text
language sql immutable strict set search_path = '' as $$
  select btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
revoke all on function private.behavior_trim(text) from public, anon, authenticated;

-- Human observations only. Each save appends a revision; existing entries cannot
-- be edited through the API. Deleting the parent application removes its history.
create table public.behavior_assessment_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  area_key text not null check (area_key in ('responsibility','independence','initiative','results','cooperation','change','feedback','pressure')),
  version integer not null check (version > 0),
  rating text not null check (rating in ('insufficient_data','below','meets','above')),
  evidence text not null check (length(evidence) <= 10000 and (rating = 'insufficient_data' or length(private.behavior_trim(evidence)) > 0)),
  required_level text not null check (required_level in ('Niski','Standardowy','Wysoki','Krytyczny')),
  position_id uuid not null,
  position_updated_at timestamptz not null,
  position_snapshot jsonb not null check (jsonb_typeof(position_snapshot) = 'object'),
  author_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (application_id, area_key, version),
  foreign key (company_id, recruitment_id, application_id) references public.applications(company_id, recruitment_id, id) on delete cascade,
  foreign key (company_id, position_id) references public.positions(company_id, id)
);
create index behavior_entries_tenant_application_idx on public.behavior_assessment_entries(company_id, application_id, area_key, version desc);
alter table public.behavior_assessment_entries enable row level security;
revoke all on public.behavior_assessment_entries from public, anon, authenticated;
grant select on public.behavior_assessment_entries to authenticated;
create policy behavior_entries_read on public.behavior_assessment_entries for select to authenticated
  using (private.has_company_access(company_id));

-- RLS is evaluated as the caller, including when reading through the view.
create view public.latest_behavior_assessments with (security_invoker = true) as
select distinct on (company_id, application_id, area_key) *
from public.behavior_assessment_entries
order by company_id, application_id, area_key, version desc;
revoke all on public.latest_behavior_assessments from public, anon, authenticated;
grant select on public.latest_behavior_assessments to authenticated;

create function public.save_behavior_assessment(
  target_application uuid, target_area text, new_rating text, new_evidence text,
  expected_version integer, expected_position_updated_at timestamptz, expected_position_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  app public.applications%rowtype;
  recruitment public.recruitments%rowtype;
  position public.positions%rowtype;
  area_label text;
  matching_requirements text[];
  requirement text;
  last_version integer;
  entry_id uuid;
  actor uuid := (select auth.uid());
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_area is null or new_rating is null or new_evidence is null
    or expected_version is null or expected_version < 0 or expected_position_updated_at is null or expected_position_id is null
    or new_rating not in ('insufficient_data','below','meets','above')
    or length(new_evidence) > 10000 or (new_rating <> 'insufficient_data' and length(private.behavior_trim(new_evidence)) = 0) then
    raise exception 'Invalid assessment' using errcode = '22023';
  end if;
  area_label := case target_area
    when 'responsibility' then 'Odpowiedzialność' when 'independence' then 'Samodzielność'
    when 'initiative' then 'Inicjatywa' when 'results' then 'Orientacja na wynik'
    when 'cooperation' then 'Współpraca z ludźmi' when 'change' then 'Reakcja na zmianę'
    when 'feedback' then 'Otwartość na informację zwrotną'
    when 'pressure' then 'Działanie pod presją i w trudnych sytuacjach' end;
  if area_label is null then raise exception 'Invalid area' using errcode = '22023'; end if;

  -- Parent locks keep statuses and the requirement snapshot stable until commit.
  select * into app from public.applications a where a.id = target_application
    and private.has_company_access(a.company_id, true) for share;
  if not found then raise exception 'No write access' using errcode = '42501'; end if;
  select * into recruitment from public.recruitments r where r.id = app.recruitment_id and r.company_id = app.company_id for share;
  if not found then raise exception 'Missing recruitment' using errcode = '42501'; end if;
  select * into position from public.positions p where p.id = recruitment.position_id and p.company_id = app.company_id for share;
  if not found then raise exception 'Missing position' using errcode = '42501'; end if;
  if app.status not in ('new','in_progress') or recruitment.status not in ('draft','open') or position.status = 'archived' then
    raise exception 'Assessment is closed' using errcode = '55000';
  end if;
  if position.id is distinct from expected_position_id or position.updated_at is distinct from expected_position_updated_at then
    raise exception 'Position changed' using errcode = '40001';
  end if;
  select array_agg(value) into matching_requirements from unnest(position.required_behaviors) as value
    where private.behavior_trim(split_part(value, ':', 1)) = area_label;
  if coalesce(cardinality(matching_requirements), 0) <> 1 then
    raise exception 'Missing or duplicated requirement' using errcode = '22023';
  end if;
  requirement := private.behavior_trim(substr(matching_requirements[1], strpos(matching_requirements[1], ':') + 1));
  if strpos(matching_requirements[1], ':') = 0 or requirement not in ('Niski','Standardowy','Wysoki','Krytyczny') then
    raise exception 'Invalid requirement' using errcode = '22023';
  end if;

  -- Serialize same-application saves, including the first insert with no row to lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('behavior:' || app.id::text, 0));
  select coalesce(max(e.version), 0) into last_version from public.behavior_assessment_entries e
    where e.application_id = app.id and e.area_key = target_area;
  if last_version <> expected_version then raise exception 'Assessment changed' using errcode = '40001'; end if;
  insert into public.behavior_assessment_entries(company_id, recruitment_id, application_id, area_key, version,
    rating, evidence, required_level, position_id, position_updated_at, position_snapshot, author_id)
  values (app.company_id, app.recruitment_id, app.id, target_area, last_version + 1,
    new_rating, private.behavior_trim(new_evidence), requirement, position.id, position.updated_at,
    jsonb_build_object('title', position.title, 'description', position.description, 'tasks', position.tasks,
      'kpis', position.kpis, 'autonomy_level', position.autonomy_level,
      'required_competencies', position.required_competencies, 'required_behaviors', position.required_behaviors), actor)
  returning id into entry_id;
  return entry_id;
end;
$$;
revoke all on function public.save_behavior_assessment(uuid,text,text,text,integer,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.save_behavior_assessment(uuid,text,text,text,integer,timestamptz,uuid) to authenticated;
commit;
