begin;
-- SC Step 4: interview workbench. Depends on 20261026194700_evidence_matrix.sql.
-- organization_id is companies.id, not a second tenancy system.
create unique index if not exists evidence_item_identity_tenant_idx
  on public.evidence_item(organization_id,analysis_id,id);

create table public.interview_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  analysis_id uuid not null,
  evidence_item_id uuid not null,
  requirement_key text not null,
  requirement_text text not null,
  evidence_context text not null default '',
  question_text text not null check (length(btrim(question_text)) between 1 and 2000),
  origin text not null check (origin in ('generated','manual')),
  sort_order double precision not null check (sort_order > 0 and sort_order < 1000000000),
  is_active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  foreign key(organization_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete cascade,
  foreign key(organization_id,analysis_id)
    references public.evidence_analysis(organization_id,id) on delete cascade,
  foreign key(organization_id,analysis_id,evidence_item_id)
    references public.evidence_item(organization_id,analysis_id,id) on delete cascade
);
-- Generated questions are unique per evidence item; manual additions may repeat.
create unique index interview_generated_once_idx on public.interview_questions
  (organization_id,application_id,analysis_id,evidence_item_id) where origin='generated';
create index interview_questions_order_idx on public.interview_questions
  (organization_id,application_id,analysis_id,sort_order);

create table public.interview_question_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  question_id uuid not null,
  version integer not null,
  question_text text not null,
  sort_order double precision not null,
  is_active boolean not null,
  changed_by uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  unique(organization_id,question_id,version),
  foreign key(organization_id,question_id)
    references public.interview_questions(organization_id,id) on delete cascade
);

create table public.interview_question_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  question_id uuid not null,
  answer_text text not null default '' check (length(answer_text)<=12000),
  observation_text text not null default '' check(length(observation_text)<=12000),
  version integer not null default 1 check(version > 0),
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  unique(organization_id,question_id),
  foreign key(organization_id,question_id)
    references public.interview_questions(organization_id,id) on delete cascade
);
create table public.interview_note_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  note_id uuid not null,
  version integer not null,
  answer_text text not null,
  observation_text text not null,
  changed_by uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  unique(organization_id,note_id,version),
  foreign key(organization_id,note_id)
    references public.interview_question_notes(organization_id,id) on delete cascade
);

create table public.application_stage_transitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  stage_id uuid not null,
  previous_stage_id uuid,
  expected_previous_event_id uuid,
  changed_by uuid not null references auth.users(id) on delete restrict,
  reason text not null default '' check(length(reason)<=2000),
  created_at timestamptz not null default now(),
  foreign key(organization_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete cascade,
  foreign key(organization_id,recruitment_id,stage_id)
    references public.assessment_stages(company_id,recruitment_id,id) on delete restrict,
  foreign key(organization_id,recruitment_id,previous_stage_id)
    references public.assessment_stages(company_id,recruitment_id,id) on delete restrict
);
create index application_stage_log_idx on public.application_stage_transitions
  (organization_id,application_id,created_at desc,id desc);

-- Append-only human decisions. No default value, AI or background worker cannot write.
create table public.human_candidate_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  decision text not null check(decision in ('next_stage','on_hold','completed')),
  justification text not null check(length(btrim(justification)) between 1 and 10000),
  decided_by uuid not null references auth.users(id) on delete restrict,
  decided_at timestamptz not null default now(),
  foreign key(organization_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete cascade
);
create index human_decisions_history_idx on public.human_candidate_decisions
  (organization_id,application_id,decided_at desc,id desc);

-- Identity and snapshot derived from trusted rows, not client body.
create function private.interview_question_stamp() returns trigger
language plpgsql set search_path = '' as $$
declare a public.evidence_analysis%rowtype;
declare e public.evidence_item%rowtype;
declare req jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Login required' using errcode='42501'; end if;
  if tg_op='INSERT' then
    select * into a from public.evidence_analysis where organization_id=new.organization_id
      and id=new.analysis_id and application_id=new.application_id and
      recruitment_id=new.recruitment_id and status='done';
    if not found then raise exception 'Completed evidence analysis required' using errcode='23503'; end if;
    select * into e from public.evidence_item where organization_id=new.organization_id
      and analysis_id=new.analysis_id and id=new.evidence_item_id and
      human_status in ('accepted','edited') and
      (case when human_status='edited' then human_verdict else verdict end)
        in ('partial','missing','contradicted');
    if not found then raise exception 'Human-reviewed evidence required' using errcode='42501'; end if;
    select value into req from pg_catalog.jsonb_array_elements(a.requirements_snapshot)
      where value->>'id'=e.requirement_key limit 1;
    if req is null then raise exception 'Unknown requirement' using errcode='23503'; end if;
    new.requirement_key := e.requirement_key;
    new.requirement_text := req->>'text';
    new.evidence_context := pg_catalog.left(
      coalesce(e.evidence_quotes->0->>'quote','Brak cytatu w zatwierdzonym tekście CV.'),2000);
    new.created_by := (select auth.uid());
    new.updated_by := (select auth.uid());
    new.version := 1;
  else
    if new.organization_id<>old.organization_id or new.recruitment_id<>old.recruitment_id
      or new.application_id<>old.application_id or new.analysis_id<>old.analysis_id
      or new.evidence_item_id<>old.evidence_item_id or new.origin<>old.origin
      or new.created_by<>old.created_by or new.requirement_text<>old.requirement_text
      or new.requirement_key<>old.requirement_key or new.evidence_context<>old.evidence_context
    then raise exception 'Question source is immutable' using errcode='42501'; end if;
    new.updated_by := (select auth.uid());
    new.version := old.version+1;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end; $$;
create trigger interview_question_stamp before insert or update on public.interview_questions
  for each row execute function private.interview_question_stamp();

create function private.interview_question_audit() returns trigger
language plpgsql set search_path = '' as $$
begin
 insert into public.interview_question_revisions(
  organization_id,question_id,version,question_text,sort_order,is_active,changed_by
 ) values (new.organization_id,new.id,new.version,new.question_text,new.sort_order,
   new.is_active,new.updated_by);
 return new;
end; $$;
create trigger interview_question_audit after insert or update on public.interview_questions
  for each row execute function private.interview_question_audit();

create function private.interview_note_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
 if (select auth.uid()) is null then raise exception 'Login required' using errcode='42501'; end if;
 if tg_op='UPDATE' then
   if new.organization_id<>old.organization_id or new.question_id<>old.question_id then
     raise exception 'Note source immutable' using errcode='42501'; end if;
   new.version := old.version+1;
 else
   new.version := 1;
 end if;
 new.updated_by := (select auth.uid());
 new.updated_at := pg_catalog.now();
 return new;
end; $$;
create trigger interview_note_stamp before insert or update on public.interview_question_notes
  for each row execute function private.interview_note_stamp();
create function private.interview_note_audit() returns trigger
language plpgsql set search_path = '' as $$
begin
 insert into public.interview_note_revisions(
  organization_id,note_id,version,answer_text,observation_text,changed_by
 ) values(new.organization_id,new.id,new.version,new.answer_text,new.observation_text,new.updated_by);
 return new;
end; $$;
create trigger interview_note_audit after insert or update on public.interview_question_notes
  for each row execute function private.interview_note_audit();

create function private.application_stage_stamp() returns trigger
language plpgsql set search_path = '' as $$
declare previous public.application_stage_transitions%rowtype;
begin
 if (select auth.uid()) is null then raise exception 'Login required' using errcode='42501'; end if;
 perform pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended(new.organization_id::text||':'||new.application_id::text,12));
 select * into previous from public.application_stage_transitions
   where organization_id=new.organization_id and application_id=new.application_id
   order by created_at desc,id desc limit 1;
 if new.expected_previous_event_id is distinct from previous.id then
   raise exception 'Stage changed in another session' using errcode='40001';
 end if;
 if new.stage_id is not distinct from previous.stage_id then
   raise exception 'Already at this stage' using errcode='23514';
 end if;
 new.previous_stage_id := previous.stage_id;
 new.changed_by := (select auth.uid());
 new.created_at := pg_catalog.now();
 return new;
end; $$;
create trigger application_stage_stamp before insert on public.application_stage_transitions
  for each row execute function private.application_stage_stamp();

create function private.human_decision_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
 if (select auth.uid()) is null then raise exception 'Login required' using errcode='42501'; end if;
 if new.decision is null or btrim(new.justification)='' then
    raise exception 'Explicit human decision and justification required' using errcode='23514';
 end if;
 new.decided_by := (select auth.uid());
 new.decided_at := pg_catalog.now();
 return new;
end; $$;
create trigger human_decision_stamp before insert on public.human_candidate_decisions
  for each row execute function private.human_decision_stamp();

-- All tables are tenant-scoped; audit/history are append-only for users.
do $$
declare t text;
begin
 foreach t in array array[
   'interview_questions','interview_question_revisions','interview_question_notes',
   'interview_note_revisions','application_stage_transitions','human_candidate_decisions'
 ] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
   execute format('grant select on public.%I to authenticated',t);
   execute format('create policy tenant_read on public.%I for select to authenticated using (private.has_company_access(organization_id))',t);
 end loop;
end $$;
grant insert on public.interview_questions,public.interview_question_notes,
  public.application_stage_transitions,public.human_candidate_decisions to authenticated;
grant update(question_text,sort_order,is_active) on public.interview_questions to authenticated;
grant update(answer_text,observation_text) on public.interview_question_notes to authenticated;

create policy tenant_insert on public.interview_questions for insert to authenticated
  with check(private.has_company_access(organization_id,true));
create policy tenant_update on public.interview_questions for update to authenticated
  using(private.has_company_access(organization_id,true))
  with check(private.has_company_access(organization_id,true));
create policy tenant_insert on public.interview_question_notes for insert to authenticated
  with check(private.has_company_access(organization_id,true));
create policy tenant_update on public.interview_question_notes for update to authenticated
  using(private.has_company_access(organization_id,true))
  with check(private.has_company_access(organization_id,true));
create policy tenant_insert on public.application_stage_transitions for insert to authenticated
  with check(private.has_company_access(organization_id,true));
create policy tenant_insert on public.human_candidate_decisions for insert to authenticated
  with check(private.has_company_access(organization_id,true));

revoke all on function private.interview_question_stamp(),
  private.interview_question_audit(),private.interview_note_stamp(),
  private.interview_note_audit(),private.application_stage_stamp(),
  private.human_decision_stamp() from public,anon,authenticated;
commit;
