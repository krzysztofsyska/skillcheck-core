// Public API contract after migrations 20260930000100 through 20261004000100.
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
export type Database = {
  public: {
    Tables: {
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
