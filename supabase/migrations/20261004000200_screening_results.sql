begin;

-- SC-004: persisted, immutable screening results. This migration does not call
-- an AI provider and never stores raw provider request/response bodies.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'screening_worker') then
    create role screening_worker nologin noinherit;
  end if;
end;
$$;

alter table public.candidate_documents
  add constraint candidate_documents_company_id_id_key unique (company_id, id);

create table public.screening_analysis_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  position_id uuid not null,
  candidate_document_id uuid not null,
  candidate_document_version integer not null check (candidate_document_version >= 1),
  analysis_version integer not null check (analysis_version >= 1),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  analysis_contract_hash text not null check (analysis_contract_hash ~ '^[0-9a-f]{64}$'),
  payload_schema_version integer not null check (payload_schema_version >= 1),
  result_schema_version integer not null check (result_schema_version >= 1),
  prompt_version text not null check (length(btrim(prompt_version)) between 1 and 200),
  provider text not null check (length(btrim(provider)) between 1 and 100),
  model text not null check (length(btrim(model)) between 1 and 200),
  model_revision text check (model_revision is null or length(btrim(model_revision)) between 1 and 200),
  execution_status text not null default 'pending'
    check (execution_status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  input_cv_text_snapshot text not null
    check (length(btrim(input_cv_text_snapshot)) between 1 and 100000),
  criteria_snapshot jsonb not null check (jsonb_typeof(criteria_snapshot) = 'array'),
  binding_snapshot jsonb not null check (jsonb_typeof(binding_snapshot) = 'object'),
  result_summary jsonb check (result_summary is null or jsonb_typeof(result_summary) = 'object'),
  overall_score numeric(6,3),
  stale_at timestamptz,
  stale_reason text check (stale_reason is null or stale_reason in (
    'application_changed', 'recruitment_changed', 'position_changed',
    'candidate_document_changed', 'candidate_document_unreviewed',
    'screening_contract_changed', 'manual_invalidation',
    'input_changed_during_processing'
  )),
  superseded_by_analysis_id uuid,
  failure_code text check (failure_code is null or length(failure_code) between 1 and 100),
  failure_message text check (failure_message is null or length(failure_message) <= 2000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  latest_review_version integer not null default 0 check (latest_review_version >= 0),
  constraint screening_analysis_status_times_check check (
    (execution_status = 'completed' and completed_at is not null and failed_at is null)
    or (execution_status = 'failed' and failed_at is not null and completed_at is null)
    or (execution_status in ('pending', 'processing', 'cancelled')
      and completed_at is null and failed_at is null)
  ),
  constraint screening_analysis_stale_check check (
    (stale_at is null) = (stale_reason is null)
  ),
  constraint screening_analysis_no_score_check check (overall_score is null),
  constraint screening_analysis_application_fkey
    foreign key (company_id, recruitment_id, application_id)
    references public.applications(company_id, recruitment_id, id) on delete cascade,
  constraint screening_analysis_recruitment_fkey
    foreign key (company_id, recruitment_id)
    references public.recruitments(company_id, id) on delete cascade,
  constraint screening_analysis_position_fkey
    foreign key (company_id, position_id)
    references public.positions(company_id, id) on delete restrict,
  constraint screening_analysis_document_fkey
    foreign key (company_id, candidate_document_id)
    references public.candidate_documents(company_id, id) on delete cascade,
  unique (company_id, id),
  unique (company_id, application_id, analysis_version)
);

alter table public.screening_analysis_versions
  add constraint screening_analysis_superseded_fkey
  foreign key (company_id, superseded_by_analysis_id)
  references public.screening_analysis_versions(company_id, id)
  on delete set null (superseded_by_analysis_id);

create index screening_analysis_application_idx
  on public.screening_analysis_versions(company_id, recruitment_id, application_id, analysis_version desc);
create index screening_analysis_status_idx
  on public.screening_analysis_versions(company_id, recruitment_id, execution_status, stale_at);
create index screening_analysis_reuse_idx
  on public.screening_analysis_versions(company_id, application_id, input_fingerprint, analysis_contract_hash);
create index screening_analysis_document_idx
  on public.screening_analysis_versions(company_id, candidate_document_id, candidate_document_version);
create unique index screening_analysis_current_completed_idx
  on public.screening_analysis_versions(company_id, application_id)
  where execution_status = 'completed' and stale_at is null;
create unique index screening_analysis_active_contract_idx
  on public.screening_analysis_versions(company_id, application_id, input_fingerprint, analysis_contract_hash)
  where execution_status in ('pending', 'processing');

create table public.screening_analysis_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  analysis_id uuid not null,
  attempt_no integer not null check (attempt_no >= 1),
  idempotency_key uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'abandoned')),
  lease_token_hash text check (lease_token_hash is null or lease_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 500),
  provider_response_id text check (provider_response_id is null or length(provider_response_id) <= 500),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cached_input_tokens integer check (cached_input_tokens is null or cached_input_tokens >= 0),
  cost_amount numeric(12,6) check (cost_amount is null or cost_amount >= 0),
  cost_currency char(3) check (cost_currency is null or cost_currency ~ '^[A-Z]{3}$'),
  error_code text check (error_code is null or length(error_code) between 1 and 100),
  finalization_hash text check (finalization_hash is null or finalization_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint screening_attempt_status_check check (
    (status = 'pending' and finished_at is null)
    or (status = 'processing' and started_at is not null and finished_at is null
      and lease_token_hash is not null and lease_expires_at is not null)
    or (status in ('completed', 'failed', 'abandoned') and finished_at is not null)
  ),
  constraint screening_attempt_analysis_fkey
    foreign key (company_id, analysis_id)
    references public.screening_analysis_versions(company_id, id) on delete cascade,
  unique (company_id, analysis_id, attempt_no),
  unique (company_id, idempotency_key)
);
create unique index screening_attempt_active_idx
  on public.screening_analysis_attempts(company_id, analysis_id)
  where status in ('pending', 'processing');
create index screening_attempt_history_idx
  on public.screening_analysis_attempts(company_id, analysis_id, attempt_no desc);

create table public.screening_criterion_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  analysis_id uuid not null,
  criterion_id text not null check (length(criterion_id) between 1 and 100),
  criterion_kind text not null check (criterion_kind in ('task', 'kpi', 'competency')),
  criterion_order integer not null check (criterion_order >= 1),
  criterion_text_snapshot text not null check (length(btrim(criterion_text_snapshot)) between 1 and 500),
  rating text not null check (rating in ('insufficient_data', 'below', 'meets', 'above')),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array'),
  explanation text check (explanation is null or length(explanation) <= 4000),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  created_at timestamptz not null default now(),
  constraint screening_criterion_analysis_fkey
    foreign key (company_id, analysis_id)
    references public.screening_analysis_versions(company_id, id) on delete cascade,
  unique (company_id, id),
  unique (company_id, id, analysis_id),
  unique (company_id, analysis_id, criterion_id),
  unique (company_id, analysis_id, criterion_order)
);
create index screening_criterion_order_idx
  on public.screening_criterion_results(company_id, analysis_id, criterion_order);
create index screening_criterion_rating_idx
  on public.screening_criterion_results(company_id, analysis_id, rating);

create table public.screening_result_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  analysis_id uuid not null,
  review_version integer not null check (review_version >= 1),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  disposition text not null
    check (disposition in ('approved', 'approved_with_changes', 'needs_reanalysis')),
  review_note text check (review_note is null or length(review_note) <= 10000),
  created_at timestamptz not null default now(),
  constraint screening_review_analysis_fkey
    foreign key (company_id, analysis_id)
    references public.screening_analysis_versions(company_id, id) on delete cascade,
  unique (company_id, id),
  unique (company_id, analysis_id, review_version)
);
create index screening_review_history_idx
  on public.screening_result_reviews(company_id, analysis_id, review_version desc);
create index screening_review_reviewer_idx
  on public.screening_result_reviews(company_id, reviewer_id, created_at desc);

create table public.screening_criterion_review_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  review_id uuid not null,
  criterion_result_id uuid not null,
  rating_override text
    check (rating_override is null or rating_override in ('insufficient_data', 'below', 'meets', 'above')),
  evidence_override jsonb
    check (evidence_override is null or jsonb_typeof(evidence_override) = 'array'),
  explanation_override text
    check (explanation_override is null or length(explanation_override) <= 4000),
  created_at timestamptz not null default now(),
  constraint screening_override_not_empty_check check (
    rating_override is not null or evidence_override is not null or explanation_override is not null
  ),
  constraint screening_override_review_fkey
    foreign key (company_id, review_id)
    references public.screening_result_reviews(company_id, id) on delete cascade,
  constraint screening_override_criterion_fkey
    foreign key (company_id, criterion_result_id)
    references public.screening_criterion_results(company_id, id) on delete cascade,
  unique (company_id, review_id, criterion_result_id)
);
create index screening_override_review_idx
  on public.screening_criterion_review_overrides(company_id, review_id);

alter table public.screening_analysis_versions enable row level security;
alter table public.screening_analysis_attempts enable row level security;
alter table public.screening_criterion_results enable row level security;
alter table public.screening_result_reviews enable row level security;
alter table public.screening_criterion_review_overrides enable row level security;

revoke all on public.screening_analysis_versions from public, anon, authenticated, screening_worker;
revoke all on public.screening_analysis_attempts from public, anon, authenticated, screening_worker;
revoke all on public.screening_criterion_results from public, anon, authenticated, screening_worker;
revoke all on public.screening_result_reviews from public, anon, authenticated, screening_worker;
revoke all on public.screening_criterion_review_overrides from public, anon, authenticated, screening_worker;
grant select on public.screening_analysis_versions to authenticated;
grant select on public.screening_analysis_attempts to authenticated;
grant select on public.screening_criterion_results to authenticated;
grant select on public.screening_result_reviews to authenticated;
grant select on public.screening_criterion_review_overrides to authenticated;

create policy screening_analysis_read on public.screening_analysis_versions
  for select to authenticated using (private.has_company_access(company_id));
create policy screening_attempt_read on public.screening_analysis_attempts
  for select to authenticated using (private.has_company_access(company_id));
create policy screening_criterion_read on public.screening_criterion_results
  for select to authenticated using (private.has_company_access(company_id));
create policy screening_review_read on public.screening_result_reviews
  for select to authenticated using (private.has_company_access(company_id));
create policy screening_override_read on public.screening_criterion_review_overrides
  for select to authenticated using (private.has_company_access(company_id));

create function private.screening_hash(value text)
returns text language sql immutable strict set search_path = '' as $$
  select encode(sha256(convert_to(value, 'UTF8')), 'hex');
$$;

create function private.screening_contract_hash(
  requested_provider text,
  requested_model text,
  requested_model_revision text,
  requested_prompt_version text,
  requested_payload_schema_version integer,
  requested_result_schema_version integer
) returns text language sql immutable set search_path = '' as $$
  select private.screening_hash(
    '{"provider":' || to_json(requested_provider)::text
    || ',"model":' || to_json(requested_model)::text
    || ',"model_revision":' || coalesce(to_json(requested_model_revision)::text, 'null')
    || ',"prompt_version":' || to_json(requested_prompt_version)::text
    || ',"payload_schema_version":' || requested_payload_schema_version::text
    || ',"result_schema_version":' || requested_result_schema_version::text || '}'
  );
$$;

create function private.screening_utf16_length(value text)
returns integer language plpgsql immutable strict set search_path = '' as $$
declare
  result integer := 0;
  index integer;
begin
  if value = '' then return 0; end if;
  for index in 1..char_length(value) loop
    result := result + case when ascii(substr(value, index, 1)) > 65535 then 2 else 1 end;
  end loop;
  return result;
end;
$$;

create function private.screening_utf16_slice(value text, start_offset integer, end_offset integer)
returns text language plpgsql immutable set search_path = '' as $$
declare
  result text := '';
  current_offset integer := 0;
  next_offset integer;
  index integer;
  character text;
  start_seen boolean := false;
  end_seen boolean := false;
begin
  if value is null or start_offset is null or end_offset is null
    or start_offset < 0 or end_offset <= start_offset then return null; end if;
  if start_offset = 0 then start_seen := true; end if;
  for index in 1..char_length(value) loop
    character := substr(value, index, 1);
    next_offset := current_offset + case when ascii(character) > 65535 then 2 else 1 end;
    if current_offset = start_offset then start_seen := true; end if;
    if start_seen and current_offset >= start_offset and next_offset <= end_offset then
      result := result || character;
    end if;
    current_offset := next_offset;
    if current_offset = end_offset then end_seen := true; exit; end if;
    if current_offset > end_offset then return null; end if;
  end loop;
  if not start_seen or not end_seen then return null; end if;
  return result;
end;
$$;

create function private.screening_valid_evidence(
  source_text text,
  evidence jsonb,
  evidence_required boolean
) returns boolean language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  start_offset integer;
  end_offset integer;
  quote text;
begin
  if jsonb_typeof(evidence) is distinct from 'array'
    or jsonb_array_length(evidence) > 5
    or (evidence_required and jsonb_array_length(evidence) = 0) then return false; end if;
  for item in select value from jsonb_array_elements(evidence) loop
    if jsonb_typeof(item) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(item) key
        where key not in ('start', 'end', 'quote')
      )
      or jsonb_typeof(item->'start') is distinct from 'number'
      or jsonb_typeof(item->'end') is distinct from 'number'
      or jsonb_typeof(item->'quote') is distinct from 'string'
      or item->>'start' !~ '^(0|[1-9][0-9]*)$'
      or item->>'end' !~ '^(0|[1-9][0-9]*)$' then return false; end if;
    start_offset := (item->>'start')::integer;
    end_offset := (item->>'end')::integer;
    quote := item->>'quote';
    if length(btrim(quote)) = 0 or private.screening_utf16_length(quote) > 2000
      or private.screening_utf16_slice(source_text, start_offset, end_offset) is distinct from quote
      then return false; end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create function private.screening_material(target_application uuid, lock_rows boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  application public.applications%rowtype;
  recruitment public.recruitments%rowtype;
  position public.positions%rowtype;
  document public.candidate_documents%rowtype;
  criteria jsonb;
  criteria_text text;
  binding jsonb;
  canonical text;
  fingerprint text;
begin
  if lock_rows then
    select * into application from public.applications
      where id = target_application for share;
  else
    select * into application from public.applications where id = target_application;
  end if;
  if not found then raise exception 'Missing application' using errcode = '42501'; end if;

  if lock_rows then
    select * into recruitment from public.recruitments
      where id = application.recruitment_id and company_id = application.company_id for share;
  else
    select * into recruitment from public.recruitments
      where id = application.recruitment_id and company_id = application.company_id;
  end if;
  if not found then raise exception 'Missing recruitment' using errcode = '42501'; end if;

  if lock_rows then
    select * into position from public.positions
      where id = recruitment.position_id and company_id = application.company_id for share;
  else
    select * into position from public.positions
      where id = recruitment.position_id and company_id = application.company_id;
  end if;
  if not found then raise exception 'Missing position' using errcode = '42501'; end if;

  if lock_rows then
    select * into document from public.candidate_documents
      where company_id = application.company_id and candidate_id = application.candidate_id
      order by created_at desc, id desc limit 1 for share;
  else
    select * into document from public.candidate_documents
      where company_id = application.company_id and candidate_id = application.candidate_id
      order by created_at desc, id desc limit 1;
  end if;
  if not found then raise exception 'Missing candidate document' using errcode = '55000'; end if;
  if application.status not in ('new', 'in_progress')
    or recruitment.status not in ('draft', 'open')
    or position.status = 'archived'
    or document.status <> 'reviewed' or document.reviewed_by is null or document.reviewed_at is null
    then raise exception 'Screening input is not eligible' using errcode = '55000'; end if;
  if cardinality(position.tasks) = 0 or cardinality(position.kpis) = 0
    or cardinality(position.tasks) > 30 or cardinality(position.kpis) > 30
    or cardinality(position.required_competencies) > 30
    or exists (
      select 1 from unnest(position.tasks || position.kpis || position.required_competencies) item
      where length(btrim(item)) = 0 or length(item) > 500
    ) then raise exception 'Invalid screening criteria' using errcode = '22023'; end if;

  select jsonb_agg(jsonb_build_object(
      'id', kind || ':' || item_order::text,
      'kind', kind,
      'text', item
    ) order by group_order, item_order)
  into criteria
  from (
    select 1 as group_order, 'task'::text as kind, item, item_order
      from unnest(position.tasks) with ordinality source(item, item_order)
    union all
    select 2, 'kpi', item, item_order
      from unnest(position.kpis) with ordinality source(item, item_order)
    union all
    select 3, 'competency', item, item_order
      from unnest(position.required_competencies) with ordinality source(item, item_order)
  ) ordered_criteria;

  select string_agg(
    '{"id":' || to_json(item->>'id')::text
    || ',"kind":' || to_json(item->>'kind')::text
    || ',"text":' || to_json(item->>'text')::text || '}',
    ',' order by item_order
  ) into criteria_text
  from jsonb_array_elements(criteria) with ordinality source(item, item_order);

  binding := jsonb_build_object(
    'company_id', application.company_id::text,
    'application_id', application.id::text,
    'application_updated_at', application.updated_at,
    'recruitment_id', recruitment.id::text,
    'recruitment_updated_at', recruitment.updated_at,
    'position_id', position.id::text,
    'position_updated_at', position.updated_at,
    'document_id', document.id::text,
    'document_version', document.version
  );
  canonical := '{"binding":{"company_id":' || to_json(application.company_id::text)::text
    || ',"application_id":' || to_json(application.id::text)::text
    || ',"application_updated_at":' || to_json(application.updated_at)::text
    || ',"recruitment_id":' || to_json(recruitment.id::text)::text
    || ',"recruitment_updated_at":' || to_json(recruitment.updated_at)::text
    || ',"position_id":' || to_json(position.id::text)::text
    || ',"position_updated_at":' || to_json(position.updated_at)::text
    || ',"document_id":' || to_json(document.id::text)::text
    || ',"document_version":' || document.version::text
    || '},"payload":{"schema_version":1,"cv_text":' || to_json(document.redacted_text)::text
    || ',"criteria":[' || criteria_text || ']}}';
  fingerprint := private.screening_hash(canonical);

  return jsonb_build_object(
    'company_id', application.company_id,
    'recruitment_id', recruitment.id,
    'application_id', application.id,
    'position_id', position.id,
    'candidate_document_id', document.id,
    'candidate_document_version', document.version,
    'input_cv_text_snapshot', document.redacted_text,
    'criteria_snapshot', criteria,
    'binding_snapshot', binding,
    'input_fingerprint', fingerprint
  );
end;
$$;

create function private.screening_stale_reason(target_analysis uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  analysis public.screening_analysis_versions%rowtype;
  application public.applications%rowtype;
  recruitment public.recruitments%rowtype;
  position public.positions%rowtype;
  document public.candidate_documents%rowtype;
begin
  select * into analysis from public.screening_analysis_versions where id = target_analysis;
  if not found then return 'application_changed'; end if;
  select * into application from public.applications
    where id = analysis.application_id and company_id = analysis.company_id;
  if not found or application.status not in ('new', 'in_progress')
    or analysis.binding_snapshot->>'application_updated_at' is distinct from to_jsonb(application.updated_at)#>>'{}'
    then return 'application_changed'; end if;
  select * into recruitment from public.recruitments
    where id = analysis.recruitment_id and company_id = analysis.company_id;
  if not found or recruitment.status not in ('draft', 'open')
    or analysis.binding_snapshot->>'recruitment_updated_at' is distinct from to_jsonb(recruitment.updated_at)#>>'{}'
    then return 'recruitment_changed'; end if;
  select * into position from public.positions
    where id = analysis.position_id and company_id = analysis.company_id;
  if not found or position.status = 'archived'
    or analysis.binding_snapshot->>'position_updated_at' is distinct from to_jsonb(position.updated_at)#>>'{}'
    then return 'position_changed'; end if;
  select * into document from public.candidate_documents
    where company_id = analysis.company_id and candidate_id = application.candidate_id
    order by created_at desc, id desc limit 1;
  if not found or document.id <> analysis.candidate_document_id
    or document.version <> analysis.candidate_document_version
    then return 'candidate_document_changed'; end if;
  if document.status <> 'reviewed' or document.reviewed_by is null or document.reviewed_at is null
    then return 'candidate_document_unreviewed'; end if;
  return null;
end;
$$;

create function private.mark_screening_stale_for_application(target_application uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.screening_analysis_versions
  set stale_at = clock_timestamp(), stale_reason = reason, updated_at = clock_timestamp()
  where application_id = target_application and stale_at is null;
end;
$$;

create function private.screening_application_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.mark_screening_stale_for_application(new.id, 'application_changed');
  return new;
end;
$$;
create trigger screening_application_stale after update on public.applications
  for each row execute function private.screening_application_stale_trigger();

create function private.screening_recruitment_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.screening_analysis_versions
  set stale_at = clock_timestamp(), stale_reason = 'recruitment_changed', updated_at = clock_timestamp()
  where company_id = new.company_id and recruitment_id = new.id and stale_at is null;
  return new;
end;
$$;
create trigger screening_recruitment_stale after update on public.recruitments
  for each row execute function private.screening_recruitment_stale_trigger();

create function private.screening_position_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.screening_analysis_versions
  set stale_at = clock_timestamp(), stale_reason = 'position_changed', updated_at = clock_timestamp()
  where company_id = new.company_id and position_id = new.id and stale_at is null;
  return new;
end;
$$;
create trigger screening_position_stale after update on public.positions
  for each row execute function private.screening_position_stale_trigger();

create function private.screening_document_stale_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  reason text := case when new.status = 'reviewed'
    then 'candidate_document_changed' else 'candidate_document_unreviewed' end;
begin
  update public.screening_analysis_versions analysis
  set stale_at = clock_timestamp(), stale_reason = reason, updated_at = clock_timestamp()
  where analysis.company_id = new.company_id and analysis.stale_at is null
    and exists (
      select 1 from public.applications application
      where application.company_id = new.company_id
        and application.candidate_id = new.candidate_id
        and application.id = analysis.application_id
    );
  return new;
end;
$$;
create trigger screening_document_stale after insert or update on public.candidate_documents
  for each row execute function private.screening_document_stale_trigger();

create function public.start_screening_analysis(
  target_application uuid,
  expected_input_fingerprint text,
  expected_payload_schema_version integer,
  requested_result_schema_version integer,
  requested_prompt_version text,
  requested_provider text,
  requested_model text,
  requested_model_revision text,
  request_idempotency_key uuid,
  force_reanalysis boolean default false
) returns table (
  analysis_id uuid,
  attempt_id uuid,
  analysis_version integer,
  execution_status text,
  reused boolean
) language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  application_company uuid;
  material jsonb;
  contract_hash text;
  existing_analysis public.screening_analysis_versions%rowtype;
  existing_attempt public.screening_analysis_attempts%rowtype;
  new_analysis_id uuid;
  new_attempt_id uuid;
  next_version integer;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_application is null or request_idempotency_key is null
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_payload_schema_version <> 1
    or requested_result_schema_version is null or requested_result_schema_version < 1
    or length(btrim(requested_prompt_version)) not between 1 and 200
    or length(btrim(requested_provider)) not between 1 and 100
    or length(btrim(requested_model)) not between 1 and 200
    or (requested_model_revision is not null
      and length(btrim(requested_model_revision)) not between 1 and 200)
    then raise exception 'Invalid screening request' using errcode = '22023'; end if;

  select company_id into application_company from public.applications where id = target_application;
  if not found or not private.has_company_access(application_company, true)
    then raise exception 'No write access' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended('screening:' || target_application::text, 0));
  material := private.screening_material(target_application, true);
  if material->>'company_id' <> application_company::text
    then raise exception 'Invalid tenant binding' using errcode = '42501'; end if;
  if material->>'input_fingerprint' <> expected_input_fingerprint
    then raise exception 'Screening input changed' using errcode = 'PT409'; end if;
  contract_hash := private.screening_contract_hash(
    btrim(requested_provider), btrim(requested_model),
    case when requested_model_revision is null then null else btrim(requested_model_revision) end,
    btrim(requested_prompt_version), expected_payload_schema_version, requested_result_schema_version
  );

  select * into existing_attempt
  from public.screening_analysis_attempts attempt
  where attempt.company_id = application_company
    and attempt.idempotency_key = request_idempotency_key;
  if found then
    select * into existing_analysis
    from public.screening_analysis_versions analysis
    where analysis.company_id = existing_attempt.company_id
      and analysis.id = existing_attempt.analysis_id;
    if existing_analysis.application_id <> target_application
      or existing_analysis.input_fingerprint <> expected_input_fingerprint
      or existing_analysis.analysis_contract_hash <> contract_hash
      then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
    return query select existing_analysis.id, existing_attempt.id,
      existing_analysis.analysis_version, existing_analysis.execution_status, true;
    return;
  end if;

  update public.screening_analysis_versions analysis
  set stale_at = clock_timestamp(),
      stale_reason = coalesce(private.screening_stale_reason(analysis.id), 'manual_invalidation'),
      updated_at = clock_timestamp()
  where analysis.company_id = application_company
    and analysis.application_id = target_application
    and analysis.stale_at is null
    and analysis.input_fingerprint <> expected_input_fingerprint;

  if not force_reanalysis then
    select * into existing_analysis
    from public.screening_analysis_versions analysis
    where analysis.company_id = application_company
      and analysis.application_id = target_application
      and analysis.input_fingerprint = expected_input_fingerprint
      and analysis.analysis_contract_hash = contract_hash
      and analysis.execution_status = 'completed'
      and analysis.stale_at is null
      and (select count(*) from public.screening_criterion_results criterion
        where criterion.company_id = analysis.company_id and criterion.analysis_id = analysis.id)
        = jsonb_array_length(analysis.criteria_snapshot)
      and coalesce((
        select review.disposition from public.screening_result_reviews review
        where review.company_id = analysis.company_id and review.analysis_id = analysis.id
        order by review.review_version desc limit 1
      ), '') <> 'needs_reanalysis'
    order by analysis.analysis_version desc limit 1;
    if found then
      return query select existing_analysis.id, null::uuid,
        existing_analysis.analysis_version, existing_analysis.execution_status, true;
      return;
    end if;

    select * into existing_analysis
    from public.screening_analysis_versions analysis
    where analysis.company_id = application_company
      and analysis.application_id = target_application
      and analysis.input_fingerprint = expected_input_fingerprint
      and analysis.analysis_contract_hash = contract_hash
      and analysis.execution_status in ('pending', 'processing')
    order by analysis.analysis_version desc limit 1;
    if found then
      select * into existing_attempt from public.screening_analysis_attempts attempt
      where attempt.company_id = application_company and attempt.analysis_id = existing_analysis.id
        and attempt.status in ('pending', 'processing')
      order by attempt.attempt_no desc limit 1;
      return query select existing_analysis.id, existing_attempt.id,
        existing_analysis.analysis_version, existing_analysis.execution_status, true;
      return;
    end if;
  end if;

  -- Even an explicit reanalysis cannot create a second active execution for the
  -- same input and contract. It may create a new version after the active one
  -- reaches a terminal state.
  select * into existing_analysis
  from public.screening_analysis_versions analysis
  where analysis.company_id = application_company
    and analysis.application_id = target_application
    and analysis.input_fingerprint = expected_input_fingerprint
    and analysis.analysis_contract_hash = contract_hash
    and analysis.execution_status in ('pending', 'processing')
  order by analysis.analysis_version desc limit 1;
  if found then
    select * into existing_attempt from public.screening_analysis_attempts attempt
    where attempt.company_id = application_company and attempt.analysis_id = existing_analysis.id
      and attempt.status in ('pending', 'processing')
    order by attempt.attempt_no desc limit 1;
    return query select existing_analysis.id, existing_attempt.id,
      existing_analysis.analysis_version, existing_analysis.execution_status, true;
    return;
  end if;

  select coalesce(max(analysis.analysis_version), 0) + 1 into next_version
  from public.screening_analysis_versions analysis
  where analysis.company_id = application_company and analysis.application_id = target_application;

  insert into public.screening_analysis_versions(
    company_id, recruitment_id, application_id, position_id,
    candidate_document_id, candidate_document_version, analysis_version,
    input_fingerprint, analysis_contract_hash, payload_schema_version,
    result_schema_version, prompt_version, provider, model, model_revision,
    input_cv_text_snapshot, criteria_snapshot, binding_snapshot, created_by
  ) values (
    application_company,
    (material->>'recruitment_id')::uuid,
    target_application,
    (material->>'position_id')::uuid,
    (material->>'candidate_document_id')::uuid,
    (material->>'candidate_document_version')::integer,
    next_version,
    expected_input_fingerprint,
    contract_hash,
    expected_payload_schema_version,
    requested_result_schema_version,
    btrim(requested_prompt_version),
    btrim(requested_provider),
    btrim(requested_model),
    case when requested_model_revision is null then null else btrim(requested_model_revision) end,
    material->>'input_cv_text_snapshot',
    material->'criteria_snapshot',
    material->'binding_snapshot',
    actor
  ) returning id into new_analysis_id;

  insert into public.screening_analysis_attempts(
    company_id, analysis_id, attempt_no, idempotency_key
  ) values (
    application_company, new_analysis_id, 1, request_idempotency_key
  ) returning id into new_attempt_id;

  return query select new_analysis_id, new_attempt_id, next_version, 'pending'::text, false;
end;
$$;

create function public.claim_screening_attempt(target_attempt uuid)
returns table (
  analysis_id uuid,
  attempt_id uuid,
  lease_token text,
  lease_expires_at timestamptz
) language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  stale_reason text;
  raw_token text;
  expires_at timestamptz;
begin
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if attempt.status <> 'pending'
    and not (attempt.status = 'processing' and attempt.lease_expires_at <= clock_timestamp())
    then raise exception 'Attempt is not claimable' using errcode = '55000'; end if;

  stale_reason := private.screening_stale_reason(analysis.id);
  if stale_reason is not null then
    update public.screening_analysis_attempts
      set status = 'abandoned', finished_at = clock_timestamp()
      where id = attempt.id;
    update public.screening_analysis_versions
      set execution_status = 'cancelled',
        stale_at = coalesce(stale_at, clock_timestamp()),
        stale_reason = coalesce(screening_analysis_versions.stale_reason, stale_reason),
        updated_at = clock_timestamp()
      where id = analysis.id;
    return;
  end if;

  raw_token := replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');
  expires_at := clock_timestamp() + interval '5 minutes';
  update public.screening_analysis_attempts
    set status = 'processing',
      lease_token_hash = private.screening_hash(raw_token),
      lease_expires_at = expires_at,
      started_at = coalesce(started_at, clock_timestamp())
    where id = attempt.id;
  update public.screening_analysis_versions
    set execution_status = 'processing',
      processing_started_at = coalesce(processing_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
    where id = analysis.id;
  return query select analysis.id, attempt.id, raw_token, expires_at;
end;
$$;

create function public.retry_screening_analysis(
  target_analysis uuid,
  request_idempotency_key uuid
) returns table (
  analysis_id uuid,
  attempt_id uuid,
  analysis_version integer
) language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  material jsonb;
  existing_attempt public.screening_analysis_attempts%rowtype;
  next_attempt integer;
  next_version integer;
  new_analysis_id uuid;
  new_attempt_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_analysis is null or request_idempotency_key is null
    then raise exception 'Invalid retry request' using errcode = '22023'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || analysis.application_id::text, 0));

  select * into existing_attempt from public.screening_analysis_attempts
    where company_id = analysis.company_id and idempotency_key = request_idempotency_key;
  if found then
    if existing_attempt.analysis_id <> analysis.id
      then raise exception 'Idempotency key conflict' using errcode = 'PT409'; end if;
    return query select analysis.id, existing_attempt.id, analysis.analysis_version;
    return;
  end if;
  if analysis.execution_status not in ('failed', 'pending')
    or exists (
      select 1 from public.screening_analysis_attempts attempt
      where attempt.company_id = analysis.company_id and attempt.analysis_id = analysis.id
        and attempt.status in ('pending', 'processing')
    ) then raise exception 'Analysis cannot be retried' using errcode = '55000'; end if;

  material := private.screening_material(analysis.application_id, true);
  if material->>'input_fingerprint' = analysis.input_fingerprint then
    select coalesce(max(item.attempt_no), 0) + 1 into next_attempt
      from public.screening_analysis_attempts item
      where item.company_id = analysis.company_id and item.analysis_id = analysis.id;
    insert into public.screening_analysis_attempts(
      company_id, analysis_id, attempt_no, idempotency_key
    ) values (
      analysis.company_id, analysis.id, next_attempt, request_idempotency_key
    ) returning id into new_attempt_id;
    update public.screening_analysis_versions
      set execution_status = 'pending', failed_at = null,
        failure_code = null, failure_message = null, updated_at = clock_timestamp()
      where id = analysis.id;
    return query select analysis.id, new_attempt_id, analysis.analysis_version;
    return;
  end if;

  update public.screening_analysis_versions
    set stale_at = coalesce(stale_at, clock_timestamp()),
      stale_reason = coalesce(screening_analysis_versions.stale_reason,
        private.screening_stale_reason(analysis.id), 'manual_invalidation'),
      updated_at = clock_timestamp()
    where id = analysis.id;
  select coalesce(max(item.analysis_version), 0) + 1 into next_version
    from public.screening_analysis_versions item
    where item.company_id = analysis.company_id and item.application_id = analysis.application_id;
  insert into public.screening_analysis_versions(
    company_id, recruitment_id, application_id, position_id,
    candidate_document_id, candidate_document_version, analysis_version,
    input_fingerprint, analysis_contract_hash, payload_schema_version,
    result_schema_version, prompt_version, provider, model, model_revision,
    input_cv_text_snapshot, criteria_snapshot, binding_snapshot, created_by
  ) values (
    analysis.company_id,
    (material->>'recruitment_id')::uuid,
    analysis.application_id,
    (material->>'position_id')::uuid,
    (material->>'candidate_document_id')::uuid,
    (material->>'candidate_document_version')::integer,
    next_version,
    material->>'input_fingerprint',
    analysis.analysis_contract_hash,
    analysis.payload_schema_version,
    analysis.result_schema_version,
    analysis.prompt_version,
    analysis.provider,
    analysis.model,
    analysis.model_revision,
    material->>'input_cv_text_snapshot',
    material->'criteria_snapshot',
    material->'binding_snapshot',
    actor
  ) returning id into new_analysis_id;
  insert into public.screening_analysis_attempts(
    company_id, analysis_id, attempt_no, idempotency_key
  ) values (
    analysis.company_id, new_analysis_id, 1, request_idempotency_key
  ) returning id into new_attempt_id;
  return query select new_analysis_id, new_attempt_id, next_version;
end;
$$;

create function public.complete_screening_analysis(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  findings jsonb,
  new_provider_request_id text default null,
  new_provider_response_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  expected_criterion jsonb;
  finding jsonb;
  item_order bigint;
  rating text;
  evidence jsonb;
  explanation text;
  confidence numeric;
  computed_finalization_hash text;
  detected_stale_reason text;
begin
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(findings) is distinct from 'array'
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    or length(coalesce(new_provider_request_id, '')) > 500
    or length(coalesce(new_provider_response_id, '')) > 500
    then raise exception 'Invalid completion metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'findings', findings,
    'provider_request_id', new_provider_request_id,
    'provider_response_id', new_provider_response_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;

  if attempt.status = 'completed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting completion' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;
  if jsonb_array_length(findings) <> jsonb_array_length(analysis.criteria_snapshot)
    then raise exception 'Incomplete criterion set' using errcode = '22023'; end if;

  for expected_criterion, item_order in
    select value, ordinality
    from jsonb_array_elements(analysis.criteria_snapshot) with ordinality
  loop
    select value into finding
    from jsonb_array_elements(findings)
    where value->>'criterion_id' = expected_criterion->>'id';
    if not found or (
      select count(*) from jsonb_array_elements(findings)
      where value->>'criterion_id' = expected_criterion->>'id'
    ) <> 1 then raise exception 'Invalid criterion set' using errcode = '22023'; end if;
    if jsonb_typeof(finding) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(finding) key
        where key not in ('criterion_id', 'rating', 'evidence', 'explanation', 'confidence')
      )
      or jsonb_typeof(finding->'criterion_id') is distinct from 'string'
      or jsonb_typeof(finding->'rating') is distinct from 'string'
      or jsonb_typeof(finding->'evidence') is distinct from 'array'
      or (finding ? 'explanation'
        and jsonb_typeof(finding->'explanation') not in ('string', 'null'))
      or (finding ? 'confidence'
        and jsonb_typeof(finding->'confidence') not in ('number', 'null'))
      then raise exception 'Invalid criterion result' using errcode = '22023'; end if;
    rating := finding->>'rating';
    evidence := finding->'evidence';
    explanation := finding->>'explanation';
    confidence := case when jsonb_typeof(finding->'confidence') = 'number'
      then (finding->>'confidence')::numeric else null end;
    if rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or confidence < 0 or confidence > 1
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid evidence' using errcode = '22023'; end if;

    insert into public.screening_criterion_results(
      company_id, analysis_id, criterion_id, criterion_kind, criterion_order,
      criterion_text_snapshot, rating, evidence, explanation, confidence
    ) values (
      analysis.company_id, analysis.id, expected_criterion->>'id',
      expected_criterion->>'kind', item_order, expected_criterion->>'text',
      rating, evidence, explanation, confidence
    );
  end loop;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is null and analysis.stale_at is null then
    update public.screening_analysis_versions previous
    set stale_at = clock_timestamp(),
      stale_reason = case
        when previous.input_fingerprint <> analysis.input_fingerprint
          then coalesce(private.screening_stale_reason(previous.id), 'manual_invalidation')
        when previous.analysis_contract_hash <> analysis.analysis_contract_hash
          then 'screening_contract_changed'
        else 'manual_invalidation'
      end,
      superseded_by_analysis_id = analysis.id,
      updated_at = clock_timestamp()
    where previous.company_id = analysis.company_id
      and previous.application_id = analysis.application_id
      and previous.id <> analysis.id
      and previous.execution_status = 'completed'
      and previous.stale_at is null;
  end if;

  update public.screening_analysis_attempts
  set status = 'completed',
    provider_request_id = new_provider_request_id,
    provider_response_id = new_provider_response_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'completed',
    completed_at = clock_timestamp(),
    failed_at = null,
    failure_code = null,
    failure_message = null,
    stale_at = case when detected_stale_reason is not null or stale_at is not null
      then coalesce(stale_at, clock_timestamp()) else null end,
    stale_reason = case when detected_stale_reason is not null or stale_at is not null
      then 'input_changed_during_processing' else null end,
    overall_score = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid completion payload' using errcode = '22023';
end;
$$;

create function public.fail_screening_attempt(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  new_error_code text,
  new_error_message text default null,
  new_provider_request_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  computed_finalization_hash text;
begin
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or new_error_code is null or new_error_code !~ '^[a-z0-9_:-]{1,100}$'
    or length(coalesce(new_error_message, '')) > 2000
    or length(coalesce(new_provider_request_id, '')) > 500
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    then raise exception 'Invalid failure metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'error_code', new_error_code,
    'error_message', new_error_message,
    'provider_request_id', new_provider_request_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  select * into analysis from public.screening_analysis_versions
    where id = attempt.analysis_id and company_id = attempt.company_id for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if attempt.status = 'failed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting failure' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;

  update public.screening_analysis_attempts
  set status = 'failed',
    provider_request_id = new_provider_request_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    error_code = new_error_code,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'failed',
    failure_code = new_error_code,
    failure_message = new_error_message,
    failed_at = clock_timestamp(),
    completed_at = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
end;
$$;

create function public.review_screening_result(
  target_analysis uuid,
  expected_review_version integer,
  new_disposition text,
  new_review_note text,
  new_overrides jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  analysis public.screening_analysis_versions%rowtype;
  review_id uuid;
  override_item jsonb;
  criterion public.screening_criterion_results%rowtype;
  rating text;
  evidence jsonb;
  explanation text;
  detected_stale_reason text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if expected_review_version is null or expected_review_version < 0
    or new_disposition not in ('approved', 'approved_with_changes', 'needs_reanalysis')
    or length(coalesce(new_review_note, '')) > 10000
    or jsonb_typeof(new_overrides) is distinct from 'array'
    then raise exception 'Invalid review' using errcode = '22023'; end if;

  select * into analysis from public.screening_analysis_versions
    where id = target_analysis for update;
  if not found or not private.has_company_access(analysis.company_id, true)
    then raise exception 'No write access' using errcode = '42501'; end if;
  if analysis.execution_status <> 'completed'
    then raise exception 'Only completed results can be reviewed' using errcode = '55000'; end if;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is not null and analysis.stale_at is null then
    update public.screening_analysis_versions
      set stale_at = clock_timestamp(), stale_reason = detected_stale_reason,
        updated_at = clock_timestamp()
      where id = analysis.id;
    analysis.stale_at := clock_timestamp();
    analysis.stale_reason := detected_stale_reason;
  end if;
  if analysis.latest_review_version <> expected_review_version
    then raise exception 'Review changed' using errcode = 'PT409'; end if;
  if analysis.stale_at is not null
    and (new_disposition <> 'needs_reanalysis' or jsonb_array_length(new_overrides) <> 0)
    then raise exception 'Stale result requires reanalysis' using errcode = '55000'; end if;
  if (new_disposition = 'approved_with_changes' and jsonb_array_length(new_overrides) = 0)
    or (new_disposition in ('approved', 'needs_reanalysis')
      and jsonb_array_length(new_overrides) <> 0)
    then raise exception 'Overrides do not match disposition' using errcode = '22023'; end if;

  for override_item in select value from jsonb_array_elements(new_overrides) loop
    if jsonb_typeof(override_item) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(override_item) key
        where key not in (
          'criterion_result_id', 'rating_override',
          'evidence_override', 'explanation_override'
        )
      )
      or jsonb_typeof(override_item->'criterion_result_id') is distinct from 'string'
      or (override_item ? 'rating_override'
        and jsonb_typeof(override_item->'rating_override') not in ('string', 'null'))
      or (override_item ? 'evidence_override'
        and jsonb_typeof(override_item->'evidence_override') not in ('array', 'null'))
      or (override_item ? 'explanation_override'
        and jsonb_typeof(override_item->'explanation_override') not in ('string', 'null'))
      then raise exception 'Invalid review override' using errcode = '22023'; end if;
    begin
      select * into criterion from public.screening_criterion_results
      where id = (override_item->>'criterion_result_id')::uuid
        and company_id = analysis.company_id and analysis_id = analysis.id;
    exception when invalid_text_representation then
      raise exception 'Invalid criterion reference' using errcode = '22023';
    end;
    if not found then raise exception 'Criterion does not belong to analysis' using errcode = '22023'; end if;
    rating := coalesce(override_item->>'rating_override', criterion.rating);
    evidence := case when override_item ? 'evidence_override'
      and jsonb_typeof(override_item->'evidence_override') <> 'null'
      then override_item->'evidence_override' else criterion.evidence end;
    explanation := override_item->>'explanation_override';
    if not (override_item ? 'rating_override'
      or override_item ? 'evidence_override'
      or override_item ? 'explanation_override')
      or rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid review evidence' using errcode = '22023'; end if;
  end loop;
  if (
    select count(distinct value->>'criterion_result_id')
    from jsonb_array_elements(new_overrides)
  ) <> jsonb_array_length(new_overrides)
    then raise exception 'Duplicate review override' using errcode = '22023'; end if;

  insert into public.screening_result_reviews(
    company_id, analysis_id, review_version, reviewer_id,
    disposition, review_note
  ) values (
    analysis.company_id, analysis.id, expected_review_version + 1, actor,
    new_disposition, nullif(btrim(new_review_note), '')
  ) returning id into review_id;

  for override_item in select value from jsonb_array_elements(new_overrides) loop
    insert into public.screening_criterion_review_overrides(
      company_id, review_id, criterion_result_id,
      rating_override, evidence_override, explanation_override
    ) values (
      analysis.company_id,
      review_id,
      (override_item->>'criterion_result_id')::uuid,
      override_item->>'rating_override',
      case when override_item ? 'evidence_override'
        and jsonb_typeof(override_item->'evidence_override') <> 'null'
        then override_item->'evidence_override' else null end,
      override_item->>'explanation_override'
    );
  end loop;
  update public.screening_analysis_versions
    set latest_review_version = expected_review_version + 1,
      updated_at = clock_timestamp()
    where id = analysis.id;
  return review_id;
end;
$$;

revoke all on function private.screening_hash(text) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_contract_hash(text,text,text,text,integer,integer) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_utf16_length(text) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_utf16_slice(text,integer,integer) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_valid_evidence(text,jsonb,boolean) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_material(uuid,boolean) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_stale_reason(uuid) from public, anon, authenticated, screening_worker;
revoke all on function private.mark_screening_stale_for_application(uuid,text) from public, anon, authenticated, screening_worker;
revoke all on function private.screening_application_stale_trigger() from public, anon, authenticated, screening_worker;
revoke all on function private.screening_recruitment_stale_trigger() from public, anon, authenticated, screening_worker;
revoke all on function private.screening_position_stale_trigger() from public, anon, authenticated, screening_worker;
revoke all on function private.screening_document_stale_trigger() from public, anon, authenticated, screening_worker;

revoke all on function public.start_screening_analysis(uuid,text,integer,integer,text,text,text,text,uuid,boolean)
  from public, anon, authenticated, screening_worker;
revoke all on function public.retry_screening_analysis(uuid,uuid)
  from public, anon, authenticated, screening_worker;
revoke all on function public.review_screening_result(uuid,integer,text,text,jsonb)
  from public, anon, authenticated, screening_worker;
revoke all on function public.claim_screening_attempt(uuid)
  from public, anon, authenticated, screening_worker;
revoke all on function public.complete_screening_analysis(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)
  from public, anon, authenticated, screening_worker;
revoke all on function public.fail_screening_attempt(uuid,text,text,text,text,text,text,integer,integer,integer,numeric,text)
  from public, anon, authenticated, screening_worker;

grant execute on function public.start_screening_analysis(uuid,text,integer,integer,text,text,text,text,uuid,boolean)
  to authenticated;
grant execute on function public.retry_screening_analysis(uuid,uuid)
  to authenticated;
grant execute on function public.review_screening_result(uuid,integer,text,text,jsonb)
  to authenticated;
grant usage on schema public to screening_worker;
grant execute on function public.claim_screening_attempt(uuid)
  to screening_worker;
grant execute on function public.complete_screening_analysis(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)
  to screening_worker;
grant execute on function public.fail_screening_attempt(uuid,text,text,text,text,text,text,integer,integer,integer,numeric,text)
  to screening_worker;

commit;
