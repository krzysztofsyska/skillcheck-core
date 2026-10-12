// Public API contract after migrations 20260930000100 through 20261010190255.
// Keep API write restrictions below when comparing with generated Supabase types.
import type { ExerciseDefinition } from '../exercise-definition';
import type { BehaviorAreaKey, RequiredBehaviorLevel } from '../position-fields';
export type { BehaviorAreaKey, RequiredBehaviorLevel } from '../position-fields';
type Timestamps = { created_at: string; updated_at: string };
type Entity = Timestamps & { id: string; company_id: string };
type Relationship<
  ForeignKeyName extends string,
  Columns extends string[],
  ReferencedRelation extends string,
  ReferencedColumns extends string[],
  IsOneToOne extends boolean = false,
> = {
  foreignKeyName: ForeignKeyName;
  columns: Columns;
  isOneToOne: IsOneToOne;
  referencedRelation: ReferencedRelation;
  referencedColumns: ReferencedColumns;
};
type Table<
  Row,
  Required extends keyof Row,
  Editable extends keyof Row,
  Relationships extends Relationship<string, string[], string, string[], boolean>[] = [],
  InsertRow = Pick<Row, Required> & Partial<Omit<Row, Required>>,
> = {
  Row: Row;
  Insert: InsertRow;
  Update: Partial<Pick<Row, Editable>>;
  Relationships: Relationships;
};
export type CompanyRole = "recruiter" | "viewer";
export type BehaviorRating = "insufficient_data" | "below" | "meets" | "above";
export type PositionSnapshot = {
  title: string;
  description: string | null;
  tasks: string[];
  kpis: string[];
  autonomy_level: number | null;
  required_competencies: string[];
  required_behaviors: string[];
};
export type Company = Timestamps & { id: string; name: string; owner_id: string };
export type CompanyMember = Timestamps & { company_id: string; user_id: string; role: CompanyRole };
export type CompanyProfile = Timestamps & {
  company_id: string; industry: string | null; description: string | null;
  website: string | null; size_band: "1-10" | "11-50" | "51-200" | "201-500" | "501+" | null;
  work_environment: string | null; company_values: string[];
};
export type Position = Entity & {
  title: string; description: string | null; tasks: string[]; kpis: string[];
  autonomy_level: number | null; required_behaviors: string[]; required_competencies: string[];
  status: "draft" | "active" | "archived";
};
export type Recruitment = Entity & {
  position_id: string; name: string; status: "draft" | "open" | "paused" | "closed";
  opened_at: string | null; closed_at: string | null;
};
export type CandidateRetentionRule = {
  data_class: 'candidate' | 'assessment' | 'screening' | 'communication' | 'audit' | 'external' | 'backup' | 'exports';
  trigger_event: 'record_created' | 'process_closed' | 'consent_revoked';
  duration_days: number; hold_review_days: number;
};
export type CandidateRetentionPolicy = {
  id: string | null; revision: number; rules: CandidateRetentionRule[];
  configured: boolean; owner_current: boolean; execution_enabled: false;
};
export type ErasureSubjectResolution = { id: string | null; revision: number; candidate_ids: string[]; owner_current: boolean };
export type CandidateErasurePreview = {
  scope_kind: 'candidate_record' | 'confirmed_subject'; candidate_count: number;
  counts: Record<string, number>; blockers: string[]; policy_revision: number; resolution_revision: number;
  manifest_hash: string; schema_signature: string; generated_at: string; expires_at: string; execution_enabled: false;
};
export type ContactChannel = "email" | "sms" | "voice";
export type ContactPermission = Entity & {
  candidate_id: string; recruitment_id: string | null; purpose: "verification_invitation";
  channel: ContactChannel; state: "unverified" | "revoked" | "blocked"; revision: number; source: "operator_recorded";
};
export type ContactWeekdayWindow = { weekday: number; start_minute: number; end_minute: number };
export type ContactPreferences = Entity & {
  candidate_id: string; revision: number; timezone: string; source: "operator_recorded";
  weekday_windows: ContactWeekdayWindow[]; blocked_channels: ContactChannel[];
};
export type CandidateCommunication = Entity & {
  recruitment_id: string; candidate_id: string; application_id: string; shortlist_entry_id: string;
  channel: ContactChannel; purpose: "verification_invitation"; state: "draft" | "cancelled";
  version: number; created_by: string; cancelled_at: string | null;
};
export type CandidateCommunicationEvent = {
  id: string; company_id: string; communication_id: string; actor_id: string; created_at: string;
  event_type: "draft_created" | "cancelled" | "permission_denied" | "preferences_changed";
};
export type CandidateCommunicationApproval = {
  id: string; company_id: string; communication_id: string; communication_version: number;
  receipt_id: string; contact_version: number; shortlist_entry_id: string; analysis_id: string;
  review_id: string; ranking_policy_version: string; approved_by: string; approved_at: string;
};
export type CommunicationApprovalStatus = { approval_id: string | null; is_current: boolean; reason: string };
export type Candidate = Entity & { first_name: string; last_name: string; email: string | null; phone: string | null };
export type Application = Entity & {
  recruitment_id: string; candidate_id: string;
  status: "new" | "in_progress" | "rejected" | "withdrawn" | "hired";
};
export type AssessmentStage = Entity & { recruitment_id: string; name: string; description: string | null; sequence: number };
export type CandidateAssessment = Entity & {
  recruitment_id: string; application_id: string; stage_id: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  score: number | null; notes: string | null; completed_at: string | null;
};
export type CandidateDocument = Entity & {
  candidate_id: string; source_text: string; redacted_text: string; version: number;
  status: "draft" | "reviewed"; reviewed_by: string | null; reviewed_at: string | null;
};
export type BehaviorAssessmentEntry = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  area_key: BehaviorAreaKey; version: number; rating: BehaviorRating; evidence: string;
  required_level: RequiredBehaviorLevel; position_id: string; position_updated_at: string;
  position_snapshot: PositionSnapshot;
  author_id: string; created_at: string;
};
export type ExerciseDefinitionEntry = {
  id: string; exercise_id: string; company_id: string; recruitment_id: string;
  version: number; definition: ExerciseDefinition; position_id: string; position_updated_at: string;
  position_snapshot: BehaviorAssessmentEntry['position_snapshot']; author_id: string; created_at: string;
};
export type ExerciseObservationEntry = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  definition_entry_id: string; version: number; work_sample: string;
  observations: { criterionIndex: number; rating: BehaviorRating; evidence: string }[];
  author_id: string; created_at: string;
};
export type ScreeningRating = "insufficient_data" | "below" | "meets" | "above";
export type ScreeningEvidence = { start: number; end: number; quote: string };
export type ScreeningCriterionSnapshot = {
  id: string;
  kind: "task" | "kpi" | "competency";
  text: string;
};
export type ScreeningBindingSnapshot = {
  company_id: string;
  application_id: string;
  application_updated_at: string;
  recruitment_id: string;
  recruitment_updated_at: string;
  position_id: string;
  position_updated_at: string;
  document_id: string;
  document_version: number;
};
export type ScreeningAnalysisVersion = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  position_id: string; candidate_document_id: string; candidate_document_version: number;
  analysis_version: number; input_fingerprint: string; analysis_contract_hash: string;
  payload_schema_version: number; result_schema_version: number; prompt_version: string;
  provider: string; model: string; model_revision: string | null;
  execution_status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  input_cv_text_snapshot: string; criteria_snapshot: ScreeningCriterionSnapshot[];
  binding_snapshot: ScreeningBindingSnapshot; result_summary: Record<string, unknown> | null;
  overall_score: number | null; stale_at: string | null; stale_reason:
    | "application_changed" | "recruitment_changed" | "position_changed"
    | "candidate_document_changed" | "candidate_document_unreviewed"
    | "screening_contract_changed" | "manual_invalidation"
    | "input_changed_during_processing" | null;
  superseded_by_analysis_id: string | null; failure_code: string | null;
  failure_message: string | null; created_by: string; created_at: string;
  processing_started_at: string | null; completed_at: string | null;
  failed_at: string | null; updated_at: string; latest_review_version: number;
};
export type ScreeningAnalysisAttempt = {
  id: string; company_id: string; analysis_id: string; attempt_no: number;
  idempotency_key: string; status: "pending" | "processing" | "completed" | "failed" | "abandoned";
  lease_token_hash: string | null; lease_expires_at: string | null;
  provider_request_id: string | null; provider_response_id: string | null;
  input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null;
  cost_amount: number | null; cost_currency: string | null; error_code: string | null;
  finalization_hash: string | null; created_at: string; started_at: string | null;
  finished_at: string | null;
};
export type ScreeningCriterionResult = {
  id: string; company_id: string; analysis_id: string; criterion_id: string;
  criterion_kind: "task" | "kpi" | "competency"; criterion_order: number;
  criterion_text_snapshot: string; rating: ScreeningRating; evidence: ScreeningEvidence[];
  explanation: string | null; confidence: number | null; created_at: string;
};
export type ScreeningResultReview = {
  id: string; company_id: string; analysis_id: string; review_version: number;
  reviewer_id: string; disposition: "approved" | "approved_with_changes" | "needs_reanalysis";
  review_note: string | null; created_at: string;
};
export type ScreeningCriterionReviewOverride = {
  id: string; company_id: string; review_id: string; criterion_result_id: string;
  rating_override: ScreeningRating | null; evidence_override: ScreeningEvidence[] | null;
  explanation_override: string | null; created_at: string;
};
export type ScreeningFindingInput = {
  criterion_id: string; rating: ScreeningRating; evidence: ScreeningEvidence[];
  explanation?: string | null; confidence?: number | null;
};
export type ScreeningReviewOverrideInput = {
  criterion_result_id: string; rating_override?: ScreeningRating | null;
  evidence_override?: ScreeningEvidence[] | null; explanation_override?: string | null;
};
export type ScreeningRankingEligibility =
  | "eligible" | "insufficient_evidence" | "result_incomplete" | "review_inconsistent"
  | "no_human_review" | "needs_reanalysis" | "processing" | "pending" | "failed"
  | "cancelled" | "stale" | "no_completed_result";
export type ScreeningRankingRow = {
  application_id: string; analysis_id: string | null; review_id: string | null;
  rank: number | null; rankable: boolean; eligibility_reason: ScreeningRankingEligibility;
  raw_score: number | null; coverage: number | null; total_criteria: number; known_criteria: number;
  below_count: number; meets_count: number; above_count: number; insufficient_data_count: number;
  suggested_shortlist: boolean; ranking_policy_version: string;
  shortlist_entry_id: string | null; shortlist_snapshot_current: boolean;
};
export type RecruitmentShortlistEntry = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  selected_by: string; selected_at: string; source: "manual" | "suggested";
  analysis_id: string; review_id: string; ranking_policy_version: string;
  raw_score_snapshot: number | null; coverage_snapshot: number; note: string | null;
  removed_at: string | null; removed_by: string | null;
};
export type RecruitmentShortlistRow = Omit<RecruitmentShortlistEntry, "id" | "company_id" | "recruitment_id"> & {
  entry_id: string; snapshot_current: boolean; policy_current: boolean;
};
export type Database = {
  public: {
    Tables: {
      candidate_contact_permissions: { Row: ContactPermission; Insert: never; Update: never; Relationships: [] };
      candidate_contact_preferences: { Row: ContactPreferences; Insert: never; Update: never; Relationships: [] };
      candidate_communication_approvals: { Row: CandidateCommunicationApproval; Insert: never; Update: never; Relationships: [] };
      candidate_communications: { Row: CandidateCommunication; Insert: never; Update: never; Relationships: [] };
      candidate_communication_events: { Row: CandidateCommunicationEvent; Insert: never; Update: never; Relationships: [] };
      recruitment_shortlist_entries: {
        Row: RecruitmentShortlistEntry;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"recruitment_shortlist_application_fkey", ["company_id", "recruitment_id", "application_id"], "applications", ["company_id", "recruitment_id", "id"]>,
          Relationship<"recruitment_shortlist_recruitment_fkey", ["company_id", "recruitment_id"], "recruitments", ["company_id", "id"]>,
          Relationship<"recruitment_shortlist_analysis_fkey", ["company_id", "analysis_id"], "screening_analysis_versions", ["company_id", "id"]>,
          Relationship<"recruitment_shortlist_review_fkey", ["company_id", "review_id"], "screening_result_reviews", ["company_id", "id"]>,
        ];
      };
      sales_leads: { Row: SalesLead; Insert: never; Update: never; Relationships: [] };
      platform_operators: { Row: PlatformOperator; Insert: never; Update: never; Relationships: [] };
      screening_criterion_review_overrides: {
        Row: ScreeningCriterionReviewOverride;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"screening_override_review_fkey", ["company_id", "review_id"], "screening_result_reviews", ["company_id", "id"]>,
          Relationship<"screening_override_criterion_fkey", ["company_id", "criterion_result_id"], "screening_criterion_results", ["company_id", "id"]>,
        ];
      };
      screening_result_reviews: {
        Row: ScreeningResultReview;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"screening_review_analysis_fkey", ["company_id", "analysis_id"], "screening_analysis_versions", ["company_id", "id"]>,
        ];
      };
      screening_criterion_results: {
        Row: ScreeningCriterionResult;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"screening_criterion_analysis_fkey", ["company_id", "analysis_id"], "screening_analysis_versions", ["company_id", "id"]>,
        ];
      };
      screening_analysis_attempts: {
        Row: ScreeningAnalysisAttempt;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"screening_attempt_analysis_fkey", ["company_id", "analysis_id"], "screening_analysis_versions", ["company_id", "id"]>,
        ];
      };
      screening_analysis_versions: {
        Row: ScreeningAnalysisVersion;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"screening_analysis_application_fkey", ["company_id", "recruitment_id", "application_id"], "applications", ["company_id", "recruitment_id", "id"]>,
          Relationship<"screening_analysis_recruitment_fkey", ["company_id", "recruitment_id"], "recruitments", ["company_id", "id"]>,
          Relationship<"screening_analysis_position_fkey", ["company_id", "position_id"], "positions", ["company_id", "id"]>,
          Relationship<"screening_analysis_document_fkey", ["company_id", "candidate_document_id"], "candidate_documents", ["company_id", "id"]>,
          Relationship<"screening_analysis_superseded_fkey", ["company_id", "superseded_by_analysis_id"], "screening_analysis_versions", ["company_id", "id"]>,
        ];
      };
      exercise_observation_entries: {
        Row: ExerciseObservationEntry;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"exercise_observation_entries_company_id_recruitment_id_app_fkey", ["company_id", "recruitment_id", "application_id"], "applications", ["company_id", "recruitment_id", "id"]>,
          Relationship<"exercise_observation_entries_company_id_recruitment_id_def_fkey", ["company_id", "recruitment_id", "definition_entry_id"], "exercise_definition_entries", ["company_id", "recruitment_id", "id"]>,
        ];
      };
      exercise_definition_entries: {
        Row: ExerciseDefinitionEntry;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"exercise_definition_entries_company_id_recruitment_id_fkey", ["company_id", "recruitment_id"], "recruitments", ["company_id", "id"]>,
          Relationship<"exercise_definition_entries_company_id_position_id_fkey", ["company_id", "position_id"], "positions", ["company_id", "id"]>,
        ];
      };
      behavior_assessment_entries: {
        Row: BehaviorAssessmentEntry;
        Insert: never;
        Update: never;
        Relationships: [
          Relationship<"behavior_assessment_entries_company_id_recruitment_id_appl_fkey", ["company_id", "recruitment_id", "application_id"], "applications", ["company_id", "recruitment_id", "id"]>,
          Relationship<"behavior_assessment_entries_company_id_position_id_fkey", ["company_id", "position_id"], "positions", ["company_id", "id"]>,
        ];
      };
      candidate_documents: {
        Row: CandidateDocument;
        Insert: Pick<CandidateDocument, "company_id" | "candidate_id" | "source_text" | "redacted_text">;
        Update: Pick<Partial<CandidateDocument>, "redacted_text">;
        Relationships: [
          Relationship<"candidate_documents_company_id_candidate_id_fkey", ["company_id", "candidate_id"], "candidates", ["company_id", "id"]>,
        ];
      };
      companies: Table<Company, "name" | "owner_id", "name", [], never>;
      company_members: Table<
        CompanyMember,
        "company_id" | "user_id",
        "role",
        [Relationship<"company_members_company_id_fkey", ["company_id"], "companies", ["id"]>]
      >;
      company_profiles: Table<
        CompanyProfile,
        "company_id",
        "industry" | "description" | "website" | "size_band" | "work_environment" | "company_values",
        [Relationship<"company_profiles_company_id_fkey", ["company_id"], "companies", ["id"], true>],
        never
      >;
      positions: Table<
        Position,
        "company_id" | "title",
        "title" | "description" | "tasks" | "kpis" | "autonomy_level" | "required_behaviors" | "required_competencies" | "status",
        [Relationship<"positions_company_id_fkey", ["company_id"], "companies", ["id"]>]
      >;
      recruitments: Table<
        Recruitment,
        "company_id" | "position_id" | "name",
        "name" | "status" | "opened_at" | "closed_at",
        [
          Relationship<"recruitments_company_id_fkey", ["company_id"], "companies", ["id"]>,
          Relationship<"recruitments_company_id_position_id_fkey", ["company_id", "position_id"], "positions", ["company_id", "id"]>,
        ]
      >;
      candidates: Table<
        Candidate,
        "company_id" | "first_name" | "last_name",
        "first_name" | "last_name" | "email" | "phone",
        [Relationship<"candidates_company_id_fkey", ["company_id"], "companies", ["id"]>]
      >;
      applications: Table<
        Application,
        "company_id" | "recruitment_id" | "candidate_id",
        "status",
        [
          Relationship<"applications_company_id_fkey", ["company_id"], "companies", ["id"]>,
          Relationship<"applications_company_id_recruitment_id_fkey", ["company_id", "recruitment_id"], "recruitments", ["company_id", "id"]>,
          Relationship<"applications_company_id_candidate_id_fkey", ["company_id", "candidate_id"], "candidates", ["company_id", "id"]>,
        ]
      >;
      assessment_stages: Table<
        AssessmentStage,
        "company_id" | "recruitment_id" | "name" | "sequence",
        "name" | "description" | "sequence",
        [
          Relationship<"assessment_stages_company_id_fkey", ["company_id"], "companies", ["id"]>,
          Relationship<"assessment_stages_company_id_recruitment_id_fkey", ["company_id", "recruitment_id"], "recruitments", ["company_id", "id"]>,
        ]
      >;
      candidate_assessments: Table<
        CandidateAssessment,
        "company_id" | "recruitment_id" | "application_id" | "stage_id",
        "status" | "score" | "notes" | "completed_at",
        [
          Relationship<"candidate_assessments_company_id_fkey", ["company_id"], "companies", ["id"]>,
          Relationship<"candidate_assessments_company_id_recruitment_id_applicatio_fkey", ["company_id", "recruitment_id", "application_id"], "applications", ["company_id", "recruitment_id", "id"]>,
          Relationship<"candidate_assessments_company_id_recruitment_id_stage_id_fkey", ["company_id", "recruitment_id", "stage_id"], "assessment_stages", ["company_id", "recruitment_id", "id"]>,
        ]
      >;
    };
    Views: {
      latest_exercise_observations: { Row: ExerciseObservationEntry; Relationships: [] };
      latest_behavior_assessments: { Row: BehaviorAssessmentEntry; Relationships: [] };
      latest_exercise_definitions: { Row: ExerciseDefinitionEntry; Relationships: [] };
    };
    Functions: {
      configure_candidate_retention_policy: {
        Args: { target_company: string; expected_revision: number; policy_rules: CandidateRetentionRule[]; request_key: string };
        Returns: string;
      };
      get_candidate_retention_policy: { Args: { target_company: string }; Returns: CandidateRetentionPolicy };
      confirm_erasure_subject: {
        Args: { target_candidate: string; candidate_ids: string[]; expected_revision: number; request_key: string };
        Returns: string;
      };
      get_erasure_subject_resolution: { Args: { target_candidate: string }; Returns: ErasureSubjectResolution };
      set_candidate_erasure_hold: { Args: { target_request: string; reason: 'legal_review' | 'active_purpose' | 'owner_review'; review_at: string; expires_at: string; request_key: string }; Returns: string };
      release_candidate_erasure_hold: { Args: { target_hold: string }; Returns: string };
      issue_candidate_erasure_preview: {
        Args: { target_candidate: string; scope_kind?: 'candidate_record' | 'confirmed_subject'; resolution_id?: string | null };
        Returns: CandidateErasurePreview & { preview_ticket_id: string };
      };
      request_candidate_erasure: { Args: { preview_ticket_id: string; request_key: string }; Returns: string };
      cancel_candidate_erasure: { Args: { target_request: string; expected_generation: number; request_key: string }; Returns: string };
      get_erasure_status: { Args: { target_request: string }; Returns: CandidateErasureStatus };
      get_candidate_erasure_status: { Args: { target_candidate: string }; Returns: CandidateErasureStatus | null };
      list_candidate_erasure_requests: {
        Args: { target_company: string; before_created_at?: string | null; before_id?: string | null; page_size?: number };
        Returns: CandidateErasureStatus[];
      };
      preview_candidate_erasure: {
        Args: { target_candidate: string; scope_kind?: 'candidate_record' | 'confirmed_subject'; resolution_id?: string | null };
        Returns: CandidateErasurePreview;
      };
      save_sales_pipeline: { Args: { target_lead: string; expected_version: number; new_stage: string; new_note: string; next_contact: string | null; linked_company: string | null }; Returns: string };
      list_sales_pipeline: { Args: { stage_filter?: string; due_filter?: string; page_offset?: number; target_lead?: string }; Returns: SalesPipelineRow[] };
      sales_pipeline_history: { Args: { target_lead: string; before_version?: number }; Returns: Pick<SalesPipelineRow, 'version' | 'stage' | 'note' | 'next_contact_on' | 'company_id' | 'created_at'>[] };
      find_sales_companies: { Args: { search_text: string }; Returns: { id: string; name: string }[] };
      approve_candidate_communication: {
        Args: { target_communication: string; expected_version: number; receipt_id: string; request_key: string };
        Returns: string;
      };
      get_communication_approval_status: {
        Args: { target_communication: string };
        Returns: CommunicationApprovalStatus[];
      };
      record_contact_permission: {
        Args: { target_candidate: string; target_recruitment: string | null; contact_channel: ContactChannel;
          permission_state: ContactPermission["state"]; evidence_ref: string | null; expected_revision: number; request_key: string };
        Returns: string;
      };
      set_contact_preferences: {
        Args: { target_candidate: string; contact_timezone: string; weekday_windows: ContactWeekdayWindow[];
          blocked_channels: ContactChannel[]; expected_revision: number; request_key: string };
        Returns: string;
      };
      prepare_candidate_communication: {
        Args: { target_application: string; target_shortlist: string; contact_channel: ContactChannel; request_key: string };
        Returns: string;
      };
      cancel_candidate_communication: {
        Args: { target_id: string; expected_version: number; request_key: string }; Returns: string;
      };
      get_candidate_communications: {
        Args: { target_application: string; after_created_at?: string | null; after_id?: string | null; page_size?: number };
        Returns: CandidateCommunication[];
      };
      get_candidate_communication_history: {
        Args: { target_id: string; after_created_at?: string | null; after_id?: string | null; page_size?: number };
        Returns: CandidateCommunicationEvent[];
      };
      get_screening_ranking: {
        Args: { target_recruitment: string; target_size?: number | null };
        Returns: ScreeningRankingRow[];
      };
      get_recruitment_shortlist: {
        Args: { target_recruitment: string; include_removed?: boolean | null };
        Returns: RecruitmentShortlistRow[];
      };
      add_recruitment_shortlist_entry: {
        Args: {
          target_application: string; entry_source: RecruitmentShortlistEntry["source"];
          expected_analysis_id: string; expected_review_id: string; expected_policy_version: string;
          entry_note?: string | null; target_size?: number | null;
        };
        Returns: string;
      };
      remove_recruitment_shortlist_entry: { Args: { target_entry: string }; Returns: string };
      claim_sales_mail: {
        Args: { target_lead: string | null; request_id: string; issued_at_ms: number; request_signature: string };
        Returns: { lead_id: string; email: string; template_version: string; lease_id: string }[];
      };
      finish_sales_mail: {
        Args: { target_lead: string; request_id: string; issued_at_ms: number; outcome: string; provider_id: string | null; request_signature: string };
        Returns: boolean;
      };
      submit_sales_lead: { Args: {
        idempotency_key: string; first_name: string; company_name: string; email: string;
        phone: string | null; needs: string; source_ip: string; issued_at_us: number; request_signature: string;
      }; Returns: { lead_id: string | null; result_code: string }[] };
      list_sales_leads: { Args: { result_limit?: number }; Returns: SalesLead[] };
      list_sales_leads_inbox: { Args: { result_limit?: number }; Returns: (Omit<SalesLead, 'idempotency_key' | 'fingerprint_hash'> & { closed_at: string | null })[] };
      close_sales_lead: { Args: { target_lead: string }; Returns: string };
      platform_operator_status: { Args: Record<PropertyKey, never>; Returns: boolean };
      grant_platform_operator: { Args: { target_user: string }; Returns: string };
      revoke_platform_operator: { Args: { target_user: string }; Returns: string };
      review_screening_result: {
        Args: {
          target_analysis: string;
          expected_review_version: number;
          new_disposition: ScreeningResultReview["disposition"];
          new_review_note: string | null;
          new_overrides?: ScreeningReviewOverrideInput[];
        };
        Returns: string;
      };
      retry_screening_analysis: {
        Args: { target_analysis: string; request_idempotency_key: string };
        Returns: { analysis_id: string; attempt_id: string; analysis_version: number }[];
      };
      fail_screening_attempt: {
        Args: {
          target_attempt: string;
          provided_lease_token: string;
          expected_input_fingerprint: string;
          expected_analysis_contract_hash: string;
          new_error_code: string;
          new_error_message?: string | null;
          new_provider_request_id?: string | null;
          new_input_tokens?: number | null;
          new_output_tokens?: number | null;
          new_cached_input_tokens?: number | null;
          new_cost_amount?: number | null;
          new_cost_currency?: string | null;
        };
        Returns: string;
      };
      complete_screening_analysis: {
        Args: {
          target_attempt: string;
          provided_lease_token: string;
          expected_input_fingerprint: string;
          expected_analysis_contract_hash: string;
          findings: ScreeningFindingInput[];
          new_provider_request_id?: string | null;
          new_provider_response_id?: string | null;
          new_input_tokens?: number | null;
          new_output_tokens?: number | null;
          new_cached_input_tokens?: number | null;
          new_cost_amount?: number | null;
          new_cost_currency?: string | null;
        };
        Returns: string;
      };
      claim_screening_attempt: {
        Args: { target_attempt: string };
        Returns: {
          analysis_id: string;
          attempt_id: string;
          lease_token: string;
          lease_expires_at: string;
          input_fingerprint: string;
          analysis_contract_hash: string;
          payload_schema_version: number;
          result_schema_version: number;
          prompt_version: string;
          provider: string;
          model: string;
          model_revision: string | null;
          input_cv_text_snapshot: string;
          criteria_snapshot: ScreeningCriterionSnapshot[];
        }[];
      };
      start_screening_analysis: {
        Args: {
          target_application: string;
          expected_input_fingerprint: string;
          expected_payload_schema_version: number;
          requested_result_schema_version: number;
          requested_prompt_version: string;
          requested_provider: string;
          requested_model: string;
          requested_model_revision: string | null;
          request_idempotency_key: string;
          force_reanalysis?: boolean;
        };
        Returns: {
          analysis_id: string;
          attempt_id: string | null;
          analysis_version: number;
          execution_status: ScreeningAnalysisVersion["execution_status"];
          reused: boolean;
        }[];
      };
      save_exercise_observations: { Args: { target_application: string; target_definition: string; expected_version: number; new_work_sample: string; new_observations: ExerciseObservationEntry['observations'] }; Returns: string };
      save_exercise_definition: { Args: { target_recruitment: string; target_exercise: string;
        new_definition: ExerciseDefinition; expected_version: number; expected_position_id: string;
        expected_position_updated_at: string }; Returns: string };
      save_behavior_assessment: { Args: { target_application: string; target_area: BehaviorAreaKey; new_rating: BehaviorRating;
        new_evidence: string; expected_version: number; expected_position_updated_at: string; expected_position_id: string }; Returns: string };
      review_candidate_document: { Args: { document_id: string; expected_version: number }; Returns: boolean };
      create_company: { Args: { company_name: string }; Returns: string };
      ensure_initial_company: { Args: { company_name: string }; Returns: string };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
export type TableName = keyof Database["public"]["Tables"];
export type ViewName = keyof Database["public"]["Views"];
export type FunctionName = keyof Database["public"]["Functions"];
export type RelationName = TableName | ViewName;
export type Row<T extends RelationName> =
  T extends TableName
    ? Database["public"]["Tables"][T]["Row"]
    : T extends ViewName
      ? Database["public"]["Views"][T]["Row"]
      : never;
export type Insert<T extends TableName> = Database["public"]["Tables"][T]["Insert"];
export type Update<T extends TableName> = Database["public"]["Tables"][T]["Update"];

export type SalesLead = {
  id: string; idempotency_key: string; first_name: string; company_name: string;
  email: string; phone: string | null; needs: string; status: 'received';
  submitted_by: string | null; fingerprint_hash: string; created_at: string;
};
export type PlatformOperator = {
  user_id: string; granted_at: string; granted_by: string | null; revoked_at: string | null;
};

export type SalesPipelineRow = {
 id: string; first_name: string; company_name: string; email: string; phone: string | null;
 needs: string; created_at: string; stage: import('../sales-pipeline').SalesStage;
 note: string; next_contact_on: string | null; company_id: string | null;
 linked_company_name: string | null; version: number; closed_at: string | null; total_count: number;
};

export type CandidateErasureStatus = {
  request_id: string;
  company_id: string;
  status: 'authorized' | 'cancelled' | 'erasing' | 'active_data_erased';
  generation: number;
  scope_kind: 'candidate_record' | 'confirmed_subject';
  candidate_count: number;
  created_at: string;
  cancelled_at: string | null;
  execution_enabled: false;
  phase: 'local_frozen' | 'authorized' | 'cancelled' | 'erasing' | 'active_data_erased' | 'cancellation_pending' | 'ledger_pending';
  ledger_sequence?: number;
  pending_phase?: string | null;
  local_purged?: boolean;
  can_cancel: boolean;
  blockers: string[];
};
