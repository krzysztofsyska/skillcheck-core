-- SC Step 4: extend existing recruitment / assessment model; no production execution.
begin;

-- A recruitment inherits its position from recruitments.position_id.
-- No decision default: only the authenticated explicit RPC can change it.
alter table public.applications
  add column current_stage_id uuid,
  add column human_decision text check (human_decision in ('next_stage', 'on_hold', 'closed')),
  add column human_decision_reason text check (human_decision_reason is null or length(btrim(human_decision_reason)) between 10 and 5000),
  add constraint application_decision_reason_pair check (
    (human_decision is null and human_decision_reason is null)
    or (human_decision is not null and human_decision_reason is not null)
  ),
  add constraint application_current_stage_fk foreign key (company_id, recruitment_id, current_stage_id)
    references public.assessment_stages(company_id, recruitment_id, id) on delete restrict;

-- Existing per-stage candidate_assessments.notes remains the live note.
-- Future evidence-guide question identifiers can be attached after PR #171.
alter table public.candidate_assessments
  add column guide_question_id text check (guide_question_id is null or length(guide_question_id) between 1 and 150);

create table public.application_stage_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  from_stage_id uuid,
  to_stage_id uuid,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (from_stage_id is distinct from to_stage_id),
  foreign key (company_id, recruitment_id, application_id)
    references public.applications(company_id, recruitment_id, id) on delete cascade,
  foreign key (company_id, recruitment_id, from_stage_id)
    references public.assessment_stages(company_id, recruitment_id, id) on delete restrict,
  foreign key (company_id, recruitment_id, to_stage_id)
    references public.assessment_stages(company_id, recruitment_id, id) on delete restrict
);
create index application_stage_events_lookup on public.application_stage_events(company_id, recruitment_id, application_id, created_at desc);

create table public.application_decision_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  previous_decision text check (previous_decision in ('next_stage', 'on_hold', 'closed')),
  new_decision text not null check (new_decision in ('next_stage', 'on_hold', 'closed')),
  reason text not null check (length(btrim(reason)) between 10 and 5000),
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (company_id, recruitment_id, application_id)
    references public.applications(company_id, recruitment_id, id) on delete cascade
);
create index application_decision_events_lookup on public.application_decision_events(company_id, recruitment_id, application_id, created_at desc);

-- Append-only revisions, not a competing live-notes table.
create table public.candidate_assessment_note_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  assessment_id uuid not null references public.candidate_assessments(id) on delete cascade,
  body text,
  guide_question_id text,
  author_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (company_id, recruitment_id, application_id)
    references public.applications(company_id, recruitment_id, id) on delete cascade
);
create index candidate_note_revisions_lookup on public.candidate_assessment_note_revisions(company_id, recruitment_id, application_id, assessment_id, created_at desc);

do $$
declare tbl text;
begin
  foreach tbl in array array['application_stage_events','application_decision_events','candidate_assessment_note_revisions'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public, anon, authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy tenant_read on public.%I for select to authenticated using (private.has_company_access(company_id))',tbl);
  end loop;
end $$;

-- These log tables cannot be written, updated or deleted by an API session.
-- Application stage/decision columns intentionally receive NO UPDATE grants.
grant update (guide_question_id) on public.candidate_assessments to authenticated;

create function private.track_candidate_assessment_notes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if (tg_op = 'INSERT' and (new.notes is not null or new.guide_question_id is not null))
     or (tg_op = 'UPDATE' and (new.notes is distinct from old.notes or new.guide_question_id is distinct from old.guide_question_id)) then
    if actor is null or not private.has_company_access(new.company_id, true) then
      raise exception 'Human author required for notes' using errcode = '42501';
    end if;
    insert into public.candidate_assessment_note_revisions(company_id,recruitment_id,application_id,assessment_id,body,guide_question_id,author_id)
      values(new.company_id,new.recruitment_id,new.application_id,new.id,new.notes,new.guide_question_id,actor);
  end if;
  return new;
end $$;
revoke all on function private.track_candidate_assessment_notes() from public, anon, authenticated;
create trigger candidate_assessment_note_history after insert or update on public.candidate_assessments
for each row execute function private.track_candidate_assessment_notes();

-- Concurrency-safe stage reordering across one recruitment. Client never rewrites
-- all sequence numbers, which would collide with the existing unique key.
create function public.move_assessment_stage(target_company uuid, target_recruitment uuid, target_stage uuid, move_direction integer)
returns void language plpgsql security definer set search_path = '' as $$
declare item record; neighbor record; temporary_sequence integer;
begin
  if not private.has_company_access(target_company,true) or move_direction not in (-1,1) then
    raise exception 'Stage update not allowed' using errcode = '42501';
  end if;
  perform 1 from public.recruitments where company_id=target_company and id=target_recruitment for update;
  if not found then raise exception 'Recruitment not found'; end if;
  select id, sequence into item from public.assessment_stages
    where company_id=target_company and recruitment_id=target_recruitment and id=target_stage;
  if not found then raise exception 'Stage not found'; end if;
  if move_direction = -1 then
    select id,sequence into neighbor from public.assessment_stages
      where company_id=target_company and recruitment_id=target_recruitment and sequence < item.sequence
      order by sequence desc limit 1;
  else
    select id,sequence into neighbor from public.assessment_stages
      where company_id=target_company and recruitment_id=target_recruitment and sequence > item.sequence
      order by sequence limit 1;
  end if;
  if neighbor.id is null then return; end if;
  select coalesce(max(sequence),0)+1 into temporary_sequence from public.assessment_stages
    where company_id=target_company and recruitment_id=target_recruitment;
  update public.assessment_stages set sequence=temporary_sequence where id=item.id and company_id=target_company;
  update public.assessment_stages set sequence=item.sequence where id=neighbor.id and company_id=target_company;
  update public.assessment_stages set sequence=neighbor.sequence where id=item.id and company_id=target_company;
end $$;

create function public.move_application_stage(target_company uuid, target_recruitment uuid, target_application uuid, target_stage uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); old_stage uuid;
begin
  if actor is null or not private.has_company_access(target_company,true) then
    raise exception 'Stage change requires authenticated recruiter' using errcode = '42501';
  end if;
  if target_stage is not null and not exists (
    select 1 from public.assessment_stages where company_id=target_company and recruitment_id=target_recruitment and id=target_stage
  ) then raise exception 'Stage outside recruitment'; end if;
  select current_stage_id into old_stage from public.applications
    where company_id=target_company and recruitment_id=target_recruitment and id=target_application for update;
  if not found then raise exception 'Application not found'; end if;
  if old_stage is not distinct from target_stage then return; end if;
  update public.applications set current_stage_id=target_stage
    where company_id=target_company and recruitment_id=target_recruitment and id=target_application;
  insert into public.application_stage_events(company_id,recruitment_id,application_id,from_stage_id,to_stage_id,actor_id)
    values (target_company,target_recruitment,target_application,old_stage,target_stage,actor);
end $$;

create function public.set_application_human_decision(target_company uuid, target_recruitment uuid, target_application uuid, requested_decision text, justification text)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); old_decision text; clean_reason text := btrim(coalesce(justification,''));
begin
  if actor is null or not private.has_company_access(target_company,true) then
    raise exception 'Human decision requires authenticated recruiter' using errcode = '42501';
  end if;
  if requested_decision is null or requested_decision not in ('next_stage','on_hold','closed')
     or length(clean_reason) not between 10 and 5000 then
    raise exception 'Explicit decision and justification (10–5000 chars) required' using errcode = '22023';
  end if;
  select human_decision into old_decision from public.applications
    where company_id=target_company and recruitment_id=target_recruitment and id=target_application for update;
  if not found then raise exception 'Application not found'; end if;
  update public.applications set human_decision=requested_decision, human_decision_reason=clean_reason
    where company_id=target_company and recruitment_id=target_recruitment and id=target_application;
  insert into public.application_decision_events(company_id,recruitment_id,application_id,previous_decision,new_decision,reason,actor_id)
    values(target_company,target_recruitment,target_application,old_decision,requested_decision,clean_reason,actor);
end $$;

revoke all on function public.move_assessment_stage(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.move_application_stage(uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.set_application_human_decision(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.move_assessment_stage(uuid,uuid,uuid,integer),
  public.move_application_stage(uuid,uuid,uuid,uuid),
  public.set_application_human_decision(uuid,uuid,uuid,text,text) to authenticated;
commit;
