-- R7 SC-019b (issue #638): a NEW competency test access (WERYFIKACJA layer) is
-- issued only to a company holding a paid WERYFIKACJA or ASSESSMENT CENTER package.
--
-- Gap (PR #635, docs/checks/sc019a-stripe-test-mode-e2e-2026-11-27.md, „Luki” pkt 1):
-- no database function checked the package, skill_test_metering stays off and
-- 20261121150000_r7_stripe_packages.sql grants no test units, so a FREE or a
-- PRESELEKCJA-only company could issue a competency test.
-- Owner decision (docs/DECYZJE.md, 27.11.2026, 07:12): „Tak”. Per
-- docs/cennik-2026-11-02.md „Testy kompetencji: tak” belongs to WERYFIKACJA and to
-- ASSESSMENT CENTER, so either package opens the test. No test count or limit is
-- introduced (the number of tests is not in the price list).
--
-- "Active package" = the existing row sc19_commerce.entitlements(company_id,
-- 'package:WERYFIKACJA' | 'package:ASSESSMENT_CENTER') with available > 0, the same
-- row the R3 AC gate (private.ac_package_required) reads and that a paid order
-- (sc19_stripe.grant_package / public.sc19_settle_catalog_order) adds. Nothing here
-- creates an order, grants or consumes a package, changes a price or the catalog.
--
-- WHERE: sc19_commerce.consume_skill_test(company) is the single commerce boundary
-- of a NEW grant. Both functions that create competency test access call it right
-- before their insert into private.competency_test_grants, only for a new grant and
-- after authorization, R1 (active shortlist entry, locked), status and AI-approval
-- checks:
--  * public.create_competency_test_grant (manual issue by owner/recruiter; an
--    idempotent replay of an existing request key returns before this boundary);
--  * public.issue_exercise_ai_auto_access (automatic mode; an existing grant is
--    skipped before this boundary, and any error aborts the whole call).
-- The preflight proves this: exactly these two functions insert into
-- private.competency_test_grants, both with their reviewed bodies, both calling
-- this boundary. The package check is added in front of the (still off) metering.
-- Refusal: PT402, 'Competency test package required'. An outsider still gets the
-- same 42501 first and learns nothing about another company's package.
--
-- Existing data: grants and attempts issued before this migration keep working
-- (exchange, start, submit, review, rotation and revocation of an existing grant
-- are untouched), so a candidate can always finish a test already given to him.
-- Only new issuance is gated.
--
-- Function body only: same signature, owner, security definer, empty search_path,
-- volatility and EXECUTE grants (owner-only, nothing for API roles), no table,
-- column, constraint, trigger or grant changes, so the SC-010 erasure schema
-- signature stays exactly as it is (checked below).
--
-- Code compatibility: the application code shipped with this change works on the
-- pre-migration schema (it only maps one more error code to a Polish message).
-- Production: applied only through db-migrate-production after the owner's approval.
-- Rollback: supabase/rollbacks/20261127170000_r7_competency_test_package_gate_down.sql.
begin;

do $preflight$
declare callers text[];
begin
 if to_regclass('sc19_commerce.entitlements') is null
  or to_regprocedure('sc19_commerce.consume_skill_test(uuid)') is null
  or to_regprocedure('public.create_competency_test_grant(uuid,uuid,timestamptz,uuid)') is null
  or to_regprocedure('public.issue_exercise_ai_auto_access(uuid,uuid)') is null then
  raise exception 'r7_competency_package_gate_dependency_missing' using errcode='55000';end if;
 -- Replace only the reviewed body, never a later change made elsewhere.
 if not exists(select 1 from pg_proc where oid='sc19_commerce.consume_skill_test(uuid)'::regprocedure
   and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='27a344e726dae207e9cb770c498c92dfd0f962cbd65daaef7b0c793cb33960b7'
   and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
   and proacl::text='{postgres=X/postgres}') then
  raise exception 'r7_competency_package_gate_source_unreviewed' using errcode='55000';end if;
 -- The two issuers must be the reviewed bodies that call the boundary above.
 if not exists(select 1 from pg_proc where oid='public.create_competency_test_grant(uuid,uuid,timestamptz,uuid)'::regprocedure
   and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='96821d0ba46eabdd2f396054aa9ddc93c63cb1d124f9045b9edff024e02c8bc1')
  or not exists(select 1 from pg_proc where oid='public.issue_exercise_ai_auto_access(uuid,uuid)'::regprocedure
   and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='deca0878a969d68ed958832eed59cb9017836baf2bd4b95cce7a7cede0508b87') then
  raise exception 'r7_competency_package_gate_issuer_unreviewed' using errcode='55000';end if;
 -- No other function may create competency test access around this boundary.
 select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text),'{}') into callers
  from pg_proc p where p.prosrc ~* 'insert\s+into\s+private\.competency_test_grants';
 if callers is distinct from array['create_competency_test_grant(uuid,uuid,timestamp with time zone,uuid)',
   'issue_exercise_ai_auto_access(uuid,uuid)'] then
  raise exception 'r7_competency_package_gate_unknown_issuer:%',callers using errcode='55000';end if;
 perform set_config('r7_competency_package_gate.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

-- Debit boundary of a NEW competency test grant (see the header). The package row
-- is read FOR SHARE so the check holds until the calling transaction commits.
create or replace function sc19_commerce.consume_skill_test(cid uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 -- R7 SC-019b: a new competency test needs a paid WERYFIKACJA or ASSESSMENT CENTER package.
 perform 1 from sc19_commerce.entitlements
  where company_id=cid and code in ('package:WERYFIKACJA','package:ASSESSMENT_CENTER') and available>0
  order by code limit 1 for share;
 if not found then
  raise exception using errcode='PT402',message='Competency test package required';end if;
 -- Existing deployments keep their behavior until explicit runtime activation.
 if not (select skill_test_metering from sc19_commerce.settings where singleton) then return;end if;
 update sc19_commerce.entitlements set available=available-1,used=used+1
 where company_id=cid and code='skill_test' and available>0;
 if not found then raise exception 'commerce_skill_test_exhausted' using errcode='PT422';end if;
end;$$;
revoke all on function sc19_commerce.consume_skill_test(uuid) from public,anon,authenticated;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_competency_package_gate.signature_before') then
  raise exception 'r7_competency_package_gate_changed_erasure_signature' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='sc19_commerce.consume_skill_test(uuid)'::regprocedure
   and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
   and provolatile='v' and proacl::text='{postgres=X/postgres}') then
  raise exception 'r7_competency_package_gate_acl_mismatch' using errcode='55000';end if;
end $postflight$;
commit;
