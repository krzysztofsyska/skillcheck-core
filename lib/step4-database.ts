// Isolated Step 4 type overlay. Deliberately does not modify the shared
// database.types.ts owned by the parallel Step 3 PR #171.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

type Core = Database['public'];
type CoreTables = Core['Tables'];
type CoreApplication = CoreTables['applications'];
type CoreAssessment = CoreTables['candidate_assessments'];

export type Step4ApplicationFields = {
  current_stage_id: string | null;
  human_decision: 'next_stage' | 'on_hold' | 'closed' | null;
  human_decision_reason: string | null;
};
export type Step4CandidateAssessment = CoreAssessment['Row'] & { guide_question_id: string | null };

type StageEvent = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  from_stage_id: string | null; to_stage_id: string | null;
  actor_id: string; created_at: string;
};
type DecisionEvent = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  previous_decision: Step4ApplicationFields['human_decision'];
  new_decision: NonNullable<Step4ApplicationFields['human_decision']>;
  reason: string; actor_id: string; created_at: string;
};
type NoteRevision = {
  id: string; company_id: string; recruitment_id: string; application_id: string;
  assessment_id: string; body: string | null; guide_question_id: string | null;
  author_id: string; created_at: string;
};
type ReadonlyAuditTable<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] };

export type Step4Database = Omit<Database, 'public'> & {
  public: Omit<Core, 'Tables' | 'Functions'> & {
    Tables: Omit<CoreTables, 'applications' | 'candidate_assessments'> & {
      applications: Omit<CoreApplication, 'Row' | 'Insert' | 'Relationships'> & {
        Row: CoreApplication['Row'] & Step4ApplicationFields;
        Insert: CoreApplication['Insert'] & Partial<Step4ApplicationFields>;
        Relationships: CoreApplication['Relationships'];
      };
      candidate_assessments: Omit<CoreAssessment, 'Row' | 'Insert' | 'Update' | 'Relationships'> & {
        Row: Step4CandidateAssessment;
        Insert: CoreAssessment['Insert'] & { guide_question_id?: string | null };
        Update: CoreAssessment['Update'] & { guide_question_id?: string | null };
        Relationships: CoreAssessment['Relationships'];
      };
      application_stage_events: ReadonlyAuditTable<StageEvent>;
      application_decision_events: ReadonlyAuditTable<DecisionEvent>;
      candidate_assessment_note_revisions: ReadonlyAuditTable<NoteRevision>;
    };
    Functions: Core['Functions'] & {
      move_assessment_stage: {
        Args: { target_company: string; target_recruitment: string; target_stage: string; move_direction: number };
        Returns: undefined;
      };
      move_application_stage: {
        Args: { target_company: string; target_recruitment: string; target_application: string; target_stage: string | null };
        Returns: undefined;
      };
      set_application_human_decision: {
        Args: { target_company: string; target_recruitment: string; target_application: string; requested_decision: NonNullable<Step4ApplicationFields['human_decision']>; justification: string };
        Returns: undefined;
      };
    };
  };
};

export function step4Client(client: SupabaseClient<Database>): SupabaseClient<Step4Database> {
  return client as unknown as SupabaseClient<Step4Database>;
}
