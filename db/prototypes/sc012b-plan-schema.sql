-- SC-012-B: ISOLATED SCHEMA PROTOTYPE, NOT AN APPLIED SUPABASE MIGRATION.
-- Review-only. Requires SC-006 / SC-008 existing tables. No callable mutating RPC,
-- no provider calls, no SELECT grants and no production authorization.
-- A generated CLI migration, template catalog, audited RPC and two-session races
-- remain separate hard gates before integration/production.

create schema if not exists private;

create table public.voice_plan_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  position_id uuid not null,
  analysis_id uuid not null,
  screening_review_id uuid not null,
  shortlist_entry_id uuid not null,
  plan_version bigint not null check (plan_version>=1),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  envelope_hash text not null check (envelope_hash ~ '^[0-9a-f]{64}$'),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot)='object'),
  plan_envelope jsonb not null check (
    jsonb_typeof(plan_envelope)='object' and
    plan_envelope->>'schemaVersion'='1' and
    plan_envelope->>'language'='pl-PL' and
    plan_envelope->>'recordingAllowed'='false' and
    plan_envelope->>'noticeRequired'='true' and
    plan_envelope->>'targetSeconds'='420' and
    plan_envelope->>'maximumSeconds'='600' and
    jsonb_typeof(plan_envelope->'questions')='array'
  ),
  template_version text not null check (length(template_version) between 1 and 128),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  retention_policy_version text not null check (length(retention_policy_version) between 1 and 128),
  retention_deadline timestamptz not null,
  unique (company_id,id),
  unique (company_id,id,application_id),
  unique (company_id,application_id,plan_version),
  foreign key(company_id,recruitment_id) references public.recruitments(company_id,id) on delete restrict,
  foreign key(company_id,position_id) references public.positions(company_id,id) on delete restrict,
  foreign key(company_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete restrict,
  foreign key(company_id,analysis_id)
    references public.screening_analysis_versions(company_id,id) on delete restrict,
  foreign key(company_id,screening_review_id)
    references public.screening_result_reviews(company_id,id) on delete restrict,
  foreign key(company_id,shortlist_entry_id)
    references public.recruitment_shortlist_entries(company_id,id) on delete restrict
);
create index voice_plan_versions_app_idx
  on public.voice_plan_versions(company_id,application_id,created_at desc);

create table private.voice_plan_review_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  plan_id uuid not null,
  review_version bigint not null check(review_version>=1),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check(decision in ('approved','requires_changes')),
  reason text check(reason is null or
    (char_length(reason) between 1 and 1000 and char_length(btrim(reason))>=1)),
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  retention_policy_version text not null,
  retention_deadline timestamptz not null,
  check(decision <> 'requires_changes' or reason is not null),
  unique(company_id,plan_id,id),
  unique(company_id,plan_id,review_version),
  foreign key(company_id,plan_id)
    references public.voice_plan_versions(company_id,id) on delete restrict
);

create table private.voice_plan_release_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  plan_id uuid not null,
  approved_review_id uuid not null,
  release_version bigint not null check(release_version>=1),
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  released_by uuid not null references auth.users(id) on delete restrict,
  released_at timestamptz not null default now(),
  retention_policy_version text not null,
  retention_deadline timestamptz not null,
  unique(company_id,plan_id,id),
  unique(company_id,plan_id),
  foreign key(company_id,plan_id)
    references public.voice_plan_versions(company_id,id) on delete restrict,
  foreign key(company_id,plan_id,approved_review_id)
    references private.voice_plan_review_entries(company_id,plan_id,id) on delete restrict
);

-- The only effective release pointer is app-scoped; historical releases remain append-only.
-- A reviewed RPC must atomically CAS pointer_version and verify source freshness
-- to prevent an older/same-source plan being promoted.
create table private.voice_plan_current_releases (
  company_id uuid not null,
  application_id uuid not null,
  plan_id uuid not null,
  release_entry_id uuid not null,
  pointer_version bigint not null check(pointer_version>=1),
  updated_at timestamptz not null default now(),
  primary key(company_id,application_id),
  foreign key(company_id,plan_id,application_id)
    references public.voice_plan_versions(company_id,id,application_id) on delete restrict,
  foreign key(company_id,plan_id,release_entry_id)
    references private.voice_plan_release_entries(company_id,plan_id,id) on delete restrict
);

create table private.voice_plan_request_keys (
  company_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  operation text not null check(operation in ('generate','review','release')),
  request_key uuid not null,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  result_id uuid,
  created_at timestamptz not null default now(),
  retention_policy_version text not null,
  retention_deadline timestamptz not null,
  primary key(company_id,actor_id,operation,request_key),
  foreign key(company_id) references public.companies(id) on delete restrict
);

-- Explicit fail-closed default: no SELECT/INSERT/UPDATE/DELETE from client roles.
-- Before enabling read access, implement least-privilege RLS or an approved
-- authenticated, tenant-scoped read RPC with redaction.
alter table public.voice_plan_versions enable row level security;
alter table private.voice_plan_review_entries enable row level security;
alter table private.voice_plan_release_entries enable row level security;
alter table private.voice_plan_current_releases enable row level security;
alter table private.voice_plan_request_keys enable row level security;
alter table public.voice_plan_versions force row level security;
alter table private.voice_plan_review_entries force row level security;
alter table private.voice_plan_release_entries force row level security;
alter table private.voice_plan_current_releases force row level security;
alter table private.voice_plan_request_keys force row level security;

revoke all on table public.voice_plan_versions from public, anon, authenticated;
revoke all on table private.voice_plan_review_entries from public, anon, authenticated;
revoke all on table private.voice_plan_release_entries from public, anon, authenticated;
revoke all on table private.voice_plan_current_releases from public, anon, authenticated;
revoke all on table private.voice_plan_request_keys from public, anon, authenticated;

-- No SECURITY DEFINER RPC is granted here; no data mutation is exposed.

-- Prototype immutability guard: history is append-only even for privileged callers.
-- A future owner-authorized, narrowly scoped erasure path must be reviewed separately.
create or replace function private.voice_plan_protect_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode='42501',message='VOICE_PLAN_HISTORY_IMMUTABLE';
end;
$$;
revoke all on function private.voice_plan_protect_history() from public, anon, authenticated;
create trigger voice_plan_versions_immutable
  before update or delete on public.voice_plan_versions
  for each row execute function private.voice_plan_protect_history();
create trigger voice_plan_reviews_immutable
  before update or delete on private.voice_plan_review_entries
  for each row execute function private.voice_plan_protect_history();
create trigger voice_plan_releases_immutable
  before update or delete on private.voice_plan_release_entries
  for each row execute function private.voice_plan_protect_history();
