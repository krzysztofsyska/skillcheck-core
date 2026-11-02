export const availabilityNote =
  "Oznaczenia dotyczą funkcji w aplikacji po założeniu konta i utworzeniu firmy. Ta strona publiczna niczego nie uruchamia.";

export const heroTitle = "Masz kandydatów. Sprawdź, komu warto poświęcić czas.";

export const heroLede =
  "SkillCheck porządkuje CV według wymagań stanowiska, pokazuje brakujące informacje i przygotowuje shortlistę do dalszej oceny. Zacznij od bezpłatnej próby albo sprawdź koszt swojej rekrutacji.";

// The four client benefits agreed in the offer audit (2026-10-24): time, quality,
// cost and credibility. They appear on the home page and in the calculator.
export const benefits = [
  {
    title: "Oszczędność czasu",
    claim: "Mniej powtarzalnej pracy przy czytaniu CV.",
    body: "Informacje z CV są zestawione z wymaganiami stanowiska, zamiast czytać każdy dokument od początku i notować osobno. Przygotowanie do rozmowy zaczynasz od gotowego zestawienia.",
  },
  {
    title: "Lepsza jakość oceny",
    claim: "Te same kryteria dla każdej osoby.",
    body: "Kandydaci jednej rekrutacji są czytani według wspólnej listy tematów. Widzisz, czego w materiałach brakuje, i o co dopytać na rozmowie.",
  },
  {
    title: "Kontrola kosztów",
    claim: "Wiesz, ile kosztuje Twój własny proces.",
    body: "W kalkulatorze policzysz koszt ręcznej analizy CV na własnych założeniach i porównasz go z budżetem przykładowej usługi agencji. Płacisz za jeden, z góry znany zakres.",
  },
  {
    title: "Większa wiarygodność",
    claim: "Każda informacja ma źródło w materiale.",
    body: "Przy każdym wniosku widać, z czego wynika, a brak wzmianki jest oznaczony jako brak danych, nie jako wynik zerowy. Decyzję o zatrudnieniu podejmuje człowiek.",
  },
] as const;

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

// WERYFIKACJA and ASSESSMENT CENTER are shown as later stages, without prices
// (owner decision 2026-11-02).
export const nextStages = [
  {
    name: "WERYFIKACJA",
    title: "Pogłębienie sprawdzenia kompetencji",
    body: "Kolejny etap po preselekcji: sprawdzenie kompetencji szerzej niż we wstępnym zestawieniu materiałów, z rozszerzonym raportem kandydata.",
    price: "615 zł brutto",
    scope: "60 CV · testy kompetencji · pula CV zwiększana co 5",
  },
  {
    name: "ASSESSMENT CENTER",
    title: "Szerszy proces oceny kompetencji",
    body: "Kolejny etap po weryfikacji: zadania praktyczne i obserwacje osadzone w realiach stanowiska. W koncie można już ręcznie prowadzić zadania i obserwacje.",
    price: "1 499 zł brutto",
    scope: "50 CV · zadania praktyczne · proces dla 5–6 osób, maksymalnie 10",
  },
] as const;

export const nextStagesNote =
  "WERYFIKACJA i ASSESSMENT CENTER to kolejne etapy oferty. Ceny są zatwierdzone (decyzja właściciela 2026-11-02), ale pakiety są jeszcze w budowie — nie mają terminu uruchomienia i nie można ich dziś kupić. Rozmowy z botem są w przygotowaniu i nie działają w żadnym pakiecie.";

export const assumptions = [
  { label: "Czas analizy jednego CV", value: "6 minut", note: "Wartość przykładowa. W kalkulatorze wpisujesz własną." },
  { label: "Koszt godziny pracy", value: "65 zł netto", note: "Wartość przykładowa. W kalkulatorze wpisujesz własną." },
  { label: "Przykładowa opłata agencji", value: "10 000 zł netto", note: "Publiczny cennik rekrutacji IT, model success fee." },
  { label: "Dodatkowy koszt klienta", value: "1 500 zł netto", note: "Przykład: 1 000 zł pozyskanie CV + 500 zł własna obsługa." },
] as const;

export const sources = [
  {
    label: "Be in IT — cennik rekrutacji IT",
    href: "https://beinit.pl/cennik/",
    note: "10 000 zł netto za jedną rekrutację IT w modelu success fee.",
  },
  {
    label: "HRESTIE — oferta usług",
    href: "https://www.hrestie.com/nasze-uslugi",
    note: "Podstawowa rekrutacja od 15% rocznego wynagrodzenia brutto kandydata.",
  },
] as const;

export const comparisonNote =
  "To porównanie budżetów, nie identycznych usług. Agencja prowadzi pełną rekrutację razem z pozyskaniem kandydatów; SkillCheck obejmuje etap oceny materiałów, które już masz. Różnica kwot nie jest gwarantowaną oszczędnością.";

export const faq = [
  {
    question: "Do czego służy SkillCheck?",
    answer:
      "Do uporządkowania informacji o kandydatach względem wymagań stanowiska, zanim odbędzie się rozmowa. Ma pokazać, co wynika z materiałów i czego w nich nie ma.",
  },
  {
    question: "Ile kosztuje PRESELEKCJA?",
    answer:
      "300 zł brutto za jeden pakiet, ważny 3 miesiące od przyznania. To aktualna cena, nie symulacja. Liczbę analiz CV w pakiecie podajemy przy opisie pakietu powyżej; większa pula CV oznacza kolejne pakiety.",
  },
  {
    question: "Jak zapłacę?",
    answer:
      "Przelewem na podstawie faktury proforma. Po zaksięgowaniu wpłaty uruchamiamy pakiet na koncie firmy i wysyłamy fakturę VAT. Płatność online Przelewy24 jest przygotowywana i udostępnimy ją w koncie firmy, gdy będzie gotowa.",
  },
  {
    question: "Czy muszę zapłacić, żeby wypróbować SkillCheck?",
    answer:
      "Nie. FREE to bezpłatna analiza CV, jedna próba na firmę — liczbę analiz podajemy przy opisie pakietu powyżej. Do rejestracji potrzebny jest numer NIP i firmowy adres e-mail. FREE jest opcjonalnym pierwszym krokiem, nie warunkiem zakupu PRESELEKCJI.",
  },
  {
    question: "Czy SkillCheck znajduje kandydatów?",
    answer:
      "Nie. Pracujesz na własnych CV — z ogłoszeń, poleceń albo bazy firmy. Pozyskanie kandydatów i organizacja dalszych etapów pozostają po Twojej stronie.",
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
    question: "Czy kwoty w kalkulatorze to gwarantowana oszczędność?",
    answer:
      "Nie. Kalkulator pokazuje koszt ręcznej analizy CV przy Twoich założeniach oraz zestawienie budżetów. Ceny FREE i PRESELEKCJI są aktualne; porównanie z agencją jest symulacją.",
  },
  {
    question: "Czym jest przykład na stronie demonstracyjnej?",
    answer:
      "Fikcyjną prezentacją układu informacji dla stanowiska przedstawiciela handlowego. Nie jest wynikiem analizy wykonanej dla osoby, która ogląda stronę.",
  },
] as const;
