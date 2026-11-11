-- SC-BULK-001 / #233: enforce the global parallel screening cap across independent tenants.
-- The existing private.cv_bulk_pump_batch counts global in-flight analyses but two transactions
-- for different companies could both count before either starts an analysis. A shared xact advisory
-- lock serializes this count+reservation, for both recruiter RPC and signed cron RPC.
-- Lock order: global advisory lock BEFORE company row/SC-019 lock in BOTH entry points.
-- If the AI contract is disabled, no new analysis starts and the global lock is unnecessary.
-- Existing function signatures, grants, pricing rules, idempotency and schema objects are unchanged.
-- No data, production settings, quotas or payment operations are modified.
-- Forward-only; previous migrations and their baselines are not edited.
begin;
do $sc_bulk_global_cap_preflight$
begin
  if to_regprocedure('private.cv_bulk_item_running(uuid,integer,integer)') is null
    or to_regprocedure('public.cv_bulk_pump(uuid,jsonb,jsonb)') is null
    or to_regprocedure('public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb)') is null
    or position('private.cv_bulk_file_name_retention' in pg_get_functiondef('public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb)'::regprocedure)) = 0
  then raise exception 'cv_bulk_global_capacity_requires_review_fixes_and_capacity_fix' using errcode='55000';
  end if;
end $sc_bulk_global_cap_preflight$;

create or replace function public.cv_bulk_pump(target_batch uuid, contract jsonb default null, pricing jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b private.cv_bulk_batches; company uuid; result jsonb;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if not private.cv_bulk_valid_contract(contract) then raise exception using errcode='22023', message='Invalid contract'; end if;
  select company_id into company from private.cv_bulk_batches where id = target_batch;
  if company is null or not private.has_company_access(company, true) then
    raise exception using errcode='PT404', message='Resource unavailable'; end if;
  -- Serialize slot counting and reservation across DIFFERENT companies. Same global key for both entry points.
  -- Transaction lock lasts through private.cv_bulk_pump_batch and its SC-019 charge.
  if contract is not null then perform pg_advisory_xact_lock(hashtextextended('cv_bulk_global_capacity_v1', 0)); end if;
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
  -- Serialize slot counting and reservation across DIFFERENT companies. Same global key for both entry points.
  -- Transaction lock lasts through private.cv_bulk_pump_batch and its SC-019 charge.
  if contract is not null then perform pg_advisory_xact_lock(hashtextextended('cv_bulk_global_capacity_v1', 0)); end if;
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
commit;
