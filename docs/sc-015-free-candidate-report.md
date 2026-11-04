# SC-015 — raport FREE kandydata i porównanie do pięciu CV

Kontrakt wspólnego odczytu dla GitHub Issue #268. Oba widoki — raport pojedynczego CV
i porównanie kandydatów — czytają wymagania i wyniki analizy w ten sam sposób. Ten dokument
jest tym wspólnym odczytem; zmiana w nim jest zmianą w obu widokach.

Decyzje właściciela z 2026-11-04 (czat): poziom L3 z osobną tabelą na oznaczenia; starsze
profile pokazują wymagania jako **nieoznaczone**, dopóki rekruter sam ich nie sklasyfikuje;
obecny eksport CSV raportu preselekcji zostaje bez zmian.

## 1. Oznaczenie wymagania: konieczne / dodatkowe / nieoznaczone

### Dlaczego osobna tabela

Wymagania stanowiska to trzy tablice `text[]` w `public.positions` (`tasks`, `kpis`,
`required_competencies`). Nie mają metadanych na pozycję. Dopisanie kolumny albo zmiana
tych tablic podbija `positions.updated_at`, a trigger `screening_position_stale`
(`20260930000100_skillcheck_core.sql`) unieważnia wtedy **każdą** analizę tego stanowiska
z `stale_reason = 'position_changed'`. Samo oznaczenie wymagania kasowałoby więc pracę
rekrutera i wymuszało płatną ponowną analizę CV.

Oznaczenia żyją dlatego w osobnej tabeli `public.position_requirement_flags`, poza zasięgiem
tego triggera. Zapis oznaczenia nie dotyka `positions`, nie zmienia `positions.updated_at`,
nie zmienia `input_fingerprint` analizy i nie uruchamia ponownej analizy. Test
`tests/position-requirement-flags-database.test.mjs` pilnuje tego wprost.

### Klucz wymagania

Identyfikator kryterium jest pozycyjny i powstaje w `lib/screening.ts`:
`task:1`, `kpi:2`, `competency:3` — numer to pozycja w odpowiedniej tablicy, licząc od 1.
Identyfikator sam w sobie nie jest trwały: po przestawieniu kolejności zadań `task:1`
wskazuje inny tekst.

Dlatego każde oznaczenie przechowuje razem z identyfikatorem **tekst wymagania w chwili
oznaczania** (`criterion_text`). Przy odczycie oznaczenie obowiązuje tylko wtedy, gdy ten
tekst jest identyczny z tekstem, który stoi dziś pod tym identyfikatorem w profilu
stanowiska. Jeśli się różni, wymaganie jest **nieoznaczone** — nigdy nie dziedziczy
oznaczenia po innym wymaganiu. Zasada: lepiej poprosić rekrutera o ponowne oznaczenie niż
po cichu przypisać wymaganiu cudzą etykietę.

### Trzy stany, nie dwa

| stan | skąd | etykieta |
| --- | --- | --- |
| `required` | wiersz w tabeli, tekst zgodny | Konieczne |
| `additional` | wiersz w tabeli, tekst zgodny | Dodatkowe |
| `unmarked` | brak wiersza albo tekst się różni | Nieoznaczone |

Brak wiersza znaczy „nieoznaczone", nie „konieczne". Starsze profile stanowisk nie mają
żadnych wierszy, więc wszystkie ich wymagania są nieoznaczone, dopóki rekruter sam ich nie
sklasyfikuje. Nic nie znika z widoku: nieoznaczone wymagania są pokazywane w obu widokach
i w podsumowaniu, w osobnej grupie.

### Kolejność

W obu widokach: **konieczne → nieoznaczone → dodatkowe**, a wewnątrz grupy według
`criterion_order` (czyli zadania, potem KPI, potem kompetencje — w kolejności z profilu).
Nieoznaczone stoją przed dodatkowymi, bo nikt jeszcze nie stwierdził, że są mniej ważne.

### Kto może zapisać

Zapis wyłącznie przez `public.set_position_requirement_flag` (`security definer`), który
sprawdza `private.has_company_access(target_company, true)`. Tabela ma RLS tylko do odczytu
dla `authenticated`, bez `insert/update/delete`, oraz złożony klucz obcy
`(company_id, position_id) → positions(company_id, id)` — identyfikator stanowiska z innej
firmy nie da się połączyć, niezależnie od polityk.

## 2. Status wymagania u kandydata

Jedna funkcja, `requirementStatus` w `lib/requirement-status.ts`, liczy status wymagania dla
jednego kandydata. Oba widoki używają tylko jej; żaden z nich nie interpretuje kolumn bazy
samodzielnie.

Podział modułów jest celowy: `lib/requirement-status.ts` to czysty kontrakt (statusy, etykiety,
składanie wiersza, podsumowanie) i nie importuje klienta Supabase, więc mogą go czytać komponenty
Reacta i porównanie. `lib/candidate-report.ts` dokłada do tego sam odczyt z bazy i re-eksportuje
czysty kontrakt, żeby strony miały jedno miejsce do importu.

Wejście: stan analizy (`screening_analysis_versions.execution_status`, `stale_at`) oraz
wiersz macierzy dowodów (`screening_criterion_results`).

| status | warunek | etykieta |
| --- | --- | --- |
| `in_progress` | brak analizy albo `execution_status in ('pending','processing')` | Analiza w toku |
| `unavailable` | analiza `failed` / `cancelled`, albo brak wiersza dla wymagania | Brak wyniku analizy |
| `legacy` | `verdict is null` (analiza sprzed macierzy dowodów) | Analiza starszego typu |
| `rejected` | `human_status = 'rejected'` | Wiersz odrzucony przez rekrutera |
| `supported` / `partial` / `missing` / `contradicted` | `execution_status = 'completed'`, werdykt po korekcie | Potwierdzone w CV / Częściowo potwierdzone / Brak informacji w CV / Sprzeczne dane |

**Analiza w toku to nie to samo co brak informacji.** `in_progress` znaczy, że nikt jeszcze
nie sprawdził tego wymagania. `missing` znaczy, że analiza się skończyła i w CV nie ma na ten
temat nic. Widoki nigdy nie pokazują tych dwóch stanów tą samą etykietą ani tym samym
oznaczeniem graficznym.

### Korekta rekrutera

Werdykt, cytaty, „czego brakuje" i pytanie bierze się po korekcie: przy
`human_status = 'edited'` wygrywa `human_*`, w pozostałych przypadkach wartość AI.
Przy `human_status = 'rejected'` nie publikuje się ani werdyktu AI, ani jego cytatów —
wiersz zostaje otwarty, a rekruter układa pytanie sam. To ta sama zasada, którą stosuje już
`lib/interview-gaps.ts`; obie funkcje muszą zgadzać się co do tego, co znaczy odrzucony wiersz.

Korekta dotyczy jednego wiersza jednej analizy jednego kandydata. Nie dotyka wymagań
stanowiska, oznaczeń ani wyników pozostałych kandydatów.

### Cytat

Pokazywany jest cytat dostępny dla danego wymagania: po korekcie `human_evidence`, w innym
razie `evidence`. Przy `missing` cytatu z definicji nie ma (RPC wymusza pustą listę).
Cytaty pochodzą wyłącznie ze sprawdzonego, zanonimizowanego tekstu CV i są weryfikowane
bajt po bajcie po stronie bazy — widoki ich nie rekonstruują.

### Pytanie przy luce

Przy `partial`, `missing` i `contradicted` widok podaje pytanie z przewodnika:
`human_suggested_question` albo `suggested_question`. Gdy pytania nie ma, podaje zdanie
zastępcze — to samo, którego używa „Przygotowanie do rozmowy", żeby rekruter nie dostał
dwóch różnych pytań o to samo.

### Zdanie, które musi stać w obu widokach

> Brak informacji w CV nie przesądza o braku kwalifikacji.

Nie jest to ozdobnik. Raport nie jest decyzją o zatrudnieniu i nie liczy wyniku ogólnego.
`screening_analysis_versions.overall_score` jest w bazie trwale `NULL`; żaden z tych widoków
nie wprowadza punktacji, rankingu ani sugestii „zatrudnić / odrzucić".

## 3. Raport pojedynczego CV

Ścieżka:
`app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/report`.

Kolejność na stronie:
1. krótkie podsumowanie — ile wymagań koniecznych ma potwierdzenie, ile czeka na wyjaśnienie,
   ile jest nieoznaczonych, stan analizy;
2. wymagania konieczne, każde ze statusem, cytatem i (przy luce) pytaniem;
3. wymagania nieoznaczone;
4. wymagania dodatkowe.

Zasada pustych sekcji z `docs/plan-budowy-2026-11-02.md` obowiązuje: grupa bez wymagań
pokazuje zdanie „Brak wymagań w tej grupie", a nie znika. Rekruter ma widzieć, czego nie
sprawdzono.

Strona nie ma w adresie ani w tytule danych kandydata, ustawia `robots: noindex`
i `Referrer-Policy: no-referrer`, tak jak raport preselekcji.

## 4. Porównanie kandydatów

Zostaje w raporcie rekrutacji
(`app/dashboard/[companyId]/recruitments/[recruitmentId]/report`), ale zmienia układ:
**wiersze to wymagania, kolumny to kandydaci**, maksymalnie pięciu. Komórka pokazuje ten sam
status i ten sam cytat co raport pojedynczego CV, bo pochodzi z tej samej funkcji.

Wybór pięciu kandydatów: najpierw osoby z shortlisty człowieka, potem według miejsca
w rankingu, dalej według identyfikatora zgłoszenia — deterministycznie. Limit ma własną
stałą `MAX_COMPARISON_CANDIDATES = 5` i nie korzysta z parametru `size` raportu
(ten steruje wielkością sugestii shortlisty i ma inne znaczenie).

Wiersze porównania to wymagania **aktualnego** profilu stanowiska, pogrupowane jak wyżej.
Kandydat analizowany na innej wersji wymagań nie ma w danym wierszu wyniku — komórka mówi
„Brak wyniku analizy", a nie „brak informacji".

Tabela rankingu i shortlisty zostaje na stronie jako osobna sekcja: niesie miejsce, sugestię
i decyzję człowieka, czego macierz wymagań nie pokazuje.

**Eksport CSV zostaje bez zmian** (`screeningReportCsv` w `lib/screening-report.ts`).
Decyzja właściciela z 2026-11-04. Nowe oznaczenia i nowy układ są na razie tylko na ekranie.

## 5. Izolacja firm

Każdy odczyt idzie przez klienta RLS zalogowanego użytkownika, nigdy przez `service_role`.
Oznaczenia czyta się z filtrem `company_id` **i** `position_id`, a wynik sprawdza się
dodatkowo w kodzie: wiersz z obcym `company_id` albo `position_id` przerywa budowę raportu,
zamiast zostać po cichu pominięty. Test `tests/position-requirement-flags-database.test.mjs`
sprawdza, że firma B nie widzi oznaczeń firmy A i nie może ich zapisać (`42501`).

## 6. Dane kandydatów w testach

Testy używają wyłącznie fikcyjnych CV (`fixtures/screening/`, flaga `"real_person": false`).
Żaden test ani log nie zawiera prawdziwego CV, nazwiska, adresu ani NIP-u.
