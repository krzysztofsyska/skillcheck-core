import type { Metadata } from "next";
import { HomePage } from "./components/marketing/home-page";

export const metadata: Metadata = {
  title: "SkillCheck — ludzie, kompetencje, świadome decyzje",
  description:
    "Poznaj SkillCheck: od zrozumienia firmy i stanowiska do uporządkowanej oceny kandydatów. Sprawdź dostępne funkcje, przykład raportu i kierunek rozwoju.",
};

export default function Home() {
  return <HomePage />;
}
