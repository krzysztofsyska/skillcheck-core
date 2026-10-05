import type { Metadata } from "next";
import { HomePage } from "./components/marketing/home-page";

export const metadata: Metadata = {
  title: "SkillCheck — uporządkuj ocenę kandydatów",
  description:
    "SkillCheck zestawia informacje o kandydatach z wymaganiami stanowiska. Strona pokazuje dostępny zakres, planowaną ofertę i fikcyjny przykład prezentacji.",
};

export default function Home() {
  return <HomePage />;
}
