import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Kalkulator kosztu rekrutacji — SkillCheck",
  description: "Policz koszt ręcznej analizy CV i porównaj go z ceną SkillCheck oraz budżetem agencji. Kalkulator nie pobiera płatności.",
};

export default function KalkulatorPage() {
  redirect("/kalkulator-demo.html");
}
