-- SC-AC-SESSION (#276): AC session, coverage plan, finalists, reconciliation, second attempt
-- + erasure inventory R16. Generated offline by scripts/sc-ac-session-compose.mjs, pinned to
-- reviewed R13 (pair engine, adapters, purge engine) and R15 (readers).
-- Three candidate-linked tables, two configuration tables. No service, preview flag or production activation.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r15') is null then raise exception 'acs_requires_r15' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r16') is not null or to_regclass('private.ac_sessions') is not null then
  raise exception 'acs_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r15 where singleton and schema_signature='1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44')
  or private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
  raise exception 'acs_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r15 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'acs_source_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_inventory_rows(uuid,uuid[])'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9f7edcf5d0b3fefca54e032992f7d1b778d22b855e193daf759ea51a68850d2f'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'acs_source_function_unreviewed:private.erasure_inventory_rows' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_row_candidates(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='654764eaa73493ea5091238a1c582d358bb2e30c3872aa9bdf1a03e26adf8fe9'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'acs_source_function_unreviewed:private.erasure_row_candidates' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_engine(uuid,bigint,boolean)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='13a9fb369b2ffa93895f33abd6f5f97adb0fac56d0d6954900e0d999b20db3bd'
  and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{erasure_purge_owner=X/erasure_purge_owner}') then
  raise exception 'acs_source_function_unreviewed:private.erasure_purge_engine' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.preview_candidate_erasure(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='5a0552e8203957f729c7e55e2153b9ad6b2d3abe989c3582b7800035d6e48ba8'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'acs_source_function_unreviewed:public.preview_candidate_erasure' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.prepare_erasure_purge_manifest(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='338e96d30b5209cb04ee906c4e620473dc4c6b6225f00eb47126d30a1d7533ad'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'acs_source_function_unreviewed:private.prepare_erasure_purge_manifest' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.authorize_retention_suggestion(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3bd543b182e3ed28f6df28570cde142cc6f0f746d4abbe22923d489af105d4fe'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'acs_source_function_unreviewed:private.authorize_retention_suggestion' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.get_retention_schedule(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='cdf8bb12156af9d7dce48deeb2102dd2a86fdd27550a0376fea870dff8fef4d3'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'acs_source_function_unreviewed:public.get_retention_schedule' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.ac_lock_application(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='6fcdbf800f23a268dbdd5c8e1c76213964a09cfc99a65767351cbdc915cf6f64') then
  raise exception 'acs_source_function_unreviewed:private.ac_lock_application' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.ac_assign_pair(uuid,uuid,uuid,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='27dc900372491f08f71f5c50bfc4fe62403b3265ea20b7dcfffbbd05e4f7f418') then
  raise exception 'acs_source_function_unreviewed:public.ac_assign_pair' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.ac_submit_sheet(uuid,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='a44366ff57b847e5c73c705e4e289dc130e1940deafe8a15487e22e195e4a6a7') then
  raise exception 'acs_source_function_unreviewed:public.ac_submit_sheet' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.ac_sheet_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9a300fb065f1bf0226dd45b8ab7a5467d8c07eeda73ea7703275be3c01484865') then
  raise exception 'acs_source_function_unreviewed:private.ac_sheet_guard' using errcode='55000';end if;
 if to_regprocedure('private.erasure_inventory_rows_r15(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r15(text,jsonb)') is not null then
  raise exception 'acs_adapter_name_taken' using errcode='55000';end if;
end $preflight$;

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
-- Revisions that are not a stage of any session keep the plain R13 behaviour.
create function private.ac_session_pair_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;
begin
 select x.* into s from private.ac_session_stages g join private.ac_sessions x on x.id=g.session_id
 where g.company_id=new.company_id and g.recruitment_id=new.recruitment_id and g.definition_id=new.definition_id for share of x nowait;
 if s.id is null then return new;end if;
 if s.status<>'open' or not exists(select 1 from private.ac_session_finalists f where f.session_id=s.id and f.application_id=new.application_id) then
  raise exception using errcode='42501',message='Session is not open';end if;
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
 select coalesce(max(ordinal),0)+1 into next_ordinal from private.ac_session_stages where session_id=s.id;
 if next_ordinal>8 then raise exception using errcode='PT422',message='Stage limit reached';end if;
 insert into private.ac_session_stages(session_id,company_id,recruitment_id,ordinal,stage_type,title,definition_id,counterpart_brief)
 values(s.id,s.company_id,s.recruitment_id,next_ordinal,kind,private.behavior_trim(stage_title),revision,brief) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Stage revision already used';end;$$;

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
       from private.ac_session_entries e where not h.hidden and e.session_id=s.id and e.application_id=f.application_id and e.session_stage_id=g.id),'[]'::jsonb),
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
   -- Free text (work, feedback, expert notes) could carry a rating. A caller who still owes
   -- an independent sheet for this finalist gets none of it until that sheet is submitted.
   cross join lateral (select exists(select 1 from private.ac_session_stages g
     join private.ac_paired_sheets p on p.application_id=f.application_id and p.definition_id=g.definition_id
     where g.session_id=s.id and ((p.first_assessor=auth.uid() and p.first_sheet is null)
      or (p.second_assessor=auth.uid() and p.second_sheet is null))) hidden) h
   where f.session_id=s.id and private.candidate_workflow_visible(f.company_id,a.candidate_id)),'[]'::jsonb));
end;$$;



alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r15;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r15;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;
begin
 if adapter in ('private.ac_session_entries','private.ac_reconciliations','private.ac_session_finalists') then
  select a.candidate_id into subject from public.applications a where a.id=(data->>'application_id')::uuid
   and a.company_id=(data->>'company_id')::uuid and a.recruitment_id=(data->>'recruitment_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown AC session candidate dependency';end if;
  return array[subject];
 end if;
 return private.erasure_row_candidates_r15(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r15(tenant,subjects)
 union all
 select 'private.ac_session_entries',t.id::text,to_jsonb(t) from private.ac_session_entries t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id and a.recruitment_id=t.recruitment_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
 union all
 select 'private.ac_reconciliations',t.id::text,to_jsonb(t) from private.ac_reconciliations t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id and a.recruitment_id=t.recruitment_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
 union all
 select 'private.ac_session_finalists',t.id::text,to_jsonb(t) from private.ac_session_finalists t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id and a.recruitment_id=t.recruitment_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
$$;
create table private.erasure_inventory_baseline_r16 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r16 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r16
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r16 select true,'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8',
 known_tables||array['private.ac_sessions','private.ac_session_stages','private.ac_session_finalists','private.ac_reconciliations','private.ac_session_entries','private.erasure_inventory_baseline_r16']
 from private.erasure_inventory_baseline_r15 where singleton;


create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r16;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 if scope_kind is null or scope_kind not in ('candidate_record','confirmed_subject')
 or (scope_kind='candidate_record' and resolution_id is not null) or (scope_kind='confirmed_subject' and resolution_id is null)
 then raise exception using errcode='PT422',message='Invalid preview scope';end if;
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then
  select * into r from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant and anchor_candidate_id=target_candidate;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  subjects:=r.candidate_ids;
  if r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate)
   or r.confirmed_by<>auth.uid() then blockers:=array_append(blockers,'subject_resolution_changed');end if;
  if cardinality(subjects)<>(select count(*) from public.candidates where company_id=tenant and id=any(subjects)) then
   blockers:=array_append(blockers,'subject_resolution_changed');end if;
 else blockers:=array_append(blockers,'subject_resolution_required');end if;
 select * into p from private.candidate_retention_policies where company_id=tenant order by revision desc limit 1;
 if p.id is null then blockers:=array_append(blockers,'retention_policy_required');
 elsif jsonb_array_length(p.rules)<8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 if p.id is not null and p.approved_by<>auth.uid() then blockers:=array_append(blockers,'policy_owner_changed');end if;
 select * into baseline from private.erasure_inventory_baseline_r16 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  -- Preserve the R4-VOICE preview denial as well as its purge/restore adapters.
  -- The legacy R4 fixture has no voice module; SQL in this branch is planned
  -- only when the reviewed voice helper exists.
  if to_regprocedure('private.erasure_voice_request_candidate(uuid,text,uuid)') is not null then
    if exists(select 1 from private.voice_plan_request_keys t where t.company_id=tenant
      and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null)
    then blockers:=array_append(blockers,'voice_request_adapter_unknown');end if;
  end if;
  if exists(select 1 from private.contact_requests t where t.company_id=tenant
   and private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id) is null) then blockers:=array_append(blockers,'contact_request_adapter_unknown');end if;
  if exists(select 1 from public.screening_analysis_versions a join public.applications ap on ap.company_id=a.company_id and ap.id=a.application_id
   where ap.company_id=tenant and ap.candidate_id=any(subjects) and a.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
  if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.candidate_ids && subjects and not sr.candidate_ids <@ subjects)
   then blockers:=array_append(blockers,'shared_resolution_requires_adapter');end if;
  if exists(select 1 from private.competency_test_cancellations c where c.company_id=tenant
   and private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) && subjects
   and not private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) <@ subjects)
   then blockers:=array_append(blockers,'shared_competency_cancellation_requires_adapter');end if;
  with rows as materialized(select * from private.erasure_inventory_rows(tenant,subjects)),
  grouped as(select adapter,count(*) n from rows group by adapter)
  select coalesce((select jsonb_object_agg(adapter,n) from grouped),'{}'::jsonb),
   coalesce((select jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key) from rows),'[]'::jsonb)
  into counts,row_digest;
 end if;
 manifest:=private.erasure_hash(jsonb_build_object('contract','sc010-r1-v1','tenant',tenant,'owner',auth.uid(),'scope',scope_kind,'subjects',subjects,
 'resolution',to_jsonb(r),'current_resolution_revision',(select coalesce(max(revision),0) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate),
 'policy',to_jsonb(p),'schema',signature,'rows',row_digest,'blockers',blockers));
 return jsonb_build_object('scope_kind',scope_kind,'candidate_count',cardinality(subjects),'counts',counts,'blockers',to_jsonb(blockers),
 'policy_revision',coalesce(p.revision,0),'resolution_revision',coalesce(r.revision,0),'manifest_hash',manifest,'schema_signature',signature,
 'generated_at',generated,'expires_at',generated+interval '5 minutes','execution_enabled',false);
end;$$;

create or replace function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R4 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r16 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;

create or replace function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r16 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,d.id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash'<>s.evidence_hash then raise exception using errcode='PT409',message='Retention eligibility changed';end if;
 if exists(select 1 from unnest(s.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 select * into r from private.erasure_subject_resolutions where id=s.resolution_id;
 -- Fixed graph checks, with unknown schema/JSON/dependencies rejected by the R3 adapter before commit.
 if exists(select 1 from private.contact_requests c where c.company_id=s.company_id and private.erasure_contact_request_candidate(c.company_id,c.operation,c.payload,c.result_id) is null) then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,'confirmed_subject',r.id,s.candidate_ids,s.evidence_hash,private.erasure_generation_snapshot(s.candidate_ids),issued,issued+interval '5 minutes') returning id into ticket;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,s.candidate_ids,'confirmed_subject',ticket,s.evidence_hash,d.policy_revision,r.revision,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,s.company_id,1,'frozen',result from unnest(s.candidate_ids) x(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 authz:=jsonb_build_object('kind','retention_policy','actor_id',d.owner_id,'delegation_id',d.id,'activation_revision',d.revision,'policy_revision',d.policy_revision,'due_generation',s.due_generation,'due_at',s.due_at,'evidence_hash',s.evidence_hash);
 insert into private.retention_authorizations(request_id,authorization_json) values(result,authz);
 update private.retention_suggestions set status='authorized',request_id=result,blockers='[]'::jsonb where id=s.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(s.company_id,result,d.owner_id,'authorized',1);
 -- Reuse the complete reviewed R3 scope validator inside this transaction. This
 -- temporary non-exportable execution never receives a reservation or ledger ACK.
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
 select result,s.company_id,s.candidate_ids,'confirmed_subject',d.owner_id,jsonb_build_object('revision',p2.revision,'rules',p2.rules),r.revision,1,'authorized',clock_timestamp()+interval '1 second'
 from private.candidate_retention_policies p2 where p2.id=d.policy_id;
 perform private.erasure_check_purge_scope(result);
 delete from private.erasure_executions where request_id=result;
 return result;
end;$$;

create or replace function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;p private.candidate_retention_policies;schema_ok boolean;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r16 where singleton);
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),
 'authorization_enabled',coalesce(schema_ok and not d.revoked and d.execution_mode='automatic' and d.owner_id=auth.uid() and d.policy_id=p.id and d.policy_revision=p.revision and p.approved_by=auth.uid()
  and c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated,false),
 'production_ready',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end || case when schema_ok then '[]'::jsonb else jsonb_build_array('schema_dependency_unknown') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;

-- PG16+ non-superuser creators retain ADMIN only. Ownership transfers need
-- SET plus schema CREATE, confined to this transaction and restored below.
create temporary table sc010_purge_migration_access on commit drop as
 select (select rolsuper from pg_roles where rolname=current_user) superuser,
   (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    from pg_auth_members m where m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole) memberships,
   (select nspacl from pg_namespace where nspname='private') schema_acl;
do $$begin
 if current_user<>session_user then raise exception 'Migration identity must be direct';end if;
 if has_schema_privilege('erasure_purge_owner','private','CREATE') then
   raise exception 'Unsafe purge owner schema privileges';
 end if;
 if not (select superuser from pg_temp.sc010_purge_migration_access) then
   if current_user<>'postgres' or exists(select 1 from pg_auth_members m
     where (m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole)
       and not (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid='erasure_purge_owner'::regrole and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option)) or not exists(select 1 from pg_auth_members m where (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid='erasure_purge_owner'::regrole and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option)) then
     raise exception 'Unsafe purge owner migration membership';
   end if;
   grant erasure_purge_owner to postgres with admin false, inherit false, set true;
 end if;
 grant create on schema private to erasure_purge_owner;
end;$$;



set local role erasure_purge_owner;
create or replace function private.erasure_purge_engine(target_request uuid,expected_sequence bigint,restoring boolean) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;receipt uuid;c record;deleted_count bigint;expected_count bigint;deleted_counts jsonb:='{}';event_row public.candidate_communication_events;begin
 perform private.erasure_validate_purge(target_request,expected_sequence,restoring);
 select * into e from private.erasure_executions where request_id=target_request;
 if e.local_purged then return jsonb_build_object('receipt_id',e.receipt_id,'phase','active_data_erased','counts',e.counts);end if;
 insert into private.erasure_purge_context values(txid_current(),e.request_id,e.company_id,e.manifest_hash,'cancel');
 insert into private.erasure_purge_context_rows select txid_current(),adapter,row_key,row_hash,'delete' from private.erasure_purge_manifest where request_id=e.request_id and manifest_hash=e.manifest_hash;
 -- The authoritative erasing ACK precedes the first irreversible cancellation.
 for c in select * from public.candidate_communications where state='draft' loop
  update public.candidate_communications set state='cancelled',version=version+1,cancelled_at=now(),updated_at=now() where id=c.id;
  update private.erasure_purge_context_rows set row_hash=(select private.erasure_hash(to_jsonb(x)) from public.candidate_communications x where x.id=c.id) where txid=txid_current() and adapter='public.candidate_communications' and row_key=c.id::text;
  event_row:=row(gen_random_uuid(),e.company_id,c.id,'cancelled',e.owner_id,now())::public.candidate_communication_events;
  insert into private.erasure_purge_context_rows values(txid_current(),'public.candidate_communication_events',event_row.id::text,private.erasure_hash(to_jsonb(event_row)),'insert');
  insert into public.candidate_communication_events select event_row.*;
  update private.erasure_purge_context_rows set command='delete' where txid=txid_current() and adapter='public.candidate_communication_events' and row_key=event_row.id::text;
 end loop;
 update private.erasure_purge_context set mode='delete' where txid=txid_current();
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_session_entries';
 delete from private.ac_session_entries t where private.erasure_purge_allowed('private.ac_session_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_session_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_reconciliations';
 delete from private.ac_reconciliations t where private.erasure_purge_allowed('private.ac_reconciliations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_reconciliations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_session_finalists';
 delete from private.ac_session_finalists t where private.erasure_purge_allowed('private.ac_session_finalists',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_session_finalists',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_paired_sheets';
 delete from private.ac_paired_sheets t where private.erasure_purge_allowed('private.ac_paired_sheets',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_paired_sheets',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_drafts';
 delete from private.competency_test_drafts t where private.erasure_purge_allowed('private.competency_test_drafts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_drafts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.competency_test_review_entries';
 delete from public.competency_test_review_entries t where private.erasure_purge_allowed('public.competency_test_review_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.competency_test_review_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_sessions';
 delete from private.competency_test_sessions t where private.erasure_purge_allowed('private.competency_test_sessions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_sessions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_grant_events';
 delete from private.competency_test_grant_events t where private.erasure_purge_allowed('private.competency_test_grant_events',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_grant_events',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.competency_test_attempts';
 delete from public.competency_test_attempts t where private.erasure_purge_allowed('public.competency_test_attempts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.competency_test_attempts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_grants';
 delete from private.competency_test_grants t where private.erasure_purge_allowed('private.competency_test_grants',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_grants',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.competency_test_cancellations';
 delete from private.competency_test_cancellations t where private.erasure_purge_allowed('private.competency_test_cancellations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.competency_test_cancellations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.retention_suggestions';
 delete from private.retention_suggestions t where private.erasure_purge_allowed('private.retention_suggestions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.retention_suggestions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.retention_candidate_clocks';
 delete from private.retention_candidate_clocks t where private.erasure_purge_allowed('private.retention_candidate_clocks',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.retention_candidate_clocks',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.contact_requests';
 delete from private.contact_requests t where private.erasure_purge_allowed('private.contact_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.contact_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_communication_approvals';
 delete from public.candidate_communication_approvals t where private.erasure_purge_allowed('public.candidate_communication_approvals',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_communication_approvals',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_communication_events';
 delete from public.candidate_communication_events t where private.erasure_purge_allowed('public.candidate_communication_events',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_communication_events',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_communications';
 delete from public.candidate_communications t where private.erasure_purge_allowed('public.candidate_communications',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_communications',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.candidate_verified_contact_receipts';
 delete from private.candidate_verified_contact_receipts t where private.erasure_purge_allowed('private.candidate_verified_contact_receipts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.candidate_verified_contact_receipts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.candidate_verified_contact_points';
 delete from private.candidate_verified_contact_points t where private.erasure_purge_allowed('private.candidate_verified_contact_points',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.candidate_verified_contact_points',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_contact_permissions';
 delete from public.candidate_contact_permissions t where private.erasure_purge_allowed('public.candidate_contact_permissions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_contact_permissions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_contact_preferences';
 delete from public.candidate_contact_preferences t where private.erasure_purge_allowed('public.candidate_contact_preferences',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_contact_preferences',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.contact_audit';
 delete from private.contact_audit t where private.erasure_purge_allowed('private.contact_audit',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.contact_audit',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.recruitment_shortlist_entries';
 delete from public.recruitment_shortlist_entries t where private.erasure_purge_allowed('public.recruitment_shortlist_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.recruitment_shortlist_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_criterion_review_overrides';
 delete from public.screening_criterion_review_overrides t where private.erasure_purge_allowed('public.screening_criterion_review_overrides',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_criterion_review_overrides',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_result_reviews';
 delete from public.screening_result_reviews t where private.erasure_purge_allowed('public.screening_result_reviews',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_result_reviews',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_criterion_results';
 delete from public.screening_criterion_results t where private.erasure_purge_allowed('public.screening_criterion_results',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_criterion_results',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_analysis_attempts';
 delete from public.screening_analysis_attempts t where private.erasure_purge_allowed('public.screening_analysis_attempts',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_analysis_attempts',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.screening_analysis_versions';
 delete from public.screening_analysis_versions t where private.erasure_purge_allowed('public.screening_analysis_versions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.screening_analysis_versions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.exercise_observation_entries';
 delete from public.exercise_observation_entries t where private.erasure_purge_allowed('public.exercise_observation_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.exercise_observation_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.behavior_assessment_entries';
 delete from public.behavior_assessment_entries t where private.erasure_purge_allowed('public.behavior_assessment_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.behavior_assessment_entries',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_assessments';
 delete from public.candidate_assessments t where private.erasure_purge_allowed('public.candidate_assessments',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_assessments',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_configuration_requests';
 delete from private.erasure_configuration_requests t where private.erasure_purge_allowed('private.erasure_configuration_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_configuration_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_holds';
 delete from private.erasure_holds t where private.erasure_purge_allowed('private.erasure_holds',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_holds',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_lifecycle_commands';
 delete from private.erasure_lifecycle_commands t where private.erasure_purge_allowed('private.erasure_lifecycle_commands',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_lifecycle_commands',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_lifecycle_events';
 delete from private.erasure_lifecycle_events t where private.erasure_purge_allowed('private.erasure_lifecycle_events',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_lifecycle_events',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_candidate_lifecycle';
 delete from private.erasure_candidate_lifecycle t where private.erasure_purge_allowed('private.erasure_candidate_lifecycle',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_candidate_lifecycle',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_requests';
 delete from private.erasure_requests t where private.erasure_purge_allowed('private.erasure_requests',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_requests',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_preview_tickets';
 delete from private.erasure_preview_tickets t where private.erasure_purge_allowed('private.erasure_preview_tickets',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_preview_tickets',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_subject_resolutions';
 delete from private.erasure_subject_resolutions t where private.erasure_purge_allowed('private.erasure_subject_resolutions',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_subject_resolutions',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.erasure_denial_context';
 delete from private.erasure_denial_context t where private.erasure_purge_allowed('private.erasure_denial_context',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.erasure_denial_context',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.applications';
 delete from public.applications t where private.erasure_purge_allowed('public.applications',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.applications',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidate_documents';
 delete from public.candidate_documents t where private.erasure_purge_allowed('public.candidate_documents',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidate_documents',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.candidates';
 delete from public.candidates t where private.erasure_purge_allowed('public.candidates',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('public.candidates',deleted_count);

 insert into private.erasure_receipts(company_id,policy_revision,phase,counts) values(e.company_id,(e.policy_copy->>'revision')::bigint,'active_data_erased',deleted_counts) returning id into receipt;
 update private.erasure_executions set local_purged=true,receipt_id=receipt,counts=deleted_counts where request_id=e.request_id;
 delete from private.erasure_purge_manifest where request_id=e.request_id;
 delete from private.erasure_purge_context_rows where txid=txid_current();
 delete from private.erasure_purge_context where txid=txid_current();
 return jsonb_build_object('receipt_id',receipt,'phase','active_data_erased','counts',deleted_counts);
exception when lock_not_available then
 raise exception using errcode='PT409',message='Erasure source busy';
end;$$;
reset role;
do $$begin
 revoke create on schema private from erasure_purge_owner;
 if not (select superuser from pg_temp.sc010_purge_migration_access) then
   revoke erasure_purge_owner from postgres granted by postgres;
 end if;
 if (select nspacl from pg_namespace where nspname='private') is distinct from
      (select schema_acl from pg_temp.sc010_purge_migration_access) or
   has_schema_privilege('erasure_purge_owner','private','CREATE') or
   (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    from pg_auth_members m where m.roleid='erasure_purge_owner'::regrole or m.member='erasure_purge_owner'::regrole)
      is distinct from (select memberships from pg_temp.sc010_purge_migration_access) then
   raise exception 'Purge migration privileges not restored';
 end if;
end;$$;






-- Remove hostile default ACLs on every new table and function, then grant
-- only the public session RPCs and the existing manifest-checked purge role.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('private.ac_sessions'::regclass,'private.ac_session_stages'::regclass,'private.ac_session_finalists'::regclass,'private.ac_reconciliations'::regclass,'private.ac_session_entries'::regclass,'private.erasure_inventory_baseline_r16'::regclass) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.ac_competency_key(text)',
  'private.ac_session_uncovered(uuid)',
  'private.ac_session_config_guard()',
  'private.ac_session_row_guard()',
  'private.ac_session_pair_guard()',
  'private.ac_pair_open_session(uuid,uuid,uuid,uuid)',
  'private.ac_pair_lock_session(uuid)',
  'private.ac_session_lock(uuid,boolean)',
  'private.ac_session_lock_finalist(uuid,uuid)',
  'private.erasure_row_candidates(text,jsonb)',
  'private.erasure_inventory_rows(uuid,uuid[])',
  'public.ac_session_create(uuid,text,text[])',
  'public.ac_session_add_stage(uuid,text,text,uuid,text)',
  'public.ac_session_remove_last_stage(uuid)',
  'public.ac_session_add_finalist(uuid,uuid)',
  'public.ac_session_remove_finalist(uuid,uuid)',
  'public.ac_session_set_status(uuid,text)',
  'public.ac_session_assign_pair(uuid,uuid,uuid,uuid,uuid)',
  'public.ac_record_reconciliation(uuid,jsonb)',
  'public.ac_confirm_reconciliation(uuid,text,text)',
  'public.ac_session_record_entry(uuid,uuid,uuid,text,jsonb)',
  'public.ac_session_find(uuid)',
  'public.ac_session_read(uuid)']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant execute on function public.ac_session_create(uuid,text,text[]),
 public.ac_session_add_stage(uuid,text,text,uuid,text),
 public.ac_session_remove_last_stage(uuid),
 public.ac_session_add_finalist(uuid,uuid),
 public.ac_session_remove_finalist(uuid,uuid),
 public.ac_session_set_status(uuid,text),
 public.ac_session_assign_pair(uuid,uuid,uuid,uuid,uuid),
 public.ac_record_reconciliation(uuid,jsonb),
 public.ac_confirm_reconciliation(uuid,text,text),
 public.ac_session_record_entry(uuid,uuid,uuid,text,jsonb),
 public.ac_session_find(uuid),
 public.ac_session_read(uuid) to authenticated;
grant select,delete on private.ac_session_entries,private.ac_reconciliations,private.ac_session_finalists to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from 'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8' then
  raise exception 'acs_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r16 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'acs_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-5])([^0-9]|$)') then
  raise exception 'acs_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r16%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'acs_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r15(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r15(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'acs_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table.
 if exists(select 1 from pg_class c cross join (values('anon'),('authenticated')) r(name)
  where c.oid in ('private.ac_sessions'::regclass,'private.ac_session_stages'::regclass,'private.ac_session_finalists'::regclass,'private.ac_reconciliations'::regclass,'private.ac_session_entries'::regclass)
  and (not c.relrowsecurity or has_table_privilege(r.name,c.oid,'select,insert,update,delete'))) then
  raise exception 'acs_table_exposed' using errcode='55000';end if;
end $postflight$;
commit;
