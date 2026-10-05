import type { Metadata } from "next";
import { HomePage } from "./components/marketing/home-page";

export const metadata: Metadata = {
  title: "SkillCheck — uporządkuj ocenę kandydatów",
  description:
    "SkillCheck pomaga przygotować profil stanowiska i materiały kandydatów. Poznaj dostępne funkcje oraz demonstracyjny przykład planowanej analizy.",
};

export default function Home() {
  return <HomePage />;
}
