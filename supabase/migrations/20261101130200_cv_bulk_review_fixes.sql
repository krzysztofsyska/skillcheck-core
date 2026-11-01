-- SC-BULK-001 review fixes (PR #228 follow-up). Forward-only: the bulk intake
-- (20261101130000) and R9 (20261101130100) are already applied on the preview
-- database, whose ledger skips files by name, so they are not edited.
--
-- Order: R9 (20261101130100) -> this migration -> R10
-- (20261101130300_cv_bulk_erasure_inventory_r10.sql). Between this migration
-- and R10 erasure preview/purge fail closed (schema_dependency_unknown), like
-- between the bulk intake and R9.
--
-- Fixes
-- * Stuck analyses: a pending attempt that is never claimed, or a processing
--   attempt whose lease expired, is re-dispatched at most
--   cv_bulk_settings.max_redispatches times; then the analysis is invalidated
--   (stale, manual_invalidation), the unchanged SC-019 trigger cancels it and
--   refunds the credit, and the item ends as analysis_failed. Parallel slots
--   are freed and the batch can complete.
-- * Pricing is never taken from a user session. cv_bulk_pump ignores its
--   pricing argument (kept for the app's call signature); every pump uses the
--   DB-held cv_bulk_settings.pricing, which only the signed worker pump (or the
--   operator in SQL) writes. Pricing is validated everywhere as plain decimal
--   text/numbers (no NaN/Infinity), 0..1000 per million tokens, currency
--   ^[A-Z]{3}$, version 1..80 chars. cost_amount additionally refuses NaN.
-- * Transient errors (serialization/deadlock, lock_not_available, statement
--   timeout, 'Candidate workflow busy', 'Screening input changed') during a
--   start or retry no longer end the item: it stays queued with its slot held
--   (start) or analyzing (retry) for the next pump.
-- * A retry that resolves to another analysis (active peer or new version)
--   moves the item to that analysis.
-- * Erasing a candidate whose item still holds a package slot returns the slot
--   (bulk_release journaled by a BEFORE DELETE trigger), so the journal keeps
--   reconciling with the balance.
-- * The purge deletes analyses before applications; the analysis link is set
--   to NULL first, so an item may now be 'analyzing' without analysis_id (the
--   pump already settles that as analysis_failed). The check is dropped.
-- * Signed calls: sha256 digest of contract/pricing (md5 still accepted while
--   the app migrates), constant-time comparison (digest of both sides), and a
--   private nonce store so a signed request_id is accepted once.
-- * File names of files that never became a candidate are cleared after 30
--   days by every pump, not only the signed one.
-- * Status reads also hide duplicate rows that point to a frozen candidate.
-- * The worker pump takes company locks with SKIP LOCKED in company order and
--   runs each batch in its own subtransaction: one bad batch no longer rolls
--   back the others and concurrent worker pumps never wait on each other.
-- * A notification claim whose lease expired after the last attempt becomes
--   'failed' instead of staying 'sending'.
-- * EXECUTE on the bulk RPCs is revoked from service_role (Supabase default
--   ACL), matching the SC-019 / Step 4 migrations.
begin;

do $fix_preflight$
begin
  if to_regclass('private.erasure_inventory_baseline_r9') is null or to_regclass('private.cv_bulk_items') is null then
    raise exception 'cv_bulk_fixes_require_r9' using errcode='55000';
  end if;
  if to_regclass('private.cv_bulk_worker_nonces') is not null or to_regclass('private.erasure_inventory_baseline_r10') is not null then
    raise exception 'cv_bulk_fixes_already_installed' using errcode='55000';
  end if;
end $fix_preflight$;

-- Settings: DB-held pricing and the re-dispatch bound.
alter table private.cv_bulk_settings
  add column pricing jsonb,
  add column max_redispatches integer not null default 3 check (max_redispatches between 1 and 10);

-- Items: re-dispatch counter; NaN-proof cost; analysis link may be cleared by the purge.
update private.cv_bulk_items set cost_amount = null, cost_currency = null, pricing_version = null, updated_at = now()
  where cost_amount = 'NaN'::numeric;
alter table private.cv_bulk_items
  add column redispatches integer not null default 0 check (redispatches between 0 and 100);
alter table private.cv_bulk_items drop constraint cv_bulk_items_cost_amount_check;
alter table private.cv_bulk_items add constraint cv_bulk_items_cost_amount_check
  check (cost_amount is null or (cost_amount >= 0 and cost_amount < 1000000));
do $drop_analyzing_check$
declare n text;
begin
  select conname into strict n from pg_constraint where conrelid = 'private.cv_bulk_items'::regclass and contype = 'c'
    and pg_get_constraintdef(oid, true) = 'CHECK (phase <> ''analyzing''::text OR analysis_id IS NOT NULL)';
  execute format('alter table private.cv_bulk_items drop constraint %I', n);
end $drop_analyzing_check$;

-- OCR that runs out of its time budget is reported separately from an unreadable scan.
alter table private.cv_bulk_items drop constraint cv_bulk_items_error_reason_check;
alter table private.cv_bulk_items add constraint cv_bulk_items_error_reason_check
  check (error_reason is null or error_reason in (
    'over_limit','unreadable_scan','protected_pdf','bad_format','too_large','no_text','ocr_timeout','duplicate',
    'not_uploaded','analysis_failed','not_eligible'));

create or replace function public.cv_bulk_fail_item(target_item uuid, reason text) returns boolean
language plpgsql security definer set search_path='' as $$
declare item private.cv_bulk_items;
begin
  if reason is null or reason not in ('unreadable_scan','protected_pdf','bad_format','too_large','no_text','ocr_timeout') then
    raise exception using errcode='22023', message='Invalid reason'; end if;
  item := private.cv_bulk_item_for_write(target_item);
  if item.phase <> 'awaiting_upload' then return false; end if;
  perform private.cv_bulk_release_slot(item);
  update private.cv_bulk_items set phase = 'error', error_reason = reason, updated_at = now() where id = item.id;
  perform private.cv_bulk_touch(item.batch_id);
  return true;
end;$$;

-- Replay store for signed worker calls (request ids only, no candidate data).
create table private.cv_bulk_worker_nonces (
  request_id uuid primary key,
  seen_at timestamptz not null default now()
);
create index cv_bulk_worker_nonces_seen_idx on private.cv_bulk_worker_nonces(seen_at);
revoke all on private.cv_bulk_worker_nonces from public, anon, authenticated;
alter table private.cv_bulk_worker_nonces enable row level security;

create function private.cv_bulk_valid_pricing(pricing jsonb) returns boolean
language sql immutable set search_path='' as $$
  select pricing is null or coalesce(jsonb_typeof(pricing) = 'object'
    and jsonb_typeof(pricing->'input_per_mtok') in ('string','number')
    and (pricing->>'input_per_mtok') ~ '^[0-9]{1,4}(\.[0-9]{1,6})?$' and (pricing->>'input_per_mtok')::numeric <= 1000
    and jsonb_typeof(pricing->'output_per_mtok') in ('string','number')
    and (pricing->>'output_per_mtok') ~ '^[0-9]{1,4}(\.[0-9]{1,6})?$' and (pricing->>'output_per_mtok')::numeric <= 1000
    and (pricing->>'cached_input_per_mtok' is null or (jsonb_typeof(pricing->'cached_input_per_mtok') in ('string','number')
      and (pricing->>'cached_input_per_mtok') ~ '^[0-9]{1,4}(\.[0-9]{1,6})?$' and (pricing->>'cached_input_per_mtok')::numeric <= 1000))
    and (pricing->>'currency' is null or (pricing->>'currency') ~ '^[A-Z]{3}$')
    and (pricing->>'version' is null or length(pricing->>'version') between 1 and 80), false)
$$;
revoke all on function private.cv_bulk_valid_pricing(jsonb) from public, anon, authenticated;

-- Errors after which the same start/retry can succeed on a later pump.
create function private.cv_bulk_transient_error(state text, message text) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(state in ('40001','40P01','55P03','57014')
    or (state = 'PT409' and message in ('Candidate workflow busy','Screening input changed','Contact source busy')), false)
$$;
revoke all on function private.cv_bulk_transient_error(text,text) from public, anon, authenticated;

-- A held slot that disappears with its row (erasure purge, recruitment delete)
-- goes back to the package with a journal entry.
create function private.cv_bulk_item_release_on_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.slot_state = 'held' then
    -- SC-019 lock order: company before balance.
    perform 1 from public.companies where id = old.company_id for update;
    perform private.cv_bulk_journal(old.company_id, 'bulk_release', 1, 'cv-bulk-release:' || old.id);
  end if;
  return old;
end;$$;
revoke all on function private.cv_bulk_item_release_on_delete() from public, anon, authenticated;
create trigger release_held_slot before delete on private.cv_bulk_items
  for each row execute function private.cv_bulk_item_release_on_delete();

-- 30-day retention of file names that never became a candidate; bounded and
-- non-blocking so any pump can run it.
create function private.cv_bulk_file_name_retention() returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  update private.cv_bulk_items set file_name = null, updated_at = now()
    where id in (select i.id from private.cv_bulk_items i
      where i.file_name is not null and i.candidate_id is null and i.created_at < now() - interval '30 days'
      order by i.created_at limit 500 for update skip locked);
  get diagnostics n = row_count;
  return n;
end;$$;
revoke all on function private.cv_bulk_file_name_retention() from public, anon, authenticated;

create or replace function public.cv_bulk_register_item(target_item uuid, extracted jsonb) returns jsonb
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
        -- A name alone is weak evidence (a job title can look like a name): it counts only when
        -- no contact data on either side could tell the two people apart.
        or (named and lower(btrim(c.first_name)) = lower(first) and lower(btrim(c.last_name)) = lower(last)
            and (mail is null or nullif(btrim(c.email), '') is null)
            and (tel is null or nullif(btrim(c.phone), '') is null)))
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
  -- Owner-approved exception (owner decision 2026-11-01): for bulk upload the
  -- client-produced redacted_text is marked 'reviewed' automatically. The batch
  -- confirmation is the operator's approval of the automatic redaction for this
  -- upload, recorded with the operator as reviewer (like a manual review).
  -- Single-CV intake keeps the manual review step.
  update public.candidate_documents set status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now() where id = doc;
  insert into public.applications(company_id, recruitment_id, candidate_id)
    values (b.company_id, b.recruitment_id, person) returning id into app;
  update private.cv_bulk_items set phase = 'queued', candidate_id = person, application_id = app,
    ocr_used = coalesce((extracted->>'ocr_used')::boolean, false), name_detected = named, updated_at = now()
    where id = item.id;
  perform private.cv_bulk_touch(item.batch_id);
  return jsonb_build_object('status', 'queued', 'application_id', app, 'candidate_id', person);
end;$$;

-- One pump step for one batch. Caller must already hold the company lock and
-- have established the acting identity. `pricing` must come from
-- cv_bulk_settings (never from a user session); it is validated again here.
create or replace function private.cv_bulk_pump_batch(b private.cv_bulk_batches, contract jsonb, pricing jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.cv_bulk_settings; item private.cv_bulk_items; a public.screening_analysis_versions;
  dispatch uuid[] := '{}'; started record; retried record; fp text; inflight integer; inflight_global integer;
  in_tok bigint; out_tok bigint; cached_tok bigint; cost numeric; notify jsonb; email text; claimed uuid;
  p_in numeric; p_cached numeric; p_out numeric; err_state text; err_message text; resend uuid;
begin
  select * into s from private.cv_bulk_settings where singleton;
  if not private.cv_bulk_valid_pricing(pricing) then pricing := null; end if;
  p_in := nullif(pricing->>'input_per_mtok', '')::numeric;
  p_cached := coalesce(nullif(pricing->>'cached_input_per_mtok', '')::numeric, p_in);
  p_out := nullif(pricing->>'output_per_mtok', '')::numeric;
  -- 1. Settle analyses that left processing; re-dispatch or give up stuck ones.
  for item in select * from private.cv_bulk_items where batch_id = b.id and phase = 'analyzing' order by position for update loop
    a := null;
    select * into a from public.screening_analysis_versions where id = item.analysis_id;
    if a.id is null then
      update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
    elsif a.execution_status = 'completed' then
      select sum(input_tokens), sum(output_tokens), sum(cached_input_tokens) into in_tok, out_tok, cached_tok
        from public.screening_analysis_attempts where analysis_id = a.id;
      cost := case when p_in is null or p_out is null or in_tok is null or out_tok is null then null else
        round(((in_tok - coalesce(cached_tok, 0)) * p_in + coalesce(cached_tok, 0) * p_cached + out_tok * p_out) / 1000000.0, 6) end;
      if cost >= 1000000 then cost := null; end if;
      update private.cv_bulk_items set phase = 'done', input_tokens = in_tok, output_tokens = out_tok, cached_input_tokens = cached_tok,
        cost_amount = cost, cost_currency = case when cost is null then null else coalesce(pricing->>'currency', 'USD') end,
        pricing_version = case when cost is null then null else left(pricing->>'version', 80) end, updated_at = now()
        where id = item.id;
      perform private.cv_bulk_apply_auto_group(item.application_id, a.id);
    elsif a.execution_status in ('failed','cancelled') then
      if a.execution_status = 'failed' and item.analysis_retries < s.max_analysis_retries and a.stale_at is null then
        begin
          select * into retried from public.retry_screening_analysis(a.id, gen_random_uuid());
          -- The retry may resolve to an active peer or a new analysis version: follow it.
          update private.cv_bulk_items set analysis_id = retried.analysis_id, analysis_retries = analysis_retries + 1,
            redispatches = 0, dispatched_at = now(), updated_at = now() where id = item.id;
          dispatch := dispatch || retried.attempt_id;
        exception when others then
          get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
          if not private.cv_bulk_transient_error(err_state, err_message) then
            update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
          end if;
        end;
      else
        update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
      end if;
    elsif a.execution_status in ('pending','processing') and (item.dispatched_at is null or item.dispatched_at < now() - interval '3 minutes') then
      -- Lost dispatch (pending) or a worker that died after claiming (processing,
      -- lease expired): claim_screening_attempt(_v2) accepts the same attempt again.
      resend := (select t.id from public.screening_analysis_attempts t where t.analysis_id = a.id
        and (t.status = 'pending' or (t.status = 'processing' and t.lease_expires_at <= clock_timestamp()))
        order by t.attempt_no desc limit 1);
      if resend is not null and item.redispatches < s.max_redispatches then
        dispatch := dispatch || resend;
        update private.cv_bulk_items set redispatches = redispatches + 1, dispatched_at = now(), updated_at = now() where id = item.id;
      elsif resend is not null then
        -- Bounded: invalidate; the SC-019 trigger cancels the analysis and refunds the credit.
        begin
          update public.screening_analysis_versions set stale_at = clock_timestamp(), stale_reason = 'manual_invalidation',
            updated_at = clock_timestamp() where id = a.id and stale_at is null;
          update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
        exception when others then
          -- E.g. the candidate row is busy: rolled back, tried again by the next pump.
          null;
        end;
      end if;
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
          redispatches = 0, dispatched_at = now(), updated_at = now() where id = item.id;
        if started.execution_status in ('pending','processing') then dispatch := dispatch || started.attempt_id; end if;
        inflight := inflight + 1; inflight_global := inflight_global + 1;
      exception when others then
        -- Subtransaction rolled back the transfer; the slot is still held.
        get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
        if not private.cv_bulk_transient_error(err_state, err_message) then
          perform private.cv_bulk_release_slot(item);
          update private.cv_bulk_items set phase = 'error', error_reason = 'not_eligible', updated_at = now() where id = item.id;
        end if;
        -- Transient: stays queued with the slot held; the next pump tries again.
      end;
    end loop;
  end if;
  -- 3. Completion and notification claim.
  perform private.cv_bulk_touch(b.id);
  update private.cv_bulk_batches set status = 'completed', completed_at = now(), updated_at = now()
    where id = b.id and status = 'processing'
      and not exists(select 1 from private.cv_bulk_items i where i.batch_id = b.id and i.phase in ('awaiting_upload','queued','analyzing'));
  -- The last claim expired without an outcome: terminal.
  update private.cv_bulk_batches set notify_state = 'failed', notify_lease_until = null, updated_at = now()
    where id = b.id and notify_state = 'sending' and notify_lease_until < now() and notify_attempts >= 5;
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

-- User-session pump (upload responses and the progress page). The pricing
-- argument is accepted for call compatibility and ignored: a recruiter must
-- not be able to write cost data that operator statistics aggregate.
create or replace function public.cv_bulk_pump(target_batch uuid, contract jsonb default null, pricing jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches; company uuid; result jsonb;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if not private.cv_bulk_valid_contract(contract) then raise exception using errcode='22023', message='Invalid contract'; end if;
  select company_id into company from private.cv_bulk_batches where id = target_batch;
  if company is null or not private.has_company_access(company, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  perform private.sc19_lock_company(company);
  select * into b from private.cv_bulk_batches where id = target_batch for update skip locked;
  if b.id is null then result := jsonb_build_object('dispatch', '[]'::jsonb, 'notify', null);
  else
    -- Starts run as the calling recruiter; start_screening_analysis re-checks access.
    result := private.cv_bulk_pump_batch(b, contract, (select s.pricing from private.cv_bulk_settings s where s.singleton));
  end if;
  perform private.cv_bulk_file_name_retention();
  return result;
end;$$;

-- HMAC-SHA256 over the request; compared as digests of both sides (constant
-- time in the secret-dependent part); each request_id is accepted once.
create or replace function private.cv_bulk_verify_signature(op text, request_id uuid, stamp bigint, target uuid, extra text, signature text) returns boolean
language plpgsql security definer set search_path='' as $$
declare secret text; expected text;
begin
  select worker_secret into secret from private.cv_bulk_settings where singleton;
  if secret is null or request_id is null or stamp is null or signature is null or length(signature) > 200 then return false; end if;
  if abs(extract(epoch from clock_timestamp()) * 1000 - stamp::numeric) > 60000 then return false; end if;
  expected := encode(extensions.hmac(concat_ws(E'\n', 'cv-bulk-v1', op, request_id::text, stamp::text,
    coalesce(target::text, '-'), coalesce(extra, '-')), secret, 'sha256'), 'hex');
  if extensions.digest(lower(signature), 'sha256') <> extensions.digest(expected, 'sha256') then return false; end if;
  -- Replay window is +-60 s; keep ids for 3 minutes.
  delete from private.cv_bulk_worker_nonces where seen_at < now() - interval '3 minutes';
  insert into private.cv_bulk_worker_nonces(request_id) values (request_id) on conflict do nothing;
  return found;
end;$$;

-- Background pump for a scheduler: signed with the database-held secret.
-- Signed extra = hex sha256 of (contract::text || '|' || pricing::text); the
-- former md5 digest is still accepted until the app switches.
create or replace function public.cv_bulk_worker_pump(request_id uuid, issued_at_ms bigint, request_signature text, contract jsonb default null, pricing jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches; target record; results jsonb := '[]'; one jsonb; bound text; held boolean;
  stored jsonb; err_state text;
begin
  bound := coalesce(contract::text,'') || '|' || coalesce(pricing::text,'');
  if not private.cv_bulk_verify_signature('pump', request_id, issued_at_ms, null, encode(extensions.digest(bound, 'sha256'), 'hex'), request_signature)
    and not private.cv_bulk_verify_signature('pump', request_id, issued_at_ms, null, md5(bound), request_signature) then
    raise exception using errcode='42501', message='cv_bulk_forbidden'; end if;
  if not private.cv_bulk_valid_contract(contract) then raise exception using errcode='22023', message='Invalid contract'; end if;
  -- Signed pricing is the only source of the DB-held pricing; invalid pricing is stored as unknown.
  stored := case when private.cv_bulk_valid_pricing(pricing) then pricing end;
  update private.cv_bulk_settings set pricing = stored, updated_at = now() where singleton and cv_bulk_settings.pricing is distinct from stored;
  for target in select x.id, x.company_id from (select bb.id, bb.company_id from private.cv_bulk_batches bb
      where bb.status = 'processing' or (bb.status = 'uploading' and bb.created_at < now() - interval '2 hours')
        or (bb.status = 'completed' and (bb.notify_state = 'pending' or (bb.notify_state = 'sending' and bb.notify_lease_until < now())))
      order by bb.updated_at limit 20) x
      order by x.company_id, x.id loop
    begin
      -- Never wait on a company another pump or upload holds; it is picked up next time.
      select true into held from public.companies where id = target.company_id for update skip locked;
      continue when held is null;
      held := null;
      b := null;
      select * into b from private.cv_bulk_batches where id = target.id for update skip locked;
      continue when b.id is null;
      -- Unsent files of a batch abandoned for two hours free their slots.
      if b.status = 'uploading' and b.created_at < now() - interval '2 hours' then
        perform private.cv_bulk_release_slot(i) from private.cv_bulk_items i where i.batch_id = b.id and i.phase = 'awaiting_upload';
        update private.cv_bulk_items set phase = 'error', error_reason = 'not_uploaded', updated_at = now() where batch_id = b.id and phase = 'awaiting_upload';
      end if;
      perform private.cv_bulk_act_as(b.created_by);
      one := private.cv_bulk_pump_batch(b, contract, stored);
      results := results || jsonb_build_array(one || jsonb_build_object('batch_id', b.id));
    exception when others then
      -- This batch's work is rolled back; the others are kept.
      get stacked diagnostics err_state = returned_sqlstate;
      results := results || jsonb_build_array(jsonb_build_object('batch_id', target.id, 'dispatch', '[]'::jsonb, 'notify', null, 'error', err_state));
    end;
    held := null;
  end loop;
  perform private.cv_bulk_file_name_retention();
  return results;
end;$$;

-- Batch progress for the recruitment screen. Frozen (erasure) candidates are
-- hidden, including duplicate rows that point to a frozen candidate.
create or replace function public.cv_bulk_batch_status(target_batch uuid) returns jsonb
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
      left join public.applications d on d.id = i.duplicate_of_application
      where i.batch_id = b.id and (i.candidate_id is null or not private.erasure_candidate_frozen(i.candidate_id))
        and (d.candidate_id is null or not private.erasure_candidate_frozen(d.candidate_id))), '[]'::jsonb));
end;$$;

-- Supabase grants EXECUTE on new public functions to service_role by default.
-- The bulk RPCs are reached only through the user session or the signature.
do $service_role_acl$
begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.cv_bulk_create_batch(uuid,uuid,jsonb), public.cv_bulk_fail_item(uuid,text),
      public.cv_bulk_register_item(uuid,jsonb), public.cv_bulk_close_upload(uuid), public.cv_bulk_pump(uuid,jsonb,jsonb),
      public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb), public.cv_bulk_finish_notification(uuid,text,uuid,bigint,text),
      public.cv_bulk_batch_status(uuid), public.cv_bulk_recruitment_batches(uuid), public.get_preselection_groups(uuid),
      public.move_preselection_group(uuid,text,timestamptz,text), public.get_preselection_group_history(uuid),
      public.cv_ai_usage_stats(integer) from service_role;
    revoke all on private.cv_bulk_worker_nonces from service_role;
  end if;
end $service_role_acl$;

do $fix_postflight$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and (p.proname like 'cv\_bulk%')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
    or has_table_privilege('anon', 'private.cv_bulk_worker_nonces', 'select')
    or has_table_privilege('authenticated', 'private.cv_bulk_worker_nonces', 'select') then
    raise exception 'cv_bulk_fixes_acl_unreviewed' using errcode='42501';
  end if;
end $fix_postflight$;

commit;
