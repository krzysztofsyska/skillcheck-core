# SkillCheck — kontrakt bazy danych

Stan docelowego Supabase na 2026-10-04 obejmuje osiem wykonanych migracji:
`20260930000100`, `20261001000100`, `20261001000200`, `20261002000100`,
`20261002000200`, `20261002000300`, `20261004000100` i
`20261004000200`. Schemat publiczny ma 18 tabel z RLS, 45 polityk, trzy widoki
`security_invoker` i 12 publicznych RPC. Nie wykonywać tych migracji ponownie. Instrukcja wykonania poniżej dotyczy
wyłącznie nowego, pustego środowiska.

Migracja bazowa: `supabase/migrations/20260930000100_skillcheck_core.sql`.
Przygotowanie pliku ani wdrożenie kodu na Vercel nie wykonuje migracji w Supabase.

SC-004 zostało wdrożone do produkcyjnego Supabase przez
`20261004000200_screening_results.sql`. Migracja dodała pięć tabel
persistowanego wyniku preselekcji oraz sześć RPC. Po wdrożeniu produkcyjny
baseline wynosi 18 tabel z RLS / 45 polityk / 3 widoki `security_invoker` /
12 publicznych RPC.

SC-005 przygotowuje w repozytorium jedną kolejną migrację
`20261005000100_screening_worker_claim_payload.sql`. Rozszerza wyłącznie
wynik `claim_screening_attempt` o niemutowalny payload workera. Nie została
zastosowana do produkcyjnego Supabase i nie zmienia tabel, RLS ani grantów.

## Model

| Tabela | Znaczenie |
| --- | --- |
| companies | Firma i jej właściciel z Supabase Auth |
| company_members | Dostęp pozostałych użytkowników: recruiter lub viewer |
| company_profiles | Jeden profil firmy: branża, wielkość, wartości, środowisko pracy |
| positions | Stanowisko: zadania, KPI, samodzielność 1–5, zachowania i kompetencje |
| recruitments | Rekrutacja dla stanowiska |
| candidates | Kandydat należący do jednej firmy |
| applications | Udział kandydata w rekrutacji; jedna osoba może mieć wiele aplikacji |
| assessment_stages | Uporządkowane etapy danej rekrutacji |
| candidate_assessments | Status, opcjonalny wynik 0–100 i notatka dla aplikacji i etapu |
| candidate_documents | Wersjonowany tekst CV i ręcznie zatwierdzona redakcja |
| behavior_assessment_entries | Niezmienna historia ocen zachowania z dowodami |
| exercise_definition_entries | Niezmienne wersje definicji zadań i rubryk |
| exercise_observation_entries | Niezmienna historia obserwacji wykonania zadań |
| screening_analysis_versions | Wersjonowany snapshot wejścia i stan logicznej analizy |
| screening_analysis_attempts | Próby wykonania, idempotency oraz worker lease |
| screening_criterion_results | Niezmienny wynik AI per kryterium |
| screening_result_reviews | Wersjonowana historia review człowieka |
| screening_criterion_review_overrides | Niezmienne korekty człowieka bez nadpisywania AI |

Każdy rekord operacyjny zawiera `company_id`. Złożone klucze obce wymagają tej
samej firmy po obu stronach relacji. Ocena wymaga dodatkowo tej samej rekrutacji
dla aplikacji i etapu. CV, oceny zachowania, definicje zadań i obserwacje opisują
odpowiednio [cv.md](cv.md), [behavior-assessments.md](behavior-assessments.md),
[exercise-definitions.md](exercise-definitions.md) i
[exercise-observations.md](exercise-observations.md). Nie ma automatycznej oceny,
integracji AI ani voicebota; wyniki zapisuje uprawniony użytkownik.

Widoki `latest_behavior_assessments`, `latest_exercise_definitions` i
`latest_exercise_observations` udostępniają najnowsze wersje przez
`security_invoker`, więc nadal obowiązuje RLS tabel źródłowych. Publiczne RPC to
`create_company`, `ensure_initial_company`, `review_candidate_document`,
`save_behavior_assessment`, `save_exercise_definition` i
`save_exercise_observations`.

SC-004 dodało `start_screening_analysis`,
`retry_screening_analysis` i `review_screening_result` dla owner/recruiter oraz
worker-only `claim_screening_attempt`, `complete_screening_analysis` i
`fail_screening_attempt`. Zwykła rola `authenticated` nie ma `EXECUTE` do
worker-only RPC. Dedykowana rola `screening_worker` nie ma bezpośredniego CRUD
do tabel i korzysta z hashowanego, wygasającego lease.

## Uprawnienia

| Użytkownik | Odczyt | Zapis danych operacyjnych | Zmiana nazwy firmy / członków |
| --- | --- | --- | --- |
| Właściciel | Własna firma | Tak | Tak |
| recruiter | Przypisana firma | Tak | Nie |
| viewer | Przypisana firma | Nie | Nie |
| Osoba spoza firmy / anonimowa | Nie | Nie | Nie |

RLS chroni wszystkie 18 wdrożonych tabel, w tym pięć tabel SC-004. Uprawnienia do kolumn blokują zmianę
właściciela, identyfikatorów, firmy i relacji nadrzędnych. Funkcje pomocnicze
SECURITY DEFINER mają pusty `search_path` i znajdują się w schemacie `private`.
Nie dodawaj go do Exposed schemas w Supabase. Tylko `public` jest potrzebny API.

`create_company(company_name)` jest dostępne dla zalogowanego użytkownika.
W jednej transakcji przypisuje mu firmę i tworzy pusty profil; nie przyjmuje
identyfikatora właściciela od klienta. Właściciel nie potrzebuje osobnego wpisu
w `company_members`. Dodawany członek musi już istnieć w `auth.users`.
Zapraszanie użytkowników, interfejs logowania i transfer własności to przyszły etap.

Usunięcie firmy przez API jest zablokowane. Usunięcie kandydata usuwa jego aplikacje
i oceny, usunięcie rekrutacji usuwa aplikacje, etapy i oceny, a usunięcie etapu usuwa
jego oceny. Stanowiska z rekrutacjami nie można usunąć — można je archiwizować.
Przyszły interfejs musi jasno pokazywać konsekwencje operacji usuwania.

## Wykonanie migracji

Na istniejącym projekcie Supabase otwórz SQL Editor, utwórz zapytanie, wklej cały
plik migracji i uruchom jako postgres. Plik obejmuje `begin`/`commit`, więc błąd
wycofa całą migrację. Uruchamiaj go raz; celowo nie ukrywa konfliktów istniejących
tabel przez `IF NOT EXISTS`. Nie usuwa istniejących tabel ani danych.

Po sukcesie sprawdź dziewięć tabel oraz RLS w Table Editor. Jeśli migracje będą
później zarządzane CLI, oznacz tę migrację jako wykonaną w historii migracji,
zamiast ponownie ją uruchamiać. Alternatywą dla SQL Editor jest standardowy
proces Supabase CLI: inicjalizacja lokalna, link do właściwego projektu i db push.
Nie stosuj obu metod jednocześnie. Nie uruchamiaj lokalnego db reset na produkcji.

Migracja SC-004 została zastosowana do docelowego Supabase 2026-10-04 i jest
zarejestrowana w zdalnej historii migracji jako `20261004000200`. Nie uruchamiać
jej ponownie. Testy nadal odtwarzają pełny kontrakt w efemerycznym PGlite.

Testy poniżej nie wymagają konta Supabase. Odtwarzają role i `auth.uid()` w lokalnym
PostgreSQL (PGlite), ale nie weryfikują konfiguracji zdalnego projektu, Auth, JWT ani
PostgREST. Po migracji potrzebny jest test z dwiema sesjami Supabase Auth, gdy
zostanie przygotowane logowanie. Obecny endpoint `/api/health/supabase` sprawdza
dostępność Auth, a nie obecność tej migracji.

## Korzystanie z kodu

Oba istniejące klienty Supabase korzystają z kontraktu `database.types.ts`.
`skillcheckData(client)` udostępnia typowane operacje dla całego modelu.
Zapytania firmowe mają filtr `company_id`; RLS pozostaje ostatecznym zabezpieczeniem.
Przekazuj klienta z sesją użytkownika, nigdy klienta z kluczem service role.
Publiczny klucz Supabase jest wystarczający; nie dodawaj sekretów do repozytorium.

```ts
import { createClient } from "../lib/supabase/server";
import { skillcheckData } from "../lib/supabase/skillcheck";

const db = skillcheckData(await createClient());
const { data: companyId, error } = await db.createCompany("Przykładowa firma");
if (error) throw error;
if (!companyId) throw new Error("Brak identyfikatora firmy");
const company = db.company(companyId);
const { data: position, error: positionError } = await company.positions.create({
  title: "Specjalista ds. obsługi klienta",
  tasks: ["Obsługa zgłoszeń"],
  kpis: ["Czas odpowiedzi"],
  autonomy_level: 3,
});
if (positionError) throw positionError;
```

To przykład dla przyszłego uwierzytelnionego handlera zapisu, nie kod do wykonania
podczas renderowania strony. Każda metoda zwraca standardowe `{ data, error }`.
Obsługuj błąd przed użyciem danych. Odczyt i aktualizacja jednego rekordu używają
`.single()` i zwracają błąd również wtedy, gdy RLS ukryje rekord. Usuwanie zwraca
listę usuniętych rekordów; pusta lista oznacza brak pasującego dostępnego rekordu.
Tworzenie aplikacji nie tworzy automatycznie wszystkich ocen — zapisuje się je
oddzielnie, gdy dany etap zostaje przypisany kandydatowi.

Przy kończeniu oceny ustaw jednocześnie `status: "completed"` i `completed_at`.
Przy jej ponownym otwieraniu ustaw `completed_at: null`. Statusy i zakresy wartości
sprawdza baza. Kolejność etapów jest unikalna w rekrutacji; przy zmianie kolejności
użyj wolnej dodatniej wartości przejściowej (docelowy edytor może dostać własne RPC).

Kontrakt TypeScript w `lib/supabase/database.types.ts` jest utrzymywany ręcznie.
Obejmuje 18 wdrożonych tabel, trzy widoki, 12 RPC, relacje między obiektami
publicznymi oraz celowo ograniczone typy `Insert`/`Update` zgodne z dostępnymi
ścieżkami zapisu. Tabele historii są zapisywane wyłącznie przez RPC, a firmy i ich
profile są tworzone atomowo przez RPC; ich bezpośredni `Insert` ma typ `never`.
Typy wygenerowane przez Supabase CLI należy porównywać z tym kontraktem, nie
zastępować nim ograniczeń API bez przeglądu. Baza zawsze egzekwuje uprawnienia.

`tests/database-types.test.mjs` odtwarza osiem wdrożonych migracji oraz
przygotowaną migrację SC-005 i zamraża
publiczne tabele, kolumny, relacje, widoki `security_invoker` oraz sygnatury RPC.
`tests/database-types.contract.ts` zamraża odpowiadające im typy TypeScript.

## Sprawdzenie

```sh
npm ci
npm run typecheck
npm run test:db
npm run build
```

Testy wykonują migracje w PGlite i sprawdzają istniejący model, pięć tabel
SC-004 oraz rozszerzony claim SC-005, a także
izolację odczytu/zapisu/usuwania, brak anonimowego dostępu, role, odebranie dostępu,
blokadę zmiany właściciela i firmy, złożone relacje, ograniczenia i bootstrap.
Te same kontrole są uruchamiane przez GitHub Actions. Plik lock stabilizuje wersje.

Źródła projektu zabezpieczeń:
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
i [Database Functions](https://supabase.com/docs/guides/database/functions).
