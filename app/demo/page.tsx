import type { Metadata } from "next";
import { DemoPage } from "../components/marketing/demo-page";

export const metadata: Metadata = {
  title: "Przykład prezentacji kandydatów — SkillCheck",
  description:
    "Fikcyjny przykład prezentacji informacji o kandydatach na stanowisko przedstawiciela handlowego. To nie jest wynik analizy.",
};

export default function Demo() {
  return <DemoPage />;
}
