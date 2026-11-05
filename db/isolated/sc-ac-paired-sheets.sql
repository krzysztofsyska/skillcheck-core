-- Synthetic preview only. Review retention/inventory before an active migration.
begin;
create table private.ac_paired_sheets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  definition_id uuid not null,
  first_assessor uuid not null references auth.users(id),
  second_assessor uuid not null references auth.users(id),
  first_sheet jsonb,
  second_sheet jsonb,
  check (first_assessor <> second_assessor),
  unique(application_id, definition_id),
  foreign key(company_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete cascade,
  foreign key(company_id,recruitment_id,definition_id)
    references public.exercise_definition_entries(company_id,recruitment_id,id) on delete cascade
);
alter table private.ac_paired_sheets enable row level security;
revoke all on private.ac_paired_sheets from public, anon, authenticated;

create function public.ac_assign_pair(application uuid, revision uuid, first_id uuid, second_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare saved uuid;
begin
  insert into private.ac_paired_sheets(company_id,recruitment_id,application_id,definition_id,first_assessor,second_assessor)
  select a.company_id,a.recruitment_id,a.id,d.id,first_id,second_id
    from public.applications a join public.exercise_definition_entries d
      on d.company_id=a.company_id and d.recruitment_id=a.recruitment_id
    join public.companies c on c.id=a.company_id
    where a.id=application and d.id=revision and d.definition->>'kind'='assessment_center'
      and private.is_company_owner(c.id) and first_id<>second_id
      and not exists (
        select 1 from unnest(array[first_id,second_id]) participant
        where participant is null or (participant<>c.owner_id and not exists
          (select 1 from public.company_members m where m.company_id=c.id and m.user_id=participant and m.role='recruiter')))
  returning id into saved;
  if saved is null then raise exception using errcode='42501',message='Pair unavailable'; end if;
  return saved;
end $$;

create function public.ac_submit_sheet(pair_id uuid, sheet jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare pair private.ac_paired_sheets; rubric jsonb; item jsonb; idx integer:=0;
begin
  select s.* into pair from private.ac_paired_sheets s
    join public.applications a on a.id=s.application_id
    join public.recruitments r on r.id=s.recruitment_id
    join public.positions p on p.id=r.position_id
    where s.id=pair_id and auth.uid() in (s.first_assessor,s.second_assessor)
      and private.has_company_access(s.company_id,true) and a.status in ('new','in_progress')
      and r.status in ('draft','open') and p.status<>'archived'
    for update of s for share of a,r,p;
  if pair.id is null then raise exception using errcode='42501',message='Pair unavailable'; end if;
  if (auth.uid()=pair.first_assessor and pair.first_sheet is not null) or
     (auth.uid()=pair.second_assessor and pair.second_sheet is not null) then
    raise exception using errcode='PT409',message='Sheet already submitted';
  end if;
  select definition into strict rubric from public.exercise_definition_entries where id=pair.definition_id;
  if jsonb_typeof(sheet) is distinct from 'array' or jsonb_array_length(sheet)<>jsonb_array_length(rubric->'criteria') then
    raise exception using errcode='22023',message='Invalid sheet';
  end if;
  for item in select value from jsonb_array_elements(sheet) loop
    if jsonb_typeof(item) is distinct from 'object' or item-'criterionIndex'-'rating'-'evidence'<>'{}'::jsonb
      or item->'criterionIndex' is distinct from to_jsonb(idx)
      or coalesce(item->>'rating','') not in ('meets','above','below','insufficient_data')
      or jsonb_typeof(item->'evidence') is distinct from 'string' or length(item->>'evidence')>10000
      or ((item->>'rating'='insufficient_data') <> (private.behavior_trim(item->>'evidence')='')) then
      raise exception using errcode='22023',message='Invalid observation';
    end if;
    idx:=idx+1;
  end loop;
  if auth.uid()=pair.first_assessor then
    update private.ac_paired_sheets set first_sheet=sheet where id=pair.id;
  else
    update private.ac_paired_sheets set second_sheet=sheet where id=pair.id;
  end if;
end $$;

create function public.ac_read_pair(pair_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pair private.ac_paired_sheets;
begin
  select * into pair from private.ac_paired_sheets s where s.id=pair_id
    and private.has_company_access(s.company_id,true)
    and (auth.uid() in (s.first_assessor,s.second_assessor) or private.is_company_owner(s.company_id));
  if pair.id is null then raise exception using errcode='42501',message='Pair unavailable'; end if;
  if pair.first_sheet is null or pair.second_sheet is null then
    return jsonb_build_object('state','pending','ownSubmitted',case auth.uid()
      when pair.first_assessor then pair.first_sheet is not null
      when pair.second_assessor then pair.second_sheet is not null end);
  end if;
  return jsonb_build_object('state','ready','definitionId',pair.definition_id,
    'sheets',jsonb_build_array(jsonb_build_object('authorId',pair.first_assessor,'observations',pair.first_sheet),
                              jsonb_build_object('authorId',pair.second_assessor,'observations',pair.second_sheet)));
end $$;
create function public.ac_find_pair(application uuid,revision uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select s.id from private.ac_paired_sheets s where s.application_id=application and s.definition_id=revision
    and private.has_company_access(s.company_id,true)
    and (auth.uid() in (s.first_assessor,s.second_assessor) or private.is_company_owner(s.company_id))
$$;
revoke all on function public.ac_find_pair(uuid,uuid),public.ac_assign_pair(uuid,uuid,uuid,uuid),public.ac_submit_sheet(uuid,jsonb),
  public.ac_read_pair(uuid) from public,anon,authenticated;
grant execute on function public.ac_find_pair(uuid,uuid),public.ac_assign_pair(uuid,uuid,uuid,uuid),public.ac_submit_sheet(uuid,jsonb),
  public.ac_read_pair(uuid) to authenticated;
commit;
