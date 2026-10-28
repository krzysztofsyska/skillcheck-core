# Promocja #178 (integration → main) — checklista właściciela

Jednorazowe obejście reguły `require_last_push_approval` dla PR #178, a potem przejście na ruleset (b) z `production-approval-attestation.md`.
Wykonuje wyłącznie właściciel (`krzysztofsyska`). Agent nie edytuje rulesetu, nie scala i nie zatwierdza.

Wpisuj godziny w formacie `RRRR-MM-DD GG:MM` (czas polski) oraz identyfikatory. Na koniec przenieś całość do issue atestacji.

## 0. Warunki wstępne (przed edycją rulesetu)
- [ ] #177 (ten workflow) i #179 (data 29.10.2026) scalone do `integration`. Godzina: `________`
- [ ] #178: CI zielone na aktualnym head `integration`; brak nierozwiązanych wątków. Head SHA: `________`
- [ ] Brak nowych migracji względem produkcji (`main..integration` nie zmienia `supabase/**`). Sprawdził: `________`
- [ ] Zakres #178 zgodny z raportem przed scaleniem (lista PR: #169, #174, #177, #179). Potwierdzam: `________`

## 1. Tymczasowa edycja rulesetu `main-production-protection` (id 25301984)
Settings → Rules → Rulesets → `main-production-protection`.
- [ ] Zapisz bieżącą konfigurację (Export JSON) jako załącznik do issue atestacji. Godzina: `________`
- [ ] Zmień tylko regułę `pull_request`: `require_last_push_approval: true → false` i `required_approving_review_count: 1 → 0`. Wymagane checki `verify` i `Agent contract / scope gate` zostają. Godzina zmiany: `________`

## 2. Merge #178
- [ ] Head SHA #178 bez zmian od kroku 0 (inaczej wróć do kroku 0). SHA: `________`
- [ ] Merge metodą **merge commit**. Godzina: `________` Merge SHA na `main`: `________`

## 3. Przywrócenie rulesetu
- [ ] Przywróć konfigurację z kroku 1 (Import JSON lub ręcznie: `required_approving_review_count: 1`, `require_last_push_approval: true`). Godzina: `________`
- [ ] Rule insights pokazuje tylko jedno obejście (merge #178). Zrzut/URL: `________`

Czas między krokiem 1 a 3 powinien być jak najkrótszy (cel: < 15 min). Łącznie: `________` min.

## 4. Weryfikacja deployu produkcyjnego (Vercel)
- [ ] Deploy Production z merge SHA ma stan `READY`. Deployment ID: `________` Godzina: `________`
- [ ] `https://skillcheck.pl/regulamin` → 200, „obowiązuje od 29.10.2026”.
- [ ] `https://skillcheck.pl/polityka-prywatnosci` → 200.
- [ ] `/regulamin/umowa-powierzenia`, `/regulamin/formularz-odstapienia`, `/ai` → 200.
- [ ] Stopka na `/`, `/login`, `/register`, `/kalkulator-demo.html`: linki „Regulamin” i „Polityka prywatności”, KTIG CONSULTING Sp. z o.o., adres, NIP, KRS, pomoc@skillcheck.pl.
- [ ] `/#pakiety`: PRESELEKCJA „300 zł brutto”; kalkulator PRESELEKCJA 300 zł brutto.
- [ ] Pliki `/legal/*.docx` się pobierają.
- [ ] Brak nowych błędów runtime w Vercel w ciągu 30 min. Sprawdził/godzina: `________`

Rollback w razie problemu: Vercel → Deployments → poprzedni Production (`613a493`) → Instant Rollback. Godzina (jeśli użyty): `________`

## 5. Przejście na ruleset (b) — po promocji workflow atestacji
Kolejność z `production-approval-attestation.md` („Rollout order”).
- [ ] Environment `production-approval`: reviewer tylko `krzysztofsyska`, `prevent_self_review: false`, `can_admins_bypass: false`, deployment branches: `main`. Godzina: `________`
- [ ] Testowy PR do `main` (bez zmian produktowych). Numer: `#____`
  - [ ] brak zatwierdzenia → `pending`
  - [ ] odrzucenie → `failure`
  - [ ] zatwierdzenie aktualnego SHA → `success`
  - [ ] nowy push po zatwierdzeniu → nowy SHA `pending`
- [ ] Testowy PR zamknięty bez merge. Godzina: `________`
- [ ] Ruleset zmieniony na wariant (b) (JSON w `production-approval-attestation.md`). Godzina: `________`
- [ ] Kolejna promocja przechodzi bez obejścia rulesetu.

## 6. Wpis do issue atestacji
```
PROMOCJA: #178 integration → main
ZAKRES: #169, #174, #177, #179
HEAD #178: <sha>        MERGE SHA: <sha>
RULESET: edycja <godzina> → merge <godzina> → przywrócenie <godzina> (łącznie <min> min)
DEPLOY: <deployment id> READY <godzina>; smoke test OK <godzina>
RULESET (b): environment <godzina>; testowy PR #<nr>; zmiana rulesetu <godzina>
UWAGI:
```
