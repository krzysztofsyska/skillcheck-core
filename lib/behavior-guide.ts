export type BehaviorGuideDefinition = Readonly<{
  id: string;
  label: string;
  definition: string;
  questions: readonly string[];
  positiveSignals: readonly string[];
  verificationSignals: readonly string[];
}>;

function defineArea(definition: BehaviorGuideDefinition): BehaviorGuideDefinition {
  return Object.freeze({
    ...definition,
    questions: Object.freeze([...definition.questions]),
    positiveSignals: Object.freeze([...definition.positiveSignals]),
    verificationSignals: Object.freeze([...definition.verificationSignals]),
  });
}

// Materiał do rozmowy prowadzonej przez człowieka. Sygnały wymagają przykładów
// i kontekstu; nie stanowią diagnozy ani automatycznej oceny kandydata.
export const behaviorGuideDefinitions: readonly BehaviorGuideDefinition[] = Object.freeze([
  defineArea({
    id: "responsibility",
    label: "Odpowiedzialność",
    definition: "Branie odpowiedzialności za wynik, własne decyzje i błędy oraz podejmowanie działań naprawczych.",
    questions: [
      "Opowiedz o sytuacji, w której Twój błąd wpłynął na wynik, klienta albo zespół. Co zrobiłeś?",
      "Widzisz, że nie dotrzymasz uzgodnionego terminu. Jakie działania podejmiesz, kogo poinformujesz i jak sprawdzisz efekt?",
    ],
    positiveSignals: [
      "Opisuje własny udział w sytuacji i podjętych decyzjach.",
      "Informuje o problemie, podejmuje działania naprawcze i sprawdza ich rezultat.",
      "Wskazuje konkretny wniosek i zmianę, która pomaga uniknąć podobnego błędu.",
    ],
    verificationSignals: [
      "Przypisuje całą odpowiedzialność innym; dopytaj o zakres własnego wpływu.",
      "Bagatelizuje lub ukrywa błąd; poproś o opis konsekwencji i komunikacji.",
      "Nie wskazuje działania naprawczego; ustal, jakie możliwości miał w tej sytuacji.",
    ],
  }),
  defineArea({
    id: "independence",
    label: "Samodzielność",
    definition: "Działanie bez ciągłego prowadzenia, z uwzględnieniem dostępnych informacji, własnych uprawnień i sytuacji wymagających konsultacji.",
    questions: [
      "Dostajesz ważne zadanie, ale przełożony jest niedostępny. Nie masz pełnej instrukcji. Co robisz?",
      "Opowiedz o decyzji zawodowej, którą podjąłeś samodzielnie. Co sprawdziłeś, co wymagało konsultacji i jaki był rezultat?",
    ],
    positiveSignals: [
      "Zbiera potrzebne informacje i określa priorytety przed działaniem.",
      "Podejmuje decyzje w granicach swoich uprawnień i sprawdza ich konsekwencje.",
      "Wyjaśnia, co i dlaczego wymagało konsultacji lub eskalacji.",
    ],
    verificationSignals: [
      "Czeka na instrukcje mimo dostępnych możliwości działania; dopytaj o ograniczenia.",
      "Unika decyzji; poproś o przykład decyzji mieszczącej się w jego zakresie.",
      "Działa bez sprawdzenia konsekwencji lub uprawnień; dopytaj o sposób oceny ryzyka.",
    ],
  }),
  defineArea({
    id: "initiative",
    label: "Inicjatywa",
    definition: "Zauważanie problemów i możliwości, proponowanie usprawnień oraz doprowadzanie uzgodnionych działań do realizacji.",
    questions: [
      "Opowiedz o sytuacji, kiedy zauważyłeś problem, którego nikt nie kazał Ci rozwiązać. Co zrobiłeś?",
      "Zauważasz powtarzalny problem poza swoim głównym zakresem zadań. Jak sprawdzisz jego znaczenie i z kim uzgodnisz dalsze działania?",
    ],
    positiveSignals: [
      "Sam zauważa problem lub możliwość usprawnienia i przedstawia konkretny przykład.",
      "Proponuje rozwiązanie oraz uzgadnia jego zakres z odpowiednimi osobami.",
      "Opisuje własny udział we wdrożeniu i sprawdzeniu efektu pomysłu.",
    ],
    verificationSignals: [
      "Kończy odpowiedź na stwierdzeniu, że sprawa nie należała do jego zakresu; dopytaj o możliwość zgłoszenia problemu.",
      "Oczekuje wyłącznie działania innych; ustal, co mógł zaproponować sam.",
      "Nie podaje przykładu usprawnienia; zapytaj o okazje do inicjatywy w dotychczasowej pracy.",
    ],
  }),
  defineArea({
    id: "results",
    label: "Orientacja na wynik",
    definition: "Przekładanie celów na działania i mierniki, kontrolowanie postępu oraz zmienianie sposobu pracy, gdy wyniki odbiegają od założeń.",
    questions: [
      "Przez dwa miesiące nie realizujesz celu. Co robisz w pierwszej kolejności?",
      "Opowiedz o zadaniu, w którym musiałeś zmienić sposób pracy, aby osiągnąć wynik. Jak mierzyłeś postęp i jaki był efekt?",
    ],
    positiveSignals: [
      "Wskazuje cel i mierniki pozwalające ocenić jego realizację.",
      "Sprawdza postęp, rozpoznaje przyczyny odchyleń i proponuje poprawę.",
      "Zmienia sposób działania i porównuje uzyskany wynik z celem.",
    ],
    verificationSignals: [
      "Opisuje wyłącznie wykonane czynności; dopytaj o ich rezultat.",
      "Nie zna wyniku swojej pracy; ustal, jakie mierniki lub informacje były dostępne.",
      "Nie reaguje na brak postępu; poproś o opis prób poprawy i napotkanych ograniczeń.",
    ],
  }),
  defineArea({
    id: "cooperation",
    label: "Współpraca z ludźmi",
    definition: "Słuchanie, dzielenie się informacją, uzgadnianie działań i konstruktywne rozwiązywanie różnic zdań we wspólnej pracy.",
    questions: [
      "Opowiedz o sytuacji, kiedy nie zgadzałeś się z członkiem zespołu w ważnej sprawie. Jak to rozwiązaliście?",
      "Twoje zadanie zależy od informacji od innego zespołu, który ma odmienne priorytety. Jak uzgodnisz dalszą współpracę?",
    ],
    positiveSignals: [
      "Przedstawia perspektywę drugiej osoby i sposób jej wysłuchania.",
      "Dzieli się potrzebnymi informacjami i uzgadnia odpowiedzialność za działania.",
      "Rozwiązuje różnice zdań poprzez argumenty i wspólny cel.",
    ],
    verificationSignals: [
      "Obwinia innych bez opisania własnego udziału; dopytaj o przebieg współpracy.",
      "Unika każdej różnicy zdań lub narzuca rozwiązanie bez argumentów; poproś o konkretny przykład rozmowy.",
      "Zatrzymuje informacje potrzebne zespołowi; ustal przyczyny i skutki.",
    ],
  }),
  defineArea({
    id: "change",
    label: "Reakcja na zmianę",
    definition: "Rozumienie nowych warunków pracy, dostosowywanie planu i uczenie się sposobów działania potrzebnych po zmianie.",
    questions: [
      "Opowiedz o sytuacji, kiedy w krótkim czasie zmieniono zasady albo priorytety Twojej pracy. Jak zareagowałeś?",
      "W połowie zadania zmienia się wymagany rezultat. Jak ustalisz, co zachować, czego się nauczyć i jak zmienić plan?",
    ],
    positiveSignals: [
      "Zbiera informacje o przyczynach zmiany i nowych oczekiwaniach.",
      "Dostosowuje plan oraz uczy się potrzebnego sposobu pracy.",
      "Sprawdza skuteczność działania po zmianie i komunikuje napotkane trudności.",
    ],
    verificationSignals: [
      "Odrzuca zmianę bez próby poznania jej przyczyn; dopytaj, jakie informacje otrzymał.",
      "Uzasadnia pozostanie przy starej metodzie wyłącznie przyzwyczajeniem; zapytaj o porównanie rezultatów.",
      "Nie zmienia sposobu pracy mimo nowych wymagań; ustal dostępne wsparcie i ograniczenia.",
    ],
  }),
  defineArea({
    id: "feedback",
    label: "Otwartość na informację zwrotną",
    definition: "Wysłuchiwanie informacji o swojej pracy, sprawdzanie jej zasadności oraz wprowadzanie i ocenianie uzasadnionych zmian.",
    questions: [
      "Opowiedz o sytuacji, kiedy otrzymałeś informację zwrotną, z którą początkowo się nie zgadzałeś. Co zrobiłeś?",
      "Otrzymujesz ogólną uwagę, że sposób wykonania zadania wymaga poprawy. O co dopytasz i jak ustalisz, czy zmiana przyniosła efekt?",
    ],
    positiveSignals: [
      "Wysłuchuje uwagi i prosi o konkretne przykłady oraz oczekiwania.",
      "Sprawdza zasadność informacji zwrotnej na podstawie faktów.",
      "Opisuje uzasadnioną zmianę zachowania i sposób sprawdzenia efektów.",
    ],
    verificationSignals: [
      "Automatycznie odrzuca uwagę bez sprawdzenia jej treści; dopytaj o fakty i kontekst.",
      "Ignoruje uzgodnioną poprawę; poproś o opis dalszych działań i przeszkód.",
      "Odpowiada atakiem osobistym; dopytaj, jak odniósł się do samej informacji o pracy.",
    ],
  }),
  defineArea({
    id: "pressure",
    label: "Działanie pod presją i w trudnych sytuacjach",
    definition: "Ustalanie priorytetów, podejmowanie przemyślanych decyzji i komunikowanie zagrożeń przy spiętrzeniu zadań lub trudnej sytuacji zawodowej.",
    questions: [
      "Masz trzy pilne sprawy jednocześnie i każda osoba twierdzi, że jej temat jest najważniejszy. Jak decydujesz, czym zajmiesz się najpierw?",
      "Opowiedz o sytuacji, gdy liczba pilnych zadań przekroczyła dostępny czas. Jak uzgodniłeś priorytety, wsparcie i terminy?",
    ],
    positiveSignals: [
      "Ustala kolejność według znaczenia, terminów i konsekwencji zadań.",
      "Podejmuje przemyślane decyzje i informuje o zagrożeniach dla realizacji.",
      "Uzgadnia wsparcie lub delegowanie i skupia się na ustalonych priorytetach.",
    ],
    verificationSignals: [
      "Rozpoczyna wszystko jednocześnie bez ustalonej kolejności; dopytaj o kryteria priorytetów.",
      "Podejmuje pochopne działania bez sprawdzenia skutków; poproś o opis procesu decyzyjnego.",
      "Unika zgłoszenia problemu; ustal, kiedy i komu przekazał informację o zagrożeniach.",
    ],
  }),
]);

const supportedLevels = ["Niski", "Standardowy", "Wysoki", "Krytyczny"] as const;

export function buildBehaviorGuide(requiredBehaviors: readonly string[]) {
  const entries = requiredBehaviors.map(raw => {
    const trimmed = raw.trim();
    const separator = trimmed.indexOf(":");
    return {
      raw,
      label: (separator < 0 ? trimmed : trimmed.slice(0, separator)).trim(),
      level: separator < 0 ? null : trimmed.slice(separator + 1).trim(),
    };
  });
  return {
    areas: behaviorGuideDefinitions.map(definition => {
      const matches = entries.filter(entry => entry.label === definition.label);
      let requiredLevel: string | null = null;
      let requirementIssue: string | null = null;
      if (matches.length === 0) {
        requirementIssue = "Brak zapisanego poziomu wymaganego dla tego obszaru. Uzupełnij profil stanowiska.";
      } else if (matches.length > 1) {
        requirementIssue = "Ten obszar zapisano więcej niż raz. Sprawdź powtórzone lub sprzeczne wymagania w profilu stanowiska.";
      } else if (matches[0].level === null || !(supportedLevels as readonly string[]).includes(matches[0].level)) {
        requirementIssue = "Nieprawidłowy zapis poziomu wymaganego. Wybierz w profilu stanowiska: Niski, Standardowy, Wysoki albo Krytyczny.";
      } else {
        requiredLevel = matches[0].level;
      }
      return { ...definition, requiredLevel, requirementIssue };
    }),
    unrecognizedRequirements: entries
      .filter(entry => !behaviorGuideDefinitions.some(definition => definition.label === entry.label))
      .map(entry => entry.raw),
  };
}
