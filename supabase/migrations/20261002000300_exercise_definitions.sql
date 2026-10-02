begin;

-- Normalization matches the application rubric validator, including Unicode whitespace.
create function private.exercise_key(value text) returns text
language sql immutable strict set search_path = '' as $$
  select lower(regexp_replace(translate(normalize(private.behavior_trim(value), NFKC),
    U&'\0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF',
    repeat(' ', 24)), ' +', ' ', 'g'));
$$;
revoke all on function private.exercise_key(text) from public, anon, authenticated;

create function private.validate_exercise_definition(value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  item jsonb; field text; maximum integer; key text; seen text[] := '{}';
  anchors text[]; criteria jsonb := '[]';
begin
  if value is null or jsonb_typeof(value) <> 'object' then
    raise exception 'Invalid exercise' using errcode = '22023';
  end if;
  if (value->>'kind') is null or value->>'kind' not in ('competency_test','assessment_center')
    or jsonb_typeof(value->'durationMinutes') is distinct from 'number' then
    raise exception 'Invalid kind or duration' using errcode = '22023';
  end if;
  if (value->>'durationMinutes')::numeric not between 1 and 180
    or trunc((value->>'durationMinutes')::numeric) <> (value->>'durationMinutes')::numeric then
    raise exception 'Invalid duration' using errcode = '22023';
  end if;
  foreach field in array array['title','instructions','expectedOutput'] loop
    maximum := case field when 'title' then 200 when 'instructions' then 10000 else 4000 end;
    if jsonb_typeof(value->field) is distinct from 'string' or length(value->>field) > maximum
      or length(private.behavior_trim(value->>field)) = 0 then
      raise exception 'Invalid exercise text' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(value->'criteria') is distinct from 'array' then
    raise exception 'Invalid criteria' using errcode = '22023';
  end if;
  if jsonb_array_length(value->'criteria') not between 1 and 12 then
    raise exception 'Invalid criteria count' using errcode = '22023';
  end if;
  for item in select * from jsonb_array_elements(value->'criteria') loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Invalid criterion' using errcode = '22023'; end if;
    foreach field in array array['competency','below','meets','above'] loop
      maximum := case field when 'competency' then 200 else 2000 end;
      if jsonb_typeof(item->field) is distinct from 'string' or length(item->>field) > maximum
        or length(private.behavior_trim(item->>field)) = 0 then
        raise exception 'Invalid criterion text' using errcode = '22023';
      end if;
    end loop;
    key := private.exercise_key(item->>'competency');
    if key = any(seen) then raise exception 'Duplicate competency' using errcode = '22023'; end if;
    seen := array_append(seen, key);
    anchors := array[private.exercise_key(item->>'below'), private.exercise_key(item->>'meets'), private.exercise_key(item->>'above')];
    if anchors[1] = anchors[2] or anchors[1] = anchors[3] or anchors[2] = anchors[3] then
      raise exception 'Indistinguishable anchors' using errcode = '22023';
    end if;
    criteria := criteria || jsonb_build_array(jsonb_build_object(
      'competency',private.behavior_trim(item->>'competency'), 'below',private.behavior_trim(item->>'below'),
      'meets',private.behavior_trim(item->>'meets'), 'above',private.behavior_trim(item->>'above')));
  end loop;
  return jsonb_build_object('kind',value->>'kind','title',private.behavior_trim(value->>'title'),
    'instructions',private.behavior_trim(value->>'instructions'),'expectedOutput',private.behavior_trim(value->>'expectedOutput'),
    'durationMinutes',(value->>'durationMinutes')::numeric,'criteria',criteria);
end;
$$;
revoke all on function private.validate_exercise_definition(jsonb) from public, anon, authenticated;

create table public.exercise_definition_entries (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid not null,
  company_id uuid not null,
  recruitment_id uuid not null,
  version integer not null check(version > 0),
  definition jsonb not null check(jsonb_typeof(definition) = 'object'),
  position_id uuid not null,
  position_updated_at timestamptz not null,
  position_snapshot jsonb not null,
  author_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(exercise_id, version),
  unique(company_id, recruitment_id, id),
  foreign key(company_id, recruitment_id) references public.recruitments(company_id,id) on delete cascade,
  foreign key(company_id, position_id) references public.positions(company_id,id)
);
create index exercise_definitions_tenant_idx on public.exercise_definition_entries(company_id,recruitment_id,exercise_id,version desc);
alter table public.exercise_definition_entries enable row level security;
revoke all on public.exercise_definition_entries from public, anon, authenticated;
grant select on public.exercise_definition_entries to authenticated;
create policy exercise_definitions_read on public.exercise_definition_entries for select to authenticated
  using(private.has_company_access(company_id));
create view public.latest_exercise_definitions with(security_invoker = true) as
  select distinct on (exercise_id) * from public.exercise_definition_entries order by exercise_id,version desc;
revoke all on public.latest_exercise_definitions from public, anon, authenticated;
grant select on public.latest_exercise_definitions to authenticated;

create function public.save_exercise_definition(target_recruitment uuid, target_exercise uuid, new_definition jsonb,
  expected_version integer, expected_position_id uuid, expected_position_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); recruitment public.recruitments%rowtype; position public.positions%rowtype;
  previous public.exercise_definition_entries%rowtype; canonical jsonb; entry_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_exercise is null or expected_version is null or expected_version < 0
    or expected_position_id is null or expected_position_updated_at is null then
    raise exception 'Invalid revision context' using errcode = '22023';
  end if;
  select * into recruitment from public.recruitments r where r.id = target_recruitment
    and private.has_company_access(r.company_id, true) for share;
  if not found then raise exception 'No write access' using errcode = '42501'; end if;
  select * into position from public.positions p where p.id = recruitment.position_id and p.company_id = recruitment.company_id for share;
  if not found then raise exception 'No position' using errcode = '42501'; end if;
  if recruitment.status not in ('draft','open') or position.status = 'archived' then
    raise exception 'Exercise editing closed' using errcode = '55000';
  end if;
  if position.id is distinct from expected_position_id or position.updated_at is distinct from expected_position_updated_at then
    raise exception 'Position changed' using errcode = 'PT409';
  end if;
  canonical := private.validate_exercise_definition(new_definition);
  perform pg_advisory_xact_lock(hashtextextended('exercise:' || target_exercise::text,0));
  select * into previous from public.exercise_definition_entries where exercise_id = target_exercise order by version desc limit 1;
  if found and (previous.company_id <> recruitment.company_id or previous.recruitment_id <> recruitment.id) then
    raise exception 'No write access' using errcode = '42501';
  end if;
  if coalesce(previous.version,0) <> expected_version then raise exception 'Exercise changed' using errcode = 'PT409'; end if;
  insert into public.exercise_definition_entries(exercise_id, company_id, recruitment_id,version,definition,
    position_id,position_updated_at,position_snapshot,author_id)
    values(target_exercise,recruitment.company_id,recruitment.id,expected_version+1,canonical,
      position.id,position.updated_at,jsonb_build_object('title',position.title,'description',position.description,
        'tasks',position.tasks,'kpis',position.kpis,'autonomy_level',position.autonomy_level,
        'required_competencies',position.required_competencies,'required_behaviors',position.required_behaviors),actor)
    returning id into entry_id;
  return entry_id;
end;
$$;
revoke all on function public.save_exercise_definition(uuid,uuid,jsonb,integer,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.save_exercise_definition(uuid,uuid,jsonb,integer,uuid,timestamptz) to authenticated;
commit;
