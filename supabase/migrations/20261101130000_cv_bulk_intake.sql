-- SC-BULK-001: bulk CV intake, package slot reservation, background queue,
-- automatic preselection groups and per-CV AI usage.
--
-- Trust model
-- * Every table is private (RLS on, no Data API grants). Reads and writes go
--   through SECURITY DEFINER RPCs that derive the tenant from the batch,
--   recruitment or application and re-check private.has_company_access.
-- * Package slots: a batch reserves min(files, sc19 available) credits in one
--   company-locked transaction (the same lock order as every SC-019 write), so
--   concurrent batches can never reserve more than the balance. Each slot is
--   returned (bulk_release) when its file fails before analysis, or handed to
--   the existing SC-019 analysis charge (bulk_transfer +1 immediately followed
--   by the analysis_reserve -1 of private.sc19_charge_analysis in the same
--   transaction). A failed/cancelled analysis is refunded by the unchanged
--   SC-019 trigger, so only a completed analysis consumes a credit.
-- * Background starts run on behalf of the operator who confirmed the batch:
--   private.cv_bulk_act_as sets the transaction-local JWT subject, and the
--   unchanged public.start_screening_analysis / retry_screening_analysis
--   re-check that person's current write access, the reviewed CV, recruitment
--   state and fingerprint. A worker without a user session may only reach this
--   through a request signed with the database-held worker secret.
-- * Groups are a proposal for the recruiter. They never change
--   applications.status, never write hire/reject and never replace the SC-008
--   human-reviewed shortlist (recruitment_shortlist_entries stays human-only).
-- * Erasure: every candidate-linked row cascades from public.candidates or
--   public.applications (a duplicate file row cascades from the application it
--   duplicates) and is listed by the R9 inventory adapters
--   (20261101130100_cv_bulk_erasure_inventory_r9.sql, which must follow).
-- * Original files are never stored. Only the file name (cleared after 30 days
--   for files that did not become a candidate) and the extracted text in the
--   existing candidate_documents table are kept.
begin;

-- SC-019 journal: three bulk reasons, every balance change stays journaled.
alter table private.sc19_credit_journal drop constraint sc19_credit_journal_reason_check;
alter table private.sc19_credit_journal add constraint sc19_credit_journal_reason_check
  check (reason in ('trial','paid_grant','analysis_reserve','analysis_release','analysis_retry',
    'bulk_reserve','bulk_release','bulk_transfer'));

create table private.cv_bulk_settings (
  singleton boolean primary key default true check (singleton),
  worker_secret text check (worker_secret is null or octet_length(worker_secret) >= 32),
  max_parallel_company integer not null default 4 check (max_parallel_company between 1 and 20),
  max_parallel_global integer not null default 12 check (max_parallel_global between 1 and 100),
  max_analysis_retries integer not null default 2 check (max_analysis_retries between 0 and 5),
  updated_at timestamptz not null default now()
);
insert into private.cv_bulk_settings(singleton) values (true);

create table private.cv_bulk_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recruitment_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  request_key uuid not null,
  declared_files integer not null check (declared_files between 1 and 100),
  reserved_slots integer not null check (reserved_slots >= 0 and reserved_slots <= declared_files),
  available_before integer not null check (available_before >= 0),
  status text not null default 'uploading' check (status in ('uploading','processing','completed')),
  upload_closed_at timestamptz,
  completed_at timestamptz,
  notify_state text not null default 'pending' check (notify_state in ('pending','sending','sent','failed','skipped')),
  notify_attempts integer not null default 0 check (notify_attempts between 0 and 10),
  notify_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, request_key),
  foreign key (company_id, recruitment_id) references public.recruitments(company_id, id) on delete cascade,
  check ((status = 'completed') = (completed_at is not null))
);
create index cv_bulk_batches_recruitment_idx on private.cv_bulk_batches(company_id, recruitment_id, created_at desc);
create index cv_bulk_batches_open_idx on private.cv_bulk_batches(status, updated_at) where status <> 'completed' or notify_state in ('pending','sending');

create table private.cv_bulk_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  batch_id uuid not null,
  position integer not null check (position between 1 and 100),
  file_name text check (file_name is null or length(file_name) between 1 and 255),
  file_kind text not null check (file_kind in ('pdf','docx','txt','image','other')),
  file_bytes integer not null check (file_bytes >= 0),
  phase text not null check (phase in ('awaiting_upload','queued','analyzing','done','error')),
  error_reason text check (error_reason is null or error_reason in (
    'over_limit','unreadable_scan','protected_pdf','bad_format','too_large','no_text','duplicate',
    'not_uploaded','analysis_failed','not_eligible')),
  slot_state text not null check (slot_state in ('none','held','transferred','released')),
  ocr_used boolean not null default false,
  name_detected boolean not null default false,
  candidate_id uuid,
  application_id uuid,
  duplicate_of_application uuid,
  analysis_id uuid,
  analysis_retries integer not null default 0 check (analysis_retries between 0 and 5),
  dispatched_at timestamptz,
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens is null or cached_input_tokens >= 0),
  cost_amount numeric(12,6) check (cost_amount is null or cost_amount >= 0),
  cost_currency text check (cost_currency is null or cost_currency ~ '^[A-Z]{3}$'),
  pricing_version text check (pricing_version is null or length(pricing_version) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, position),
  foreign key (company_id, batch_id) references private.cv_bulk_batches(company_id, id) on delete cascade,
  foreign key (company_id, candidate_id) references public.candidates(company_id, id) on delete cascade,
  foreign key (application_id) references public.applications(id) on delete cascade,
  foreign key (duplicate_of_application) references public.applications(id) on delete cascade,
  foreign key (analysis_id) references public.screening_analysis_versions(id) on delete set null,
  check ((phase = 'error') = (error_reason is not null)),
  check (phase not in ('queued','analyzing','done') or (candidate_id is not null and application_id is not null)),
  check (phase <> 'analyzing' or analysis_id is not null),
  check (slot_state <> 'held' or phase in ('awaiting_upload','queued')),
  check (error_reason is distinct from 'duplicate' or slot_state in ('released','none'))
);
create index cv_bulk_items_phase_idx on private.cv_bulk_items(company_id, phase);
create index cv_bulk_items_candidate_idx on private.cv_bulk_items(company_id, candidate_id) where candidate_id is not null;
create index cv_bulk_items_application_idx on private.cv_bulk_items(application_id) where application_id is not null;

-- Proposal groups for any application (bulk or single), one row per application.
create table private.application_preselection_groups (
  id uuid not null default gen_random_uuid() unique,
  application_id uuid primary key references public.applications(id) on delete cascade,
  company_id uuid not null,
  recruitment_id uuid not null,
  group_key text not null check (group_key in ('passed','review','rejected')),
  source text not null check (source in ('auto','manual')),
  policy_version text not null check (policy_version = 'preselection-groups-v1'),
  analysis_id uuid references public.screening_analysis_versions(id) on delete set null,
  raw_score numeric(5,2) check (raw_score is null or raw_score between 0 and 100),
  coverage numeric(5,4) check (coverage is null or coverage between 0 and 1),
  changed_by uuid references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  foreign key (company_id, recruitment_id) references public.recruitments(company_id, id) on delete cascade,
  check ((source = 'manual') = (changed_by is not null))
);
create index application_preselection_groups_recruitment_idx on private.application_preselection_groups(company_id, recruitment_id, group_key);

create table private.application_preselection_group_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  company_id uuid not null,
  from_group text check (from_group is null or from_group in ('passed','review','rejected')),
  to_group text not null check (to_group in ('passed','review','rejected')),
  source text not null check (source in ('auto','manual')),
  actor_id uuid references auth.users(id) on delete restrict,
  note text check (note is null or (note = btrim(note) and length(note) between 1 and 500)),
  created_at timestamptz not null default now(),
  check ((source = 'manual') = (actor_id is not null))
);
create index application_preselection_group_events_idx on private.application_preselection_group_events(company_id, application_id, created_at);

do $acl$
declare t text;
begin
  foreach t in array array['cv_bulk_settings','cv_bulk_batches','cv_bulk_items','application_preselection_groups','application_preselection_group_events'] loop
    execute format('revoke all on private.%I from public, anon, authenticated', t);
    execute format('alter table private.%I enable row level security', t);
  end loop;
end $acl$;

create function private.cv_bulk_events_append_only() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op = 'UPDATE' then raise exception using errcode='42501', message='Append-only group history'; end if;
  return old;
end;$$;
revoke all on function private.cv_bulk_events_append_only() from public, anon, authenticated;
create trigger append_only before update on private.application_preselection_group_events
  for each row execute function private.cv_bulk_events_append_only();

-- Transaction-local identity for background work on behalf of the batch
-- operator. Never granted; the callers below decide when it is allowed.
create function private.cv_bulk_act_as(actor uuid) returns void
language plpgsql set search_path='' as $$
begin
  if actor is null then raise exception using errcode='42501', message='Actor required'; end if;
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
end;$$;
revoke all on function private.cv_bulk_act_as(uuid) from public, anon, authenticated;

create function private.cv_bulk_journal(target_company uuid, why text, change integer, ref text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if change = 0 then return; end if;
  update private.sc19_balances set available = available + change, updated_at = now()
    where company_id = target_company and available + change >= 0;
  if not found then raise exception using errcode='PT409', message='cv_bulk_balance_mismatch'; end if;
  insert into private.sc19_credit_journal(company_id, reason, delta, reference) values (target_company, why, change, ref);
end;$$;
revoke all on function private.cv_bulk_journal(uuid,text,integer,text) from public, anon, authenticated;

-- Group policy preselection-groups-v1 (a proposal, never a decision):
-- * evidence-matrix results (result schema 2) store a neutral legacy rating, so
--   they are scored by evidence verdict: supported/partial/missing/contradicted
--   = 100/50/0/0 over all criteria (CV-to-criteria evidence fit, coverage 1);
-- * legacy results (schema 1) use screening-ranking-v1 points below/meets/above
--   = 0/50/100, insufficient_data unknown, coverage < 0.60 never auto-sorted.
-- passed >= 60, rejected < 35, otherwise the recruiter decides.
create function private.cv_bulk_group_for(score numeric, cover numeric) returns text
language sql immutable set search_path='' as $$
  select case when score is null or cover is null or cover < 0.60 then 'review'
    when score >= 60 then 'passed' when score < 35 then 'rejected' else 'review' end
$$;
revoke all on function private.cv_bulk_group_for(numeric,numeric) from public, anon, authenticated;

create function private.cv_bulk_phone_digits(value text) returns text
language sql immutable set search_path='' as $$
  select nullif(right(regexp_replace(coalesce(value,''), '\D', '', 'g'), 9), '')
$$;
revoke all on function private.cv_bulk_phone_digits(text) from public, anon, authenticated;

create function public.cv_bulk_create_batch(target_recruitment uuid, request_key uuid, files jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.recruitments; existing private.cv_bulk_batches; batch_id uuid; avail integer; reserve integer;
  total integer; f jsonb; pos integer := 0; kind text; fname text; fsize bigint;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if request_key is null or files is null or jsonb_typeof(files) <> 'array' then
    raise exception using errcode='22023', message='Invalid batch'; end if;
  total := jsonb_array_length(files);
  if total < 1 or total > 100 then raise exception using errcode='22023', message='cv_bulk_file_count'; end if;
  select * into r from public.recruitments where id = target_recruitment;
  if r.id is null or not private.has_company_access(r.company_id, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  if r.status not in ('draft','open') or exists(select 1 from public.positions p where p.company_id = r.company_id and p.id = r.position_id and p.status = 'archived') then
    raise exception using errcode='55000', message='cv_bulk_recruitment_closed'; end if;
  perform private.sc19_lock_company(r.company_id);
  select * into existing from private.cv_bulk_batches b where b.company_id = r.company_id and b.request_key = cv_bulk_create_batch.request_key;
  if existing.id is not null then
    if existing.recruitment_id <> r.id or existing.declared_files <> total then
      raise exception using errcode='PT409', message='Request key reused'; end if;
    return jsonb_build_object('batch_id', existing.id, 'reserved_slots', existing.reserved_slots,
      'over_limit', existing.declared_files - existing.reserved_slots, 'available_before', existing.available_before);
  end if;
  select available into avail from private.sc19_balances where company_id = r.company_id for update;
  avail := coalesce(avail, 0);
  reserve := least(total, avail);
  insert into private.cv_bulk_batches(company_id, recruitment_id, created_by, request_key, declared_files, reserved_slots, available_before)
    values (r.company_id, r.id, auth.uid(), cv_bulk_create_batch.request_key, total, reserve, avail) returning id into batch_id;
  if reserve > 0 then
    perform private.cv_bulk_journal(r.company_id, 'bulk_reserve', -reserve, 'cv-bulk-reserve:' || batch_id);
  end if;
  for f in select value from jsonb_array_elements(files) loop
    pos := pos + 1;
    fname := btrim(coalesce(f->>'name', ''));
    kind := coalesce(f->>'kind', 'other');
    fsize := coalesce((f->>'size')::bigint, -1);
    if fname = '' or length(fname) > 255 or kind not in ('pdf','docx','txt','image','other') or fsize < 0 or fsize > 2147483647 then
      raise exception using errcode='22023', message='Invalid file entry'; end if;
    insert into private.cv_bulk_items(company_id, batch_id, position, file_name, file_kind, file_bytes, phase, error_reason, slot_state)
      values (r.company_id, batch_id, pos, fname, kind, fsize,
        case when pos <= reserve then 'awaiting_upload' else 'error' end,
        case when pos <= reserve then null else 'over_limit' end,
        case when pos <= reserve then 'held' else 'none' end);
  end loop;
  return jsonb_build_object('batch_id', batch_id, 'reserved_slots', reserve, 'over_limit', total - reserve, 'available_before', avail);
end;$$;

-- Internal: return one held slot to the package.
create function private.cv_bulk_release_slot(item private.cv_bulk_items) returns void
language plpgsql security definer set search_path='' as $$
begin
  if item.slot_state = 'held' then
    perform private.cv_bulk_journal(item.company_id, 'bulk_release', 1, 'cv-bulk-release:' || item.id);
    update private.cv_bulk_items set slot_state = 'released', updated_at = now() where id = item.id;
  end if;
end;$$;
revoke all on function private.cv_bulk_release_slot(private.cv_bulk_items) from public, anon, authenticated;

create function private.cv_bulk_item_for_write(target_item uuid) returns private.cv_bulk_items
language plpgsql security definer set search_path='' as $$
declare item private.cv_bulk_items; company uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select company_id into company from private.cv_bulk_items where id = target_item;
  if company is null or not private.has_company_access(company, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  -- Company before item/balance, the SC-019 lock order.
  perform private.sc19_lock_company(company);
  select * into item from private.cv_bulk_items where id = target_item for update;
  return item;
end;$$;
revoke all on function private.cv_bulk_item_for_write(uuid) from public, anon, authenticated;

create function public.cv_bulk_fail_item(target_item uuid, reason text) returns boolean
language plpgsql security definer set search_path='' as $$
declare item private.cv_bulk_items;
begin
  if reason is null or reason not in ('unreadable_scan','protected_pdf','bad_format','too_large','no_text') then
    raise exception using errcode='22023', message='Invalid reason'; end if;
  item := private.cv_bulk_item_for_write(target_item);
  if item.phase <> 'awaiting_upload' then return false; end if;
  perform private.cv_bulk_release_slot(item);
  update private.cv_bulk_items set phase = 'error', error_reason = reason, updated_at = now() where id = item.id;
  perform private.cv_bulk_touch(item.batch_id);
  return true;
end;$$;

-- Batch bookkeeping after any item change: close uploads when nothing awaits.
create function private.cv_bulk_touch(target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update private.cv_bulk_batches b set updated_at = now(),
    status = case when b.status = 'uploading' and not exists(select 1 from private.cv_bulk_items i where i.batch_id = b.id and i.phase = 'awaiting_upload') then 'processing' else b.status end,
    upload_closed_at = case when b.upload_closed_at is null and not exists(select 1 from private.cv_bulk_items i where i.batch_id = b.id and i.phase = 'awaiting_upload') then now() else b.upload_closed_at end
    where b.id = target_batch;
end;$$;
revoke all on function private.cv_bulk_touch(uuid) from public, anon, authenticated;

create function public.cv_bulk_register_item(target_item uuid, extracted jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item private.cv_bulk_items; b private.cv_bulk_batches; first text; last text; mail text; tel text;
  src text; red text; named boolean; dup uuid; person uuid; doc uuid; app uuid;
begin
  item := private.cv_bulk_item_for_write(target_item);
  if item.phase <> 'awaiting_upload' then
    return jsonb_build_object('status', item.phase, 'error_reason', item.error_reason, 'application_id', item.application_id);
  end if;
  select * into b from private.cv_bulk_batches where id = item.batch_id;
  if extracted is null or jsonb_typeof(extracted) <> 'object' then raise exception using errcode='22023', message='Invalid extraction'; end if;
  first := btrim(coalesce(extracted->>'first_name', ''));
  last := btrim(coalesce(extracted->>'last_name', ''));
  mail := nullif(lower(btrim(coalesce(extracted->>'email', ''))), '');
  tel := nullif(btrim(coalesce(extracted->>'phone', '')), '');
  src := extracted->>'source_text';
  red := extracted->>'redacted_text';
  named := coalesce((extracted->>'name_detected')::boolean, false);
  if length(first) not between 1 and 100 or length(last) not between 1 and 100
    or (mail is not null and (length(mail) > 254 or mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
    or (tel is not null and (length(tel) > 32 or tel !~ '^\+?[0-9 ()-]{7,31}$'))
    or src is null or red is null or length(btrim(src)) not between 1 and 100000 or length(btrim(red)) not between 1 and 100000 then
    raise exception using errcode='22023', message='Invalid extraction'; end if;
  -- Duplicate detection per recruitment, serialized against concurrent uploads.
  perform pg_advisory_xact_lock(hashtext('cv_bulk_recruitment'), hashtext(b.recruitment_id::text));
  select a.id into dup from public.applications a join public.candidates c on c.company_id = a.company_id and c.id = a.candidate_id
    where a.company_id = b.company_id and a.recruitment_id = b.recruitment_id
      and ((mail is not null and lower(btrim(c.email)) = mail)
        or (tel is not null and private.cv_bulk_phone_digits(c.phone) = private.cv_bulk_phone_digits(tel) and length(private.cv_bulk_phone_digits(tel)) = 9)
        or (named and lower(btrim(c.first_name)) = lower(first) and lower(btrim(c.last_name)) = lower(last)))
    order by a.created_at, a.id limit 1;
  if dup is not null then
    perform private.cv_bulk_release_slot(item);
    update private.cv_bulk_items set phase = 'error', error_reason = 'duplicate', duplicate_of_application = dup,
      ocr_used = coalesce((extracted->>'ocr_used')::boolean, false), updated_at = now() where id = item.id;
    perform private.cv_bulk_touch(item.batch_id);
    return jsonb_build_object('status', 'error', 'error_reason', 'duplicate', 'duplicate_of_application', dup);
  end if;
  insert into public.candidates(company_id, first_name, last_name, email, phone)
    values (b.company_id, first, last, mail, tel) returning id into person;
  insert into public.candidate_documents(company_id, candidate_id, source_text, redacted_text)
    values (b.company_id, person, btrim(src), btrim(red)) returning id into doc;
  -- The batch confirmation is the operator's approval of the automatic
  -- redaction for this upload (recorded as the reviewer, like a manual review).
  update public.candidate_documents set status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now() where id = doc;
  insert into public.applications(company_id, recruitment_id, candidate_id)
    values (b.company_id, b.recruitment_id, person) returning id into app;
  update private.cv_bulk_items set phase = 'queued', candidate_id = person, application_id = app,
    ocr_used = coalesce((extracted->>'ocr_used')::boolean, false), name_detected = named, updated_at = now()
    where id = item.id;
  perform private.cv_bulk_touch(item.batch_id);
  return jsonb_build_object('status', 'queued', 'application_id', app, 'candidate_id', person);
end;$$;

-- Operator ends uploading early (closed tab, cancelled): unsent files free their slots.
create function public.cv_bulk_close_upload(target_batch uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches; item private.cv_bulk_items; n integer := 0;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select * into b from private.cv_bulk_batches where id = target_batch;
  if b.id is null or not private.has_company_access(b.company_id, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  perform private.sc19_lock_company(b.company_id);
  for item in select * from private.cv_bulk_items where batch_id = b.id and phase = 'awaiting_upload' order by position for update loop
    perform private.cv_bulk_release_slot(item);
    update private.cv_bulk_items set phase = 'error', error_reason = 'not_uploaded', updated_at = now() where id = item.id;
    n := n + 1;
  end loop;
  perform private.cv_bulk_touch(b.id);
  return n;
end;$$;

-- Auto group from the AI ratings of a completed analysis (no human review yet).
create function private.cv_bulk_apply_auto_group(target_application uuid, target_analysis uuid) returns void
language plpgsql security definer set search_path='' as $$
declare total integer; known integer; with_verdict integer; score numeric; verdict_score numeric; cover numeric; grp text;
  app public.applications; old_group text; old_source text;
begin
  select * into app from public.applications where id = target_application;
  if app.id is null then return; end if;
  select count(*), count(*) filter (where rating <> 'insufficient_data'),
    avg(case rating when 'below' then 0 when 'meets' then 50 when 'above' then 100 end),
    count(*) filter (where verdict is not null),
    avg(case verdict when 'supported' then 100 when 'partial' then 50 when 'missing' then 0 when 'contradicted' then 0 end)
    into total, known, score, with_verdict, verdict_score
    from public.screening_criterion_results where analysis_id = target_analysis;
  if total > 0 and with_verdict = total then
    score := verdict_score; cover := 1;
  else
    cover := case when total > 0 then round(known::numeric / total, 4) end;
  end if;
  score := round(score, 2);
  grp := private.cv_bulk_group_for(score, cover);
  select group_key, source into old_group, old_source from private.application_preselection_groups where application_id = app.id for update;
  if old_source = 'manual' then
    -- A recruiter's manual placement is never overwritten; keep the new score for reference.
    update private.application_preselection_groups set analysis_id = target_analysis, raw_score = score, coverage = cover, updated_at = now()
      where application_id = app.id;
    return;
  end if;
  insert into private.application_preselection_groups(application_id, company_id, recruitment_id, group_key, source, policy_version, analysis_id, raw_score, coverage)
    values (app.id, app.company_id, app.recruitment_id, grp, 'auto', 'preselection-groups-v1', target_analysis, score, cover)
    on conflict (application_id) do update set group_key = excluded.group_key, analysis_id = excluded.analysis_id,
      raw_score = excluded.raw_score, coverage = excluded.coverage, updated_at = now();
  if old_group is distinct from grp then
    insert into private.application_preselection_group_events(application_id, company_id, from_group, to_group, source)
      values (app.id, app.company_id, old_group, grp, 'auto');
  end if;
end;$$;
revoke all on function private.cv_bulk_apply_auto_group(uuid,uuid) from public, anon, authenticated;

-- One pump step for one batch. Caller must already hold the company lock and
-- have established the acting identity. Returns attempts to dispatch and an
-- optional e-mail notification claim.
create function private.cv_bulk_pump_batch(b private.cv_bulk_batches, contract jsonb, pricing jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.cv_bulk_settings; item private.cv_bulk_items; a public.screening_analysis_versions;
  dispatch uuid[] := '{}'; started record; retried record; fp text; inflight integer; inflight_global integer;
  in_tok bigint; out_tok bigint; cached_tok bigint; cost numeric; notify jsonb; email text; claimed uuid;
  p_in numeric; p_cached numeric; p_out numeric;
begin
  select * into s from private.cv_bulk_settings where singleton;
  p_in := nullif(pricing->>'input_per_mtok', '')::numeric;
  p_cached := coalesce(nullif(pricing->>'cached_input_per_mtok', '')::numeric, p_in);
  p_out := nullif(pricing->>'output_per_mtok', '')::numeric;
  -- 1. Settle analyses that left processing.
  for item in select * from private.cv_bulk_items where batch_id = b.id and phase = 'analyzing' order by position for update loop
    select * into a from public.screening_analysis_versions where id = item.analysis_id;
    if a.id is null then
      update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
    elsif a.execution_status = 'completed' then
      select sum(input_tokens), sum(output_tokens), sum(cached_input_tokens) into in_tok, out_tok, cached_tok
        from public.screening_analysis_attempts where analysis_id = a.id;
      cost := case when p_in is null or p_out is null or in_tok is null or out_tok is null then null else
        round(((in_tok - coalesce(cached_tok, 0)) * p_in + coalesce(cached_tok, 0) * p_cached + out_tok * p_out) / 1000000.0, 6) end;
      update private.cv_bulk_items set phase = 'done', input_tokens = in_tok, output_tokens = out_tok, cached_input_tokens = cached_tok,
        cost_amount = cost, cost_currency = case when cost is null then null else coalesce(pricing->>'currency', 'USD') end,
        pricing_version = case when cost is null then null else left(pricing->>'version', 80) end, updated_at = now()
        where id = item.id;
      perform private.cv_bulk_apply_auto_group(item.application_id, a.id);
    elsif a.execution_status in ('failed','cancelled') then
      if a.execution_status = 'failed' and item.analysis_retries < s.max_analysis_retries and a.stale_at is null then
        begin
          select * into retried from public.retry_screening_analysis(a.id, gen_random_uuid());
          update private.cv_bulk_items set analysis_retries = analysis_retries + 1, dispatched_at = now(), updated_at = now() where id = item.id;
          dispatch := dispatch || retried.attempt_id;
        exception when others then
          update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
        end;
      else
        update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
      end if;
    elsif a.execution_status = 'pending' and (item.dispatched_at is null or item.dispatched_at < now() - interval '3 minutes') then
      -- Lost dispatch: send the same pending attempt again (claim is idempotent).
      dispatch := dispatch || (select t.id from public.screening_analysis_attempts t where t.analysis_id = a.id and t.status = 'pending' order by t.attempt_no desc limit 1);
      update private.cv_bulk_items set dispatched_at = now(), updated_at = now() where id = item.id;
    elsif a.execution_status = 'processing' and (item.dispatched_at is null or item.dispatched_at < now() - interval '3 minutes')
      and exists(select 1 from public.screening_analysis_attempts t where t.analysis_id = a.id and t.status = 'processing'
                 and t.lease_expires_at <= clock_timestamp()) then
      -- Worker died after claiming: the lease expired, so claim_screening_attempt(_v2) accepts the same attempt again.
      dispatch := dispatch || (select t.id from public.screening_analysis_attempts t where t.analysis_id = a.id and t.status = 'processing'
                               and t.lease_expires_at <= clock_timestamp() order by t.attempt_no desc limit 1);
      update private.cv_bulk_items set dispatched_at = now(), updated_at = now() where id = item.id;
    end if;
  end loop;
  -- 2. Start queued items within the parallel limits.
  select count(*) into inflight from private.cv_bulk_items where company_id = b.company_id and phase = 'analyzing';
  select count(*) into inflight_global from private.cv_bulk_items where phase = 'analyzing';
  if contract is not null then
    for item in select * from private.cv_bulk_items where batch_id = b.id and phase = 'queued' order by position for update skip locked loop
      exit when inflight >= s.max_parallel_company or inflight_global >= s.max_parallel_global;
      begin
        fp := private.screening_material(item.application_id, false)->>'input_fingerprint';
        -- Hand the held slot to the SC-019 analysis charge in this transaction.
        if item.slot_state = 'held' then
          perform private.cv_bulk_journal(item.company_id, 'bulk_transfer', 1, 'cv-bulk-transfer:' || item.id);
        end if;
        select * into started from public.start_screening_analysis(item.application_id, fp,
          (contract->>'payload_schema_version')::integer, (contract->>'result_schema_version')::integer,
          contract->>'prompt_version', contract->>'provider', contract->>'model', contract->>'model_revision', gen_random_uuid());
        update private.cv_bulk_items set phase = 'analyzing', analysis_id = started.analysis_id, slot_state = 'transferred',
          dispatched_at = now(), updated_at = now() where id = item.id;
        if started.execution_status in ('pending','processing') then dispatch := dispatch || started.attempt_id; end if;
        inflight := inflight + 1; inflight_global := inflight_global + 1;
      exception when others then
        -- Subtransaction rolled back the transfer; the slot is still held.
        perform private.cv_bulk_release_slot(item);
        update private.cv_bulk_items set phase = 'error', error_reason = 'not_eligible', updated_at = now() where id = item.id;
      end;
    end loop;
  end if;
  -- 3. Completion and notification claim.
  perform private.cv_bulk_touch(b.id);
  update private.cv_bulk_batches set status = 'completed', completed_at = now(), updated_at = now()
    where id = b.id and status = 'processing'
      and not exists(select 1 from private.cv_bulk_items i where i.batch_id = b.id and i.phase in ('awaiting_upload','queued','analyzing'));
  update private.cv_bulk_batches set notify_state = 'sending', notify_attempts = notify_attempts + 1,
      notify_lease_until = now() + interval '2 minutes', updated_at = now()
    where id = b.id and status = 'completed' and notify_attempts < 5
      and (notify_state = 'pending' or (notify_state = 'sending' and notify_lease_until < now()))
    returning id into claimed;
  if claimed is not null then
    select to_jsonb(u)->>'email' into email from auth.users u where u.id = b.created_by;
    select jsonb_build_object('batch_id', b.id, 'recruitment_id', b.recruitment_id, 'company_id', b.company_id, 'email', email,
      'recruitment_name', (select name from public.recruitments where id = b.recruitment_id),
      'files', b.declared_files,
      'done', count(*) filter (where i.phase = 'done'),
      'errors', count(*) filter (where i.phase = 'error'),
      'passed', count(*) filter (where g.group_key = 'passed'),
      'review', count(*) filter (where g.group_key = 'review'),
      'rejected', count(*) filter (where g.group_key = 'rejected'))
      into notify from private.cv_bulk_items i left join private.application_preselection_groups g on g.application_id = i.application_id
      where i.batch_id = b.id;
  end if;
  return jsonb_build_object('dispatch', to_jsonb(dispatch), 'notify', notify);
end;$$;
revoke all on function private.cv_bulk_pump_batch(private.cv_bulk_batches,jsonb,jsonb) from public, anon, authenticated;

create function private.cv_bulk_valid_contract(contract jsonb) returns boolean
language sql immutable set search_path='' as $$
  select contract is null or (jsonb_typeof(contract) = 'object'
    and (contract->>'payload_schema_version') ~ '^[0-9]{1,4}$' and (contract->>'result_schema_version') ~ '^[0-9]{1,4}$'
    and length(coalesce(contract->>'prompt_version','')) between 1 and 100 and length(coalesce(contract->>'provider','')) between 1 and 100
    and length(coalesce(contract->>'model','')) between 1 and 100 and (contract->>'model_revision' is null or length(contract->>'model_revision') between 1 and 100))
$$;
revoke all on function private.cv_bulk_valid_contract(jsonb) from public, anon, authenticated;

-- User-session pump (upload responses and the progress page).
create function public.cv_bulk_pump(target_batch uuid, contract jsonb default null, pricing jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches; company uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if not private.cv_bulk_valid_contract(contract) then raise exception using errcode='22023', message='Invalid contract'; end if;
  select company_id into company from private.cv_bulk_batches where id = target_batch;
  if company is null or not private.has_company_access(company, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  perform private.sc19_lock_company(company);
  select * into b from private.cv_bulk_batches where id = target_batch for update skip locked;
  if b.id is null then return jsonb_build_object('dispatch', '[]'::jsonb, 'notify', null); end if;
  -- Starts run as the calling recruiter; start_screening_analysis re-checks access.
  return private.cv_bulk_pump_batch(b, contract, pricing);
end;$$;

create function private.cv_bulk_verify_signature(op text, request_id uuid, stamp bigint, target uuid, extra text, signature text) returns boolean
language plpgsql security definer set search_path='' as $$
declare secret text;
begin
  select worker_secret into secret from private.cv_bulk_settings where singleton;
  if secret is null or request_id is null or stamp is null or signature is null then return false; end if;
  if abs(extract(epoch from clock_timestamp()) * 1000 - stamp::numeric) > 60000 then return false; end if;
  return signature = encode(extensions.hmac(concat_ws(E'\n', 'cv-bulk-v1', op, request_id::text, stamp::text,
    coalesce(target::text, '-'), coalesce(extra, '-')), secret, 'sha256'), 'hex');
end;$$;
revoke all on function private.cv_bulk_verify_signature(text,uuid,bigint,uuid,text,text) from public, anon, authenticated;

-- Background pump for a scheduler: signed with the database-held secret.
create function public.cv_bulk_worker_pump(request_id uuid, issued_at_ms bigint, request_signature text, contract jsonb default null, pricing jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches; target uuid; results jsonb := '[]'; one jsonb;
begin
  if not private.cv_bulk_verify_signature('pump', request_id, issued_at_ms, null, md5(coalesce(contract::text,'') || '|' || coalesce(pricing::text,'')), request_signature) then
    raise exception using errcode='42501', message='cv_bulk_forbidden'; end if;
  if not private.cv_bulk_valid_contract(contract) then raise exception using errcode='22023', message='Invalid contract'; end if;
  perform pg_advisory_xact_lock(hashtext('cv_bulk_worker_nonce'), hashtext(request_id::text));
  for target in select id from private.cv_bulk_batches
      where status = 'processing' or (status = 'uploading' and created_at < now() - interval '2 hours')
        or (status = 'completed' and (notify_state = 'pending' or (notify_state = 'sending' and notify_lease_until < now())))
      order by updated_at limit 20 loop
    select * into b from private.cv_bulk_batches where id = target;
    perform private.sc19_lock_company(b.company_id);
    select * into b from private.cv_bulk_batches where id = target for update skip locked;
    continue when b.id is null;
    -- Unsent files of a batch abandoned for two hours free their slots.
    if b.status = 'uploading' and b.created_at < now() - interval '2 hours' then
      perform private.cv_bulk_release_slot(i) from private.cv_bulk_items i where i.batch_id = b.id and i.phase = 'awaiting_upload';
      update private.cv_bulk_items set phase = 'error', error_reason = 'not_uploaded', updated_at = now() where batch_id = b.id and phase = 'awaiting_upload';
    end if;
    perform private.cv_bulk_act_as(b.created_by);
    one := private.cv_bulk_pump_batch(b, contract, pricing);
    results := results || jsonb_build_array(one || jsonb_build_object('batch_id', b.id));
  end loop;
  -- Retention of file names that never became a candidate.
  update private.cv_bulk_items set file_name = null, updated_at = now()
    where file_name is not null and candidate_id is null and created_at < now() - interval '30 days';
  return results;
end;$$;

create function public.cv_bulk_finish_notification(target_batch uuid, outcome text, request_id uuid default null, issued_at_ms bigint default null, request_signature text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches;
begin
  if outcome is null or outcome not in ('sent','failed','skipped') then raise exception using errcode='22023', message='Invalid outcome'; end if;
  select * into b from private.cv_bulk_batches where id = target_batch;
  if b.id is null then raise exception using errcode='PT404', message='Resource unavailable'; end if;
  if request_signature is not null then
    if not private.cv_bulk_verify_signature('notify', request_id, issued_at_ms, target_batch, outcome, request_signature) then
      raise exception using errcode='42501', message='cv_bulk_forbidden'; end if;
  elsif auth.uid() is null or not private.has_company_access(b.company_id, true) then
    raise exception using errcode='PT404', message='Resource unavailable';
  end if;
  update private.cv_bulk_batches set updated_at = now(), notify_lease_until = null,
    notify_state = case when outcome = 'failed' and notify_attempts < 5 then 'pending' else outcome end
    where id = target_batch and notify_state = 'sending';
  return found;
end;$$;

-- Batch progress for the recruitment screen. Frozen (erasure) candidates are hidden.
create function public.cv_bulk_batch_status(target_batch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b private.cv_bulk_batches;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select * into b from private.cv_bulk_batches where id = target_batch;
  if b.id is null or not private.has_company_access(b.company_id) then raise exception using errcode='PT404', message='Resource unavailable'; end if;
  return jsonb_build_object(
    'batch', jsonb_build_object('id', b.id, 'recruitment_id', b.recruitment_id, 'status', b.status, 'declared_files', b.declared_files,
      'reserved_slots', b.reserved_slots, 'available_before', b.available_before, 'created_at', b.created_at, 'completed_at', b.completed_at,
      'notify_state', b.notify_state),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'position', i.position, 'file_name', i.file_name, 'file_kind', i.file_kind, 'phase', i.phase,
      'error_reason', i.error_reason, 'ocr_used', i.ocr_used, 'application_id', i.application_id,
      'candidate_name', case when c.id is not null then c.first_name || ' ' || c.last_name end,
      'has_phone', case when c.id is not null then c.phone is not null and btrim(c.phone) <> '' end,
      'duplicate_of_application', i.duplicate_of_application,
      'group_key', g.group_key, 'group_source', g.source, 'raw_score', g.raw_score, 'coverage', g.coverage,
      'input_tokens', i.input_tokens, 'output_tokens', i.output_tokens, 'cost_amount', i.cost_amount, 'cost_currency', i.cost_currency)
      order by i.position)
      from private.cv_bulk_items i
      left join public.candidates c on c.company_id = i.company_id and c.id = i.candidate_id
      left join private.application_preselection_groups g on g.application_id = i.application_id
      where i.batch_id = b.id and (i.candidate_id is null or not private.erasure_candidate_frozen(i.candidate_id))), '[]'::jsonb));
end;$$;

create function public.cv_bulk_recruitment_batches(target_recruitment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare company uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select company_id into company from public.recruitments where id = target_recruitment;
  if company is null or not private.has_company_access(company) then raise exception using errcode='PT404', message='Resource unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status, 'declared_files', b.declared_files,
      'reserved_slots', b.reserved_slots, 'created_at', b.created_at, 'completed_at', b.completed_at,
      'done', (select count(*) from private.cv_bulk_items i where i.batch_id = b.id and i.phase = 'done'),
      'errors', (select count(*) from private.cv_bulk_items i where i.batch_id = b.id and i.phase = 'error'),
      'pending', (select count(*) from private.cv_bulk_items i where i.batch_id = b.id and i.phase in ('awaiting_upload','queued','analyzing')))
      order by b.created_at desc)
    from private.cv_bulk_batches b where b.recruitment_id = target_recruitment and b.company_id = company), '[]'::jsonb);
end;$$;

-- Groups of one recruitment (bulk and single CV), with the voicebot phone flag.
create function public.get_preselection_groups(target_recruitment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare company uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select company_id into company from public.recruitments where id = target_recruitment;
  if company is null or not private.has_company_access(company) then raise exception using errcode='PT404', message='Resource unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('application_id', g.application_id, 'candidate_id', c.id,
      'candidate_name', c.first_name || ' ' || c.last_name, 'has_phone', c.phone is not null and btrim(c.phone) <> '',
      'group_key', g.group_key, 'source', g.source, 'raw_score', g.raw_score, 'coverage', g.coverage, 'updated_at', g.updated_at,
      'application_status', a.status)
      order by case g.group_key when 'passed' then 0 when 'review' then 1 else 2 end, g.raw_score desc nulls last, g.coverage desc nulls last, g.application_id)
    from private.application_preselection_groups g
    join public.applications a on a.id = g.application_id
    join public.candidates c on c.company_id = a.company_id and c.id = a.candidate_id
    where g.company_id = company and g.recruitment_id = target_recruitment and not private.erasure_candidate_frozen(c.id)), '[]'::jsonb);
end;$$;

-- Manual move with history. Never touches applications.status.
create function public.move_preselection_group(target_application uuid, new_group text, expected_updated_at timestamptz, move_note text default null)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare g private.application_preselection_groups; note_value text := nullif(btrim(coalesce(move_note, '')), ''); stamp timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if new_group is null or new_group not in ('passed','review','rejected') or (note_value is not null and length(note_value) > 500) then
    raise exception using errcode='22023', message='Invalid group'; end if;
  select * into g from private.application_preselection_groups where application_id = target_application for update;
  if g.application_id is null or not private.has_company_access(g.company_id, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  perform private.erasure_lock_candidate((select candidate_id from public.applications where id = target_application));
  if g.updated_at is distinct from expected_updated_at then raise exception using errcode='PT409', message='Group changed'; end if;
  update private.application_preselection_groups set group_key = new_group, source = 'manual', changed_by = auth.uid(), updated_at = stamp
    where application_id = target_application;
  insert into private.application_preselection_group_events(application_id, company_id, from_group, to_group, source, actor_id, note)
    values (target_application, g.company_id, g.group_key, new_group, 'manual', auth.uid(), note_value);
  return stamp;
end;$$;

create function public.get_preselection_group_history(target_application uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare company uuid; person uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select company_id, candidate_id into company, person from public.applications where id = target_application;
  if company is null or not private.has_company_access(company) or private.erasure_candidate_frozen(person) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('from_group', e.from_group, 'to_group', e.to_group, 'source', e.source,
      'actor_id', e.actor_id, 'note', e.note, 'created_at', e.created_at) order by e.created_at, e.id)
    from private.application_preselection_group_events e where e.application_id = target_application), '[]'::jsonb);
end;$$;

-- Real per-CV usage for the internal price calculator (platform operator only).
create function public.cv_ai_usage_stats(since_days integer default 90) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  if since_days is null or since_days not between 1 and 730 then raise exception using errcode='22023', message='Invalid range'; end if;
  return (with per_analysis as (
      select a.id, sum(t.input_tokens) in_tok, sum(t.output_tokens) out_tok, sum(t.cached_input_tokens) cached_tok, count(t.id) attempts
      from public.screening_analysis_versions a join public.screening_analysis_attempts t on t.analysis_id = a.id
      where a.execution_status = 'completed' and a.created_at >= now() - make_interval(days => since_days)
      group by a.id)
    select jsonb_build_object('since_days', since_days, 'analyses', count(*),
      'avg_input_tokens', round(avg(in_tok)), 'avg_output_tokens', round(avg(out_tok)), 'avg_cached_input_tokens', round(avg(cached_tok)),
      'p90_input_tokens', percentile_cont(0.9) within group (order by in_tok), 'p90_output_tokens', percentile_cont(0.9) within group (order by out_tok),
      'avg_attempts', round(avg(attempts), 2),
      'bulk_items_with_cost', (select count(*) from private.cv_bulk_items i where i.cost_amount is not null and i.updated_at >= now() - make_interval(days => since_days)),
      'avg_bulk_cost', (select round(avg(i.cost_amount), 6) from private.cv_bulk_items i where i.cost_amount is not null and i.updated_at >= now() - make_interval(days => since_days)),
      'bulk_cost_currency', (select min(i.cost_currency) from private.cv_bulk_items i where i.cost_amount is not null))
    from per_analysis);
end;$$;

revoke all on function public.cv_bulk_create_batch(uuid,uuid,jsonb), public.cv_bulk_fail_item(uuid,text),
  public.cv_bulk_register_item(uuid,jsonb), public.cv_bulk_close_upload(uuid), public.cv_bulk_pump(uuid,jsonb,jsonb),
  public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb), public.cv_bulk_finish_notification(uuid,text,uuid,bigint,text),
  public.cv_bulk_batch_status(uuid), public.cv_bulk_recruitment_batches(uuid), public.get_preselection_groups(uuid),
  public.move_preselection_group(uuid,text,timestamptz,text), public.get_preselection_group_history(uuid),
  public.cv_ai_usage_stats(integer) from public, anon, authenticated;
grant execute on function public.cv_bulk_create_batch(uuid,uuid,jsonb), public.cv_bulk_fail_item(uuid,text),
  public.cv_bulk_register_item(uuid,jsonb), public.cv_bulk_close_upload(uuid), public.cv_bulk_pump(uuid,jsonb,jsonb),
  public.cv_bulk_finish_notification(uuid,text,uuid,bigint,text),
  public.cv_bulk_batch_status(uuid), public.cv_bulk_recruitment_batches(uuid), public.get_preselection_groups(uuid),
  public.move_preselection_group(uuid,text,timestamptz,text), public.get_preselection_group_history(uuid),
  public.cv_ai_usage_stats(integer) to authenticated;
-- The scheduler has no user session; the signature is its only authority.
grant execute on function public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb), public.cv_bulk_finish_notification(uuid,text,uuid,bigint,text) to anon;

commit;
