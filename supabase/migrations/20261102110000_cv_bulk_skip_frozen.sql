-- SC-BULK-001 release findings, round 3 (Codex review of promotion PR #247).
-- Forward-only, after 20261102100000_cv_bulk_capacity_phone_fix.sql.
-- Functions only: no table, column, constraint or trigger change, so the
-- SC-010 erasure schema signature (R10) stays valid.
--
-- * Erasure freeze: an item whose analysis finished before its candidate was
--   frozen for erasure stayed 'analyzing'; a later pump settled it (item row,
--   preselection group and group history), changing rows covered by the
--   approved erasure manifest, so the purge refused ("Erasure manifest
--   changed"). The same applied to queued items (start or the 24-hour expiry)
--   of a frozen candidate. cv_bulk_pump_batch now takes the candidate lock
--   (private.erasure_lock_candidate, FOR UPDATE NOWAIT) before touching an
--   item; a frozen or busy candidate (PT409) is skipped and left untouched.
--   Holding the lock also keeps a freeze from starting while the item is
--   written. Body otherwise unchanged from 20261102100000.
begin;

do $skip_frozen_preflight$
begin
  if to_regprocedure('private.cv_bulk_item_running(uuid,integer,integer)') is null then
    raise exception 'cv_bulk_skip_frozen_requires_capacity_phone_fix' using errcode='55000';
  end if;
  if to_regprocedure('private.cv_bulk_skip_frozen_installed()') is not null then
    raise exception 'cv_bulk_skip_frozen_already_installed' using errcode='55000';
  end if;
end $skip_frozen_preflight$;

-- Installation marker (lets the preflight and the rollback tell the versions apart).
create function private.cv_bulk_skip_frozen_installed() returns boolean
language sql immutable set search_path='' as $$ select true $$;
revoke all on function private.cv_bulk_skip_frozen_installed() from public, anon, authenticated;

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
      -- Erasure freeze: a frozen candidate's rows are in an approved erasure manifest and must not
      -- change. The candidate lock (FOR UPDATE NOWAIT) also keeps a freeze from starting while this
      -- item is written; frozen or busy (PT409) leaves the item untouched for a later pump.
      if item.candidate_id is not null then
        begin
          perform private.erasure_lock_candidate(item.candidate_id);
        exception when sqlstate 'PT409' then
          continue;
        end;
      end if;
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
          -- Busy rows (transient): rolled back, tried again by the next pump. Any other error must not
          -- keep the item analyzing forever (it would hold a parallel slot): mark it failed.
          get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
          if not private.cv_bulk_transient_error(err_state, err_message) then
            update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
          end if;
        end;
      end if;
    end if;
  end loop;
  -- 2. Start queued items within the parallel limits.
  -- Count only analyses that are still running. An item of another batch stays 'analyzing' until that
  -- batch is pumped again (its page may be closed), but a finished analysis holds no parallel slot.
  select count(*) into inflight from private.cv_bulk_items i
    where i.company_id = b.company_id and i.phase = 'analyzing' and private.cv_bulk_item_running(i.analysis_id, i.analysis_retries, s.max_analysis_retries);
  select count(*) into inflight_global from private.cv_bulk_items i
    where i.phase = 'analyzing' and private.cv_bulk_item_running(i.analysis_id, i.analysis_retries, s.max_analysis_retries);
  if contract is not null then
    for item in select * from private.cv_bulk_items where batch_id = b.id and phase = 'queued' order by position for update skip locked loop
      exit when inflight >= s.max_parallel_company or inflight_global >= s.max_parallel_global;
      -- Erasure freeze: a frozen candidate's rows are in an approved erasure manifest and must not
      -- change. The candidate lock (FOR UPDATE NOWAIT) also keeps a freeze from starting while this
      -- item is written; frozen or busy (PT409) leaves the item untouched for a later pump.
      if item.candidate_id is not null then
        begin
          perform private.erasure_lock_candidate(item.candidate_id);
        exception when sqlstate 'PT409' then
          continue;
        end;
      end if;
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
  else
    -- AI switched off: queued files wait for it, but not forever; after 24 hours their slots
    -- return to the package and the files are reported as not analysed.
    for item in select * from private.cv_bulk_items where batch_id = b.id and phase = 'queued'
        and updated_at < now() - interval '24 hours' order by position for update skip locked loop
      -- Erasure freeze: a frozen candidate's rows are in an approved erasure manifest and must not
      -- change. The candidate lock (FOR UPDATE NOWAIT) also keeps a freeze from starting while this
      -- item is written; frozen or busy (PT409) leaves the item untouched for a later pump.
      if item.candidate_id is not null then
        begin
          perform private.erasure_lock_candidate(item.candidate_id);
        exception when sqlstate 'PT409' then
          continue;
        end;
      end if;
      perform private.cv_bulk_release_slot(item);
      update private.cv_bulk_items set phase = 'error', error_reason = 'analysis_failed', updated_at = now() where id = item.id;
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

do $service_role_acl$
begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function private.cv_bulk_skip_frozen_installed() from service_role;
  end if;
end $service_role_acl$;

do $skip_frozen_postflight$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and (p.proname like 'cv\_bulk%')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'cv_bulk_skip_frozen_acl_unreviewed' using errcode='42501';
  end if;
  if position('erasure_lock_candidate' in pg_get_functiondef('private.cv_bulk_pump_batch(private.cv_bulk_batches,jsonb,jsonb)'::regprocedure)) = 0 then
    raise exception 'cv_bulk_skip_frozen_not_installed' using errcode='55000';
  end if;
end $skip_frozen_postflight$;

commit;
