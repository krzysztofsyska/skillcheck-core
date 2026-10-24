import type { Metadata } from "next";
import { HomePage } from "./components/marketing/home-page";

// Package policy and its server flag must be evaluated per request, including
// when the deployment was built while packages were disabled.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SkillCheck — ludzie, kompetencje, świadome decyzje",
  description:
    "Poznaj SkillCheck: od zrozumienia firmy i stanowiska do uporządkowanej oceny kandydatów. Sprawdź dostępne funkcje, przykład raportu i kierunek rozwoju.",
};

export default function Home() {
  return <HomePage />;
}
