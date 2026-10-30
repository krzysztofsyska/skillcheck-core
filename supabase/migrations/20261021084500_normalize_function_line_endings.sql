-- SC-OPS-DB-MIGRATE: normalize CRLF line endings in 13 production function bodies.
-- Read-only inspection of production (db-migrate-production run 41021636267,
-- 2026-10-30) found these functions stored with CRLF line endings. With CRLF
-- replaced by LF the routines fingerprint equals the reviewed r4_legacy state,
-- so M13 (20261021084732) refuses production only because of line endings.
-- Re-creates each listed function from its own current definition with CRLF
-- replaced by LF. Nothing else changes: CREATE OR REPLACE keeps owner and ACL,
-- and both are verified afterwards. A function whose body has no CR is left
-- untouched, so on databases built from the repository this is a no-op.
begin;

do $normalize_line_endings$
declare
  target regprocedure;
  owner_before oid;
  acl_before aclitem[];
  definition text;
  normalized text;
begin
  for target in select unnest(array[
    'private.behavior_trim(text)',
    'private.exercise_key(text)',
    'private.has_company_access(uuid,boolean)',
    'private.is_company_owner(uuid)',
    'private.touch_updated_at()',
    'private.validate_exercise_definition(jsonb)',
    'private.version_candidate_document()',
    'public.create_company(text)',
    'public.ensure_initial_company(text)',
    'public.review_candidate_document(uuid,integer)',
    'public.save_behavior_assessment(uuid,text,text,text,integer,timestamp with time zone,uuid)',
    'public.save_exercise_definition(uuid,uuid,jsonb,integer,uuid,timestamp with time zone)',
    'public.save_exercise_observations(uuid,uuid,integer,text,jsonb)'
  ]::regprocedure[]) loop
    select p.proowner, p.proacl into owner_before, acl_before from pg_catalog.pg_proc p where p.oid = target;
    if pg_catalog.pg_get_userbyid(owner_before) <> current_user then
      raise exception 'Unexpected owner of %', target using errcode = '55000';
    end if;
    definition := pg_catalog.pg_get_functiondef(target);
    continue when pg_catalog.strpos(definition, E'\r') = 0;
    normalized := pg_catalog.replace(definition, E'\r\n', E'\n');
    if pg_catalog.strpos(normalized, E'\r') > 0 then
      raise exception 'Bare carriage return in %', target using errcode = '55000';
    end if;
    execute normalized;
    if pg_catalog.pg_get_functiondef(target) is distinct from normalized
      or (select p.proowner from pg_catalog.pg_proc p where p.oid = target) is distinct from owner_before
      or (select p.proacl from pg_catalog.pg_proc p where p.oid = target) is distinct from acl_before then
      raise exception 'Line ending normalization changed more than line endings in %', target using errcode = '55000';
    end if;
  end loop;
end;
$normalize_line_endings$;

commit;
