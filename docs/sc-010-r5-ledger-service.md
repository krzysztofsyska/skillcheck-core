# SC-010-R5 — osobna usługa rejestru

TASK: SC-010-R5, issue #105. LEVEL: L3. SCOPE: BACKEND / OPERATIONS.
OWNER: Krzysztof Syska. REVIEWER: niezależny Codex.
DEPENDS ON: zaakceptowane R3/R4, PR #103.

## Stan i zakres

Na 2026-10-12 baza `skillcheck-erasure-ledger` (`jfacjlrfbusqlednluzu`)
działa w eu-west-1, Micro, w dotychczasowej organizacji. Schemat ledger
wdrożono migracją `20261012054904_sc010_independent_erasure_ledger`.
Tożsamość rejestru: `4cde6438-c27e-46b1-9b7d-1396b688643f`.
Stan początkowy to sequence=0, event_hash=NULL. To NIE jest niezależny watermark.

R5 dostarcza transport HTTP, kontrolę konfiguracji i uruchamialny proces Node.
Nie tworzy hosta, kluczy, kont logowania, harmonogramu, adaptera magazynu
kontrolnego ani automatycznego purge. Nie zmienia migracji produktu.
Przykład konfiguracji celowo nie przechodzi uruchomienia bez rzeczywistego
niezależnego magazynu. Nie wolno oznaczać tego etapu jako gotowej produkcji.

## Granice dostępu

| Proces | Dostęp |
| --- | --- |
| Ledger | Tylko oddzielna baza, klucz AES i klucz podpisu ledger; publiczny klucz prover |
| Prover/attestor | Ograniczona rola produktu, prywatny klucz rezerwacji; brak klucza podpisu ledger |
| Worker | Token append i podpisana rezerwacja; brak tokena odczytu ledger i kluczy |
| Operator restore | Osobny token odczytu, zachowane klucze weryfikacji/deszyfracji, niezależny watermark |

Tokeny append/read muszą być różne, losowe (minimum 32 losowe bajty, np. base64url),
przechowywane jako sekrety. Walidacja długości nie dowodzi losowości.
Żadnego klucza prywatnego prover nie wolno wgrać do procesu ledger.
Nie umieszczać sekretów ledger w głównym projekcie `skillcheck-core` Vercel.
Osobny projekt Vercel i jego sekrety są jedynie możliwym przyszłym celem:
obecny proces jest usługą Node za prywatnym TLS ingress, nie funkcją Vercel.
Wdrożenie serverless wymaga osobnego adaptera i weryfikacji limitów.

## Interfejs

Wszystkie odpowiedzi mają `Cache-Control: no-store`. Brak CORS, logowania
ciał żądań, haseł lub błędów adaptera. Uwierzytelnianie poprzedza odczyt body.

| Metoda i ścieżka | Token | Kontrakt |
| --- | --- | --- |
| POST `/v1/events` | append | `{eventId,envelopeText,envelopeHash,reservationKeyId,reservationProof}`; receipt dopiero po trwałym register.record |
| POST `/v1/checkpoint` | read | `{challenge}` — świeży UUID, podpisany checkpoint |
| GET `/v1/records?after=0&through=10&limit=10` | read | Zaszyfrowane rekordy, limit 1–100, dokładnie ciągła strona do wskazanego checkpointu |
| GET `/healthz` | read | Tylko żywotność procesu, zawsze `production_ready:false` |

Body JSON max 2 MiB; sam envelope max 1 MiB. Błędy kontraktu 400,
uwierzytelnienia 401, nieznane trasy/metody 404, za duże body 413,
błąd adaptera 503. Błąd po commit nie oznacza braku zapisu. Ponowienie zawsze
używa identycznego eventId i envelope; nie wolno tworzyć zastępczego zdarzenia.
Odczyt może ujawnić zatwierdzony w bazie event, którego register jeszcze nie
potwierdził; token read jest zastrzeżony dla operatora. Odczyt nie wykonuje ACK.

## Wymagany niezależny magazyn kontrolny

`checkpointRegister.record(receipt)` jest zaufanym adapterem operatora.
Przed zakończeniem musi trwale zachować dowód pokrycia danego zdarzenia:

1. Weryfikuje podpis przy użyciu przypiętych kluczy i ledger_id.
2. Pierwszy zapis kontynuuje zatwierdzony genesis. Następne mają kolejny numer
   i `previous_ledger_hash` równy poprzedniemu hashowi.
3. Warunkowy atomowy zapis (compare-and-set) chroni przed równoległym nadpisaniem,
   cofnięciem numeru lub podmianą hasha. Rejestr i jego wersje są poza kopiami obu baz.
4. Powtórka starszego zdarzenia wymaga dowodu identycznego hasha na jego pozycji,
   a nie tylko porównania numerów. Nigdy nie obniża minimum.
5. Luka lub równoległe przyjście n+1 przed n odmawia potwierdzenia do uzgodnienia
   wcześniejszego wpisu. Błąd/timeout odmawia ACK; żądanie zostaje ponowione.
6. Odczyt operatora dostarcza `{ledger_id,sequence,event_hash}` niezależnie od
   odtwarzanej bazy. Brak wpisu jest błędem, nie domyślnym zerem.

Nie dostarczamy pozornego adaptera pamięciowego ani `/tmp`. Wybór trwałego
magazynu z powyższymi gwarancjami, jego uprawnienia, kopie i koszty są blokadą
wdrożenia. Żaden boolean w config nie może zastąpić próby utraty ACK i rollbacku.

## Konfiguracja i uruchomienie

1. Zbudować wydanie z zaakceptowanego SHA (Node 24, `npm ci`, zależność `pg`
   jest obecnie w devDependencies, więc instalacja operatora musi ją uwzględniać).
2. W oddzielnej bazie utworzyć nieadministracyjną rolę `erasure_ledger_service`.
   USAGE na schemacie, SELECT/INSERT na events i SELECT/UPDATE na head.
   Bez własności obiektów, członkostwa w innych rolach, BYPASSRLS, CREATE ROLE/DB,
   CREATE na schemacie, UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER na events.
   Poświadczenie logowania ustanowić przez bezpieczny proces operatora.
3. Przykład `tools/erasure/operator-config.example.mjs` skopiować poza repo,
   dostosować przypięty endpoint i ścieżkę instalacji. Sekrety dostarczyć przez
   magazyn hosta jako pliki tylko do odczytu, z prawami właściciela procesu.
   Nie wyłączać weryfikacji TLS PostgreSQL; użyć zatwierdzonego CA dostawcy.
4. Dostarczyć rzeczywisty, przejrzany adapter register i jego oddzielną tożsamość.
   Zachować stare wersje kluczy do końca zatwierdzonego horyzontu kopii.
5. Uruchomić `node tools/erasure/serve.mjs --config /secure/operator.mjs`.
   Proces nasłuchuje wyłącznie na `127.0.0.1:8787`. Import plików nie uruchamia usługi.
6. Prywatny reverse proxy zapewnia TLS, ograniczenie liczby równoległych żądań,
   czasu odpowiedzi i rate limiting. Wyłączyć logowanie Authorization/body.
   Adaptery DB i magazynu muszą mieć skończone timeouty. Sam limit HTTP body
   nie ogranicza czasu wiszącej operacji zewnętrznej.
7. Wykonać test na izolowanych, syntetycznych danych zgodnie z R4 runbookiem:
   zapis → register → ACK → purge → stara kopia → weryfikacja i replay.
   Dodatkowo rollback ledger, niedostępny register, utrata odpowiedzi, duplikat,
   konkurencyjny zapis i separacja tenantów. Nigdy nie zwalniać izolacji automatycznie.

## Walidacja i następny krok

`npm run test:erasure-service` sprawdza transport na prawdziwym lokalnym HTTP,
awarie potwierdzeń i trwały zapis w PGlite oraz kontrolę konfiguracji procesu.
Regresje: `npm run test:erasure-execution`. To nie zastępuje docelowego restore drill.
Następny etap to dostarczenie konkretnego magazynu register i hosta, następnie
review konfiguracji i próba na docelowej infrastrukturze. Nie włączać usuwania
na podstawie samego uruchomienia HTTP lub zielonego healthz.
