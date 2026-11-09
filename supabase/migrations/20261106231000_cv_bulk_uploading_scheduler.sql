-- SC-BULK-001 / #233: signed cron must process a registered CV while later files in
-- the same batch are still uploading. An unfinished upload is only expired after 2h.
-- No changes to charge semantics, signature/nonce, limits, roles, RLS or data layout.
-- Requires the global cross-tenant capacity lock wrapper (20261106230000).
-- Reversible before any later migration changes the same RPC body.
begin;
do $bulk_scheduler_preflight$
begin
  if to_regprocedure('public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb)') is null
    or to_regclass('private.cv_bulk_items') is null
    or position('cv_bulk_global_capacity_v1' in
      pg_get_functiondef('public.cv_bulk_worker_pump(uuid,bigint,text,jsonb,jsonb)'::regprocedure)) = 0
  then raise exception 'cv_bulk_uploading_scheduler_requires_global_capacity_lock' using errcode='55000';
  end if;
end $bulk_scheduler_preflight$;

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
      -- cv_bulk_scheduler_uploading_ready_v1: pump already registered files without closing active uploads.
      where bb.status = 'processing' or (bb.status = 'uploading' and
        (bb.created_at < now() - interval '2 hours' or exists (
          select 1 from private.cv_bulk_items qi where qi.batch_id = bb.id and qi.phase in ('queued','analyzing'))))
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
