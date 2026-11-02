-- Reverts 20261101130200_cv_bulk_review_fixes.sql. Run the R10 rollback
-- (20261101130300_cv_bulk_erasure_inventory_r10_down.sql) first. Restores the
-- exact 20261101130000 bodies of the redefined functions and the R9 table
-- shape, so the schema matches erasure_inventory_baseline_r9 again. The
-- service_role EXECUTE revocation is a tightening and is kept.
-- Re-applying the fixes on the same database afterwards is refused by the R10
-- preflight (sc_r10_source_schema_unreviewed): the dropped columns keep their
-- attribute numbers, so the schema signature differs from the reviewed one and
-- erasure stays fail closed until a new reviewed inventory revision.
-- Fails closed while an item is 'analyzing' without an analysis (the restored
-- check would refuse it); settle such items with a pump first.
begin;

do $fix_down_preflight$
begin
  if to_regclass('private.erasure_inventory_baseline_r10') is not null then
    raise exception 'cv_bulk_fixes_down_requires_r10_rollback' using errcode='55000';
  end if;
  if to_regclass('private.cv_bulk_worker_nonces') is null then
    raise exception 'cv_bulk_fixes_down_requires_fixes' using errcode='55000';
  end if;
  if exists(select 1 from private.cv_bulk_items where phase = 'analyzing' and analysis_id is null) then
    raise exception 'cv_bulk_fixes_down_has_unlinked_analyzing_items' using errcode='55000';
  end if;
end $fix_down_preflight$;

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

create or replace function private.cv_bulk_pump_batch(b private.cv_bulk_batches, contract jsonb, pricing jsonb) returns jsonb
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

create or replace function public.cv_bulk_pump(target_batch uuid, contract jsonb default null, pricing jsonb default null) returns jsonb
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

create or replace function private.cv_bulk_verify_signature(op text, request_id uuid, stamp bigint, target uuid, extra text, signature text) returns boolean
language plpgsql security definer set search_path='' as $$
declare secret text;
begin
  select worker_secret into secret from private.cv_bulk_settings where singleton;
  if secret is null or request_id is null or stamp is null or signature is null then return false; end if;
  if abs(extract(epoch from clock_timestamp()) * 1000 - stamp::numeric) > 60000 then return false; end if;
  return signature = encode(extensions.hmac(concat_ws(E'\n', 'cv-bulk-v1', op, request_id::text, stamp::text,
    coalesce(target::text, '-'), coalesce(extra, '-')), secret, 'sha256'), 'hex');
end;$$;

create or replace function public.cv_bulk_worker_pump(request_id uuid, issued_at_ms bigint, request_signature text, contract jsonb default null, pricing jsonb default null)
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
      where i.batch_id = b.id and (i.candidate_id is null or not private.erasure_candidate_frozen(i.candidate_id))), '[]'::jsonb));
end;$$;

drop trigger release_held_slot on private.cv_bulk_items;
drop function private.cv_bulk_item_release_on_delete(), private.cv_bulk_file_name_retention(),
  private.cv_bulk_transient_error(text,text), private.cv_bulk_valid_pricing(jsonb);
drop table private.cv_bulk_worker_nonces;
alter table private.cv_bulk_items drop column redispatches;
alter table private.cv_bulk_items drop constraint cv_bulk_items_cost_amount_check;
alter table private.cv_bulk_items add constraint cv_bulk_items_cost_amount_check check (cost_amount is null or cost_amount >= 0);
alter table private.cv_bulk_items add constraint cv_bulk_items_check2 check (phase <> 'analyzing' or analysis_id is not null);
alter table private.cv_bulk_settings drop column pricing, drop column max_redispatches;
update private.cv_bulk_items set error_reason = 'unreadable_scan', updated_at = now() where error_reason = 'ocr_timeout';
alter table private.cv_bulk_items drop constraint cv_bulk_items_error_reason_check;
alter table private.cv_bulk_items add constraint cv_bulk_items_error_reason_check
  check (error_reason is null or error_reason in (
    'over_limit','unreadable_scan','protected_pdf','bad_format','too_large','no_text','duplicate',
    'not_uploaded','analysis_failed','not_eligible'));
create or replace function public.cv_bulk_fail_item(target_item uuid, reason text) returns boolean
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
commit;
