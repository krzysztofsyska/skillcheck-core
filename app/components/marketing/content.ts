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
    status: "Dostępne",
    body: "Analiza AI zestawia zatwierdzony, zanonimizowany tekst CV z wymaganiami stanowiska: co jest poparte cytatem z CV, czego brakuje i o co zapytać. Wyniki kandydatów trafiają do rankingu i raportu z eksportem. AI nie podejmuje decyzji o zatrudnieniu.",
  },
  {
    number: "4",
    title: "Przygotowanie do rozmowy i decyzja człowieka",
    status: "Dostępne",
    body: "W koncie jest przewodnik rozmowy, pytania o brakujące informacje oraz ręczne etapy, notatki i decyzja z uzasadnieniem. Kolejny krok wybiera człowiek. Aplikacja nie oznacza kandydatów do zatrudnienia ani do odrzucenia.",
  },
] as const;

export const capabilities = [
  {
    title: "Profil stanowiska",
    body: "Profil opisuje pracę i wymagania, zanim ktokolwiek zacznie porównywać osoby. Dzięki temu rozmowa wraca do ustalonego zakresu, a nie do luźnego wrażenia. Taki profil można już utworzyć w koncie.",
  },
  {
    title: "Te same kryteria dla każdej osoby",
    body: "Porównanie ma sens, gdy każda osoba jest czytana według tej samej listy tematów. Raport preselekcji pokazuje kandydatów jednej rekrutacji obok siebie, według tych samych wymagań.",
  },
  {
    title: "Informacja poparta materiałem i brak danych",
    body: "W przykładzie każda informacja jest powiązana z fikcyjnym źródłem. Brak wzmianki oznaczamy jako brak danych albo temat do wyjaśnienia. W koncie takie zestawienie przygotowuje analiza AI, a każdą informację można sprawdzić w źródle.",
  },
  {
    title: "Pytania, które uzupełniają luki",
    body: "Tam, gdzie materiałów nie wystarcza, kolejnym krokiem jest pytanie na rozmowie. W koncie jest przewodnik rozmowy oparty na wymaganiach stanowiska. Pytania w przykładzie są fikcyjne i nie powstają z analizy plików odwiedzającego.",
  },
] as const;

export const packages = [
  {
    name: "FREE",
    title: "Sprawdź na własnych CV",
    body: "Bezpłatny pakiet na pierwsze analizy CV, jeden na firmę (weryfikacja NIP). Zakładasz konto, opisujesz stanowisko i sprawdzasz wynik na prawdziwej rekrutacji.",
  },
  {
    name: "PRESELEKCJA",
    title: "Preselekcja CV z dowodami",
    body: "Analiza AI CV względem wymagań stanowiska: dowody, braki i pytania na rozmowę, ranking i raport z eksportem. Płatność na podstawie faktury, pakiet aktywujemy po zaksięgowaniu wpłaty.",
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
