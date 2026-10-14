# SC-VOICE-MVP — FREE + PRESELEKCJA (odrębny strumień, tylko offline)

Data: 2026-10-13. Cel: jeden wspólny voicebot SkillCheck dostępny dla obu planów po spełnieniu warunków uprawnień. Nie oznacza produkcyjnego aktywowania rozmów ani zmiany zatwierdzonych cen.

## Decyzja produktowa
- **FREE**: maksymalnie jeden próbny wywiad *tylko jeśli operator zatwierdzi firmę* i backend przyzna limit; liczba jest przykładową konfiguracją testową, nie gwarancją aktywnego świadczenia.
- **PRESELEKCJA**: wywiady głosowe w pakiecie po potwierdzeniu zapłaty, z konfigurowalną osobną pulą rozmów (liczba i cena wymagają późniejszej decyzji biznesowej).
- Jeden silnik Retell dla wszystkich firm. SC-012 buduje scenariusz stanowiska; SC-011 dostarcza transport; SC-013 analizuje odpowiedzi i pokazuje dowody rekruterowi. Nie dokonujemy automatycznej decyzji o zatrudnieniu.
- **VoIPstudio / GoTrunk**: wybrany operator telefonii i SIP na indywidualnie uzgodnionych warunkach. Retell AI pozostaje silnikiem rozmów. Interoperacyjność Retell ↔ GoTrunk, konto, numer +48/caller ID i routing wymagają potwierdzenia przed pierwszym testem. Dokumentacja operatora: https://gotrunk.com/docs/sipendpoints/ . Zadarma została zastąpiona decyzją z 2026-10-14.
- Cel rozmowy: ok. 7 min (420 s), maksimum techniczne 10 min (600 s). Retell nalicza użycie według własnego cennika; wybór VoIPstudio/GoTrunk nie oznacza darmowych rozmów; obowiązują indywidualne warunki, których nie zastępuje publiczny cennik.

## Parametry operatora SIP — aktualizacja 2026-10-14
- Równoległe rozmowy: konfigurowalny limit i kolejka, bez sztywnego limitu 15. Poprzednie 15 to tylko orientacyjnie deklarowana dostępna przepustowość, nie potwierdzenie techniczne; weryfikacja konta, limitów, budżetu i przeciążenia wymagana przed aktywacją.
- Nie wpisywać na sztywno adresu SIP, poświadczeń ani konfiguracji specyficznej dla Zadarmy. Szczegóły integracji Retell↔GoTrunk wymagają testu kompatybilności.
- Nie uruchamiać płatnych połączeń ani Production bez osobnych bramek i zgód.

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
- `voiceScenarioFromApprovedPlan`: bezpieczna, deterministyczna projekcja planu zwróconego przez `releaseInterviewPlan` w tym procesie. Odtworzony lub ręcznie złożony obiekt ze `status: "released"` jest odrzucany, a treść pytań musi zgadzać się z kanonicznymi szablonami SC-012. Identyfikator firmy i aplikacji zostaje tylko w powiązaniu po stronie serwera i nie wchodzi do scenariusza ani do Retell.
- `tests/voice-mvp-package-gate.test.mjs`: testy obu planów, zgód, limitów, odmowy nieznanych pól/PII oraz fikcyjnej rozmowy w FakeVoiceProvider. Wszystko offline.
- `lib/voice/retell-outbound-draft.ts` przygotowuje **tylko obiekt żądania** wg Retell Create Phone Call. Agent, wersja, lista tematów zakazanych, `max_call_duration_ms: 600000` i `data_storage_retention_days: 30` pochodzą z zamkniętej konfiguracji w kodzie, nie z argumentu wywołującego. `idempotency_key` jest losowym UUID. `honor_internal_dnc: true`, `enable_dnc_detection: true` i `data_storage_setting: basic_attributes_only` są stałe. Szkic wymaga dokładnego obiektu scenariusza tej samej firmy i aplikacji; te identyfikatory nie trafiają do DTO. Nie wykonuje POST, nie ma klucza i nie uruchamia kosztów. Dokumentacja API: https://docs.retellai.com/api-references/create-phone-call.
- FREE z `limit.total` innym niż 1 jest konfiguracją niepoprawną (`invalid_snapshot`), nie dodatkowym limitem.
- `tests/retell-outbound-draft.test.mjs` sprawdza zamkniętą konfigurację agenta, losowy klucz zamiast PESEL, retencję 30 dni, odrzucenie limitu krótszego niż 600 s, powiązanie z aplikacją oraz brak CV i identyfikatorów w DTO.
- CI typecheck, istniejące testy voice i build. Bez API/kluczy/wywołań Retell/VoIPstudio/GoTrunk.

## Wymagane przed prawdziwym połączeniem — kolejny etap, nie aktywować teraz
1. Niezależny review i testy wszystkich otwartych zależności SC-010/011/012/013 oraz SC-019, migracje w izolowanym Postgres 16, kontrola tenant/RLS.
2. Przeprowadzić autoryzowany profil firmy i stanowiska, screening CV, świadomą i aktualną zgodę na kontakt oraz informację o przetwarzaniu danych; numer telefonu z zaufanej bazy, nie z formularza.
3. Podpisane zdarzenia Retell: walidacja surowego webhooka, ochrona replay, poprawne mapowanie zweryfikowanego numeru/Caller ID z GoTrunk oraz korelacja z zatwierdzoną aplikacją; nie ujawniać tokenów ani numerów w logach.
4. Atomowa rezerwacja jednej jednostki rozmowy w SC-019 po sprawdzeniu limitu i kwoty budżetu; idempotency, timeout UNKNOWN -> reconciliation, aktualność źródła i cofnięcia zgód sprawdzane bezpośrednio przed dispatch.
5. Preview-only test z fikcyjną rekrutacją i kontrolowanym testowym numerem po osobnej zgodzie właściciela na koszt oraz potencjalne połączenie; następnie osobno Production.
6. Zatwierdzenie finalnych parametrów FREE i PRESELEKCJA (pule rozmów, cena) — nie wpisywać ich sztywno w frontend.

## Jeden końcowy odbiór
Nie wymagać od właściciela osobnej akceptacji każdej funkcji. Zbiorczy raport końcowy zawiera stan SC-010–013 + Voice MVP, dokładne PR/SHA, zielone CI, niezależny PASS, syntetyczny E2E, braki do podłączenia Retell/VoIPstudio/GoTrunk i jeden checkpoint OWNER ACCEPTANCE. Dopiero po tej decyzji merge. Osobny checkpoint PRODUCTION oraz zgoda na koszty/połączenia pozostają obowiązkowe. Nie uruchamiać automatycznych połączeń i nie używać rzeczywistych danych kandydatów.

## Testy
`node --test tests/voice-mvp-package-gate.test.mjs tests/retell-outbound-draft.test.mjs tests/voice-provider.test.mjs tests/voice-interview-plan.test.mjs`.
