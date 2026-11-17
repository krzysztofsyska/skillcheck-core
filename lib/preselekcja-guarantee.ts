// R4 (issue #492): PRESELEKCJA result guarantee, copy shown on /preselekcja. The binding wording is
// § 10 ust. 5 of the Regulamin (docs/legal/v1.0/01_Regulamin_SkillCheck.md); this is its short form.
// Owner decision 2026-11-17. Do not state how long the report takes. The refund is done by the
// operator outside the app: nothing here touches prices, the catalog, checkout or order states.

export const preselekcjaGuarantee = {
  headline: "60 CV. Minimum 5 kandydatów spełniających Twoje wymagania konieczne. Albo oddajemy pieniądze.",
  points: [
    "Darmowa powtórka analizy tych samych CV po wspólnej poprawie opisu stanowiska.",
    "Zwrot 300 zł, jeśli powtórka nie pomoże.",
    "Gwarancja dla pierwszych 20 firm, które kupiły PRESELEKCJĘ. Zgłoszenie w ciągu 7 dni od otrzymania raportu.",
  ],
} as const;
