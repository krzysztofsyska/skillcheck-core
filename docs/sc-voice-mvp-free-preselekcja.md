# SC-VOICE-MVP — FREE + PRESELEKCJA (odrębny strumień, tylko offline)

Data: 2026-10-13. Cel: jeden wspólny voicebot SkillCheck dostępny dla obu planów po spełnieniu warunków uprawnień. Nie oznacza produkcyjnego aktywowania rozmów ani zmiany zatwierdzonych cen.

## Decyzja produktowa
- **FREE**: maksymalnie jeden próbny wywiad *tylko jeśli operator zatwierdzi firmę* i backend przyzna limit; liczba jest przykładową konfiguracją testową, nie gwarancją aktywnego świadczenia.
- **PRESELEKCJA**: wywiady głosowe w pakiecie po potwierdzeniu zapłaty, z konfigurowalną osobną pulą rozmów (liczba i cena wymagają późniejszej decyzji biznesowej).
- Jeden silnik Retell dla wszystkich firm. SC-012 buduje scenariusz stanowiska; SC-011 dostarcza transport; SC-013 analizuje odpowiedzi i pokazuje dowody rekruterowi. Nie dokonujemy automatycznej decyzji o zatrudnieniu.
- **Zadarma**: operator telefonii i numerów przez SIP trunk do Retell, podłączany dopiero przy komputerze. Oficjalna instrukcja: https://zadarma.com/pl/support/instructions/retellai/
- Cel rozmowy: ok. 7 min (420 s), maksimum techniczne 10 min (600 s). Retell nalicza użycie według własnego cennika; napis „Zadarma” to nazwa operatora, nie obietnica darmowych rozmów.

## Istniejący kod — nie powielamy
- `integration/lib/voice/provider.ts`: zatwierdzony format VoiceCallRequest, walidacja, format E.164, idempotency, anulowanie; fake provider do testów.
- `integration/lib/voice/interview-plan.ts`: wersjonowany polski szablon, 4 wspólne + do 2 pytań wyjaśniających, próba 7 minut, limit 10 minut, notice wymagany, bez domyślnego nagrywania; review i release.
- PR #116: serwerowy Retell read-only GET; żadnych połączeń ani kluczy w przeglądarce.
- PR #88: bezpieczny syntetyczny kontrakt zdarzeń i przejść;
- PR #98/#99: odtwarzanie zaufanego źródła i atomowe RPC review/release (izolowane prototypy);
- PR #102: syntetyczna analiza transkrypcji i dowodów SC-013.
- SC-010: przyszła produkcyjna bramka zgód, retencji, kontaktu i odwołania uprawnienia.
- SC-019: produkcyjny rejestr FREE / PRESELEKCJA, rozliczenia i pulę wywiadów należy dopiero powiązać transakcyjnie.

## W tym PR
- `lib/voice/mvp-package-gate.ts`: offline preflight sprawdza aktywację firmy, FREE vs opłaconą PRESELEKCJĘ, aktualny zatwierdzony screening i scenariusz, notice i zgodę kandydata, flagę dostawcy oraz pozostały limit.
- Funkcja wyłącznie zwraca `prepared_for_trusted_dispatch` lub `blocked`. **NIE może wysłać telefonu ani zarezerwować jednostki**; nie tworzy fałszywej autoryzacji.
- `voiceScenarioFromApprovedPlan`: bezpieczna, deterministyczna projekcja **wcześniej autoryzowanego** planu SC-012 do istniejącego kontraktu SC-011 VoiceScenario (bez numeru i treści CV).
- `tests/voice-mvp-package-gate.test.mjs`: testy obu planów, zgód, limitów, odmowy nieznanych pól/PII oraz fikcyjnej rozmowy w FakeVoiceProvider. Wszystko offline.
- CI typecheck, istniejące testy voice i build. Bez API/kluczy/wywołań Retell/Zadarma.

## Wymagane przed prawdziwym połączeniem — kolejny etap, nie aktywować teraz
1. Niezależny review i testy wszystkich otwartych zależności SC-010/011/012/013 oraz SC-019, migracje w izolowanym Postgres 16, kontrola tenant/RLS.
2. Przeprowadzić autoryzowany profil firmy i stanowiska, screening CV, świadomą i aktualną zgodę na kontakt oraz informację o przetwarzaniu danych; numer telefonu z zaufanej bazy, nie z formularza.
3. Podpisane zdarzenia Retell: walidacja surowego webhooka, ochrona replay, poprawne mapowanie numeru z Zadarma oraz korelacja z zatwierdzoną aplikacją; nie ujawniać tokenów ani numerów w logach.
4. Atomowa rezerwacja jednej jednostki rozmowy w SC-019 po sprawdzeniu limitu i kwoty budżetu; idempotency, timeout UNKNOWN -> reconciliation, aktualność źródła i cofnięcia zgód sprawdzane bezpośrednio przed dispatch.
5. Preview-only test z fikcyjną rekrutacją i kontrolowanym testowym numerem po osobnej zgodzie właściciela na koszt oraz potencjalne połączenie; następnie osobno Production.
6. Zatwierdzenie finalnych parametrów FREE i PRESELEKCJA (pule rozmów, cena) — nie wpisywać ich sztywno w frontend.

## Jeden końcowy odbiór
Nie wymagać od właściciela osobnej akceptacji każdej funkcji. Zbiorczy raport końcowy zawiera stan SC-010–013 + Voice MVP, dokładne PR/SHA, zielone CI, niezależny PASS, syntetyczny E2E, braki do podłączenia Retell/Zadarma i jeden checkpoint OWNER ACCEPTANCE. Dopiero po tej decyzji merge. Osobny checkpoint PRODUCTION oraz zgoda na koszty/połączenia pozostają obowiązkowe. Nie uruchamiać automatycznych połączeń i nie używać rzeczywistych danych kandydatów.

## Testy
`node --test tests/voice-mvp-package-gate.test.mjs tests/voice-provider.test.mjs tests/voice-interview-plan.test.mjs`.
