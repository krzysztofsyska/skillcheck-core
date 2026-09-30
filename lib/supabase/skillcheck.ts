import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Insert, Update, TableName } from "./database.types";

type New<T extends TableName> = Omit<Insert<T>, "company_id" | "id" | "created_at" | "updated_at">;

// Supply the existing cookie/browser-session client. Never a service-role client.
// Explicit tenant filters improve scoping; PostgreSQL RLS is the security boundary.
// Methods return Supabase { data, error }; callers must handle error before using data.
export function skillcheckData(client: SupabaseClient<Database>) {
  return {
    listCompanies: () => client.from("companies").select("*").order("name"),
    createCompany: (name: string) => client.rpc("create_company", { company_name: name }),
    company(companyId: string) {
      return {
        get: () => client.from("companies").select("*").eq("id", companyId).single(),
        rename: (name: string) => client.from("companies").update({ name }).eq("id", companyId).select().single(),
        members: {
          list: () => client.from("company_members").select("*").eq("company_id", companyId),
          add: (userId: string, role: "recruiter" | "viewer") => client.from("company_members").insert({ company_id: companyId, user_id: userId, role }).select().single(),
          setRole: (userId: string, role: "recruiter" | "viewer") => client.from("company_members").update({ role }).eq("company_id", companyId).eq("user_id", userId).select().single(),
          remove: (userId: string) => client.from("company_members").delete().eq("company_id", companyId).eq("user_id", userId).select(),
        },
        profile: {
          get: () => client.from("company_profiles").select("*").eq("company_id", companyId).single(),
          update: (input: Update<"company_profiles">) => client.from("company_profiles").update(input).eq("company_id", companyId).select().single(),
        },
        positions: {
          list: () => client.from("positions").select("*").eq("company_id", companyId).order("created_at"),
          get: (id: string) => client.from("positions").select("*").eq("company_id", companyId).eq("id", id).single(),
          create: (input: New<"positions">) => client.from("positions").insert({ ...input, company_id: companyId }).select().single(),
          update: (id: string, input: Update<"positions">) => client.from("positions").update(input).eq("company_id", companyId).eq("id", id).select().single(),
          remove: (id: string) => client.from("positions").delete().eq("company_id", companyId).eq("id", id).select(),
        },
        recruitments: {
          list: () => client.from("recruitments").select("*").eq("company_id", companyId).order("created_at"),
          get: (id: string) => client.from("recruitments").select("*").eq("company_id", companyId).eq("id", id).single(),
          create: (input: New<"recruitments">) => client.from("recruitments").insert({ ...input, company_id: companyId }).select().single(),
          update: (id: string, input: Update<"recruitments">) => client.from("recruitments").update(input).eq("company_id", companyId).eq("id", id).select().single(),
          remove: (id: string) => client.from("recruitments").delete().eq("company_id", companyId).eq("id", id).select(),
        },
        candidates: {
          list: () => client.from("candidates").select("*").eq("company_id", companyId).order("created_at"),
          get: (id: string) => client.from("candidates").select("*").eq("company_id", companyId).eq("id", id).single(),
          create: (input: New<"candidates">) => client.from("candidates").insert({ ...input, company_id: companyId }).select().single(),
          update: (id: string, input: Update<"candidates">) => client.from("candidates").update(input).eq("company_id", companyId).eq("id", id).select().single(),
          remove: (id: string) => client.from("candidates").delete().eq("company_id", companyId).eq("id", id).select(),
        },
        applications: {
          list: (recruitmentId: string) => client.from("applications").select("*").eq("company_id", companyId).eq("recruitment_id", recruitmentId).order("created_at"),
          get: (id: string) => client.from("applications").select("*").eq("company_id", companyId).eq("id", id).single(),
          create: (input: New<"applications">) => client.from("applications").insert({ ...input, company_id: companyId }).select().single(),
          update: (id: string, input: Update<"applications">) => client.from("applications").update(input).eq("company_id", companyId).eq("id", id).select().single(),
          remove: (id: string) => client.from("applications").delete().eq("company_id", companyId).eq("id", id).select(),
        },
        stages: {
          list: (recruitmentId: string) => client.from("assessment_stages").select("*").eq("company_id", companyId).eq("recruitment_id", recruitmentId).order("sequence"),
          get: (id: string) => client.from("assessment_stages").select("*").eq("company_id", companyId).eq("id", id).single(),
          create: (input: New<"assessment_stages">) => client.from("assessment_stages").insert({ ...input, company_id: companyId }).select().single(),
          update: (id: string, input: Update<"assessment_stages">) => client.from("assessment_stages").update(input).eq("company_id", companyId).eq("id", id).select().single(),
          remove: (id: string) => client.from("assessment_stages").delete().eq("company_id", companyId).eq("id", id).select(),
        },
        assessments: {
          list: (recruitmentId: string) => client.from("candidate_assessments").select("*").eq("company_id", companyId).eq("recruitment_id", recruitmentId).order("created_at"),
          get: (id: string) => client.from("candidate_assessments").select("*").eq("company_id", companyId).eq("id", id).single(),
          create: (input: New<"candidate_assessments">) => client.from("candidate_assessments").insert({ ...input, company_id: companyId }).select().single(),
          update: (id: string, input: Update<"candidate_assessments">) => client.from("candidate_assessments").update(input).eq("company_id", companyId).eq("id", id).select().single(),
          remove: (id: string) => client.from("candidate_assessments").delete().eq("company_id", companyId).eq("id", id).select(),
        },
      };
    },
  };
}
