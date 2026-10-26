begin;
-- Step 3: evidence-only contract. Reuses positions, candidates, applications,
-- reviewed candidate_documents, and existing company membership/RLS helpers.
-- organization_id is the tenant identifier; it references companies.id.
create table public.evidence_analysis (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.companies(id) on delete cascade,
  candidate_id uuid not null,
  position_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  document_id uuid not null,
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  model text not null check (length(model) between 1 and 160),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  requirements_snapshot jsonb not null check (jsonb_typeof(requirements_snapshot) = 'array'),
  materials_snapshot jsonb not null check (jsonb_typeof(materials_snapshot) = 'array'),
  materials_snapshot_hash text not null check (materials_snapshot_hash ~ '^[0-9a-f]{64}$'),
  failure_message text check (failure_message is null or length(failure_message) <= 2000),
  unique (organization_id,id),
  foreign key (organization_id,candidate_id) references public.candidates(company_id,id) on delete cascade,
  foreign key (organization_id,position_id) references public.positions(company_id,id) on delete restrict,
  foreign key (organization_id,document_id) references public.candidate_documents(company_id,id) on delete cascade,
  foreign key (organization_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete cascade
);
create index evidence_analysis_history_idx on public.evidence_analysis(organization_id,application_id,created_at desc);
create unique index evidence_analysis_active_idx on public.evidence_analysis(organization_id,application_id)
  where status in ('pending','running');

create table public.evidence_item (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  analysis_id uuid not null,
  requirement_key text not null check (length(requirement_key) between 1 and 100),
  verdict text not null check (verdict in ('supported','partial','missing','contradicted')),
  evidence_quotes jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_quotes) = 'array'),
  missing_info text not null default '' check (length(missing_info) <= 2000),
  suggested_question text not null default '' check (length(suggested_question) <= 2000),
  human_status text not null default 'unreviewed'
    check (human_status in ('unreviewed','accepted','rejected','edited')),
  human_note text not null default '' check (length(human_note) <= 3000),
  human_verdict text check (human_verdict in ('supported','partial','missing','contradicted')),
  human_missing_info text check (human_missing_info is null or length(human_missing_info) <= 2000),
  human_question text check (human_question is null or length(human_question) <= 2000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id,analysis_id,requirement_key),
  foreign key (organization_id,analysis_id) references public.evidence_analysis(organization_id,id) on delete cascade
);
create index evidence_item_analysis_idx on public.evidence_item(organization_id,analysis_id);

alter table public.evidence_analysis enable row level security;
alter table public.evidence_item enable row level security;
revoke all on public.evidence_analysis, public.evidence_item from public,anon,authenticated;
grant select on public.evidence_analysis, public.evidence_item to authenticated;
grant update (human_status,human_note,human_verdict,human_missing_info,human_question)
  on public.evidence_item to authenticated;

create policy evidence_analysis_read on public.evidence_analysis for select to authenticated
  using (private.has_company_access(organization_id));
create policy evidence_item_read on public.evidence_item for select to authenticated
  using (private.has_company_access(organization_id));
create policy evidence_item_human_update on public.evidence_item for update to authenticated
  using (private.has_company_access(organization_id,true))
  with check (private.has_company_access(organization_id,true));

-- Stamp the real review identity server-side: clients cannot forge reviewer IDs.
create function private.evidence_review_stamp() returns trigger language plpgsql set search_path = '' as $
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode='42501'; end if;
  new.reviewed_by := (select auth.uid());
  new.reviewed_at := now();
  return new;
end;
$;
revoke all on function private.evidence_review_stamp() from public,anon,authenticated;
create trigger evidence_review_stamp before update on public.evidence_item
  for each row execute function private.evidence_review_stamp();

-- Service-role carries NO direct table privileges. Backend writes use
-- narrow atomic SECURITY DEFINER RPCs instead of unrestricted table CRUD.
do $evidence_acl$
begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    revoke all on public.evidence_analysis,public.evidence_item from service_role;
  end if;
end
$evidence_acl$;

create function public.begin_evidence_analysis(
  p_organization_id uuid, p_candidate_id uuid, p_position_id uuid,
  p_recruitment_id uuid, p_application_id uuid, p_document_id uuid,
  p_model text, p_created_by uuid, p_requirements jsonb, p_materials jsonb, p_hash text
) returns uuid language plpgsql security definer set search_path = '' as $evidence_begin$
declare
  new_id uuid;
  doc public.candidate_documents%rowtype;
  rec public.recruitments%rowtype;
begin
  -- Prevent concurrent charges and overlapping jobs for one application.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':' || p_application_id::text, 0));
  select * into doc from public.candidate_documents
    where company_id=p_organization_id and id=p_document_id and candidate_id=p_candidate_id
      and status='reviewed' for share;
  if not found then raise exception 'Reviewed CV required' using errcode='42501'; end if;
  if pg_catalog.jsonb_typeof(p_materials) <> 'array'
    or pg_catalog.jsonb_array_length(p_materials) <> 1
    or p_materials->0->>'document_id' is distinct from doc.id::text
    or p_materials->0->>'version' is distinct from doc.version::text
    or p_materials->0->>'text' is distinct from doc.redacted_text
    then raise exception 'Source snapshot mismatch' using errcode='22023'; end if;
  select * into rec from public.recruitments
    where company_id=p_organization_id and id=p_recruitment_id and position_id=p_position_id;
  if not found then raise exception 'Position mismatch' using errcode='23503'; end if;
  if not exists(select 1 from public.applications
    where company_id=p_organization_id and id=p_application_id and recruitment_id=p_recruitment_id
      and candidate_id=p_candidate_id) then raise exception 'Applicant mismatch' using errcode='23503'; end if;
  if (select count(*) from public.evidence_analysis where organization_id=p_organization_id
      and application_id=p_application_id and created_at > pg_catalog.now()-interval '24 hours') >= 5
    then raise exception 'Daily analysis quota exceeded' using errcode='PT429'; end if;
  update public.evidence_analysis set status='failed',finished_at=pg_catalog.now(),
    failure_message='Przekroczono czas wykonywania. Możesz ponowić analizę.'
    where organization_id=p_organization_id and application_id=p_application_id
      and status in ('pending','running') and created_at < pg_catalog.now()-interval '120 seconds';
  if exists(select 1 from public.evidence_analysis where organization_id=p_organization_id
    and application_id=p_application_id and status in ('pending','running'))
    then raise exception 'Analysis already running' using errcode='PT409'; end if;
  insert into public.evidence_analysis(
    organization_id,candidate_id,position_id,recruitment_id,application_id,document_id,
    status,model,created_by,requirements_snapshot,materials_snapshot,materials_snapshot_hash
  ) values (
    p_organization_id,p_candidate_id,p_position_id,p_recruitment_id,p_application_id,p_document_id,
    'running',p_model,p_created_by,p_requirements,p_materials,p_hash
  ) returning id into new_id;
  return new_id;
end;
$evidence_begin$;

create function public.complete_evidence_analysis(p_organization_id uuid, p_analysis_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $evidence_complete$
declare
  analysis public.evidence_analysis%rowtype;
  item jsonb;
begin
  select * into analysis from public.evidence_analysis
    where organization_id=p_organization_id and id=p_analysis_id for update;
  if not found or analysis.status <> 'running'
    then raise exception 'Analysis not running' using errcode='PT409'; end if;
  if pg_catalog.jsonb_typeof(p_items) <> 'array' or
    pg_catalog.jsonb_array_length(p_items) <> pg_catalog.jsonb_array_length(analysis.requirements_snapshot)
    then raise exception 'Incomplete evidence matrix' using errcode='22023'; end if;
  for item in select value from pg_catalog.jsonb_array_elements(p_items) loop
    if not exists(select 1 from pg_catalog.jsonb_array_elements(analysis.requirements_snapshot) r
      where r->>'id'=item->>'requirement_key')
      then raise exception 'Unrecognized requirement' using errcode='22023'; end if;
    insert into public.evidence_item(
      organization_id,analysis_id,requirement_key,verdict,evidence_quotes,missing_info,suggested_question
    ) values (
      p_organization_id,p_analysis_id,item->>'requirement_key',item->>'verdict',
      item->'evidence_quotes',item->>'missing_info',item->>'suggested_question'
    );
  end loop;
  update public.evidence_analysis set status='done',finished_at=pg_catalog.now()
    where organization_id=p_organization_id and id=p_analysis_id;
end;
$evidence_complete$;

create function public.fail_evidence_analysis(p_organization_id uuid, p_analysis_id uuid, p_message text)
returns void language plpgsql security definer set search_path = '' as $evidence_fail$
begin
  update public.evidence_analysis set status='failed',finished_at=pg_catalog.now(),
    failure_message=pg_catalog.left(p_message,2000)
    where organization_id=p_organization_id and id=p_analysis_id and status='running';
end;
$evidence_fail$;

revoke all on function public.begin_evidence_analysis(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb,text)
  from public,anon,authenticated;
revoke all on function public.complete_evidence_analysis(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.fail_evidence_analysis(uuid,uuid,text) from public,anon,authenticated;
do $evidence_rpc_acl$
begin
 if exists(select 1 from pg_roles where rolname='service_role') then
   grant execute on function public.begin_evidence_analysis(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb,text)
     to service_role;
   grant execute on function public.complete_evidence_analysis(uuid,uuid,jsonb) to service_role;
   grant execute on function public.fail_evidence_analysis(uuid,uuid,text) to service_role;
 end if;
end
$evidence_rpc_acl$;

commit;