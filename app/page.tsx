import type { Metadata } from "next";
import { HomePage } from "./components/marketing/home-page";

// Package policy and its server flag must be evaluated per request, including
// when the deployment was built while packages were disabled.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SkillCheck — masz kandydatów, sprawdź komu warto poświęcić czas",
  description:
    "Uporządkuj CV według wymagań stanowiska i przygotuj shortlistę. FREE za 0 zł, PRESELEKCJA za 300 zł brutto. Sprawdź przykład raportu i kalkulator kosztu rekrutacji.",
};

export default function Home() {
  return <HomePage />;
}
