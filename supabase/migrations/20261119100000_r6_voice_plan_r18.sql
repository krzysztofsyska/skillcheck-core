-- R6-1c (part 1): voice interview plan tables (SC-012-B) as a real migration.
-- Generated offline by scripts/r6-voice-plan-compose.mjs from the reviewed isolated
-- sources and the R17 erasure inventory; erasure inventory R18 adds the five
-- candidate-linked voice plan tables (R4 voice adapter, reduced to the plan tables).
--
-- Nothing is used by the application yet and nothing is customer-visible: no table
-- or function is granted to anon, authenticated or service_role, no template
-- version is seeded (private.voice_plan_template_catalog stays empty), no provider,
-- package, price or order state is touched. The review/release RPCs are executable
-- only by their owner (trusted server code, a later reviewed step).
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r17') is null then raise exception 'voice_plan_requires_r17' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r18') is not null or to_regclass('public.voice_plan_versions') is not null
  or to_regclass('private.voice_plan_template_catalog') is not null then
  raise exception 'voice_plan_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r17 where singleton and schema_signature='8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f')
  or private.erasure_schema_signature() is distinct from '8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f' then
  raise exception 'voice_plan_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r17 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_plan_source_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_inventory_rows(uuid,uuid[])'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='11867699d79851c4f8b367315678bf968a85de895ac864c182e555a7f2119b7b'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_plan_source_function_unreviewed:private.erasure_inventory_rows' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_row_candidates(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='0082879ef79e748dfd16751eb79744875637d0d82342075f9897aeae5d18862a'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_plan_source_function_unreviewed:private.erasure_row_candidates' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_engine(uuid,bigint,boolean)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='c9b17a3055d16b022074c199689e65bf4961ce1ee51034bf70a4fbd6e07f7c55'
  and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{erasure_purge_owner=X/erasure_purge_owner}') then
  raise exception 'voice_plan_source_function_unreviewed:private.erasure_purge_engine' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.preview_candidate_erasure(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='1ce25c42f1df20280e17a772bbfea1926f233bc55ba28216223f310ee031d849'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'voice_plan_source_function_unreviewed:public.preview_candidate_erasure' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.prepare_erasure_purge_manifest(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='616894e70a744394e2c37d8c3491c95f11f3c561234059b6b3e11ba5798e34e5'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_plan_source_function_unreviewed:private.prepare_erasure_purge_manifest' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.authorize_retention_suggestion(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='ceb8d739a62a2dca4dff8be15374e6fe91c56bca9bfcdd4f50c9f1213d85863d'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'voice_plan_source_function_unreviewed:private.authorize_retention_suggestion' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.get_retention_schedule(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='5524934402e8ce05b0df985760308db9d6c82325706d1fd96ba24278bd53059b'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'voice_plan_source_function_unreviewed:public.get_retention_schedule' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_key(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='6342e21c44f29e5715fd30b192706b7a18592352166f9f51c5c45479803e45bb') then
  raise exception 'voice_plan_source_function_unreviewed:private.erasure_purge_key' using errcode='55000';end if;
 if to_regprocedure('private.erasure_inventory_rows_r17(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r17(text,jsonb)') is not null then
  raise exception 'voice_plan_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.has_company_access(uuid,boolean)') is null or to_regprocedure('private.erasure_lock_candidate(uuid)') is null
  or to_regprocedure('private.screening_material(uuid,boolean)') is null or to_regclass('private.erasure_execution_config') is null
  or to_regprocedure('private.erasure_normal_row_guard(text,text,text,jsonb,jsonb)') is null
  or to_regprocedure('private.retention_observe_candidate()') is null or to_regrole('erasure_purge_owner') is null then
  raise exception 'voice_plan_dependency_missing' using errcode='55000';end if;
end $preflight$;

-- SC-012-B plan tables (source: db/prototypes/sc012b-plan-schema.sql).

-- Composite provenance keys are necessary to stop same-tenant cross-application
-- and cross-position binding. Every key ends with the primary key, so the new
-- unique indexes cannot conflict with existing rows.
create unique index sc012b_recruitment_position_binding_uq
  on public.recruitments(company_id,position_id,id);
create unique index sc012b_screening_application_binding_uq
  on public.screening_analysis_versions(company_id,recruitment_id,application_id,position_id,id);
create unique index sc012b_review_analysis_binding_uq
  on public.screening_result_reviews(company_id,analysis_id,id);
create unique index sc012b_shortlist_review_binding_uq
  on public.recruitment_shortlist_entries(company_id,recruitment_id,application_id,analysis_id,review_id,id);

create table public.voice_plan_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  position_id uuid not null,
  analysis_id uuid not null,
  screening_review_id uuid not null,
  shortlist_entry_id uuid not null,
  supersedes_plan_id uuid,
  corrects_review_id uuid,
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
  check (corrects_review_id is null or supersedes_plan_id is not null),
  foreign key(company_id,application_id,supersedes_plan_id)
    references public.voice_plan_versions(company_id,application_id,id) on delete restrict,
  foreign key(company_id,recruitment_id) references public.recruitments(company_id,id) on delete restrict,
  foreign key(company_id,position_id) references public.positions(company_id,id) on delete restrict,
  foreign key(company_id,recruitment_id,application_id)
    references public.applications(company_id,recruitment_id,id) on delete restrict,
  foreign key(company_id,analysis_id)
    references public.screening_analysis_versions(company_id,id) on delete restrict,
  foreign key(company_id,screening_review_id)
    references public.screening_result_reviews(company_id,id) on delete restrict,
  foreign key(company_id,shortlist_entry_id)
    references public.recruitment_shortlist_entries(company_id,id) on delete restrict,
  foreign key(company_id,position_id,recruitment_id)
    references public.recruitments(company_id,position_id,id) on delete restrict,
  foreign key(company_id,recruitment_id,application_id,position_id,analysis_id)
    references public.screening_analysis_versions(company_id,recruitment_id,application_id,position_id,id)
    on delete restrict,
  foreign key(company_id,analysis_id,screening_review_id)
    references public.screening_result_reviews(company_id,analysis_id,id) on delete restrict,
  foreign key(company_id,recruitment_id,application_id,analysis_id,screening_review_id,shortlist_entry_id)
    references public.recruitment_shortlist_entries(company_id,recruitment_id,application_id,analysis_id,review_id,id)
    on delete restrict
);
create index voice_plan_versions_app_idx
  on public.voice_plan_versions(company_id,application_id,created_at desc);

create table private.voice_plan_review_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  application_id uuid not null,
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
  unique(company_id,application_id,id),
  unique(company_id,application_id,plan_id,id),
  unique(company_id,plan_id,review_version),
  foreign key(company_id,plan_id,application_id)
    references public.voice_plan_versions(company_id,id,application_id) on delete restrict
);
-- Circular provenance is intentionally nullable on the first plan and immutable
-- on later plans: a correction cannot reference a review of another application.
alter table public.voice_plan_versions add constraint voice_plan_correction_lineage_fk
  foreign key(company_id,application_id,supersedes_plan_id,corrects_review_id)
  references private.voice_plan_review_entries(company_id,application_id,plan_id,id)
  on delete restrict;

create table private.voice_plan_release_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  application_id uuid not null,
  plan_id uuid not null,
  approved_review_id uuid not null,
  release_version bigint not null check(release_version>=1),
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  released_by uuid not null references auth.users(id) on delete restrict,
  released_at timestamptz not null default now(),
  retention_policy_version text not null,
  retention_deadline timestamptz not null,
  unique(company_id,plan_id,id),
  unique(company_id,application_id,id),
  unique(company_id,application_id,plan_id,id),
  unique(company_id,plan_id),
  foreign key(company_id,plan_id,application_id)
    references public.voice_plan_versions(company_id,id,application_id) on delete restrict,
  foreign key(company_id,application_id,plan_id,approved_review_id)
    references private.voice_plan_review_entries(company_id,application_id,plan_id,id) on delete restrict
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
  foreign key(company_id,application_id,release_entry_id)
    references private.voice_plan_release_entries(company_id,application_id,id) on delete restrict,
  foreign key(company_id,application_id,plan_id,release_entry_id)
    references private.voice_plan_release_entries(company_id,application_id,plan_id,id) on delete restrict
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
-- RPC-only even when installed with historical Supabase public-table defaults.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.voice_plan_versions from service_role;
  end if;
end $$;
revoke all on table private.voice_plan_review_entries from public, anon, authenticated;
revoke all on table private.voice_plan_release_entries from public, anon, authenticated;
revoke all on table private.voice_plan_current_releases from public, anon, authenticated;
revoke all on table private.voice_plan_request_keys from public, anon, authenticated;

-- No SECURITY DEFINER RPC is granted here; no data mutation is exposed.

-- History is append-only even for privileged callers. The only delete is the
-- manifest-checked candidate erasure (SC-010 R18 below), as in the R4 voice adapter.
create function private.voice_plan_protect_history()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
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


-- Lineage guard (name kept from the reviewed SC-012-B source); any future write
-- RPC must own the same app advisory lock, actor authorization and source checks.
create function private.voice_plan_prototype_lineage_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
 previous_plan public.voice_plan_versions%rowtype;
 latest_review private.voice_plan_review_entries%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended(new.company_id::text||':'||new.application_id::text,0));
 select * into previous_plan from public.voice_plan_versions
   where company_id=new.company_id and application_id=new.application_id
   order by plan_version desc limit 1;
 if not found then
   if new.plan_version<>1 or new.supersedes_plan_id is not null
      or new.corrects_review_id is not null then
     raise exception using errcode='PT409',message='VOICE_PLAN_LINEAGE_CONFLICT';
   end if;
   return new;
 end if;
 if new.supersedes_plan_id is distinct from previous_plan.id or
    new.plan_version<>previous_plan.plan_version+1 then
   raise exception using errcode='PT409',message='VOICE_PLAN_LINEAGE_CONFLICT';
 end if;
 select * into latest_review from private.voice_plan_review_entries
   where company_id=new.company_id and application_id=new.application_id
     and plan_id=previous_plan.id order by review_version desc limit 1;
 if not found then
   if new.corrects_review_id is not null or
      new.source_hash=previous_plan.source_hash then
     raise exception using errcode='PT409',message='VOICE_PLAN_LINEAGE_CONFLICT';
   end if;
 elsif new.corrects_review_id is distinct from latest_review.id then
   raise exception using errcode='PT409',message='VOICE_PLAN_LINEAGE_CONFLICT';
 elsif latest_review.decision='requires_changes' then
   if new.envelope_hash=previous_plan.envelope_hash then
     raise exception using errcode='PT409',message='VOICE_PLAN_CORRECTION_UNCHANGED';
   end if;
 elsif new.source_hash=previous_plan.source_hash then
   raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_UNCHANGED';
 end if;
 return new;
end;
$$;
revoke all on function private.voice_plan_prototype_lineage_guard()
  from public,anon,authenticated;
create trigger voice_plan_lineage_before_insert
  before insert on public.voice_plan_versions
  for each row execute function private.voice_plan_prototype_lineage_guard();

-- SC-012-B template catalog (source: db/isolated/sc012b-template-catalog.sql).

create table private.voice_plan_template_catalog (
  version text primary key check (length(version) between 1 and 128),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
alter table private.voice_plan_template_catalog enable row level security;
alter table private.voice_plan_template_catalog force row level security;
-- Close actual inherited ACLs, including roles unknown to this installer.
-- Preserve the owner and do not change defaults or any pre-existing object.
revoke all on private.voice_plan_template_catalog from public cascade;
do $$
declare recipient record;
begin
  for recipient in
    select distinct a.grantee from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      where c.oid='private.voice_plan_template_catalog'::pg_catalog.regclass
        and a.grantee<>0 and a.grantee<>c.relowner
  loop
    execute pg_catalog.format('revoke all on table private.voice_plan_template_catalog from %I cascade',
      pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
end;
$$;
create trigger voice_plan_template_catalog_immutable
  before update or delete on private.voice_plan_template_catalog
  for each row execute function private.voice_plan_protect_history();
-- Only trusted DB administration may seed a new, independently reviewed version.

-- SC-012-B review RPC (source: db/isolated/sc012b-review-rpc.sql).

create function private.sc012b_review_plan(
  p_plan_id uuid,
  p_expected_review_version bigint,
  p_expected_source_hash text,
  p_decision text,
  p_reason text,
  p_request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  plan record;
  last_review record;
  last_version bigint;
  auth_owner uuid;
  auth_role text;
  bound_review_version integer;
  analysis_latest_version integer;
  current_plan uuid;
  prior_key record;
  result_id uuid;
  request_digest text;
  clean_reason text := nullif(pg_catalog.btrim(p_reason, E' \t\n\r\f\v'),'');
begin
  if actor is null or p_plan_id is null or p_request_key is null
     or p_expected_review_version is null or p_expected_review_version<0
     or p_expected_source_hash is null
     or p_expected_source_hash !~ '^[0-9a-f]{64}$'
     or p_decision is null or p_decision not in ('approved','requires_changes')
     or (p_decision='requires_changes' and
         (clean_reason is null or nullif(pg_catalog.regexp_replace(clean_reason,'[[:space:]]','','g'),'') is null or pg_catalog.char_length(clean_reason)>1000))
     or (p_reason is not null and pg_catalog.char_length(p_reason)>1000)
  then raise exception using errcode='22023',message='VOICE_PLAN_INVALID_REVIEW'; end if;

  -- No tenant ID or actor ID comes from the browser.
  select company_id,application_id,source_hash,analysis_id,screening_review_id,
         shortlist_entry_id into plan
  from public.voice_plan_versions where id=p_plan_id;
  if not found or not private.has_company_access(plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;

  -- Current SC-010/SC-006 take the candidate + freeze guard first, then
  -- screening and application advisory locks. Replays keep this same order.
  perform private.erasure_lock_candidate(ap.candidate_id)
    from public.applications ap
    where ap.company_id=plan.company_id and ap.id=plan.application_id;
  if not found then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  perform 1 from private.erasure_execution_config where singleton for share nowait;
  if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('screening:'||plan.application_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(plan.company_id::text||':'||plan.application_id::text,0));
  -- Pin the current owner/member row until commit; a concurrent revocation
  -- cannot commit while this review transaction holds its membership lock.
  select c.owner_id into auth_owner from public.companies c
    where c.id=plan.company_id for share nowait;
  if not found then raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN'; end if;
  if actor is distinct from auth_owner then
    select m.role into auth_role from public.company_members m
      where m.company_id=plan.company_id and m.user_id=actor
      for share nowait;
    if not found or auth_role<>'recruiter' then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  end if;
  if not private.has_company_access(plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- Serialize a reused request key across different applications before
  -- looking up the global (company,actor,operation,key) uniqueness scope.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(plan.company_id::text||':'||actor::text||':review:'||p_request_key::text,0));
  -- Resolve an authorized, committed request replay BEFORE current-state
  -- checks, so a superseded or stale plan can recover the original review.
  request_digest:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'plan',p_plan_id,'expectedVersion',p_expected_review_version,
      'source',p_expected_source_hash,'decision',p_decision,
      'reason',clean_reason)::text,'UTF8')),'hex');
  select k.payload_hash,k.result_id into prior_key
  from private.voice_plan_request_keys k
  where k.company_id=plan.company_id and k.actor_id=actor
    and k.operation='review' and k.request_key=p_request_key for update;
  if found then
    if prior_key.payload_hash is distinct from request_digest or
       prior_key.result_id is null then
      raise exception using errcode='PT409',message='VOICE_PLAN_REQUEST_CONFLICT';
    end if;
    return prior_key.result_id;
  end if;
  -- A historical replay above recovers an ID only. New authority requires an
  -- eligible application and an unexpired plan under their retained locks.
  perform 1 from public.applications ap
    where ap.company_id=plan.company_id and ap.id=plan.application_id
      and ap.status in ('new','in_progress') for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE'; end if;
  select p.* into plan from public.voice_plan_versions p
    where p.id=p_plan_id and p.company_id=plan.company_id
      and p.application_id=plan.application_id
      and p.retention_deadline>pg_catalog.clock_timestamp() for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  if plan.source_hash is distinct from p_expected_source_hash then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  select p.id into current_plan from public.voice_plan_versions p
    where p.company_id=plan.company_id and p.application_id=plan.application_id
    order by p.plan_version desc limit 1;
  if current_plan is distinct from p_plan_id then
    raise exception using errcode='PT409',message='VOICE_PLAN_SUPERSEDED';
  end if;
  -- Refuse stale analysis/shortlist/approval, including removal.
  -- Lock the analysis and the shortlist in the writer's established order.
  -- NOWAIT makes contention a conflict rather than waiting across lock-order
  -- inversions. Re-check all predicates *after* the locks are acquired.
  select a.latest_review_version into analysis_latest_version
    from public.screening_analysis_versions a
    where a.id=plan.analysis_id and a.company_id=plan.company_id
      and a.application_id=plan.application_id
      and a.execution_status='completed' and a.stale_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  perform 1 from public.recruitment_shortlist_entries s
    where s.id=plan.shortlist_entry_id and s.company_id=plan.company_id
      and s.application_id=plan.application_id and s.analysis_id=plan.analysis_id
      and s.review_id=plan.screening_review_id and s.removed_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  select r.review_version into bound_review_version
    from public.screening_result_reviews r
    where r.id=plan.screening_review_id and r.company_id=plan.company_id
      and r.analysis_id=plan.analysis_id
      and r.disposition in ('approved','approved_with_changes')
    for share nowait;
  if not found or bound_review_version is distinct from analysis_latest_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  if exists(select 1 from private.voice_plan_release_entries
     where company_id=plan.company_id and plan_id=p_plan_id) then
    raise exception using errcode='PT409',message='VOICE_PLAN_ALREADY_RELEASED';
  end if;

  select id,review_version,decision into last_review
    from private.voice_plan_review_entries
    where company_id=plan.company_id and plan_id=p_plan_id
    order by review_version desc limit 1;
  last_version:=coalesce(last_review.review_version,0);
  if last_review.decision='requires_changes' then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_TERMINAL';
  end if;
  if last_version<>p_expected_review_version then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_CONFLICT';
  end if;
  insert into private.voice_plan_review_entries
    (company_id,application_id,plan_id,review_version,reviewer_id,decision,
     reason,source_hash,retention_policy_version,retention_deadline)
  select p.company_id,p.application_id,p.id,last_version+1,actor,p_decision,
    clean_reason,p.source_hash,p.retention_policy_version,p.retention_deadline
  from public.voice_plan_versions p
  join public.applications ap on ap.company_id=p.company_id and ap.id=p.application_id
  where p.id=p_plan_id and p.source_hash=p_expected_source_hash
    and ap.status in ('new','in_progress')
    and p.retention_deadline>pg_catalog.clock_timestamp()
  returning id into result_id;
  -- Time can advance after JS verification or while the RPC acquires locks.
  -- The INSERT itself must still have current write authority.
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE'; end if;
  insert into private.voice_plan_request_keys
    (company_id,actor_id,operation,request_key,payload_hash,result_id,
     retention_policy_version,retention_deadline)
  select p.company_id,actor,'review',p_request_key,request_digest,result_id,
    p.retention_policy_version,p.retention_deadline
  from public.voice_plan_versions p where p.id=p_plan_id;
  return result_id;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
-- New history must still be current inside COMMIT, not only when its INSERT
-- ran. The RPC keeps its source/actor/candidate/restore locks through this
-- deferred check. Read-only historical replay queues no fresh-write event.
create function private.sc012b_assert_fresh_write() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op<>'INSERT' or tg_table_schema<>'private'
     or tg_table_name not in ('voice_plan_review_entries','voice_plan_release_entries') then
    raise exception using errcode='42501',message='VOICE_PLAN_INVALID_TRIGGER_CONTEXT';
  end if;
  if tg_table_name='voice_plan_review_entries' then
    perform 1 from public.voice_plan_versions p
      join public.applications ap on ap.company_id=p.company_id and ap.id=p.application_id
      where p.company_id=new.company_id and p.application_id=new.application_id and p.id=new.plan_id
        and p.source_hash=new.source_hash and ap.status in ('new','in_progress')
        and p.retention_deadline>pg_catalog.clock_timestamp()
        and new.retention_deadline>pg_catalog.clock_timestamp()
      for share of p,ap nowait;
  else
    perform 1 from public.voice_plan_versions p
      join public.applications ap on ap.company_id=p.company_id and ap.id=p.application_id
      join private.voice_plan_review_entries r on r.company_id=p.company_id
        and r.application_id=p.application_id and r.plan_id=p.id and r.id=new.approved_review_id
      where p.company_id=new.company_id and p.application_id=new.application_id and p.id=new.plan_id
        and p.source_hash=new.source_hash and r.source_hash=p.source_hash and r.decision='approved'
        and ap.status in ('new','in_progress')
        and p.retention_deadline>pg_catalog.clock_timestamp()
        and r.retention_deadline>pg_catalog.clock_timestamp()
        and new.retention_deadline>pg_catalog.clock_timestamp()
      for share of p,ap,r nowait;
  end if;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_STALE_AT_COMMIT'; end if;
  return null;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
create constraint trigger sc012b_review_fresh_at_commit
  after insert on private.voice_plan_review_entries
  deferrable initially deferred for each row
  execute function private.sc012b_assert_fresh_write();

-- No browser/anonymous grant: this is a candidate for a future trusted
-- server capability after independent security review, not a public endpoint.
-- Remove every non-owner grantee from both functions' actual ACLs. A fixed role
-- list cannot close privileges inherited from arbitrary owner defaults.
do $$
declare f record; recipient record;
begin
  for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p where p.oid in (
      'private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)'::pg_catalog.regprocedure,
      'private.sc012b_assert_fresh_write()'::pg_catalog.regprocedure
    )
  loop
    execute pg_catalog.format('revoke all on function %s from public cascade',f.signature);
    for recipient in
      select distinct a.grantee from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        where p.oid=f.oid and a.grantee<>0 and a.grantee<>p.proowner
    loop
      execute pg_catalog.format('revoke all on function %s from %I cascade',f.signature,
        pg_catalog.pg_get_userbyid(recipient.grantee));
    end loop;
  end loop;
end;
$$;

-- SC-012-B release RPC (source: db/isolated/sc012b-release-rpc.sql).

create function private.sc012b_release_plan(
  p_plan_id uuid,
  p_expected_review_id uuid,
  p_expected_source_hash text,
  p_expected_pointer_version bigint,
  p_expected_release_id uuid,
  p_request_key uuid
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  v_plan record;
  v_owner uuid;
  v_role text;
  v_latest_review record;
  v_current record;
  v_latest_analysis_review integer;
  v_bound_analysis_review integer;
  v_digest text;
  v_existing record;
  v_new_release uuid;
begin
  if actor is null or p_plan_id is null or p_expected_review_id is null or
     p_request_key is null or p_expected_source_hash is null or
     p_expected_source_hash !~ '^[0-9a-f]{64}$' or
     (p_expected_pointer_version is null) <> (p_expected_release_id is null) or
     p_expected_pointer_version < 1 then
    raise exception using errcode='22023',message='VOICE_PLAN_INVALID_RELEASE';
  end if;
  select p.* into v_plan from public.voice_plan_versions p where p.id=p_plan_id;
  if not found or not private.has_company_access(v_plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- Match current SC-010/SC-006: candidate + freeze, screening, application.
  -- A frozen candidate cannot recover a replay id or append release history.
  perform private.erasure_lock_candidate(ap.candidate_id)
    from public.applications ap
    where ap.company_id=v_plan.company_id and ap.id=v_plan.application_id;
  if not found then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  perform 1 from private.erasure_execution_config where singleton for share nowait;
  if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('screening:'||v_plan.application_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_plan.company_id::text||':'||v_plan.application_id::text,0));
  select c.owner_id into v_owner from public.companies c
    where c.id=v_plan.company_id for share nowait;
  if not found then raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN'; end if;
  if actor is distinct from v_owner then
    select m.role into v_role from public.company_members m
      where m.company_id=v_plan.company_id and m.user_id=actor for share nowait;
    if not found or v_role<>'recruiter' then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  end if;
  if not private.has_company_access(v_plan.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  -- A request key is unique across applications of this actor.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_plan.company_id::text||':'||actor::text||':release:'||p_request_key::text,0));
  -- Resolve an authorized, committed request replay BEFORE current-state
  -- checks, so superseded plans can recover their original result.
  v_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('plan',p_plan_id,'review',p_expected_review_id,
      'source',p_expected_source_hash,'expectedPointer',p_expected_pointer_version,
      'expectedRelease',p_expected_release_id)::text,'UTF8')),'hex');
  select k.payload_hash,k.result_id into v_existing from private.voice_plan_request_keys k
    where k.company_id=v_plan.company_id and k.actor_id=actor
      and k.operation='release' and k.request_key=p_request_key for update;
  if found then
    if v_existing.payload_hash is distinct from v_digest or v_existing.result_id is null then
      raise exception using errcode='PT409',message='VOICE_PLAN_REQUEST_CONFLICT';
    end if;
    return v_existing.result_id;
  end if;
  -- Replay is historical recovery only. Every new release needs current,
  -- locked application and plan authority before it can append or move a pointer.
  perform 1 from public.applications ap
    where ap.company_id=v_plan.company_id and ap.id=v_plan.application_id
      and ap.status in ('new','in_progress') for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE'; end if;
  select p.* into v_plan from public.voice_plan_versions p
    where p.id=p_plan_id and p.company_id=v_plan.company_id
      and p.application_id=v_plan.application_id
      and p.retention_deadline>pg_catalog.clock_timestamp() for share nowait;
  if not found or v_plan.source_hash is distinct from p_expected_source_hash then
    raise exception using errcode='PT409',message='VOICE_PLAN_STALE';
  end if;
  if exists(select 1 from public.voice_plan_versions p
     where p.company_id=v_plan.company_id and p.application_id=v_plan.application_id
       and p.plan_version>v_plan.plan_version) then
    raise exception using errcode='PT409',message='VOICE_PLAN_SUPERSEDED';
  end if;
  -- Match the exact latest human approval; requires_changes is terminal.
  select r.id,r.review_version,r.decision,r.source_hash,r.retention_deadline into v_latest_review
    from private.voice_plan_review_entries r
    where r.company_id=v_plan.company_id and r.plan_id=p_plan_id
    order by r.review_version desc limit 1 for share nowait;
  if not found or v_latest_review.id is distinct from p_expected_review_id
     or v_latest_review.decision<>'approved'
     or v_latest_review.source_hash is distinct from v_plan.source_hash
     or v_latest_review.retention_deadline<=pg_catalog.clock_timestamp() then
    raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_STALE';
  end if;
  select a.latest_review_version into v_latest_analysis_review
    from public.screening_analysis_versions a
    where a.company_id=v_plan.company_id and a.id=v_plan.analysis_id
      and a.application_id=v_plan.application_id
      and a.execution_status='completed' and a.stale_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE'; end if;
  perform 1 from public.recruitment_shortlist_entries s
    where s.company_id=v_plan.company_id and s.id=v_plan.shortlist_entry_id
      and s.application_id=v_plan.application_id and s.analysis_id=v_plan.analysis_id
      and s.review_id=v_plan.screening_review_id and s.removed_at is null
    for share nowait;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE'; end if;
  select r.review_version into v_bound_analysis_review
    from public.screening_result_reviews r
    where r.company_id=v_plan.company_id and r.id=v_plan.screening_review_id
      and r.analysis_id=v_plan.analysis_id
      and r.disposition in ('approved','approved_with_changes') for share nowait;
  if not found or v_bound_analysis_review is distinct from v_latest_analysis_review then
    raise exception using errcode='PT409',message='VOICE_PLAN_SOURCE_STALE';
  end if;
  select c.pointer_version,c.release_entry_id into v_current
    from private.voice_plan_current_releases c
    where c.company_id=v_plan.company_id and c.application_id=v_plan.application_id
    for update nowait;
  if found then
    if v_current.pointer_version is distinct from p_expected_pointer_version or
       v_current.release_entry_id is distinct from p_expected_release_id then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
  elsif p_expected_pointer_version is not null or p_expected_release_id is not null then
    raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
  end if;
  if exists(select 1 from private.voice_plan_release_entries r
    where r.company_id=v_plan.company_id and r.plan_id=p_plan_id) then
    raise exception using errcode='PT409',message='VOICE_PLAN_ALREADY_RELEASED';
  end if;
  insert into private.voice_plan_release_entries
    (company_id,application_id,plan_id,approved_review_id,release_version,
     source_hash,released_by,retention_policy_version,retention_deadline)
  select p.company_id,p.application_id,p.id,r.id,1,
     p.source_hash,actor,p.retention_policy_version,p.retention_deadline
  from public.voice_plan_versions p
  join public.applications ap on ap.company_id=p.company_id and ap.id=p.application_id
  join private.voice_plan_review_entries r on r.company_id=p.company_id
    and r.application_id=p.application_id and r.plan_id=p.id and r.id=p_expected_review_id
  where p.id=p_plan_id and p.source_hash=p_expected_source_hash
    and ap.status in ('new','in_progress')
    and r.decision='approved' and r.source_hash=p.source_hash
    and p.retention_deadline>pg_catalog.clock_timestamp()
    and r.retention_deadline>pg_catalog.clock_timestamp()
  returning id into v_new_release;
  if not found then raise exception using errcode='PT409',message='VOICE_PLAN_REVIEW_STALE'; end if;
  if p_expected_pointer_version is null then
    insert into private.voice_plan_current_releases
      (company_id,application_id,plan_id,release_entry_id,pointer_version)
    values(v_plan.company_id,v_plan.application_id,p_plan_id,v_new_release,1);
  else
    update private.voice_plan_current_releases
      set plan_id=p_plan_id,release_entry_id=v_new_release,
          pointer_version=p_expected_pointer_version+1,updated_at=now()
    where company_id=v_plan.company_id and application_id=v_plan.application_id
      and pointer_version=p_expected_pointer_version
      and release_entry_id=p_expected_release_id;
    if not found then
      raise exception using errcode='PT409',message='VOICE_PLAN_POINTER_CONFLICT';
    end if;
  end if;
  insert into private.voice_plan_request_keys
    (company_id,actor_id,operation,request_key,payload_hash,result_id,
     retention_policy_version,retention_deadline)
  values(v_plan.company_id,actor,'release',p_request_key,v_digest,v_new_release,
     v_plan.retention_policy_version,v_plan.retention_deadline);
  return v_new_release;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
revoke all on function private.sc012b_release_plan(
  uuid,uuid,text,bigint,uuid,uuid) from public cascade;
create constraint trigger sc012b_release_fresh_at_commit
  after insert on private.voice_plan_release_entries
  deferrable initially deferred for each row
  execute function private.sc012b_assert_fresh_write();

-- Diagnostic pointer cleanup only, not a provider/reservation authorization.
-- Trusted reservations must also run the full Node source/template verifier.
-- Read the current release only after revalidating the live source.
-- A stale pointer is removed in this same statement. Release history stays.
-- Returning NULL without raising is required: an exception would roll the
-- delete back.
create function private.sc012b_current_release(p_application_id uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  v_row record;
  v_application record;
  v_owner uuid;
  v_role text;
  v_plan record;
  v_plan_found boolean := false;
  v_material jsonb;
  v_position_updated timestamptz;
  v_position_found boolean := false;
  v_analysis record;
  v_analysis_found boolean := false;
  v_shortlist_removed timestamptz;
  v_shortlist_found boolean := false;
  v_review_version integer;
  v_review_disposition text;
  v_review_found boolean := false;
  v_frozen boolean := false;
  v_stale boolean;
begin
  if actor is null or p_application_id is null then
    raise exception using errcode='22023',message='VOICE_PLAN_INVALID_RELEASE';
  end if;
  select ap.company_id,ap.id as application_id,ap.candidate_id
    into v_application from public.applications ap where ap.id=p_application_id;
  if not found then return null; end if;
  if not private.has_company_access(v_application.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  begin
    perform private.erasure_lock_candidate(v_application.candidate_id);
  exception
    when sqlstate 'PT409' then
      if sqlerrm is distinct from 'Candidate workflow frozen' then raise; end if;
      return null;
  end;
  perform 1 from private.erasure_execution_config where singleton for share nowait;
  if not found or exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('screening:'||v_application.application_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_application.company_id::text||':'||v_application.application_id::text,0));
  select c.owner_id into v_owner from public.companies c
    where c.id=v_application.company_id for share nowait;
  if not found then raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN'; end if;
  if actor is distinct from v_owner then
    select m.role into v_role from public.company_members m
      where m.company_id=v_application.company_id and m.user_id=actor for share nowait;
    if not found or v_role<>'recruiter' then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  end if;
  if not private.has_company_access(v_application.company_id,true) then
    raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
  end if;
  select c.company_id,c.application_id,c.plan_id,c.release_entry_id
    into v_row from private.voice_plan_current_releases c
    where c.company_id=v_application.company_id and c.application_id=p_application_id
    for update nowait;
  if not found then return null; end if;
  select p.analysis_id,p.screening_review_id,p.shortlist_entry_id,p.plan_envelope
    into v_plan
  from public.voice_plan_versions p
  where p.id=v_row.plan_id and p.company_id=v_row.company_id
    and p.application_id=v_row.application_id
  for share nowait;
  v_plan_found:=found;
  if v_plan_found then
    begin
      -- The candidate lock is already held before source row locks.
      v_material:=private.screening_material(v_row.application_id,true);
    exception
      when insufficient_privilege or object_not_in_prerequisite_state
           or invalid_parameter_value then
        v_material:=null;
    end;
    select pos.updated_at into v_position_updated
    from public.applications ap
    join public.recruitments rec
      on rec.company_id=ap.company_id and rec.id=ap.recruitment_id
    join public.positions pos
      on pos.company_id=rec.company_id and pos.id=rec.position_id
    where ap.company_id=v_row.company_id and ap.id=v_row.application_id;
    v_position_found:=found;
    select a.latest_review_version,a.execution_status,a.stale_at into v_analysis
    from public.screening_analysis_versions a
    where a.company_id=v_row.company_id and a.id=v_plan.analysis_id
      and a.application_id=v_row.application_id
    for share nowait;
    v_analysis_found:=found;
    select s.removed_at into v_shortlist_removed
    from public.recruitment_shortlist_entries s
    where s.company_id=v_row.company_id and s.id=v_plan.shortlist_entry_id
      and s.application_id=v_row.application_id
    for share nowait;
    v_shortlist_found:=found;
    select r.review_version,r.disposition
      into v_review_version,v_review_disposition
    from public.screening_result_reviews r
    where r.company_id=v_row.company_id and r.id=v_plan.screening_review_id
      and r.analysis_id=v_plan.analysis_id
    for share nowait;
    v_review_found:=found;
  end if;
  begin
    perform private.erasure_lock_candidate(ap.candidate_id)
      from public.applications ap
      where ap.company_id=v_row.company_id and ap.id=v_row.application_id;
    if not found then
      raise exception using errcode='42501',message='VOICE_PLAN_FORBIDDEN';
    end if;
  exception
    when sqlstate 'PT409' then
      if sqlerrm is distinct from 'Candidate workflow frozen' then raise; end if;
      v_frozen:=true;
  end;
  v_stale:=not v_plan_found or v_material is null or not v_position_found
    or not v_analysis_found or not v_shortlist_found or not v_review_found
    or (v_material->>'input_fingerprint') is distinct from
       (v_plan.plan_envelope #>> '{sourceBinding,analysisFingerprint}')
    or pg_catalog.date_trunc('milliseconds', v_position_updated) is distinct from
       pg_catalog.date_trunc('milliseconds',
         (v_plan.plan_envelope #>> '{sourceBinding,positionUpdatedAt}')::timestamptz)
    or v_analysis.execution_status is distinct from 'completed'
    or v_analysis.stale_at is not null
    or v_shortlist_removed is not null
    or v_review_disposition not in ('approved','approved_with_changes')
    or v_review_version is distinct from v_analysis.latest_review_version;
  if v_frozen then return null; end if;
  if v_stale then
    delete from private.voice_plan_current_releases
    where company_id=v_row.company_id and application_id=v_row.application_id;
    return null;
  end if;
  return v_row.release_entry_id;
exception
  when lock_not_available or deadlock_detected or serialization_failure then
    raise exception using errcode='PT409',message='VOICE_PLAN_CONFLICT';
end;
$$;
-- Close both newly defined functions without changing owner defaults, grants
-- on existing objects, or relying on a list of known browser/worker roles.
do $$
declare f record; recipient record;
begin
  for f in select p.oid,p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p where p.oid in (
      'private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)'::pg_catalog.regprocedure,
      'private.sc012b_current_release(uuid)'::pg_catalog.regprocedure
    )
  loop
    execute pg_catalog.format('revoke all on function %s from public cascade',f.signature);
    for recipient in
      select distinct a.grantee from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        where p.oid=f.oid and a.grantee<>0 and a.grantee<>p.proowner
    loop
      execute pg_catalog.format('revoke all on function %s from %I cascade',f.signature,
        pg_catalog.pg_get_userbyid(recipient.grantee));
    end loop;
  end loop;
end;
$$;

-- SC-010 R18: voice plan rows are candidate data. Resolve request results by
-- operation AND tenant, never by UUID text (reviewed R4 voice adapter).
create function private.erasure_voice_request_candidate(tenant uuid,operation text,result uuid)
returns uuid language sql stable security definer set search_path='' as $$
 select a.candidate_id from public.applications a where a.company_id=tenant and a.id in (
  select p.application_id from public.voice_plan_versions p where operation='generate' and p.company_id=tenant and p.id=result
  union all select r.application_id from private.voice_plan_review_entries r where operation='review' and r.company_id=tenant and r.id=result
  union all select r.application_id from private.voice_plan_release_entries r where operation='release' and r.company_id=tenant and r.id=result
 )
$$;

-- Row keys of the two voice tables without an id column; every other adapter
-- keeps its R4 key (this function was last defined by 20261012031039).
create or replace function private.erasure_purge_key(adapter text,data jsonb) returns text
language sql immutable set search_path='' as $$
 select case
 when adapter='private.voice_plan_request_keys' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
 when adapter in ('private.contact_requests','private.erasure_configuration_requests','private.erasure_lifecycle_commands') then data->>'actor_id'||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter in ('private.erasure_candidate_lifecycle','private.retention_candidate_clocks') then data->>'candidate_id'
 when adapter='private.erasure_denial_context' then data->>'txid'||':'||(data->>'candidate_id')
 else data->>'id' end
$$;

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r17;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r17;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;ids uuid[];
begin
 if adapter='private.voice_plan_request_keys' then
  subject:=private.erasure_voice_request_candidate((data->>'company_id')::uuid,data->>'operation',(data->>'result_id')::uuid);
  if subject is null then raise exception using errcode='PT409',message='Unknown voice request dependency';end if;
  return array[subject];
 end if;
 if adapter in ('private.voice_plan_current_releases','private.voice_plan_release_entries','private.voice_plan_review_entries','public.voice_plan_versions') then
  -- Composite foreign keys bind every plan, review, release and pointer to one
  -- (company, application); referenced plan/review/release ids are resolved too.
  select array_agg(distinct a.candidate_id order by a.candidate_id) into ids from public.applications a
  where a.company_id=(data->>'company_id')::uuid and (a.id=(data->>'application_id')::uuid or a.id in (
   select p.application_id from public.voice_plan_versions p where p.company_id=a.company_id
    and p.id in ((data->>'plan_id')::uuid,(data->>'supersedes_plan_id')::uuid)
   union select r.application_id from private.voice_plan_review_entries r where r.company_id=a.company_id
    and r.id in ((data->>'corrects_review_id')::uuid,(data->>'approved_review_id')::uuid)
   union select r.application_id from private.voice_plan_release_entries r where r.company_id=a.company_id
    and r.id=(data->>'release_entry_id')::uuid));
  if coalesce(cardinality(ids),0)=0 then raise exception using errcode='PT409',message='Unknown voice candidate dependency';end if;
  return ids;
 end if;
 return private.erasure_row_candidates_r17(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r17(tenant,subjects)
 union all
 select 'private.voice_plan_current_releases',private.erasure_purge_key('private.voice_plan_current_releases',to_jsonb(t)),to_jsonb(t) from private.voice_plan_current_releases t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
 union all
 select 'private.voice_plan_release_entries',private.erasure_purge_key('private.voice_plan_release_entries',to_jsonb(t)),to_jsonb(t) from private.voice_plan_release_entries t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
 union all
 select 'private.voice_plan_review_entries',private.erasure_purge_key('private.voice_plan_review_entries',to_jsonb(t)),to_jsonb(t) from private.voice_plan_review_entries t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
 union all
 select 'public.voice_plan_versions',private.erasure_purge_key('public.voice_plan_versions',to_jsonb(t)),to_jsonb(t) from public.voice_plan_versions t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
 union all
 select 'private.voice_plan_request_keys',private.erasure_purge_key('private.voice_plan_request_keys',to_jsonb(t)),to_jsonb(t) from private.voice_plan_request_keys t
 where t.company_id=tenant and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id)=any(subjects)
$$;
create table private.erasure_inventory_baseline_r18 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r18 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r18
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r18 select true,'d77384591cfa80a1a2f16d641b7af5e653a21ce49ccc1b7f2db2bbc2539aaebb',
 known_tables||array['private.voice_plan_request_keys','private.voice_plan_current_releases','private.voice_plan_release_entries','private.voice_plan_review_entries','public.voice_plan_versions','private.voice_plan_template_catalog','private.erasure_inventory_baseline_r18']
 from private.erasure_inventory_baseline_r17 where singleton;

-- Normal writes take the candidate lock and refuse frozen candidates; deletes are
-- only the manifest-checked purge, except the app-scoped current-release pointer
-- that sc012b_current_release clears when its source went stale (R4 voice guard).
create function private.erasure_voice_row_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then
  if current_user='erasure_purge_owner' and private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
  if tg_table_name<>'voice_plan_current_releases' then
   raise exception using errcode='42501',message='Controlled voice erasure required';end if;
 end if;
 if tg_table_name='voice_plan_request_keys' and tg_op='UPDATE' then
  raise exception using errcode='42501',message='Immutable voice request';end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,
  case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
  case when tg_op<>'DELETE' then to_jsonb(new) end);
 if tg_op='DELETE' then return old;end if;
 return new;
end;$$;
create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_request_keys
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.voice_plan_request_keys
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.voice_plan_request_keys for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_request_keys',to_jsonb(voice_plan_request_keys)));
create policy erasure_purge_delete on private.voice_plan_request_keys for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_request_keys',to_jsonb(voice_plan_request_keys)));
create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_current_releases
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.voice_plan_current_releases
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.voice_plan_current_releases for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_current_releases',to_jsonb(voice_plan_current_releases)));
create policy erasure_purge_delete on private.voice_plan_current_releases for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_current_releases',to_jsonb(voice_plan_current_releases)));
create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_release_entries
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.voice_plan_release_entries
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.voice_plan_release_entries for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_release_entries',to_jsonb(voice_plan_release_entries)));
create policy erasure_purge_delete on private.voice_plan_release_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_release_entries',to_jsonb(voice_plan_release_entries)));
create trigger erasure_voice_guard before insert or update or delete on private.voice_plan_review_entries
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on private.voice_plan_review_entries
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on private.voice_plan_review_entries for select to erasure_purge_owner using (private.erasure_purge_visible('private.voice_plan_review_entries',to_jsonb(voice_plan_review_entries)));
create policy erasure_purge_delete on private.voice_plan_review_entries for delete to erasure_purge_owner using (private.erasure_purge_allowed('private.voice_plan_review_entries',to_jsonb(voice_plan_review_entries)));
create trigger erasure_voice_guard before insert or update or delete on public.voice_plan_versions
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on public.voice_plan_versions
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on public.voice_plan_versions for select to erasure_purge_owner using (private.erasure_purge_visible('public.voice_plan_versions',to_jsonb(voice_plan_versions)));
create policy erasure_purge_delete on public.voice_plan_versions for delete to erasure_purge_owner using (private.erasure_purge_allowed('public.voice_plan_versions',to_jsonb(voice_plan_versions)));

create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r18;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
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
 select * into baseline from private.erasure_inventory_baseline_r18 where singleton;
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
 select schema_signature into baseline from private.erasure_inventory_baseline_r18 where singleton;
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
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r18 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
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
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r18 where singleton);
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
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_request_keys';
 delete from private.voice_plan_request_keys t where private.erasure_purge_allowed('private.voice_plan_request_keys',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_plan_request_keys',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_current_releases';
 delete from private.voice_plan_current_releases t where private.erasure_purge_allowed('private.voice_plan_current_releases',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_plan_current_releases',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_release_entries';
 delete from private.voice_plan_release_entries t where private.erasure_purge_allowed('private.voice_plan_release_entries',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.voice_plan_release_entries',deleted_count);
 for c in select * from public.voice_plan_versions order by company_id,application_id,plan_version desc loop
  delete from private.voice_plan_review_entries t where t.company_id=c.company_id and t.plan_id=c.id
   and private.erasure_purge_allowed('private.voice_plan_review_entries',to_jsonb(t));
  get diagnostics deleted_count=row_count;
  deleted_counts:=jsonb_set(deleted_counts,'{private.voice_plan_review_entries}',to_jsonb(coalesce((deleted_counts->>'private.voice_plan_review_entries')::bigint,0)+deleted_count));
  delete from public.voice_plan_versions t where t.id=c.id and private.erasure_purge_allowed('public.voice_plan_versions',to_jsonb(t));
  get diagnostics deleted_count=row_count;
  if deleted_count<>1 then raise exception using errcode='PT409',message='Purge plan manifest changed';end if;
  deleted_counts:=jsonb_set(deleted_counts,'{public.voice_plan_versions}',to_jsonb(coalesce((deleted_counts->>'public.voice_plan_versions')::bigint,0)+deleted_count));
 end loop;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.voice_plan_versions';
 if coalesce((deleted_counts->>'public.voice_plan_versions')::bigint,0)<>expected_count then raise exception using errcode='PT409',message='Purge plan count changed';end if;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_review_entries';
 if coalesce((deleted_counts->>'private.voice_plan_review_entries')::bigint,0)<>expected_count then raise exception using errcode='PT409',message='Purge review count changed';end if;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.process_followup_observations';
 delete from private.process_followup_observations t where private.erasure_purge_allowed('private.process_followup_observations',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.process_followup_observations',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.process_followup_grants';
 delete from private.process_followup_grants t where private.erasure_purge_allowed('private.process_followup_grants',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.process_followup_grants',deleted_count);
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.process_followup_cases';
 delete from private.process_followup_cases t where private.erasure_purge_allowed('private.process_followup_cases',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.process_followup_cases',deleted_count);
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










-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('private.voice_plan_request_keys'::regclass,'private.voice_plan_current_releases'::regclass,'private.voice_plan_release_entries'::regclass,'private.voice_plan_review_entries'::regclass,'public.voice_plan_versions'::regclass,'private.voice_plan_template_catalog'::regclass,'private.erasure_inventory_baseline_r18'::regclass) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.voice_plan_protect_history()',
  'private.voice_plan_prototype_lineage_guard()',
  'private.sc012b_assert_fresh_write()',
  'private.erasure_voice_request_candidate(uuid,text,uuid)',
  'private.erasure_voice_row_guard()',
  'private.erasure_row_candidates(text,jsonb)',
  'private.erasure_inventory_rows(uuid,uuid[])',
  'private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)',
  'private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)',
  'private.sc012b_current_release(uuid)']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant select,delete on private.voice_plan_request_keys,private.voice_plan_current_releases,private.voice_plan_release_entries,private.voice_plan_review_entries,public.voice_plan_versions to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from 'd77384591cfa80a1a2f16d641b7af5e653a21ce49ccc1b7f2db2bbc2539aaebb' then
  raise exception 'voice_plan_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r18 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_plan_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-7])([^0-9]|$)') then
  raise exception 'voice_plan_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r18%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_plan_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r17(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r17(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_plan_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid in ('private.voice_plan_request_keys'::regclass,'private.voice_plan_current_releases'::regclass,'private.voice_plan_release_entries'::regclass,'private.voice_plan_review_entries'::regclass,'public.voice_plan_versions'::regclass,'private.voice_plan_template_catalog'::regclass)
  and (not c.relrowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_plan_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array['private.voice_plan_protect_history()','private.voice_plan_prototype_lineage_guard()','private.sc012b_assert_fresh_write()','private.erasure_voice_request_candidate(uuid,text,uuid)','private.erasure_voice_row_guard()','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])','private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)','private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)','private.sc012b_current_release(uuid)']::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_plan_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array['private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)','private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)','private.sc012b_current_release(uuid)']::regprocedure[])
  and (not prosecdef or proconfig is distinct from array['search_path=""'])) then
  raise exception 'voice_plan_definer_search_path' using errcode='55000';end if;
end $postflight$;
commit;
