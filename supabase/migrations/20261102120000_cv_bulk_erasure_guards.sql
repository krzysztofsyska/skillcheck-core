-- SC-BULK-001 release findings, round 4 (Codex review of promotion PR #247).
-- Forward-only, after 20261102110000_cv_bulk_skip_frozen.sql.
-- Functions only: no table, column, constraint or trigger change, so the
-- SC-010 erasure schema signature (R10) stays valid.
--
-- * Duplicate of a frozen candidate: cv_bulk_register_item linked a re-uploaded
--   duplicate (duplicate_of_application) to an application whose candidate was
--   already frozen for erasure. The R9 adapter lists such links, so the approved
--   manifest changed and the purge refused. The duplicate's candidate lock
--   (private.erasure_lock_candidate) is now taken first; if frozen or busy
--   (PT409) the file is still a duplicate (slot returned, no new candidate) but
--   is not linked.
-- * File-name retention: clearing file_name on duplicates (candidate_id null,
--   linked through duplicate_of_application) changed manifest rows of frozen
--   candidates. Linked rows now take the candidate lock and skip frozen or busy
--   candidates; unlinked rows are unchanged.
-- * cv_bulk_batch_status also returns the group's analysis_id
--   ('group_analysis_id') so the batch page can show a stale group as stale.
--
-- Sweep of the other bulk write paths: create_batch, fail_item, close_upload and
-- the worker pump's upload close touch only 'awaiting_upload' items (no
-- candidate, no link); the pump loops are guarded (20261102110000);
-- cv_bulk_apply_auto_group runs only inside the guarded settle loop;
-- move_preselection_group already takes the candidate lock.
begin;

do $erasure_guards_preflight$
begin
  if to_regprocedure('private.cv_bulk_skip_frozen_installed()') is null then
    raise exception 'cv_bulk_erasure_guards_requires_skip_frozen' using errcode='55000';
  end if;
  if to_regprocedure('private.cv_bulk_erasure_guards_installed()') is not null then
    raise exception 'cv_bulk_erasure_guards_already_installed' using errcode='55000';
  end if;
end $erasure_guards_preflight$;

-- Installation marker (lets the preflight and the rollback tell the versions apart).
create function private.cv_bulk_erasure_guards_installed() returns boolean
language sql immutable set search_path='' as $$ select true $$;
revoke all on function private.cv_bulk_erasure_guards_installed() from public, anon, authenticated;

create or replace function public.cv_bulk_register_item(target_item uuid, extracted jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item private.cv_bulk_items; b private.cv_bulk_batches; first text; last text; mail text; tel text;
  src text; red text; named boolean; dup uuid; person uuid; doc uuid; app uuid; dup_person uuid; dup_link uuid;
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
    -- The link to the existing application is part of that candidate's erasure manifest. If the
    -- candidate is frozen for erasure (or busy), the file stays a duplicate (never a second record of
    -- a person being erased) but is not linked; otherwise the lock is held until commit, so a freeze
    -- cannot start in between.
    select a.candidate_id into dup_person from public.applications a where a.id = dup;
    dup_link := dup;
    begin
      perform private.erasure_lock_candidate(dup_person);
    exception when sqlstate 'PT409' then dup_link := null;
    end;
    perform private.cv_bulk_release_slot(item);
    update private.cv_bulk_items set phase = 'error', error_reason = 'duplicate', duplicate_of_application = dup_link,
      ocr_used = coalesce((extracted->>'ocr_used')::boolean, false), updated_at = now() where id = item.id;
    perform private.cv_bulk_touch(item.batch_id);
    return jsonb_build_object('status', 'error', 'error_reason', 'duplicate', 'duplicate_of_application', dup_link);
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
declare n integer; r record;
begin
  -- Files that never became a candidate and are not linked to one.
  update private.cv_bulk_items set file_name = null, updated_at = now()
    where id in (select i.id from private.cv_bulk_items i
      where i.file_name is not null and i.candidate_id is null and i.duplicate_of_application is null
        and i.created_at < now() - interval '30 days'
      order by i.created_at limit 500 for update skip locked);
  get diagnostics n = row_count;
  -- Duplicates are linked to a candidate through duplicate_of_application and belong to that
  -- candidate's erasure manifest: take the candidate lock (NOWAIT) and skip frozen or busy ones.
  for r in select i.id, a.candidate_id from private.cv_bulk_items i
      join public.applications a on a.id = i.duplicate_of_application
      where i.file_name is not null and i.candidate_id is null and i.created_at < now() - interval '30 days'
      order by i.created_at limit 500 for update of i skip locked loop
    begin
      perform private.erasure_lock_candidate(r.candidate_id);
    exception when sqlstate 'PT409' then continue;
    end;
    update private.cv_bulk_items set file_name = null, updated_at = now() where id = r.id;
    n := n + 1;
  end loop;
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
      'group_key', g.group_key, 'group_source', g.source, 'raw_score', g.raw_score, 'coverage', g.coverage, 'group_analysis_id', g.analysis_id,
      'input_tokens', i.input_tokens, 'output_tokens', i.output_tokens, 'cost_amount', i.cost_amount, 'cost_currency', i.cost_currency)
      order by i.position)
      from private.cv_bulk_items i
      left join public.candidates c on c.company_id = i.company_id and c.id = i.candidate_id
      left join private.application_preselection_groups g on g.application_id = i.application_id
      left join public.applications d on d.id = i.duplicate_of_application
      where i.batch_id = b.id and (i.candidate_id is null or not private.erasure_candidate_frozen(i.candidate_id))
        and (d.candidate_id is null or not private.erasure_candidate_frozen(d.candidate_id))), '[]'::jsonb));
end;$$;

do $service_role_acl$
begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function private.cv_bulk_erasure_guards_installed() from service_role;
  end if;
end $service_role_acl$;

do $erasure_guards_postflight$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and (p.proname like 'cv\_bulk%')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'cv_bulk_erasure_guards_acl_unreviewed' using errcode='42501';
  end if;
  if position('erasure_lock_candidate' in pg_get_functiondef('public.cv_bulk_register_item(uuid,jsonb)'::regprocedure)) = 0
    or position('erasure_lock_candidate' in pg_get_functiondef('private.cv_bulk_file_name_retention()'::regprocedure)) = 0
    or position('group_analysis_id' in pg_get_functiondef('public.cv_bulk_batch_status(uuid)'::regprocedure)) = 0 then
    raise exception 'cv_bulk_erasure_guards_not_installed' using errcode='55000';
  end if;
end $erasure_guards_postflight$;

commit;
