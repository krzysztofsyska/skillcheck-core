-- R6-1e part 2: the Retell webhook's own database role `retell_webhook`.
--
-- WHY. PR #584 added the Preview-only runtime gate for /api/voice/retell/webhook
-- (lib/voice/retell-webhook-config.ts). Its database login is pinned to role
-- `retell_webhook` (`retell_webhook.<preview ref>` on the transaction pooler),
-- never a service key and never `postgres`. No such role existed, so the gate
-- could never be satisfied and the route stays 404. This migration creates the
-- role with exactly the privileges ingestRetellWebhook
-- (lib/voice/retell-dispatch-ledger.ts) needs, and nothing else.
--
-- WHAT THIS MIGRATION CREATES. One role, grants and row-level security policies
-- for it. No table, column, constraint, trigger, function or row, so the SC-010
-- erasure schema signature is unchanged. Nothing for anon, authenticated,
-- service_role or PUBLIC. Nothing is sent and nothing is turned on: the route
-- still needs RETELL_WEBHOOK_ENABLED and the other Preview variables, and the
-- runtime gate refuses production.
--
-- NO PASSWORD HERE, EVER. The role is NOLOGIN with no password, so applying this
-- file gives nobody a way in. On the test project the login and its password
-- are set outside the repository; a password must never appear in a committed
-- file. Production needs its own reviewed change (the runtime gate refuses it).
--
-- WHY EACH PRIVILEGE (derived from what ingestRetellWebhook and the invoker
-- guards it fires actually execute):
--   usage on private, voice_budget            the schemas of the objects below.
--   private.sc011b_voice_attempts             select (the webhook reads `select *
--                                             ... for update` by provider call id;
--                                             the row holds ids, status and the
--                                             agent id, no contact data) and
--                                             update(status,outcome,dnc_requested),
--                                             the only columns it writes. The
--                                             attempt guard still refuses every
--                                             other change and any move out of a
--                                             terminal status.
--   private.sc011b_voice_webhook_receipts     select (duplicate check, RETURNING)
--                                             and insert. Receipts stay immutable
--                                             (receipt guard).
--   private.sc011b_voice_transcripts          insert of the five columns the
--                                             webhook writes. No select: the
--                                             webhook never reads a transcript back.
--   private.sc010c_voice_preparations         select, rows of dispatched calls only.
--                                             The transcript insert reads
--                                             recruitment_id, and the transcript
--                                             guard (security invoker) reads the
--                                             whole row with `select *`, which needs
--                                             every column. The row holds no
--                                             contact destination; the provider key
--                                             is AES-GCM ciphertext whose key is never
--                                             in the database.
--   voice_budget.charges                      select(company_id,preparation_id,
--                                             cost_grosze), rows of dispatched calls
--                                             only; the write goes through
--                                             voice_budget.record_call_cost.
--   execute voice_budget.record_call_cost      records the real call cost once
--                                             (security definer, owner-checked).
--   execute private.erasure_lock_candidate,   called by the invoker guards on the
--     private.erasure_normal_row_guard        attempt, receipt and transcript rows
--                                             (definer, refuse a frozen candidate).
--   execute private.erasure_purge_allowed     referenced by the same guards behind
--                                             `current_user='erasure_purge_owner'`;
--                                             PostgreSQL checks EXECUTE when the
--                                             expression is prepared, so the guards
--                                             fail without it. Invoker: called by
--                                             this role it can read nothing extra.
--
-- Row-level security: all five tables are FORCE RLS; policies `retell_webhook_*`
-- are scoped `to retell_webhook` only. No delete anywhere.
--
-- Re-runnable: the role is created only if missing (and refused if a role of that
-- name is wider than expected), policies are dropped before being created and
-- every grant is idempotent.
begin;

do $preflight$
begin
 if to_regclass('private.sc011b_voice_attempts') is null
  or to_regclass('private.sc011b_voice_webhook_receipts') is null
  or to_regclass('private.sc011b_voice_transcripts') is null
  or to_regclass('private.sc010c_voice_preparations') is null
  or to_regclass('voice_budget.charges') is null
  or to_regprocedure('voice_budget.record_call_cost(uuid,uuid,integer)') is null
  or to_regprocedure('private.erasure_lock_candidate(uuid)') is null
  or to_regprocedure('private.erasure_normal_row_guard(text,text,text,jsonb,jsonb)') is null
  or to_regprocedure('private.erasure_purge_allowed(text,jsonb,text)') is null then
  raise exception 'retell_webhook_role_requires_r23_and_r7_cost_cap' using errcode='55000';
 end if;
 perform set_config('r6_retell_webhook_role.signature_before',private.erasure_schema_signature(),true);
end $preflight$;

-- The identity: NOLOGIN, no password, inherits nothing. LOGIN is accepted on a
-- re-run, because by then it was enabled on the test project.
do $role$
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='retell_webhook') then
  begin
   create role retell_webhook nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  exception when duplicate_object or unique_violation then
   null; -- created concurrently by another database of the same cluster; checked below
  end;
 end if;
 if exists(select 1 from pg_catalog.pg_roles where rolname='retell_webhook'
   and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) then
  raise exception 'retell_webhook_unsafe_role' using errcode='55000';
 end if;
 -- A membership in another role would widen it beyond the grants below. The
 -- reverse direction is not checked: PostgreSQL 16+ makes the creating role a
 -- member of the new role automatically.
 if exists(select 1 from pg_catalog.pg_auth_members m where m.member='retell_webhook'::regrole) then
  raise exception 'retell_webhook_unexpected_membership' using errcode='55000';
 end if;
end $role$;

grant usage on schema private, voice_budget to retell_webhook;

grant select, update(status,outcome,dnc_requested) on private.sc011b_voice_attempts to retell_webhook;
grant select, insert on private.sc011b_voice_webhook_receipts to retell_webhook;
grant insert(attempt_id,company_id,recruitment_id,candidate_id,utterances) on private.sc011b_voice_transcripts to retell_webhook;
grant select on private.sc010c_voice_preparations to retell_webhook;
grant select(company_id,preparation_id,cost_grosze) on voice_budget.charges to retell_webhook;

grant execute on function voice_budget.record_call_cost(uuid,uuid,integer) to retell_webhook;
grant execute on function private.erasure_lock_candidate(uuid) to retell_webhook;
grant execute on function private.erasure_normal_row_guard(text,text,text,jsonb,jsonb) to retell_webhook;
grant execute on function private.erasure_purge_allowed(text,jsonb,text) to retell_webhook;

-- Attempts: every recorded call is looked up by its provider call id (the webhook
-- carries no tenant). `for update` also needs the update policy's USING.
drop policy if exists retell_webhook_select on private.sc011b_voice_attempts;
drop policy if exists retell_webhook_update on private.sc011b_voice_attempts;
create policy retell_webhook_select on private.sc011b_voice_attempts for select to retell_webhook using (true);
create policy retell_webhook_update on private.sc011b_voice_attempts for update to retell_webhook using (true) with check (true);

drop policy if exists retell_webhook_select on private.sc011b_voice_webhook_receipts;
drop policy if exists retell_webhook_insert on private.sc011b_voice_webhook_receipts;
create policy retell_webhook_select on private.sc011b_voice_webhook_receipts for select to retell_webhook using (true);
create policy retell_webhook_insert on private.sc011b_voice_webhook_receipts for insert to retell_webhook with check (true);

-- The transcript guard decides whether a transcript may be kept (completed
-- attempt, candidate not frozen) and sets tenant, candidate and recruitment.
drop policy if exists retell_webhook_insert on private.sc011b_voice_transcripts;
create policy retell_webhook_insert on private.sc011b_voice_transcripts for insert to retell_webhook with check (true);

-- Only preparations whose call was actually placed (an attempt exists).
drop policy if exists retell_webhook_select on private.sc010c_voice_preparations;
create policy retell_webhook_select on private.sc010c_voice_preparations for select to retell_webhook
 using (exists(select 1 from private.sc011b_voice_attempts a
  where a.company_id=sc010c_voice_preparations.company_id and a.preparation_id=sc010c_voice_preparations.id));

drop policy if exists retell_webhook_select on voice_budget.charges;
create policy retell_webhook_select on voice_budget.charges for select to retell_webhook
 using (exists(select 1 from private.sc011b_voice_attempts a
  where a.company_id=charges.company_id and a.preparation_id=charges.preparation_id));

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r6_retell_webhook_role.signature_before',true) then
  raise exception 'retell_webhook_role_inventory_changed' using errcode='55000';end if;
 -- The role reaches exactly the five relations and four functions above.
 if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','v','m','p','f','S')
    and c.oid<>all(array['private.sc011b_voice_attempts','private.sc011b_voice_webhook_receipts',
     'private.sc011b_voice_transcripts','private.sc010c_voice_preparations','voice_budget.charges']::regclass[])
    and (pg_catalog.has_table_privilege('retell_webhook',c.oid,'select,insert,update,delete,truncate,references,trigger')
     or pg_catalog.has_any_column_privilege('retell_webhook',c.oid,'select,insert,update,references'))
    and n.nspname not in ('pg_catalog','information_schema')) then
  raise exception 'retell_webhook_relation_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('private','voice_budget')
    and p.oid<>all(array['voice_budget.record_call_cost(uuid,uuid,integer)','private.erasure_lock_candidate(uuid)',
     'private.erasure_normal_row_guard(text,text,text,jsonb,jsonb)','private.erasure_purge_allowed(text,jsonb,text)']::regprocedure[])
    and pg_catalog.has_function_privilege('retell_webhook',p.oid,'execute')) then
  raise exception 'retell_webhook_function_exposed' using errcode='55000';end if;
 if pg_catalog.has_table_privilege('retell_webhook','private.sc011b_voice_attempts','insert,delete,truncate')
  or pg_catalog.has_column_privilege('retell_webhook','private.sc011b_voice_attempts','provider_call_id','update')
  or pg_catalog.has_table_privilege('retell_webhook','private.sc011b_voice_webhook_receipts','update,delete,truncate')
  or pg_catalog.has_table_privilege('retell_webhook','private.sc011b_voice_transcripts','update,delete,truncate')
  or pg_catalog.has_any_column_privilege('retell_webhook','private.sc011b_voice_transcripts','select')
  or pg_catalog.has_table_privilege('retell_webhook','private.sc010c_voice_preparations','insert,update,delete,truncate')
  or pg_catalog.has_column_privilege('retell_webhook','voice_budget.charges','reserved_grosze','select')
  or pg_catalog.has_any_column_privilege('retell_webhook','voice_budget.charges','insert,update') then
  raise exception 'retell_webhook_privilege_too_wide' using errcode='55000';end if;
end $postflight$;

commit;
