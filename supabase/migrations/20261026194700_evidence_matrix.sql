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
grant update (human_status,human_note,human_verdict,human_missing_info,human_question,reviewed_by,reviewed_at)
  on public.evidence_item to authenticated;

create policy evidence_analysis_read on public.evidence_analysis for select to authenticated
  using (private.has_company_access(organization_id));
create policy evidence_item_read on public.evidence_item for select to authenticated
  using (private.has_company_access(organization_id));
create policy evidence_item_human_update on public.evidence_item for update to authenticated
  using (private.has_company_access(organization_id,true))
  with check (private.has_company_access(organization_id,true));

-- Backend-only writer. Never pass this credential to browsers or store it as NEXT_PUBLIC_*.
-- Keeping INSERT/AI status writes out of authenticated grants prevents client forgery.
do $grant_service$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update,delete on public.evidence_analysis,public.evidence_item to service_role;
  end if;
end
$grant_service$;
commit;