# SC-010-C — trwałe przygotowanie rozmowy offline

Data: 2026-10-17.

## TASK

SC-010-C: zapisać jedną logiczną operację przygotowania rozmowy `voice_interview`
w izolowanej bazie PostgreSQL, atomowo z rezerwacją osobnej jednostki rozmowy,
po ponownym odczycie wszystkich wymaganych uprawnień i aktualnego źródła.

| Pole kontraktu | Wartość |
| --- | --- |
| LEVEL | L3: prywatny SQL, RLS, granice zaufania, zgody i uprawnienia do puli rozmów. |
| SCOPE | BACKEND; wyłącznie przygotowanie offline i syntetyczne testy. |
| OWNER | SkillCheck. |
| BUILDER | Bieżąca gałąź zadania; implementacja pod nadzorem orchestratora. |
| REVIEWER | Niezależny reviewer bieżącego commitu; wiążący werdykt i SHA są zapisane w PR. |
| DEPENDS ON | Zaakceptowany łańcuch SC-006/008/010, istniejący provider/draft SC-011, kanoniczny plan SC-012 oraz izolowane rozszerzenia zgody, current-release i voice entitlement opisane niżej. |
| PRODUCTION APPROVAL | NO. |
| PROVIDER SEND / LIVE PAYMENT | NO. |

## STATUS

IMPLEMENTED_OFFLINE. Przyjęcie do `integration` wymaga niezależnego PASS i pełnego
CI dla aktualnego commitu; dowody i stan scalenia są zapisane w PR. Ten dokument
opisuje zachowanie oraz granice przygotowania offline, bez deklaracji wdrożenia
lub dostępności rozmów dla klienta.

## BRANCH

`feat/sc-010c-trusted-voice-reservation-20261017`, od `integration`.
Baza rozpoczęcia prac: `dc4d20240568669a514480e387687c49194d5267`.

## COMMIT

Pełny identyfikator wspólnego commitu, jego tree SHA, wyniki CI i niezależnego
review są częścią kontraktu PR dla powyższej gałęzi. Nie wpisujemy tu własnego
SHA dokumentu: każda taka zmiana tworzyłaby nowy commit. Wynik wcześniejszego
commitu nie stanowi automatycznie oceny bieżącej wersji.

## Zakres i zachowanie

`prepareOfflineVoiceDraft` w `lib/voice/offline-preparation.ts` wymaga dedykowanego,
bezczynnego połączenia SQL oraz uwierzytelnionego kontekstu serwera. Połączenie,
kontekst firmy, klucze i konfiguracja Retell nie mogą pochodzić z przeglądarki.
Żądanie wybiera identyfikatory istniejących artefaktów i oczekiwaną wersję wskaźnika;
nie przekazuje numeru telefonu, statusu zgody, ceny ani przyznanej puli.

Jedna transakcja `READ COMMITTED` wykonuje następujące czynności:

1. Sprawdza aktora, firmę i blokadę SC-010 kandydata; odczytuje aktualny zatwierdzony
   draft komunikacji, kontakt, receipt, rewizje zgód, politykę, wystawcę i okno kontaktu.
2. Wymaga osobnego podpisanego dowodu otrzymania konkretnego notice i świadomego
   pozwolenia na `voice_interview`, z `recording_allowed=false`. Istniejący dowód
   `verification_invitation` potwierdza powiązany kontakt i sam nie rozszerza celu
   na wielominutowy wywiad.
3. Odtwarza aktualne źródło SC-012 pod blokadami i porównuje plan, release oraz
   `pointer_version`. Weryfikuje aktualny human-reviewed screening, shortlistę,
   profil stanowiska, wersję szablonu i fingerprinty. Z tych danych odbudowuje
   autentyczny plan i istniejące powiązanie scenariusza z aplikacją.
4. Blokuje dokładny `(company_id, entitlement_id)` w
   `private.sc19_voice_entitlements`. Weryfikuje aktywację, okres ważności,
   brak cofnięcia, aktualną weryfikację firmy i odpowiednie zatwierdzenie pakietu.
   Wolną pulę sprawdza tylko dla nowej operacji; replay własnej rezerwacji nie
   potrzebuje drugiej wolnej jednostki.
5. Wiąże żądanie, approval, aplikację, release, źródło, entitlement i zatwierdzoną
   konfigurację z niezmiennym hashem operacji. Kompiluje istniejący szkic Retell,
   po czym ponownie sprawdza warunki zależne od czasu przy nadal utrzymanych blokadach.
6. Zapisuje operację, kopertę UUID, klucz ponowienia i `reserved + 1` w jednym
   COMMIT. Odroczony constraint bazy wykonuje wewnątrz COMMIT ponowne sprawdzenie
   kontaktu, zgody, okna, trzech terminów retencji plan/review/release, bieżącego
   wskaźnika i uprawnienia firmy. Błąd cofa również rezerwację i klucz żądania.
   Utrata potwierdzenia COMMIT nie dowodzi rollbacku; odtworzenie korzysta
   z pierwotnego żądania i zapisanej operacji.

Dozwolone stany to wyłącznie `prepared_offline` i terminalny `cancelled_offline`.
`cancelOfflineVoicePreparation` atomowo anuluje przygotowanie i zwalnia jedną
rezerwację. Ponowne anulowanie nie zwalnia jej drugi raz. Nie ma stanu dispatch,
wywołania POST, endpointu uruchamiającego rozmowę ani przejść wyniku dostawcy.

### Stałość UUID i ponowienia

Operacja ma własny `operationId`. Jej losowy UUID v4 dla kompilatora jest tworzony
przy pierwszym przygotowaniu i trwale zapisywany jako koperta AES-256-GCM oraz
digest. AAD wiąże kopertę z domeną offline, firmą, operacją, approval i hashem wejścia.
KEK pozostaje poza bazą i jest oddzielony od kluczy przechowywania kontaktu.

`UNIQUE(company_id, approval_id)` blokuje utworzenie drugiej operacji z tego samego
approval, także przy innym `request_key`. Te same wejścia odtwarzają operację i ten
sam UUID; zmiana niezmiennego powiązania kończy się konfliktem. Klucz żądania jest
dodatkowo związany z firmą i uwierzytelnionym aktorem. Częściowy unique komunikacji
blokuje równoległe utrzymanie drugiej operacji dla tego samego draftu.

Każde odtworzenie, także z już znanym kluczem żądania, wykonuje wewnętrzny UPDATE
bez zmiany żadnego pola operacji. Dzięki temu kolejkuje ten sam odroczony
constraint, a wygaśnięcie zgody lub planu po ostatnim odczycie uniemożliwia zwrot
nowego szkicu. Ponowienie nie zwiększa licznika ani nie zmienia dat i historii.

Samodzielne funkcje SC-012 oraz przygotowanie i anulowanie odrzucają połączenie
z otwartą transakcją, zanim przejmą kontrolę nad COMMIT/ROLLBACK. Jawne warianty
`WithinTransaction` pozostają przeznaczone do składania operacji w jednej
transakcji. Blokada singletona restore jest utrzymywana przez przygotowanie,
anulowanie, odtwarzanie źródła, review/release oraz zapis i cofnięcie pozwolenia.

Nowe odtworzenie źródła, review i release wymagają aktywnej aplikacji ze statusem
`new` albo `in_progress`. Weryfikator odrzuca plan po terminie retencji pod blokadą
wiersza. Oba prywatne RPC powtarzają kontrolę statusu i ważności według zegara bazy
przy nowym zapisie oraz w odroczonej kontroli wewnątrz COMMIT; release wymaga
również nadal ważnego, dokładnego zatwierdzenia planu. Wygaśnięcie między
weryfikacją JavaScript a RPC lub po udanym RPC przed COMMIT cofa nową historię,
klucz żądania i zmianę wskaźnika release.

Dokładne, autoryzowane ponowienie wcześniejszego review lub release może zwrócić
historyczny identyfikator wyniku. Nie dopisuje zatwierdzenia, nie publikuje ponownie
wskaźnika i nie przyznaje aktualnego uprawnienia do przygotowania rozmowy.

**Ten zaszyfrowany UUID jest identyfikatorem diagnostycznego szkicu offline.**
Nie stanowi klucza autoryzującego live dispatch z architektury PR #87.
Nie powstają live lease, account binding, `dispatch_not_after` ani finalny fence
przed adapterem. Wynik ma `preflightOnly: true`; jego trwałość nie uprawnia do POST.

### Zaufana zgoda i osobna pula rozmów

`lib/voice/interview-permission.ts` sprawdza ścisły kontrakt, kolejność zdarzeń,
powiązany kontekst, domenę podpisu i Ed25519 przed prywatnym ingesterem SQL.
Baza ponownie sprawdza aktualne rewizje, ważność, replay, registry wystawcy,
politykę oraz blokady kandydata. Fixture korzysta z efemerycznego syntetycznego
wystawcy; nie jest uruchomionym kanałem zbierania zgód od kandydatów.

`private.sc19_voice_entitlements` rozlicza jednostkę `voice_interview`.
FREE dopuszcza najwyżej jeden historyczny grant na firmę z `total=1`.
PRESELEKCJA ma osobne niezmienne przyznania o konfigurowalnej wielkości i globalnie
unikalnym opaque settlement reference. Top-up nie nadpisuje historycznego zużycia
ani utrzymanych rezerwacji. Cofnięcie grantu jest ostateczne; wyłączenie lub
ponowna weryfikacja firmy nie resetują liczników. Nie ma publicznego claim/grant
RPC ani wyliczania uprawnienia z callbacku płatniczego.

Świadomie połączono odtwarzanie zaufanego źródła i atomowe review/release rozwijane
w PR #98/#99 z obecnym kontraktem SC-012. Wspólna wersja wymaga ponownego CI
i niezależnej oceny; samo pochodzenie kodu nie jest PASS. PR #92/#115 nie zostały
cherry-pickowane jako silnik billingowy. Ich kredyty analiz CV nie są pulą rozmów;
nowy moduł nie instaluje triggerów ani rejestru debit/refund screeningu.

## CHANGED FILES

| Obszar | Pliki |
| --- | --- |
| Przygotowanie i anulowanie | `lib/voice/offline-preparation.ts`, `db/isolated/sc010c-voice-preparation.sql`, `tests/voice-preparation.test.mjs`, `tests/helpers/voice-preparation-fixture.mjs`, `tests/helpers/voice-preparation-provider-fixture.mjs`, `tests/helpers/voice-preparation-restart.mjs`. |
| Notice i pozwolenie na wywiad | `lib/voice/interview-permission.ts`, `db/isolated/sc010c-interview-permission.sql`, `tests/voice-interview-permission.test.mjs`, `tests/helpers/voice-interview-permission-fixture.mjs`. |
| Odtwarzanie SC-012 i atomowe operacje | `lib/voice/trusted-source-verifier.ts`, `lib/voice/atomic-plan-operations.ts`, `lib/voice/template-registry.ts`, `lib/voice/plan-persistence-contract.ts`, `db/isolated/sc012b-template-catalog.sql`, `db/isolated/sc012b-review-rpc.sql`, `db/isolated/sc012b-release-rpc.sql`, `tests/voice-trusted-source-verifier.test.mjs`, `tests/voice-plan-atomic-operations.test.mjs`. |
| Osobna pula voice | `db/isolated/sc019-voice-entitlements.sql`, `tests/voice-entitlements-database.test.mjs`. |
| Weryfikacja i handoff | `tests/voice-preparation-privileges.test.mjs`, `.github/workflows/voice-preparation.yml`, `docs/sc010c-offline-preparation-handoff.md`. |

Lista dotyczy wspólnego zadania; ostateczny diff i SHA należy zweryfikować przy PR.

## DB/MIGRATIONS

Nowy SQL znajduje się wyłącznie w `db/isolated/`. Testy instalują istniejący pełny
łańcuch `supabase/migrations/`, istniejący `db/prototypes/sc012b-plan-schema.sql`
i potrzebne moduły izolowane w jednorazowych bazach. Nie dodano ani nie zastosowano
migracji, nie prowadzono provisioning na połączonym Supabase i nie zmieniono sekretów.

R4 erasure inventory pozostaje niezmieniony. Nowe tabele powodują zamierzone
`schema_dependency_unknown` w preview/schedulerze i blokadę ścieżki purge.
Nie aktualizować signature z zastanego katalogu, nie omijać tej blokady i nie
przenosić SQL do migracji bez reviewed inventory, adapterów purge/restore i testów
nowego grafu. Operacje, receipt i powiązania kandydata nie są anonimową księgowością.

## TESTS

| Weryfikacja bieżącego wspólnego commitu | Status |
| --- | --- |
| Pełny zestaw persistent preparation + podpisane pozwolenie + entitlement + SC-012 | Wynik, liczba testów i SHA w kontrakcie PR; wymagany PASS bez pominięć. |
| Rzeczywiste PostgreSQL 16: rollback, replay, unikalność, konflikty i wyścigi | Wymagany nieskipowany przebieg izolowanej bazy, w tym expiry wewnątrz COMMIT. |
| Dotychczasowe domenowe regresje voice, plan, provider events, kontakt i Retell offline | Wspólny przebieg z nowymi testami; wynik w PR. |
| Główne `verify`: typecheck, build i pozostałe wymagane regresje | Obowiązkowy GitHub check dla aktualnego SHA. |
| Dedykowany GitHub job `offline-preparation` dla aktualnego SHA | Obowiązkowy wynik tego zadania, obejmujący także hostile-default ACL. |
| Niezależny reviewer i bramki gałęzi dla tego samego SHA | Wymagany PASS, rzeczywiste checki GitHub Actions i zamknięte wątki review. |

Workflow `.github/workflows/voice-preparation.yml` ma tylko `contents: read`,
checkout bez zachowania poświadczeń, Node 24, `npm ci` i jednorazowy Postgres 16.
Jego `SCREENING_TEST_DATABASE_URL` wskazuje wyłącznie
`postgres://postgres:postgres@127.0.0.1:5432/postgres` w usłudze testowej joba.
Jedna jawna lista plików uruchamia nowe testy i istniejące regresje przez
`node --test --test-isolation=none --test-concurrency=1 --test-reporter=tap`.
Brak wymaganego pliku powoduje błąd, a testy wymagające PG nie są zastępowane
samym PGlite. Sekwencyjne wykonanie chroni wspólny katalog ról klastra przed
wyścigiem instalatorów fixture. Typecheck i build pozostają także w głównym `verify`.

Filtry obejmują wszystkie `lib/**` (w tym voice/contact/behavior), schematy `db/**`,
cały łańcuch migracji, helpery testowe, testy voice/Retell, dependency lockfile,
konfigurację TypeScript oraz sam workflow. Syntetyczne klienty i fixture nie
odczytują kluczy Retell/SIP ani rzeczywistych danych kandydatów.

Kryteria akceptacji wymagają jednego stabilnego UUID i jednej rezerwacji przy
replay, konfliktu przy zmianie powiązania, odmowy obcej firmy/aktora, odmowy
nieaktualnego źródła lub cofniętej zgody, poprawnego rollbacku i jednokrotnego
zwolnienia przez terminalne anulowanie. Dodatkowo wymagane są odmowy dla braku
notice/podpisu, nieaktualnego release, wyczerpania puli i manipulacji kopertą,
przy zerowej liczbie wywołań rzeczywistego dostawcy.

Regresje po niezależnym review odtwarzają również transakcję wywołującego w obu
poziomach izolacji, jej COMMIT/ROLLBACK i stan błędu; celowo odziedziczone granty
EXECUTE/CRUD dla niepowiązanych ról; wygaśnięcie dowodu po ostatnim odczycie lub
wszystkich zapisach; wygaśnięcie retencji podczas nowej próby i dokładnego replay;
oraz oba porządki przełączenia restore względem operacji kandydata.
Regresje SC-012 sprawdzają też odmowę nowego review/release dla zakończonej aplikacji
i wygasłego planu lub zatwierdzenia, w tym bezpośrednie wywołanie RPC oraz upływ
terminu między weryfikacją źródła a zapisem, jak również po udanym RPC przed COMMIT.
Odmowa pozostawia liczbę wpisów, kluczy żądań i wskaźnik release bez zmian.

## SECURITY CHECKS

- Uprawnienia są odtwarzane z bieżących wierszy pod blokadami; JSON klienta nie
  przyznaje statusu verified/released/paid ani dostępu do numeru telefonu.
- Tenant i immutable approval/source/contact/release wiążą się przez composite
  FK, unique, fingerprinty i wersje CAS. Błąd blokady wymaga całej nowej próby
  z oryginalnym kluczem i ponownym odczytem uprawnień.
- Tabele przygotowania, dowodów i entitlement są prywatne/default-deny; nie
  przyznano przeglądarce dostępu do kopert ani ogólnego CRUD puli. Każdy instalator
  usuwa również odziedziczone ACL nowych obiektów dla wszystkich grantees poza
  właścicielem. Jedyny jawny grant pozwala dedykowanemu verifierowi zapisać
  sprawdzony dowód; inne workery nie mogą ominąć weryfikacji Ed25519.
- Numer jest odszyfrowywany w pamięci zaufanego serwera dla szkicu; tabela
  przygotowania nie zapisuje numeru, CV, transkryptu, plaintext UUID ani KEK.
- Nagrywanie pozostaje wyłączone. Przygotowany szkic nie podejmuje decyzji
  o zatrudnieniu i nie ma ścieżki kontaktu z Retell/VoIPstudio/GoTrunk.

Wiążący wynik niezależnej weryfikacji tych niezmienników obejmuje dokładny SHA
i tree SHA wskazane w PR.

## KNOWN ISSUES

Nie wykonano syntetycznego E2E z żywym dostawcą, pomiaru DNC w rozmowie ani
weryfikacji interoperacyjności Retell/SIP. Ten etap nie modeluje dispatch,
nieznanego wyniku wywołania, podpisanych zdarzeń realnego dostawcy ani finalnego
fence. Brak tych elementów jest granicą funkcji offline i blokadą aktywacji.

Testowy SQL instaluje się przez uprzywilejowaną fixture. Istnienie nazw prywatnych
funkcji i roli `voice_permission_verifier` nie oznacza wdrożonego, ograniczonego
połączenia workera ani zweryfikowanego live wystawcy.

## BLOCKERS

Scalenie do `integration` jest uzależnione od pełnego CI, niezależnego PASS i bramek
bezpieczeństwa oraz gałęzi dla tego samego aktualnego commitu. Nie ma rutynowego checkpointu
OWNER ACCEPTANCE; orchestrator realizuje integrację według aktualnego `AGENTS.md`.

Przed aktywacją potrzebne są osobno: reviewed SC-010 inventory i adaptery
purge/restore nowych danych, finalny fence i protokół live dispatch/reconciliation,
provider-account/key lifecycle, ograniczony provisioning ról Supabase,
zweryfikowany wystawca notice i zgód, zatwierdzone provisioning uprawnień firmy
i settlementów, a także kontrolowany test dostawcy i warunki operacyjne SIP.
Żaden z tych braków nie jest zastępowany przez pozytywny wynik preflight.

## NEXT ACTION

Zamknąć wspólny zestaw testów i typecheck/build, uzupełnić SHA oraz wyniki w PR,
uzyskać niezależny review i zweryfikować bramki. Po PASS orchestrator scala do
`integration` zgodnie z istniejącą autoryzacją. Następne prace obejmują zależności
gotowe do wykonania; Production, rzeczywisty kontakt, koszty i płatności wymagają
odrębnych właściwych zgód. Ten PR ich nie uruchamia.
