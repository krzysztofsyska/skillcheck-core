export const availabilityNote =
  "Oznaczenia dotyczą funkcji w aplikacji po założeniu konta i utworzeniu firmy. Ta strona publiczna niczego nie uruchamia.";

export const steps = [
  {
    number: "1",
    title: "Określenie wymagań stanowiska",
    status: "Dostępne",
    body: "W koncie firmy opisujesz stanowisko: pracę, oczekiwane rezultaty i wymagania. To jest punkt odniesienia dla materiałów o kandydatach.",
  },
  {
    number: "2",
    title: "Dodanie materiałów o kandydacie",
    status: "Dostępne",
    body: "Do rekrutacji dodajesz kandydatów i materiały, w tym CV w formacie TXT, PDF albo DOCX. Tekst, który ma być dalej używany, zatwierdza człowiek.",
  },
  {
    number: "3",
    title: "Zestawienie dowodów i brakujących informacji",
    status: "W przygotowaniu",
    body: "Docelowo materiały mają być zestawione z wymaganiami: co jest poparte źródłem, a gdzie danych brakuje. W koncie można już przygotować materiał do takiego zestawienia. Uruchomienie analizy, która tworzy to zestawienie, nie jest jeszcze dostępne. Układ prezentacji pokazuje przykład.",
  },
  {
    number: "4",
    title: "Przygotowanie do rozmowy i decyzja człowieka",
    status: "Częściowo dostępne",
    body: "W koncie jest przewodnik rozmowy oraz miejsce na ręczne etapy, notatki i obserwacje. Kolejny krok wybiera człowiek. Aplikacja nie oznacza kandydatów do zatrudnienia ani do odrzucenia.",
  },
] as const;

export const capabilities = [
  {
    title: "Profil stanowiska",
    body: "Profil opisuje pracę i wymagania, zanim ktokolwiek zacznie porównywać osoby. Dzięki temu rozmowa wraca do ustalonego zakresu, a nie do luźnego wrażenia. Taki profil można już utworzyć w koncie.",
  },
  {
    title: "Te same kryteria dla każdej osoby",
    body: "Porównanie ma sens, gdy każda osoba jest czytana według tej samej listy tematów. Widok kilku kandydatów obok siebie nie jest jeszcze częścią aplikacji. Taki układ jest pokazany w przykładzie.",
  },
  {
    title: "Informacja poparta materiałem i brak danych",
    body: "W przykładzie każda informacja jest powiązana z fikcyjnym źródłem. Brak wzmianki oznaczamy jako brak danych albo temat do wyjaśnienia. Automatyczne przygotowywanie takiego zestawienia jest w przygotowaniu.",
  },
  {
    title: "Pytania, które uzupełniają luki",
    body: "Tam, gdzie materiałów nie wystarcza, kolejnym krokiem jest pytanie na rozmowie. W koncie jest przewodnik rozmowy oparty na wymaganiach stanowiska. Pytania w przykładzie są fikcyjne i nie powstają z analizy plików odwiedzającego.",
  },
] as const;

export const packages = [
  {
    name: "FREE",
    title: "Planowany wariant próbny",
    body: "Kierunek na ograniczone zapoznanie się z produktem. Zakres, czas i warunki próby nie są ustalone. Sama rejestracja tego wariantu nie włącza.",
  },
  {
    name: "PRESELEKCJA",
    title: "Wstępne uporządkowanie informacji",
    body: "Kierunek oferty: zestawić materiały z wymaganiami stanowiska i pokazać dowody, braki oraz pytania. W koncie można już opisać stanowisko, dodać materiały i przygotować je do zestawienia. Uruchomienie analizy oraz sam pakiet nie są dostępne.",
  },
  {
    name: "WERYFIKACJA",
    title: "Pogłębienie sprawdzenia kompetencji",
    body: "Planowane sprawdzenie kompetencji szerzej niż we wstępnym zestawieniu materiałów. Ten kierunek nie jest dostępny.",
  },
  {
    name: "ASSESSMENT CENTER",
    title: "Szerszy proces oceny kompetencji",
    body: "Planowany szerszy proces oceny. W koncie można już ręcznie prowadzić zadania i obserwacje. Kompletny proces Assessment Center jako oferta nie jest dostępny.",
  },
] as const;

export const faq = [
  {
    question: "Do czego służy SkillCheck?",
    answer:
      "Do uporządkowania informacji o kandydatach względem wymagań stanowiska, zanim odbędzie się rozmowa. Ma pokazać, co wynika z materiałów i czego w nich nie ma.",
  },
  {
    question: "Jaką rolę mają wymagania stanowiska?",
    answer:
      "Są wspólną listą tematów, do których odnosimy informacje o każdej osobie. Bez nich porównanie nie ma jednego punktu odniesienia.",
  },
  {
    question: "Co oznaczają dowody i brakujące informacje?",
    answer:
      "Dowód to informacja, którą da się wskazać w materiale. Brak wzmianki to brak danych albo temat do wyjaśnienia, a nie wynik zerowy.",
  },
  {
    question: "Kto odpowiada za decyzję?",
    answer:
      "Człowiek prowadzący rekrutację. SkillCheck nie podejmuje decyzji o zatrudnieniu ani o odrzuceniu kandydata.",
  },
  {
    question: "Czym jest przykład na stronie demonstracyjnej?",
    answer:
      "Fikcyjną prezentacją układu informacji dla stanowiska przedstawiciela handlowego. Nie jest wynikiem analizy wykonanej dla osoby, która ogląda stronę.",
  },
] as const;
