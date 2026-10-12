# SC-010-R4 — harmonogram retencji, monitoring i przygotowanie produkcji

Data: 2026-10-12, UTC.

TASK: SC-010-R4  
LEVEL: L3  
SCOPE: FULLSTACK  
OWNER: orchestrator / właściciel projektu  
REVIEWER: niezależny architect/reviewer  
DEPENDS ON: scalone R1–R3, B1/B2, SC-006/008/009  
BRANCH: feat/sc-010-r4-retention  
STATUS: kontrakt implementacyjny; wyniki i dokładny commit w PR.

## 1. Cel i granica zakresu

R4 realizuje §4c dokumentu `sc-010-retention-erasure-architecture.md`:
harmonogram może proponować retencję albo, po jawnej delegacji właściciela,
autoryzować należne usunięcie. Autoryzacja przechodzi przez istniejący protokół
zamrożenia R2 oraz podpisanej rezerwacji, niezależnego ledger i purge R3.
Samo upłynięcie liczby dni nigdy nie stanowi uprawnienia wykonawcy do DELETE.

W tym etapie automatyczny zakres to **cała potwierdzona osoba**, wszystkie jej
potwierdzone rekordy kandydatów i cały obsługiwany graf. Automatyczny zakres
pojedynczej aplikacji albo wybranych klas wymaga osobnego adaptera i jest
blokowany. Nie wolno rozszerzać wniosku dotyczącego jednej wygasłej aplikacji
na całą osobę. Ręczne przepływy R1–R3 zachowują swój kontrakt.

Implementacja obejmuje rzeczywisty tryb `automatic`, wykonanie jednego
ograniczonego ticka, monitoring, procedurę próby odtworzenia i kontrolę
gotowości środowiska. Brak poświadczeń lub wdrożonego ledger nie uniemożliwia
ukończenia kodu i testów; uniemożliwia aktywację rzeczywistego wykonania.

## 2. Aktywacja i delegacja właściciela

Właściciel firmy aktywuje niezmienną wersję konfiguracji. Konfiguracja zawiera:

| Pole kontraktu | Wymaganie |
| --- | --- |
| Firma i właściciel | Ustalone przez serwer; właściciel aktualny podczas aktywacji |
| Polityka | Dokładny identyfikator, rewizja i hash pełnych ośmiu reguł |
| Tryb | `suggest_only` domyślnie; `automatic` tylko jawnie wybrane |
| Klasy | candidate, assessment, screening, communication, audit, external, backup, exports |
| Semantyka zdarzeń | Wersjonowana definicja kanonicznych zegarów z §3 |
| Współdzielenie | Wszystkie potwierdzone rekordy i wszystkie aplikacje |
| Batch | Dodatnia, ograniczona liczba zakresów, maksymalnie 100 |
| Delegacja | ID, rewizja aktywacji, owner, serwerowy czas aktywacji i stan wycofania |

Zmiana parametrów tworzy nową wersję. Scheduler nie wybiera dowolnej starszej
aktywacji. Nowsza polityka, inny owner, wycofana delegacja lub zmieniona
semantyka wymagają ponownej jawnej aktywacji; nie dziedziczą automatycznej zgody.
Brak aktywacji oznacza brak automatycznej autoryzacji.

Idempotencja poleceń właściciela wiąże firmę, użytkownika, operację, klucz
i kanoniczny payload. Dokładne ponowienie zwraca zapisany wynik. Inny payload
z tym samym kluczem jest konfliktem. Ponowienie nie tworzy nowej delegacji.

## 3. Kanoniczne zdarzenia i obliczenie terminu

Istniejące `created_at`, `updated_at` i `recruitments.closed_at` nie są same
w sobie dowodem upływu czasu dla automatycznego usuwania: część można podać
lub zmienić przez DML. R4 używa prywatnego, serwerowego zapisu obserwacji
zdarzeń, bez uprawnień DML dla aplikacji lub schedulera.

Pierwsza obserwacja istniejącego rekordu zaczyna zegar w chwili obserwacji.
Nie wolno wstecznie uznać starego pola czasu za zatwierdzony zegar. Import
starszej historii jest osobną operacją administracyjną z udokumentowanym
źródłem; nie jest częścią zwykłego ticka.

| Trigger polityki | Kanoniczna interpretacja |
| --- | --- |
| `record_created` | Najpóźniejsze serwerowo zaobserwowane powstanie danych danej klasy w całym zakresie osoby |
| `process_closed` | Serwerowa obserwacja zamknięcia wszystkich odpowiednich procesów przy terminalnych aplikacjach; ponowne otwarcie lub nowa aplikacja unieważnia poprzedni zegar |
| `consent_revoked` | Serwerowy zapis aktualnej odmowy/wycofania dla wszystkich odpowiednich zakresów zgody, związany z bieżącymi rewizjami uprawnień |

Zegar zamknięcia może być projekcją kompletnego stanu osoby zamiast jednego
zdarzenia rekrutacji, jeżeli każda zmiana wpływająca na kwalifikację unieważnia
lub odświeża tę projekcję pod tymi samymi blokadami. Ponowne spełnienie warunku
po otwarciu procesu zaczyna nowy zegar. Nowe dane klasy powstałe po zamknięciu
nie dziedziczą starego terminu: podstawą jest późniejszy czas zamknięcia
i obserwacji tych danych.

Dla każdej klasy obliczany jest najpóźniejszy właściwy czas w całym zakresie.
Do tego czasu dodawane jest zatwierdzone `duration_days`. Termin całej osoby
to maksimum terminów wszystkich ośmiu klas. Klasa pusta ma konserwatywną
podstawę obserwacji zakresu osoby; brak wiersza nie oznacza automatycznie
zerowego okresu. Brak wymaganego zdarzenia lub dowodu kompletności oznacza
blokadę, a nie domyślny czas sprzed epoki.

Purge aktywnych danych nie deklaruje wygaśnięcia kopii zapasowych. Reguły
klas backup/exports i horyzont odzyskiwania R3 mają osobne znaczenie;
gotowość pierwszego nie zastępuje dowodu dla drugiego.

Niezależnie od triggera i wieku danych obowiązują wszystkie warunki:

- Wszystkie aplikacje wszystkich potwierdzonych rekordów są `rejected`
  lub `withdrawn`, a ich rekrutacje są kanonicznie zamknięte.
- `new`, `in_progress`, `hired` lub otwarta/pauzowana rekrutacja oznacza aktywny
  cel i blokuje automatyczny purge całej osoby.
- Brak aplikacji nie tworzy zdarzenia `process_closed`.
- Wycofanie zgody w jednym kanale lub jednej rekrutacji nie reprezentuje
  wszystkich pozostałych celów. Każdy odpowiedni aktualny zakres zgody musi
  mieć dowód odmowy; nieznany lub niepełny zakres blokuje tę ścieżkę.
- Brak hold, aktywnego screeningu, nieznanych adapterów i nieobsługiwanych
  zasobów zewnętrznych. Wygasły termin przeglądu hold nie usuwa hold.
- Aktualne owner-confirmed rozpoznanie osoby obejmuje dokładnie ten zakres.
  Niepotwierdzone duplikaty, nakładające się niezgodne zakresy lub brak
  potwierdzenia kierują sprawę do przeglądu ręcznego.

Dowód kwalifikacji wiąże wersję semantyki, firmę, aktywację, politykę,
posortowane ID, rewizję rozpoznania, kanoniczne zdarzenia, wszystkie
aplikacje, klasy i terminy. Serwer oblicza `evidence_hash` oraz generację
kwalifikacji. Zmiana istotnego źródła unieważnia wcześniejszy dowód.

Pierwsza implementacja może konserwatywnie używać wspólnego zegara zmian
całego grafu kandydata dla wszystkich klas. Każda znana zmiana operacyjna
przesuwa wtedy podstawę czasu wszystkich klas; może wydłużyć oczekiwanie,
ale nie może przyspieszyć usunięcia względem powyższych zasad. Zegar
zamknięcia/odmowy jest resetowany lub odświeżany przy takiej zmianie.
Wspólna odmowa dla trzech obsługiwanych kanałów albo komplet odmów tych
kanałów dla wszystkich rekrutacji musi wynikać z aktualnego stanu, bez
wnioskowania o nieobsługiwanych kanałach. Zapis sugestii, ticka, dowodu,
samego zegara lub freeze przez scheduler nie jest nowym zdarzeniem
operacyjnym i nie resetuje zegara. Inaczej scheduler sam odsuwałby swój
termin, zmieniał generację lub unieważniał autoryzację.

## 4. Scheduler i idempotencja

Osobna rola schedulera jest `NOLOGIN` bez uprawnień do DML, owner RPC,
potwierdzania ledger i purge. Tożsamość runtime otrzymuje jedynie ograniczone
RPC potrzebne do ticka. Scheduler nie ustawia `auth.uid()` właściciela,
nie podszywa się pod niego i nie przekazuje gotowego manifestu jako dowodu.

Serwerowy kontrakt `private.tick_retention_schedule(batch_limit)` obsługuje
globalną usługę harmonogramu. Serwer wybiera aktywne firmy i ich konkretne
wersje delegacji, osobno dla każdej firmy egzekwując jej limit. Wywołanie
ma limit pracy nad osobami oraz niezależne ograniczenie liczby przeglądanych
firm, również tych bez kwalifikujących się rekordów. Deterministyczny wybór
na podstawie czasu ostatniego sprawdzenia zapewnia, że stale zablokowane
osoby nie zatrzymują obsługi pozostałych. Granica firmy obowiązuje przy
każdym obliczeniu i zapisie. Scheduler nie przekazuje dowolnego zakresu UUID
jako uprawnienia; serwer sam wylicza terminy i dozwolony zakres.

`suggest_only` tworzy lub aktualizuje deduplikowany wpis `requested`
w kolejce sugestii z podsumowaniem preview. Nie zmienia lifecycle,
nie tworzy autoryzacji wykonania i nie emituje envelope. Historyczne preview
jest informacją. Ręczna zgoda właściciela wymaga świeżego biletu R2.

`automatic` ponownie sprawdza delegację i kwalifikację pod blokadami,
buduje aktualny manifest i zapisuje rzeczywiste żądanie autoryzowane
z lifecycle freeze. Pole autora wskazuje właściciela delegacji jako źródło
uprawnienia; rodzaj autoryzacji wskazuje politykę, nie ręczne kliknięcie.
Dalej działa zwykły worker R3.

Unikalna tożsamość autoryzacji obejmuje firmę, aktywację/politykę,
kanoniczny zakres osoby i generację kwalifikacji. Powtórzenie tego samego
ticka lub dwóch ticków współbieżnych nie tworzy drugiego żądania. Idempotencja
jest oparta na zapisanym zakresie i dowodzie kwalifikacji, nie na domniemaniu,
że wywołanie runtime zakończyło się bez utraty odpowiedzi. Zapis
sugestii i autoryzacja automatyczna nie mogą same zmieniać operacyjnego
hasha, od którego zależy ich idempotencja.

## 5. Blokady, cofnięcie delegacji i granica nieodwracalności

Automatyczna autoryzacja stosuje ten sam porządek blokad co ręczny przepływ:
firma, posortowany zakres kandydatów oraz zależności procesów w ustalonej
kolejności. Zmiany statusów, dodanie aplikacji, reopening, zmiana ownera,
polityki, delegacji i rozpoznania muszą serializować się z decyzją.
Transakcje ze starym snapshotem są odrzucane; wymagany jest READ COMMITTED.
Konflikty NOWAIT zwracają przewidywalny `PT409` i bezpiecznie ponawialny wynik.

Przed pierwszą rezerwacją `erasing` serwer ponownie sprawdza aktualność
delegacji, ownera, polityki, rozpoznania, hold oraz dowodu kwalifikacji.
Sam zapis wcześniejszej autoryzacji schedulera nie omija tego sprawdzenia.

Wycofanie delegacji przed tą granicą blokuje rozpoczęcie usuwania. Nie
odmraża samoistnie istniejącego żądania; anulowanie przechodzi przez R2/R3.
Od chwili utworzenia możliwej do wyeksportowania rezerwacji `erasing`
nie wolno zakładać, że ledger jej nie przyjął. Mutacja, która miałaby
wycofać tę decyzję, jest blokowana do reconciliation. Trwały `erasing`
zachowuje przypiętą autoryzację; późniejsza zmiana ownera lub delegacji
wpływa na przyszłe żądania, nie odwraca usuwania.

Odmowa kontaktu pozostaje niezależnie dostępna zgodnie z R3. Zmiana grafu
wymaga odświeżenia manifestu i nowego ACK w tym samym nieodwracalnym strumieniu.
Nie może zmienić ID, zakresu, delegacji ani źródła autoryzacji.

## 6. Podpisana autoryzacja i odtwarzanie

Envelope zachowuje istniejące podpisy rezerwacji i zdarzenia ledger.
Dozwolone są dwa ściśle walidowane warianty `authorization`:

```json
{"kind":"owner","actor_id":"uuid"}
```

```json
{
  "kind":"retention_policy",
  "actor_id":"uuid",
  "delegation_id":"uuid",
  "activation_revision":1,
  "policy_revision":1,
  "due_generation":1,
  "due_at":"UTC timestamp",
  "evidence_hash":"sha256"
}
```

Nazwy i typy są wspólnym kontraktem SQL, Node i testów. Nieznane pola,
brakujące pola, inne rodzaje i niespójna rewizja polityki są odrzucane.
Rewizje i generacje są dodatnimi bezpiecznymi liczbami całkowitymi; `due_at`
jest prawidłowym czasem UTC nie późniejszym niż `authorized_at`.
Cały obiekt autoryzacji wchodzi do niezmiennej granicy strumienia.
Pierwotne zdarzenia R3 rodzaju `owner` pozostają weryfikowalne.

SQL przechowuje pochodzenie autoryzacji w żądaniu/wykonaniu. Podpisana kopia
nie zależy od FK do aktywacji: podczas restore backup może poprzedzać
utworzenie delegacji, polityki i konta dawnego ownera. Replay używa
zweryfikowanej decyzji ledger, nie bieżącej delegacji jako zastępczego dowodu.
`authorized` odtwarza freeze; `cancelled` odtwarza anulowanie; nieodwracalne
fazy stosują dokładne zasady R3, również dla wygasłego envelope.

Upływ terminu polityki nie zmienia wymaganej kontroli pełnej historii,
podpisu rezerwacji, świeżego checkpointu, niezależnego minimum watermark
i izolacji odtwarzanej bazy. Ponowny replay musi zachować oryginalny receipt
po sprawdzeniu pustego grafu, a odtworzone dane ponownie uzgodnić.

## 7. Metadane R4 i adaptery

Nowe migracje rozszerzają istniejący kontrakt; scalonych migracji R1–R3
nie wolno edytować. Każda nowa tabela i trwały link do kandydata muszą mieć
jedną jawną klasyfikację:

- Operacyjne/sugestie i dowody związane z osobą: dokładny adapter manifestu
  oraz purge, z kontrolą zakresów współdzielonych.
- Konfiguracja firmy i projekcja wspólnej rekrutacji: zachowana, bez
  skopiowanych danych osobowych; nieusuwana dla jednej osoby.
- Pseudonimowe metadane autoryzacji i odzyskiwania: odrębny horyzont R3,
  minimalny zakres pól i jawne wyłączenie z operacyjnego hasha.

Nie wolno usuwać wspólnego zdarzenia rekrutacji potrzebnego innym osobom.
Nie wolno pozostawić niezinwentaryzowanego JSON z UUID. Baseline schematu
jest generowany z czystego pełnego łańcucha migracji po przeglądzie; runtime
nie uczy się nowego schematu. Nieznana zależność nadal blokuje wykonanie.

## 8. Monitoring i gotowość środowiska

Owner widzi wyłącznie swoją firmę: tryb, wersję aktywacji, ostatni udany tick,
liczby requested/due/blocked/frozen/ledger_pending/cancellation_pending/erasing/
active_data_erased/backup_pending, najstarsze opóźnienie, hold wymagające
przeglądu oraz stabilne, zrozumiałe kody blokad. Stan oczekiwania na ACK
nie jest przedstawiany jako zakończone anulowanie lub usunięcie.

Historia ticków jest minimalna: identyfikator, firma, wersja, czas, rezultat,
liczniki i kody. Nie zawiera CV, adresów kontaktowych, tekstów dostawców ani
sekretów. Szczegóły osoby są dostępne jedynie w jej uprawnionym zakresie.
Stronicowanie i ograniczenie batcha obejmują również endpointy monitoringu.

Kontrola operatorska rozdziela stan produktu od dowodów zewnętrznych.
Zdrowia ledger nie potwierdza lokalna flaga: potrzebny jest podpisany świeży
checkpoint, zgodność z niezależnym watermark i oczekiwana tożsamość ledger.
Monitor ujawnia opóźnienia ACK, zaległe rezerwacje, lease wymagający odnowienia
i stan izolacji restore. Nie wykonuje DELETE w celu sprawdzenia zdrowia.

Przygotowanie produkcji musi wykazać:

1. Niezależne wdrożenie ledger, rozdzielone tożsamości i klucze poza bazami.
2. Zatwierdzone horyzonty backupów, artifacts i margines oraz kompletny
   inwentarz kopii, eksportów i zasobów zewnętrznych.
3. Scheduler skonfigurowany z ograniczoną rolą, limitem, retry i monitoringiem.
4. Udokumentowaną próbę restore na izolowanym środowisku, z weryfikacją
   pełnej historii i kontrolą starego UUID; wynik związany z wersją kodu,
   schematu, tożsamością ledger i użytym checkpointem.
5. Zielone wymagane testy/review i zgodę właściciela na produkcję zgodnie
   z AGENTS.md. Scalenie z integration nie zastępuje tej zgody.

Brak dowodu jest widoczną blokadą, nie zielonym statusem domyślnym.
Aktualizacja konfiguracji produkcyjnej nie należy do zwykłego ticka.
Runtime odtwarzania nie wyłącza sam izolacji; dopuszczenie środowiska
pozostaje osobnym krokiem operatora po spełnieniu kontroli.

## 9. Wymagana weryfikacja i kryteria odbioru

| Obszar | Konieczna regresja |
| --- | --- |
| Tryby | suggest_only nigdy nie zamraża; automatic faktycznie prowadzi due → policy-derived authorization → podpisy → purge na fixture |
| Zakres | Dwie osoby/firmy, wiele aplikacji, jedna wygasła i jedna aktywna, hired, brak rozpoznania i overlap |
| Zegary | Nowe dane klasy, backdated input, stary rekord obserwowany pierwszy raz, reopen/reclose, brak eventu, częściowa odmowa zgody |
| Idempotencja | Powtórzone i współbieżne ticki, jeden request na generację, dokładne ponowienie polecenia ownera |
| Wyścigi PostgreSQL | Nowa aplikacja/reopening/hold/owner change/delegation revoke wobec autoryzacji i pierwszego erasing; wyścig reserve → ACK |
| Uprawnienia | Scheduler bez owner RPC, DML, prover ACK i purge; obce UUID i brak rekordu nie ujawniają stanu firmy |
| Ledger | Sfałszowana delegacja/policy/due proof odrzucona; niezmienność autoryzacji przez refresh; stare owner envelopes nadal działają |
| Restore | Backup sprzed delegacji i requestu, wygasłe authorized, brak pełnej historii/watermark, receipt idempotency, ponownie obecne dane |
| Adaptery | Każda nowa trwała referencja objęta klasyfikacją; shared metadata bez rozszerzenia purge; nieznany schemat blokuje |
| Monitoring/UI | Izolacja firm, znane kody, pending nie udaje sukcesu, brak sekretów/PII w tickach i health |

Odbiór wymaga typecheck/build, testów jednostkowych i bazodanowych R4,
rzeczywistych wyścigów PostgreSQL oraz istotnych regresji R1–R3/B1/B2/
SC-006/008/009. Dokładne liczniki, środowisko, SHA, pozostałe blokady
produkcyjne i niezależny werdykt są publikowane w PR i handoff.
