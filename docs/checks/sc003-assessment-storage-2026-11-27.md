# SC-003 — zgodność zapisu ocen CV z projektem (27.11.2026)

Krok R0 SC-003 w `docs/ROADMAP.md`, zadanie #610. Projekt: issue #4 opisuje tylko cel (wersje,
odcisk wejścia, przegląd człowieka, stany wyniku); szczegółowy projekt jest w
[`docs/sc-003-screening-result-architecture.md`](../sc-003-screening-result-architecture.md)
(dalej „projekt”, numery sekcji z tego pliku). Porównanie zrobione na `origin/integration`
@ `8cb9182` przez czytanie migracji, kodu w `lib/` i `app/` oraz testów. Nic nie było
uruchamiane na bazie (ani Preview, ani produkcja); to przegląd kodu, nie test.

## Wynik w skrócie

Zapis wyników analizy CV jest w większości zgodny z projektem: pięć tabel, wersje analizy,
odcisk wejścia, kontrakt modelu, próby wykonania z dzierżawą, cytaty sprawdzane znak w znak,
uprawnienia ról i odczyt tylko w obrębie firmy. Są dwie istotne różnice, obie powstały świadomie
w późniejszym kroku („macierz dowodów”, migracje z 26.10.2026) i nie były dopisane do projektu:

1. **Ocena kryterium** to dziś `verdict` (potwierdzone / częściowo / brak / sprzeczne), a nie
   `rating` (poniżej / spełnia / powyżej). Dla nowych analiz `rating` jest zawsze
   `insufficient_data`. Opisane niżej i dopisane do projektu w tym PR.
2. **Poprawki człowieka przy pojedynczym kryterium** są zapisywane w tym samym wierszu co wynik AI
   (kolumny `human_*`) i każda kolejna poprawka nadpisuje poprzednią. Wynik AI zostaje
   nietknięty, ale **historia poprawek człowieka per kryterium ginie** (zostaje tylko ostatnia
   wersja, kto i kiedy). Projekt wymaga pełnej, niezmiennej historii. To zmiana bazy (L3), więc
   proponowana jako osobny krok #621.

## Tabela zgodności

| # | Wymóg projektu | Wynik | Dowód (plik:wiersz) | Co dalej |
|---|---|---|---|---|
| 1 | Pięć tabel: wersje analizy, próby, wyniki kryteriów, przeglądy, poprawki (§3) | zgodne | `supabase/migrations/20261004000200_screening_results.sql:16`, `:105`, `:145`, `:171`, `:192` | — |
| 2 | Każdy wiersz ma `company_id`, złożone klucze obce w obrębie tej samej firmy (§3.1) | zgodne | `20261004000200_screening_results.sql:68-81`, `:133-135`, `:158-160`, `:207-212` | — |
| 3 | Trzy niezależne osie: wykonanie, aktualność (`stale_at`/`stale_reason`), przegląd (§2, §5) | zgodne | `20261004000200_screening_results.sql:33-34`, `:41-48`, `:58-66` | — |
| 4 | Lista przyczyn nieaktualności (§5) | zgodne, z jednym dodatkiem | `20261004000200_screening_results.sql:42-47` — dodane `input_changed_during_processing` | Dodatek realizuje rekomendację z §18 pkt 1 (zapis „ukończony + nieaktualny”). |
| 5 | Wersja analizy rośnie per zgłoszenie; jeden aktualny ukończony wynik (§3.1) | zgodne (ostrzej niż w projekcie) | `20261004000200_screening_results.sql:81`, `:98-103` — indeks aktualnego wyniku jest unikalny, projekt mówił o zwykłym | — |
| 6 | Odcisk wejścia = SHA-256 z `{binding, payload}`, bez zmiany algorytmu (§8.1) | zgodne | `lib/screening.ts:40-48` | — |
| 7 | Co zmienia aktualność: zmiana zgłoszenia/rekrutacji (§8.3) | zgodne co do zasady, zawężone | `supabase/migrations/20261118120000_r2_screening_stale_input_columns.sql:1-35` — zmiana etapu, decyzji człowieka i nazwy rekrutacji nie unieważnia już wyniku (krok R2-B1) | Świadoma poprawka R2; te pola nie są wejściem analizy. Bez zmian. |
| 8 | Obowiązkowy `analysis_contract_hash`, ten sam w TS i SQL (§8.4) | zgodne | `20261004000200_screening_results.sql:26`, `:251`; `lib/screening.ts:60-78`; test równości `tests/screening-result-database.test.mjs:272-279` | — |
| 9 | Próby: idempotency, jedna aktywna próba, hasz dzierżawy zamiast tokenu (§3.2) | zgodne | `20261004000200_screening_results.sql:110-113`, `:136-141` | — |
| 10 | Bez pełnej treści zapytania/odpowiedzi dostawcy AI w bazie (§3.2, §13) | zgodne | brak takich kolumn w `20261004000200_screening_results.sql:105-137` | — |
| 11 | Cytaty: maks. 5, do 2000 znaków, dokładnie z zatwierdzonego tekstu, offsety UTF-16 (§6) | zgodne | `20261004000200_screening_results.sql:313-349` (`private.screening_valid_evidence`) | — |
| 12 | `rating` jest jedynym źródłem prawdy oceny kryterium (§6) | **różnica** | `supabase/migrations/20261026220100_sc_step3_evidence_extensions.sql:5-6` (nowe `verdict`); `supabase/migrations/20261026220200_sc_step3_evidence_worker.sql:193-197` (`rating` zawsze `insufficient_data` dla nowych analiz) | **Opisane tutaj.** Dopisana uwaga na początku projektu (ten PR). Kod jest celowo tak zrobiony (komentarz w migracji: brak bezpiecznego przeliczenia na punkty). |
| 13 | Wynik AI niezmienny po zapisie (§3.3, §9) | zgodne w skutku | `20261026220200_sc_step3_evidence_worker.sql:208-225` — `verdict` dopisywany w tej samej transakcji co wynik, tylko raz; inna treść przy ponowieniu = błąd | — |
| 14 | Poprawki człowieka: osobne, niezmienne wpisy; pełna historia; nie nadpisują AI (§3.4, §3.5, §9) | **różnica** (dla nowych analiz) | `20261026220100_sc_step3_evidence_extensions.sql:9-17` (kolumny `human_*` w wierszu wyniku AI), `supabase/migrations/20261030120000_sc_step3_matrix_change_invalidates_approval.sql:81-108` (`update` nadpisuje poprzednią poprawkę; podbija tylko numer przeglądu) | **Osobny krok (L3, migracja)** — zadanie #621 (PROPOSED). Stara ścieżka przez `screening_criterion_review_overrides` działa zgodnie z projektem. |
| 15 | Przegląd całej analizy: wersjonowany, z kontrolą „ktoś zmienił w międzyczasie” (§11.6) | zgodne | `20261030120000_sc_step3_matrix_change_invalidates_approval.sql:171-175`, `:236-263` | — |
| 16 | Nieaktualny wynik nie może dostać zatwierdzenia (§3.4) | zgodne | `20261030120000_sc_step3_matrix_change_invalidates_approval.sql:173-175`; poprawka per kryterium wymaga aktualnego wyniku: `20261026220100_sc_step3_evidence_extensions.sql:57-65` | — |
| 17 | Role: właściciel i rekruter zapisują przez funkcje, „tylko odczyt” tylko czyta, obcy nic (§9, §10) | zgodne | `supabase/migrations/20260930000100_skillcheck_core.sql:139-146` (`has_company_access`, zapis tylko właściciel/rekruter); `20261004000200_screening_results.sql:218-243`, `:1325-1350` (RLS, tylko `select` dla zalogowanych, brak dostępu dla `anon`) | Test SC-004 (#614) sprawdza izolację firm. |
| 18 | Worker AI za osobną granicą: przeglądarka nie może przejąć ani zakończyć próby (§10) | zgodne | `20261004000200_screening_results.sql:5-11`, `:1344-1350` (rola `screening_worker`); `lib/screening-hmac.ts` (podpis HMAC) | — |
| 19 | Model nie zwraca decyzji „zatrudnij/odrzuć”, wyniku ogólnego ani rankingu (§6, §14) | zgodne | `lib/screening-evidence-schema.ts:19`, `:25`, `:46` | — |
| 20 | Brak wyniku liczbowego w SC-004 (`overall_score` pusty) (§6, §15) | zgodne | `20261004000200_screening_results.sql:67` | — |
| 21 | Opis tabel w `docs/database.md` zgodny ze stanem (§20 pkt 12) | **różnica** (drobna, dokument) | `docs/database.md:47` mówiło „Niezmienny wynik AI per kryterium”, a wiersz ma też poprawki człowieka | **Poprawione w tym PR.** |

## Czego nie sprawdzono

- Nie porównano bazy Preview ani produkcji z migracjami — to zakres SC-002.
- Nie uruchomiono testów bazy; ocena opiera się na czytaniu kodu i istniejących testów.
- Tabela `candidate_assessments` (ręczna ocena etapu 0–100) nie jest częścią projektu #4 i nie
  była porównywana.
