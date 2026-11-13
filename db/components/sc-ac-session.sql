-- SC-AC-SESSION (#276) domain component. Installed atomically by the R16 forward migration.
-- Builds ON the R13 pair engine (private.ac_paired_sheets + ac_* RPCs): one pair per
-- finalist and stage, never a second engine. Synthetic data only in tests.

-- Exact comparison key of a competency name: NFKC, outer trim, inner whitespace collapsed.
-- No case folding: lower() depends on the database locale, an exact key does not.
create function private.ac_competency_key(value text) returns text
language sql immutable strict set search_path='' as $$
 select regexp_replace(private.behavior_trim(normalize(value,NFKC)),'\s+',' ','g')
$$;

-- Session configuration. No candidate data: the plan and its lifecycle only.
create table private.ac_sessions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,recruitment_id uuid not null,
 title text not null check(length(title) between 1 and 200),
 planned_competencies text[] not null check(cardinality(planned_competencies) between 1 and 24),
 status text not null default 'draft' check(status in ('draft','open','closed')),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 opened_by uuid references auth.users(id),opened_at timestamptz,
 closed_by uuid references auth.users(id),closed_at timestamptz,
 check((status='draft')=(opened_at is null)),check((opened_at is null)=(opened_by is null)),
 check((closed_at is null)=(closed_by is null)),check((status='closed')=(closed_at is not null)),
 unique(company_id,recruitment_id),
 unique(company_id,recruitment_id,id),
 foreign key(company_id,recruitment_id) references public.recruitments(company_id,id) on delete cascade
);
alter table private.ac_sessions enable row level security;
comment on table private.ac_sessions is 'AC session per recruitment: competency coverage plan and lifecycle. Configuration, no candidate data. RPC access only.';

-- Ordered stages. Each stage pins one exact immutable AC exercise revision; its rubric
-- criteria are the competencies the stage covers and the sheet both assessors fill.
create table private.ac_session_stages (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null,company_id uuid not null,recruitment_id uuid not null,
 ordinal smallint not null check(ordinal between 1 and 8),
 stage_type text not null check(stage_type in ('case_study','human_simulation')),
 title text not null check(length(title) between 1 and 200),
 definition_id uuid not null,
 counterpart_brief text check(length(counterpart_brief) between 10 and 2000),
 check((stage_type='human_simulation')=(counterpart_brief is not null)),
 unique(session_id,ordinal),unique(session_id,definition_id),unique(session_id,id),
 foreign key(company_id,recruitment_id,session_id) references private.ac_sessions(company_id,recruitment_id,id) on delete cascade,
 foreign key(company_id,recruitment_id,definition_id) references public.exercise_definition_entries(company_id,recruitment_id,id)
);
alter table private.ac_session_stages enable row level security;
comment on table private.ac_session_stages is 'Ordered AC session stages (multi-stage case study, simulation with a human). Configuration, no candidate data. RPC access only.';

-- Finalists. slot 1..10 + unique(session_id,slot) is the hard cap of ten.
create table private.ac_session_finalists (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null,company_id uuid not null,recruitment_id uuid not null,application_id uuid not null,
 slot smallint not null check(slot between 1 and 10),
 added_by uuid not null references auth.users(id),added_at timestamptz not null default clock_timestamp(),
 unique(session_id,slot),unique(session_id,application_id),
 foreign key(company_id,recruitment_id,session_id) references private.ac_sessions(company_id,recruitment_id,id),
 foreign key(company_id,recruitment_id,application_id) references public.applications(company_id,recruitment_id,id)
);
alter table private.ac_session_finalists enable row level security;
comment on table private.ac_session_finalists is 'Candidate-linked: AC finalist drawn from the recruitment shortlist (rule R1), at most ten per session. R16 manifest-checked candidate purge only.';

-- Reconciliation of one submitted pair: per criterion an agreed rating (one of the two
-- submitted ratings, never a computed mean) or an explicit discrepancy keeping both.
create table private.ac_reconciliations (
 id uuid primary key default gen_random_uuid(),
 pair_id uuid not null unique references private.ac_paired_sheets(id),
 company_id uuid not null,recruitment_id uuid not null,application_id uuid not null,
 items jsonb not null check(jsonb_typeof(items)='array'),
 recorded_by uuid not null references auth.users(id),recorded_at timestamptz not null default clock_timestamp(),
 confirmation text check(confirmation in ('confirmed','disputed')),
 confirmed_by uuid references auth.users(id),confirmed_at timestamptz,
 dispute_note text check(length(dispute_note) between 10 and 2000),
 check((confirmation is null)=(confirmed_by is null)),check((confirmed_by is null)=(confirmed_at is null)),
 check(confirmed_by is distinct from recorded_by),
 check(dispute_note is null or confirmation='disputed'),check(confirmation is distinct from 'disputed' or dispute_note is not null),
 foreign key(company_id,recruitment_id,application_id) references public.applications(company_id,recruitment_id,id)
);
alter table private.ac_reconciliations enable row level security;
comment on table private.ac_reconciliations is 'Candidate-linked: named reconciliation of two submitted AC sheets; agreed rating or explicit discrepancy per criterion, answered once by the other assessor. R16 manifest-checked candidate purge only.';

-- Append-only ledger: first attempt, assessor feedback, revised attempt, separate proof
-- of change, expert consultation notes. Nothing here is ever rewritten.
create table private.ac_session_entries (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null,company_id uuid not null,recruitment_id uuid not null,application_id uuid not null,
 -- Not "stage_id": the generic row guard reserves that key for public.assessment_stages.
 session_stage_id uuid,
 kind text not null check(kind in ('first_attempt','feedback','revised_attempt','change_proof','expert_consultation')),
 body jsonb not null check(jsonb_typeof(body)='object'),
 author_id uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 check((kind='expert_consultation')=(session_stage_id is null)),
 foreign key(session_id,application_id) references private.ac_session_finalists(session_id,application_id),
 foreign key(session_id,session_stage_id) references private.ac_session_stages(session_id,id),
 foreign key(company_id,recruitment_id,application_id) references public.applications(company_id,recruitment_id,id)
);
create unique index ac_session_entries_once on private.ac_session_entries(session_id,application_id,session_stage_id,kind) where kind<>'expert_consultation';
create index ac_session_entries_finalist on private.ac_session_entries(session_id,application_id,created_at);
alter table private.ac_session_entries enable row level security;
comment on table private.ac_session_entries is 'Candidate-linked append-only AC evidence: first attempt, feedback, revised attempt, proof of change, expert consultation. R16 manifest-checked candidate purge only.';

-- Planned competencies no stage rubric covers. Empty array = complete plan.
create function private.ac_session_uncovered(target uuid) returns text[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(p.c order by p.ord),'{}'::text[])
 from private.ac_sessions s cross join lateral unnest(s.planned_competencies) with ordinality p(c,ord)
 where s.id=target and not exists(
  select 1 from private.ac_session_stages g
  join public.exercise_definition_entries d on d.id=g.definition_id and d.company_id=g.company_id and d.recruitment_id=g.recruitment_id
  cross join lateral jsonb_array_elements(d.definition->'criteria') k
  where g.session_id=s.id and private.ac_competency_key(k->>'competency')=p.c)
$$;

-- Configuration guards. The opening rule lives in the table, not only in the RPC:
-- no path can open a session with an uncovered competency, no stage or finalist.
create function private.ac_session_config_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare parent private.ac_sessions;
begin
 if tg_table_name='ac_sessions' then
  if tg_op='INSERT' then
   if new.status<>'draft' then raise exception using errcode='42501',message='Session starts as draft';end if;
   return new;
  end if;
  if (to_jsonb(old)-array['status','opened_by','opened_at','closed_by','closed_at']) is distinct from
   (to_jsonb(new)-array['status','opened_by','opened_at','closed_by','closed_at'])
   or not ((old.status='draft' and new.status='open') or (old.status='open' and new.status='closed'))
   or (old.opened_at is not null and row(new.opened_by,new.opened_at) is distinct from row(old.opened_by,old.opened_at)) then
   raise exception using errcode='42501',message='Immutable session';end if;
  if new.status='open' then
   if not exists(select 1 from private.ac_session_stages where session_id=new.id)
    or not exists(select 1 from private.ac_session_finalists where session_id=new.id) then
    raise exception using errcode='PT422',message='Session needs a stage and a finalist';end if;
   if cardinality(private.ac_session_uncovered(new.id))>0 then
    raise exception using errcode='PT422',message='Coverage plan incomplete';end if;
  end if;
  return new;
 end if;
 -- Stages: never rewritten, and frozen once the session leaves draft. A cascade from
 -- a deleted session (deleted recruitment) finds no parent and passes.
 select * into parent from private.ac_sessions where id=coalesce(new.session_id,old.session_id);
 if parent.id is not null and (tg_op='UPDATE' or parent.status<>'draft') then
  raise exception using errcode='42501',message='Immutable session plan';end if;
 return coalesce(new,old);
end;$$;
create trigger ac_session_config_guard before insert or update on private.ac_sessions for each row execute function private.ac_session_config_guard();
create trigger ac_session_config_guard before insert or update or delete on private.ac_session_stages for each row execute function private.ac_session_config_guard();

-- Candidate-linked rows: insert-only, no ordinary DELETE, identity never changes.
-- The purge role is allowed only the already validated manifest DELETE.
create function private.ac_session_row_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare adapter text:=tg_table_schema||'.'||tg_table_name;fresh jsonb;past jsonb;pair private.ac_paired_sheets;
 answer text[]:=array['confirmation','confirmed_by','confirmed_at','dispute_note'];
begin
 if current_user='erasure_purge_owner' then
  if tg_op='DELETE' and private.erasure_purge_allowed(adapter,to_jsonb(old)) then return old;end if;
  raise exception using errcode='42501',message='Purge boundary';end if;
 if tg_op='DELETE' then
  -- The only ordinary DELETE: a mistaken finalist of a DRAFT session with no evidence yet.
  past:=to_jsonb(old);
  if tg_table_name<>'ac_session_finalists'
   or not exists(select 1 from private.ac_sessions s where s.id=(past->>'session_id')::uuid and s.status='draft')
   or exists(select 1 from private.ac_session_entries e where e.session_id=(past->>'session_id')::uuid and e.application_id=(past->>'application_id')::uuid)
   or exists(select 1 from private.ac_session_stages g join private.ac_paired_sheets p on p.definition_id=g.definition_id
    where g.session_id=(past->>'session_id')::uuid and p.application_id=(past->>'application_id')::uuid) then
   raise exception using errcode='42501',message='Controlled erasure required';end if;
  perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,past,null);
  return old;
 end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='Assessment frozen';end if;
 fresh:=to_jsonb(new);
 if tg_op='UPDATE' then
  past:=to_jsonb(old);
  -- Only the single answer of the OTHER assessor may ever be added to a reconciliation.
  if tg_table_name<>'ac_reconciliations' or (past-answer) is distinct from (fresh-answer)
   or past->>'confirmation' is not null or fresh->>'confirmation' is null
   or fresh->>'confirmed_by' is distinct from auth.uid()::text then
   raise exception using errcode='42501',message='Immutable assessment';end if;
  select * into pair from private.ac_paired_sheets where id=(fresh->>'pair_id')::uuid;
  if pair.id is null or auth.uid() not in (pair.first_assessor,pair.second_assessor)
   or private.ac_pair_open_session(pair.company_id,pair.recruitment_id,pair.application_id,pair.definition_id) is null then
   raise exception using errcode='42501',message='Immutable assessment';end if;
  return new;
 end if;
 if tg_table_name='ac_session_finalists' then
  -- Rule R1 in the table itself: a finalist is an active shortlist entry of this recruitment.
  if not exists(select 1 from public.recruitment_shortlist_entries e where e.company_id=(fresh->>'company_id')::uuid
   and e.recruitment_id=(fresh->>'recruitment_id')::uuid and e.application_id=(fresh->>'application_id')::uuid and e.removed_at is null)
   or not exists(select 1 from private.ac_sessions s where s.id=(fresh->>'session_id')::uuid and s.status in ('draft','open')) then
   raise exception using errcode='42501',message='Finalist must be shortlisted';end if;
 elsif tg_table_name='ac_reconciliations' then
  select * into pair from private.ac_paired_sheets where id=(fresh->>'pair_id')::uuid;
  if pair.id is null or pair.first_sheet is null or pair.second_sheet is null or fresh->>'confirmation' is not null
   or pair.company_id<>(fresh->>'company_id')::uuid or pair.recruitment_id<>(fresh->>'recruitment_id')::uuid
   or pair.application_id<>(fresh->>'application_id')::uuid
   or (fresh->>'recorded_by')::uuid not in (pair.first_assessor,pair.second_assessor)
   or private.ac_pair_open_session(pair.company_id,pair.recruitment_id,pair.application_id,pair.definition_id) is null then
   raise exception using errcode='42501',message='Reconciliation requires both sheets in an open session';end if;
 else
  if not exists(select 1 from private.ac_sessions s where s.id=(fresh->>'session_id')::uuid and s.status='open'
   and s.company_id=(fresh->>'company_id')::uuid and s.recruitment_id=(fresh->>'recruitment_id')::uuid) then
   raise exception using errcode='42501',message='Session is not open';end if;
 end if;
 return new;
exception when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;

do $guards$
declare t text;
begin
 foreach t in array array['ac_session_finalists','ac_reconciliations','ac_session_entries'] loop
  execute format('create trigger ac_session_row_guard before insert or update or delete on private.%I for each row execute function private.ac_session_row_guard()',t);
  execute format('create trigger zz_retention_observed after insert or update or delete on private.%I for each row execute function private.retention_observe_candidate()',t);
  execute format('grant select,delete on private.%I to erasure_purge_owner',t);
  execute format('create policy erasure_purge_select on private.%1$I for select to erasure_purge_owner using(private.erasure_purge_visible(%2$L,to_jsonb(%1$I)))',t,'private.'||t);
  execute format('create policy erasure_purge_delete on private.%1$I for delete to erasure_purge_owner using(private.erasure_purge_allowed(%2$L,to_jsonb(%1$I)))',t,'private.'||t);
 end loop;
end $guards$;

-- Owner-only session lock for configuration. Recruitment and position must be live.
create function private.ac_session_lock(target uuid,owner_only boolean) returns private.ac_sessions
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;r public.recruitments;p public.positions;
begin
 select * into s from private.ac_sessions where id=target;
 if s.id is null or not private.has_company_access(s.company_id,true) then
  raise exception using errcode='42501',message='Session unavailable';end if;
 perform private.competency_authority(s.company_id,owner_only);
 select * into s from private.ac_sessions where id=target for update nowait;
 select * into r from public.recruitments where company_id=s.company_id and id=s.recruitment_id for share nowait;
 select * into p from public.positions where company_id=s.company_id and id=r.position_id for share nowait;
 if s.id is null or r.id is null or r.status not in ('draft','open') or p.id is null or p.status='archived' then
  raise exception using errcode='42501',message='Session unavailable';end if;
 return s;
exception when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

-- Every candidate write of an open session: the R13 application lock (candidate, restore
-- configuration, authority, withdrawal markers, live process) + finalist + rule R1.
create function private.ac_session_lock_finalist(target uuid,application uuid) returns private.ac_sessions
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;a public.applications;
begin
 select * into s from private.ac_sessions where id=target;
 if s.id is null or not private.has_company_access(s.company_id,true) then
  raise exception using errcode='42501',message='Session unavailable';end if;
 a:=private.ac_lock_application(application);
 select * into s from private.ac_sessions where id=target and company_id=a.company_id and recruitment_id=a.recruitment_id for share nowait;
 if s.id is null or s.status<>'open' then raise exception using errcode='42501',message='Session unavailable';end if;
 perform 1 from private.ac_session_finalists f where f.session_id=s.id and f.application_id=a.id;
 if not found then raise exception using errcode='42501',message='Session unavailable';end if;
 perform 1 from public.recruitment_shortlist_entries e where e.company_id=a.company_id and e.recruitment_id=a.recruitment_id
  and e.application_id=a.id and e.removed_at is null for share nowait;
 if not found then raise exception using errcode='42501',message='Finalist must be shortlisted';end if;
 return s;
exception when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

-- The OPEN session in which this pair is the assessment of a finalist on a stage; else null.
create function private.ac_pair_open_session(tenant uuid,target_recruitment uuid,application uuid,revision uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select s.id from private.ac_sessions s
 join private.ac_session_stages g on g.session_id=s.id and g.definition_id=revision
 join private.ac_session_finalists f on f.session_id=s.id and f.application_id=application
 where s.company_id=tenant and s.recruitment_id=target_recruitment and s.status='open'
$$;

-- Reconciliation is a session act: open session (held until COMMIT against closing),
-- finalist, and rule R1 again: a person taken off the shortlist gets no new record.
create function private.ac_pair_lock_session(target uuid) returns void
language plpgsql security definer set search_path='' as $$
declare pair private.ac_paired_sheets;found_session uuid;
begin
 select * into pair from private.ac_paired_sheets where id=target;
 found_session:=private.ac_pair_open_session(pair.company_id,pair.recruitment_id,pair.application_id,pair.definition_id);
 perform 1 from private.ac_sessions where id=found_session and status='open' for share nowait;
 if not found then raise exception using errcode='42501',message='Session is not open';end if;
 perform 1 from public.recruitment_shortlist_entries e where e.company_id=pair.company_id and e.recruitment_id=pair.recruitment_id
  and e.application_id=pair.application_id and e.removed_at is null for share nowait;
 if not found then raise exception using errcode='42501',message='Finalist must be shortlisted';end if;
end;$$;

-- Pairs on a session stage belong to the session: the unchanged R13 RPCs (ac_assign_pair,
-- ac_submit_sheet) can create or fill one only for a finalist of an OPEN session. A draft
-- or closed session accepts no pair and no sheet, so a closed report cannot change.
-- Rule R1 holds here too: a finalist taken off the shortlist gets no new pair and no sheet.
-- Revisions that are not a stage of any session keep the plain R13 behaviour.
create function private.ac_session_pair_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;
begin
 if tg_op='INSERT' then
  -- Serializes a new pair against ac_session_add_stage adopting this revision (which
  -- takes FOR UPDATE on the same row): one of the two is told to retry, so a revision
  -- never becomes a stage while a pair on it is being created, in either order.
  perform 1 from public.exercise_definition_entries d where d.id=new.definition_id for share nowait;
 end if;
 select x.* into s from private.ac_session_stages g join private.ac_sessions x on x.id=g.session_id
 where g.company_id=new.company_id and g.recruitment_id=new.recruitment_id and g.definition_id=new.definition_id for share of x nowait;
 if s.id is null then return new;end if;
 if s.status<>'open' or not exists(select 1 from private.ac_session_finalists f where f.session_id=s.id and f.application_id=new.application_id) then
  raise exception using errcode='42501',message='Session is not open';end if;
 perform 1 from public.recruitment_shortlist_entries e where e.company_id=new.company_id and e.recruitment_id=new.recruitment_id
  and e.application_id=new.application_id and e.removed_at is null for share nowait;
 if not found then raise exception using errcode='42501',message='Finalist must be shortlisted';end if;
 return new;
exception when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;
create trigger ac_session_pair_guard before insert or update on private.ac_paired_sheets for each row execute function private.ac_session_pair_guard();

create function public.ac_session_create(recruitment uuid,session_title text,competencies text[]) returns uuid
language plpgsql security definer set search_path='' as $$
declare r public.recruitments;p public.positions;keys text[]:='{}';item text;saved uuid;
begin
 select * into r from public.recruitments where id=recruitment;
 if r.id is null or not private.has_company_access(r.company_id,true) then
  raise exception using errcode='42501',message='Session unavailable';end if;
 perform private.competency_authority(r.company_id,true);
 select * into r from public.recruitments where id=recruitment for share nowait;
 select * into p from public.positions where company_id=r.company_id and id=r.position_id for share nowait;
 if r.id is null or r.status not in ('draft','open') or p.id is null or p.status='archived' then
  raise exception using errcode='42501',message='Session unavailable';end if;
 if session_title is null or private.behavior_trim(session_title)='' or length(session_title)>200
  or competencies is null or cardinality(competencies) not between 1 and 24 or array_ndims(competencies)<>1 then
  raise exception using errcode='22023',message='Invalid session plan';end if;
 foreach item in array competencies loop
  if item is null or length(item)>200 or private.ac_competency_key(item)='' or private.ac_competency_key(item)=any(keys) then
   raise exception using errcode='22023',message='Invalid session plan';end if;
  keys:=keys||private.ac_competency_key(item);
 end loop;
 insert into private.ac_sessions(company_id,recruitment_id,title,planned_competencies,created_by)
 values(r.company_id,r.id,private.behavior_trim(session_title),keys,auth.uid()) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Session already exists';
 when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

create function public.ac_session_add_stage(session uuid,kind text,stage_title text,revision uuid,counterpart text) returns uuid
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;next_ordinal integer;saved uuid;brief text:=nullif(private.behavior_trim(coalesce(counterpart,'')),'');
begin
 s:=private.ac_session_lock(session,true);
 if s.status<>'draft' then raise exception using errcode='PT409',message='Session plan is closed';end if;
 if kind is null or kind not in ('case_study','human_simulation') or stage_title is null or private.behavior_trim(stage_title)=''
  or length(stage_title)>200 or (kind='human_simulation' and (brief is null or length(brief) not between 10 and 2000))
  or (kind='case_study' and brief is not null) then
  raise exception using errcode='22023',message='Invalid stage';end if;
 if not exists(select 1 from public.exercise_definition_entries d where d.id=revision and d.company_id=s.company_id
  and d.recruitment_id=s.recruitment_id and d.definition->>'kind'='assessment_center') then
  raise exception using errcode='42501',message='Session unavailable';end if;
 -- A stage starts without assessments. A revision that already has R13 pairs is refused:
 -- adopting it would close those pairs to their assessors and present assessors chosen
 -- outside the session as the stage pair. FOR UPDATE on the revision excludes a pair
 -- being created right now (the pair guard holds FOR SHARE on the same row).
 perform 1 from public.exercise_definition_entries d where d.id=revision for update nowait;
 if exists(select 1 from private.ac_paired_sheets p where p.definition_id=revision) then
  raise exception using errcode='PT409',message='Stage revision already has assessments';end if;
 select coalesce(max(ordinal),0)+1 into next_ordinal from private.ac_session_stages where session_id=s.id;
 if next_ordinal>8 then raise exception using errcode='PT422',message='Stage limit reached';end if;
 insert into private.ac_session_stages(session_id,company_id,recruitment_id,ordinal,stage_type,title,definition_id,counterpart_brief)
 values(s.id,s.company_id,s.recruitment_id,next_ordinal,kind,private.behavior_trim(stage_title),revision,brief) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Stage revision already used';
 when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

-- A draft plan is corrected by taking back its last stage; stages are never edited in place.
create function public.ac_session_remove_last_stage(session uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;
begin
 s:=private.ac_session_lock(session,true);
 if s.status<>'draft' then raise exception using errcode='PT409',message='Session plan is closed';end if;
 delete from private.ac_session_stages g where g.session_id=s.id
  and g.ordinal=(select max(ordinal) from private.ac_session_stages where session_id=s.id);
 if not found then raise exception using errcode='PT409',message='No stage to remove';end if;
end;$$;

create function public.ac_session_add_finalist(session uuid,application uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;a public.applications;free_slot integer;saved uuid;
begin
 select * into s from private.ac_sessions where id=session;
 if s.id is null or not private.has_company_access(s.company_id,true) then
  raise exception using errcode='42501',message='Session unavailable';end if;
 a:=private.ac_lock_application(application);
 perform private.competency_authority(a.company_id,true);
 -- The session row lock serializes slot allocation; the cap itself is the table constraint.
 select * into s from private.ac_sessions where id=session and company_id=a.company_id and recruitment_id=a.recruitment_id for update nowait;
 if s.id is null or s.status not in ('draft','open') then raise exception using errcode='42501',message='Session unavailable';end if;
 perform 1 from public.recruitment_shortlist_entries e where e.company_id=a.company_id and e.recruitment_id=a.recruitment_id
  and e.application_id=a.id and e.removed_at is null for share nowait;
 if not found then raise exception using errcode='42501',message='Finalist must be shortlisted';end if;
 if exists(select 1 from private.ac_session_finalists where session_id=s.id and application_id=a.id) then
  raise exception using errcode='PT409',message='Finalist already added';end if;
 select min(n) into free_slot from generate_series(1,10) n
  where not exists(select 1 from private.ac_session_finalists f where f.session_id=s.id and f.slot=n);
 if free_slot is null then raise exception using errcode='PT422',message='Finalist limit reached';end if;
 insert into private.ac_session_finalists(session_id,company_id,recruitment_id,application_id,slot,added_by)
 values(s.id,s.company_id,s.recruitment_id,a.id,free_slot,auth.uid()) returning id into saved;
 return saved;
exception when unique_violation or lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

-- A mistaken finalist is taken back only while the session is a draft and nothing was
-- recorded for them; the row guard enforces the same rule below this RPC.
create function public.ac_session_remove_finalist(session uuid,application uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;
begin
 s:=private.ac_session_lock(session,true);
 if s.status<>'draft' then raise exception using errcode='PT409',message='Session plan is closed';end if;
 delete from private.ac_session_finalists f where f.session_id=s.id and f.application_id=application;
 if not found then raise exception using errcode='42501',message='Session unavailable';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

create function public.ac_session_set_status(session uuid,next_status text) returns void
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;
begin
 s:=private.ac_session_lock(session,true);
 if next_status='open' and s.status='draft' then
  -- Stage rows are locked so the plan checked by the table guard is the plan committed.
  perform 1 from private.ac_session_stages where session_id=s.id order by id for share nowait;
  update private.ac_sessions set status='open',opened_by=auth.uid(),opened_at=clock_timestamp() where id=s.id;
 elsif next_status='closed' and s.status='open' then
  update private.ac_sessions set status='closed',closed_by=auth.uid(),closed_at=clock_timestamp() where id=s.id;
 else raise exception using errcode='PT409',message='Session state changed';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

-- One pair per finalist and stage through the unchanged R13 engine.
create function public.ac_session_assign_pair(session uuid,stage uuid,application uuid,first_id uuid,second_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;revision uuid;
begin
 s:=private.ac_session_lock_finalist(session,application);
 perform private.competency_authority(s.company_id,true);
 select definition_id into revision from private.ac_session_stages where session_id=s.id and id=stage;
 if revision is null then raise exception using errcode='42501',message='Session unavailable';end if;
 return public.ac_assign_pair(application,revision,first_id,second_id);
end;$$;

create function public.ac_record_reconciliation(pair_id uuid,decisions jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare seed private.ac_paired_sheets;pair private.ac_paired_sheets;a public.applications;item jsonb;idx integer:=0;
 first_rating text;second_rating text;normalized jsonb:='[]';saved uuid;
begin
 select * into seed from private.ac_paired_sheets where id=pair_id;
 if seed.id is null or auth.uid() is null or auth.uid() not in (seed.first_assessor,seed.second_assessor) then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 a:=private.ac_lock_application(seed.application_id);
 perform private.ac_pair_lock_session(seed.id);
 select * into pair from private.ac_paired_sheets where id=pair_id and company_id=a.company_id for update nowait;
 if pair.id is null or auth.uid() not in (pair.first_assessor,pair.second_assessor) then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 if pair.first_sheet is null or pair.second_sheet is null then
  raise exception using errcode='PT409',message='Both sheets are required';end if;
 if exists(select 1 from private.ac_reconciliations where ac_reconciliations.pair_id=pair.id) then
  raise exception using errcode='PT409',message='Reconciliation already recorded';end if;
 if jsonb_typeof(decisions) is distinct from 'array' or jsonb_array_length(decisions)<>jsonb_array_length(pair.first_sheet) then
  raise exception using errcode='22023',message='Invalid reconciliation';end if;
 for item in select value from jsonb_array_elements(decisions) loop
  first_rating:=pair.first_sheet->idx->>'rating';second_rating:=pair.second_sheet->idx->>'rating';
  if jsonb_typeof(item) is distinct from 'object' or item->'criterionIndex' is distinct from to_jsonb(idx)
   or coalesce(item->>'outcome','') not in ('agreed','discrepancy') then
   raise exception using errcode='22023',message='Invalid reconciliation';end if;
  if item->>'outcome'='agreed' then
   -- An agreed rating is one of the two submitted ratings: nothing is averaged or invented.
   if item-'criterionIndex'-'outcome'-'rating'-'justification'<>'{}'::jsonb
    or jsonb_typeof(item->'rating') is distinct from 'string' or item->>'rating' not in (first_rating,second_rating)
    or jsonb_typeof(item->'justification') is distinct from 'string' or length(item->>'justification')>2000
    or length(private.behavior_trim(item->>'justification'))<10 then
    raise exception using errcode='22023',message='Invalid reconciliation';end if;
   normalized:=normalized||jsonb_build_array(jsonb_build_object('criterionIndex',idx,'outcome','agreed','rating',item->>'rating',
    'justification',private.behavior_trim(item->>'justification'),'firstRating',first_rating,'secondRating',second_rating));
  else
   if item-'criterionIndex'-'outcome'-'note'<>'{}'::jsonb or first_rating=second_rating
    or jsonb_typeof(item->'note') is distinct from 'string' or length(item->>'note')>2000
    or length(private.behavior_trim(item->>'note'))<10 then
    raise exception using errcode='22023',message='Invalid reconciliation';end if;
   normalized:=normalized||jsonb_build_array(jsonb_build_object('criterionIndex',idx,'outcome','discrepancy',
    'note',private.behavior_trim(item->>'note'),'firstRating',first_rating,'secondRating',second_rating));
  end if;
  idx:=idx+1;
 end loop;
 insert into private.ac_reconciliations(pair_id,company_id,recruitment_id,application_id,items,recorded_by)
 values(pair.id,pair.company_id,pair.recruitment_id,pair.application_id,normalized,auth.uid()) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Reconciliation already recorded';
 when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;

create function public.ac_confirm_reconciliation(pair_id uuid,verdict text,note text) returns void
language plpgsql security definer set search_path='' as $$
declare seed private.ac_paired_sheets;pair private.ac_paired_sheets;a public.applications;rec private.ac_reconciliations;
 reason text:=nullif(private.behavior_trim(coalesce(note,'')),'');
begin
 select * into seed from private.ac_paired_sheets where id=pair_id;
 if seed.id is null or auth.uid() is null or auth.uid() not in (seed.first_assessor,seed.second_assessor) then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 a:=private.ac_lock_application(seed.application_id);
 perform private.ac_pair_lock_session(seed.id);
 select * into pair from private.ac_paired_sheets where id=pair_id and company_id=a.company_id for update nowait;
 select * into rec from private.ac_reconciliations r where r.pair_id=pair.id for update nowait;
 if pair.id is null or rec.id is null or auth.uid() not in (pair.first_assessor,pair.second_assessor) or rec.recorded_by=auth.uid() then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 if rec.confirmation is not null then raise exception using errcode='PT409',message='Reconciliation already answered';end if;
 if verdict is null or verdict not in ('confirmed','disputed') or (verdict='confirmed' and reason is not null)
  or (verdict='disputed' and (reason is null or length(reason) not between 10 and 2000)) then
  raise exception using errcode='22023',message='Invalid reconciliation answer';end if;
 update private.ac_reconciliations set confirmation=verdict,confirmed_by=auth.uid(),confirmed_at=clock_timestamp(),dispute_note=reason where id=rec.id;
exception when lock_not_available then raise exception using errcode='PT409',message='Assessment busy';end;$$;

create function public.ac_session_record_entry(session uuid,application uuid,stage uuid,entry_kind text,entry jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;pair private.ac_paired_sheets;revision uuid;saved uuid;clean jsonb;
 has_kind text[];
 field constant jsonb:='{"first_attempt":["work"],"feedback":["feedback"],"revised_attempt":["work"],"change_proof":["changes","evidence","assessment"],"expert_consultation":["note"]}';
 name text;
begin
 s:=private.ac_session_lock_finalist(session,application);
 if entry_kind is null or not field ? entry_kind or jsonb_typeof(entry) is distinct from 'object' then
  raise exception using errcode='22023',message='Invalid entry';end if;
 clean:='{}'::jsonb;
 for name in select jsonb_array_elements_text(field->entry_kind) loop
  if jsonb_typeof(entry->name) is distinct from 'string' then raise exception using errcode='22023',message='Invalid entry';end if;
  clean:=clean||jsonb_build_object(name,private.behavior_trim(entry->>name));
 end loop;
 if entry-array(select jsonb_array_elements_text(field->entry_kind))<>'{}'::jsonb then
  raise exception using errcode='22023',message='Invalid entry';end if;
 if entry_kind='expert_consultation' then
  if stage is not null or length(clean->>'note') not between 10 and 8000 then raise exception using errcode='22023',message='Invalid entry';end if;
 else
  select definition_id into revision from private.ac_session_stages where session_id=s.id and id=stage;
  if revision is null then raise exception using errcode='42501',message='Session unavailable';end if;
  select array_agg(e.kind) into has_kind from private.ac_session_entries e where e.session_id=s.id and e.application_id=application and e.session_stage_id=stage;
  has_kind:=coalesce(has_kind,'{}');
  if entry_kind=any(has_kind) then raise exception using errcode='PT409',message='Entry already recorded';end if;
  select * into pair from private.ac_paired_sheets p where p.application_id=application and p.definition_id=revision for share nowait;
  if entry_kind in ('first_attempt','revised_attempt') then
   if length(clean->>'work') not between 20 and 20000 then raise exception using errcode='22023',message='Invalid entry';end if;
   if entry_kind='revised_attempt' and not 'feedback'=any(has_kind) then
    raise exception using errcode='PT409',message='Earlier step required';end if;
  else
   -- Feedback and the proof of change are assessor records, made only after both
   -- independent sheets exist, so neither can leak or steer a pending assessment.
   if pair.id is null or auth.uid() not in (pair.first_assessor,pair.second_assessor) then
    raise exception using errcode='42501',message='Assessor required';end if;
   if pair.first_sheet is null or pair.second_sheet is null
    or (entry_kind='feedback' and not 'first_attempt'=any(has_kind))
    or (entry_kind='change_proof' and not 'revised_attempt'=any(has_kind)) then
    raise exception using errcode='PT409',message='Earlier step required';end if;
   if entry_kind='feedback' then
    if length(clean->>'feedback') not between 20 and 8000 then raise exception using errcode='22023',message='Invalid entry';end if;
   elsif clean->>'assessment' not in ('change_confirmed','change_partial','no_change_observed','insufficient_data')
    or length(clean->>'changes') not between 20 and 8000 or length(clean->>'evidence')>4000
    or (clean->>'assessment'='insufficient_data' and clean->>'evidence'<>'')
    or (clean->>'assessment'<>'insufficient_data' and length(clean->>'evidence')<10) then
    raise exception using errcode='22023',message='Invalid entry';end if;
  end if;
 end if;
 insert into private.ac_session_entries(session_id,company_id,recruitment_id,application_id,session_stage_id,kind,body,author_id)
 values(s.id,s.company_id,s.recruitment_id,application,stage,entry_kind,clean,auth.uid()) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Entry already recorded';
 when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

create function public.ac_session_find(recruitment uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select s.id from private.ac_sessions s where s.recruitment_id=recruitment and private.has_company_access(s.company_id,true)
$$;

-- One authorized read model. Sheets and their reconciliation appear only after BOTH
-- sheets are submitted, and only for the two assessors or the owner (the R13 rule).
-- Frozen or isolated candidates are omitted entirely. No score, rank or hiring decision.
create function public.ac_session_read(session uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s private.ac_sessions;owner boolean;
begin
 select * into s from private.ac_sessions where id=session;
 if s.id is null or auth.uid() is null or not private.has_company_access(s.company_id,true) then
  raise exception using errcode='42501',message='Session unavailable';end if;
 owner:=private.is_company_owner(s.company_id);
 return jsonb_build_object(
  'session',jsonb_build_object('id',s.id,'recruitmentId',s.recruitment_id,'title',s.title,'status',s.status,
   'plannedCompetencies',to_jsonb(s.planned_competencies),'uncoveredCompetencies',to_jsonb(private.ac_session_uncovered(s.id)),
   'createdAt',s.created_at,'openedAt',s.opened_at,'closedAt',s.closed_at,'finalistLimit',10,'recommendedFinalists',jsonb_build_array(5,6)),
  'stages',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'ordinal',g.ordinal,'type',g.stage_type,'title',g.title,
    'definitionId',g.definition_id,'definition',d.definition,'counterpartBrief',g.counterpart_brief) order by g.ordinal)
   from private.ac_session_stages g join public.exercise_definition_entries d on d.id=g.definition_id where g.session_id=s.id),'[]'::jsonb),
  'finalists',coalesce((select jsonb_agg(jsonb_build_object('applicationId',f.application_id,'slot',f.slot,'textHidden',h.hidden,
    'expertNotes',coalesce((select jsonb_agg(jsonb_build_object('note',e.body->>'note','authorId',e.author_id,'createdAt',e.created_at) order by e.created_at,e.id)
     from private.ac_session_entries e where not h.hidden and e.session_id=s.id and e.application_id=f.application_id and e.kind='expert_consultation'),'[]'::jsonb),
    'stages',coalesce((select jsonb_agg(jsonb_build_object('stageId',g.id,
      'entries',coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'body',e.body,'authorId',e.author_id,'createdAt',e.created_at) order by e.created_at,e.id)
       from private.ac_session_entries e where (not h.hidden or e.kind in ('first_attempt','revised_attempt'))
        and e.session_id=s.id and e.application_id=f.application_id and e.session_stage_id=g.id),'[]'::jsonb),
      'pair',case
       when p.id is null then jsonb_build_object('state','unassigned')
       when not (owner or auth.uid() in (p.first_assessor,p.second_assessor)) then jsonb_build_object('state','restricted')
       when p.first_sheet is null or p.second_sheet is null then jsonb_build_object('state','pending','pairId',p.id,
        'ownSubmitted',case auth.uid() when p.first_assessor then p.first_sheet is not null when p.second_assessor then p.second_sheet is not null end)
       else jsonb_build_object('state','ready','pairId',p.id,'definitionId',p.definition_id,'sheets',jsonb_build_array(
        jsonb_build_object('authorId',p.first_assessor,'submittedAt',p.first_submitted_at,'observations',p.first_sheet),
        jsonb_build_object('authorId',p.second_assessor,'submittedAt',p.second_submitted_at,'observations',p.second_sheet)),
        'reconciliation',(select jsonb_build_object('items',c.items,'recordedBy',c.recorded_by,'recordedAt',c.recorded_at,
          'confirmation',c.confirmation,'confirmedBy',c.confirmed_by,'confirmedAt',c.confirmed_at,'disputeNote',c.dispute_note)
         from private.ac_reconciliations c where c.pair_id=p.id)) end) order by g.ordinal)
     from private.ac_session_stages g
     left join private.ac_paired_sheets p on p.application_id=f.application_id and p.definition_id=g.definition_id
     where g.session_id=s.id),'[]'::jsonb)) order by f.slot)
   from private.ac_session_finalists f join public.applications a on a.id=f.application_id and a.company_id=f.company_id
   -- Text written by assessors and experts (feedback, proof of change, expert notes) could
   -- carry a rating. A caller who still owes an independent sheet for this finalist gets none
   -- of it until that sheet is submitted. The candidate's own work (first and revised
   -- attempt) is never withheld: an assessor must read it to assess the stage.
   cross join lateral (select exists(select 1 from private.ac_session_stages g
     join private.ac_paired_sheets p on p.application_id=f.application_id and p.definition_id=g.definition_id
     where g.session_id=s.id and ((p.first_assessor=auth.uid() and p.first_sheet is null)
      or (p.second_assessor=auth.uid() and p.second_sheet is null))) hidden) h
   where f.session_id=s.id and private.candidate_workflow_visible(f.company_id,a.candidate_id)),'[]'::jsonb));
end;$$;
