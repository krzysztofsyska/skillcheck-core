export const demoNotice =
  "Dane demonstracyjne — fikcyjny przykład prezentacji informacji o kandydatach";

export const evidenceLabels = [
  "Informacja w materiale",
  "Częściowa informacja",
  "Brak danych",
  "Do wyjaśnienia",
] as const;

export type EvidenceLabel = (typeof evidenceLabels)[number];

export const labelHelp: Record<EvidenceLabel, string> = {
  "Informacja w materiale": "Da się wskazać cytat w fikcyjnym materiale.",
  "Częściowa informacja": "Materiał mówi o zbliżonym fakcie, ale nie opisuje wymagania wprost.",
  "Brak danych": "Materiał nie zawiera informacji o tym wymaganiu. To nie jest wynik zerowy.",
  "Do wyjaśnienia": "Jest wzmianka, która nie pozwala ustalić wymagania. To nie jest ocena negatywna.",
};

export type Quote = {
  source: string;
  text: string;
};

export type Finding = {
  label: EvidenceLabel;
  summary: string;
  quote: Quote | null;
};

export type CriterionId = "b2b" | "acquisition" | "crm" | "negotiation";

export type Criterion = {
  id: CriterionId;
  title: string;
  expectation: string;
};

export const criteria: Criterion[] = [
  {
    id: "b2b",
    title: "Doświadczenie w sprzedaży B2B",
    expectation: "Czy materiały opisują sprzedaż firmom, a nie tylko klientom indywidualnym.",
  },
  {
    id: "acquisition",
    title: "Pozyskiwanie klientów",
    expectation: "Czy opisano samodzielne doprowadzenie do rozmowy lub umowy z firmą, z którą wcześniej nie było współpracy.",
  },
  {
    id: "crm",
    title: "Praca z CRM",
    expectation: "Czy opisano korzystanie z systemu CRM.",
  },
  {
    id: "negotiation",
    title: "Prowadzenie negocjacji",
    expectation: "Czy opisano samodzielne ustalanie warunków umowy.",
  },
];

export const role = {
  title: "Przedstawiciel handlowy",
  description:
    "Rekrutacja dotyczy osoby, która ma sprzedawać oprogramowanie firmom. Osoba na tym stanowisku rozmawia z firmami, zapisuje przebieg szans sprzedaży i ustala warunki umowy w zakresie powierzonym przez pracodawcę.",
};

export type Candidate = {
  name: string;
  profile: string;
  findings: Record<CriterionId, Finding>;
  gaps: string[];
  questions: string[];
};

export const candidates: Candidate[] = [
  {
    name: "Piotr Adamski",
    profile:
      "Fikcyjne CV opisuje trzy lata sprzedaży detalicznej i rok asysty w zespole handlowym firmy BiuroPlus. Materiały mówią o ofertach przygotowywanych według wzoru opiekuna, o zapytaniach przychodzących i o arkuszu współdzielonym. Notatka ze spotkania wstępnego mówi o udziale w rozmowach, na których warunki ustalał kierownik.",
    findings: {
      b2b: {
        label: "Częściowa informacja",
        summary: "Jest opis przygotowywania ofert dla klientów biznesowych. Nie ma opisu samodzielnej sprzedaży B2B.",
        quote: {
          source: "CV (fikcyjne)",
          text: "2024–2025, asystent handlowy, BiuroPlus — przygotowywanie ofert dla klientów biznesowych według wzoru opiekuna.",
        },
      },
      acquisition: {
        label: "Do wyjaśnienia",
        summary: "Materiały opisują obsługę zapytań, które już wpłynęły. Nie wynika z nich, czy Piotr sam pozyskiwał nowe firmy.",
        quote: {
          source: "CV (fikcyjne)",
          text: "Obsługa zapytań przychodzących od firm, które same skontaktowały się z BiuroPlus.",
        },
      },
      crm: {
        label: "Do wyjaśnienia",
        summary: "Jest informacja o arkuszu współdzielonym. Nie ma informacji o pracy w CRM.",
        quote: {
          source: "CV (fikcyjne)",
          text: "Wprowadzanie kontaktów do arkusza współdzielonego.",
        },
      },
      negotiation: {
        label: "Do wyjaśnienia",
        summary: "Jest opis udziału w spotkaniach. Warunki ustalał kierownik. Brak informacji o samodzielnym prowadzeniu negocjacji.",
        quote: {
          source: "Notatka ze spotkania wstępnego (fikcyjna)",
          text: "Uczestniczył w dwóch spotkaniach z klientem. Warunki umowy ustalał kierownik.",
        },
      },
    },
    gaps: [
      "Brak opisu samodzielnej sprzedaży B2B. Materiały mówią o asyście przy ofertach.",
      "Brak danych o samodzielnym pozyskiwaniu klientów.",
      "Brak potwierdzenia pracy w CRM. Jest tylko arkusz współdzielony.",
      "Brak informacji o samodzielnym prowadzeniu negocjacji.",
    ],
    questions: [
      "Które części oferty dla klienta biznesowego przygotowywałeś samodzielnie, a które dostawałeś gotowe od opiekuna?",
      "Czy sam doprowadzałeś do pierwszego kontaktu z firmą, czy pracowałeś na zapytaniach, które już wpłynęły?",
      "Czy korzystałeś z CRM? Jeśli tak, z jakiego systemu i co w nim uzupełniałeś?",
      "Podaj przykład warunków umowy, które ustalałeś samodzielnie. Jeśli nie było takiej sytuacji, powiedz o tym wprost.",
    ],
  },
  {
    name: "Helena Nowak",
    profile:
      "Fikcyjne CV opisuje osiem lat sprzedaży usług serwisowych dla sieci handlowych w firmie SerwisSieci. Materiały mówią o umowach ramowych, o raportowaniu pipeline w Salesforce i o renegocjacjach aneksów. Nie opisują pozyskiwania nowych klientów. Jest tylko wzmianka o rozwoju zamówień u obecnych odbiorców.",
    findings: {
      b2b: {
        label: "Informacja w materiale",
        summary: "CV opisuje wieloletnią sprzedaż do sieci handlowych i umowy ramowe.",
        quote: {
          source: "CV (fikcyjne)",
          text: "2017–2025, przedstawicielka handlowa, SerwisSieci — umowy ramowe z sieciami sklepów.",
        },
      },
      acquisition: {
        label: "Brak danych",
        summary: "Zdanie dotyczy firm, które już są odbiorcami. Materiały nie opisują pozyskiwania nowych klientów.",
        quote: {
          source: "CV (fikcyjne)",
          text: "Rozwój zamówień u obecnych odbiorców.",
        },
      },
      crm: {
        label: "Informacja w materiale",
        summary: "CV wskazuje Salesforce i cotygodniowe raportowanie pipeline.",
        quote: {
          source: "CV (fikcyjne)",
          text: "Raportowanie pipeline w Salesforce raz w tygodniu.",
        },
      },
      negotiation: {
        label: "Informacja w materiale",
        summary: "Fikcyjna opinia opisuje prowadzenie renegocjacji aneksów cenowych.",
        quote: {
          source: "Opinia współpracownika (fikcyjna)",
          text: "W 2023 roku prowadziła renegocjacje aneksów cenowych z trzema sieciami.",
        },
      },
    },
    gaps: ["Brak danych o pozyskiwaniu nowych klientów."],
    questions: [
      "Czy pozyskiwałaś współpracę z nową siecią lub nową firmą? Materiały opisują rozwój zamówień u obecnych odbiorców.",
      "Które warunki aneksu ustalałaś sama, a które wymagały zgody przełożonego?",
      "Co wpisywałaś w Salesforce samodzielnie, a co dostawałaś z innego źródła?",
    ],
  },
  {
    name: "Marta Zielińska",
    profile:
      "Fikcyjne CV opisuje sześć lat sprzedaży licencji dla firm produkcyjnych w SoftwareHurt sp. z o.o. List polecający podaje liczbę nowych umów z 2024 roku. CV wspomina codzienną pracę w CRM, bez nazwy systemu. Negocjacje warunków umowy nie są opisane.",
    findings: {
      b2b: {
        label: "Informacja w materiale",
        summary: "CV opisuje sprzedaż licencji dla firm produkcyjnych w latach 2019–2025.",
        quote: {
          source: "CV (fikcyjne)",
          text: "2019–2025, specjalistka ds. sprzedaży, SoftwareHurt sp. z o.o. — sprzedaż licencji dla firm produkcyjnych.",
        },
      },
      acquisition: {
        label: "Informacja w materiale",
        summary: "Fikcyjny list podaje liczbę nowych umów doprowadzonych samodzielnie w 2024 roku.",
        quote: {
          source: "List polecający (fikcyjny)",
          text: "W 2024 roku samodzielnie doprowadziła do 14 nowych umów z firmami, z którymi wcześniej nie było współpracy.",
        },
      },
      crm: {
        label: "Informacja w materiale",
        summary: "CV opisuje rejestrację szans sprzedaży w CRM. Nazwa systemu nie została podana.",
        quote: {
          source: "CV (fikcyjne)",
          text: "Codzienna rejestracja szans sprzedaży i etapów w CRM firmy.",
        },
      },
      negotiation: {
        label: "Brak danych",
        summary: "W CV i w liście polecającym nie ma informacji o prowadzeniu negocjacji.",
        quote: null,
      },
    },
    gaps: [
      "Brak danych o prowadzeniu negocjacji.",
      "Nie podano nazwy systemu CRM.",
    ],
    questions: [
      "Opisz negocjację warunków umowy, którą prowadziłaś samodzielnie. Jeśli warunków nie ustalałaś, powiedz, kto to robił.",
      "Z jakiego CRM korzystałaś i które informacje wpisywałaś sama?",
    ],
  },
];
