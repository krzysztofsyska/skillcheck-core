import type { Metadata } from "next";
import { LegalDocumentPage } from "../../components/legal/legal-document";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "Aneks nr 1 – Rozmowy głosowe — SkillCheck" };

export default function Page() {
  return <LegalDocumentPage documentKey="aneks1" />;
}
