-- SC-DB-API-001 (#153). Forward-only ACL repair; no new API exposure.
-- The application uses authenticated sessions and scoped worker RPCs, never
-- service_role CRUD. Old Supabase defaults left this BYPASSRLS role with table
-- privileges. Preserve all existing user/worker/RPC grants and RLS policies.
-- Production application requires a separately approved migration runbook.
begin;

do $data_api_acl$
declare
  relation_name text;
  target regclass;
  columns_sql text;
begin
  -- Plain PostgreSQL test installations may not define Supabase's service role.
  -- Do not create a role, change its membership, or change platform defaults.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach relation_name in array array[
      'companies', 'company_members', 'company_profiles', 'positions',
      'recruitments', 'candidates', 'applications', 'assessment_stages',
      'candidate_assessments', 'candidate_documents',
      'behavior_assessment_entries', 'exercise_definition_entries',
      'exercise_observation_entries', 'screening_analysis_versions',
      'screening_analysis_attempts', 'screening_criterion_results',
      'screening_result_reviews', 'screening_criterion_review_overrides',
      'sales_leads', 'platform_operators', 'recruitment_shortlist_entries',
      'candidate_contact_permissions', 'candidate_contact_preferences',
      'candidate_communications', 'candidate_communication_events',
      'candidate_communication_approvals', 'latest_behavior_assessments',
      'latest_exercise_definitions', 'latest_exercise_observations'
    ] loop
      -- Missing dependencies fail the transaction; never silently skip a table.
      target := format('public.%I', relation_name)::regclass;
      execute format('revoke all on table %s from service_role', target);
      -- Table REVOKE does not remove independently granted column privileges.
      select string_agg(quote_ident(attname), ', ' order by attnum)
        into columns_sql from pg_attribute
        where attrelid = target and attnum > 0 and not attisdropped;
      execute format('revoke all (%s) on table %s from service_role', columns_sql, target);
    end loop;
  end if;
end
$data_api_acl$;

commit;
