// Contract for 20260930000100_skillcheck_core.sql; regenerate from Supabase
// after deployment: supabase gen types typescript --project-id <id> --schema public
type Timestamps = { created_at: string; updated_at: string };
type Entity = Timestamps & { id: string; company_id: string };
type Table<Row, Required extends keyof Row, Editable extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Pick<Row, Editable>>;
  Relationships: [];
};
export type Company = Timestamps & { id: string; name: string; owner_id: string };
export type CompanyMember = Timestamps & { company_id: string; user_id: string; role: "recruiter" | "viewer" };
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
export type Database = {
  public: {
    Tables: {
      candidate_documents: {
        Row: CandidateDocument;
        Insert: Pick<CandidateDocument, "company_id" | "candidate_id" | "source_text" | "redacted_text">;
        Update: Pick<Partial<CandidateDocument>, "redacted_text">;
        Relationships: [];
      };
      companies: Table<Company, "name" | "owner_id", "name">;
      company_members: Table<CompanyMember, "company_id" | "user_id", "role">;
      company_profiles: Table<CompanyProfile, "company_id", "industry" | "description" | "website" | "size_band" | "work_environment" | "company_values">;
      positions: Table<Position, "company_id" | "title", "title" | "description" | "tasks" | "kpis" | "autonomy_level" | "required_behaviors" | "required_competencies" | "status">;
      recruitments: Table<Recruitment, "company_id" | "position_id" | "name", "name" | "status" | "opened_at" | "closed_at">;
      candidates: Table<Candidate, "company_id" | "first_name" | "last_name", "first_name" | "last_name" | "email" | "phone">;
      applications: Table<Application, "company_id" | "recruitment_id" | "candidate_id", "status">;
      assessment_stages: Table<AssessmentStage, "company_id" | "recruitment_id" | "name" | "sequence", "name" | "description" | "sequence">;
      candidate_assessments: Table<CandidateAssessment, "company_id" | "recruitment_id" | "application_id" | "stage_id", "status" | "score" | "notes" | "completed_at">;
    };
    Views: { [_ in never]: never };
    Functions: {
      review_candidate_document: { Args: { document_id: string; expected_version: number }; Returns: boolean };
      create_company: { Args: { company_name: string }; Returns: string };
      ensure_initial_company: { Args: { company_name: string }; Returns: string };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
export type TableName = keyof Database["public"]["Tables"];
export type Insert<T extends TableName> = Database["public"]["Tables"][T]["Insert"];
export type Update<T extends TableName> = Database["public"]["Tables"][T]["Update"];
