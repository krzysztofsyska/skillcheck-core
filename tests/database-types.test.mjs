import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGlite } from "@electric-sql/pglite";

const migrations = [
  "20260930000100_skillcheck_core.sql",
  "20261001000100_idempotent_onboarding.sql",
  "20261001000200_candidate_documents.sql",
  "20261002000100_behavior_assessments.sql",
  "20261002000200_behavior_conflict_response.sql",
  "20261002000300_exercise_definitions.sql",
  "20261004000100_exercise_observations.sql",
  "20261004000200_screening_results.sql",
  "20261005000100_screening_worker_claim_payload.sql",
  "20261007000100_screening_retry_active_conflict.sql",
  "20261007000200_sales_leads.sql",
  "20261009073604_sales_lead_inbox_retention.sql",
  "20261009104142_sales_lead_auto_reply.sql",
];

const tableColumns = {
  sales_leads: ["id", "idempotency_key", "first_name", "company_name", "email", "phone", "needs", "status", "submitted_by", "fingerprint_hash", "created_at"],
  platform_operators: ["user_id", "granted_at", "granted_by", "revoked_at"],
  applications: ["id", "company_id", "recruitment_id", "candidate_id", "status", "created_at", "updated_at"],
  assessment_stages: ["id", "company_id", "recruitment_id", "name", "description", "sequence", "created_at", "updated_at"],
  behavior_assessment_entries: ["id", "company_id", "recruitment_id", "application_id", "area_key", "version", "rating", "evidence", "required_level", "position_id", "position_updated_at", "position_snapshot", "author_id", "created_at"],
  candidate_assessments: ["id", "company_id", "recruitment_id", "application_id", "stage_id", "status", "score", "notes", "completed_at", "created_at", "updated_at"],
  candidate_documents: ["id", "company_id", "candidate_id", "source_text", "redacted_text", "version", "status", "reviewed_by", "reviewed_at", "created_at", "updated_at"],
  candidates: ["id", "company_id", "first_name", "last_name", "email", "phone", "created_at", "updated_at"],
  companies: ["id", "name", "owner_id", "created_at", "updated_at"],
  company_members: ["company_id", "user_id", "role", "created_at", "updated_at"],
  company_profiles: ["company_id", "industry", "description", "website", "size_band", "work_environment", "company_values", "created_at", "updated_at"],
  exercise_definition_entries: ["id", "exercise_id", "company_id", "recruitment_id", "version", "definition", "position_id", "position_updated_at", "position_snapshot", "author_id", "created_at"],
  exercise_observation_entries: ["id", "company_id", "recruitment_id", "application_id", "definition_entry_id", "version", "work_sample", "observations", "author_id", "created_at"],
  positions: ["id", "company_id", "title", "description", "tasks", "kpis", "autonomy_level", "required_behaviors", "required_competencies", "status", "created_at", "updated_at"],
  recruitments: ["id", "company_id", "position_id", "name", "status", "opened_at", "closed_at", "created_at", "updated_at"],
  screening_analysis_attempts: ["id", "company_id", "analysis_id", "attempt_no", "idempotency_key", "status", "lease_token_hash", "lease_expires_at", "provider_request_id", "provider_response_id", "input_tokens", "output_tokens", "cached_input_tokens", "cost_amount", "cost_currency", "error_code", "finalization_hash", "created_at", "started_at", "finished_at"],
  screening_analysis_versions: ["id", "company_id", "recruitment_id", "application_id", "position_id", "candidate_document_id", "candidate_document_version", "analysis_version", "input_fingerprint", "analysis_contract_hash", "payload_schema_version", "result_schema_version", "prompt_version", "provider", "model", "model_revision", "execution_status", "input_cv_text_snapshot", "criteria_snapshot", "binding_snapshot", "result_summary", "overall_score", "stale_at", "stale_reason", "superseded_by_analysis_id", "failure_code", "failure_message", "created_by", "created_at", "processing_started_at", "completed_at", "failed_at", "updated_at", "latest_review_version"],
  screening_criterion_results: ["id", "company_id", "analysis_id", "criterion_id", "criterion_kind", "criterion_order", "criterion_text_snapshot", "rating", "evidence", "explanation", "confidence", "created_at"],
  screening_criterion_review_overrides: ["id", "company_id", "review_id", "criterion_result_id", "rating_override", "evidence_override", "explanation_override", "created_at"],
  screening_result_reviews: ["id", "company_id", "analysis_id", "review_version", "reviewer_id", "disposition", "review_note", "created_at"],
};

const viewColumns = {
  latest_behavior_assessments: tableColumns.behavior_assessment_entries,
  latest_exercise_definitions: tableColumns.exercise_definition_entries,
  latest_exercise_observations: tableColumns.exercise_observation_entries,
};

const publicForeignKeys = [
  "platform_operators_granted_by_fkey",
  "applications_company_id_candidate_id_fkey",
  "applications_company_id_fkey",
  "applications_company_id_recruitment_id_fkey",
  "assessment_stages_company_id_fkey",
  "assessment_stages_company_id_recruitment_id_fkey",
  "behavior_assessment_entries_company_id_position_id_fkey",
  "behavior_assessment_entries_company_id_recruitment_id_appl_fkey",
  "candidate_assessments_company_id_fkey",
  "candidate_assessments_company_id_recruitment_id_applicatio_fkey",
  "candidate_assessments_company_id_recruitment_id_stage_id_fkey",
  "candidate_documents_company_id_candidate_id_fkey",
  "candidates_company_id_fkey",
  "company_members_company_id_fkey",
  "company_profiles_company_id_fkey",
  "exercise_definition_entries_company_id_position_id_fkey",
  "exercise_definition_entries_company_id_recruitment_id_fkey",
  "exercise_observation_entries_company_id_recruitment_id_app_fkey",
  "exercise_observation_entries_company_id_recruitment_id_def_fkey",
  "positions_company_id_fkey",
  "recruitments_company_id_fkey",
  "recruitments_company_id_position_id_fkey",
  "screening_analysis_application_fkey",
  "screening_analysis_document_fkey",
  "screening_analysis_position_fkey",
  "screening_analysis_recruitment_fkey",
  "screening_analysis_superseded_fkey",
  "screening_attempt_analysis_fkey",
  "screening_criterion_analysis_fkey",
  "screening_override_criterion_fkey",
  "screening_override_review_fkey",
  "screening_review_analysis_fkey",
];

const functions = {
  submit_sales_lead: "idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text, source_ip text, issued_at_us bigint, request_signature text",
  list_sales_leads: "result_limit integer",
  list_sales_leads_inbox: "result_limit integer",
  close_sales_lead: "target_lead uuid",
  claim_sales_mail: "target_lead uuid, request_id uuid, issued_at_ms bigint, request_signature text",
  finish_sales_mail: "target_lead uuid, request_id uuid, issued_at_ms bigint, outcome text, provider_id uuid, request_signature text",
  platform_operator_status: "",
  grant_platform_operator: "target_user uuid",
  revoke_platform_operator: "target_user uuid",
  create_company: "company_name text",
  ensure_initial_company: "company_name text",
  claim_screening_attempt: "target_attempt uuid",
  complete_screening_analysis: "target_attempt uuid, provided_lease_token text, expected_input_fingerprint text, expected_analysis_contract_hash text, findings jsonb, new_provider_request_id text, new_provider_response_id text, new_input_tokens integer, new_output_tokens integer, new_cached_input_tokens integer, new_cost_amount numeric, new_cost_currency text",
  fail_screening_attempt: "target_attempt uuid, provided_lease_token text, expected_input_fingerprint text, expected_analysis_contract_hash text, new_error_code text, new_error_message text, new_provider_request_id text, new_input_tokens integer, new_output_tokens integer, new_cached_input_tokens integer, new_cost_amount numeric, new_cost_currency text",
  review_screening_result: "target_analysis uuid, expected_review_version integer, new_disposition text, new_review_note text, new_overrides jsonb",
  review_candidate_document: "document_id uuid, expected_version integer",
  retry_screening_analysis: "target_analysis uuid, request_idempotency_key uuid",
  save_behavior_assessment: "target_application uuid, target_area text, new_rating text, new_evidence text, expected_version integer, expected_position_updated_at timestamp with time zone, expected_position_id uuid",
  save_exercise_definition: "target_recruitment uuid, target_exercise uuid, new_definition jsonb, expected_version integer, expected_position_id uuid, expected_position_updated_at timestamp with time zone",
  save_exercise_observations: "target_application uuid, target_definition uuid, expected_version integer, new_work_sample text, new_observations jsonb",
  start_screening_analysis: "target_application uuid, expected_input_fingerprint text, expected_payload_schema_version integer, requested_result_schema_version integer, requested_prompt_version text, requested_provider text, requested_model text, requested_model_revision text, request_idempotency_key uuid, force_reanalysis boolean",
};

test("public database contract matches the manually maintained Supabase types", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    for (const migration of migrations) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
    }

    const relations = await db.query(`
      select c.relname as relation_name, c.relkind,
        array_agg(a.attname order by a.attnum) filter (where a.attnum > 0 and not a.attisdropped) as columns
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind in ('r', 'v')
      group by c.relname, c.relkind
      order by c.relname
    `);
    const actualTables = Object.fromEntries(
      relations.rows.filter(row => row.relkind === "r").map(row => [row.relation_name, row.columns]),
    );
    const actualViews = Object.fromEntries(
      relations.rows.filter(row => row.relkind === "v").map(row => [row.relation_name, row.columns]),
    );
    assert.deepEqual(actualTables, tableColumns);
    assert.deepEqual(actualViews, viewColumns);

    const securityInvokerViews = await db.query(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and 'security_invoker=true' = any(coalesce(c.reloptions, '{}'))
      order by c.relname
    `);
    assert.deepEqual(
      securityInvokerViews.rows.map(row => row.relname),
      Object.keys(viewColumns).sort(),
    );

    const foreignKeys = await db.query(`
      select constraint_name
      from information_schema.table_constraints
      where constraint_schema = 'public' and constraint_type = 'FOREIGN KEY'
        and constraint_name not like '%_owner_id_fkey'
        and constraint_name not like '%_user_id_fkey'
        and constraint_name not like '%_author_id_fkey'
        and constraint_name not like '%_created_by_fkey'
        and constraint_name not like '%_reviewer_id_fkey'
        and constraint_name <> 'candidate_documents_reviewed_by_fkey'
      order by constraint_name
    `);
    assert.deepEqual(
      foreignKeys.rows.map(row => row.constraint_name),
      [...publicForeignKeys].sort(),
    );

    const rpc = await db.query(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
        pg_get_function_result(p.oid) as result
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      order by p.proname
    `);
    assert.deepEqual(
      Object.fromEntries(rpc.rows.map(row => [row.proname, row.arguments])),
      functions,
    );
    assert.equal(rpc.rows.find(row => row.proname === "review_candidate_document").result, "boolean");
    assert.equal(rpc.rows.find(row => row.proname === "submit_sales_lead").result, "TABLE(lead_id uuid, result_code text)");
    assert.equal(rpc.rows.find(row => row.proname === "list_sales_leads").result, "SETOF sales_leads");
    assert.equal(rpc.rows.find(row => row.proname === "platform_operator_status").result, "boolean");
    for (const name of ["grant_platform_operator", "revoke_platform_operator"]) {
      assert.equal(rpc.rows.find(row => row.proname === name).result, "text");
    }
    for (const name of ["start_screening_analysis", "claim_screening_attempt", "retry_screening_analysis"]) {
      assert.match(rpc.rows.find(row => row.proname === name).result, /^TABLE\(/);
    }
    assert.match(
      rpc.rows.find(row => row.proname === "claim_screening_attempt").result,
      /input_fingerprint[\s\S]*criteria_snapshot/,
    );
    assert.doesNotMatch(
      rpc.rows.find(row => row.proname === "claim_screening_attempt").result,
      /company_id|candidate_id|binding_snapshot|source_text/,
    );
    for (const name of [
      "create_company", "ensure_initial_company", "save_behavior_assessment",
      "save_exercise_definition", "save_exercise_observations",
      "complete_screening_analysis", "fail_screening_attempt", "review_screening_result",
    ]) {
      assert.equal(rpc.rows.find(row => row.proname === name).result, "uuid");
    }
  } finally {
    await db.close();
  }
});
