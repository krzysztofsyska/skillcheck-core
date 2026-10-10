import type {
  BehaviorAreaKey,
  BehaviorRating,
  Database,
  FunctionName,
  Insert,
  RequiredBehaviorLevel,
  Row,
  TableName,
  Update,
  ViewName,
} from "../lib/supabase/database.types";
import { behaviorRatings } from "../lib/behavior-assessment";
import { behaviorAreas, requirementLevels } from "../lib/position-fields";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;
type Keys<Value> = keyof Value;
type NullableKeys<Value> = {
  [Key in keyof Value]-?: null extends Value[Key] ? Key : never;
}[keyof Value];
type RequiredKeys<Value> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? never : Key;
}[keyof Value];
type RelationshipNames<Name extends TableName> =
  Database["public"]["Tables"][Name]["Relationships"][number] extends {
    foreignKeyName: infer ForeignKeyName;
  }
    ? ForeignKeyName
    : never;

type ExpectedTables =
  | "sales_leads"
  | "platform_operators"
  | "companies"
  | "company_members"
  | "company_profiles"
  | "positions"
  | "recruitments"
  | "candidates"
  | "applications"
  | "assessment_stages"
  | "candidate_assessments"
  | "candidate_documents"
  | "behavior_assessment_entries"
  | "exercise_definition_entries"
  | "exercise_observation_entries"
  | "screening_analysis_versions"
  | "screening_analysis_attempts"
  | "screening_criterion_results"
  | "screening_result_reviews"
  | "screening_criterion_review_overrides"
  | "recruitment_shortlist_entries"
  | "candidate_contact_permissions"
  | "candidate_contact_preferences"
  | "candidate_communications"
  | "candidate_communication_events"
  | "candidate_communication_approvals";
type ExpectedViews =
  | "latest_behavior_assessments"
  | "latest_exercise_definitions"
  | "latest_exercise_observations";
type ExpectedFunctions =
  | "submit_sales_lead"
  | "list_sales_leads"
  | "list_sales_leads_inbox"
  | "close_sales_lead"
  | "claim_sales_mail"
  | "finish_sales_mail"
  | "platform_operator_status"
  | "grant_platform_operator"
  | "revoke_platform_operator"
  | "create_company"
  | "ensure_initial_company"
  | "review_candidate_document"
  | "save_behavior_assessment"
  | "save_exercise_definition"
  | "save_exercise_observations"
  | "start_screening_analysis"
  | "claim_screening_attempt"
  | "complete_screening_analysis"
  | "fail_screening_attempt"
  | "retry_screening_analysis"
  | "review_screening_result"
  | "get_screening_ranking"
  | "get_recruitment_shortlist"
  | "add_recruitment_shortlist_entry"
  | "remove_recruitment_shortlist_entry"
  | "record_contact_permission"
  | "set_contact_preferences"
  | "prepare_candidate_communication"
  | "cancel_candidate_communication"
  | "get_candidate_communications"
  | "get_candidate_communication_history"
  | "save_sales_pipeline" | "list_sales_pipeline" | "sales_pipeline_history" | "find_sales_companies"
  | "approve_candidate_communication"
  | "get_communication_approval_status"
  | "configure_candidate_retention_policy"
  | "get_candidate_retention_policy"
  | "confirm_erasure_subject"
  | "preview_candidate_erasure"
  | "get_erasure_subject_resolution"
  | "issue_candidate_erasure_preview"
  | "request_candidate_erasure"
  | "cancel_candidate_erasure"
  | "get_erasure_status"
  | "get_candidate_erasure_status"
  | "list_candidate_erasure_requests";

type _Tables = Expect<Equal<TableName, ExpectedTables>>;
type _Views = Expect<Equal<ViewName, ExpectedViews>>;
type _Functions = Expect<Equal<FunctionName, ExpectedFunctions>>;

type _CompanyColumns = Expect<Equal<
  Keys<Row<"companies">>,
  "id" | "name" | "owner_id" | "created_at" | "updated_at"
>>;
type _MemberColumns = Expect<Equal<
  Keys<Row<"company_members">>,
  "company_id" | "user_id" | "role" | "created_at" | "updated_at"
>>;
type _ProfileColumns = Expect<Equal<
  Keys<Row<"company_profiles">>,
  "company_id" | "industry" | "description" | "website" | "size_band" |
  "work_environment" | "company_values" | "created_at" | "updated_at"
>>;
type _PositionColumns = Expect<Equal<
  Keys<Row<"positions">>,
  "id" | "company_id" | "title" | "description" | "tasks" | "kpis" |
  "autonomy_level" | "required_behaviors" | "required_competencies" |
  "status" | "created_at" | "updated_at"
>>;
type _RecruitmentColumns = Expect<Equal<
  Keys<Row<"recruitments">>,
  "id" | "company_id" | "position_id" | "name" | "status" | "opened_at" |
  "closed_at" | "created_at" | "updated_at"
>>;
type _CandidateColumns = Expect<Equal<
  Keys<Row<"candidates">>,
  "id" | "company_id" | "first_name" | "last_name" | "email" | "phone" |
  "created_at" | "updated_at"
>>;
type _ApplicationColumns = Expect<Equal<
  Keys<Row<"applications">>,
  "id" | "company_id" | "recruitment_id" | "candidate_id" | "status" |
  "created_at" | "updated_at"
>>;
type _StageColumns = Expect<Equal<
  Keys<Row<"assessment_stages">>,
  "id" | "company_id" | "recruitment_id" | "name" | "description" |
  "sequence" | "created_at" | "updated_at"
>>;
type _AssessmentColumns = Expect<Equal<
  Keys<Row<"candidate_assessments">>,
  "id" | "company_id" | "recruitment_id" | "application_id" | "stage_id" |
  "status" | "score" | "notes" | "completed_at" | "created_at" | "updated_at"
>>;
type _DocumentColumns = Expect<Equal<
  Keys<Row<"candidate_documents">>,
  "id" | "company_id" | "candidate_id" | "source_text" | "redacted_text" |
  "version" | "status" | "reviewed_by" | "reviewed_at" | "created_at" | "updated_at"
>>;
type _BehaviorColumns = Expect<Equal<
  Keys<Row<"behavior_assessment_entries">>,
  "id" | "company_id" | "recruitment_id" | "application_id" | "area_key" |
  "version" | "rating" | "evidence" | "required_level" | "position_id" |
  "position_updated_at" | "position_snapshot" | "author_id" | "created_at"
>>;
type _DefinitionColumns = Expect<Equal<
  Keys<Row<"exercise_definition_entries">>,
  "id" | "exercise_id" | "company_id" | "recruitment_id" | "version" |
  "definition" | "position_id" | "position_updated_at" | "position_snapshot" |
  "author_id" | "created_at"
>>;
type _ObservationColumns = Expect<Equal<
  Keys<Row<"exercise_observation_entries">>,
  "id" | "company_id" | "recruitment_id" | "application_id" |
  "definition_entry_id" | "version" | "work_sample" | "observations" |
  "author_id" | "created_at"
>>;
type _ScreeningAnalysisColumns = Expect<Equal<
  Keys<Row<"screening_analysis_versions">>,
  "id" | "company_id" | "recruitment_id" | "application_id" | "position_id" |
  "candidate_document_id" | "candidate_document_version" | "analysis_version" |
  "input_fingerprint" | "analysis_contract_hash" | "payload_schema_version" |
  "result_schema_version" | "prompt_version" | "provider" | "model" |
  "model_revision" | "execution_status" | "input_cv_text_snapshot" |
  "criteria_snapshot" | "binding_snapshot" | "result_summary" | "overall_score" |
  "stale_at" | "stale_reason" | "superseded_by_analysis_id" | "failure_code" |
  "failure_message" | "created_by" | "created_at" | "processing_started_at" |
  "completed_at" | "failed_at" | "updated_at" | "latest_review_version"
>>;
type _ScreeningAttemptColumns = Expect<Equal<
  Keys<Row<"screening_analysis_attempts">>,
  "id" | "company_id" | "analysis_id" | "attempt_no" | "idempotency_key" |
  "status" | "lease_token_hash" | "lease_expires_at" | "provider_request_id" |
  "provider_response_id" | "input_tokens" | "output_tokens" |
  "cached_input_tokens" | "cost_amount" | "cost_currency" | "error_code" |
  "finalization_hash" | "created_at" | "started_at" | "finished_at"
>>;
type _ScreeningCriterionColumns = Expect<Equal<
  Keys<Row<"screening_criterion_results">>,
  "id" | "company_id" | "analysis_id" | "criterion_id" | "criterion_kind" |
  "criterion_order" | "criterion_text_snapshot" | "rating" | "evidence" |
  "explanation" | "confidence" | "created_at"
>>;
type _ScreeningReviewColumns = Expect<Equal<
  Keys<Row<"screening_result_reviews">>,
  "id" | "company_id" | "analysis_id" | "review_version" | "reviewer_id" |
  "disposition" | "review_note" | "created_at"
>>;
type _ScreeningOverrideColumns = Expect<Equal<
  Keys<Row<"screening_criterion_review_overrides">>,
  "id" | "company_id" | "review_id" | "criterion_result_id" |
  "rating_override" | "evidence_override" | "explanation_override" | "created_at"
>>;

type _CompanyNullability = Expect<Equal<NullableKeys<Row<"companies">>, never>>;
type _MemberNullability = Expect<Equal<NullableKeys<Row<"company_members">>, never>>;
type _ProfileNullability = Expect<Equal<
  NullableKeys<Row<"company_profiles">>,
  "industry" | "description" | "website" | "size_band" | "work_environment"
>>;
type _PositionNullability = Expect<Equal<
  NullableKeys<Row<"positions">>,
  "description" | "autonomy_level"
>>;
type _RecruitmentNullability = Expect<Equal<
  NullableKeys<Row<"recruitments">>,
  "opened_at" | "closed_at"
>>;
type _CandidateNullability = Expect<Equal<
  NullableKeys<Row<"candidates">>,
  "email" | "phone"
>>;
type _ApplicationNullability = Expect<Equal<NullableKeys<Row<"applications">>, never>>;
type _StageNullability = Expect<Equal<
  NullableKeys<Row<"assessment_stages">>,
  "description"
>>;
type _AssessmentNullability = Expect<Equal<
  NullableKeys<Row<"candidate_assessments">>,
  "score" | "notes" | "completed_at"
>>;
type _DocumentNullability = Expect<Equal<
  NullableKeys<Row<"candidate_documents">>,
  "reviewed_by" | "reviewed_at"
>>;
type _BehaviorNullability = Expect<Equal<NullableKeys<Row<"behavior_assessment_entries">>, never>>;
type _DefinitionNullability = Expect<Equal<NullableKeys<Row<"exercise_definition_entries">>, never>>;
type _ObservationNullability = Expect<Equal<NullableKeys<Row<"exercise_observation_entries">>, never>>;
type _ScreeningAnalysisNullability = Expect<Equal<
  NullableKeys<Row<"screening_analysis_versions">>,
  "model_revision" | "result_summary" | "overall_score" | "stale_at" |
  "stale_reason" | "superseded_by_analysis_id" | "failure_code" |
  "failure_message" | "processing_started_at" | "completed_at" | "failed_at"
>>;
type _ScreeningAttemptNullability = Expect<Equal<
  NullableKeys<Row<"screening_analysis_attempts">>,
  "lease_token_hash" | "lease_expires_at" | "provider_request_id" |
  "provider_response_id" | "input_tokens" | "output_tokens" |
  "cached_input_tokens" | "cost_amount" | "cost_currency" | "error_code" |
  "finalization_hash" | "started_at" | "finished_at"
>>;
type _ScreeningCriterionNullability = Expect<Equal<
  NullableKeys<Row<"screening_criterion_results">>,
  "explanation" | "confidence"
>>;
type _ScreeningReviewNullability = Expect<Equal<
  NullableKeys<Row<"screening_result_reviews">>,
  "review_note"
>>;
type _ScreeningOverrideNullability = Expect<Equal<
  NullableKeys<Row<"screening_criterion_review_overrides">>,
  "rating_override" | "evidence_override" | "explanation_override"
>>;

type _BehaviorAreas = Expect<Equal<
  BehaviorAreaKey,
  "responsibility" | "independence" | "initiative" | "results" |
  "cooperation" | "change" | "feedback" | "pressure"
>>;
type _BehaviorRatings = Expect<Equal<
  BehaviorRating,
  "insufficient_data" | "below" | "meets" | "above"
>>;
type _RequiredLevels = Expect<Equal<
  RequiredBehaviorLevel,
  "Niski" | "Standardowy" | "Wysoki" | "Krytyczny"
>>;
type _ApplicationBehaviorAreas = Expect<Equal<
  typeof behaviorAreas[number][0],
  BehaviorAreaKey
>>;
type _ApplicationBehaviorRatings = Expect<Equal<
  typeof behaviorRatings[number][0],
  BehaviorRating
>>;
type _ApplicationRequiredLevels = Expect<Equal<
  typeof requirementLevels[number],
  RequiredBehaviorLevel
>>;

type _CompaniesAreRpcOnly = Expect<Equal<Insert<"companies">, never>>;
type _ProfilesAreRpcOnly = Expect<Equal<Insert<"company_profiles">, never>>;
type _BehaviorIsRpcOnly = Expect<Equal<Insert<"behavior_assessment_entries">, never>>;
type _DefinitionsAreRpcOnly = Expect<Equal<Insert<"exercise_definition_entries">, never>>;
type _ObservationsAreRpcOnly = Expect<Equal<Insert<"exercise_observation_entries">, never>>;
type _ScreeningAnalysesAreRpcOnly = Expect<Equal<Insert<"screening_analysis_versions">, never>>;
type _ScreeningAttemptsAreRpcOnly = Expect<Equal<Insert<"screening_analysis_attempts">, never>>;
type _ScreeningCriteriaAreRpcOnly = Expect<Equal<Insert<"screening_criterion_results">, never>>;
type _ScreeningReviewsAreRpcOnly = Expect<Equal<Insert<"screening_result_reviews">, never>>;
type _ScreeningOverridesAreRpcOnly = Expect<Equal<Insert<"screening_criterion_review_overrides">, never>>;
type _ScreeningAnalysisUpdatesAreRpcOnly = Expect<Equal<Update<"screening_analysis_versions">, never>>;
type _ScreeningAttemptUpdatesAreRpcOnly = Expect<Equal<Update<"screening_analysis_attempts">, never>>;
type _ScreeningCriterionUpdatesAreRpcOnly = Expect<Equal<Update<"screening_criterion_results">, never>>;
type _ScreeningReviewUpdatesAreRpcOnly = Expect<Equal<Update<"screening_result_reviews">, never>>;
type _ScreeningOverrideUpdatesAreRpcOnly = Expect<Equal<Update<"screening_criterion_review_overrides">, never>>;
type _DocumentInsert = Expect<Equal<
  Keys<Insert<"candidate_documents">>,
  "company_id" | "candidate_id" | "source_text" | "redacted_text"
>>;
type _DocumentUpdate = Expect<Equal<Keys<Update<"candidate_documents">>, "redacted_text">>;
type _CompanyUpdate = Expect<Equal<Keys<Update<"companies">>, "name">>;
type _MemberInsert = Expect<Equal<
  RequiredKeys<Insert<"company_members">>,
  "company_id" | "user_id"
>>;
type _PositionInsert = Expect<Equal<
  RequiredKeys<Insert<"positions">>,
  "company_id" | "title"
>>;
type _RecruitmentInsert = Expect<Equal<
  RequiredKeys<Insert<"recruitments">>,
  "company_id" | "position_id" | "name"
>>;
type _CandidateInsert = Expect<Equal<
  RequiredKeys<Insert<"candidates">>,
  "company_id" | "first_name" | "last_name"
>>;
type _ApplicationInsert = Expect<Equal<
  RequiredKeys<Insert<"applications">>,
  "company_id" | "recruitment_id" | "candidate_id"
>>;
type _StageInsert = Expect<Equal<
  RequiredKeys<Insert<"assessment_stages">>,
  "company_id" | "recruitment_id" | "name" | "sequence"
>>;
type _AssessmentInsert = Expect<Equal<
  RequiredKeys<Insert<"candidate_assessments">>,
  "company_id" | "recruitment_id" | "application_id" | "stage_id"
>>;

type _MemberUpdate = Expect<Equal<Keys<Update<"company_members">>, "role">>;
type _ProfileUpdate = Expect<Equal<
  Keys<Update<"company_profiles">>,
  "industry" | "description" | "website" | "size_band" | "work_environment" | "company_values"
>>;
type _PositionUpdate = Expect<Equal<
  Keys<Update<"positions">>,
  "title" | "description" | "tasks" | "kpis" | "autonomy_level" |
  "required_behaviors" | "required_competencies" | "status"
>>;
type _RecruitmentUpdate = Expect<Equal<
  Keys<Update<"recruitments">>,
  "name" | "status" | "opened_at" | "closed_at"
>>;
type _CandidateUpdate = Expect<Equal<
  Keys<Update<"candidates">>,
  "first_name" | "last_name" | "email" | "phone"
>>;
type _ApplicationUpdate = Expect<Equal<Keys<Update<"applications">>, "status">>;
type _StageUpdate = Expect<Equal<
  Keys<Update<"assessment_stages">>,
  "name" | "description" | "sequence"
>>;
type _AssessmentUpdate = Expect<Equal<
  Keys<Update<"candidate_assessments">>,
  "status" | "score" | "notes" | "completed_at"
>>;

type _BehaviorRpcArea = Expect<Equal<
  Database["public"]["Functions"]["save_behavior_assessment"]["Args"]["target_area"],
  BehaviorAreaKey
>>;
type _BehaviorRpcRating = Expect<Equal<
  Database["public"]["Functions"]["save_behavior_assessment"]["Args"]["new_rating"],
  BehaviorRating
>>;
type _ClaimReturns = Expect<Equal<
  Keys<Database["public"]["Functions"]["claim_screening_attempt"]["Returns"][number]>,
  "analysis_id" | "attempt_id" | "lease_token" | "lease_expires_at" |
  "input_fingerprint" | "analysis_contract_hash" | "payload_schema_version" |
  "result_schema_version" | "prompt_version" | "provider" | "model" |
  "model_revision" | "input_cv_text_snapshot" | "criteria_snapshot"
>>;

type _ApplicationRelationships = Expect<Equal<
  RelationshipNames<"applications">,
  "applications_company_id_fkey" |
  "applications_company_id_recruitment_id_fkey" |
  "applications_company_id_candidate_id_fkey"
>>;
type _AssessmentRelationships = Expect<Equal<
  RelationshipNames<"candidate_assessments">,
  "candidate_assessments_company_id_fkey" |
  "candidate_assessments_company_id_recruitment_id_applicatio_fkey" |
  "candidate_assessments_company_id_recruitment_id_stage_id_fkey"
>>;
type _BehaviorRelationships = Expect<Equal<
  RelationshipNames<"behavior_assessment_entries">,
  "behavior_assessment_entries_company_id_recruitment_id_appl_fkey" |
  "behavior_assessment_entries_company_id_position_id_fkey"
>>;
type _DefinitionRelationships = Expect<Equal<
  RelationshipNames<"exercise_definition_entries">,
  "exercise_definition_entries_company_id_recruitment_id_fkey" |
  "exercise_definition_entries_company_id_position_id_fkey"
>>;
type _ObservationRelationships = Expect<Equal<
  RelationshipNames<"exercise_observation_entries">,
  "exercise_observation_entries_company_id_recruitment_id_app_fkey" |
  "exercise_observation_entries_company_id_recruitment_id_def_fkey"
>>;
type _ScreeningAnalysisRelationships = Expect<Equal<
  RelationshipNames<"screening_analysis_versions">,
  "screening_analysis_application_fkey" |
  "screening_analysis_recruitment_fkey" |
  "screening_analysis_position_fkey" |
  "screening_analysis_document_fkey" |
  "screening_analysis_superseded_fkey"
>>;
type _ScreeningAttemptRelationships = Expect<Equal<
  RelationshipNames<"screening_analysis_attempts">,
  "screening_attempt_analysis_fkey"
>>;
type _ScreeningCriterionRelationships = Expect<Equal<
  RelationshipNames<"screening_criterion_results">,
  "screening_criterion_analysis_fkey"
>>;
type _ScreeningReviewRelationships = Expect<Equal<
  RelationshipNames<"screening_result_reviews">,
  "screening_review_analysis_fkey"
>>;
type _ScreeningOverrideRelationships = Expect<Equal<
  RelationshipNames<"screening_criterion_review_overrides">,
  "screening_override_review_fkey" | "screening_override_criterion_fkey"
>>;

type _SalesInsert = Expect<Equal<Insert<"sales_leads">, never>>;
type _SalesUpdate = Expect<Equal<Update<"sales_leads">, never>>;
type _OperatorInsert = Expect<Equal<Insert<"platform_operators">, never>>;
type _OperatorUpdate = Expect<Equal<Update<"platform_operators">, never>>;
type _SalesColumns = Expect<Equal<keyof Row<"sales_leads">,
  "id" | "idempotency_key" | "first_name" | "company_name" | "email" | "phone" | "needs" | "status" | "submitted_by" | "fingerprint_hash" | "created_at">>;
type _OperatorColumns = Expect<Equal<keyof Row<"platform_operators">,
  "user_id" | "granted_at" | "granted_by" | "revoked_at">>;
type _SalesNullable = Expect<Equal<NullableKeys<Row<"sales_leads">>, "phone" | "submitted_by">>;
type _SalesReturn = Expect<Equal<Database["public"]["Functions"]["submit_sales_lead"]["Returns"], { lead_id: string | null; result_code: string }[]>>;
type _OperatorGrantReturn = Expect<Equal<Database["public"]["Functions"]["grant_platform_operator"]["Returns"], string>>;
type _OperatorRevokeReturn = Expect<Equal<Database["public"]["Functions"]["revoke_platform_operator"]["Returns"], string>>;

type _SalesArgs = Expect<Equal<Database["public"]["Functions"]["submit_sales_lead"]["Args"], {
  idempotency_key: string; first_name: string; company_name: string; email: string;
  phone: string | null; needs: string; source_ip: string; issued_at_us: number; request_signature: string;
}>>;
type _ListArgs = Expect<Equal<Database["public"]["Functions"]["list_sales_leads"]["Args"], { result_limit?: number }>>;
type _ListReturn = Expect<Equal<Database["public"]["Functions"]["list_sales_leads"]["Returns"], Row<"sales_leads">[]>>;
type _StatusReturn = Expect<Equal<Database["public"]["Functions"]["platform_operator_status"]["Returns"], boolean>>;
type _GrantArgs = Expect<Equal<Database["public"]["Functions"]["grant_platform_operator"]["Args"], { target_user: string }>>;
type _RevokeArgs = Expect<Equal<Database["public"]["Functions"]["revoke_platform_operator"]["Args"], { target_user: string }>>;

// SC-008 writes are available exclusively through tenant-checked RPCs.
type _ShortlistInsert = Expect<Equal<Insert<"recruitment_shortlist_entries">, never>>;
type _ShortlistUpdate = Expect<Equal<Update<"recruitment_shortlist_entries">, never>>;
type _RankingTenantArgument = Expect<Equal<Extract<keyof Database["public"]["Functions"]["get_screening_ranking"]["Args"], "company_id">, never>>;

// SC-010 B1: writes only through scoped RPCs; no delivery/verified grant types.
type _ContactPermissionInsert = Expect<Equal<Insert<"candidate_contact_permissions">, never>>;
type _ContactPermissionUpdate = Expect<Equal<Update<"candidate_contact_permissions">, never>>;
type _ContactPreferencesInsert = Expect<Equal<Insert<"candidate_contact_preferences">, never>>;
type _CommunicationInsert = Expect<Equal<Insert<"candidate_communications">, never>>;
type _CommunicationUpdate = Expect<Equal<Update<"candidate_communications">, never>>;
type _CommunicationEventUpdate = Expect<Equal<Update<"candidate_communication_events">, never>>;
type _CommunicationNoTenantInput = Expect<Equal<Extract<keyof Database["public"]["Functions"]["prepare_candidate_communication"]["Args"], "company_id" | "actor_id" | "destination">, never>>;

// SC-010 B2 public surface exposes metadata only; proof minting remains private.
type _ApprovalInsert = Expect<Equal<Insert<"candidate_communication_approvals">, never>>;
type _ApprovalUpdate = Expect<Equal<Update<"candidate_communication_approvals">, never>>;
type _NoVerificationMint = Expect<Equal<Extract<FunctionName, "ingest_verified_contact_receipt">, never>>;
type _ApprovalNoPrivateInput = Expect<Equal<Extract<keyof Database["public"]["Functions"]["approve_candidate_communication"]["Args"], "company_id" | "actor_id" | "destination" | "policy_version">, never>>;

// SC-010 R1 is configuration + read-only preview, never erasure authorization.
type _NoErasureExecution = Expect<Equal<Extract<FunctionName, "execute_candidate_erasure" | "purge_candidate" | "authorize_retention_due">, never>>;
type _PreviewNoClientManifest = Expect<Equal<Extract<keyof Database["public"]["Functions"]["preview_candidate_erasure"]["Args"], "company_id" | "actor_id" | "candidate_ids" | "manifest" | "execute">, never>>;

// R2 authorization accepts a server-minted ticket only, never client counts/hash/tenant.
type _ErasureRequestArgs = Expect<Equal<Database["public"]["Functions"]["request_candidate_erasure"]["Args"], {
  preview_ticket_id: string; request_key: string;
}>>;
type _ErasureCancelArgs = Expect<Equal<Database["public"]["Functions"]["cancel_candidate_erasure"]["Args"], {
  target_request: string; expected_generation: number; request_key: string;
}>>;
