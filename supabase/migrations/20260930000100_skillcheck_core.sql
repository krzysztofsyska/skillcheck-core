begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  owner_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_owner_idx on public.companies(owner_id);

-- Ownership is stored only on companies; members cannot promote themselves.
create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('recruiter', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_members_user_idx on public.company_members(user_id);

create table public.company_profiles (
  company_id uuid primary key references public.companies(id) on delete cascade,
  industry text,
  description text,
  website text,
  size_band text check (size_band in ('1-10', '11-50', '51-200', '201-500', '501+')),
  work_environment text,
  company_values text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text,
  tasks text[] not null default '{}',
  kpis text[] not null default '{}',
  autonomy_level smallint check (autonomy_level between 1 and 5),
  required_behaviors text[] not null default '{}',
  required_competencies text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.recruitments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  position_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  status text not null default 'draft' check (status in ('draft', 'open', 'paused', 'closed')),
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, position_id) references public.positions(company_id, id) on delete restrict,
  check (closed_at is null or opened_at is null or closed_at >= opened_at)
);
create index recruitments_position_idx on public.recruitments(company_id, position_id);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text not null check (length(btrim(last_name)) between 1 and 100),
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recruitment_id uuid not null,
  candidate_id uuid not null,
  status text not null default 'new' check (status in ('new', 'in_progress', 'rejected', 'withdrawn', 'hired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, recruitment_id, candidate_id),
  unique (company_id, recruitment_id, id),
  foreign key (company_id, recruitment_id) references public.recruitments(company_id, id) on delete cascade,
  foreign key (company_id, candidate_id) references public.candidates(company_id, id) on delete cascade
);
create index applications_candidate_idx on public.applications(company_id, candidate_id);

-- Definitions only: no CV/AI/voicebot execution or automatic decisions.
create table public.assessment_stages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recruitment_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  description text,
  sequence integer not null check (sequence > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, recruitment_id, sequence),
  unique (company_id, recruitment_id, id),
  foreign key (company_id, recruitment_id) references public.recruitments(company_id, id) on delete cascade
);

create table public.candidate_assessments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recruitment_id uuid not null,
  application_id uuid not null,
  stage_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'skipped')),
  score numeric(5,2) check (score between 0 and 100),
  notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, application_id, stage_id),
  foreign key (company_id, recruitment_id, application_id) references public.applications(company_id, recruitment_id, id) on delete cascade,
  foreign key (company_id, recruitment_id, stage_id) references public.assessment_stages(company_id, recruitment_id, id) on delete cascade,
  check ((status = 'completed') = (completed_at is not null))
);
create index candidate_assessments_application_idx on public.candidate_assessments(company_id, recruitment_id, application_id);
create index candidate_assessments_stage_idx on public.candidate_assessments(company_id, recruitment_id, stage_id);

create function private.is_company_owner(target_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.companies
    where id = target_company and owner_id = (select auth.uid()));
$$;

create function private.has_company_access(target_company uuid, write_access boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_company_owner(target_company) or exists (
    select 1 from public.company_members
    where company_id = target_company and user_id = (select auth.uid())
      and (not write_access or role = 'recruiter')
  );
$$;

create function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Bootstrap atomically. No caller-supplied owner ID, no direct company INSERT.
create function public.create_company(company_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_company_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  insert into public.companies(name, owner_id)
    values (btrim(company_name), (select auth.uid())) returning id into new_company_id;
  insert into public.company_profiles(company_id) values (new_company_id);
  return new_company_id;
end;
$$;

revoke all on function private.is_company_owner(uuid) from public, anon, authenticated;
revoke all on function private.has_company_access(uuid, boolean) from public, anon, authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;
revoke all on function public.create_company(text) from public, anon, authenticated;
grant execute on function private.is_company_owner(uuid), private.has_company_access(uuid, boolean), public.create_company(text) to authenticated;

-- Explicit grants override Supabase's permissive default table privileges.
do $$
declare t text;
begin
  foreach t in array array['companies','company_members','company_profiles','positions','recruitments','candidates','applications','assessment_stages','candidate_assessments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()', t);
  end loop;
  foreach t in array array['company_profiles','positions','recruitments','candidates','applications','assessment_stages','candidate_assessments'] loop
    execute format('grant insert, delete on table public.%I to authenticated', t);
    execute format('create policy tenant_read on public.%I for select to authenticated using (private.has_company_access(company_id))', t);
    execute format('create policy tenant_insert on public.%I for insert to authenticated with check (private.has_company_access(company_id, true))', t);
    execute format('create policy tenant_update on public.%I for update to authenticated using (private.has_company_access(company_id, true)) with check (private.has_company_access(company_id, true))', t);
    execute format('create policy tenant_delete on public.%I for delete to authenticated using (private.has_company_access(company_id, true))', t);
  end loop;
end;
$$;

-- Column grants make identity, tenancy and parent links immutable, even for a
-- user belonging to both companies. Reparenting needs an explicit future API.
grant update (name) on public.companies to authenticated;
grant insert, delete on public.company_members to authenticated;
grant update (role) on public.company_members to authenticated;
grant update (industry, description, website, size_band, work_environment, company_values) on public.company_profiles to authenticated;
grant update (title, description, tasks, kpis, autonomy_level, required_behaviors, required_competencies, status) on public.positions to authenticated;
grant update (name, status, opened_at, closed_at) on public.recruitments to authenticated;
grant update (first_name, last_name, email, phone) on public.candidates to authenticated;
grant update (status) on public.applications to authenticated;
grant update (name, description, sequence) on public.assessment_stages to authenticated;
grant update (status, score, notes, completed_at) on public.candidate_assessments to authenticated;

create policy company_read on public.companies for select to authenticated using (private.has_company_access(id));
create policy company_update on public.companies for update to authenticated using (private.is_company_owner(id)) with check (private.is_company_owner(id));
create policy members_read on public.company_members for select to authenticated using (private.has_company_access(company_id));
create policy members_insert on public.company_members for insert to authenticated with check (private.is_company_owner(company_id));
create policy members_update on public.company_members for update to authenticated using (private.is_company_owner(company_id)) with check (private.is_company_owner(company_id));
create policy members_delete on public.company_members for delete to authenticated using (private.is_company_owner(company_id));

commit;
