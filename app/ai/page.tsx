import type { Metadata } from "next";
import { LegalDocumentPage } from "../components/legal/legal-document";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "AI i nadzór człowieka — SkillCheck" };

export default function Page() {
  return <LegalDocumentPage documentKey="ai" />;
}
