-- Rollback of 20261102120000_cv_bulk_erasure_guards: restores the previous
-- bodies of public.cv_bulk_register_item (20261102100000),
-- private.cv_bulk_file_name_retention and public.cv_bulk_batch_status
-- (20261101130200), and drops the installation marker. Run before rolling back
-- 20261102110000.
begin;

do $erasure_guards_down_preflight$
begin
  if to_regprocedure('private.cv_bulk_erasure_guards_installed()') is null then
    raise exception 'cv_bulk_erasure_guards_not_installed' using errcode='55000';
  end if;
end $erasure_guards_down_preflight$;

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
        or (tel is not null and private.cv_bulk_phone_key(tel) is not null and private.cv_bulk_phone_key(c.phone) = private.cv_bulk_phone_key(tel))
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

create or replace function private.cv_bulk_file_name_retention() returns integer
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

drop function private.cv_bulk_erasure_guards_installed();

commit;
