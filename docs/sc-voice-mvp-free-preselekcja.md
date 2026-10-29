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
- `lib/voice/retell-outbound-draft.ts` ma dwie **wyłącznie przygotowawcze** operacje: odczyt i walidację dokładnej, wcześniej zatwierdzonej konfiguracji agenta/flow Retell przez **jawnie przekazany transport** (w tych testach tylko fikcyjny HTTP), oraz deterministyczną kompilację szkicu żądania Create Phone Call bez wykonywania POST. Brak domyślnego `fetch`, poświadczeń i wywołań rzeczywistego Retell w tym etapie. Konfiguracja zatwierdzonej wersji agenta, powiązane SHA-256 flow i kompletnej odpowiedzi agenta, polski notice i budżet pochodzą wyłącznie z serwera; szkic przypina zweryfikowaną numeryczną wersję, wymagane `honor_internal_dnc: true` i identyfikator idempotencji UUID v4 dostarczony przez zaufanego workera. Wymagane jest autentyczne wydanie planu SC-012, dokładny identyfikator aplikacji, ten sam scenariusz z jej in-process binding oraz osobna zgodność numeru docelowego ze snapshotem kontaktu z zaufanego, tenant-scoped odczytu SC-010. Snapshot **sam nie stanowi dowodu autoryzacji DB**; przed realnym wywołaniem worker musi ponownie sprawdzić źródło, kontakt, zgodę, notice, limit i zarezerwować operację transakcyjnie. W payloadzie są tylko technicznie niezbędne pola dla przyszłego połączenia, w tym numer odbiorcy; nie ma CV, nazwiska, ID firmy ani aplikacji. Dokumentacja API: https://docs.retellai.com/api-references/create-phone-call.
- FREE z `limit.total` innym niż 1 jest konfiguracją niepoprawną (`invalid_snapshot`), nie dodatkowym limitem.
- `tests/retell-outbound-draft.test.mjs` sprawdza zsyntetyzowane odpowiedzi Retell (bez sieci), przypięte SHA/wersję, brak wysyłania POST, limit rozmowy zgodny z zatwierdzonym scenariuszem (420–600 s), zgodność aplikacji/scenariusza/docelowego numeru, UUID v4, ochronę danych i granice rozmiaru odpowiedzi. Test negatywny wykrywa brak transportu zamiast próbować użyć `fetch`.
- CI typecheck, istniejące testy voice i build. Bez API/kluczy/wywołań Retell/VoIPstudio/GoTrunk.

## Wymagane przed prawdziwym połączeniem — kolejny etap, nie aktywować teraz
1. Niezależny review i testy wszystkich otwartych zależności SC-010/011/012/013 oraz SC-019, migracje w izolowanym Postgres 16, kontrola tenant/RLS.
2. Przeprowadzić autoryzowany profil firmy i stanowiska, screening CV, świadomą i aktualną zgodę na kontakt oraz informację o przetwarzaniu danych; numer telefonu z zaufanej bazy, nie z formularza.
3. Podpisane zdarzenia Retell: walidacja surowego webhooka, ochrona replay, poprawne mapowanie zweryfikowanego numeru/Caller ID z GoTrunk oraz korelacja z zatwierdzoną aplikacją; nie ujawniać tokenów ani numerów w logach.
4. Atomowa rezerwacja jednej jednostki rozmowy w SC-019 po sprawdzeniu limitu i kwoty budżetu; idempotency, timeout UNKNOWN -> reconciliation, aktualność źródła i cofnięcia zgód sprawdzane bezpośrednio przed dispatch.
5. Preview-only test z fikcyjną rekrutacją i kontrolowanym testowym numerem po osobnej zgodzie właściciela na koszt oraz potencjalne połączenie; następnie osobno Production.
6. Zatwierdzenie finalnych parametrów FREE i PRESELEKCJA (pule rozmów, cena) — nie wpisywać ich sztywno w frontend.

## Zbiorczy raport i dalsza integracja
Nie wymagać od właściciela osobnej akceptacji każdej funkcji. Zbiorczy raport końcowy zawiera stan SC-010–013 + Voice MVP, dokładne PR/SHA, zielone CI, niezależny PASS, syntetyczny E2E i braki do podłączenia Retell/VoIPstudio/GoTrunk. Zgodnie z aktualnym `AGENTS.md` scalenie do `integration` następuje po CI i niezależnym review bieżącego commitu oraz przejściu bramek bezpieczeństwa i gałęzi, bez rutynowego checkpointu OWNER ACCEPTANCE. Osobny checkpoint PRODUCTION oraz zgoda na koszty/połączenia pozostają obowiązkowe. Nie uruchamiać automatycznych połączeń i nie używać rzeczywistych danych kandydatów.

## Testy
`node --test tests/voice-mvp-package-gate.test.mjs tests/retell-outbound-draft.test.mjs tests/voice-provider.test.mjs tests/voice-interview-plan.test.mjs`.

## PR #121 — izolacja zmiennych znacznika Retell (2026-10-17)

Uwaga [P1 / 4296772812](https://github.com/krzysztofsyska/skillcheck-core/pull/121#discussion_r4296772812)
dotyczy różnicy między odczytem po dokładnym znaczniku a wywołaniem po numerze wersji.
Numer wersji przypina opublikowaną konfigurację, ale Retell nadal wybiera zmienne
aktualnie preferowanego znacznika. Kolejny GET ani sprawdzenie pustych zmiennych
nie zabezpiecza przed zmianą znacznika pomiędzy sprawdzeniem a użyciem.

Weryfikator przed wydaniem niekopiowalnego dowodu sprawdza wszystkie wartości tekstowe
i klucze kompletnej odpowiedzi agenta oraz flow. Dopuszcza wyłącznie odwołania do
`skillcheck_interview_script`, `skillcheck_notice_version` i `skillcheck_language`
(od SC-011-D także `skillcheck_company_name` i `skillcheck_position_title`, zob.
[sc-011d-retell-interview-config.md](sc-011d-retell-interview-config.md)).
Każdą z tych wartości kompilator zawsze przekazuje jawnie w żądaniu. Według
[kontraktu Retell](https://docs.retellai.com/build/dynamic-variables) wartości żądania
mają pierwszeństwo przed wartościami środowiska i domyślnymi. Numer wersji oraz oba
zatwierdzone skróty SHA-256 nadal muszą się zgadzać. Nieznane, zagnieżdżone lub
niekompletne wyrażenia szablonu są odrzucane; wartości wygenerowane przez kompilator
muszą być literalne. Nawiasy klamrowe poza trzema obsługiwanymi wyrażeniami nie są
częścią tego profilu.

Profil offline obsługuje osadzone węzły `conversation` i `end`, bez narzędzi,
kodów wykonywalnych, MCP, komponentów/subflow, zewnętrznych baz wiedzy i odczytu
pamięci kontaktu. Puste lub nieobecne kolekcje są dozwolone. Te ograniczenia zamykają
odczyty całej mapy zmiennych bez składni `{{...}}`, np. przez kod `dv.*` albo narzędzie
otrzymujące cały obiekt rozmowy. Dodanie takich funkcji wymaga osobnej weryfikacji
ich wejść; sam zatwierdzony hash nie wystarcza. Dotychczasowy kontrolowany scenariusz
wywiadu pozostaje obsługiwany; API kompilatora i format szkicu nie zmieniają się.

Regresje obejmują różne zestawy zmiennych, inny preferowany znacznik, zmianę preferencji
po weryfikacji i utworzeniu szkicu, niedozwolone zmienne w polach i kluczach, składnię
zagnieżdżoną, nieprzejrzyste odbiorniki zmiennych oraz próbę użycia obcej konfiguracji
lub skopiowanego dowodu. Model pierwszeństwa jest syntetyczny: nie wykonuje POST ani
testu zgodności z żywą usługą. Retell może nadal przechowywać dodatkowe zmienne znacznika;
gwarancja dotyczy ich niewykorzystania przez dopuszczoną konfigurację agenta/flow,
nie usunięcia ich z wewnętrznego stanu dostawcy ani ustawień całego konta.

### Ponowna ocena wcześniejszych uwag

Punktem odniesienia jest `b4c8835392e1470fe5d107807c2f1aa02af41ab2`.
Nie utożsamiać oznaczenia GitHub `outdated` z rozwiązaniem problemu.

| Uwagi review (identyfikatory dyskusji) | Stan wynikający z aktualnego kodu |
| --- | --- |
| 4255619360, 4255619370 | Naprawione wcześniej: autentyczny plan SC-012, powiązanie scenariusza i dokładna zgodność pytań; testy odrzucają PII i podrobione plany. |
| 4255619384 | Naprawione wcześniej: każdy szkic ustawia `honor_internal_dnc: true`. |
| 4255619391, 4270437552, 4274194114 | UUID v4 jest walidowany i zachowany przy ponownej kompilacji. Generowanie i trwałe zapisanie klucza jednej operacji pozostaje obowiązkiem przyszłego workera. |
| 4255619402 | Walidacja przyjmuje również udokumentowany nieprefiksowany identyfikator o długości 32 znaków. |
| 4255619411, 4255619420, 4270437559, 4270437568 | Weryfikator wymaga `basic_attributes_only`, retencji 1–30 dni oraz limitu zgodnego z planem i budżetem 420–600 s. Nie przywracać wcześniejszych override, których zastąpienie było celowe. |
| 4255619435, 4255619452 | Limit FREE równy 1 i ścieżki zależności workflow są już poprawione. |
| 4255619446, 4270437543 | Oba hashe, identyfikator i wersja są sprawdzane przez niekopiowalny dowód; zaufane pochodzenie konfiguracji jest kontraktem serwerowym. |
| 4270437576, 4274194107, 4283734518 | Porównanie firmy, aplikacji, fingerprintu i docelowego numeru jest już zaimplementowane i przetestowane. Snapshot kontaktu nadal nie jest uwierzytelnioną zdolnością DB; jego źródło wymaga przyszłego SC-010. |
| 4283734498, 4283734531 | Kanoniczna lista tematów i numeryczna wersja są już używane. Pozostałą lukę zmiennych znacznika obejmuje obecna poprawka. |
| 4294799177, 4294799184 | Transport jest obowiązkowo wstrzykiwany, a testy używają aktualnego API; brak domyślnego live fetch. |
| **4266690401 — P1** | Poprawione 2026-10-17: przypięty agent musi mieć literalne `enable_dnc_detection: true`; brak pola, `false`, wartości zastępcze i ustawienie w innym miejscu są odrzucane przed wydaniem dowodu. Szkic zachowuje również `honor_internal_dnc: true`. |
| **4266690408 — P1** | Poprawione 2026-10-17: globalny prompt musi zawierać pełną instrukcję zakazu pytań i dopytań, wyprowadzoną z kanonicznej listy SC-012. Dotychczasowy zakaz pytań o dane medyczne i szczególne pozostaje wymagany. |

### DNC i pełna polityka SC-012 (2026-10-17)

`verifyRetellOutboundAgent` wymaga `enable_dnc_detection === true` w kompletnej,
niezależnie przypiętej odpowiedzi agenta. Według [kontraktu Retell](https://docs.retellai.com/api-references/get-agent)
ta opcja włącza rozpoznanie prośby o zaprzestanie kontaktu, potwierdzenie oraz
zakończenie rozmowy i oznaczenie numeru jako DNC po potwierdzeniu. Samo
`honor_internal_dnc` dotyczy respektowania już istniejącej blokady. Oba ustawienia
są wymagane; szkic nie dodaje osobnych override agenta.

W `flow.global_prompt`, obok dotychczasowego zdania o zdrowiu/danych szczególnych,
musi znaleźć się dosłowna instrukcja `SC012_PROHIBITED_TOPICS_INSTRUCTION`:

```text
Nie zadawaj pytań ani dopytań dotyczących następujących tematów: stan zdrowia; religia; poglądy polityczne; życie prywatne.
```

Instrukcja powstaje z tej samej zamkniętej listy, którą otrzymuje scenariusz SC-012.
Brak dowolnego tematu, sama lista nazw, odwrócenie zakazu lub umieszczenie polityki
wyłącznie w węźle, metadanych albo zmiennej domyślnej nie wystarczają. Regresje
ponownie obliczają oba zatwierdzone hashe dla niepoprawnych konfiguracji, więc
sprawdzają obowiązkowe warunki, a nie tylko wykrywanie zmiany skrótu.

Wcześniejszy agent bez DNC i flow z samym zakazem pytań o zdrowie muszą przejść
ponowny przegląd konfiguracji i otrzymać nowe zatwierdzone hashe. Testy są
syntetyczne: potwierdzają obecność wymaganej konfiguracji oraz odmowę jej braku,
bez oceny skuteczności detektora DNC lub odpowiedzi modelu w rzeczywistej rozmowie.
Scalenie z aktualnym `integration` zachowuje wszystkie poprzednie testy i poprawki
wersjonowania, izolacji zmiennych, kontaktu i obowiązkowego transportu offline.
