import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Kalkulator SkillCheck — interaktywny podgląd",
  description: "Interaktywny podgląd kalkulatora SkillCheck. Symulacja, bez aktywnej sprzedaży ani płatności.",
};

export default function KalkulatorPage() {
  redirect("/kalkulator-demo.html");
}
