-- R3 SC-016b (issue #636): the paid ASSESSMENT CENTER package also gates a NEW
-- pair of assessors assigned outside a session through the raw R13 RPC.
--
-- Gap (PR #633, docs/checks/sc016a-ac-end-to-end-2026-11-27.md, „Luka”): the R3 gate
-- (20261121090000_r3_ac_package_gate.sql, private.ac_package_required, PT402) covers
-- ac_session_create and draft -> open only; public.ac_assign_pair (R13) did not check
-- the package, so a company owner without the package could assign a pair (and then
-- submit sheets) outside any session.
--
-- Enforced in the database (public.ac_assign_pair only):
--  * a new pair on a revision that is NOT a stage of any AC session is refused without
--    the package (PT402, 'Assessment Center package required'); checked after the
--    existing R13 application lock and owner-only authority, so an outsider or a
--    recruiter still gets the same 42501 / PT404 and learns nothing about a package;
--  * a pair on a revision that IS a session stage is not checked here: that path is the
--    session (public.ac_session_assign_pair calls this same function, and the R16 pair
--    guard trigger already accepts such a pair only for a finalist of an OPEN session,
--    which could only be opened with the package). A session that was created and opened
--    with the package keeps working even if the package later reads available = 0
--    (the package is not consumed by a session, see the R3 gate). The stage rows are
--    read FOR SHARE NOWAIT so a stage cannot be removed between this check and the
--    insert (a concurrent removal is told to retry, PT409).
-- Deliberately unchanged: ac_read_pair, ac_find_pair and ac_submit_sheet. Pairs that
-- already exist (created before this migration) stay readable and their assessors can
-- still submit, so work already started is never cut off half-way. Nothing existing is
-- deleted or changed.
--
-- Functions only: no table, column, constraint, trigger or grant changes, so the SC-010
-- erasure schema signature and inventory stay exactly as they are. `create or replace`
-- keeps the existing EXECUTE grants, security definer and search_path. Nothing creates
-- an order, grants or consumes a package, changes a price or talks to a provider.
--
-- Code compatibility: the application code is unchanged; it works on the pre- and
-- post-migration schema (a PT402 is shown as the existing generic refusal).
-- Rollback: supabase/rollbacks/20261127160000_r3_ac_pair_package_gate_down.sql.
begin;

do $preflight$
begin
 if to_regprocedure('public.ac_assign_pair(uuid,uuid,uuid,uuid)') is null
  or to_regprocedure('private.ac_package_required(uuid)') is null
  or to_regclass('private.ac_session_stages') is null then
  raise exception 'r3_ac_pair_package_gate_requires_r3_gate_and_r16' using errcode='55000';end if;
 -- Replace only the reviewed R13 body, never a later change made elsewhere.
 if encode(sha256(convert_to((select prosrc from pg_proc where oid='public.ac_assign_pair(uuid,uuid,uuid,uuid)'::regprocedure),'UTF8')),'hex')
   is distinct from '27dc900372491f08f71f5c50bfc4fe62403b3265ea20b7dcfffbbd05e4f7f418' then
  raise exception 'r3_ac_pair_package_gate_source_unreviewed' using errcode='55000';end if;
 perform set_config('r3_ac_pair_package_gate.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

create or replace function public.ac_assign_pair(application uuid,revision uuid,first_id uuid,second_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare a public.applications;owner_id uuid;participant uuid;saved uuid;
begin
 a:=private.ac_lock_application(application);
 perform private.competency_authority(a.company_id,true);
 -- R3 SC-016b: a new pair outside a session needs the paid ASSESSMENT CENTER package.
 -- A session stage revision is the session path (open session, enforced by the pair guard).
 perform 1 from private.ac_session_stages g where g.company_id=a.company_id
  and g.recruitment_id=a.recruitment_id and g.definition_id=revision for share nowait;
 if not found then perform private.ac_package_required(a.company_id);end if;
 if first_id is null or second_id is null or first_id=second_id or not exists(
  select 1 from public.exercise_definition_entries d where d.id=revision and d.company_id=a.company_id
  and d.recruitment_id=a.recruitment_id and d.definition->>'kind'='assessment_center') then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 select c.owner_id into owner_id from public.companies c where c.id=a.company_id;
 foreach participant in array array[first_id,second_id] loop
  if participant<>owner_id then
   perform 1 from public.company_members m where m.company_id=a.company_id and m.user_id=participant and m.role='recruiter' for share nowait;
   if not found then raise exception using errcode='42501',message='Assessor unavailable';end if;
  end if;
 end loop;
 insert into private.ac_paired_sheets(company_id,recruitment_id,application_id,definition_id,first_assessor,second_assessor)
 values(a.company_id,a.recruitment_id,a.id,revision,first_id,second_id) returning id into saved;
 return saved;
exception when unique_violation or lock_not_available then raise exception using errcode='PT409',message='Assessment assignment changed';end;$$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r3_ac_pair_package_gate.signature_before') then
  raise exception 'r3_ac_pair_package_gate_changed_erasure_signature' using errcode='55000';end if;
end $postflight$;
commit;
