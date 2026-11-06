-- Revert SC-BULK-001 global advisory cap; restores the exact functions from
-- 20261101130200_cv_bulk_review_fixes.sql. Use only on isolated test databases.
begin;
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
commit;
