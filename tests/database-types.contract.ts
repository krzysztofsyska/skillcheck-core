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
  | "exercise_observation_entries";
type ExpectedViews =
  | "latest_behavior_assessments"
  | "latest_exercise_definitions"
  | "latest_exercise_observations";
type ExpectedFunctions =
  | "create_company"
  | "ensure_initial_company"
  | "review_candidate_document"
  | "save_behavior_assessment"
  | "save_exercise_definition"
  | "save_exercise_observations";

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
