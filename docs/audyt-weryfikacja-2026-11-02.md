# Audyt pakietu WERYFIKACJA — 2026-11-02

**Zakres:** repozytorium `krzysztofsyska/skillcheck-core` (HEAD `9856a3d`, merge PR #222 z `integration`),
projekt Vercel `skillcheck-core`, baza Supabase `skillcheck-preview` (`orbyscrupgnupifzlqxp`).
**Ważne:** audyt badał `main` (`9856a3d`). Gałąź `integration` była w kilku miejscach nowsza,
więc część uwag — w szczególności dotyczące chatbota — opisuje stan, którego na `integration`
już nie było. Każda taka różnica jest zaznaczona w tekście. Numery linii i długości plików
też odnoszą się do `9856a3d`.

**Charakter:** audyt wyłącznie odczytowy. Nie wprowadzono żadnych zmian w kodzie, migracjach,
bazie ani konfiguracji Vercel.

## Co deklaruje pakiet WERYFIKACJA

Źródło: `app/components/marketing/package-comparison.tsx` (wiersze 19, 24–33).
Cena **615 zł za 60 CV** (decyzja właściciela 2026-11-02; w chwili audytu strona podawała 899 zł), zakres: „20 rozmów + testy; analizy CV według zatwierdzonej polityki”, funkcje:

1. Wszystko z Preselekcji
2. 20 rozmów weryfikacyjnych z botem
3. Analiza odpowiedzi z rozmowy
4. Testy kompetencji
5. Rozszerzony raport kandydata

Dodatkowo tabela porównawcza deklarowała „Chatbot informacyjny — Tak” dla wszystkich czterech
pakietów — **ale tylko na `9856a3d`, czyli na `main`**. Na `integration` wiersz brzmiał już
„Planowany”, a decyzją właściciela z 2026-11-02 nie ma go wcale. Wszystkie uwagi o chatbocie
w tym dokumencie dotyczą stanu `main` z dnia audytu.
Karta WERYFIKACJA jest oznaczona `Planowany pakiet` i opatrzona adnotacją „Cena robocza z wizualizacji”,
a przycisk prowadzi do `/rozmowa` (formularz kontaktowy), nie do checkoutu.

## Metoda i kryteria statusów

- **GOTOWE** — jest UI, jest warstwa serwerowa/API, jest zapis, a schemat bazy znajduje się
  w `supabase/migrations/` i jest obecny w żywej bazie `skillcheck-preview`.
- **CZĘŚCIOWE** — część łańcucha działa, brakuje istotnego ogniwa (np. UI albo wdrożonego schematu).
- **TYLKO BAZA** — istnieje schemat/logika SQL lub moduły domenowe, ale nic tego nie uruchamia
  w aplikacji (brak UI, brak runtime, brak migracji produkcyjnej).
- **BRAK** — nie ma kodu poza treścią marketingową.

Kluczowe rozróżnienie w tym repozytorium: katalog `supabase/migrations/` to łańcuch migracji faktycznie
stosowany do bazy, natomiast `db/isolated/` to **prototypy nieaktywne**. Pliki w `db/isolated/` noszą
własne ostrzeżenia, np. `db/isolated/sc014-b2-attempts.sql:1`: „Isolated composition only; never an
active production migration.” Potwierdza to spis tabel w `skillcheck-preview` — żadna tabela
z `db/isolated/` tam nie istnieje.

---

## 1. Testy kompetencji — **CZĘŚCIOWE (bliżej TYLKO BAZA)**

Trzeba rozdzielić dwie różne rzeczy, które w repozytorium nazywają się podobnie.

### 1a. „Test kompetencji” jako rubryka oceniana przez rekrutera — GOTOWE

To jest rodzaj definicji ćwiczenia (`kind = 'competency_test'`), opisany szerzej w punkcie 3.
Ekran tworzenia istnieje, ocena przez rekrutera istnieje, zapis działa. **Kandydat nie bierze w tym udziału** —
próbkę pracy (`work_sample`) wkleja rekruter w formularzu obserwacji.

| Element | Ścieżka |
|---|---|
| Ekran tworzenia | `app/dashboard/[companyId]/recruitments/[recruitmentId]/exercises/new/page.tsx`, `exercise-form.tsx:35` |
| Zapis | `exercise-actions.ts` → RPC `save_exercise_definition` |
| Migracja (wdrożona) | `supabase/migrations/20261002000300_exercise_definitions.sql` |

### 1b. „Test kompetencji” jako test rozwiązywany przez kandydata (SC-014) — TYLKO BAZA / nieaktywne

To jest to, co sprzedaje pakiet. Zbudowana jest logika domenowa i broker HTTP, ale **nie ma ekranu
dla kandydata i nic nie jest wdrożone**.

| Element | Status | Ścieżka / dowód |
|---|---|---|
| Logika punktacji i walidacji | istnieje | `lib/competency-test.ts` (250 linii; polityka `competency-test-rubric-v1`, punkty below=0/meets=50/above=100, minimalne pokrycie 0.6) |
| Broker HTTP (trust boundary) | istnieje | `lib/competency-attempt-broker.ts` (345 linii), `lib/competency-attempt-transport.ts`, `lib/competency-broker-limiter.ts`, `lib/competency-broker-role.ts` |
| Endpoint API | istnieje, ale wyłączony | `app/api/competency/attempt/route.ts` → `lib/competency-attempt-broker-runtime.ts:139`: `if (process.env.COMPETENCY_BROKER_ENABLED !== 'true') return disabled();` (HTTP 503) |
| Zmienne środowiskowe | **nie ustawione nigdzie** | W Vercel `skillcheck-core` nie ma ani jednej zmiennej `COMPETENCY_BROKER_*` (ani Preview, ani Production). Nie ma ich też w `.env.example`. |
| Schemat bazy | **nie wdrożony** | `db/isolated/sc014-b2-attempts.sql`, `sc014-b2-validation.sql`, `sc014-b2-withdrawal.sql`, `sc014-b2-retention.sql` — wszystkie w `db/isolated/`, żadna w `supabase/migrations/`. Tabel `private.competency_test_grants` i pokrewnych **nie ma** w `skillcheck-preview`. |
| **Ekran kandydata** | **BRAK** | Nie istnieje żadna trasa kandydacka. Potwierdza to komentarz w `lib/competency-attempt-broker.ts:4`: „No server-side candidate storage, public RPC, AI, or B4 page.” |
| Ocena wyników / wpięcie w raport | BRAK | Punktacja z `lib/competency-test.ts` nie jest nigdzie konsumowana przez warstwę raportową. |

**Wniosek:** kandydat dziś nie może rozwiązać testu. Rekruter może jedynie opisać rubrykę i sam ocenić
materiał, który zdobędzie poza systemem.

---

## 2. Ocena zachowań w 8 obszarach — **GOTOWE**

Pełny łańcuch: UI → server action → RPC → tabela wdrożona w żywej bazie.

Osiem obszarów zdefiniowanych w `lib/behavior-guide.ts`:
`responsibility`, `independence`, `initiative`, `results`, `cooperation`, `change`, `feedback`, `pressure`.

| Element | Ścieżka |
|---|---|
| Ekran listy obszarów i ocen | `app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/behaviors/page.tsx` |
| Historia wersji oceny | `.../behaviors/[areaKey]/history/page.tsx` (odczyt `behavior_assessment_entries`) |
| Formularz | `app/dashboard/[companyId]/recruitments/[recruitmentId]/behavior-form.tsx` |
| Zapis | `behavior-actions.ts:24` → RPC `save_behavior_assessment` |
| Walidacja i obsługa błędów | `lib/behavior-assessment.ts`, `lib/behavior-context.ts` |
| Przewodnik treściowy | `lib/behavior-guide.ts`, `.../interview-guide/page.tsx` |
| Migracje (wdrożone) | `supabase/migrations/20261002000100_behavior_assessments.sql`, `20261002000200_behavior_conflict_response.sql` |
| Tabela w żywej bazie | `public.behavior_assessment_entries` — **istnieje**, RLS włączone, **0 wierszy** |

Zastrzeżenia: funkcja jest w pełni ręczna (ocenia człowiek, nie AI) i **nigdy nie była użyta** —
zero wierszy w bazie, czyli brak realnego przetestowania na danych. Jest to też funkcja dostępna
niezależnie od pakietu; nie ma w kodzie bramki, która wiązałaby ją z WERYFIKACJĄ.

---

## 3. Ćwiczenia i obserwacje — **GOTOWE** (po stronie rekrutera)

| Element | Ścieżka |
|---|---|
| Lista definicji | `app/dashboard/[companyId]/recruitments/[recruitmentId]/exercises/page.tsx` |
| Tworzenie / edycja | `.../exercises/new/page.tsx`, `.../exercises/[exerciseId]/page.tsx`, `exercise-form.tsx` |
| Zapis definicji | `exercise-actions.ts` → RPC `save_exercise_definition` |
| Formularz obserwacji | `exercise-observation-form.tsx` (ocena per kryterium + dowody, do 10 000 znaków) |
| Zapis obserwacji | `exercise-observation-actions.ts` → RPC `save_exercise_observations` |
| Widok obserwacji kandydata | `.../applications/[applicationId]/exercises/page.tsx`, `.../exercises/[definitionId]/page.tsx` |
| Logika | `lib/exercise-definition.ts`, `lib/exercise-observation.ts`, `lib/exercise-editor.ts`, `lib/exercise-context.ts` |
| Migracje (wdrożone) | `supabase/migrations/20261002000300_exercise_definitions.sql`, `20261004000100_exercise_observations.sql` |
| Tabele w żywej bazie | `public.exercise_definition_entries`, `public.exercise_observation_entries` — **istnieją**, obie **0 wierszy** |

Zastrzeżenia: brak jakiegokolwiek interfejsu kandydata — kandydat nie dostaje zadania, nie wysyła
rozwiązania. `new_work_sample` przekazuje rekruter z własnego formularza. Dla WERYFIKACJI
(gdzie case studies i tak są poza zakresem, bo należą do ASSESSMENT CENTER) to wystarcza jako
narzędzie rekrutera, ale nie jako funkcja sprzedawana kandydatowi.

---

## 4. Etapy oceny — **GOTOWE**

Proces kandydata faktycznie przechodzi przez etapy w kodzie, z audytem zmian i decyzją człowieka.

| Element | Ścieżka |
|---|---|
| Lista i zarządzanie etapami | `app/dashboard/[companyId]/recruitments/[recruitmentId]/page.tsx:15-25` (odczyt `assessment_stages`, sortowanie po `sequence`) |
| Dodanie / zmiana nazwy / kolejność / usunięcie | `assessment-forms.tsx` (`StageForm`, `StageControls`) → `assessment-actions.ts` |
| Przypisanie kandydata do etapu | `assessment-forms.tsx:49` (`CandidateStageForm`) |
| Notatki oceny na etapie | `assessment-forms.tsx:81` (`AssessmentForm`), `.../applications/[applicationId]/assessments/page.tsx` |
| Decyzja człowieka | `lib/interview-decision.ts`, `interview-actions.ts`, `.../applications/[applicationId]/interview/page.tsx` |
| Logika serwerowa | `lib/step4-database.ts`, `lib/assessment-fields.ts` |
| RPC (wdrożone) | `move_assessment_stage`, `move_application_stage`, `set_application_human_decision` w `supabase/migrations/20261030160000_sc_step4_interview_decision.sql` |
| Tabele w żywej bazie | `public.assessment_stages`, `public.candidate_assessments`, `public.application_stage_events`, `public.application_decision_events`, `public.candidate_assessment_note_revisions` — **wszystkie istnieją**, wszystkie **0 wierszy** |

Zastrzeżenia: etapy są w pełni konfigurowalne przez firmę, nie są predefiniowane dla pakietu.
Funkcja nieużywana w praktyce (0 wierszy).

---

## 5. Voicebot / rozmowy AI — **TYLKO BAZA / nieaktywne**

To jest najcięższa luka. Zbudowano bardzo dużo kodu domenowego (ok. 20 modułów w `lib/voice/`),
ale **nic z tego nie jest podłączone do aplikacji ani wdrożone**.

### Co istnieje

| Obszar | Ścieżka |
|---|---|
| Kontrakt dostawcy, scenariusze | `lib/voice/provider.ts`, `lib/voice/fake-provider.ts`, `lib/voice/provider-event-contract.ts` |
| Plan rozmowy, szablony | `lib/voice/interview-plan.ts`, `lib/voice/template-registry.ts`, `lib/voice/plan-persistence-contract.ts`, `lib/voice/atomic-plan-operations.ts` |
| Wybór luk do dopytania | `lib/voice/screening-gap-selection.ts`, `lib/interview-gaps.ts` |
| Kompilator zlecenia wychodzącego | `lib/voice/retell-outbound-draft.ts` |
| Worker dzwoniący (once-only) | `lib/voice/retell-dispatch-worker.ts`, `retell-dispatch-ledger.ts`, `retell-dispatch-resolution.ts` |
| Webhook Retell | `lib/voice/retell-webhook.ts`, `retell-webhook-http.ts`, `app/api/voice/retell/webhook/route.ts` |
| Bramka pakietowa | `lib/voice/mvp-package-gate.ts` |
| Uprawnienia, przygotowanie offline | `lib/voice/interview-permission.ts`, `lib/voice/offline-preparation.ts` |
| Panel zatwierdzania planu (React) | `components/voice/VoicePlanApprovalPanel.tsx` |
| Konfiguracja agenta | `config/retell/skillcheck-interview-v1/agent.json`, `conversation-flow.json` |
| Testy | `tests/retell-*.test.mjs`, `tests/voice-*.test.mjs` (kilkanaście plików, przechodzą w CI) |
| Aneks prawny | `docs/legal/v1.0/06_Aneks_1_Rozmowy_glosowe.md`, `public/legal/06_Aneks_1_Rozmowy_glosowe_v1.0.docx` |

### Dlaczego to nie działa

1. **Webhook zawsze zwraca 404.** `lib/voice/retell-webhook-http.ts:62-64` — `resolveRetellWebhookRuntime()`
   ma ciało `return null;`, a `createRetellWebhookHttp(null)` odpowiada 404 bez treści. Żadne zdarzenie
   z Retell nie zostanie przyjęte.
2. **Panel planu nie jest nigdzie zamontowany.** `components/voice/VoicePlanApprovalPanel.tsx`
   importowany jest wyłącznie przez testy (`tests/voice-plan-panel-component.test.mjs`,
   `tests/voice-plan-panel-react-state.test.mjs`). Żadna strona w `app/` go nie renderuje.
3. **Worker dzwoniący nie ma runtime'u.** `lib/voice/retell-dispatch-worker.ts:3-5` — transport HTTP
   jest zawsze wstrzykiwany, nie ma domyślnego `fetch`: „there is no default fetch, so nothing here can
   place a call until a reviewed runtime supplies one”. Jedyny importer to `tests/retell-dispatch-worker.test.mjs`.
4. **Schemat nie jest wdrożony.** Cały SQL głosowy leży w `db/isolated/`: `sc010c-voice-preparation.sql`,
   `sc010c-interview-permission.sql`, `sc011b2-voice-dispatch.sql`, `sc011b3-voice-transcripts.sql`,
   `sc011b4-voice-settlement.sql`, `sc011b5-voice-dispatch-worker.sql`, `sc011b6-voice-dispatch-resolution.sql`,
   `sc010-r4-voice-retention.sql`, `sc012b-*.sql`, `sc019-voice-entitlements.sql`. W żywej bazie
   `skillcheck-preview` **nie ma żadnej tabeli głosowej**.
5. **Bramka pakietowa nie zna WERYFIKACJI.** `lib/voice/mvp-package-gate.ts:18` —
   `export type VoiceMvpPackage = "FREE" | "PRESELEKCJA";`. Pakiet, który sprzedaje 20 rozmów,
   nie występuje w bramce, która o rozmowach decyduje.
6. **Brak operatora SIP.** `lib/voice/retell-outbound-draft.ts` wymaga zweryfikowanego
   `fromNumberE164` od operatora (VoIPstudio/GoTrunk) — „provisioned separately”. Brak śladu
   provisionowania.
7. **Konfiguracja tylko podglądowa.** W Vercel `RETELL_API_KEY` i `RETELL_AGENT_ID` istnieją
   **wyłącznie dla środowiska Preview** (komentarz: „Retell SkillCheck demonstration voice agent; Preview only”).
   W Production nie ma ich wcale.

### Analiza odpowiedzi z rozmowy — BRAK

Nie istnieje moduł oceniający treść rozmowy. `lib/screening-ai.ts` dotyczy wyłącznie analizy CV.
Transkrypty (`sc011b3-voice-transcripts.sql`) są wyłącznie projektem schematu, bez konsumenta.

---

## 6. Chatbot informacyjny — **BRAK**

**Stan na `9856a3d` (`main`).** Na `integration` wiersz miał już wartość „Planowany”, a od
2026-11-02 został usunięty w całości.

Jedyne wystąpienia frazy w całym repozytorium to treść marketingowa:
`app/components/marketing/package-comparison.tsx:17`, `:18`, `:26`.

Brak jakiegokolwiek modułu, trasy, endpointu, tabeli czy zmiennej środowiskowej. Nie istnieje nawet prototyp.

**Uwaga sprzedażowa — nieaktualna od 2026-11-02.** Na `main` tabela deklarowała chatbota jako „Tak”
również dla FREE i PRESELEKCJI, czyli dla pakietów już sprzedawanych, bez pokrycia w kodzie.
Na `integration` wiersz brzmiał już „Planowany”, a następnie został usunięty razem z całym modułem.
Problemu nie ma.

---

## 7. Rozszerzony raport — **BRAK (różnica wobec PRESELEKCJI: żadna)**

Istnieje dokładnie jeden raport i jest to raport preselekcji.

| Element | Ścieżka |
|---|---|
| Strona raportu | `app/dashboard/[companyId]/recruitments/[recruitmentId]/report/page.tsx` (tytuł: „Raport preselekcji”) |
| Widok | `report/report-view.tsx` |
| Eksport CSV | `report/export/route.ts` |
| Druk | `report/print-button.tsx` |
| Logika | `lib/screening-report.ts` (180 linii), `lib/screening-report-source.ts` (166), `lib/screening-report-export.ts` (20) |

Raport jest **na poziomie rekrutacji**, nie kandydata: pokazuje ranking i sugestię shortlisty
o rozmiarze 5–10 (parametr `size`). Marketing obiecuje „Rozszerzony **raport kandydata**” —
czyli inny obiekt niż to, co istnieje.

W całym kodzie produkcyjnym nie ma wariantu raportu, flagi pakietowej przy raporcie, ani sekcji
na wyniki rozmowy / testu / obserwacji. Jedyne wystąpienia słowa „Rozszerzony” to
`package-comparison.tsx:19` i `:33` — czyli znów sama obietnica.

---

## Dodatkowe ustalenia (poza zadanymi pytaniami)

1. **Rozliczenia nie obsługują WERYFIKACJI.** `lib/sc19-package-sizes.ts:4` —
   `export const sc19Plans = ['FREE', 'PRESELEKCJA'] as const;`. Tabela `private.sc19_package_policy`
   w żywej bazie ma 2 wiersze. Nie da się dziś kupić, aktywować ani rozliczyć WERYFIKACJI —
   nawet gdyby wszystkie funkcje istniały. Wyjątkiem jest wewnętrzny kalkulator
   (`lib/pricing/quote-engine.ts:5` zna wszystkie cztery kody), ale zgodnie z ustaleniami
   nie jest on podpięty do cennika na stronie.
2. **Ostrzeżenie bezpieczeństwa z Supabase — mniej groźne, niż brzmi.**
   Trzy tabele mają wyłączone RLS: `private.sales_lead_settings`, `private.sales_lead_attempts`,
   `private.sales_lead_replay_state`, a doradca Supabase oznacza to jako `critical`.
   **Sprawdzone: realnego dostępu nie ma.** `supabase/migrations/20261007000200_sales_leads.sql:74`
   odbiera wszystkie uprawnienia tym tabelom dla `public`, `anon` i `authenticated` (linia 75
   robi to samo z sekwencją), żadna późniejsza migracja ich nie przywraca, a schemat `private`
   nie jest wystawiony w Data API. To zabezpieczenie w głąb, nie dziura.
   Niczego nie zmieniałem. Włączenie RLS bez polityk i tak nie zepsułoby `/rozmowa`, bo
   `public.submit_sales_lead` jest `security definer` i działa jako właściciel tabeli, który
   pomija RLS — ale byłaby to zmiana w bezpieczeństwie wykonana bez potrzeby, więc wymaga
   osobnej, świadomej decyzji, a nie odruchu na ostrzeżenie doradcy.
3. **Żadna z funkcji „weryfikacyjnych” nie ma ani jednego wiersza danych.** Zachowania, ćwiczenia,
   obserwacje, etapy, oceny — wszystko 0. Działają analizy CV (68 wersji analiz, 410 wyników kryteriów,
   109 kandydatów), czyli faktycznie używana jest tylko ścieżka PRESELEKCJI.

---

## Podsumowanie — czy WERYFIKACJĘ można dziś sprzedać?

**Nie.** Z pięciu funkcji wymienionych na karcie pakietu **żadna nie jest dostarczalna klientowi**:

| Obietnica z karty pakietu | Rzeczywisty stan |
|---|---|
| 20 rozmów weryfikacyjnych z botem | Nie da się wykonać ani jednej rozmowy |
| Analiza odpowiedzi z rozmowy | Moduł nie istnieje |
| Testy kompetencji | Kandydat nie ma gdzie rozwiązać testu |
| Rozszerzony raport kandydata | Istnieje tylko raport preselekcji, bez wariantów |
| Wszystko z Preselekcji | To jedyna część, która działa |

Do tego nie ma technicznej możliwości przyjęcia zapłaty za ten pakiet ani jego aktywacji.

Działające elementy, które *wspierają* weryfikację, ale nie są tym, co karta obiecuje: ocena zachowań
w 8 obszarach, ćwiczenia i obserwacje, etapy oceny z decyzją człowieka. Wszystkie są narzędziami
ręcznymi dla rekrutera i wszystkie mają zero użyć.

Warto też odnotować, że sama strona już dziś to sygnalizuje: karta ma etykietę „Planowany pakiet”
i adnotację „Cena robocza z wizualizacji”, a CTA prowadzi do formularza kontaktowego. Z punktu widzenia
ryzyka to dobrze — pakiet nie jest formalnie oferowany do sprzedaży. Ryzykiem pozostaje tabela
porównawcza, która deklaruje chatbota informacyjnego jako dostępnego również w FREE i PRESELEKCJI.

### Brakujące elementy z szacunkiem pracy

Szacunki w dniach roboczych, przy założeniu jednego budowniczego pracującego w dotychczasowym
rytmie projektu (zakres obejmuje migracje, runtime, UI, testy i bramki wydawnicze zgodne
z `docs/DEFINITION_OF_DONE.md`).

| # | Brakujący element | Dni |
|---|---|---|
| 1 | **Voicebot — wdrożenie schematu.** Przeniesienie 9 plików z `db/isolated/` do `supabase/migrations/` wraz z rolami, RLS, inwentarzem usuwania i rollbackami | 8–12 |
| 2 | **Voicebot — runtime webhooka.** Implementacja `resolveRetellWebhookRuntime()`, zaufane połączenie, sekrety w Vercel Production | 4–6 |
| 3 | **Voicebot — runtime workera dzwoniącego.** Transport HTTP, rezerwacje, reconcyliacja stanów `unknown`, limity kosztowe | 6–9 |
| 4 | **Voicebot — operator SIP.** Umowa z VoIPstudio/GoTrunk, numer prezentacyjny, weryfikacja `fromNumberE164`, testy połączeń | 3–5 (+ czas oczekiwania na operatora) |
| 5 | **Voicebot — UI.** Zamontowanie `VoicePlanApprovalPanel`, ekran planu rozmowy, zgody kandydata, podgląd statusów i transkryptów | 8–12 |
| 6 | **Analiza odpowiedzi z rozmowy.** Nowy moduł AI na transkryptach, rubryka, przegląd przez człowieka, zapis wersjonowany | 7–11 |
| 7 | **Test kompetencji — wdrożenie schematu.** `db/isolated/sc014-b2-*.sql` → migracje, role `competency_test_gateway`, dedykowany login bazodanowy | 4–6 |
| 8 | **Test kompetencji — ekran kandydata (B4).** Trasa publiczna z tokenem, sesja, autozapis, wysyłka, obsługa wycofania zgody | 6–9 |
| 9 | **Test kompetencji — ocena i wpięcie w raport.** Konsumpcja `lib/competency-test.ts`, przegląd przez rekrutera | 3–5 |
| 10 | **Rozszerzony raport kandydata.** Nowy raport per kandydat: rozmowa + test + obserwacje + zachowania + CV, eksport, druk | 6–9 |
| 11 | **Chatbot informacyjny.** Od zera: model, treści, ograniczenia tematyczne, log rozmów, retencja, aneks RODO | 10–15 |
| 12 | **Rozliczenia WERYFIKACJI.** Rozszerzenie `sc19Plans`, polityka pakietu, limity 20 rozmów, checkout, faktura, aktywacja | 5–8 |
| 13 | **Zgodność prawna i dokumentacja.** Aktualizacja regulaminu, polityki, DPA i aneksu pod realnie działające rozmowy i testy | 3–5 |
| 14 | **Testy end-to-end i wydanie.** Pełna ścieżka na danych testowych, runbook produkcyjny, atestacja | 5–8 |

**Suma: około 78–120 dni roboczych**, czyli realistycznie **4–6 miesięcy** pracy jednoosobowej
przy obecnym tempie. Pozycje 1–6 (voicebot z analizą rozmowy) to **36–55 dni**, czyli blisko połowa
całości, i to one decydują o terminie.

### Sugerowana kolejność, gdyby pakiet miał powstać

Najtańsza droga do czegoś sprzedawalnego nie prowadzi przez voicebota. Pozycje 7–10 i 12
(test kompetencji + rozszerzony raport + rozliczenia) to **24–37 dni** i dają pakiet pośredni:
preselekcja plus realny test kompetencji plus raport per kandydat, bez rozmów AI. To byłby inny
produkt niż dziś reklamowany, ale możliwy do dostarczenia w rozsądnym czasie i do wyceny poniżej 899 zł.

Decyzja o kolejności należy do właściciela — audyt jej nie przesądza.

---

*Audyt wykonany 2026-11-02. Żadnych zmian w kodzie, bazie ani konfiguracji.*
