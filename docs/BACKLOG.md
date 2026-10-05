# SkillCheck — Development Backlog

Punkt startowy: po merge PR #1 do main, 2026-10-04.

## Status istniejącego produktu
Nie budować ponownie: auth/onboarding, firmy, profile stanowisk, rekrutacje, kandydaci, TXT/PDF/DOCX CV, manualna redakcja, screening-prep, ręczne etapy, behavior assessments, interview guide, exercise definitions i observations.

## Kolejka SC-001 — SC-020

| ID | Zadanie | Level | Owner | Reviewer | Depends on | Status |
|---|---|---:|---|---|---|---|
| SC-001 | Post-merge production baseline + aktualizacja starych opisów PR/README/PROGRESS | L1 | Cursor | Codex | — | DONE |
| SC-002 | Zamrożenie kontraktów DB/types + kontrola rozbieżności ręcznych typów Supabase | L2 | Cursor | Codex | SC-001 | DONE |
| SC-003 | Model danych dla persistowanego wyniku preselekcji AI | L3 | Codex→Cursor | Codex | SC-002 | DONE |
| SC-004 | Migracja + RLS + RPC dla wyników preselekcji i review człowieka | L3 | Cursor | Codex | SC-003 | DONE |
| SC-005 | Integracja OpenAI dla preselekcji: bezpieczny payload, structured output, limity | L3 | Codex→Cursor | Codex | SC-004 | DONE |
| SC-006 | UI uruchomienia analizy i podglądu dowodów bez automatycznej decyzji | L2 | Cursor | Codex | SC-005 | BACKLOG |
| SC-007 | Obsługa stale/fingerprint/idempotency/concurrency analizy | L3 | Cursor | Codex | SC-005 | BACKLOG |
| SC-008 | Ranking/shortlista dla jednej rekrutacji na podstawie sprawdzonych wyników | L2 | Cursor | Codex | SC-006,SC-007 | BACKLOG |
| SC-009 | Raport preselekcji dla firmy + eksport | L2 | Cursor | Codex | SC-008 | BACKLOG |
| SC-010 | Model komunikacji z kandydatem: zgody, statusy, kanały, retry | L3 | Codex→Cursor | Codex | SC-008 | BACKLOG |
| SC-011 | Voicebot architecture/provider contract + koszt i limity | L3 | Codex | Codex | SC-010 | BACKLOG |
| SC-012 | Voicebot MVP: rozmowa, callback/retry, transcript | L3 | Cursor | Codex | SC-011 | BACKLOG |
| SC-013 | Analiza rozmowy voice + dowody + review człowieka | L3 | Cursor | Codex | SC-012 | BACKLOG |
| SC-014 | Test kompetencji: wykonanie kandydata + scoring evidence-based | L3 | Codex→Cursor | Codex | SC-008 | BACKLOG |
| SC-015 | Raport WERYFIKACJA łączący CV, voice i test | L2 | Cursor | Codex | SC-013,SC-014 | BACKLOG |
| SC-016 | Assessment Center: komplet flow na istniejących exercise definitions/observations | L2 | Cursor | Codex | SC-014 | BACKLOG |
| SC-017 | Quality of Hire 30/90/180 + KPI feedback | L3 | Codex→Cursor | Codex | SC-015 | BACKLOG |
| SC-018 | Talent pool: zgoda kandydata, eligibility i matching | L3 | Codex→Cursor | Codex | SC-015 | BACKLOG |
| SC-019 | Billing/pakiety/limity usage FREE-PRESELEKCJA-WERYFIKACJA-AC | L3 | Codex→Cursor | Codex | SC-009,SC-015 | BACKLOG |
| SC-020 | White-label tenant configuration | L3 | Codex→Cursor | Codex | SC-019 | BACKLOG |

## Pierwsza fala
Uruchamiać sekwencyjnie:
1. SC-001
2. SC-002
3. SC-003

Po zaakceptowaniu SC-003 można rozbić implementację na niezależne podtaski.

## Product backlog poza pierwszą 20
- agency subscriptions / volume packs,
- candidate chatbot,
- notification center,
- admin/ops dashboard,
- OCR jako osobna usługa,
- advanced analytics,
- integrations z ATS/HRIS,
- full white-label domain/email branding.

## Zasada priorytetu
Najpierw domknąć PRESELEKCJĘ jako pierwszy płatny end-to-end produkt. Voice, AC, QoH, billing i white-label są kolejnymi warstwami, nie mogą blokować SC-003—SC-009.

## Prezentacja oferty

| ID | Zadanie | Level | Owner | Reviewer | Depends on | Status |
|---|---|---:|---|---|---|---|
| SC-SALES-004A | Publiczna strona `/` i demonstracyjny przykład `/demo` | L2 | Cursor | Codex | — | DONE |

SC-SALES-004A obejmuje stronę oferty i publiczne demo bez logowania. Poza zakresem pozostają płatności, pakiety jako zakup, zamówienia i uruchamianie analiz. Istniejące zadania SC-001–SC-020 nie zmieniają tu zakresu ani statusu.

## Zgłoszenia kontaktowe

SC-SALES-006 nie jest backendowym SC-006. SC-006 pozostaje w kolejce analizy AI i nie zmienia tu zakresu ani statusu.

| ID | Zadanie | Level | Owner | Reviewer | Depends on | Status |
|---|---|---:|---|---|---|---|
| SC-SALES-006A | Projekt formularza kontaktowego i bezpiecznego zapisu zgłoszeń | L3 | Codex | Codex | SC-SALES-004A | REVIEW |
| SC-SALES-006B | Migracja, RLS i RPC zapisu oraz odczytu zgłoszeń | L3 | Cursor | Codex | SC-SALES-006A | BACKLOG |
| SC-SALES-006C | Publiczny formularz `/rozmowa` | L2 | Cursor | Codex | SC-SALES-006B | BACKLOG |
| SC-SALES-006D | Minimalny odczyt zgłoszeń przez operatora platformy | L2 | Cursor | Codex | SC-SALES-006C | BACKLOG |
| SC-SALES-013 | Etapy sprzedaży, notatki, przypomnienia i powiązanie zgłoszenia z firmą | L3 | Codex→Cursor | Codex | SC-SALES-006D | BACKLOG |

006A pozostaje w REVIEW do zatwierdzenia poprawki. 006B nie jest READY i nie startuje, dopóki ten dokument nie zostanie zatwierdzony i scalony do `main`. Potem kolejność jest liniowa: 006B, następnie 006C, następnie 006D. Publiczne włączenie wymaga obu widoków, testu współbieżności na osobnym Postgresie, sekretu żądania, treści informacji podanej przez właściciela i ręcznego nadania pierwszego operatora. Tych danych ten backlog nie zawiera.
