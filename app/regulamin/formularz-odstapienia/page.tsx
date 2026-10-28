import type { Metadata } from "next";
import { LegalDocumentPage } from "../../components/legal/legal-document";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "Formularz odstąpienia od umowy — SkillCheck" };

export default function Page() {
  return <LegalDocumentPage documentKey="odstapienie" />;
}
